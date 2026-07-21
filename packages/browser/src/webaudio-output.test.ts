/**
 * WebAudioOutput tests — scheduled-buffer playhead mapping.
 *
 * playheadCaptureUs() answers "which CaptureTimestamp is coming out of the
 * speakers right now," derived from the scheduled-buffer ring. This is the
 * observability foundation for LOC A/V skew measurement — it must be exact
 * across chained buffers, playbackRate changes, gaps, and flush.
 */

import { describe, expect, it, vi } from 'vitest';
import { WebAudioOutput } from './webaudio-output.js';

// ─── Mock AudioContext ───────────────────────────────────────────────

class MockAudioContext {
  currentTime = 0;
  readonly destination = { kind: 'destination' };
  readonly started: Array<{ when: number; duration: number; rate: number }> = [];

  createBuffer(channels: number, frames: number, sampleRate: number) {
    return {
      duration: frames / sampleRate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(frames),
    };
  }

  createBufferSource() {
    const ctx = this;
    const source: any = {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start(when: number) {
        ctx.started.push({ when, duration: source.buffer.duration, rate: source.playbackRate.value });
      },
    };
    return source;
  }
}

/** 20ms of mono 48kHz audio with the given capture timestamp (µs). */
function audioData(timestampUs: number, frames = 960) {
  return {
    timestamp: timestampUs,
    numberOfChannels: 1,
    numberOfFrames: frames,
    sampleRate: 48_000,
    copyTo: vi.fn(),
    close: vi.fn(),
  };
}

