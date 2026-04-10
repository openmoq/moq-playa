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
  createControlCodec,
  varint,
  decodeSubgroupHeader,
  decodeSubgroupObject,
  decodeFetchHeader,
  decodeFetchObject,
  decodeFetchObjectV14,
  decodeObjectDatagram,
  isSubgroupHeaderType,
  DataStreamType,
  SessionError,
  getSubgroupIdMode,
  SubgroupIdMode,
  SubgroupFlags,
  ObjectStatus,
  ProtocolViolationError,
  encodeSubgroupHeader,
  encodeSubgroupObject,
} from '@moqt/transport';
import type {
  ControlMessage,
  ControlCodec,
  DraftVersion,
  SessionOutboundAction,
  Varint,
  DataStreamHeader,
  SubgroupHeader,
  FetchHeader,
  ObjectDatagram,
  FetchPriorContext,
  QlogEvent,
  MoqtObject,
  MoqtObjectData,
  MoqtObjectGap,
  Subscribe,
} from '@moqt/transport';
import type { SetupOptions, SubscribeOptions, RequestUpdateOptions, FetchOptions } from '@moqt/transport';
import { ControlStreamFramer } from './framer.js';
import { MoqtConnectionError } from './adapter-error.js';
import type { WebTransportLike } from './types.js';



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
 * Map a negotiated WT-Available-Protocols string to a DraftVersion.
 *
 * @see draft-ietf-moq-transport-16 §3.1
 * - 'moqt-16' → 16
 * - 'moq-00' → 14 (pre-15 convention)
 * - '' or undefined → undefined (no negotiation, use constructor version)
 */
function protocolToDraftVersion(protocol: string | undefined): DraftVersion | undefined {
  if (!protocol) return undefined;
  if (protocol === 'moq-00') return 14;
  const match = protocol.match(/^moqt-(\d+)$/);
  if (match) return parseInt(match[1]!, 10) as DraftVersion;
  return undefined;
}

export class MoqtConnection {
  /** The underlying sans-I/O session state machine. */
  session: Session;

  /** Draft version this connection was created with. */
  get draftVersion(): DraftVersion {
    return this.session.draftVersion;
  }

  /** Wire format codec for the active negotiated draft version. */
  private codec: ControlCodec;

  private framer: ControlStreamFramer;
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

  /** Track subscriptions by requestId (pending alias resolution). */
  private rawSubscriptions = new Map<bigint, RawSubState>();
  /** Track subscriptions by trackAlias (active, alias resolved). */
  private rawAliasMaps = new Map<bigint, RawSubState>();

  /** Called for each control message received after setup. */
  onMessage?: (msg: ControlMessage) => void;

  /** Called when the control stream or connection closes. */
  onClose?: (error?: number, reason?: string) => void;

  /** Called when the session encounters a protocol error. */
  onError?: (error: Error) => void;

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

