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
 * are held; group N's END_OF_GROUP releases them, in (group, object) order. A
 * deadline bounds the wait when the tail is lost. Holding starts only
 * once the track has delivered an END_OF_GROUP, so a publisher that never sends
 * one sees no added latency.
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
 * The bound covers a group stream stalling for a few frame intervals.
 */
export const GROUP_BOUNDARY_WAIT_MS = 250;

export class GroupBoundaryOrder {
  private group: bigint | null = null;
  private groupEnded = false;
  /** The track has delivered END_OF_GROUP, so a tail is worth waiting for. */
  private signalsEnd = false;
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
    if (this.groupEnded || !this.signalsEnd) {
      this.release(obj);
      return;
    }
    this.held.push(obj);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.waitMs);
    }
  }

  /** Release everything held, in (group, object) order. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const held = this.held.sort((a, b) => {
      const ga = BigInt(a.groupId);
      const gb = BigInt(b.groupId);
      if (ga !== gb) return ga < gb ? -1 : 1;
      const oa = BigInt(a.objectId);
      const ob = BigInt(b.objectId);
      return oa < ob ? -1 : oa > ob ? 1 : 0;
    });
    this.held = [];
    for (const obj of held) this.release(obj);
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
    const endsGroup = obj.kind === 'gap' && obj.status === ObjectStatus.END_OF_GROUP;
    if (endsGroup && group === this.group) {
      this.groupEnded = true;
      this.signalsEnd = true;
    }
    this.deliver(obj);
    if (endsGroup && group === this.group && this.held.length > 0) this.flush();
  }
}
