/** Completion-wait ownership through the public ClockSource callback only. */
import { describe, expect, it } from 'vitest';
import { ObjectStatus, varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { ClockSource, DecoderCommand, PlaybackEvent } from './types.js';

const GAP_US = 200_000;

function fixture() {
  let nowUs = 5_000_000;
  const highestObject = new Map<bigint, bigint>();
  let nextRead: (() => void) | undefined;
  let reentries = 0;
  const clock: ClockSource = {
    now: () => {
      const callback = nextRead;
      nextRead = undefined;
      if (callback) { reentries++; callback(); }
      return nowUs;
    },
  };
  const commands: DecoderCommand[] = [];
  const events: PlaybackEvent[] = [];
  const sync = new SyncController({ clock, driftThresholdUs: 10_000_000 });
  sync.setAudioReference(1_000_000_000n);
  const pipeline = new PlaybackPipeline({
    mediaType: 'video', clock, sync,
    config: { gapTimeoutUs: GAP_US, driftThresholdUs: 10_000_000, maxBufferDepth: 100 },
    onCommand: command => { commands.push(command); },
    onEvent: event => { events.push(event); },
  });
  const push = (group: number, object: number, key = false) => {
    const groupId = BigInt(group), objectId = BigInt(object);
    if (objectId > (highestObject.get(groupId) ?? -1n)) highestObject.set(groupId, objectId);
    const input = { group, object };
    const wire: MoqtObjectData = {
      kind: 'data', trackAlias: varint(1), groupId: varint(group), objectId: varint(object),
      subgroupId: varint(object % 2), publisherPriority: 128,
      extensions: undefined, payload: Uint8Array.of(group, object),
    };
    pipeline.pushObject(wire, {
      captureTimestamp: 1_000_000_000n + BigInt(group * 100_000 + object * 1000),
      videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: key,
        discardable: false, baseLayerSync: false, temporalId: object % 2 },
      ...(key ? { videoConfig: Uint8Array.of(1, 100) } : {}),
    }, input);
    return input;
  };
  // Install the public receipt observer so decode commands carry admitted input identity.
  pipeline.inputObserver = () => {};
  // Root exposes completion through the existing status input, not endGroup().
  // A bound after the highest supplied Object does not assert every earlier Object arrived.
  const endGroup = (groupId: bigint) => pipeline.pushObject({ kind: 'gap', trackAlias: varint(1),
    groupId: varint(groupId), subgroupId: varint(0),
    objectId: varint((highestObject.get(groupId) ?? -1n) + 1n), status: ObjectStatus.END_OF_GROUP });
  const decoded = () => commands.filter(command => command.type === 'decode_video');
  const resets = () => commands.filter(command => command.type === 'reset');
  const abandoned = () => events.filter(event => event.type === 'partial_group_abandoned');
  const first = push(0, 0, true);
  pipeline.tick();
  expect(decoded().map(command => command.inputToken)).toEqual([first]);
  commands.length = 0;
  events.length = 0;
  return {
    pipeline, endGroup, push, decoded, resets, abandoned, commands, events,
    advance(us: number) { nowUs += us; },
    onNextClock(callback: () => void) { nextRead = callback; },
    reentries: () => reentries,
  };
}

