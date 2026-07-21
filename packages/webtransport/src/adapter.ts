/**
 * MoqtConnection — bridges WebTransport to the sans-I/O Session state machine.
 *
 * Manages the control stream lifecycle, framing, setup handshake,
 * control message routing, data stream processing, and datagram decoding.
 *
 * @see draft-ietf-moq-transport-16 §3, §10
 * @module
 */

import {
  Session,
  SessionState,
  EndpointRole,
  varint,
  createControlCodec,
  SessionError,
  getSubgroupIdMode,
  SubgroupIdMode,
  SubgroupFlags,
  SubgroupFlags18,
  ObjectStatus,
  ProtocolViolationError,
  encodeSubgroupHeader,
  encodeSubgroupObject,
  encodeSubgroupHeader18,
  encodeSubgroupObject18,
  encodeObjectDatagram18,
  encodeFetchHeader18,
  encodeFetchObject18,
  encodeFetchEndOfRange18,
  createDataCodec,
  hasObjectOnlyTrackProperty,
  hasUnsupportedMandatoryTrackProperty,
  RequestError18,
  SubscriptionState,
  ForwardState,
} from '@moqt/transport';
import type {
  EndpointRoleValue,
  ControlMessage,
  DecodedControlMessage,
  ControlCodec,
  DataCodec,
  StreamClass,
  DraftVersion,
  SendControlAction,
  OpenNamespaceStreamAction,
  CloseConnectionAction,
  SessionOutboundAction,
  Varint,
  DataStreamHeader,
  SubgroupHeader,
  FetchHeader,
  ObjectDatagram,
  FetchPriorContext,
  FetchObjectPrior18,
  GroupOrder,
  FetchObjectFields,
  QlogEvent,
  MoqtObject,
  MoqtObjectData,
  MoqtObjectGap,
  Subscribe,
  Publish,
  Fetch,
  JoiningFetch,
  TrackStatus,
  PublishNamespace,
  SubscribeNamespace,
  SubscribeTracks,
  Goaway,
  Parameters,
  TrackProperties,
  SubscriptionStateMachine,
} from '@moqt/transport';
import type { SetupOptions, SubscribeOptions, RequestUpdateOptions, FetchOptions, JoiningFetchOptions, FetchAcceptOptions, TrackStatusAcceptOptions } from '@moqt/transport';
import { ControlStreamFramer } from './framer.js';
import { createBidiControlTopology } from './topology/bidi-control.js';
import { createUniPairTopology, RequestCancelledError, RequestGoawayError, type UniPairTopology, type RequestStream } from './topology/uni-pair.js';
import { InboundRequestStreamContext } from './topology/inbound-request.js';
import { MoqtConnectionError } from './adapter-error.js';
import type { WebTransportLike, WebTransportBidirectionalStream } from './types.js';



// ─── Track Subscription Types ─────────────────────────────────────────

/** Options for connection.subscribeTrack(). */
export interface TrackSubscribeOptions {
  /** Subscription filter (LargestObject, NextGroupStart, AbsoluteStart, etc.). */
  readonly filter?: SubscribeOptions['subscriptionFilter'];
  /**
   * DELIVERY_TIMEOUT (§9.2.2.2), in the encoded unit expected by SUBSCRIBE — the
   * window during which the publisher may still deliver Objects. The terminal-alias
   * guard is floored by this so it cannot expire while late old-alias streams are
   * still legitimately in flight (§10.11).
   */
  readonly deliveryTimeout?: SubscribeOptions['deliveryTimeout'];
  /** Called for each object delivered on this subscription (stream-based only; datagrams excluded). */
  onObject?: (obj: MoqtObject) => void;
}

/**
 * A track subscription with resolved alias and per-subscription object delivery.
 *
 * Returned by `connection.subscribeTrack()` after SUBSCRIBE_OK resolves.
 * The `onObject` callback is mutable — the connection reads it live on each delivery.
 */
export interface TrackSubscription {
  /** Request ID for this subscription. */
  readonly requestId: bigint;
  /** Track alias assigned by the publisher (resolved from SUBSCRIBE_OK). */
  readonly trackAlias: bigint;
  /** Called for each object — mutable, read live on each delivery. */
  onObject: ((obj: MoqtObject) => void) | null;
  /** Unsubscribe and clean up. */
  unsubscribe(): Promise<void>;
}

/** Internal state for a pending/active track subscription. */
interface RawSubState {
  readonly requestId: bigint;
  trackAlias: bigint | null;
  readonly sub: TrackSubscription;
  resolve: ((sub: TrackSubscription) => void) | null;
  reject: ((err: Error) => void) | null;
}

/**
 * A PUBLISH received from a peer publisher on a new inbound bidi stream
 * (draft-18 §10.10). Set `onObject` to receive the track's objects (delivered
 * via the bound Track Alias), then accept/reject via the connection.
 */
export interface IncomingPublish {
  readonly requestId: bigint;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly trackAlias: bigint;
  /** Called for each object on the published track — mutable, read live. */
  onObject: ((obj: MoqtObject) => void) | null;
}

/**
 * MoQT connection over WebTransport I/O to the MOQT Session state machine.
 *
 * Handles control stream, incoming data streams (§10.4), and datagrams (§10.3).
 *
 * Usage:
 * ```
 * const connection = new MoqtConnection();
 * connection.onObject = (streamId, obj) => { ... };
 * await connection.connect(transport, { path: '/moq' });
 * ```
 */
/**
 * Map a negotiated WT-Available-Protocols string to a supported DraftVersion.
 *
 * Returns undefined for an absent protocol OR a `moqt-N` token we do not support
 * (e.g. 'moqt-17'), so the caller falls back to the current configuration rather
 * than trying to construct a codec for an unwired draft.
 *
 * @see draft-ietf-moq-transport-16 §3.1
 * - 'moqt-18' → 18, 'moqt-16' → 16
 * - 'moq-00' → 14 (pre-15 convention)
 * - '' / undefined / unsupported token → undefined (use constructor version)
 */
function protocolToDraftVersion(protocol: string | undefined): DraftVersion | undefined {
  if (!protocol) return undefined;
  if (protocol === 'moq-00') return 14;
  const match = protocol.match(/^moqt-(\d+)$/);
  if (!match) return undefined;
  const n = parseInt(match[1]!, 10);
  return n === 14 || n === 16 || n === 18 ? (n as DraftVersion) : undefined;
}

export class MoqtConnection {
  /** The underlying sans-I/O session state machine. Set by {@link configureForVersion}. */
  session!: Session;

  /** Draft version this connection was created with. */
  get draftVersion(): DraftVersion {
    return this.session.draftVersion;
  }

  /** Wire format codec for the active negotiated draft version. Set by {@link configureForVersion}. */
  private codec!: ControlCodec;

  /** Data-plane decoder for the active negotiated draft version (14/16/18). Set by {@link configureForVersion}. */
  private dataCodec!: DataCodec | null;

  /** draft-18 control/request stream topology. Null for draft-14/16. */
  private uniPair: UniPairTopology | null = null;

  private framer!: ControlStreamFramer;
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private transport: WebTransportLike | null = null;
  private nextStreamId = 0n;

  /**
   * Map from requestId → namespace bidi stream writer, for future cancellation.
   * @see draft-ietf-moq-transport-16 §6.1
   */
  private namespaceStreams = new Map<bigint, WritableStreamDefaultWriter<Uint8Array>>();

  /**
   * Map from streamId → readable stream reader, for STOP_SENDING.
   *
   * §10.4.3: "A subscriber MAY send a QUIC STOP_SENDING frame for a
   * subgroup stream if the Group or Subgroup is no longer of interest."
   *
   * In WebTransport, calling reader.cancel() sends STOP_SENDING.
   * @see draft-ietf-moq-transport-16 §10.4.3
   */
  private dataStreamReaders = new Map<bigint, ReadableStreamDefaultReader<Uint8Array>>();

  /**
   * Map from fetch requestId → data stream ID, for STOP_SENDING on cancel.
   *
   * §5.2: "If the data stream is already open, it MAY send STOP_SENDING
   * for the data stream along with FETCH_CANCEL, but MUST send FETCH_CANCEL."
   *
   * Set when a FETCH_HEADER is decoded in processDataStream().
   * @see draft-ietf-moq-transport-16 §5.2, §10.4.4
   */
  private fetchStreams = new Map<bigint, bigint>();
  /**
   * Fetch request IDs we (the fetcher) recently CANCELLED — a marker so a data stream
   * the peer already had in flight when our cancellation crossed it is DISCARDED
   * (STOP_SENDING), whether it is a NEW stream (FETCH_HEADER handler) or ALREADY OPEN
   * (readFetchObjects18 stops delivering mid-stream). Installed SYNCHRONOUSLY at
   * cancel (before any await) and CONSUMED one-shot when its stream is handled.
   *
   * LOSSLESS — no cap, no eviction: a late data stream may be arbitrarily delayed, so
   * this is the SOLE provenance distinguishing "a stream for a fetch WE cancelled"
   * (→ discard) from "a stream for a request that is not a live FETCH" (→ §9.1/§10.12.3
   * PROTOCOL_VIOLATION: unknown request, wrong request kind, or a second response
   * stream for a completed fetch). A capped marker would evict a valid cancellation
   * and either false-close a still-crossing late stream or forgive a genuine
   * violation. The only cost is memory for a cancellation whose late stream never
   * arrives — the same lossless trade-off the Session makes for crossed-terminal
   * shadows; the entry is otherwise reclaimed the instant its one late stream lands.
   */
  private recentlyCancelledFetches = new Set<bigint>();

  /**
   * Requested Group Order per FETCH request ID (draft-18). The fetch-object
   * decoder needs it to interpret Group ID Deltas; Ascending is the default.
   */
  private fetchGroupOrder = new Map<bigint, GroupOrder>();

  /** Track subscriptions by requestId (pending alias resolution). */
  private rawSubscriptions = new Map<bigint, RawSubState>();
  /** Track subscriptions by trackAlias (active, alias resolved). */
  private rawAliasMaps = new Map<bigint, RawSubState>();

  /** Inbound PUBLISH (draft-18 §10.10) stream contexts, keyed by Request ID. */
  private inboundRequestContexts = new Map<bigint, InboundRequestStreamContext>();
  /** Inbound PUBLISH tracks by Track Alias, for routing data objects. */
  private publishAliasMaps = new Map<bigint, IncomingPublish>();

  /** Requested Group Order per inbound FETCH Request ID (default ascending). */
  private inboundFetchGroupOrder = new Map<bigint, GroupOrder>();

  /**
   * draft-18 §10.12.2: Joining Fetches referencing a PENDING subscription are
   * buffered "until either the Subscription is established or the request
   * times out." Keyed by the joined subscription's request ID; released on
   * acceptSubscribe, rejected (INVALID_JOINING_REQUEST_ID) on rejectSubscribe,
   * and rejected (TIMEOUT) after joiningFetchTimeoutMs. Standalone FETCH is
   * never buffered.
   */
  private readonly pendingJoinFetches = new Map<bigint, Array<{
    requestId: bigint;
    fetch: Fetch;
    timer: ReturnType<typeof setTimeout>;
  }>>();
  private readonly joiningFetchTimeoutMs: number;

  /**
   * §10.8 response ordering: REQUEST_OKs for updates that raced a pending
   * SUBSCRIBE, deferred until the SUBSCRIBE's own first response is written.
   * Keyed by the subscription's request ID; flushed FIFO on accept/reject.
   */
  private readonly deferredUpdateResponses = new Map<bigint, ControlMessage[]>();
  /** Bound for deferred update acks per pending subscription (§10.8 flood guard). */
  private static readonly MAX_DEFERRED_UPDATE_RESPONSES = 4;
  /** Outgoing FETCH response data streams, keyed by synthetic stream ID. */
  private fetchOutgoingStreams = new Map<bigint, {
    requestId: bigint;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    groupOrder: GroupOrder;
    prior: FetchObjectPrior18 | undefined;
    isFirstObject: boolean;
  }>();

  /**
   * Called for each application-relevant control message received after setup.
   * This is the APPLICATION channel, not raw wire observability: responses the
   * connection consumes internally are not surfaced — a SUBSCRIBE_OK that resolves
   * a subscribeTrack() (delivered via that promise instead), and a response
   * (SUBSCRIBE_OK / REQUEST_ERROR) crossing a §5.1 cancellation the session ignores.
   * For the raw, unfiltered message stream use the qlog channel (onQlogEvent),
   * which observes every parsed control message including the ones suppressed here.
   */
  onMessage?: (msg: ControlMessage) => void;

  /** Called when the control stream or connection closes. */
  onClose?: (error?: number, reason?: string) => void;

  /** Called when the session encounters a protocol error. */
  onError?: (error: Error) => void;

  /**
   * Request-stream failures surface through TWO paths — the response consumer
   * ({@link consumeRequestStream}) and the topology's `onStreamError` hook — both
   * carrying the SAME Error instance (uni-pair rejects `response` and `closed`
   * with one `failure`). De-dupe by identity so a single stream failure fires
   * `onError` exactly once. A no-waiter failure reaches only the `onStreamError`
   * path and is still reported once.
   */
  private readonly reportedStreamErrors = new WeakSet<Error>();

  /**
   * True once the single terminal shutdown has run (fatal error, session close,
   * or transport close). Guards {@link terminate} so shutdown is exactly-once.
   */
  private _terminated = false;
  /** The close report to emit; upgraded from preliminary→authoritative before it fires. */
  private _terminalReport: { code: number; reason: string; authoritative: boolean } | null = null;
  /** True once onClose has actually fired (emission is deferred one microtask). */
  private _closeEmitted = false;
  /** Fallback timer that emits a preliminary (synthetic) report if no authoritative transport.closed arrives. */
  private _closeReportTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long a preliminary read-failure report waits for transport.closed to own it (constructor option). */
  private readonly closeReportFallbackMs: number;

  /**
   * THE terminal coordinator. Every terminal path — a session-generated
   * close_connection ({@link notifyClose}), an adapter-detected fatal violation
   * (control / request-stream / data-stream / datagram, via
   * {@link closeSessionFatal}), and the WebTransport `closed` promise settling —
   * funnels through here. It runs the shutdown EXACTLY ONCE: close the session
   * if still open, reject every pending public operation, clear all timers and
   * routing state, then fire onClose a single time. Concurrent causes (e.g. the
   * control-loop error and `transport.closed` settling together) collapse to one
   * terminal event.
   *
   * The session ALWAYS ends CLOSED, so no operation can allocate state against a
   * dead transport afterward. `closeSession` chooses HOW: when this endpoint is
   * declaring a violation (the transport is still alive) it closes the session,
   * emitting a CONNECTION_CLOSE capsule; otherwise (a remote/failed transport
   * close) it transitions the session to CLOSED state-only, with no capsule.
   *
   * Shutdown is SEPARATE from reporting. The terminal side effects (state,
   * pending rejection, cleanup) run once, synchronously, on the FIRST cause. The
   * onClose EMISSION is chosen by the cause's authority:
   *   - `authoritative` (transport.closed — the peer's real code/reason): emit
   *     promptly and let it override a not-yet-emitted preliminary report;
   *   - `preliminary` (a raw stream/control READ FAILURE with only a SYNTHETIC
   *     code): DON'T emit yet — start a bounded fallback timer so an authoritative
   *     transport.closed settling in a LATER task still owns the report; the timer
   *     emits the synthetic report only if none arrives;
   *   - otherwise (a DECLARED protocol close with a meaningful code): emit on the
   *     next microtask (prompt), still upgradable by a same-tick authoritative.
   * onClose fires exactly once regardless.
   */
  private terminate(
    code: number,
    reason: string,
    opts: { closeSession?: boolean; authoritative?: boolean; preliminary?: boolean } = {},
  ): void {
    if (this._terminated) {
      // A later AUTHORITATIVE cause overrides a preliminary report not yet emitted.
      if (!this._closeEmitted && opts.authoritative && this._terminalReport && !this._terminalReport.authoritative) {
        this._terminalReport = { code, reason, authoritative: true };
        if (this._closeReportTimer !== undefined) { clearTimeout(this._closeReportTimer); this._closeReportTimer = undefined; }
        this.emitClose(); // authoritative info arrived — report it now
      }
      return;
    }
    this._terminated = true;
    if (this.session.state !== SessionState.CLOSED) {
      if (opts.closeSession) {
        void this.executeActions(this.session.close(SessionError.PROTOCOL_VIOLATION, reason));
      } else {
        // Remote/failed transport close — move to CLOSED without sending a
        // capsule on a transport that is already gone. New requests then reject.
        this.session.handleTransportClosed();
      }
    }
    // Reject any pending subscribeTrack()/request promise so no caller hangs.
    this.failPendingRawSubscriptions(reason);
    // Clear every bounded timer + routing map exactly once.
    this.clearTerminalState();
    this._terminalReport = { code, reason, authoritative: opts.authoritative ?? false };
    if (opts.authoritative) {
      this.emitClose(); // the peer's real reason — report immediately
    } else if (opts.preliminary) {
      // Synthetic code from a read failure — give transport.closed a bounded
      // window to provide the real code/reason before falling back to this.
      const timer = setTimeout(() => { this._closeReportTimer = undefined; this.emitClose(); }, this.closeReportFallbackMs);
      (timer as { unref?: () => void }).unref?.();
      this._closeReportTimer = timer;
    } else {
      // A declared protocol close — emit promptly (one microtask, so a same-tick
      // authoritative transport.closed can still upgrade the code/reason first).
      queueMicrotask(() => this.emitClose());
    }
  }

  /** Fire onClose exactly once with the final (possibly upgraded) close report. */
  private emitClose(): void {
    if (this._closeEmitted || !this._terminalReport) return;
    this._closeEmitted = true;
    if (this._closeReportTimer !== undefined) { clearTimeout(this._closeReportTimer); this._closeReportTimer = undefined; }
    this.onClose?.(this._terminalReport.code, this._terminalReport.reason);
  }

  /**
   * Cancel every outstanding timer and drop / abort ALL owned state exactly
   * once: parked-join timers, alias tombstones, publisher accounting, deferred
   * update responses, inbound-request contexts, publish/fetch routing, data
   * readers and writers, and the topology's request-stream contexts. Nothing
   * owned by the connection outlives the terminal shutdown.
   */
  private clearTerminalState(): void {
    // Parked joining-fetch timers.
    for (const parked of this.pendingJoinFetches.values()) {
      for (const e of parked) clearTimeout(e.timer);
    }
    this.pendingJoinFetches.clear();
    // Receiver terminal tracker (tombstone TTL timers) + seen counts.
    for (const alias of [...this.terminatedAliases.keys()]) this.clearTerminatedAlias(alias);
    this.aliasStreamsSeen.clear();
    this.aliasDeliveryTimeoutMs.clear();
    this.aliasPublisherTimeout.clear();
    this.inboundPublishTimeouts.clear();
    // Publisher-side accounting.
    this.publisherAliasRequests.clear();
    this.retiredPublisherAliases.clear();
    this.openSubgroupsByRequest.clear();
    this.pendingPublishOps.clear();
    this.publisherGeneration.clear();
    this.incomingSubgroupAliases.clear();
    this.deferredUpdateResponses.clear();
    // Inbound request-stream contexts — abort each, then drop. abort() may
    // reject ASYNCHRONOUSLY, so swallow the promise (a sync try/catch would not
    // observe it, leaving an unhandled rejection during terminal teardown).
    const reason = new Error('session terminated');
    for (const ctx of this.inboundRequestContexts.values()) this.swallow(() => ctx.abort());
    this.inboundRequestContexts.clear();
    // Inbound PUBLISH / FETCH routing + group-order state.
    this.publishAliasMaps.clear();
    this.fetchGroupOrder.clear();
    this.inboundFetchGroupOrder.clear();
    this.fetchServeReserved.clear();
    this.fetchStreams.clear();
    this.recentlyCancelledFetches.clear();
    // Incoming data-stream readers — cancel each, then drop.
    for (const r of this.dataStreamReaders.values()) this.swallow(() => r.cancel(reason));
    this.dataStreamReaders.clear();
    // Outgoing data-stream / fetch / namespace writers — abort each, then drop.
    for (const st of this.outgoingStreams.values()) this.swallow(() => st.writer.abort(reason));
    this.outgoingStreams.clear();
    for (const st of this.fetchOutgoingStreams.values()) this.swallow(() => st.writer.abort(reason));
    this.fetchOutgoingStreams.clear();
    for (const w of this.namespaceStreams.values()) this.swallow(() => w.abort(reason));
    this.namespaceStreams.clear();
    // Topology request-stream contexts (outbound + continuing).
    this.uniPair?.shutdown();
  }

  /**
   * Run a fire-and-forget teardown thunk, swallowing BOTH a synchronous throw
   * and an asynchronous rejection — the thunk is invoked INSIDE the try, so a
   * sync throw from cancel()/abort() cannot escape and abort the terminal
   * coordinator mid-cleanup.
   */
  private swallow(fn: () => Promise<unknown> | undefined): void {
    try { void Promise.resolve(fn()).catch(() => { /* teardown races are expected */ }); } catch { /* sync throw */ }
  }

  /**
   * A fatal violation this endpoint detected (control-stream, request-stream,
   * data-stream, or datagram). Closes the local session and runs the one-shot
   * terminal shutdown. Idempotent via {@link terminate}.
   */
  private closeSessionFatal(reason: string, code: number = 0x3): void {
    this.terminate(code, reason, { closeSession: true });
  }

  /**
   * Watch the WebTransport `closed` promise for a REMOTE session close (§webtrans).
   * On fulfillment the real close code/reason are preserved into onClose; on
   * rejection a fatal transport error is surfaced. Ignores a settle from a
   * stale/non-current transport (after migration), and collapses with any
   * concurrent fatal cause through the one-shot {@link terminate}.
   */
  private async watchTransportClosed(transport: WebTransportLike): Promise<void> {
    try {
      const info = await transport.closed;
      if (this.transport !== transport) return; // stale/migrated transport — ignore
      const code = typeof info?.closeCode === 'number' ? info.closeCode : 0;
      // Authoritative: the peer's real close code/reason override any preliminary
      // stream/control-failure report that fired first in the same tick.
      this.terminate(code, info?.reason ?? '', { authoritative: true });
    } catch (err) {
      if (this.transport !== transport) return;
      const message = err instanceof Error ? err.message : String(err);
      // Surface the transport failure (fatal) before the close notification.
      if (!this._terminated) {
        this.onError?.(new MoqtConnectionError(message, {
          errorSource: 'transport', isFatal: true, ...(err instanceof Error ? { cause: err } : {}),
        }));
      }
      // Authoritative too: a rejected transport.closed is the real transport
      // failure — it owns the report over any preliminary read-failure guess,
      // and is never silently suppressed even when it settles later.
      this.terminate(0x2, message, { authoritative: true });
    }
  }

  /** Fire `onError` for a request/stream failure at most once per Error instance. */
  private reportStreamError(error: Error): void {
    if (this.reportedStreamErrors.has(error)) return;
    this.reportedStreamErrors.add(error);
    this.onError?.(error);
    // A protocol violation on an OUTBOUND request stream (e.g. a message after
    // the terminal PUBLISH_DONE, §10.11) is session-fatal — via the SAME
    // centralized cleanup as every other fatal path, so unrelated pending
    // promises are rejected rather than left hanging.
    if (error instanceof ProtocolViolationError) {
      this.closeSessionFatal(error.message);
    }
  }

  /** Called when a data stream header is decoded (§10.4). */
  onDataStream?: (streamId: bigint, header: DataStreamHeader) => void;

  /** Called for each object decoded from a data stream (§10.4.2, §10.4.4). */
  onObject?: (streamId: bigint, object: MoqtObject) => void;

  /** Called when a data stream closes (FIN or error). */
  onStreamClosed?: (streamId: bigint, error?: number) => void;

  /** Called for each decoded datagram (§10.3). */
  onDatagram?: (datagram: ObjectDatagram) => void;

  /** Called for each message on a namespace discovery stream (§6.1). */
  onNamespaceMessage?: (requestId: bigint, msg: ControlMessage) => void;

  /** Called for each PUBLISH_BLOCKED on a SUBSCRIBE_TRACKS response stream (§10.20). */
  onPublishBlocked?: (requestId: bigint, msg: ControlMessage) => void;

  /**
   * Called when a SUBSCRIBE arrives from a remote subscriber.
   * The publisher should respond via acceptSubscribe() or rejectSubscribe().
   * @see draft-ietf-moq-transport-16 §9.5
   */
  onSubscribe?: (
    requestId: bigint,
    namespace: Uint8Array[],
    trackName: Uint8Array,
    parameters: Map<bigint, any>,
  ) => void;

  /**
   * Called (draft-18) when an accepted inbound SUBSCRIBE's request stream is closed
   * or reset by the subscriber — i.e. the subscriber unsubscribed (§3.3.2; draft-18
   * removed the UNSUBSCRIBE message, so cancellation IS a request-stream teardown).
   * This is a normal lifecycle end, NOT an error: the session's per-subscription
   * state is already cleaned and the connection stays open. A publisher (e.g. a relay)
   * uses it to drop just that subscription — without waiting for the whole connection
   * to close — which is what ABR quality-switching needs. Mirrors
   * {@link onSubscribeNamespaceClosed} / {@link onSubscribeTracksClosed}.
   */
  onSubscribeClosed?: (requestId: bigint) => void;

  /**
   * Called when a PUBLISH arrives on a new inbound bidi stream (draft-18 §10.10).
   * Set `publish.onObject` to receive the track's objects, then respond via
   * acceptSubscribe(publish.requestId, publish.trackAlias) / rejectSubscribe().
   */
  onPublish?: (publish: IncomingPublish) => void;

  /**
   * Called when a FETCH arrives on a new inbound bidi stream (draft-18 §10.12).
   * Inspect the Fetch and respond via acceptFetch(requestId, …) / rejectFetch().
   */
  onFetch?: (requestId: bigint, fetch: Fetch) => void;

  /**
   * Called when a TRACK_STATUS arrives on a new inbound bidi stream (draft-18
   * §10.14). One-shot: respond via acceptTrackStatus(requestId, params?) /
   * rejectTrackStatus(requestId, errorCode, reason); the stream then FINs.
   */
  onTrackStatus?: (requestId: bigint, msg: TrackStatus) => void;

  /**
   * Called when a PUBLISH_NAMESPACE arrives on a new inbound bidi stream
   * (draft-18 §10.15) after the session auto-acknowledges it (REQUEST_OK on the
   * same stream). The stream stays open; withdrawal arrives as a FIN/reset.
   */
  onPublishNamespace?: (requestId: bigint, msg: PublishNamespace) => void;

  /**
   * Called when an inbound PUBLISH_NAMESPACE stream is withdrawn by the peer
   * (FIN or reset, draft-18 §3.3.2) after local/session state is cleaned up.
   */
  onPublishNamespaceClosed?: (requestId: bigint) => void;

  /**
   * Called when a SUBSCRIBE_NAMESPACE arrives on a new inbound bidi stream
   * (draft-18 §10.18) after validation. We are the publisher — answer via
   * acceptSubscribeNamespace / rejectSubscribeNamespace, then announce matching
   * namespaces with sendNamespace / sendNamespaceDone on the same stream.
   */
  onSubscribeNamespace?: (requestId: bigint, msg: SubscribeNamespace) => void;

  /**
   * Called when an inbound SUBSCRIBE_NAMESPACE stream is cancelled by the peer
   * (FIN or reset, draft-18 §10.18) after publisher-side state is removed.
   */
  onSubscribeNamespaceClosed?: (requestId: bigint) => void;

  /**
   * Called when a SUBSCRIBE_TRACKS arrives on a new inbound bidi stream
   * (draft-18 §10.19) after validation. We are the publisher — answer via
   * acceptSubscribeTracks / rejectSubscribeTracks, then optionally report
   * unservable tracks with sendPublishBlocked on the same stream.
   */
  onSubscribeTracks?: (requestId: bigint, msg: SubscribeTracks) => void;

  /**
   * Called when an inbound SUBSCRIBE_TRACKS stream is cancelled by the peer
   * (FIN or reset, draft-18 §10.19) after publisher-side state is removed.
   */
  onSubscribeTracksClosed?: (requestId: bigint) => void;

  /**
   * Called for each qlog-spec event (opt-in tracing).
   *
   * When set, the connection emits structured qlog events at each
   * protocol observation point. When null/undefined, zero overhead —
   * no event objects are allocated.
   *
   * @see draft-pardue-moq-qlog-moq-events-04
   */
  onQlogEvent?: (event: QlogEvent) => void;

  /**
   * Synthetic stream ID for the control stream in qlog events.
   *
   * WebTransport does not expose QUIC stream IDs to JavaScript.
   * We use 0 for the control stream (matching QUIC client-initiated
   * bidi stream 0) and the nextStreamId counter for data streams.
   */
  private static readonly CONTROL_STREAM_QLOG_ID = 0n;

  /**
   * Open outgoing data streams for publishing.
   * @see draft-ietf-moq-transport-16 §10.4.2
   */
  private outgoingStreams = new Map<bigint, {
    writer: WritableStreamDefaultWriter<Uint8Array>;
    hasExtensions: boolean;
    previousObjectId: bigint;
    isFirstObject: boolean;
    /** The subscription this stream serves, when its alias is associated. */
    subscriptionRequestId?: bigint;
  }>();

  /** Counter for synthetic outgoing stream IDs. */
  private nextOutgoingStreamId = 0n;

