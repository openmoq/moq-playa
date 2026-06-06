/**
 * MOQT error code registries.
 * @see draft-ietf-moq-transport-16 §13.4
 * @module
 */

import { varint } from './primitives/varint.js';

/**
 * Session Termination Error Codes.
 * @see draft-ietf-moq-transport-16 §13.4.1
 */
export const SessionError = {
  NO_ERROR: varint(0x0),
  INTERNAL_ERROR: varint(0x1),
  UNAUTHORIZED: varint(0x2),
  PROTOCOL_VIOLATION: varint(0x3),
  INVALID_REQUEST_ID: varint(0x4),
  DUPLICATE_TRACK_ALIAS: varint(0x5),
  KEY_VALUE_FORMATTING_ERROR: varint(0x6),
  TOO_MANY_REQUESTS: varint(0x7),
  INVALID_PATH: varint(0x8),
  MALFORMED_PATH: varint(0x9),
  GOAWAY_TIMEOUT: varint(0x10),
  CONTROL_MESSAGE_TIMEOUT: varint(0x11),
  DATA_STREAM_TIMEOUT: varint(0x12),
  AUTH_TOKEN_CACHE_OVERFLOW: varint(0x13),
  DUPLICATE_AUTH_TOKEN_ALIAS: varint(0x14),
  VERSION_NEGOTIATION_FAILED: varint(0x15),
  MALFORMED_AUTH_TOKEN: varint(0x16),
  UNKNOWN_AUTH_TOKEN_ALIAS: varint(0x17),
  EXPIRED_AUTH_TOKEN: varint(0x18),
  INVALID_AUTHORITY: varint(0x19),
  MALFORMED_AUTHORITY: varint(0x1a),
} as const;

/**
 * REQUEST_ERROR codes.
 * @see draft-ietf-moq-transport-16 §13.4.2
 */
export const RequestError = {
  INTERNAL_ERROR: varint(0x0),
  UNAUTHORIZED: varint(0x1),
  TIMEOUT: varint(0x2),
  NOT_SUPPORTED: varint(0x3),
  MALFORMED_AUTH_TOKEN: varint(0x4),
  EXPIRED_AUTH_TOKEN: varint(0x5),
  DOES_NOT_EXIST: varint(0x10),
  INVALID_RANGE: varint(0x11),
  MALFORMED_TRACK: varint(0x12),
  DUPLICATE_SUBSCRIPTION: varint(0x19),
  UNINTERESTED: varint(0x20),
  PREFIX_OVERLAP: varint(0x30),
  NAMESPACE_TOO_LARGE: varint(0x31),
  INVALID_JOINING_REQUEST_ID: varint(0x32),
  /** draft-18 §2.5.1: a Mandatory Track Property the endpoint does not understand. */
  UNSUPPORTED_EXTENSION: varint(0x33),
  /** draft-18 §10.6.2: the request is redirected; the body carries a Redirect. */
  REDIRECT: varint(0x34),
} as const;

/**
 * PUBLISH_DONE Status Codes — **draft-14/16** (legacy).
 *
 * NOTE: draft-18 renumbers this table — EXPIRED and TOO_FAR_BEHIND are swapped
 * (0x5↔0x6) and EXCESSIVE_LOAD (0x9) is added. Use {@link PublishDoneCode18} for
 * draft-18; this export is retained unchanged for draft-14/16 compatibility.
 * @see draft-ietf-moq-transport-16 §13.4.3
 */
export const PublishDoneCode = {
  INTERNAL_ERROR: varint(0x0),
  UNAUTHORIZED: varint(0x1),
  TRACK_ENDED: varint(0x2),
  SUBSCRIPTION_ENDED: varint(0x3),
  GOING_AWAY: varint(0x4),
  EXPIRED: varint(0x5),
  TOO_FAR_BEHIND: varint(0x6),
  UPDATE_FAILED: varint(0x8),
  MALFORMED_TRACK: varint(0x12),
} as const;

/**
 * Data Stream Reset Error Codes — **draft-14/16** (legacy).
 *
 * NOTE: draft-18 renumbers this table (see {@link StreamResetCode18}) —
 * UNKNOWN_OBJECT_STATUS moves from 0x4 to 0x6, and 0x4 becomes GOING_AWAY. This
 * export is retained unchanged for draft-14/16 compatibility.
 * @see draft-ietf-moq-transport-16 §13.4.4
 */
