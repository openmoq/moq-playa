/**
 * Data plane type definitions.
 * @see draft-ietf-moq-transport-16 §10
 * @module
 */

import type { Varint } from '../primitives/varint.js';

/**
 * SUBGROUP_HEADER parsed from a data stream.
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export interface SubgroupHeader {
  /** Raw type byte (0x10-0x1F or 0x30-0x3F). */
  readonly typeByte: number;
  /** Track alias identifying the track. */
  readonly trackAlias: Varint;
  /** Group ID for all objects on this stream. */
  readonly groupId: Varint;
  /** Subgroup ID (derived from mode or explicit). */
  readonly subgroupId: Varint;
  /** Publisher priority (0-255), or undefined if DEFAULT_PRIORITY flag set. */
  readonly publisherPriority: number | undefined;
  /** Whether extensions are present in objects on this stream. */
  readonly hasExtensions: boolean;
  /** Whether this subgroup contains the largest object in the group. */
  readonly isEndOfGroup: boolean;
}

/**
 * FETCH_HEADER parsed from a data stream.
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export interface FetchHeader {
  /** Request ID matching the FETCH control message. */
  readonly requestId: Varint;
}

/**
 * A single object within a subgroup stream.
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export interface SubgroupObject {
  /** Object ID (computed from delta). */
  readonly objectId: Varint;
  /** Extension headers if present. */
  readonly extensions: Uint8Array | undefined;
  /** Object payload (empty if status object). */
  readonly payload: Uint8Array;
  /** Object status (only meaningful if payload is empty). */
  readonly status: Varint | undefined;
}

/**
 * A single object within a fetch stream.
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export interface FetchObject {
  /** Serialization flags byte. */
  readonly flags: Varint;
  /** Group ID (may be inherited from prior object). */
  readonly groupId: Varint;
  /** Subgroup ID (may be inherited or derived). */
  readonly subgroupId: Varint;
  /** Object ID (may be inherited from prior object + 1). */
  readonly objectId: Varint;
  /** Publisher priority (may be inherited). */
  readonly publisherPriority: number | undefined;
  /** Whether this object was sent as a datagram originally. */
  readonly isDatagram: boolean;
  /** Extension headers if present. */
  readonly extensions: Uint8Array | undefined;
  /** Object payload. */
  readonly payload: Uint8Array;
}

/**
 * Special fetch marker indicating a range of non-existent objects.
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export interface FetchEndOfRange {
  /** The special flags value (0x8C or 0x10C). */
  readonly flags: Varint;
  /** Group ID of the range end. */
  readonly groupId: Varint;
  /** Object ID of the range end. */
  readonly objectId: Varint;
  /** Whether objects are known to not exist (true) or status unknown (false). */
  readonly nonExistent: boolean;
  /**
   * Raw Object Status code from the wire.
   * Present in draft-14 fetch status objects to preserve exact status semantics
   * (OBJECT_DOES_NOT_EXIST=0x1, END_OF_GROUP=0x3, END_OF_TRACK=0x4).
   * @see draft-ietf-moq-transport-14 §10.4.4
   */
  readonly rawStatus?: Varint;
}

/**
 * OBJECT_DATAGRAM parsed from a datagram.
 * @see draft-ietf-moq-transport-16 §10.3.1
 */
export interface ObjectDatagram {
  /** Raw type byte (0x00-0x0F or 0x20-0x2F). */
  readonly typeByte: number;
  /** Track alias identifying the track. */
  readonly trackAlias: Varint;
  /** Group ID. */
  readonly groupId: Varint;
  /** Object ID (1 if ZERO_OBJECT_ID flag set). */
  readonly objectId: Varint;
  /** Publisher priority, or undefined if DEFAULT_PRIORITY flag set. */
  readonly publisherPriority: number | undefined;
  /** Whether this is the last object in the group. */
  readonly isEndOfGroup: boolean;
  /** Extension headers if present. */
  readonly extensions: Uint8Array | undefined;
  /** Object payload (empty if status object). */
  readonly payload: Uint8Array;
  /** Object status (only present if STATUS flag set). */
  readonly status: Varint | undefined;
}

/**
 * Discriminated union of data stream header types.
 */
export type DataStreamHeader =
  | { readonly type: 'subgroup'; readonly header: SubgroupHeader }
  | { readonly type: 'fetch'; readonly header: FetchHeader };

/**
 * Discriminated union for objects delivered via subscription.
 * Includes both normal objects and gap signals.
 * @see draft-ietf-moq-transport-16 §10.2
 */
export type MoqtObject =
  | MoqtObjectData
  | MoqtObjectGap;

/**
 * A normal object with payload data.
 */
export interface MoqtObjectData {
  readonly kind: 'data';
  readonly trackAlias: Varint;
  readonly groupId: Varint;
  readonly subgroupId: Varint;
  readonly objectId: Varint;
  readonly publisherPriority: number | undefined;
  readonly extensions: Uint8Array | undefined;
  readonly payload: Uint8Array;
}

/**
 * A gap signal indicating missing or terminated objects.
 */
export interface MoqtObjectGap {
  readonly kind: 'gap';
  readonly trackAlias: Varint;
  readonly groupId: Varint;
  readonly subgroupId: Varint;
  readonly objectId: Varint;
  /** The status code explaining the gap. */
  readonly status: Varint;
}