  /**
   * Called when a SUBSCRIBE arrives from a remote subscriber.
   * The publisher should respond via acceptSubscribe() or rejectSubscribe().
   * @see draft-ietf-moq-transport-16 §9.5
   */
  onSubscribe?: (
    requestId: Varint,
    namespace: Uint8Array[],
    trackName: Uint8Array,
    parameters: Map<bigint, any>,
  ) => void;

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
   */
  constructor(version?: DraftVersion) {
    this._requestedVersion = version;
    // Initialize with requested version (or default 16).
    // May be reconfigured in connect() if protocol negotiation selects differently.
    const v = version ?? 16;
    this.codec = createControlCodec(v);
    this.framer = new ControlStreamFramer(this.codec);
    this.session = new Session(EndpointRole.CLIENT, version);
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

    // §3.1: Auto-detect draft version from negotiated WT-Available-Protocols.
    // If constructor was given no explicit version, use what the server picked.
    if (this._requestedVersion === undefined && transport.protocol) {
      const negotiated = protocolToDraftVersion(transport.protocol);
      if (negotiated !== undefined && negotiated !== this.codec.version) {
        this.codec = createControlCodec(negotiated);
        this.framer = new ControlStreamFramer(this.codec);
        // Session needs the version for setup message format
        this.session = new Session(EndpointRole.CLIENT, negotiated);
      }
    }

    // Open control stream (first client-initiated bidirectional stream)
    const bidiStream = await transport.createBidirectionalStream();
    this.controlWriter = bidiStream.writable.getWriter();
    const reader = bidiStream.readable.getReader();

    // §9.3.1.1/§9.3.1.2: PATH and AUTHORITY MUST NOT be used when
    // WebTransport is used. MoqtConnection is WebTransport-specific — strip them.
    const { path, authority, ...cleanOptions } = options;

    // Send CLIENT_SETUP
    const setupActions = this.session.initiateSetup(cleanOptions);
    await this.executeActions(setupActions);

    // Read until SERVER_SETUP completes the handshake
    while (this.session.state === SessionState.SETUP_PENDING) {
      const { value, done } = await reader.read();
      if (done) {
        throw new ProtocolViolationError('Control stream closed before setup complete');
      }
      this.framer.push(value);
      const messages = this.framer.drain();
      for (const { message } of messages) {
        const actions = this.session.handleControlMessage(message);
        await this.executeActions(actions);
      }
    }

    // §9.3: Setup must complete successfully before normal exchange.
    // The while-loop exits when state !== SETUP_PENDING, which includes
    // CLOSED (setup failure). Only start background loops if ESTABLISHED.
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
   * Subscribe to a track. Sends SUBSCRIBE on the control stream.
   * @returns The request ID for this subscription.
   */
  async subscribe(
    namespace: Uint8Array[],
    name: Uint8Array,
    options?: SubscribeOptions,
  ): Promise<Varint> {
    const { requestId, actions } = this.session.subscribe(
      namespace,
      name,
      options,
    );
    await this.executeActions(actions);
    return requestId;
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
    const requestId = await this.subscribe(namespace, name, subscribeOpts);
    const reqIdBigint = BigInt(requestId);

    // Create the subscription object — connection reads sub.onObject live
    const sub: TrackSubscription = {
      requestId: reqIdBigint,
      trackAlias: 0n, // placeholder, updated when SUBSCRIBE_OK arrives
      onObject: options?.onObject ?? null,
      unsubscribe: async () => {
        this.rawAliasMaps.delete(sub.trackAlias);
        this.rawSubscriptions.delete(reqIdBigint);
        await this.unsubscribe(requestId);
      },
    };

    return new Promise<TrackSubscription>((resolve, reject) => {
      const state: RawSubState = {
        requestId: reqIdBigint,
        trackAlias: null,
        sub,
        resolve,
        reject,
      };
      this.rawSubscriptions.set(reqIdBigint, state);
    });
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
    existingRequestId: Varint,
    options?: RequestUpdateOptions,
  ): Promise<Varint> {
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
   * @param requestId The request ID of the subscription to unsubscribe
   * @see draft-ietf-moq-transport-16 §2.4.2 (Malformed Track)
   */
  async unsubscribe(requestId: Varint): Promise<void> {
    const actions = this.session.unsubscribe(requestId);
    await this.executeActions(actions);
  }

  /**
   * Close the session. Sends close_connection to the transport.
   */
  async close(error?: Varint, reason?: string): Promise<void> {
    const actions = this.session.close(error, reason);
    await this.executeActions(actions);
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
  ): Promise<Varint> {
    const { requestId, actions } = this.session.subscribeNamespace(
      namespacePrefix,
      subscribeOptions,
    );
    await this.executeActions(actions);
    return requestId;
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
  async cancelNamespace(requestId: Varint): Promise<void> {
    if (this.codec.version === 14) {
      // Draft-14: send UNSUBSCRIBE_NAMESPACE on the control stream
      const actions = this.session.cancelNamespace(requestId);
      await this.executeActions(actions);
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
   * Fetch a range of already-published objects from a track.
   *
   * Sends a Standalone FETCH on the control stream.
   *
   * @param namespace Track namespace
   * @param name Track name
   * @param options Fetch range (startGroup, startObject, endGroup, endObject)
   * @returns The request ID for this fetch
   * @see draft-ietf-moq-transport-16 §9.16
   */
  async fetch(
    namespace: Uint8Array[],
    name: Uint8Array,
    options: FetchOptions,
  ): Promise<Varint> {
    const { requestId, actions } = this.session.fetch(namespace, name, options);
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * Cancel an active fetch.
   *
   * Sends FETCH_CANCEL on the control stream. If a data stream is
   * associated with this fetch, also sends STOP_SENDING on it.
   *
   * §9.18: "A subscriber sends a FETCH_CANCEL message to a publisher
   * to indicate it is no longer interested in receiving objects for the
   * fetch identified by the 'Request ID'."
   *
   * §5.2: "If the data stream is already open, it MAY send STOP_SENDING
   * for the data stream along with FETCH_CANCEL, but MUST send FETCH_CANCEL."
   *
   * @param requestId The request ID of the fetch to cancel
   * @see draft-ietf-moq-transport-16 §5.2, §9.18
   */
  async fetchCancel(requestId: Varint): Promise<void> {
    const actions = this.session.fetchCancel(requestId);
    await this.executeActions(actions);

    // §5.2: Also send STOP_SENDING on the data stream if open
    const streamId = this.fetchStreams.get(requestId as bigint);
    if (streamId !== undefined) {
      const reader = this.dataStreamReaders.get(streamId);
      if (reader) {
        try {
          await reader.cancel(new Error('FETCH_CANCEL'));
        } catch {
          // Stream may already be closed
        }
        this.dataStreamReaders.delete(streamId);
      }
      this.fetchStreams.delete(requestId as bigint);
    }
  }

  /**
   * Query the status of a track without creating a subscription.
   *
   * Sends TRACK_STATUS on the control stream. The response (REQUEST_OK
   * or REQUEST_ERROR) arrives via the onMessage callback.
   *
   * §9.19: "TRACK_STATUS [...] enables a potential subscriber to query
   * the current status of a track without creating a subscription or
   * receiving objects."
   *
   * @param namespace Track namespace
   * @param name Track name
   * @returns The request ID for this query
   * @see draft-ietf-moq-transport-16 §9.19
   */
  async trackStatus(
    namespace: Uint8Array[],
    name: Uint8Array,
  ): Promise<Varint> {
    const { requestId, actions } = this.session.trackStatus(namespace, name);
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
   * Sends PUBLISH_NAMESPACE on the control stream.
   *
   * @param namespace The namespace to advertise
   * @returns The request ID for this namespace publication
   * @see draft-ietf-moq-transport-16 §6.2
   */
  async publishNamespace(namespace: Uint8Array[]): Promise<Varint> {
    const { requestId, actions } = this.session.publishNamespace(namespace);
    await this.executeActions(actions);
    return requestId;
  }

  /**
   * End an announced namespace — sends PUBLISH_NAMESPACE_DONE.
   * The namespace must have been accepted (REQUEST_OK / PUBLISH_NAMESPACE_OK).
   *
   * @param requestId The request ID from publishNamespace()
   * @see draft-ietf-moq-transport-16 §9.22
   */
  async publishNamespaceDone(requestId: Varint): Promise<void> {
    const actions = this.session.publishNamespaceDone(requestId);
    await this.executeActions(actions);
  }

  /**
   * Accept an incoming subscription request from a remote subscriber.
   *
   * Sends SUBSCRIBE_OK on the control stream and transitions the
   * subscription to ESTABLISHED.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE
   * @param trackAlias The track alias to assign
   * @see draft-ietf-moq-transport-16 §9.10
   */
  async acceptSubscribe(requestId: Varint, trackAlias: Varint): Promise<void> {
    const actions = this.session.acceptSubscribe(requestId, trackAlias);
    await this.executeActions(actions);
  }

  /**
   * Reject an incoming subscription request from a remote subscriber.
   *
   * Sends REQUEST_ERROR on the control stream and transitions the
   * subscription to TERMINATED.
   *
   * @param requestId The request ID from the incoming SUBSCRIBE
   * @param errorCode Error code (see §13.4)
   * @param reason Human-readable error reason
   * @see draft-ietf-moq-transport-16 §9.8
   */
  async rejectSubscribe(requestId: Varint, errorCode: Varint, reason: string): Promise<void> {
    const actions = this.session.rejectSubscribe(requestId, errorCode, reason);
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
  async publishDone(requestId: Varint, statusCode: Varint, reason: string): Promise<void> {
    const actions = this.session.publishDone(requestId, statusCode, reason);
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
    trackAlias: Varint,
    groupId: Varint,
    subgroupId: Varint,
    opts?: {
      publisherPriority?: number;
      hasExtensions?: boolean;
      endOfGroup?: boolean;
      /** Use default priority (omit priority byte). §10.4.2 bit 5. */
      defaultPriority?: boolean;
      /** Subgroup ID mode. Default: EXPLICIT (field present). §10.4.2 bits 1-2. */
      subgroupIdMode?: number;
    },
  ): Promise<bigint> {
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

    // Build the type byte from flags
    // §10.4.2: SubgroupFlags encode subgroup ID mode, extensions, end-of-group, priority
    // Bit 4 (SUBGROUP_MARKER) is always set for subgroup headers.
    const mode = opts?.subgroupIdMode ?? SubgroupIdMode.EXPLICIT;
    let typeByte = SubgroupFlags.SUBGROUP_MARKER; // 0x10 base
    typeByte |= (mode << 1);
    if (opts?.hasExtensions) {
      typeByte |= SubgroupFlags.EXTENSIONS;
    }
    if (opts?.endOfGroup) {
      typeByte |= SubgroupFlags.END_OF_GROUP;
    }
    if (opts?.defaultPriority) {
      typeByte |= SubgroupFlags.DEFAULT_PRIORITY;
    }

    const header: SubgroupHeader = {
      typeByte,
      trackAlias,
      groupId,
      subgroupId,
      // §10.4.2: publisherPriority present unless DEFAULT_PRIORITY bit is set
      publisherPriority: opts?.defaultPriority ? undefined : (opts?.publisherPriority ?? 128),
      hasExtensions: opts?.hasExtensions ?? false,
      isEndOfGroup: opts?.endOfGroup ?? false,
    };

    const headerBytes = encodeSubgroupHeader(header);
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
    objectId: Varint,
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

    const objectBytes = encodeSubgroupObject(
      {
        objectId,
        extensions,
        payload,
        status: undefined,
      },
      state.hasExtensions,
      varint(state.previousObjectId),
      state.isFirstObject,
    );

    await state.writer.write(objectBytes);

    state.previousObjectId = objectId as bigint;
    state.isFirstObject = false;
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
          this.transport?.close({
            closeCode: Number(action.error),
            reason: action.reason,
          });
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
          return;
        }
        for (const { message } of messages) {
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
      this.onError?.(new MoqtConnectionError(
        err instanceof Error ? err.message : String(err),
        { errorSource: 'transport', ...(err instanceof Error ? { cause: err } : {}) },
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
          const { datagram } = decodeObjectDatagram(bytes, 0, this.codec.version);
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
   * Process a single incoming data stream: decode header, then objects.
   *
   * Stream types (determined by first varint):
   * - 0x10–0x3D: SUBGROUP_HEADER (§10.4.2)
   * - 0x05: FETCH_HEADER (§10.4.4)
   *
   * @see draft-ietf-moq-transport-16 §10.4
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
        // Phase 2: Decode fetch objects
        await this.readFetchObjects(reader, buf, streamId);
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
      // Clean up fetch stream association
      for (const [reqId, sid] of this.fetchStreams) {
        if (sid === streamId) {
          this.fetchStreams.delete(reqId);
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
    | undefined
  > {
    while (true) {
      // Try to decode if we have any bytes
      if (buf.length > 0) {
        const firstByte = buf[0]!;

        // Determine stream type from first byte (single-byte varint for values < 64)
        if (isSubgroupHeaderType(firstByte, this.codec.version)) {
          try {
            const { header, bytesRead } = decodeSubgroupHeader(buf, 0, this.codec.version);
            return { type: 'subgroup', header, remaining: buf.subarray(bytesRead) };
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            // Not enough bytes yet — fall through to read more
          }
        } else if (firstByte === DataStreamType.FETCH_HEADER) {
          try {
            const { header, bytesRead } = decodeFetchHeader(buf, 0);
            return { type: 'fetch', header, remaining: buf.subarray(bytesRead) };
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
          }
        } else {
          throw new ProtocolViolationError(
            `Unknown data stream type byte 0x${firstByte.toString(16)} — expected SUBGROUP_HEADER (0x10–0x3D) or FETCH_HEADER (0x05)`,
          );
        }
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
    let previousObjectId = varint(0);
    let isFirstObject = true;

    while (true) {
      // Try to decode an object from the buffer
      if (buf.length > 0) {
        try {
          const { object, bytesRead } = decodeSubgroupObject(
            buf,
            0,
            header.hasExtensions,
            previousObjectId,
            isFirstObject,
            this.codec.version,
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

          // Emit the object
          const isGap =
            object.payload.length === 0 && object.status !== undefined;
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
            objectId: varint((previousObjectId as bigint) + 1n),
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
          const { item, bytesRead } = this.codec.version === 14
            ? decodeFetchObjectV14(buf, 0)
            : decodeFetchObject(buf, 0, prior, isFirstObject);
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
    requestId: Varint,
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
    requestId: Varint,
  ): Promise<void> {
    const framer = new ControlStreamFramer(this.codec);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        framer.push(value);
        const messages = framer.drain();
        for (const { message } of messages) {
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
