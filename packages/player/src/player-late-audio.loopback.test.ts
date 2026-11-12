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

async function fixture(_jumps = false, av = false, frameUs = 20_000, threshold = 3000) {
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
        decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: frameUs * 48_000 / 1_000_000,
          copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, time, input,
          timing ? { context: timing, sourceOffsetUs: 0 } : undefined);
      };
      if (holdNext) { holdNext = false; pending.push(emit); } else emit();
    }, async flush() {}, reset() { generation++; }, destroy() { generation++; } };
  const f = await locSeekFixture(18, true, true, { isLive: true, audioOnly: !av,
    playerConfig: { liveJumpThresholdMs: threshold, createAudioDecoder: () => decoder, createAudioOutput: () => output } });
  f.decoder.decode = vi.fn((chunk, time, input, timing) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, input,
      timing ? { context: timing, sourceTimestamp: { ticks: BigInt(chunk.timestamp), ticksPerSecond: 1_000_000n, domain: 'unix' } } : undefined);
  });
  // Read the real shared timeline; classify history at the real object-routing boundary.
  const graph = f.player as unknown as { syncController: SyncController; subscriptionManager: SubscriptionManager; audioPipeline: import('@openmoq/playback').PlaybackPipeline };
  const offsets: number[] = [], handler = graph.audioPipeline.lateAudioHandler;
  if (handler) graph.audioPipeline.lateAudioHandler = (offset, object) => { if (offset < 0) offsets.push(offset); return handler(offset, object); };
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
  return { f, graph, emit, baseline, schedules, starts, offsets, holdNext: () => { holdNext = true; }, release: () => pending.splice(0).forEach(emit => emit()),
    align(sourceUs: number) {
      const timestamp = Number(ORIGIN) + sourceUs;
      const audio = schedules.mock.calls.findIndex(call => (call[0] as { timestamp: number }).timestamp === timestamp);
      const video = vi.mocked(f.renderer.enqueue).mock.calls.find(call => (call[0] as { timestamp: number }).timestamp === timestamp);
      expect(audio).toBeGreaterThanOrEqual(0); expect(video).toBeDefined();
      expect(Math.abs(starts[audio]! * 1_000_000 - video![1])).toBeLessThan(20_000);
    }, async destroy() { expect(f.errors).toEqual([]); manager.onObject = deliver; await f.destroy(); } };
}

it('plays sustained late audio: 30 frames each 400 ms late past the cushion (planner probe)', async () => {
  const t = await fixture();
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 30; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    expect(t.schedules.mock.calls.length - 1).toBe(15);
    expect(t.baseline()).toBe(1_000_000);
    expect(t.offsets.slice(0, 16)).toEqual(Array(16).fill(-400_000));
  } finally { await t.destroy(); }
});

it('on-time frames break the continuous-lateness interval', async () => {
  const t = await fixture();
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 15; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    expect(t.baseline()).toBe(100_000);
    await t.emit(1_010_000, 910_000); // on time between two late periods
    for (let i = 1; i <= 15; i++) await t.emit(1_010_000 + i * 20_000, 310_000 + i * 20_000);
    expect(t.baseline()).toBe(100_000);
    await t.emit(1_330_000, 630_000); expect(t.baseline()).toBe(1_000_000);
  } finally { await t.destroy(); }
});

it.each(['backfill', 'fetched'] as const)('never absorbs %s audio, with a live sustained-late control', async origin => {
  const t = await fixture();
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 30; i++) await t.emit(700_000 + i * 20_000, i * 20_000, origin);
    expect(t.schedules).toHaveBeenCalledTimes(1); expect(t.baseline()).toBe(100_000);
    for (let i = 31; i <= 46; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    expect(t.schedules).toHaveBeenCalledTimes(2); expect(t.baseline()).toBe(1_000_000);
  } finally { await t.destroy(); }
});

it('does not absorb late audio just after a jump; counting starts after the two-second settle window', async () => {
  const t = await fixture(true), jumps: unknown[] = [];
  t.f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  try {
    await t.emit(100_000, 0); await t.emit(1_200_000, 6_000_000); await t.emit(2_300_000, 6_020_000);
    expect(jumps).toHaveLength(1);
    const baseline = t.baseline(), scheduled = t.schedules.mock.calls.length;
    for (let i = 0; i < 30; i++) {
      const at = 3_420_000 + i * 20_000;
      await t.emit(at, at - baseline - 600_000);
    }
    expect(t.schedules).toHaveBeenCalledTimes(scheduled); expect(t.baseline()).toBe(baseline);
    for (let i = 0; i < 15; i++) {
      const at = 4_310_000 + i * 20_000;
      await t.emit(at, at - baseline - 600_000);
    }
    expect(t.baseline()).toBe(baseline);
    await t.emit(4_610_000, 4_610_000 - baseline - 600_000);
    expect(t.baseline()).toBe(baseline + 900_000); expect(t.schedules).toHaveBeenCalledTimes(scheduled + 1);
  } finally { await t.destroy(); }
});

