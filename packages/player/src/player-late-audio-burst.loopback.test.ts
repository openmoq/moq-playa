/** Real transport/player/dispatcher with modeled native PCM and video decoding. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import type { SyncController } from '@openmoq/playback';
import { WebAudioOutput } from '../../browser/src/webaudio-output.js';
import type { AudioDecoderLike } from './interfaces.js';
import type { SubscriptionManager } from './subscription-manager.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
const ORIGIN = 1_000_000_000n;

async function fixture(_jumps = false, av = false) {
  let nowUs = 100_000, generation = 0, group = 10n, holdNext = false;
  const pending: Array<() => void> = [];
  const starts: number[] = [];
  const context = {
    state: 'running', destination: {}, get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (channel: number) => planes[channel]! };
    },
    createBufferSource() {
      const node = { buffer: null, onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {}, start(when: number) { starts.push(when); }, stop() { node.onended?.(); } };
      return node;
    },
  };
  const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, { now: () => nowUs });
  const schedules = vi.spyOn(output, 'schedule');
  const decoder: AudioDecoderLike = { configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk, time, input, timing) {
      const admitted = generation;
      const emit = () => {
        if (admitted !== generation) return;
        decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: 960,
          copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, time, input,
          timing ? { context: timing, sourceOffsetUs: 0 } : undefined);
      };
      if (holdNext) { holdNext = false; pending.push(emit); } else emit();
    }, async flush() {}, reset() { generation++; }, destroy() { generation++; } };
  const f = await locSeekFixture(18, true, true, { isLive: true, audioOnly: !av,
    playerConfig: { liveJumpThresholdMs: 3000, createAudioDecoder: () => decoder, createAudioOutput: () => output } });
  f.decoder.decode = vi.fn((chunk, time, input, timing) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, input,
      timing ? { context: timing, sourceTimestamp: { ticks: BigInt(chunk.timestamp), ticksPerSecond: 1_000_000n, domain: 'unix' } } : undefined);
  });
  // Read the real shared timeline; classify history at the real object-routing boundary.
  const graph = f.player as unknown as { syncController: SyncController; subscriptionManager: SubscriptionManager; audioPipeline: import('@openmoq/playback').PlaybackPipeline };
  const offsets: number[] = [], handler = graph.audioPipeline.lateAudioHandler;
  if (handler) graph.audioPipeline.lateAudioHandler = (offset, object) => { offsets.push(offset); return handler(offset, object); };
  const manager = graph.subscriptionManager, deliver = manager.onObject!;
  let history: 'backfill' | 'fetched' | undefined;
  manager.onObject = (role, track, object, headers, input, delivery) =>
    deliver(role, track, object, headers, input, role === 'audio' && history ? { ...delivery, [history]: true } : delivery);
  async function emit(atUs: number, sourceUs: number, origin?: typeof history) {
    nowUs = atUs; f.setNow(atUs); history = origin;
    for (const audio of av ? [true, false] : [true]) {
      const stream = await f.server.openSubgroup(audio ? 201n : 200n, group, 0n,
        { publisherPriority: 128, hasExtensions: true, endOfGroup: true });
      await f.server.sendObject(stream, 0n, audio ? Uint8Array.of(0xf8, 0xff, 0xfe) : Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
        encodeLocHeaders({ captureTimestamp: ORIGIN + BigInt(sourceUs),
          ...(!audio ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
        { wireProfile: locWireProfileForDraft(18), locVersion: 1 }));
      await f.server.closeSubgroup(stream); await flush(128);
    }
    group++; f.advance(atUs); history = undefined;
  }
  const baseline = () => graph.syncController.computeAudioRenderTime(ORIGIN)!.renderTimeUs;
  return { f, emit, baseline, schedules, starts, offsets, graph, holdNext: () => { holdNext = true; }, release: () => pending.splice(0).forEach(emit => emit()),
    align(sourceUs: number) {
      const timestamp = Number(ORIGIN) + sourceUs;
      const audio = schedules.mock.calls.findIndex(call => (call[0] as { timestamp: number }).timestamp === timestamp);
      const video = vi.mocked(f.renderer.enqueue).mock.calls.find(call => (call[0] as { timestamp: number }).timestamp === timestamp);
      expect(audio).toBeGreaterThanOrEqual(0); expect(video).toBeDefined();
      expect(Math.abs(starts[audio]! * 1_000_000 - video![1])).toBeLessThan(20_000);
    }, async destroy() { expect(f.errors).toEqual([]); manager.onObject = deliver; await f.destroy(); } };
}



const due = (i: number) => 100_000 + i * 20_000;
function jumpsOf(t: { f: { player: { on: Function } } }) {
  const jumps: unknown[] = [];
  t.f.player.on('recovery_action', (event: { action: { type: string } }) => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  return jumps;
}
async function hiccup(av: boolean, heldFrames: number) {
  const t = await fixture(true, av), jumps = jumpsOf(t);
  await t.emit(due(0), 0);
  for (let i = 1; i <= 30; i++) await t.emit(due(i), i * 20_000);
  const before = t.baseline(), playedBefore = t.schedules.mock.calls.length;
  const last = 30 + heldFrames, at = due(last) + 20_000;
  for (let i = 31; i <= last; i++) await t.emit(at, i * 20_000);   // held, then released together
  const resumeUs = t.starts[playedBefore]! * 1e6;
  for (let i = last + 1; i <= last + 300; i++) await t.emit(due(i), i * 20_000);
  return { t, jumps, addedUs: t.baseline() - before, silenceUs: resumeUs - (t.starts[playedBefore - 1]! * 1e6 + 20_000) };
}

it(`audio-only: a 600 ms delivery hiccup adds no latency and no extra silence`, async () => {
  const { t, jumps, addedUs, silenceUs } = await hiccup(false, 30);
  try { expect({ addedUs, jumps: jumps.length }).toEqual({ addedUs: 0, jumps: 0 }); expect(silenceUs).toBeLessThanOrEqual(400_000); }
  finally { await t.destroy(); }
});

it(`A/V: a 600 ms hiccup (renderer gap about 340 ms, under its 500 ms stall bound) adds no latency`, async () => {
  const { t, jumps, addedUs } = await hiccup(true, 30);
  try { expect({ addedUs, jumps: jumps.length }).toEqual({ addedUs: 0, jumps: 0 }); }
  finally { await t.destroy(); }
});

it(`audio-only: a 3.6 s outage released as a burst neither slips nor jumps`, async () => {
  const { t, jumps, addedUs } = await hiccup(false, 180);
  try { expect({ addedUs, jumps: jumps.length }).toEqual({ addedUs: 0, jumps: 0 }); }
  finally { await t.destroy(); }
});

it(`control: on-time delivery throughout`, async () => {
  const { t, jumps, addedUs } = await hiccup(true, 0);
  try { expect({ addedUs, jumps: jumps.length }).toEqual({ addedUs: 0, jumps: 0 }); }
  finally { await t.destroy(); }
});

it(`sustained: delivery at 90% of real time for 20 s, then the backlog arrives`, async () => {
  const t = await fixture(true, true);
  try {
    await t.emit(due(0), 0);
    for (let i = 1; i <= 30; i++) await t.emit(due(i), i * 20_000);
    const before = t.baseline();
    let at = due(30);
    for (let i = 31; i <= 1030; i++) { at += 22_222; await t.emit(at, i * 20_000); }
    const peak = (t.baseline() - before) / 1000;
    const played = t.schedules.mock.calls.length;
    // backlog delivered: newest media now arrives on time
    for (let i = 1031; i <= 1400; i++) await t.emit(Math.max(at, due(i)), i * 20_000);
    expect(played - 31).toBe(948);
    expect(peak).toBeLessThanOrEqual(3000);
  } finally { await t.destroy(); }
}, 60_000);
