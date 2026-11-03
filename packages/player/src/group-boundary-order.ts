/**
 * Orders a video track's objects across a group boundary.
 *
 * Each group arrives on its own stream (draft-ietf-moq-transport §10.4), so the
 * last objects of group N can arrive after object 0 of group N+1. On the MSE
 * paths that tail cannot be appended late: its decode time precedes the newer
 * keyframe's, which MSE treats as a discontinuity, dropping the late frame and
 * every frame after it until the next random access point. The MSE adapter
 * therefore discards it, leaving a hole at the group boundary.
 *
 * One instance per video track. While group N is open, objects of later groups
 * are held; group N's END_OF_GROUP releases them, in (group, object) order, and
 * so does losing group N's tail (its stream reset, {@link abandon}). A deadline
 * bounds the wait for a stream that stalls without ending. Holding starts once
 * the track is known to signal END_OF_GROUP: it has delivered one, or an
 * object's subgroup header declares it carries the group's end. A publisher
 * that never signals one sees no added latency.
 *
 * @see draft-ietf-moq-transport-16 §10.2.1 (Object Status: End of Group)
 * @see https://www.w3.org/TR/media-source-2/#sourcebuffer-coded-frame-processing
 * @module
 */
import { ObjectStatus, type MoqtObject } from '@openmoq/transport';

/**
 * Longest wait for a group's tail before later groups are released anyway.
 * Waiting is cheap: playback cannot pass group N's last frame before its tail
 * arrives, so holding group N+1 only costs time when the tail is truly lost.
 * A lost tail normally shows as a reset of its stream, which releases at once
 * ({@link GroupBoundaryOrder.abandon}); this bound covers a stream that stalls
 * without ending. Releasing sooner turns a late tail into a hole the MSE
 * adapter must jump (its gap jump waits as long), so the bound matches it.
 */
export const GROUP_BOUNDARY_WAIT_MS = 2000;

export class GroupBoundaryOrder {
  private group: bigint | null = null;
  private groupEnded = false;
  /** The track has delivered END_OF_GROUP, so a tail is worth waiting for. */
  private signalsEnd = false;
  /**
   * Assume group IDs advance by one, as live publishers number them, so after
   * a group ends a later group's head means the group in between is still in
   * flight. Assumed from the start because the first boundary is where a stall
   * at startup strands a group. Cleared the first time an expected group never
   * arrives, so a track that skips IDs waits out one deadline and is then
   * never held for a missing group again.
   */
  private consecutive = true;
  private held: MoqtObject[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deliver: (obj: MoqtObject) => void,
    private readonly waitMs: number = GROUP_BOUNDARY_WAIT_MS,
  ) {}

  push(obj: MoqtObject): void {
    const group = BigInt(obj.groupId);
    if (this.group === null || group === this.group || group < this.group) {
      // Current group, the first object, or a tail too late for this
      // window: deliver now and let the sink decide.
      this.release(obj);
      return;
    }
    // The open group is complete, so the next group may pass, unless this is a
    // later one and the group in between can still be expected.
    const nextExpected = this.consecutive && group > this.group + 1n;
    if (!this.signalsEnd || (this.groupEnded && !nextExpected)) {
      this.release(obj);
      return;
    }
    this.held.push(obj);
    if (this.timer === null) this.armDeadline();
  }

  /**
   * Release the next held group, in object order. Later groups stay held
   * behind it until it ends in turn: after a stall several groups can be
   * queued, and releasing them all at once would make the newest one current
   * while the next is still missing its tail.
   */
  flush(): void {
    this.releaseNextHeld(false);
  }

  private releaseNextHeld(deadline: boolean): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.held.length === 0) return;
    const next = this.held.reduce((min, o) => (BigInt(o.groupId) < min ? BigInt(o.groupId) : min), BigInt(this.held[0]!.groupId));
    const now = this.held
      .filter((o) => BigInt(o.groupId) === next)
      .sort((a, b) => {
        const oa = BigInt(a.objectId);
        const ob = BigInt(b.objectId);
        return oa < ob ? -1 : oa > ob ? 1 : 0;
      });
    const skips = this.groupEnded && this.group !== null && next > this.group + 1n;
    if (skips && this.consecutive && !deadline) {
      // The group after the completed one has not arrived: keep waiting for it.
      this.armDeadline();
      return;
    }
    this.held = this.held.filter((o) => BigInt(o.groupId) !== next);
    // Waited out a group that never came between a complete group and a later
    // one: this track does not number its groups consecutively.
    if (skips && deadline) this.consecutive = false;
    // Releasing the group's END_OF_GROUP re-enters flush for the following group.
    for (const obj of now) this.release(obj);
    if (this.held.length > 0 && this.timer === null) this.armDeadline();
  }

  private armDeadline(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.releaseNextHeld(true);
    }, this.waitMs);
  }


  /**
   * Group `groupId`'s tail is lost (its stream reset): stop waiting for it and
   * release later groups now. No-op unless `groupId` is the open group.
   */
  abandon(groupId: bigint): void {
    if (this.group !== groupId || this.groupEnded) return;
    this.groupEnded = true;
    if (this.held.length > 0) this.flush();
  }

  /** Drop held objects and the pending deadline (track retired or player reset). */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.held = [];
  }

  private release(obj: MoqtObject): void {
    const group = BigInt(obj.groupId);
    if (this.group === null || group > this.group) {
      this.group = group;
      this.groupEnded = false;
    }
    // A subgroup header whose END_OF_GROUP flag is set means that stream ends
    // the group, so a later group's early objects are worth holding even
    // before the first END_OF_GROUP has been seen.
    if (obj.subgroupContainsEndOfGroup === true) this.signalsEnd = true;
    const endsGroup = obj.kind === 'gap' && obj.status === ObjectStatus.END_OF_GROUP;
    if (endsGroup && group === this.group) {
      this.groupEnded = true;
      this.signalsEnd = true;
    }
    this.deliver(obj);
    if (endsGroup && group === this.group && this.held.length > 0) this.flush();
  }
}