  /**
   * Publisher-side Track Alias → subscription Request ID for ACTIVE
   * subscriptions we assigned via acceptSubscribe() / advertised via publish().
   * Associates the data-plane APIs (openSubgroup / sendDatagram) with their
   * subscription for §10.11 Stream Count accounting and terminal enforcement.
   * On termination the entry is RETIRED (moved to {@link retiredPublisherAliases}),
   * so this map tracks only live subscriptions.
   */
  private publisherAliasRequests = new Map<bigint, bigint>();

  /**
   * BOUNDED LRU of recently-RETIRED publisher alias → request ID. A send on a
   * just-terminated alias is still refused (terminal enforcement), but the set
   * is capped so cumulative subscription churn cannot grow unboundedly for the
   * session lifetime — the oldest retired alias is evicted past the cap.
   */
  private retiredPublisherAliases = new Map<bigint, bigint>();
  private static readonly MAX_RETIRED_PUBLISHER_ALIASES = 256;

  /**
   * OPEN outgoing subgroup stream IDs per subscription Request ID. §10.11:
   * PUBLISH_DONE is refused while any of these remain open (its Stream Count
   * must cover every stream, and the terminal message ends the data plane).
   */
  private openSubgroupsByRequest = new Map<bigint, Set<bigint>>();

  /**
   * Incoming subgroup data streams by Track Alias (streamId → alias). Lets the
   * PUBLISH_DONE receive path take the explicit early-discard route: it
   * STOP_SENDINGs every data stream still open for the terminated
   * subscription instead of merely dropping routing state (§10.11).
   */
  private incomingSubgroupAliases = new Map<bigint, bigint>();

  /**
   * In-flight publisher data-plane operations (subgroup opens / datagram
   * writes) per subscription Request ID. Reserved SYNCHRONOUSLY before the
   * first await of the operation and released when it settles, so
   * publishDone() can refuse atomically: either the terminal message sees the
   * finished operation in its Stream Count, or the operation is refused —
   * never a stream/datagram slipping out after the DONE.
   */
  private pendingPublishOps = new Map<bigint, number>();

  /**
   * Publisher-op GENERATION per subscription Request ID. Cancellation /
   * termination bumps it synchronously; a data-plane operation captures the
   * generation before its first await and, once the transport stream resolves,
   * checks it: a bump in the meantime means the subscription was cancelled
   * mid-open, so the freshly-created stream is aborted and rejected WITHOUT
   * writing a header, registering, or counting it. This closes the window a
   * deletion-only scheme leaves open — a stream created after cancellation
   * escaping onto the wire.
   */
  private publisherGeneration = new Map<bigint, number>();

  /**
   * Receiver-side §10.11 terminal tracker. `aliasStreamsSeen` counts every
   * subgroup stream observed per Track Alias; when PUBLISH_DONE arrives, the
   * difference to its Stream Count becomes a BOUNDED tombstone in
   * `terminatedAliases`: late streams for the alias are early-discarded
   * (STOP_SENDING) and datagrams dropped, until the announced count has been
   * observed or `terminatedAliasTtlMs` expires — never retained indefinitely.
   */
  private aliasStreamsSeen = new Map<bigint, bigint>();
  /**
   * Per-alias tombstone. `remaining` is how many late streams are still expected
   * (bigint, counted down as they arrive); `null` means the count is UNKNOWN —
   * the publisher set the 2^62-1 sentinel (§9.15) — so the tombstone relies on
   * the TTL alone and never auto-clears by counting. A tombstone always carries
   * a TTL timer so it is bounded even when `remaining` never reaches 0.
   */
  private terminatedAliases = new Map<bigint, {
    remaining: bigint | null;
    /** Cancels the (possibly chunked) guard-clear timer — see {@link armGuardTimer}. */
    cancelTimer: () => void;
    /**
     * STRICT tombstones come from a PUBLISH_DONE Stream Count; NON-strict ones
     * are ordinary-unsubscribe / peer-close TTL-only guards. Both REFUSE alias
     * reuse while live (see {@link aliasReuseSafe}) — §11.1 permits late objects
     * after cancellation, so reusing an alias with any guard risks misdelivering
     * an old stream to the new track. The only reuse-safe state is a COMPLETE
     * strict tombstone (remaining 0: its generation finished). The `strict` flag
     * distinguishes the two for that check and for count-driven clearing.
     */
    strict: boolean;
  }>();
  /**
   * Terminal-alias-guard lifetime (constructor option, default 10s). §10.11: a late
   * stream should be discarded for at least the effective delivery timeout after
   * termination. This is the DEFAULT floor; when a subscription's §8 EFFECTIVE
   * delivery timeout exceeds it, {@link armTerminatedAlias} extends the guard to that
   * value via {@link aliasDeliveryTimeoutMs} — so a guard cannot expire while the
   * publisher is still legitimately delivering old-alias streams.
   */
  private readonly terminatedAliasTtlMs: number;
  /**
   * Alias → §8 EFFECTIVE delivery timeout (ms) for the subscription that owns it —
   * combining the publisher's OBJECT_DELIVERY_TIMEOUT (0x02) / SUBGROUP_DELIVERY_TIMEOUT
   * (0x06) Track Properties (both generically decoded) with the subscriber's Message
   * Parameters, per {@link effectiveDeliveryTimeoutMs}. Populated at SUBSCRIBE_OK bind;
   * consumed by {@link armTerminatedAlias} to floor the guard TTL, and dropped by
   * {@link clearTerminatedAlias} when the guard clears.
   */
  private aliasDeliveryTimeoutMs = new Map<bigint, number>();
  /**
   * Alias → the PUBLISHER's raw OBJECT/SUBGROUP delivery-timeout values (ms), kept so
   * a later REQUEST_UPDATE carrying a new SUBSCRIBER timeout (§8) can re-derive the
   * alias's effective guard timeout via {@link combineDeliveryTimeoutMs}. Cleared
   * with {@link aliasDeliveryTimeoutMs}.
   */
  private aliasPublisherTimeout = new Map<bigint, { obj: number; sub: number }>();
  /**
   * Inbound-PUBLISH request ID → the publisher's raw OBJECT/SUBGROUP delivery-timeout
   * Track Properties (ms), captured at bind so acceptSubscribe can COMBINE them with
   * OUR PUBLISH_OK Message Parameters (§8) into the alias's effective timeout. Dropped
   * once combined or when the inbound PUBLISH is torn down.
   */
  private inboundPublishTimeouts = new Map<bigint, { obj: number; sub: number }>();
  /**
   * Inbound-FETCH request IDs that have already opened their ONE response stream
   * (§11.4.4). Reserved atomically in openFetchStream and RETAINED after the stream
   * FINs — a request cannot open a second stream, nor reopen after close. Released
   * only when the inbound FETCH is torn down (reject / cancel / request-stream close).
   */
  private fetchServeReserved = new Set<bigint>();
  /** §9.15 sentinel: publisher could not set an exact Stream Count. */
  private static readonly STREAM_COUNT_UNKNOWN = (1n << 62n) - 1n;
  /** setTimeout's safe upper bound (2^31-1 ms); longer durations are chunked. */
  private static readonly MAX_TIMER_MS = 2_147_483_647;

  /** Version explicitly requested in constructor, if any. */
  private readonly _requestedVersion: DraftVersion | undefined;

  /** Endpoint role — determines Request ID parity (CLIENT even / SERVER odd). */
  private readonly _role: EndpointRoleValue;

  /**
   * Create a MOQT connection.
   *
   * @param version Draft version to use. When omitted:
   *   - Browser WebTransport may expose `transport.protocol`, allowing
   *     draft auto-detection ('moqt-16' → 16, 'moq-00' → 14).
   *   - Node/headless/polyfill WebTransport often has `protocol` undefined.
   *   - When `protocol` is undefined, the connection defaults to draft 16.
   *   - **v14 callers MUST pass `new MoqtConnection(14)`**, because the first
   *     CLIENT_SETUP bytes are draft-specific and cannot be retried.
   * @param options.role Endpoint role (default `'client'`). The role sets
   *   Request ID parity (client = even, server = odd, §10.1). Almost all
   *   deployments are clients; `'server'` exists so two endpoints can be paired
   *   in-process (e.g. an in-memory loopback for tests).
   */
  constructor(
    version?: DraftVersion,
    options?: {
      role?: 'client' | 'server';
      joiningFetchTimeoutMs?: number;
      terminatedAliasTtlMs?: number;
      closeReportFallbackMs?: number;
    },
  ) {
    this._requestedVersion = version;
    this._role = options?.role === 'server' ? EndpointRole.SERVER : EndpointRole.CLIENT;
    this.joiningFetchTimeoutMs = options?.joiningFetchTimeoutMs ?? 10_000;
    this.terminatedAliasTtlMs = options?.terminatedAliasTtlMs ?? 10_000;
    this.closeReportFallbackMs = options?.closeReportFallbackMs ?? 2_000;
    // Initialize with the requested version (or default 16). May be reconfigured
    // in connect() if WT protocol negotiation selects a different draft.
    this.configureForVersion(version ?? 16);
  }

  /**
   * (Re)configure all version-bound state for a draft version: the sans-I/O
   * Session, the control/data codecs + control framer, and the stream topology.
   *
   * Centralizes what the constructor and connect()'s negotiation path both need,
   * so the draft-18 uni-pair wiring can never drift from the auto-negotiated
   * path. Called once from the constructor, and again from connect() when
   * `transport.protocol` selects a different draft than the constructor default.
   *
   * - draft-18: uni control-stream pair + per-request bidi streams. Data still
   *   flows on incoming uni streams + datagrams (draft-18 vi64 data codec).
   * - draft-14/16: a single bidi control stream (BidiControlTopology); no uniPair.
   */
  private configureForVersion(version: DraftVersion): void {
    // This adapter is always WebTransport, so PATH/AUTHORITY in SETUP are illegal
    // (§10.3.1.1/§10.3.1.2 → INVALID_PATH / INVALID_AUTHORITY on receive).
    this.session = new Session(this._role, version, { webtransport: true });
    if (version === 18) {
      this.codec = createControlCodec(18);
      this.framer = new ControlStreamFramer(this.codec);
      this.dataCodec = createDataCodec(18);
      this.uniPair = createUniPairTopology(this.session);
      // Surface request-stream failures (unsolicited/wrong-typed response) at once,
      // de-duped against the response-consumer path (same Error instance).
      this.uniPair.onStreamError = (err) => this.reportStreamError(err);
      // A peer REQUEST_UPDATE on an open outbound PUBLISH stream (§10.9).
      this.uniPair.onPeerRequestUpdate = (originalRequestId, message) =>
        this.handleOutboundPublishPeerUpdate(originalRequestId, message);
      // A peer FIN/reset of an outbound request stream (§11.4.1) terminates that
      // request — clean session AND adapter-owned state for it.
      this.uniPair.onRequestClosed = (requestId, disposition) => this.handleOutboundRequestClosed(requestId, disposition);
      // A GOAWAY on a request stream (§10.4) — a per-request migration signal,
      // surfaced for BOTH pending and already-established requests (empty queue).
      this.uniPair.onRequestGoaway = (err) => this.handleRequestStreamGoaway(err);
      // A later control-stream message (draft-18 GOAWAY, §10.4): feed it to the
      // session (→ DRAINING, or close on a violation) and surface it to the app.
      this.uniPair.onControlMessage = (message) => this.handleControlStreamMessage(message);
      // A post-SETUP control-stream lifecycle violation (non-GOAWAY message, decode
      // failure, or FIN, §3.3/§10.4) is fatal — close with PROTOCOL_VIOLATION.
      this.uniPair.onControlStreamViolation = (reason) => this.handleControlStreamViolation(reason);
    } else {
      const topology = createBidiControlTopology(version);
      this.codec = topology.control;
      this.dataCodec = topology.data;
      this.framer = topology.framer;
      this.uniPair = null;
    }
  }

  /**
   * Connect to a MOQT server via WebTransport.
   *
   * Opens the control bidirectional stream, sends CLIENT_SETUP,
   * waits for SERVER_SETUP, then starts background loops for:
   * - Control stream reading
   * - Incoming unidirectional data streams
   * - Incoming datagrams
   *
   * @param transport WebTransport session (real or mock)
   * @param options Setup parameters (path, maxRequestId, etc.)
   * @see draft-ietf-moq-transport-16 §3.3
   */
  async connect(
    transport: WebTransportLike,
    options: SetupOptions = {},
  ): Promise<void> {
    this.transport = transport;
    // Observe the WebTransport session lifetime: a remote close settles this
    // promise with the real code/reason (preserved into onClose), a transport
    // failure rejects it (surfaced as a fatal error). Runs through the one-shot
    // terminal coordinator, ignores a stale transport after migration.
    void this.watchTransportClosed(transport);

    // §3.1: Auto-detect the draft version from the negotiated WT-Available-Protocols
    // BEFORE choosing a connect path. If the constructor was given no explicit
    // version and the server picked a supported protocol, reconfigure to it — this
    // is what lets an auto-negotiated 'moqt-18' enter the uni-pair path below
    // instead of the legacy single-bidi path. An explicit constructor version
    // (`_requestedVersion !== undefined`) always wins over `transport.protocol`.
    if (this._requestedVersion === undefined && transport.protocol) {
      const negotiated = protocolToDraftVersion(transport.protocol);
      if (negotiated !== undefined && negotiated !== this.session.draftVersion) {
        this.configureForVersion(negotiated);
      }
    }

    if (this.session.draftVersion === 18) {
      // draft-18: open the uni control-stream pair and exchange SETUP. Request
      // responses arrive on their own bidi streams (see subscribe()), so no
      // shared control read loop is started. Data, however, flows the same way
      // as 14/16 — incoming uni (subgroup/fetch) streams and datagrams — so we
      // start those loops here. establish() has already consumed the inbound
      // control stream (#1) and released the lock, so runIncomingStreamLoop
      // picks up data streams (#2+) without contending for the control stream.
      // WebTransport carries the path in the URL, so never put PATH in SETUP.
      // AUTHORITY over WebTransport is prohibited by draft-16 §9.3.1.1, but
      // some tenant-routed deployments require it; preserve it only when the
      // caller explicitly opts into that interop deviation.
      const { path, ...cleanOptions } = options;
      void path;
      await this.uniPair!.establish(transport, cleanOptions);
      this.runIncomingStreamLoop(transport);
      this.runDatagramLoop(transport);
      this.runIncomingBidiLoop(transport);
      return;
    }

    // WebTransport carries the path in the URL, so never put PATH in SETUP.
    // AUTHORITY over WebTransport is prohibited by draft-16 §9.3.1.1, but
    // some tenant-routed deployments require it; preserve it only when the
    // caller explicitly opts into that interop deviation.
    const { path, ...cleanOptions } = options;
    void path;

    // draft-14/16 single-bidi control stream. The role decides who opens it:
    // the client opens it and sends CLIENT_SETUP; the server accepts the client's
    // stream and replies SERVER_SETUP. (draft-18's server path is the uni-pair
    // establish() above; this is the legacy equivalent.)
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    if (this._role === EndpointRole.SERVER) {
      const incoming = transport.incomingBidirectionalStreams;
      if (!incoming) {
        throw new ProtocolViolationError('server connect: transport has no incomingBidirectionalStreams');
      }
      const incomingReader = incoming.getReader();
      const { value: bidiStream, done } = await incomingReader.read();
      incomingReader.releaseLock();
      if (done || !bidiStream) {
        throw new ProtocolViolationError('server connect: no control stream from client');
      }
      this.controlWriter = bidiStream.writable.getWriter();
      reader = bidiStream.readable.getReader();
      // Read until CLIENT_SETUP is processed, then reply with SERVER_SETUP.
      let clientSetupSeen = false;
      while (!clientSetupSeen) {
        const { value, done: rDone } = await reader.read();
        if (rDone) throw new ProtocolViolationError('Control stream closed before CLIENT_SETUP');
        this.framer.push(value);
        for (const { message } of this.framer.drain()) {
          await this.executeActions(this.session.handleControlMessage(message));
          if (message.type === 'CLIENT_SETUP') clientSetupSeen = true;
        }
      }
      await this.executeActions(this.session.completeSetup(cleanOptions));
    } else {
      // Open control stream (first client-initiated bidirectional stream).
      const bidiStream = await transport.createBidirectionalStream();
      this.controlWriter = bidiStream.writable.getWriter();
      reader = bidiStream.readable.getReader();
      await this.executeActions(this.session.initiateSetup(cleanOptions)); // CLIENT_SETUP
      // Read until SERVER_SETUP completes the handshake.
      while (this.session.state === SessionState.SETUP_PENDING) {
        const { value, done } = await reader.read();
        if (done) throw new ProtocolViolationError('Control stream closed before setup complete');
        this.framer.push(value);
        for (const { message } of this.framer.drain()) {
          await this.executeActions(this.session.handleControlMessage(message));
        }
      }
    }

    // §9.3: Setup must complete successfully before normal exchange.
    if (this.session.state !== SessionState.ESTABLISHED) {
      throw new Error(
        `Setup failed: session in state "${this.session.state}" (expected "established")`,
      );
    }

    // Start background loops
    this.runControlReadLoop(reader);
    this.runIncomingStreamLoop(transport);
    this.runDatagramLoop(transport);
  }

  /**
   * Subscribe to a track. draft-14/16 send SUBSCRIBE on the control stream;
   * draft-18 opens a per-request bidi stream and the response correlates by it.
   * @returns The request ID for this subscription.
   */
  async subscribe(
    namespace: Uint8Array[],
    name: Uint8Array,
    options?: SubscribeOptions,
  ): Promise<bigint> {
    const { requestId, actions } = this.session.subscribe(namespace, name, options);
    await this.sendSubscribeActions(actions);
    return requestId;
  }

  /**
   * Send the outbound SUBSCRIBE produced by `session.subscribe()`. draft-18 opens
   * the SUBSCRIBE's own bidi request stream (response correlates by it); draft-14/16
   * write it on the shared control stream. Split out so {@link subscribeTrack} can
   * register its response resolver BEFORE any bytes go out — a zero-latency peer
   * may answer (e.g. a §3.2 reserved-namespace REQUEST_ERROR) synchronously.
   */
  private async sendSubscribeActions(actions: SessionOutboundAction[]): Promise<void> {
    if (this.session.draftVersion === 18) {
      const subscribeMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      const requestId = (subscribeMsg as { requestId: bigint }).requestId;
      // The delivery IS the topology's wire-order barrier: the read loop awaits
      // it before touching the next frame, so a PUBLISH_DONE coalesced behind
      // the SUBSCRIBE_OK can never reach a still-PENDING subscription.
      await this.openD18Request(requestId, subscribeMsg);
      return;
    }
    await this.executeActions(actions);
  }

