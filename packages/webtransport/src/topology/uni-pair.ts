/**
 * UniPairTopology — draft-18 control-stream topology.
 *
 * Draft-18 replaces the single bidirectional control stream with a pair of
 * unidirectional control streams: each endpoint opens one and sends a unified
 * SETUP on it. Requests move to per-request bidirectional streams.
 *
 * Wired so far:
 *   - `establish()` — open our outbound uni control stream + send SETUP, then
 *     read the peer's inbound uni control stream and feed its SETUP to the
 *     session. The control stream is kept open for the session lifetime.
 *   - `openRequest()` — open a per-request bidi stream for an outbound SUBSCRIBE
 *     or FETCH, returning a {@link RequestStream} handle whose `response`
 *     resolves with the first reply (SUBSCRIBE_OK / FETCH_OK / REQUEST_ERROR)
 *     for the caller to route.
 *
 * This topology owns only the control plane. Incoming data streams (subgroup /
 * fetch) and datagrams are read by the adapter's data loops directly from the
 * transport, not through this object.
 *
 * @see draft-ietf-moq-transport-18 §3.3
 * @module
 */

import {
  createControlCodec,
  StreamResetCode18,
  ProtocolViolationError,
  type ControlCodec,
  type ControlMessage,
  type DecodedControlMessage,
  type Session,
} from '@moqt/transport';
import type { SetupOptions } from '@moqt/transport';
import { ControlStreamFramer } from '../framer.js';
import type { WebTransportLike, WebTransportBidirectionalStream } from '../types.js';

/**
 * Marks a request stream torn down by a LOCAL cancellation (e.g. draft-18 FETCH
 * cancel). The owner recognizes it and does NOT surface it as an error — unlike
 * a peer-initiated failure (unsolicited/wrong-typed response, early end).
 */
export class RequestCancelledError extends Error {
  constructor(readonly errorCode: bigint) {
    super(`request stream cancelled (code ${errorCode})`);
    this.name = 'RequestCancelledError';
  }
}

/**
 * A GOAWAY received on a request stream (§10.4): a per-request MIGRATION signal,
 * NOT a response (never FIFO-matched) and NOT a session-level violation. The peer
 * asks us to re-issue THIS one request elsewhere. The topology fails the affected
 * request stream with this typed error (carrying the request's id and the decoded
 * GOAWAY) and tears the stream down gracefully; the owner settles the affected
 * request and decides whether to re-issue. Automatic reissue/reconnect is NOT
 * performed here — that remains application policy.
 */
export class RequestGoawayError extends Error {
  constructor(readonly requestId: bigint, readonly goaway: DecodedControlMessage) {
    super(`request stream ${requestId} received GOAWAY (per-request migration requested)`);
    this.name = 'RequestGoawayError';
  }
}

/**
 * A handle to an open draft-18 request stream. The request has already been
 * sent (the SUBSCRIBE or FETCH was written before the handle is returned);
 * `response` resolves with the first response message — SUBSCRIBE_OK / FETCH_OK
 * or REQUEST_ERROR — still WITHOUT its Request ID. The caller stamps it via
 * `handleControlMessage(message, { requestId })` through its own pipeline; the
 * topology does not swallow the response.
 */
export interface RequestStream {
  readonly requestId: bigint;
  readonly response: Promise<DecodedControlMessage>;
}

/** Whether a continuing-stream message is the first response or a follow-up. */
export type ContinuationKind = 'first' | 'continuation';

/** Handler for messages on a continuing request stream (SUBSCRIBE_NAMESPACE). */
export type ContinuationHandler = (
  requestId: bigint,
  message: DecodedControlMessage,
  kind: ContinuationKind,
) => void | Promise<void>;

/** Handle to a continuing request stream. `closed` resolves on a clean FIN and
 *  rejects with a {@link ProtocolViolationError} on a stream-ordering violation. */
export interface ContinuingRequestStream {
  readonly requestId: bigint;
  readonly closed: Promise<void>;
}

export class UniPairTopology {
  readonly version = 18 as const;
  private readonly codec: ControlCodec = createControlCodec(18);

  /** Our outbound uni control stream writer. Held open for the session lifetime
   *  (the draft-18 control stream pair must NOT be closed after SETUP). */
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  /** Called when a request stream fails (e.g. unsolicited / wrong-typed
   *  response), so the owner can surface the error immediately rather than only
   *  on a later operation. */
  onStreamError?: (error: Error) => void;

  /** Called for each CONTROL-stream message received AFTER the initial SETUP —
   *  in draft-18 that is GOAWAY (§10.4). The owner feeds it to the session and
   *  acts on the result (transition to DRAINING, or close on a violation). */
  onControlMessage?: (message: DecodedControlMessage) => void | Promise<void>;

  /** Called when the control stream violates its draft-18 lifecycle AFTER SETUP:
   *  a non-GOAWAY message (only GOAWAY is allowed, §10.4), a decode failure, or a
   *  FIN/close (the control stream MUST stay open for the session, §3.3). The owner
   *  MUST close the session with PROTOCOL_VIOLATION — this is fatal, NOT a per-stream
   *  error routed through {@link onStreamError}. */
  onControlStreamViolation?: (reason: string) => void;

  /** Called for a peer-initiated REQUEST_UPDATE on an open PUBLISH request stream
   *  (§10.9). `originalRequestId` is the PUBLISH's Request ID (from stream
   *  context); the owner stamps + handles the update and answers on that stream
   *  via {@link writeOnRequest}. */
  onPeerRequestUpdate?: (originalRequestId: bigint, message: DecodedControlMessage) => void | Promise<void>;

  /** Called for a GOAWAY received on an OUTBOUND request stream (§10.4): a
   *  per-request MIGRATION signal. Fired REGARDLESS of whether a FIFO response is
   *  still pending — an ESTABLISHED SUBSCRIBE/PUBLISH has an empty queue but must
   *  still see the GOAWAY. The owner surfaces it (e.g. onMessage) and settles the
   *  affected request; it is NOT a response and NOT a session-level event. Per-request
   *  cleanup still runs through {@link onRequestClosed} as the stream tears down. */
  onRequestGoaway?: (error: RequestGoawayError) => void | Promise<void>;

