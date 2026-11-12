import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import type { SyncController } from '@openmoq/playback';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { WebAudioOutput } from '../../browser/src/webaudio-output.js';
import { CanvasRenderer } from '../../browser/src/canvas-renderer.js';
import type { AudioDecoderLike } from './interfaces.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
const ORIGIN = 1_000_000_000n;
type NativeSource = { buffer: { duration: number; capture: number } | null; when: number; stopped: boolean;
  onended: (() => void) | null; playbackRate: { value: number }; connect(): void; disconnect(): void;
  start(when: number): void; stop(): void; position(): number };

async function run(options: { target?: number; wallLeadUs?: number; mediaTime?: boolean; frames?: number; aheadUs?: number; videoTail?: boolean; rate?: number; live?: boolean; hook?: boolean; seek?: boolean; slip?: boolean; delayed?: boolean; pauseOnRate?: boolean } = {}) {
  let now = 100_000, capture = 0, picture: number | null = null, lastHead = 0;
  const wall = vi.spyOn(Date, 'now').mockImplementation(() => (Number(ORIGIN) + (options.wallLeadUs ?? 2_500_000) + now) / 1000);
  const clock = { now: () => now }, nodes: NativeSource[] = [], rates: number[] = [];
  let queuedAtActivation = 0, hold = false;
  const pending: Array<() => void> = [];
  function source(): NativeSource {
    let speed = 1, at = 0, consumed = 0;
    const node = { buffer: null as { duration: number; capture: number } | null, when: Infinity, stopped: false,
      onended: null as (() => void) | null, connect() {}, disconnect() {},
      playbackRate: { get value() { return speed; }, set value(value: number) {
        consumed += Math.max(0, now / 1e6 - Math.max(at, node.when)) * speed;
        at = now / 1e6; speed = value;
      } },
      start(when: number) { node.when = when; at = when; consumed = 0; },
      stop() { node.stopped = true; node.onended?.(); },
      position() { return consumed + Math.max(0, now / 1e6 - Math.max(at, node.when)) * speed; },
    }; nodes.push(node); return node;
  }
  const context = { state: 'running', destination: {}, get currentTime() { return now / 1e6; }, createBufferSource: source,
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, capture, getChannelData: () => new Float32Array(length) };
    } };
  const audio = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, clock);
  const setRate = audio.setPlaybackRate.bind(audio);
  audio.setPlaybackRate = rate => {
    if (rate > 1 && !rates.length) queuedAtActivation = nodes.filter(n => !n.stopped && n.when > now / 1e6).length;
    rates.push(rate); setRate(rate);
  };
  const decoder: AudioDecoderLike = { supportsOutputTiming: true, queueDepth: 0, configure() {}, reset() {}, destroy() {},
    onData: null, onError: null, async flush() {}, decode(chunk, time, input, timing) {
      const deliver = () => { capture = chunk.timestamp;
      decoder.onData!({ timestamp: capture, sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1,
        copyTo() {}, close() {} }, time, input, timing ? { context: timing, sourceOffsetUs: 0 } : undefined); };
      if (hold) pending.push(deliver); else deliver();
    } };
  const canvas = { width: 10, height: 10, getContext: () => ({ drawImage(frame: { timestamp: number }) { picture = frame.timestamp; }, canvas }) };
  const renderer = new CanvasRenderer(canvas as unknown as HTMLCanvasElement, { clock, stallThresholdMs: 60_000 });
  if (options.hook === false) Reflect.set(renderer, 'setPlaybackRate', undefined);
  const f = await locSeekFixture(18, true, true, { isLive: options.live ?? true, playerConfig: {
    maxCatchUpRate: options.rate ?? 1.1, liveJumpThresholdMs: 3000,
    ...(options.target === undefined ? {} : { targetLatencyMs: options.target }),
    createAudioDecoder: () => decoder, createAudioOutput: () => audio, createRenderer: () => renderer } });
  f.decoder.decode = (chunk, time, input, timing) => f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, undefined, input, timing);
  if (options.pauseOnRate) {
    const set = renderer.setPlaybackRate.bind(renderer);
    renderer.setPlaybackRate = rate => { set(rate); if (rate > 1) f.player.pause(); };
  }
  const sync = (f.player as unknown as { syncController: SyncController }).syncController;
  let maxSkew = 0, samples = 0, initial = 0, debtAtSlip = 0;
  try {
    for (let i = 0; i <= (options.frames ?? 1000); i++) {
      if (options.pauseOnRate && rates.length) break;
      now = options.slip && i > 0 ? i <= 16 ? 700_000 + i * 20_000
        : 1_020_000 + Math.max(0, (i - 16) * 20_000 - 2_000_000)
        : 100_000 + Math.max(0, i * 20_000 - (options.aheadUs ?? 2_000_000));
      f.setNow(now);
      hold = options.delayed === true && i >= 190 && i < 215;
      if (!hold) pending.splice(0).forEach(deliver => deliver());
      if (options.seek && i === 300) { await f.player.seek(5000); }
      for (const isAudio of [true, false]) {
        const stream = await f.server.openSubgroup(isAudio ? 201n : 200n, BigInt(10 + i), 0n,
          { publisherPriority: 128, hasExtensions: true, endOfGroup: true });
        await f.server.sendObject(stream, 0n, isAudio ? Uint8Array.of(0xf8, 0xff, 0xfe) : Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
          encodeLocHeaders({ ...(options.mediaTime ? { timestamp: ORIGIN + BigInt(i * 20_000), timescale: 1_000_000n } : {
            captureTimestamp: ORIGIN + BigInt(!isAudio && options.videoTail ? Math.max(0, i * 20_000 - 1_900_000) : i * 20_000) }), ...(!isAudio ? { videoFrameMarking: {
            independent: true, startOfFrame: true, endOfFrame: true, discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
          { wireProfile: locWireProfileForDraft(18), locVersion: options.mediaTime ? 4 : 1 }));
        await f.server.closeSubgroup(stream); await flush(64);
      }
      f.player.tick(); renderer.renderTick(now);
      if (i === 16) debtAtSlip = (f.player as unknown as { lateAudioDebtUs: number }).lateAudioDebtUs;
      if (i === 0) initial = sync.computeAudioRenderTime(ORIGIN)!.renderTimeUs;
      const playing = nodes.find(n => !n.stopped && n.when <= now / 1e6 && n.position() < n.buffer!.duration);
      if (playing && picture !== null && !options.seek) {
        const head = playing.buffer!.capture + playing.position() * 1e6;
        maxSkew = Math.max(maxSkew, Math.abs(head - picture)); samples++; lastHead = head;
      }
      for (const node of nodes) if (!node.stopped && node.when <= now / 1e6 && node.position() >= node.buffer!.duration) node.stop();
    }
    return { latencyMs: (Number(ORIGIN) + (options.wallLeadUs ?? 2_500_000) + now - lastHead) / 1000, rates: [...rates], queuedAtActivation, maxSkew, samples, debtAtSlip,
      debtAtEnd: (f.player as unknown as { lateAudioDebtUs: number }).lateAudioDebtUs,
      returnedUs: initial - sync.computeAudioRenderTime(ORIGIN)!.renderTimeUs };
  } finally { wall.mockRestore(); await f.destroy(); }
}

it('LOC catches up on one clock with two seconds of native audio and video already queued', async () => {
  const off = await run({ rate: 1 }); expect(off.rates).toEqual([]); expect(off.returnedUs).toBe(0);
  const on = await run();
  expect(on.queuedAtActivation).toBeGreaterThan(90);
  expect(on.samples).toBeGreaterThan(700); expect(on.maxSkew).toBeLessThan(33_334);
  expect(on.returnedUs).toBeGreaterThan(500_000); expect(on.rates[0]).toBe(1.1);
});

it.each([{ live: false }, { hook: false }])('LOC output without live ownership or the renderer hook stays at 1x: %j', async options => {
  const control = await run(options); expect(control.rates).toEqual([]); expect(control.returnedUs).toBe(0);
  const live = await run(); expect(live.returnedUs).toBeGreaterThan(500_000);
});

it('LOC restores 1x when seeking and never accelerates historical playback', async () => {
  const result = await run({ seek: true });
  expect(result.rates).toEqual([1.1, 1]);
});

it('replenishes late-audio slip budget by the latency LOC catch-up actually returns', async () => {
  const result = await run({ slip: true });
  expect(result.debtAtSlip).toBeGreaterThan(700_000);
  expect(result.debtAtEnd).toBe(0);
  expect(result.rates.some(rate => rate > 1)).toBe(true);
});

it('decoder completions admitted before a rate change retain their shared source schedule', async () => {
  const result = await run({ delayed: true });
  expect(result.returnedUs).toBeGreaterThan(500_000);
  expect(result.maxSkew).toBeLessThan(33_334);
});

it('a reentrant pause during renderer retiming cannot leave audio accelerated', async () => {
  const result = await run({ pauseOnRate: true });
  expect(result.rates).toEqual([1]); expect(result.returnedUs).toBe(0);
});


it.each([{ target: 3000, wallLeadUs: 2_500_000 }, { target: 10_000, wallLeadUs: 2_900_000 }])
('LOC respects a wall-clock target already above playout latency: %j', async options => {
  const result = await run(options);
  expect(result.rates).toEqual([]); expect(result.returnedUs).toBe(0);
  expect(result.latencyMs).toBeCloseTo((options.wallLeadUs + 300_000) / 1000, 0);
});

it('LOC drains to the configured one-second playout target and restores normal rate', async () => {
  const result = await run({ target: 1000, frames: 2000, aheadUs: 2_400_000 });
  expect(result.rates[0]).toBe(1.1); expect(result.rates.at(-1)).toBe(1);
  expect(result.latencyMs).toBeGreaterThanOrEqual(980); expect(result.latencyMs).toBeLessThan(1080);
  expect(result.maxSkew).toBeLessThan(33_334);
});

it('media-time LOC cannot invent wall-clock latency, with a measurable target control', async () => {
  const media = await run({ target: 10_000, mediaTime: true });
  expect(media.rates.some(rate => rate > 1)).toBe(true);
  const unix = await run({ target: 10_000 }); expect(unix.rates).toEqual([]);
});

it('video without standing buffer prevents LOC catch-up despite queued audio', async () => {
  const result = await run({ videoTail: true }); expect(result.rates).toEqual([]);
  const control = await run(); expect(control.rates[0]).toBe(1.1);
});
