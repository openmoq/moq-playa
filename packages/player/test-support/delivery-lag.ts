/** Real LOC18 wire and public adapter witnesses; no native rendering or network-capacity claim. */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { codecDescriptionFromInit } from '@openmoq/locmaf';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioPeer, identity } from './audio-selection.js';
import { MoqtPlayer } from '../src/player.js';
import type { VideoDecoderLike, VideoRendererLike } from '../src/interfaces.js';
import type { PlayerError } from '../src/errors.js';
import type { QualitySwitchedEvent } from '../src/events.js';
import type { MoqtPlayerConfig } from '../src/config.js';

const namespace = ['live', 'delivery-trend'];
const refs = {
  catalog: { namespace, name: 'catalog' },
  high: { namespace, name: 'video-high' },
  low: { namespace, name: 'video-low' },
};
const SOURCE_EPOCH_US = 1_762_000_000_000_000n;
const STEP_US = 40_000;
interface Delivery { readonly captureUs: bigint; readonly arrivalUs: number }
interface SendOptions { readonly tick?: boolean; readonly timestamp?: boolean; readonly timescale?: bigint; readonly marker?: number }
const deliveries = (from: number, count: number, lagAt: (i: number) => number): Delivery[] =>
  Array.from({ length: count }, (_, n) => {
    const i = from + n;
    return { captureUs: SOURCE_EPOCH_US + BigInt(i * STEP_US), arrivalUs: 1_000_000 + i * STEP_US + lagAt(i) };
  }).sort((a, b) => a.arrivalUs - b.arrivalUs);
const baseline = () => deliveries(0, 40, () => 20_000);
const rising = () => deliveries(40, 50, i => 20_000 + (i - 40) * 20_000);

