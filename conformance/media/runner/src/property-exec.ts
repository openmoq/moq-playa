/**
 * Executable Layer-A `property-block-decode` path against the PRODUCTION shared
 * property-wire core (`@moqt/transport` — `decodePropertyBlock` /
 * `encodePropertyBlock`). This is the codec extracted from `kvp.ts` and
 * `track-properties-18.ts`; the corpus exercises it directly, both directions.
 *
 * @module
 */

import {
  decodePropertyBlock,
  encodePropertyBlock,
  PropertyWireError,
  type PropertyEntry,
  type PropertyMap,
  type PropertyWireProfile,
} from '@moqt/transport';
import { createHash } from 'node:crypto';
import { fromHex, toHex } from './canonical.js';
import type { ExecResult } from './exec-compare.js';
import type { PropertyMapEntryJson, WireProfile } from './schema-types.js';

/** The corpus wire profiles are exactly the transport core's profiles. */
function coreProfile(wireProfile: WireProfile): PropertyWireProfile {
  return wireProfile;
}

/** An odd-property value: inline hex up to 64 bytes, else a blob reference —
 *  matching the canonical projection the corpus was authored with. */
function projectBytes(bytes: Uint8Array): unknown {
  return bytes.length <= 64
    ? toHex(bytes)
    : { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

/** Canonical Layer-A projection: the ordered PropertyMap itself. */
export function propertyProjection(entries: PropertyMap): unknown {
  return {
    properties: entries.map((e) => ({
      id: e.id.toString(10),
      valueKind: typeof e.value === 'bigint' ? 'varint' : 'bytes',
      value: typeof e.value === 'bigint' ? e.value.toString(10) : projectBytes(e.value),
    })),
  };
}

/** Map a thrown core error to a corpus error category (never message text). */
function categorize(err: unknown): string {
  // PropertyWireError (a categorised wire violation) extends RangeError, so it
  // must be checked first; a bare RangeError is a truncated integer read.
  if (err instanceof PropertyWireError) return err.category;
  if (err instanceof RangeError) return 'truncated';
  throw err;
}

/** Build ordered core entries from an inline JSON PropertyMap. */
export function entriesFromJson(propertyMap: readonly PropertyMapEntryJson[]): PropertyEntry[] {
  return propertyMap.map((e) => ({
    id: BigInt(e.id),
    value: e.valueKind === 'varint' ? BigInt(e.value) : fromHex(e.value),
  }));
}

export interface DecodeRun {
  readonly result: ExecResult;
  /** Canonical (minimal) re-encoding of the decoded map, when decode succeeded. */
  readonly canonicalHex?: string;
}

/**
 * Decode a property block, returning the projection AND the canonical re-encoding
 * so the driver can assert BOTH the decoded PropertyMap and the minimal
 * round-trip (against `canonicalHex` for non-minimal inputs, else the input).
 */
export function runPropertyDecode(bytes: Uint8Array, wireProfile: WireProfile): DecodeRun {
  try {
    const { entries } = decodePropertyBlock(bytes, 0, { profile: coreProfile(wireProfile) });
    return { result: { status: 'ok', semantics: propertyProjection(entries) }, canonicalHex: toHex(encodePropertyBlock(entries, coreProfile(wireProfile))) };
  } catch (err) {
    return { result: { status: 'error', category: categorize(err) } };
  }
}

/** Encode an inline JSON PropertyMap to canonical minimal bytes (or a typed error). */
export function runPropertyEncode(propertyMap: readonly PropertyMapEntryJson[], wireProfile: WireProfile): ExecResult {
  try {
    const bytes = encodePropertyBlock(entriesFromJson(propertyMap), coreProfile(wireProfile));
    return { status: 'ok', bytesHex: toHex(bytes) };
  } catch (err) {
    return { status: 'error', category: categorize(err) };
  }
}