export const DataStreamError = {
  INTERNAL_ERROR: varint(0x0),
  CANCELLED: varint(0x1),
  DELIVERY_TIMEOUT: varint(0x2),
  SESSION_CLOSED: varint(0x3),
  UNKNOWN_OBJECT_STATUS: varint(0x4),
  MALFORMED_TRACK: varint(0x12),
} as const;

// ─── draft-18 error code registries (canonical) ──────────────────────────────
// draft-18 renumbers several registries; these are the authoritative draft-18
// tables. The legacy exports above stay frozen for draft-14/16. Consumers select
// the registry by the negotiated draft version.

/**
 * REQUEST_ERROR codes — **draft-18** (§15.10.2). Superset of the legacy table:
 * adds GOING_AWAY (0x6) and EXCESSIVE_LOAD (0x9).
 */
export const RequestError18 = {
  INTERNAL_ERROR: varint(0x0),
  UNAUTHORIZED: varint(0x1),
  TIMEOUT: varint(0x2),
  NOT_SUPPORTED: varint(0x3),
  MALFORMED_AUTH_TOKEN: varint(0x4),
  EXPIRED_AUTH_TOKEN: varint(0x5),
  GOING_AWAY: varint(0x6),
  EXCESSIVE_LOAD: varint(0x9),
  DOES_NOT_EXIST: varint(0x10),
  INVALID_RANGE: varint(0x11),
  MALFORMED_TRACK: varint(0x12),
  DUPLICATE_SUBSCRIPTION: varint(0x19),
  UNINTERESTED: varint(0x20),
  PREFIX_OVERLAP: varint(0x30),
  NAMESPACE_TOO_LARGE: varint(0x31),
  INVALID_JOINING_REQUEST_ID: varint(0x32),
  UNSUPPORTED_EXTENSION: varint(0x33),
  REDIRECT: varint(0x34),
} as const;

/**
 * PUBLISH_DONE Status Codes — **draft-18** (§15.10.3). Differs from legacy:
 * TOO_FAR_BEHIND = 0x5 and EXPIRED = 0x6 (swapped), plus EXCESSIVE_LOAD (0x9).
 */
export const PublishDoneCode18 = {
  INTERNAL_ERROR: varint(0x0),
  UNAUTHORIZED: varint(0x1),
  TRACK_ENDED: varint(0x2),
  SUBSCRIPTION_ENDED: varint(0x3),
  GOING_AWAY: varint(0x4),
  TOO_FAR_BEHIND: varint(0x5),
  EXPIRED: varint(0x6),
  UPDATE_FAILED: varint(0x8),
  EXCESSIVE_LOAD: varint(0x9),
  MALFORMED_TRACK: varint(0x12),
} as const;

/**
 * Stream Reset Error Codes — **draft-18** (§15.10.4), the canonical draft-18 name
 * for what draft-14/16 called {@link DataStreamError}. Differs from legacy:
 * GOING_AWAY = 0x4, TOO_FAR_BEHIND = 0x5, UNKNOWN_OBJECT_STATUS moves to 0x6, plus
 * EXPIRED_AUTH_TOKEN (0x7) and EXCESSIVE_LOAD (0x9).
 */
export const StreamResetCode18 = {
  INTERNAL_ERROR: varint(0x0),
  CANCELLED: varint(0x1),
  DELIVERY_TIMEOUT: varint(0x2),
  SESSION_CLOSED: varint(0x3),
  GOING_AWAY: varint(0x4),
  TOO_FAR_BEHIND: varint(0x5),
  UNKNOWN_OBJECT_STATUS: varint(0x6),
  EXPIRED_AUTH_TOKEN: varint(0x7),
  EXCESSIVE_LOAD: varint(0x9),
  MALFORMED_TRACK: varint(0x12),
} as const;

/** @deprecated Use {@link StreamResetCode18} — the canonical draft-18 name. */
export const DataStreamError18 = StreamResetCode18;

// ─── Typed Error Classes ──────────────────────────────────────────────

/**
 * Thrown when a MOQT protocol violation is detected that requires
 * the session to be closed with PROTOCOL_VIOLATION (0x3).
 *
 * Used by decoders and validators to signal violations that the
 * I/O layer (adapter) must convert into session closure. Using a
 * typed class instead of string matching ensures reliable detection.
 *
 * @see draft-ietf-moq-transport-16 §9 (malformed control messages)
 * @see draft-ietf-moq-transport-16 §10.4 (data stream violations)
 * @see draft-ietf-moq-transport-16 §10.3.1 (datagram violations)
 */
export class ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolViolationError';
  }
}
