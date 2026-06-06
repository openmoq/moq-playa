/**
 * Draft18DataCodec — the draft-18 implementation of {@link DataCodec}.
 *
 * Wraps the vi64 decoders in `decoder-18.ts` and the vi64 stream classifier in
 * `stream-type-18.ts`: subgroup streams, object datagrams, and FETCH data
 * (FETCH_HEADER + the §11.4.4 fetch-object format) all decode. The legacy
 * draft-16-shaped `decodeFetchObject` is NOT used for draft-18 — callers use
 * {@link DataCodec.decodeFetchObject18} (group-order aware, threads prior).
 *
 * @see draft-ietf-moq-transport-18 §11.3–§11.4
 * @module
 */

import type { DataCodec, StreamClass, DatagramClass } from './data-codec.js';
import {
  decodeSubgroupHeader18,
  decodeSubgroupObject18,
  decodeObjectDatagram18,
  decodeFetchHeader18,
  decodeFetchObject18,
} from './decoder-18.js';
import { classifyStream18, classifyDatagram18 } from './stream-type-18.js';

/** Create the draft-18 {@link DataCodec}. */
export function createDataCodec18(): DataCodec {
  return {
    version: 18,

    decodeSubgroupHeader: (buf, offset) => decodeSubgroupHeader18(buf, offset),

    decodeSubgroupObject: (buf, offset, hasProperties, previousObjectId, isFirstObject = true) =>
      decodeSubgroupObject18(buf, offset, hasProperties, previousObjectId, isFirstObject),

    decodeFetchHeader: (buf, offset) => decodeFetchHeader18(buf, offset),

    decodeFetchObject: () => {
      throw new Error('Draft18DataCodec: use decodeFetchObject18 for draft-18 fetch streams');
    },

    decodeFetchObject18: (buf, offset, prior, isFirstObject, groupOrder) =>
      decodeFetchObject18(buf, offset, prior, isFirstObject, groupOrder),

    decodeObjectDatagram: (buf, offset) => decodeObjectDatagram18(buf, offset),

    classifyStream: (buf, offset = 0): StreamClass => classifyStream18(buf, offset).kind,

    classifyDatagram: (buf, offset = 0): DatagramClass => classifyDatagram18(buf, offset),
  };
}
