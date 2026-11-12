/**
 * Ordinary audio admission through the shared player graph, dispatcher and
 * WebAudioOutput with a native-interface mock; no browser decoding claim.
 */
import { describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import { DEFAULT_PLAYER_CONFIG } from './config.js';
import { createPipelines, configurePipelines, handlePipelineCommand,
  type PipelineSet } from './player-pipeline.js';
import { WebAudioOutput } from '../../browser/src/webaudio-output.js';
import { PlaybackPipeline, SyncController } from '../../playback/src/index.js';
import { RenderCushionSmoother } from './render-cushion.js';
import type { AudioDecoderLike } from './interfaces.js';
import type { AudioChunkInit } from '@openmoq/loc';
import type { AudioTimingSource, DecoderCommand, PlaybackInputDiscardReason } from '@openmoq/playback';

const ORIGIN = 1_000_000_000n;

function fixture(options: { av?: boolean; initialPCM?: boolean; handshakeRttMs?: number } = {}) {
  let nowUs = 5_000_000;
  const clock = { now: () => nowUs };
  const starts: Array<{ whenSec: number; currentTimeSec: number; durationSec: number }> = [];
  const nodes: Array<{ buffer: { duration: number } | null; when: number | null; ended: boolean;
    onended: (() => void) | null; playbackRate: { value: number } }> = [];
  const fakeContext = {
    state: 'running', destination: {},
    get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (channel: number) => planes[channel]! };
    },
    createBufferSource() {
      const node = {
        buffer: null as { duration: number } | null, when: null as number | null, ended: false,
        onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {},
        start(when: number) {
          node.when = when;
          starts.push({ whenSec: when, currentTimeSec: fakeContext.currentTime,
            durationSec: node.buffer!.duration });
        },
        stop() { if (!node.ended) { node.ended = true; node.onended?.(); } },
      };
      nodes.push(node);
      return node;
    },
  };
  const output = new WebAudioOutput(fakeContext as unknown as AudioContext, undefined, 0, clock);
  const schedules = vi.spyOn(output, 'schedule'); // Calls the actual output implementation.
  const decodeCalls: Array<{ timestamp: number; renderTimeUs: number; input?: object }> = [];
  const dataClosed: number[] = [];
  const decoder: AudioDecoderLike = {
    configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk: AudioChunkInit, renderTimeUs: number, input?: object) {
      decodeCalls.push({ timestamp: chunk.timestamp, renderTimeUs, ...(input === undefined ? {} : { input }) });
      decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000,
        numberOfChannels: 1, numberOfFrames: 960,
        copyTo(plane: Float32Array) { plane.fill(0.25); },
        close() { dataClosed.push(chunk.timestamp); },
      }, renderTimeUs, input);
    },
    async flush() {}, reset() {}, destroy() {},
  };
  const commands: DecoderCommand[] = [];
  const discarded: Array<{ input: object; reason: PlaybackInputDiscardReason }> = [];
  const errors: unknown[] = [];
  let graph!: PipelineSet;
  const config = {
    ...DEFAULT_PLAYER_CONFIG,
    url: 'https://unused.invalid/moq', namespace: 'probe',
    createTransport: async () => { throw new Error('No transport is used by this probe'); },
    createConnection: () => { throw new Error('No connection is used by this probe'); },
    createAudioDecoder: () => decoder, createAudioOutput: () => output,
  };
  const tracks = { video: options.av ? { codec: 'avc1.640028', width: 640, height: 360, packaging: 'loc' as const } : undefined, audio: { codec: 'opus', samplerate: 48_000, channels: 1, packaging: 'loc' as const } };
  graph = createPipelines(config, clock, tracks, {
    onFirstFrame() {}, onStall() {}, onDecodeError: (_role, error) => { errors.push(error); },
    onFrameRendered() {}, onFeedback: feedback => graph.audioPipeline?.handleFeedback(feedback),
    onCommand: command => {
      commands.push(command);
      handlePipelineCommand(command, undefined, graph.commandDispatcher, graph.mediaSource, () => {});
    },
    onEvent() {},
  }, options.handshakeRttMs);
  graph.audioPipeline!.inputObserver = (input, reason) => { discarded.push({ input, reason }); };
  configurePipelines(graph, tracks);
  let nextObject = 0;
  const push = (sourceUs: bigint) => {
    const input = { object: nextObject };
    graph.audioPipeline!.pushObject({
      kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(nextObject++), publisherPriority: 128,
      payload: Uint8Array.of(1), extensions: undefined,
    }, { captureTimestamp: sourceUs, timestampIsWallClock: true }, input);
    graph.audioPipeline!.tick();
    return input;
  };
  if (options.initialPCM !== false) {
    const initial = push(ORIGIN);
    const initialCushionUs = options.handshakeRttMs !== undefined && options.handshakeRttMs < 5 ? 50_000 : 200_000;
    expect(errors).toEqual([]); expect(decodeCalls).toHaveLength(1); expect(decodeCalls[0]!.input).toBe(initial);
    expect(schedules).toHaveBeenCalledTimes(1);
    expect(starts[0]!.whenSec).toBeCloseTo(5 + initialCushionUs / 1_000_000, 9);
    expect(dataClosed).toEqual([Number(ORIGIN)]); expect(graph.getRenderCushionUs!()).toBe(initialCushionUs);
    expect(config.lateFrameThresholdMs).toBe(100);
  }
  const setNow = (us: number) => {
    nowUs = us;
    // Deliver fake native ended callbacks for actual sources whose graph time elapsed.
    for (const node of nodes) {
      if (!node.ended && node.when !== null && node.when + node.buffer!.duration <= fakeContext.currentTime) {
        node.ended = true;
        node.onended?.();
      }
    }
  };
  return { graph, push, setNow, now: () => nowUs, output, schedules, decodeCalls, commands, discarded, errors, starts,
    snapshot(label: string, sourceUs: bigint, input: object) {
      console.info(JSON.stringify({ label, nowUs, input, sourceUs, thresholdMs: config.lateFrameThresholdMs,
        cushionUs: graph.getRenderCushionUs!(), nominal: graph.syncController.computeAudioRenderTime(sourceUs),
        commands: commands.map(command => command.type), decodeCalls: [...decodeCalls],
        outputScheduleRenderTimesUs: schedules.mock.calls.map(call => call[1]),
        starts: [...starts], discarded: [...discarded], errors: errors.map(String),
        reference: graph.syncController.computeAudioRenderTime(ORIGIN),
      }, (_, value) => typeof value === 'bigint' ? value.toString() : value));
    },
    cleanup() { graph.commandDispatcher!.destroy(); },
  };
}

