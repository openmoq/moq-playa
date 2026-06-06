/**
 * MOQT session state machine.
 *
 * Coordinates all session-level state: setup handshake, request ID allocation,
 * subscriptions, fetches, namespace discovery, and track aliases.
 *
 * This is a sans-I/O implementation: it consumes control messages and produces
 * actions to be executed by the I/O layer. No network operations are performed
 * directly.
 *
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import { varint, type Varint } from '../primitives/varint.js';
import { readLocation } from '../primitives/location.js';
import { encodeSubscriptionFilter, validateSubscriptionFilter, type SubscriptionFilter } from '../control/subscription-filter.js';
import { validateTrackNamespace, validateTrackNamespacePrefix, validateFullTrackName, isReservedSessionNamespace, isReservedDotNamespace } from '../primitives/bytes.js';
import { SessionError as SessionErrorCode, RequestError as RequestErrorCode } from '../errors.js';
import type {
  ControlMessage,
  ClientSetup,
  ServerSetup,
  Setup,
  Subscribe,
  SubscribeOk,
  SubscribeNamespace,
  SubscribeTracks,
  PublishBlocked,
  RequestUpdate,
  RequestOk,
  RequestErrorMsg,
  Fetch,
  StandaloneFetch,
  FetchOk,
  FetchCancel,
  PublishDone,
  Unsubscribe,
  Goaway,
  MaxRequestId,
  RequestsBlocked,
  Namespace,
  NamespaceDone,
  TrackStatus,
  PublishNamespace,
  PublishNamespaceDone,
  PublishNamespaceCancel,
  PublishNamespaceOk,
  PublishNamespaceError,
  UnsubscribeNamespace,
  Publish,
  PublishOk,
  PublishError,
} from '../control/messages.js';
import type { DraftVersion, DecodedControlMessage } from '../control/codec.js';
import {
  SessionState,
  EndpointRole,
  ForwardState,
  SubscriptionState,
  type SessionStateValue,
  type EndpointRoleValue,
  type ForwardStateValue,
  type SessionOutboundAction,
  type SendControlAction,
  type CloseConnectionAction,
  type OpenNamespaceStreamAction,
  type NotifyNamespaceAction,
} from './types.js';
import { SetupGate, SetupError } from './setup.js';
import { RequestIdAllocator, RequestIdError } from './request-id.js';
import { getProtocolProfile, type ProtocolProfile } from '../profile.js';
import type { RequestEndpoint } from './request-endpoint.js';
import { SubscriptionStateMachine } from './subscription.js';
import { FetchStateMachine } from './fetch.js';
import type { GroupOrder } from '../data/types.js';
import { NamespaceStateMachine } from './namespace.js';
import { TrackAliasManager } from './track-alias.js';
import { MessageParam } from '../control/parameters.js';
import type { Parameters, ParameterValue, TrackProperties } from '../control/messages.js';
import { AuthTokenCache, AuthCacheError } from './auth-cache.js';
import { AliasType, parseAuthorizationToken, parseAuthorizationToken18, type AuthorizationToken, type ResolvedToken } from '../control/auth-token.js';

/**
 * Set of known message parameter type codes.
 * @see draft-ietf-moq-transport-16 §9.2.2
 */
const KNOWN_MESSAGE_PARAMS = new Set<bigint>([
  MessageParam.DELIVERY_TIMEOUT as bigint,
  MessageParam.AUTHORIZATION_TOKEN as bigint,
  MessageParam.EXPIRES as bigint,
  MessageParam.LARGEST_OBJECT as bigint,
  MessageParam.FORWARD as bigint,
  MessageParam.SUBSCRIBER_PRIORITY as bigint,
  MessageParam.SUBSCRIPTION_FILTER as bigint,
  MessageParam.GROUP_ORDER as bigint,
  MessageParam.NEW_GROUP_REQUEST as bigint,
  MessageParam.TRACK_NAMESPACE_PREFIX as bigint, // draft-18 §10.2.14
]);

/**
 * Mapping of message parameter types to the message types where they are valid.
 * Per §9.2.2: "If it appears in some other type of message, it MUST be ignored."
 * @see draft-ietf-moq-transport-16 §9.2.2
 */
const VALID_PARAMS_FOR_MESSAGE_TYPE: Map<bigint, Set<string>> = new Map([
  // §9.2.2.2: DELIVERY_TIMEOUT MAY appear in PUBLISH_OK, SUBSCRIBE, REQUEST_UPDATE
  [MessageParam.DELIVERY_TIMEOUT as bigint, new Set(['PUBLISH_OK', 'SUBSCRIBE', 'REQUEST_UPDATE'])],
  // §9.2.2.1: AUTHORIZATION_TOKEN MAY appear in PUBLISH, SUBSCRIBE, REQUEST_UPDATE,
  // SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, TRACK_STATUS, FETCH
  [MessageParam.AUTHORIZATION_TOKEN as bigint, new Set([
    'PUBLISH', 'SUBSCRIBE', 'REQUEST_UPDATE', 'SUBSCRIBE_NAMESPACE',
    'PUBLISH_NAMESPACE', 'TRACK_STATUS', 'FETCH',
  ])],
  // §9.2.2.6: EXPIRES MAY appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK
  [MessageParam.EXPIRES as bigint, new Set(['SUBSCRIBE_OK', 'PUBLISH', 'PUBLISH_OK'])],
  // §9.2.2.7: LARGEST_OBJECT MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_OK
  [MessageParam.LARGEST_OBJECT as bigint, new Set(['SUBSCRIBE_OK', 'PUBLISH', 'REQUEST_OK'])],
  // §9.2.2.8: FORWARD MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE
  [MessageParam.FORWARD as bigint, new Set(['SUBSCRIBE', 'REQUEST_UPDATE', 'PUBLISH', 'PUBLISH_OK', 'SUBSCRIBE_NAMESPACE'])],
  // §9.2.2.3: SUBSCRIBER_PRIORITY MAY appear in SUBSCRIBE, FETCH, REQUEST_UPDATE, PUBLISH_OK
  [MessageParam.SUBSCRIBER_PRIORITY as bigint, new Set(['SUBSCRIBE', 'FETCH', 'REQUEST_UPDATE', 'PUBLISH_OK'])],
  // §9.2.2.5: SUBSCRIPTION_FILTER MAY appear in SUBSCRIBE, PUBLISH_OK, REQUEST_UPDATE
  [MessageParam.SUBSCRIPTION_FILTER as bigint, new Set(['SUBSCRIBE', 'PUBLISH_OK', 'REQUEST_UPDATE'])],
  // §9.2.2.4: GROUP_ORDER MAY appear in SUBSCRIBE, PUBLISH_OK, FETCH
  // Draft-14 also carries it inline on PUBLISH; handle that as a versioned exception.
  [MessageParam.GROUP_ORDER as bigint, new Set(['SUBSCRIBE', 'PUBLISH_OK', 'FETCH'])],
  // §9.2.2.9: NEW_GROUP_REQUEST MAY appear in PUBLISH_OK, SUBSCRIBE, REQUEST_UPDATE
  [MessageParam.NEW_GROUP_REQUEST as bigint, new Set(['PUBLISH_OK', 'SUBSCRIBE', 'REQUEST_UPDATE'])],
  // draft-18 §10.2.14: TRACK_NAMESPACE_PREFIX MAY appear in REQUEST_UPDATE (to
  // change the prefix of a SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS).
  [MessageParam.TRACK_NAMESPACE_PREFIX as bigint, new Set(['REQUEST_UPDATE'])],
]);

/**
 * draft-18 known message-parameter type codes (§15.7). Distinct from the
 * draft-14/16 set: draft-18 adds RENDEZVOUS_TIMEOUT, SUBGROUP_DELIVERY_TIMEOUT
 * and FILL_TIMEOUT, and treats every unknown type as a PROTOCOL_VIOLATION.
 * @see draft-ietf-moq-transport-18 §10.2, §15.7
 */
const KNOWN_MESSAGE_PARAMS_18 = new Set<bigint>([
  MessageParam.OBJECT_DELIVERY_TIMEOUT as bigint, // 0x02
  MessageParam.AUTHORIZATION_TOKEN as bigint,      // 0x03
  MessageParam.RENDEZVOUS_TIMEOUT as bigint,       // 0x04
  MessageParam.SUBGROUP_DELIVERY_TIMEOUT as bigint, // 0x06
  MessageParam.EXPIRES as bigint,                  // 0x08
  MessageParam.LARGEST_OBJECT as bigint,           // 0x09
  MessageParam.FILL_TIMEOUT as bigint,             // 0x0a
  MessageParam.FORWARD as bigint,                  // 0x10
  MessageParam.SUBSCRIBER_PRIORITY as bigint,      // 0x20
  MessageParam.SUBSCRIPTION_FILTER as bigint,      // 0x21
  MessageParam.GROUP_ORDER as bigint,              // 0x22
  MessageParam.NEW_GROUP_REQUEST as bigint,        // 0x32
  MessageParam.TRACK_NAMESPACE_PREFIX as bigint,   // 0x34
]);

/**
 * draft-18 message-parameter scope table (§10.2.2–§10.2.14). Keys include the
 * request message types AND the response *contexts* a REQUEST_OK can answer
 * (PUBLISH_OK, REQUEST_UPDATE_OK, TRACK_STATUS_OK) plus the distinct response
 * messages SUBSCRIBE_OK — see {@link Session.d18RequestOkContext}. Per §10.2.1,
 * a known parameter appearing OUT of scope is a PROTOCOL_VIOLATION (draft-14/16
 * instead silently ignore it).
 * @see draft-ietf-moq-transport-18 §10.2.1
 */
const VALID_PARAMS_FOR_MESSAGE_TYPE_18: Map<bigint, Set<string>> = new Map([
  // §10.2.4
  [MessageParam.OBJECT_DELIVERY_TIMEOUT as bigint, new Set(['PUBLISH_OK', 'SUBSCRIBE', 'REQUEST_UPDATE'])],
  // §10.2.2
  [MessageParam.AUTHORIZATION_TOKEN as bigint, new Set([
    'PUBLISH', 'SUBSCRIBE', 'REQUEST_UPDATE', 'SUBSCRIBE_NAMESPACE', 'SUBSCRIBE_TRACKS',
    'PUBLISH_NAMESPACE', 'TRACK_STATUS', 'FETCH',
  ])],
  // §10.2.6
  [MessageParam.RENDEZVOUS_TIMEOUT as bigint, new Set(['SUBSCRIBE'])],
  // §10.2.3
  [MessageParam.SUBGROUP_DELIVERY_TIMEOUT as bigint, new Set(['PUBLISH_OK', 'SUBSCRIBE', 'REQUEST_UPDATE'])],
  // §10.2.10
  [MessageParam.EXPIRES as bigint, new Set(['SUBSCRIBE_OK', 'PUBLISH', 'PUBLISH_OK', 'REQUEST_UPDATE_OK'])],
  // §10.2.11
  [MessageParam.LARGEST_OBJECT as bigint, new Set(['SUBSCRIBE_OK', 'PUBLISH', 'REQUEST_UPDATE_OK', 'TRACK_STATUS_OK'])],
  // §10.2.5
  [MessageParam.FILL_TIMEOUT as bigint, new Set(['FETCH'])],
  // §10.2.12
  [MessageParam.FORWARD as bigint, new Set(['SUBSCRIBE', 'REQUEST_UPDATE', 'PUBLISH', 'PUBLISH_OK', 'SUBSCRIBE_TRACKS'])],
  // §10.2.7
  [MessageParam.SUBSCRIBER_PRIORITY as bigint, new Set(['SUBSCRIBE', 'FETCH', 'REQUEST_UPDATE', 'PUBLISH_OK'])],
  // §10.2.9
  [MessageParam.SUBSCRIPTION_FILTER as bigint, new Set(['SUBSCRIBE', 'PUBLISH_OK', 'REQUEST_UPDATE'])],
  // §10.2.8
  [MessageParam.GROUP_ORDER as bigint, new Set(['SUBSCRIBE', 'PUBLISH_OK', 'FETCH'])],
  // §10.2.13
  [MessageParam.NEW_GROUP_REQUEST as bigint, new Set(['PUBLISH_OK', 'SUBSCRIBE', 'REQUEST_UPDATE'])],
  // §10.2.14 — generic REQUEST_UPDATE scope; the namespace/tracks-target restriction
  // is enforced contextually in handleIncomingRequestUpdate.
  [MessageParam.TRACK_NAMESPACE_PREFIX as bigint, new Set(['REQUEST_UPDATE'])],
]);

/**
 * Whether two Track Namespace Prefixes overlap: one is a (field-wise) prefix of
 * the other, so a single PUBLISH_NAMESPACE could match both. Used to reject an
 * overlapping incoming SUBSCRIBE_NAMESPACE with PREFIX_OVERLAP (§10.18).
 */
function prefixesOverlap(a: Uint8Array[], b: Uint8Array[]): boolean {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  for (let i = 0; i < shorter.length; i++) {
    const x = shorter[i]!, y = longer[i]!;
    if (x.length !== y.length) return false;
    for (let j = 0; j < x.length; j++) {
      if (x[j] !== y[j]) return false;
    }
  }
  return true; // every field of the shorter prefix matches the longer's
}

/**
 * Error thrown for session-level protocol violations.
 */
export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: 'PROTOCOL_VIOLATION' | 'INVALID_STATE' | 'RESOURCE_EXHAUSTED' | 'INVALID_RANGE',
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * Error thrown when an application API method is called after the
 * session has received a GOAWAY (state is DRAINING). Carries the
 * `newUri` from the GOAWAY so the application can reconnect.
 *
 * Applications should catch this specifically to drive reconnection
 * logic — distinct from generic `SessionError('INVALID_STATE')` which
 * covers other state-machine misuse (e.g. calling APIs before setup
 * completes).
 *
 * @see draft-ietf-moq-transport-16 §9.4 (GOAWAY)
 */
export class SessionDrainingError extends Error {
  constructor(
    message: string,
    /** The new-session URI from the GOAWAY, or empty string if none was provided. */
    public readonly newUri: string,
  ) {
    super(message);
    this.name = 'SessionDrainingError';
  }
}

/**
 * Options for initiating or completing setup.
 */
export interface SetupOptions {
  maxRequestId?: Varint;
  path?: string;
  authority?: string;
  implementation?: string;
  /**
   * Our MAX_AUTH_TOKEN_CACHE_SIZE to advertise to the peer. Declares how many bytes
   * of token aliases we are willing to cache. Default 0 = aliases prohibited. Raw
   * `bigint`: draft-18 §10.3.1.3 carries it as a vi64 (full uint64); draft-14/16
   * encode it as a QUIC varint, where an above-range value throws on encode.
   * @see draft-ietf-moq-transport-18 §10.3.1.3
   */
  maxAuthTokenCacheSize?: bigint;
  /**
   * Raw AUTHORIZATION_TOKEN parameter values to include in setup.
   * Each Uint8Array is a serialized Token structure (Figure 4).
   * @see draft-ietf-moq-transport-16 §9.3.1.5
   */
  authTokens?: Uint8Array[];
}

/**
 * Options for creating a subscription.
 */
/**
 * Options for creating a subscription.
 * @see draft-ietf-moq-transport-16 §9.2.2
 */
export interface SubscribeOptions {
  /** §9.2.2.2: Duration in milliseconds. MUST be > 0. */
  deliveryTimeout?: Varint;
  /** §9.2.2.3: Priority relative to other subscriptions. Range 0-255. Lower = higher priority. */
  subscriberPriority?: Varint;
  /** §9.2.2.4: Ascending (0x1) or Descending (0x2). */
  groupOrder?: Varint;
  /**
   * §9.2.2.5: Subscription filter.
   * If omitted, the subscription is unfiltered (all objects pass).
   */
  subscriptionFilter?: SubscriptionFilter;
}

/**
 * Options for sending a REQUEST_UPDATE.
 * @see draft-ietf-moq-transport-16 §9.11
 */
export interface RequestUpdateOptions {
  forward?: ForwardStateValue;
  /** §9.2.2.3: SUBSCRIBER_PRIORITY MAY appear in REQUEST_UPDATE. */
  subscriberPriority?: Varint;
  /** §9.2.2.5: SUBSCRIPTION_FILTER MAY appear in REQUEST_UPDATE to change subscription range. */
  subscriptionFilter?: SubscriptionFilter;
  /**
   * draft-18 §10.9.2 / §10.2.14: a new Track Namespace Prefix. Valid ONLY when
   * `existingRequestId` is an outbound SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS;
   * sets the TRACK_NAMESPACE_PREFIX (0x34) parameter and, on REQUEST_OK, replaces
   * the stored prefix. Supplying it for a normal subscription update throws (it is
   * a draft-18-only concept; there is no such update in draft-14/16).
   */
  trackNamespacePrefix?: Uint8Array[];
}

/**
 * Options for creating a fetch.
 */
export interface FetchOptions {
  // Fetch Locations are vi64 (full uint64) on draft-18, so `bigint`. The
  // draft-14/16 FETCH encoder still range-checks them against the QUIC-varint
  // range on encode (a value above 2^62-1 throws there).
  startGroup: bigint;
  startObject: bigint;
  endGroup?: bigint;
  endObject?: bigint;
  /**
   * Requested Group Order (§9.2.2.4 / §10.2). Sets the GROUP_ORDER (0x22)
   * parameter (Ascending = 0x1, Descending = 0x2). When omitted, the parameter
   * is not sent and the response is decoded as Ascending per spec.
   */
  groupOrder?: GroupOrder;
}

/**
 * Options for accepting an incoming FETCH (FETCH_OK metadata, §10.13). Locations
 * are vi64 (full uint64) on draft-18, so `bigint`.
 */
export interface FetchAcceptOptions {
  /** 1 if the End Location is the final Object in the Track, else 0. */
  endOfTrack?: number;
  /** End of the range covered by the FETCH response. */
  endLocation?: { group: bigint; object: bigint };
  /** Response parameters. */
  parameters?: Parameters;
  /** draft-18 Track Properties (§2.5) on the FETCH_OK; non-empty on draft-14/16 throws. */
  trackProperties?: TrackProperties;
}

/**
 * Options for accepting an incoming TRACK_STATUS (TRACK_STATUS_OK, §10.14).
 * `parameters` are the REQUEST_OK message parameters (as for SUBSCRIBE_OK).
 * `trackProperties` are the draft-18 Track Properties (§2.5) — draft-14/16 have
 * no such field, so supplying non-empty Track Properties there throws.
 */
export interface TrackStatusAcceptOptions {
  parameters?: Parameters;
  trackProperties?: TrackProperties;
}

/** Local state for an outgoing SUBSCRIBE_TRACKS request (draft-18 §10.19). */
export interface TrackSubscriptionState {
  /** Mutable: a §10.9.2 prefix update replaces it on REQUEST_OK. */
  trackNamespacePrefix: Uint8Array[];
  state: 'pending' | 'active' | 'terminated';
  /** Tracks the publisher reported it cannot serve, via PUBLISH_BLOCKED. */
  readonly blockedTracks: Array<{ trackNamespaceSuffix: Uint8Array[]; trackName: Uint8Array }>;
}

/**
 * Result of subscribe/fetch operations.
 */
export interface RequestResult {
  requestId: bigint;
  actions: SessionOutboundAction[];
}

/**
 * MOQT Session state machine.
 *
 * Manages the full lifecycle of a MOQT session from setup to close.
 */
export class Session {
  private readonly setupGate: SetupGate;
  /**
   * Per-draft behavior bundle. Today only its {@link ProtocolProfile.requestPolicy}
   * is consumed; the {@link ProtocolProfile.capabilities} flags are installed for
   * the upcoming branch-cleanup slice (they let the session key off named
   * capabilities instead of raw `_draftVersion` comparisons).
   */
  private readonly _profile: ProtocolProfile;
  private readonly requestIdAllocator: RequestIdAllocator;
  private readonly trackAliases = new TrackAliasManager();

  /** Outgoing subscriptions (as subscriber). */
  private readonly subscriptions = new Map<bigint, SubscriptionStateMachine>();
  /** Track info for subscriptions (for alias registration). */
  private readonly subscriptionTracks = new Map<bigint, { namespace: Uint8Array[]; name: Uint8Array }>();

  /** Outgoing fetches (as fetcher). */
  private readonly fetches = new Map<bigint, FetchStateMachine>();

  /**
   * Outgoing PUBLISH requests (as publisher, draft-18 §10.10). We initiate a
   * PUBLISH on its own bidi request stream, advertise a Track Alias, and the peer
   * replies REQUEST_OK (PUBLISH_OK shorthand) / REQUEST_ERROR. Distinct from
   * {@link incomingSubscriptions} (peer-initiated SUBSCRIBE we serve) so response
   * correlation never crosses the two roles.
   */
  private readonly outgoingPublishes = new Map<bigint, SubscriptionStateMachine>();

  /** Incoming subscriptions (as publisher). */
  private readonly incomingSubscriptions = new Map<bigint, SubscriptionStateMachine>();

  /** Incoming fetches (as publisher). */
  private readonly incomingFetches = new Map<bigint, FetchStateMachine>();

  /** Outgoing namespace subscriptions (as namespace subscriber). */
  private readonly namespaceSubscriptions = new Map<bigint, NamespaceStateMachine>();

