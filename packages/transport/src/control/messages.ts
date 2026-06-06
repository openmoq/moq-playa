/**
 * All MOQT control message type interfaces as a discriminated union.
 * Each interface maps 1:1 to the wire format fields from §9.
 *
 * @see draft-ietf-moq-transport-16 §9
 * @module
 */

import type { Varint } from '../primitives/varint.js';
import type { Location } from '../primitives/location.js';

/**
 * Semantic protocol-integer aliases.
 *
 * These are `bigint` (NOT the QUIC-varint `Varint` brand) because draft-18
 * encodes them as vi64 and they can legitimately span the full unsigned 64-bit
 * range, beyond QUIC varint's 2^62-1. The draft-14/16 encoders still enforce the
 * QUIC range at write time (see `varintEncodingLength`), so widening the type
 * does not let a draft-14/16 message encode an out-of-range value. There is
 * deliberately no `Vi64` brand and no `Varint | Vi64` union — the wire codec
 * owns the integer encoding; the session sees a semantic `bigint`.
 */
export type RequestId = bigint;
/**
 * A server-assigned track alias. vi64 in draft-18 and can exceed the QUIC-varint
 * range, so it is `bigint` (see {@link RequestId}). Both the CONTROL plane
 * (SUBSCRIBE_OK / PUBLISH and the subscription state it feeds) and the DATA
 * plane (subgroup/datagram headers in `data/types.ts`) carry it as `bigint`.
 */
export type TrackAlias = bigint;

/**
 * A control-message parameter value at the semantic layer.
 *
 * Integer values are raw `bigint` (NOT the QUIC-varint `Varint` brand): draft-18
 * encodes varint-kind message parameters as vi64, so they may span the full
 * unsigned 64-bit range, beyond QUIC varint's 2^62-1. The draft-14/16 codecs
 * remain the guardrail — their KVP writer (`writeVarint`/`varintEncodingLength`)
 * range-checks every value at write time, so widening this type does NOT let a
 * draft-14/16 message silently encode an out-of-QUIC-range value.
 *
 * `Location` (two vi64s, e.g. LARGEST_OBJECT) and `NamespaceTuple` are draft-18
 * typed parameters with no KVP representation — modelled here ABOVE the KVP
 * primitive; the draft-14/16 codecs reject them if asked to encode through KVP.
 */
export type ParameterValue = bigint | Uint8Array | Location | NamespaceTuple;

/**
 * A Track Namespace structure (§2.4.1) carried as a parameter value — a list of
 * namespace fields. Used by the draft-18 TRACK_NAMESPACE_PREFIX parameter (0x34,
 * REQUEST_UPDATE for SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS, §10.2.14). Modelled
 * here, above the KVP primitive, like {@link Location}: the draft-14/16 codecs
 * never emit it and reject it if asked to encode through KVP.
 */
export type NamespaceTuple = readonly Uint8Array[];

/**
 * Message parameters map used by many messages. Keyed by parameter Type (a
 * `bigint`; draft-18 Types are vi64). Each key maps to an array of values to
 * support parameter Types that allow multiple instances (e.g. AUTHORIZATION_TOKEN).
 */
export type Parameters = Map<bigint, ParameterValue[]>;

/**
 * A single Track Property value (draft-18 §2.5): a vi64 integer for even Property
 * Types, raw bytes for odd Types. Integers are full uint64 (`bigint`) — NOT the
 * QUIC-Varint range — so Track Properties can carry any draft-18 vi64 value.
 */
export type TrackPropertyValue = bigint | Uint8Array;

/**
 * Track Properties — the trailing per-track KVP block on PUBLISH / SUBSCRIBE_OK /
 * FETCH_OK / TRACK_STATUS_OK (draft-18 §2.5). The Type is a vi64 (`bigint`); each
 * maps to an array of {@link TrackPropertyValue} (multiple per Type allowed).
 * (draft-14/16 called this "Track Extensions".)
 */
export type TrackProperties = Map<bigint, TrackPropertyValue[]>;

