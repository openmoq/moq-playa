/**
 * Invariant tests for the deterministic link model used by playout-timing
 * simulations.
 *
 * These exist because an ad-hoc arrival model silently produced a NON-CAUSAL
 * trace (a large frame's completion computed independently of the frames behind
 * it, so simulated time ran backward after every keyframe) and that invalidated
 * a root-cause analysis. The model is therefore an asserted component, not an
 * assumed one: causality is checked here, once, rather than re-derived by hand
 * in every timing test.
 *
 * Scope: MOQT does NOT guarantee globally ordered frame
 * arrivals — groups/subgroups ride independent QUIC streams and may complete
 * out of capture order. The invariants below are therefore about the EVENT
 * QUEUE (dispatch order, per-stream ordering, service eligibility), not about
 * global frame-order monotonicity. `fifo` is one explicitly named topology,
 * not a generic network.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { SerializedLinkModel } from '../test-support/serialized-link.js';

/** 30 fps frames on one stream, `key` every `gop` frames. */
function locFrames(opts: {
  count: number; fps?: number; gop?: number; keyBytes: number; deltaBytes: number; streamId?: string;
}) {
  const fps = opts.fps ?? 30;
  const gop = opts.gop ?? 60;
  return Array.from({ length: opts.count }, (_, i) => ({
    id: `f${i}`,
    streamId: opts.streamId ?? 's0',
    captureUs: Math.round(i * (1_000_000 / fps)),
    bytes: i % gop === 0 ? opts.keyBytes : opts.deltaBytes,
  }));
}

const MBPS = (n: number) => n * 1_000_000;

