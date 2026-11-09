import { MAX_VARINT, MAX_VI64, isDraft22, type ControlMessage, type DataStreamHeader, type FetchOk, type TrackPropertyValue } from '@openmoq/transport';
import type { FetchReceiveContext, FetchReceiver, MoqtConnection } from '@openmoq/webtransport';

export interface SeekFetchResponse {
  readonly endOfTrack: boolean;
  readonly endLocation: FetchOk['endLocation'];
  /** Defaults carried by this FETCH's own response, never borrowed from a live subscription. */
  readonly trackProperties?: ReadonlyMap<bigint, readonly TrackPropertyValue[]>;
}
/** SDK emission-attempt completion, not delivery, acceptance, or native output. */
export interface SeekFetchIssuance {
  readonly issued: Promise<bigint>;
  readonly cancel: () => void;
}
interface Issuance {
  readonly promise: Promise<bigint>;
  readonly settled: boolean;
  readonly resolve: (id: bigint) => void;
  readonly reject: (error: Error) => void;
}
const aborted = () => Object.assign(new Error('Seek FETCH issuance retired'), { name: 'AbortError' });
interface Owner {
  readonly receiver: FetchReceiver;
  readonly issuance: Issuance | null;
  readonly onResponse: ((response: SeekFetchResponse) => void) | undefined;
  requestId: bigint | null;
  streamId: bigint | null;
  response: boolean;
  terminal: boolean;
  cancelled: boolean;
  cancelSent: boolean;
  reported: boolean;
  failureReserved: boolean;
  cleanupQueued: boolean;
}
type ReceiverOptions = Required<Pick<Parameters<MoqtConnection['fetch']>[2], 'onRequestId' | 'receiver'>>;
interface Options {
  readonly isCurrent: () => boolean;
  readonly onError: (error: Error, receiver: FetchReceiver) => void;
  /** Before bytes are sent; throwing leaves rollback to the SDK. */
  readonly onRegister?: (receiver: FetchReceiver) => void;
}

/** One seek attempt's ordered historical requests; live continuation belongs to the engine. */
export class SeekFetchRequests {
  private readonly owners = new Set<Owner>();
  private readonly requests = new Map<bigint, Owner>();
  private readonly streams = new Map<bigint, Owner>();
  private disposed = false;

  constructor(private readonly connection: Pick<MoqtConnection, 'fetch' | 'fetchCancel' | 'joiningFetch' | 'draftVersion'>, private readonly options: Options) {}

  open(
    track: { readonly namespace: readonly string[]; readonly name: string },
    start: { readonly groupId: bigint; readonly objectId: bigint },
    receiver: FetchReceiver,
    onResponse?: (response: SeekFetchResponse) => void,
    end?: { readonly groupId: bigint; readonly objectId?: bigint },
  ): () => void {
    return this.openRequest(null, track, start, receiver, onResponse, end);
  }

  openIssued(...args: Parameters<SeekFetchRequests['open']>): SeekFetchIssuance {
    const issuance = this.newIssuance();
    return { cancel: this.openRequest(issuance, ...args), issued: issuance.promise };
  }

  private openRequest(
    issuance: Issuance | null,
    track: { readonly namespace: readonly string[]; readonly name: string },
    start: { readonly groupId: bigint; readonly objectId: bigint },
    receiver: FetchReceiver,
    onResponse?: (response: SeekFetchResponse) => void,
    end?: { readonly groupId: bigint; readonly objectId?: bigint },
  ): () => void {
    return this.issue(receiver, onResponse, ownership => {
      const encoder = new TextEncoder();
      // An omitted SDK endGroup means zero. Without an explicit endpoint,
      // request the current published snapshot using the selected wire width.
      return this.connection.fetch(track.namespace.map(field => encoder.encode(field)), encoder.encode(track.name), {
        startGroup: start.groupId, startObject: start.objectId, groupOrder: 'ascending',
        endGroup: end?.groupId ?? (this.connection.draftVersion >= 18 ? MAX_VI64 : MAX_VARINT), endObject: end?.objectId ?? 0n,
        ...ownership,
      });
    }, issuance);
  }

  /** Join the saved boundary of our own fresh subscription; draft22 refuses this in the SDK. */
  join(joiningRequestId: bigint, startGroup: bigint, receiver: FetchReceiver,
      onResponse?: (response: SeekFetchResponse) => void): () => void {
    return this.joinRequest(null, joiningRequestId, startGroup, receiver, onResponse);
  }