/**
 * @deprecated draft-18 renamed "Track Extensions" → "Track Properties". Use
 * {@link TrackProperties}. Kept as an alias for backwards compatibility.
 */
export type TrackExtensions = TrackProperties;

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

/**
 * draft-18 unified SETUP (§10.3, type 0x2F00). Replaces the role-specific
 * CLIENT_SETUP / SERVER_SETUP: each endpoint sends one on its outbound control
 * stream. This is a NEUTRAL decoded shape — a pure wire codec has no role, so it
 * does not guess client vs server; the session (which knows its role) interprets
 * it. Setup Options span the whole payload (no count prefix); unknown options are
 * ignored by the session.
 *
 * @see draft-ietf-moq-transport-18 §10.3
 */
/**
 * A draft-18 Setup Option value. Setup Options are KVP and self-describing by
 * Type parity: an even Type carries a vi64 value (here `bigint`, full uint64 —
 * NOT the QUIC-Varint-capped message-parameter range), an odd Type carries a
 * length-prefixed byte string.
 */
export type SetupOptionValue = bigint | Uint8Array;

/**
 * draft-18 Setup Options, keyed by Option Type. Distinct from {@link Parameters}
 * (even-Type values are full-uint64 vi64) and from the session-layer `SetupOptions`
 * config object (which describes setup *inputs*, not the decoded wire map).
 */
export type SetupOptionMap = Map<bigint, SetupOptionValue[]>;

export interface Setup {
  readonly type: 'SETUP';
  readonly setupOptions: SetupOptionMap;
}

// ─── Session Messages ────────────────────────────────────────────────

/**
 * @see draft-ietf-moq-transport-16 §9.4
 * @see draft-ietf-moq-transport-18 §10.4
 */
export interface Goaway {
  readonly type: 'GOAWAY';
  readonly newSessionUri: string;
  /**
   * draft-18 §10.4: graceful-closure timeout in milliseconds (vi64). Absent on
   * draft-14/16 (URI-only GOAWAY). A value of 0 means "no specific timeout".
   */
  readonly timeout?: bigint;
  /**
   * draft-18 §10.4: the smallest peer Request ID that may not have been processed.
   * Present ONLY when the GOAWAY is sent on the CONTROL stream; absent on a request
   * stream (and on draft-14/16). The codec is context-free, so it surfaces this as
   * optional — control-vs-request-stream context is enforced by the session.
   */
  readonly requestId?: bigint;
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
  readonly requestId: RequestId;
  readonly parameters: Parameters;
  /**
   * draft-18 Track Properties. Carried only when a REQUEST_OK answers a
   * TRACK_STATUS (TRACK_STATUS_OK); for PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE /
   * SUBSCRIBE_TRACKS responses they MUST be empty — the request-stream context
   * decides legality, so the codec decodes them and the session validates. Absent
   * on draft-14/16.
   */
  readonly trackProperties?: TrackProperties;
  /** @deprecated Use {@link trackProperties}. */
  readonly trackExtensions?: TrackProperties;
}

/**
 * draft-18 §10.6.2: the optional Redirect carried by a REQUEST_ERROR whose Error
 * Code is REDIRECT (0x34). A zero-length Connect URI means "same session"; an
 * empty namespace + zero-length Track Name means "same track".
 *
 * The codec/session decode, validate, and surface this to the application; the
 * library does NOT automatically reconnect or re-issue the request — following a
 * redirect is the application's responsibility (intentionally out of scope).
 */
export interface Redirect {
  readonly connectUri: Uint8Array;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
}

/**
 * Originating request kind for a REQUEST_ERROR, used ONLY by the draft-14 codec.
 *
 * draft-16/18 carry a single generic REQUEST_ERROR on the wire, but draft-14
 * splits it into a distinct message per request kind — SUBSCRIBE_ERROR,
 * FETCH_ERROR, TRACK_STATUS_ERROR, SUBSCRIBE_NAMESPACE_ERROR — all sharing the
 * identical `[Request ID, Error Code, Reason]` payload and differing only by
 * type code. Once the session normalizes responses to the unified draft-16
 * shape the originating kind is lost, so the session stamps it here for the
 * draft-14 encoder to recover the wire type (it never guesses from Request ID).
 * (draft-18's SUBSCRIBE_TRACKS has no draft-14 wire error and is not listed.)
 */
