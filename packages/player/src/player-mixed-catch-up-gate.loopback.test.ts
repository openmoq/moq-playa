import { expect, it } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildInit } from '../../locmaf/test-support/cmaf.js';
import { liveLocFixture } from '../test-support/live-loc.js';
import { fixture, locations } from '../test-support/seek-live-mse.js';
import type { MediaSourceLike } from './interfaces.js';

it.each(['video', 'audio'] as const)('CMAF %s cannot accelerate alone beside an unsupported LOC role', async mseRole => {
  const rates: number[] = [];
  const source: MediaSourceLike = { initialize: () => true, appendChunk() {}, endOfStream() {}, reset() {}, destroy() {},
    mediaElement: {}, onFirstFrame: null, onError: null, onStall: null, getTimestampOffset: () => 0, setTimestampOffset() {},
    getBufferAheadUs: () => 2_500_000, setPlaybackRate: rate => { rates.push(rate); } };
  const f = await liveLocFixture({ maxCatchUpRate: 1.05, liveJumpThresholdMs: 0, logLevel: 'none',
    createMediaSource: () => source, createCmafAssembler: callbacks => new CmafAssembler(callbacks),
    catalog: { tracks: (['video', 'audio'] as const).map(role => ({
      name: role === 'video' ? 'v' : 'a', role, packaging: role === mseRole ? 'cmaf' : 'loc', isLive: true,
      codec: role === 'video' ? 'avc1.64001f' : 'opus', samplerate: 48000, channelConfig: '2',
      ...(role === mseRole ? { initData: Buffer.from(buildInit({ trackId: 1, timescale: 48000,
        handler: role === 'video' ? 'vide' : 'soun' })).toString('base64') } : {}),
    })) } });
  try { f.player.play(); source.onFirstFrame?.(); f.tick(200); expect(rates).toEqual([]); }
  finally { await f.close(); }
  // A fully supported live element proves that opt-in policy actually ran.
  let now = 100_000;
  const control = await fixture(18, true, locations, { receiptClock: true, startPaused: false,
    playerConfig: { maxCatchUpRate: 1.05, liveJumpThresholdMs: 0 }, rateOutput: {
      getBufferAheadUs: () => 2_500_000, setPlaybackRate: rate => { rates.push(rate); } } });
  try {
    control.source.onFirstFrame?.();
    for (let i = 0; i < 40; i++) { now += 100_000; control.setNow(now); control.player.tick(); }
    expect(rates).toEqual([1.05]);
  } finally { await control.destroy(); }
});