  joinIssued(...args: Parameters<SeekFetchRequests['join']>): SeekFetchIssuance {
    const issuance = this.newIssuance();
    return { cancel: this.joinRequest(issuance, ...args), issued: issuance.promise };
  }

  private joinRequest(issuance: Issuance | null, joiningRequestId: bigint, startGroup: bigint, receiver: FetchReceiver,
      onResponse?: (response: SeekFetchResponse) => void): () => void {
    return this.issue(receiver, onResponse, ownership => {
      if (isDraft22(this.connection.draftVersion)) throw new Error('Joining FETCH is not available in draft-22; use FILL');
      return this.connection.joiningFetch({
        joiningFetchType: 'absolute', joiningRequestId, joiningStart: startGroup, groupOrder: 'ascending', ...ownership,
      });
    }, issuance);
  }

  private newIssuance(): Issuance {
    let resolve!: (id: bigint) => void, reject!: (error: Error) => void, settled = false;
    const promise = new Promise<bigint>((yes, no) => { resolve = yes; reject = no; });
    // Legacy/background callers may intentionally ignore this additive surface.
    void promise.catch(() => {});
    return { promise, get settled() { return settled; },
      resolve: id => { if (!settled) { settled = true; resolve(id); } },
      reject: error => { if (!settled) { settled = true; reject(error); } },
    };
  }

  private issue(receiver: FetchReceiver, onResponse: ((response: SeekFetchResponse) => void) | undefined,
      send: (ownership: ReceiverOptions) => Promise<bigint>, issuance: Issuance | null): () => void {
    const owner: Owner = { receiver, issuance, onResponse, requestId: null, streamId: null, response: false, terminal: false,
      cancelled: false, cancelSent: false, reported: false, failureReserved: false, cleanupQueued: false };
    if (!this.current(owner)) { issuance?.reject(aborted()); return () => {}; }
    this.owners.add(owner);
    const cancel = () => this.cancel(owner);
    let registrationRejected = false;
    try {
      const pending = send({
        onRequestId: id => {
          const register = this.options.onRegister;
          if (register) {
            if (!this.current(owner)) throw aborted();
            try { register(receiver); }
            catch (error) { registrationRejected = true; throw error; }
            if (!this.current(owner)) throw aborted();
          }
          owner.requestId = id;
          this.requests.set(id, owner);
          if (!this.current(owner)) { this.cancel(owner); return; }
        },
        receiver: {
          onObject: async (object, context) => {
            this.noteStream(owner, context);
            if (!this.current(owner) || context.signal.aborted) { this.cancel(owner); return; }
            try { await receiver.onObject(object, context); }
            catch (error) {
              if (!context.signal.aborted) this.fail(owner, error);
              throw error; // The SDK owns the rejection and cancels only this FETCH.
            }
            if (!this.current(owner) || context.signal.aborted) this.cancel(owner);
          },
          onClosed: (terminal, context) => {
            // SDK rollback may close the receiver before its rejected FETCH
            // promise delivers the actual local registration refusal.
            if (registrationRejected) return;
            this.noteStream(owner, context);
            if (owner.terminal) return;
            owner.terminal = true;
            // REQUEST_ERROR calls this immediately before onMessage. Keep its
            // current control-turn owner so that callback reentry cannot leak it.
            if (terminal !== 'fin') queueMicrotask(() => {
              if (!owner.cancelled) this.fail(owner, new Error(`Historical FETCH ended with ${terminal}`));
            });
            if (this.current(owner)) {
              try {
                void Promise.resolve(receiver.onClosed?.(terminal, context)).catch(error => this.fail(owner, error));
              } catch (error) { this.fail(owner, error); }
            }
            this.maybeFinish(owner);
          },
        },
      });
      void pending.then(id => {
        if (owner.requestId === null) {
          // Never claim a response from the outer promise: ownership is pre-send.
          owner.requestId = id;
          this.fail(owner, new Error('FETCH returned without onRequestId ownership'));
          return;
        }
        if (issuance && id !== owner.requestId) { this.fail(owner, new Error('FETCH returned a different request ID')); return; }
        if (!this.current(owner)) this.cancel(owner);
        else issuance?.resolve(id);
        this.maybeFinish(owner);
      }, error => this.fail(owner, error));
    } catch (error) { this.fail(owner, error); }
    return cancel;
  }