  /**
   * Open a draft-18 per-request bidi stream for `message`, write it, and attach the
   * response handler. On stream-open (or write) FAILURE, roll back the Session's
   * request state (§11.4.1) plus any adapter-side state (`onRollback`), then
   * re-throw. Without this a failed open leaves a phantom request that the peer
   * never learned of — one that could still authorize outbound data (e.g. a fetch's
   * group-order entry) or leave a caller's promise/subscription pending. The single
   * transaction boundary for every d18 request opener.
   */
  private async openD18Request(
    requestId: bigint,
    message: ControlMessage,
    onRollback?: () => void,
  ): Promise<void> {
    try {
      const stream = await this.uniPair!.openRequest(
        this.transport!, message,
        (m) => this.deliverRequestResponse(m, requestId),
      );
      this.routeRequestResponse(stream); // always attach a handler (no unhandled rejection)
    } catch (err) {
      onRollback?.();
      await this.executeActions(this.session.handleOutboundRequestClosed(requestId));
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Initiate an outbound PUBLISH (draft-18 §10.10): push a track to the peer. We
   * are the publisher — this opens a NEW bidi request stream, writes PUBLISH, and
   * keeps the stream open for the REQUEST_OK / REQUEST_ERROR response, a local
   * PUBLISH_DONE, and object data (sent via openSubgroup / sendObject / sendDatagram
   * keyed by `trackAlias`). Objects MAY be sent before REQUEST_OK arrives.
   *
   * @param namespace Track namespace tuple
   * @param name Track name bytes
   * @param trackAlias Track Alias to advertise (full uint64-capable bigint)
   * @param options Optional PUBLISH parameters
   * @returns The request ID for this publish
   * @see draft-ietf-moq-transport-18 §10.10
   */
  async publish(
    namespace: Uint8Array[],
    name: Uint8Array,
    trackAlias: bigint,
    options?: { parameters?: Parameters; trackProperties?: TrackProperties },
  ): Promise<bigint> {
    const { requestId, actions } = this.session.publish(namespace, name, trackAlias, options);
    // Associate the advertised alias with this publish for §10.11 Stream Count
    // accounting and terminal enforcement on the data-plane APIs.
    this.publisherAliasRequests.set(trackAlias, requestId);
    if (this.session.draftVersion === 18) {
      const publishMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      // Roll back the publisher-alias authority too (so openSubgroup can't publish
      // on an alias the peer never learned) if the request-stream open fails.
      await this.openD18Request(requestId, publishMsg, () => this.publisherAliasRequests.delete(trackAlias));
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Attach a background handler to a draft-18 request stream's response, routing
   * it through the adapter's normal pipeline (qlog → raw subscription resolution
   * → onMessage → session). Always attached, even for plain subscribe(), so a
   * REQUEST_ERROR / malformed response / stream reset never becomes an unhandled
   * rejection.
   */
  private routeRequestResponse(stream: RequestStream): void {
    // Single guarded background handler: a response rejection, a delivery error,
    // or an executeActions rejection are ALL funneled through one catch, so
    // nothing escapes as an unhandled promise rejection.
    void this.consumeRequestStream(stream);
  }

  private async consumeRequestStream(stream: RequestStream): Promise<void> {
    try {
      // Delivery already ran INSIDE the topology's read loop (the wire-order
      // barrier registered at openRequest/sendUpdate) — here we only await the
      // settled result so failures are funneled through one catch.
      await stream.response;
    } catch (err) {
      // A LOCAL cancellation (fetchCancel) tears down the stream on purpose — it
      // is not a failure, so do not reject the caller or fire onError.
      if (err instanceof RequestCancelledError) return;
      // §10.4: a GOAWAY on this request stream is a per-request MIGRATION signal,
      // already handled by the topology's onRequestGoaway callback (which fires for
      // pending AND established requests). The pending first-response waiter is
      // rejected with this typed error only to unblock THIS consumer — do not
      // double-handle it here (no onError, no second settle).
      if (err instanceof RequestGoawayError) return;
      const error = err instanceof Error ? err : new Error(String(err));
      // Reject a still-pending subscribeTrack for this request (no-op if already
      // resolved), then surface the error.
      const raw = this.rawSubscriptions.get(stream.requestId);
      if (raw?.reject) {
        raw.reject(error);
        raw.resolve = null;
        raw.reject = null;
        this.rawSubscriptions.delete(stream.requestId);
      }
      // De-duped: the topology's onStreamError path carries the same Error.
      this.reportStreamError(error);
    }
  }

  /**
   * Handle a GOAWAY received on an OUTBOUND request stream (§10.4). The peer asks
   * us to migrate THIS one request; the draft says the receiver SHOULD re-issue it
   * and close the old stream. We parse and surface it as a well-formed per-request
   * signal, but do NOT auto-reissue (no timers/reconnect/session-migration machinery
   * — that remains application policy), and we do NOT close the session.
   *
   * Invoked via the topology's `onRequestGoaway` callback for BOTH a still-pending
   * request (first response not yet delivered) AND an already-established one (FIFO
   * queue empty) — so onMessage fires in either case. What we do:
   *   - pending subscribeTrack(): reject it with a controlled, non-fatal
   *     MoqtConnectionError (the caller decides whether to re-issue);
   *   - established subscribe: nothing to reject (resolve/reject already nulled);
   *   - always: surface the GOAWAY via onMessage, consistent with control-stream GOAWAY.
   * The old request stream is being torn down by the topology; per-request
   * session/alias/fetch cleanup runs through onRequestClosed → handleOutboundRequestClosed.
   */
  private handleRequestStreamGoaway(err: RequestGoawayError): void {
    const raw = this.rawSubscriptions.get(err.requestId);
    if (raw?.reject) {
      raw.reject(new MoqtConnectionError(
        `Request ${err.requestId} received GOAWAY on its request stream; re-issue is application policy (automatic reissue not implemented)`,
        { errorSource: 'control' },
      ));
      raw.resolve = null;
      raw.reject = null;
      this.rawSubscriptions.delete(err.requestId);
    }
    // Surface the GOAWAY to the application (same channel as control-stream GOAWAY).
    this.onMessage?.(err.goaway as ControlMessage);
  }

  /** Read a control message's Track Properties (canonical `trackProperties`, or
   *  the deprecated `trackExtensions` alias). */
  private trackPropsOf(message: DecodedControlMessage): TrackProperties {
    const m = message as { trackProperties?: TrackProperties; trackExtensions?: TrackProperties };
    return m.trackProperties ?? m.trackExtensions ?? new Map();
  }

  /** Read a varint Track Property value (ms), or undefined if absent/non-numeric. */
  private trackPropMs(props: TrackProperties, type: bigint): number | undefined {
    const v = props.get(type)?.[0];
    return typeof v === 'bigint' ? Number(v) : undefined;
  }

  /** §8 per-type rule: both non-zero → the SMALLER; one zero → the other; both zero → 0. */
  private static minNonzeroMs(a: number, b: number): number {
    return a > 0 && b > 0 ? Math.min(a, b) : Math.max(a, b);
  }

  /**
   * Combine the §8 delivery timeouts (ms) into the effective value the terminal-alias
   * guard must outlive. Each of OBJECT_DELIVERY_TIMEOUT (0x02) and
   * SUBGROUP_DELIVERY_TIMEOUT (0x06) is carried by the PUBLISHER as a Track Property
   * AND by the SUBSCRIBER as a Message Parameter; the effective value per type is the
   * smaller non-zero of the two, and the guard must cover the LARGER of the two
   * effective timeouts (a late Object may arrive within either window).
   */
  private combineDeliveryTimeoutMs(pubObj: number, pubSub: number, subObj: number, subSub: number): number {
    return Math.max(
      MoqtConnection.minNonzeroMs(pubObj, subObj),
      MoqtConnection.minNonzeroMs(pubSub, subSub),
    );
  }

  /** Read a varint delivery-timeout Message Parameter (ms) from a Parameters map. */
  private paramTimeoutMs(params: Parameters | undefined, type: bigint): number {
    const v = params?.get(type)?.[0];
    return typeof v === 'bigint' ? Number(v) : 0;
  }

  /**
   * Effective §8 delivery timeout for a SUBSCRIBE-initiated subscription: the peer's
   * Track Properties (in the SUBSCRIBE_OK `okMsg`) combined with OUR requested
   * Message Parameters. Our SUBSCRIBE API exposes only the object timeout
   * (DELIVERY_TIMEOUT, 0x02); the subscriber subgroup timeout is absent (0).
   */
  private effectiveDeliveryTimeoutMs(subObjectMs: number | undefined, okMsg: DecodedControlMessage): number {
    const props = this.trackPropsOf(okMsg);
    return this.combineDeliveryTimeoutMs(
      this.trackPropMs(props, 0x02n) ?? 0, this.trackPropMs(props, 0x06n) ?? 0,
      subObjectMs ?? 0, 0,
    );
  }

  /**
   * §8: re-derive `alias`'s effective terminal-guard timeout from the subscription's
   * CURRENTLY-COMMITTED delivery timeouts (a REQUEST_UPDATE commits them on REQUEST_OK,
   * not at send) combined with the retained publisher Track-Property values. Called
   * just before the guard is armed at teardown, so it reflects any accepted update.
   * No-op if the alias's subscription is gone (the last cached value then stands).
   */
  private refreshAliasDeliveryTimeout(alias: bigint): void {
    const reqId = this.rawAliasMaps.get(alias)?.requestId
      ?? [...this.publishAliasMaps].find(([a]) => a === alias)?.[1]?.requestId;
    if (reqId === undefined || reqId === null) return;
    const sub = this.session.getSubscription(reqId) ?? this.session.getIncomingSubscription(reqId);
    if (!sub) return;
    const pub = this.aliasPublisherTimeout.get(alias) ?? { obj: 0, sub: 0 };
    const eff = this.combineDeliveryTimeoutMs(
      pub.obj, pub.sub, sub.requestedDeliveryTimeoutMs ?? 0, sub.requestedSubgroupDeliveryTimeoutMs ?? 0,
    );
    if (eff > 0) this.aliasDeliveryTimeoutMs.set(alias, eff);
    else this.aliasDeliveryTimeoutMs.delete(alias);
  }

  /**
   * Classify a Track Properties block that this endpoint MUST NOT process/forward:
   * an unsupported Mandatory Track Property (§2.5.1) or a data-Object-only Property
   * (§2.5). Returns the REQUEST_ERROR code + reason, or null if acceptable.
   */
  private trackPropertyFault(message: DecodedControlMessage): { code: Varint; reason: string } | null {
    const props = this.trackPropsOf(message);
    if (hasUnsupportedMandatoryTrackProperty(props)) {
      return { code: RequestError18.UNSUPPORTED_EXTENSION, reason: 'an unsupported Mandatory Track Property (§2.5.1)' };
    }
    if (hasObjectOnlyTrackProperty(props)) {
      return { code: RequestError18.MALFORMED_TRACK, reason: 'a data-Object-only Property in Track Properties (§2.5)' };
    }
    return null;
  }

  /** Route a draft-18 request-stream response through the standard pipeline. */
  private async deliverRequestResponse(message: DecodedControlMessage, requestId: bigint): Promise<void> {
    // Stamp the stream-derived Request ID (codec leaves it absent on responses).
    const stamped = { ...message, requestId } as ControlMessage;
    // qlog is the RAW observation channel — emit BEFORE any semantic handling
    // (track-property fault, session reject, guarded-alias refuse, crossed-response
    // drop) so every parsed response is observed even when it is not surfaced to
    // the application via onMessage.
    this.onQlogEvent?.({
      type: 'control_message_parsed',
      stream_id: MoqtConnection.CONTROL_STREAM_QLOG_ID,
      message: stamped,
    });

    // §2.4.2 / §2.5.1: a SUBSCRIBE_OK / FETCH_OK whose Track Properties carry an
    // unsupported Mandatory Track Property or a data-Object-only Property MUST NOT
    // be processed — cancel ONLY this request (reset its stream); the session is
    // NOT closed.
    if (message.type === 'SUBSCRIBE_OK' || message.type === 'FETCH_OK') {
      const fault = this.trackPropertyFault(message);
      if (fault) {
        await this.failRejectedTrack(message.type, requestId, fault.reason);
        return;
      }
    }

    // SUBSCRIBE_OK binds a Track Alias and resolves the public subscribeTrack()
    // promise. Ordered handling (§10.8 / §11.1): the SESSION validates FIRST
    // (unknown request / true simultaneous duplicate alias → session close),
    // THEN alias-reuse safety is checked and a guarded reuse is refused via the
    // draft-specific cancel — nothing is bound or resolved until both pass. See
    // handleSubscribeOkOrdered.
    if (message.type === 'SUBSCRIBE_OK') {
      await this.handleSubscribeOkOrdered(message, requestId);
      return;
    }

    // §5.1: a response (e.g. REQUEST_ERROR) crossing a cancellation is consumed by
    // the session as a superseded-request reclaim — suppress it from the application
    // onMessage for consistency with the crossed-SUBSCRIBE_OK path (qlog above stays raw).
    const suppress = this.handleRawSubControlMessage(stamped)
      || this.session.isCancelledRequest(requestId);
    if (!suppress) this.onMessage?.(stamped);
    await this.executeActions(this.session.handleControlMessage(message, { requestId }));
    // §10.13: a FETCH_OK may complete the fetch (its data stream already FIN'd, in
    // the object-delivery-before-response order) — close the request bidi so the
    // fetcher's topology context does not leak.
    if (message.type === 'FETCH_OK') await this.closeCompletedFetchRequest(requestId);
  }

  /**
   * §10.13: once BOTH the FETCH_OK and the data stream are done (the Session has
   * reclaimed the outgoing fetch), FIN the fetcher's request bidi stream so its
   * topology context is reclaimed. No-op if the fetch is still in flight (one side
   * outstanding) or the stream is already gone.
   */
  private async closeCompletedFetchRequest(requestId: bigint): Promise<void> {
    if (this.session.getFetch(requestId) !== undefined) return;
    if (!this.uniPair?.hasRequestStream(requestId)) return;
    await this.uniPair.finishRequest(requestId);
  }

  /**
   * Ordered SUBSCRIBE_OK handling shared by the draft-18 request-stream path and
   * the draft-14/16 control loop, so BOTH enforce the same rules (§10.8 / §11.1):
   *   (1) SESSION validation FIRST — unknown request ID and a TRUE simultaneous
   *       duplicate alias get their session-level close here (through the terminal
   *       coordinator); nothing is bound or resolved on rejection;
   *   (2) alias-reuse policy — if a prior generation's guard is still live,
   *       refuse binding and cancel via the DRAFT-SPECIFIC mechanism (draft-14/16
   *       UNSUBSCRIBE, draft-18 request-stream reset), never binding routing;
   *   (3) only on acceptance: clear a complete guard, bind routing, resolve.
   */
  private async handleSubscribeOkOrdered(message: DecodedControlMessage, requestId: bigint): Promise<void> {
    // (1) Validate in the session first.
    const actions = this.session.handleControlMessage(message, { requestId });
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      // The session rejected it (e.g. DUPLICATE_TRACK_ALIAS, unknown request) —
      // do NOT bind or resolve. The terminal coordinator rejects the pending
      // subscribeTrack().
      await this.executeActions(actions);
      this.notifyClose(closeAction, 'SUBSCRIBE_OK rejected');
      return;
    }
    // §5.1: a SUBSCRIBE_OK crossing a cancellation is IGNORED by the session (the
    // local subscription was already superseded/removed). It is not a live
    // response — drop it BEFORE alias-reuse checks, guard clearing, binding, and
    // application (onMessage) delivery. (qlog already observed it raw at the caller;
    // qlog is the raw channel, onMessage is application-level.) Incidental actions
    // still run.
    if (this.session.getSubscription(requestId) === undefined) {
      await this.executeActions(actions);
      return;
    }
    // (2) The session accepted + registered the alias. If a prior terminal guard
    // is still live, reusing the alias risks misdelivering an old stream to this
    // new track — refuse (per-track, non-fatal) via the draft-specific cancel.
    const alias = BigInt((message as { trackAlias: bigint }).trackAlias);
    if (!this.aliasReuseSafe(alias)) {
      await this.refuseAliasReuse(requestId,
        `track alias ${alias} is still guarded by a terminating prior subscription (§11.1) — reuse refused`);
      return;
    }
    // (3) Accepted — bind routing, resolve, surface, and run replenish actions.
    const stampedOk = { ...message, requestId } as ControlMessage;
    // The old generation's complete guard (if any) is safe to clear now.
    this.clearTerminatedAlias(alias);
    const suppress = this.handleRawSubControlMessage(stampedOk);
    if (!suppress) this.onMessage?.(stampedOk);
    await this.executeActions(actions);
  }

  /**
   * Refuse a guarded alias reuse for a just-established subscription: reject its
   * pending subscribeTrack() promise, terminate the session subscription (which
   * unregisters the alias), and cancel through the DRAFT-SPECIFIC mechanism —
   * draft-14/16 emit UNSUBSCRIBE, draft-18 resets the request stream. Never binds
   * adapter routing. Per-track failure, NOT a session close. `uniPair` is only
   * touched on draft-18 (it does not exist on draft-14/16).
   */
  private async refuseAliasReuse(requestId: bigint, reason: string): Promise<void> {
    const err = new MoqtConnectionError(reason, { errorSource: 'control', isFatal: false });
    const raw = this.rawSubscriptions.get(requestId);
    if (raw) {
      this.rawSubscriptions.delete(requestId);
      raw.reject?.(err);
      raw.resolve = null;
      raw.reject = null;
    }
    // session.unsubscribe: draft-14/16 → UNSUBSCRIBE control action + alias
    // unregister; draft-18 → no control action + alias unregister.
    await this.executeActions(this.session.unsubscribe(requestId));
    if (this.session.draftVersion === 18) await this.uniPair!.cancelRequest(requestId);
    this.onError?.(err);
  }

  /**
   * Whether Track Alias `alias` is safe to (re)bind to a new subscription.
   * Unsafe while a prior terminal guard is still live and could route a late old
   * stream to the new track (§11.1): an incomplete or unknown-count STRICT
   * tombstone, or any NON-strict ordinary-teardown guard. Safe when there is no
   * tombstone, or a COMPLETE strict one (remaining 0 — its generation finished).
   */
  private aliasReuseSafe(alias: bigint): boolean {
    const t = this.terminatedAliases.get(alias);
    return !t || (t.strict && t.remaining === 0n);
  }

  /**
   * Reject a SUBSCRIBE_OK / FETCH_OK whose Track Properties this endpoint must not
   * process (malformed track §2.4.2 or unsupported Mandatory Track Property
   * §2.5.1). The track is cancelled — NOT the session: fail the pending
   * subscribeTrack (if any), terminate local request state, and RESET the request's
   * own bidi stream (§3.3.2). Surfaced via onError as a per-track failure.
   */
  private async failRejectedTrack(type: 'SUBSCRIBE_OK' | 'FETCH_OK', requestId: bigint, reason: string): Promise<void> {
    const err = new MoqtConnectionError(
      `Track rejected: ${type} carried ${reason} — request reset`,
      { errorSource: 'control', isFatal: false },
    );
    // Reject a still-pending subscribeTrack for this request (no-op otherwise).
    const raw = this.rawSubscriptions.get(requestId);
    if (raw?.reject) {
      raw.reject(err);
      raw.resolve = null;
      raw.reject = null;
      this.rawSubscriptions.delete(requestId);
    }
    await this.executeActions(this.session.handleMalformedTrack(requestId)); // terminate state (no establish)
    await this.uniPair!.cancelRequest(requestId); // §2.4.2: RESET the request stream
    this.onError?.(err);
  }

  /**
   * Reject and clear all pending raw subscription state on a terminal control
   * failure or session close. Without this a draft-14/16 `subscribeTrack()` whose
   * response never arrived (the shared control stream closed mid-response) would
   * hang forever. A still-pending entry is rejected with a fatal control error;
   * settled entries (no `reject` callback) are skipped, so this is idempotent.
   * Alias routing is dropped too — the session is gone, nothing more can deliver.
   */
  private failPendingRawSubscriptions(reason: string): void {
    for (const raw of this.rawSubscriptions.values()) {
      if (raw.reject) {
        raw.reject(new MoqtConnectionError(reason, { errorSource: 'control', isFatal: true }));
        raw.resolve = null;
        raw.reject = null;
      }
    }
    this.rawSubscriptions.clear();
    this.rawAliasMaps.clear();
  }

  /**
   * Handle a peer REQUEST_UPDATE on an open OUTBOUND PUBLISH request stream
   * (§10.9). Same stamped-pipeline pattern as an inbound PUBLISH: the wire Request
   * ID is the update's OWN id; the Existing Request ID is the original PUBLISH
   * (stream context). The session applies it (e.g. FORWARD) and we answer
   * REQUEST_OK / REQUEST_ERROR on the SAME stream — no new stream, no uni control.
   * If handling produces a session close, close and do NOT also write a response.
   */
  private async handleOutboundPublishPeerUpdate(
    originalRequestId: bigint,
    message: DecodedControlMessage,
  ): Promise<void> {
    // §10.11: PUBLISH_DONE — the publisher's terminal message on OUR
    // subscription's request stream. Stamp the subscription's request ID,
    // let the session terminate the subscription, surface to the app. This
    // receiver takes the EXPLICIT early-discard path: every data stream still
    // open for the terminated subscription's alias is STOP_SENDINGed — related
    // streams are actively stopped, not merely unrouted. The topology FINs our
    // send direction and drains to the publisher's FIN.
    if (message.type === 'PUBLISH_DONE') {
      // Capture the alias BEFORE the session reclaims the subscription.
      const doneAlias = this.session.getSubscription(originalRequestId)?.trackAlias;
      const streamCount = (message as { streamCount?: bigint }).streamCount ?? 0n;
      const stampedDone = { ...message, requestId: originalRequestId } as ControlMessage;
      this.onMessage?.(stampedDone);
      // Owner-check + route removal + tombstone install run SYNCHRONOUSLY (the
      // arm inside applyTerminalStreamCount is before its first await) — started
      // BEFORE the session-teardown await so no object slips through the window
      // and no concurrently-binding new subscription's route is deleted.
      const discard = doneAlias !== undefined
        ? this.applyTerminalStreamCount(doneAlias, BigInt(streamCount), originalRequestId)
        : Promise.resolve();
      await this.executeActions(this.session.handleControlMessage(stampedDone));
      await discard;
      return;
    }
    const updateId = (message as { requestId: bigint }).requestId;
    const stamped = { ...message, existingRequestId: originalRequestId } as ControlMessage;
    this.onMessage?.(stamped);
    const actions = this.session.handleControlMessage(stamped, {
      requestId: updateId,
      existingRequestId: originalRequestId,
    });
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      this.notifyClose(closeAction, 'REQUEST_UPDATE on PUBLISH rejected');
      return;
    }
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
    if (send) await this.uniPair!.writeOnRequest(originalRequestId, send.message);
    await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
  }

  /**
   * A peer FIN/reset of an OUTBOUND request stream terminates that request
   * (§11.4.1: Subscription / Fetch / Track Status / Publish / Publish Namespace).
   * The session drops its state (and unregisters a SUBSCRIBE's Track Alias); here
   * we drop the adapter-owned per-request maps. For a SUBSCRIBE we ALSO drop the
   * Track-Alias routing entry and arm a bounded late-object guard: the
   * subscription is terminated, so late data on that alias MUST NOT be delivered.
   * (An inbound PUBLISH that ends is torn down the same bounded way — its routing
   * is early-discarded, not retained indefinitely; §11.1.)
   */
  private async handleOutboundRequestClosed(requestId: bigint, disposition: 'fin' | 'reset'): Promise<void> {
    // §5.2 / §10.12: a FETCH's response (FETCH_OK) and its object data ride
    // INDEPENDENT streams with no cross-stream ordering, so a clean FIN of the request
    // stream AFTER FETCH_OK does NOT end the fetch — its data stream lives on. RETAIN
    // the fetch only in that exact case; the data-stream FIN drives reclamation (the
    // data-FIN finally deletes the group-order entry, reclaims the Session fetch, and
    // FINs the request stream via closeCompletedFetchRequest — a no-op here since the
    // stream is already closed; the topology FINned our writable half on the clean FIN).
    //
    // Every OTHER close is terminal and must reclaim (fall through), or the fetch would
    // leak forever:
    //   - a clean FIN BEFORE FETCH_OK — no response can arrive on a closed stream, so
    //     the fetch cannot complete (§11.4.1); leaving it PENDING would leak it;
    //   - a RESET at any point — a terminal stream error (§11.4.1); leaving it after a
    //     post-FETCH_OK reset would leak it TRANSFERRING.
    // A locally cancelled/errored fetch is already reclaimed in the Session
    // (getFetch === undefined) and also falls through.
    const outgoingFetch = this.session.getFetch(requestId);
    if (outgoingFetch !== undefined && !outgoingFetch.isFetcherComplete
        && disposition === 'fin' && outgoingFetch.responseReceived) {
      return;
    }
    // §5.1.1: capture the alias and arm terminal protection SYNCHRONOUSLY —
    // before the session-teardown await below — via the centralized path, so a
    // late object cannot slip through to the generic onObject hook. Only if this
    // request STILL owns the alias routing: a delayed peer-close after the alias
    // was legitimately reused by a new subscription must not re-tombstone it.
    const raw = this.rawSubscriptions.get(requestId);
    const teardownAlias = raw && raw.trackAlias !== null && this.rawAliasMaps.get(raw.trackAlias) === raw
      ? raw.trackAlias : null;
    if (teardownAlias !== null) this.armSubscriberAliasTeardown(teardownAlias);

    await this.executeActions(this.session.handleOutboundRequestClosed(requestId));
    if (raw) {
      if (teardownAlias !== null) {
        // Tombstone armed above; now early-discard any streams still open.
        await this.discardOpenStreamsForAlias(teardownAlias);
      }
      this.rawSubscriptions.delete(requestId);
      // Defensive: a still-pending subscribeTrack() (no SUBSCRIBE_OK yet) must not
      // hang when its request stream closes before the response (peer FIN/reset, or
      // a request-stream GOAWAY whose handler raced this cleanup). No-op once the
      // subscribe has resolved/rejected (resolve+reject are nulled out then).
      raw.reject?.(new MoqtConnectionError(
        `Request ${requestId} stream closed before completion`,
        { errorSource: 'control' },
      ));
    }
    // §5.1.1: if this was an outbound PUBLISH whose subscriber cancelled (peer
    // reset the PUBLISH request stream), RESET our open data streams for it too.
    await this.abortPublisherStreamsForRequest(requestId);
    this.fetchGroupOrder.delete(requestId);
  }

  /**
   * Handle a draft-18 control-stream message received AFTER setup — currently
   * GOAWAY (§10.4). Surface it to the application, feed it to the session, and act
   * on the result: a valid GOAWAY transitions the session to DRAINING (no actions,
   * so new local requests are refused); a violation (duplicate GOAWAY, server with
   * a non-empty URI, or a missing/wrong-parity Request ID) returns a close, which
   * closes the connection. This does NOT auto-migrate, reconnect, or start timers.
   */
  private async handleControlStreamMessage(message: DecodedControlMessage): Promise<void> {
    this.onMessage?.(message as ControlMessage);
    const actions = this.session.handleControlMessage(message as ControlMessage);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    await this.executeActions(actions);
    if (closeAction) this.notifyClose(closeAction, 'control-stream GOAWAY violation');
  }

  /**
   * A draft-18 control-stream lifecycle violation AFTER setup (§3.3/§10.4): a
   * non-GOAWAY message, a decode failure, or a FIN of the control stream. This is
   * fatal — close the session with PROTOCOL_VIOLATION and fire onClose. No-op if
   * the session is already closed (e.g. a local close FIN'd the stream first), so
   * we never double-close.
   */
  private handleControlStreamViolation(reason: string): void {
    if (this.session.state === SessionState.CLOSED) return;
    this.closeSessionFatal(reason); // centralized: close + reject pending + onClose
  }

  /**
   * Subscribe to a raw track with per-subscription object delivery.
   *
   * Sends SUBSCRIBE and awaits SUBSCRIBE_OK. Returns a TrackSubscription
   * with the resolved trackAlias. Objects delivered to sub.onObject
   * starting from the return point (stream-based only; datagrams excluded).
   *
   * @param namespace Track namespace tuple
   * @param name Track name bytes
   * @param options Subscribe options (filter, onObject callback)
   * @returns Resolved TrackSubscription after SUBSCRIBE_OK
   * @throws On REQUEST_ERROR from the publisher
   * @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
   */
  async subscribeTrack(
    namespace: Uint8Array[],
    name: Uint8Array,
    options?: TrackSubscribeOptions,
  ): Promise<TrackSubscription> {
    const subscribeOpts: SubscribeOptions = {};
    if (options?.filter) {
      subscribeOpts.subscriptionFilter = options.filter;
    }
    if (options?.deliveryTimeout !== undefined) {
      subscribeOpts.deliveryTimeout = options.deliveryTimeout;
    }
    // Build the SUBSCRIBE synchronously (allocates the Request ID) so the response
    // resolver is registered BEFORE any bytes go out. Otherwise a zero-latency peer
    // (e.g. the §3.2 reserved-namespace auto-reject) could answer with REQUEST_ERROR
    // before rawSubscriptions held an entry, and the promise would never settle.
    const { requestId, actions } = this.session.subscribe(namespace, name, subscribeOpts);
    const reqIdBigint = BigInt(requestId);

    // Create the subscription object — connection reads sub.onObject live.
    const sub: TrackSubscription = {
      requestId: reqIdBigint,
      trackAlias: 0n, // placeholder, updated when SUBSCRIBE_OK arrives
      onObject: options?.onObject ?? null,
      unsubscribe: async () => {
        // Delegate to the single centralized path: it arms terminal alias
        // protection synchronously (from the raw entry's real alias — null-safe,
        // and correct even for a legitimate alias 0) before any await.
        await this.unsubscribe(reqIdBigint);
      },
    };

    // Register the resolver/rejecter synchronously (executor runs now), THEN send.
    const result = new Promise<TrackSubscription>((resolve, reject) => {
      this.rawSubscriptions.set(reqIdBigint, { requestId: reqIdBigint, trackAlias: null, sub, resolve, reject });
    });
    try {
      await this.sendSubscribeActions(actions);
    } catch (err) {
      // The SUBSCRIBE never went out (e.g. request-stream creation failed) — drop
      // BOTH the adapter's pending state AND the session's pending subscription
      // (§11.4.1), then reject the caller. Otherwise a phantom subscription lingers.
      await this.executeActions(this.session.handleOutboundRequestClosed(reqIdBigint));
      const raw = this.rawSubscriptions.get(reqIdBigint);
      if (raw) {
        this.rawSubscriptions.delete(reqIdBigint);
        raw.reject?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return result;
  }

  /**
   * Check if an object belongs to a track subscription and route it.
   * Returns true if the object was claimed by a track subscription.
   * Called from data stream handlers before this.onObject.
   */
  private routeToTrackSubscription(obj: MoqtObject): boolean {
    const alias = BigInt(obj.trackAlias);
    const rawSub = this.rawAliasMaps.get(alias);
    if (rawSub) {
      rawSub.sub.onObject?.(obj);
      return true;
    }
    // draft-18 §10.10: objects for an accepted inbound PUBLISH route by alias.
    const pub = this.publishAliasMaps.get(alias);
    if (pub) {
      pub.onObject?.(obj);
      return true;
    }
    return false;
  }

  // ── receiver §10.11 terminal tracker (bounded, Stream-Count-driven) ──

  /** STOP_SENDING one incoming subgroup stream and drop its receiver state. */
  private async stopIncomingSubgroupStream(streamId: bigint): Promise<void> {
    this.incomingSubgroupAliases.delete(streamId);
    const reader = this.dataStreamReaders.get(streamId);
    if (reader) {
      try { await reader.cancel(new Error('subscription terminated by PUBLISH_DONE — early discard')); } catch { /* closed */ }
      this.dataStreamReaders.delete(streamId);
    }
  }

  /**
   * SYNCHRONOUS first step of a subscriber-alias teardown (ordinary unsubscribe /
   * peer-close): arm a bounded TTL-only tombstone (no Stream Count is known) and
   * drop the routing entry, in one synchronous step with NO await between. This
   * closes the window in which a stream/object arriving during a later await
   * (session teardown, request-stream reset) would find no route and leak to the
   * generic onObject hook. The async early-discard of already-open streams runs
   * afterward via {@link discardOpenStreamsForAlias}.
   */
  private armSubscriberAliasTeardown(alias: bigint): void {
    this.refreshAliasDeliveryTimeout(alias); // §8: reflect any accepted REQUEST_UPDATE before arming
    this.armTerminatedAlias(alias, null, /* strict */ false); // TTL-only; refuses reuse until it expires
    this.rawAliasMaps.delete(alias);
  }

  /** Early-discard (STOP_SENDING) every incoming subgroup stream open on `alias`. */
  private async discardOpenStreamsForAlias(alias: bigint): Promise<void> {
    for (const [sid, a] of [...this.incomingSubgroupAliases]) {
      if (a === alias) await this.stopIncomingSubgroupStream(sid);
    }
  }

  /** Clear an alias tombstone (cancel its TTL timer) and its seen-count. */
  private clearTerminatedAlias(alias: bigint): void {
    const t = this.terminatedAliases.get(alias);
    if (t) { t.cancelTimer(); this.terminatedAliases.delete(alias); }
    this.aliasStreamsSeen.delete(alias);
    this.aliasDeliveryTimeoutMs.delete(alias);
    this.aliasPublisherTimeout.delete(alias);
  }

  /**
   * Schedule `onElapsed` after `totalMs`, re-arming in ≤ {@link MAX_TIMER_MS} chunks
   * so an effective delivery timeout larger than setTimeout's 32-bit range (e.g. a
   * 2^62-1 varint) does NOT overflow into an immediate ~1 ms fire (§8 / finding).
   * `totalMs` is clamped to a safe integer. Returns a cancel function. All timers
   * are unref'd so they never keep the process alive.
   */
  private armGuardTimer(totalMs: number, onElapsed: () => void): () => void {
    let remaining = Math.max(0, Math.min(totalMs, Number.MAX_SAFE_INTEGER));
    let handle: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      if (remaining <= 0) { onElapsed(); return; }
      const chunk = Math.min(remaining, MoqtConnection.MAX_TIMER_MS);
      remaining -= chunk;
      handle = setTimeout(tick, chunk);
      (handle as { unref?: () => void }).unref?.();
    };
    tick();
    return () => clearTimeout(handle);
  }

  /**
   * Arm (or refresh) a bounded terminal tombstone for `alias`, installed
   * SYNCHRONOUSLY: the routing is dropped and the tombstone recorded before any
   * await, so a late stream/datagram racing the STOP_SENDING that follows is
   * already covered. `remaining` counts expected late streams (bigint), or
   * `null` when the count is unknown (2^62-1 sentinel) — then only the TTL clears
   * it. `strict` marks a PUBLISH_DONE Stream-Count tombstone vs an
   * ordinary-teardown guard; both REFUSE alias reuse while live (only a COMPLETE
   * strict tombstone is reuse-safe — see {@link aliasReuseSafe}) — the flag only
   * governs count-driven clearing and the no-downgrade rule below. A tombstone
   * always carries a TTL so it is bounded regardless.
   */
  private armTerminatedAlias(alias: bigint, remaining: bigint | null, strict: boolean): void {
    // No more objects routed for this alias — drop BOTH routing maps (an alias
    // lives in one or the other): the inbound-PUBLISH map AND the outbound-
    // subscribe map (the latter matters for a legacy control-stream PUBLISH_DONE,
    // where no request-stream close tears rawAliasMaps down separately).
    this.publishAliasMaps.delete(alias);
    this.rawAliasMaps.delete(alias);
    const existing = this.terminatedAliases.get(alias);
    // Do NOT downgrade a STRICT Stream-Count tombstone (which tracks outstanding
    // old streams for §11.1) to a non-strict ordinary-teardown guard: the
    // request-stream FIN that follows a PUBLISH_DONE would otherwise clobber the
    // count and let a reused alias misdeliver the old stream.
    if (existing?.strict && !strict) return;
    if (existing) existing.cancelTimer();
    // §10.11: the guard must outlive the effective delivery timeout — floor its TTL
    // by the alias's §8 effective delivery timeout when that exceeds the default.
    // Chunked so a huge (but valid) timeout cannot overflow setTimeout to ~1 ms.
    const ttlMs = Math.max(this.terminatedAliasTtlMs, this.aliasDeliveryTimeoutMs.get(alias) ?? 0);
    const cancelTimer = this.armGuardTimer(ttlMs, () => this.clearTerminatedAlias(alias));
    this.terminatedAliases.set(alias, { remaining, cancelTimer, strict });
  }

  /**
   * Apply a PUBLISH_DONE Stream Count to `alias` on the RECEIVER (§10.11 / §9.15).
   * The tombstone is installed SYNCHRONOUSLY first (so a stream/datagram arriving
   * during the STOP_SENDING awaits below is already discarded), THEN every stream
   * currently open for the alias is early-discarded. Late streams beyond those
   * already seen are counted down as they arrive; the tombstone clears once the
   * announced count is met OR the TTL expires. A 2^62-1 Stream Count means the
   * publisher could not give an exact count — the tombstone then relies on the
   * TTL alone (never auto-clears by counting). Bounded either way.
   */
  private async applyTerminalStreamCount(alias: bigint, streamCount: bigint, owningRequestId: bigint): Promise<void> {
    // Generation ownership: only tear down / guard the alias when its CURRENT
    // route still belongs to the terminating request. A crossed OLD PUBLISH_DONE
    // whose alias was already reused by a newer subscription must NOT erase the
    // new route (§11.1). `undefined` owner (no live route) is the terminating
    // request's own already-partly-torn-down subscription — proceed.
    const owner = this.rawAliasMaps.get(alias)?.requestId
      ?? this.publishAliasMaps.get(alias)?.requestId;
    if (owner !== undefined && owner !== owningRequestId) return;

    // 1) Install terminal state synchronously (before any await).
    // §8: re-derive the effective delivery timeout from the subscription's COMMITTED
    // state (an accepted REQUEST_UPDATE commits on REQUEST_OK) BEFORE arming — else
    // the guard uses a stale/default timeout and can expire while late streams for
    // the updated window are still valid.
    this.refreshAliasDeliveryTimeout(alias);
    const seen = this.aliasStreamsSeen.get(alias) ?? 0n;
    const remaining: bigint | null = streamCount === MoqtConnection.STREAM_COUNT_UNKNOWN
      ? null // §9.15 sentinel: exact count unknown — rely on the TTL only
      : (streamCount - seen > 0n ? streamCount - seen : 0n);
    this.armTerminatedAlias(alias, remaining, /* strict */ true);
    // 2) Early-discard every stream currently open for the alias.
    for (const [sid, a] of [...this.incomingSubgroupAliases]) {
      if (a === alias) await this.stopIncomingSubgroupStream(sid);
    }
  }

  /**
   * Handle control messages for track subscriptions.
   * Returns true if the message was consumed (suppress onMessage).
   */
  private handleRawSubControlMessage(msg: ControlMessage): boolean {
    if (msg.type === 'SUBSCRIBE_OK' && 'requestId' in msg && 'trackAlias' in msg) {
      const reqId = BigInt((msg as any).requestId);
      const raw = this.rawSubscriptions.get(reqId);
      if (raw) {
        const alias = BigInt((msg as any).trackAlias);
        // Alias-reuse safety and the complete-guard clear were already handled by
        // handleSubscribeOkOrdered — AFTER the session validated + registered the
        // alias, just before this call. Here we only bind routing + resolve.
        raw.trackAlias = alias;
        (raw.sub as { trackAlias: bigint }).trackAlias = alias;
        this.rawAliasMaps.set(alias, raw);
        // §8/§10.11: record the EFFECTIVE delivery timeout for this alias so a later
        // teardown's guard outlives the window in which the publisher may still
        // deliver old-alias streams — combining the publisher's Track Properties
        // (in this SUBSCRIBE_OK) with the subscriber's requested Message Parameters.
        // Retain the publisher's raw values so a later REQUEST_UPDATE (§8) can
        // re-derive the effective timeout with a new subscriber value.
        const okProps = this.trackPropsOf(msg);
        this.aliasPublisherTimeout.set(alias, {
          obj: this.trackPropMs(okProps, 0x02n) ?? 0, sub: this.trackPropMs(okProps, 0x06n) ?? 0,
        });
        const eff = this.effectiveDeliveryTimeoutMs(
          this.session.getSubscription(reqId)?.requestedDeliveryTimeoutMs, msg,
        );
        if (eff > 0) this.aliasDeliveryTimeoutMs.set(alias, eff);
        raw.resolve?.(raw.sub);
        raw.resolve = null;
        raw.reject = null;
        return true; // suppress onMessage
      }
    }
    if (msg.type === 'REQUEST_ERROR' && 'requestId' in msg) {
      const reqId = BigInt((msg as any).requestId);
      const raw = this.rawSubscriptions.get(reqId);
      if (raw) {
        const errMsg = msg as any;
        raw.reject?.(new Error(`Subscribe failed: ${errMsg.errorReason} (${errMsg.errorCode})`));
        raw.resolve = null;
        raw.reject = null;
        this.rawSubscriptions.delete(reqId);
        return true;
      }
    }
    return false;
  }

  /**
   * Send REQUEST_UPDATE to modify an existing subscription.
   *
   * Used for pause (forward:0) and resume (forward:1).
   * The forward state is not updated locally until REQUEST_OK is received.
   *
   * @param existingRequestId The request ID of the subscription to update
   * @param options Update options (forward, subscriberPriority, etc.)
   * @returns The request ID allocated for the update
   * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE)
   * @see draft-ietf-moq-transport-16 §9.2.2.8 (FORWARD parameter)
   */
  async requestUpdate(
    existingRequestId: bigint,
    options?: RequestUpdateOptions,
  ): Promise<bigint> {
    if (this.session.draftVersion === 18) {
      // Local REQUEST_UPDATE is only valid for an inbound PUBLISH (we are the
      // subscriber there). For an inbound SUBSCRIBE we are the publisher — the
      // peer updates that subscription, not us — so it is NOT eligible here.
      const inboundCtx = this.inboundRequestContexts.get(existingRequestId);
      if (inboundCtx && inboundCtx.openerKind === 'publish') {
        // The update rides the inbound PUBLISH stream; its REQUEST_OK /
        // REQUEST_ERROR is matched FIFO by the context.
        const { requestId, actions } = this.session.updateIncomingSubscription(existingRequestId, options);
        const updateMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
        // The delivery runs INSIDE the context's read loop (wire-order barrier)
        // so a PUBLISH_DONE coalesced behind the REQUEST_OK is applied after it.
        // On a write failure the peer never received the update — roll back the
        // pending record (the topology drops its own FIFO slot) so no response is
        // mis-correlated to an update that never went out.
        try {
          await inboundCtx.sendUpdate(updateMsg, (m) => this.deliverRequestResponse(m, requestId));
        } catch (err) {
          this.session.rollbackRequestUpdate(requestId);
          // §11.4.1: the update write failed → the inbound PUBLISH request stream is
          // dead. Use the SAME owner-checked inbound-PUBLISH teardown as a failed
          // acceptance: aborting the context alone suppresses onClosed, so we must
          // ALSO drop publishAliasMaps and arm the terminal-alias guard — otherwise
          // the route stays live and a late/independent data stream on the alias
          // would keep reaching the application.
          const pubAlias = [...this.publishAliasMaps].find(([, p]) => p.requestId === existingRequestId)?.[0];
          if (pubAlias !== undefined) {
            await this.rollbackFailedAcceptance(existingRequestId, pubAlias, /* isPublishInitiated */ true);
          } else {
            await this.executeActions(this.session.handleInboundRequestClosed(existingRequestId));
            this.inboundRequestContexts.delete(existingRequestId);
            try { await inboundCtx.abort(); } catch { /* already torn down */ }
          }
          throw err instanceof Error ? err : new Error(String(err));
        }
        return requestId;
      }
      // draft-18 §10.9.2: an outbound SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS rides
      // a CONTINUING request stream. A prefix update is written on it and matched
      // FIFO to its REQUEST_OK / REQUEST_ERROR (which still interleave with
      // NAMESPACE / PUBLISH_BLOCKED continuations).
      if (this.uniPair!.hasContinuingRequest(existingRequestId)) {
        const { requestId, actions } = this.session.requestUpdate(existingRequestId, options);
        const updateMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
        try {
          await this.uniPair!.sendUpdateOnContinuing(
            existingRequestId, updateMsg,
            (m) => this.deliverRequestResponse(m, requestId), // stamps + applies REQUEST_OK, in wire order
          );
        } catch (err) {
          this.session.rollbackRequestUpdate(requestId);
          throw err instanceof Error ? err : new Error(String(err));
        }
        return requestId;
      }
      // draft-18: the REQUEST_UPDATE is sent on the EXISTING request stream that
      // targets existingRequestId — not a new stream. Guard clearly if none.
      if (!this.uniPair!.hasRequestStream(existingRequestId)) {
        throw new Error(`requestUpdate: no open draft-18 request stream for request ${existingRequestId}`);
      }
      const { requestId, actions } = this.session.requestUpdate(existingRequestId, options);
      const updateMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      // The response (REQUEST_OK/REQUEST_ERROR) correlates to the UPDATE's own
      // requestId, not the original — routeRequestResponse stamps with handle.requestId.
      let stream: RequestStream;
      try {
        stream = await this.uniPair!.sendUpdate(
          existingRequestId, updateMsg,
          (m) => this.deliverRequestResponse(m, requestId),
        );
      } catch (err) {
        // The write failed: the peer never received the update. Roll back the
        // pending record (the topology already dropped its FIFO slot in send()).
        this.session.rollbackRequestUpdate(requestId);
        throw err instanceof Error ? err : new Error(String(err));
      }
      this.routeRequestResponse(stream);
      return requestId;
    }
    const { requestId, actions } = this.session.requestUpdate(
      existingRequestId,
      options,
    );
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Unsubscribe from an established subscription.
   *
   * §2.4.2: "When a subscriber detects a Malformed Track, it MUST
   * UNSUBSCRIBE any subscription [...] for that Track from that publisher."
   *
   * draft-14/16 send an UNSUBSCRIBE control message; draft-18 removed it, so
   * cancellation is request-stream teardown (RESET_STREAM + STOP_SENDING, §3.3.2)
   * plus local state cleanup.
   *
   * @param requestId The request ID of the subscription to unsubscribe
   * @see draft-ietf-moq-transport-16 §2.4.2 (Malformed Track), draft-18 §3.3.2
   */
  async unsubscribe(requestId: bigint): Promise<void> {
    // §5.1.1: arm terminal alias protection SYNCHRONOUSLY — before session
    // teardown, the request-stream reset, or dropping routing — so a late object
    // arriving during any of those awaits is discarded, never routed to the
    // generic onObject hook. Centralized in teardownSubscriberAlias so this
    // direct API, the TrackSubscription wrapper, and the peer-close path all
    // arm at the same point and cannot diverge.
    const raw = this.rawSubscriptions.get(requestId);
    if (raw && raw.trackAlias !== null && this.rawAliasMaps.get(raw.trackAlias) === raw) {
      this.armSubscriberAliasTeardown(raw.trackAlias);
    }

    const actions = this.session.unsubscribe(requestId); // draft-18 returns no send_control
    await this.executeActions(actions);
    if (this.session.draftVersion === 18) {
      // Reset the subscribe request stream; this is the draft-18 cancellation
      // signal (a LOCAL cancel — the response handler ignores the resulting
      // RequestCancelledError, so it surfaces no onError).
      await this.uniPair!.cancelRequest(requestId);
      const current = this.rawSubscriptions.get(requestId) ?? raw;
      if (current && current.trackAlias !== null) {
        // Tombstone already armed above; now early-discard open streams.
        await this.discardOpenStreamsForAlias(current.trackAlias);
      }
    }
    // Drop the raw subscription for EVERY draft: draft-14/16 has no request-stream
    // close to reclaim it, so without this the subscription object + its onObject
    // callback would leak after unsubscribe.
    this.rawSubscriptions.delete(requestId);
  }

  /**
   * Close the session. Sends close_connection to the transport.
   *
   * A quiet, intentional local close: it does NOT fire onClose (there is no
   * remote event to report), but it MARKS the connection terminated so the
   * ensuing `transport.closed` fulfillment — which our watcher observes when we
   * close the transport — does not race in a duplicate onClose.
   */
  async close(error?: Varint, reason?: string): Promise<void> {
    // Mark terminated + emitted FIRST so the transport-close watcher stays quiet
    // (a quiet local close fires no onClose, and cannot be upgraded into one).
    this._terminated = true;
    this._closeEmitted = true;
    const actions = this.session.close(error, reason);
    await this.executeActions(actions);
    // A local close must not leave a caller awaiting subscribeTrack() forever.
    this.failPendingRawSubscriptions(reason ?? 'Session closed');
    // Drop all timers + publisher/receiver accounting with the session.
    this.clearTerminalState();
  }

  /**
   * Send a GOAWAY on the control stream (§10.4) to begin draining the session.
   * This only WRITES the message: it does NOT migrate, reconnect, or start a
   * timeout timer — those remain application/timer concerns. A server MAY supply a
   * `newSessionUri`; a client MUST leave it empty. For draft-18, `requestId` (the
   * smallest peer Request ID that may be unprocessed) is required by the receiver
   * and MUST match the peer's request-id parity.
   * @see draft-ietf-moq-transport-18 §10.4
   */
  async sendGoaway(options: { newSessionUri?: string; timeout?: bigint; requestId?: bigint } = {}): Promise<void> {
    const newSessionUri = options.newSessionUri ?? '';

    if (this.session.draftVersion === 18) {
      // §10.4 local guards — never emit an invalid control-stream GOAWAY. The peer
      // would reject these; refuse to put them on the wire in the first place.
      if (options.requestId === undefined) {
        throw new MoqtConnectionError('sendGoaway (draft-18): a control-stream GOAWAY requires a Request ID', { errorSource: 'control' });
      }
      if (this._role === EndpointRole.CLIENT && newSessionUri.length > 0) {
        throw new MoqtConnectionError('sendGoaway (draft-18): a client MUST send a zero-length New Session URI', { errorSource: 'control' });
      }
      // The Request ID refers to the RECEIVER's request IDs, so it must carry the
      // peer's parity: server→client is even, client→server is odd.
      const expectedParity = this._role === EndpointRole.SERVER ? 0n : 1n;
      if ((options.requestId & 1n) !== expectedParity) {
        throw new MoqtConnectionError(
          `sendGoaway (draft-18): Request ID ${options.requestId} has the wrong parity for the peer (expected ${expectedParity === 0n ? 'even' : 'odd'})`,
          { errorSource: 'control' },
        );
      }
      const message: Goaway = { type: 'GOAWAY', newSessionUri, timeout: options.timeout ?? 0n, requestId: options.requestId };
      await this.uniPair!.sendControl(message); // draft-18 control stream is the uni pair
      return;
    }

    // draft-14/16: URI-only GOAWAY on the bidi control stream (unchanged).
    const message: Goaway = {
      type: 'GOAWAY',
      newSessionUri,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    };
    await this.executeActions([{ type: 'send_control', message }]);
  }

  /**
   * Subscribe to a namespace prefix for dynamic track discovery.
   *
   * Opens a new bidirectional stream, sends SUBSCRIBE_NAMESPACE, and
   * starts a background read loop for responses (REQUEST_OK/REQUEST_ERROR,
   * NAMESPACE, NAMESPACE_DONE).
   *
   * @param namespacePrefix The namespace prefix to subscribe to
   * @param subscribeOptions Subscribe options (default: 0)
   * @returns The request ID for this namespace subscription
   * @see draft-ietf-moq-transport-16 §6.1
   */
  async subscribeNamespace(
    namespacePrefix: Uint8Array[],
    subscribeOptions?: Varint,
  ): Promise<bigint> {
    const { requestId, actions } = this.session.subscribeNamespace(
      namespacePrefix,
      subscribeOptions,
    );
    if (this.session.draftVersion === 18) {
      // draft-18 §10.18: SUBSCRIBE_NAMESPACE opens a CONTINUING request stream.
      // The first response (REQUEST_OK / REQUEST_ERROR) goes through the normal
      // stamped pipeline; subsequent NAMESPACE / NAMESPACE_DONE are routed to
      // onNamespaceMessage + session.handleNamespaceStreamMessage. The handler is
      // awaited per message, so the first REQUEST_OK fully transitions the
      // subscription to ACTIVE before any NAMESPACE is processed.
      const action = actions.find((a) => a.type === 'open_namespace_stream') as OpenNamespaceStreamAction;
      let closed: Promise<void>;
      try {
        ({ closed } = await this.uniPair!.openContinuingRequest(
          this.transport!,
          action.message,
          (rid, msg, kind) => {
            if (kind === 'first') return this.deliverRequestResponse(msg, rid);
            this.onNamespaceMessage?.(rid, msg as ControlMessage);
            return this.executeActions(this.session.handleNamespaceStreamMessage(rid, msg as ControlMessage));
          },
        ));
      } catch (err) {
        // Request-stream open failed → reclaim the pending namespace subscription.
        await this.executeActions(this.session.handleNamespaceStreamClosed(requestId));
        throw err instanceof Error ? err : new Error(String(err));
      }
      void this.handleNamespaceStreamClosed(requestId, closed);
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Background handler for a draft-18 SUBSCRIBE_NAMESPACE response stream ending.
   * A clean FIN treats active namespaces as done (§10.18); a stream-ordering
   * PROTOCOL_VIOLATION closes the whole session; any other error is surfaced.
   */
  private async handleNamespaceStreamClosed(requestId: bigint, closed: Promise<void>): Promise<void> {
    try {
      await closed;
      await this.executeActions(this.session.handleNamespaceStreamClosed(requestId));
    } catch (err) {
      if (err instanceof ProtocolViolationError) {
        this.closeSessionFatal(err.message);
        return;
      }
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
      ));
    }
  }

  /**
   * Subscribe to tracks within matching namespaces (draft-18 §10.19, draft-18
   * only). Like subscribeNamespace, this opens a CONTINUING bidi request stream:
   * the first REQUEST_OK / REQUEST_ERROR goes through the stamped pipeline, and
   * follow-up PUBLISH_BLOCKED messages are routed to onPublishBlocked +
   * session.handleSubscribeTracksStreamMessage. PUBLISH for matched tracks
   * arrives on its own inbound bidi stream (onPublish), not on this stream.
   *
   * @param namespacePrefix The namespace prefix to match.
   * @returns The request ID for this track subscription.
   */
  async subscribeTracks(namespacePrefix: Uint8Array[]): Promise<bigint> {
    const { requestId, actions } = this.session.subscribeTracks(namespacePrefix);
    const msg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
    let closed: Promise<void>;
    try {
      ({ closed } = await this.uniPair!.openContinuingRequest(
        this.transport!,
        msg,
        (rid, m, kind) => {
          if (kind === 'first') return this.deliverRequestResponse(m, rid);
          this.onPublishBlocked?.(rid, m as ControlMessage);
          return this.executeActions(this.session.handleSubscribeTracksStreamMessage(rid, m as ControlMessage));
        },
      ));
    } catch (err) {
      // Request-stream open failed → reclaim the pending track subscription.
      await this.executeActions(this.session.handleSubscribeTracksStreamClosed(requestId));
      throw err instanceof Error ? err : new Error(String(err));
    }
    void this.handleSubscribeTracksStreamClosed(requestId, closed);
    return requestId;
  }

  /** Background handler for a SUBSCRIBE_TRACKS response stream ending. */
  private async handleSubscribeTracksStreamClosed(requestId: bigint, closed: Promise<void>): Promise<void> {
    try {
      await closed;
      await this.executeActions(this.session.handleSubscribeTracksStreamClosed(requestId));
    } catch (err) {
      if (err instanceof ProtocolViolationError) {
        this.closeSessionFatal(err.message);
        return;
      }
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
      ));
    }
  }

  /**
   * Cancel a namespace subscription.
   *
   * Draft-16 §6.1: Close the bidi stream with FIN.
   * Draft-14 §9.31: Send UNSUBSCRIBE_NAMESPACE on the control stream.
   *
   * @param requestId The request ID of the namespace subscription to cancel
   * @see draft-ietf-moq-transport-16 §6.1
   * @see draft-ietf-moq-transport-14 §9.31
   */
  async cancelNamespace(requestId: bigint): Promise<void> {
    if (this.codec.version === 14) {
      // Draft-14: send UNSUBSCRIBE_NAMESPACE on the control stream
      const actions = this.session.cancelNamespace(requestId);
      await this.executeActions(actions);
      return;
    }

    if (this.session.draftVersion === 18) {
      // draft-18 §10.18: gracefully close the continuing request stream.
      await this.uniPair!.closeContinuingRequest(requestId);
      return;
    }

    // Draft-16: close the bidi stream
    const writer = this.namespaceStreams.get(requestId as bigint);
    if (!writer) return;

    try {
      await writer.close();
    } catch {
      // Stream may already be closed — ignore
    }
    this.namespaceStreams.delete(requestId as bigint);
  }

  /**
   * Cancel a SUBSCRIBE_TRACKS subscription (draft-18 §10.19). Mirrors
   * {@link cancelNamespace}: gracefully closes the continuing request stream
   * (FIN our writable + STOP_SENDING the readable), ending PUBLISH_BLOCKED /
   * PUBLISH continuation. SUBSCRIBE_TRACKS is draft-18-only, so there is no
   * draft-14/16 path. No-op if no such stream is open.
   *
   * @param requestId The request ID of the track subscription to cancel
   */
  async cancelTracks(requestId: bigint): Promise<void> {
    if (this.session.draftVersion === 18) {
      await this.uniPair!.closeContinuingRequest(requestId);
    }
  }

  /**
   * Fetch a range of already-published objects from a track.
   *
   * draft-14/16: sends a Standalone FETCH on the control stream.
   * draft-18: opens its own bidi request stream (like SUBSCRIBE); the FETCH_OK /
   * REQUEST_ERROR reply correlates by stream and is stamped with this requestId.
   *
   * @param namespace Track namespace
   * @param name Track name
   * @param options Fetch range (startGroup, startObject, endGroup, endObject)
   * @returns The request ID for this fetch
   * @see draft-ietf-moq-transport-16 §9.16, draft-ietf-moq-transport-18 §10.12
   */
  async fetch(
    namespace: Uint8Array[],
    name: Uint8Array,
    options: FetchOptions,
  ): Promise<bigint> {
    const { requestId, actions } = this.session.fetch(namespace, name, options);
    if (this.session.draftVersion === 18) {
      // draft-18: FETCH opens its own bidi request stream rather than travelling
      // on the control stream. Same machinery as subscribe(). Remember the
      // requested Group Order so the fetch-object decoder can read deltas.
      this.fetchGroupOrder.set(requestId, options.groupOrder ?? 'ascending');
      const fetchMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      // Roll back the outbound group-order entry on open failure (else a phantom
      // fetch could shape a later object decode / authorize unsolicited data).
      await this.openD18Request(requestId, fetchMsg, () => this.fetchGroupOrder.delete(requestId));
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Create a Joining Fetch (§9.16.2 / draft-18 §10.12.2) referencing one of
   * our subscriptions in PENDING or ESTABLISHED state. The publisher derives
   * namespace, name, and range from the referenced subscription's Largest
   * Location, contiguous with (never overlapping) the live delivery.
   *
   * draft-18: opens its own bidi request stream, like {@link fetch}.
   * draft-14/16: travels on the shared control stream.
   *
   * @returns The request ID for this fetch (cancel with {@link fetchCancel}).
   * @throws {SessionError} INVALID_STATE if `joiningRequestId` is not one of
   *   our PENDING/ESTABLISHED subscriptions — nothing is emitted on the wire.
   */
  async joiningFetch(options: JoiningFetchOptions): Promise<bigint> {
    const { requestId, actions } = this.session.joiningFetch(options);
    if (this.session.draftVersion === 18) {
      this.fetchGroupOrder.set(requestId, options.groupOrder ?? 'ascending');
      const fetchMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      await this.openD18Request(requestId, fetchMsg, () => this.fetchGroupOrder.delete(requestId));
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Resolve an incoming Joining Fetch against this publisher's Largest
   * Location for the referenced subscription's track (§9.16.2.1). Back-fills
   * the session's fetch range and returns the standalone-equivalent range in
   * the FETCH wire convention (endLocation.object is one-past the last
   * delivered object) — serve exactly `[startLocation, endLocation)` then
   * {@link acceptFetch} with this `endLocation`.
   */
  resolveJoiningFetch(
    requestId: bigint,
    largest: { group: bigint; object: bigint },
  ): { startLocation: { group: bigint; object: bigint }; endLocation: { group: bigint; object: bigint } } {
    return this.session.resolveIncomingJoiningFetch(requestId, largest);
  }

  /**
   * Cancel an active fetch.
   *
   * draft-14/16: sends FETCH_CANCEL on the control stream, and STOP_SENDING on
   * the associated data stream if open.
   *   §9.18: "A subscriber sends a FETCH_CANCEL message to a publisher to
   *   indicate it is no longer interested in receiving objects for the fetch
   *   identified by the 'Request ID'."
   *   §5.2: "If the data stream is already open, it MAY send STOP_SENDING for
   *   the data stream along with FETCH_CANCEL, but MUST send FETCH_CANCEL."
   *
   * draft-18: FETCH_CANCEL was REMOVED; cancellation is STOP_SENDING /
   * RESET_STREAM on the bidi request stream and the fetch data stream (§3.3.2).
   * No control message is sent.
   *
   * @param requestId The request ID of the fetch to cancel
   * @see draft-ietf-moq-transport-16 §5.2, §9.18; draft-ietf-moq-transport-18 §3.3.2
   */
  async fetchCancel(requestId: bigint): Promise<void> {
    // §5.2: the fetch may already have ended (its data stream FIN'd/reset → reclaimed
    // by handleFetchStreamFinished, or a REQUEST_ERROR). Cancelling a fetch that is
    // already gone is a NO-OP, not an error — makes fetchCancel idempotent and safe
    // to call racing the terminal.
    if (this.session.getFetch(requestId) === undefined) return;
    // §10.13: install the late-stream cancellation marker SYNCHRONOUSLY — BEFORE any
    // await below — so a data stream arriving during the teardown awaits is discarded
    // (see the FETCH_HEADER handler), never delivered to onObject. The marker is
    // LOSSLESS (no cap / no eviction): a late data stream may be arbitrarily delayed,
    // so forgetting a cancellation would turn its late stream into a §9.1 false close.
    // It is the SOLE provenance for "a stream for a fetch WE cancelled" — a missing
    // marker means the stream is NOT a cancelled fetch (completed / unknown / wrong
    // request kind) and is a protocol violation. Consumed one-shot on the late stream.
    this.recentlyCancelledFetches.add(requestId as bigint);
    // Mark the fetch completed. draft-18 returns no actions (FETCH_CANCEL was
    // removed); draft-14/16 returns a FETCH_CANCEL to send.
    const actions = this.session.fetchCancel(requestId);
    await this.executeActions(actions);

    if (this.session.draftVersion === 18) {
      // §3.3.2: cancel the bidi request stream (STOP_SENDING + RESET_STREAM).
      // This is a LOCAL cancel, so the request-stream response handler ignores
      // the resulting RequestCancelledError (no onError, no unhandled rejection).
      await this.uniPair!.cancelRequest(requestId);
    }

    // Also STOP_SENDING the fetch DATA stream if one is open (both drafts).
    const streamId = this.fetchStreams.get(requestId as bigint);
    if (streamId !== undefined) {
      const reader = this.dataStreamReaders.get(streamId);
      if (reader) {
        try {
          await reader.cancel(new Error('FETCH cancelled'));
        } catch {
          // Stream may already be closed
        }
        this.dataStreamReaders.delete(streamId);
      }
      this.fetchStreams.delete(requestId as bigint);
      // The known open response stream is torn down HERE, so the marker that guards a
      // NOT-yet-arrived late stream is redundant for it — CONSUME it. Cancelling a
      // reader blocked in read() ends the loop via `done` WITHOUT revisiting the
      // loop-top marker check, and the finalizer does not clear it either, so a
      // lossless marker would otherwise linger forever. Keep the marker only when NO
      // response stream has appeared yet (streamId === undefined) — then it is still
      // needed to discard the eventual late stream.
      this.recentlyCancelledFetches.delete(requestId as bigint);
    }
    // draft-18 per-request group-order state is no longer needed.
    this.fetchGroupOrder.delete(requestId as bigint);
  }

  /**
   * Query the status of a track without creating a subscription.
   *
   * draft-14/16: sends TRACK_STATUS on the control stream.
   * draft-18: TRACK_STATUS is the first and only message on its own bidi request
   * stream (§10.14); the topology FINs our writable after sending. The response
   * (REQUEST_OK — a.k.a. TRACK_STATUS_OK — or REQUEST_ERROR) correlates by stream
   * and is stamped with this requestId, then routed through the normal pipeline.
   *
   * @param namespace Track namespace
   * @param name Track name
   * @returns The request ID for this query
   * @see draft-ietf-moq-transport-16 §9.19, draft-ietf-moq-transport-18 §10.14
   */
  async trackStatus(
    namespace: Uint8Array[],
    name: Uint8Array,
  ): Promise<bigint> {
    const { requestId, actions } = this.session.trackStatus(namespace, name);
    if (this.session.draftVersion === 18) {
      const msg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      await this.openD18Request(requestId, msg);
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Send STOP_SENDING on an incoming data stream.
   *
   * §10.4.3: "A subscriber MAY send a QUIC STOP_SENDING frame for a
   * subgroup stream if the Group or Subgroup is no longer of interest
   * to it. The publisher SHOULD respond with RESET_STREAM."
   *
   * @param streamId The stream to stop receiving from
   * @param error Error code (e.g., CANCELLED=0x1)
   * @see draft-ietf-moq-transport-16 §10.4.3
   */
  async stopSending(streamId: bigint, error: Varint): Promise<void> {
    await this.executeActions([
      { type: 'stop_sending' as const, streamId, error },
    ]);
  }

  // ─── Publisher Operations ───────────────────────────────────────

  /**
   * Advertise a namespace that this endpoint can publish on.
   *
   * draft-14/16: sends PUBLISH_NAMESPACE on the control stream.
   * draft-18: PUBLISH_NAMESPACE opens its own bidi request stream (§10.15) and the
   * stream STAYS OPEN — unlike TRACK_STATUS it is not one-shot: §10.9 allows a
   * later REQUEST_UPDATE and §3.3.2 makes withdrawal a stream cancellation. The
   * response (REQUEST_OK — a.k.a. PUBLISH_NAMESPACE_OK — or REQUEST_ERROR) is
   * stamped with this requestId and routed through the normal pipeline.
   *
   * @param namespace The namespace to advertise
   * @returns The request ID for this namespace publication
   * @see draft-ietf-moq-transport-16 §6.2, draft-ietf-moq-transport-18 §10.15
   */
  async publishNamespace(namespace: Uint8Array[]): Promise<bigint> {
    const { requestId, actions } = this.session.publishNamespace(namespace);
    if (this.session.draftVersion === 18) {
      const msg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      await this.openD18Request(requestId, msg);
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Withdraw an announced namespace — stops serving new subscriptions.
   * The namespace must have been accepted (REQUEST_OK / PUBLISH_NAMESPACE_OK).
   *
   * draft-14/16: emits PUBLISH_NAMESPACE_DONE on the control stream.
   * draft-18: PUBLISH_NAMESPACE_DONE was removed (§3.3.2) — withdrawal cancels the
   * PUBLISH_NAMESPACE request stream (RESET_STREAM + STOP_SENDING). No control
   * bytes are written; local state is terminated by the session.
   *
   * @param requestId The request ID from publishNamespace()
   * @see draft-ietf-moq-transport-16 §9.22, draft-ietf-moq-transport-18 §3.3.2
   */
  async publishNamespaceDone(requestId: bigint): Promise<void> {
    const actions = this.session.publishNamespaceDone(requestId);
    if (this.session.draftVersion === 18) {
      // Terminate local state (no send_control action) and cancel the request
      // stream — that cancellation IS the draft-18 withdrawal signal.
      await this.executeActions(actions);
      await this.uniPair!.cancelRequest(requestId);
      return;
    }
    await this.executeActions(actions);
  }

  /**
   * Accept an incoming subscription request from a remote subscriber, sending
   * SUBSCRIBE_OK and transitioning the subscription to ESTABLISHED.
   *
   * draft-18 writes SUBSCRIBE_OK on the inbound SUBSCRIBE's own bidi request stream
   * (also the PUBLISH_OK shorthand for an inbound PUBLISH); draft-14/16 send it on
   * the control stream.
   *
   * `options` (draft-18) may carry SUBSCRIBE_OK `parameters` and `trackProperties`
   * (§2.5); non-empty Track Properties on draft-14/16 throw. The two-argument form
   * remains valid.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE
   * @param trackAlias The track alias to assign
   * @param options Optional `{ parameters?, trackProperties? }`
   * @see draft-ietf-moq-transport-16 §9.10, draft-ietf-moq-transport-18 §10.8
   */
  async acceptSubscribe(
    requestId: bigint,
    trackAlias: bigint,
    options?: { parameters?: Parameters; trackProperties?: TrackProperties },
  ): Promise<void> {
    // Role check: an inbound PUBLISH (publish-initiated) makes US the SUBSCRIBER —
    // accepting it must NOT authorize us to publish on its alias. Only an inbound
    // SUBSCRIBE (we are the publisher) grants publisher data-plane authority.
    const incoming = this.session.getIncomingSubscription(requestId);
    const isPublishInitiated = incoming?.isPublishInitiated ?? false;
    // For an inbound PUBLISH the alias is fixed by the publisher on the wire — the
    // acceptance MUST NOT rebind it to a different value.
    if (isPublishInitiated && incoming?.trackAlias !== undefined && trackAlias !== incoming.trackAlias) {
      throw new MoqtConnectionError(
        `acceptSubscribe alias ${trackAlias} does not match the PUBLISH's advertised alias ${incoming.trackAlias}`,
        { errorSource: 'control' },
      );
    }
    const actions = this.session.acceptSubscribe(requestId, trackAlias, options);
    // §5.1: the acceptance may itself force a session close (e.g. the superseded-set
    // is at capacity, §5.1). Then there is no acceptance to report — execute the
    // close, settle parked joins as NOT accepted, and reject rather than resolving
    // as success.
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      this.notifyClose(closeAction, 'acceptSubscribe forced a session close');
      await this.settleParkedJoins(requestId, false);
      throw new MoqtConnectionError(
        `acceptSubscribe closed the session: ${closeAction.reason}`,
        { errorSource: 'control', isFatal: true },
      );
    }
    // §10.11: authorize publisher data-plane ops (openSubgroup / sendObject /
    // sendDatagram) on this alias ONLY for an inbound SUBSCRIBE we serve — never for
    // an inbound PUBLISH, where we are the subscriber.
    if (!isPublishInitiated) this.publisherAliasRequests.set(trackAlias, requestId);
    // §8: for an inbound PUBLISH (we are the subscriber), COMPUTE the effective
    // timeout by combining the publisher's Track-Property timeouts (captured at bind)
    // with OUR PUBLISH_OK Message Parameters — but DEFER committing it until the
    // PUBLISH_OK write SUCCEEDS. The provisional (publisher-only) value stays in
    // aliasDeliveryTimeoutMs meanwhile, so a rollback after a failed write arms the
    // guard with a value the publisher DID receive, not our unsent subscriber timeout.
    let commitTimeout: (() => void) | undefined;
    if (isPublishInitiated) {
      const pub = this.inboundPublishTimeouts.get(requestId);
      this.inboundPublishTimeouts.delete(requestId);
      if (pub) {
        const subObj = this.paramTimeoutMs(options?.parameters, 0x02n);
        const subSub = this.paramTimeoutMs(options?.parameters, 0x06n);
        const eff = this.combineDeliveryTimeoutMs(pub.obj, pub.sub, subObj, subSub);
        commitTimeout = () => {
          if (eff > 0) this.aliasDeliveryTimeoutMs.set(trackAlias, eff);
          else this.aliasDeliveryTimeoutMs.delete(trackAlias);
        };
      }
    }
    // §5.1: run the NON-response actions (e.g. a cancel_request tearing down a
    // local SUBSCRIBE this PUBLISH supersedes) BEFORE writing the acceptance. The
    // session has already deleted that local subscription synchronously, so if the
    // acceptance write below rejects, the adapter-side teardown (reject the pending
    // subscribeTrack(), reset its request stream) must still have run — otherwise
    // its promise and stream leak.
    const nonResponse = actions.filter((a) => a.type !== 'send_control');
    if (nonResponse.length > 0) await this.executeActions(nonResponse);
    // §10.8: the acceptance response (SUBSCRIBE_OK / REQUEST_OK) rides the inbound
    // request's OWN bidi stream on draft-18. The Session already transitioned the
    // subscription to ESTABLISHED, so if that write REJECTS the peer never received
    // acceptance — roll back to avoid a ghost established subscription with live
    // routing and a publisher-alias association, and PROPAGATE the failure (this
    // acceptance did not succeed).
    let handled: boolean;
    try {
      handled = await this.writeInboundRequestResponse(requestId, actions);
    } catch (err) {
      await this.rollbackFailedAcceptance(requestId, trackAlias, isPublishInitiated);
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (handled) {
      commitTimeout?.(); // PUBLISH_OK reached the peer — now commit the combined timeout
      await this.flushDeferredUpdateResponses(requestId);
      await this.settleParkedJoins(requestId, true);
      return;
    }
    // draft-14/16: the send_control response(s) ride the control stream (the
    // non-response actions already ran above — do not repeat them). A control-stream
    // write failure is session-fatal and handled by the control loop, not per-request.
    await this.executeActions(actions.filter((a) => a.type === 'send_control'));
    commitTimeout?.(); // control-stream PUBLISH_OK sent — commit the combined timeout
    await this.flushDeferredUpdateResponses(requestId);
    await this.settleParkedJoins(requestId, true);
  }

  /**
   * Roll back an inbound subscription whose acceptance response failed to write
   * (§10.8). The peer never received SUBSCRIBE_OK / REQUEST_OK, so no established
   * subscription, publish routing, or publisher-alias association may survive:
   * terminate the request in the Session (§11.4.1), drop the publisher-alias
   * association, remove any inbound PUBLISH route (aborting the context suppresses
   * the normal onClosed cleanup that would otherwise remove it — without this, late
   * objects on the alias would keep reaching the application), and reset the stream.
   * The caller re-throws so the failed acceptance is not reported as success.
   */
  private async rollbackFailedAcceptance(requestId: bigint, trackAlias: bigint, isPublishInitiated: boolean): Promise<void> {
    this.publisherAliasRequests.delete(trackAlias);
    // For an inbound PUBLISH, tear down its route AND arm a bounded late-object
    // guard SYNCHRONOUSLY (before the first await), exactly like the inbound-FIN
    // teardown — a subgroup opened BEFORE the failed PUBLISH_OK and delivered after
    // would otherwise fall through to the connection-level onObject. Owner-checked
    // so a reused alias's newer publication is untouched.
    const ownsRoute = isPublishInitiated
      && this.publishAliasMaps.get(trackAlias)?.requestId === requestId;
    if (ownsRoute) this.armTerminatedAlias(trackAlias, null, /* strict */ false); // drops route + installs guard
    this.inboundPublishTimeouts.delete(requestId);
    await this.executeActions(this.session.handleInboundRequestClosed(requestId));
    const ctx = this.inboundRequestContexts.get(requestId);
    this.inboundRequestContexts.delete(requestId);
    if (ownsRoute) await this.discardOpenStreamsForAlias(trackAlias);
    if (ctx) { try { await ctx.abort(); } catch { /* already torn down */ } }
  }

  /** Write update responses deferred behind the subscribe's first response (§10.8), FIFO. */
  private async flushDeferredUpdateResponses(subRequestId: bigint): Promise<void> {
    const queued = this.deferredUpdateResponses.get(subRequestId);
    if (!queued) return;
    this.deferredUpdateResponses.delete(subRequestId);
    const ctx = this.inboundRequestContexts.get(subRequestId);
    if (!ctx) return; // stream already gone — nothing to write to
    for (const msg of queued) {
      try { await ctx.writeMessage(msg); } catch { break; /* stream torn down */ }
    }
  }

  /**
   * draft-18: if `requestId` names an inbound request stream, write its response
   * (SUBSCRIBE_OK / FETCH_OK / REQUEST_OK / REQUEST_ERROR) on THAT stream — not
   * the control stream — and return true. Otherwise return false so the caller
   * uses the normal path. When `finalize` is set (one-shot requests such as
   * TRACK_STATUS), FIN our writable, seal the stream, and drop the context.
   */
  private async writeInboundRequestResponse(
    requestId: bigint,
    actions: SessionOutboundAction[],
    finalize = false,
  ): Promise<boolean> {
    if (this.session.draftVersion !== 18) return false;
    const ctx = this.inboundRequestContexts.get(requestId);
    if (!ctx) return false;
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
    if (!send) return false;
    await ctx.writeMessage(send.message);
    if (finalize) {
      ctx.seal();           // any further inbound message is a protocol violation
      await ctx.terminate(); // FIN our writable + STOP_SENDING the readable (§3.3.2)
      this.inboundRequestContexts.delete(requestId);
    }
    return true;
  }

  /**
   * Reject an incoming subscription request from a remote subscriber, sending
   * REQUEST_ERROR and transitioning the subscription to TERMINATED.
   *
   * draft-18 writes REQUEST_ERROR on the inbound request's own bidi stream (also
   * used to reject an inbound PUBLISH); draft-14/16 send it on the control stream.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE
   * @param errorCode Error code (see §13.4)
   * @param reason Human-readable error reason
   * @see draft-ietf-moq-transport-16 §9.8, draft-ietf-moq-transport-18 §10.6
   */
  async rejectSubscribe(requestId: bigint, errorCode: bigint, reason: string): Promise<void> {
    // Capture the context BEFORE any await: the subscriber may react to the
    // REQUEST_ERROR by FINning its side immediately, and that close event
    // removes the map entry mid-flow — the terminal FIN below must still run.
    const rejectedCtx = this.inboundRequestContexts.get(requestId);
    // §10.11: rejecting an inbound PUBLISH we are the subscriber of — tear down its
    // route AND arm a late-object guard SYNCHRONOUSLY (before session.rejectSubscribe
    // deletes the state and before the response-write await), so a subgroup object
    // in flight after the REQUEST_ERROR cannot reach the rejected publication
    // callback. Owner-checked so a reused alias's newer publication is untouched.
    const incoming = this.session.getIncomingSubscription(requestId);
    const pubAlias = incoming?.isPublishInitiated ? incoming.trackAlias : undefined;
    const ownsRoute = pubAlias !== undefined && this.publishAliasMaps.get(pubAlias)?.requestId === requestId;
    if (ownsRoute) this.armTerminatedAlias(pubAlias, null, /* strict */ false);
    const actions = this.session.rejectSubscribe(requestId, errorCode, reason);
    if (await this.writeInboundRequestResponse(requestId, actions)) {
      // §10.8: REQUEST_ERROR is the subscription's first AND terminal response
      // — flush deferred update acknowledgements behind it, then close BOTH
      // directions (FIN our writable, STOP_SENDING the readable): a rejected
      // request stream must not stay half-open holding context or credit.
      await this.flushDeferredUpdateResponses(requestId);
      if (ownsRoute) await this.discardOpenStreamsForAlias(pubAlias);
      if (rejectedCtx) {
        rejectedCtx.seal();
        try { await rejectedCtx.terminate(); } catch { /* peer already tore it down */ }
        this.inboundRequestContexts.delete(requestId);
      }
      await this.settleParkedJoins(requestId, false);
      return;
    }
    await this.executeActions(actions);
    if (ownsRoute) await this.discardOpenStreamsForAlias(pubAlias);
    await this.flushDeferredUpdateResponses(requestId);
    await this.settleParkedJoins(requestId, false);
  }

  /**
   * Accept an incoming FETCH (§10.12). draft-18 writes FETCH_OK (no wire Request
   * ID) on the FETCH's own bidi request stream; draft-14/16 send it on the
   * control stream. Pass real FETCH_OK metadata via `options` (End Location may
   * be a full-uint64 draft-18 Location). FETCH response data is sent separately
   * via openFetchStream / sendFetchObject / sendFetchEndOfRange.
   *
   * @param requestId The request ID from the incoming FETCH
   * @param options FETCH_OK metadata (endOfTrack, endLocation, parameters)
   * @see draft-ietf-moq-transport-18 §10.13
   */
  async acceptFetch(requestId: bigint, options?: FetchAcceptOptions): Promise<void> {
    const actions = this.session.acceptFetch(requestId, options);
    // §10.13: the Session has already transitioned the fetch to TRANSFERRING. On
    // draft-18 the FETCH_OK rides the fetch's OWN bidi request stream, so if that
    // write REJECTS the peer never received acceptance — roll back (drop the session
    // fetch, revoke openFetchStream authorization, abort any response stream already
    // opened before FETCH_OK) so no ghost accepted fetch survives, then propagate.
    try {
      if (await this.writeInboundRequestResponse(requestId, actions)) return;
    } catch (err) {
      await this.rollbackFailedFetchAcceptance(requestId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    await this.executeActions(actions);
  }

  /**
   * Roll back an inbound FETCH whose FETCH_OK failed to write (§10.13). Mirrors
   * {@link rollbackFailedAcceptance}: the peer never saw acceptance, so revoke the
   * openFetchStream authorization, abort any response stream already opened (opening
   * before FETCH_OK is allowed, §10.12), terminate the fetch in the Session
   * (§11.4.1), and tear the request stream down. The caller re-throws.
   */
  private async rollbackFailedFetchAcceptance(requestId: bigint): Promise<void> {
    this.inboundFetchGroupOrder.delete(requestId);
    this.fetchServeReserved.delete(requestId);
    await this.abortFetchStreamsForRequest(requestId, 'fetch acceptance failed');
    await this.executeActions(this.session.handleInboundRequestClosed(requestId));
    const ctx = this.inboundRequestContexts.get(requestId);
    this.inboundRequestContexts.delete(requestId);
    if (ctx) { try { await ctx.abort(); } catch { /* already torn down */ } }
  }

  /**
   * SYNCHRONOUSLY detach every open FETCH response stream serving `requestId` from
   * the registry and return their writers. After this returns, sendFetchObject() /
   * closeFetchStream() for those streams find no entry and fail — so a cancellation
   * takes effect BEFORE any teardown await, closing the window in which a serve call
   * could still write to a cancelled fetch. The caller aborts the returned writers.
   */
  private detachFetchStreamsForRequest(requestId: bigint): WritableStreamDefaultWriter<Uint8Array>[] {
    const writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
    for (const [streamId, st] of [...this.fetchOutgoingStreams]) {
      if (st.requestId !== requestId) continue;
      this.fetchOutgoingStreams.delete(streamId);
      writers.push(st.writer);
    }
    return writers;
  }

  /** Detach (synchronously) + abort every open FETCH response stream for `requestId`. */
  private async abortFetchStreamsForRequest(requestId: bigint, reason: string): Promise<void> {
    for (const writer of this.detachFetchStreamsForRequest(requestId)) {
      try { await writer.abort(reason); } catch { /* already torn down */ }
    }
  }

  /**
   * Reject an incoming FETCH with REQUEST_ERROR (§10.6). draft-18 writes it on
   * the FETCH's own bidi request stream; draft-14/16 use the control stream.
   *
   * @param requestId The request ID from the incoming FETCH
   * @param errorCode Error code (see §13.4)
   * @param reason Human-readable error reason
   */
  async rejectFetch(requestId: bigint, errorCode: bigint, reason: string): Promise<void> {
    const actions = this.session.rejectFetch(requestId, errorCode, reason);
    // §10.13: rejection DEAUTHORIZES the FETCH — drop its group-order entry so a
    // later openFetchStream() for it is refused, AND abort any response stream the
    // application already opened. openFetchStream() is explicitly allowed BEFORE
    // FETCH_OK (§10.12), so a rejection must revoke an in-flight stream too — merely
    // blocking future opens would leave earlier ones writable and let unsolicited
    // fetch data reach a peer that received only REQUEST_ERROR.
    this.inboundFetchGroupOrder.delete(requestId);
    this.fetchServeReserved.delete(requestId);
    await this.abortFetchStreamsForRequest(requestId, 'fetch rejected');
    // finalize: a rejected FETCH's request stream is done — close both
    // directions rather than leaving the context and reader pending (§3.3.2).
    if (await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true)) return;
    await this.executeActions(actions);
  }

  /**
   * Accept an incoming TRACK_STATUS (§10.14, TRACK_STATUS_OK). draft-18 writes
   * REQUEST_OK on the TRACK_STATUS's own bidi request stream and then FINs it
   * (one-shot); draft-14/16 send it on the control stream.
   *
   * The second argument is backwards-compatible: it may be the legacy `Parameters`
   * map, or a {@link TrackStatusAcceptOptions} carrying `parameters` and/or
   * draft-18 `trackProperties` (§2.5). Non-empty Track Properties on draft-14/16
   * throw.
   *
   * @param requestId The request ID from the incoming TRACK_STATUS
   * @param paramsOrOptions REQUEST_OK parameters, or `{ parameters?, trackProperties? }`
   */
  async acceptTrackStatus(
    requestId: bigint,
    paramsOrOptions: Parameters | TrackStatusAcceptOptions = new Map(),
  ): Promise<void> {
    const actions = this.session.acceptTrackStatus(requestId, paramsOrOptions);
    if (await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true)) return;
    await this.executeActions(actions);
  }

  /**
   * Reject an incoming TRACK_STATUS with REQUEST_ERROR (§10.14). draft-18 writes
   * it on the TRACK_STATUS's own bidi request stream and then FINs it; draft-14/16
   * use the control stream.
   *
   * @param requestId The request ID from the incoming TRACK_STATUS
   * @param errorCode Error code (see §13.4)
   * @param reason Human-readable error reason
   */
  async rejectTrackStatus(requestId: bigint, errorCode: bigint, reason: string): Promise<void> {
    const actions = this.session.rejectTrackStatus(requestId, errorCode, reason);
    if (await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true)) return;
    await this.executeActions(actions);
  }

  /**
   * Accept an incoming SUBSCRIBE_NAMESPACE (§10.18). Writes REQUEST_OK on the
   * request's own bidi stream and KEEPS it open so NAMESPACE / NAMESPACE_DONE can
   * be announced via sendNamespace / sendNamespaceDone.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE_NAMESPACE
   * @param params REQUEST_OK parameters (usually empty)
   */
  async acceptSubscribeNamespace(requestId: bigint, params: Parameters = new Map()): Promise<void> {
    const actions = this.session.acceptSubscribeNamespace(requestId, params);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
  }

  /**
   * Reject an incoming SUBSCRIBE_NAMESPACE (§10.18). Writes REQUEST_ERROR on the
   * request's own bidi stream, then FINs / seals / drops the context.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE_NAMESPACE
   * @param errorCode Error code (see §13.4)
   * @param reason Human-readable error reason
   */
  async rejectSubscribeNamespace(requestId: bigint, errorCode: bigint, reason: string): Promise<void> {
    const actions = this.session.rejectSubscribeNamespace(requestId, errorCode, reason);
    if (await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true)) return;
    await this.executeActions(actions);
  }

  /**
   * Announce a matching namespace on an accepted incoming SUBSCRIBE_NAMESPACE
   * stream (NAMESPACE, §10.18). Written on that request stream, not uni control;
   * the stream stays open for further announcements.
   *
   * @param requestId The request ID of the incoming SUBSCRIBE_NAMESPACE
   * @param suffix The namespace suffix (appended to the subscribed prefix)
   */
  async sendNamespace(requestId: bigint, suffix: Uint8Array[]): Promise<void> {
    const actions = this.session.sendNamespace(requestId, suffix);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
  }

  /**
   * Publisher-side: write NAMESPACE_DONE for a previously announced suffix on the
   * existing SUBSCRIBE_NAMESPACE stream (§10.18). Locally this only withdraws that
   * suffix from publisher bookkeeping and does NOT seal the stream; the receiving
   * subscriber, however, treats NAMESPACE_DONE as TERMINATING its namespace
   * subscription (§6.1), so it must not be used to keep the subscription alive.
   *
   * @param requestId The request ID of the incoming SUBSCRIBE_NAMESPACE
   * @param suffix The namespace suffix to withdraw
   */
  async sendNamespaceDone(requestId: bigint, suffix: Uint8Array[]): Promise<void> {
    const actions = this.session.sendNamespaceDone(requestId, suffix);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
  }

  /**
   * Accept an incoming SUBSCRIBE_TRACKS (§10.19). Writes REQUEST_OK on the
   * request's own bidi stream and KEEPS it open for PUBLISH / PUBLISH_BLOCKED.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE_TRACKS
   * @param params REQUEST_OK parameters (usually empty)
   */
  async acceptSubscribeTracks(requestId: bigint, params: Parameters = new Map()): Promise<void> {
    const actions = this.session.acceptSubscribeTracks(requestId, params);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
  }

  /**
   * Reject an incoming SUBSCRIBE_TRACKS (§10.19). Writes REQUEST_ERROR on the
   * request's own bidi stream, then FINs / seals / drops the context.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE_TRACKS
   * @param errorCode Error code (see §13.4)
   * @param reason Human-readable error reason
   */
  async rejectSubscribeTracks(requestId: bigint, errorCode: bigint, reason: string): Promise<void> {
    const actions = this.session.rejectSubscribeTracks(requestId, errorCode, reason);
    if (await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true)) return;
    await this.executeActions(actions);
  }

  /**
   * Report a Track that cannot be served within an accepted incoming
   * SUBSCRIBE_TRACKS (PUBLISH_BLOCKED, §10.20). Written on the request's own bidi
   * stream; the stream stays open. Throws if the request is not yet accepted.
   *
   * @param requestId The request ID of the incoming SUBSCRIBE_TRACKS
   * @param suffix The namespace suffix of the blocked track (appended to the prefix)
   * @param trackName The blocked track's name
   */
  async sendPublishBlocked(requestId: bigint, suffix: Uint8Array[], trackName: Uint8Array): Promise<void> {
    const actions = this.session.sendPublishBlocked(requestId, suffix, trackName);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
  }

  /**
   * Send PUBLISH_DONE for an established subscription.
   *
   * Terminates the subscription from the publisher side, signalling
   * that no more objects will be sent.
   *
   * @param requestId The request ID of the subscription
   * @param statusCode Status code (see PublishDoneCode)
   * @param reason Human-readable reason
   * @see draft-ietf-moq-transport-16 §9.15
   */
  async publishDone(requestId: bigint, statusCode: Varint, reason: string): Promise<void> {
    // §10.11: PUBLISH_DONE is the terminal message AND carries the total Stream
    // Count — it is refused while data streams for this subscription remain
    // open OR an open/datagram-write operation is still in flight (a
    // synchronous reservation, so this check cannot race a deferred stream
    // creation). Close/await them first; their count is already included.
    const open = this.openSubgroupsByRequest.get(requestId);
    const inFlight = this.pendingPublishOps.get(requestId) ?? 0;
    if ((open && open.size > 0) || inFlight > 0) {
      throw new MoqtConnectionError(
        `publishDone: ${(open?.size ?? 0)} open + ${inFlight} in-flight data operation(s) for request ${requestId} — finish them before PUBLISH_DONE (§10.11)`,
        { errorSource: 'control' },
      );
    }
    const actions = this.session.publishDone(requestId, statusCode, reason);
    this.openSubgroupsByRequest.delete(requestId);
    // Terminal — retire the alias into the bounded LRU (a later send is still
    // refused) so per-subscription churn does not accumulate for the session.
    this.retirePublisherRequest(requestId);
    // draft-18 §10.11: PUBLISH_DONE has no wire Request ID — it is written on the
    // subscription's own bidi request stream (an accepted inbound SUBSCRIBE),
    // then the stream is sealed and fully closed (FIN + STOP_SENDING). Not the
    // uni control stream.
    if (this.session.draftVersion === 18) {
      const ctx = this.inboundRequestContexts.get(requestId);
      if (ctx) {
        const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
        if (send) await ctx.writeMessage(send.message);
        ctx.seal();
        await ctx.terminate();
        this.inboundRequestContexts.delete(requestId);
        return;
      }
      // Outbound PUBLISH (§10.10): PUBLISH_DONE rides the PUBLISH request stream we
      // opened, then the stream is FIN'd and dropped. Not the uni control stream.
      if (this.uniPair!.hasRequestStream(requestId)) {
        const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
        await this.uniPair!.finishRequest(requestId, send?.message);
        return;
      }
    }
    await this.executeActions(actions);
  }

  /**
   * Resolve the publisher-side subscription serving `trackAlias`, when the
   * alias was associated via acceptSubscribe() / publish(). Returns undefined
   * for an unassociated alias (raw data-plane use with no subscription — the
   * legacy behavior, unaccounted). A known alias whose subscription is gone or
   * TERMINATED yields `sub: undefined` — the caller must refuse to send.
   */
  private publisherSubscriptionForAlias(
    trackAlias: bigint,
  ): { requestId: bigint; sub: SubscriptionStateMachine | undefined } | undefined {
    const requestId = this.publisherAliasRequests.get(trackAlias);
    if (requestId === undefined) {
      // A recently-retired alias: still refuse sends (sub undefined) so a
      // post-termination open is rejected, until it ages out of the bounded LRU.
      const retired = this.retiredPublisherAliases.get(trackAlias);
      if (retired !== undefined) return { requestId: retired, sub: undefined };
      return undefined; // unassociated (never ours, or aged out) — legacy path
    }
    const sub = this.session.getIncomingSubscription(requestId)
      ?? this.session.getOutgoingPublish(requestId);
    if (sub && sub.state === SubscriptionState.TERMINATED) return { requestId, sub: undefined };
    return { requestId, sub };
  }

  /**
   * Retire a publisher subscription's alias on termination: move it from the
   * active map into the bounded retired LRU (still refused), and drop its
   * generation. Evicts the oldest retired alias past the cap so cumulative
   * subscription churn stays bounded.
   */
  private retirePublisherRequest(requestId: bigint): void {
    for (const [alias, rid] of this.publisherAliasRequests) {
      if (rid !== requestId) continue;
      this.publisherAliasRequests.delete(alias);
      if (this.retiredPublisherAliases.size >= MoqtConnection.MAX_RETIRED_PUBLISHER_ALIASES) {
        const oldest = this.retiredPublisherAliases.keys().next().value;
        if (oldest !== undefined) this.retiredPublisherAliases.delete(oldest);
      }
      this.retiredPublisherAliases.set(alias, requestId);
      break;
    }
    // NOTE: publisherGeneration is NOT deleted here — an in-flight openSubgroup
    // captured before cancellation still checks it. It is bounded separately by
    // {@link boundPublisherGeneration}, which only evicts entries with no
    // pending op so an in-flight generation is never lost.
  }

  /** Cap publisherGeneration: evict the oldest entry that has no pending op. */
  private boundPublisherGeneration(): void {
    if (this.publisherGeneration.size <= MoqtConnection.MAX_RETIRED_PUBLISHER_ALIASES) return;
    for (const rid of this.publisherGeneration.keys()) {
      if (!this.pendingPublishOps.has(rid)) { this.publisherGeneration.delete(rid); break; }
    }
  }

  /**
   * Begin a publisher data-plane operation on `trackAlias`: refuse if the
   * subscription is terminated, else SYNCHRONOUSLY reserve the in-flight slot
   * (so a concurrent publishDone sees it and refuses) and return the
   * association. Balanced by {@link endPublishOp} in a finally. Returns
   * undefined for an unassociated alias (legacy unaccounted use).
   */
  private beginPublishOp(
    trackAlias: bigint,
    what: string,
  ): { requestId: bigint; sub: SubscriptionStateMachine; generation: number } {
    const assoc = this.publisherSubscriptionForAlias(trackAlias);
    // The public API documents trackAlias as coming from acceptSubscribe() /
    // publish(). An UNKNOWN alias (never associated, or aged out of the retired
    // LRU) is rejected — never silently published with no accounting.
    if (!assoc) {
      throw new MoqtConnectionError(
        `${what}: unknown track alias ${trackAlias} — not from acceptSubscribe()/publish()`,
        { errorSource: 'data' },
      );
    }
    if (!assoc.sub) {
      throw new MoqtConnectionError(
        `${what}: the subscription for track alias ${trackAlias} is terminated — no further objects (§10.11)`,
        { errorSource: 'data' },
      );
    }
    this.pendingPublishOps.set(assoc.requestId, (this.pendingPublishOps.get(assoc.requestId) ?? 0) + 1);
    // Capture the generation now: if it is bumped (cancellation) before the
    // operation's transport stream resolves, the op invalidates itself.
    const generation = this.publisherGeneration.get(assoc.requestId) ?? 0;
    return { requestId: assoc.requestId, sub: assoc.sub, generation };
  }

  /** Whether the captured op generation is still current (not cancelled). */
  private publisherOpCurrent(requestId: bigint, generation: number): boolean {
    return (this.publisherGeneration.get(requestId) ?? 0) === generation;
  }

  /** Release an in-flight publisher operation reserved by {@link beginPublishOp}. */
  private endPublishOp(requestId: bigint | undefined): void {
    if (requestId === undefined) return;
    const n = (this.pendingPublishOps.get(requestId) ?? 0) - 1;
    if (n > 0) {
      this.pendingPublishOps.set(requestId, n);
    } else {
      // Last in-flight op released — NOW the generation map may be bounded (its
      // entry no longer needs preserving to invalidate this op). Deferred here from
      // abortPublisherStreamsForRequest so a live reservation is never dropped early.
      this.pendingPublishOps.delete(requestId);
      this.boundPublisherGeneration();
    }
  }

  /**
   * §5.1.1: the subscriber cancelled a subscription — RESET_STREAM every
   * publisher subgroup stream still open for it and drop the stream accounting.
   * The alias→request association is retained so a subsequent openSubgroup /
   * sendDatagram is refused (terminated), never silently accepted.
   */
  private async abortPublisherStreamsForRequest(requestId: bigint): Promise<void> {
    // Bump the generation FIRST (synchronously): any openSubgroup already past
    // its beginPublishOp but still awaiting createUnidirectionalStream will, on
    // resolving, see the stale generation and abort itself instead of emitting
    // a stream for the cancelled subscription.
    this.publisherGeneration.set(requestId, (this.publisherGeneration.get(requestId) ?? 0) + 1);
    const open = this.openSubgroupsByRequest.get(requestId);
    if (open) {
      for (const sid of [...open]) {
        const st = this.outgoingStreams.get(sid);
        if (st) {
          try { await st.writer.abort(new Error('subscription cancelled — RESET_STREAM (§5.1.1)')); } catch { /* already gone */ }
          this.outgoingStreams.delete(sid);
        }
      }
      this.openSubgroupsByRequest.delete(requestId);
    }
    // Do NOT delete pendingPublishOps here: an openSubgroup already past its
    // beginPublishOp but still awaiting createUnidirectionalStream holds a live
    // reservation. Preserving it keeps boundPublisherGeneration from evicting the
    // just-bumped generation (which would let the resolving op default to gen 0 and
    // false-positive as current). The op's own endPublishOp finally releases it and
    // bounds the map — after it has correctly seen the bumped generation and aborted.
    // Retire the alias (bounded LRU) so cumulative churn stays bounded, and cap the
    // generation map (skips any request that still has a pending op).
    this.retirePublisherRequest(requestId);
    this.boundPublisherGeneration();
  }

  /**
   * Open a new outgoing subgroup data stream for publishing objects.
   *
   * Creates a unidirectional stream, writes the SUBGROUP_HEADER, and
   * returns a synthetic stream ID for use with sendObject/closeSubgroup.
   *
   * @param trackAlias Track alias (from acceptSubscribe)
   * @param groupId Group ID for this subgroup
   * @param subgroupId Subgroup ID
   * @param opts Optional: publisherPriority, hasExtensions, endOfGroup, defaultPriority, subgroupIdMode
   * @returns Synthetic stream ID for sendObject/closeSubgroup
   * @see draft-ietf-moq-transport-16 §10.4.2
   */
  async openSubgroup(
    trackAlias: bigint,
    groupId: bigint,
    subgroupId: bigint,
    opts?: {
      publisherPriority?: number;
      hasExtensions?: boolean;
      endOfGroup?: boolean;
      /** Use default priority (omit priority byte). §10.4.2 bit 5. */
      defaultPriority?: boolean;
      /** Subgroup ID mode. Default: EXPLICIT (field present). §10.4.2 bits 1-2. */
      subgroupIdMode?: number;
      /**
       * draft-18 only (FIRST_OBJECT, 0x40 — §10.4.2 bit 6): set when the first
       * object on this stream is the FIRST object ever published in this subgroup.
       * The Original Publisher opening a new subgroup MUST set it. draft-14/16 have
       * no such bit, so supplying it there throws.
       */
      firstObject?: boolean;
    },
  ): Promise<bigint> {
    // §10.4.2 bit 6: FIRST_OBJECT (0x40) is a draft-18-only header bit — reject the
    // option on draft-14/16 BEFORE opening a stream.
    if (opts?.firstObject && this.session.draftVersion !== 18) {
      throw new MoqtConnectionError('openSubgroup: firstObject is a draft-18-only option', { errorSource: 'data' });
    }
    if (!this.transport?.createUnidirectionalStream) {
      throw new MoqtConnectionError(
        'Transport does not support createUnidirectionalStream',
        { errorSource: 'transport' },
      );
    }
    // §10.11: no new data streams for a terminated subscription. Reserve the
    // operation SYNCHRONOUSLY (before any await) so a concurrent publishDone
    // sees it in flight and refuses — the terminated check and the reservation
    // are one atomic step, not a pre-await check that a deferred stream
    // creation could slip past.
    const assoc = this.beginPublishOp(trackAlias, 'openSubgroup');
    try {
      let writable: WritableStream<Uint8Array>;
      try {
        writable = await this.transport.createUnidirectionalStream();
      } catch (err) {
        // Stream limit exhausted — relay hasn't granted enough MAX_STREAMS
        // or WT_MAX_STREAMS credit. This is not a protocol error; it means
        // the peer's flow control window is full.
        // @see draft-ietf-webtrans-http3-15 §5.3 (session-level stream limits)
        // @see RFC 9000 §4.6 (QUIC stream limits)
        throw new MoqtConnectionError(
          `Failed to open unidirectional stream for group ${groupId}: ${(err as Error).message ?? err}. ` +
          `The relay may not be granting enough stream credits (MAX_STREAMS / WT_MAX_STREAMS).`,
          { errorSource: 'transport', isFatal: false, ...(err instanceof Error ? { cause: err } : {}) },
        );
      }
      const writer = writable.getWriter();

      // §5.1.1: if the subscription was cancelled while we awaited the transport
      // stream, this open is stale — abort the fresh writer and reject WITHOUT
      // writing a header, registering the stream, or counting it. Nothing for
      // the cancelled subscription reaches the wire.
      if (assoc && !this.publisherOpCurrent(assoc.requestId, assoc.generation)) {
        try { await writer.abort(new Error('subgroup open cancelled before header (§5.1.1)')); } catch { /* already gone */ }
        throw new MoqtConnectionError(
          `openSubgroup: subscription for track alias ${trackAlias} was cancelled while opening the stream (§5.1.1)`,
          { errorSource: 'data' },
        );
      }

      // §10.11: the transport stream now exists — count it toward the
      // subscription's PUBLISH_DONE Stream Count IMMEDIATELY, track it as OPEN,
      // and REGISTER the writer, all BEFORE writing the header. Registering the
      // writer first is what lets a cancellation DURING the header write find
      // and abort it (abortPublisherStreamsForRequest walks outgoingStreams) —
      // otherwise a stale open would resurrect the stream. If the header write
      // (or setup) fails or the op was cancelled, the stream is aborted and
      // removed from the OPEN set, but its Stream Count is retained (§10.11).
      const streamId = this.nextOutgoingStreamId++;
      this.outgoingStreams.set(streamId, {
        writer,
        hasExtensions: opts?.hasExtensions ?? false,
        previousObjectId: 0n,
        isFirstObject: true,
        ...(assoc ? { subscriptionRequestId: assoc.requestId } : {}),
      });
      if (assoc?.sub) {
        assoc.sub.incrementStreamCount();
        let open = this.openSubgroupsByRequest.get(assoc.requestId);
        if (!open) {
          open = new Set();
          this.openSubgroupsByRequest.set(assoc.requestId, open);
        }
        open.add(streamId);
      }

      const dropStreamKeepingCount = async (err: unknown): Promise<void> => {
        try { await writer.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* already gone */ }
        if (assoc) {
          const open = this.openSubgroupsByRequest.get(assoc.requestId);
          if (open) {
            open.delete(streamId);
            if (open.size === 0) this.openSubgroupsByRequest.delete(assoc.requestId);
          }
        }
        this.outgoingStreams.delete(streamId);
      };

      try {
        // Build the type byte from flags. Bit 4 (SUBGROUP_MARKER 0x10) is always set;
        // bits 1-2 are the subgroup-ID mode. draft-18 renamed EXTENSIONS→PROPERTIES
        // (bit 0x01) vs draft-14/16 (0x20), so the flag bit differs by version.
        const mode = opts?.subgroupIdMode ?? SubgroupIdMode.EXPLICIT;
        const d18 = this.session.draftVersion === 18;
        let typeByte = SubgroupFlags.SUBGROUP_MARKER | (mode << 1);
        if (opts?.hasExtensions) typeByte |= d18 ? SubgroupFlags18.PROPERTIES : SubgroupFlags.EXTENSIONS;
        if (opts?.endOfGroup) typeByte |= d18 ? SubgroupFlags18.END_OF_GROUP : SubgroupFlags.END_OF_GROUP;
        if (opts?.defaultPriority) typeByte |= d18 ? SubgroupFlags18.DEFAULT_PRIORITY : SubgroupFlags.DEFAULT_PRIORITY;
        if (opts?.firstObject) typeByte |= SubgroupFlags18.FIRST_OBJECT; // d18-only; validated above

        const header: SubgroupHeader = {
          typeByte,
          trackAlias,
          groupId,
          subgroupId,
          // publisherPriority present unless DEFAULT_PRIORITY bit is set
          publisherPriority: opts?.defaultPriority ? undefined : (opts?.publisherPriority ?? 128),
          hasExtensions: opts?.hasExtensions ?? false,
          isEndOfGroup: opts?.endOfGroup ?? false,
          isFirstObjectInSubgroup: opts?.firstObject ?? false,
        };

        const headerBytes = d18 ? encodeSubgroupHeader18(header) : encodeSubgroupHeader(header);
        await writer.write(headerBytes);

        // §5.1.1: a cancellation that raced the header write (bumping the
        // generation) must NOT leave a live stream for a dead subscription.
        // Recheck AFTER the write; if stale, abort and reject (count retained).
        if (assoc && !this.publisherOpCurrent(assoc.requestId, assoc.generation)) {
          await dropStreamKeepingCount(new Error('subgroup open cancelled during header write (§5.1.1)'));
          throw new MoqtConnectionError(
            `openSubgroup: subscription for track alias ${trackAlias} was cancelled while writing the header (§5.1.1)`,
            { errorSource: 'data' },
          );
        }
        return streamId;
      } catch (err) {
        // Header encode/write failed (or the recheck above rejected): abort +
        // drop from the OPEN set (so PUBLISH_DONE is not blocked), keep the count.
        // If dropStreamKeepingCount already ran (recheck path), this is idempotent.
        if (this.outgoingStreams.has(streamId)) await dropStreamKeepingCount(err);
        throw err;
      }
    } finally {
      // The open is now recorded (open-stream set) or failed — release the
      // in-flight reservation either way.
      this.endPublishOp(assoc?.requestId);
    }
  }

  /**
   * Send an object on an open subgroup stream.
   *
   * Encodes the object with delta-encoded object IDs and writes it
   * to the stream.
   *
   * @param streamId Stream ID from openSubgroup()
   * @param objectId Object ID
   * @param payload Object payload bytes
   * @param extensions Optional extension header bytes
   * @see draft-ietf-moq-transport-16 §10.4.2
   */
  async sendObject(
    streamId: bigint,
    objectId: bigint,
    payload: Uint8Array,
    extensions?: Uint8Array,
  ): Promise<void> {
    const state = this.outgoingStreams.get(streamId);
    if (!state) {
      throw new MoqtConnectionError(
        `Unknown outgoing stream ${streamId}`,
        { errorSource: 'data' },
      );
    }

    const obj = { objectId, extensions, payload, status: undefined };
    const objectBytes = this.session.draftVersion === 18
      ? encodeSubgroupObject18(obj, state.hasExtensions, state.previousObjectId, state.isFirstObject)
      : encodeSubgroupObject(obj, state.hasExtensions, varint(state.previousObjectId), state.isFirstObject);

    await state.writer.write(objectBytes);

    state.previousObjectId = objectId as bigint;
    state.isFirstObject = false;
  }

  /**
   * Send a draft-18 OBJECT_DATAGRAM for an accepted subscription (§11.3.1).
   * Uses the assigned Track Alias and vi64 encoding. Narrow happy path: a plain
   * object datagram (no status, properties, or end-of-group flags).
   *
   * @param trackAlias Track alias (from acceptSubscribe)
   * @param groupId Group ID
   * @param objectId Object ID
   * @param payload Object payload bytes
   * @param opts Optional publisherPriority (default 128)
   * @see draft-ietf-moq-transport-18 §11.3.1
   */
  async sendDatagram(
    trackAlias: bigint,
    groupId: bigint,
    objectId: bigint,
    payload: Uint8Array,
    opts?: { publisherPriority?: number },
  ): Promise<void> {
    if (this.session.draftVersion !== 18) {
      throw new MoqtConnectionError('sendDatagram is draft-18 only', { errorSource: 'data' });
    }
    if (!this.transport?.datagrams) {
      throw new MoqtConnectionError('Transport does not support datagrams', { errorSource: 'transport' });
    }
    // §10.11: no datagrams for a terminated subscription; reserve the operation
    // synchronously so a concurrent publishDone refuses (see openSubgroup).
    const assoc = this.beginPublishOp(trackAlias, 'sendDatagram');
    try {
      const bytes = encodeObjectDatagram18({
        typeByte: 0x00, // plain OBJECT_DATAGRAM: priority present, no flags
        trackAlias,
        groupId,
        objectId,
        publisherPriority: opts?.publisherPriority ?? 128,
        isEndOfGroup: false,
        extensions: undefined,
        payload,
        status: undefined,
      });
      const writer = this.transport.datagrams.writable?.getWriter();
      if (!writer) {
        throw new MoqtConnectionError('Transport datagrams are not writable', { errorSource: 'transport' });
      }
      try {
        await writer.write(bytes);
      } finally {
        writer.releaseLock();
      }
    } finally {
      this.endPublishOp(assoc?.requestId);
    }
  }

  /**
   * Close an outgoing subgroup stream (sends FIN).
   *
   * @param streamId Stream ID from openSubgroup()
   * @see draft-ietf-moq-transport-16 §10.4.2
   */
  async closeSubgroup(streamId: bigint): Promise<void> {
    const state = this.outgoingStreams.get(streamId);
    if (!state) return;

    try {
      await state.writer.close();
    } catch {
      // Stream may already be closed — ignore
    }
    this.outgoingStreams.delete(streamId);
    if (state.subscriptionRequestId !== undefined) {
      const open = this.openSubgroupsByRequest.get(state.subscriptionRequestId);
      if (open) {
        open.delete(streamId);
        if (open.size === 0) this.openSubgroupsByRequest.delete(state.subscriptionRequestId);
      }
    }
  }

  /**
   * Open a draft-18 FETCH response data stream for an admitted inbound FETCH
   * (§11.4.4). Opens a unidirectional stream, writes the FETCH_HEADER (type 0x05
   * + the FETCH Request ID), and returns a synthetic stream ID for
   * sendFetchObject / sendFetchEndOfRange / closeFetchStream.
   *
   * Works before OR after acceptFetch() — the spec allows FETCH_OK and object
   * delivery in either order (§10.12). The requested Group Order comes from the
   * inbound FETCH's parameters (default Ascending).
   *
   * @param requestId The Request ID of the admitted inbound FETCH.
   * @see draft-ietf-moq-transport-18 §11.4.4
   */
  async openFetchStream(requestId: bigint): Promise<bigint> {
    if (this.session.draftVersion !== 18) {
      throw new MoqtConnectionError('openFetchStream is draft-18 only', { errorSource: 'data' });
    }
    const groupOrder = this.inboundFetchGroupOrder.get(requestId);
    if (groupOrder === undefined) {
      throw new MoqtConnectionError(`No admitted inbound FETCH for request ${requestId}`, { errorSource: 'data' });
    }
    if (!this.transport?.createUnidirectionalStream) {
      throw new MoqtConnectionError('Transport does not support createUnidirectionalStream', { errorSource: 'transport' });
    }
    // §11.4.4: a FETCH response uses EXACTLY ONE unidirectional stream. Reserve the
    // request ATOMICALLY (synchronously, before any await) so a concurrent second
    // open is refused, and the reservation is RETAINED after the stream FINs — a
    // request whose one stream is done cannot reopen. The reservation is released
    // only when the inbound FETCH itself is torn down (reject / cancel / close).
    if (this.fetchServeReserved.has(requestId)) {
      throw new MoqtConnectionError(`FETCH ${requestId} already has its one response stream (§11.4.4)`, { errorSource: 'data' });
    }
    this.fetchServeReserved.add(requestId);
    const writer = (await this.transport.createUnidirectionalStream()).getWriter();
    // §10.13: authorization was validated BEFORE the createUnidirectionalStream
    // await. A rejectFetch() or a request-stream close during that await
    // deauthorizes the FETCH SYNCHRONOUSLY (its group-order entry is dropped before
    // any teardown await). Re-check BEFORE writing the FETCH_HEADER — so a fetch
    // rejected/cancelled during stream creation transmits NOTHING and does not
    // RESURRECT itself. Abort the freshly-opened stream and refuse.
    if (!this.inboundFetchGroupOrder.has(requestId)) {
      this.fetchServeReserved.delete(requestId); // no stream established — release the reservation
      try { await writer.abort(new Error('inbound FETCH deauthorized during stream open')); } catch { /* already down */ }
      throw new MoqtConnectionError(`No admitted inbound FETCH for request ${requestId}`, { errorSource: 'data' });
    }
    try {
      await writer.write(encodeFetchHeader18(requestId));
    } catch (err) {
      // The FETCH_HEADER write failed: the stream is unusable — abort it so it is
      // not left half-open, and surface the failure (do not register a dead writer).
      this.fetchServeReserved.delete(requestId); // no stream established — release the reservation
      try { await writer.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* already down */ }
      throw err instanceof Error ? err : new Error(String(err));
    }
    // Re-check once more after the header write (single-threaded: no await between
    // this and the register below, so they are atomic) — a cancellation could have
    // landed during the header write itself.
    if (!this.inboundFetchGroupOrder.has(requestId)) {
      this.fetchServeReserved.delete(requestId);
      try { await writer.abort(new Error('inbound FETCH deauthorized during stream open')); } catch { /* already down */ }
      throw new MoqtConnectionError(`No admitted inbound FETCH for request ${requestId}`, { errorSource: 'data' });
    }
    const streamId = this.nextOutgoingStreamId++;
    this.fetchOutgoingStreams.set(streamId, { requestId, writer, groupOrder, prior: undefined, isFirstObject: true });
    return streamId;
  }

  /** Send a normal fetch object on a FETCH response stream (§11.4.4). */
  async sendFetchObject(streamId: bigint, fields: FetchObjectFields): Promise<void> {
    const state = this.fetchOutgoingStreams.get(streamId);
    if (!state) throw new MoqtConnectionError(`Unknown fetch stream ${streamId}`, { errorSource: 'data' });
    const { bytes, nextPrior } = encodeFetchObject18(fields, state.prior, state.isFirstObject, state.groupOrder);
    await state.writer.write(bytes);
    state.prior = nextPrior;
    state.isFirstObject = false;
  }

  /** Send an End-of-Range marker on a FETCH response stream (§11.4.4.2). */
  async sendFetchEndOfRange(streamId: bigint, nonExistent: boolean, groupId: bigint, objectId: bigint): Promise<void> {
    const state = this.fetchOutgoingStreams.get(streamId);
    if (!state) throw new MoqtConnectionError(`Unknown fetch stream ${streamId}`, { errorSource: 'data' });
    const { bytes, nextPrior } = encodeFetchEndOfRange18(nonExistent, groupId, objectId, state.prior);
    await state.writer.write(bytes);
    state.prior = nextPrior;
    state.isFirstObject = false;
  }

  /** Close (FIN) a FETCH response data stream. */
  async closeFetchStream(streamId: bigint): Promise<void> {
    const state = this.fetchOutgoingStreams.get(streamId);
    if (!state) return;
    try { await state.writer.close(); } catch { /* already closed */ }
    this.fetchOutgoingStreams.delete(streamId);
    // §10.13: the publisher finished serving — RECLAIM the accepted incoming fetch in
    // the Session so serving-side state is bounded. Do NOT release the one-stream
    // reservation: §11.4.4 permits EXACTLY ONE response stream per fetch, and that
    // limit SURVIVES the FIN — a second openFetchStream() must still be refused. The
    // reservation, the group-order authorization, and the inbound request context are
    // all released when the inbound FETCH request stream itself is torn down (reject /
    // cancel / the FETCHER's request-stream FIN — see onInboundStreamClosed).
    //
    // The publisher MUST NOT terminate its request-stream context here: §5.2/§10.12
    // deliver the FETCH_OK and the object data on INDEPENDENT streams with no ordering
    // between them, so FINning the request stream on completion could reach the
    // fetcher BEFORE its data stream and make the fetcher discard valid data. The
    // FETCHER owns final request-stream closure once it has observed BOTH the FETCH_OK
    // and the data FIN (see closeCompletedFetchRequest); that FIN then drives the
    // publisher's own context teardown through the normal inbound-close path.
    this.session.reclaimServedFetch(state.requestId);
  }

  // ─── Internal ─────────────────────────────────────────────────

  /**
   * Execute outbound actions produced by the session.
   */
  private async executeActions(
    actions: SessionOutboundAction[],
  ): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case 'send_control': {
          const bytes = this.codec.encode(action.message);
          this.onQlogEvent?.({
            type: 'control_message_created',
            stream_id: MoqtConnection.CONTROL_STREAM_QLOG_ID,
            length: bytes.byteLength,
            message: action.message,
          });
          await this.controlWriter!.write(bytes);
          break;
        }
        case 'close_connection': {
          // WebTransport.close() is specified to return undefined, but on an
          // already failed or closed session a non-conforming implementation
          // may throw (InvalidStateError) or return a rejected thenable
          // (NetworkError). An intentional close must neither reject nor
          // leak an unhandled rejection — observe both shapes.
          try {
            const result = this.transport?.close({
              closeCode: Number(action.error),
              reason: action.reason,
            }) as unknown;
            void Promise.resolve(result).catch(() => { /* already failed/closed */ });
          } catch { /* already failed/closed */ }
          break;
        }
        case 'open_namespace_stream': {
          // §6.1: Open a new bidi stream, send the SUBSCRIBE_NAMESPACE
          // message, then start reading responses.
          this.openNamespaceStream(action.requestId, action.message);
          break;
        }
        case 'stop_sending': {
          // §10.4.3: "A subscriber MAY send a QUIC STOP_SENDING frame
          // for a subgroup stream if the Group or Subgroup is no longer
          // of interest to it."
          // In WebTransport, reader.cancel() sends STOP_SENDING.
          const reader = this.dataStreamReaders.get(action.streamId);
          if (reader) {
            try {
              await reader.cancel(new Error(`STOP_SENDING: ${action.error}`));
            } catch {
              // Stream may already be closed — ignore
            }
            this.dataStreamReaders.delete(action.streamId);
          }
          break;
        }
        case 'notify_namespace': {
          // Draft-14: namespace events arrive on the control stream, not
          // a bidi stream. Bridge to the same callback as bidi-stream events.
          this.onNamespaceMessage?.(action.requestId as bigint, action.message);
          break;
        }
        case 'cancel_request': {
          // §5.1: the Session cancelled a local request out of band (a PENDING
          // SUBSCRIBE superseded by a peer PUBLISH for the same track). Reject its
          // still-pending subscribeTrack(), drop its routing, and (draft-18) reset
          // its request stream — the Session already tore down its own state.
          const raw = this.rawSubscriptions.get(action.requestId);
          if (raw) {
            this.rawSubscriptions.delete(action.requestId);
            raw.reject?.(new MoqtConnectionError(action.reason, { errorSource: 'control', isFatal: false }));
            raw.resolve = null;
            raw.reject = null;
          }
          for (const [alias, st] of this.rawAliasMaps) {
            if (st.requestId === action.requestId) this.rawAliasMaps.delete(alias);
          }
          if (this.session.draftVersion === 18) await this.uniPair?.cancelRequest(action.requestId);
          break;
        }
        case 'close_stream':
        case 'reset_stream':
        case 'open_data_stream':
        case 'send_object': {
          // These action types are not yet implemented in the connection.
          // Surface as error rather than silently dropping.
          this.onError?.(new MoqtConnectionError(
            `Unhandled session action type: "${action.type}"`,
            { errorSource: 'control' },
          ));
          break;
        }
      }
    }
  }

  /**
   * Background loop: read control stream bytes, decode messages,
   * route to session, execute resulting actions.
   */
  private async runControlReadLoop(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // §3.2: "The control stream MUST NOT be closed at the underlying
          // transport layer during the session's lifetime. Doing so results
          // in the session being closed as a PROTOCOL_VIOLATION." One-shot
          // terminal coordinator (idempotent with a concurrent transport close).
          this.closeSessionFatal('Control stream closed unexpectedly');
          break;
        }

        this.framer.push(value);
        let messages: ReturnType<ControlStreamFramer['drain']>;
        try {
          messages = this.framer.drain();
        } catch (drainErr) {
          // §9: "An endpoint that receives an unknown message type MUST close
          // the session." and "If the length does not match the length of the
          // Message Payload, the receiver MUST close the session with a
          // PROTOCOL_VIOLATION."
          const drainMsg = drainErr instanceof Error ? drainErr.message : String(drainErr);
          this.closeSessionFatal(`Malformed control message: ${drainMsg}`);
          return;
        }
        for (const framed of messages) {
          // draft-14/16: the decoder always yields a fully-correlated
          // ControlMessage (Request IDs are on the wire). draft-18 response
          // correlation will be stamped by the topology before this point
          // (Slice C); until then this single-bidi-control path only carries
          // draft-14/16, so the narrowing is sound.
          const message = framed.message as ControlMessage;
          // SUBSCRIBE_OK: same ordered handling as draft-18 (session validation →
          // terminal-on-close → alias-reuse policy → bind/resolve). Do NOT let the
          // generic path bind/resolve before the session validates. Emit qlog HERE
          // (the raw channel) before the ordered handling, since `continue` skips
          // the generic qlog below and handleSubscribeOkOrdered no longer emits.
          if (message.type === 'SUBSCRIBE_OK') {
            this.onQlogEvent?.({
              type: 'control_message_parsed',
              stream_id: MoqtConnection.CONTROL_STREAM_QLOG_ID,
              message,
            });
            await this.handleSubscribeOkOrdered(message, (message as { requestId: bigint }).requestId);
            continue;
          }
          this.onQlogEvent?.({
            type: 'control_message_parsed',
            stream_id: MoqtConnection.CONTROL_STREAM_QLOG_ID,
            message,
          });
          // §10.11 / §9.15: a subscriber-side PUBLISH_DONE terminates the
          // subscription — apply its Stream Count so the alias routing is torn
          // down and late streams are bounded/discarded (parity with draft-18).
          // Capture the alias BEFORE the session reclaims the subscription.
          const doneAlias = message.type === 'PUBLISH_DONE'
            ? this.session.getSubscription((message as { requestId: bigint }).requestId)?.trackAlias
            : undefined;
          // Intercept track subscription responses before onMessage.
          // Session still processes them (alias mapping, state machine).
          // §5.1: also suppress a response (e.g. REQUEST_ERROR) crossing a
          // cancellation — the session consumes it as a tombstone, so it is not an
          // application event (qlog above stays raw), consistent with SUBSCRIBE_OK.
          const crossedCancel = 'requestId' in message
            && this.session.isCancelledRequest((message as { requestId: bigint }).requestId);
          const suppressOnMessage = this.handleRawSubControlMessage(message) || crossedCancel;
          if (!suppressOnMessage) {
            this.onMessage?.(message);
          }
          // Arm the terminal guard + remove the route SYNCHRONOUSLY (before the
          // session-teardown await) so no late object slips through the window.
          const doneDiscard = message.type === 'PUBLISH_DONE' && doneAlias !== undefined
            ? this.applyTerminalStreamCount(doneAlias,
                BigInt((message as { streamCount?: bigint }).streamCount ?? 0n),
                (message as { requestId: bigint }).requestId)
            : Promise.resolve();
          // §9.5: onSubscribe fires only for a request the session ADMITTED as a
          // NEW subscription. Capture the pre-existing entry (if any) BEFORE
          // processing: a rejected duplicate creates no state (post === undefined),
          // and a SUBSCRIBE reusing a live request ID is a fatal INVALID_REQUEST_ID
          // whose OLD entry persists (post === pre) — neither must fire the callback.
          const subBefore = message.type === 'SUBSCRIBE'
            ? this.session.getIncomingSubscription((message as Subscribe).requestId)
            : undefined;
          const actions = this.session.handleControlMessage(message);
          await this.executeActions(actions);
          await doneDiscard;
          // Fire AFTER session processing so incomingSubscriptions is populated
          // when acceptSubscribe is called (§5.1: admission = a NEW SM identity,
          // and the session did not close on this message).
          if (message.type === 'SUBSCRIBE' && this.onSubscribe) {
            const sub = message as Subscribe;
            const subAfter = this.session.getIncomingSubscription(sub.requestId);
            if (subAfter !== undefined && subAfter !== subBefore
                && this.session.state !== SessionState.CLOSED) {
              this.onSubscribe(sub.requestId, sub.trackNamespace, sub.trackName, sub.parameters as Map<bigint, any>);
            }
          }
          // §5.1.1 (draft-14/16): an inbound UNSUBSCRIBE cancels the
          // subscription — RESET the publisher's open data streams for it.
          if (message.type === 'UNSUBSCRIBE') {
            await this.abortPublisherStreamsForRequest((message as { requestId: bigint }).requestId);
          }
          // §9.18 (draft-14/16): an inbound FETCH_CANCEL — the fetcher stopped
          // (from PENDING or TRANSFERRING). Abort any response stream we opened for
          // it so we no longer write data for a fetch the peer abandoned.
          if (message.type === 'FETCH_CANCEL') {
            await this.abortFetchStreamsForRequest((message as { requestId: bigint }).requestId, 'inbound FETCH_CANCEL');
          }
        }
      }
    } catch (err) {
      // A control-loop read failure is terminal for the session. The 0x2 code is
      // SYNTHETIC (the real reason lives in transport.closed) — mark the report
      // preliminary so an authoritative transport.closed, even one settling in a
      // later task, owns the reported code/reason (bounded fallback otherwise).
      const message = err instanceof Error ? err.message : String(err);
      if (!this._terminated) {
        this.onError?.(new MoqtConnectionError(
          message,
          { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
        ));
      }
      this.terminate(0x2, message, { preliminary: true });
    }
  }

  /**
   * Background loop: listen for incoming unidirectional streams,
   * decode headers and objects.
   * @see draft-ietf-moq-transport-16 §10.4
   */
  private async runIncomingStreamLoop(
    transport: WebTransportLike,
  ): Promise<void> {
    try {
      const reader = transport.incomingUnidirectionalStreams.getReader();
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        // Process each stream in the background
        const streamId = this.nextStreamId++;
        this.processDataStream(stream, streamId);
      }
    } catch (err) {
      // The ACCEPT loop dying is terminal for media delivery: no future data
      // stream will ever be accepted, so an established session would starve
      // silently. Surface it as FATAL — unless the session is already closed
      // (intentional teardown makes the reader throw; that is not an error).
      if (this.session.state === SessionState.CLOSED) return;
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'transport', isFatal: true, ...(err instanceof Error ? { cause: err } : {}) },
      ));
    }
  }

  /**
   * Background loop: listen for incoming datagrams, decode each one.
   * @see draft-ietf-moq-transport-16 §10.3
   */
  private async runDatagramLoop(
    transport: WebTransportLike,
  ): Promise<void> {
    try {
      const reader = transport.datagrams.readable.getReader();
      while (true) {
        const { value: bytes, done } = await reader.read();
        if (done) break;
        try {
          // Classify by the (vi64 in draft-18) datagram type first. Padding
          // datagrams (draft-18 §11.5.2, type 0x132B3E29) are discarded rather
          // than decoded as objects. classifyDatagram throws RangeError on a
          // truncated type, handled below as a (dropped) malformed datagram.
          if (this.dataCodec!.classifyDatagram(bytes, 0) === 'padding') {
            continue;
          }
          const { datagram } = this.dataCodec!.decodeObjectDatagram(bytes, 0);
          // §10.11 early-discard: a datagram for an alias whose PUBLISH_DONE
          // already arrived is dropped (datagrams do not count toward the
          // Stream Count, so the tombstone is not decremented).
          if (this.terminatedAliases.has(datagram.trackAlias as bigint)) {
            continue;
          }
          this.onQlogEvent?.({
            type: 'object_datagram_parsed',
            track_alias: datagram.trackAlias as bigint,
            group_id: datagram.groupId as bigint,
            object_id: datagram.objectId as bigint,
            // -06 §4.5: publisher_priority optional (inherits from subscription)
            ...(datagram.publisherPriority !== undefined ? { publisher_priority: datagram.publisherPriority } : {}),
            ...(datagram.extensions ? { extension_headers_length: datagram.extensions.byteLength } : {}),
            ...(datagram.status !== undefined ? { object_status: datagram.status as bigint } : {}),
            ...(datagram.payload.byteLength > 0
              ? { object_payload: { payload_length: datagram.payload.byteLength } }
              : {}),
            end_of_group: datagram.isEndOfGroup,
          });
          this.onDatagram?.(datagram);
        } catch (err) {
          // §10.3.1, §10: Protocol violations (invalid flags, zero-length
          // extensions, extensions on status datagrams) MUST close the session.
          if (err instanceof ProtocolViolationError) {
            this.closeSessionFatal(err.message);
            return;
          }
          // RangeError = truncated/malformed datagram (e.g. stray H3 capsule
          // or WebTransport implementation artifact). Datagrams are unreliable
          // by nature (§10.3) — silently drop rather than emitting a session error.
          if (!(err instanceof RangeError)) {
            const msg = err instanceof Error ? err.message : String(err);
            this.onError?.(new MoqtConnectionError(
              msg,
              { errorSource: 'datagram', ...(err instanceof Error ? { cause: err } : {}) },
            ));
          }
        }
      }
    } catch (err) {
      // A real transport close makes this read throw AFTER terminal shutdown —
      // do not emit a spurious post-close error event.
      if (this._terminated || this.session.state === SessionState.CLOSED) return;
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'transport', ...(err instanceof Error ? { cause: err } : {}) },
      ));
    }
  }

  /**
   * Background loop: accept peer-initiated bidi streams. In draft-18 the first
   * message identifies a request-stream opener (§3.3): PUBLISH, SUBSCRIBE, FETCH,
   * TRACK_STATUS, PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, or SUBSCRIBE_TRACKS. Any
   * other first message is rejected with a PROTOCOL_VIOLATION (see
   * dispatchInboundRequestMessage).
   */
  private async runIncomingBidiLoop(transport: WebTransportLike): Promise<void> {
    if (!transport.incomingBidirectionalStreams) return;
    try {
      const reader = transport.incomingBidirectionalStreams.getReader();
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        void this.handleIncomingBidiStream(stream);
      }
    } catch (err) {
      // Same as the uni accept loop: terminal accept failure on an ESTABLISHED
      // session is fatal (inbound requests can never arrive again); during
      // intentional teardown (session CLOSED) it is expected — swallow.
      if (this.session.state === SessionState.CLOSED) return;
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'transport', isFatal: true, ...(err instanceof Error ? { cause: err } : {}) },
      ));
    }
  }

  /** Wrap a peer-initiated bidi stream in an InboundRequestStreamContext and read it. */
  private handleIncomingBidiStream(stream: WebTransportBidirectionalStream): void {
    const ctx = new InboundRequestStreamContext(stream, this.codec, {
      onMessage: (msg, c) => this.dispatchInboundRequestMessage(msg, c),
      onFailure: (err, c) => void this.onInboundStreamClosed(c, err),
      onClosed: (c) => void this.onInboundStreamClosed(c, null),
    });
    ctx.start();
  }

  /**
   * An inbound request stream ended — a clean FIN (`err === null`) or a failure
   * (reset / protocol violation). A protocol violation closes the session. A
   * FIN/reset of an inbound PUBLISH_NAMESPACE stream is a withdrawal (§3.3.2): we
   * clean local/session state and notify, NOT surface an error. Other non-protocol
   * failures are surfaced via onError.
   */
  private async onInboundStreamClosed(ctx: InboundRequestStreamContext, err: Error | null): Promise<void> {
    if (err instanceof ProtocolViolationError) {
      await this.failInboundRequest(err);
      return;
    }
    if (ctx.requestId !== null && ctx.openerKind === 'publish-namespace') {
      const requestId = ctx.requestId;
      await this.executeActions(this.session.handleInboundPublishNamespaceClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
      await ctx.terminate(); // release our half — no half-open stream retained
      this.onPublishNamespaceClosed?.(requestId);
      return; // FIN/reset here is a normal withdrawal, not an error
    }
    if (ctx.requestId !== null && ctx.openerKind === 'subscribe-namespace') {
      const requestId = ctx.requestId;
      await this.executeActions(this.session.handleInboundSubscribeNamespaceClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
      await ctx.terminate(); // release our half — no half-open stream retained
      this.onSubscribeNamespaceClosed?.(requestId);
      return; // FIN/reset here is the §10.18 cancellation, not an error
    }
    if (ctx.requestId !== null && ctx.openerKind === 'subscribe-tracks') {
      const requestId = ctx.requestId;
      await this.executeActions(this.session.handleInboundSubscribeTracksClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
      await ctx.terminate(); // release our half — no half-open stream retained
      this.onSubscribeTracksClosed?.(requestId);
      return; // FIN/reset here is the §10.19 cancellation, not an error
    }
    if (ctx.requestId !== null && ctx.openerKind === 'track-status' && err === null) {
      // §10.14: a one-shot TRACK_STATUS — the subscriber FINs its send side right
      // after sending the request, but we still owe exactly one REQUEST_OK /
      // REQUEST_ERROR. Keep the context (our writable is still open) so
      // accept/rejectTrackStatus can respond; it is finalized + removed then.
      // (A reset — err !== null — falls through to the cancellation path below.)
      return;
    }
    if (ctx.requestId !== null) {
      // §3.3.2: a FIN/reset on any other bound inbound request stream (PUBLISH /
      // SUBSCRIBE / FETCH / TRACK_STATUS) is a normal lifecycle end / cancellation
      // — clean up the request, do NOT surface it as an error.
      const requestId = ctx.requestId;
      const wasSubscribe = ctx.openerKind === 'subscribe';
      // §11.1: an inbound PUBLISH ending must ALSO tear down its adapter routing
      // and arm a bounded late-object guard (not retain publishAliasMaps forever)
      // — but only for the route THIS request still owns (found by requestId), so
      // a reused alias's newer publication is untouched. Captured before the
      // session teardown below (which unregisters the session alias).
      const pubAlias = ctx.openerKind === 'publish'
        ? [...this.publishAliasMaps].find(([, p]) => p.requestId === requestId)?.[0]
        : undefined;
      // SYNCHRONOUS route removal + tombstone install + FETCH deauthorization
      // (before the FIRST await) so nothing can slip through the teardown window:
      //   - a late object can't route (armTerminatedAlias drops publishAliasMaps);
      //   - a concurrent openFetchStream() can't open a response stream for the
      //     cancelled FETCH — its group-order authorization is gone before we await,
      //     and its post-await re-check now fails (§10.13). Deauthorizing only AFTER
      //     the session-teardown await left a window in which a new stream opened.
      if (pubAlias !== undefined) this.armTerminatedAlias(pubAlias, null, /* strict */ false);
      this.inboundFetchGroupOrder.delete(requestId);
      this.fetchServeReserved.delete(requestId); // the one-stream reservation is released on teardown
      this.inboundPublishTimeouts.delete(requestId); // never-accepted inbound PUBLISH
      // §10.13: DETACH every open FETCH response stream SYNCHRONOUSLY (before the
      // first await), so sendFetchObject()/closeFetchStream() for this cancelled
      // fetch fail immediately rather than continuing to write during the teardown
      // awaits below. The writers are aborted afterward.
      const fetchWriters = this.detachFetchStreamsForRequest(requestId);
      await this.executeActions(this.session.handleInboundRequestClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
      if (pubAlias !== undefined) await this.discardOpenStreamsForAlias(pubAlias);
      // §5.1.1: the subscriber cancelled — RESET every publisher data stream
      // still open for this subscription and drop its accounting, so no more
      // objects can be written for a subscription the peer abandoned.
      if (wasSubscribe) await this.abortPublisherStreamsForRequest(requestId);
      // The peer ended its direction; FIN ours too so the stream fully closes
      // instead of lingering half-open (idempotent if already terminated).
      await ctx.terminate();
      // Abort the detached FETCH response writers (already unreachable via the maps).
      for (const w of fetchWriters) { try { await w.abort('inbound FETCH request stream closed'); } catch { /* already torn down */ } }
      // A canceled FETCH request stream removes its parked join — otherwise a
      // later acceptSubscribe would surface a ghost onFetch for a request the
      // peer already abandoned.
      if (ctx.openerKind === 'fetch') {
        for (const [subReqId, parked] of this.pendingJoinFetches) {
          const idx = parked.findIndex((e) => e.requestId === requestId);
          if (idx < 0) continue;
          clearTimeout(parked[idx]!.timer);
          parked.splice(idx, 1);
          if (parked.length === 0) this.pendingJoinFetches.delete(subReqId);
          break;
        }
      }
      // A canceled SUBSCRIBE promptly rejects its parked joins (the
      // subscription left the Pending/Established states) instead of leaving
      // them to the timeout.
      if (wasSubscribe) {
        this.deferredUpdateResponses.delete(requestId);
        await this.settleParkedJoins(requestId, false);
      }
      // §3.3.2: a subscriber resetting its SUBSCRIBE stream IS the draft-18
      // unsubscribe — surface it so the publisher can drop just that subscription.
      if (wasSubscribe) this.onSubscribeClosed?.(requestId);
      return;
    }
    // An UNBOUND inbound stream (no valid opener yet) that failed — surface it.
    if (err) await this.failInboundRequest(err);
  }

  /** Close the session on a PUBLISH-stream protocol violation; else surface it. */
  private async failInboundRequest(err: Error): Promise<void> {
    if (err instanceof ProtocolViolationError) {
      this.closeSessionFatal(err.message); // centralized: also rejects pending promises
      return;
    }
    this.onError?.(new MoqtConnectionError(
      err.message,
      { errorSource: 'control', cause: err },
    ));
  }

  /** Route a message from an inbound request stream — PUBLISH (§10.10),
   *  SUBSCRIBE (§10.7), or FETCH (§10.16). The context handles local REQUEST_UPDATE
   *  responses; this sees the opener, PUBLISH_DONE, and peer REQUEST_UPDATEs. */
  private async dispatchInboundRequestMessage(
    message: DecodedControlMessage,
    ctx: InboundRequestStreamContext,
  ): Promise<void> {
    if (ctx.requestId === null) {
      // §3.3: the first inbound message must be a valid request-stream opener:
      // PUBLISH (§10.10), SUBSCRIBE (§10.7), FETCH (§10.12), TRACK_STATUS (§10.14),
      // or PUBLISH_NAMESPACE (§10.15).
      if (message.type === 'PUBLISH') {
        await this.bindInboundPublish(message as Publish, ctx);
        return;
      }
      if (message.type === 'SUBSCRIBE') {
        await this.bindInboundSubscribe(message as Subscribe, ctx);
        return;
      }
      if (message.type === 'FETCH') {
        await this.bindInboundFetch(message as Fetch, ctx);
        return;
      }
      if (message.type === 'TRACK_STATUS') {
        await this.bindInboundTrackStatus(message as TrackStatus, ctx);
        return;
      }
      if (message.type === 'PUBLISH_NAMESPACE') {
        await this.bindInboundPublishNamespace(message as PublishNamespace, ctx);
        return;
      }
      if (message.type === 'SUBSCRIBE_NAMESPACE') {
        await this.bindInboundSubscribeNamespace(message as SubscribeNamespace, ctx);
        return;
      }
      if (message.type === 'SUBSCRIBE_TRACKS') {
        await this.bindInboundSubscribeTracks(message as SubscribeTracks, ctx);
        return;
      }
      throw new ProtocolViolationError(
        `first inbound bidi message must be PUBLISH, SUBSCRIBE, FETCH, TRACK_STATUS, PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, or SUBSCRIBE_TRACKS, got ${message.type}`,
      );
    }

    const originalId = ctx.requestId;
    if (message.type === 'PUBLISH_DONE') {
      // §10.11: terminate the subscription. Only an inbound PUBLISH carries a
      // PUBLISH_DONE; on any other opener it is a protocol violation.
      if (ctx.openerKind !== 'publish') {
        throw new ProtocolViolationError(`PUBLISH_DONE is not valid on a ${ctx.openerKind} request stream`);
      }
      // §10.11: bounded early-discard — capture the published alias, terminate,
      // then apply the Stream Count so open/late streams are STOP_SENDINGed and
      // the alias tombstone is cleared once the count is met (or the TTL fires),
      // rather than retaining the publication's routing indefinitely.
      const doneAlias = [...this.publishAliasMaps].find(([, p]) => p.requestId === originalId)?.[0];
      const streamCount = (message as { streamCount?: bigint }).streamCount ?? 0n;
      const stamped = { ...message, requestId: originalId } as ControlMessage;
      this.onMessage?.(stamped);
      // Arm the terminal guard + remove the route SYNCHRONOUSLY (before the
      // session-teardown await) so no late object slips through the window.
      const discard = doneAlias !== undefined
        ? this.applyTerminalStreamCount(doneAlias, BigInt(streamCount), originalId)
        : Promise.resolve();
      await this.executeActions(this.session.handleInboundPublishDone(originalId));
      ctx.seal();
      this.inboundRequestContexts.delete(originalId);
      await discard;
      return;
    }

    if (message.type === 'REQUEST_UPDATE') {
      // §10.14: TRACK_STATUS is one-shot — no REQUEST_UPDATE may follow it.
      if (ctx.openerKind === 'track-status') {
        throw new ProtocolViolationError('REQUEST_UPDATE is not valid on a TRACK_STATUS request stream');
      }
      // Peer-initiated REQUEST_UPDATE: the wire carries the update's own Request
      // ID; the Existing Request ID is the original request (stream context). The
      // session routes it by the opener — a PUBLISH subscription update, or a
      // §10.9.2 SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS prefix update.
      const updateId = (message as { requestId: bigint }).requestId;
      const stamped = { ...message, existingRequestId: originalId } as ControlMessage;
      this.onMessage?.(stamped);
      const actions = this.session.handleControlMessage(stamped, {
        requestId: updateId,
        existingRequestId: originalId,
      });
      // §10.9: respond with exactly one REQUEST_OK / REQUEST_ERROR on THIS stream.
      // If handling produced a session close (e.g. unknown/invalid update), do
      // NOT also write a success response — close and stop.
      const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
      if (closeAction) {
        await this.executeActions(actions);
        this.notifyClose(closeAction, 'REQUEST_UPDATE rejected');
        return;
      }
      const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
      // §10.8: SUBSCRIBE_OK is the FIRST response on a successful subscribe
      // stream. An update racing a still-PENDING subscription is APPLIED
      // immediately (§10.12.2), but its REQUEST_OK is deferred and flushed —
      // FIFO — right after SUBSCRIBE_OK / REQUEST_ERROR is written.
      if (send && ctx.openerKind === 'subscribe'
          && this.session.getIncomingSubscription(originalId)?.state === SubscriptionState.PENDING) {
        const queued = this.deferredUpdateResponses.get(originalId) ?? [];
        // BOUNDED: a peer flooding updates while the application leaves the
        // SUBSCRIBE pending must not grow this queue without opening streams.
        // Exceeding the bound rejects the SUBSCRIBE itself with EXCESSIVE_LOAD
        // (a REQUEST_ERROR is a valid first response) — queued acks flush
        // behind it and the stream is finished.
        if (queued.length >= MoqtConnection.MAX_DEFERRED_UPDATE_RESPONSES) {
          queued.push(send.message);
          this.deferredUpdateResponses.set(originalId, queued);
          await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
          await this.rejectSubscribe(originalId, RequestError18.EXCESSIVE_LOAD as bigint,
            'too many REQUEST_UPDATEs on a pending subscription');
          return;
        }
        queued.push(send.message);
        this.deferredUpdateResponses.set(originalId, queued);
        await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
        return;
      }
      if (send) await ctx.writeMessage(send.message);
      await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
      // §10.9.1: a REQUEST_ERROR to a prefix/namespace update terminates that
      // request — the responder MUST close BOTH halves of the bidi stream (FIN
      // our writable AND STOP_SENDING the readable), not just FIN. Applies to the
      // continuing/persistent request streams: SUBSCRIBE_NAMESPACE (§10.18),
      // SUBSCRIBE_TRACKS (§10.19), and PUBLISH_NAMESPACE (§10.15).
      const persistentOpener = ctx.openerKind === 'subscribe-namespace'
        || ctx.openerKind === 'subscribe-tracks'
        || ctx.openerKind === 'publish-namespace';
      if (send?.message.type === 'REQUEST_ERROR' && persistentOpener) {
        ctx.seal();
        await ctx.terminate();
        this.inboundRequestContexts.delete(originalId);
      }
      return;
    }

    throw new ProtocolViolationError(`unexpected ${message.type} on inbound request stream`);
  }

  /**
   * A session-generated close_connection (a peer protocol violation the session
   * decided). The action was already executed by the caller, so the session is
   * closing; route through the one-shot terminal coordinator (which also rejects
   * pending operations and clears timers — not just fires onClose).
   */
  private notifyClose(closeAction: CloseConnectionAction, fallbackReason: string): void {
    this.terminate(Number(closeAction.error), closeAction.reason ?? fallbackReason);
  }

  /** Validate + bind an inbound PUBLISH (§10.10). */
  private async bindInboundPublish(pub: Publish, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = pub.requestId as bigint;
    this.onMessage?.(pub);
    const actions = this.session.handleControlMessage(pub);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'PUBLISH rejected');
      return;
    }
    // §5.1: the session may reject a duplicate PUBLISH with a per-request
    // REQUEST_ERROR. draft-18 has no control stream — write it on THIS request's
    // own bidi stream and seal, WITHOUT binding or surfacing via onPublish.
    if (await this.autoRejectInboundRequest(actions, ctx)) return;
    await this.executeActions(actions);
    ctx.bind(requestId, 'publish');
    this.inboundRequestContexts.set(requestId, ctx);
    // §2.5.1 / §2.4.2: a PUBLISH whose Track Properties carry an unsupported
    // Mandatory Track Property (→ UNSUPPORTED_EXTENSION) or a data-Object-only
    // Property (→ MALFORMED_TRACK) MUST NOT be processed — respond with
    // REQUEST_ERROR on its own stream, do NOT surface via onPublish. Not a session
    // close (the request, not the connection, failed).
    const fault = this.trackPropertyFault(pub);
    if (fault) {
      // REQUEST_ERROR + FIN + seal in ONE finalized write: a publish fault has
      // no subscription lifecycle (no parked joins, no deferred update
      // responses), and extra awaits before finish() would race the peer-FIN
      // cleanup that cancels this context.
      const actions = this.session.rejectSubscribe(requestId, fault.code, fault.reason);
      await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true);
      return;
    }
    // §11.1: refuse an inbound PUBLISH that reuses a Track Alias still guarded by
    // a terminating prior generation — binding it would risk misdelivering an old
    // late stream to this new track. Reject with REQUEST_ERROR (not a session
    // close): the request, not the connection, is at fault.
    const pubAlias = pub.trackAlias as bigint;
    if (!this.aliasReuseSafe(pubAlias)) {
      const actions = this.session.rejectSubscribe(
        requestId, RequestError18.DUPLICATE_SUBSCRIPTION as bigint,
        `track alias ${pubAlias} is still guarded by a terminating prior subscription (§11.1)`,
      );
      await this.writeInboundRequestResponse(requestId, actions, /* finalize */ true);
      return;
    }
    // The old generation's complete guard (if any) is safe to clear now.
    this.clearTerminatedAlias(pubAlias);
    const incoming: IncomingPublish = {
      requestId,
      trackNamespace: pub.trackNamespace,
      trackName: pub.trackName,
      trackAlias: pubAlias,
      onObject: null,
    };
    this.publishAliasMaps.set(incoming.trackAlias, incoming);
    // §8 applies to a PUBLISH-initiated subscription too. Capture the publisher's raw
    // OBJECT/SUBGROUP_DELIVERY_TIMEOUT Track Properties so acceptSubscribe can COMBINE
    // them with OUR PUBLISH_OK Message Parameters; set a provisional (publisher-only)
    // guard value now in case we never set subscriber params.
    const props = this.trackPropsOf(pub);
    const pubObj = this.trackPropMs(props, 0x02n) ?? 0;
    const pubSub = this.trackPropMs(props, 0x06n) ?? 0;
    this.inboundPublishTimeouts.set(requestId, { obj: pubObj, sub: pubSub });
    this.aliasPublisherTimeout.set(pubAlias, { obj: pubObj, sub: pubSub });
    const provisional = this.combineDeliveryTimeoutMs(pubObj, pubSub, 0, 0);
    if (provisional > 0) this.aliasDeliveryTimeoutMs.set(pubAlias, provisional);
    this.onPublish?.(incoming);
  }

  /**
   * Validate + bind an inbound SUBSCRIBE (§10.7). We are the publisher; the
   * stream stays open so acceptSubscribe / rejectSubscribe can write SUBSCRIBE_OK
   * / REQUEST_ERROR on it, and a later peer REQUEST_UPDATE can be answered there.
   */
  /**
   * draft-18 §3.2: the session may auto-reject an inbound request (a reserved
   * `.`/`.session` namespace) by returning a per-request REQUEST_ERROR from
   * handleControlMessage. Write it on the request's OWN bidi stream and FIN/seal,
   * WITHOUT binding the request or surfacing it to the application. Any other
   * returned actions (e.g. MAX_REQUEST_ID replenish) run on the control path.
   * @returns true if the request was auto-rejected and fully handled here.
   */
  private async autoRejectInboundRequest(
    actions: SessionOutboundAction[],
    ctx: InboundRequestStreamContext,
  ): Promise<boolean> {
    const reqErr = actions.find(
      (a) => a.type === 'send_control' && (a as SendControlAction).message.type === 'REQUEST_ERROR',
    ) as SendControlAction | undefined;
    if (!reqErr) return false;
    await ctx.writeMessage(reqErr.message);
    await this.executeActions(actions.filter((a) => a !== reqErr));
    await ctx.finish();
    ctx.seal();
    return true;
  }

  private async bindInboundSubscribe(sub: Subscribe, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = sub.requestId as bigint;
    this.onMessage?.(sub);
    const actions = this.session.handleControlMessage(sub);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'SUBSCRIBE rejected');
      return;
    }
    if (await this.autoRejectInboundRequest(actions, ctx)) return; // §3.2 reserved namespace
    await this.executeActions(actions);
    ctx.bind(requestId, 'subscribe');
    this.inboundRequestContexts.set(requestId, ctx);
    this.onSubscribe?.(requestId, sub.trackNamespace, sub.trackName, sub.parameters as Map<bigint, unknown>);
  }

  /**
   * Validate + bind an inbound FETCH (§10.12). We are the publisher; the stream
   * stays open so acceptFetch / rejectFetch can write FETCH_OK / REQUEST_ERROR
   * on it. The FETCH response data is sent on a separate uni stream via
   * openFetchStream / sendFetchObject / sendFetchEndOfRange.
   */
  private async bindInboundFetch(fetch: Fetch, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = fetch.requestId as bigint;
    this.onMessage?.(fetch);
    const actions = this.session.handleControlMessage(fetch);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'FETCH rejected');
      return;
    }
    if (await this.autoRejectInboundRequest(actions, ctx)) return; // §3.2 reserved namespace
    await this.executeActions(actions);
    ctx.bind(requestId, 'fetch');
    this.inboundRequestContexts.set(requestId, ctx);
    // §10.2 GROUP_ORDER (0x22): 0x2 = Descending, else (incl. absent) Ascending.
    const order = fetch.parameters.get(0x22n)?.[0];
    this.inboundFetchGroupOrder.set(requestId, order === 2n ? 'descending' : 'ascending');

    // draft-18 §10.12.2: buffer a Joining Fetch whose subscription is still
    // PENDING; the app sees it via onFetch only once acceptSubscribe runs.
    if (fetch.fetch.fetchType !== 0x1) {
      const joiningReqId = (fetch.fetch as JoiningFetch).joiningRequestId as bigint;
      const sub = this.session.getIncomingSubscription(joiningReqId);
      if (sub && sub.state === SubscriptionState.PENDING) {
        const entry = {
          requestId,
          fetch,
          timer: setTimeout(() => { void this.expireParkedJoin(joiningReqId, requestId); }, this.joiningFetchTimeoutMs),
        };
        const parked = this.pendingJoinFetches.get(joiningReqId) ?? [];
        parked.push(entry);
        this.pendingJoinFetches.set(joiningReqId, parked);
        return;
      }
    }
    this.onFetch?.(requestId, fetch);
  }

  /** Timeout for a parked Joining Fetch (§10.12.2 "or the request times out"). */
  private async expireParkedJoin(joiningReqId: bigint, requestId: bigint): Promise<void> {
    const parked = this.pendingJoinFetches.get(joiningReqId);
    if (!parked) return;
    const idx = parked.findIndex((e) => e.requestId === requestId);
    if (idx < 0) return;
    parked.splice(idx, 1);
    if (parked.length === 0) this.pendingJoinFetches.delete(joiningReqId);
    try {
      await this.rejectFetch(requestId, RequestError18.TIMEOUT as bigint,
        'joining fetch timed out waiting for the subscription to establish (§10.12.2)');
    } catch { /* stream already gone */ }
  }

  /**
   * Release (surface) or reject every Joining Fetch parked on `subRequestId`.
   * Called from acceptSubscribe / rejectSubscribe.
   */
  private async settleParkedJoins(subRequestId: bigint, accepted: boolean): Promise<void> {
    const parked = this.pendingJoinFetches.get(subRequestId);
    if (!parked) return;
    this.pendingJoinFetches.delete(subRequestId);
    for (const entry of parked) {
      clearTimeout(entry.timer);
      if (!accepted) {
        try {
          await this.rejectFetch(entry.requestId, RequestError18.INVALID_JOINING_REQUEST_ID as bigint,
            'the joined subscription was rejected (§10.12.2)');
        } catch { /* stream already gone */ }
        continue;
      }
      // §10.12.2: the Forward-State gate is evaluated NOW — at establish
      // time, after any REQUEST_UPDATEs that raced establishment have been
      // applied — never when the join arrived.
      const sub = this.session.getIncomingSubscription(subRequestId);
      if (!sub || sub.forwardState !== ForwardState.ACTIVE) {
        try {
          await this.rejectFetch(entry.requestId, RequestError18.INVALID_RANGE as bigint,
            'Joining Fetch on a subscription with Forward State 0 at establish (§10.12.2)');
        } catch { /* stream already gone */ }
        continue;
      }
      this.onFetch?.(entry.requestId, entry.fetch);
    }
  }

  /**
   * Validate + bind an inbound TRACK_STATUS (§10.14). One-shot: we are the
   * publisher; the application answers via acceptTrackStatus / rejectTrackStatus,
   * which writes REQUEST_OK / REQUEST_ERROR on this stream and then FINs it. No
   * REQUEST_UPDATE or PUBLISH_DONE may follow (enforced in dispatch).
   */
  private async bindInboundTrackStatus(ts: TrackStatus, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = ts.requestId as bigint;
    this.onMessage?.(ts);
    const actions = this.session.handleControlMessage(ts);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'TRACK_STATUS rejected');
      return;
    }
    if (await this.autoRejectInboundRequest(actions, ctx)) return; // §3.2 reserved namespace
    await this.executeActions(actions);
    ctx.bind(requestId, 'track-status');
    this.inboundRequestContexts.set(requestId, ctx);
    this.onTrackStatus?.(requestId, ts);
  }

  /**
   * Validate + bind an inbound PUBLISH_NAMESPACE (§10.15). The session
   * auto-acknowledges with REQUEST_OK; we write that on THIS bidi stream (not the
   * control stream) and keep the stream open. A later peer REQUEST_UPDATE is
   * answered on the same stream; a FIN/reset withdraws the namespace (§3.3.2).
   */
  private async bindInboundPublishNamespace(pn: PublishNamespace, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = pn.requestId as bigint;
    this.onMessage?.(pn);
    const actions = this.session.handleControlMessage(pn);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'PUBLISH_NAMESPACE rejected');
      return;
    }
    if (await this.autoRejectInboundRequest(actions, ctx)) return; // §3.2 reserved namespace
    ctx.bind(requestId, 'publish-namespace');
    this.inboundRequestContexts.set(requestId, ctx);
    // Write the REQUEST_OK on the bidi stream — NOT the control stream — then run
    // any remaining actions (replenish, notify_namespace).
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
    if (send) await ctx.writeMessage(send.message);
    await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
    this.onPublishNamespace?.(requestId, pn);
  }

  /**
   * Validate + bind an inbound SUBSCRIBE_NAMESPACE (§10.18). We are the publisher.
   * The session validates the prefix and Request ID; an overlapping prefix yields
   * an immediate REQUEST_ERROR (PREFIX_OVERLAP) written on the bidi stream, which
   * we then FIN/seal WITHOUT binding or firing the callback. Otherwise the request
   * is held PENDING and the application answers via acceptSubscribeNamespace /
   * rejectSubscribeNamespace; the stream stays open for NAMESPACE updates.
   */
  private async bindInboundSubscribeNamespace(sn: SubscribeNamespace, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = sn.requestId as bigint;
    this.onMessage?.(sn);
    const actions = this.session.handleControlMessage(sn);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'SUBSCRIBE_NAMESPACE rejected');
      return;
    }
    // An immediate REQUEST_ERROR (e.g. PREFIX_OVERLAP) means the request was NOT
    // accepted: write it on the bidi stream, FIN, and do not bind or notify.
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
    if (send) {
      await ctx.writeMessage(send.message);
      await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
      // §10.9.1: an immediate REQUEST_ERROR is terminal — close BOTH directions
      // (FIN writable + STOP_SENDING readable), not just FIN, so the rejected
      // continuing stream leaves no half-open reader.
      ctx.seal();
      await ctx.terminate();
      return;
    }
    // Held PENDING — bind and surface to the application for accept/reject.
    ctx.bind(requestId, 'subscribe-namespace');
    this.inboundRequestContexts.set(requestId, ctx);
    await this.executeActions(actions); // replenish only
    this.onSubscribeNamespace?.(requestId, sn);
  }

  /**
   * Validate + bind an inbound SUBSCRIBE_TRACKS (§10.19). We are the publisher.
   * The session validates the prefix and Request ID; an overlapping prefix (only
   * vs other incoming SUBSCRIBE_TRACKS) yields an immediate REQUEST_ERROR
   * (PREFIX_OVERLAP) written on the bidi stream, which we then FIN/seal WITHOUT
   * binding or firing the callback. Otherwise the request is held PENDING and the
   * application answers via acceptSubscribeTracks / rejectSubscribeTracks; the
   * stream stays open for PUBLISH (new streams) and PUBLISH_BLOCKED.
   */
  private async bindInboundSubscribeTracks(st: SubscribeTracks, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = st.requestId as bigint;
    this.onMessage?.(st);
    const actions = this.session.handleControlMessage(st);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    if (closeAction) {
      await this.executeActions(actions);
      await ctx.abort();
      this.notifyClose(closeAction, 'SUBSCRIBE_TRACKS rejected');
      return;
    }
    // An immediate REQUEST_ERROR (e.g. PREFIX_OVERLAP) means it was NOT accepted:
    // write it on the bidi stream, FIN, and do not bind or notify.
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
    if (send) {
      await ctx.writeMessage(send.message);
      await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
      // §10.9.1: an immediate REQUEST_ERROR is terminal — close BOTH directions
      // (FIN writable + STOP_SENDING readable), not just FIN, so the rejected
      // continuing stream leaves no half-open reader.
      ctx.seal();
      await ctx.terminate();
      return;
    }
    ctx.bind(requestId, 'subscribe-tracks');
    this.inboundRequestContexts.set(requestId, ctx);
    await this.executeActions(actions); // replenish only
    this.onSubscribeTracks?.(requestId, st);
  }

  /**
   * Process a single incoming data stream: decode header, then objects.
   *
   * Stream types (determined by the leading type; a vi64 in draft-18):
   * - SUBGROUP_HEADER: 0x10–0x3D (draft-14/16), widened to the 0b0XX1XXXX form
   *   incl. 0x50–0x5F / 0x70–0x7F in draft-18 (FIRST_OBJECT bit)
   * - FETCH_HEADER: 0x05
   * - draft-18 also defines PADDING streams (discarded) and a vi64 SETUP type.
   *
   * @see draft-ietf-moq-transport-16 §10.4, draft-ietf-moq-transport-18 §11.4
   */
  private async processDataStream(
    stream: ReadableStream<Uint8Array>,
    streamId: bigint,
  ): Promise<void> {
    const reader = stream.getReader();
    // Track the reader so STOP_SENDING can be sent later (§10.4.3)
    this.dataStreamReaders.set(streamId, reader);
    let buf: Uint8Array = new Uint8Array(0);

    try {
      // Phase 1: Accumulate bytes and decode the stream header
      const headerResult = await this.readStreamHeader(reader, buf);
      if (!headerResult) {
        // Stream closed before header could be decoded
        // Stream closed before header could be decoded — non-fatal
        this.onStreamClosed?.(streamId);
        return;
      }
      if (headerResult.type === 'discard') {
        // draft-18 padding stream — drain and drop the remaining bytes.
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        this.onStreamClosed?.(streamId);
        return;
      }
      buf = headerResult.remaining;

      if (headerResult.type === 'subgroup') {
        const header = headerResult.header as SubgroupHeader;
        const subgroupAlias = header.trackAlias as bigint;
        // §10.11 receiver terminal tracker: a stream for an alias whose
        // PUBLISH_DONE already arrived is a LATE expected stream — early-discard
        // it (STOP_SENDING), count it against the announced total, and clear the
        // tombstone once the whole count is observed. Never delivered.
        const tombstone = this.terminatedAliases.get(subgroupAlias);
        if (tombstone) {
          // Count down only a KNOWN remaining (bigint); a null remaining is the
          // 2^62-1 sentinel — unknown count, cleared by TTL alone. Clear as soon
          // as the known count is met so a legitimately reused alias isn't held.
          if (tombstone.remaining !== null) {
            tombstone.remaining -= 1n;
            if (tombstone.remaining <= 0n) this.clearTerminatedAlias(subgroupAlias);
          }
          try { await reader.cancel(new Error('late stream on a terminated alias — early discard (§10.11)')); } catch { /* closed */ }
          this.dataStreamReaders.delete(streamId);
          this.onStreamClosed?.(streamId);
          return;
        }
        // Count the stream toward this alias's lifetime total (so a later
        // PUBLISH_DONE knows how many streams are still outstanding) and track
        // it as open so the terminal message can STOP_SENDING it.
        this.aliasStreamsSeen.set(subgroupAlias, (this.aliasStreamsSeen.get(subgroupAlias) ?? 0n) + 1n);
        this.incomingSubgroupAliases.set(streamId, subgroupAlias);
        // Header decoded — route objects below
        this.onQlogEvent?.({
          type: 'stream_type_set',
          owner: 'remote',
          stream_id: streamId,
          stream_type: 'subgroup_header',
        });
        this.onQlogEvent?.({
          type: 'subgroup_header_parsed',
          stream_id: streamId,
          track_alias: header.trackAlias as bigint,
          group_id: header.groupId as bigint,
          subgroup_id_mode: getSubgroupIdMode(header.typeByte),
          ...(header.subgroupId !== undefined ? { subgroup_id: header.subgroupId as bigint } : {}),
          ...(header.publisherPriority !== undefined ? { publisher_priority: header.publisherPriority } : {}),
          contains_end_of_group: header.isEndOfGroup,
          extensions_present: header.hasExtensions,
        });
        this.onDataStream?.(streamId, { type: 'subgroup', header });
        // Phase 2: Decode subgroup objects
        await this.readSubgroupObjects(reader, buf, streamId, header);
      } else {
        const header = headerResult.header as FetchHeader;
        const fetchReqId = header.requestId as bigint;
        // §10.13: a data stream for a fetch WE cancelled may still be in flight. It is
        // NOT a new fetch nor a §11.4.4 duplicate — DISCARD it (STOP_SENDING via the
        // finally's reader cleanup) and CONSUME the one-shot marker (a cancellation
        // has at most one such stream; consuming keeps the marker set from lingering).
        if (this.recentlyCancelledFetches.has(fetchReqId)) {
          this.recentlyCancelledFetches.delete(fetchReqId);
          await reader.cancel(new Error('FETCH cancelled — late data stream discarded')).catch(() => { /* already closed */ });
          return;
        }
        // §11.4.4: a FETCH response uses EXACTLY ONE unidirectional stream. A second
        // stream for a request that ALREADY has one currently open is a
        // PROTOCOL_VIOLATION (it would otherwise silently OVERWRITE the mapping). We
        // scope this to a still-OPEN stream (`fetchStreams`, cleared on FIN/cancel):
        // a late stream for a gone (cancelled/completed) fetch is not our concern and
        // must never close the session — so no separate "seen after FIN" set that
        // could be count-evicted into a false close.
        if (this.fetchStreams.has(fetchReqId)) {
          throw new ProtocolViolationError(
            `second FETCH response stream for request ${fetchReqId} while one is open (§11.4.4: exactly one)`,
          );
        }
        // §10.4.4: Track fetch requestId → streamId for STOP_SENDING on cancel
        this.fetchStreams.set(fetchReqId, streamId);
        this.onQlogEvent?.({
          type: 'stream_type_set',
          owner: 'remote',
          stream_id: streamId,
          stream_type: 'fetch_header',
        });
        this.onQlogEvent?.({
          type: 'fetch_header_parsed',
          stream_id: streamId,
          request_id: header.requestId as bigint,
        });
        this.onDataStream?.(streamId, { type: 'fetch', header });
        // Phase 2: Decode fetch objects. draft-18 has its own object format
        // (group-order-aware deltas, End-of-Range prior rules) and correlates by
        // FETCH_HEADER.requestId — not by a (fabricated) track alias.
        if (this.dataCodec!.version === 18) {
          await this.readFetchObjects18(reader, buf, streamId, header);
        } else {
          await this.readFetchObjects(reader, buf, streamId);
        }
      }

      this.onStreamClosed?.(streamId);
    } catch (err) {
      // §10.4, §10.4.2, §10.4.4, §10.2.1.2: Protocol violations on data
      // streams MUST close the session with PROTOCOL_VIOLATION.
      if (err instanceof ProtocolViolationError) {
        this.closeSessionFatal(err.message);
        return;
      }

      // §10.4.3: RESET_STREAM is a normal stream lifecycle event —
      // it occurs on UNSUBSCRIBE (§5.1.1), delivery timeout (§9.2.2.2),
      // subscription updates, and publisher decisions.
      // Only surface as onError for non-RESET_STREAM failures.
      const streamErrorCode = typeof (err as any)?.streamErrorCode === 'number'
        ? (err as any).streamErrorCode as number
        : undefined;
      // A real transport close makes in-flight data reads throw AFTER terminal
      // shutdown — do not emit a spurious post-close error event.
      const terminated = this._terminated || this.session.state === SessionState.CLOSED;
      if (streamErrorCode === undefined && !terminated) {
        // Not a RESET_STREAM — genuine read error
        this.onError?.(new MoqtConnectionError(
          err instanceof Error ? err.message : String(err),
          {
            errorSource: 'data',
            streamId: BigInt(streamId),
            ...(err instanceof Error ? { cause: err } : {}),
          },
        ));
      }
      // Always notify stream closed — player can inspect the code if needed
      this.onStreamClosed?.(streamId, streamErrorCode);
    } finally {
      this.dataStreamReaders.delete(streamId);
      this.incomingSubgroupAliases.delete(streamId);
      // Clean up fetch stream association (and any draft-18 group-order state), and
      // RECLAIM the completed outgoing fetch in the Session (§5.2: the fetch ends on
      // its data-stream FIN/reset). Group-order removal makes a later FETCH_HEADER for
      // this now-completed request a §10.12.3/§11.4.4 PROTOCOL_VIOLATION (exactly one
      // response stream per fetch) — a cancelled fetch is instead recognized by its
      // lossless cancellation marker and its late stream discarded; a completed one
      // has no marker, so a second stream is correctly rejected.
      for (const [reqId, sid] of this.fetchStreams) {
        if (sid === streamId) {
          this.fetchStreams.delete(reqId);
          this.fetchGroupOrder.delete(reqId);
          this.session.handleFetchStreamFinished(reqId);
          // §10.13: if the FETCH_OK also arrived, the fetch is complete — close the
          // request bidi so the fetcher's topology context does not leak.
          void this.closeCompletedFetchRequest(reqId);
          break;
        }
      }
    }
  }

  /**
   * Read and decode the stream header (subgroup or fetch).
   * Accumulates bytes until the header can be decoded.
   */
  private async readStreamHeader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buf: Uint8Array,
  ): Promise<
    | { type: 'subgroup' | 'fetch'; header: SubgroupHeader | FetchHeader; remaining: Uint8Array }
    | { type: 'discard' }
    | undefined
  > {
    while (true) {
      // Try to decode if we have any bytes
      if (buf.length > 0) {
        const firstByte = buf[0]!;

        // Determine stream type from its leading type. In draft-18 the type is a
        // vi64 that can itself be fragmented across reads, so classifyStream may
        // throw RangeError — treat that as "need more bytes" and read on.
        let streamClass: StreamClass | undefined;
        try {
          streamClass = this.dataCodec!.classifyStream(buf, 0);
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
          streamClass = undefined; // incomplete vi64 stream type — read more
        }
        if (streamClass === 'subgroup') {
          try {
            const { header, bytesRead } = this.dataCodec!.decodeSubgroupHeader(buf, 0);
            return { type: 'subgroup', header, remaining: buf.subarray(bytesRead) };
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            // Not enough bytes yet — fall through to read more
          }
        } else if (streamClass === 'fetch') {
          try {
            const { header, bytesRead } = this.dataCodec!.decodeFetchHeader(buf, 0);
            return { type: 'fetch', header, remaining: buf.subarray(bytesRead) };
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
          }
        } else if (streamClass === 'padding') {
          // draft-18 §11.5.1: PADDING streams carry arbitrary discardable bytes.
          // Signal the caller to drain and drop the rest of the stream.
          return { type: 'discard' };
        } else if (streamClass !== undefined) {
          // Complete but unrecognized stream type (e.g. SETUP on a data stream).
          throw new ProtocolViolationError(
            `Unknown data stream type (leading byte 0x${firstByte.toString(16)}) — expected SUBGROUP_HEADER or FETCH_HEADER (0x05)`,
          );
        }
        // streamClass === undefined → incomplete type, fall through to read more
      }

      // Read more bytes from the stream
      const { value, done } = await reader.read();
      if (done) {
        // §10.4: FIN with partial header bytes is mid-object
        if (buf.length > 0) {
          // Stream FIN arrived mid-header parse — protocol violation
          this.closeSessionFatal('Stream FIN received mid-header');
        }
        return undefined;
      }
      buf = this.appendBuffer(buf, value);
    }
  }

  /**
   * Read and decode subgroup objects until the stream closes.
   * @see draft-ietf-moq-transport-16 §10.4.2
   */
  private async readSubgroupObjects(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buf: Uint8Array,
    streamId: bigint,
    header: SubgroupHeader,
  ): Promise<void> {
    let previousObjectId: bigint = 0n;
    let isFirstObject = true;

    while (true) {
      // Try to decode an object from the buffer
      if (buf.length > 0) {
        try {
          const { object, bytesRead } = this.dataCodec!.decodeSubgroupObject(
            buf,
            0,
            header.hasExtensions,
            previousObjectId,
            isFirstObject,
          );
          buf = buf.subarray(bytesRead);

          // §10.4.2: "0b01: The Subgroup ID field is absent and the Subgroup ID
          // is the Object ID of the first Object transmitted in this Subgroup."
          if (
            isFirstObject &&
            getSubgroupIdMode(header.typeByte) === SubgroupIdMode.FIRST_OBJECT
          ) {
            header = { ...header, subgroupId: object.objectId };
          }

          // Emit the object. Only a NON-Normal status is a gap; a zero-length
          // Normal object (status 0x0, explicitly encoded) is real data with an
          // empty payload (§11.2.1.1). Normal is 0x0 in every draft.
          const isGap =
            object.payload.length === 0 &&
            object.status !== undefined &&
            object.status !== 0n;
          const delivered: MoqtObject = isGap
            ? {
                kind: 'gap',
                trackAlias: header.trackAlias,
                groupId: header.groupId,
                subgroupId: header.subgroupId,
                objectId: object.objectId,
                status: object.status!,
              } satisfies MoqtObjectGap
            : {
                kind: 'data',
                trackAlias: header.trackAlias,
                groupId: header.groupId,
                subgroupId: header.subgroupId,
                objectId: object.objectId,
                publisherPriority: header.publisherPriority,
                extensions: object.extensions,
                properties: object.extensions,
                payload: object.payload,
              } satisfies MoqtObjectData;

          // -06 §4.9: emit object_id_delta (raw delta, not resolved absolute ID)
          const objectIdDelta = isFirstObject
            ? (object.objectId as bigint)
            : ((object.objectId as bigint) - (previousObjectId as bigint) - 1n);
          this.onQlogEvent?.({
            type: 'subgroup_object_parsed',
            stream_id: streamId,
            object_id_delta: objectIdDelta,
            object_payload_length: object.payload.byteLength,
            ...(object.extensions && object.extensions.byteLength > 0
              ? { extension_headers: [] } : {}), // TODO: parse extension headers for qlog
            ...(object.status !== undefined ? { object_status: object.status as bigint } : {}),
          });
          if (!this.routeToTrackSubscription(delivered)) {
            this.onObject?.(streamId, delivered);
          }
          previousObjectId = object.objectId;
          isFirstObject = false;
          continue; // Try to decode another object from remaining buffer
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
          // Not enough bytes — read more
        }
      }

      // Read more bytes from the stream
      const { value, done } = await reader.read();
      if (done) {
        // §10.4: "If a stream ends gracefully in the middle of a serialized
        // Object, the session SHOULD be closed with a PROTOCOL_VIOLATION."
        if (buf.length > 0) {
          // Stream FIN arrived mid-object parse — protocol violation
          this.closeSessionFatal('Stream FIN received mid-object');
          return;
        }

        // §10.4.2: Subgroup header's END_OF_GROUP flag means this subgroup
        // contains the largest object in the group. On graceful FIN,
        // synthesize a gap object so the pipeline knows the group is complete.
        if (header.isEndOfGroup) {
          const eogGap: MoqtObjectGap = {
            kind: 'gap',
            trackAlias: header.trackAlias,
            groupId: header.groupId,
            subgroupId: header.subgroupId,
            objectId: previousObjectId + 1n, // raw bigint — object IDs are semantic now
            status: ObjectStatus.END_OF_GROUP,
          };
          if (!this.routeToTrackSubscription(eogGap)) {
            this.onObject?.(streamId, eogGap);
          }
        }
        return;
      }
      buf = this.appendBuffer(buf, value);
    }
  }

  /**
   * Read and decode fetch objects until the stream closes.
   * @see draft-ietf-moq-transport-16 §10.4.4
   */
  private async readFetchObjects(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buf: Uint8Array,
    streamId: bigint,
  ): Promise<void> {
    let prior: FetchPriorContext | undefined;
    let isFirstObject = true;

    while (true) {
      if (buf.length > 0) {
        try {
          const { item, bytesRead } = this.dataCodec!.decodeFetchObject(buf, 0, prior, isFirstObject);
          buf = buf.subarray(bytesRead);

          // Distinguish between FetchObject and FetchEndOfRange
          if ('payload' in item) {
            // FetchObject
            // -06 §4.13: fetch object with flag bools and optional fields
            this.onQlogEvent?.({
              type: 'fetch_object_parsed',
              stream_id: streamId,
              datagram: item.isDatagram ?? false,
              end_of_nonexistent_range: false,
              end_of_unknown_range: false,
              ...(item.groupId !== undefined ? { group_id: item.groupId as bigint } : {}),
              ...(item.subgroupId !== undefined ? { subgroup_id: item.subgroupId as bigint } : {}),
              ...(item.objectId !== undefined ? { object_id: item.objectId as bigint } : {}),
              ...(item.publisherPriority !== undefined ? { publisher_priority: item.publisherPriority } : {}),
              ...(item.extensions ? { extension_headers_length: item.extensions.byteLength } : {}),
              object_payload_length: item.payload.byteLength,
            });
            const delivered: MoqtObjectData = {
              kind: 'data',
              trackAlias: varint(0), // Fetch objects don't carry track alias
              groupId: item.groupId,
              subgroupId: item.subgroupId,
              objectId: item.objectId,
              publisherPriority: item.publisherPriority,
              extensions: item.extensions,
              properties: item.extensions,
              payload: item.payload,
            };
            if (!this.routeToTrackSubscription(delivered)) {
              this.onObject?.(streamId, delivered);
            }

            // Update prior context for next object's inheritance
            prior = {
              groupId: item.groupId as bigint,
              subgroupId: item.subgroupId as bigint,
              objectId: item.objectId as bigint,
              ...(item.publisherPriority !== undefined ? { priority: item.publisherPriority } : {}),
            };
          } else {
            // FetchEndOfRange — emit as gap
            // Use rawStatus when available (draft-14 preserves exact status code),
            // otherwise derive from nonExistent boolean (draft-16).
            const gapStatus = item.rawStatus
              ?? varint(item.nonExistent ? 0x3 : 0x0);
            const delivered: MoqtObjectGap = {
              kind: 'gap',
              trackAlias: varint(0),
              groupId: item.groupId,
              subgroupId: varint(0),
              objectId: item.objectId,
              status: gapStatus,
            };
            if (!this.routeToTrackSubscription(delivered)) {
              this.onObject?.(streamId, delivered);
            }
          }

          isFirstObject = false;
          continue;
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
        }
      }

      const { value, done } = await reader.read();
      if (done) {
        // §10.4: mid-object FIN → SHOULD close with PROTOCOL_VIOLATION
        if (buf.length > 0) {
          this.closeSessionFatal('Fetch stream FIN received mid-object');
        }
        return;
      }
      buf = this.appendBuffer(buf, value);
    }
  }

  /**
   * Read and decode draft-18 fetch objects until the stream closes.
   *
   * Uses the §11.4.4 fetch-object format (group-order-aware deltas, End-of-Range
   * markers, threaded prior context). The Group Order is the one this client
   * requested for `header.requestId` (Ascending by default per §11.4.4.1).
   *
   * Fetch objects carry NO track alias, so they are delivered directly to
   * `onObject` and do NOT go through alias-based subscription routing — a
   * fabricated `trackAlias: 0` must never land in a real alias-0 subscription.
   *
   * @see draft-ietf-moq-transport-18 §11.4.4
   */
  private async readFetchObjects18(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    buf: Uint8Array,
    streamId: bigint,
    header: FetchHeader,
  ): Promise<void> {
    // A FETCH_HEADER must name a Request ID we actually issued a FETCH for. The
    // group-order map is recorded for every fetch() (Ascending by default), so a
    // missing entry means an unknown/unrequested fetch — a PROTOCOL_VIOLATION,
    // never a silently-defaulted decode.
    const groupOrder = this.fetchGroupOrder.get(header.requestId);
    if (groupOrder === undefined) {
      // No group-order entry AND no cancellation marker (the marker is checked — and
      // consumed — at the FETCH_HEADER handler and the loop-top guard BEFORE we reach
      // here, and it is lossless). So this stream is NOT a cancelled fetch: it is a
      // FETCH_HEADER for a request that is not a live FETCH — a request we never
      // issued, a request of a different kind (e.g. a live SUBSCRIBE's id, which
      // shares the request-id space), or a SECOND response stream for an already
      // completed fetch. §10.12.3 / §11.4.4 (exactly one response stream) and §9.1
      // (unknown request) make all of these a PROTOCOL_VIOLATION — never a silent
      // discard. Cancelled fetches never reach here (their lossless marker discards
      // the late stream at the header / loop-top guard).
      throw new ProtocolViolationError(
        `FETCH_HEADER for request ${header.requestId} that is not a live FETCH ` +
        `(unknown, wrong request kind, or a second response stream for a completed fetch)`,
      );
    }
    let prior: FetchObjectPrior18 | undefined;
    let isFirstObject = true;

    while (true) {
      // §10.13: if the fetch is cancelled WHILE this stream is open, stop delivering
      // immediately — objects buffered mid-flight must not reach onObject after the
      // cancellation began (the marker is installed synchronously at fetchCancel).
      if (this.recentlyCancelledFetches.has(header.requestId)) {
        this.recentlyCancelledFetches.delete(header.requestId); // one-shot: this stream is handled
        await reader.cancel(new Error('FETCH cancelled — open stream stopped')).catch(() => { /* already closed */ });
        return;
      }
      if (buf.length > 0) {
        try {
          const { item, bytesRead, nextPrior } =
            this.dataCodec!.decodeFetchObject18(buf, 0, prior, isFirstObject, groupOrder);
          buf = buf.subarray(bytesRead);
          prior = nextPrior;
          isFirstObject = false;

          if ('payload' in item) {
            this.onQlogEvent?.({
              type: 'fetch_object_parsed',
              stream_id: streamId,
              datagram: item.isDatagram ?? false,
              end_of_nonexistent_range: false,
              end_of_unknown_range: false,
              group_id: item.groupId as bigint,
              subgroup_id: item.subgroupId as bigint,
              object_id: item.objectId as bigint,
              ...(item.publisherPriority !== undefined ? { publisher_priority: item.publisherPriority } : {}),
              ...(item.extensions ? { extension_headers_length: item.extensions.byteLength } : {}),
              object_payload_length: item.payload.byteLength,
            });
            const delivered: MoqtObjectData = {
              kind: 'data',
              trackAlias: 0n, // fetch objects carry no track alias
              groupId: item.groupId,
              subgroupId: item.subgroupId,
              objectId: item.objectId,
              publisherPriority: item.publisherPriority,
              extensions: item.extensions,
              properties: item.extensions,
              payload: item.payload,
            };
            this.onObject?.(streamId, delivered); // no alias routing for fetch
          } else {
            const delivered: MoqtObjectGap = {
              kind: 'gap',
              trackAlias: 0n,
              groupId: item.groupId,
              subgroupId: 0n,
              objectId: item.objectId,
              status: varint(item.nonExistent ? 0x3 : 0x0),
            };
            this.onObject?.(streamId, delivered);
          }
          continue;
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
        }
      }

      const { value, done } = await reader.read();
      if (done) {
        if (buf.length > 0) {
          this.closeSessionFatal('Fetch stream FIN received mid-object');
        }
        return;
      }
      buf = this.appendBuffer(buf, value);
    }
  }

  /**
   * Open a bidirectional stream for namespace discovery, send the
   * SUBSCRIBE_NAMESPACE message, and start reading responses.
   *
   * §6.1: "The subscriber sends SUBSCRIBE_NAMESPACE on a new bidirectional
   * stream and the publisher MUST send a single REQUEST_OK or REQUEST_ERROR
   * as the first message."
   *
   * @see draft-ietf-moq-transport-16 §6.1
   */
  private async openNamespaceStream(
    requestId: bigint,
    message: ControlMessage,
  ): Promise<void> {
    try {
      const bidiStream = await this.transport!.createBidirectionalStream();
      const writer = bidiStream.writable.getWriter();

      // Track the stream for future cancellation
      this.namespaceStreams.set(requestId as bigint, writer);

      // Send SUBSCRIBE_NAMESPACE on the writable side
      const bytes = this.codec.encode(message);
      await writer.write(bytes);

      // Start reading responses on the readable side
      const reader = bidiStream.readable.getReader();
      this.runNamespaceStreamReadLoop(reader, requestId);
    } catch (err) {
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
      ));
    }
  }

  /**
   * Background read loop for a namespace discovery bidi stream.
   *
   * Reads framed control messages from the stream and routes them
   * to session.handleNamespaceStreamMessage().
   *
   * §6.1: Expects REQUEST_OK or REQUEST_ERROR first, then NAMESPACE
   * and NAMESPACE_DONE messages.
   *
   * @see draft-ietf-moq-transport-16 §6.1
   */
  private async runNamespaceStreamReadLoop(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    requestId: bigint,
  ): Promise<void> {
    const framer = new ControlStreamFramer(this.codec);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        framer.push(value);
        const messages = framer.drain();
        for (const framed of messages) {
          // draft-16 namespace bidi stream carries fully-correlated messages;
          // draft-18 correlation is a topology concern (Slice C).
          const message = framed.message as ControlMessage;
          this.onNamespaceMessage?.(requestId as bigint, message);
          const actions = this.session.handleNamespaceStreamMessage(
            requestId,
            message,
          );
          await this.executeActions(actions);
        }
      }
    } catch (err) {
      // A real transport close makes this read throw AFTER terminal shutdown —
      // suppress the spurious post-close error event.
      if (!(this._terminated || this.session.state === SessionState.CLOSED)) {
        this.onError?.(new MoqtConnectionError(
          err instanceof Error ? err.message : String(err),
          { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
        ));
      }
    } finally {
      this.namespaceStreams.delete(requestId as bigint);
    }
  }

  /** Append a chunk to an existing buffer. */
  private appendBuffer(existing: Uint8Array, chunk: Uint8Array): Uint8Array {
    if (existing.length === 0) return chunk;
    const newBuf = new Uint8Array(existing.length + chunk.length);
    newBuf.set(existing, 0);
    newBuf.set(chunk, existing.length);
    return newBuf;
  }
}
