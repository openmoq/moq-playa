import type { MoqtObject } from '@openmoq/transport';
import type { DataStreamTerminal } from './adapter.js';

/** Local ownership of one FETCH; this context is never sent on the wire. */
export interface FetchReceiveContext {
  readonly requestId: bigint;
  /** Always present for onObject; null only when no data stream was opened. */
  readonly streamId: bigint | null;
  /** Aborted on cancellation or failure, but not on successful FIN. */
  readonly signal: AbortSignal;
}

/**
 * An opt-in consumer of one FETCH's Objects (including gap markers).
 * Callbacks can run before fetch() resolves or FETCH_OK arrives. Objects claimed
 * here are not also delivered to the connection's generic onObject callback.
 */
export interface FetchReceiver {
  /** Settlement admits the next Object on this FETCH's single data stream. */
  onObject(object: MoqtObject, context: FetchReceiveContext): void | Promise<void>;
  /** Exactly once; observer completion never delays teardown. */
  onClosed?(terminal: DataStreamTerminal, context: FetchReceiveContext): void;
}

type ReceiveResult = { kind: 'accepted' | 'stopped' }
  | { kind: 'failed' | 'read-error'; error: unknown };

/** One live request, with no Object queue or receipt history. */
export class FetchReceiverState {
  readonly controller = new AbortController();
  context: FetchReceiveContext;
  closed = false;
  requestStarted = false;
  private interruption?: ReceiveResult;
  private wake: ((result: ReceiveResult) => void) | undefined;

  private interrupt(result: ReceiveResult): void {
    this.interruption ??= result;
    const wake = this.wake;
    this.wake = undefined;
    wake?.(this.interruption);
  }

  constructor(readonly requestId: bigint, private readonly receiver: FetchReceiver) {
    this.context = Object.freeze({ requestId, streamId: null, signal: this.controller.signal });
  }

  bind(streamId: bigint, reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.context = Object.freeze({ requestId: this.requestId, streamId, signal: this.controller.signal });
    // A reset must wake a consumer even while no read() is outstanding. A clean
    // reader close must NOT bypass the settlement of already accepted work.
    void reader.closed.catch(error => { this.interrupt({ kind: 'read-error', error }); });
  }

  async receive(object: MoqtObject): Promise<ReceiveResult> {
    if (this.closed) return { kind: 'stopped' };
    if (this.interruption) return this.interruption;
    // Each wait owns a removable wakeup. Reusing one never-settled stop Promise
    // for every Object would retain a reaction per Object until stream teardown.
    let wake!: (result: ReceiveResult) => void;
    const stopped = new Promise<ReceiveResult>(resolve => { this.wake = wake = resolve; });
    try {
      let work: void | Promise<void>;
      try { work = this.receiver.onObject(object, this.context); }
      catch (error) { return { kind: 'failed', error }; }
      // Attach both handlers even if onObject cancelled synchronously, so its
      // late rejection remains owned after the stop race has already settled.
      const settled = Promise.resolve(work).then<ReceiveResult, ReceiveResult>(
        () => ({ kind: 'accepted' }), error => ({ kind: 'failed', error }),
      );
      return await Promise.race([stopped, settled]);
    } finally {
      if (this.wake === wake) this.wake = undefined;
    }
  }

  finish(terminal: DataStreamTerminal): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt({ kind: 'stopped' });
    if (terminal !== 'fin') this.controller.abort();
    try {
      // Runtime observers may return a thenable despite the void API. Observe
      // rejection without making a terminal notification a teardown barrier.
      void Promise.resolve(this.receiver.onClosed?.(terminal, this.context)).catch(() => {});
    } catch { /* observers cannot interrupt request teardown */ }
  }
}
