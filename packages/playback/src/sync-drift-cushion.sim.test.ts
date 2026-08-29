/**
 * Characterization of the DEPRECATED `reportActualRenderTime` metric.
 *
 * The deprecated `SyncController.reportActualRenderTime()` compares actual
 * presentation time against `localBaseline + (capture - captureBaseline)` — the PTS-anchored
 * time WITHOUT any playout cushion (`sync.ts:283-290`). But the player
 * deliberately presents at `ptsRenderTime + cushion`, so the cushion appears in
 * full as drift on every frame, forever.
 *
 * Consequences observed in the real-class composition: 590-1199 `sync_drift`
 * events in a single run — one per presentation after the first — each of which
 * `handlePipelineEvent()` reports. A deliberate 200 ms+ playout delay is not
 * clock drift.
 *
 * These tests pin why that metric was replaced. The live path now measures
 * presentation-schedule drift via `reportPresentationTiming`; see the suites
 * below.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { ClockSource } from './types.js';

class SimClock implements ClockSource {
  private nowUs = 0;
  now(): number { return this.nowUs; }
  set(us: number): void { this.nowUs = us; }
}

const FRAME_US = 33_333;
const CUSHION_US = 200_000;

function anchored(): { sync: SyncController; clock: SimClock } {
  const clock = new SimClock();
  const sync = new SyncController({ clock, driftThresholdUs: 100_000 });
  clock.set(0);
  sync.setVideoReference(0n);
  return { sync, clock };
}

describe('SyncController — playout cushion counted as drift', () => {
  it('reports zero drift when frames render at the uncushioned PTS time', () => {
    const { sync, clock } = anchored();
    for (let i = 1; i <= 10; i++) {
      const captureUs = i * FRAME_US;
      const timing = sync.computeVideoRenderTime(BigInt(captureUs))!;
      clock.set(timing.renderTimeUs);
      sync.reportActualRenderTime(BigInt(captureUs), timing.renderTimeUs);
    }
    expect(sync.currentDriftUs).toBe(0);
  });

  it('reports the FULL cushion as drift when frames render on their intended schedule', () => {
    const { sync, clock } = anchored();
    for (let i = 1; i <= 10; i++) {
      const captureUs = i * FRAME_US;
      const timing = sync.computeVideoRenderTime(BigInt(captureUs))!;
      // Present exactly when the player intended: PTS + the playout cushion.
      const scheduledUs = timing.renderTimeUs + CUSHION_US;
      clock.set(scheduledUs);
      sync.reportActualRenderTime(BigInt(captureUs), scheduledUs);
    }
    // Nothing drifted — every frame rendered exactly on schedule — yet the whole
    // cushion is reported as drift.
    expect(sync.currentDriftUs).toBe(CUSHION_US);
  });

  it('exceeds the drift threshold purely because of the cushion', () => {
    const { sync, clock } = anchored();
    const captureUs = FRAME_US;
    const timing = sync.computeVideoRenderTime(BigInt(captureUs))!;
    const scheduledUs = timing.renderTimeUs + CUSHION_US;
    clock.set(scheduledUs);
    sync.reportActualRenderTime(BigInt(captureUs), scheduledUs);

    // 200 ms cushion against a 100 ms threshold: a perfectly scheduled stream
    // reported drift on every single frame, and tripped the flag that USED TO
    // gate the `sync_drift` event. Production no longer consults it.
    expect(Math.abs(sync.currentDriftUs)).toBeGreaterThan(100_000);
    expect(sync.needsResync).toBe(true);
  });
});

/**
 * Schedule-based presentation drift.
 *
 * `sync_drift` is redefined as PRESENTATION SCHEDULE ERROR: did the renderer
 * present when it was told to? The authority is the exact scheduled timestamp
 * stored with the rendered frame, never a recomputed or subtracted cushion — that
 * timestamp already accounts for the cushion actually applied, the live-join
 * offset, decode-output recomputation and late-frame handling, and an adaptive
 * cushion can move between enqueue and presentation.
 *
 * Actual audio/video skew remains `sync_skew`'s job.
 */
