import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObjectStatus, varint, type MoqtObject } from '@openmoq/transport';
import { GroupBoundaryOrder, GROUP_BOUNDARY_WAIT_MS } from './group-boundary-order.js';

const data = (group: number, object: number): MoqtObject => ({
  kind: 'data',
  trackAlias: varint(1),
  groupId: varint(group),
  subgroupId: varint(0),
  objectId: varint(object),
  payload: new Uint8Array([group, object]),
} as MoqtObject);

/** An object whose subgroup header declares it carries the group's end. */
const flagged = (group: number, object: number): MoqtObject => ({
  ...data(group, object),
  subgroupContainsEndOfGroup: true,
} as MoqtObject);

const endOfGroup = (group: number, object: number): MoqtObject => ({
  kind: 'gap',
  trackAlias: varint(1),
  groupId: varint(group),
  subgroupId: varint(0),
  objectId: varint(object),
  status: ObjectStatus.END_OF_GROUP,
} as MoqtObject);

describe('GroupBoundaryOrder', () => {
  let out: string[];
  let order: GroupBoundaryOrder;
  const ids = (o: MoqtObject) => `${o.groupId}:${o.objectId}`;

  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    order = new GroupBoundaryOrder((o) => out.push(ids(o)));
  });
  afterEach(() => {
    order.dispose();
    vi.useRealTimers();
  });

  /** Group 1, ended, so the track is known to signal END_OF_GROUP. */
  const firstGroup = () => {
    order.push(data(1, 0));
    order.push(data(1, 1));
    order.push(endOfGroup(1, 2));
  };

  it('holds the next group until the late tail and END_OF_GROUP arrive', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0)); // next group's head, ahead of group 2's tail
    order.push(data(2, 1));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1']);

    order.push(endOfGroup(2, 2));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1', '2:2', '3:0']);
  });

  it('releases held objects in order after the deadline when the tail is lost', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 1));
    order.push(data(3, 0));
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS - 1);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0']);

    vi.advanceTimersByTime(1);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '3:0', '3:1']);
    // Group 3 is now current; its own objects pass straight through.
    order.push(data(3, 2));
    expect(out.at(-1)).toBe('3:2');
  });

  it('passes objects straight through for a track that never signals END_OF_GROUP', () => {
    order.push(data(1, 0));
    order.push(data(2, 0));
    order.push(data(1, 1));
    expect(out).toEqual(['1:0', '2:0', '1:1']);
  });

  it('passes an ended group\'s successor straight through', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(endOfGroup(2, 1));
    order.push(data(3, 0));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1', '3:0']);
  });

  it('delivers a tail that arrives after the window and keeps the current group', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0));
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS);
    order.push(data(2, 1)); // too late: the sink decides
    order.push(data(3, 1));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '3:0', '2:1', '3:1']);
  });

  it('holds at the first group boundary when the subgroup header declares the group end', () => {
    // No END_OF_GROUP has been seen yet: the stall-at-startup case, where group
    // 2 arriving ahead of group 1's tail would otherwise strand that tail.
    order.push(flagged(1, 0));
    order.push(flagged(2, 0));
    order.push(flagged(1, 1));
    expect(out).toEqual(['1:0', '1:1']);
    order.push(endOfGroup(1, 2));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0']);
  });

  it('abandon releases the held groups as soon as the open group\'s tail is lost', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0));
    order.abandon(3n); // not the open group: still waiting for group 2
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0']);
    order.abandon(2n);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '3:0']);
    // The deadline was cancelled with the release.
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '3:0']);
  });

  it('after abandon, later objects of the next group are not held behind the lost group', () => {
    firstGroup();
    order.push(data(2, 0));
    order.abandon(2n);
    order.push(data(3, 0));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '3:0']);
  });

  it('waits out a delivery stall well beyond a few frame intervals', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0));
    vi.advanceTimersByTime(1500);
    order.push(data(2, 1)); // the tail, after a 1.5 s stall
    order.push(endOfGroup(2, 2));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1', '2:2', '3:0']);
  });

  it('releases queued groups one at a time, each behind the previous group\'s tail', () => {
    // After a stall, the heads of groups 3 and 4 arrive before group 2's
    // tail and before group 3's tail. Releasing both at once would make group
    // 4 current while group 3 is incomplete, stranding group 3's tail.
    firstGroup();
    order.push(data(2, 0));
    order.push(data(4, 0));
    order.push(data(3, 0));
    order.push(data(2, 1));
    order.push(endOfGroup(2, 2));
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1', '2:2', '3:0']);
    order.push(data(3, 1)); // group 3's tail: current group, passes straight through
    expect(out.at(-1)).toBe('3:1');
    order.push(endOfGroup(3, 2));
    expect(out.slice(-2)).toEqual(['3:2', '4:0']);
  });

  it('the deadline releases one group and keeps waiting for the next', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0));
    order.push(data(4, 0));
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '3:0']);
    order.push(endOfGroup(3, 1));
    expect(out.slice(-2)).toEqual(['3:1', '4:0']);
  });

  it('after a group ends, holds a later group while the group in between is still in flight', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(endOfGroup(2, 1)); // group 2 complete; groups advance by one
    order.push(data(4, 0)); // group 3's stream is delayed
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1']);
    order.push(data(3, 0));
    expect(out.at(-1)).toBe('3:0');
    order.push(endOfGroup(3, 1));
    expect(out.slice(-2)).toEqual(['3:1', '4:0']);
  });

  it('stops expecting consecutive groups once a skipped group never arrives', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(endOfGroup(2, 1));
    order.push(data(4, 0)); // group 3 does not exist
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS);
    expect(out.at(-1)).toBe('4:0');
    order.push(endOfGroup(4, 1));
    order.push(data(6, 0)); // no longer held for a group 5
    expect(out.at(-1)).toBe('6:0');
  });

  it('a track whose group IDs skip waits out one deadline, then is never held for a gap again', () => {
    order.push(data(10, 0));
    order.push(endOfGroup(10, 1));
    order.push(data(20, 0)); // assumed to follow group 11
    expect(out).toEqual(['10:0', '10:1']);
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS);
    expect(out).toEqual(['10:0', '10:1', '20:0']);
    order.push(endOfGroup(20, 1));
    order.push(data(30, 0));
    expect(out).toEqual(['10:0', '10:1', '20:0', '20:1', '30:0']);
  });

  it('when a group ends, keeps holding a later group until the one in between arrives', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(4, 0)); // held behind the open group 2
    order.push(endOfGroup(2, 1)); // group 3 has not arrived yet
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0', '2:1']);
    order.push(data(3, 0));
    order.push(endOfGroup(3, 1));
    expect(out.slice(-3)).toEqual(['3:0', '3:1', '4:0']);
  });

  it('dispose drops held objects and cancels the deadline', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0));
    order.dispose();
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS * 2);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0']);
  });
});
