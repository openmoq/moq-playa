/**
 * Late-keyframe dependency behaviour in the production pipeline.
 *
 * Found while composing the real player path for the render-cushion
 * investigation: on a repeated delivery impairment, six source frames were never
 * decoded, and all six were GOP keyframes. `processDataObject()` returns at the
 * late-drop branch BEFORE `DecoderStateMachine.processVideoChunk()` observes the
 * object (`pipeline.ts:753-759`), so dropping an INDEPENDENT object leaves the
 * FSM in `DECODING` and its dependent deltas are still submitted — referencing a
 * keyframe the decoder never received.
 *
 * These tests now encode the SELECTED regression policy: decode
 * late non-discardable video to keep the stream decodable, rather than resetting
 * and waiting for the next independent frame — which would turn a transient
 * delay into up to a full keyframe interval of outage.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import { DefaultRecoveryController } from './recovery.js';
import type { ClockSource, DecoderCommand, PlaybackEvent, PlaybackConfig } from './types.js';
import type { LocHeaders } from '@moqt/loc';
import { varint, ObjectStatus } from '@moqt/transport';

class SimClock implements ClockSource {
  private nowUs = 0;
  now(): number { return this.nowUs; }
  set(us: number): void { this.nowUs = us; }
}

const GOP = 6;
const FRAME_US = 33_333;
const CONFIG: PlaybackConfig = {
  gapTimeoutUs: 200_000,
  driftThresholdUs: 100_000,
  maxBufferDepth: 240,
};

function headers(
  captureUs: number,
  independent: boolean,
  opts?: { discardable?: boolean; omitMarking?: boolean },
): LocHeaders {
  if (opts?.omitMarking) return { captureTimestamp: BigInt(captureUs) };
  return {
    captureTimestamp: BigInt(captureUs),
    videoFrameMarking: {
      startOfFrame: true, endOfFrame: true, independent,
      discardable: opts?.discardable ?? false, baseLayerSync: false, temporalId: 0,
    },
  };
}

function object(groupId: number, objectId: number, independent: boolean) {
  const payload = new Uint8Array(32).fill(0x41);
  // IDR-shaped leading byte for independent objects, so enabling AVC keyframe
  // validation does not add `keyframe_validation_failed` noise to the evidence.
  if (independent) payload[0] = 0x65;
  return {
    kind: 'data' as const,
    trackAlias: varint(1),
    groupId: varint(groupId),
    subgroupId: varint(0),
    objectId: varint(objectId),
    publisherPriority: 128,
    extensions: undefined,
    payload,
  };
}

/** The adapter's END_OF_GROUP synthesis shape: objectId = previous + 1. */
function endOfGroup(groupId: number, lastObjectId: number) {
  return {
    kind: 'gap' as const,
    trackAlias: varint(1),
    groupId: varint(groupId),
    subgroupId: varint(0),
    objectId: varint(lastObjectId + 1),
    status: ObjectStatus.END_OF_GROUP,
  };
}

interface Rig {
  clock: SimClock;
  pipeline: PlaybackPipeline;
  commands: DecoderCommand[];
  events: PlaybackEvent[];
  decodedTimestamps: () => number[];
}

function makeRig(): Rig {
  const clock = new SimClock();
  const sync = new SyncController({ clock, driftThresholdUs: CONFIG.driftThresholdUs });
  const commands: DecoderCommand[] = [];
  const events: PlaybackEvent[] = [];
  const pipeline = new PlaybackPipeline({
    mediaType: 'video', config: CONFIG, clock, sync,
    videoOnly: true, isLive: true,
    recovery: new DefaultRecoveryController(),
    onCommand: (c) => commands.push(c),
    onEvent: (e) => events.push(e),
  });
  pipeline.setCodec('avc1.42c01f');
  pipeline.configure(new Uint8Array(0));
  return {
    clock, pipeline, commands, events,
    decodedTimestamps: () => commands
      .filter((c) => c.type === 'decode_video')
      .map((c) => Number((c as { chunk: { timestamp: number | bigint } }).chunk.timestamp)),
  };
}

/**
 * Push one GOP with a monotonic clock. `delayUs` models a delivery stall on the
 * group's first object: the keyframe arrives that much late, and the deltas
 * queue behind it on the same subgroup stream (so they are late too, but by
 * progressively less as the backlog drains).
 */