async function fixture(options: { finite?: boolean; manual?: boolean; draft?: 16 | 18 | 22; cooldownMs?: number;
  authorization?: NonNullable<MoqtPlayerConfig['authorization']>; objectTransform?: MoqtPlayerConfig['objectTransform'] } = {}) {
  const draft = options.draft ?? 18, wire = audioPeer(draft);
  const errors: PlayerError[] = [], received: Array<{ track: string; captureUs?: bigint }> = [];
  const decoded: Array<{ marker: number; timestamp: number }> = [], enqueued: number[] = [];
  const switched: QualitySwitchedEvent[] = [];
  const published = new Map<string, { group: bigint; object: bigint }>();
  wire.server.setLargestLocationProvider(id => {
    const request = wire.requests.find(request => request.id === id);
    return request ? published.get(request.name) ?? null : null;
  });
  let now = 1_000_000, nextObject = 0n, group = 70n, closed = false;
  let clockEffect: (() => void) | undefined, onWarning: ((message: string) => void) | undefined;
  const decoder: VideoDecoderLike = {
    configure() {},
    decode(chunk, at, input) {
      const marker = chunk.data[5];
      if (marker === undefined) throw new Error('Video payload has no identity marker');
      decoded.push({ marker, timestamp: chunk.timestamp });
      decoder.onFrame?.({ timestamp: chunk.timestamp, marker, close() {} }, at, null, input);
    },
    flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null,
  };
  const renderer: VideoRendererLike = {
    enqueue(frame) {
      if (typeof frame !== 'object' || frame === null || !('marker' in frame) || typeof frame.marker !== 'number') {
        throw new Error('Enqueued frame has no producing payload marker');
      }
      enqueued.push(frame.marker);
    },
    flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null,
  };
  const avc = codecDescriptionFromInit(videoInit());
  if (!avc) throw new Error('No AVC configuration');
  const catalog = new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
    { ...refs.high, namespace: namespace.join('/'), bitrate: 600_000 },
    { ...refs.low, namespace: namespace.join('/'), bitrate: 150_000 },
  ].map(track => ({ ...track, role: 'video', packaging: 'loc', codec: 'avc1.640028', width: 640, height: 360,
    renderGroup: 1, altGroup: 7, isLive: !options.finite, initData: Buffer.from(avc).toString('base64') })) }));
  const player = new MoqtPlayer({ url: 'https://delivery-trend.invalid/moq', namespace, draftVersion: draft,
    clock: { now() { const effect = clockEffect; clockEffect = undefined; effect?.(); return now; } },
    logger: { debug() {}, info() {}, error() {}, warn(message) { onWarning?.(message); } },
    startLevel: 0, qualitySwitchCooldownMs: options.cooldownMs ?? 1, livenessTimeoutMs: 0,
    lateFrameThresholdMs: 5000, maxBufferDepth: 2048, disableAudio: true,
    selection: { renderGroup: 1, videoAltGroup: 7 },
    catalogBootstrap: 'subscribe', reconnectAttempts: 0, connectionTimeoutMs: 1000,
    ...(options.objectTransform ? { objectTransform: options.objectTransform } : {}),
    ...(options.manual ? { autoQuality: false } : {}),
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    createConnection: () => wire.client, createTransport: async () => wire.start(),
    createVideoDecoder: () => decoder, createRenderer: () => renderer,
  });
  player.on('error', event => { errors.push(event.error); });
  player.on('quality_switched', event => { switched.push(event); });
  player.on('media_object', event => { received.push({ track: event.trackName,
    ...(event.captureTimestamp === undefined ? {} : { captureUs: event.captureTimestamp }) }); });
  player.on('session_closed', () => { closed = true; });
  try {
    await player.load(); await wire.accept(refs.catalog, 100n); await wire.send(refs.catalog, catalog, 1n);
    published.set(refs.catalog.name, { group: 1n, object: 0n });
    await wire.accept(refs.high, 200n);
    expect(wire.requests.map(({ name, namespace }) => ({ name, namespace }))).toEqual([refs.catalog, refs.high]);
    expect(player.selection.video).toEqual(identity(refs.high));
    expect(player.selection.videoAlternatives).toEqual([identity(refs.high), identity(refs.low)]);
    expect(player.selection.autoQuality).toBe(!options.manual);
    player.play();
  } catch (error) {
    await player.destroy(); await wire.close();
    throw new Error(`Fixture setup failed: ${String(error)}; errors=${JSON.stringify(errors)}; requests=${wire.requests.map(r => r.name)}`);
  }

  function tick() { player.tick(); }
  async function send(point: Delivery, options: SendOptions = {}) {
    expect(point.arrivalUs).toBeGreaterThanOrEqual(now);
    now = point.arrivalUs;
    const independent = nextObject === 0n;
    const timestamp = options.timestamp === false ? {} : options.timescale === undefined
      ? { captureTimestamp: point.captureUs }
      : { timestamp: point.captureUs * options.timescale / 1_000_000n, timescale: options.timescale };
    await wire.send(refs.high, Uint8Array.of(0, 0, 0, 2, independent ? 0x65 : 0x41, options.marker ?? 11), group, nextObject++,
      encodeLocHeaders({ ...timestamp,
        videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent, discardable: false, baseLayerSync: false, temporalId: 0 },
      }, { wireProfile: locWireProfileForDraft(draft), ...(options.timescale === undefined ? {} : { locVersion: 4 }) }));
    published.set(refs.high.name, { group, object: nextObject - 1n });
    if (options.tick !== false) tick();
    await flush(128);
  }
  async function feed(points: readonly Delivery[], options?: SendOptions) {
    for (const point of points) await send(point, options);
  }
  return { player, wire, errors, received, decoded, enqueued, switched, tick, send, feed,
    lowerRequests: () => wire.requests.filter(request => request.name === refs.low.name),
    get nowUs() { return now; }, get closed() { return closed; },
    newGroup() { group++; nextObject = 0n; },
    onWarning(callback: (message: string) => void) { onWarning = callback; },
    nextClock(callback: () => void) { clockEffect = callback; },
    elapse(us: number) { now += us; },
    advance(us: number) { now += us; tick(); },
    async target(independent: boolean, object: bigint) {
      const captureUs = SOURCE_EPOCH_US + BigInt(now - 1_000_000);
      const group = independent ? 81n : 80n;
      await wire.send(refs.low, Uint8Array.of(0, 0, 0, 2, independent ? 0x65 : 0x41, 22), group, object,
        encodeLocHeaders({ captureTimestamp: captureUs,
          videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent, discardable: false, baseLayerSync: false, temporalId: 0 },
        }, { wireProfile: locWireProfileForDraft(draft) }));
      published.set(refs.low.name, { group, object });
      tick(); await flush(256);
    },
    async destroy() { await player.destroy(); await wire.close(); },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function unchanged(f: Fixture) {
  expect(f.lowerRequests()).toEqual([]);
  expect(f.player.selection.video).toEqual(identity(refs.high));
  expect(f.wire.stopped).not.toContain(f.wire.request(refs.high).id);
  expect(f.switched).toEqual([]);
  expect(f.wire.errors).toEqual([]);
}

async function commitLower(f: Fixture, automatic: boolean) {
  expect(f.player.selection.video).toEqual(identity(refs.high));
  expect(f.switched).toEqual([]);
  expect(f.wire.stopped).not.toContain(f.wire.request(refs.high).id);
  await f.wire.accept(refs.low, 201n);
  expect(f.player.selection.video).toEqual(identity(refs.high));
  expect(f.switched).toEqual([]);
  await f.target(false, 0n);
  expect(f.player.selection.video).toEqual(identity(refs.high));
  expect(f.enqueued).not.toContain(22);
  await f.target(true, 0n);
  expect(f.player.selection.video).toEqual(identity(refs.low));
  expect(f.player.selection.autoQuality).toBe(automatic);
  expect(f.enqueued).toContain(22);
  expect(f.switched).toEqual([expect.objectContaining({ fromTrackName: refs.high.name, toTrackName: refs.low.name })]);
  expect(f.wire.stopped).toContain(f.wire.request(refs.high).id);
  expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
}

// Only the automatic tick interval is parked. Media/receiver time comes solely
// from the injected microclock; performance.now and native time are untouched.
beforeEach(() => { vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });


export type { Delivery };
export { identity, fixture, baseline, rising, deliveries, unchanged, commitLower, refs, SOURCE_EPOCH_US };