describe('Group completion wait ClockSource ownership', () => {
  it('does not restore a completion wait when EOG arrives inside its arming clock', () => {
    const f = fixture();
    f.push(1, 1);
    f.onNextClock(() => f.endGroup(0n));
    f.pipeline.tick();
    expect(f.reentries()).toBe(1);
    f.advance(50_000);
    f.pipeline.tick(); // Start the separate missing-RAP wait, if not already started.
    f.advance(151_000);
    f.pipeline.tick(); // A stale old completion wait must not publish abandonment.
    expect.soft(f.abandoned(), 'EOG observed in the arming read retires the old completion owner').toEqual([]);
    // A corrected implementation may start the new RAP wait in the same tick
    // or the next. Do not constrain its independent expiry with this old-owner oracle.
    f.push(1, 0, true);
    f.pipeline.tick();
    f.endGroup(1n);
    const fresh = f.push(2, 0, true);
    f.pipeline.tick();
    expect(f.decoded().at(-1)?.inputToken).toBe(fresh);
  });

  it('does not restore a completion wait after track reset inside its arming clock', () => {
    const f = fixture();
    const oldDelta = f.push(1, 1);
    let replacement: object | undefined;
    f.onNextClock(() => {
      f.pipeline.resetForTrackSwitch(7n);
      replacement = f.push(7, 0, true);
    });
    f.pipeline.tick();
    expect(f.reentries()).toBe(1);
    expect(f.resets()).toHaveLength(1); // The explicit public track reset is expected.
    f.commands.length = 0;
    f.events.length = 0;
    f.advance(GAP_US + 1);
    f.pipeline.tick();
    expect.soft(f.abandoned(), 'an old arming continuation cannot abandon the replacement lifetime').toEqual([]);
    expect.soft(f.resets()).toEqual([]);
    expect(f.decoded().map(command => command.inputToken)).toEqual([replacement]);
    expect(f.decoded().some(command => command.inputToken === oldDelta)).toBe(false);
    expect(f.pipeline.currentGroupId).toBe(7n);
  });

  it('does not expire a completion wait when EOG arrives inside its expiry clock', () => {
    const f = fixture();
    const delta = f.push(1, 1);
    f.pipeline.tick(); // Arm the unresolved Group0 completion wait.
    f.advance(GAP_US + 1);
    f.onNextClock(() => f.endGroup(0n));
    f.pipeline.tick();
    expect(f.reentries()).toBe(1);
    expect.soft(f.abandoned(), 'the expiry read observed actual completion before publishing abandonment').toEqual([]);
    expect.soft(f.resets()).toEqual([]);
    const key = f.push(1, 0, true);
    f.pipeline.tick();
    expect(f.decoded().map(command => command.inputToken)).toEqual([key, delta]);
  });

  it('does not publish abandonment against a replacement after reset inside its expiry clock', () => {
    const f = fixture();
    const oldDelta = f.push(1, 1);
    f.pipeline.tick();
    f.advance(GAP_US + 1);
    let replacement: object | undefined;
    f.onNextClock(() => {
      f.pipeline.resetForTrackSwitch(7n);
      replacement = f.push(7, 0, true);
    });
    f.pipeline.tick();
    expect(f.reentries()).toBe(1);
    expect.soft(f.abandoned(), 'a stale expiry must not publish an event for the replacement Group6 cursor').toEqual([]);
    expect(f.resets()).toHaveLength(1); // Only the explicit track reset.
    f.pipeline.tick();
    expect(f.decoded().map(command => command.inputToken)).toEqual([replacement]);
    expect(f.decoded().some(command => command.inputToken === oldDelta)).toBe(false);
    expect(f.pipeline.currentGroupId).toBe(7n);
  });

  it('healthy arming control: completion between ticks retires the old wait and decodes the reordered RAP', () => {
    const f = fixture();
    const delta = f.push(1, 1);
    f.onNextClock(() => {});
    f.pipeline.tick();
    expect(f.reentries()).toBe(1);
    f.advance(50_000);
    f.endGroup(0n);
    f.pipeline.tick();
    f.advance(151_000);
    f.pipeline.tick();
    expect(f.abandoned()).toEqual([]);
    expect(f.resets()).toEqual([]);
    const key = f.push(1, 0, true);
    f.pipeline.tick();
    expect(f.decoded().map(command => command.inputToken)).toEqual([key, delta]);
  });

  it('healthy expiry control: a still-current unresolved completion wait expires once and permits the next RAP', () => {
    const f = fixture();
    const delta = f.push(1, 1);
    f.pipeline.tick();
    f.advance(GAP_US + 1);
    f.onNextClock(() => {});
    f.pipeline.tick();
    expect(f.reentries()).toBe(1);
    expect(f.abandoned()).toEqual([{ type: 'partial_group_abandoned', fromGroupId: 0n,
      toGroupId: 1n, reason: 'intra-group timeout' }]);
    expect(f.resets()).toHaveLength(1);
    const key = f.push(1, 0, true);
    f.pipeline.tick();
    expect(f.decoded().map(command => command.inputToken)).toEqual([key, delta]);
    expect(f.resets()).toHaveLength(1);
  });
});