describe('SerializedLinkModel — causality invariants', () => {
  it('dispatches completion events in nondecreasing simulated time', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 20_000 });
    const out = link.run(locFrames({ count: 300, keyBytes: 400_000, deltaBytes: 15_000 }));

    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.completionUs).toBeGreaterThanOrEqual(out[i - 1]!.completionUs);
    }
  });

  it('never completes a frame before its capture + serialization + path delay', () => {
    const capacityBps = MBPS(8);
    const pathDelayUs = 20_000;
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps, pathDelayUs });
    const frames = locFrames({ count: 120, keyBytes: 400_000, deltaBytes: 15_000 });
    const out = link.run(frames);

    for (const c of out) {
      const serializationUs = Math.round((c.bytes * 8) / capacityBps * 1_000_000);
      expect(c.completionUs).toBeGreaterThanOrEqual(c.captureUs + serializationUs + pathDelayUs);
    }
  });

  it('preserves byte order within a stream even when a later frame is smaller', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 0 });
    // A huge frame followed immediately by a tiny one: the tiny frame must not
    // overtake it on the same stream, however cheap it is to serialize.
    const out = link.run([
      { id: 'big', streamId: 's0', captureUs: 0, bytes: 1_000_000 },
      { id: 'small', streamId: 's0', captureUs: 1_000, bytes: 100 },
    ]);
    const big = out.find((c) => c.id === 'big')!;
    const small = out.find((c) => c.id === 'small')!;
    expect(small.completionUs).toBeGreaterThan(big.completionUs);
  });

  it('reports queueing delay when a burst exceeds what the link can carry in cadence', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 20_000 });
    const out = link.run(locFrames({ count: 120, keyBytes: 400_000, deltaBytes: 15_000 }));

    // Frames captured while the keyframe is still on the wire must report queue delay.
    const behindKeyframe = out.filter((c) => c.id !== 'f0' && c.queueDelayUs > 0);
    expect(behindKeyframe.length).toBeGreaterThan(0);
    // The keyframe itself waits for nothing — it is first.
    expect(out.find((c) => c.id === 'f0')!.queueDelayUs).toBe(0);
  });

  it('adds no queue delay when capacity comfortably exceeds the media rate', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(100), pathDelayUs: 20_000 });
    const out = link.run(locFrames({ count: 120, keyBytes: 400_000, deltaBytes: 15_000 }));
    for (const c of out) expect(c.queueDelayUs).toBe(0);
  });

  it('classifies sustained capacity shortfall as overload, not jitter', () => {
    // Media averages ~5.1 Mbps; run it over a 2 Mbps link.
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(2), pathDelayUs: 20_000 });
    const out = link.run(locFrames({ count: 300, keyBytes: 400_000, deltaBytes: 15_000 }), { sourceDurationUs: 10_000_000 });

    expect(link.overloaded).toBe(true);
    // Queue delay grows without bound under sustained overload, rather than
    // oscillating around a steady value the way a periodic burst does.
    const first = out[10]!.queueDelayUs;
    const last = out[out.length - 1]!.queueDelayUs;
    expect(last).toBeGreaterThan(first * 5);
  });

  it('stays causal when jitter is injected', () => {
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(8),
      pathDelayUs: 20_000,
      // Deterministic pseudo-jitter — no Math.random in a replayable model.
      jitterUs: (i) => (i * 7919) % 15_000,
    });
    const out = link.run(locFrames({ count: 300, keyBytes: 400_000, deltaBytes: 15_000 }));
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.completionUs).toBeGreaterThanOrEqual(out[i - 1]!.completionUs);
    }
  });

  it('keeps same-stream delivery in offer order even when jitter favours the later frame', () => {
    // Post-transmission jitter must not let a later frame on the
    // SAME stream overtake an earlier one. Asserted against OFFER sequence, not
    // against whatever order the completion sort produced.
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(8),
      pathDelayUs: 0,
      jitterUs: (i) => (i === 0 ? 10_000 : 0),
    });
    const out = link.run([
      { id: 'a', streamId: 's0', captureUs: 0, bytes: 100 },
      { id: 'b', streamId: 's0', captureUs: 1, bytes: 100 },
    ]);
    const a = out.find((c) => c.id === 'a')!;
    const b = out.find((c) => c.id === 'b')!;
    expect(a.completionUs).toBeLessThanOrEqual(b.completionUs);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('allows cross-stream overtaking — that is legal MOQT behaviour', () => {
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(8),
      pathDelayUs: 0,
      jitterUs: (i) => (i === 0 ? 50_000 : 0),
    });
    const out = link.run([
      { id: 'v0', streamId: 'video', captureUs: 0, bytes: 100 },
      { id: 'a0', streamId: 'audio', captureUs: 1, bytes: 100 },
    ]);
    expect(out.map((c) => c.id)).toEqual(['a0', 'v0']);
  });

  it('does not report a single small frame as overload', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 0 });
    const one = [{ id: 'only', streamId: 's0', captureUs: 0, bytes: 100 }];
    // Without a declared source duration the model must not guess.
    link.run(one);
    expect(link.overloaded).toBeNull();
    // With one, 800 bits over 1 s is nowhere near 8 Mbps.
    link.run(one, { sourceDurationUs: 1_000_000 });
    expect(link.overloaded).toBe(false);
  });

  it('reports overload only when offered load exceeds capacity over the source interval', () => {
    const frames = locFrames({ count: 300, keyBytes: 400_000, deltaBytes: 15_000 });
    const sourceDurationUs = 10_000_000; // 300 frames at 30 fps

    // ~5.1 Mbps of media offered to a 2 Mbps link is overload...
    const hot = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(2), pathDelayUs: 0 });
    hot.run(frames, { sourceDurationUs });
    expect(hot.overloaded).toBe(true);

    // ...and the same media over 100 Mbps is not.
    const cool = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(100), pathDelayUs: 0 });
    cool.run(frames, { sourceDurationUs });
    expect(cool.overloaded).toBe(false);
  });

  it('resets overload classification between runs', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(2), pathDelayUs: 0 });
    const sourceDurationUs = 10_000_000;
    link.run(locFrames({ count: 300, keyBytes: 400_000, deltaBytes: 15_000 }), { sourceDurationUs });
    expect(link.overloaded).toBe(true);
    link.run(locFrames({ count: 300, keyBytes: 4_000, deltaBytes: 1_000 }), { sourceDurationUs });
    expect(link.overloaded).toBe(false);
    // A run with no declared duration must clear the previous classification.
    link.run(locFrames({ count: 10, keyBytes: 4_000, deltaBytes: 1_000 }));
    expect(link.overloaded).toBeNull();
  });

  it('is deterministic — identical input yields byte-identical output', () => {
    const opts = { topology: 'fifo' as const, capacityBps: MBPS(8), pathDelayUs: 20_000, jitterUs: (i: number) => (i * 7919) % 15_000 };
    const frames = locFrames({ count: 200, keyBytes: 400_000, deltaBytes: 15_000 });
    const a = new SerializedLinkModel(opts).run(frames);
    const b = new SerializedLinkModel(opts).run(frames);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('breaks simultaneous-event ties deterministically', () => {
    // Two streams whose frames are captured at exactly the same instant.
    const frames = [
      { id: 'a0', streamId: 'video', captureUs: 0, bytes: 10_000 },
      { id: 'b0', streamId: 'audio', captureUs: 0, bytes: 10_000 },
      { id: 'a1', streamId: 'video', captureUs: 33_333, bytes: 10_000 },
      { id: 'b1', streamId: 'audio', captureUs: 33_333, bytes: 10_000 },
    ];
    const opts = { topology: 'fifo' as const, capacityBps: MBPS(8), pathDelayUs: 0 };
    const a = new SerializedLinkModel(opts).run(frames).map((c) => c.id);
    const b = new SerializedLinkModel(opts).run([...frames]).map((c) => c.id);
    expect(a).toEqual(b);
  });
});

