/**
 * Data plane type codes and constants.
 * @see draft-ietf-moq-transport-16 §10
 * @module
 */

import { varint } from '../primitives/varint.js';

/**
 * Object Status codes.
 * @see draft-ietf-moq-transport-16 §10.2.1.1
 */
export const ObjectStatus = {
  /** Normal object (implicit for non-zero length payloads). */
  NORMAL: varint(0x0),
  /**
   * Object does not exist at any publisher. Valid in draft-14.
   * @see draft-ietf-moq-transport-14 §10.2.1.1
   */
  OBJECT_DOES_NOT_EXIST: varint(0x1),
  /** No objects with same Group ID and Object ID >= this exist. */
  END_OF_GROUP: varint(0x3),
  /** No objects at location >= this exist. */
  END_OF_TRACK: varint(0x4),
} as const;

/**
 * Data stream header types.
 * @see draft-ietf-moq-transport-16 §10.4
 */
export const DataStreamType = {
  /** FETCH_HEADER - fixed type byte. */
  FETCH_HEADER: 0x05,
} as const;

/**
 * SUBGROUP_HEADER type byte bit flags.
 * Type byte format: 0b00X1XXXX (bit 4 always set).
 * Valid ranges: 0x10-0x1F, 0x30-0x3F.
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export const SubgroupFlags = {
  /** Extensions present in all objects on this stream. */
  EXTENSIONS: 0x01,
  /** Subgroup ID mode mask (bits 1-2). */
  SUBGROUP_ID_MODE_MASK: 0x06,
  /** Subgroup contains largest object in group. */
  END_OF_GROUP: 0x08,
  /** Bit 4 - always set for subgroup headers. */
  SUBGROUP_MARKER: 0x10,
  /** Priority field omitted (inherit from subscription). */
  DEFAULT_PRIORITY: 0x20,
} as const;

/**
 * Subgroup ID modes (extracted from type byte bits 1-2).
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export const SubgroupIdMode = {
  /** Subgroup ID = 0 (field absent). */
  ZERO: 0b00,
  /** Subgroup ID = first Object ID in subgroup (field absent). */
  FIRST_OBJECT: 0b01,
  /** Subgroup ID field present in header. */
  EXPLICIT: 0b10,
  /** Reserved - PROTOCOL_VIOLATION if received. */
  RESERVED: 0b11,
} as const;

/**
 * OBJECT_DATAGRAM type byte bit flags.
 * Type byte format: 0b00X0XXXX (bit 4 always clear).
 * Valid ranges: 0x00-0x0F, 0x20-0x2F.
 * @see draft-ietf-moq-transport-16 §10.3.1
 */
export const DatagramFlags = {
  /** Extensions field present. */
  EXTENSIONS: 0x01,
  /** No object with same Group ID and Object ID > current exists. */
  END_OF_GROUP: 0x02,
  /** Object ID field omitted (Object ID = 1). */
  ZERO_OBJECT_ID: 0x04,
  /** Priority field omitted (inherit from subscription). */
  DEFAULT_PRIORITY: 0x08,
  /** Object Status present instead of payload. */
  STATUS: 0x20,
} as const;

/**
 * FETCH object serialization flags.
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export const FetchFlags = {
  /** Subgroup encoding mode mask (bits 0-1). */
  SUBGROUP_MODE_MASK: 0x03,
  /** Object ID field present. */
  OBJECT_ID: 0x04,
  /** Group ID field present. */
  GROUP_ID: 0x08,
  /** Priority field present. */
  PRIORITY: 0x10,
  /** Extensions field present. */
  EXTENSIONS: 0x20,
  /** Datagram object (ignore subgroup bits). */
  DATAGRAM: 0x40,
} as const;

/**
 * Fetch subgroup encoding modes (bits 0-1 of serialization flags).
 * @see draft-ietf-moq-transport-16 §10.4.4.1
 */
export const FetchSubgroupMode = {
  /** Subgroup ID = 0. */
  ZERO: 0x00,
  /** Subgroup ID = prior object's Subgroup ID. */
  PRIOR: 0x01,
  /** Subgroup ID = prior object's Subgroup ID + 1. */
  PRIOR_PLUS_ONE: 0x02,
  /** Subgroup ID field present. */
  EXPLICIT: 0x03,
} as const;

/**
 * Special serialization flag values for FETCH streams.
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export const FetchSpecialFlags = {
  /** End of Non-Existent Range - objects in range don't exist. */
  END_NON_EXISTENT: 0x8c,
  /** End of Unknown Range - object status unknown. */
  END_UNKNOWN: 0x10c,
} as const;

/**
 * Check if a type byte is a valid SUBGROUP_HEADER type.
 *
 * Draft-16: 0b00X1XXXX (0x10-0x1F, 0x30-0x3F).
 * Draft-14: 0x10..0x1D only (12 types, no DEFAULT_PRIORITY range).
 *
 * @see draft-ietf-moq-transport-16 §10.4.2
 * @see draft-ietf-moq-transport-14 §10.4.2
 */
export function isSubgroupHeaderType(type: number, version: 14 | 16 = 16): boolean {
  if (version === 14) {
    // Draft-14: 0x10..0x1D (12 defined types, mode 0b11 reserved = 0x16/0x17 excluded)
    return type >= 0x10 && type <= 0x1d && (type & 0x06) !== 0x06;
  }
  // Draft-16: bit 4 set, bits 6-7 clear, max 0x3F
  return type <= 0x3f && (type & 0x10) !== 0 && (type & 0xc0) === 0;
}

/**
 * Check if a type byte is a valid OBJECT_DATAGRAM type.
 *
 * Draft-16: 0b00X0XXXX (0x00-0x0F, 0x20-0x2F).
 * Draft-14: 0x0-0x7, 0x20-0x21 (10 defined types, no DEFAULT_PRIORITY bit).
 *
 * @see draft-ietf-moq-transport-16 §10.3.1
 * @see draft-ietf-moq-transport-14 §10.3.1
 */
export function isDatagramType(type: number, version: 14 | 16 = 16): boolean {
  if (version === 14) {
    // Draft-14: 0x0-0x7 (8 types) and 0x20-0x21 (2 types)
    return (type >= 0x00 && type <= 0x07) || (type >= 0x20 && type <= 0x21);
  }
  // Draft-16: bit 4 clear, bits 6-7 clear, max 0x2F
  return type <= 0x2f && (type & 0x10) === 0 && (type & 0xc0) === 0;
}

/**
 * Check if a SUBGROUP_HEADER type byte has a valid subgroup ID mode.
 * Mode 0b11 is reserved and causes PROTOCOL_VIOLATION.
 */
export function isValidSubgroupIdMode(type: number): boolean {
  const mode = (type & SubgroupFlags.SUBGROUP_ID_MODE_MASK) >> 1;
  return mode !== SubgroupIdMode.RESERVED;
}

/**
 * Check if a DATAGRAM type byte has invalid flag combinations.
 * STATUS + END_OF_GROUP together is invalid.
 */
export function isValidDatagramFlags(type: number): boolean {
  const hasStatus = (type & DatagramFlags.STATUS) !== 0;
  const hasEndOfGroup = (type & DatagramFlags.END_OF_GROUP) !== 0;
  // STATUS and END_OF_GROUP cannot both be set
  return !(hasStatus && hasEndOfGroup);
}

/**
 * Extract subgroup ID mode from SUBGROUP_HEADER type byte.
 */
export function getSubgroupIdMode(type: number): number {
  return (type & SubgroupFlags.SUBGROUP_ID_MODE_MASK) >> 1;
}
