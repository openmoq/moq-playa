type RetuneOperations<T> = {
  stop(): Promise<void>;
  start(target: T, signal: AbortSignal): Promise<void>;
};

export function parseVideoAltGroup(value: string | null): number | undefined {
  if (value === null) return undefined;
  const group = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(group)) {
    throw new Error('altGroup must be a safe integer');
  }
  return group;
}

function within(promise: Promise<void>, ms: number, label: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (callback: (value?: unknown) => void, value?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback(value);
    };
    const aborted = () => finish(reject, signal?.reason ?? new Error('View change cancelled'));
    const timer = setTimeout(() => finish(reject, new Error(`View ${label} timed out after ${ms}ms`)), ms);
    signal?.addEventListener('abort', aborted, { once: true });
    promise.then(() => finish(() => resolve()), error => finish(reject, error));
    if (signal?.aborted) aborted();
  });
}

/** A timed-out teardown still owns its resources until it actually finishes. */
export class TeardownBarrier {
  private pending: Promise<void> | undefined;
  constructor(private readonly timeoutMs = 15_000) {}
  run(operation: () => Promise<void>): Promise<void> {
    const previous = this.pending;
    const pending = (previous ?? Promise.resolve()).then(operation);
    this.pending = pending;
    void pending.then(() => {
      if (this.pending === pending) this.pending = undefined;
    }, () => {});
    return pending;
  }
  wait(): Promise<void> {
    return this.pending ? within(this.pending, this.timeoutMs, 'teardown') : Promise.resolve();
  }
}

/** Owns one stop-and-retune transaction; quality switching stays separate. */
export class ViewRetuner<T = number> {
  private controller: AbortController | undefined;
  constructor(
    private readonly operations: RetuneOperations<T>, private readonly timeoutMs = 15_000,
    private readonly same: (a: T, b: T) => boolean = Object.is,
  ) {}
  get busy(): boolean { return this.controller !== undefined; }
  cancel(): void { this.controller?.abort(new Error('View change cancelled')); }
  async change(target: T, choices: readonly T[], current: T | undefined): Promise<boolean> {
    if (this.busy) return false;
    if (!choices.some(choice => this.same(choice, target))) throw new Error('Unknown presentation choice');
    if (current !== undefined && this.same(target, current)) return false;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await within(this.operations.stop(), this.timeoutMs, 'teardown');
      if (controller.signal.aborted) return false;
      try {
        await within(this.operations.start(target, controller.signal), this.timeoutMs, 'startup', controller.signal);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        controller.abort(error);
        await within(this.operations.stop(), this.timeoutMs, 'cleanup');
        if (cancelled) return false;
        throw error;
      }
      return !controller.signal.aborted;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

/**
 * Video always requires a rendered first frame. For a proven audio-only scope,
 * accepted audio plus play intent is a bounded startup policy, not output evidence.
 * The owning retuner supplies the 15s budget and aborts this waiter on timeout.
 */
export function waitForOutput(
  p: Pick<import('@openmoq/player').MoqtPlayer, 'on' | 'selection' | 'state'>,
  signal: AbortSignal, hasVideo: () => boolean | undefined, isCurrent: () => boolean,
) {
  let complete!: (result: 'first-frame' | 'audio-accepted') => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<'first-frame' | 'audio-accepted'>((resolve, reject) => { complete = resolve; fail = reject; });
  const acceptedAudio = () => {
    if (isCurrent() && hasVideo() === false && p.selection.video === null && p.selection.audio !== null && p.state === 'playing') {
      complete('audio-accepted');
    }
  };
  const offFrame = p.on('first_frame', () => { if (isCurrent()) complete('first-frame'); });
  const offSelection = p.on('selection_changed', acceptedAudio);
  const offState = p.on('state_changed', acceptedAudio);
  const offError = p.on('error', e => {
    if (isCurrent() && e.error.severity === 'fatal') fail(new Error(e.error.message));
  });
  const aborted = () => fail(signal.reason);
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted(); else acceptedAudio();
  return { promise, dispose() { offFrame(); offSelection(); offState(); offError(); signal.removeEventListener('abort', aborted); } };
}
