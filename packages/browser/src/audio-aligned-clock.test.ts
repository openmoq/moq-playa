/**
 * Tests for AudioAlignedClock — audio-backed shared clock.
 *
 * Verifies the clock correctly bridges performance.now() and
 * AudioContext.currentTime domains, with continuous handoff
 * when audio becomes available.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioAlignedClock } from './audio-aligned-clock.js';

// ─── Mock AudioContext ───────────────────────────────────────────────

interface MockAudioTimestamp {
  contextTime: number;
  performanceTime: number;
}

function createMockAudioContext(options?: {
  state?: AudioContextState;
  currentTime?: number;
  outputLatency?: number;
  timestamp?: MockAudioTimestamp;
}) {
  return {
    state: options?.state ?? 'running',
    currentTime: options?.currentTime ?? 0,
    outputLatency: options?.outputLatency ?? 0.005,
    getOutputTimestamp: vi.fn((): MockAudioTimestamp =>
      options?.timestamp ?? { contextTime: 0, performanceTime: 0 },
    ),
  } as unknown as AudioContext;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('AudioAlignedClock', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to performance.now() when no AudioContext attached', () => {
    const clock = new AudioAlignedClock();
    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    const t = clock.now();
    expect(t).toBe(1_000_000); // 1000ms * 1000 = 1_000_000µs
    expect(perfSpy).toHaveBeenCalled();
  });

  it('falls back when getOutputTimestamp() returns {0, 0}', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 0, performanceTime: 0 },
    });
    clock.attachAudioContext(ctx);

    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(2000);
    const t = clock.now();
    expect(t).toBe(2_000_000);
    expect(clock.isAudioBacked).toBe(false);
  });

  it('falls back when AudioContext state is suspended', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext({
      state: 'suspended',
      timestamp: { contextTime: 1.0, performanceTime: 1000 },
    });
    clock.attachAudioContext(ctx);

    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(3000);
    const t = clock.now();
    expect(t).toBe(3_000_000);
    expect(clock.isAudioBacked).toBe(false);
  });

  it('anchors on first nonzero getOutputTimestamp()', () => {
    const clock = new AudioAlignedClock();

    // Audio clock at 2.0s, performance.now at 5000ms — correlated pair
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 2.0, performanceTime: 5000 },
    });
    clock.attachAudioContext(ctx);

    // Mock performance.now for the extrapolation (same as timestamp)
    vi.spyOn(performance, 'now').mockReturnValue(5000);

    const t = clock.now();
    expect(clock.isAudioBacked).toBe(true);

    // anchorOffset = perfTimeUs - audioTimeUs = 5_000_000 - 2_000_000 = 3_000_000
    // audioNowUs = contextTime * 1e6 + elapsed * 1e3 = 2_000_000 + 0
    // result = 2_000_000 + 3_000_000 = 5_000_000
    expect(t).toBe(5_000_000);
  });

  it('continuity at anchor — no timeline jump', () => {
    const clock = new AudioAlignedClock();
    const perfNowMock = vi.spyOn(performance, 'now');

    // Before audio: read performance clock
    perfNowMock.mockReturnValue(5000);
    const beforeAudio = clock.now();
    expect(beforeAudio).toBe(5_000_000);

    // Attach audio — timestamp sampled at the same instant
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 2.0, performanceTime: 5000 },
    });
    clock.attachAudioContext(ctx);

    // Same instant — should return same value (no jump)
    perfNowMock.mockReturnValue(5000);
    const afterAudio = clock.now();
    expect(afterAudio).toBe(5_000_000);
    expect(afterAudio).toBe(beforeAudio);
  });

  it('after anchor, tracks audio clock rate', () => {
    const clock = new AudioAlignedClock();

    // Anchor at contextTime=2.0, perfTime=5000ms
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 2.0, performanceTime: 5000 },
    });
    clock.attachAudioContext(ctx);

    vi.spyOn(performance, 'now').mockReturnValue(5000);
    clock.now(); // triggers anchor

    // 100ms later in audio clock, but performance.now advanced by 100.05ms (drift)
    (ctx.getOutputTimestamp as ReturnType<typeof vi.fn>).mockReturnValue({
      contextTime: 2.1,       // +100ms in audio time
      performanceTime: 5100.05, // +100.05ms in perf time (50ppm drift)
    });
    vi.spyOn(performance, 'now').mockReturnValue(5100.05);

    const t = clock.now();
    // Should track audio clock: 2.1s * 1e6 + anchorOffset(3_000_000) = 5_100_000
    // NOT performance clock: 5_100_050
    expect(t).toBe(5_100_000);
  });

  it('detachAudioContext() reverts to performance.now() fallback', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 2.0, performanceTime: 5000 },
    });
    clock.attachAudioContext(ctx);

    vi.spyOn(performance, 'now').mockReturnValue(5000);
    clock.now(); // anchor

    expect(clock.isAudioBacked).toBe(true);

    clock.detachAudioContext();
    expect(clock.isAudioBacked).toBe(false);

    vi.spyOn(performance, 'now').mockReturnValue(6000);
    const t = clock.now();
    expect(t).toBe(6_000_000); // back to performance.now
  });

  it('speakerLatencyUs reads from AudioContext.outputLatency', () => {
    const clock = new AudioAlignedClock();
    expect(clock.speakerLatencyUs).toBe(0); // no context

    const ctx = createMockAudioContext({ outputLatency: 0.015 }); // 15ms
    clock.attachAudioContext(ctx);
    expect(clock.speakerLatencyUs).toBe(15_000); // 15ms in µs
  });

  it('speakerLatencyUs handles missing outputLatency gracefully', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext();
    // Remove outputLatency to simulate unsupported browser
    delete (ctx as any).outputLatency;
    clock.attachAudioContext(ctx);
    expect(clock.speakerLatencyUs).toBe(0);
  });

  it('enforces monotonicity under getOutputTimestamp() jitter', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 2.0, performanceTime: 5000 },
    });
    clock.attachAudioContext(ctx);

    // Anchor
    vi.spyOn(performance, 'now').mockReturnValue(5000);
    const t1 = clock.now();
    expect(t1).toBe(5_000_000);

    // Simulate backward jitter: contextTime goes slightly back
    (ctx.getOutputTimestamp as ReturnType<typeof vi.fn>).mockReturnValue({
      contextTime: 1.999, // jitter: 1ms backward
      performanceTime: 5016,
    });
    vi.spyOn(performance, 'now').mockReturnValue(5016);

    const t2 = clock.now();
    // Should NOT go backward — clamped to previous value
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('detachAudioContext clears speakerLatencyUs', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext({ outputLatency: 0.020 });
    clock.attachAudioContext(ctx);
    expect(clock.speakerLatencyUs).toBe(20_000);

    clock.detachAudioContext();
    expect(clock.speakerLatencyUs).toBe(0);
  });

  it('extrapolates between audio callbacks', () => {
    const clock = new AudioAlignedClock();
    const ctx = createMockAudioContext({
      state: 'running',
      timestamp: { contextTime: 2.0, performanceTime: 5000 },
    });
    clock.attachAudioContext(ctx);

    // Anchor
    vi.spyOn(performance, 'now').mockReturnValue(5000);
    clock.now();

    // Same getOutputTimestamp (hasn't updated yet), but performance.now advanced 3ms
    // This simulates being between audio callbacks
    vi.spyOn(performance, 'now').mockReturnValue(5003);

    const t = clock.now();
    // audioNowUs = 2.0 * 1e6 + (5003 - 5000) * 1000 = 2_003_000
    // + anchorOffset 3_000_000 = 5_003_000
    expect(t).toBe(5_003_000);
  });
});
