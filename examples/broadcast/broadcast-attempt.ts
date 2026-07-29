/**
 * A broadcast STARTUP as a generation-owned transaction, DOM-free.
 *
 * Starting a broadcast crosses several awaits (capture, encoders, transport,
 * connection handshake, namespace publication). With mutable globals,
 * stopping attempt A and starting attempt B lets A's continuations overwrite
 * or tear down B's resources.
 *
 * Ownership here is at RESOURCE-CREATION granularity, not step granularity:
 * a step adopts each resource through {@link AttemptResources.adopt} the
 * moment it exists, so a failure or cancellation *between* a step's internal
 * awaits — a transport built but its handshake never completed, encoders
 * created but audio config throwing — still disposes what was acquired.
 * Disposal is LIFO, every disposer is contained, and a rejecting disposer can
 * never surface as an unhandled rejection.
 *
 * WHICH promise is the completion barrier, precisely:
 * - `run()` IS the final barrier. It re-enters `cancel()` after the step
 *   unwinds, so by the time it resolves `'cancelled'`, every disposal —
 *   including one started by an acquisition that only completed after Stop —
 *   has finished.
 * - `cancel()` is the barrier for everything outstanding AT THE MOMENT IT IS
 *   CALLED. It cannot be a barrier for an acquisition still pending inside a
 *   step (an open camera-permission prompt is not cancellable), so a `cancel()`
 *   that resolves before such an acquisition lands is correct, not a leak: the
 *   resource is disposed when it arrives (see {@link AttemptResources.adopt}),
 *   and a subsequent `cancel()` — which `run()` performs — awaits that.
 *
 * Cancellation reaches in-progress work: {@link AttemptResources.onCancel}
 * callbacks fire synchronously inside `cancel()`, letting a step abort a
 * hanging handshake rather than leaving the teardown blocked on it.
 */

export interface CaptureHandle { stop(): void }
export interface EncoderHandle { destroy(): void }

/** Minimal shape this module needs from a session (kept structural so the
 *  attempt has no import cycle with broadcast-session.ts). Callers keep their
 *  concrete session type through the generic parameter below. */
export interface SessionLike { shutdown(): Promise<void> }

/** Thrown by {@link AttemptResources.throwIfCancelled}. */
export class AttemptCancelledError extends Error {
  constructor() { super('broadcast attempt cancelled'); this.name = 'AttemptCancelledError'; }
}

/** The ownership context handed to every step. */
export interface AttemptResources {
  /**
   * Adopt `resource` for this attempt IMMEDIATELY — before the step that
   * created it returns — so any later failure or cancellation disposes it.
   * Returns `resource` so it can be used inline. If the attempt is ALREADY
   * cancelled, the resource's disposal starts right away and is awaited by
   * whichever barrier comes next — a still-active quiescence pass, or else the
   * next `cancel()` (which `run()` performs as it unwinds). It is never leaked.
   */
  adopt<T>(resource: T, dispose: (resource: T) => void | Promise<void>): T;
  /** Throw {@link AttemptCancelledError} if cancelled. Call after each await. */
  throwIfCancelled(): void;
  readonly cancelled: boolean;
  /** Run `cb` synchronously when cancel() is called — use it to abort an
   *  in-progress handshake (e.g. close the transport) so the step's pending
   *  await settles instead of hanging. */
  onCancel(cb: () => void): void;
}

/** The attempt's steps, injected so the transaction is unit-testable. Each
 *  receives the ownership context and MUST adopt what it creates. */
export interface BroadcastAttemptDeps<TSession extends SessionLike = SessionLike> {
  startCapture(ctx: AttemptResources): Promise<CaptureHandle>;
  createEncoders(ctx: AttemptResources, capture: CaptureHandle): EncoderHandle;
  openSession(ctx: AttemptResources): Promise<TSession>;
  publishNamespace(ctx: AttemptResources, session: TSession): Promise<void>;
  wirePublication(session: TSession, capture: CaptureHandle, encoders: EncoderHandle): void;
}

interface Adopted { resource: unknown; dispose: (r: never) => void | Promise<void>; disposed: boolean }

export class BroadcastAttempt<TSession extends SessionLike = SessionLike> {
  private readonly deps: BroadcastAttemptDeps<TSession>;
  private cancelled = false;
  private session: TSession | null = null;
  /** The in-flight quiescence pass, if any. Restartable: a disposal that
   *  begins after a pass completes gets a NEW pass, so no caller can observe
   *  cancellation as finished while a disposal is still running. */
  private quiescing: Promise<void> | null = null;
  /** Adoption order; disposed LIFO. */
  private readonly adopted: Adopted[] = [];
  /** Disposals currently running (from any pass or a post-cancel adoption). */
  private readonly runningDisposals = new Set<Promise<void>>();
  private readonly cancelCallbacks: Array<() => void> = [];
  private readonly ctx: AttemptResources;