  /** Called when an open OUTBOUND request stream ends by PEER action — NOT a local
   *  cancel/finish (those are driven by the owner). `disposition` distinguishes a
   *  clean FIN (`'fin'`) from a reset/failure (`'reset'`), which the owner needs to
   *  tell a valid post-response request-stream close (e.g. a FETCH whose data stream
   *  outlives it, §5.2) from a terminal reset (§11.4.1). The owner cleans any
   *  persistent local state for `requestId`; the context is already dropped from the
   *  topology (and our writable half is FINned on a clean FIN — no half-open). */
  onRequestClosed?: (requestId: bigint, disposition: 'fin' | 'reset') => void | Promise<void>;

  constructor(private readonly session: Session) {}

  /**
   * Establish the draft-18 control-stream pair: open our outbound uni control
   * stream and send SETUP, then read the peer's inbound uni control stream and
   * feed its SETUP to the session.
   */
  async establish(transport: WebTransportLike, options: SetupOptions = {}): Promise<void> {
    if (!transport.createUnidirectionalStream) {
      throw new Error('UniPairTopology: transport does not support unidirectional streams');
    }

    // Outbound control stream — send our SETUP and KEEP THE STREAM OPEN. The
    // draft-18 control-stream pair lives for the session lifetime; closing a
    // control stream is a protocol violation, so we retain the writer for later
    // control messages rather than FIN-ing after SETUP.
    this.controlWriter = (await transport.createUnidirectionalStream()).getWriter();
    for (const action of this.session.initiateSetup(options)) {
      if (action.type === 'send_control') {
        await this.controlWriter.write(this.codec.encode(action.message));
      }
    }

    // Inbound control stream — the first incoming uni stream, which must begin
    // with SETUP. Subsequent incoming uni streams are data streams, read by the
    // adapter's data loop after establish() releases this reader lock.
    const incoming = transport.incomingUnidirectionalStreams.getReader();
    const { value: stream, done } = await incoming.read();
    incoming.releaseLock();
    if (done || !stream) {
      throw new Error('UniPairTopology: no inbound control stream');
    }
    await this.readControlStream(stream);
  }

