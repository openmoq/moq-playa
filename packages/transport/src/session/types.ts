/**
 * Session layer type definitions.
 * @see draft-ietf-moq-transport-16 §3, §5, §9
 * @module
 */

import type { Varint } from '../primitives/varint.js';
import type { ControlMessage } from '../control/messages.js';
import type { DataStreamHeader, MoqtObject } from '../data/types.js';

// ─── Session State ────────────────────────────────────────────────────

/**
 * Session lifecycle states.
 * @see draft-ietf-moq-transport-16 §3
 */
export const SessionState = {
  /** Initial state before any messages. */
  IDLE: 'idle',
  /** CLIENT_SETUP sent, awaiting SERVER_SETUP. */
  SETUP_PENDING: 'setup_pending',
  /** Handshake complete, session operational. */
  ESTABLISHED: 'established',
  /** GOAWAY received, draining subscriptions. */
  DRAINING: 'draining',
  /** Session terminated. */
  CLOSED: 'closed',
} as const;

export type SessionStateValue = (typeof SessionState)[keyof typeof SessionState];

/**
 * Role of the endpoint in the session.
 * Determines request ID parity (client=even, server=odd).
 */
export const EndpointRole = {
  CLIENT: 'client',
  SERVER: 'server',
} as const;

export type EndpointRoleValue = (typeof EndpointRole)[keyof typeof EndpointRole];

// ─── Subscription State ───────────────────────────────────────────────

/**
 * Subscription lifecycle states.
 * @see draft-ietf-moq-transport-16 §5.1
 */
export const SubscriptionState = {
  /** Request sent, awaiting response. */
  PENDING: 'pending',
  /** SUBSCRIBE_OK/PUBLISH_OK received, active. */
  ESTABLISHED: 'established',
  /** Terminated (UNSUBSCRIBE, PUBLISH_DONE, or REQUEST_ERROR). */
  TERMINATED: 'terminated',
} as const;

export type SubscriptionStateValue = (typeof SubscriptionState)[keyof typeof SubscriptionState];

/**
 * Forward state controls whether objects are sent.
 * @see draft-ietf-moq-transport-16 §9.2.2.8
 */
export const ForwardState = {
  /** Don't forward objects. */
  PAUSED: 0,
  /** Forward objects (default). */
  ACTIVE: 1,
} as const;

export type ForwardStateValue = (typeof ForwardState)[keyof typeof ForwardState];

// ─── Fetch State ──────────────────────────────────────────────────────

/**
 * Fetch lifecycle states.
 * @see draft-ietf-moq-transport-16 §5.2
 */
export const FetchState = {
  /** FETCH sent, awaiting FETCH_OK or REQUEST_ERROR. */
  PENDING: 'pending',
  /** FETCH_OK received, data stream active. */
  TRANSFERRING: 'transferring',
  /** Completed (stream FIN, FETCH_CANCEL, or REQUEST_ERROR). */
  COMPLETED: 'completed',
} as const;

export type FetchStateValue = (typeof FetchState)[keyof typeof FetchState];

// ─── Namespace Discovery State ────────────────────────────────────────

/**
 * SUBSCRIBE_NAMESPACE lifecycle states.
 * @see draft-ietf-moq-transport-16 §6.1
 */
export const NamespaceState = {
  /** SUBSCRIBE_NAMESPACE sent, awaiting REQUEST_OK/ERROR. */
  PENDING: 'pending',
  /** REQUEST_OK received, receiving NAMESPACE messages. */
  ACTIVE: 'active',
  /** Terminated (REQUEST_ERROR or NAMESPACE_DONE). */
  TERMINATED: 'terminated',
} as const;

export type NamespaceStateValue = (typeof NamespaceState)[keyof typeof NamespaceState];

// ─── Inbound Events (from I/O adapter) ────────────────────────────────

/**
 * Control message received on the control stream.
 */
export interface ControlMessageEvent {
  readonly type: 'control_message';
  readonly message: ControlMessage;
}

/**
 * New data stream opened (unidirectional from peer).
 */
export interface DataStreamOpenedEvent {
  readonly type: 'data_stream_opened';
  readonly streamId: bigint;
  readonly header: DataStreamHeader;
}

/**
 * Object received on a data stream.
 */
export interface ObjectReceivedEvent {
  readonly type: 'object_received';
  readonly streamId: bigint;
  readonly object: MoqtObject;
}

/**
 * Data stream closed (FIN or RESET_STREAM).
 */
export interface StreamClosedEvent {
  readonly type: 'stream_closed';
  readonly streamId: bigint;
  /** Error code if RESET_STREAM, undefined if clean FIN. */
  readonly error?: Varint;
}

/**
 * Connection closed by peer or transport error.
 */
export interface ConnectionClosedEvent {
  readonly type: 'connection_closed';
  /** Session error code if provided. */
  readonly error?: Varint;
  /** Human-readable reason if provided. */
  readonly reason?: string;
}

/**
 * Bidirectional stream opened for namespace discovery.
 * @see draft-ietf-moq-transport-16 §6.1
 */
export interface NamespaceStreamOpenedEvent {
  readonly type: 'namespace_stream_opened';
  readonly streamId: bigint;
}

/**
 * All possible inbound events from the I/O adapter.
 */
export type SessionInboundEvent =
  | ControlMessageEvent
  | DataStreamOpenedEvent
  | ObjectReceivedEvent
  | StreamClosedEvent
  | ConnectionClosedEvent
  | NamespaceStreamOpenedEvent;