describe('SerializedLinkModel — offer-order contract', () => {
  it('rejects duplicate frame ids', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 0 });
    expect(() => link.run([
      { id: 'dup', streamId: 's0', captureUs: 0, bytes: 10 },
      { id: 'dup', streamId: 's0', captureUs: 1, bytes: 10 },
    ])).toThrow(/duplicate frame id/);
  });

  it('rejects a stream offered out of capture order, so offer order is well defined', () => {
    const link = new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 0 });
    expect(() => link.run([
      { id: 'later', streamId: 's0', captureUs: 1_000, bytes: 10 },
      { id: 'earlier', streamId: 's0', captureUs: 0, bytes: 10 },
    ])).toThrow(/out of capture order/);
  });
});

describe('SerializedLinkModel — time-varying capacity', () => {
  it('serves each segment at its own rate for objects wholly inside a segment', () => {
    // Neither object spans the boundary — this pins the per-segment rates only.
    // The spanning case (the actual start-sampling discriminator) is below.
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(10),
      pathDelayUs: 0,
      capacitySchedule: [{ fromUs: 0, bps: MBPS(10) }, { fromUs: 1_000_000, bps: MBPS(1) }],
    });
    const out = link.run([
      { id: 'early', streamId: 's0', captureUs: 0, bytes: 125_000 },
      { id: 'late', streamId: 's0', captureUs: 2_000_000, bytes: 125_000 },
    ]);
    const early = out.find((c) => c.id === 'early')!;
    const late = out.find((c) => c.id === 'late')!;
    expect(early.serializationUs).toBe(100_000);
    expect(late.serializationUs).toBe(1_000_000);
  });

  it('stays causal across a capacity step', () => {
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(50),
      pathDelayUs: 20_000,
      capacitySchedule: [
        { fromUs: 0, bps: MBPS(50) },
        { fromUs: 5_000_000, bps: MBPS(6) },
        { fromUs: 12_000_000, bps: MBPS(50) },
      ],
    });
    const out = link.run(locFrames({ count: 600, keyBytes: 400_000, deltaBytes: 15_000 }));
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.completionUs).toBeGreaterThanOrEqual(out[i - 1]!.completionUs);
    }
  });
});

describe('SerializedLinkModel — capacity schedule semantics', () => {
  it('integrates an object that is still in flight when capacity changes', () => {
    // 10 Mbps until 1 s, then 1 Mbps. A 125 KB object (1,000,000 bits) starting
    // at 950 ms sends 500,000 bits in its first 50 ms at 10 Mbps, then needs
    // 500 ms for the remaining 500,000 bits at 1 Mbps: 550 ms of service.
    // A start-sampled model would price the whole object at 10 Mbps (100 ms).
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(10),
      pathDelayUs: 0,
      capacitySchedule: [{ fromUs: 0, bps: MBPS(10) }, { fromUs: 1_000_000, bps: MBPS(1) }],
    });
    const out = link.run([{ id: 'spanning', streamId: 's0', captureUs: 950_000, bytes: 125_000 }]);
    expect(out[0]!.serializationUs).toBe(550_000);
  });

  it('classifies overload from integrated capacity, not the nominal rate', () => {
    // Nominal 10 Mbps would call this comfortable; the schedule spends most of
    // the interval at 1 Mbps, so the link truly cannot carry the offered bits.
    const frames = locFrames({ count: 300, keyBytes: 100_000, deltaBytes: 10_000 });
    const link = new SerializedLinkModel({
      topology: 'fifo',
      capacityBps: MBPS(10),
      pathDelayUs: 0,
      capacitySchedule: [{ fromUs: 0, bps: MBPS(10) }, { fromUs: 1_000_000, bps: MBPS(1) }],
    });
    link.run(frames, { sourceDurationUs: 10_000_000 });
    expect(link.overloaded).toBe(true);
  });

  it('rejects malformed capacity schedules', () => {
    const make = (schedule: readonly { fromUs: number; bps: number }[]) =>
      () => new SerializedLinkModel({ topology: 'fifo', capacityBps: MBPS(8), pathDelayUs: 0, capacitySchedule: schedule })
        .run([{ id: 'a', streamId: 's0', captureUs: 0, bytes: 10 }]);
    expect(make([{ fromUs: 1_000, bps: MBPS(8) }])).toThrow(/must start at fromUs 0/);
    expect(make([{ fromUs: 0, bps: MBPS(8) }, { fromUs: 0, bps: MBPS(1) }])).toThrow(/duplicate boundary/);
    expect(make([{ fromUs: 0, bps: MBPS(8) }, { fromUs: 5_000, bps: 0 }])).toThrow(/non-positive or non-finite/);
    expect(make([{ fromUs: 0, bps: MBPS(8) }, { fromUs: 5_000, bps: Number.POSITIVE_INFINITY }])).toThrow(/non-finite/);
    // Non-finite BOUNDARIES, distinct from non-finite rates.
    expect(make([{ fromUs: 0, bps: MBPS(8) }, { fromUs: Number.NaN, bps: MBPS(1) }])).toThrow(/boundary must be finite/);
    expect(make([{ fromUs: 0, bps: MBPS(8) }, { fromUs: Number.POSITIVE_INFINITY, bps: MBPS(1) }])).toThrow(/boundary must be finite/);
  });
});
