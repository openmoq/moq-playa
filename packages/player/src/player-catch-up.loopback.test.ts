import { expect, it } from 'vitest';
import { mediaSelectionMseFixture, mseMediaRefs } from '../test-support/media-selection-mse.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, locations, landHistory } from '../test-support/seek-live-mse.js';

async function setup(options: { live?: boolean; rate?: number; supported?: boolean; range?: boolean } = {}) {
  let rate = 1, ahead = 2_500_000, now = 100_000;
  const rates: number[] = [];
  const f = await fixture(18, options.live ?? true, locations, { receiptClock: true, startPaused: false,
    playerConfig: { maxCatchUpRate: options.rate ?? 1.05, liveJumpThresholdMs: 0,
      ...(options.range ? { subscriptionFilter: { type: 'AbsoluteRange' as const, startGroup: 0, endGroup: 100 } } : {}) },
    rateOutput: { getBufferAheadUs: () => ahead,
      ...(options.supported === false ? {} : { setPlaybackRate: (next: number) => { rate = next; rates.push(next); } }) } });
  f.source.onFirstFrame?.();
  const step = (duration = 100_000) => { ahead -= (rate - 1) * duration; now += duration; f.setNow(now); f.player.tick(); };
  const run = (seconds: number) => { for (let i = 0; i < seconds * 10; i++) step(); };
  return { ...f, rates, run, step, rate: () => rate, ahead: () => ahead, setAhead: (value: number) => { ahead = value; } };
}
async function positive() {
  const f = await setup();
  try { f.run(3); expect(f.rate()).toBe(1.05); } finally { await f.destroy(); }
}

it('reduces excess live latency when opted in; the default preserves normal timing', async () => {
  const off = await setup({ rate: 1 });
  try { off.run(12); expect(off.rates).toEqual([]); expect(off.ahead()).toBe(2_500_000); } finally { await off.destroy(); }
  const on = await setup();
  try { on.run(12); expect(on.rate()).toBe(1.05); expect(on.ahead()).toBeLessThan(2_050_000); }
  finally { await on.destroy(); }
});

it.each([{ live: false }, { supported: false }, { range: true }])('excludes ineligible output %j, with a live control', async options => {
  const f = await setup(options);
  try { f.run(4); expect(f.rate()).toBe(1); expect(f.rates).toEqual([]); } finally { await f.destroy(); }
  await positive();
});

it('ignores burst refills, then activates only after the buffer stands high for two seconds', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 50; i++) { f.setAhead(i % 5 === 0 ? 300_000 : 2_500_000); f.step(); }
    expect(f.rates).toEqual([]);
    f.setAhead(2_500_000); f.run(1); expect(f.rates).toEqual([]);
    f.run(2); expect(f.rate()).toBe(1.05);
  } finally { await f.destroy(); }
});

it.each(['stop', 'pause', 'seek', 'teardown', 'owner', 'history'] as const)('restores normal rate on %s', async action => {
  const f = await setup();
  try {
    f.run(3); expect(f.rate()).toBe(1.05);
    if (action === 'stop') { f.setAhead(500_000); f.step(); }
    if (action === 'pause') f.player.pause();
    if (action === 'seek') { await f.player.seek(5000); f.run(3); }
    if (action === 'history') { await landHistory(f); f.run(3); }
    if (action === 'teardown') await f.player.destroy();
    if (action === 'owner') {
      // Retire only the input generation, leaving playback and subscriptions active.
      const manager = (f.player as unknown as { subscriptionManager: { invalidateMediaInputs(): void } }).subscriptionManager;
      manager.invalidateMediaInputs(); f.step();
    }
    expect(f.rate()).toBe(1); expect(f.rates).toEqual([1.05, 1]);
  } finally { await f.destroy(); }
});

it('restores rate before a real media switch prepares new output', async () => {
  let now = 10_000_000, rate = 1;
  const f = await mediaSelectionMseFixture({ config: { clock: { now: () => now }, maxCatchUpRate: 1.05 } });
  f.source.getBufferAheadUs = () => 2_500_000;
  f.source.setPlaybackRate = next => { rate = next; };
  try {
    f.player.play();
    for (let i = 0; i < 30; i++) { now += 100_000; f.player.tick(); }
    expect(rate).toBe(1.05);
    expect(f.player.mediaTimelineReference).toBeNull();
    await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    void f.player.selectMedia({ renderGroup: 2, videoTrack: mseMediaRefs.nextVideo,
      audioTrack: mseMediaRefs.nextAudio }, { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
        audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n } } }).catch(() => {});
    await flush(512);
    expect(rate).toBe(1);
    now += 3_000_000; f.player.tick(); expect(rate).toBe(1);
  } finally { await f.destroy(); }
});