  handleControl(message: ControlMessage): boolean {
    if (message.type !== 'FETCH_OK' && message.type !== 'REQUEST_ERROR') return false;
    const owner = this.requests.get(message.requestId);
    if (!owner) return false;
    if (!owner.response) {
      owner.response = true;
      if (message.type === 'REQUEST_ERROR') {
        this.fail(owner, new Error(`Historical FETCH ${message.errorCode}: ${message.errorReason}`));
      } else if (this.current(owner)) {
        try {
          const properties = message.trackProperties ?? message.trackExtensions;
          const trackProperties = properties?.size ? new Map([...properties].map(([type, values]) =>
            [type, values.map(value => typeof value === 'bigint' ? value : value.slice())])) : undefined;
          owner.onResponse?.({ endOfTrack: message.endOfTrack === 1, endLocation: { ...message.endLocation },
            ...(trackProperties ? { trackProperties } : {}) });
        }
        catch (error) { this.fail(owner, error); }
      } else this.cancel(owner);
    }
    this.maybeFinish(owner);
    return true;
  }

  handleStreamOpen(streamId: bigint, header: DataStreamHeader): boolean {
    if (header.type !== 'fetch' || header.fill) return false;
    const owner = this.requests.get(header.header.requestId);
    if (!owner) return false;
    owner.streamId = streamId;
    this.streams.set(streamId, owner);
    return true;
  }

  handleStreamClose(streamId: bigint): boolean {
    const owner = this.streams.get(streamId);
    if (!owner) return false;
    this.streams.delete(streamId);
    if (owner.streamId === streamId) owner.streamId = null;
    this.maybeFinish(owner);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const owner of this.owners) this.cancel(owner);
  }

  private current(owner: Owner): boolean {
    return !this.disposed && !owner.cancelled && this.options.isCurrent() && !this.disposed && !owner.cancelled;
  }

  private noteStream(owner: Owner, context: FetchReceiveContext): void {
    if (context.streamId !== null) {
      owner.streamId = context.streamId;
      this.streams.set(context.streamId, owner);
    }
  }

  private fail(owner: Owner, cause: unknown): void {
    if (owner.reported) return;
    if (!this.current(owner)) { this.cancel(owner); return; }
    // Unknown-value conversion may invoke user code. The observed failure
    // owns the outcome before disposal/cancellation can reenter that conversion.
    owner.reported = true; owner.failureReserved = true;
    let error: Error;
    try { error = cause instanceof Error ? cause : new Error(String(cause), { cause }); }
    catch { error = new Error('Seek FETCH failed', { cause }); }
    owner.issuance?.reject(error);
    owner.failureReserved = false;
    this.cancel(owner);
    try { this.options.onError(error, owner.receiver); }
    catch { /* observer exceptions cannot strand request cleanup */ }
  }

  private sendCancellation(owner: Owner): void {
    if (owner.requestId === null || owner.cancelSent) return;
    owner.cancelSent = true;
    if (this.requests.get(owner.requestId) !== owner) return;
    try { void this.connection.fetchCancel(owner.requestId).catch(() => {}); }
    catch { /* already terminated; no pending consumer is left waiting here */ }
  }

  private cancel(owner: Owner): void {
    if (!owner.failureReserved) owner.issuance?.reject(aborted());
    owner.cancelled = true;
    this.owners.delete(owner);
    this.sendCancellation(owner);
    if (owner.cleanupQueued) return;
    owner.cleanupQueued = true;
    queueMicrotask(() => {
      owner.cleanupQueued = false;
      this.releaseRequest(owner);
      // An announced stream remains owned until the global close callback,
      // including when receiver/onResponse synchronously disposes its actor.
    });
  }

  private maybeFinish(owner: Owner): void {
    if (!owner.cancelled && owner.response && owner.terminal && owner.streamId === null) {
      // Routing can retire while the original SDK emission attempt is pending.
      if (!owner.issuance || owner.issuance.settled) this.owners.delete(owner);
      this.releaseRequest(owner);
    }
  }

  private releaseRequest(owner: Owner): void {
    if (owner.requestId !== null && this.requests.get(owner.requestId) === owner) this.requests.delete(owner.requestId);
  }
}
