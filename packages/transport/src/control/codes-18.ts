/**
 * draft-18 wire code tables.
 *
 * Distinct from the draft-16 tables (`./codes.ts`, `./parameters.ts`) because
 * draft-18 renumbers and adds/removes several codes: a unified SETUP (0x2F00)
 * replaces CLIENT_SETUP/SERVER_SETUP; SUBSCRIBE_NAMESPACE splits into 0x50 +
 * SUBSCRIBE_TRACKS 0x51; UNSUBSCRIBE/FETCH_CANCEL/MAX_REQUEST_ID/REQUESTS_BLOCKED
 * are removed; PUBLISH_BLOCKED 0x0F is new. All values verified against the
 * draft-18 IANA registries.
 *
 * Values are plain numbers; on the wire they are encoded with vi64
 * (`../primitives/vi64.ts`), so the multi-byte SETUP type (0x2F00) is fine.
 *
 * @see draft-ietf-moq-transport-18 §16 (IANA), §3.4 (stream types), §11.4 (data)
 * @module
 */

/**
 * draft-18 control message type codes (§16 message type registry).
 * Removed in draft-18: CLIENT_SETUP, SERVER_SETUP, UNSUBSCRIBE, FETCH_CANCEL,
 * MAX_REQUEST_ID, REQUESTS_BLOCKED, PUBLISH_NAMESPACE_DONE, PUBLISH_NAMESPACE_CANCEL.
 *
 * PUBLISH_OK: a PUBLISH is accepted with the REQUEST_OK shorthand (wire type
 * 0x07), per §10.5; the standalone 0x1E PUBLISH_OK message of draft-14/16 was
 * removed in draft-18 (changelog). So this table has no 0x1E entry — the codec
 * neither encodes nor decodes a draft-18 PUBLISH_OK, and a 0x1E on a draft-18
 * control stream is rejected as an unknown type. (The draft-18 spec's message
 * table still lists 0x1E PUBLISH_OK; we treat §10.5 + the changelog as
 * authoritative and intentionally do not implement it.)
 */
export const ControlMessageType18 = {
  REQUEST_UPDATE: 0x02,
  SUBSCRIBE: 0x03,
  SUBSCRIBE_OK: 0x04,
  REQUEST_ERROR: 0x05,
  PUBLISH_NAMESPACE: 0x06,
  REQUEST_OK: 0x07,
  NAMESPACE: 0x08,
  PUBLISH_DONE: 0x0b,
  TRACK_STATUS: 0x0d,
  NAMESPACE_DONE: 0x0e,
  PUBLISH_BLOCKED: 0x0f,
  GOAWAY: 0x10,
  FETCH: 0x16,
  FETCH_OK: 0x18,
  PUBLISH: 0x1d,
  // PUBLISH_OK (0x1E) intentionally omitted — see the note above (REQUEST_OK shorthand).
  SUBSCRIBE_NAMESPACE: 0x50,
  SUBSCRIBE_TRACKS: 0x51,
  /** Unified setup message; also the control-stream stream type. */
  SETUP: 0x2f00,
} as const;

/**
 * draft-18 Setup Option codes (§10.3.1). KVP-encoded, no count, span the payload.
 * MAX_REQUEST_ID (draft-16 0x02) is removed.
 */
export const SetupOption18 = {
  PATH: 0x01,
  AUTHORIZATION_TOKEN: 0x03,
  MAX_AUTH_TOKEN_CACHE_SIZE: 0x04,
  AUTHORITY: 0x05,
  MOQT_IMPLEMENTATION: 0x07,
} as const;

/**
 * Value-encoding kind for a draft-18 message parameter (§10.2).
 * `namespace` is a Track Namespace structure (§2.4.1): a vi64 field count
 * followed by that many vi64-length-prefixed fields (used by TRACK_NAMESPACE_PREFIX).
 */
export type ParamValueKind = 'uint8' | 'varint' | 'location' | 'bytes' | 'namespace';

/**
 * draft-18 Message Parameter codes + their value encodings (§10.2 registry).
 * Message parameters use Type-Delta (vi64) + a per-type value (NOT KVP parity).
 * DELIVERY_TIMEOUT splits into OBJECT_/SUBGROUP_; RENDEZVOUS_/FILL_TIMEOUT and
 * TRACK_NAMESPACE_PREFIX are new.
 */
export const MessageParam18: Record<string, { type: number; kind: ParamValueKind }> = {
  OBJECT_DELIVERY_TIMEOUT: { type: 0x02, kind: 'varint' },
  AUTHORIZATION_TOKEN: { type: 0x03, kind: 'bytes' },
  RENDEZVOUS_TIMEOUT: { type: 0x04, kind: 'varint' },
  SUBGROUP_DELIVERY_TIMEOUT: { type: 0x06, kind: 'varint' },
  EXPIRES: { type: 0x08, kind: 'varint' },
  LARGEST_OBJECT: { type: 0x09, kind: 'location' },
  FILL_TIMEOUT: { type: 0x0a, kind: 'varint' },
  FORWARD: { type: 0x10, kind: 'uint8' },
  SUBSCRIBER_PRIORITY: { type: 0x20, kind: 'uint8' },
  SUBSCRIPTION_FILTER: { type: 0x21, kind: 'bytes' },
  GROUP_ORDER: { type: 0x22, kind: 'uint8' },
  NEW_GROUP_REQUEST: { type: 0x32, kind: 'varint' },
  TRACK_NAMESPACE_PREFIX: { type: 0x34, kind: 'namespace' },
} as const;

/** Property type ranges (§2.5, §12). Properties are carried by control messages
 * (Track Properties) and data objects (Object Properties); the type-space is shared. */
export const PropertyRange18 = {
  /** Immutable Properties container (Track scope), added by original publisher only. */
  IMMUTABLE: 0x0b,
  /** Mandatory Track Properties: must be understood or refuse with UNSUPPORTED_EXTENSION. */
  MANDATORY_MIN: 0x4000,
  MANDATORY_MAX: 0x7fff,
} as const;

/** Whether a property type is a Mandatory Track Property (0x4000–0x7FFF, §2.5.1). */
export function isMandatoryProperty(type: number): boolean {
  return type >= PropertyRange18.MANDATORY_MIN && type <= PropertyRange18.MANDATORY_MAX;
}
