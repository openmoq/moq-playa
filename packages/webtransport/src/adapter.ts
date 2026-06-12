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
  TrackStatus,
  PublishNamespace,
  SubscribeNamespace,
  SubscribeTracks,
  Goaway,
  Parameters,
  TrackProperties,
} from '@moqt/transport';
import type { SetupOptions, SubscribeOptions, RequestUpdateOptions, FetchOptions, FetchAcceptOptions, TrackStatusAcceptOptions } from '@moqt/transport';
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
  /** Outgoing FETCH response data streams, keyed by synthetic stream ID. */
  private fetchOutgoingStreams = new Map<bigint, {
    writer: WritableStreamDefaultWriter<Uint8Array>;
    groupOrder: GroupOrder;
    prior: FetchObjectPrior18 | undefined;
    isFirstObject: boolean;
  }>();

  /** Called for each control message received after setup. */
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

  /** Fire `onError` for a request/stream failure at most once per Error instance. */
  private reportStreamError(error: Error): void {
    if (this.reportedStreamErrors.has(error)) return;
    this.reportedStreamErrors.add(error);
    this.onError?.(error);
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
  }>();

  /** Counter for synthetic outgoing stream IDs. */
  private nextOutgoingStreamId = 0n;

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
  constructor(version?: DraftVersion, options?: { role?: 'client' | 'server' }) {
    this._requestedVersion = version;
    this._role = options?.role === 'server' ? EndpointRole.SERVER : EndpointRole.CLIENT;
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
      this.uniPair.onRequestClosed = (requestId) => this.handleOutboundRequestClosed(requestId);
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
      // WebTransport carries path/authority in the URL — strip them, same as 14/16.
      const { path, authority, ...cleanOptions } = options;
      void path;
      void authority;
      await this.uniPair!.establish(transport, cleanOptions);
      this.runIncomingStreamLoop(transport);
      this.runDatagramLoop(transport);
      this.runIncomingBidiLoop(transport);
      return;
    }

    // §9.3.1.1/§9.3.1.2: PATH and AUTHORITY MUST NOT be used when
    // WebTransport is used. MoqtConnection is WebTransport-specific — strip them.
    const { path, authority, ...cleanOptions } = options;

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
      const stream = await this.uniPair!.openRequest(this.transport!, subscribeMsg); // returns after the write
      this.routeRequestResponse(stream); // always attach a handler (no unhandled rejection)
      return;
    }
    await this.executeActions(actions);
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
    if (this.session.draftVersion === 18) {
      const publishMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
      const stream = await this.uniPair!.openRequest(this.transport!, publishMsg);
      this.routeRequestResponse(stream);
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
      const message = await stream.response;
      await this.deliverRequestResponse(message, stream.requestId);
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

    // Stamp the stream-derived Request ID (codec leaves it absent on responses).
    const stamped = { ...message, requestId } as ControlMessage;
    this.onQlogEvent?.({
      type: 'control_message_parsed',
      stream_id: MoqtConnection.CONTROL_STREAM_QLOG_ID,
      message: stamped,
    });
    const suppress = this.handleRawSubControlMessage(stamped);
    if (!suppress) this.onMessage?.(stamped);
    await this.executeActions(this.session.handleControlMessage(message, { requestId }));
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
   * Track-Alias routing entry: the subscription is terminated, so late data on
   * that alias MUST NOT be delivered (unlike an inbound PUBLISH after PUBLISH_DONE,
   * where alias routing is deliberately kept for late streams).
   */
  private async handleOutboundRequestClosed(requestId: bigint): Promise<void> {
    await this.executeActions(this.session.handleOutboundRequestClosed(requestId));
    const raw = this.rawSubscriptions.get(requestId);
    if (raw) {
      if (raw.trackAlias !== null) this.rawAliasMaps.delete(raw.trackAlias);
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
    void this.executeActions(this.session.close(SessionError.PROTOCOL_VIOLATION, reason));
    // A fatal session close must not leave subscribeTrack() callers pending forever
    // (matches close() and the legacy fatal control-stream path).
    this.failPendingRawSubscriptions(reason);
    this.onClose?.(Number(SessionError.PROTOCOL_VIOLATION), reason);
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
        this.rawAliasMaps.delete(sub.trackAlias);
        this.rawSubscriptions.delete(reqIdBigint);
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
      // The SUBSCRIBE never went out — drop the pending state and reject the caller.
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
        raw.trackAlias = alias;
        (raw.sub as { trackAlias: bigint }).trackAlias = alias;
        this.rawAliasMaps.set(alias, raw);
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
        const response = await inboundCtx.sendUpdate(updateMsg);
        // Apply via the stamped-response pipeline (REQUEST_OK applies the update).
        await this.deliverRequestResponse(response, requestId);
        return requestId;
      }
      // draft-18 §10.9.2: an outbound SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS rides
      // a CONTINUING request stream. A prefix update is written on it and matched
      // FIFO to its REQUEST_OK / REQUEST_ERROR (which still interleave with
      // NAMESPACE / PUBLISH_BLOCKED continuations).
      if (this.uniPair!.hasContinuingRequest(existingRequestId)) {
        const { requestId, actions } = this.session.requestUpdate(existingRequestId, options);
        const updateMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message;
        const response = await this.uniPair!.sendUpdateOnContinuing(existingRequestId, updateMsg);
        await this.deliverRequestResponse(response, requestId); // stamps + applies REQUEST_OK
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
      const stream = await this.uniPair!.sendUpdate(existingRequestId, updateMsg);
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
    const actions = this.session.unsubscribe(requestId); // draft-18 returns no send_control
    await this.executeActions(actions);
    if (this.session.draftVersion === 18) {
      // Reset the subscribe request stream; this is the draft-18 cancellation
      // signal (a LOCAL cancel — the response handler ignores the resulting
      // RequestCancelledError, so it surfaces no onError).
      await this.uniPair!.cancelRequest(requestId);
      // Drop adapter-owned per-subscription routing so late data on the freed
      // alias is not delivered (idempotent with TrackSubscription.unsubscribe()).
      const raw = this.rawSubscriptions.get(requestId);
      if (raw) {
        if (raw.trackAlias !== null) this.rawAliasMaps.delete(raw.trackAlias);
        this.rawSubscriptions.delete(requestId);
      }
    }
  }

  /**
   * Close the session. Sends close_connection to the transport.
   */
  async close(error?: Varint, reason?: string): Promise<void> {
    const actions = this.session.close(error, reason);
    await this.executeActions(actions);
    // A local close must not leave a caller awaiting subscribeTrack() forever.
    this.failPendingRawSubscriptions(reason ?? 'Session closed');
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
      const { closed } = await this.uniPair!.openContinuingRequest(
        this.transport!,
        action.message,
        (rid, msg, kind) => {
          if (kind === 'first') return this.deliverRequestResponse(msg, rid);
          this.onNamespaceMessage?.(rid, msg as ControlMessage);
          return this.executeActions(this.session.handleNamespaceStreamMessage(rid, msg as ControlMessage));
        },
      );
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
        const actions = this.session.close(SessionError.PROTOCOL_VIOLATION, err.message);
        await this.executeActions(actions);
        this.onClose?.(0x3, err.message);
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
    const { closed } = await this.uniPair!.openContinuingRequest(
      this.transport!,
      msg,
      (rid, m, kind) => {
        if (kind === 'first') return this.deliverRequestResponse(m, rid);
        this.onPublishBlocked?.(rid, m as ControlMessage);
        return this.executeActions(this.session.handleSubscribeTracksStreamMessage(rid, m as ControlMessage));
      },
    );
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
        const actions = this.session.close(SessionError.PROTOCOL_VIOLATION, err.message);
        await this.executeActions(actions);
        this.onClose?.(0x3, err.message);
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
      const stream = await this.uniPair!.openRequest(this.transport!, fetchMsg);
      this.routeRequestResponse(stream);
      return requestId;
    }
    await this.executeActions(actions);
    return requestId;
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
      const stream = await this.uniPair!.openRequest(this.transport!, msg);
      this.routeRequestResponse(stream);
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
      const stream = await this.uniPair!.openRequest(this.transport!, msg);
      this.routeRequestResponse(stream);
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
    const actions = this.session.acceptSubscribe(requestId, trackAlias, options);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
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
      await ctx.finish(); // FIN our writable — one-shot, nothing more to send
      ctx.seal();         // any further inbound message is a protocol violation
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
    const actions = this.session.rejectSubscribe(requestId, errorCode, reason);
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
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
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
    await this.executeActions(actions);
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
    if (await this.writeInboundRequestResponse(requestId, actions)) return;
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
    const actions = this.session.publishDone(requestId, statusCode, reason);
    // draft-18 §10.11: PUBLISH_DONE has no wire Request ID — it is written on the
    // subscription's own bidi request stream (an accepted inbound SUBSCRIBE),
    // then the stream is sealed and FIN'd. Not the uni control stream.
    if (this.session.draftVersion === 18) {
      const ctx = this.inboundRequestContexts.get(requestId);
      if (ctx) {
        const send = actions.find((a) => a.type === 'send_control') as SendControlAction | undefined;
        if (send) await ctx.writeMessage(send.message);
        ctx.seal();
        await ctx.finish();
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

    const streamId = this.nextOutgoingStreamId++;
    this.outgoingStreams.set(streamId, {
      writer,
      hasExtensions: opts?.hasExtensions ?? false,
      previousObjectId: 0n,
      isFirstObject: true,
    });

    return streamId;
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
    const writer = (await this.transport.createUnidirectionalStream()).getWriter();
    await writer.write(encodeFetchHeader18(requestId));

    const streamId = this.nextOutgoingStreamId++;
    this.fetchOutgoingStreams.set(streamId, { writer, groupOrder, prior: undefined, isFirstObject: true });
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
          // in the session being closed as a PROTOCOL_VIOLATION."
          const actions = this.session.close(
            SessionError.PROTOCOL_VIOLATION,
            'Control stream closed unexpectedly',
          );
          await this.executeActions(actions);
          this.onClose?.(0x3, 'Control stream closed unexpectedly');
          this.failPendingRawSubscriptions('Control stream closed unexpectedly');
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
          const actions = this.session.close(
            SessionError.PROTOCOL_VIOLATION,
            `Malformed control message: ${drainMsg}`,
          );
          await this.executeActions(actions);
          this.onClose?.(0x3, `Malformed control message: ${drainMsg}`);
          this.failPendingRawSubscriptions(`Malformed control message: ${drainMsg}`);
          return;
        }
        for (const framed of messages) {
          // draft-14/16: the decoder always yields a fully-correlated
          // ControlMessage (Request IDs are on the wire). draft-18 response
          // correlation will be stamped by the topology before this point
          // (Slice C); until then this single-bidi-control path only carries
          // draft-14/16, so the narrowing is sound.
          const message = framed.message as ControlMessage;
          this.onQlogEvent?.({
            type: 'control_message_parsed',
            stream_id: MoqtConnection.CONTROL_STREAM_QLOG_ID,
            message,
          });
          // Intercept track subscription responses before onMessage.
          // Session still processes them (alias mapping, state machine).
          const suppressOnMessage = this.handleRawSubControlMessage(message);
          if (!suppressOnMessage) {
            this.onMessage?.(message);
          }
          const actions = this.session.handleControlMessage(message);
          await this.executeActions(actions);
          // §9.5: Fire onSubscribe AFTER session processes the SUBSCRIBE
          // (so incomingSubscriptions is populated when acceptSubscribe is called)
          if (message.type === 'SUBSCRIBE' && this.onSubscribe) {
            const sub = message as Subscribe;
            this.onSubscribe(sub.requestId, sub.trackNamespace, sub.trackName, sub.parameters as Map<bigint, any>);
          }
        }
      }
    } catch (err) {
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
      ));
      this.failPendingRawSubscriptions(err instanceof Error ? err.message : String(err));
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
            const actions = this.session.close(
              SessionError.PROTOCOL_VIOLATION,
              err.message,
            );
            await this.executeActions(actions);
            this.onClose?.(0x3, err.message);
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
      this.onPublishNamespaceClosed?.(requestId);
      return; // FIN/reset here is a normal withdrawal, not an error
    }
    if (ctx.requestId !== null && ctx.openerKind === 'subscribe-namespace') {
      const requestId = ctx.requestId;
      await this.executeActions(this.session.handleInboundSubscribeNamespaceClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
      this.onSubscribeNamespaceClosed?.(requestId);
      return; // FIN/reset here is the §10.18 cancellation, not an error
    }
    if (ctx.requestId !== null && ctx.openerKind === 'subscribe-tracks') {
      const requestId = ctx.requestId;
      await this.executeActions(this.session.handleInboundSubscribeTracksClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
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
      // — clean up the request, do NOT surface it as an error. (Alias routing for
      // an inbound PUBLISH is intentionally left intact for late data streams.)
      const requestId = ctx.requestId;
      const wasSubscribe = ctx.openerKind === 'subscribe';
      await this.executeActions(this.session.handleInboundRequestClosed(requestId));
      this.inboundRequestContexts.delete(requestId);
      this.inboundFetchGroupOrder.delete(requestId);
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
      const actions = this.session.close(SessionError.PROTOCOL_VIOLATION, err.message);
      await this.executeActions(actions);
      this.onClose?.(0x3, err.message);
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
      // Keep alias routing — late data streams may still arrive after
      // PUBLISH_DONE. Seal the stream: nothing more may follow.
      const stamped = { ...message, requestId: originalId } as ControlMessage;
      this.onMessage?.(stamped);
      await this.executeActions(this.session.handleInboundPublishDone(originalId));
      ctx.seal();
      this.inboundRequestContexts.delete(originalId);
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
      if (send) await ctx.writeMessage(send.message);
      await this.executeActions(actions.filter((a) => a.type !== 'send_control'));
      // §10.9.1: a failed SUBSCRIBE_NAMESPACE prefix update — the responder MUST
      // close the bidi stream (the subscription is terminated session-side too).
      if (send?.message.type === 'REQUEST_ERROR' && ctx.openerKind === 'subscribe-namespace') {
        ctx.seal();
        await ctx.finish();
        this.inboundRequestContexts.delete(originalId);
      }
      return;
    }

    throw new ProtocolViolationError(`unexpected ${message.type} on inbound request stream`);
  }

  /** Fire onClose for a session-close action using its actual error code. */
  private notifyClose(closeAction: CloseConnectionAction, fallbackReason: string): void {
    this.onClose?.(Number(closeAction.error), closeAction.reason ?? fallbackReason);
  }

  /** Validate + bind an inbound PUBLISH (§10.10). */
  private async bindInboundPublish(pub: Publish, ctx: InboundRequestStreamContext): Promise<void> {
    const requestId = pub.requestId as bigint;
    this.onMessage?.(pub);
    const actions = this.session.handleControlMessage(pub);
    const closeAction = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    await this.executeActions(actions);
    if (closeAction) {
      await ctx.abort();
      this.notifyClose(closeAction, 'PUBLISH rejected');
      return;
    }
    ctx.bind(requestId, 'publish');
    this.inboundRequestContexts.set(requestId, ctx);
    // §2.5.1 / §2.4.2: a PUBLISH whose Track Properties carry an unsupported
    // Mandatory Track Property (→ UNSUPPORTED_EXTENSION) or a data-Object-only
    // Property (→ MALFORMED_TRACK) MUST NOT be processed — respond with
    // REQUEST_ERROR on its own stream, do NOT surface via onPublish. Not a session
    // close (the request, not the connection, failed).
    const fault = this.trackPropertyFault(pub);
    if (fault) {
      await this.rejectSubscribe(requestId, fault.code, fault.reason); // REQUEST_ERROR on the stream
      ctx.seal();
      await ctx.finish(); // FIN after the rejection — the request is done
      this.inboundRequestContexts.delete(requestId);
      return;
    }
    const incoming: IncomingPublish = {
      requestId,
      trackNamespace: pub.trackNamespace,
      trackName: pub.trackName,
      trackAlias: pub.trackAlias as bigint,
      onObject: null,
    };
    this.publishAliasMaps.set(incoming.trackAlias, incoming);
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
    this.onFetch?.(requestId, fetch);
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
      await ctx.finish();
      ctx.seal();
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
      await ctx.finish();
      ctx.seal();
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
        // §10.4.4: Track fetch requestId → streamId for STOP_SENDING on cancel
        this.fetchStreams.set(header.requestId as bigint, streamId);
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
        const actions = this.session.close(
          SessionError.PROTOCOL_VIOLATION,
          err.message,
        );
        await this.executeActions(actions);
        this.onClose?.(0x3, err.message);
        return;
      }

      // §10.4.3: RESET_STREAM is a normal stream lifecycle event —
      // it occurs on UNSUBSCRIBE (§5.1.1), delivery timeout (§9.2.2.2),
      // subscription updates, and publisher decisions.
      // Only surface as onError for non-RESET_STREAM failures.
      const streamErrorCode = typeof (err as any)?.streamErrorCode === 'number'
        ? (err as any).streamErrorCode as number
        : undefined;
      if (streamErrorCode === undefined) {
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
      // Clean up fetch stream association (and any draft-18 group-order state)
      for (const [reqId, sid] of this.fetchStreams) {
        if (sid === streamId) {
          this.fetchStreams.delete(reqId);
          this.fetchGroupOrder.delete(reqId);
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
          const actions = this.session.close(
            SessionError.PROTOCOL_VIOLATION,
            'Stream FIN received mid-header (§10.4)',
          );
          await this.executeActions(actions);
          this.onClose?.(0x3, 'Stream FIN received mid-header');
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
          const actions = this.session.close(
            SessionError.PROTOCOL_VIOLATION,
            'Stream FIN received mid-object (§10.4)',
          );
          await this.executeActions(actions);
          this.onClose?.(0x3, 'Stream FIN received mid-object');
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
          const actions = this.session.close(
            SessionError.PROTOCOL_VIOLATION,
            'Fetch stream FIN received mid-object (§10.4)',
          );
          await this.executeActions(actions);
          this.onClose?.(0x3, 'Fetch stream FIN received mid-object');
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
      throw new ProtocolViolationError(
        `FETCH_HEADER for unknown Request ID ${header.requestId} (no FETCH was issued)`,
      );
    }
    let prior: FetchObjectPrior18 | undefined;
    let isFirstObject = true;

    while (true) {
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
          const actions = this.session.close(
            SessionError.PROTOCOL_VIOLATION,
            'Fetch stream FIN received mid-object (§11.4.4)',
          );
          await this.executeActions(actions);
          this.onClose?.(0x3, 'Fetch stream FIN received mid-object');
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
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'control', ...(err instanceof Error ? { cause: err } : {}) },
      ));
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