it('retires pre-slip audio decoding and schedules fresh audio and video together', async () => {
  const t = await fixture(false, true);
  try {
    await t.emit(100_000, 0); t.holdNext(); await t.emit(120_000, 20_000);
    for (let i = 2; i <= 17; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    expect(t.schedules).toHaveBeenCalledTimes(2); expect(t.offsets).toHaveLength(16);
    expect(t.baseline()).toBe(100_000 - t.offsets.at(-1)! + 500_000);
    t.release(); expect(t.schedules).toHaveBeenCalledTimes(2);
    await t.emit(1_060_000, 360_000); t.align(360_000);
  } finally { await t.destroy(); }
});

it('accepts steady lateness from 60 ms Opus-like frames after 300 ms, never sooner', async () => {
  const t = await fixture(false, false, 60_000);
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 5; i++) await t.emit(700_000 + i * 60_000, i * 60_000);
    expect(t.baseline()).toBe(100_000);
    await t.emit(1_060_000, 360_000); expect(t.baseline()).toBe(1_000_000);
  } finally { await t.destroy(); }
});

it('a slip flushes already queued video, not only the audio decoder', async () => {
  const t = await fixture(false, true), queued: unknown[] = [];
  t.f.renderer.enqueue = vi.fn(frame => { queued.push(frame); });
  t.f.renderer.flush = vi.fn(() => { queued.length = 0; });
  try {
    await t.emit(100_000, 0); const stale = queued[0]; expect(stale).toBeDefined();
    for (let i = 1; i <= 16; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    expect(queued).not.toContain(stale); expect(t.baseline()).toBeGreaterThan(100_000);
  } finally { await t.destroy(); }
});

it.each(['state', 'playbackIntent', 'seekIsPreparing', 'activeMseSeek', 'pendingVideoSwitch', 'switchInProgress', 'mediaSelection'] as const)
('a delayed admitted audio ask cannot slip behind the %s guard', async guard => {
  const t = await fixture();
  // The input was already admitted before the guard changed; bypassing routing
  // exercises the late hook's own lifecycle check rather than an earlier gate.
  let object: import('@openmoq/transport').MoqtObjectData | undefined;
  const manager = t.graph.subscriptionManager, deliver = manager.onObject!;
  manager.onObject = (...args) => { if (args[2].kind === 'data') object = args[2]; deliver(...args); };
  const player = t.f.player as unknown as Record<string, unknown>;
  try {
    await t.emit(100_000, 0); const handler = t.graph.audioPipeline.lateAudioHandler!;
    const restore = guard === 'state' ? vi.spyOn(t.f.player, 'state', 'get').mockReturnValue('paused')
      : guard === 'seekIsPreparing' ? vi.spyOn(t.f.player as unknown as { seekIsPreparing(): boolean }, 'seekIsPreparing').mockReturnValue(true) : null;
    const prior = player[guard];
    if (!restore) player[guard] = guard === 'playbackIntent' ? false : guard === 'activeMseSeek' ? { positioned: true } : true;
    for (let i = 0; i <= 20; i++) { t.f.setNow(700_000 + i * 20_000); expect(handler(-400_000, object!)).toBe(false); }
    expect(t.baseline()).toBe(100_000);
    restore?.mockRestore(); if (!restore) player[guard] = prior;
    t.f.setNow(1_200_000); expect(handler(-400_000, object!)).toBe(false);
    t.f.setNow(1_500_000); expect(handler(-400_000, object!)).toBe(true);
  } finally { if (guard === 'activeMseSeek') player.activeMseSeek = null; await t.destroy(); }
});

it('clock reset discards a partially accumulated late interval', async () => {
  const t = await fixture();
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 15; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    (t.f.player as unknown as { resetMediaClock(): void }).resetMediaClock();
    t.graph.syncController.setAudioReference(ORIGIN + 900_000n);
    const before = t.baseline();
    await t.emit(1_020_000, 320_000); expect(t.baseline()).toBe(before);
    for (let i = 1; i <= 15; i++) await t.emit(1_020_000 + i * 20_000, 320_000 + i * 20_000);
    expect(t.baseline()).toBeGreaterThan(before);
  } finally { await t.destroy(); }
});


it('pipeline adoption clears both accumulated asks and spent slip budget', async () => {
  const t = await fixture();
  const p = t.f.player as unknown as { lateAudioAsksUs: number[]; lateAudioDebtUs: number; pipelinesCreated: boolean;
    commandDispatcher: { destroy(): void }; createPipelinesFromTrackInfo(info: object): void };
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 16; i++) await t.emit(700_000 + i * 20_000, i * 20_000);
    expect(p.lateAudioDebtUs).toBeGreaterThan(0);
    await t.emit(2_000_000, 340_000); expect(p.lateAudioAsksUs.length).toBeGreaterThan(0);
    p.commandDispatcher.destroy(); p.pipelinesCreated = false;
    p.createPipelinesFromTrackInfo({ audio: { codec: 'opus', samplerate: 48000, channels: 1, packaging: 'loc' }, isLive: true });
    expect(p.lateAudioAsksUs).toEqual([]); expect(p.lateAudioDebtUs).toBe(0);
  } finally { await t.destroy(); }
});

it('audio slipped after more than five seconds of lateness uses the new shared schedule', async () => {
  const t = await fixture(false, false, 20_000, 10_000);
  try {
    await t.emit(100_000, 0);
    for (let i = 1; i <= 16; i++) await t.emit(6_100_000 + i * 20_000, i * 20_000);
    expect(t.baseline()).toBeGreaterThan(6_100_000);
    const scheduled = t.schedules.mock.calls.at(-1)!;
    const timestamp = BigInt((scheduled[0] as { timestamp: number }).timestamp);
    const render = t.graph.syncController.computeAudioRenderTime(timestamp)!.renderTimeUs;
    expect(scheduled[1]).toBeGreaterThanOrEqual(render);
    expect(t.starts.at(-1)! * 1e6).toBeGreaterThanOrEqual(render);
  } finally { await t.destroy(); }
});
