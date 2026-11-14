/**
 * DataCodec — a thin, per-version wrapper over the data-plane decode functions.
 *
 * Today the data decoders take a trailing `version: 14 | 16` parameter and the
 * fetch-object path is a different function per draft (`decodeFetchObject` vs
 * `decodeFetchObjectV14`). Callers (the WebTransport adapter) currently thread
 * version literals and pick the fetch variant by hand. This object captures the
 * version once so the adapter stops branching, and gives draft-18 a single place
 * to slot its vi64/property rules later — without touching call sites.
 *
 * Behavior is identical to calling the underlying functions directly; this is
 * pure dispatch, no wire changes.
 *
 * @see draft-ietf-moq-transport-16 §10
 * @module
 */

import type { DraftVersion } from '../versions.js';
import { DEFAULT_DRAFT_VERSION, isWiredDraft } from '../versions.js';
import { createDataCodec18 } from './data-codec-18.js';
import {
  decodeSubgroupHeader,
  decodeSubgroupObject,
  decodeFetchHeader,
  decodeFetchObject,
  decodeFetchObjectV14,
  decodeObjectDatagram,
  decodeSubgroupObjectHeader,
  decodeFetchObjectHeader,
  decodeFetchObjectHeaderV14,
  type FetchPriorContext,
  type DecodedFetchItem,
  type FetchObjectHeaderLayout,
} from './decoder.js';
import type { FetchObjectPrior18, FetchObjectHeaderLayout18 } from './decoder-18.js';
import {
  DataStreamType,
  isSubgroupHeaderType,
  isDatagramType,
} from './codes.js';
import type {
  SubgroupHeader,
  SubgroupObject,
  FetchHeader,
  ObjectDatagram,
  GroupOrder,
  ObjectHeaderLayout,
} from './types.js';

/** Coarse classification of an incoming unidirectional data stream by its first byte. */
export type StreamClass = 'subgroup' | 'fetch' | 'setup' | 'padding' | 'unknown';

/** Coarse classification of an incoming datagram by its first byte. */
export type DatagramClass = 'object' | 'padding' | 'invalid';

/**
 * Version-bound data-plane decoder. Methods mirror the free functions in
 * `decoder.ts` but with `version` already applied and the fetch-object variant
 * already selected.
 */
export interface DataCodec {
  readonly version: DraftVersion;

  decodeSubgroupHeader(buf: Uint8Array, offset: number): { header: SubgroupHeader; bytesRead: number };

  decodeSubgroupObject(
    buf: Uint8Array,
    offset: number,
    hasExtensions: boolean,
    previousObjectId: bigint,
    isFirstObject?: boolean,
  ): { object: SubgroupObject; bytesRead: number; header: ObjectHeaderLayout };

  decodeFetchHeader(buf: Uint8Array, offset: number): { header: FetchHeader; bytesRead: number };

  /** Dispatches to the draft-14 or draft-16 fetch-object format based on version. */
  decodeFetchObject(
    buf: Uint8Array,
    offset: number,
    prior: FetchPriorContext | undefined,
    isFirstObject: boolean,
  ): { item: DecodedFetchItem; bytesRead: number; header: FetchObjectHeaderLayout };

  /**
   * Decode a draft-18 fetch object (or End-of-Range marker). Distinct from
   * {@link decodeFetchObject}: it threads a richer prior context and the FETCH's
   * requested Group Order, and returns the `nextPrior` to pass to the next call.
   * Implemented only by the draft-18 codec; draft-14/16 throw.
   * @see draft-ietf-moq-transport-18 §11.4.4
   */
  decodeFetchObject18(
    buf: Uint8Array,
    offset: number,
    prior: FetchObjectPrior18 | undefined,
    isFirstObject: boolean,
    groupOrder: GroupOrder,
  ): { item: DecodedFetchItem; bytesRead: number; nextPrior: FetchObjectPrior18; header: FetchObjectHeaderLayout18 };

  decodeObjectDatagram(buf: Uint8Array, offset: number): { datagram: ObjectDatagram; bytesRead: number };

  /**
   * Parse a subgroup object up to its payload with the grammar
   * {@link decodeSubgroupObject} uses, which returns the same layout for the
   * Object it decodes. Reads, never updates, the caller's state.
   * @throws {RangeError} when `buf` ends before the header does (read more), and
   *   wherever the complete decoder raises RangeError for an out-of-range value.
   */
  decodeSubgroupObjectHeader(
    buf: Uint8Array,
    offset: number,
    hasExtensions: boolean,
    previousObjectId: bigint,
    isFirstObject?: boolean,
  ): ObjectHeaderLayout;