  /**
   * Read the inbound control stream. The first message MUST be SETUP; once it is
   * processed this resolves so `establish()` (and thus `connect()`) returns, while
   * a background loop keeps reading SUBSEQUENT control-stream messages (draft-18
   * GOAWAY, §10.4) and delivers them via {@link onControlMessage}. connect() never
   * blocks waiting for control-stream EOF.
   */
  private async readControlStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const framer = new ControlStreamFramer(this.codec);
    const reader = stream.getReader();
    const setupSeen = deferred<void>();
    void this.controlReadLoop(reader, framer, setupSeen);
    await setupSeen.promise;
  }

  /**
   * Write a control message on OUR outbound uni control stream (draft-18 §10.4 —
   * GOAWAY is the only post-SETUP control-stream message we send). The stream is
   * kept open for the session lifetime, so this does not FIN it.
   */
  async sendControl(message: ControlMessage): Promise<void> {
    if (!this.controlWriter) throw new Error('UniPairTopology: control stream not established');
    await this.controlWriter.write(this.codec.encode(message));
  }

  private async controlReadLoop(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    framer: ControlStreamFramer,
    setupSeen: Deferred<void>,
  ): Promise<void> {
    let sawSetup = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) framer.push(value);
        for (const { message } of framer.drain()) {
          if (!sawSetup) {
            if (message.type !== 'SETUP') {
              throw new Error(`UniPairTopology: expected SETUP on the control stream, got ${message.type}`);
            }
            sawSetup = true;
            this.session.handleControlMessage(message);
            setupSeen.resolve();
          } else if (message.type === 'GOAWAY') {
            // §10.4: GOAWAY is the ONLY message permitted on the control stream
            // after SETUP — hand it to the owner.
            await this.onControlMessage?.(message);
          } else {
            // §10.4: any other post-SETUP control-stream message is a fatal
            // protocol violation. (A SUBSCRIBE etc. belongs on a request stream and
            // MUST NOT reach the session's request handler from here.)
            this.onControlStreamViolation?.(
              `unexpected ${message.type} on the control stream after SETUP (only GOAWAY is permitted, §10.4)`,
            );
            return;
          }
        }
        if (done) {
          if (!sawSetup) throw new Error('UniPairTopology: control stream ended before SETUP');
          // §3.3: the control stream MUST NOT be closed during the session — a FIN
          // after SETUP is a protocol violation (the owner skips it if already closed).
          this.onControlStreamViolation?.('control stream closed (FIN) during the session (§3.3)');
          return;
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!sawSetup) {
        setupSeen.reject(e); // pre-SETUP failure → establish() rejects
      } else {
        // A post-SETUP framer/codec decode failure is a fatal control-stream
        // protocol violation (NOT a per-request stream error).
        this.onControlStreamViolation?.(e.message);
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── request bidi streams (SUBSCRIBE / FETCH open; REQUEST_UPDATE reuses) ──

  /** Per-request-stream context, keyed by the ORIGINAL request's Request ID. */
  private readonly contexts = new Map<bigint, RequestStreamContext>();

  /**
   * Open a new bidirectional request stream for an outbound request and write it
   * as the first message. SUBSCRIBE (→ SUBSCRIBE_OK) and FETCH (→ FETCH_OK) both
   * open their own stream; each correlates to its reply by stream context, so a
   * response that omits the Request ID is stamped from here. Resolves once the
   * request has been SENT (so a caller with "return requestId after sending"
   * semantics need not block on the response). The returned {@link RequestStream}'s
   * `response` resolves with the first reply (the OK variant or REQUEST_ERROR).
   *
   * `requestId` is derived from the message itself (single source of truth).
   */
  async openRequest(
    transport: WebTransportLike,
    message: ControlMessage,
    onResponse: ResponseProcessor,
  ): Promise<RequestStream> {
    // The response processor is REQUIRED (not optional): it is the wire-order
    // acknowledgement the read loop awaits before the next frame. Making it
    // mandatory — in the type AND at runtime — means a direct consumer of this
    // experimental API cannot silently skip the ordering barrier.
    if (typeof onResponse !== 'function') {
      throw new Error('UniPairTopology.openRequest: an onResponse processor (the wire-order acknowledgement) is required');
    }
    if (!STREAM_OPENING_REQUESTS.has(message.type) || !('requestId' in message)) {
      throw new Error(
        `UniPairTopology: only ${[...STREAM_OPENING_REQUESTS].join('/')} may open a request stream, got ${message.type}`,
      );
    }
    const requestId = message.requestId;
    const stream = await transport.createBidirectionalStream();
    const ctx = new RequestStreamContext(stream, this.codec, message.type, requestId);
    this.contexts.set(requestId, ctx);
    // A peer-initiated REQUEST_UPDATE on this stream (§10.9, PUBLISH only) is
    // surfaced to the owner stamped with the ORIGINAL request's ID for correlation.
    ctx.onPeerRequest = (m) => this.onPeerRequestUpdate?.(requestId, m);
    // A request-stream GOAWAY (§10.4) is surfaced to the owner whether or not a
    // response is still pending (established streams have an empty FIFO queue).
    ctx.onGoaway = (err) => this.onRequestGoaway?.(err);
    // Surface a stream failure (unsolicited/wrong-typed response, early end)
    // immediately, even if no operation is awaiting a response at the time, and
    // ALWAYS reclaim the context when the stream ends so it can't leak. A clean FIN
    // resolves `closed`; a failure rejects it — both run the cleanup. If the owner
    // already removed the context (local cancel/finish), skip the peer-close notify.
    let closedClean = true;
    void ctx.closed
      .catch((err) => {
        closedClean = false; // a reset/failure — NOT a clean FIN
        this.onStreamError?.(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (this.contexts.get(requestId) === ctx) {
          this.contexts.delete(requestId);
          // peer-initiated close → owner cleans local state, told whether the close
          // was a clean FIN or a reset (§5.2 vs §11.4.1 — matters for FETCH).
          void this.onRequestClosed?.(requestId, closedClean ? 'fin' : 'reset');
        }
      });
    let response: Promise<DecodedControlMessage>;
    try {
      ({ response } = await ctx.send(message, onResponse)); // resolves after the WRITE
      // One-shot requests (TRACK_STATUS) send nothing more — FIN our writable now.
      if (ONE_SHOT_REQUESTS.has(message.type)) {
        await ctx.finishSending();
      }
    } catch (err) {
      // The open write (or one-shot FIN) failed: the peer never received the
      // request, so no per-request context may survive in the topology. Reclaim it
      // and tear the half-open stream down BEFORE rethrowing (matching the owner's
      // own Session-state rollback). Delete first so the ctx.closed `finally` guard
      // sees a foreign context and does NOT re-fire onRequestClosed — the caller
      // owns the request-closed cleanup on this failure path.
      if (this.contexts.get(requestId) === ctx) this.contexts.delete(requestId);
      try { await ctx.cancel(StreamResetCode18.CANCELLED); } catch { /* already down */ }
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { requestId, response };
  }

  /**
   * Send a REQUEST_UPDATE on the EXISTING request stream that targets
   * `existingRequestId`. The update carries its OWN Request ID; the returned
   * handle's `requestId` is that update id, and `response` (REQUEST_OK /
   * REQUEST_ERROR) correlates to the update — not the original request.
   * @throws if there is no open request stream for `existingRequestId`.
   */
  async sendUpdate(
    existingRequestId: bigint,
    message: ControlMessage,
    onResponse: ResponseProcessor,
  ): Promise<RequestStream> {
    if (typeof onResponse !== 'function') {
      throw new Error('UniPairTopology.sendUpdate: an onResponse processor (the wire-order acknowledgement) is required');
    }
    if (message.type !== 'REQUEST_UPDATE') {
      throw new Error(`UniPairTopology.sendUpdate expects REQUEST_UPDATE, got ${message.type}`);
    }
    const ctx = this.contexts.get(existingRequestId);
    if (!ctx) {
      throw new Error(`UniPairTopology: no open request stream for request ${existingRequestId}`);
    }
    let response: Promise<DecodedControlMessage>;
    try {
      ({ response } = await ctx.send(message, onResponse));
    } catch (err) {
      // §11.4.1: the REQUEST_UPDATE write failed, which terminates the bidi request
      // stream it rode. The UNDERLYING request (SUBSCRIBE / PUBLISH) is therefore
      // gone — reclaim its context and notify the owner so its session state is
      // cleaned, else a later update would target an already-dead writer.
      await this.terminateRequestContext(existingRequestId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { requestId: message.requestId, response };
  }

  /**
   * Terminate an open request-stream context (§11.4.1): drop it from the registry,
   * tear the stream down, and fire {@link onRequestClosed} so the owner cleans the
   * request's session state. Deleting BEFORE the cancel means the ctx.closed
   * `finally` sees a foreign context and does not ALSO fire onRequestClosed — this
   * fires it exactly once. Used when a write on the stream fails (a REQUEST_UPDATE
   * send), which the draft treats as terminating the request.
   */
  private async terminateRequestContext(requestId: bigint): Promise<void> {
    const ctx = this.contexts.get(requestId);
    if (!ctx) return;
    this.contexts.delete(requestId);
    try { await ctx.cancel(StreamResetCode18.CANCELLED); } catch { /* already down */ }
    void this.onRequestClosed?.(requestId, 'reset'); // a write-failure teardown is terminal
  }

  /** Whether an open request stream exists for `requestId` (e.g. to send a
   *  REQUEST_UPDATE on it). */
  hasRequestStream(requestId: bigint): boolean {
    return this.contexts.has(requestId);
  }

  /**
   * Write a message on an open OUTBOUND request stream without registering a
   * response expectation — used to answer a peer REQUEST_UPDATE (REQUEST_OK /
   * REQUEST_ERROR) on the PUBLISH stream it arrived on. No-op if no such stream.
   */
  async writeOnRequest(requestId: bigint, message: ControlMessage): Promise<void> {
    const ctx = this.contexts.get(requestId);
    if (!ctx) return;
    await ctx.writeMessage(message);
  }

  /**
   * Locally cancel an open request stream (draft-18 FETCH cancel, §3.3.2). Sends
   * STOP_SENDING on the readable and RESET_STREAM on the writable (both
   * directions of the bidi stream are torn down), then drops the context.
   * No-op if no such stream is open. Cancellation is NOT surfaced as an error.
   */
  async cancelRequest(requestId: bigint, errorCode: bigint = StreamResetCode18.CANCELLED): Promise<void> {
    const ctx = this.contexts.get(requestId);
    if (!ctx) return;
    this.contexts.delete(requestId);
    await ctx.cancel(errorCode);
  }

  /**
   * Gracefully finish an open request stream, optionally writing one last message
   * first (e.g. PUBLISH_DONE on an outbound PUBLISH, draft-18 §10.11). FINs our
   * writable and STOP_SENDINGs the readable, then drops the context. No response
   * is expected for the final message. No-op if no such stream is open.
   */
  async finishRequest(requestId: bigint, finalMessage?: ControlMessage): Promise<void> {
    const ctx = this.contexts.get(requestId);
    if (!ctx) return;
    this.contexts.delete(requestId);
    await ctx.finishWith(finalMessage);
  }

  // ── continuing request streams (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) ──

  /** Per-continuing-stream context, keyed by Request ID. */
  private readonly continuingContexts = new Map<bigint, ContinuingRequestStreamContext>();

  /**
   * Open a CONTINUING request stream (SUBSCRIBE_NAMESPACE §10.18 or
   * SUBSCRIBE_TRACKS §10.19). Unlike a one-shot request, the response half stays
   * open after the first reply: `handler` is invoked for the first response
   * (kind 'first', REQUEST_OK | REQUEST_ERROR), then for each follow-up message
   * the request type allows (kind 'continuation') — NAMESPACE / NAMESPACE_DONE
   * for SUBSCRIBE_NAMESPACE, PUBLISH_BLOCKED for SUBSCRIBE_TRACKS — strictly in
   * order (each awaited before the next read). Stream-ordering violations — a
   * non-OK/ERROR first message, a message after REQUEST_ERROR, or a disallowed
   * message after REQUEST_OK — reject `closed` with a ProtocolViolationError.
   * A clean FIN resolves `closed`.
   */
  async openContinuingRequest(
    transport: WebTransportLike,
    message: ControlMessage,
    handler: ContinuationHandler,
  ): Promise<ContinuingRequestStream> {
    const allowedContinuation = CONTINUING_REQUESTS[message.type];
    if (!allowedContinuation || (message.type !== 'SUBSCRIBE_NAMESPACE' && message.type !== 'SUBSCRIBE_TRACKS')) {
      throw new Error(
        `UniPairTopology.openContinuingRequest expects ${Object.keys(CONTINUING_REQUESTS).join('/')}, got ${message.type}`,
      );
    }
    const requestId = message.requestId;
    const stream = await transport.createBidirectionalStream();
    const ctx = new ContinuingRequestStreamContext(stream, this.codec, allowedContinuation, (m, kind) => handler(requestId, m, kind));
    this.continuingContexts.set(requestId, ctx);
    // Clean up the context once the stream ends (either outcome).
    void ctx.closed.then(() => {}, () => {}).finally(() => this.continuingContexts.delete(requestId));
    try {
      await ctx.send(message);
    } catch (err) {
      // The initial write failed: the peer never received the request, so no
      // continuing context may survive. Reclaim it and tear the half-open stream
      // down before rethrowing (matching openRequest's transactional guarantee).
      if (this.continuingContexts.get(requestId) === ctx) this.continuingContexts.delete(requestId);
      try { await ctx.close(); } catch { /* already down */ }
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { requestId, closed: ctx.closed };
  }

  /** Whether a continuing request stream is open for `requestId`. */
  hasContinuingRequest(requestId: bigint): boolean {
    return this.continuingContexts.has(requestId);
  }

  /**
   * Send a REQUEST_UPDATE on an open continuing request stream (draft-18 §10.9.2,
   * a SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS prefix update) and resolve with its
   * REQUEST_OK / REQUEST_ERROR. The response omits its Request ID on the wire; the
   * caller stamps it with the update's own Request ID.
   * @throws if no continuing request stream is open for `existingRequestId`.
   */
  async sendUpdateOnContinuing(
    existingRequestId: bigint,
    message: ControlMessage,
    onResponse: ResponseProcessor,
  ): Promise<DecodedControlMessage> {
    if (typeof onResponse !== 'function') {
      throw new Error('UniPairTopology.sendUpdateOnContinuing: an onResponse processor (the wire-order acknowledgement) is required');
    }
    if (message.type !== 'REQUEST_UPDATE') {
      throw new Error(`UniPairTopology.sendUpdateOnContinuing expects REQUEST_UPDATE, got ${message.type}`);
    }
    const ctx = this.continuingContexts.get(existingRequestId);
    if (!ctx) {
      throw new Error(`UniPairTopology.sendUpdateOnContinuing: no continuing request stream for ${existingRequestId}`);
    }
    try {
      return await ctx.sendUpdate(message, onResponse);
    } catch (err) {
      // §11.4.1: the prefix-update write failed → the continuing bidi request
      // stream is dead. Tear it down; its registered closed-handler then cleans the
      // session's SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS state. Without this the
      // continuing context would linger and later updates would target a dead writer.
      await this.closeContinuingRequest(existingRequestId);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Gracefully close a continuing request stream (FIN our writable + STOP_SENDING
   * the readable), e.g. to cancel a namespace subscription (§10.18). No-op if no
   * such stream is open.
   */
  async closeContinuingRequest(requestId: bigint): Promise<void> {
    const ctx = this.continuingContexts.get(requestId);
    if (!ctx) return;
    this.continuingContexts.delete(requestId);
    await ctx.close();
  }

  /**
   * Terminal shutdown: cancel every open request-stream context and close every
   * continuing-request context, then drop them. Used by the owner's one-shot
   * terminal coordinator so no topology-owned stream context outlives the
   * session. Fire-and-forget teardown (idempotent; safe if already torn down).
   */
  shutdown(): void {
    for (const [, ctx] of this.contexts) void ctx.cancel(StreamResetCode18.CANCELLED);
    this.contexts.clear();
    for (const [, ctx] of this.continuingContexts) void ctx.close();
    this.continuingContexts.clear();
  }
}

/** Create a {@link UniPairTopology} for a draft-18 session. */
export function createUniPairTopology(session: Session): UniPairTopology {
  return new UniPairTopology(session);
}

// ── per-request-stream response router ────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The response message types each request type may receive (in order). */
const ALLOWED_RESPONSES: Record<string, ReadonlySet<string>> = {
  SUBSCRIBE: new Set(['SUBSCRIBE_OK', 'REQUEST_ERROR']),
  FETCH: new Set(['FETCH_OK', 'REQUEST_ERROR']),
  // TRACK_STATUS_OK / PUBLISH_NAMESPACE_OK / PUBLISH_OK are all REQUEST_OK shorthand.
  TRACK_STATUS: new Set(['REQUEST_OK', 'REQUEST_ERROR']),
  PUBLISH_NAMESPACE: new Set(['REQUEST_OK', 'REQUEST_ERROR']),
  PUBLISH: new Set(['REQUEST_OK', 'REQUEST_ERROR']),
  REQUEST_UPDATE: new Set(['REQUEST_OK', 'REQUEST_ERROR']),
};

/** Request types that may OPEN a new bidi request stream (first message). */
const STREAM_OPENING_REQUESTS: ReadonlySet<string> = new Set([
  'SUBSCRIBE', 'FETCH', 'TRACK_STATUS', 'PUBLISH_NAMESPACE', 'PUBLISH',
]);

/**
 * One-shot request types: the request is the FIRST AND ONLY message we send on
 * the stream (no REQUEST_UPDATE follows), so we FIN our writable right after
 * writing it. TRACK_STATUS (§10.14) is truly one-shot — a single query answered
 * by one REQUEST_OK / REQUEST_ERROR, then FIN.
 *
 * PUBLISH_NAMESPACE is deliberately NOT one-shot: draft-18 §10.9 lets it receive
 * a later REQUEST_UPDATE on the same stream, and §3.3.2 makes withdrawal a
 * cancellation of the request stream (draft-18 removed PUBLISH_NAMESPACE_DONE).
 * Its request stream therefore stays open after the initial REQUEST_OK.
 */
const ONE_SHOT_REQUESTS: ReadonlySet<string> = new Set(['TRACK_STATUS']);

/**
 * CONTINUING request types and the follow-up messages each allows on its
 * response stream AFTER the first REQUEST_OK. SUBSCRIBE_NAMESPACE carries
 * NAMESPACE / NAMESPACE_DONE; SUBSCRIBE_TRACKS carries PUBLISH_BLOCKED only
 * (PUBLISH for matched tracks arrives on its own NEW inbound bidi stream, handled
 * by the inbound-request path — not as a continuation here).
 */
const CONTINUING_REQUESTS: Record<string, ReadonlySet<string>> = {
  SUBSCRIBE_NAMESPACE: new Set(['NAMESPACE', 'NAMESPACE_DONE']),
  SUBSCRIBE_TRACKS: new Set(['PUBLISH_BLOCKED']),
};

/**
 * In-order processing hook for a matched response: the read loop AWAITS it
 * before decoding the next frame, so coalesced messages from one read are
 * applied through session state strictly in wire order (e.g. a SUBSCRIBE_OK
 * must be fully applied before a PUBLISH_DONE in the same receive is handled).
 * This is an explicit processing acknowledgement — not a microtask delay.
 */
export type ResponseProcessor = (message: DecodedControlMessage) => void | Promise<void>;

interface PendingResponse extends Deferred<DecodedControlMessage> {
  /** Response types valid for the request that produced this expectation. */
  readonly allowed: ReadonlySet<string>;
  /** Awaited by the read loop before the next frame (wire-order barrier). */
  readonly process?: ResponseProcessor;
}

/**
 * Owns one bidirectional request stream and routes its responses FIFO. Each
 * `send()` (the original SUBSCRIBE, then any REQUEST_UPDATEs) registers a typed
 * response expectation; the single background read loop matches replies in
 * order and validates that each reply is one of the EXPECTED types for the
 * operation it answers. An unsolicited reply (none queued) or a wrong-typed
 * reply fails the whole stream — neither can be mis-matched to a later
 * operation. The stream stays open for the request's lifetime.
 */
class RequestStreamContext {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly framer: ControlStreamFramer;
  private readonly queue: PendingResponse[] = [];
  private started = false;
  private failure: Error | null = null;
  private cancelled = false;
  private firstResponseSeen = false;
  /** §10.11: a successful SUBSCRIBE_OK arrived — PUBLISH_DONE becomes legal. */
  private subscribeEstablished = false;
  /** §10.11: a terminal PUBLISH_DONE was processed — NOTHING may follow it
   *  (including further frames in the same receive) except the peer's FIN. */
  private terminalSeen = false;
  /** The opener was rejected: the FIRST response was REQUEST_ERROR. Once every
   *  already-queued update response has settled, our writable is FINned. */
  private rejectedTerminal = false;
  /** Our writable has been FINned by the terminal/rejection paths. */
  private writerFinished = false;
  private readonly closedDeferred = deferred<void>();

  /** Invoked for a peer-initiated, stream-scoped request (not a queued response)
   *  — currently a peer REQUEST_UPDATE on an open PUBLISH stream (§10.9). The
   *  owner stamps and answers it on this same stream; it is NOT FIFO-matched. */
  onPeerRequest?: (message: DecodedControlMessage) => void | Promise<void>;

  /** Invoked when a GOAWAY arrives on this request stream (§10.4) — a per-request
   *  migration signal, fired whether or not a response is still pending. */
  onGoaway?: (error: RequestGoawayError) => void | Promise<void>;

  /** Resolves when the stream closes cleanly; rejects on failure (an unsolicited
   *  or wrong-typed response, or an early end) — so the owner can surface the
   *  error immediately, even with no operation currently awaiting a response. */
  get closed(): Promise<void> {
    return this.closedDeferred.promise;
  }

  constructor(
    stream: WebTransportBidirectionalStream,
    private readonly codec: ControlCodec,
    /** The request type that OPENED this stream (e.g. 'PUBLISH'). Only a PUBLISH
     *  stream accepts a peer REQUEST_UPDATE; on others it is a protocol violation. */
    private readonly openerType: string,
    /** The Request ID this stream carries — stamped onto a {@link RequestGoawayError}
     *  so the owner can identify which request a request-stream GOAWAY targets. */
    private readonly requestId: bigint,
  ) {
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();
    this.framer = new ControlStreamFramer(codec);
  }

  /** Write a message on this stream WITHOUT registering a response expectation —
   *  e.g. the REQUEST_OK / REQUEST_ERROR answer to a peer REQUEST_UPDATE. */
  async writeMessage(message: ControlMessage): Promise<void> {
    await this.writer.write(this.codec.encode(message));
  }

  /**
   * Write a message and register its typed response expectation (FIFO). Resolves
   * once the WRITE completes; the returned `response` resolves when the matching
   * reply arrives.
   */
  async send(
    message: ControlMessage,
    onResponse?: ResponseProcessor,
  ): Promise<{ response: Promise<DecodedControlMessage> }> {
    if (this.cancelled) throw new RequestCancelledError(StreamResetCode18.CANCELLED);
    if (this.failure) throw this.failure;
    const allowed = ALLOWED_RESPONSES[message.type];
    if (!allowed) {
      throw new Error(`UniPairTopology: no response mapping for request type ${message.type}`);
    }
    // Register BEFORE writing so a fast reply can't outrun its queue slot. The
    // read loop AWAITS `process` before touching the next frame — the explicit
    // wire-order barrier between topology and owner (adapter/session).
    const d = deferred<DecodedControlMessage>();
    const entry = { ...d, allowed, ...(onResponse ? { process: onResponse } : {}) };
    this.queue.push(entry);
    this.startReading();
    try {
      await this.writer.write(this.codec.encode(message));
    } catch (err) {
      // The write failed: the peer never received this request/update, so no reply
      // can ever match this FIFO slot. Remove the dangling slot BEFORE rethrowing —
      // leaving it would mis-correlate the NEXT response to arrive (a REQUEST_UPDATE
      // whose send failed must not steal the reply meant for an earlier request).
      const i = this.queue.indexOf(entry);
      if (i >= 0) this.queue.splice(i, 1);
      const e = err instanceof Error ? err : new Error(String(err));
      // Reject the response promise for any holder, but pre-attach a no-op catch:
      // on the open/send failure path the caller throws BEFORE receiving `response`,
      // so its rejection would otherwise surface as an unhandled rejection.
      void d.promise.catch(() => { /* observed; the throw below is the signal */ });
      d.reject(e);
      throw e;
    }
    return { response: d.promise };
  }

  /**
   * Locally cancel the stream (draft-18 §3.3.2). Cancels the readable side
   * (STOP_SENDING) and aborts the writable side (RESET_STREAM), then rejects any
   * pending response with {@link RequestCancelledError} and resolves `closed`
   * cleanly — a local cancel is not a stream failure.
   */
  async cancel(errorCode: bigint): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    const reason = new RequestCancelledError(errorCode);
    try { await this.reader.cancel(reason); } catch { /* already closed */ }
    try { await this.writer.abort(reason); } catch { /* already closed */ }
    for (const d of this.queue.splice(0)) d.reject(reason);
    this.closedDeferred.resolve();
  }

  /** FIN our writable side — used by one-shot requests that send nothing more. */
  async finishSending(): Promise<void> {
    try { await this.writer.close(); } catch { /* already closed/aborted */ }
  }

  /**
   * Gracefully finish the stream: optionally write one final message (no response
   * expected), then FIN our writable and STOP_SENDING the readable. Used for a
   * local PUBLISH_DONE on an outbound PUBLISH (§10.11). Resolves `closed` cleanly;
   * the read loop is suppressed from reporting the teardown as a failure.
   */
  async finishWith(finalMessage?: ControlMessage): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true; // suppress read-loop errors during teardown
    if (finalMessage) {
      try { await this.writer.write(this.codec.encode(finalMessage)); } catch { /* already closed */ }
    }
    try { await this.writer.close(); } catch { /* already closed/aborted */ }
    try { await this.reader.cancel(); } catch { /* already closed */ }
    for (const d of this.queue.splice(0)) d.reject(new RequestCancelledError(StreamResetCode18.CANCELLED));
    this.closedDeferred.resolve();
  }

  /** Start the continuous read loop once (it runs for the stream's lifetime). */
  private startReading(): void {
    if (this.started) return;
    this.started = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (value) this.framer.push(value);
        for (const { message } of this.framer.drain()) {
          // §10.11: NOTHING follows a terminal PUBLISH_DONE — a duplicate DONE
          // or any trailing message (even coalesced into the same receive) is a
          // protocol violation, never silently discarded.
          if (this.terminalSeen) {
            throw new ProtocolViolationError(
              `${message.type} received after the terminal PUBLISH_DONE (§10.11)`,
            );
          }
          // A peer-initiated REQUEST_UPDATE is a stream-scoped REQUEST, not a
          // response — it must NOT be FIFO-matched against our local operations.
          // §10.9: only a PUBLISH stream carries one, and only after the initial
          // REQUEST_OK / REQUEST_ERROR has been delivered.
          if (message.type === 'REQUEST_UPDATE') {
            if (this.openerType !== 'PUBLISH') {
              throw new ProtocolViolationError(
                `peer REQUEST_UPDATE not accepted on a ${this.openerType} request stream`,
              );
            }
            if (!this.firstResponseSeen) {
              throw new ProtocolViolationError(
                'peer REQUEST_UPDATE before the initial PUBLISH response',
              );
            }
            await this.onPeerRequest?.(message);
            continue;
          }
          // §10.11: PUBLISH_DONE is the publisher's TERMINAL message on a
          // subscription's request stream — accepted exactly once, only after
          // a successful SUBSCRIBE_OK (never after REQUEST_ERROR), and only
          // once all outstanding local update responses have settled. It is
          // not a response to any local operation — never FIFO-matched. On
          // receipt we FIN our own writable and keep READING until the peer's
          // clean FIN: `closed` resolves only on terminal completion, and any
          // message after the DONE (same chunk or later) is a violation.
          if (message.type === 'PUBLISH_DONE') {
            if (this.openerType !== 'SUBSCRIBE') {
              throw new ProtocolViolationError(
                `PUBLISH_DONE not accepted on a ${this.openerType} request stream`,
              );
            }
            if (!this.subscribeEstablished) {
              throw new ProtocolViolationError(
                'PUBLISH_DONE without a preceding SUBSCRIBE_OK',
              );
            }
            if (this.queue.length > 0) {
              throw new ProtocolViolationError(
                'PUBLISH_DONE while update responses are still outstanding',
              );
            }
            this.terminalSeen = true;
            await this.onPeerRequest?.(message);
            if (!this.writerFinished) {
              this.writerFinished = true;
              try { await this.writer.close(); } catch { /* already closed */ }
            }
            continue; // drain to the peer's clean FIN (or fail on trailing bytes)
          }
          // §10.4: a GOAWAY MAY arrive on a request stream to migrate that ONE
          // request. It is NOT a response, so it must NEVER be FIFO-matched, and it
          // is NOT a session-level violation. We do not auto-reissue (application
          // policy); instead we fail THIS request with a typed RequestGoawayError
          // (carrying the request id + GOAWAY) and tear the stream down gracefully —
          // `closed` resolves cleanly, so the owner sees a per-request migration
          // signal, not an onStreamError. Control-stream GOAWAY (the other form)
          // still drives session DRAINING. The FIFO queue is left untouched.
          if (message.type === 'GOAWAY') {
            this.cancelled = true; // graceful teardown — suppress read-loop failure handling
            const reason = new RequestGoawayError(this.requestId, message);
            // Surface the per-request migration signal to the owner FIRST, regardless
            // of whether a FIFO response is still pending — an ESTABLISHED request has
            // an empty queue but must still see the GOAWAY.
            await this.onGoaway?.(reason);
            // Then settle any still-pending first-response waiter with the same error.
            for (const d of this.queue.splice(0)) d.reject(reason);
            try { await this.reader.cancel(reason); } catch { /* already closed */ }
            try { await this.writer.abort(reason); } catch { /* already closed */ }
            this.closedDeferred.resolve();
            return;
          }
          const exp = this.queue.shift();
          if (!exp) {
            // A reply with no pending request — unsolicited. Fail the stream so
            // it can never be matched to a later operation.
            throw new Error(`UniPairTopology: unsolicited response ${message.type} on request stream`);
          }
          if (!exp.allowed.has(message.type)) {
            const err = new Error(
              `UniPairTopology: expected ${[...exp.allowed].join('/')} on request stream, got ${message.type}`,
            );
            exp.reject(err);
            throw err; // wrong-typed reply also fails the stream
          }
          const isFirstResponse = !this.firstResponseSeen;
          this.firstResponseSeen = true;
          if (message.type === 'SUBSCRIBE_OK') this.subscribeEstablished = true;
          // Wire-order barrier: the owner PROCESSES this response (applies it
          // through session state) before the next frame — even one already
          // decoded from the same read — is handled. A processing failure fails
          // the stream; the waiter sees the same error exactly once.
          if (exp.process) {
            try {
              await exp.process(message);
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              exp.reject(e);
              throw e;
            }
          }
          exp.resolve(message);
          // §10.6/§3.3.2: a REQUEST_ERROR to the OPENER rejects the whole
          // request — the stream is done. Once every already-queued update
          // response has settled (they are flushed FIFO behind the rejection),
          // FIN our writable and drain to the peer's FIN, so neither side
          // retains a half-open stream or its context.
          if (isFirstResponse && message.type === 'REQUEST_ERROR') this.rejectedTerminal = true;
          if (this.rejectedTerminal && this.queue.length === 0 && !this.writerFinished) {
            this.writerFinished = true;
            try { await this.writer.close(); } catch { /* already closed/aborted */ }
          }
        }
        if (done) {
          // A local cancel drains the queue and resolves `closed` itself; a
          // peer-side early end with responses still pending is a failure.
          if (!this.cancelled && this.queue.length > 0) {
            throw new Error('UniPairTopology: request stream ended before all responses');
          }
          // §3.3.2: on a genuine PEER FIN, FIN OURS too so the bidi fully closes and
          // no half-open write side lingers. Idempotent if a terminal path
          // (PUBLISH_DONE / REQUEST_ERROR) already closed it. This matters for a FETCH
          // whose request stream is FIN'd after FETCH_OK while its data stream lives
          // on (§5.2): the owner retains the fetch but can no longer reach this
          // writable, so the topology must close it here. NOT on a local cancel
          // (`cancelled`) — that path RESETs the writable (writer.abort), and a
          // reader.cancel there also surfaces as `done`; closing here would race the
          // abort and downgrade the RESET to a FIN.
          if (!this.cancelled && !this.writerFinished) {
            this.writerFinished = true;
            try { await this.writer.close(); } catch { /* already closed/aborted */ }
          }
          this.closedDeferred.resolve();
          return;
        }
      }
    } catch (err) {
      if (this.cancelled) {
        // Reader/writer teardown raced the read loop — not a failure.
        this.closedDeferred.resolve();
        return;
      }
      this.failure = err instanceof Error ? err : new Error(String(err));
      // §3.3.2: the stream FAILED (peer reset, early FIN with a pending response, an
      // unsolicited/wrong-typed reply, or a processing error). RESET our writable half
      // before settling `closed` — the topology deletes this context immediately after,
      // so this is the last chance to reach the writer; leaving it open half-closes the
      // bidi for the life of the connection. Absorb any abort failure (already torn
      // down). Applies to every outbound request stream, not just FETCH.
      if (!this.writerFinished) {
        this.writerFinished = true;
        try { await this.writer.abort(this.failure); } catch { /* already closed/aborted */ }
      }
      for (const d of this.queue.splice(0)) d.reject(this.failure);
      this.closedDeferred.reject(this.failure);
    } finally {
      this.started = false;
    }
  }
}

/**
 * Owns one CONTINUING request stream (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS).
 * The first message back MUST be REQUEST_OK | REQUEST_ERROR; thereafter the
 * stream carries the request-specific continuation messages (NAMESPACE /
 * NAMESPACE_DONE, or PUBLISH_BLOCKED) until FIN/reset. Every message is
 * dispatched through an AWAITED handler so the first response is fully processed
 * before any follow-up — the response and continuation streams cannot race.
 */
class ContinuingRequestStreamContext {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly framer: ControlStreamFramer;
  private readonly closedDeferred = deferred<void>();
  private closing = false;
  /**
   * Pending local REQUEST_UPDATEs (draft-18 §10.9.2 prefix updates) awaiting their
   * REQUEST_OK / REQUEST_ERROR, matched FIFO by send order against responses that
   * arrive AFTER the first response on this continuing stream. Each may carry a
   * processor the read loop awaits before the next frame (wire-order barrier).
   */
  private readonly pendingUpdates: Array<Deferred<DecodedControlMessage> & { process?: ResponseProcessor }> = [];

  get closed(): Promise<void> {
    return this.closedDeferred.promise;
  }

  constructor(
    stream: WebTransportBidirectionalStream,
    private readonly codec: ControlCodec,
    private readonly allowedContinuation: ReadonlySet<string>,
    private readonly handler: (message: DecodedControlMessage, kind: ContinuationKind) => void | Promise<void>,
  ) {
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();
    this.framer = new ControlStreamFramer(codec);
  }

  /** Write the request and start the continuing read loop. */
  async send(message: ControlMessage): Promise<void> {
    void this.readLoop();
    await this.writer.write(this.codec.encode(message));
  }

  /**
   * Send a REQUEST_UPDATE on this continuing stream (draft-18 §10.9.2) and resolve
   * with its REQUEST_OK / REQUEST_ERROR. The response correlates to the update's
   * own Request ID (the caller stamps it); it is matched FIFO so it is never
   * mistaken for a NAMESPACE / PUBLISH_BLOCKED continuation.
   */
  async sendUpdate(message: ControlMessage, onResponse?: ResponseProcessor): Promise<DecodedControlMessage> {
    const d = { ...deferred<DecodedControlMessage>(), ...(onResponse ? { process: onResponse } : {}) };
    this.pendingUpdates.push(d);
    try {
      await this.writer.write(this.codec.encode(message));
    } catch (err) {
      // The write never reached the peer — drop the queued deferred so a later
      // REQUEST_OK / REQUEST_ERROR cannot be mis-correlated to this failed update.
      const i = this.pendingUpdates.indexOf(d);
      if (i !== -1) this.pendingUpdates.splice(i, 1);
      throw err;
    }
    return d.promise;
  }

  /** Gracefully close: FIN our writable + STOP_SENDING the readable. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try { await this.writer.close(); } catch { /* already closed/aborted */ }
    try { await this.reader.cancel(); } catch { /* already closed */ }
    this.closedDeferred.resolve();
  }

  private async readLoop(): Promise<void> {
    let firstSeen = false;
    let errored = false;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (value) this.framer.push(value);
        for (const { message } of this.framer.drain()) {
          if (!firstSeen) {
            // §10.18: the first response MUST be REQUEST_OK | REQUEST_ERROR.
            if (message.type !== 'REQUEST_OK' && message.type !== 'REQUEST_ERROR') {
              throw new ProtocolViolationError(
                `SUBSCRIBE_NAMESPACE: first response must be REQUEST_OK/REQUEST_ERROR, got ${message.type}`,
              );
            }
            firstSeen = true;
            errored = message.type === 'REQUEST_ERROR';
            await this.handler(message, 'first');
            if (errored) {
              // §10.9.1: a REQUEST_ERROR first response is terminal — the request
              // is rejected. Close BOTH directions so no half-open stream (an
              // open request writer + a pending reader) lingers.
              await this.close();
              return;
            }
          } else {
            // After REQUEST_ERROR the stream must FIN — no further messages.
            if (errored) {
              throw new ProtocolViolationError('SUBSCRIBE_NAMESPACE: message received after REQUEST_ERROR');
            }
            // A REQUEST_OK / REQUEST_ERROR after the first response answers a
            // pending local REQUEST_UPDATE (§10.9.2), matched FIFO. Without a
            // pending update it is unsolicited → protocol violation.
            if (message.type === 'REQUEST_OK' || message.type === 'REQUEST_ERROR') {
              const exp = this.pendingUpdates.shift();
              if (!exp) {
                throw new ProtocolViolationError(
                  `continuing request: unsolicited ${message.type} (no pending REQUEST_UPDATE)`,
                );
              }
              // Wire-order barrier: apply the update response before any
              // continuation coalesced behind it in the same receive.
              if (exp.process) {
                try {
                  await exp.process(message);
                } catch (err) {
                  const e = err instanceof Error ? err : new Error(String(err));
                  exp.reject(e);
                  throw e;
                }
              }
              exp.resolve(message);
              continue; // not a continuation message
            }
            // After REQUEST_OK only the request-specific continuation messages
            // may follow (NAMESPACE/NAMESPACE_DONE, or PUBLISH_BLOCKED).
            if (!this.allowedContinuation.has(message.type)) {
              throw new ProtocolViolationError(
                `continuing request: expected ${[...this.allowedContinuation].join('/')} after REQUEST_OK, got ${message.type}`,
              );
            }
            await this.handler(message, 'continuation');
          }
        }
        if (done) {
          // A FIN with updates still in flight: they will never be answered.
          for (const d of this.pendingUpdates.splice(0)) {
            d.reject(new ProtocolViolationError('continuing request stream FIN before REQUEST_UPDATE response'));
          }
          this.closedDeferred.resolve();
          return;
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const d of this.pendingUpdates.splice(0)) d.reject(e);
      if (this.closing) {
        this.closedDeferred.resolve();
        return;
      }
      this.closedDeferred.reject(e);
    }
  }
}