  constructor(deps: BroadcastAttemptDeps<TSession>) {
    this.deps = deps;
    const self = this; // the `cancelled` getter below cannot be an arrow
    this.ctx = {
      adopt: <T>(resource: T, dispose: (resource: T) => void | Promise<void>): T => {
        const entry: Adopted = {
          resource,
          dispose: dispose as (r: never) => void | Promise<void>,
          disposed: false,
        };
        this.adopted.push(entry);
        // Already cancelled: this resource's acquisition finished AFTER the
        // teardown began (a camera whose permission prompt resolved after
        // Stop), so dispose it now. Tracking it makes any cancel() — including
        // one whose earlier pass already finished — await this disposal.
        if (this.cancelled) this.beginDisposal(entry);
        return resource;
      },
      throwIfCancelled: () => { if (this.cancelled) throw new AttemptCancelledError(); },
      get cancelled(): boolean { return self.cancelled; },
      onCancel: (cb: () => void) => {
        if (this.cancelled) { try { cb(); } catch { /* contained */ } return; }
        this.cancelCallbacks.push(cb);
      },
    };
  }

  get isCancelled(): boolean { return this.cancelled; }
  /** The session, once fully established (null before, and after teardown). */
  get currentSession(): TSession | null { return this.session; }

  /**
   * Run the startup transaction. Steps adopt their own resources as they are
   * created; between steps a cancellation gate stops further progress. Any
   * failure — or cancellation — releases everything this attempt acquired,
   * awaited, before returning or rethrowing. A cancelled attempt's failure is
   * reported as `'cancelled'`, never rethrown: it is not the user's error.
   */
  async run(): Promise<'completed' | 'cancelled'> {
    try {
      const capture = await this.deps.startCapture(this.ctx);
      this.ctx.throwIfCancelled();

      const encoders = this.deps.createEncoders(this.ctx, capture);
      this.ctx.throwIfCancelled();

      const session = await this.deps.openSession(this.ctx);
      this.ctx.throwIfCancelled();

      await this.deps.publishNamespace(this.ctx, session);
      this.ctx.throwIfCancelled();

      this.deps.wirePublication(session, capture, encoders);
      this.session = session;
      return 'completed';
    } catch (err) {
      const wasCancelled = this.cancelled || err instanceof AttemptCancelledError;
      // Release THIS attempt's resources — awaited, so nothing outlives run().
      await this.cancel();
      if (wasCancelled) return 'cancelled';
      throw err;
    }
  }

  /**
   * Cancel synchronously (the flag flips and abort callbacks fire before any
   * await, so an in-flight step settles at its next gate), then dispose every
   * adopted resource LIFO. Single-flight and never rejects.
   */
  cancel(): Promise<void> {
    this.cancelled = true;
    // Fire abort hooks FIRST — synchronously, before anything is awaited — so
    // local resources (capture, encoders) retire the instant Stop is pressed
    // rather than after a bounded network shutdown, and a hanging handshake
    // settles instead of blocking the disposal we are about to await.
    while (this.cancelCallbacks.length > 0) {
      const cb = this.cancelCallbacks.shift()!;
      try { cb(); } catch { /* contained */ }
    }
    // Restartable: if a previous pass already finished but a disposal has since
    // begun (post-cancel adoption), start a fresh pass covering it.
    if (this.quiescing === null) {
      this.quiescing = this.disposeUntilQuiet().then(() => { this.quiescing = null; });
    }
    return this.quiescing;
  }

  /** Start one resource's disposal, tracked so quiescence awaits it. */
  private beginDisposal(entry: Adopted): void {
    if (entry.disposed) return;
    entry.disposed = true;
    const p = this.safeDispose(entry.resource as never, entry.dispose);
    this.runningDisposals.add(p);
    void p.then(() => this.runningDisposals.delete(p));
  }

  /**
   * Dispose everything adopted, LIFO, and do not resolve until NOTHING is
   * outstanding — neither an undisposed entry nor a running disposal. A step
   * racing the teardown can adopt more resources mid-drain; the loop picks
   * them up rather than resolving early and leaking them.
   */
  private async disposeUntilQuiet(): Promise<void> {
    for (;;) {
      for (let i = this.adopted.length - 1; i >= 0; i--) {
        const entry = this.adopted[i]!;
        if (entry.disposed) continue;
        entry.disposed = true;
        await this.safeDispose(entry.resource as never, entry.dispose);
      }
      if (this.runningDisposals.size > 0) {
        await Promise.all([...this.runningDisposals]);
        continue;
      }
      if (this.adopted.some((e) => !e.disposed)) continue;
      this.session = null;
      return;
    }
  }

  private async safeDispose<T>(resource: T, dispose: (r: T) => void | Promise<void>): Promise<void> {
    try {
      await dispose(resource);
    } catch { /* contained: one bad disposer must not strand the rest */ }
  }
}