function makeOutput(playbackDelayMs = 0) {
  const ctx = new MockAudioContext();
  // Clock pinned to the ctx so toAudioCtxTime is deterministic.
  const clock = { now: () => ctx.currentTime * 1_000_000 };
  const out = new WebAudioOutput(ctx as unknown as AudioContext, undefined, playbackDelayMs, clock);
  return { ctx, out };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('WebAudioOutput.playheadCaptureUs', () => {
  it('returns null when nothing has been scheduled', () => {
    const { out } = makeOutput();
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('returns null before the first buffer starts playing', () => {
    const { ctx, out } = makeOutput(200); // anchored 200ms in the future
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000);
    // now = 1.0, buffer starts at 1.2 — nothing is being heard yet
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('maps playout position inside a buffer to its capture timeline', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // starts at 1.0, 20ms long

    ctx.currentTime = 1.010; // 10ms into the buffer
    expect(out.playheadCaptureUs()).toBe(5_010_000);
  });

  it('tracks across chained buffers (the normal playback path)', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // [1.000, 1.020)
    out.schedule(audioData(5_020_000), 1_020_000); // chained: [1.020, 1.040)
    out.schedule(audioData(5_040_000), 1_040_000); // chained: [1.040, 1.060)

    ctx.currentTime = 1.030; // 10ms into the SECOND buffer
    expect(out.playheadCaptureUs()).toBe(5_030_000);
    ctx.currentTime = 1.055; // 15ms into the THIRD
    expect(out.playheadCaptureUs()).toBe(5_055_000);
  });

  it('accounts for playbackRate in both duration and capture progression', () => {
    const { ctx, out } = makeOutput();
    out.setPlaybackRate(2.0); // catch-up: 20ms of media plays in 10ms wall
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // wall [1.000, 1.010)

    ctx.currentTime = 1.005; // 5ms wall = 10ms of media at 2×
    expect(out.playheadCaptureUs()).toBe(5_010_000);
  });

  it('returns null once playout has run past the last scheduled buffer (starved)', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // [1.000, 1.020)

    ctx.currentTime = 1.5;
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('prunes finished buffers without losing the playing one', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    for (let i = 0; i < 200; i++) {
      out.schedule(audioData(5_000_000 + i * 20_000), 1_000_000 + i * 20_000);
    }
    ctx.currentTime = 1.0 + 199 * 0.020 + 0.010; // inside the LAST buffer
    // toBeCloseTo: float accumulation across 199 chained start times is ~1e-8µs
    expect(out.playheadCaptureUs()).toBeCloseTo(5_000_000 + 199 * 20_000 + 10_000, 0);
  });

  it('flush() clears the ring — playhead goes null', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000);
    ctx.currentTime = 1.010;
    expect(out.playheadCaptureUs()).not.toBeNull();

    out.flush();
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('does not change scheduling behavior (observability only)', () => {
    const { ctx, out } = makeOutput(200);
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000);
    out.schedule(audioData(5_020_000), 1_020_000);

    // Identical to pre-slice behavior: first anchored at renderTime+delay
    // (clock pinned to ctx → toAudioCtxTime(1s)=1.0, +0.2), second chained.
    expect(ctx.started).toEqual([
      { when: 1.2, duration: 0.02, rate: 1 },
      { when: 1.22, duration: 0.02, rate: 1 },
    ]);
  });
});

describe('unified playout cushion (delay unification)', () => {
  it('DEFAULT construction adds no delay of its own — the dispatcher owns the cushion', () => {
    // The documented @moqt/player + @moqt/browser composition wires this
    // output behind the CommandDispatcher, which already adds the shared
    // cushion to renderTimeUs. A non-zero default here would double-delay
    // audio ~200ms behind video after startup or an underrun.
    const ctx = new MockAudioContext();
    const clock = { now: () => ctx.currentTime * 1_000_000 };
    const out = new WebAudioOutput(ctx as unknown as AudioContext, undefined, undefined, clock);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_500_000);
    expect(ctx.started[0]!.when).toBeCloseTo(1.5, 5); // exactly the render time
  });

  // With playbackDelayMs = 0, the cushion arrives INSIDE renderTimeUs (the
  // dispatcher adds the shared pipeline cushion) — the output must anchor at
  // exactly toAudioCtxTime(renderTimeUs), adding no delay of its own.
  it('with zero playbackDelayMs the first anchor is exactly the render time', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_500_000); // render at ctx 1.5s
    expect(ctx.started[0]!.when).toBeCloseTo(1.5, 5);
  });

  it('PINNED SEMANTICS: a mid-chain cushion change does NOT retime healthy chained playback', () => {
    // Audio adopts the shared cushion at anchor/underrun boundaries ONLY.
    // While the chain is healthy (nextScheduledTime >= now) schedule()
    // intentionally ignores renderTimeUs — retiming a playing chain would
    // need an audible gap or rate control (slice-C territory). So a cushion
    // that grows mid-session reaches audio playout at the NEXT underrun,
    // not immediately. Video adopts per-frame; transient divergence between
    // a cushion change and the next audio anchor is expected and bounded.
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200_000);      // anchor at 1.2 (cushion 200ms)
    // Cushion grew to 400ms upstream — next buffer arrives while the chain
    // is still healthy, carrying renderTime reflecting the LARGER cushion.
    out.schedule(audioData(20_000) as unknown as AudioData, 1_420_000);
    // Chained back-to-back at 1.22 — renderTime (1.42) intentionally ignored.
    expect(ctx.started[1]!.when).toBeCloseTo(1.22, 5);
  });

  it('the next underrun re-anchor ADOPTS the grown cushion (adoption boundary)', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200_000);      // chain ends 1.22
    ctx.currentTime = 2.0;                                              // underrun
    out.schedule(audioData(20_000) as unknown as AudioData, 2_400_000); // new 400ms cushion inside renderTime
    expect(ctx.started[1]!.when).toBeCloseTo(2.4, 5);                   // adopted exactly
  });

  it('an underrun re-anchor also lands exactly on the (cushion-inclusive) render time', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_100_000); // 20ms buffer → chain ends 1.12
    ctx.currentTime = 2.0; // chain long dry — underrun
    out.schedule(audioData(20_000) as unknown as AudioData, 2_300_000);
    expect(ctx.started[1]!.when).toBeCloseTo(2.3, 5); // no hidden +200ms
  });
});