// ─── Outbound Actions (to I/O adapter) ────────────────────────────────

/**
 * Send a control message on the control stream.
 */
export interface SendControlAction {
  readonly type: 'send_control';
  readonly message: ControlMessage;
}

/**
 * Open a unidirectional data stream for sending objects.
 */
export interface OpenDataStreamAction {
  readonly type: 'open_data_stream';
  readonly streamType: 'subgroup' | 'fetch';
  // Publisher-side action feeding the draft-14/16 object encoder. It stays
  // `Varint` because there is no draft-18 publisher/encode path yet; the
  // draft-18 data *decoder* already reads track aliases as full-uint64 `bigint`.
  readonly trackAlias: Varint;
  readonly groupId: Varint;
  readonly subgroupId?: Varint;
  readonly publisherPriority?: number;
}

/**
 * Send an object on an open data stream.
 */
export interface SendObjectAction {
  readonly type: 'send_object';
  readonly streamId: bigint;
  readonly objectId: Varint;
  readonly payload: Uint8Array;
  readonly extensions?: Uint8Array;
  readonly status?: Varint;
}

/**
 * Close a data stream (FIN).
 */
export interface CloseStreamAction {
  readonly type: 'close_stream';
  readonly streamId: bigint;
}

/**
 * Reset a data stream with error code.
 */
export interface ResetStreamAction {
  readonly type: 'reset_stream';
  readonly streamId: bigint;
  readonly error: Varint;
}

/**
 * Send STOP_SENDING on a stream.
 */
export interface StopSendingAction {
  readonly type: 'stop_sending';
  readonly streamId: bigint;
  readonly error: Varint;
}

/**
 * Close the entire connection.
 */
export interface CloseConnectionAction {
  readonly type: 'close_connection';
  readonly error: Varint;
  readonly reason: string;
}

/**
 * Open a bidirectional stream for namespace discovery.
 * The adapter should open a bidi stream, send the message,
 * and associate the stream with the requestId for routing
 * subsequent NAMESPACE/NAMESPACE_DONE messages.
 * @see draft-ietf-moq-transport-16 §6.1
 */
export interface OpenNamespaceStreamAction {
  readonly type: 'open_namespace_stream';
  readonly requestId: bigint;
  readonly message: ControlMessage;
}

/**
 * Notify the adapter of a namespace event received on the control stream.
 *
 * In draft-14, PUBLISH_NAMESPACE/DONE/CANCEL arrive on the control stream
 * (not a bidi stream). The session produces this action so the adapter can
 * fire onNamespaceMessage regardless of draft version.
 *
 * @see draft-ietf-moq-transport-14 §9.23, §9.26, §9.27
 */
export interface NotifyNamespaceAction {
  readonly type: 'notify_namespace';
  readonly requestId: bigint;
  readonly message: ControlMessage;
}

/**
 * Cancel a LOCAL outbound request at the I/O layer: reject its still-pending
 * subscribeTrack()/request promise, drop adapter routing for it, and (draft-18)
 * reset its own request stream (§3.3.2). Emitted when the Session terminates a
 * local request out of band — e.g. a PENDING SUBSCRIBE superseded by a peer
 * PUBLISH for the same track (§5.1). The Session has ALREADY torn down its own
 * state and (draft-14/16) emitted UNSUBSCRIBE; this action only drives the
 * adapter-side cleanup so no caller hangs and no stream leaks.
 */
export interface CancelRequestAction {
  readonly type: 'cancel_request';
  readonly requestId: bigint;
  readonly reason: string;
}

/**
 * All possible outbound actions for the I/O adapter.
 */
export type SessionOutboundAction =
  | SendControlAction
  | OpenDataStreamAction
  | SendObjectAction
  | CloseStreamAction
  | ResetStreamAction
  | StopSendingAction
  | CloseConnectionAction
  | OpenNamespaceStreamAction
  | NotifyNamespaceAction
  | CancelRequestAction;

// ─── Session Events (emitted to application) ──────────────────────────

/**
 * Session state changed.
 */
export interface SessionStateChangedEvent {
  readonly type: 'session_state_changed';
  readonly previousState: SessionStateValue;
  readonly newState: SessionStateValue;
  /** New session URI if GOAWAY with redirect. */
  readonly newSessionUri?: string;
}

/**
 * Subscription state changed.
 */
export interface SubscriptionStateChangedEvent {
  readonly type: 'subscription_state_changed';
  readonly requestId: bigint;
  readonly previousState: SubscriptionStateValue;
  readonly newState: SubscriptionStateValue;
  /** Track alias assigned on SUBSCRIBE_OK. */
  readonly trackAlias?: bigint;
  /** Error code if terminated with error. */
  readonly error?: Varint;
  /** Error reason if terminated with error. */
  readonly errorReason?: string;
}

/**
 * Fetch state changed.
 */
export interface FetchStateChangedEvent {
  readonly type: 'fetch_state_changed';
  readonly requestId: bigint;
  readonly previousState: FetchStateValue;
  readonly newState: FetchStateValue;
  /** Error code if completed with error. */
  readonly error?: Varint;
}

/**
 * Object available for delivery to application.
 */
export interface ObjectDeliveryEvent {
  readonly type: 'object_delivery';
  readonly requestId: bigint;
  readonly object: MoqtObject;
}

/**
 * All events emitted to the application layer.
 */
export type SessionEmittedEvent =
  | SessionStateChangedEvent
  | SubscriptionStateChangedEvent
  | FetchStateChangedEvent
  | ObjectDeliveryEvent;
