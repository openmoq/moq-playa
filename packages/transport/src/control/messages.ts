/**
 * All MOQT control message type interfaces as a discriminated union.
 * Each interface maps 1:1 to the wire format fields from §9.
 *
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import type { Varint } from '../primitives/varint.js';
import type { Location } from '../primitives/location.js';
import type { KvpValue } from '../primitives/kvp.js';

/**
 * KVP parameters map used by many messages.
 * Each key maps to an array of values to support multiple values per type
 * (e.g., AUTHORIZATION_TOKEN in setup, §9.3.1.5).
 */
export type Parameters = Map<Varint, KvpValue[]>;

/**
 * Track Extensions — KVP list consumed from remaining message bytes.
 * Each key maps to an array of values.
 */
export type TrackExtensions = Map<Varint, KvpValue[]>;

// ─── Setup Messages §9.3 ────────────────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.3 */
export interface ClientSetup {
  readonly type: 'CLIENT_SETUP';
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.3 */
export interface ServerSetup {
  readonly type: 'SERVER_SETUP';
  readonly parameters: Parameters;
}

// ─── Session Messages ────────────────────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.4 */
export interface Goaway {
  readonly type: 'GOAWAY';
  readonly newSessionUri: string;
}

/** @see draft-ietf-moq-transport-16 §9.5 */
export interface MaxRequestId {
  readonly type: 'MAX_REQUEST_ID';
  readonly maxRequestId: Varint;
}

/** @see draft-ietf-moq-transport-16 §9.6 */
export interface RequestsBlocked {
  readonly type: 'REQUESTS_BLOCKED';
  readonly maximumRequestId: Varint;
}

// ─── Generic Responses §9.7–§9.8 ────────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.7 */
export interface RequestOk {
  readonly type: 'REQUEST_OK';
  readonly requestId: Varint;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.8 */
export interface RequestErrorMsg {
  readonly type: 'REQUEST_ERROR';
  readonly requestId: Varint;
  readonly errorCode: Varint;
  readonly retryInterval: Varint;
  readonly errorReason: string;
}

// ─── Subscription Messages §9.9–§9.12 ───────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.9 */
export interface Subscribe {
  readonly type: 'SUBSCRIBE';
  readonly requestId: Varint;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.10 */
export interface SubscribeOk {
  readonly type: 'SUBSCRIBE_OK';
  readonly requestId: Varint;
  readonly trackAlias: Varint;
  readonly parameters: Parameters;
  readonly trackExtensions: TrackExtensions;
}

/** @see draft-ietf-moq-transport-16 §9.11 */
export interface RequestUpdate {
  readonly type: 'REQUEST_UPDATE';
  readonly requestId: Varint;
  readonly existingRequestId: Varint;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.12 */
export interface Unsubscribe {
  readonly type: 'UNSUBSCRIBE';
  readonly requestId: Varint;
}

// ─── Publish Messages §9.13–§9.15 ───────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.13 */
export interface Publish {
  readonly type: 'PUBLISH';
  readonly requestId: Varint;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly trackAlias: Varint;
  readonly parameters: Parameters;
  readonly trackExtensions: TrackExtensions;
}

/** @see draft-ietf-moq-transport-16 §9.14 */
export interface PublishOk {
  readonly type: 'PUBLISH_OK';
  readonly requestId: Varint;
  readonly parameters: Parameters;
}

/**
 * Draft-14 §9.15: PUBLISH_ERROR — rejection of a PUBLISH request.
 * Only used in draft-14 (draft-16 consolidated into REQUEST_ERROR).
 * @see draft-ietf-moq-transport-14 §9.15
 */
export interface PublishError {
  readonly type: 'PUBLISH_ERROR';
  readonly requestId: Varint;
  readonly errorCode: Varint;
  readonly errorReason: string;
}

/** @see draft-ietf-moq-transport-16 §9.15 */
export interface PublishDone {
  readonly type: 'PUBLISH_DONE';
  readonly requestId: Varint;
  readonly statusCode: Varint;
  readonly streamCount: Varint;
  readonly errorReason: string;
}

// ─── Fetch Messages §9.16–§9.18 ─────────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.16.1 */
export interface StandaloneFetch {
  readonly fetchType: 0x1;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly startLocation: Location;
  readonly endLocation: Location;
}

/** @see draft-ietf-moq-transport-16 §9.16.2 */
export interface JoiningFetch {
  readonly fetchType: 0x2 | 0x3;
  readonly joiningRequestId: Varint;
  readonly joiningStart: Varint;
}

/** @see draft-ietf-moq-transport-16 §9.16 */
export interface Fetch {
  readonly type: 'FETCH';
  readonly requestId: Varint;
  readonly fetch: StandaloneFetch | JoiningFetch;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.17 */
export interface FetchOk {
  readonly type: 'FETCH_OK';
  readonly requestId: Varint;
  readonly endOfTrack: number; // uint8: 0 or 1
  readonly endLocation: Location;
  readonly parameters: Parameters;
  readonly trackExtensions: TrackExtensions;
}

/** @see draft-ietf-moq-transport-16 §9.18 */
export interface FetchCancel {
  readonly type: 'FETCH_CANCEL';
  readonly requestId: Varint;
}

// ─── Track Status §9.19 ─────────────────────────────────────────────

/**
 * Same wire format as SUBSCRIBE.
 * @see draft-ietf-moq-transport-16 §9.19
 */
export interface TrackStatus {
  readonly type: 'TRACK_STATUS';
  readonly requestId: Varint;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly parameters: Parameters;
}

// ─── Namespace Messages §9.20–§9.25 ─────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.20 */
export interface PublishNamespace {
  readonly type: 'PUBLISH_NAMESPACE';
  readonly requestId: Varint;
  readonly trackNamespace: Uint8Array[];
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.21 */
export interface Namespace {
  readonly type: 'NAMESPACE';
  readonly trackNamespaceSuffix: Uint8Array[];
}

/**
 * Draft-16 §9.22: Request ID (i)
 * Draft-14 §9.26: Track Namespace (tuple)
 *
 * Exactly one of requestId or trackNamespace is present, determined by version.
 *
 * @see draft-ietf-moq-transport-16 §9.22
 * @see draft-ietf-moq-transport-14 §9.26
 */
export interface PublishNamespaceDone {
  readonly type: 'PUBLISH_NAMESPACE_DONE';
  readonly requestId?: Varint;
  readonly trackNamespace?: Uint8Array[];
}

/** @see draft-ietf-moq-transport-16 §9.23 */
export interface NamespaceDone {
  readonly type: 'NAMESPACE_DONE';
  readonly trackNamespaceSuffix: Uint8Array[];
}

/**
 * Draft-16 §9.24: Request ID (i)
 * Draft-14 §9.27: Track Namespace (tuple)
 *
 * Exactly one of requestId or trackNamespace is present, determined by version.
 *
 * @see draft-ietf-moq-transport-16 §9.24
 * @see draft-ietf-moq-transport-14 §9.27
 */
export interface PublishNamespaceCancel {
  readonly type: 'PUBLISH_NAMESPACE_CANCEL';
  readonly requestId?: Varint;
  readonly trackNamespace?: Uint8Array[];
  readonly errorCode: Varint;
  readonly errorReason: string;
}

/**
 * Draft-16 §9.25 includes Subscribe Options (i).
 * Draft-14 §9.28 has no subscribeOptions field.
 *
 * @see draft-ietf-moq-transport-16 §9.25
 * @see draft-ietf-moq-transport-14 §9.28
 */
export interface SubscribeNamespace {
  readonly type: 'SUBSCRIBE_NAMESPACE';
  readonly requestId: Varint;
  readonly trackNamespacePrefix: Uint8Array[];
  readonly subscribeOptions?: Varint;
  readonly parameters: Parameters;
}

// ─── Draft-14 Only Messages ──────────────────────────────────────────

/**
 * Draft-14 §9.31: Subscriber cancels namespace discovery.
 * In draft-16, the subscriber closes the bidi stream instead (no message needed).
 *
 * UNSUBSCRIBE_NAMESPACE Message {
 *   Type (i) = 0x14,
 *   Length (16),
 *   Track Namespace Prefix (tuple)
 * }
 *
 * @see draft-ietf-moq-transport-14 §9.31
 */
export interface UnsubscribeNamespace {
  readonly type: 'UNSUBSCRIBE_NAMESPACE';
  readonly trackNamespacePrefix: Uint8Array[];
}

/**
 * Draft-14 §9.24: Subscriber accepts a PUBLISH_NAMESPACE.
 * In draft-16, namespace discovery uses bidi streams with REQUEST_OK.
 *
 * PUBLISH_NAMESPACE_OK Message {
 *   Type (i) = 0x7,
 *   Length (16),
 *   Request ID (i)
 * }
 *
 * @see draft-ietf-moq-transport-14 §9.24
 */
export interface PublishNamespaceOk {
  readonly type: 'PUBLISH_NAMESPACE_OK';
  readonly requestId: Varint;
}

/**
 * Draft-14 §9.25: Subscriber rejects a PUBLISH_NAMESPACE.
 * In draft-16, namespace discovery uses bidi streams with REQUEST_ERROR.
 *
 * PUBLISH_NAMESPACE_ERROR Message {
 *   Type (i) = 0x8,
 *   Length (16),
 *   Request ID (i),
 *   Error Code (i),
 *   Error Reason (Reason Phrase)
 * }
 *
 * @see draft-ietf-moq-transport-14 §9.25
 */
export interface PublishNamespaceError {
  readonly type: 'PUBLISH_NAMESPACE_ERROR';
  readonly requestId: Varint;
  readonly errorCode: Varint;
  readonly errorReason: string;
}

// ─── Union Type ──────────────────────────────────────────────────────

export type ControlMessage =
  | ClientSetup
  | ServerSetup
  | Goaway
  | MaxRequestId
  | RequestsBlocked
  | RequestOk
  | RequestErrorMsg
  | Subscribe
  | SubscribeOk
  | RequestUpdate
  | Unsubscribe
  | Publish
  | PublishOk
  | PublishError
  | PublishDone
  | Fetch
  | FetchOk
  | FetchCancel
  | TrackStatus
  | PublishNamespace
  | Namespace
  | PublishNamespaceDone
  | NamespaceDone
  | PublishNamespaceCancel
  | SubscribeNamespace
  | UnsubscribeNamespace
  | PublishNamespaceOk
  | PublishNamespaceError;
