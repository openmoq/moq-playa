import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { encodeObjectDatagram18 } from '@openmoq/transport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildChunk, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MoqtPlayer } from './player.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import type { MediaStageObservation } from './media-diagnostic-types.js';
import type { MediaAppendObserver, MediaSourceLike } from './interfaces.js';

async function fixture() {
  const { a, b } = createLoopback(); const client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const requests: bigint[] = []; server.onSubscribe = id => { requests.push(id); };
  const listeners = new Set<MediaAppendObserver>();
  const append = vi.fn<MediaSourceLike['appendChunk']>((_type, _bytes, _track, _group, token) => {
    if (token) for (const listener of listeners) listener({ token, state: 'appended', reason: null });
  });
  const ms: MediaSourceLike = { initialize() {}, appendChunk: append, endOfStream() {}, reset() {}, destroy() {}, mediaElement: null,
    onFirstFrame: null, onError: null, onStall: null,
    observeAppends(observer) { listeners.add(observer); return () => { listeners.delete(observer); }; } };
  let serving: Promise<void> | undefined;
  const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: 18, disableAudio: true,
    createConnection: () => client, createTransport: async () => { serving = server.connect(b); void serving.catch(() => {}); return a; },
    catalog: { tracks: [{ name: 'v', packaging: 'cmaf', role: 'video', isLive: true, codec: 'avc1.4D4028',
      initData: Buffer.from(videoInit()).toString('base64') }] },
    createMediaSource: () => ms, createCmafAssembler: options => new CmafAssembler(options),
  });
  const events: MediaStageObservation[] = [];
  const remove = player.observeMediaStages(event => { events.push(event); }, { createTracker: createMediaDiagnostics });
  await player.load(); await flush(128); await server.acceptSubscribe(requests[0]!, 77n); await flush(128);
  const bytes = buildChunk({ bmdt: 9000, samples: [{ duration: 3000, size: 1, flags: SYNC_FLAGS }] });
  return { player, client, server, ms, append, events, bytes, remove,
    async send(payload = bytes, objectId = 0n) { const stream = await server.openSubgroup(77n, 2n, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, objectId, payload); await flush(128); },
    async sendParts(between?: () => void) {
      const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
      const stream = await server.openSubgroup(77n, 2n, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, bytes.slice(0, size)); await flush(128); between?.();
      await server.sendObject(stream, 1n, bytes.slice(size)); await flush(128);
    },
    async datagram() { const writer = b.datagrams.writable!.getWriter(); try {
      await writer.write(encodeObjectDatagram18({ typeByte: 0x00, trackAlias: 77n, groupId: 2n, objectId: 0n,
        publisherPriority: 128, payload: bytes, extensions: undefined, status: undefined, isEndOfGroup: false }));
      await flush(128);
    } finally { writer.releaseLock(); } },
    async close() { remove(); await player.destroy(); await server.close(); await serving?.catch(() => {}); } };
}