function pushGop(rig: Rig, groupId: number, delayUs = 0, opts?: { withEog?: boolean }): void {
  for (let o = 0; o < GOP; o++) {
    const index = groupId * GOP + o;
    const captureUs = index * FRAME_US;
    // The stall hits the keyframe; each subsequent object recovers one frame
    // interval of the backlog.
    const lateBy = delayUs === 0 ? 0 : Math.max(0, delayUs - o * FRAME_US);
    rig.clock.set(Math.max(rig.clock.now(), captureUs + lateBy));
    rig.pipeline.pushObject(object(groupId, o, o === 0), headers(captureUs, o === 0));
    rig.pipeline.tick();
  }
  // Without this the pipeline waits at every group boundary and only releases
  // the next GOP once an intra-group timeout fires — which silently made an
  // earlier version of this test pass for the wrong reason.
  if (opts?.withEog !== false) {
    rig.pipeline.pushObject(endOfGroup(groupId, GOP - 1));
    rig.pipeline.tick();
  }
}

describe('pipeline — dropping a late independent frame', () => {
  it('decodes a clean two-GOP sequence in full, with no fuse activity (control)', () => {
    const rig = makeRig();
    pushGop(rig, 0);
    pushGop(rig, 1);
    for (let i = 0; i < 5; i++) { rig.clock.set(rig.clock.now() + FRAME_US); rig.pipeline.tick(); }

    const decoded = rig.decodedTimestamps();
    expect(decoded.length).toBe(GOP * 2);
    expect(decoded).toContain(GOP * FRAME_US); // GOP 1's keyframe

    // It must decode for the RIGHT reason: no boundary timeout, no skip, no
    // decoder reset. Removing the EOG lifecycle must break this.
    expect(rig.events.filter((e) => e.type === 'partial_group_abandoned').length).toBe(0);
    expect(rig.events.filter((e) => e.type === 'skip_forward').length).toBe(0);
    expect(rig.events.filter((e) => e.type === 'keyframe_waiting').length).toBe(0);
    expect(rig.commands.filter((c) => c.type === 'reset').length).toBe(0);
  });

  it('keeps a late keyframe and its dependents (regression for the broken chain)', () => {
    const rig = makeRig();
    pushGop(rig, 0);
    // 520 ms: object 0 is late by 520 ms and crosses the 500 ms drop threshold,
    // while object 1 is only ~487 ms late and reaches the decoder path. This
    // isolates the broken-reference case rather than dropping several leading
    // objects for the same timing reason.
    pushGop(rig, 1, 520_000);
    for (let i = 0; i < 5; i++) { rig.clock.set(rig.clock.now() + FRAME_US); rig.pipeline.tick(); }

    const decoded = rig.decodedTimestamps();
    const gop1Keyframe = GOP * FRAME_US;
    const gop1Deltas = Array.from({ length: GOP - 1 }, (_, i) => (GOP + i + 1) * FRAME_US);

    // Previously the late keyframe was discarded before the decoder while its
    // dependants were still submitted — a broken reference chain. The keyframe
    // must now survive, so the chain its dependants need stays intact.
    expect(decoded).toContain(gop1Keyframe);
    const submitted = gop1Deltas.filter((ts) => decoded.includes(ts));
    expect(submitted.length).toBeGreaterThan(0);

    // Reference state is preserved by decoding, not by resetting the decoder.
    expect(rig.commands.filter((c) => c.type === 'reset').length).toBe(0);
    expect(rig.events.filter((e) => e.type === 'keyframe_waiting').length).toBe(0);
  });
});

/**
 * Late-video pre-decode drop policy.
 *
 * The boundary is NOT keyframe-vs-delta; it is **non-discardable vs explicitly
 * discardable** encoded video. Per RFC 9626 §3.1, D=1 is the sender asserting a
 * frame can be removed while the stream remains decodable; D=0 does not prove
 * the frame is a reference, only that decodability after removal is not
 * guaranteed. Removing such a frame before the decoder therefore risks the rest
 * of the GOP, whereas dropping decoded output at presentation costs one picture —
 * and the player already has an output-stage lateness policy for that.
 */
