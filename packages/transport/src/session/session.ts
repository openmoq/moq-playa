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

import { varint, type Varint, writeVarint, varintEncodingLength } from '../primitives/varint.js';
import { readLocation } from '../primitives/location.js';
import { readVarint } from '../primitives/varint.js';
import { type KvpValue } from '../primitives/kvp.js';
import { validateTrackNamespace } from '../primitives/bytes.js';
import { SessionError as SessionErrorCode, RequestError as RequestErrorCode } from '../errors.js';
import type {
  ControlMessage,
  ClientSetup,
  ServerSetup,
  Subscribe,
  SubscribeOk,
  SubscribeNamespace,
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
import type { DraftVersion } from '../control/codec.js';
import {
  SessionState,
  EndpointRole,
  ForwardState,
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
import { SubscriptionStateMachine } from './subscription.js';
import { FetchStateMachine } from './fetch.js';
import { NamespaceStateMachine } from './namespace.js';
import { TrackAliasManager } from './track-alias.js';
import { MessageParam } from '../control/parameters.js';
import type { Parameters } from '../control/messages.js';
import { AuthTokenCache, AuthCacheError } from './auth-cache.js';
import { AliasType, parseAuthorizationToken, type AuthorizationToken, type ResolvedToken } from '../control/auth-token.js';

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
]);

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
   * Our MAX_AUTH_TOKEN_CACHE_SIZE to advertise to the peer.
   * Declares how many bytes of token aliases we are willing to cache.
   * Default 0 = aliases prohibited.
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  maxAuthTokenCacheSize?: Varint;
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
/**
 * Subscription filter — controls which objects pass through a subscription.
 *
 * @see draft-ietf-moq-transport-16 §5.1.2 (Subscription Filters)
 * @see draft-ietf-moq-transport-16 §9.2.2.5 (SUBSCRIPTION_FILTER parameter)
 */
export type SubscriptionFilter =
  /** §5.1.2: Start at next group after Largest Object. */
  | { readonly type: 'NextGroupStart' }
  /** §5.1.2: Start after the Largest Object. */
  | { readonly type: 'LargestObject' }
  /** @deprecated Use 'LargestObject'. Alias kept for backward compatibility. */
  | { readonly type: 'LatestObject' }
  /** §5.1.2: Start at an explicit location (open-ended). */
  | { readonly type: 'AbsoluteStart'; readonly startGroup: Varint; readonly startObject: Varint }
  /** §5.1.2: Explicit start and end group. */
  | { readonly type: 'AbsoluteRange'; readonly startGroup: Varint; readonly startObject: Varint; readonly endGroup: Varint };

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
}

/**
 * Options for creating a fetch.
 */
export interface FetchOptions {
  startGroup: Varint;
  startObject: Varint;
  endGroup?: Varint;
  endObject?: Varint;
}

/**
 * Result of subscribe/fetch operations.
 */
export interface RequestResult {
  requestId: Varint;
  actions: SessionOutboundAction[];
}

/**
 * MOQT Session state machine.
 *
 * Manages the full lifecycle of a MOQT session from setup to close.
 */
export class Session {
  private readonly setupGate: SetupGate;
  private readonly requestIdAllocator: RequestIdAllocator;
  private readonly trackAliases = new TrackAliasManager();

  /** Outgoing subscriptions (as subscriber). */
  private readonly subscriptions = new Map<bigint, SubscriptionStateMachine>();
  /** Track info for subscriptions (for alias registration). */
  private readonly subscriptionTracks = new Map<bigint, { namespace: Uint8Array[]; name: Uint8Array }>();

  /** Outgoing fetches (as fetcher). */
  private readonly fetches = new Map<bigint, FetchStateMachine>();

  /** Incoming subscriptions (as publisher). */
  private readonly incomingSubscriptions = new Map<bigint, SubscriptionStateMachine>();

  /** Incoming fetches (as publisher). */
  private readonly incomingFetches = new Map<bigint, FetchStateMachine>();

  /** Outgoing namespace subscriptions (as namespace subscriber). */
  private readonly namespaceSubscriptions = new Map<bigint, NamespaceStateMachine>();

  /** Pending REQUEST_UPDATEs: maps update requestId → pending update info. */
  private readonly pendingUpdates = new Map<bigint, { existingRequestId: bigint; forward?: ForwardStateValue }>();

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
  private _peerMaxAuthTokenCacheSize: Varint = varint(0n);

