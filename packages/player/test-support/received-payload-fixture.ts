/** Actual root SDK/player/assembler inputs; old private estimator read, no capacity or native-rendering claim. */
import { expect, vi } from 'vitest';
import { MoqtPlayer } from '@openmoq/player';
import { MoqtConnection } from '@openmoq/webtransport';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { serializeLocmafObject } from '@openmoq/locmaf';
import type { MediaSourceLike } from '../src/interfaces.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildChunk, videoInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';


type Receipt = { readonly bytes: number; readonly nowUs: number };
type Measurement = { readVideoReceivedRate(): number | null; recordVideoPayload(receipt?: Receipt): void };
const measurement = (player: MoqtPlayer) => player as unknown as Measurement;
export const readRate = (player: MoqtPlayer) => measurement(player).readVideoReceivedRate();
export function observeReceiptSamples(player: MoqtPlayer) {
  const spy = vi.spyOn(measurement(player), 'recordVideoPayload');
  return { calls: () => spy.mock.calls.flatMap(([receipt]) => receipt ? [[receipt.bytes, receipt.nowUs]] : []),
    restore: () => spy.mockRestore() };
}

export async function fixture(format: 'cmaf' | 'locmaf' = 'cmaf', alternative = false) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const transportErrors: string[] = [];
  client.onError = server.onError = error => { transportErrors.push(error.message); };
  await Promise.all([client.connect(a), server.connect(b)]);
  let nowUs = 1_000_000, attached = true;
  let clockHook: (() => void) | undefined;
  let assembler: CmafAssembler | undefined;
  const groupStreams = new Map<bigint, bigint>();
  const requests: bigint[] = [], errors: string[] = [], delivered: bigint[] = [], receipts: number[] = [], appended: number[] = [];
  server.onSubscribe = id => { requests.push(id); };
  const source: MediaSourceLike = { supportsTrackIdentity: true, initialize: () => true,
    get attached() { return attached; }, onAttached: null,
    appendChunk: (_role, bytes) => { appended.push(bytes.byteLength); }, reset() {}, endOfStream() {}, destroy() {},
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null };
  const player = new MoqtPlayer({
    url: 'https://rate.example/moq', namespace: ['live'], draftVersion: 18, connection: client,
    createTransport: async () => a, disableAudio: true, autoQuality: false,
    clock: { now: () => { const callback = clockHook; clockHook = undefined; callback?.(); return nowUs; } }, selection: { videoTrack: { name: 'v' } },
    catalog: { tracks: [{ name: 'v', packaging: format, role: 'video', ...(format === 'locmaf' ? { locmafVersion: '0.3' } : {}), isLive: true,
      codec: 'avc1.640028', bitrate: 4_000_000, initData: Buffer.from(videoInit()).toString('base64'), ...(alternative ? { altGroup: 7 } : {}) },
      ...(alternative ? [{ name: 'v2', packaging: format, role: 'video' as const, isLive: true, altGroup: 7,
        ...(format === 'locmaf' ? { locmafVersion: '0.3' } : {}), codec: 'avc1.640028', bitrate: 8_000_000,
        initData: Buffer.from(videoInit()).toString('base64') }] : [])] },
    createMediaSource: () => source,
    createCmafAssembler: callbacks => { assembler = new CmafAssembler(callbacks); return assembler; },
  });
  player.on('error', event => { errors.push(event.error.message); });
  player.on('media_object', event => { if (event.kind === 'data') delivered.push(event.objectId); });
  const stop = client.observeObjectReceipts(event => {
    if (event.origin === 'subgroup' && event.trackAlias === 77n && event.payloadBytes > 0) receipts.push(event.payloadBytes);
  });
  async function send(index: number, bytes: number, group = BigInt(Math.floor(index / 25) + 1), object = BigInt(index % 25)) {
    const make = (size: number) => buildChunk({ trackId: 1, bmdt: BigInt(index) * 3600n,
      samples: [{ duration: 3600, size, flags: SYNC_FLAGS }], mdat: new Uint8Array(size) });
    const wrap = (data: Uint8Array) => format === 'locmaf' ? serializeLocmafObject({ kind: 'rawBoxes', boxes: data }) : data;
    const payload = wrap(make(bytes - wrap(make(0)).byteLength));
    expect(payload.byteLength).toBe(bytes);
    let stream = format === 'locmaf' ? groupStreams.get(group) : undefined;
    if (stream === undefined) {
      stream = await server.openSubgroup(77n, group, format === 'locmaf' ? 0n : object, { publisherPriority: 128 });
      if (format === 'locmaf') groupStreams.set(group, stream);
    }
    await server.sendObject(stream, object, payload);
    if (format === 'cmaf' || object === 24n) { await server.closeSubgroup(stream); groupStreams.delete(group); }
    await flush(128);
  }
  await player.load(); await flush(128); expect(requests).toHaveLength(1);
  player.play(); expect(player.state).toBe('playing');
  return { player, client, server, requests, errors, transportErrors, delivered, receipts, appended, send,
    setNow(value: number) { nowUs = value; },
    setClockHook(callback: () => void) { clockHook = callback; },
    source, setAttached(value: boolean) { attached = value; },
    assembler() { if (!assembler) throw new Error('Expected actual assembler'); return assembler; },
    response: a.bidiOut[0]!.in,
    async accept() { await server.acceptSubscribe(requests[0]!, 77n); await flush(128);
      expect(client.session.getSubscription(requests[0]!)?.state).toBe('established');
      expect(player.selection.video).toMatchObject({ name: 'v', namespaceFields: ['live'] }); },
    async close() { stop(); for (const stream of groupStreams.values()) await server.closeSubgroup(stream); groupStreams.clear(); await player.destroy(); await client.close(); await server.close(); },
  };
}