  /** Draft-14/16 FETCH counterpart of {@link decodeSubgroupObjectHeader}; draft-18/22 throw. */
  decodeFetchObjectHeader(
    buf: Uint8Array,
    offset: number,
    prior: FetchPriorContext | undefined,
    isFirstObject: boolean,
  ): FetchObjectHeaderLayout;

  /** Draft-18/22 FETCH counterpart of {@link decodeSubgroupObjectHeader}; draft-14/16 throw. */
  decodeFetchObjectHeader18(
    buf: Uint8Array,
    offset: number,
    prior: FetchObjectPrior18 | undefined,
    isFirstObject: boolean,
    groupOrder: GroupOrder,
  ): FetchObjectHeaderLayout18;

  /**
   * Identify a data stream from its leading type. Buffer-based (not a single
   * byte) because draft-18 stream types are vi64 and may span multiple bytes.
   * @throws {RangeError} if `buf` is too short to read the type (read more).
   */
  classifyStream(buf: Uint8Array, offset?: number): StreamClass;

  /**
   * Identify a datagram from its leading type. Buffer-based (not a single byte)
   * because draft-18 datagram types are vi64 and the PADDING datagram
   * (0x132B3E29) spans multiple bytes.
   * @throws {RangeError} if `buf` is too short to read the type.
   */
  classifyDatagram(buf: Uint8Array, offset?: number): DatagramClass;
}

/**
 * Create a {@link DataCodec} for the given draft version.
 * @param version Draft version (default: {@link DEFAULT_DRAFT_VERSION}).
 *   Drafts 14, 16, 18, 22 and 23 are wired.
 * @throws {Error} for draft versions without a wired data codec.
 */
export function createDataCodec(version: DraftVersion = DEFAULT_DRAFT_VERSION): DataCodec {
  if (version === 18 || version === 22 || version === 23) {
    return createDataCodec18(version);
  }
  if (!isWiredDraft(version)) {
    throw new Error(`DataCodec: draft-${version} data plane is not yet implemented`);
  }
  const v = version;
  return {
    version: v,

    decodeSubgroupHeader: (buf, offset) => decodeSubgroupHeader(buf, offset, v),

    decodeSubgroupObject: (buf, offset, hasExtensions, previousObjectId, isFirstObject = true) =>
      decodeSubgroupObject(buf, offset, hasExtensions, previousObjectId, isFirstObject, v),

    decodeFetchHeader: (buf, offset) => decodeFetchHeader(buf, offset),

    decodeFetchObject: (buf, offset, prior, isFirstObject) =>
      v === 14
        ? decodeFetchObjectV14(buf, offset)
        : decodeFetchObject(buf, offset, prior, isFirstObject),

    decodeFetchObject18: () => {
      throw new Error(`DataCodec: decodeFetchObject18 is draft-18 only (this codec is draft-${v})`);
    },

    decodeObjectDatagram: (buf, offset) => decodeObjectDatagram(buf, offset, v),

    decodeSubgroupObjectHeader: (buf, offset, hasExtensions, previousObjectId, isFirstObject = true) =>
      decodeSubgroupObjectHeader(buf, offset, hasExtensions, previousObjectId, isFirstObject, v),

    decodeFetchObjectHeader: (buf, offset, prior, isFirstObject) =>
      v === 14
        ? decodeFetchObjectHeaderV14(buf, offset)
        : decodeFetchObjectHeader(buf, offset, prior, isFirstObject),

    decodeFetchObjectHeader18: () => {
      throw new Error(`DataCodec: decodeFetchObjectHeader18 is draft-18 only (this codec is draft-${v})`);
    },

    classifyStream: (buf, offset = 0) => {
      // draft-14/16 stream types are a single byte; read it directly.
      if (offset >= buf.length) {
        throw new RangeError(`classifyStream: offset ${offset} out of bounds (length ${buf.length})`);
      }
      const firstByte = buf[offset]!;
      if (firstByte === DataStreamType.FETCH_HEADER) return 'fetch';
      if (isSubgroupHeaderType(firstByte, v)) return 'subgroup';
      return 'unknown';
    },

    classifyDatagram: (buf, offset = 0) => {
      // draft-14/16 datagram types are a single byte; read it directly.
      if (offset >= buf.length) {
        throw new RangeError(`classifyDatagram: offset ${offset} out of bounds (length ${buf.length})`);
      }
      return isDatagramType(buf[offset]!, v) ? 'object' : 'invalid';
    },
  };
}