describe('real player receipt to append chain', () => {
  it('observes one unit reconstructed then synchronously appended with the same actual receipt', async () => {
    const f = await fixture(); try {
      await f.send(); expect(f.append).toHaveBeenCalledOnce();
      expect(f.events.map(e => e.stage)).toEqual(['reconstructed', 'appended']);
      expect(f.events[0]!.unit).toBe(f.events[1]!.unit);
      expect(f.events[0]!.inputs).toEqual(f.events[1]!.inputs); expect(f.events[0]!.inputs).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('does not turn unavailable MSE decoder output into a measured zero', async () => {
    const f = await fixture(); try {
      await f.send();
      expect(f.player.diagnosticSnapshot().mediaStages).toMatchObject({ decodedVideoCount: null, decodedAudioCount: null });
    } finally { await f.close(); }
  });
  it('preserves the original receipt when a datagram is converted for routing', async () => {
    const f = await fixture(); try {
      await f.datagram(); expect(f.append).toHaveBeenCalledOnce();
      expect(f.events.map(e => e.stage)).toEqual(['reconstructed', 'appended']);
    } finally { await f.close(); }
  });
  it('associates both actual receipts with a legacy split-object reconstructed unit', async () => {
    const f = await fixture(); try {
      await f.sendParts(() => { expect(f.events).toEqual([]); expect(f.append).not.toHaveBeenCalled(); });
      expect(f.events.map(e => e.stage)).toEqual(['reconstructed', 'appended']);
      expect(f.events[0]!.inputs).toHaveLength(2); expect(f.events[0]!.inputs[0]).not.toBe(f.events[0]!.inputs[1]);
      expect(f.events[0]!.inputs).toEqual(f.events[1]!.inputs);
    } finally { await f.close(); }
  });
  it('keeps only the observed new half-pair provenance on reattachment', async () => {
    const f = await fixture(), later: MediaStageObservation[] = [], receipts: object[] = []; let stop = () => {};
    const offReceipts = f.client.observeObjectReceipts(event => { receipts.push(event.receipt); });
    try {
      await f.sendParts(() => {
        f.remove(); stop = f.player.observeMediaStages(event => { later.push(event); }, { createTracker: createMediaDiagnostics });
      });
      expect(f.append).toHaveBeenCalledOnce(); expect(later.map(event => event.stage)).toEqual(['reconstructed', 'appended']);
      expect(later.map(event => event.inputs)).toEqual([[receipts[1]], [receipts[1]]]);
      expect(later[0]!.inputs).not.toContain(receipts[0]);
      expect(f.player.diagnosticSnapshot().mediaStages?.evidenceLossCount).toBe(0);
      expect(f.player.diagnosticSnapshot().mediaStages?.unattributedInputCount).toBe(1);
    } finally { offReceipts(); stop(); await f.close(); }
  });
  it('does not append after a reconstructed observer synchronously destroys the player', async () => {
    const f = await fixture(); let destroying: Promise<void> | undefined;
    const stop = f.player.observeMediaStages(event => { if (event.stage === 'reconstructed') destroying = f.player.destroy(); });
    try { await f.send(); await destroying; expect(f.append).not.toHaveBeenCalled(); }
    finally { stop(); await f.close(); }
  });
  it('detaches diagnostics while leaving media delivery running without a token', async () => {
    const f = await fixture(); try {
      f.remove(); await f.send(); expect(f.events).toEqual([]);
      expect(f.append.mock.calls[0]).toHaveLength(4);
    } finally { await f.close(); }
  });
});

it('publishes correlated object and unit-stage facts through the real diagnostic adapter', async () => {
  const { DiagnosticRegistry } = await import('../../devtools/src/index.js');
  const { installPlayerDiagnostics } = await import('../../devtools/src/player.js');
  const { encodeMessage, decodeMessage, PROTOCOL_VERSION } = await import('../../devtools-protocol/src/index.js');
  const f = await fixture(), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(f.player, { registry, exposure: 'development' });
  const owner = registry.open('stages');
  try {
    const initial = owner.request(encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION, kind: 'attach', requestId: 'attach',
      target: { ownerId: 'stages', sourceId: installed.source.sourceId, runId: installed.source.runId } }));
    await f.send();
    const facts: import('../../devtools-protocol/src/index.js').Fact[] = [];
    for (const raw of initial) { const parsed = decodeMessage(raw); if (parsed.ok && parsed.message.kind === 'snapshot') facts.push(...parsed.message.facts.map(e => e.fact)); }
    for (let i = 0; i < 100; i++) {
      const raw = owner.pull(); if (raw === null) break;
      const parsed = decodeMessage(raw); if (!parsed.ok) throw Error('Invalid diagnostic frame');
      const message = parsed.message;
      if (message.kind === 'batch') facts.push(...message.events.map(event => event.fact));
    }
    const object = facts.find(fact => fact.kind === 'object');
    expect(object?.kind).toBe('object'); if (object?.kind !== 'object') throw Error('No object observed');
    const stages = facts.filter(fact => fact.kind === 'stage');
    expect(stages.map(stage => stage.stage)).toEqual(['reconstructed', 'appended']);
    expect(stages.map(stage => stage.deliveryId)).toEqual([object.deliveryId, object.deliveryId]);
    expect(stages[0]!.unitId).not.toBeNull(); expect(stages[0]!.unitId).toBe(stages[1]!.unitId);
    expect(installed.source.capabilities).toContain('cmaf-append-stages');
    expect(facts.find(f => f.kind === 'metric' && f.name === 'frames_decoded')).toMatchObject({ value: null, unavailable: 'unsupported' });
    expect(facts.find(f => f.kind === 'metric' && f.name === 'audio_outputs_decoded')).toMatchObject({ value: null, unavailable: 'unsupported' });
  } finally { owner.close(); installed.dispose(); registry.dispose(); await f.close(); }
});