describe('ordinary audio admission against the real shared output cushion', () => {
  it('nominal minus150ms with the actual200ms cushion reaches a future native start without slipping the reference', () => {
    const f = fixture();
    try {
      f.setNow(6_000_000); // The initial PCM interval [5.2,5.22] has actually ended.
      expect(f.output.playheadCaptureUs()).toBeNull();
      const sourceUs = ORIGIN + 850_000n;
      const before = f.graph.syncController.computeAudioRenderTime(sourceUs)!;
      expect(before.offsetUs).toBe(-150_000);
      expect(f.graph.getRenderCushionUs!()).toBe(200_000);
      const input = f.push(sourceUs);
      f.snapshot('nominal-minus150ms', sourceUs, input);
      expect.soft(f.discarded, 'the intended output target is still50ms ahead').toEqual([]);
      expect.soft(f.decodeCalls).toHaveLength(2);
      expect.soft(f.schedules).toHaveBeenCalledTimes(2);
      expect.soft(f.starts).toHaveLength(2);
      expect.soft(f.starts[1]?.whenSec).toBeCloseTo(6.05, 9);
      expect(f.graph.syncController.computeAudioRenderTime(sourceUs)).toEqual(before);
      expect(f.errors).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('healthy control: on-time ordinary audio traverses decode, dispatcher, PCM copy and native source.start with200ms delay', () => {
    const f = fixture();
    try {
      f.setNow(6_000_000);
      const sourceUs = ORIGIN + 1_000_000n;
      const input = f.push(sourceUs);
      f.snapshot('on-time', sourceUs, input);
      expect(f.discarded).toEqual([]);
      expect(f.decodeCalls).toHaveLength(2);
      expect(f.decodeCalls[1]).toEqual({ timestamp: Number(sourceUs), renderTimeUs: 6_000_000, input });
      expect(f.schedules).toHaveBeenCalledTimes(2);
      expect(f.schedules.mock.calls[1]![1]).toBe(6_200_000);
      expect(f.starts[1]).toEqual({ whenSec: 6.2, currentTimeSec: 6, durationSec: 0.02 });
      expect(f.errors).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('late control: minus2s remains beyond the actual cushion and produces no new PCM/native start', () => {
    const f = fixture();
    try {
      f.setNow(8_000_000);
      const sourceUs = ORIGIN + 1_000_000n;
      expect(f.graph.syncController.computeAudioRenderTime(sourceUs)!.offsetUs).toBe(-2_000_000);
      const input = f.push(sourceUs);
      f.snapshot('nominal-minus2s', sourceUs, input);
      expect(f.discarded).toEqual([{ input, reason: 'late frame' }]);
      expect(f.decodeCalls).toHaveLength(1);
      expect(f.schedules).toHaveBeenCalledTimes(1);
      expect(f.starts).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('downstream-only control: an admitted nominal minus150ms command really starts at now plus50ms', () => {
    const f = fixture();
    try {
      f.setNow(6_000_000);
      const sourceUs = ORIGIN + 850_000n;
      const nominal = f.graph.syncController.computeAudioRenderTime(sourceUs)!;
      const input = { downstreamOnly: true };
      // Deliberately bypass pipeline admission ONLY in this labelled control.
      // The red above must obtain this command from the ordinary pipeline.
      f.graph.commandDispatcher!.dispatch({ type: 'decode_audio',
        chunk: { type: 'key', timestamp: Number(sourceUs), data: Uint8Array.of(1) },
        renderTimeUs: nominal.renderTimeUs, inputToken: input });
      f.snapshot('downstream-only-nominal-minus150ms', sourceUs, input);
      expect(f.decodeCalls[1]).toEqual({ timestamp: Number(sourceUs), renderTimeUs: 5_850_000, input });
      expect(f.schedules.mock.calls[1]![1]).toBe(6_050_000);
      expect(f.starts[1]).toEqual({ whenSec: 6.05, currentTimeSec: 6, durationSec: 0.02 });
      expect(f.graph.syncController.computeAudioRenderTime(sourceUs)).toEqual(nominal);
      expect(f.discarded).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { f.cleanup(); }
  });
});

function firstAV() {
  const f = fixture({ av: true, initialPCM: false }), video = f.graph.videoPipeline!;
  expect(video).not.toBeNull(); expect(f.starts).toEqual([]);
  // Two ordinary video arrivals establish observed jitter without consuming
  // video or emitting PCM. The public effective timeout is the raw input.
  const object = (id: number) => ({ kind: 'data' as const, trackAlias: varint(2), groupId: varint(0),
    subgroupId: varint(id), objectId: varint(id), publisherPriority: 128,
    payload: Uint8Array.of(1), extensions: undefined });
  video.pushObject(object(0), { captureTimestamp: ORIGIN });
  f.setNow(5_000_000 + 5_000_000 / 9);
  video.pushObject(object(1), { captureTimestamp: ORIGIN + 1_000_000n });
  const raw = video.effectiveGapTimeoutUs;
  expect(raw).toBeCloseTo(500_000, 5);
  expect(f.graph.getRenderCushionUs!()).toBe(200_000);
  f.graph.syncController.setAudioReference(ORIGIN);
  const source = ORIGIN - 350_000n, nominal = f.graph.syncController.computeAudioRenderTime(source)!;
  expect(nominal.offsetUs).toBeCloseTo(-350_000, 6);
  expect(f.schedules).not.toHaveBeenCalled(); expect(f.decodeCalls).toEqual([]);
  return { f, raw, source, nominal };
}

describe('first A/V audio output uses the prospective shared cushion', () => {
  it('admits nominal minus350ms using the observed first500ms target rather than the unused200ms floor', () => {
    const { f, raw, source, nominal } = firstAV();
    try {
      const input = f.push(source); f.snapshot('first-AV-audio', source, input);
      expect(f.discarded).toEqual([]); expect(f.decodeCalls).toHaveLength(1);
      expect(f.decodeCalls[0]!.renderTimeUs).toBe(nominal.renderTimeUs);
      expect(f.schedules).toHaveBeenCalledTimes(1);
      expect(f.schedules.mock.calls[0]![1]).toBeCloseTo(nominal.renderTimeUs + raw, 5);
      expect(f.starts[0]!.whenSec).toBeCloseTo((f.now() + 150_000) / 1_000_000, 8);
      expect(f.graph.syncController.computeAudioRenderTime(source)).toEqual(nominal);
      expect(f.errors).toEqual([]);
    } finally { f.cleanup(); }
  });

  it('downstream control witnesses the first500ms cushion in the actual native source start', () => {
    const { f, raw, source, nominal } = firstAV();
    try {
      f.graph.commandDispatcher!.dispatch({ type: 'decode_audio', inputToken: {},
        chunk: { type: 'key', timestamp: Number(source), data: Uint8Array.of(1) }, renderTimeUs: nominal.renderTimeUs });
      expect(f.schedules).toHaveBeenCalledTimes(1);
      expect(f.schedules.mock.calls[0]![1]).toBeCloseTo(nominal.renderTimeUs + raw, 5);
      expect(f.starts).toHaveLength(1); expect(f.starts[0]!.whenSec).toBeCloseTo((f.now() + 150_000) / 1_000_000, 8);
      expect(f.graph.getRenderCushionUs!()).toBeCloseTo(raw, 5); expect(f.errors).toEqual([]);
    } finally { f.cleanup(); }
  });
});

function admission(getter?: () => number) {
  let nowUs = 5_000_000;
  const clock = { now: () => nowUs }, sync = new SyncController({ clock, driftThresholdUs: 500_000, dropThresholdUs: 100_000 });
  sync.setAudioReference(ORIGIN); nowUs = 6_000_000;
  const commands: DecoderCommand[] = [], discards: Array<{ input: object; reason: PlaybackInputDiscardReason }> = [];
  const pipeline = new PlaybackPipeline({ mediaType: 'audio', clock, sync,
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100 },
    ...(getter === undefined ? {} : { getAudioPlayoutDelayUs: getter }),
    onCommand: command => { commands.push(command); }, onEvent() {} });
  pipeline.configure(Uint8Array.of(1)); pipeline.inputObserver = (input, reason) => { discards.push({ input, reason }); };
  const push = (source = ORIGIN + 850_000n, objectId = 0) => {
    const input = { objectId };
    pipeline.pushObject({ kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(objectId), publisherPriority: 128, payload: Uint8Array.of(1), extensions: undefined },
    { captureTimestamp: source, timestampIsWallClock: true }, input); pipeline.tick(); return input;
  };
  return { pipeline, sync, commands, discards, push,
    decoded: () => commands.filter(command => command.type === 'decode_audio') };
}

describe('ordinary audio playout-delay admission boundary', () => {
  it('keeps nominal minus151ms late on a real50ms LAN cushion', () => {
    const f = fixture({ handshakeRttMs: 1 });
    try {
      f.setNow(6_000_000); expect(f.graph.getRenderCushionUs!()).toBe(50_000);
      const input = f.push(ORIGIN + 849_000n);
      expect(f.discarded).toEqual([{ input, reason: 'late frame' }]);
      expect(f.decodeCalls).toHaveLength(1); expect(f.schedules).toHaveBeenCalledTimes(1); expect(f.starts).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  it.each([NaN, Infinity, -1, 'throws'] as const)('retires an input once when its delay getter returns %s', value => {
    const getter = vi.fn(() => { if (value === 'throws') throw new Error('delay unavailable'); return value; });
    const f = admission(getter), input = f.push();
    expect(getter).toHaveBeenCalledOnce(); expect(f.decoded()).toEqual([]);
    expect(f.discards).toEqual([{ input, reason: 'decoder policy' }]);
    expect(f.pipeline.bufferedGroupCount).toBe(0); f.pipeline.reset();
    expect(f.discards).toHaveLength(1);
  });

  it.each(['reset', 'provider replacement'] as const)('fences an old input when the getter reenters %s', operation => {
    let f!: ReturnType<typeof admission>, first = true;
    const provider = { computeAudioRenderTime: () => ({ renderTimeUs: 6_000_000, offsetUs: 0, shouldDrop: false }) };
    const getter = vi.fn(() => {
      if (first) { first = false; if (operation === 'reset') f.pipeline.reset(); else f.pipeline.setAudioTimingSource(provider); }
      return 200_000;
    });
    f = admission(getter); const old = f.push();
    expect(f.decoded()).toEqual([]); expect(f.discards).toEqual([{ input: old, reason: 'decoder reset' }]);
    const fresh = f.push(ORIGIN + 1_000_000n, operation === 'reset' ? 0 : 1);
    expect(f.decoded()).toHaveLength(1); expect(f.decoded()[0]!.inputToken).toBe(fresh);
    expect(f.discards).toHaveLength(1); f.pipeline.reset(); expect(f.discards).toHaveLength(1);
  });

  it('preserves the standalone no-option late policy', () => {
    const f = admission(), input = f.push();
    expect(f.decoded()).toEqual([]); expect(f.discards).toEqual([{ input, reason: 'late frame' }]);
  });

  it('changes only shouldDrop when shared sync receives an output delay', () => {
    const f = admission(), source = ORIGIN + 850_000n;
    const nominal = f.sync.computeAudioRenderTime(source)!, reference = f.sync.computeAudioRenderTime(ORIGIN);
    const age = f.sync.captureTimestampAgeUs;
    const admitted = f.sync.computeAudioRenderTime(source, 200_000)!;
    expect(nominal.shouldDrop).toBe(true); expect(admitted).toEqual({ ...nominal, shouldDrop: false });
    expect(f.sync.computeAudioRenderTime(source)).toEqual(nominal);
    expect(f.sync.computeAudioRenderTime(ORIGIN)).toEqual(reference);
    expect(f.sync.captureTimestampAgeUs).toBe(age);
  });

  it('never previews ordinary delay for mapped timing and adds the downstream cushion only once', () => {
    const f = fixture();
    const preview = vi.spyOn(RenderCushionSmoother.prototype, 'preview');
    try {
      f.setNow(6_000_000);
      const reference = f.graph.syncController.computeAudioRenderTime(ORIGIN), age = f.graph.syncController.captureTimestampAgeUs;
      const provider = { computeAudioRenderTime: vi.fn(() => ({ renderTimeUs: 6_000_000, offsetUs: 0, shouldDrop: false })) };
      f.graph.audioPipeline!.setAudioTimingSource(provider);
      const input = f.push(90_000_000n);
      expect(preview).not.toHaveBeenCalled(); expect(provider.computeAudioRenderTime).toHaveBeenCalledExactlyOnceWith(90_000_000n);
      expect(f.decodeCalls[1]).toEqual({ timestamp: 90_000_000, renderTimeUs: 6_000_000, input });
      expect(f.schedules.mock.calls[1]![1]).toBe(6_200_000); expect(f.starts[1]!.whenSec).toBe(6.2);
      expect(f.graph.syncController.computeAudioRenderTime(ORIGIN)).toEqual(reference);
      expect(f.graph.syncController.captureTimestampAgeUs).toBe(age); expect(f.discarded).toEqual([]); expect(f.errors).toEqual([]);
    } finally { preview.mockRestore(); f.cleanup(); }
  });
});

describe('render cushion preview is a pure scheduling estimate', () => {
  it('previews the first snap without reserving or changing it', () => {
    const smoother = new RenderCushionSmoother({ floorUs: 200_000 }, { now: () => 0 });
    expect(smoother.currentUs).toBe(200_000); expect(smoother.preview(500_000)).toBe(500_000);
    expect(smoother.currentUs).toBe(200_000); expect(smoother.preview(400_000)).toBe(400_000);
    expect(smoother.currentUs).toBe(200_000); expect(smoother.update(500_000)).toBe(500_000);
  });

  it('previews elapsed decay without changing the current value or last update clock', () => {
    let now = 0; const smoother = new RenderCushionSmoother({ floorUs: 200_000 }, { now: () => now });
    expect(smoother.update(500_000)).toBe(500_000); now = 12_000_000;
    expect(smoother.preview(200_000)).toBe(200_000); expect(smoother.currentUs).toBe(500_000);
    expect(smoother.preview(750_000)).toBe(750_000); expect(smoother.currentUs).toBe(500_000);
    expect(smoother.update(200_000)).toBe(200_000);
  });
});

// Root mapped-provider compatibility: reference establishment may install a successor.
it('uses the current mapped provider when establishReference installs its successor', () => {
  const clock = { now: () => 6_000_000 };
  const sync = new SyncController({ clock, driftThresholdUs: 500_000 });
  const commands: DecoderCommand[] = [];
  const discards: Array<{ input: object; reason: PlaybackInputDiscardReason }> = [];
  const pipeline = new PlaybackPipeline({ mediaType: 'audio', clock, sync,
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100 },
    onCommand: command => { commands.push(command); }, onEvent() {} });
  pipeline.inputObserver = (input, reason) => { discards.push({ input, reason }); };
  pipeline.configure(Uint8Array.of(1));
  const sourceUs = 90_000_000n;
  const successorCompute = vi.fn((_sourceUs: bigint) => ({
    renderTimeUs: 6_050_000, offsetUs: 50_000, shouldDrop: false,
  }));
  const successor: AudioTimingSource = { computeAudioRenderTime: successorCompute };
  const predecessorCompute = vi.fn((_sourceUs: bigint) => null);
  const establishReference = vi.fn((_sourceUs: bigint) => {
    pipeline.setAudioTimingSource(successor);
  });
  pipeline.setAudioTimingSource({ computeAudioRenderTime: predecessorCompute, establishReference });
  const input = { rawReceipt: 'mapped-first-audio' };
  try {
    expect(sync.hasReference).toBe(false);
    pipeline.pushObject({ kind: 'data', trackAlias: varint(1), groupId: varint(0),
      subgroupId: varint(0), objectId: varint(0), publisherPriority: 128,
      payload: Uint8Array.of(1), extensions: undefined },
      { captureTimestamp: sourceUs, timestampIsWallClock: false }, input);
    pipeline.tick();
    expect(establishReference).toHaveBeenCalledExactlyOnceWith(sourceUs);
    expect.soft(predecessorCompute, 'reference hook retired this provider before timing compute').not.toHaveBeenCalled();
    expect.soft(successorCompute).toHaveBeenCalledExactlyOnceWith(sourceUs);
    expect.soft(discards).toEqual([]);
    const decoded = commands.filter(command => command.type === 'decode_audio');
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ type: 'decode_audio', renderTimeUs: 6_050_000,
      inputToken: input, chunk: { timestamp: Number(sourceUs) } });
    expect(sync.hasReference).toBe(false); // Mapping did not invent a shared reference.
    expect(commands.filter(command => command.type === 'reset')).toEqual([]);
  } finally { pipeline.reset(); }
});