  /**
   * Outgoing SUBSCRIBE_TRACKS requests (draft-18 §10.19), keyed by Request ID.
   * `pending` → `active` on REQUEST_OK, `terminated` on REQUEST_ERROR / stream
   * close. `blockedTracks` accumulates PUBLISH_BLOCKED received on the response
   * stream. (PUBLISH for matched tracks arrives on its own inbound bidi stream,
   * handled by the inbound-request path.)
   */
  private readonly trackSubscriptions = new Map<bigint, TrackSubscriptionState>();

  /**
   * Pending REQUEST_UPDATEs: maps update requestId → pending update info.
   * `forward` applies to a subscription update; `namespacePrefix` + `prefixTarget`
   * apply a draft-18 §10.9.2 prefix change to an outbound SUBSCRIBE_NAMESPACE
   * (`'namespace'`) or SUBSCRIBE_TRACKS (`'tracks'`) on REQUEST_OK.
   */
  private readonly pendingUpdates = new Map<bigint, {
    existingRequestId: bigint;
    forward?: ForwardStateValue;
    namespacePrefix?: Uint8Array[];
    prefixTarget?: 'namespace' | 'tracks';
  }>();

  /**
   * Pending outgoing TRACK_STATUS requests (as subscriber).
   * Maps requestId → track info. No subscription state created.
   * @see draft-ietf-moq-transport-16 §9.19
   */
  private readonly pendingTrackStatuses = new Map<bigint, { namespace: Uint8Array[]; name: Uint8Array }>();

  /**
   * PUBLISH_NAMESPACE lifecycle tracking.
   * 'pending': awaiting REQUEST_OK/PUBLISH_NAMESPACE_OK
   * 'active': accepted, can send PUBLISH_NAMESPACE_DONE
   * @see draft-ietf-moq-transport-16 §9.20, §9.22
   */
  private readonly publishedNamespaces = new Map<bigint, {
    namespace: Uint8Array[];
    state: 'pending' | 'active';
  }>();

  /**
   * Incoming TRACK_STATUS requests (as publisher).
   * Maps requestId → track info. No subscription state created.
   * @see draft-ietf-moq-transport-16 §9.19
   */
  private readonly incomingTrackStatuses = new Map<bigint, { namespace: Uint8Array[]; name: Uint8Array }>();

  /**
   * Incoming PUBLISH_NAMESPACE requests we accepted (draft-18, as the receiver).
   * Maps requestId → announced namespace. Each rides its own bidi request stream;
   * a FIN/reset of that stream withdraws the namespace (§3.3.2), handled via
   * {@link handleInboundPublishNamespaceClosed}. Populated only for draft-18,
   * where PUBLISH_NAMESPACE is a request stream rather than a control message.
   */
  private readonly incomingPublishNamespaces = new Map<bigint, { namespace: Uint8Array[] }>();

  /**
   * Incoming SUBSCRIBE_NAMESPACE requests we are serving as the publisher
   * (draft-18, §10.18). Each rides its own continuing bidi request stream; we
   * answer NAMESPACE / NAMESPACE_DONE on it until the subscriber cancels
   * (FIN/reset), handled via {@link handleInboundSubscribeNamespaceClosed}.
   * Kept separate from {@link namespaceSubscriptions} (our OUTBOUND, subscriber
   * side) so prefix-match scans never confuse the two roles.
   */
  private readonly incomingNamespaceSubscriptions = new Map<bigint, NamespaceStateMachine>();

  /**
   * Incoming SUBSCRIBE_TRACKS requests we are serving as the publisher
   * (draft-18 §10.19). Each rides its own continuing bidi request stream on which
   * we may send PUBLISH (new streams) and PUBLISH_BLOCKED until the subscriber
   * cancels (FIN/reset). Kept separate from {@link trackSubscriptions} (our
   * OUTBOUND, subscriber side) AND from {@link incomingNamespaceSubscriptions}
   * (SUBSCRIBE_NAMESPACE) so prefix-overlap checks never cross request types.
   */
  private readonly incomingTrackSubscriptions = new Map<bigint, { trackNamespacePrefix: Uint8Array[]; state: 'pending' | 'active' }>();

  /**
   * Auth token alias cache for tokens the peer registers with us.
   * Created after setup when we know our MAX_AUTH_TOKEN_CACHE_SIZE.
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  private authCache: AuthTokenCache | null = null;

  /**
   * Our own MAX_AUTH_TOKEN_CACHE_SIZE (set during setup).
   * Used to create the authCache.
   */
  private _ownMaxAuthTokenCacheSize: number = 0;