  private _state: SessionStateValue = SessionState.IDLE;
  private _newSessionUri: string | undefined;
  private _peerMaxRequestId: Varint = varint(0n);
  private _goawayReceived: boolean = false;

  constructor(
    private readonly _role: EndpointRoleValue,
    private readonly _draftVersion: DraftVersion = 16,
  ) {
    this.setupGate = new SetupGate(_role);
    this.requestIdAllocator = new RequestIdAllocator(_role);
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
  get peerMaxAuthTokenCacheSize(): Varint {
    return this._peerMaxAuthTokenCacheSize;
  }

  // ─── Setup Handshake ──────────────────────────────────────────────────

  /**
   * Initiate setup handshake (client only).
   * Creates and returns CLIENT_SETUP message.
   */
  initiateSetup(options: SetupOptions = {}): SessionOutboundAction[] {
    this.assertState(SessionState.IDLE, 'initiateSetup');

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
  handleControlMessage(msg: ControlMessage): SessionOutboundAction[] {
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
          // Draft-14: no generic REQUEST_ERROR on wire (0x05 is SUBSCRIBE_ERROR).
          // Receiving a truly unsupported message type is a protocol violation.
          if (this._draftVersion === 14) {
            return this.closeWithError(
              SessionErrorCode.PROTOCOL_VIOLATION,
              `Unsupported message type ${msg.type}`,
            );
          }
          // §3.1: "Limited endpoints SHOULD respond to any unsupported messages
          // with the appropriate NOT_SUPPORTED error code, rather than ignoring them."
          if ('requestId' in msg && typeof (msg as { requestId: unknown }).requestId === 'bigint') {
            const reqId = (msg as { requestId: Varint }).requestId;
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
    } catch (e) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        e instanceof Error ? e.message : String(e),
      );
    }
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
    values: (Varint | Uint8Array)[],
  ): { error: Varint; reason: string } | undefined {
    if (!this.authCache) return undefined;

    const resolved: ResolvedToken[] = [];

    for (const rawValue of values) {
      if (!(rawValue instanceof Uint8Array)) continue;

      // Parse token structure
      let token: AuthorizationToken;
      try {
        token = parseAuthorizationToken(rawValue);
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

  private handleGoaway(msg: Goaway): SessionOutboundAction[] {
    // §9.4: Multiple GOAWAYs are a protocol violation
    if (this._goawayReceived) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'Received multiple GOAWAY messages',
      );
    }

    // §9.4: Server receiving GOAWAY with non-empty New Session URI is PROTOCOL_VIOLATION
    if (this._role === EndpointRole.SERVER && msg.newSessionUri.length > 0) {
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        'Server received GOAWAY with non-empty New Session URI',
      );
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
  private validateAndReplenish(requestId: Varint): {
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

    // PUBLISH_NAMESPACE rejection (§9.20)
    const pubNsErr = this.publishedNamespaces.get(msg.requestId as bigint);
    if (pubNsErr && pubNsErr.state === 'pending') {
      this.publishedNamespaces.delete(msg.requestId as bigint);
      return [];
    }

    // §9.1: Unknown request ID must close with INVALID_REQUEST_ID
    return this.closeWithError(
      SessionErrorCode.INVALID_REQUEST_ID,
      `Unknown request ID ${msg.requestId} for REQUEST_ERROR`,
    );
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

  private handleRequestOk(msg: RequestOk): SessionOutboundAction[] {
    const pending = this.pendingUpdates.get(msg.requestId as bigint);
    if (pending) {
      this.pendingUpdates.delete(msg.requestId as bigint);

      // Apply the update to the subscription
      if (pending.forward !== undefined) {
        const sub = this.subscriptions.get(pending.existingRequestId);
        if (sub) {
          sub.updateForwardState(pending.forward);
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

    // PUBLISH_NAMESPACE response (§9.20)
    const pubNs = this.publishedNamespaces.get(msg.requestId as bigint);
    if (pubNs && pubNs.state === 'pending') {
      pubNs.state = 'active';
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

  private handleIncomingSubscribe(msg: Subscribe): SessionOutboundAction[] {
    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

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
    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

    // Extract range from standalone fetch
    let startGroup: Varint | undefined;
    let startObject: Varint | undefined;
    let endGroup: Varint | undefined;
    let endObject: Varint | undefined;
    if (msg.fetch.fetchType === 0x1) {
      const sf = msg.fetch as StandaloneFetch;
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

    // §9.11: Look up Existing Request ID — must match an active subscription or fetch
    const sub = this.incomingSubscriptions.get(msg.existingRequestId as bigint);
    const fetch = this.incomingFetches.get(msg.existingRequestId as bigint);

    if (!sub && !fetch) {
      // §9.11: "MUST close the session with PROTOCOL_VIOLATION if the sender
      // specifies an invalid Existing Request ID"
      return this.closeWithError(
        SessionErrorCode.PROTOCOL_VIOLATION,
        `REQUEST_UPDATE references unknown Existing Request ID ${msg.existingRequestId}`,
      );
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
    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

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
      const filterBytes = this.encodeSubscriptionFilter(options.subscriptionFilter);
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
   * Get a subscription by request ID.
   */
  getSubscription(requestId: Varint): SubscriptionStateMachine | undefined {
    return this.subscriptions.get(requestId as bigint);
  }

  /**
   * Send UNSUBSCRIBE for an established subscriber-side subscription.
   *
   * §2.4.2: "When a subscriber detects a Malformed Track, it MUST
   * UNSUBSCRIBE any subscription [...] for that Track from that publisher."
   *
   * @param requestId The request ID of the subscription to unsubscribe
   * @returns Actions to send the UNSUBSCRIBE message
   * @see draft-ietf-moq-transport-16 §2.4.2 (Malformed Track)
   * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
   */
  unsubscribe(requestId: Varint): SessionOutboundAction[] {
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
    existingRequestId: Varint,
    options: RequestUpdateOptions = {},
  ): RequestResult {
    this.assertEstablishedOrDraining('requestUpdate');

    const sub = this.subscriptions.get(existingRequestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown subscription ${existingRequestId} for REQUEST_UPDATE`,
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
      const filterBytes = this.encodeSubscriptionFilter(options.subscriptionFilter);
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
      group: options.endGroup ?? varint(0n),
      object: options.endObject ?? varint(0n),
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

    const fetchMsg: Fetch = {
      type: 'FETCH',
      requestId,
      fetch: standaloneFetch,
      parameters: new Map(),
    };

    return {
      requestId,
      actions: [this.sendControl(fetchMsg)],
    };
  }

  /**
   * Get a fetch by request ID.
   */
  getFetch(requestId: Varint): FetchStateMachine | undefined {
    return this.fetches.get(requestId as bigint);
  }

  /**
   * Cancel an outgoing fetch request.
   *
   * Sends FETCH_CANCEL on the control stream and transitions the fetch
   * to COMPLETED.
   *
   * §9.18: "A subscriber sends a FETCH_CANCEL message to a publisher
   * to indicate it is no longer interested in receiving objects for the
   * fetch identified by the 'Request ID'."
   *
   * §5.2: "A subscriber keeps FETCH state until it sends FETCH_CANCEL,
   * receives REQUEST_ERROR, or receives a FIN or RESET_STREAM for the
   * FETCH data stream."
   *
   * @see draft-ietf-moq-transport-16 §5.2, §9.18
   */
  fetchCancel(requestId: Varint): SessionOutboundAction[] {
    const fetch = this.fetches.get(requestId as bigint);
    if (!fetch) {
      throw new SessionError(
        `Unknown fetch ${requestId} for FETCH_CANCEL`,
        'INVALID_STATE',
      );
    }

    fetch.sendFetchCancel();

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
   * Send PUBLISH_NAMESPACE_DONE for an accepted namespace.
   * Terminates the namespace — stops serving new subscriptions.
   *
   * @param requestId The request ID from publishNamespace()
   * @throws If requestId is unknown or namespace is not yet accepted
   * @see draft-ietf-moq-transport-16 §9.22
   */
  publishNamespaceDone(requestId: Varint): SessionOutboundAction[] {
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
        `Cannot send PUBLISH_NAMESPACE_DONE for pending namespace (requestId=${requestId})`,
        'INVALID_STATE',
      );
    }

    this.publishedNamespaces.delete(requestId as bigint);

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
   * Accept an incoming TRACK_STATUS request (publisher-side).
   *
   * §9.19: "If successful, the publisher responds with a REQUEST_OK message
   * with the same parameters it would have set in a SUBSCRIBE_OK."
   *
   * @see draft-ietf-moq-transport-16 §9.19
   */
  acceptTrackStatus(requestId: Varint, params: Parameters = new Map()): SessionOutboundAction[] {
    const entry = this.incomingTrackStatuses.get(requestId as bigint);
    if (!entry) {
      throw new SessionError(
        `Unknown incoming TRACK_STATUS ${requestId}`,
        'INVALID_STATE',
      );
    }

    this.incomingTrackStatuses.delete(requestId as bigint);

    const requestOk: RequestOk = {
      type: 'REQUEST_OK',
      requestId,
      parameters: params,
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
  rejectTrackStatus(requestId: Varint, errorCode: Varint, errorReason: string): SessionOutboundAction[] {
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
    };

    return [this.sendControl(requestError)];
  }

  /**
   * Get an incoming TRACK_STATUS request by request ID.
   * @see draft-ietf-moq-transport-16 §9.19
   */
  getIncomingTrackStatus(requestId: Varint): { namespace: Uint8Array[]; name: Uint8Array } | undefined {
    return this.incomingTrackStatuses.get(requestId as bigint);
  }

  /**
   * Handle a message received on a namespace discovery bidi stream.
   * The adapter routes messages by the requestId associated with the stream.
   * @see draft-ietf-moq-transport-16 §6.1
   */
  handleNamespaceStreamMessage(
    requestId: Varint,
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
  getNamespaceSubscription(requestId: Varint): NamespaceStateMachine | undefined {
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
    // Validate incoming request ID and auto-replenish MAX_REQUEST_ID §9.5
    const validated = this.validateAndReplenish(msg.requestId);
    if (validated.error) return validated.error;

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
      return [this.sendControl(okMsg), notifyAction, ...(validated.replenish ?? [])];
    }

    // Match found — record the announced namespace.
    match.nsSm.handleNamespace(msg.trackNamespace);

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
  cancelNamespace(requestId: Varint): SessionOutboundAction[] {
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
   * @see draft-ietf-moq-transport-16 §9.10
   */
  acceptSubscribe(requestId: Varint, trackAlias: Varint): SessionOutboundAction[] {
    const sub = this.incomingSubscriptions.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${requestId}`,
        'INVALID_STATE',
      );
    }

    sub.sendSubscribeOk(trackAlias);

    // Draft-14 §9.14: PUBLISH-initiated subscriptions respond with PUBLISH_OK.
    // Only carry fields that intentionally define the initial subscription state.
    if (sub.isPublishInitiated) {
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
      parameters: new Map(),
      trackExtensions: new Map(),
    };

    return [this.sendControl(subscribeOk)];
  }

  /**
   * Reject an incoming subscription request.
   * Sends REQUEST_ERROR and transitions the subscription to TERMINATED.
   * @see draft-ietf-moq-transport-16 §9.8
   */
  rejectSubscribe(requestId: Varint, errorCode: Varint, errorReason: string): SessionOutboundAction[] {
    const sub = this.incomingSubscriptions.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${requestId}`,
        'INVALID_STATE',
      );
    }

    sub.sendRequestError(errorCode, errorReason);

    // Draft-14 §9.15: PUBLISH-initiated subscriptions respond with PUBLISH_ERROR
    if (sub.isPublishInitiated) {
      const publishError: PublishError = {
        type: 'PUBLISH_ERROR',
        requestId,
        errorCode,
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
    };

    return [this.sendControl(requestError)];
  }

  /**
   * Send PUBLISH_DONE for an established subscription.
   * Terminates the subscription from the publisher side.
   * @see draft-ietf-moq-transport-16 §9.15
   */
  publishDone(requestId: Varint, statusCode: Varint, errorReason: string): SessionOutboundAction[] {
    const sub = this.incomingSubscriptions.get(requestId as bigint);
    if (!sub) {
      throw new SessionError(
        `Unknown incoming subscription ${requestId} for PUBLISH_DONE`,
        'INVALID_STATE',
      );
    }

    sub.sendPublishDone(statusCode, errorReason);

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
  getIncomingSubscription(requestId: Varint): SubscriptionStateMachine | undefined {
    return this.incomingSubscriptions.get(requestId as bigint);
  }

  /**
   * Accept an incoming fetch request.
   * Sends FETCH_OK and transitions the fetch to TRANSFERRING.
   * @see draft-ietf-moq-transport-16 §9.17
   */
  acceptFetch(requestId: Varint): SessionOutboundAction[] {
    const fetch = this.incomingFetches.get(requestId as bigint);
    if (!fetch) {
      throw new SessionError(
        `Unknown incoming fetch ${requestId}`,
        'INVALID_STATE',
      );
    }

    fetch.sendFetchOk();

    const fetchOk: FetchOk = {
      type: 'FETCH_OK',
      requestId,
      endOfTrack: 0,
      endLocation: { group: varint(0n), object: varint(0n) },
      parameters: new Map(),
      trackExtensions: new Map(),
    };

    return [this.sendControl(fetchOk)];
  }

  /**
   * Reject an incoming fetch request.
   * Sends REQUEST_ERROR and transitions the fetch to COMPLETED.
   * @see draft-ietf-moq-transport-16 §9.8
   */
  rejectFetch(requestId: Varint, errorCode: Varint, errorReason: string): SessionOutboundAction[] {
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
    };

    return [this.sendControl(requestError)];
  }

  /**
   * Get an incoming fetch (publisher-side) by request ID.
   */
  getIncomingFetch(requestId: Varint): FetchStateMachine | undefined {
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
      validateTrackNamespace(combined);
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
  private isParamValidForMessageType(key: Varint, messageType: string): boolean {
    if (
      this._draftVersion === 14 &&
      key === MessageParam.GROUP_ORDER &&
      messageType === 'PUBLISH'
    ) {
      return true;
    }

    return VALID_PARAMS_FOR_MESSAGE_TYPE.get(key as bigint)?.has(messageType) ?? false;
  }

  /**
   * Validate message parameters: check for unknown types, invalid duplicates, and value constraints.
   * AUTHORIZATION_TOKEN may repeat (§9.2.2.1), other known types must be unique.
   * Parameters not valid for the given message type are ignored per §9.2.2.
   * @see draft-ietf-moq-transport-16 §9.2
   * @returns Error with code and reason if validation fails, undefined if valid
   */
  private validateMessageParams(params: Parameters, messageType: string): { error: Varint; reason: string } | undefined {
    for (const [key, values] of params) {
      // §9.2: Unknown message parameters are a protocol violation (draft-16).
      // Draft-14: ignore unknown params — different param sets between versions.
      if (!KNOWN_MESSAGE_PARAMS.has(key as bigint)) {
        if (this._draftVersion === 14) continue;
        return { error: SessionErrorCode.PROTOCOL_VIOLATION, reason: `Unknown message parameter type: ${key}` };
      }

      // §9.2.2: "If it appears in some other type of message, it MUST be ignored"
      // Skip validation for parameters that are not valid for this message type
      if (!this.isParamValidForMessageType(key, messageType)) {
        continue; // Ignore parameters not defined for this message type
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
  private validateParamValue(key: Varint, value: KvpValue, messageType: string): { error: Varint; reason: string } | undefined {
    // Even-type parameters: varint value constraint checks → PROTOCOL_VIOLATION
    if (typeof value === 'bigint') {
      switch (key) {
        // §9.2.2.2: DELIVERY_TIMEOUT, if present, MUST be > 0 (draft-16).
        // Draft-14 allows DELIVERY_TIMEOUT=0.
        case MessageParam.DELIVERY_TIMEOUT:
          if (value === 0n && this._draftVersion !== 14) {
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

    // Odd-type parameters: byte-format structural validation
    // §3.4: "If a receiver understands a Type, and the following Value or Length/Value
    // does not match the serialization defined by that Type, the receiver MUST close
    // the session with error code KEY_VALUE_FORMATTING_ERROR."
    const bytes = value as Uint8Array;

    switch (key) {
      // §9.2.2.7: LARGEST_OBJECT is a Location structure (two varints: group, object)
      case MessageParam.LARGEST_OBJECT:
        return this.validateLargestObject(bytes);

      // §9.2.2.5: SUBSCRIPTION_FILTER is a Subscription Filter structure
      case MessageParam.SUBSCRIPTION_FILTER:
        return this.validateSubscriptionFilter(bytes);
    }

    return undefined;
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
   * Validate SUBSCRIPTION_FILTER parameter bytes (§9.2.2.5, §5.1.2).
   * Structure: Filter Type (varint), [Start Location], [End Group]
   * §9.2.2.5: Length mismatch → PROTOCOL_VIOLATION
   * Encode a SubscriptionFilter into wire-format bytes.
   *
   * §5.1.2: Filter Type (varint), [Start Location (group + object varints)], [End Group (varint)]
   * @see draft-ietf-moq-transport-16 §5.1.2
   */
  private encodeSubscriptionFilter(filter: SubscriptionFilter): Uint8Array {
    const filterTypeMap = {
      NextGroupStart: varint(0x1n),
      LargestObject: varint(0x2n),
      LatestObject: varint(0x2n),  // deprecated alias
      AbsoluteStart: varint(0x3n),
      AbsoluteRange: varint(0x4n),
    } as const;

    const filterType = filterTypeMap[filter.type];
    let size = varintEncodingLength(filterType);

    if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
      size += varintEncodingLength(filter.startGroup);
      size += varintEncodingLength(filter.startObject);
    }
    if (filter.type === 'AbsoluteRange') {
      size += varintEncodingLength(filter.endGroup);
    }

    const buf = new Uint8Array(size);
    let offset = writeVarint(filterType, buf, 0);

    if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
      offset += writeVarint(filter.startGroup, buf, offset);
      offset += writeVarint(filter.startObject, buf, offset);
    }
    if (filter.type === 'AbsoluteRange') {
      writeVarint(filter.endGroup, buf, offset);
    }

    return buf;
  }

  /**
   * §5.1.2: Unknown filter type → PROTOCOL_VIOLATION
   * §5.1.2: AbsoluteRange End Group < Start Group → PROTOCOL_VIOLATION
   * @returns Error if malformed, undefined if valid
   */
  private validateSubscriptionFilter(bytes: Uint8Array): { error: Varint; reason: string } | undefined {
    if (bytes.length === 0) {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: 'SUBSCRIPTION_FILTER is empty',
      };
    }

    let pos = 0;

    // Read Filter Type
    let filterType: bigint;
    try {
      const { value, bytesRead } = readVarint(bytes, pos);
      filterType = value as bigint;
      pos += bytesRead;
    } catch {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: 'SUBSCRIPTION_FILTER has malformed Filter Type varint',
      };
    }

    // §5.1.2: Valid filter types are 0x1 (NextGroupStart), 0x2 (LargestObject),
    // 0x3 (AbsoluteStart), 0x4 (AbsoluteRange)
    if (filterType < 1n || filterType > 4n) {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: `SUBSCRIPTION_FILTER has unknown Filter Type ${filterType}`,
      };
    }

    // NextGroupStart (0x1) and LargestObject (0x2): no additional fields
    if (filterType === 1n || filterType === 2n) {
      if (pos !== bytes.length) {
        return {
          error: SessionErrorCode.PROTOCOL_VIOLATION,
          reason: `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for Filter Type ${filterType}`,
        };
      }
      return undefined;
    }

    // AbsoluteStart (0x3) and AbsoluteRange (0x4): Start Location required
    let startGroup: bigint;
    try {
      const { value: loc, bytesRead } = readLocation(bytes, pos);
      startGroup = loc.group as bigint;
      pos += bytesRead;
    } catch {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: 'SUBSCRIPTION_FILTER has malformed Start Location',
      };
    }

    if (filterType === 3n) {
      // AbsoluteStart: no End Group
      if (pos !== bytes.length) {
        return {
          error: SessionErrorCode.PROTOCOL_VIOLATION,
          reason: `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for AbsoluteStart`,
        };
      }
      return undefined;
    }

    // AbsoluteRange (0x4): End Group required
    let endGroup: bigint;
    try {
      const { value, bytesRead } = readVarint(bytes, pos);
      endGroup = value as bigint;
      pos += bytesRead;
    } catch {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: 'SUBSCRIPTION_FILTER has malformed End Group varint for AbsoluteRange',
      };
    }

    if (pos !== bytes.length) {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for AbsoluteRange`,
      };
    }

    // §5.1.2: "End Group MUST specify the same or a larger Group than specified in Start Location"
    if (endGroup < startGroup) {
      return {
        error: SessionErrorCode.PROTOCOL_VIOLATION,
        reason: `SUBSCRIPTION_FILTER AbsoluteRange End Group ${endGroup} < Start Group ${startGroup}`,
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