describe('pipeline — late video pre-decode drop policy', () => {
  /** Push one object at a chosen lateness, with an already-running GOP 0. */
  function rigWithLateObject(opts: {
    objectId: number;
    independent: boolean;
    discardable?: boolean;
    omitMarking?: boolean;
    lateByUs: number;
  }): Rig {
    const rig = makeRig();
    pushGop(rig, 0);
    const captureUs = (GOP + opts.objectId) * FRAME_US;
    // Deliver GOP 1 up to (but excluding) the late object, on time, so the late
    // object is releasable in order rather than waiting behind a hole.
    for (let o = 0; o < opts.objectId; o++) {
      const onTimeUs = (GOP + o) * FRAME_US;
      rig.clock.set(onTimeUs);
      rig.pipeline.pushObject(object(1, o, o === 0), headers(onTimeUs, o === 0));
      rig.pipeline.tick();
    }
    rig.clock.set(captureUs + opts.lateByUs);
    rig.pipeline.pushObject(
      object(1, opts.objectId, opts.independent),
      headers(captureUs, opts.independent, {
        ...(opts.discardable !== undefined ? { discardable: opts.discardable } : {}),
        ...(opts.omitMarking ? { omitMarking: true } : {}),
      }),
    );
    rig.pipeline.tick();
    for (let i = 0; i < 3; i++) { rig.clock.set(rig.clock.now() + FRAME_US); rig.pipeline.tick(); }
    return rig;
  }

  const LATE = 520_000; // past the 500 ms drop threshold

  it('decodes a late non-discardable INDEPENDENT frame, preserving the anchor', () => {
    const rig = rigWithLateObject({ objectId: 0, independent: true, lateByUs: LATE });
    expect(rig.decodedTimestamps()).toContain(GOP * FRAME_US);
    expect(rig.commands.filter((c) => c.type === 'reset').length).toBe(0);
    expect(rig.events.filter((e) => e.type === 'keyframe_waiting').length).toBe(0);
  });

  it('decodes a late non-discardable DELTA, so later dependents stay valid', () => {
    const rig = rigWithLateObject({ objectId: 2, independent: false, discardable: false, lateByUs: LATE });
    expect(rig.decodedTimestamps()).toContain((GOP + 2) * FRAME_US);
  });

  it('may omit a late EXPLICITLY DISCARDABLE non-independent delta', () => {
    const rig = rigWithLateObject({ objectId: 2, independent: false, discardable: true, lateByUs: LATE });
    expect(rig.decodedTimestamps()).not.toContain((GOP + 2) * FRAME_US);
  });

  it('is conservative when VideoFrameMarking is absent', () => {
    const rig = rigWithLateObject({ objectId: 2, independent: false, omitMarking: true, lateByUs: LATE });
    expect(rig.decodedTimestamps()).toContain((GOP + 2) * FRAME_US);
  });

  it('preserves an independent frame even when discardable is also set', () => {
    const rig = rigWithLateObject({ objectId: 0, independent: true, discardable: true, lateByUs: LATE });
    expect(rig.decodedTimestamps()).toContain(GOP * FRAME_US);
  });

  it('leaves the audio late-drop contract unchanged', () => {
    const clock = new SimClock();
    const sync = new SyncController({ clock, driftThresholdUs: CONFIG.driftThresholdUs });
    const commands: DecoderCommand[] = [];
    const pipeline = new PlaybackPipeline({
      mediaType: 'audio', config: CONFIG, clock, sync, isLive: true,
      recovery: new DefaultRecoveryController(),
      onCommand: (c) => commands.push(c), onEvent: () => {},
    });
    pipeline.configure(new Uint8Array(0));
    // First sample establishes the audio reference.
    clock.set(0);
    pipeline.pushObject(object(0, 0, false), { captureTimestamp: 0n });
    pipeline.tick();
    // A sample 520 ms late must still be dropped before decode.
    clock.set(FRAME_US + LATE);
    pipeline.pushObject(object(0, 1, false), { captureTimestamp: BigInt(FRAME_US) });
    pipeline.tick();
    const decodedAudio = commands
      .filter((c) => c.type === 'decode_audio')
      .map((c) => Number((c as { chunk: { timestamp: number | bigint } }).chunk.timestamp));
    expect(decodedAudio).not.toContain(FRAME_US);
  });
});
