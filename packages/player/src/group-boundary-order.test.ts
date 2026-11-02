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

  it('dispose drops held objects and cancels the deadline', () => {
    firstGroup();
    order.push(data(2, 0));
    order.push(data(3, 0));
    order.dispose();
    vi.advanceTimersByTime(GROUP_BOUNDARY_WAIT_MS * 2);
    expect(out).toEqual(['1:0', '1:1', '1:2', '2:0']);
  });
});
