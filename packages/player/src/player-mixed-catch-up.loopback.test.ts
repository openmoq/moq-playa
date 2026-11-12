import { expect, it, vi } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildInit } from '../../locmaf/test-support/cmaf.js';
import { liveLocFixture } from '../test-support/live-loc.js';
import type { AudioDecoderLike, AudioOutputLike, MediaSourceLike, VideoRendererLike } from './interfaces.js';

it.each((['video', 'audio'] as const).flatMap(mseRole => [false, true].map(pauseOnRate => ({ mseRole, pauseOnRate }))))(
  'mixed CMAF $mseRole and LOC share rate safely: pauseOnRate=$pauseOnRate', async ({ mseRole, pauseOnRate }) => {
  for (const missing of pauseOnRate ? ['none'] as const : ['none', 'element', 'frame'] as const) {
    let pause = () => {};
    const elementRates: number[] = [], frameRates: number[] = [];
    const source: MediaSourceLike = { initialize: () => true, appendChunk() {}, endOfStream() {}, reset() {}, destroy() {},
      mediaElement: {}, onFirstFrame: null, onError: null, onStall: null, getTimestampOffset: () => 0, setTimestampOffset() {},
      getBufferAheadUs: () => 2_500_000,
      ...(missing === 'element' ? {} : { setPlaybackRate: (rate: number) => { elementRates.push(rate); if (pauseOnRate && rate > 1) pause(); } }) };
    const rateHook = missing === 'frame' ? {} : { setPlaybackRate: (rate: number) => { frameRates.push(rate); } };
    const audio: AudioDecoderLike = { supportsOutputTiming: true, configure() {}, flush: async () => {}, reset() {}, destroy() {},
      queueDepth: 0, onData: null, onError: null, decode(chunk, time, input) {
        audio.onData?.({ timestamp: chunk.timestamp, close() {} }, time, input);
      } };
    const output: AudioOutputLike = { supportsOutputTiming: true, flush() {}, destroy() {}, currentPlayoutTimeUs: 0, schedule: vi.fn(), ...rateHook };
    const renderer: VideoRendererLike = { flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null,
      enqueue: vi.fn(), ...rateHook };
    const f = await liveLocFixture({ maxCatchUpRate: 1.05, targetLatencyMs: 3000, liveJumpThresholdMs: 0, logLevel: 'none',
      createMediaSource: () => source, createCmafAssembler: callbacks => new CmafAssembler(callbacks),
      createAudioDecoder: () => audio, createAudioOutput: () => output, createRenderer: () => renderer,
      catalog: { tracks: (['video', 'audio'] as const).map(role => ({
        name: role === 'video' ? 'v' : 'a', role, packaging: role === mseRole ? 'cmaf' : 'loc', isLive: true,
        codec: role === 'video' ? 'avc1.64001f' : 'opus', samplerate: 48000, channelConfig: '2',
        ...(role === mseRole ? { initData: Buffer.from(buildInit({ trackId: 1, timescale: 48000,
          handler: role === 'video' ? 'vide' : 'soun' })).toString('base64') } : {}),
      })) } });
    pause = () => f.player.pause();
    try {
      f.player.play(); source.onFirstFrame?.();
      const frame = mseRole === 'video' ? 'a' : 'v';
      await f.send(frame, 0n); f.tick(1);
      for (let group = 1n; group <= 40n; group++) {
        await f.send(frame, group, 0n, 2_500_000n); f.tick(5);
        if (pauseOnRate && elementRates.length) break;
      }
      expect(f.errors).toEqual([]);
      if (pauseOnRate) {
        expect(elementRates).toEqual([1.05, 1]);
        expect(frameRates).toEqual([1]);
        f.tick(5);
        expect(frameRates).toEqual([1]);
        continue;
      }
      const expected = missing === 'none' ? [1.05] : [];
      expect(elementRates).toEqual(expected); expect(frameRates).toEqual(expected);
      f.player.pause();
      expect(elementRates).toEqual(missing === 'none' ? [1.05, 1] : []);
      expect(frameRates).toEqual(elementRates);
    } finally { await f.close(); }
  }
});