it.each(['pause', 'destroy'] as const)('commits %s before notifying even a throwing catch-up listener', async action => {
  const f = await setup();
  const p = f.player as unknown as { playbackIntent: boolean; tickInterval: unknown; connection: unknown };
  const observations: unknown[] = [];
  try {
    f.run(3); expect(f.rate()).toBe(1.05);
    f.player.on('catch_up_changed', () => { throw new Error('observer failure'); });
    f.player.on('catch_up_changed', event => { observations.push({ rate: f.rate(), ticking: p.tickInterval,
      intent: p.playbackIntent, latency: event.latencyMs, connected: p.connection !== null }); });
    if (action === 'pause') f.player.pause(); else await f.player.destroy();
    expect(f.rate()).toBe(1);
    await flush(16);
    expect(p.tickInterval).toBeNull();
    expect(p.playbackIntent).not.toBe(true);
    expect(observations).toEqual([{ rate: 1, ticking: null, intent: p.playbackIntent,
      latency: Math.round(f.ahead() / 1000), connected: action === 'pause' }]);
    await f.player.destroy(); expect(p.connection).toBeNull();
  } finally { await f.destroy(); }
});

it.each(['PlayheadWedgeError', 'MediaGapUnrecoverableError'])('restores rate synchronously on fatal %s without another tick', async name => {
  const f = await setup();
  try {
    f.run(3); expect(f.rate()).toBe(1.05);
    const error = new Error('fatal media output'); error.name = name;
    f.source.onError?.(error);
    expect((f.player as unknown as { tickInterval: unknown }).tickInterval).toBeNull();
    expect(f.rate()).toBe(1);
  } finally { await f.destroy(); }
});


it.each([{ min: 2200 }, { target: 2200 }])('respects the catalog buffer floor %j', async buffers => {
  const f = await setup();
  try {
    // Exercise catalog metadata on the same subscribed owner, before its first observation.
    const track = (f.player as unknown as { subscribedTrack(role: string): { buffers?: typeof buffers } }).subscribedTrack('video');
    track.buffers = buffers;
    f.run(4); expect(f.rates).toEqual([]);
  } finally { await f.destroy(); }
  await positive();
});

it.each(['activeMseSeek', 'paused-state', 'ended'] as const)('loses catch-up ownership on %s without an explicit stop', async reason => {
  const f = await setup();
  // Isolate each ownership guard while leaving the ordinary live subscription installed.
  const p = f.player as unknown as { activeMseSeek: unknown; stateMachine: { transition(state: string): void };
    subscribedTrack(role: string): { isLive: boolean } };
  try {
    f.run(3); expect(f.rate()).toBe(1.05);
    if (reason === 'activeMseSeek') p.activeMseSeek = {};
    if (reason === 'paused-state') p.stateMachine.transition('paused');
    if (reason === 'ended') p.subscribedTrack('video').isLive = false;
    f.step(); expect(f.rate()).toBe(1);
    if (reason === 'activeMseSeek') p.activeMseSeek = null;
  } finally { p.activeMseSeek = null; await f.destroy(); }
});


it('restores before a quality switch announces its committed preparation', async () => {
  let now = 10_000_000, rate = 1;
  const f = await mediaSelectionMseFixture({ qualityView: true, config: { clock: { now: () => now }, maxCatchUpRate: 1.05 } });
  f.source.getBufferAheadUs = () => 2_500_000;
  f.source.setPlaybackRate = next => { rate = next; };
  const seen: unknown[] = [];
  try {
    f.player.play();
    for (let i = 0; i < 30; i++) { now += 100_000; f.player.tick(); }
    expect(rate).toBe(1.05);
    f.player.on('quality_switching', () => { seen.push(rate); });
    f.player.on('catch_up_changed', () => {
      seen.push(!!(f.player as unknown as { pendingVideoSwitch: unknown }).pendingVideoSwitch);
      throw new Error('observer failure');
    });
    void f.player.selectVideoTrack(mseMediaRefs.viewVideo).catch(() => {});
    expect(rate).toBe(1);
    await flush(16);
    expect(seen).toEqual([1, true]);
  } finally { await f.destroy(); }
});