export type RequestErrorKind = 'SUBSCRIBE' | 'FETCH' | 'TRACK_STATUS' | 'SUBSCRIBE_NAMESPACE';

/** @see draft-ietf-moq-transport-16 §9.8, draft-ietf-moq-transport-18 §10.6 */
export interface RequestErrorMsg {
  readonly type: 'REQUEST_ERROR';
  readonly requestId: RequestId;
  /** draft-18 §10.6.2: Error Code is a vi64 (full uint64), not QUIC-capped. */
  readonly errorCode: bigint;
  /** draft-18 §10.6.2: Retry Interval is a vi64 (full uint64), not QUIC-capped. */
  readonly retryInterval: bigint;
  readonly errorReason: string;
  /** draft-18: present iff `errorCode === REDIRECT` (0x34). Absent on 14/16. */
  readonly redirect?: Redirect;
  /**
   * Draft-14 outbound-encoding context (see {@link RequestErrorKind}). Stamped
   * by the session at reject sites; consumed by the draft-14 codec to pick the
   * specific error wire type. Ignored by the draft-16 and draft-18 codecs, and
   * never produced by decode (inbound stays normalized to REQUEST_ERROR).
   */
  readonly requestKind?: RequestErrorKind;
}

// ─── Subscription Messages §9.9–§9.12 ───────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.9 */
export interface Subscribe {
  readonly type: 'SUBSCRIBE';
  readonly requestId: RequestId;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.10 */
export interface SubscribeOk {
  readonly type: 'SUBSCRIBE_OK';
  readonly requestId: RequestId;
  readonly trackAlias: TrackAlias;
  readonly parameters: Parameters;
  /** draft-18 Track Properties (§2.5). */
  readonly trackProperties?: TrackProperties;
  /** @deprecated Use {@link trackProperties}. */
  readonly trackExtensions?: TrackProperties;
}

/** @see draft-ietf-moq-transport-16 §9.11 */
export interface RequestUpdate {
  readonly type: 'REQUEST_UPDATE';
  readonly requestId: RequestId;
  readonly existingRequestId: RequestId;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.12 */
export interface Unsubscribe {
  readonly type: 'UNSUBSCRIBE';
  readonly requestId: RequestId;
}

// ─── Publish Messages §9.13–§9.15 ───────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.13 */
export interface Publish {
  readonly type: 'PUBLISH';
  readonly requestId: RequestId;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly trackAlias: TrackAlias;
  readonly parameters: Parameters;
  /** draft-18 Track Properties (§2.5). */
  readonly trackProperties?: TrackProperties;
  /** @deprecated Use {@link trackProperties}. */
  readonly trackExtensions?: TrackProperties;
}

/** @see draft-ietf-moq-transport-16 §9.14 */
export interface PublishOk {
  readonly type: 'PUBLISH_OK';
  readonly requestId: RequestId;
  readonly parameters: Parameters;
}

/**
 * Draft-14 §9.15: PUBLISH_ERROR — rejection of a PUBLISH request.
 * Only used in draft-14 (draft-16 consolidated into REQUEST_ERROR).
 * @see draft-ietf-moq-transport-14 §9.15
 */
export interface PublishError {
  readonly type: 'PUBLISH_ERROR';
  readonly requestId: RequestId;
  readonly errorCode: Varint;
  readonly errorReason: string;
}

/** @see draft-ietf-moq-transport-16 §9.15 */
export interface PublishDone {
  readonly type: 'PUBLISH_DONE';
  readonly requestId: RequestId;
  /** Status Code / Stream Count are vi64 (full uint64) on draft-18, so `bigint`
   *  (like {@link RequestId}). The draft-14/16 encoders range-check them at the
   *  QUIC wire boundary, so a value above 2^62-1 throws there. */
  readonly statusCode: bigint;
  readonly streamCount: bigint;
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
  readonly joiningRequestId: RequestId;
  /**
   * Joining Start. vi64 in draft-18 (full uint64), so `bigint`. The draft-14/16
   * encoders still range-check it against the QUIC-varint range on encode.
   */
  readonly joiningStart: bigint;
}

/** @see draft-ietf-moq-transport-16 §9.16 */
export interface Fetch {
  readonly type: 'FETCH';
  readonly requestId: RequestId;
  readonly fetch: StandaloneFetch | JoiningFetch;
  readonly parameters: Parameters;
}

/** @see draft-ietf-moq-transport-16 §9.17 */
export interface FetchOk {
  readonly type: 'FETCH_OK';
  readonly requestId: RequestId;
  readonly endOfTrack: number; // uint8: 0 or 1
  readonly endLocation: Location;
  readonly parameters: Parameters;
  /** draft-18 Track Properties (§2.5). */
  readonly trackProperties?: TrackProperties;
  /** @deprecated Use {@link trackProperties}. */
  readonly trackExtensions?: TrackProperties;
}

/** @see draft-ietf-moq-transport-16 §9.18 */
export interface FetchCancel {
  readonly type: 'FETCH_CANCEL';
  readonly requestId: RequestId;
}

// ─── Track Status §9.19 ─────────────────────────────────────────────

/**
 * Same wire format as SUBSCRIBE.
 * @see draft-ietf-moq-transport-16 §9.19
 */
export interface TrackStatus {
  readonly type: 'TRACK_STATUS';
  readonly requestId: RequestId;
  readonly trackNamespace: Uint8Array[];
  readonly trackName: Uint8Array;
  readonly parameters: Parameters;
}

// ─── Namespace Messages §9.20–§9.25 ─────────────────────────────────

/** @see draft-ietf-moq-transport-16 §9.20 */
export interface PublishNamespace {
  readonly type: 'PUBLISH_NAMESPACE';
  readonly requestId: RequestId;
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
  readonly requestId?: RequestId;
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
  readonly requestId?: RequestId;
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
  readonly requestId: RequestId;
  readonly trackNamespacePrefix: Uint8Array[];
  readonly subscribeOptions?: Varint;
  readonly parameters: Parameters;
}

/**
 * draft-18 §10.19: request PUBLISH messages for all tracks within matching
 * namespaces. First message on a CONTINUING bidi request stream; after
 * REQUEST_OK the publisher sends PUBLISH on NEW bidi streams, while the response
 * stream itself carries PUBLISH_BLOCKED.
 * @see draft-ietf-moq-transport-18 §10.19
 */
export interface SubscribeTracks {
  readonly type: 'SUBSCRIBE_TRACKS';
  readonly requestId: RequestId;
  readonly trackNamespacePrefix: Uint8Array[];
  readonly parameters: Parameters;
}

/**
 * draft-18 §10.20: publisher indicates it cannot serve a Track within a
 * SUBSCRIBE_TRACKS namespace. Sent on the SUBSCRIBE_TRACKS response stream, so
 * it carries no Request ID — the stream context supplies it.
 * @see draft-ietf-moq-transport-18 §10.20
 */
export interface PublishBlocked {
  readonly type: 'PUBLISH_BLOCKED';
  readonly trackNamespaceSuffix: Uint8Array[];
  readonly trackName: Uint8Array;
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
  readonly requestId: RequestId;
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
  readonly requestId: RequestId;
  readonly errorCode: Varint;
  readonly errorReason: string;
}

// ─── Union Type ──────────────────────────────────────────────────────

export type ControlMessage =
  | ClientSetup
  | ServerSetup
  | Setup
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
  | SubscribeTracks
  | PublishBlocked
  | UnsubscribeNamespace
  | PublishNamespaceOk
  | PublishNamespaceError;
