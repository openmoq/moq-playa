/**
 * Setup and message parameter type codes.
 * @see draft-ietf-moq-transport-16 §9.2.2, §9.3.1
 * @module
 */

import { varint } from '../primitives/varint.js';

/**
 * Setup parameter type codes (version-independent).
 * @see draft-ietf-moq-transport-16 §9.3.1
 */
export const SetupParam = {
  /** @see §9.3.1.2 */
  PATH: varint(0x01),
  /** @see §9.3.1.3 */
  MAX_REQUEST_ID: varint(0x02),
  /** @see §9.3.1.5 */
  AUTHORIZATION_TOKEN: varint(0x03),
  /** @see §9.3.1.4 */
  MAX_AUTH_TOKEN_CACHE_SIZE: varint(0x04),
  /** @see §9.3.1.1 */
  AUTHORITY: varint(0x05),
  /** @see §9.3.1.6 */
  MOQT_IMPLEMENTATION: varint(0x07),
} as const;

/**
 * Message parameter type codes (version-specific).
 * @see draft-ietf-moq-transport-16 §9.2.2
 */
export const MessageParam = {
  /** @see §9.2.2.2 */
  DELIVERY_TIMEOUT: varint(0x02),
  /**
   * draft-18 §10.2.4: OBJECT_DELIVERY_TIMEOUT — same wire type (0x02) as the
   * draft-14/16 DELIVERY_TIMEOUT; named alias for the draft-18 scope tables.
   */
  OBJECT_DELIVERY_TIMEOUT: varint(0x02),
  /** @see §9.2.2.1 */
  AUTHORIZATION_TOKEN: varint(0x03),
  /** draft-18 §10.2.6: RENDEZVOUS_TIMEOUT — SUBSCRIBE only. */
  RENDEZVOUS_TIMEOUT: varint(0x04),
  /** draft-18 §10.2.3: SUBGROUP_DELIVERY_TIMEOUT — PUBLISH_OK / SUBSCRIBE / REQUEST_UPDATE. */
  SUBGROUP_DELIVERY_TIMEOUT: varint(0x06),
  /** @see §9.2.2.6 */
  EXPIRES: varint(0x08),
  /** @see §9.2.2.7 */
  LARGEST_OBJECT: varint(0x09),
  /** draft-18 §10.2.5: FILL_TIMEOUT — FETCH only. */
  FILL_TIMEOUT: varint(0x0a),
  /** @see §9.2.2.8 */
  FORWARD: varint(0x10),
  /** @see §9.2.2.3 */
  SUBSCRIBER_PRIORITY: varint(0x20),
  /** @see §9.2.2.5 */
  SUBSCRIPTION_FILTER: varint(0x21),
  /** @see §9.2.2.4 */
  GROUP_ORDER: varint(0x22),
  /** @see §9.2.2.9 */
  NEW_GROUP_REQUEST: varint(0x32),
  /**
   * draft-18 §10.2.14: Track Namespace Prefix. Carried in REQUEST_UPDATE to
   * change the prefix of a SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS. Its value is a
   * Track Namespace tuple (semantic `Uint8Array[]`), not a KVP scalar — the
   * draft-14/16 codecs reject it at the KVP boundary.
   */
  TRACK_NAMESPACE_PREFIX: varint(0x34),
} as const;