  /**
   * The peer's MAX_AUTH_TOKEN_CACHE_SIZE (from their setup message).
   * Limits how many token aliases we can register with them.
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  // draft-18 §10.3.1.3: vi64 (full uint64), so a raw `bigint`.
  private _peerMaxAuthTokenCacheSize: bigint = 0n;

  private _state: SessionStateValue = SessionState.IDLE;
  private _newSessionUri: string | undefined;
  private _peerMaxRequestId: Varint = varint(0n);
  private _goawayReceived: boolean = false;

  constructor(
    private readonly _role: EndpointRoleValue,
    private readonly _draftVersion: DraftVersion = 16,
    /**
     * Session-level policy. `webtransport: true` enables the §10.3.1.1/§10.3.1.2
     * rule that PATH/AUTHORITY MUST NOT appear in SETUP over WebTransport (the WT
     * adapter sets this); default `false` = native QUIC.
     */
    options: { webtransport?: boolean } = {},
  ) {
    this.setupGate = new SetupGate(_role, _draftVersion, options.webtransport ?? false);
    this._profile = getProtocolProfile(_draftVersion);
    this.requestIdAllocator = new RequestIdAllocator(_role, undefined, this._profile.requestPolicy);
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  /** Current session state. */
  get state(): SessionStateValue {
    return this._state;
  }

  /** Endpoint role (CLIENT or SERVER). */
  get role(): EndpointRoleValue {
    return this._role;
  }

  /** New session URI from GOAWAY (for migration). */
  get newSessionUri(): string | undefined {
    return this._newSessionUri;
  }

  /** Draft version for this session. */
  get draftVersion(): DraftVersion {
    return this._draftVersion;
  }

  /** Peer's MAX_REQUEST_ID from setup. */
  get peerMaxRequestId(): Varint {
    return this._peerMaxRequestId;
  }

  /**
   * Peer's MAX_AUTH_TOKEN_CACHE_SIZE from setup.
   * Limits how many token alias bytes we can register with them.
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  get peerMaxAuthTokenCacheSize(): bigint {
    return this._peerMaxAuthTokenCacheSize;
  }

  // ─── Setup Handshake ──────────────────────────────────────────────────

  /**
   * Initiate setup handshake (client only).
   * Creates and returns CLIENT_SETUP message.
   */
  initiateSetup(options: SetupOptions = {}): SessionOutboundAction[] {
    this.assertState(SessionState.IDLE, 'initiateSetup');

    if (this._draftVersion === 18) {
      // draft-18: send the unified SETUP (no MAX_REQUEST_ID — QUIC stream limits).
      const setup = this.setupGate.createSetup18(options);
      if (options.maxAuthTokenCacheSize !== undefined) {
        this._ownMaxAuthTokenCacheSize = Number(options.maxAuthTokenCacheSize);
      }
      this._state = SessionState.SETUP_PENDING;
      return [this.sendControl(setup)];
    }

    const clientSetup = this.setupGate.createClientSetup(options);

    // Set our MAX_REQUEST_ID so validateIncoming() knows what we advertised
    if (options.maxRequestId && options.maxRequestId > 0n) {
      this.requestIdAllocator.setOurMaxRequestId(options.maxRequestId);
    }

    // Track our own MAX_AUTH_TOKEN_CACHE_SIZE for cache initialization
    if (options.maxAuthTokenCacheSize !== undefined) {
      this._ownMaxAuthTokenCacheSize = Number(options.maxAuthTokenCacheSize);
    }

    this._state = SessionState.SETUP_PENDING;

    return [this.sendControl(clientSetup)];
  }

  /**
   * Complete setup handshake (server only).
   * Creates and returns SERVER_SETUP message.
   */
  completeSetup(options: SetupOptions = {}): SessionOutboundAction[] {
    this.assertState(SessionState.SETUP_PENDING, 'completeSetup');

    if (this._role !== EndpointRole.SERVER) {
      throw new SessionError('Only server can call completeSetup', 'INVALID_STATE');
    }

    if (this._draftVersion === 18) {
      const setup = this.setupGate.createSetup18(options);
      if (options.maxAuthTokenCacheSize !== undefined) {
        this._ownMaxAuthTokenCacheSize = Number(options.maxAuthTokenCacheSize);
      }
      this._state = SessionState.ESTABLISHED;
      return [this.sendControl(setup)];
    }

    const serverSetup = this.setupGate.createServerSetup(options);

    // Set our MAX_REQUEST_ID so validateIncoming() knows what we advertised
    if (options.maxRequestId && options.maxRequestId > 0n) {
      this.requestIdAllocator.setOurMaxRequestId(options.maxRequestId);
    }

    // Track our own MAX_AUTH_TOKEN_CACHE_SIZE for cache initialization
    if (options.maxAuthTokenCacheSize !== undefined) {
      this._ownMaxAuthTokenCacheSize = Number(options.maxAuthTokenCacheSize);
    }

    this._state = SessionState.ESTABLISHED;

    return [this.sendControl(serverSetup)];
  }

  // ─── Control Message Handling ─────────────────────────────────────────

  /**
   * Handle an incoming control message.
   * Returns actions to execute in response.
   */
  handleControlMessage(decoded: DecodedControlMessage, endpoint?: RequestEndpoint): SessionOutboundAction[] {
    // Draft-18 correlation seam: when this message arrived on a request stream,
    // the I/O/topology layer supplies the stream-derived Request ID (responses)
    // or update target (REQUEST_UPDATE). For draft-14/16 the Request ID is on
    // the wire and `endpoint` is omitted, so this is a passthrough that simply
    // re-types the decoded message as a fully-correlated ControlMessage.
    const msg = this.applyRequestEndpoint(decoded, endpoint);

    // Setup phase validation
    if (this._state === SessionState.IDLE || this._state === SessionState.SETUP_PENDING) {
      return this.handleSetupMessage(msg);
    }

    if (this._state === SessionState.CLOSED) {
      throw new SessionError('Session is closed', 'INVALID_STATE');
    }

    // §9.2: Validate message parameters for all messages that have them
    // (Setup parameters are handled separately in handleSetupMessage)
    const paramError = this.validateControlMessageParams(msg);
    if (paramError) {
      return this.closeWithError(paramError.error, paramError.reason);
    }

    // Dispatch based on message type.
    // §9: Invalid peer behavior (e.g., duplicate SUBSCRIBE_OK, PUBLISH_DONE
    // in wrong state) causes state machine methods to throw. Convert these
    // into close_connection actions with PROTOCOL_VIOLATION rather than
    // letting them propagate as uncaught exceptions.
    try {
      switch (msg.type) {
        case 'GOAWAY':
          return this.handleGoaway(msg);
        case 'MAX_REQUEST_ID':
          return this.handleMaxRequestId(msg);
        case 'REQUESTS_BLOCKED':
          return this.handleRequestsBlocked(msg);
        case 'SUBSCRIBE_OK':
          return this.handleSubscribeOk(msg);
        case 'REQUEST_ERROR':
          return this.handleRequestError(msg);
        case 'FETCH_OK':
          return this.handleFetchOk(msg);
        case 'REQUEST_OK':
          return this.handleRequestOk(msg);
        case 'PUBLISH_DONE':
          return this.handlePublishDone(msg);
        case 'UNSUBSCRIBE':
          return this.handleUnsubscribe(msg);
        case 'SUBSCRIBE':
          return this.handleIncomingSubscribe(msg);
        case 'PUBLISH':
          return this.handleIncomingPublish(msg as Publish);
        case 'FETCH':
          return this.handleIncomingFetch(msg);
        case 'FETCH_CANCEL':
          return this.handleFetchCancel(msg);
        case 'REQUEST_UPDATE':
          return this.handleIncomingRequestUpdate(msg);
        case 'TRACK_STATUS':
          return this.handleIncomingTrackStatus(msg as TrackStatus);
        case 'PUBLISH_NAMESPACE':
          return this.handleIncomingPublishNamespace(msg as PublishNamespace);
        case 'SUBSCRIBE_NAMESPACE':
          // draft-18 only: inbound SUBSCRIBE_NAMESPACE is a publisher-side
          // continuing request stream (§10.18). For draft-14/16 it is not handled
          // as an inbound message — fall through to the unsupported-type path.
          if (this._draftVersion === 18) {
            return this.handleIncomingSubscribeNamespace(msg as SubscribeNamespace);
          }
          return this.handleUnsupportedControlMessage(msg);
        case 'SUBSCRIBE_TRACKS':
          // draft-18 only: inbound SUBSCRIBE_TRACKS is a publisher-side continuing
          // request stream (§10.19). It has no draft-14/16 inbound form.
          if (this._draftVersion === 18) {
            return this.handleIncomingSubscribeTracks(msg as SubscribeTracks);
          }
          return this.handleUnsupportedControlMessage(msg);
        case 'PUBLISH_NAMESPACE_DONE':
          return this.handlePublishNamespaceDone(msg as PublishNamespaceDone);
        case 'PUBLISH_NAMESPACE_CANCEL':
          return this.handlePublishNamespaceCancel(msg as PublishNamespaceCancel);
        case 'PUBLISH_NAMESPACE_OK':
          return this.handlePublishNamespaceOk(msg as PublishNamespaceOk);
        case 'PUBLISH_NAMESPACE_ERROR':
          return this.handlePublishNamespaceError(msg as PublishNamespaceError);
        case 'UNSUBSCRIBE_NAMESPACE':
          return this.handleIncomingUnsubscribeNamespace(msg as UnsubscribeNamespace);
        default:
          return this.handleUnsupportedControlMessage(msg);
      }
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * Default handling for a control message type this session does not process.
   * Draft-14: PROTOCOL_VIOLATION (no generic REQUEST_ERROR on the wire). Draft-16+:
   * respond NOT_SUPPORTED (§3.1) when the message carries a Request ID, else ignore.
   */
  private handleUnsupportedControlMessage(msg: ControlMessage): SessionOutboundAction[] {
    if (this._draftVersion === 14) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `Unsupported message type ${msg.type}`,
      );
    }
    // §3.1: "Limited endpoints SHOULD respond to any unsupported messages with the
    // appropriate NOT_SUPPORTED error code, rather than ignoring them."
    if ('requestId' in msg && typeof (msg as { requestId: unknown }).requestId === 'bigint') {
      const reqId = (msg as { requestId: bigint }).requestId;
      return [this.sendControl({
        type: 'REQUEST_ERROR',
        requestId: reqId,
        errorCode: RequestErrorCode.NOT_SUPPORTED,
        retryInterval: varint(0n),
        errorReason: `Message type ${msg.type} is not supported`,
      })];
    }
    return [];
  }

  /**
   * Overlay stream-derived correlation onto a decoded control message.
   *
   * Draft-14/16 carry every Request ID on the wire, so the relevant field is
   * already present and this returns the message unchanged. Draft-18 omits the
   * Request ID from responses (correlated by request stream) and omits the
   * "Existing Request ID" from REQUEST_UPDATE (the stream identifies the
   * target); in those cases the topology layer recovers the value from stream
   * context and supplies it here — never a placeholder.
   */
  private applyRequestEndpoint(msg: DecodedControlMessage, endpoint?: RequestEndpoint): ControlMessage {
    // No stream-derived context (draft-14/16): the wire already carried every
    // Request ID, so the decoded message is already a full ControlMessage.
    if (endpoint === undefined) {
      return msg as ControlMessage;
    }
    // REQUEST_UPDATE: the wire Request ID is the update's own (new) ID; the
    // removed "Existing Request ID" target comes from stream context.
    if (msg.type === 'REQUEST_UPDATE') {
      const m = msg as RequestUpdate;
      if (endpoint.existingRequestId !== undefined && m.existingRequestId === undefined) {
        // Assign the raw bigint — endpoint IDs are stream-derived and may span
        // the full draft-18 uint64 range; re-branding through varint() would
        // throw for values above the QUIC range, defeating the widening.
        return { ...m, existingRequestId: endpoint.existingRequestId } as ControlMessage;
      }
      return msg as ControlMessage;
    }
    // Responses whose Request ID is absent on the wire (draft-18) correlate via
    // the endpoint. When the wire already carried a Request ID (draft-14/16),
    // it is left untouched.
    const withId = msg as { requestId?: bigint };
    if (withId.requestId === undefined) {
      // Raw bigint — see note above; the endpoint seam carries full uint64.
      return { ...msg, requestId: endpoint.requestId } as ControlMessage;
    }
    return msg as ControlMessage;
  }

  private handleSetupMessage(msg: ControlMessage): SessionOutboundAction[] {
    try {
      this.setupGate.validateMessage(msg);

      if (msg.type === 'CLIENT_SETUP') {
        const result = this.setupGate.handleClientSetup(msg as ClientSetup);
        this._peerMaxRequestId = result.peerMaxRequestId;
        // Only update allocator if MAX_REQUEST_ID was actually provided (> 0)
        if (result.peerMaxRequestId > 0n) {
          this.requestIdAllocator.updatePeerMaxRequestId(result.peerMaxRequestId);
        }
        // §9.3.1.4: Store peer's cache size for our outbound alias registration
        if (result.peerMaxAuthTokenCacheSize !== undefined) {
          this._peerMaxAuthTokenCacheSize = result.peerMaxAuthTokenCacheSize;
        }
        // Initialize auth cache with OUR limit (server processes client tokens)
        this.initAuthCache();
        // Process client's auth tokens through our cache
        if (result.authTokens) {
          this.processSetupAuthTokens(result.authTokens, true);
        }
        this._state = SessionState.SETUP_PENDING;
      } else if (msg.type === 'SERVER_SETUP') {
        const result = this.setupGate.handleServerSetup(msg as ServerSetup);
        this._peerMaxRequestId = result.peerMaxRequestId;
        // Only update allocator if MAX_REQUEST_ID was actually provided (> 0)
        if (result.peerMaxRequestId > 0n) {
          this.requestIdAllocator.updatePeerMaxRequestId(result.peerMaxRequestId);
        }
        // §9.3.1.4: Store peer's cache size for our outbound alias registration
        if (result.peerMaxAuthTokenCacheSize !== undefined) {
          this._peerMaxAuthTokenCacheSize = result.peerMaxAuthTokenCacheSize;
        }
        // Initialize auth cache with OUR limit (client processes server tokens)
        this.initAuthCache();
        // Process server's auth tokens through our cache
        if (result.authTokens) {
          this.processSetupAuthTokens(result.authTokens, false);
        }
        this._state = SessionState.ESTABLISHED;
      } else if (msg.type === 'SETUP') {
        // draft-18 unified SETUP (role-neutral wire; this side interprets it).
        const result = this.setupGate.handleSetup18(msg as Setup);
        this._peerMaxRequestId = result.peerMaxRequestId; // 0 — draft-18 has no credit
        // No MAX_REQUEST_ID in draft-18: do NOT update the request-id allocator credit.
        if (result.peerMaxAuthTokenCacheSize !== undefined) {
          this._peerMaxAuthTokenCacheSize = result.peerMaxAuthTokenCacheSize;
        }
        this.initAuthCache();
        if (result.authTokens) {
          // §10.3.1.4: ANY endpoint receiving a SETUP REGISTER that exceeds its
          // MAX_AUTH_TOKEN_CACHE_SIZE MUST treat it as USE_VALUE (downgrade) rather
          // than failing with AUTH_TOKEN_CACHE_OVERFLOW — both client and server,
          // not only the server processing a CLIENT_SETUP.
          this.processSetupAuthTokens(result.authTokens, true);
        }
        this._state = this.setupGate.sessionState;
      }

      return [];
    } catch (e) {
      // Convert setup/request-id errors to close_connection actions
      if (e instanceof SetupError) {
        // Map SetupError codes to session error codes
        const errorCode = this.mapSetupErrorCode(e.code);
        return this.closeWithError(errorCode, e.message);
      }
      if (e instanceof RequestIdError) {
        // Map RequestIdError codes to session error codes
        const errorCode = e.code === 'PROTOCOL_VIOLATION'
          ? SessionErrorCode.PROTOCOL_VIOLATION
          : SessionErrorCode.INVALID_REQUEST_ID;
        return this.closeWithError(errorCode, e.message);
      }
      if (e instanceof AuthCacheError) {
        return this.closeWithError(e.sessionErrorCode, e.message);
      }
      // Re-throw unexpected errors
      throw e;
    }
  }

  /**
   * Map SetupError codes to session error codes.
   */
  private mapSetupErrorCode(code: SetupError['code']): Varint {
    switch (code) {
      case 'INVALID_PATH':
        return SessionErrorCode.INVALID_PATH;
      case 'MALFORMED_PATH':
        return SessionErrorCode.MALFORMED_PATH;
      case 'INVALID_AUTHORITY':
        return SessionErrorCode.INVALID_AUTHORITY;
      case 'MALFORMED_AUTHORITY':
        return SessionErrorCode.MALFORMED_AUTHORITY;
      case 'KEY_VALUE_FORMATTING_ERROR':
        return SessionErrorCode.KEY_VALUE_FORMATTING_ERROR;
      case 'VERSION_NEGOTIATION_FAILED':
        return SessionErrorCode.VERSION_NEGOTIATION_FAILED;
      case 'PROTOCOL_VIOLATION':
      default:
        return SessionErrorCode.PROTOCOL_VIOLATION;
    }
  }

  // ─── Auth Token Processing ─────────────────────────────────────────────

  /**
   * Initialize the auth token cache with our own MAX_AUTH_TOKEN_CACHE_SIZE.
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  private initAuthCache(): void {
    this.authCache = new AuthTokenCache(this._ownMaxAuthTokenCacheSize);
  }

  /**
   * Process AUTHORIZATION_TOKEN parameters from a setup message through the cache.
   *
   * @param tokens Parsed tokens from the setup message
   * @param isClientSetup Whether these tokens came from CLIENT_SETUP
   * @throws {AuthCacheError} for cache overflow (non-setup), duplicate aliases, unknown aliases
   * @see draft-ietf-moq-transport-16 §9.2.2.1, §9.3.1.5
   */
  private processSetupAuthTokens(tokens: AuthorizationToken[], isClientSetup: boolean): void {
    if (!this.authCache) return;

    for (const token of tokens) {
      this.processOneToken(token, isClientSetup);
    }
  }

  /**
   * Process a single auth token through the cache.
   * Returns the resolved (tokenType, tokenValue) if applicable.
   *
   * @param token Parsed token structure
   * @param isClientSetup Whether this is during CLIENT_SETUP processing
   * @returns Resolved token, or undefined for DELETE
   * @throws {AuthCacheError} for cache errors
   * @see draft-ietf-moq-transport-16 §9.2.2.1
   */
  private processOneToken(token: AuthorizationToken, isClientSetup: boolean): ResolvedToken | undefined {
    if (!this.authCache) return undefined;

    switch (token.aliasType) {
      case AliasType.DELETE as bigint: {
        const t = token as import('../control/auth-token.js').DeleteToken;
        this.authCache.delete(t.tokenAlias);
        return undefined;
      }
      case AliasType.REGISTER as bigint: {
        const t = token as import('../control/auth-token.js').RegisterToken;
        const result = this.authCache.register(t.tokenAlias, t.tokenType, t.tokenValue, isClientSetup);
        if (result === null) {
          // §9.3.1.5: CLIENT_SETUP REGISTER that exceeds cache → treat as USE_VALUE
          return { tokenType: t.tokenType, tokenValue: t.tokenValue };
        }
        return result;
      }
      case AliasType.USE_ALIAS as bigint: {
        const t = token as import('../control/auth-token.js').UseAliasToken;
        return this.authCache.resolve(t.tokenAlias);
      }
      case AliasType.USE_VALUE as bigint: {
        const t = token as import('../control/auth-token.js').UseValueToken;
        return { tokenType: t.tokenType, tokenValue: t.tokenValue };
      }
      default:
        return undefined;
    }
  }

  /**
   * Process AUTHORIZATION_TOKEN message parameters for a non-setup control message.
   *
   * Parses raw token bytes, resolves through cache, validates per-message uniqueness.
   *
   * §9.2.2.1: "The AUTHORIZATION TOKEN parameter MAY be repeated within a message
   * as long as the combination of Token Type and Token Value are unique after
   * resolving any aliases."
   *
   * @returns Error info if validation fails, undefined if OK
   * @see draft-ietf-moq-transport-16 §9.2.2.1
   */
  private processMessageAuthTokens(
    values: ParameterValue[],
  ): { error: Varint; reason: string } | undefined {
    if (!this.authCache) return undefined;

    const resolved: ResolvedToken[] = [];

    // draft-18 Token internals (Alias Type / Token Alias / Token Type) are vi64
    // (full uint64); draft-14/16 use QUIC varint. Pick the wire parser by version.
    const parseToken = this._draftVersion === 18 ? parseAuthorizationToken18 : parseAuthorizationToken;

    for (const rawValue of values) {
      if (!(rawValue instanceof Uint8Array)) continue;

      // Parse token structure
      let token: AuthorizationToken;
      try {
        token = parseToken(rawValue);
      } catch {
        // §9.2.2.1: malformed → KEY_VALUE_FORMATTING_ERROR
        return {
          error: SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
          reason: 'Malformed AUTHORIZATION_TOKEN structure',
        };
      }

      // Process through cache
      try {
        const result = this.processOneToken(token, false);
        if (result) {
          resolved.push(result);
        }
      } catch (e) {
        if (e instanceof AuthCacheError) {
          return { error: e.sessionErrorCode, reason: e.message };
        }
        throw e;
      }
    }

    // §9.2.2.1: validate uniqueness of (tokenType, tokenValue) after resolution
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i]!;
        const b = resolved[j]!;
        if (a.tokenType === b.tokenType && this.bytesEqual(a.tokenValue, b.tokenValue)) {
          return {
            error: SessionErrorCode.MALFORMED_AUTH_TOKEN,
            reason: 'Duplicate Token Type + Token Value in AUTHORIZATION_TOKEN parameters',
          };
        }
      }
    }

    return undefined;
  }

  private bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Handle a GOAWAY received on the CONTROL stream (§9.4 / §10.4). This does NOT
   * close, migrate, or start timers — it transitions to DRAINING so local new
   * requests are refused, and stores the New Session URI for the application.
   * A GOAWAY arriving on a request stream is handled separately by the topology.
   */
  private handleGoaway(msg: Goaway): SessionOutboundAction[] {
    // §9.4 / §10.4: at most one GOAWAY on the control stream.
    if (this._goawayReceived) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'Received multiple GOAWAY messages on the control stream',
      );
    }

    // §9.4 / §10.4: a server MUST close if it receives a non-empty New Session URI
    // (clients cannot instruct servers to initiate connections).
    if (this._role === EndpointRole.SERVER && msg.newSessionUri.length > 0) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'Server received GOAWAY with non-empty New Session URI',
      );
    }

    // draft-18 §10.4: a control-stream GOAWAY MUST carry the Request ID, and its
    // parity MUST match the receiver's own request-id parity (the GOAWAY refers
    // to the smallest of OUR requests the peer may not have processed).
    if (this._draftVersion === 18) {
      if (msg.requestId === undefined) {
        return this.closeWithError(
          SessionErrorCode.PROTOCOL_VIOLATION,
          'draft-18 control-stream GOAWAY is missing the Request ID',
        );
      }
      if ((msg.requestId & 1n) !== this.requestIdAllocator.parityBit) {
        return this.closeWithError(
          SessionErrorCode.INVALID_REQUEST_ID,
          `GOAWAY Request ID ${msg.requestId} has the wrong parity for this endpoint`,
        );
      }
    }

    this._goawayReceived = true;
    this._newSessionUri = msg.newSessionUri;
    this._state = SessionState.DRAINING;
    return [];
  }

  private handleMaxRequestId(msg: MaxRequestId): SessionOutboundAction[] {
    // §9.5: MAX_REQUEST_ID updates the peer's limit
    try {
      this.requestIdAllocator.updatePeerMaxRequestId(msg.maxRequestId);
      this._peerMaxRequestId = msg.maxRequestId;
      return [];
    } catch (e) {
      if (e instanceof RequestIdError) {
        // Non-increasing MAX_REQUEST_ID is a protocol violation
        return this.closeWithError(
          SessionErrorCode.PROTOCOL_VIOLATION,
          e.message,
        );
      }
      throw e;
    }
  }

  private handleRequestsBlocked(_msg: RequestsBlocked): SessionOutboundAction[] {
    // §9.6: Peer is blocked waiting to allocate request IDs.
    // Immediately replenish if we can — don't wait for the periodic check.
    // §9.5: "An endpoint MAY send a MAX_REQUEST_ID upon receipt of REQUESTS_BLOCKED"
    return this.maybeReplenishMaxRequestId(true);
  }

  /**
   * Check if the peer is approaching our MAX_REQUEST_ID limit and send
   * a new MAX_REQUEST_ID to extend their window.
   *
   * Called after every incoming request validation and on REQUESTS_BLOCKED.
   * Uses a sliding window: when the peer consumes past 50% of the current
   * window, we extend by windowSize.
   *
   * @param force If true, always replenish (used for REQUESTS_BLOCKED response)
   * @see draft-ietf-moq-transport-16 §9.5 (similar to MAX_STREAMS in RFC 9000 §4.6)
   */
  /**
   * Validate an incoming request ID and check if MAX_REQUEST_ID
   * replenishment is needed.
   *
   * Returns `{ error: actions }` on validation failure (caller should return these).
   * Returns `{ replenish: actions }` when a MAX_REQUEST_ID should be sent
   * (caller should append these to its own output).
   * Returns `{}` when validation passes with no replenishment needed.
   */
  private validateAndReplenish(requestId: bigint): {
    error?: SessionOutboundAction[];
    replenish?: SessionOutboundAction[];
  } {
    try {
      this.requestIdAllocator.validateIncoming(requestId);
    } catch (e) {
      if (e instanceof RequestIdError) {
        const errorCode = e.code === 'TOO_MANY_REQUESTS'
          ? SessionErrorCode.TOO_MANY_REQUESTS
          : SessionErrorCode.INVALID_REQUEST_ID;
        return { error: this.closeWithError(errorCode, e.message) };
      }
      throw e;
    }
    // Validation passed — check if we need to extend the peer's window
    const replenish = this.maybeReplenishMaxRequestId();
    return replenish.length > 0 ? { replenish } : {};
  }

  private maybeReplenishMaxRequestId(force = false): SessionOutboundAction[] {
    if (!force && !this.requestIdAllocator.shouldReplenish()) return [];
    if (this.requestIdAllocator.getOurMaxRequestId() === 0n) return [];

    const newMax = this.requestIdAllocator.nextReplenishValue();
    this.requestIdAllocator.commitReplenish();

    return [{
      type: 'send_control',
      message: {
        type: 'MAX_REQUEST_ID',
        maxRequestId: newMax,
      },
    }];
  }

  private handleSubscribeOk(msg: SubscribeOk): SessionOutboundAction[] {
    const sub = this.subscriptions.get(msg.requestId as bigint);
    if (!sub) {
      // §9.1: Unknown request ID must close with INVALID_REQUEST_ID
      return this.closeWithError(
        SessionErrorCode.INVALID_REQUEST_ID,
        `Unknown request ID ${msg.requestId} for SUBSCRIBE_OK`,
      );
    }

    sub.handleSubscribeOk(msg.trackAlias);

    // Register track alias - §9.10/§10.1: duplicate alias must close connection
    const trackInfo = this.subscriptionTracks.get(msg.requestId as bigint);
    if (trackInfo) {
      try {
        this.trackAliases.register(msg.trackAlias, trackInfo.namespace, trackInfo.name);
      } catch {
        return this.closeWithError(
          SessionErrorCode.DUPLICATE_TRACK_ALIAS,
          `Duplicate track alias ${msg.trackAlias}`,
        );
      }
    }

    return [];
  }

  private handleRequestError(msg: RequestErrorMsg): SessionOutboundAction[] {
    // draft-18 §10.6.2: a Redirect is only valid for certain request CONTEXTS,
    // which only the session knows (the codec parsed it blind). Validate before
    // the normal per-request dispatch terminates the request as usual.
    if (msg.redirect) {
      const invalid = this.validateRedirectContext(msg);
      if (invalid) return invalid;
    }

    // Could be for pending REQUEST_UPDATE
    const pending = this.pendingUpdates.get(msg.requestId as bigint);
    if (pending) {
      this.pendingUpdates.delete(msg.requestId as bigint);
      // Don't apply the update — it was rejected
      return [];
    }

    // §9.19: Could be for TRACK_STATUS — no subscription state to update
    const trackStatus = this.pendingTrackStatuses.get(msg.requestId as bigint);
    if (trackStatus) {
      this.pendingTrackStatuses.delete(msg.requestId as bigint);
      return [];
    }

    // Could be for subscription or fetch
    const sub = this.subscriptions.get(msg.requestId as bigint);
    if (sub) {
      sub.handleRequestError(msg.errorCode, msg.errorReason);
      return [];
    }

    const fetch = this.fetches.get(msg.requestId as bigint);
    if (fetch) {
      fetch.handleRequestError(msg.errorCode, msg.errorReason);
      return [];
    }

    // Draft-14: SUBSCRIBE_NAMESPACE_ERROR arrives as normalized REQUEST_ERROR
    const nsSubErr = this.namespaceSubscriptions.get(msg.requestId as bigint);
    if (nsSubErr) {
      nsSubErr.handleRequestError(msg.errorCode, msg.errorReason);
      return [];
    }

    // draft-18 §10.19: SUBSCRIBE_TRACKS rejected (REQUEST_ERROR on its stream).
    const trackSubErr = this.trackSubscriptions.get(msg.requestId as bigint);
    if (trackSubErr) {
      trackSubErr.state = 'terminated';
      this.trackSubscriptions.delete(msg.requestId as bigint);
      return [];
    }

    // PUBLISH_NAMESPACE rejection (§9.20)
    const pubNsErr = this.publishedNamespaces.get(msg.requestId as bigint);
    if (pubNsErr && pubNsErr.state === 'pending') {
      this.publishedNamespaces.delete(msg.requestId as bigint);
      return [];
    }

    // draft-18 §10.10: our outbound PUBLISH rejected — terminate only that publish.
    const outPubErr = this.outgoingPublishes.get(msg.requestId as bigint);
    if (outPubErr) {
      this.outgoingPublishes.delete(msg.requestId as bigint);
      return [];
    }

    // §9.1: Unknown request ID must close with INVALID_REQUEST_ID
    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for REQUEST_ERROR`,
    );
  }

  /**
   * Validate a Redirect against the request CONTEXT it answers (§10.6.2). Returns
   * a session-close action if invalid, or `null` if the Redirect is acceptable
   * (the normal handleRequestError dispatch then terminates the request).
   *
   *   - REDIRECT is valid only for SUBSCRIBE / FETCH / TRACK_STATUS /
   *     PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE responses; on any other request
   *     type (REQUEST_UPDATE / SUBSCRIBE_TRACKS / PUBLISH / …) it is a violation.
   *   - A server endpoint MUST NOT receive a non-empty Connect URI.
   *   - A namespace-scoped request (PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE) MUST
   *     NOT carry a replacement Track Name.
   */
  private validateRedirectContext(msg: RequestErrorMsg): SessionOutboundAction[] | null {
    const rid = msg.requestId as bigint;
    const redirect = msg.redirect!;

    // §10.6.2: a server never receives a relocation to another session.
    if (this._role === EndpointRole.SERVER && redirect.connectUri.length > 0) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'REQUEST_ERROR Redirect with a non-empty Connect URI received by a server endpoint (§10.6.2)',
      );
    }

    // Request types for which REDIRECT is explicitly NOT allowed.
    if (this.pendingUpdates.has(rid) || this.trackSubscriptions.has(rid) || this.outgoingPublishes.has(rid)) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `REQUEST_ERROR Redirect is not valid for this request type (request ${rid})`,
      );
    }

    const isPubNs = this.publishedNamespaces.has(rid);
    const isSubNs = this.namespaceSubscriptions.has(rid);
    const allowed = this.subscriptions.has(rid) || this.fetches.has(rid)
      || this.pendingTrackStatuses.has(rid) || isPubNs || isSubNs;
    if (!allowed) {
      // Unknown request ID — let the normal dispatch close with INVALID_REQUEST_ID.
      return null;
    }

    // §10.6.2: a namespace-scoped request must not carry a replacement Track Name.
    if ((isPubNs || isSubNs) && redirect.trackName.length > 0) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'REQUEST_ERROR Redirect for a namespace-scoped request must have an empty Track Name (§10.6.2)',
      );
    }

    return null; // valid — terminate the request as usual
  }

  private handleFetchOk(msg: FetchOk): SessionOutboundAction[] {
    const fetch = this.fetches.get(msg.requestId as bigint);
    if (!fetch) {
      // §9.1: Unknown request ID must close with INVALID_REQUEST_ID
      return this.closeWithError(
        SessionErrorCode.INVALID_REQUEST_ID,
        `Unknown request ID ${msg.requestId} for FETCH_OK`,
      );
    }

    // §9.17: "If End Location is smaller than the Start Location in the
    // corresponding FETCH the receiver MUST close the session with a
    // PROTOCOL_VIOLATION."
    if (msg.endLocation && fetch.startGroup !== undefined) {
      const endGroup = msg.endLocation.group;
      const endObject = msg.endLocation.object;
      const startGroup = fetch.startGroup;
      const startObject = fetch.startObject ?? 0n;

      if (
        endGroup < startGroup ||
        (endGroup === startGroup && endObject < startObject)
      ) {
        return this.closeWithError(
          SessionErrorCode.PROTOCOL_VIOLATION,
          `FETCH_OK endLocation (${endGroup},${endObject}) < startLocation (${startGroup},${startObject})`,
        );
      }
    }

    fetch.handleFetchOk();
    return [];
  }

  /**
   * Terminate a pending OUTGOING subscription or fetch as a malformed track
   * (§2.4.2) — e.g. a SUBSCRIBE_OK / FETCH_OK whose Track Properties carried a
   * data-Object-only Property (wrong scope, not a wire-format error). This is NOT
   * a session close: only the one request is reset (the I/O layer RESETs its
   * stream). No-op for an unknown request ID.
   *
   * @see draft-ietf-moq-transport-18 §2.4.2
   */
  handleMalformedTrack(requestId: bigint): SessionOutboundAction[] {
    const sub = this.subscriptions.get(requestId as bigint);
    if (sub) {
      if (!sub.isTerminated) sub.handleRequestError(RequestErrorCode.MALFORMED_TRACK, 'malformed track');
      return [];
    }
    const fetch = this.fetches.get(requestId as bigint);
    if (fetch && !fetch.isCompleted) {
      fetch.handleRequestError(RequestErrorCode.MALFORMED_TRACK, 'malformed track');
    }
    return [];
  }

  /**
   * draft-18: resolve which response a REQUEST_OK stands in for, by the outbound
   * request state it correlates to. Returns the effective response message type
   * used for parameter-scope validation (§10.2), or `undefined` if the Request ID
   * matches no pending request (the caller then closes with INVALID_REQUEST_ID).
   * Each Request ID lives in exactly one of these maps.
   */
  private d18RequestOkContext(requestId: bigint): string | undefined {
    if (this.pendingUpdates.has(requestId)) return 'REQUEST_UPDATE_OK';
    if (this.pendingTrackStatuses.has(requestId)) return 'TRACK_STATUS_OK';
    if (this.namespaceSubscriptions.has(requestId)) return 'SUBSCRIBE_NAMESPACE_OK';
    if (this.trackSubscriptions.has(requestId)) return 'SUBSCRIBE_TRACKS_OK';
    if (this.publishedNamespaces.has(requestId)) return 'PUBLISH_NAMESPACE_OK';
    if (this.outgoingPublishes.has(requestId)) return 'PUBLISH_OK';
    return undefined;
  }

  private handleRequestOk(msg: RequestOk): SessionOutboundAction[] {
    // draft-18 Track Properties are CONTEXT-dependent on a REQUEST_OK: valid only
    // when it answers a TRACK_STATUS (TRACK_STATUS_OK). For every other REQUEST_OK
    // context (REQUEST_UPDATE / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE /
    // SUBSCRIBE_TRACKS / PUBLISH responses) they MUST be empty — the codec decoded
    // them blind, so we enforce the request-stream context here.
    if (((msg.trackProperties ?? msg.trackExtensions)?.size ?? 0) > 0 && !this.pendingTrackStatuses.has(msg.requestId as bigint)) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `Track Properties are not valid on this REQUEST_OK (request ${msg.requestId})`,
      );
    }

    // draft-18 §10.2.1: validate the REQUEST_OK's Message Parameters against the
    // scope of the RESPONSE it stands in for, resolved from the request stream
    // (PUBLISH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK / namespace responses).
    if (this._draftVersion === 18 && (msg.parameters?.size ?? 0) > 0) {
      const context = this.d18RequestOkContext(msg.requestId as bigint);
      if (context) {
        const paramError = this.validateMessageParams(msg.parameters, context);
        if (paramError) return this.closeWithError(paramError.error, paramError.reason);
      }
      // context === undefined → unknown request id; the dispatch below closes with
      // INVALID_REQUEST_ID, so no parameter validation is needed here.
    }

    const pending = this.pendingUpdates.get(msg.requestId as bigint);
    if (pending) {
      this.pendingUpdates.delete(msg.requestId as bigint);

      // Apply the update to the subscription (outgoing or, for a draft-18
      // PUBLISH-initiated subscription, the incoming one).
      if (pending.forward !== undefined) {
        const sub = this.subscriptions.get(pending.existingRequestId)
          ?? this.incomingSubscriptions.get(pending.existingRequestId);
        if (sub) {
          sub.updateForwardState(pending.forward);
        }
      }

      // draft-18 §10.9.2: a prefix update is confirmed — replace the stored
      // Track Namespace Prefix on the outbound namespace/tracks subscription.
      if (pending.namespacePrefix && pending.prefixTarget) {
        if (pending.prefixTarget === 'namespace') {
          this.namespaceSubscriptions.get(pending.existingRequestId)?.updatePrefix(pending.namespacePrefix);
        } else {
          const ts = this.trackSubscriptions.get(pending.existingRequestId);
          if (ts) ts.trackNamespacePrefix = pending.namespacePrefix;
        }
      }

      return [];
    }

    // §9.19: TRACK_STATUS response — REQUEST_OK with track status params
    const trackStatus = this.pendingTrackStatuses.get(msg.requestId as bigint);
    if (trackStatus) {
      this.pendingTrackStatuses.delete(msg.requestId as bigint);
      return [];
    }

    // Draft-14: SUBSCRIBE_NAMESPACE_OK arrives as normalized REQUEST_OK
    const nsSubOk = this.namespaceSubscriptions.get(msg.requestId as bigint);
    if (nsSubOk) {
      nsSubOk.handleRequestOk();
      return [];
    }

    // draft-18 §10.19: SUBSCRIBE_TRACKS accepted (REQUEST_OK on its stream).
    const trackSubOk = this.trackSubscriptions.get(msg.requestId as bigint);
    if (trackSubOk) {
      trackSubOk.state = 'active';
      return [];
    }

    // PUBLISH_NAMESPACE response (§9.20)
    const pubNs = this.publishedNamespaces.get(msg.requestId as bigint);
    if (pubNs && pubNs.state === 'pending') {
      pubNs.state = 'active';
      return [];
    }

    // draft-18 §10.10: our outbound PUBLISH accepted (REQUEST_OK = PUBLISH_OK
    // shorthand). Establish the publisher-side subscription; keep the stream.
    const outPub = this.outgoingPublishes.get(msg.requestId as bigint);
    if (outPub && outPub.state === SubscriptionState.PENDING) {
      outPub.acceptOutboundPublish();
      return [];
    }

    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for REQUEST_OK`,
    );
  }

  private handlePublishDone(msg: PublishDone): SessionOutboundAction[] {
    // §9.19: "The publisher does not send PUBLISH_DONE for this request"
    if (this.pendingTrackStatuses.has(msg.requestId as bigint)) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `Received PUBLISH_DONE for TRACK_STATUS request ${msg.requestId}`,
      );
    }

    const sub = this.subscriptions.get(msg.requestId as bigint);
    if (!sub) {
      // §9.1: Unknown request ID must close with INVALID_REQUEST_ID
      return this.closeWithError(
        SessionErrorCode.INVALID_REQUEST_ID,
        `Unknown request ID ${msg.requestId} for PUBLISH_DONE`,
      );
    }

    sub.handlePublishDone(msg.statusCode, msg.errorReason);
    return [];
  }

  private handleUnsubscribe(msg: Unsubscribe): SessionOutboundAction[] {
    // Publisher-side: terminate the subscription
    const sub = this.incomingSubscriptions.get(msg.requestId as bigint);
    if (sub) {
      sub.handleUnsubscribe();
      return [];
    }

    // §9.1: Unknown request ID
    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for UNSUBSCRIBE`,
    );
  }

  /**
   * Draft-18 §2.4.1 defensive name validation for inbound full-track-name requests.
   * The codec validates on decode, but a message can be constructed directly and
   * passed to {@link handleControlMessage} (tests / programmatic APIs), so we re-check
   * BEFORE any state/alias/request map is mutated. Returns a PROTOCOL_VIOLATION close
   * action on violation, or `null` when valid (or not draft-18, which keeps legacy
   * behavior unchanged). An empty namespace is permitted (allowEmptyNamespace).
   */
  private validateFullName18(namespace: Uint8Array[], trackName: Uint8Array): SessionOutboundAction[] | null {
    if (this._draftVersion !== 18) return null;
    try {
      validateFullTrackName(namespace, trackName, { allowEmptyNamespace: true });
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : 'invalid Full Track Name (§2.4.1)',
      );
    }
    return null;
  }

  /** Draft-18 §2.4.1 defensive validation for a full Track Namespace (no track name,
   *  e.g. PUBLISH_NAMESPACE). Same contract as {@link validateFullName18}. */
  private validateNamespace18(namespace: Uint8Array[]): SessionOutboundAction[] | null {
    if (this._draftVersion !== 18) return null;
    try {
      validateTrackNamespace(namespace, { allowEmpty: true });
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : 'invalid Track Namespace (§2.4.1)',
      );
    }
    return null;
  }

  private handleIncomingSubscribe(msg: Subscribe): SessionOutboundAction[] {
    // §2.4.1: validate the Full Track Name BEFORE creating any state.
    const nameError = this.validateFullName18(msg.trackNamespace, msg.trackName);
    if (nameError) return nameError;

    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // §3.2: reserved `.`/`.session` namespace → REQUEST_ERROR DOES_NOT_EXIST.
    const reserved = this.rejectReservedNamespace(msg.trackNamespace, msg.requestId, validated.replenish);
    if (reserved) return reserved;

    // Create publisher-side subscription state machine
    const sub = SubscriptionStateMachine.createAsPublisher(
      msg.requestId,
      msg.trackNamespace,
      msg.trackName,
    );
    this.incomingSubscriptions.set(msg.requestId as bigint, sub);

    return validated.replenish ?? [];
  }

  /**
   * Handle incoming PUBLISH from a publisher (publisher-initiated subscription).
   * Draft-14 §9.13: The publisher sends PUBLISH to indicate it wants to
   * publish on a track. The subscriber creates state to track this and
   * the application responds via acceptSubscribe() or rejectSubscribe().
   * @see draft-ietf-moq-transport-14 §9.13
   */
  private handleIncomingPublish(msg: Publish): SessionOutboundAction[] {
    // §2.4.1: validate the Full Track Name BEFORE registering an alias or state.
    const nameError = this.validateFullName18(msg.trackNamespace, msg.trackName);
    if (nameError) return nameError;

    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // Draft-14 §9.13: "The same Track Alias MUST NOT be used to refer to two
    // different Tracks simultaneously. If a subscriber receives a PUBLISH that
    // uses the same Track Alias as a different track with an active subscription,
    // it MUST close the session with error DUPLICATE_TRACK_ALIAS."
    try {
      this.trackAliases.register(msg.trackAlias, msg.trackNamespace, msg.trackName);
    } catch {
      return this.closeWithError(
        SessionErrorCode.DUPLICATE_TRACK_ALIAS,
        `Duplicate track alias ${msg.trackAlias} in PUBLISH`,
      );
    }

    // Create subscription state machine flagged as PUBLISH-initiated.
    // The application response may reuse selected inbound state (for example
    // draft-14 GROUP_ORDER/FORWARD) when constructing PUBLISH_OK.
    const sub = SubscriptionStateMachine.createFromPublish(
      msg.requestId,
      msg.trackNamespace,
      msg.trackName,
      msg.parameters,
    );
    this.incomingSubscriptions.set(msg.requestId as bigint, sub);

    return validated.replenish ?? [];
  }

  private handleIncomingFetch(msg: Fetch): SessionOutboundAction[] {
    // §2.4.1: a standalone FETCH carries a Full Track Name — validate it BEFORE any
    // state. (A joining FETCH references an existing request and carries no name.)
    if (msg.fetch.fetchType === 0x1) {
      const sf = msg.fetch as StandaloneFetch;
      const nameError = this.validateFullName18(sf.trackNamespace, sf.trackName);
      if (nameError) return nameError;
    }

    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // Extract range from standalone fetch
    let startGroup: bigint | undefined;
    let startObject: bigint | undefined;
    let endGroup: bigint | undefined;
    let endObject: bigint | undefined;
    if (msg.fetch.fetchType === 0x1) {
      const sf = msg.fetch as StandaloneFetch;
      // §3.2: reserved `.`/`.session` namespace → REQUEST_ERROR DOES_NOT_EXIST.
      // (Joining FETCH references an existing request and carries no namespace.)
      const reserved = this.rejectReservedNamespace(sf.trackNamespace, msg.requestId, validated.replenish);
      if (reserved) return reserved;
      startGroup = sf.startLocation.group;
      startObject = sf.startLocation.object;
      endGroup = sf.endLocation.group;
      endObject = sf.endLocation.object;
    }

    // Create publisher-side fetch state machine
    const fetchSm = FetchStateMachine.createAsPublisher(
      msg.requestId,
      startGroup,
      startObject,
      endGroup,
      endObject,
    );
    this.incomingFetches.set(msg.requestId as bigint, fetchSm);

    return validated.replenish ?? [];
  }

  private handleFetchCancel(msg: FetchCancel): SessionOutboundAction[] {
    const fetch = this.incomingFetches.get(msg.requestId as bigint);
    if (fetch) {
      fetch.handleFetchCancel();
      return [];
    }

    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for FETCH_CANCEL`,
    );
  }

  /**
   * Handle incoming REQUEST_UPDATE from subscriber (publisher-side).
   * §9.11: "The receiver MUST close the session with PROTOCOL_VIOLATION
   * if the sender specifies an invalid Existing Request ID."
   * §9.11: "The receiver of a REQUEST_UPDATE MUST respond with exactly one
   * REQUEST_OK or REQUEST_ERROR."
   */
  private handleIncomingRequestUpdate(msg: RequestUpdate): SessionOutboundAction[] {
    // Validate the new request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // draft-18 §10.9.2: a peer prefix update on an inbound SUBSCRIBE_NAMESPACE /
    // SUBSCRIBE_TRACKS we serve (separate maps — handle before the generic lookup,
    // which would otherwise treat the Existing Request ID as unknown and close).
    if (this.incomingNamespaceSubscriptions.has(msg.existingRequestId as bigint)
      || this.incomingTrackSubscriptions.has(msg.existingRequestId as bigint)) {
      return this.handleIncomingPrefixUpdate(msg, validated.replenish);
    }

    // draft-18 §10.2.14: TRACK_NAMESPACE_PREFIX is in scope for REQUEST_UPDATE
    // ONLY when it targets a SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS (handled
    // above). On a REQUEST_UPDATE for a normal subscription/fetch/publish it is
    // out of scope → PROTOCOL_VIOLATION.
    if (this._draftVersion === 18 && msg.parameters.has(MessageParam.TRACK_NAMESPACE_PREFIX as bigint)) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `TRACK_NAMESPACE_PREFIX is out of scope for a REQUEST_UPDATE that does not target a SUBSCRIBE_NAMESPACE/SUBSCRIBE_TRACKS (§10.2.14)`,
      );
    }

    // §9.11: Look up Existing Request ID — must match an active subscription we
    // serve, an OUTBOUND PUBLISH we initiated (draft-18 §10.9, a peer update on
    // our PUBLISH stream), a fetch, or an inbound PUBLISH_NAMESPACE we accepted.
    // An outbound PUBLISH is a publisher-side subscription, so it follows the
    // same established-state / FORWARD / REQUEST_OK path as an inbound one.
    const sub = this.incomingSubscriptions.get(msg.existingRequestId as bigint)
      ?? this.outgoingPublishes.get(msg.existingRequestId as bigint);
    const fetch = this.incomingFetches.get(msg.existingRequestId as bigint);
    const pubNs = this.incomingPublishNamespaces.get(msg.existingRequestId as bigint);

    if (!sub && !fetch && !pubNs) {
      // §9.11: "MUST close the session with PROTOCOL_VIOLATION if the sender
      // specifies an invalid Existing Request ID"
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `REQUEST_UPDATE references unknown Existing Request ID ${msg.existingRequestId}`,
      );
    }

    // draft-18 §10.9: a PUBLISH_NAMESPACE may be updated on its request stream.
    // We have no per-namespace mutable state to apply yet — acknowledge with
    // REQUEST_OK (or, for v14, no response). Params are accepted as-is.
    if (pubNs && !sub && !fetch) {
      if (this._draftVersion === 14) return validated.replenish ?? [];
      const requestOk: RequestOk = { type: 'REQUEST_OK', requestId: msg.requestId, parameters: new Map() };
      return [this.sendControl(requestOk), ...(validated.replenish ?? [])];
    }

    // Must be ESTABLISHED to accept updates
    if (sub && sub.state !== 'established') {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `REQUEST_UPDATE for subscription ${msg.existingRequestId} in state ${sub.state}; expected established`,
      );
    }
    if (fetch && fetch.state !== 'transferring') {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `REQUEST_UPDATE for fetch ${msg.existingRequestId} in state ${fetch.state}; expected transferring`,
      );
    }

    // §9.11: "The receiver MUST close the session with PROTOCOL_VIOLATION
    // if the parameters included in the REQUEST_UPDATE are invalid for the
    // type of request being modified."
    // Parameters valid only for subscription REQUEST_UPDATEs (not fetches):
    // - FORWARD (§9.2.2.8), SUBSCRIPTION_FILTER (§9.2.2.5), NEW_GROUP_REQUEST (§9.2.2.9)
    if (fetch) {
      const subscriptionOnlyParams = [
        MessageParam.FORWARD,
        MessageParam.SUBSCRIPTION_FILTER,
        MessageParam.NEW_GROUP_REQUEST,
      ];
      for (const param of subscriptionOnlyParams) {
        if (msg.parameters.has(param)) {
          return this.closeWithError(
            SessionErrorCode.PROTOCOL_VIOLATION,
            `Parameter 0x${(param as bigint).toString(16)} is not valid for REQUEST_UPDATE on a fetch (§9.11)`,
          );
        }
      }
    }

    // §9.11: "If a parameter previously set on the request is not present
    // in REQUEST_UPDATE, its value remains unchanged."
    // Apply FORWARD parameter if present
    const forwardValues = msg.parameters.get(MessageParam.FORWARD);
    if (forwardValues && forwardValues.length > 0 && sub) {
      const forwardVal = forwardValues[0];
      if (typeof forwardVal === 'bigint') {
        sub.updateForwardState(forwardVal === 0n ? ForwardState.PAUSED : ForwardState.ACTIVE);
      }
    }

    // Draft-14 §9.10: "There is no control message in response to a
    // SUBSCRIBE_UPDATE, because it is expected that it will always succeed."
    if (this._draftVersion === 14) {
      return validated.replenish ?? [];
    }

    // Draft-16 §9.11: Respond with REQUEST_OK
    const requestOk: RequestOk = {
      type: 'REQUEST_OK',
      requestId: msg.requestId,
      parameters: new Map(),
    };

    return [this.sendControl(requestOk), ...(validated.replenish ?? [])];
  }

  /**
   * draft-18 §10.9.2: a peer REQUEST_UPDATE changing the Track Namespace Prefix of
   * an inbound SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS we serve. Validates the
   * prefix, enforces the overlap rule independently per type, and either applies
   * the new prefix (REQUEST_OK) or rejects with PREFIX_OVERLAP. A malformed prefix
   * (>32 fields / >4096 bytes) closes the session with PROTOCOL_VIOLATION.
   */
  private handleIncomingPrefixUpdate(
    msg: RequestUpdate,
    replenish: SessionOutboundAction[] | undefined,
  ): SessionOutboundAction[] {
    const existingRid = msg.existingRequestId as bigint;
    const incNs = this.incomingNamespaceSubscriptions.get(existingRid);
    const incTracks = this.incomingTrackSubscriptions.get(existingRid);

    // §6.1 / §10.9.2: the original SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS must get
    // its single REQUEST_OK / REQUEST_ERROR as the FIRST response, and a prefix
    // update is only permitted for an ESTABLISHED request. A REQUEST_UPDATE before
    // we have accepted the request is a PROTOCOL_VIOLATION.
    const accepted = incNs ? incNs.isActive : incTracks?.state === 'active';
    if (!accepted) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `REQUEST_UPDATE for ${incNs ? 'SUBSCRIBE_NAMESPACE' : 'SUBSCRIBE_TRACKS'} ${existingRid} before it was accepted`,
      );
    }

    // §10.9: a parameter absent from REQUEST_UPDATE leaves its value unchanged.
    // No TRACK_NAMESPACE_PREFIX → nothing to change; acknowledge.
    const prefixVals = msg.parameters.get(MessageParam.TRACK_NAMESPACE_PREFIX as bigint);
    const newPrefix = prefixVals && prefixVals.length > 0 ? prefixVals[prefixVals.length - 1] : undefined;
    if (newPrefix === undefined) {
      const ok: RequestOk = { type: 'REQUEST_OK', requestId: msg.requestId, parameters: new Map() };
      return [this.sendControl(ok), ...(replenish ?? [])];
    }
    if (!Array.isArray(newPrefix)) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'TRACK_NAMESPACE_PREFIX value is not a Track Namespace tuple',
      );
    }
    try {
      validateTrackNamespacePrefix(newPrefix);
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : 'Malformed Track Namespace Prefix in REQUEST_UPDATE',
      );
    }

    // Overlap is checked against OTHER subscriptions of the SAME type only
    // (§10.18/§10.19 independent overlap spaces), excluding this request itself.
    if (incNs) {
      for (const [rid, existing] of this.incomingNamespaceSubscriptions) {
        if (rid === existingRid || existing.isTerminated) continue;
        if (prefixesOverlap(existing.namespacePrefix, newPrefix)) {
          return this.prefixOverlapError(msg.requestId, 'SUBSCRIBE_NAMESPACE', existingRid, replenish);
        }
      }
      incNs.updatePrefix(newPrefix);
    } else if (incTracks) {
      for (const [rid, existing] of this.incomingTrackSubscriptions) {
        if (rid === existingRid) continue;
        if (prefixesOverlap(existing.trackNamespacePrefix, newPrefix)) {
          return this.prefixOverlapError(msg.requestId, 'SUBSCRIBE_TRACKS', existingRid, replenish);
        }
      }
      incTracks.trackNamespacePrefix = newPrefix;
    }

    const ok: RequestOk = { type: 'REQUEST_OK', requestId: msg.requestId, parameters: new Map() };
    return [this.sendControl(ok), ...(replenish ?? [])];
  }

  /**
   * Reject a prefix update with REQUEST_ERROR / PREFIX_OVERLAP (§10.6.2). For a
   * SUBSCRIBE_NAMESPACE, §10.9.1 requires the responder to close the bidi stream,
   * so the publisher-side state is terminated here (the I/O layer closes the
   * stream after writing the error). A SUBSCRIBE_TRACKS keeps its existing prefix.
   */
  private prefixOverlapError(
    requestId: bigint,
    kind: 'SUBSCRIBE_NAMESPACE' | 'SUBSCRIBE_TRACKS',
    existingRid: bigint,
    replenish: SessionOutboundAction[] | undefined,
  ): SessionOutboundAction[] {
    if (kind === 'SUBSCRIBE_NAMESPACE') {
      this.incomingNamespaceSubscriptions.delete(existingRid);
    }
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode: RequestErrorCode.PREFIX_OVERLAP,
      retryInterval: varint(0n),
      errorReason: `Track Namespace Prefix overlaps an existing ${kind}`,
      // draft-14 → SUBSCRIBE_NAMESPACE_ERROR. SUBSCRIBE_TRACKS is draft-18-only
      // (no draft-14 wire error), so it carries no requestKind. Ignored by 16/18.
      ...(kind === 'SUBSCRIBE_NAMESPACE' ? { requestKind: 'SUBSCRIBE_NAMESPACE' as const } : {}),
    };
    return [this.sendControl(err), ...(replenish ?? [])];
  }

  /**
   * Handle incoming TRACK_STATUS from a potential subscriber.
   *
   * §9.19: "The receiver of a TRACK_STATUS message treats it identically as if it
   * had received a SUBSCRIBE message, except it does not create downstream
   * subscription state or send any Objects."
   *
   * No SubscriptionStateMachine is created. The application responds via
   * acceptTrackStatus() or rejectTrackStatus().
   *
   * @see draft-ietf-moq-transport-16 §9.19
   */
  private handleIncomingTrackStatus(msg: TrackStatus): SessionOutboundAction[] {
    // §2.4.1: validate the Full Track Name BEFORE recording any state.
    const nameError = this.validateFullName18(msg.trackNamespace, msg.trackName);
    if (nameError) return nameError;

    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // §3.2: reserved `.`/`.session` namespace → REQUEST_ERROR DOES_NOT_EXIST.
    const reserved = this.rejectReservedNamespace(msg.trackNamespace, msg.requestId, validated.replenish);
    if (reserved) return reserved;

    // §9.19: Do NOT create subscription state
    this.incomingTrackStatuses.set(msg.requestId as bigint, {
      namespace: msg.trackNamespace,
      name: msg.trackName,
    });

    return validated.replenish ?? [];
  }

  // ─── Subscription Operations ──────────────────────────────────────────

  /**
   * Create a new subscription.
   */
  subscribe(
    namespace: Uint8Array[],
    name: Uint8Array,
    options: SubscribeOptions = {},
  ): RequestResult {
    this.assertEstablishedOrDraining('subscribe');

    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot create new subscriptions after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }

    const requestId = this.requestIdAllocator.allocate();

    const sub = SubscriptionStateMachine.createAsSubscriber(requestId, namespace, name);
    this.subscriptions.set(requestId as bigint, sub);
    this.subscriptionTracks.set(requestId as bigint, { namespace, name });

    // §9.2.2: Build subscription parameters from options
    const parameters: Parameters = new Map();
    if (options.deliveryTimeout !== undefined) {
      parameters.set(MessageParam.DELIVERY_TIMEOUT, [options.deliveryTimeout]);
    }
    if (options.subscriberPriority !== undefined) {
      parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [options.subscriberPriority]);
      // Store for draft-14 SUBSCRIBE_UPDATE replay
      sub.currentPriority = options.subscriberPriority;
    }
    if (options.groupOrder !== undefined) {
      parameters.set(MessageParam.GROUP_ORDER, [options.groupOrder]);
    }
    if (options.subscriptionFilter !== undefined) {
      const filterBytes = encodeSubscriptionFilter(options.subscriptionFilter, this._draftVersion);
      parameters.set(MessageParam.SUBSCRIPTION_FILTER, [filterBytes]);
      // Store for draft-14 SUBSCRIBE_UPDATE replay
      sub.currentFilter = filterBytes;
    }

    const subscribeMsg: Subscribe = {
      type: 'SUBSCRIBE',
      requestId,
      trackNamespace: namespace,
      trackName: name,
      parameters,
    };

    return {
      requestId,
      actions: [this.sendControl(subscribeMsg)],
    };
  }

  /**
   * Initiate an outbound PUBLISH (draft-18 §10.10). We are the publisher: this
   * allocates a Request ID, records publisher-side subscription state with the
   * advertised Track Alias (PENDING until the peer's REQUEST_OK), and produces a
   * PUBLISH control message. The I/O layer opens a dedicated bidi request stream.
   *
   * `trackAlias` is a full uint64-capable bigint; the draft-18 encoder accepts the
   * whole range, while draft-14/16 encoders still range-check it.
   *
   * @param namespace Track namespace tuple
   * @param name Track name bytes
   * @param trackAlias The Track Alias the publisher advertises for this track
   * @param options Optional PUBLISH `parameters` and draft-18 `trackProperties`
   *   (§2.5; non-empty Track Properties on draft-14/16 throw).
   * @see draft-ietf-moq-transport-18 §10.10
   */
  publish(
    namespace: Uint8Array[],
    name: Uint8Array,
    trackAlias: bigint,
    options: { parameters?: Parameters; trackProperties?: TrackProperties } = {},
  ): RequestResult {
    this.assertEstablishedOrDraining('publish');
    this.assertNotReservedNamespace(namespace, 'publish');

    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot PUBLISH after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }

    const trackProperties = this.resolveTrackProperties(options.trackProperties, 'PUBLISH');

    const requestId = this.requestIdAllocator.allocate();

    const sub = SubscriptionStateMachine.createAsPublisher(requestId, namespace, name);
    sub.setOutboundPublishAlias(trackAlias);
    this.outgoingPublishes.set(requestId as bigint, sub);

    const publishMsg: Publish = {
      type: 'PUBLISH',
      requestId,
      trackNamespace: namespace,
      trackName: name,
      trackAlias,
      parameters: options.parameters ?? new Map(),
      trackProperties,
    };

    return {
      requestId,
      actions: [this.sendControl(publishMsg)],
    };
  }

  /** Get an outgoing PUBLISH (publisher-side) subscription by request ID. */
  getOutgoingPublish(requestId: bigint): SubscriptionStateMachine | undefined {
    return this.outgoingPublishes.get(requestId as bigint);
  }

  /**
   * Get a subscription by request ID.
   */
  getSubscription(requestId: bigint): SubscriptionStateMachine | undefined {
    return this.subscriptions.get(requestId as bigint);
  }

  /**
   * Cancel an established subscriber-side subscription.
   *
   * §2.4.2: "When a subscriber detects a Malformed Track, it MUST
   * UNSUBSCRIBE any subscription [...] for that Track from that publisher."
   *
   * @param requestId The request ID of the subscription to unsubscribe
   * @returns draft-14/16: a `send_control` action with the UNSUBSCRIBE message;
   *   draft-18: no actions (UNSUBSCRIBE was removed — the I/O layer tears down the
   *   request stream instead).
   * @see draft-ietf-moq-transport-16 §2.4.2 (Malformed Track)
   * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
   */
  unsubscribe(requestId: bigint): SessionOutboundAction[] {
    const sub = this.subscriptions.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown subscription ${requestId} for unsubscribe`,
        'INVALID_STATE',
      );
    }

    // sendUnsubscribe validates ESTABLISHED state + subscriber side
    sub.sendUnsubscribe();

    // §5.1.1: Subscriber can destroy state after UNSUBSCRIBE.
    // Unregister the track alias so re-subscribing to the same track
    // with a new alias doesn't trigger DUPLICATE_TRACK_ALIAS.
    if (sub.trackAlias !== undefined) {
      this.trackAliases.unregister(sub.trackAlias);
    }

    if (this._draftVersion === 18) {
      // draft-18 removed the UNSUBSCRIBE message; the subscriber cancels by
      // tearing down the request stream (RESET_STREAM + STOP_SENDING, §3.3.2).
      // Terminate local subscription state and emit NO control message — the I/O
      // layer resets the request stream.
      this.subscriptions.delete(requestId as bigint);
      return [];
    }

    const msg: Unsubscribe = {
      type: 'UNSUBSCRIBE',
      requestId,
    };

    return [this.sendControl(msg)];
  }

  // ─── Request Update Operations ─────────────────────────────────────────

  /**
   * Send a REQUEST_UPDATE to modify an existing subscription.
   * The forward state is not updated locally until REQUEST_OK is received.
   * @see draft-ietf-moq-transport-16 §9.11
   */
  requestUpdate(
    existingRequestId: bigint,
    options: RequestUpdateOptions = {},
  ): RequestResult {
    this.assertEstablishedOrDraining('requestUpdate');

    // draft-18 §10.9.2: a prefix update targets an outbound SUBSCRIBE_NAMESPACE /
    // SUBSCRIBE_TRACKS request (tracked in separate maps, not `subscriptions`).
    if (this.namespaceSubscriptions.has(existingRequestId as bigint)
      || this.trackSubscriptions.has(existingRequestId as bigint)) {
      return this.requestUpdatePrefix(existingRequestId, options);
    }

    const sub = this.subscriptions.get(existingRequestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown subscription ${existingRequestId} for REQUEST_UPDATE`,
        'INVALID_STATE',
      );
    }

    // §10.9.2: a Track Namespace Prefix update is only valid for a
    // SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS, never a normal subscription — reject
    // it loudly rather than silently dropping the option.
    if (options.trackNamespacePrefix !== undefined) {
      throw new SessionError(
        `trackNamespacePrefix is only valid for a SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS update, not subscription ${existingRequestId}`,
        'INVALID_STATE',
      );
    }

    if (sub.state !== 'established') {
      throw new SessionError(
        `Cannot update subscription in state ${sub.state}; expected established`,
        'INVALID_STATE',
      );
    }

    const requestId = this.requestIdAllocator.allocate();

    // Build parameters
    const parameters: Parameters = new Map();

    // FORWARD parameter
    if (options.forward !== undefined) {
      parameters.set(MessageParam.FORWARD, [varint(BigInt(options.forward))]);
    } else if (this._draftVersion === 14) {
      // Draft-14 §9.10: Forward is a mandatory inline field.
      // Replay current value to avoid unintentional state change.
      const currentForward = varint(BigInt(sub.forwardState));
      parameters.set(MessageParam.FORWARD, [currentForward]);
    }

    // SUBSCRIBER_PRIORITY parameter
    if (options.subscriberPriority !== undefined) {
      parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [options.subscriberPriority]);
      sub.currentPriority = options.subscriberPriority;
    } else if (this._draftVersion === 14 && sub.currentPriority !== undefined) {
      // Draft-14 §9.10: Subscriber Priority is a mandatory inline field.
      // Replay current value to avoid resetting to codec default (128).
      parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [sub.currentPriority]);
    }

    // §9.2.2.5: SUBSCRIPTION_FILTER MAY appear in REQUEST_UPDATE
    if (options.subscriptionFilter !== undefined) {
      const filterBytes = encodeSubscriptionFilter(options.subscriptionFilter, this._draftVersion);
      parameters.set(MessageParam.SUBSCRIPTION_FILTER, [filterBytes]);
      // Update stored filter for future draft-14 replays
      sub.currentFilter = filterBytes;
    } else if (this._draftVersion === 14 && sub.currentFilter) {
      // Draft-14 §9.10: Start Location and End Group are mandatory inline fields.
      // If no new filter specified, replay the current filter to avoid widening.
      parameters.set(MessageParam.SUBSCRIPTION_FILTER, [sub.currentFilter]);
    }

    if (this._draftVersion === 14) {
      // Draft-14 §9.10: "There is no control message in response to a
      // SUBSCRIBE_UPDATE." Apply state changes immediately.
      if (options.forward !== undefined) {
        sub.updateForwardState(options.forward);
      }
    } else {
      // Draft-16: Track pending update — state is applied on REQUEST_OK
      const pending: { existingRequestId: bigint; forward?: ForwardStateValue } = {
        existingRequestId: existingRequestId as bigint,
      };
      if (options.forward !== undefined) {
        pending.forward = options.forward;
      }
      this.pendingUpdates.set(requestId as bigint, pending);
    }

    const updateMsg: RequestUpdate = {
      type: 'REQUEST_UPDATE',
      requestId,
      existingRequestId,
      parameters,
    };

    return {
      requestId,
      actions: [this.sendControl(updateMsg)],
    };
  }

  /**
   * draft-18 §10.9.2: send a REQUEST_UPDATE that changes the Track Namespace
   * Prefix of an outbound SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS. The update
   * rides the request's existing (continuing) bidi stream; the new prefix is
   * applied locally only when the matching REQUEST_OK arrives.
   */
  private requestUpdatePrefix(
    existingRequestId: bigint,
    options: RequestUpdateOptions,
  ): RequestResult {
    if (this._draftVersion !== 18) {
      throw new SessionError(
        `Track Namespace Prefix REQUEST_UPDATE requires draft-18 (current draft-${this._draftVersion})`,
        'INVALID_STATE',
      );
    }
    const nsSub = this.namespaceSubscriptions.get(existingRequestId as bigint);
    const trackSub = this.trackSubscriptions.get(existingRequestId as bigint);
    const target: 'namespace' | 'tracks' = nsSub ? 'namespace' : 'tracks';

    if (nsSub && !nsSub.isActive) {
      throw new SessionError(`Cannot update SUBSCRIBE_NAMESPACE ${existingRequestId}: not active`, 'INVALID_STATE');
    }
    if (trackSub && trackSub.state !== 'active') {
      throw new SessionError(`Cannot update SUBSCRIBE_TRACKS ${existingRequestId}: not active`, 'INVALID_STATE');
    }

    const prefix = options.trackNamespacePrefix;
    if (!prefix) {
      throw new SessionError(
        `REQUEST_UPDATE for a ${target === 'namespace' ? 'SUBSCRIBE_NAMESPACE' : 'SUBSCRIBE_TRACKS'} requires trackNamespacePrefix`,
        'INVALID_STATE',
      );
    }
    try {
      validateTrackNamespacePrefix(prefix);
    } catch (e) {
      throw new SessionError(e instanceof Error ? e.message : 'Malformed Track Namespace Prefix', 'PROTOCOL_VIOLATION');
    }

    const requestId = this.requestIdAllocator.allocate();
    const parameters: Parameters = new Map([[MessageParam.TRACK_NAMESPACE_PREFIX as bigint, [prefix]]]);
    this.pendingUpdates.set(requestId as bigint, {
      existingRequestId: existingRequestId as bigint,
      namespacePrefix: prefix,
      prefixTarget: target,
    });
    const updateMsg: RequestUpdate = { type: 'REQUEST_UPDATE', requestId, existingRequestId, parameters };
    return { requestId, actions: [this.sendControl(updateMsg)] };
  }

  // ─── Fetch Operations ─────────────────────────────────────────────────

  /**
   * Create a new fetch request.
   */
  fetch(
    namespace: Uint8Array[],
    name: Uint8Array,
    options: FetchOptions,
  ): RequestResult {
    this.assertEstablishedOrDraining('fetch');

    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot create new fetches after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }

    const requestId = this.requestIdAllocator.allocate();

    const fetchSm = FetchStateMachine.createAsFetcher(
      requestId,
      options.startGroup,
      options.startObject,
      options.endGroup,
      options.endObject,
    );
    this.fetches.set(requestId as bigint, fetchSm);

    // Build StandaloneFetch with proper Location fields per §9.16.1
    const startLocation = {
      group: options.startGroup,
      object: options.startObject,
    };
    const endLocation = {
      group: options.endGroup ?? 0n,
      object: options.endObject ?? 0n,
    };

    // §9.16: "End Location MUST specify the same or a larger Location
    // than Start Location for Standalone and Absolute Joining Fetches."
    if (
      endLocation.group < startLocation.group ||
      (endLocation.group === startLocation.group &&
        endLocation.object < startLocation.object)
    ) {
      throw new SessionError(
        `FETCH endLocation (${endLocation.group},${endLocation.object}) < startLocation (${startLocation.group},${startLocation.object}) — §9.16`,
        'INVALID_RANGE',
      );
    }

    const standaloneFetch: StandaloneFetch = {
      fetchType: 0x1,
      trackNamespace: namespace,
      trackName: name,
      startLocation,
      endLocation,
    };

    // §10.2: a requested Group Order travels as the GROUP_ORDER (0x22) parameter
    // — Ascending = 0x1, Descending = 0x2. Omitted ⇒ Ascending on decode.
    const parameters: Parameters = new Map();
    if (options.groupOrder !== undefined) {
      parameters.set(MessageParam.GROUP_ORDER, [varint(options.groupOrder === 'descending' ? 2n : 1n)]);
    }

    const fetchMsg: Fetch = {
      type: 'FETCH',
      requestId,
      fetch: standaloneFetch,
      parameters,
    };

    return {
      requestId,
      actions: [this.sendControl(fetchMsg)],
    };
  }

  /**
   * Get a fetch by request ID.
   */
  getFetch(requestId: bigint): FetchStateMachine | undefined {
    return this.fetches.get(requestId as bigint);
  }

  /**
   * Cancel an outgoing fetch request, transitioning the fetch to COMPLETED.
   *
   * draft-14/16: returns a FETCH_CANCEL to send on the control stream.
   *   §9.18: "A subscriber sends a FETCH_CANCEL message to a publisher to
   *   indicate it is no longer interested in receiving objects for the fetch
   *   identified by the 'Request ID'."
   *   §5.2: "A subscriber keeps FETCH state until it sends FETCH_CANCEL,
   *   receives REQUEST_ERROR, or receives a FIN or RESET_STREAM for the FETCH
   *   data stream."
   *
   * draft-18: FETCH_CANCEL was removed (§3.3.2); this marks the fetch completed
   * and returns NO actions — the I/O layer cancels the request + data streams
   * (STOP_SENDING / RESET_STREAM).
   *
   * @see draft-ietf-moq-transport-16 §5.2, §9.18; draft-ietf-moq-transport-18 §3.3.2
   */
  fetchCancel(requestId: bigint): SessionOutboundAction[] {
    const fetch = this.fetches.get(requestId as bigint);
    if (!fetch) {
      throw new SessionError(
        `Unknown fetch ${requestId} for FETCH_CANCEL`,
        'INVALID_STATE',
      );
    }

    fetch.sendFetchCancel();

    if (this._draftVersion === 18) {
      // draft-18 removed the FETCH_CANCEL control message (§3.3.2): cancellation
      // is STOP_SENDING / RESET_STREAM on the request + data streams, performed
      // by the I/O layer. The fetch state is marked completed above; no control
      // message is emitted. Drop the fetch from tracking.
      this.fetches.delete(requestId as bigint);
      return [];
    }

    const fetchCancelMsg: FetchCancel = {
      type: 'FETCH_CANCEL',
      requestId,
    };

    return [this.sendControl(fetchCancelMsg)];
  }

  // ─── Track Alias Operations ───────────────────────────────────────────

  /**
   * Get track info by alias.
   */
  getTrackByAlias(alias: Varint) {
    return this.trackAliases.getByAlias(alias);
  }

  // ─── Namespace Discovery Operations ──────────────────────────────────

  /**
   * Create a new namespace subscription.
   * Returns an open_namespace_stream action — the adapter should open a bidi
   * stream, send the SUBSCRIBE_NAMESPACE message on it, and associate the
   * stream with the requestId for routing future messages.
   * @see draft-ietf-moq-transport-16 §6.1, §9.25
   */
  subscribeNamespace(
    namespacePrefix: Uint8Array[],
    subscribeOptions: Varint = varint(0n),
  ): RequestResult {
    this.assertEstablishedOrDraining('subscribeNamespace');

    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot create new namespace subscriptions after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }

    const requestId = this.requestIdAllocator.allocate();

    const nsSm = NamespaceStateMachine.createAsSubscriber(requestId, namespacePrefix);
    this.namespaceSubscriptions.set(requestId as bigint, nsSm);

    const subscribeMsg: SubscribeNamespace = {
      type: 'SUBSCRIBE_NAMESPACE',
      requestId,
      trackNamespacePrefix: namespacePrefix,
      ...(this._draftVersion === 14 ? {} : { subscribeOptions }),
      parameters: new Map(),
    };

    if (this._draftVersion === 14) {
      // Draft-14 §9.28: SUBSCRIBE_NAMESPACE is sent on the control stream
      return {
        requestId,
        actions: [this.sendControl(subscribeMsg)],
      };
    }

    // Draft-16 §6.1: SUBSCRIBE_NAMESPACE opens a bidi stream
    const action: OpenNamespaceStreamAction = {
      type: 'open_namespace_stream',
      requestId,
      message: subscribeMsg,
    };

    return {
      requestId,
      actions: [action],
    };
  }

  // ─── SUBSCRIBE_TRACKS Operations (draft-18 §10.19) ───────────────────

  /**
   * Create a SUBSCRIBE_TRACKS request (draft-18 §10.19): ask a publisher for
   * PUBLISH messages for all tracks within matching namespaces. Like
   * SUBSCRIBE_NAMESPACE, it travels on a CONTINUING bidi request stream; the
   * I/O layer opens the stream and routes the first REQUEST_OK / REQUEST_ERROR
   * plus follow-up PUBLISH_BLOCKED messages.
   */
  subscribeTracks(namespacePrefix: Uint8Array[]): RequestResult {
    this.assertEstablishedOrDraining('subscribeTracks');
    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot create new track subscriptions after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }
    if (this._draftVersion !== 18) {
      throw new SessionError('SUBSCRIBE_TRACKS is a draft-18 message', 'INVALID_STATE');
    }

    const requestId = this.requestIdAllocator.allocate();
    this.trackSubscriptions.set(requestId as bigint, {
      trackNamespacePrefix: namespacePrefix,
      state: 'pending',
      blockedTracks: [],
    });

    const msg: SubscribeTracks = {
      type: 'SUBSCRIBE_TRACKS',
      requestId,
      trackNamespacePrefix: namespacePrefix,
      parameters: new Map(),
    };
    return { requestId, actions: [this.sendControl(msg)] };
  }

  /** Get a SUBSCRIBE_TRACKS request's local state by Request ID. */
  getTrackSubscription(requestId: bigint): TrackSubscriptionState | undefined {
    return this.trackSubscriptions.get(requestId as bigint);
  }

  /**
   * Handle a message received on a SUBSCRIBE_TRACKS response stream AFTER the
   * first REQUEST_OK — i.e. PUBLISH_BLOCKED (§10.20). The first REQUEST_OK /
   * REQUEST_ERROR is routed through the normal stamped pipeline, not here.
   */
  handleSubscribeTracksStreamMessage(requestId: bigint, msg: ControlMessage): SessionOutboundAction[] {
    const ts = this.trackSubscriptions.get(requestId as bigint);
    if (!ts) {
      return this.closeWithError(
        SessionErrorCode.INVALID_REQUEST_ID,
        `Unknown request ID ${requestId} for SUBSCRIBE_TRACKS stream message`,
      );
    }
    if (msg.type === 'PUBLISH_BLOCKED') {
      if (ts.state !== 'active') {
        return this.closeWithError(
          SessionErrorCode.PROTOCOL_VIOLATION,
          'PUBLISH_BLOCKED received before SUBSCRIBE_TRACKS was accepted',
        );
      }
      const pb = msg as PublishBlocked;
      ts.blockedTracks.push({ trackNamespaceSuffix: pb.trackNamespaceSuffix, trackName: pb.trackName });
      return [];
    }
    return this.closeWithError(
      SessionErrorCode.PROTOCOL_VIOLATION,
      `Unexpected ${msg.type} on a SUBSCRIBE_TRACKS response stream`,
    );
  }

  /** Handle FIN / reset on a SUBSCRIBE_TRACKS response stream — terminate it. */
  handleSubscribeTracksStreamClosed(requestId: bigint): SessionOutboundAction[] {
    const ts = this.trackSubscriptions.get(requestId as bigint);
    if (!ts) return [];
    ts.state = 'terminated';
    this.trackSubscriptions.delete(requestId as bigint);
    return [];
  }

  // ─── PUBLISH_NAMESPACE Operations (§6.2) ──────────────────────────────

  /**
   * Advertise a namespace that this endpoint can publish on.
   *
   * Sends PUBLISH_NAMESPACE on the control stream. The peer responds
   * with PUBLISH_NAMESPACE_OK or PUBLISH_NAMESPACE_ERROR.
   *
   * @param namespace The namespace to advertise
   * @returns The request ID and actions to execute
   * @see draft-ietf-moq-transport-16 §6.2
   */
  publishNamespace(
    namespace: Uint8Array[],
  ): RequestResult {
    this.assertEstablishedOrDraining('publishNamespace');
    this.assertNotReservedNamespace(namespace, 'publishNamespace');

    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot send PUBLISH_NAMESPACE after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }

    const requestId = this.requestIdAllocator.allocate();
    this.publishedNamespaces.set(requestId as bigint, {
      namespace,
      state: 'pending',
    });

    const publishNsMsg: PublishNamespace = {
      type: 'PUBLISH_NAMESPACE',
      requestId,
      trackNamespace: namespace,
      parameters: new Map(),
    };

    return {
      requestId,
      actions: [this.sendControl(publishNsMsg)],
    };
  }

  /**
   * Withdraw an accepted namespace — stops serving new subscriptions.
   *
   * draft-14/16: emits PUBLISH_NAMESPACE_DONE on the control stream.
   * draft-18: PUBLISH_NAMESPACE_DONE was removed; withdrawal is a cancellation of
   * the PUBLISH_NAMESPACE request stream (§3.3.2). This method only terminates
   * local state and returns NO send_control action — the I/O layer cancels the
   * request stream.
   *
   * @param requestId The request ID from publishNamespace()
   * @throws If requestId is unknown or namespace is not yet accepted
   * @see draft-ietf-moq-transport-16 §9.22, draft-ietf-moq-transport-18 §3.3.2
   */
  publishNamespaceDone(requestId: bigint): SessionOutboundAction[] {
    this.assertEstablishedOrDraining('publishNamespaceDone');

    const entry = this.publishedNamespaces.get(requestId as bigint);
    if (!entry) {
      throw new SessionError(
        `Unknown request ID ${requestId} for publishNamespaceDone`,
        'INVALID_STATE',
      );
    }
    if (entry.state !== 'active') {
      throw new SessionError(
        `Cannot withdraw pending namespace (requestId=${requestId})`,
        'INVALID_STATE',
      );
    }

    this.publishedNamespaces.delete(requestId as bigint);

    // draft-18 §3.3.2: no PUBLISH_NAMESPACE_DONE on the wire — withdrawal is a
    // request-stream cancellation handled by the I/O layer. Terminate state only.
    if (this._draftVersion === 18) {
      return [];
    }

    // v16 §9.22: PUBLISH_NAMESPACE_DONE { RequestID }
    // v14 §9.26: PUBLISH_NAMESPACE_DONE { TrackNamespace (tuple) }
    const msg: PublishNamespaceDone = this._draftVersion === 14
      ? { type: 'PUBLISH_NAMESPACE_DONE', trackNamespace: entry.namespace }
      : { type: 'PUBLISH_NAMESPACE_DONE', requestId };

    return [this.sendControl(msg)];
  }

  // ─── TRACK_STATUS Operations (§9.19) ──────────────────────────────────

  /**
   * Send a TRACK_STATUS request to query the current status of a track.
   *
   * §9.19: "A potential subscriber sends a TRACK_STATUS message on the control
   * stream to obtain information about the current status of a given track."
   *
   * Does NOT create subscription state. Response arrives via REQUEST_OK or REQUEST_ERROR.
   * The publisher does not send PUBLISH_DONE, and the subscriber cannot send
   * REQUEST_UPDATE or UNSUBSCRIBE for this request.
   *
   * @see draft-ietf-moq-transport-16 §9.19
   */
  trackStatus(
    namespace: Uint8Array[],
    name: Uint8Array,
  ): RequestResult {
    this.assertEstablishedOrDraining('trackStatus');

    if (this._state === SessionState.DRAINING) {
      throw new SessionDrainingError(
        'Cannot send TRACK_STATUS after GOAWAY; session is DRAINING',
        this._newSessionUri ?? '',
      );
    }

    const requestId = this.requestIdAllocator.allocate();

    // §9.19: No subscription state created
    this.pendingTrackStatuses.set(requestId as bigint, { namespace, name });

    const trackStatusMsg: TrackStatus = {
      type: 'TRACK_STATUS',
      requestId,
      trackNamespace: namespace,
      trackName: name,
      parameters: new Map(),
    };

    return {
      requestId,
      actions: [this.sendControl(trackStatusMsg)],
    };
  }

  /**
   * Resolve Track Properties (§2.5) for an outbound message. The `trackProperties`
   * send API is draft-18-only: draft-14/16 carry the legacy "Track Extensions" but
   * this API does not target them, so non-empty Track Properties on draft-14/16
   * throw rather than being silently encoded. Returns the map to attach (possibly
   * empty).
   */
  private resolveTrackProperties(trackProperties: TrackProperties | undefined, context: string): TrackProperties {
    const props = trackProperties ?? new Map();
    if (this._draftVersion !== 18 && props.size > 0) {
      throw new SessionError(
        `Track Properties on ${context} require draft-18 (current draft-${this._draftVersion})`,
        'INVALID_STATE',
      );
    }
    return props;
  }

  /**
   * Accept an incoming TRACK_STATUS request (publisher-side, TRACK_STATUS_OK).
   *
   * §9.19: "If successful, the publisher responds with a REQUEST_OK message
   * with the same parameters it would have set in a SUBSCRIBE_OK." draft-18 also
   * allows Track Properties (§2.5) on the TRACK_STATUS_OK.
   *
   * Backwards-compatible: the second argument may be the legacy `Parameters` map,
   * or a {@link TrackStatusAcceptOptions} carrying `parameters` and/or
   * `trackProperties`. Non-empty Track Properties on draft-14/16 throw (no such
   * field exists on the wire there).
   *
   * @see draft-ietf-moq-transport-16 §9.19, draft-ietf-moq-transport-18 §10.14
   */
  acceptTrackStatus(
    requestId: bigint,
    paramsOrOptions: Parameters | TrackStatusAcceptOptions = new Map(),
  ): SessionOutboundAction[] {
    const entry = this.incomingTrackStatuses.get(requestId as bigint);
    if (!entry) {
      throw new SessionError(
        `Unknown incoming TRACK_STATUS ${requestId}`,
        'INVALID_STATE',
      );
    }

    // The legacy second arg is a Parameters Map; otherwise it is an options object.
    const opts: TrackStatusAcceptOptions =
      paramsOrOptions instanceof Map ? { parameters: paramsOrOptions } : paramsOrOptions;
    const parameters = opts.parameters ?? new Map();
    const trackProperties = this.resolveTrackProperties(opts.trackProperties, 'TRACK_STATUS_OK');

    this.incomingTrackStatuses.delete(requestId as bigint);

    const requestOk: RequestOk = {
      type: 'REQUEST_OK',
      requestId,
      parameters,
      // Carry Track Properties only when present; the codec encodes an empty
      // block as zero bytes regardless, but keeping it absent is cleaner for
      // draft-14/16 (whose codec has no Track Properties field).
      ...(trackProperties.size > 0 ? { trackProperties } : {}),
    };

    return [this.sendControl(requestOk)];
  }

  /**
   * Reject an incoming TRACK_STATUS request (publisher-side).
   *
   * §9.19: "A publisher responds to a failed TRACK_STATUS with an
   * appropriate REQUEST_ERROR message."
   *
   * @see draft-ietf-moq-transport-16 §9.19
   */
  rejectTrackStatus(requestId: bigint, errorCode: bigint, errorReason: string): SessionOutboundAction[] {
    const entry = this.incomingTrackStatuses.get(requestId as bigint);
    if (!entry) {
      throw new SessionError(
        `Unknown incoming TRACK_STATUS ${requestId}`,
        'INVALID_STATE',
      );
    }

    this.incomingTrackStatuses.delete(requestId as bigint);

    const requestError: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode,
      retryInterval: varint(0n),
      errorReason,
      requestKind: 'TRACK_STATUS', // draft-14 → TRACK_STATUS_ERROR; ignored by 16/18
    };

    return [this.sendControl(requestError)];
  }

  /**
   * Get an incoming TRACK_STATUS request by request ID.
   * @see draft-ietf-moq-transport-16 §9.19
   */
  getIncomingTrackStatus(requestId: bigint): { namespace: Uint8Array[]; name: Uint8Array } | undefined {
    return this.incomingTrackStatuses.get(requestId as bigint);
  }

  /**
   * Get a still-pending OUTGOING TRACK_STATUS request (one we sent, awaiting its
   * REQUEST_OK / REQUEST_ERROR). Cleared once the response is handled.
   * @see draft-ietf-moq-transport-16 §9.19
   */
  getPendingTrackStatus(requestId: bigint): { namespace: Uint8Array[]; name: Uint8Array } | undefined {
    return this.pendingTrackStatuses.get(requestId as bigint);
  }

  /**
   * Handle a message received on a namespace discovery bidi stream.
   * The adapter routes messages by the requestId associated with the stream.
   * @see draft-ietf-moq-transport-16 §6.1
   */
  /**
   * Handle a FIN / reset on a SUBSCRIBE_NAMESPACE response stream.
   *
   * §6.1 / §10.18: "When a subscriber receives a stream reset or FIN on a
   * SUBSCRIBE_NAMESPACE response stream, it SHOULD treat this as though each
   * active namespace received a NAMESPACE_DONE." We terminate the (subscriber)
   * namespace subscription and drop it. No-op for an unknown / already-terminated
   * request.
   */
  handleNamespaceStreamClosed(requestId: bigint): SessionOutboundAction[] {
    const nsSm = this.namespaceSubscriptions.get(requestId as bigint);
    if (!nsSm) return [];
    if (nsSm.isActive) {
      nsSm.handleNamespaceDone(); // ACTIVE → TERMINATED (treat actives as done)
    }
    this.namespaceSubscriptions.delete(requestId as bigint);
    return [];
  }

  handleNamespaceStreamMessage(
    requestId: bigint,
    msg: ControlMessage,
  ): SessionOutboundAction[] {
    const nsSm = this.namespaceSubscriptions.get(requestId as bigint);
    if (!nsSm) {
      return this.closeWithError(
        SessionErrorCode.INVALID_REQUEST_ID,
        `Unknown request ID ${requestId} for namespace stream message`,
      );
    }

    switch (msg.type) {
      case 'REQUEST_OK':
        nsSm.handleRequestOk();
        return [];

      case 'REQUEST_ERROR': {
        const errMsg = msg as RequestErrorMsg;
        nsSm.handleRequestError(errMsg.errorCode, errMsg.errorReason);
        return [];
      }

      case 'NAMESPACE': {
        const nsMsg = msg as Namespace;
        // §2.4.1: Combined prefix + suffix must satisfy namespace constraints
        const nsValidationError = this.validateCombinedNamespace(
          nsSm.namespacePrefix, nsMsg.trackNamespaceSuffix,
        );
        if (nsValidationError) return nsValidationError;
        nsSm.handleNamespace(nsMsg.trackNamespaceSuffix);
        return [];
      }

      case 'NAMESPACE_DONE': {
        const ndMsg = msg as NamespaceDone;
        // §2.4.1: Combined prefix + suffix must satisfy namespace constraints
        const ndValidationError = this.validateCombinedNamespace(
          nsSm.namespacePrefix, ndMsg.trackNamespaceSuffix,
        );
        if (ndValidationError) return ndValidationError;
        // §6.1: "If a subscriber receives a NAMESPACE_DONE before the
        // corresponding NAMESPACE, it MUST close the session with a
        // 'PROTOCOL_VIOLATION'."
        if (!nsSm.hasDiscoveredSuffix(ndMsg.trackNamespaceSuffix)) {
          return this.closeWithError(
            SessionErrorCode.PROTOCOL_VIOLATION,
            `NAMESPACE_DONE for suffix not previously announced via NAMESPACE (§6.1)`,
          );
        }
        nsSm.handleNamespaceDone();
        return [];
      }

      default:
        return this.closeWithError(
          SessionErrorCode.PROTOCOL_VIOLATION,
          `Unexpected message type ${msg.type} on namespace stream`,
        );
    }
  }

  /**
   * Get a namespace subscription by request ID.
   */
  getNamespaceSubscription(requestId: bigint): NamespaceStateMachine | undefined {
    return this.namespaceSubscriptions.get(requestId as bigint);
  }

  // ─── Namespace Discovery on Control Stream ──────────────────────────

  /**
   * Handle incoming PUBLISH_NAMESPACE on the control stream.
   *
   * §6.2 (v14 + v16): "A subscriber MUST send exactly one
   * [PUBLISH_NAMESPACE_OK / PUBLISH_NAMESPACE_ERROR | REQUEST_OK /
   * REQUEST_ERROR] in response to a PUBLISH_NAMESPACE."
   *
   * Draft-14 (§9.23 / §9.25): ack via `PUBLISH_NAMESPACE_OK` /
   *   `PUBLISH_NAMESPACE_ERROR (UNINTERESTED 0x4)`.
   * Draft-16 (§6.2 / §9.20): ack via `REQUEST_OK` / `REQUEST_ERROR`.
   *
   * Behavior:
   * - Match found (we previously sent SUBSCRIBE_NAMESPACE with a matching
   *   prefix): record namespace, ack OK, notify_namespace under that
   *   subscription's requestId.
   * - No match:
   *   - v14: ack UNINTERESTED (preserves existing v14 semantics).
   *   - v16: ack OK and notify_namespace under the publisher's requestId.
   *     Per §6.2 a publisher MAY push PUBLISH_NAMESPACE without a prior
   *     SUBSCRIBE_NAMESPACE; the application layer decides interest.
   *
   * @see draft-ietf-moq-transport-14 §9.23, §6.2
   * @see draft-ietf-moq-transport-16 §9.20, §6.2
   */
  private handleIncomingPublishNamespace(msg: PublishNamespace): SessionOutboundAction[] {
    // §2.4.1: validate the Track Namespace BEFORE creating any namespace state.
    const nsError = this.validateNamespace18(msg.trackNamespace);
    if (nsError) return nsError;

    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // §3.2: reserved `.`/`.session` namespace → REQUEST_ERROR DOES_NOT_EXIST.
    const reserved = this.rejectReservedNamespace(msg.trackNamespace, msg.requestId, validated.replenish);
    if (reserved) return reserved;

    const match = this.findNamespaceSubscriptionByPrefix(msg.trackNamespace);
    const isV14 = this._draftVersion === 14;

    if (!match) {
      if (isV14) {
        // §9.25: UNINTERESTED (0x4) — "The namespace is not of interest."
        const errorMsg: PublishNamespaceError = {
          type: 'PUBLISH_NAMESPACE_ERROR',
          requestId: msg.requestId,
          errorCode: varint(0x4n),
          errorReason: 'No matching namespace subscription',
        };
        return [this.sendControl(errorMsg), ...(validated.replenish ?? [])];
      }
      // v16: surface to application + ack OK. The publisher's requestId
      // is the dispatch key (no internal namespace subscription exists).
      const okMsg: RequestOk = {
        type: 'REQUEST_OK',
        requestId: msg.requestId,
        parameters: new Map(),
      };
      const notifyAction: NotifyNamespaceAction = {
        type: 'notify_namespace',
        requestId: msg.requestId,
        message: msg,
      };
      // draft-18: track the inbound announce so a stream FIN/reset can withdraw it.
      if (this._draftVersion === 18) {
        this.incomingPublishNamespaces.set(msg.requestId as bigint, { namespace: msg.trackNamespace });
      }
      return [this.sendControl(okMsg), notifyAction, ...(validated.replenish ?? [])];
    }

    // Match found — record the announced namespace.
    match.nsSm.handleNamespace(msg.trackNamespace);
    if (this._draftVersion === 18) {
      this.incomingPublishNamespaces.set(msg.requestId as bigint, { namespace: msg.trackNamespace });
    }

    const okMsg: ControlMessage = isV14
      ? { type: 'PUBLISH_NAMESPACE_OK', requestId: msg.requestId }
      : { type: 'REQUEST_OK', requestId: msg.requestId, parameters: new Map() };

    const notifyAction: NotifyNamespaceAction = {
      type: 'notify_namespace',
      requestId: match.nsSm.requestId,
      message: msg,
    };

    return [this.sendControl(okMsg), notifyAction, ...(validated.replenish ?? [])];
  }

  /**
   * Withdraw an inbound PUBLISH_NAMESPACE on a FIN/reset of its request stream
   * (draft-18 §3.3.2 — PUBLISH_NAMESPACE_DONE was removed). If we tracked the
   * announce, drop it and withdraw it from any matching namespace subscription.
   * No-op if no state exists for `requestId` (e.g. already withdrawn). Returns no
   * outbound actions — the withdrawal signal is the stream close itself.
   *
   * @see draft-ietf-moq-transport-18 §3.3.2
   */
  handleInboundPublishNamespaceClosed(requestId: bigint): SessionOutboundAction[] {
    const entry = this.incomingPublishNamespaces.get(requestId as bigint);
    if (!entry) return [];
    this.incomingPublishNamespaces.delete(requestId as bigint);
    const match = this.findNamespaceSubscriptionByPrefix(entry.namespace);
    if (match) match.nsSm.withdrawNamespace(entry.namespace);
    return [];
  }

  // ─── Inbound SUBSCRIBE_NAMESPACE (publisher side, draft-18 §10.18) ─────────

  /**
   * Handle an incoming SUBSCRIBE_NAMESPACE (we are the publisher). Validates the
   * Request ID (d18 inbound policy) and the prefix, then either:
   *   - rejects an overlapping prefix with REQUEST_ERROR / PREFIX_OVERLAP (NOT a
   *     session close — the request simply fails); or
   *   - creates a PENDING publisher-side {@link NamespaceStateMachine} and returns
   *     no response, leaving accept/reject to the application.
   * A malformed prefix or params closes the session with PROTOCOL_VIOLATION.
   *
   * @see draft-ietf-moq-transport-18 §10.18
   */
  private handleIncomingSubscribeNamespace(msg: SubscribeNamespace): SessionOutboundAction[] {
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // Malformed prefix (>32 fields or >4096 bytes) → PROTOCOL_VIOLATION.
    try {
      validateTrackNamespacePrefix(msg.trackNamespacePrefix);
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : 'Malformed SUBSCRIBE_NAMESPACE prefix',
      );
    }

    // §3.2: reserved `.`/`.session` prefix → REQUEST_ERROR DOES_NOT_EXIST.
    const reserved = this.rejectReservedNamespace(msg.trackNamespacePrefix, msg.requestId, validated.replenish);
    if (reserved) return reserved;

    // Reject a prefix that overlaps an existing non-terminated incoming sub.
    for (const existing of this.incomingNamespaceSubscriptions.values()) {
      if (existing.isTerminated) continue;
      if (prefixesOverlap(existing.namespacePrefix, msg.trackNamespacePrefix)) {
        const errorMsg: RequestErrorMsg = {
          type: 'REQUEST_ERROR',
          requestId: msg.requestId,
          errorCode: RequestErrorCode.PREFIX_OVERLAP,
          retryInterval: varint(0n),
          errorReason: 'Track Namespace Prefix overlaps an existing SUBSCRIBE_NAMESPACE',
          requestKind: 'SUBSCRIBE_NAMESPACE', // draft-14 → SUBSCRIBE_NAMESPACE_ERROR; ignored by 16/18
        };
        return [this.sendControl(errorMsg), ...(validated.replenish ?? [])];
      }
    }

    const nsSm = NamespaceStateMachine.createAsPublisher(msg.requestId as bigint, msg.trackNamespacePrefix);
    this.incomingNamespaceSubscriptions.set(msg.requestId as bigint, nsSm);
    // No auto-ack — the application accepts/rejects via accept/rejectSubscribeNamespace.
    return validated.replenish ?? [];
  }

  /**
   * Accept an incoming SUBSCRIBE_NAMESPACE: send REQUEST_OK and move the
   * publisher-side machine PENDING → ACTIVE. The request stream stays open for
   * NAMESPACE / NAMESPACE_DONE announcements.
   */
  acceptSubscribeNamespace(requestId: bigint, params: Parameters = new Map()): SessionOutboundAction[] {
    const nsSm = this.incomingNamespaceSubscriptions.get(requestId as bigint);
    if (!nsSm) {
      throw new SessionError(`Unknown incoming SUBSCRIBE_NAMESPACE ${requestId}`, 'INVALID_STATE');
    }
    nsSm.sendRequestOk(); // PENDING → ACTIVE
    const requestOk: RequestOk = { type: 'REQUEST_OK', requestId, parameters: params };
    return [this.sendControl(requestOk)];
  }

  /**
   * Reject an incoming SUBSCRIBE_NAMESPACE: send REQUEST_ERROR and drop the
   * publisher-side state. The I/O layer FINs the request stream afterward.
   */
  rejectSubscribeNamespace(requestId: bigint, errorCode: bigint, errorReason: string): SessionOutboundAction[] {
    const nsSm = this.incomingNamespaceSubscriptions.get(requestId as bigint);
    if (!nsSm) {
      throw new SessionError(`Unknown incoming SUBSCRIBE_NAMESPACE ${requestId}`, 'INVALID_STATE');
    }
    this.incomingNamespaceSubscriptions.delete(requestId as bigint);
    const errorMsg: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode,
      retryInterval: varint(0n),
      errorReason,
      requestKind: 'SUBSCRIBE_NAMESPACE', // draft-14 → SUBSCRIBE_NAMESPACE_ERROR; ignored by 16/18
    };
    return [this.sendControl(errorMsg)];
  }

  /**
   * Announce a matching namespace on an accepted incoming SUBSCRIBE_NAMESPACE
   * stream (NAMESPACE, §10.18). The stream stays ACTIVE for further updates.
   */
  sendNamespace(requestId: bigint, suffix: Uint8Array[]): SessionOutboundAction[] {
    const nsSm = this.requireActiveIncomingNamespaceSub(requestId, 'sendNamespace');
    nsSm.sendNamespace(suffix);
    const msg: Namespace = { type: 'NAMESPACE', trackNamespaceSuffix: suffix };
    return [this.sendControl(msg)];
  }

  /**
   * Publisher-side: emit NAMESPACE_DONE for a previously announced suffix on an
   * accepted incoming SUBSCRIBE_NAMESPACE stream (§10.18). Locally this is a
   * PER-SUFFIX withdrawal from our publisher bookkeeping (via `withdrawNamespace`,
   * NOT the terminal `NamespaceStateMachine.sendNamespaceDone()`), so our incoming
   * machine stays ACTIVE and may emit further NAMESPACE / NAMESPACE_DONE. The
   * RECEIVING subscriber, however, treats NAMESPACE_DONE as TERMINATING its
   * namespace subscription (§6.1, `handleNamespaceDone`).
   */
  sendNamespaceDone(requestId: bigint, suffix: Uint8Array[]): SessionOutboundAction[] {
    const nsSm = this.requireActiveIncomingNamespaceSub(requestId, 'sendNamespaceDone');
    nsSm.withdrawNamespace(suffix); // per-suffix removal; machine stays ACTIVE
    const msg: NamespaceDone = { type: 'NAMESPACE_DONE', trackNamespaceSuffix: suffix };
    return [this.sendControl(msg)];
  }

  private requireActiveIncomingNamespaceSub(requestId: bigint, op: string): NamespaceStateMachine {
    const nsSm = this.incomingNamespaceSubscriptions.get(requestId as bigint);
    if (!nsSm) {
      throw new SessionError(`Unknown incoming SUBSCRIBE_NAMESPACE ${requestId}`, 'INVALID_STATE');
    }
    if (!nsSm.isActive) {
      throw new SessionError(`Cannot ${op} for SUBSCRIBE_NAMESPACE ${requestId}: not accepted`, 'INVALID_STATE');
    }
    return nsSm;
  }

  /** Whether we are serving an accepted incoming SUBSCRIBE_NAMESPACE. */
  getIncomingNamespaceSubscription(requestId: bigint): NamespaceStateMachine | undefined {
    return this.incomingNamespaceSubscriptions.get(requestId as bigint);
  }

  /**
   * Cancel an incoming SUBSCRIBE_NAMESPACE on a FIN/reset of its request stream
   * (draft-18 §10.18). Drops publisher-side state; no-op if none exists. The
   * cancellation signal is the stream close itself, so no outbound actions.
   */
  handleInboundSubscribeNamespaceClosed(requestId: bigint): SessionOutboundAction[] {
    this.incomingNamespaceSubscriptions.delete(requestId as bigint);
    return [];
  }

  // ─── Inbound SUBSCRIBE_TRACKS (publisher side, draft-18 §10.19) ────────────

  /**
   * Handle an incoming SUBSCRIBE_TRACKS (we are the publisher). Validates the
   * Request ID (d18 inbound policy) and the prefix, then either:
   *   - rejects an overlapping prefix — only against OTHER incoming
   *     SUBSCRIBE_TRACKS, never SUBSCRIBE_NAMESPACE — with REQUEST_ERROR /
   *     PREFIX_OVERLAP (NOT a session close); or
   *   - records a PENDING incoming track subscription and returns no response,
   *     leaving accept/reject to the application.
   * A malformed prefix closes the session with PROTOCOL_VIOLATION.
   *
   * @see draft-ietf-moq-transport-18 §10.19
   */
  private handleIncomingSubscribeTracks(msg: SubscribeTracks): SessionOutboundAction[] {
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    try {
      validateTrackNamespacePrefix(msg.trackNamespacePrefix);
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : 'Malformed SUBSCRIBE_TRACKS prefix',
      );
    }

    // §3.2: reserved `.`/`.session` prefix → REQUEST_ERROR DOES_NOT_EXIST.
    const reserved = this.rejectReservedNamespace(msg.trackNamespacePrefix, msg.requestId, validated.replenish);
    if (reserved) return reserved;

    // Overlap is checked ONLY against other incoming SUBSCRIBE_TRACKS — a
    // SUBSCRIBE_TRACKS prefix may coexist with a SUBSCRIBE_NAMESPACE prefix.
    for (const existing of this.incomingTrackSubscriptions.values()) {
      if (prefixesOverlap(existing.trackNamespacePrefix, msg.trackNamespacePrefix)) {
        const errorMsg: RequestErrorMsg = {
          type: 'REQUEST_ERROR',
          requestId: msg.requestId,
          errorCode: RequestErrorCode.PREFIX_OVERLAP,
          retryInterval: varint(0n),
          errorReason: 'Track Namespace Prefix overlaps an existing SUBSCRIBE_TRACKS',
        };
        return [this.sendControl(errorMsg), ...(validated.replenish ?? [])];
      }
    }

    this.incomingTrackSubscriptions.set(msg.requestId as bigint, {
      trackNamespacePrefix: msg.trackNamespacePrefix,
      state: 'pending',
    });
    return validated.replenish ?? [];
  }

  /**
   * Accept an incoming SUBSCRIBE_TRACKS: send REQUEST_OK and mark it ACTIVE. The
   * request stream stays open for PUBLISH (new streams) and PUBLISH_BLOCKED.
   */
  acceptSubscribeTracks(requestId: bigint, params: Parameters = new Map()): SessionOutboundAction[] {
    const ts = this.incomingTrackSubscriptions.get(requestId as bigint);
    if (!ts) {
      throw new SessionError(`Unknown incoming SUBSCRIBE_TRACKS ${requestId}`, 'INVALID_STATE');
    }
    ts.state = 'active';
    const requestOk: RequestOk = { type: 'REQUEST_OK', requestId, parameters: params };
    return [this.sendControl(requestOk)];
  }

  /**
   * Reject an incoming SUBSCRIBE_TRACKS: send REQUEST_ERROR and drop state. The
   * I/O layer FINs the request stream afterward.
   */
  rejectSubscribeTracks(requestId: bigint, errorCode: bigint, errorReason: string): SessionOutboundAction[] {
    const ts = this.incomingTrackSubscriptions.get(requestId as bigint);
    if (!ts) {
      throw new SessionError(`Unknown incoming SUBSCRIBE_TRACKS ${requestId}`, 'INVALID_STATE');
    }
    this.incomingTrackSubscriptions.delete(requestId as bigint);
    const errorMsg: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode,
      retryInterval: varint(0n),
      errorReason,
    };
    return [this.sendControl(errorMsg)];
  }

  /**
   * Indicate a Track cannot be served within an accepted incoming
   * SUBSCRIBE_TRACKS (PUBLISH_BLOCKED, §10.20). Valid only after the request is
   * ACTIVE; the stream stays open (no seal/close).
   */
  sendPublishBlocked(requestId: bigint, suffix: Uint8Array[], trackName: Uint8Array): SessionOutboundAction[] {
    const ts = this.incomingTrackSubscriptions.get(requestId as bigint);
    if (!ts) {
      throw new SessionError(`Unknown incoming SUBSCRIBE_TRACKS ${requestId}`, 'INVALID_STATE');
    }
    if (ts.state !== 'active') {
      throw new SessionError(`Cannot sendPublishBlocked for SUBSCRIBE_TRACKS ${requestId}: not accepted`, 'INVALID_STATE');
    }
    const msg: PublishBlocked = { type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: suffix, trackName };
    return [this.sendControl(msg)];
  }

  /** Whether we are serving an incoming SUBSCRIBE_TRACKS (pending or active). */
  getIncomingTrackSubscription(requestId: bigint): { trackNamespacePrefix: Uint8Array[]; state: 'pending' | 'active' } | undefined {
    return this.incomingTrackSubscriptions.get(requestId as bigint);
  }

  /**
   * Cancel an incoming SUBSCRIBE_TRACKS on a FIN/reset of its request stream
   * (draft-18 §10.19). Drops publisher-side state; no-op if none exists.
   */
  handleInboundSubscribeTracksClosed(requestId: bigint): SessionOutboundAction[] {
    this.incomingTrackSubscriptions.delete(requestId as bigint);
    return [];
  }

  /**
   * Cancel an inbound PUBLISH / SUBSCRIBE / FETCH on a FIN/reset of its request
   * stream (draft-18 §3.3.2) — a normal lifecycle end, not a protocol error. Drops
   * the publisher-/subscriber-side request state; no-op if none exists. Track
   * Alias routing for an inbound PUBLISH is owned by the I/O layer (kept for late
   * data), so it is not touched here.
   */
  handleInboundRequestClosed(requestId: bigint): SessionOutboundAction[] {
    this.incomingSubscriptions.delete(requestId as bigint);
    this.incomingFetches.delete(requestId as bigint);
    return [];
  }

  /**
   * Clean local state for an OUTBOUND request whose bidi request stream the PEER
   * closed (FIN/reset). §11.4.1: "Termination of a bidi request stream terminates
   * the Subscription, Fetch, Track Status, Publish Namespace, or Subscribe
   * Namespace request." Drops every map keyed by this Request ID and unregisters a
   * SUBSCRIBE's Track Alias. No-op for a request already ended. (The continuing
   * SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS streams have their own closed handlers —
   * {@link handleNamespaceStreamClosed} / {@link handleSubscribeTracksStreamClosed}.)
   *
   * @see draft-ietf-moq-transport-18 §11.4.1
   */
  handleOutboundRequestClosed(requestId: bigint): SessionOutboundAction[] {
    const sub = this.subscriptions.get(requestId as bigint);
    if (sub) {
      if (sub.trackAlias !== undefined) this.trackAliases.unregister(sub.trackAlias);
      this.subscriptions.delete(requestId as bigint);
      this.subscriptionTracks.delete(requestId as bigint);
    }
    this.fetches.delete(requestId as bigint);
    this.pendingTrackStatuses.delete(requestId as bigint);
    this.outgoingPublishes.delete(requestId as bigint);
    this.publishedNamespaces.delete(requestId as bigint);
    return [];
  }

  /**
   * Handle PUBLISH_NAMESPACE_DONE on the control stream.
   *
   * Per-namespace withdrawal — the subscription stays ACTIVE.
   *
   * Wire format diverges between drafts:
   * - v14 (§9.26): includes the Track Namespace tuple — lookup by prefix.
   * - v16 (§9.22, Figure 23): includes only the Request ID of the
   *   original PUBLISH_NAMESPACE — surface to application unchanged.
   *
   * @see draft-ietf-moq-transport-14 §9.26
   * @see draft-ietf-moq-transport-16 §9.22
   */
  private handlePublishNamespaceDone(msg: PublishNamespaceDone): SessionOutboundAction[] {
    if (this._draftVersion === 14) {
      const namespace = msg.trackNamespace;
      if (!namespace) {
        return this.closeWithError(
          SessionErrorCode.PROTOCOL_VIOLATION,
          'PUBLISH_NAMESPACE_DONE on control stream must include trackNamespace (v14)',
        );
      }

      const match = this.findNamespaceSubscriptionByPrefix(namespace);
      if (!match) return [];

      match.nsSm.withdrawNamespace(namespace);

      const notifyAction: NotifyNamespaceAction = {
        type: 'notify_namespace',
        requestId: match.nsSm.requestId,
        message: msg,
      };
      return [notifyAction];
    }

    // v16: keyed by requestId of the original PUBLISH_NAMESPACE.
    if (msg.requestId === undefined) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'PUBLISH_NAMESPACE_DONE on control stream must include requestId (v16)',
      );
    }
    const notifyAction: NotifyNamespaceAction = {
      type: 'notify_namespace',
      requestId: msg.requestId,
      message: msg,
    };
    return [notifyAction];
  }

  /**
   * Handle PUBLISH_NAMESPACE_CANCEL on the control stream (draft-14 only).
   *
   * Per-namespace withdrawal with error info. Subscription stays ACTIVE.
   *
   * @see draft-ietf-moq-transport-14 §9.27
   */
  private handlePublishNamespaceCancel(msg: PublishNamespaceCancel): SessionOutboundAction[] {
    const namespace = msg.trackNamespace;
    if (!namespace) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'PUBLISH_NAMESPACE_CANCEL on control stream must include trackNamespace',
      );
    }

    const match = this.findNamespaceSubscriptionByPrefix(namespace);
    if (!match) {
      return [];
    }

    match.nsSm.withdrawNamespace(namespace);

    const notifyAction: NotifyNamespaceAction = {
      type: 'notify_namespace',
      requestId: match.nsSm.requestId,
      message: msg,
    };
    return [notifyAction];
  }

  /**
   * Handle PUBLISH_NAMESPACE_OK on the control stream (draft-14 only).
   *
   * Response to our publishNamespace() — peer accepted the namespace.
   * Resolves the pending publish namespace.
   *
   * @see draft-ietf-moq-transport-14 §9.24: "The subscriber sends a
   *   PUBLISH_NAMESPACE_OK control message to acknowledge the successful
   *   authorization and acceptance of a PUBLISH_NAMESPACE message."
   * @see draft-ietf-moq-transport-14 §6.2: "A subscriber MUST send exactly
   *   one PUBLISH_NAMESPACE_OK or PUBLISH_NAMESPACE_ERROR in response to
   *   a PUBLISH_NAMESPACE."
   */
  private handlePublishNamespaceOk(msg: PublishNamespaceOk): SessionOutboundAction[] {
    const pubNs = this.publishedNamespaces.get(msg.requestId as bigint);
    if (pubNs && pubNs.state === 'pending') {
      pubNs.state = 'active';
      return [];
    }

    // §9.1: Unknown request ID or duplicate response
    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for PUBLISH_NAMESPACE_OK`,
    );
  }

  /**
   * Handle PUBLISH_NAMESPACE_ERROR on the control stream (draft-14 only).
   *
   * Response to our publishNamespace() — peer rejected the namespace.
   * Resolves the pending publish namespace.
   *
   * @see draft-ietf-moq-transport-14 §9.25: "The subscriber sends a
   *   PUBLISH_NAMESPACE_ERROR control message for tracks that failed
   *   authorization."
   *
   * Error codes per §9.25:
   *   INTERNAL_ERROR (0x0), UNAUTHORIZED (0x1), TIMEOUT (0x2),
   *   NOT_SUPPORTED (0x3), UNINTERESTED (0x4),
   *   MALFORMED_AUTH_TOKEN (0x10), EXPIRED_AUTH_TOKEN (0x12)
   */
  private handlePublishNamespaceError(msg: PublishNamespaceError): SessionOutboundAction[] {
    const pubNs = this.publishedNamespaces.get(msg.requestId as bigint);
    if (pubNs && pubNs.state === 'pending') {
      this.publishedNamespaces.delete(msg.requestId as bigint);
      return [];
    }

    // §9.1: Unknown request ID or duplicate response
    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for PUBLISH_NAMESPACE_ERROR`,
    );
  }

  /**
   * Handle incoming UNSUBSCRIBE_NAMESPACE on the control stream (draft-14 only).
   *
   * The subscriber is cancelling a previous SUBSCRIBE_NAMESPACE.
   * In draft-16, this is replaced by closing the bidi stream (§6.1).
   *
   * Currently we don't track publisher-side namespace subscriptions
   * received on the control stream, so this is a graceful no-op that
   * prevents falling through to the PROTOCOL_VIOLATION default handler.
   *
   * @see draft-ietf-moq-transport-14 §9.31: "A subscriber issues a
   *   UNSUBSCRIBE_NAMESPACE message to a publisher indicating it is no
   *   longer interested in PUBLISH_NAMESPACE, PUBLISH_NAMESPACE_DONE and
   *   PUBLISH messages for the specified track namespace prefix."
   */
  private handleIncomingUnsubscribeNamespace(_msg: UnsubscribeNamespace): SessionOutboundAction[] {
    // Graceful no-op: publisher-side SUBSCRIBE_NAMESPACE handling on the
    // control stream is not implemented (draft-14 only, §9.28–§9.31).
    // The important thing is NOT to close the session with PROTOCOL_VIOLATION.
    return [];
  }

  /**
   * Cancel a namespace subscription (draft-14 only).
   *
   * Sends UNSUBSCRIBE_NAMESPACE and terminates the state machine.
   *
   * @see draft-ietf-moq-transport-14 §9.31: "A subscriber issues a
   *   UNSUBSCRIBE_NAMESPACE message to a publisher indicating it is no
   *   longer interested."
   */
  cancelNamespace(requestId: bigint): SessionOutboundAction[] {
    const nsSm = this.namespaceSubscriptions.get(requestId as bigint);
    if (!nsSm) {
      throw new SessionError(`Unknown namespace subscription ${requestId}`, 'INVALID_STATE');
    }

    const unsubMsg: UnsubscribeNamespace = {
      type: 'UNSUBSCRIBE_NAMESPACE',
      trackNamespacePrefix: nsSm.namespacePrefix,
    };

    // Terminate the state machine
    nsSm.handleNamespaceDone();

    return [this.sendControl(unsubMsg)];
  }

  /**
   * Find the namespace subscription whose prefix matches the given namespace.
   * A namespace matches if it starts with the subscription's prefix.
   *
   * O(n) scan over active namespace subscriptions — typically 1-3.
   */
  private findNamespaceSubscriptionByPrefix(
    namespace: Uint8Array[],
  ): { nsSm: NamespaceStateMachine } | undefined {
    for (const nsSm of this.namespaceSubscriptions.values()) {
      if (!nsSm.isActive) continue;

      const prefix = nsSm.namespacePrefix;
      if (namespace.length < prefix.length) continue;

      let matches = true;
      for (let i = 0; i < prefix.length; i++) {
        const a = prefix[i]!, b = namespace[i]!;
        if (a.length !== b.length) { matches = false; break; }
        for (let j = 0; j < a.length; j++) {
          if (a[j] !== b[j]) { matches = false; break; }
        }
        if (!matches) break;
      }

      if (matches) return { nsSm };
    }
    return undefined;
  }

  // ─── Publisher-Side Operations ───────────────────────────────────────

  /**
   * Accept an incoming subscription request.
   * Sends SUBSCRIBE_OK and transitions the subscription to ESTABLISHED.
   *
   * `options` (draft-18) may carry SUBSCRIBE_OK `parameters` and `trackProperties`
   * (§2.5); non-empty Track Properties on draft-14/16 throw. The two-argument form
   * remains valid.
   *
   * @see draft-ietf-moq-transport-16 §9.10, draft-ietf-moq-transport-18 §10.4
   */
  acceptSubscribe(
    requestId: bigint,
    trackAlias: bigint,
    options: { parameters?: Parameters; trackProperties?: TrackProperties } = {},
  ): SessionOutboundAction[] {
    const sub = this.incomingSubscriptions.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${requestId}`,
        'INVALID_STATE',
      );
    }

    // Validate ALL misuse up-front, BEFORE any state mutation: draft-14/16 Track
    // Properties, and Track Properties on a PUBLISH acceptance (which is a
    // REQUEST_OK / PUBLISH_OK, not a SUBSCRIBE_OK — §10.10). sendSubscribeOk()
    // mutates the subscription to ESTABLISHED, so it must run only after these
    // checks pass.
    const trackProperties = this.resolveTrackProperties(options.trackProperties, 'SUBSCRIBE_OK');
    if (sub.isPublishInitiated && trackProperties.size > 0) {
      throw new SessionError(
        'Track Properties are not valid on a PUBLISH acceptance (only SUBSCRIBE_OK / TRACK_STATUS_OK / FETCH_OK)',
        'INVALID_STATE',
      );
    }

    sub.sendSubscribeOk(trackAlias);

    // PUBLISH-initiated subscriptions respond with a publish-acceptance message
    // (PUBLISH_OK / REQUEST_OK), not SUBSCRIBE_OK.
    if (sub.isPublishInitiated) {
      if (this._draftVersion === 18) {
        // draft-18 §10.10: PUBLISH_OK is REQUEST_OK shorthand (wire 0x07, no
        // Request ID); the I/O layer writes it on the inbound PUBLISH request
        // stream, not the control stream.
        const requestOk: RequestOk = { type: 'REQUEST_OK', requestId, parameters: new Map() };
        return [this.sendControl(requestOk)];
      }
      // Draft-14/16 §9.14: respond with PUBLISH_OK. Only carry fields that
      // intentionally define the initial subscription state.
      const params = this.buildPublishOkParamsFromPublish(sub.publishParameters);
      const publishOk: PublishOk = {
        type: 'PUBLISH_OK',
        requestId,
        parameters: params,
      };
      return [this.sendControl(publishOk)];
    }

    const subscribeOk: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId,
      trackAlias,
      parameters: options.parameters ?? new Map(),
      trackProperties,
    };

    return [this.sendControl(subscribeOk)];
  }

  /**
   * Reject an incoming subscription request.
   * Sends REQUEST_ERROR and transitions the subscription to TERMINATED.
   * @see draft-ietf-moq-transport-16 §9.8
   */
  rejectSubscribe(requestId: bigint, errorCode: bigint, errorReason: string): SessionOutboundAction[] {
    const sub = this.incomingSubscriptions.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${requestId}`,
        'INVALID_STATE',
      );
    }

    sub.sendRequestError(errorCode, errorReason);

    // PUBLISH-initiated subscriptions respond with a publish-rejection message.
    if (sub.isPublishInitiated) {
      if (this._draftVersion === 18) {
        // draft-18 §10.10: reject with REQUEST_ERROR (no Request ID on wire),
        // written on the inbound PUBLISH request stream by the I/O layer.
        const requestError: RequestErrorMsg = {
          type: 'REQUEST_ERROR', requestId, errorCode, retryInterval: varint(0n), errorReason,
        };
        return [this.sendControl(requestError)];
      }
      // Draft-14/16 §9.15: respond with PUBLISH_ERROR. The draft-14 field is a
      // QUIC Varint — range-guard the (now full-uint64) errorCode at this boundary.
      const publishError: PublishError = {
        type: 'PUBLISH_ERROR',
        requestId,
        errorCode: varint(errorCode),
        errorReason,
      };
      return [this.sendControl(publishError)];
    }

    const requestError: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode,
      retryInterval: varint(0n),
      errorReason,
      requestKind: 'SUBSCRIBE', // draft-14 → SUBSCRIBE_ERROR; ignored by 16/18
    };

    return [this.sendControl(requestError)];
  }

  /**
   * Handle PUBLISH_DONE received on an inbound PUBLISH stream (draft-18 §10.11):
   * terminate the PUBLISH-initiated subscription. Stream/alias teardown is the
   * I/O layer's concern — late data streams may still arrive, so the caller keeps
   * alias routing alive until delivery is accounted for.
   */
  handleInboundPublishDone(requestId: bigint): SessionOutboundAction[] {
    const sub = this.incomingSubscriptions.get(requestId as bigint);
    if (!sub) {
      return this.closeWithError(
        SessionErrorCode.INVALID_REQUEST_ID,
        `Unknown PUBLISH ${requestId} for PUBLISH_DONE`,
      );
    }
    this.incomingSubscriptions.delete(requestId as bigint);
    return [];
  }

  /**
   * Build a REQUEST_UPDATE for a PUBLISH-initiated (incoming) subscription
   * (draft-18). The publisher opened the stream; as the subscriber we update the
   * subscription (e.g. FORWARD) by writing REQUEST_UPDATE on that PUBLISH stream.
   * The matching REQUEST_OK / REQUEST_ERROR applies the update (see the REQUEST_OK
   * handler, which also looks up incoming subscriptions).
   */
  updateIncomingSubscription(
    existingRequestId: bigint,
    options: RequestUpdateOptions = {},
  ): RequestResult {
    const sub = this.incomingSubscriptions.get(existingRequestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${existingRequestId} for REQUEST_UPDATE`,
        'INVALID_STATE',
      );
    }
    if (sub.state !== 'established') {
      throw new SessionError(
        `Cannot update incoming subscription in state ${sub.state}; expected established`,
        'INVALID_STATE',
      );
    }

    const requestId = this.requestIdAllocator.allocate();
    const parameters: Parameters = new Map();
    if (options.forward !== undefined) {
      parameters.set(MessageParam.FORWARD, [varint(BigInt(options.forward))]);
    }
    if (options.subscriberPriority !== undefined) {
      parameters.set(MessageParam.SUBSCRIBER_PRIORITY, [options.subscriberPriority]);
    }

    this.pendingUpdates.set(requestId as bigint, {
      existingRequestId,
      ...(options.forward !== undefined
        ? { forward: options.forward ? ForwardState.ACTIVE : ForwardState.PAUSED }
        : {}),
    });

    const updateMsg: RequestUpdate = { type: 'REQUEST_UPDATE', requestId, existingRequestId, parameters };
    return { requestId, actions: [this.sendControl(updateMsg)] };
  }

  /**
   * Send PUBLISH_DONE for an established subscription.
   * Terminates the subscription from the publisher side.
   * @see draft-ietf-moq-transport-16 §9.15
   */
  publishDone(requestId: bigint, statusCode: Varint, errorReason: string): SessionOutboundAction[] {
    // PUBLISH_DONE applies to a publisher-side subscription — either one we serve
    // for a peer SUBSCRIBE (incomingSubscriptions) or one WE initiated via an
    // outbound PUBLISH (outgoingPublishes, draft-18 §10.10).
    const sub = this.incomingSubscriptions.get(requestId as bigint)
      ?? this.outgoingPublishes.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${requestId} for PUBLISH_DONE`,
        'INVALID_STATE',
      );
    }

    sub.sendPublishDone(statusCode, errorReason);
    this.outgoingPublishes.delete(requestId as bigint);

    const publishDoneMsg: PublishDone = {
      type: 'PUBLISH_DONE',
      requestId,
      statusCode,
      streamCount: sub.streamCount, // §9.15: number of data streams opened
      errorReason,
    };

    return [this.sendControl(publishDoneMsg)];
  }

  /**
   * Get an incoming subscription (publisher-side) by request ID.
   */
  getIncomingSubscription(requestId: bigint): SubscriptionStateMachine | undefined {
    return this.incomingSubscriptions.get(requestId as bigint);
  }

  /**
   * Accept an incoming fetch request.
   * Sends FETCH_OK and transitions the fetch to TRANSFERRING.
   * @see draft-ietf-moq-transport-16 §9.17
   */
  acceptFetch(requestId: bigint, options: FetchAcceptOptions = {}): SessionOutboundAction[] {
    const fetch = this.incomingFetches.get(requestId as bigint);
    if (!fetch) {
      throw new SessionError(
        `Unknown incoming fetch ${requestId}`,
        'INVALID_STATE',
      );
    }

    const trackProperties = this.resolveTrackProperties(options.trackProperties, 'FETCH_OK');

    fetch.sendFetchOk();

    const fetchOk: FetchOk = {
      type: 'FETCH_OK',
      requestId,
      endOfTrack: options.endOfTrack ?? 0,
      endLocation: options.endLocation ?? { group: 0n, object: 0n },
      parameters: options.parameters ?? new Map(),
      trackProperties,
    };

    return [this.sendControl(fetchOk)];
  }

  /**
   * Reject an incoming fetch request.
   * Sends REQUEST_ERROR and transitions the fetch to COMPLETED.
   * @see draft-ietf-moq-transport-16 §9.8
   */
  rejectFetch(requestId: bigint, errorCode: bigint, errorReason: string): SessionOutboundAction[] {
    const fetch = this.incomingFetches.get(requestId as bigint);
    if (!fetch) {
      throw new SessionError(
        `Unknown incoming fetch ${requestId}`,
        'INVALID_STATE',
      );
    }

    fetch.sendRequestError(errorCode, errorReason);

    const requestError: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode,
      retryInterval: varint(0n),
      errorReason,
      requestKind: 'FETCH', // draft-14 → FETCH_ERROR; ignored by 16/18
    };

    return [this.sendControl(requestError)];
  }

  /**
   * Get an incoming fetch (publisher-side) by request ID.
   */
  getIncomingFetch(requestId: bigint): FetchStateMachine | undefined {
    return this.incomingFetches.get(requestId as bigint);
  }

  // ─── Session Lifecycle ────────────────────────────────────────────────

  /**
   * Close the session.
   */
  close(error?: Varint, reason?: string): SessionOutboundAction[] {
    this._state = SessionState.CLOSED;

    const closeAction: CloseConnectionAction = {
      type: 'close_connection',
      error: error ?? varint(0n),
      reason: reason ?? '',
    };

    return [closeAction];
  }

  /**
   * Close the session with a specific error code.
   * Used internally for protocol violations.
   */
  private closeWithError(error: Varint, reason: string): SessionOutboundAction[] {
    this._state = SessionState.CLOSED;

    return [{
      type: 'close_connection',
      error,
      reason,
    }];
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private assertState(expected: SessionStateValue, operation: string): void {
    if (this._state !== expected) {
      throw new SessionError(
        `Cannot ${operation} in state ${this._state}; expected ${expected}`,
        'INVALID_STATE',
      );
    }
  }

  private assertEstablishedOrDraining(operation: string): void {
    if (this._state !== SessionState.ESTABLISHED && this._state !== SessionState.DRAINING) {
      throw new SessionError(
        `Cannot ${operation} in state ${this._state}; session must be ESTABLISHED`,
        'INVALID_STATE',
      );
    }
  }

  /**
   * §3.2.1 / §3.2.2: the Application MUST NOT publish tracks or namespaces whose
   * first Track Namespace field is reserved — exactly `.` (a single period) or
   * `.session` (session-level, managed by the implementation). Reject such local
   * API calls before any wire is emitted (cf. the invalid-filter local guard).
   * @throws {SessionError} for local misuse of a reserved namespace.
   */
  private assertNotReservedNamespace(namespace: Uint8Array[], operation: string): void {
    if (isReservedSessionNamespace(namespace)) {
      throw new SessionError(
        `Cannot ${operation} under the reserved .session namespace (§3.2.2)`,
        'PROTOCOL_VIOLATION',
      );
    }
    if (isReservedDotNamespace(namespace)) {
      throw new SessionError(
        `Cannot ${operation} under the reserved '.' namespace (§3.2.1)`,
        'PROTOCOL_VIOLATION',
      );
    }
  }

  /**
   * §3.2.1 / §3.2.2: a draft-18 inbound request for a track or namespace whose
   * Track Namespace first field is reserved — exactly `.` (§3.2.1) or `.session`
   * (§3.2.2, and we recognize no session-level tracks) — MUST be rejected
   * per-request with REQUEST_ERROR DOES_NOT_EXIST, NOT a session close. Other
   * `.`-prefixed namespaces are unrecognized reserved namespaces that §3.2.1
   * leaves application-visible, so they pass through here.
   *
   * Returns the reject actions (REQUEST_ERROR + replenish) when reserved — built
   * BEFORE any request state is created, so nothing is left dangling — otherwise
   * `undefined`. draft-14/16 are unaffected (§3.2 is a draft-18 rule).
   * @see draft-ietf-moq-transport-18 §3.2.1, §3.2.2
   */
  private rejectReservedNamespace(
    namespace: Uint8Array[],
    requestId: bigint,
    replenish: SessionOutboundAction[] | undefined,
  ): SessionOutboundAction[] | undefined {
    if (this._draftVersion !== 18) return undefined;
    const isDot = isReservedDotNamespace(namespace);
    if (!isDot && !isReservedSessionNamespace(namespace)) return undefined;
    const errorMsg: RequestErrorMsg = {
      type: 'REQUEST_ERROR',
      requestId,
      errorCode: RequestErrorCode.DOES_NOT_EXIST,
      retryInterval: varint(0n),
      errorReason: isDot
        ? "Reserved '.' namespace does not exist (§3.2.1)"
        : 'Unrecognized .session namespace does not exist (§3.2.2)',
    };
    return [this.sendControl(errorMsg), ...(replenish ?? [])];
  }

  /**
   * Validate combined namespace (prefix + suffix) per §2.4.1.
   * "Track Namespace is an ordered set of between 1 and 32 Track Namespace Fields"
   * "The length of a Track Namespace is the sum of the Track Namespace Field Length fields.
   * If an endpoint receives a Track Namespace...exceeding 4,096 bytes, it MUST close the
   * session with a PROTOCOL_VIOLATION."
   * @returns close_connection actions if invalid, undefined if valid
   */
  private validateCombinedNamespace(
    prefix: Uint8Array[],
    suffix: Uint8Array[],
  ): SessionOutboundAction[] | undefined {
    const combined = [...prefix, ...suffix];
    try {
      // §2.4.1: draft-18 permits a zero-field full namespace; draft-14/16 do not.
      validateTrackNamespace(combined, { allowEmpty: this._draftVersion === 18 });
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `Combined namespace (prefix=${prefix.length} + suffix=${suffix.length} = ${combined.length} fields) violates §2.4.1: ${(e as Error).message}`,
      );
    }
    return undefined;
  }

  private sendControl(message: ControlMessage): SendControlAction {
    return {
      type: 'send_control',
      message,
    };
  }

  /**
   * Check whether a known message parameter is valid for a control message type.
   *
   * Draft-14 includes GROUP_ORDER inline on PUBLISH; draft-16 does not.
   */
  private isParamValidForMessageType(key: bigint, messageType: string): boolean {
    if (
      this._draftVersion === 14 &&
      key === MessageParam.GROUP_ORDER &&
      messageType === 'PUBLISH'
    ) {
      return true;
    }

    const table = this._draftVersion === 18
      ? VALID_PARAMS_FOR_MESSAGE_TYPE_18
      : VALID_PARAMS_FOR_MESSAGE_TYPE;
    return table.get(key as bigint)?.has(messageType) ?? false;
  }

  /**
   * Validate message parameters: check for unknown types, invalid duplicates, and value constraints.
   * AUTHORIZATION_TOKEN may repeat (§9.2.2.1), other known types must be unique.
   * Parameters not valid for the given message type are ignored per §9.2.2.
   * @see draft-ietf-moq-transport-16 §9.2
   * @returns Error with code and reason if validation fails, undefined if valid
   */
  private validateMessageParams(params: Parameters, messageType: string): { error: Varint; reason: string } | undefined {
    const isDraft18 = this._draftVersion === 18;
    const knownParams = isDraft18 ? KNOWN_MESSAGE_PARAMS_18 : KNOWN_MESSAGE_PARAMS;
    for (const [key, values] of params) {
      // §9.2: Unknown message parameters are a protocol violation (draft-16/18).
      // Draft-14: ignore unknown params — different param sets between versions.
      if (!knownParams.has(key as bigint)) {
        if (this._draftVersion === 14) continue;
        return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `Unknown message parameter type: ${key}` };
      }

      // Scope check. draft-18 §10.2.1: a KNOWN parameter out of scope MUST close
      // with PROTOCOL_VIOLATION. draft-14/16 §9.2.2: it MUST be ignored instead.
      if (!this.isParamValidForMessageType(key, messageType)) {
        if (isDraft18) {
          return {
            error: SessionErrorCode.PROTOCOL_VIOLATION,
            reason: `Parameter 0x${(key as bigint).toString(16)} is out of scope for ${messageType} (§10.2.1)`,
          };
        }
        continue; // draft-14/16: ignore parameters not defined for this message type
      }

      // §9.2.2.1: AUTHORIZATION_TOKEN may appear multiple times
      // All other known message parameters must be unique
      if (key !== MessageParam.AUTHORIZATION_TOKEN && values.length > 1) {
        return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `Duplicate message parameter type: ${key}` };
      }

      // §9.2.2.1: Process AUTHORIZATION_TOKEN through alias cache + uniqueness check
      if (key === MessageParam.AUTHORIZATION_TOKEN) {
        const authError = this.processMessageAuthTokens(values);
        if (authError) return authError;
        continue;
      }

      // Value constraint validation for each parameter type
      for (const value of values) {
        const error = this.validateParamValue(key, value, messageType);
        if (error) return error;
      }
    }
    return undefined;
  }

  /**
   * Validate individual parameter value constraints.
   * Even-type parameters are varints — checked for value constraints (§9.2.2).
   * Odd-type parameters are bytes — checked for structural validity (§3.4).
   * @see draft-ietf-moq-transport-16 §9.2.2, §3.4
   * @returns Error with code and reason if validation fails, undefined if valid
   */
  private validateParamValue(key: bigint, value: ParameterValue, messageType: string): { error: Varint; reason: string } | undefined {
    // Even-type parameters: varint value constraint checks → PROTOCOL_VIOLATION
    if (typeof value === 'bigint') {
      switch (key) {
        // DELIVERY_TIMEOUT (0x02). draft-16 §9.2.2.2: MUST be > 0. draft-14 allows
        // 0; draft-18 §10.2.4 renames it OBJECT_DELIVERY_TIMEOUT where 0 means
        // "no timeout" (and SUBGROUP_DELIVERY_TIMEOUT 0x06 is unconstrained) — so
        // only draft-16 rejects 0.
        case MessageParam.DELIVERY_TIMEOUT:
          if (value === 0n && this._draftVersion === 16) {
            return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: 'DELIVERY_TIMEOUT must be greater than 0' };
          }
          break;

        // §9.2.2.8: FORWARD must be 0 or 1
        case MessageParam.FORWARD:
          if (value !== 0n && value !== 1n) {
            return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `FORWARD must be 0 or 1, got ${value}` };
          }
          break;

        // §9.2.2.3: SUBSCRIBER_PRIORITY must be 0-255
        case MessageParam.SUBSCRIBER_PRIORITY:
          if (value < 0n || value > 255n) {
            return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `SUBSCRIBER_PRIORITY must be 0-255, got ${value}` };
          }
          break;

        // §9.2.2.4: GROUP_ORDER validation is context-dependent in draft-14:
        // - SUBSCRIBE/FETCH: 0x0 = "use publisher's order" (valid), 0x1/0x2 valid, >0x2 error
        // - PUBLISH/PUBLISH_OK: 0x0 is a protocol error, only 0x1/0x2 valid
        // Draft-16: GROUP_ORDER is always 0x1 or 0x2 (no 0x0 anywhere)
        case MessageParam.GROUP_ORDER:
          if (this._draftVersion === 14 && (messageType === 'SUBSCRIBE' || messageType === 'FETCH')) {
            // Draft-14 §9.7/§9.16: 0x0 means "use publisher's order"
            if (value > 0x2n) {
              return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `GROUP_ORDER must be 0x0-0x2, got ${value}` };
            }
          } else {
            if (value !== 0x1n && value !== 0x2n) {
              return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `GROUP_ORDER must be Ascending (0x1) or Descending (0x2), got ${value}` };
            }
          }
          break;
      }
      return undefined;
    }

    // Non-varint parameter values. Draft-14/16 carry a byte string that is
    // validated structurally (§3.4 KEY_VALUE_FORMATTING_ERROR). Draft-18 carries
    // a typed Location for LARGEST_OBJECT, which is valid by construction.
    if (value instanceof Uint8Array) {
      switch (key) {
        // §9.2.2.7: LARGEST_OBJECT is a Location structure (two varints).
        case MessageParam.LARGEST_OBJECT:
          return this.validateLargestObject(value);

        // §9.2.2.5 / §5.1.2: SUBSCRIPTION_FILTER is a Subscription Filter structure.
        case MessageParam.SUBSCRIPTION_FILTER: {
          const reason = validateSubscriptionFilter(value, this._draftVersion);
          return reason ? { error: SessionErrorCode.PROTOCOL_VIOLATION, reason } : undefined;
        }
      }
      return undefined;
    }

    // Track Namespace tuple value (draft-18): only TRACK_NAMESPACE_PREFIX is a
    // namespace tuple. The prefix handler validates its shape (≤32 fields) and
    // overlap; here we only reject the tuple form on any other parameter.
    if (Array.isArray(value)) {
      if (key !== MessageParam.TRACK_NAMESPACE_PREFIX) {
        return {
          error: SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
          reason: `Parameter 0x${(key as bigint).toString(16)} must not be encoded as a Track Namespace tuple`,
        };
      }
      return undefined;
    }

    // Typed Location value (draft-18): only LARGEST_OBJECT is defined as a
    // Location. Any other parameter supplied as a Location is malformed.
    if (key !== MessageParam.LARGEST_OBJECT) {
      return {
        error: SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
        reason: `Parameter 0x${(key as bigint).toString(16)} must not be encoded as a Location`,
      };
    }
    return undefined; // LARGEST_OBJECT as a typed Location is valid by construction
  }

  /**
   * Validate LARGEST_OBJECT parameter bytes as a Location (§9.2.2.7, §1.4.1).
   * Must contain exactly two varints (group, object) with no trailing bytes.
   * @returns Error if malformed, undefined if valid
   */
  private validateLargestObject(bytes: Uint8Array): { error: Varint; reason: string } | undefined {
    try {
      const { bytesRead } = readLocation(bytes, 0);
      if (bytesRead !== bytes.length) {
        return {
          error: SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
          reason: `LARGEST_OBJECT has ${bytes.length - bytesRead} trailing bytes after Location`,
        };
      }
    } catch {
      return {
        error: SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
        reason: 'LARGEST_OBJECT is not a valid Location structure',
      };
    }
    return undefined;
  }

  /**
   * Validate message parameters for any control message that has them.
   * Setup messages are excluded (handled separately with different rules).
   * @returns Error with code and reason if validation fails, undefined if valid
   */
  private validateControlMessageParams(msg: ControlMessage): { error: Varint; reason: string } | undefined {
    // Messages with parameters field (excluding setup messages)
    if ('parameters' in msg && msg.parameters instanceof Map) {
      // Skip CLIENT_SETUP and SERVER_SETUP - they have setup parameters, not message parameters
      if (msg.type === 'CLIENT_SETUP' || msg.type === 'SERVER_SETUP') {
        return undefined;
      }
      // draft-18 §10.5: REQUEST_OK is a context-sensitive shorthand (PUBLISH_OK /
      // REQUEST_UPDATE_OK / TRACK_STATUS_OK / namespace responses). Its parameter
      // scope depends on WHICH request it answers, which is only known once the
      // request stream is resolved — so defer to handleRequestOk. (draft-14/16
      // REQUEST_OK keeps the by-type scope here.)
      if (this._draftVersion === 18 && msg.type === 'REQUEST_OK') {
        return undefined;
      }
      return this.validateMessageParams(msg.parameters, msg.type);
    }
    return undefined;
  }

  /**
   * Build a PUBLISH_OK parameter set from an inbound PUBLISH.
   *
   * PUBLISH and PUBLISH_OK do not share parameter semantics wholesale, so
   * only carry fields that intentionally define the initial subscription
   * state across both messages.
   */
  private buildPublishOkParamsFromPublish(params: Parameters): Parameters {
    const publishOkParams: Parameters = new Map();

    const forward = params.get(varint(MessageParam.FORWARD));
    if (forward && forward.length > 0) {
      publishOkParams.set(varint(MessageParam.FORWARD), [...forward]);
    }

    if (this._draftVersion === 14) {
      const groupOrder = params.get(varint(MessageParam.GROUP_ORDER));
      if (groupOrder && groupOrder.length > 0) {
        publishOkParams.set(varint(MessageParam.GROUP_ORDER), [...groupOrder]);
      } else {
        // Draft-14 encodes Group Order inline on PUBLISH_OK and forbids 0x0.
        publishOkParams.set(varint(MessageParam.GROUP_ORDER), [varint(1n)]);
      }
    }

    return publishOkParams;
  }
}