describe('SyncController — presentation schedule drift', () => {
  it('reports zero drift when a cushioned frame is presented exactly on schedule', () => {
    const { sync } = anchored();
    const captureUs = FRAME_US;
    const timing = sync.computeVideoRenderTime(BigInt(captureUs))!;
    const scheduledUs = timing.renderTimeUs + CUSHION_US;
    sync.reportPresentationTiming(scheduledUs, scheduledUs);
    expect(sync.currentDriftUs).toBe(0);
    expect(sync.presentationDriftExceeded).toBe(false);
  });

  it('reports signed drift equal to how late the frame actually was', () => {
    const { sync } = anchored();
    const timing = sync.computeVideoRenderTime(BigInt(FRAME_US))!;
    const scheduledUs = timing.renderTimeUs + CUSHION_US;
    const lateByUs = 150_000;
    sync.reportPresentationTiming(scheduledUs, scheduledUs + lateByUs);
    expect(sync.currentDriftUs).toBe(lateByUs);
    expect(sync.presentationDriftExceeded).toBe(true);
  });

  it('stays at zero when the cushion changes between adjacent frames', () => {
    const { sync } = anchored();
    const cushions = [200_000, 420_000];
    for (const [i, cushionUs] of cushions.entries()) {
      const timing = sync.computeVideoRenderTime(BigInt((i + 1) * FRAME_US))!;
      const scheduledUs = timing.renderTimeUs + cushionUs;
      sync.reportPresentationTiming(scheduledUs, scheduledUs);
      expect(sync.currentDriftUs).toBe(0);
    }
  });

  it('stays at zero while a live-join offset is active', () => {
    const { sync, clock } = anchored();
    // Force a join re-anchor, then present exactly on the resulting schedule.
    clock.set(2_000_000);
    sync.onVideoJoin(BigInt(FRAME_US));
    const timing = sync.computeVideoRenderTime(BigInt(FRAME_US))!;
    const scheduledUs = timing.renderTimeUs + CUSHION_US;
    sync.reportPresentationTiming(scheduledUs, scheduledUs);
    expect(sync.currentDriftUs).toBe(0);
  });

});

/**
 * Suppression lives at the PIPELINE, not in `SyncController`: the schedule is
 * required by the measurement, and a feedback item lacking one must suppress the
 * whole measurement/event transaction — returning before drift is even read, so
 * a stale value from an earlier frame cannot be re-emitted as a fresh event.
 */
