/** A standalone graph has no player-owned catch-up output. */
import { describe, expect, it } from 'vitest';
import { varint } from '@openmoq/transport';
import { DEFAULT_PLAYER_CONFIG } from './config.js';
import { createPipelines, configurePipelines, handlePipelineCommand, type PipelineSet }
  from './player-pipeline.js';
import { WebAudioOutput } from '../../browser/src/webaudio-output.js';
import type { AudioDecoderLike } from './interfaces.js';
import type { AudioChunkInit } from '@openmoq/loc';

function fixture(maxCatchUpRate: number) {
  const wallOriginUs = Date.now() * 1000 - 3_000_000; // capture is ~3 s old on arrival
  let nowUs = 5_000_000;
  const clock = { now: () => nowUs };
  const starts: Array<{ capture: number; whenUs: number }> = [];
  let pendingCapture = 0;
  const fakeContext = {
    state: 'running', destination: {},
    get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (c: number) => planes[c]! };
    },
    createBufferSource() {
      const capture = pendingCapture;
      const node = { buffer: null as unknown, onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {}, start(when: number) { starts.push({ capture, whenUs: Math.round(when * 1e6) }); }, stop() { node.onended?.(); } };
      return node;
    },
  };
  const output = new WebAudioOutput(fakeContext as unknown as AudioContext, undefined, 0, clock);
  const rates: number[] = [];
  const setRate = output.setPlaybackRate.bind(output);
  output.setPlaybackRate = (r: number) => { rates.push(r); setRate(r); };
  const decoder: AudioDecoderLike = {
    configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk: AudioChunkInit, renderTimeUs: number, input?: object) {
      pendingCapture = chunk.timestamp;
      decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: 960,
        copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, renderTimeUs, input);
    },
    async flush() {}, reset() {}, destroy() {},
  };
  let graph!: PipelineSet;
  const config = { ...DEFAULT_PLAYER_CONFIG, url: 'https://unused.invalid/moq', namespace: 'probe',
    maxCatchUpRate, targetLatencyMs: 500,
    createTransport: async () => { throw new Error('unused'); }, createConnection: () => { throw new Error('unused'); },
    createAudioDecoder: () => decoder, createAudioOutput: () => output };
  const tracks = { video: undefined, audio: { codec: 'opus', samplerate: 48_000, channels: 1, packaging: 'loc' as const } };
  graph = createPipelines(config, clock, tracks, {
    onFirstFrame() {}, onStall() {}, onDecodeError() {}, onFrameRendered() {},
    onFeedback: f => graph.audioPipeline?.handleFeedback(f),
    onCommand: c => handlePipelineCommand(c, undefined, graph.commandDispatcher, graph.mediaSource, () => {}),
    onEvent() {},
  });
  configurePipelines(graph, tracks);
  let next = 0;
  const push = (offsetUs: number) => {
    graph.audioPipeline!.pushObject({ kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(next++), publisherPriority: 128, payload: Uint8Array.of(1), extensions: undefined },
      { captureTimestamp: BigInt(wallOriginUs + offsetUs), timestampIsWallClock: true }, { object: next });
    graph.audioPipeline!.tick();
  };
  return { graph, push, starts, rates, wallOriginUs, setNow: (us: number) => { nowUs = us; },
    cleanup() { graph.commandDispatcher!.destroy(); } };
}

/** Run: reference at 5 s, then 4 s of audio arriving 2 s ahead of its render time, fed at 1x for 20 s. */
function run(maxCatchUpRate: number) {
  const f = fixture(maxCatchUpRate);
  try {
    f.push(0);
    for (let k = 1; k <= 1000; k++) {
      f.setNow(5_000_000 + Math.max(0, k * 20_000 - 2_000_000)); // 2 s buffered ahead
      f.push(k * 20_000);
    }
    const sync = f.graph.syncController;
    const lastCapture = f.wallOriginUs + 1000 * 20_000;
    const timelineUs = sync.computeAudioRenderTime(BigInt(lastCapture))!.renderTimeUs;
    const last = f.starts.at(-1)!;
    return { rates: [...new Set(f.rates)], timelineLatencyUs: timelineUs - (5_000_000 + 1000 * 20_000),
      audioAheadOfTimelineUs: timelineUs + 200_000 - last.whenUs };
  } finally { f.cleanup(); }
}

describe('standalone graph has no player-owned catch-up policy', () => {
  it('a standalone graph cannot change rate without a player-owned output implementation', () => {
    const control = run(1.0);
    expect(control).toEqual({ rates: [], timelineLatencyUs: 0, audioAheadOfTimelineUs: 0 });
    const r = run(1.1);
    expect(r.rates).toEqual([]);
    expect(Math.abs(r.audioAheadOfTimelineUs)).toBeLessThan(50_000);
    expect(r.timelineLatencyUs).toBe(0);
  });
});
