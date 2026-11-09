import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, readCmafObjectSamples } from '@openmoq/locmaf';
import { serializeLocmafObject } from '@openmoq/locmaf';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, NON_SYNC_FLAGS, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MseSeekPlayback, type SeekRoleCandidate, type SeekRoleCutHold, type SeekTrack } from './mse-seek-playback.js';
import { MseSeekOutput } from './mse-seek-output.js';
import { SeekCmafInput } from './seek-cmaf-input.js';
import { SeekFetchRequests } from './seek-fetch-requests.js';
import { seekFetchResponseCut } from './seek-fetch-pages.js';
import { SeekRoleRetrieval } from './seek-role-retrieval.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import type { TimelineState } from './timeline-manager.js';

const object = (payload: Uint8Array, group = 4n, id = 0n): MoqtObject => ({ kind: 'data', payload,
  groupId: varint(group), objectId: varint(id), trackAlias: varint(0), subgroupId: varint(0), publisherPriority: 128 });

// Actual SDK and format consumers; append terminals/native position are controlled.
async function fixture(draft: 18 | 22, packaging: 'locmaf' | 'cmaf' = 'locmaf', limits = { maxObjects: 30, maxBytes: 16384 }, audio = false, corruptEmission = false) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const protocolErrors: string[] = [], wire: bigint[] = [], native: Array<{ bytes: Uint8Array; token: object; group: bigint }> = [];
  client.onError = server.onError = error => { protocolErrors.push(error.message); };
  server.onFetch = id => { wire.push(id); };
  await Promise.all([client.connect(a), server.connect(b)]);
  const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }), context = parseLocmafTrackContext(init), epoch = {}, resourceId = {};
  const chunk = (dts: bigint, cto = 0, duration = 125, flags = NON_SYNC_FLAGS) => buildChunk({ trackId: 1, bmdt: dts,
    samples: [{ duration, size: 4, flags, cto }], mdat: Uint8Array.of(71, 72, Number(dts % 251n), duration % 251) });
  const encoder = new LocmafEncoder(), group = new LocmafGroupState();
  const canonical = [chunk(6000n, 125, 125, SYNC_FLAGS), chunk(6125n, -125)];
  const payloads = canonical.map((bytes, i) => packaging === 'cmaf' ? bytes
    : serializeLocmafObject(encoder.encode(bytes, group, context, false, BigInt(i))));
  const higherBytes = chunk(6250n, 0, 125, SYNC_FLAGS);
  const higher = packaging === 'cmaf' ? higherBytes : serializeLocmafObject(encoder.encode(higherBytes, new LocmafGroupState(), context, false, 0n));
  let current = true, nativeCurrent = true, observer: MediaAppendObserver | null = null, sample: MediaSeekSample | null = null;
  const resource: MediaSeekResource = { epoch, resource: resourceId, get current() { return nativeCurrent; }, initialize: vi.fn(() => true), whenAttached: async () => {},
    observeAppends(fn) { observer = fn; return () => { observer = null; }; },
    appendChunk(_role, bytes, _name, group, token) { native.push({ bytes: bytes.slice(), token: token!, group: group! }); },
    getTimestampOffset: vi.fn(() => 0), setTimestampOffset: vi.fn(),
    position: vi.fn(async () => { sample = { epoch, resource: resourceId, currentTime: 5.125, buffered: { start: 4, end: 6 } }; return sample; }),
    sample: () => sample, setPlaybackIntent: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }) };
  const source: MediaSourceLike = { mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    beginSeek: () => resource, initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
  const live = new CmafAssembler({ onSegment: vi.fn() }); let assembler: CmafAssembler | null = null, retrieval: SeekRoleRetrieval | null = null;
  const discarded = vi.fn(), checks = vi.fn(() => current), admissions = vi.fn(() => current);
  const failures = vi.fn(), targetErrors = vi.fn<(...args: unknown[]) => void>(), positions = vi.fn(), consumed = vi.fn(), ended = vi.fn(), closed = vi.fn();
  const track: SeekTrack = { role: 'video', name: 'old', namespace: ['show'], sourceKey: 'old', codec: 'avc1.640028', init, packaging };
  const tracks: SeekTrack[] = [track];
  if (audio) tracks.push({ ...track, role: 'audio', name: 'audio', sourceKey: 'audio', packaging: 'cmaf', codec: 'mp4a.40.2', init: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) });
  const actor = new MseSeekPlayback({ epoch, source, liveAssembler: live, createAssembler: cb => {
    assembler = new CmafAssembler({ ...cb, onSegment: (role, bytes, name, group, inputs, key) => cb.onSegment(role,
      corruptEmission && group === 5n ? chunk(5500n, 0, 125, SYNC_FLAGS) : bytes, name, group, inputs, key) }); return assembler;
  }, tracks,
    location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, timestampRounding: 'floor', targetMs: 5000,
    maxObjects: limits.maxObjects, maxBytes: limits.maxBytes, preparationTimeoutMs: 1000, playing: false, isCurrent: checks,
    beforeResourceChange: vi.fn(), adopt: vi.fn(), onSegment: vi.fn(), onPosition: positions,
    onPageDrained: vi.fn(), onPageError: failures, onError: failures, onDiscard: discarded });
  const requests = new SeekFetchRequests(client, { isCurrent: () => current, onError: targetErrors });
  client.onMessage = message => { retrieval?.requests.handleControl(message) || requests.handleControl(message); };
  client.onDataStream = (id, header) => { retrieval?.requests.handleStreamOpen(id, header) || requests.handleStreamOpen(id, header); };
  client.onStreamClosed = id => { retrieval?.requests.handleStreamClose(id) || requests.handleStreamClose(id); };
  const cancels: Array<() => void> = [], candidates: SeekRoleCandidate[] = [];
  function complete(index: number) { observer?.({ token: native[index]!.token, state: 'appended', reason: null }); }
  actor.start(); const oldId = {}, old = actor.beginPage('video', oldId); actor.acceptPage('video', oldId, false);
  const oldBytes = chunk(4000n, 0, 2000, SYNC_FLAGS), oldPayload = packaging === 'cmaf' ? oldBytes
    : serializeLocmafObject(new LocmafEncoder().encode(oldBytes, new LocmafGroupState(), context, false, 0n));
  const initial = old.onObject(object(oldPayload, 3n)); void initial.catch(() => {}); await flush(128);
  if (!audio) { complete(0); await initial; old.onClosed('fin'); await flush(128); }
  if (audio) {
    const id = {}, receiver = actor.beginPage('audio', id); actor.acceptPage('audio', id, false);
    const bytes = buildChunk({ trackId: 2, bmdt: 4000n, samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
    const work = receiver.onObject(object(bytes, 3n)); void work.catch(() => {}); await flush(128); expect(native).toHaveLength(2); complete(0); complete(1); await Promise.all([initial, work]); old.onClosed('fin'); receiver.onClosed('fin'); await flush(128);
  }
  expect(positions).toHaveBeenCalledOnce();
  const base = { track: { ...track, name: 'new', sourceKey: 'new' }, location: { groupId: 4n, objectId: 0n }, mediaPts: 6125,
    timestampRounding: 'floor' as const, placement: { sourceTimeUs: 6125000n, rebasedTimeUs: { numerator: 6125000n, denominator: 1n } },
    onPageDrained: (id: object, scope?: 'prepared' | 'native') => { consumed(id, scope); retrieval?.onPageDrained(id); },
    onPageError: targetErrors, onError: targetErrors, isCurrent: () => admissions() };
  function prepare(mode: 'indexed-group' | 'indexed-boundary' = 'indexed-group') {
    const candidate = actor.prepareRole({ ...base, readiness: mode }); candidates.push(candidate); return candidate;
  }
  async function open(candidate: SeekRoleCandidate, start = { groupId: 4n, objectId: 0n }, end = { groupId: 4n, objectId: 1n }, withInput = false) {
    const id = {}, receiver = candidate.beginPage(id), before = wire.length;
    const cancel = requests.open(base.track, start, { onObject: raw => receiver.onObject(raw, withInput ? {} : undefined), onClosed: terminal => { closed(id, terminal); receiver.onClosed(terminal); } }, response => {
      candidate.acceptPage(id, response.endOfTrack, { start, through: seekFetchResponseCut(draft, response), endOfTrack: response.endOfTrack,
        groupOrder: 'ascending', rangeFilters: false });
    }, end); cancels.push(cancel);
    await flush(128); expect(wire).toHaveLength(before + 1); return { id, requestId: wire[before]!, cancel, receiver };
  }
  async function accept(requestId: bigint, eot: boolean, lastGroup = 4n, lastObject = 0n) {
    await server.acceptFetch(requestId, { endOfTrack: eot ? 1 : 0, endLocation: { group: lastGroup, object: draft === 22 ? lastObject : lastObject + 1n } });
    return server.openFetchStream(requestId);
  }
  async function send(stream: bigint, index: number, groupId = 4n, payload = payloads[index]!) {
    await server.sendFetchObject(stream, { groupId, objectId: groupId === 4n ? BigInt(index) : 0n, subgroupId: 0n, publisherPriority: 128, payload }); await flush(128);
  }
  async function arm() {
    const cut = actor.holdRole('video', actor.roleOwner('video')!, { beforeGroup: 4n });
    const id = {}, receiver = actor.beginPage('video', id); actor.acceptPage('video', id, false);
    const pending = receiver.onObject(object(payloads[0]!)); void pending.catch(() => {}); await cut.reached; await cut.nativeSettled; return cut;
  }
  function startRetrieval(candidate: SeekRoleCandidate) {
    const timeline: TimelineState = { entries: [{ mediaPts: 6125, location: [4, 0], wallclockTime: 0 }], trackName: 'index', depends: ['new'], isLive: false, trackDuration: undefined };
    retrieval = new SeekRoleRetrieval({ connection: client, track: base.track, location: base.location,
      timeoutMs: 1000, maxObjects: 30, maxBytes: 16384, isCurrent: () => current, getTimeline: () => timeline,
      canProbeLive: () => false, admitHead: () => false, beforeSubscribe: () => false,
      beginPage: id => candidate.beginPage(id), acceptPage: (id, eot, receipt) => candidate.acceptPage(id, eot, receipt),
      beginLive: () => { throw new Error('Finite group cannot open live input'); }, capture: () => undefined, discard: vi.fn(),
      consume: async (raw, input, admitted, deliver) => { if (admitted()) await deliver(raw, input); },
      onBridgeAdded: vi.fn(), onBridgeRemoved: vi.fn(), onEnded: ended, onProgress: vi.fn(), onFailure: targetErrors });
    retrieval.pump(); return retrieval;
  }
  return { actor, base, prepare, native, resource, payloads, higher, chunk, complete, open, accept, send, arm, wire, assembler: () => assembler!,
    consumed, ended, closed, failures, targetErrors, positions, protocolErrors, server, startRetrieval, discarded, checks, admissions,
    async destroy() { current = false; retrieval?.cancel(); for (const cancel of cancels) cancel(); requests.dispose(); for (const candidate of candidates) candidate.cancel(); actor.cancel(); resource.cancel(); assembler?.destroy(); live.destroy(); await client.close(); await server.close(); } };
}

describe.each([18, 22] as const)('closed target group draft%i', draft => {
  it('consumes intermediate finite pages with queued G, then keeps final G/EOT owned until promotion and native drain', async () => {
    const f = await fixture(draft);
    try {
      const c = f.prepare(), ready = vi.fn(); void c.ready.then(ready, () => {});
      const first = await f.open(c), fs = await f.accept(first.requestId, false); await f.send(fs, 0); await f.server.closeFetchStream(fs); await flush(128);
      expect(ready).not.toHaveBeenCalled(); expect(f.native).toHaveLength(1); expect(f.consumed).toHaveBeenCalledExactlyOnceWith(first.id, 'prepared');
      expect(new LocmafTrackDecoder(f.base.track.init).push(4n, 1n, f.payloads[1]!).kind).toBe('rejected');
      const second = await f.open(c, { groupId: 4n, objectId: 1n }, { groupId: 4n, objectId: 2n });
      const ss = await f.accept(second.requestId, true, 4n, 1n); await f.send(ss, 1); await f.server.closeFetchStream(ss); await c.ready;
      expect(f.consumed).toHaveBeenCalledTimes(1); expect(f.native).toHaveLength(1);
      expect(c.groupProof!.coverage).toHaveLength(1); const interval = c.groupProof!.coverage[0]!;
      expect(interval.startUs.numerator).toBe(6000000n * interval.startUs.denominator);
      expect(interval.endUs.numerator).toBe(6250000n * interval.endUs.denominator);
      const cut = await f.arm(); cut.commit(c); await flush(128); expect(f.native).toHaveLength(2);
      f.complete(1); await flush(128); expect(f.native).toHaveLength(3); expect(f.consumed).toHaveBeenCalledTimes(1);
      f.complete(2); await flush(128); expect(f.consumed).toHaveBeenLastCalledWith(second.id, 'native');
      const context = parseLocmafTrackContext(f.base.track.init);
      expect(f.native.slice(1).map(item => readCmafObjectSamples(item.bytes, context)![0]!.effective.baseMediaDecodeTime)).toEqual([6000n, 6125n]);
      expect(c.groupProof!.sourcePtsUs.numerator).toBe(6125000n * c.groupProof!.sourcePtsUs.denominator);
      expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('never lets retrieval onEnded fire for final G before a later-arriving F and native drainage', async () => {
    const f = await fixture(draft), inputEnd = vi.spyOn(SeekCmafInput.prototype, 'end'), outputEnd = vi.spyOn(MseSeekOutput.prototype, 'end');
    try {
      const c = f.prepare(); f.startRetrieval(c); await flush(128); const stream = await f.accept(f.wire[0]!, true, 4n, 1n);
      await f.send(stream, 0); await f.send(stream, 1); await f.server.closeFetchStream(stream); await c.ready;
      expect(f.ended).not.toHaveBeenCalled(); expect(f.consumed).not.toHaveBeenCalled(); expect(inputEnd).not.toHaveBeenCalled(); expect(outputEnd).not.toHaveBeenCalled();
      const cut = await f.arm(); cut.commit(c); await flush(128); f.complete(1); await flush(128);
      expect(f.ended).not.toHaveBeenCalled(); f.complete(2); await flush(128);
      expect(f.ended).toHaveBeenCalledOnce(); expect(inputEnd).toHaveBeenCalledOnce(); expect(outputEnd).toHaveBeenCalledExactlyOnceWith('video');
    } finally { inputEnd.mockRestore(); outputEnd.mockRestore(); await f.destroy(); }
  });

  it('closes on later DATA before parser entry without requiring that target request FIN', async () => {
    const f = await fixture(draft), decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    try {
      const c = f.prepare(), page = await f.open(c, undefined, { groupId: 5n, objectId: 1n });
      const stream = await f.accept(page.requestId, false, 5n, 0n); await f.send(stream, 0); await f.send(stream, 1);
      await f.send(stream, 0, 5n, f.higher); await f.server.closeFetchStream(stream); await c.ready;
      expect(decode.mock.calls.filter(([g]) => g === 5n)).toHaveLength(0); expect(f.closed).not.toHaveBeenCalled(); expect(f.consumed).not.toHaveBeenCalled();
      const cut = await f.arm(); cut.commit(c); await flush(128); f.complete(1); await flush(128); f.complete(2); await flush(128);
      expect(decode.mock.calls.filter(([g]) => g === 5n)).toHaveLength(1); f.complete(3); await flush(128);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith(page.id, 'fin'); expect(f.consumed).toHaveBeenCalledExactlyOnceWith(page.id, 'native');
    } finally { decode.mockRestore(); await f.destroy(); }
  });
});

it('CONTROL: existing indexed-boundary readiness remains first-prefix readiness, not a whole-group assertion', async () => {
  const f = await fixture(18);
  try {
    const c = f.prepare('indexed-boundary'), page = await f.open(c), stream = await f.accept(page.requestId, false);
    await f.send(stream, 0); await c.ready; expect(c.boundary).not.toBeNull(); expect(f.native).toHaveLength(1);
  } finally { await f.destroy(); }
});

describe('complete-group admission refusals and bounds', () => {
  it.each(['overlap', 'hole'] as const)('refuses a closed group with %s before shared/native mutation', async kind => {
    const f = await fixture(18, 'cmaf');
    try {
      const c = f.prepare(), p = await f.open(c, undefined, { groupId: 4n, objectId: 2n }), stream = await f.accept(p.requestId, true, 4n, 1n);
      await f.send(stream, 0); await f.send(stream, 1, 4n, kind === 'overlap' ? f.chunk(6125n, -126) : f.chunk(6125n, -125, 100));
      await f.server.closeFetchStream(stream); await c.ready; const cut = await f.arm();
      expect(() => cut.commit(c)).toThrow(/floor|gap|continuous/); expect(f.native).toHaveLength(1); expect(cut.current).toBe(true);
      c.cancel(); cut.resume(); await flush(128); f.complete(1); await flush(128);
      expect(f.failures).not.toHaveBeenCalled(); expect(f.resource.position).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it.each([18, 22] as const)('rejects unknown FETCH range coverage touching G without blaming the session: draft%i', async draft => {
    const f = await fixture(draft);
    try {
      const c = f.prepare(), rejected = expect(c.ready).rejects.toThrow(/unknown|coverage/), p = await f.open(c, undefined, { groupId: 4n, objectId: 2n });
      const stream = await f.accept(p.requestId, true, 4n, 1n); await f.send(stream, 0);
      await f.server.sendFetchEndOfRange(stream, false, 4n, 1n); await flush(128); await rejected;
      expect(f.native).toHaveLength(1); expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('accepts proven nonexistent sparse IDs without treating the range marker as EOG', async () => {
    const f = await fixture(22, 'cmaf');
    try {
      f.base.location.objectId = 2n; const c = f.prepare(), ready = vi.fn(); void c.ready.then(ready, () => {});
      const p = await f.open(c, undefined, { groupId: 4n, objectId: 4n }), stream = await f.accept(p.requestId, true, 4n, 3n);
      await f.server.sendFetchEndOfRange(stream, true, 4n, 1n); await flush(128);
      expect(ready).not.toHaveBeenCalled(); expect(c.groupProof).toBeNull();
      await f.send(stream, 2, 4n, f.payloads[0]!); await f.send(stream, 3, 4n, f.payloads[1]!); await f.server.closeFetchStream(stream); await c.ready;
      expect(c.groupProof?.location.objectId).toBe(2n); const cut = await f.arm(); cut.commit(c); await flush(128);
      f.complete(1); await flush(128); f.complete(2); await flush(128); expect(f.targetErrors).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it.each(['exact', 'exceeded'] as const)('charges retained media and interval facts within maxBytes: %s', async size => {
    // Charge actual canonical bytes, two source facts and one merged union.
    const chunkBytes = buildChunk({ trackId: 1, bmdt: 6000n, samples: [{ duration: 125, size: 4, flags: SYNC_FLAGS, cto: 125 }], mdat: new Uint8Array(4) }).length;
    const f = await fixture(18, 'cmaf', { maxObjects: 30, maxBytes: size === 'exact' ? 2 * chunkBytes + 3 * 64 : chunkBytes + 64 });
    try {
      const c = f.prepare(), p = await f.open(c, undefined, { groupId: 4n, objectId: 2n });
      const rejected = size === 'exceeded' ? expect(c.ready).rejects.toThrow(/proof.*byte budget/) : null;
      const stream = await f.accept(p.requestId, true, 4n, 1n); await f.send(stream, 0);
      if (rejected) { await rejected; expect(f.native).toHaveLength(1); expect(f.failures).not.toHaveBeenCalled(); }
      else { await f.send(stream, 1); await f.server.closeFetchStream(stream); await c.ready; expect(c.groupProof?.coverage).toHaveLength(1); }
    } finally { await f.destroy(); }
  });

  it('does not close a group at a finite same-G FIN with a pending legacy moof half', async () => {
    const f = await fixture(18, 'cmaf');
    try {
      const c = f.prepare(), bytes = f.payloads[0]!, split = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0), first = await f.open(c);
      const stream = await f.accept(first.requestId, false); await f.send(stream, 0, 4n, bytes.slice(0, split));
      await f.server.closeFetchStream(stream); await flush(128); expect(f.consumed).toHaveBeenCalledExactlyOnceWith(first.id, 'prepared'); expect(c.groupProof).toBeNull();
      const second = await f.open(c, { groupId: 4n, objectId: 1n }, { groupId: 4n, objectId: 2n });
      const next = await f.accept(second.requestId, true, 4n, 1n); await f.send(next, 1, 4n, bytes.slice(split));
      await f.server.closeFetchStream(next); await c.ready; expect(c.groupProof?.closedBy).toBe('track-end');
    } finally { await f.destroy(); }
  });

  it('refuses true group closure with an incomplete pair', async () => {
    const f = await fixture(18, 'cmaf');
    try {
      const c = f.prepare(), rejected = expect(c.ready).rejects.toThrow(/complete indexed/), p = await f.open(c), bytes = f.payloads[0]!;
      const stream = await f.accept(p.requestId, true); await f.send(stream, 0, 4n, bytes.slice(0, new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)));
      await f.server.closeFetchStream(stream); await rejected; expect(f.native).toHaveLength(1); expect(f.failures).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('cancels a held higher raw owner and ignores its late acceptance while a successor prepares', async () => {
    const f = await fixture(22);
    try {
      const old = f.prepare(), op = await f.open(old, undefined, { groupId: 5n, objectId: 1n }), os = await f.accept(op.requestId, false, 5n, 0n);
      await f.send(os, 0); await f.send(os, 1); await f.send(os, 0, 5n, f.higher); await old.ready;
      op.cancel(); old.cancel(); await flush(128); const current = f.prepare(), p = await f.open(current, undefined, { groupId: 4n, objectId: 2n });
      const stream = await f.accept(p.requestId, true, 4n, 1n); await f.send(stream, 0); await f.send(stream, 1); await f.server.closeFetchStream(stream); await current.ready;
      const proof = current.groupProof; old.acceptPage(op.id, true); expect(old.groupProof).toBeNull(); expect(current.groupProof).toBe(proof);
      const cut = await f.arm(); cut.commit(current); await flush(128); f.complete(1); await flush(128); f.complete(2); await flush(128);
      expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

describe('retained floor after promotion', () => {
  it.each([false, true])('fails only the new owner for a future source/emitted minimum below F, emitted=%s', async emitted => {
    const f = await fixture(18, 'cmaf', undefined, true, emitted);
    try {
      const audio = f.actor.roleOwner('audio'), c = f.prepare(), p = await f.open(c, undefined, { groupId: 5n, objectId: 1n });
      const stream = await f.accept(p.requestId, false, 5n, 0n); await f.send(stream, 0); await f.send(stream, 1);
      await f.send(stream, 0, 5n, emitted ? f.higher : f.chunk(5500n, 0, 125, SYNC_FLAGS)); await c.ready;
      const cut = await f.arm(); cut.commit(c); await flush(128); f.complete(2); await flush(128); f.complete(3); await flush(128);
      expect(f.native).toHaveLength(4); expect(f.targetErrors.mock.calls.some(call => call.some(value => value instanceof Error && /sample precedes/.test(value.message)))).toBe(true);
      expect(() => c.beginPage({})).toThrow(/requires reset/); expect(() => c.beginLive({})).toThrow(/requires reset/);
      expect(f.actor.roleOwner('audio')).toBe(audio); const id = {}, ar = f.actor.beginPage('audio', id); f.actor.acceptPage('audio', id, false);
      const bytes = buildChunk({ trackId: 2, bmdt: 6000n, samples: [{ duration: 125, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
      const work = ar.onObject(object(bytes, 3n, 1n)); void work.catch(() => {}); await flush(128); f.complete(4); await work;
      expect(f.failures).not.toHaveBeenCalled(); expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.resource.initialize).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});

it('keeps whole-group proof and cut authority distinct when final admission reenters with a successor cut', async () => {
  const f = await fixture(18);
  try {
    let armed = false, used = false, successor: SeekRoleCutHold | undefined;
    f.base.isCurrent = () => {
      if (armed && !used) { used = true; cut.resume(); successor = f.actor.holdRole('video', f.actor.roleOwner('video')!, { beforeGroup: 4n }); }
      return true;
    };
    const c = f.prepare(), p = await f.open(c, undefined, { groupId: 4n, objectId: 2n }), stream = await f.accept(p.requestId, true, 4n, 1n);
    await f.send(stream, 0); await f.send(stream, 1); await f.server.closeFetchStream(stream); await c.ready;
    const proof = c.groupProof, cut = await f.arm(); armed = true;
    expect(() => cut.commit(c)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(c.groupProof).toBe(proof); expect(f.native).toHaveLength(1);
    await successor!.reached; await successor!.nativeSettled; successor!.commit(c); await flush(128);
    f.complete(1); await flush(128); f.complete(2); await flush(128);
    expect(f.failures).not.toHaveBeenCalled(); expect(f.resource.position).toHaveBeenCalledOnce();
  } finally { await f.destroy(); }
});

it('does not let an unknown range wholly after proven G-tail coverage invalidate G', async () => {
  const f = await fixture(22);
  try {
    const c = f.prepare(), ready = vi.fn(); void c.ready.then(ready, () => {});
    const p = await f.open(c, undefined, { groupId: 5n, objectId: 2n }), stream = await f.accept(p.requestId, false, 5n, 1n);
    await f.send(stream, 0); await f.send(stream, 1);
    await f.server.sendFetchEndOfRange(stream, true, 5n, 0n); await flush(128);
    expect(ready).not.toHaveBeenCalled(); // A range marker alone is not EOG.
    await f.server.sendFetchEndOfRange(stream, false, 5n, 1n); await f.server.closeFetchStream(stream); await c.ready;
    expect(c.groupProof?.closedBy).toBe('range-fin'); expect(f.native).toHaveLength(1);
    const cut = await f.arm(); cut.commit(c); await flush(128); f.complete(1); await flush(128); f.complete(2); await flush(128);
    expect(f.targetErrors).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
  } finally { await f.destroy(); }
});


// This tests the actor input contract after receipt acceptance. Actual standalone
// SDK DATA admission already rejects an earlier Location; transforms and range
// markers must not make the actor rely on that earlier boundary implicitly.
describe.each([18, 22] as const)('actor-local accepted page lower bound draft%i', draft => {
  it.each(['data', 'gap'] as const)('refuses a predecessor on a later page: %s', async kind => {
    const f = await fixture(draft, 'cmaf');
    try {
      const c = f.prepare(), rejected = vi.fn(); void c.ready.catch(rejected);
      const first = await f.open(c), stream = await f.accept(first.requestId, false);
      await f.send(stream, 0); await f.server.closeFetchStream(stream); await flush(128);
      expect(f.consumed).toHaveBeenCalledExactlyOnceWith(first.id, 'prepared');
      const id = {}, page = c.beginPage(id);
      c.acceptPage(id, false, { start: { groupId: 4n, objectId: 1n },
        through: { kind: 'before', groupId: 4n, objectId: 2n }, endOfTrack: false, groupOrder: 'ascending', rangeFilters: false });
      const raw: MoqtObject = kind === 'data' ? object(f.payloads[0]!, 4n, 0n)
        : { kind: 'gap', groupId: varint(4n), objectId: varint(0n), status: 1n, trackAlias: varint(0), subgroupId: varint(0) };
      const refused = vi.fn(); await page.onObject(raw).catch(refused); await flush(128);
      expect(refused).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringMatching(/accepted range/) }));
      expect(rejected).toHaveBeenCalledOnce(); expect(c.groupProof).toBeNull();
      expect(f.native).toHaveLength(1); expect(f.resource.current).toBe(true);
      expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('keeps the exact later-page start admissible', async () => {
    const f = await fixture(draft, 'cmaf');
    try {
      const c = f.prepare(), first = await f.open(c), stream = await f.accept(first.requestId, false);
      await f.send(stream, 0); await f.server.closeFetchStream(stream); await flush(128);
      const id = {}, page = c.beginPage(id);
      c.acceptPage(id, true, { start: { groupId: 4n, objectId: 1n },
        through: { kind: 'before', groupId: 4n, objectId: 2n }, endOfTrack: true, groupOrder: 'ascending', rangeFilters: false });
      await page.onObject(object(f.payloads[1]!, 4n, 1n)); page.onClosed('fin'); await c.ready;
      expect(c.groupProof?.closedBy).toBe('track-end'); expect(f.targetErrors).not.toHaveBeenCalled();
      expect(f.native).toHaveLength(1); expect(f.resource.current).toBe(true); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

// Health is retained-consumer state, independently of a request's error channel.
async function promotedHealth(draft: 18 | 22) {
  const f = await fixture(draft, 'cmaf'), candidate = f.prepare();
  const page = await f.open(candidate, undefined, { groupId: 5n, objectId: 1n }, true);
  const stream = await f.accept(page.requestId, false, 5n, 0n);
  await f.send(stream, 0); await f.send(stream, 1); await f.send(stream, 0, 5n, f.higher);
  await candidate.ready; const cut = await f.arm(); cut.commit(candidate); await flush(128);
  f.complete(1); await flush(128); f.complete(2); await flush(128); f.complete(3); await flush(128);
  await f.server.closeFetchStream(stream); await flush(128);
  return { f, candidate, page };
}
function observeFormatInput() {
  let input: SeekCmafInput | null = null;
  const original = SeekCmafInput.prototype.push;
  const spy = vi.spyOn(SeekCmafInput.prototype, 'push').mockImplementation(function(this: SeekCmafInput, ...args) {
    if (args[0].groupId >= 4n) input = this;
    return original.apply(this, args);
  });
  return { get input() { return input; }, restore() { spy.mockRestore(); } };
}

describe.each([18, 22] as const)('retained role health draft%i', draft => {
  it('reports a real source-floor failure before discard observers can reenter', async () => {
    const f = await fixture(draft, 'cmaf');
    try {
      const c = f.prepare(), page = await f.open(c, undefined, { groupId: 5n, objectId: 1n }, true);
      const stream = await f.accept(page.requestId, false, 5n, 0n);
      await f.send(stream, 0); await f.send(stream, 1); await f.send(stream, 0, 5n, f.chunk(5500n, 0, 125, SYNC_FLAGS)); await c.ready;
      const atDiscard: boolean[] = []; f.discarded.mockImplementation(() => { atDiscard.push(c.requiresReset); });
      const cut = await f.arm(); cut.commit(c); await flush(128); f.complete(1); await flush(128); f.complete(2); await flush(128);
      expect(c.requiresReset).toBe(true); expect(atDiscard).not.toHaveLength(0); expect(atDiscard.every(Boolean)).toBe(true);
      expect(f.targetErrors).toHaveBeenCalled(); expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each(['assembly', 'submission'] as const)('latches %s failure while the parsed input remains ready, before diagnostic disposal', async origin => {
    const { f, candidate: c } = await promotedHealth(draft), format = observeFormatInput();
    let restore: (() => void) | undefined;
    try {
      if (origin === 'assembly') {
        const spy = vi.spyOn(f.assembler(), 'push').mockImplementation(() => { throw new Error('controlled assembly failure'); });
        restore = () => spy.mockRestore();
      } else {
        const spy = vi.spyOn(MseSeekOutput.prototype, 'append').mockImplementation(() => { throw new Error('controlled submission failure'); });
        restore = () => spy.mockRestore();
      }
      const atDiscard: boolean[] = []; f.discarded.mockImplementation(() => { atDiscard.push(c.requiresReset); });
      const page = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n }, true);
      const stream = await f.accept(page.requestId, false, 5n, 1n);
      await f.server.sendFetchObject(stream, { groupId: 5n, objectId: 1n, subgroupId: 0n, publisherPriority: 128, payload: f.chunk(6375n) }); await flush(256);
      expect(format.input?.ready).toBe(true); expect(c.requiresReset).toBe(true);
      expect(atDiscard).not.toHaveLength(0); expect(atDiscard.every(Boolean)).toBe(true);
      expect(f.targetErrors).toHaveBeenCalled(); expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { restore?.(); format.restore(); await f.destroy(); }
  });

  it('latches invalid format input before its own discard callback and leaves a reentrant candidate unpoisoned', async () => {
    const { f, candidate: c } = await promotedHealth(draft);
    let successor: SeekRoleCandidate | undefined;
    try {
      const observed: boolean[] = [];
      f.discarded.mockImplementation(() => {
        observed.push(c.requiresReset);
        if (!successor) successor = f.prepare('indexed-boundary');
      });
      const page = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n }, true);
      const stream = await f.accept(page.requestId, false, 5n, 1n);
      await f.server.sendFetchObject(stream, { groupId: 5n, objectId: 1n, subgroupId: 0n, publisherPriority: 128, payload: f.chunk(6375n, 0, 0) }); await flush(256);
      expect(c.requiresReset).toBe(true); expect(observed).not.toHaveLength(0); expect(observed.every(Boolean)).toBe(true);
      expect(successor?.requiresReset).toBe(false); expect(f.protocolErrors).toEqual([]); expect(f.failures).not.toHaveBeenCalled();
    } finally { successor?.cancel(); await f.destroy(); }
  });

  it('keeps lawful later REQUEST_ERROR and request cancellation nonfatal, then processes fresh data with the same consumer', async () => {
    const { f, candidate: c } = await promotedHealth(draft);
    try {
      const denied = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n });
      await f.server.rejectFetch(denied.requestId, 0n, 'historical range unavailable'); await flush(256);
      expect(f.targetErrors).toHaveBeenCalled(); expect(c.requiresReset).toBe(false);
      const cancelled = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n }); cancelled.cancel(); cancelled.receiver.onClosed('reset'); await flush(256);
      expect(c.requiresReset).toBe(false);
      const healthy = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n });
      const stream = await f.accept(healthy.requestId, false, 5n, 1n);
      await f.server.sendFetchObject(stream, { groupId: 5n, objectId: 1n, subgroupId: 0n, publisherPriority: 128, payload: f.chunk(6375n) }); await flush(256);
      expect(f.native).toHaveLength(5); f.complete(4); await flush(128); await f.server.closeFetchStream(stream); await flush(128);
      expect(c.requiresReset).toBe(false); expect(f.failures).not.toHaveBeenCalled(); expect(f.protocolErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('stays false after a preparation refusal even though the unpromoted candidate is retired', async () => {
    const f = await fixture(draft, 'cmaf');
    try {
      const c = f.prepare(), page = await f.open(c); await f.server.rejectFetch(page.requestId, 0n, 'range unavailable'); await flush(128);
      expect(f.targetErrors).toHaveBeenCalled(); expect(c.requiresReset).toBe(false); expect(f.failures).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});

it('reads pure actor-local health and keeps retired predecessor state separate from its promoted successor', async () => {
  const { f, candidate: old, page: oldPage } = await promotedHealth(18);
  try {
    f.admissions.mockImplementation(() => { throw new Error('health must not call admission'); }); f.admissions.mockClear();
    const native = vi.spyOn(f.resource, 'current', 'get').mockImplementation(() => { throw new Error('health must not read native'); });
    const offset = vi.spyOn(f.resource, 'getTimestampOffset'), offsetCalls = offset.mock.calls.length; f.checks.mockClear();
    expect(old.requiresReset).toBe(false); expect(old.requiresReset).toBe(false);
    expect(f.admissions).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(f.checks).not.toHaveBeenCalled();
    expect(offset).toHaveBeenCalledTimes(offsetCalls);
    native.mockRestore(); f.admissions.mockImplementation(() => true);
    const next = f.prepare('indexed-boundary'), page = await f.open(next), stream = await f.accept(page.requestId, false);
    await f.send(stream, 0); await next.ready; const hold = f.actor.holdRole('video', f.actor.roleOwner('video')!); await hold.nativeSettled; hold.commit(next);
    await flush(128); f.complete(4); await flush(128);
    expect(old.requiresReset).toBe(true); expect(next.requiresReset).toBe(false);
    oldPage.receiver.onClosed('error'); old.acceptPage(oldPage.id, true); expect(next.requiresReset).toBe(false);
    f.actor.cancel(); expect(next.requiresReset).toBe(true);
  } finally { await f.destroy(); }
});

function rejectedObserver() {
  const result = Promise.reject<void>(new Error('diagnostic observer rejection'));
  void result.then(undefined, () => {});
  const owned = vi.spyOn(result, 'catch');
  return { result, owned };
}
describe('discard observer ownership', () => {
  it('retains async rejection ownership through the promoted format-discard wrapper', async () => {
    const { f, candidate: c } = await promotedHealth(18), observer = rejectedObserver();
    try {
      f.discarded.mockImplementation(() => observer.result);
      const page = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n }, true);
      const stream = await f.accept(page.requestId, false, 5n, 1n);
      await f.server.sendFetchObject(stream, { groupId: 5n, objectId: 1n, subgroupId: 0n, publisherPriority: 128, payload: f.chunk(6375n, 0, 0) });
      await flush(256);
      expect(c.requiresReset).toBe(true); expect(f.discarded).toHaveBeenCalledOnce();
      expect(observer.owned).toHaveBeenCalledOnce();
      expect(f.failures).not.toHaveBeenCalled();
    } finally { f.discarded.mockReset(); observer.owned.mockRestore(); await f.destroy(); }
  });
  it('CONTROL: unchanged input owns async diagnostic rejection when its result reaches that input', async () => {
    const observer = rejectedObserver(), init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
    const input = new SeekCmafInput({ init, packaging: 'cmaf', role: 'video', location: { groupId: 4n, objectId: 0n },
      mediaPts: 6000, timestampRounding: 'floor', maxObjects: 10, maxBytes: 8192, onDiscard: () => observer.result });
    try {
      const bytes = buildChunk({ trackId: 1, bmdt: 6000n, samples: [{ duration: 0, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
      expect(() => input.push(object(bytes), {})).toThrow(); await flush(64);
      expect(observer.owned).toHaveBeenCalledOnce();
    } finally { observer.owned.mockRestore(); input.cancel(); }
  });
  it('CONTROL: synchronous observers see sticky reset state through the wrapper', async () => {
    const { f, candidate: c } = await promotedHealth(18);
    try {
      const atDiscard: boolean[] = []; f.discarded.mockImplementation(() => { atDiscard.push(c.requiresReset); });
      const page = await f.open(c, { groupId: 5n, objectId: 1n }, { groupId: 5n, objectId: 2n }, true);
      const stream = await f.accept(page.requestId, false, 5n, 1n);
      await f.server.sendFetchObject(stream, { groupId: 5n, objectId: 1n, subgroupId: 0n, publisherPriority: 128, payload: f.chunk(6375n, 0, 0) });
      await flush(256); expect(atDiscard).toEqual([true]); expect(f.failures).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});

describe.each([18, 22] as const)('parsed queue health draft%i', draft => {
  it('marks actual processed-chunk loss on reset before discard callbacks', async () => {
    const format = observeFormatInput(), f = await fixture(draft, 'cmaf');
    try {
      const c = f.prepare(), page = await f.open(c, undefined, { groupId: 5n, objectId: 1n }, true);
      const stream = await f.accept(page.requestId, false, 5n, 0n);
      await f.send(stream, 0); await f.send(stream, 1); await f.send(stream, 0, 5n, f.higher); await c.ready;
      const cut = await f.arm(); cut.commit(c); await flush(128);
      expect(f.native).toHaveLength(2); // Initial old media + first target append, held natively.
      expect(format.input?.ready).toBe(true); expect(c.requiresReset).toBe(false);
      const atDiscard: boolean[] = []; f.discarded.mockClear();
      f.discarded.mockImplementation(() => { atDiscard.push(c.requiresReset); });
      page.receiver.onClosed('reset'); // Public actor terminal seam after real SDK preparation.
      await flush(128); expect(f.discarded).toHaveBeenCalled();
      expect(format.input?.ready).toBe(true); expect(f.native).toHaveLength(2);
      expect(c.requiresReset).toBe(true);
      expect(atDiscard.every(Boolean)).toBe(true);
      f.complete(1); await flush(128); expect(f.native).toHaveLength(2);
      expect(f.failures).not.toHaveBeenCalled();
    } finally { format.restore(); await f.destroy(); }
  });
});
