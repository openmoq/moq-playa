/** Limits for one subscription's downstream subgroup forwarding. */
export interface ForwardLimits {
  readonly maxConcurrentSubgroups: number;
  readonly maxPendingObjects: number;
  readonly maxPendingBytes: number;
}

export type EnqueueResult =
  | { readonly status: 'queued' }
  | { readonly status: 'inactive' }
  | { readonly status: 'overloaded'; readonly reason: string };

type ForwardTask<T> =
  | { readonly kind: 'object'; readonly value: T; readonly retainedBytes: number }
  | { readonly kind: 'close' };

interface ForwardLane<T> {
  readonly tasks: ForwardTask<T>[];
  active: boolean;
  running: boolean;
  closeQueued: boolean;
}

export interface SubgroupForwarderHandlers<T> {
  forward: (value: T) => Promise<void>;
  close: (subgroupKey: string) => Promise<void>;
  reportError: (error: unknown) => void;
}

/**
 * Preserve ordering within each subgroup without serializing unrelated QUIC
 * streams. A lane retains one concurrency slot until its downstream FIN settles,
 * which also bounds the number of open subgroup streams for this subscription.
 */
export class SubgroupForwarder<T> {
  private readonly lanes = new Map<string, ForwardLane<T>>();
  private activeLanes = 0;
  private pendingObjects = 0;
  private pendingBytes = 0;
  private accepting = true;
  private stopped = false;
  private readonly drained: Promise<void>;
  private resolveDrained!: () => void;

  constructor(
    private readonly limits: ForwardLimits,
    private readonly handlers: SubgroupForwarderHandlers<T>,
  ) {
    this.drained = new Promise<void>((resolve) => { this.resolveDrained = resolve; });
  }

  enqueueObject(subgroupKey: string, value: T, retainedBytes: number): EnqueueResult {
    if (!this.accepting || this.stopped) return { status: 'inactive' };
    let lane = this.lanes.get(subgroupKey);
    if (lane?.closeQueued) return { status: 'inactive' };

    const nextObjects = this.pendingObjects + 1;
    const nextBytes = this.pendingBytes + retainedBytes;
    if (nextObjects > this.limits.maxPendingObjects || nextBytes > this.limits.maxPendingBytes) {
      return {
        status: 'overloaded',
        reason: `forwarding backlog reached ${nextObjects} object(s) / ${nextBytes} bytes `
          + `(limits ${this.limits.maxPendingObjects} / ${this.limits.maxPendingBytes})`,
      };
    }

    if (!lane) {
      lane = { tasks: [], active: false, running: false, closeQueued: false };
      this.lanes.set(subgroupKey, lane);
    }
    lane.tasks.push({ kind: 'object', value, retainedBytes });
    this.pendingObjects = nextObjects;
    this.pendingBytes = nextBytes;
    if (lane.active) this.startLane(subgroupKey, lane);
    else this.pump();
    return { status: 'queued' };
  }

  enqueueClose(subgroupKey: string): void {
    if (this.stopped) return;
    const lane = this.lanes.get(subgroupKey);
    if (!lane || lane.closeQueued) return;
    lane.closeQueued = true;
    lane.tasks.push({ kind: 'close' });
    if (lane.active) this.startLane(subgroupKey, lane);
    else this.pump();
  }

  /** Stop accepting work, deliver what was already queued, and FIN every lane. */
  retire(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.accepting) {
      this.accepting = false;
      for (const subgroupKey of this.lanes.keys()) this.enqueueClose(subgroupKey);
      this.settleDrainedIfDone();
    }
    return this.drained;
  }

  /** Drop queued work immediately; connection teardown owns any in-flight write. */
  abort(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.accepting = false;
    for (const [subgroupKey, lane] of this.lanes) {
      this.dropQueuedObjects(lane);
      if (!lane.running) this.releaseLane(subgroupKey, lane);
    }
    this.resolveDrained();
  }

  private pump(): void {
    if (this.stopped) return;
    for (const [subgroupKey, lane] of this.lanes) {
      if (lane.active || lane.tasks.length === 0) continue;
      if (this.activeLanes >= this.limits.maxConcurrentSubgroups) break;
      lane.active = true;
      this.activeLanes += 1;
      this.startLane(subgroupKey, lane);
    }
  }

  private startLane(subgroupKey: string, lane: ForwardLane<T>): void {
    if (lane.running || this.stopped) return;
    lane.running = true;
    void this.runLane(subgroupKey, lane);
  }

  private async runLane(subgroupKey: string, lane: ForwardLane<T>): Promise<void> {
    let closed = false;
    try {
      while (!this.stopped) {
        const task = lane.tasks.shift();
        if (!task) break;
        if (task.kind === 'close') {
          closed = true;
          await this.handlers.close(subgroupKey);
          break;
        }
        try {
          await this.handlers.forward(task.value);
        } finally {
          this.pendingObjects -= 1;
          this.pendingBytes -= task.retainedBytes;
        }
      }
    } catch (err) {
      try { this.handlers.reportError(err); } catch { /* diagnostics must not poison the scheduler */ }
    } finally {
      lane.running = false;
      if (closed || this.stopped) {
        this.dropQueuedObjects(lane);
        this.releaseLane(subgroupKey, lane);
      } else if (lane.tasks.length > 0) {
        this.startLane(subgroupKey, lane);
      }
    }
  }

  private dropQueuedObjects(lane: ForwardLane<T>): void {
    for (const task of lane.tasks) {
      if (task.kind !== 'object') continue;
      this.pendingObjects -= 1;
      this.pendingBytes -= task.retainedBytes;
    }
    lane.tasks.length = 0;
  }

  private releaseLane(subgroupKey: string, lane: ForwardLane<T>): void {
    if (this.lanes.get(subgroupKey) !== lane) return;
    this.lanes.delete(subgroupKey);
    if (lane.active) {
      lane.active = false;
      this.activeLanes -= 1;
    }
    this.pump();
    this.settleDrainedIfDone();
  }

  private settleDrainedIfDone(): void {
    if (!this.accepting && this.lanes.size === 0) this.resolveDrained();
  }
}