describe('PlaybackPipeline — suppression without a schedule', () => {
  function rig() {
    const clock = new SimClock();
    const sync = new SyncController({ clock, driftThresholdUs: 100_000 });
    const events: { type: string }[] = [];
    const pipeline = new PlaybackPipeline({
      mediaType: 'video',
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 100_000, maxBufferDepth: 100 },
      clock, sync, videoOnly: true, isLive: true,
      onCommand: () => {},
      onEvent: (e) => { events.push(e as { type: string }); },
    });
    clock.set(0);
    sync.setVideoReference(0n);
    return { clock, sync, pipeline, events };
  }

  it('emits schedule drift when the renderer reports a schedule it missed', () => {
    const { pipeline, events } = rig();
    pipeline.handleFeedback({
      type: 'frame_rendered', mediaType: 'video',
      captureTimestampUs: BigInt(FRAME_US),
      scheduledRenderUs: 1_000_000, actualRenderUs: 1_300_000,
    });
    expect(events.filter((e) => e.type === 'sync_drift')).toHaveLength(1);
  });

  it('does not re-emit a stale drift value when a later frame reports no schedule', () => {
    const { sync, pipeline, events } = rig();
    // Establish high drift via a scheduled report...
    pipeline.handleFeedback({
      type: 'frame_rendered', mediaType: 'video',
      captureTimestampUs: BigInt(FRAME_US),
      scheduledRenderUs: 1_000_000, actualRenderUs: 1_300_000,
    });
    const driftAfterFirst = sync.currentDriftUs;
    expect(events.filter((e) => e.type === 'sync_drift')).toHaveLength(1);

    // ...then a renderer that cannot report its schedule must produce NO second
    // event and must not disturb the recorded value.
    pipeline.handleFeedback({
      type: 'frame_rendered', mediaType: 'video',
      captureTimestampUs: BigInt(2 * FRAME_US),
      actualRenderUs: 9_999_999,
    });
    expect(events.filter((e) => e.type === 'sync_drift')).toHaveLength(1);
    expect(sync.currentDriftUs).toBe(driftAfterFirst);
  });

  it('emits a real schedule miss DURING an active live-join offset', () => {
    // The legacy metric suppressed drift while `videoJoinOffsetUs > 0`, because
    // the offset itself showed up as drift. The exact queued schedule already
    // contains that offset, so a miss of it during a join is real and must be
    // reported — this is the case a `needsResync`-gated pipeline swallows.
    const { clock, sync, pipeline, events } = rig();
    clock.set(2_000_000);
    sync.onVideoJoin(BigInt(FRAME_US));
    expect(sync.videoJoinOffsetUs).toBeGreaterThan(0);

    pipeline.handleFeedback({
      type: 'frame_rendered', mediaType: 'video',
      captureTimestampUs: BigInt(FRAME_US),
      scheduledRenderUs: 1_000_000, actualRenderUs: 1_300_000,
    });

    const drift = events.filter((e) => e.type === 'sync_drift') as unknown as { driftUs: number }[];
    expect(drift).toHaveLength(1);
    expect(drift[0]!.driftUs).toBe(300_000);
  });

  it('measures schedule drift even with no capture timestamp', () => {
    // The old PTS-era gate required captureTimestampUs > 0. Both values are on
    // the same local clock now, so that gate is gone.
    const { pipeline, events } = rig();
    pipeline.handleFeedback({
      type: 'frame_rendered', mediaType: 'video',
      captureTimestampUs: 0n,
      scheduledRenderUs: 1_000_000, actualRenderUs: 1_400_000,
    });
    expect(events.filter((e) => e.type === 'sync_drift')).toHaveLength(1);
  });

  it('does not hide schedule drift beyond five seconds', () => {
    // The old >5s suppression existed for cross-epoch capture timestamps, which
    // cannot arise in same-clock actual-minus-scheduled arithmetic.
    const { pipeline, events } = rig();
    pipeline.handleFeedback({
      type: 'frame_rendered', mediaType: 'video',
      captureTimestampUs: BigInt(FRAME_US),
      scheduledRenderUs: 1_000_000, actualRenderUs: 7_500_000,
    });
    const drift = events.find((e) => e.type === 'sync_drift') as { driftUs: number } | undefined;
    expect(drift?.driftUs).toBe(6_500_000);
  });
});

/**
 * Propagation coverage. The measurement is only truthful if the exact queued
 * schedule actually reaches the pipeline, so each hop is asserted directly:
 * deleting either forwarding step must fail.
 */
describe('presentation-schedule propagation', () => {
  it('CommandDispatcher forwards the schedule when the renderer reports one', async () => {
    const { CommandDispatcher } = await import('../../player/src/command-dispatcher.js');
    const renderer = {
      enqueue() {}, flush() {}, destroy() {},
      onFirstFrame: null,
      onFrameRendered: null as ((c: bigint, a: number, s?: number) => void) | null,
      onStall: null,
    };
    const feedback: { type: string; scheduledRenderUs?: number; actualRenderUs?: number }[] = [];
    new CommandDispatcher({
      renderer: renderer as never,
      onFeedback: (fb) => { feedback.push(fb as never); },
    });

    // The dispatcher installs its own callback; invoke it as CanvasRenderer does.
    renderer.onFrameRendered?.(123n, 5_000, 4_800);
    const fb = feedback.find((f) => f.type === 'frame_rendered');
    expect(fb?.scheduledRenderUs).toBe(4_800);
    expect(fb?.actualRenderUs).toBe(5_000);
  });

  it('CommandDispatcher omits the field when the renderer cannot report one', async () => {
    const { CommandDispatcher } = await import('../../player/src/command-dispatcher.js');
    const renderer = {
      enqueue() {}, flush() {}, destroy() {},
      onFirstFrame: null,
      onFrameRendered: null as ((c: bigint, a: number, s?: number) => void) | null,
      onStall: null,
    };
    const feedback: { type: string; scheduledRenderUs?: number }[] = [];
    new CommandDispatcher({
      renderer: renderer as never,
      onFeedback: (fb) => { feedback.push(fb as never); },
    });

    renderer.onFrameRendered?.(123n, 5_000);
    const fb = feedback.find((f) => f.type === 'frame_rendered');
    expect(fb).toBeDefined();
    expect('scheduledRenderUs' in (fb as object)).toBe(false);
  });
});
