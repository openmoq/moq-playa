import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('MediaSource', MockMediaSource);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup(autoplay = false) {
  const video = new MockVideoElement();
  video.autoplay = autoplay;
  video.paused = true;
  video.modelPlayEvents = true;
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
  return { video, adapter };
}

it.each([true, false])('disables autoplay while managed and restores %s on release', autoplay => {
  const { video, adapter } = setup(autoplay);
  try { expect(video.autoplay).toBe(false); }
  finally { adapter.destroy(); }
  expect(video.autoplay).toBe(autoplay);
});

it('pauses external playback before startup, then starts and watches the modelled element', async () => {
  const { video, adapter } = setup();
  const report = vi.fn(); adapter.onStartupReport = report;
  const quality = vi.spyOn(adapter, 'getVideoPlaybackQuality');
  try {
    await video.play();
    expect(video.paused).toBe(true);
    expect(video.pauseCalls).toBe(1);
    expect(report).not.toHaveBeenCalled();
    video.buffered = makeTimeRanges([[0, 5]]);
    adapter.resumePlayback(); await settle();
    expect(video.playCalls).toBe(2);
    expect(video.paused).toBe(false);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      seekOutcome: 'no-seek-needed', playTimeSec: 0,
    }));
    quality.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(quality).toHaveBeenCalled();
  } finally { adapter.destroy(); }
});

it('does not pause its own startup or resume play before their promises settle', async () => {
  const { video, adapter } = setup();
  try {
    video.buffered = makeTimeRanges([[0, 5]]);
    adapter.resumePlayback(); await settle();
    expect(video.playCalls).toBe(1);
    expect(video.pauseCalls).toBe(0);
    expect(video.paused).toBe(false);
    adapter.setPlaybackIntent(false);
    expect(video.pauseCalls).toBe(1);
    adapter.setPlaybackIntent(true); await settle();
    expect(video.playCalls).toBe(2);
    expect(video.pauseCalls).toBe(1);
    expect(video.paused).toBe(false);
  } finally { adapter.destroy(); }
});

it('leaves external playback alone after startup succeeds', async () => {
  const { video, adapter } = setup();
  try {
    video.buffered = makeTimeRanges([[0, 5]]);
    adapter.resumePlayback(); await settle();
    video.pause();
    await video.play();
    expect(video.playCalls).toBe(2);
    expect(video.pauseCalls).toBe(1);
    expect(video.paused).toBe(false);
  } finally { adapter.destroy(); }
});

for (const waitMs of [100, 300]) {
  it(`ends a ${waitMs}ms wait before pausing external playback before startup`, async () => {
    const { video, adapter } = setup();
    const stalled = vi.fn(); adapter.onStall = stalled;
    const recovered = vi.fn(); adapter.onStallRecovered = recovered;
    let ready!: () => void;
    video.readyState = 2;
    video.deferPlay = () => new Promise<void>(resolve => { ready = resolve; });
    try {
      const playing = video.play();
      await vi.advanceTimersByTimeAsync(waitMs);
      expect(stalled).toHaveBeenCalledTimes(waitMs >= 250 ? 1 : 0);
      video.readyState = 4;
      ready();
      await playing;
      expect(video.paused).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(stalled).toHaveBeenCalledTimes(waitMs >= 250 ? 1 : 0);
      expect(recovered).toHaveBeenCalledTimes(waitMs >= 250 ? 1 : 0);
      if (waitMs >= 250) expect(recovered).toHaveBeenCalledWith(waitMs);
    } finally { adapter.destroy(); }
  });
}

it('pauses and requests startup before publishing a reported stall recovery', async () => {
  const { video, adapter } = setup();
  const stalled = vi.fn(); adapter.onStall = stalled;
  const startup = vi.spyOn(adapter as unknown as { requestStartup(): Promise<void> }, 'requestStartup');
  const error = new Error('recovery listener failed');
  adapter.onStallRecovered = () => { throw error; };
  let ready!: () => void;
  video.readyState = 2;
  video.deferPlay = () => new Promise<void>(resolve => { ready = resolve; });
  try {
    const playing = video.play();
    await vi.advanceTimersByTimeAsync(300);
    expect(stalled).toHaveBeenCalledOnce();
    video.readyState = 4;
    ready();
    await expect(playing).rejects.toBe(error);
    expect(video.paused).toBe(true);
    expect(video.pauseCalls).toBe(1);
    expect(startup).toHaveBeenCalledOnce();
  } finally { startup.mockRestore(); adapter.destroy(); }
});
