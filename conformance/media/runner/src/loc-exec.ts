/**
 * Executable LOC-properties path (Layer A+B, end-to-end) against CURRENT
 * production code (`parseLocHeaders`). Shared by the authoring script (to
 * capture `currentBehavior`) and the runtime tests (to re-run and compare), so
 * the two agree by construction and the test becomes a genuine regression pin
 * against FUTURE drift.
 *
 * @module
 */

import { parseLocHeaders, encodeLocHeaders, resolveLocHeaders, type LocHeaders } from '@moqt/loc';
import { PropertyWireError } from '@moqt/transport';
import { toHex } from './canonical.js';
import type { ExecResult } from './exec-compare.js';
import type { PropertyMapEntryJson, WireProfile } from './schema-types.js';
import { entriesFromJson } from './property-exec.js';

export type LocRunResult = ExecResult;

/** Canonical projection of parsed LocHeaders (wide ints as decimal strings). */
export function locProjection(h: LocHeaders): unknown {
  const out: Record<string, unknown> = {};
  if (h.captureTimestamp !== undefined) out['captureTimestamp'] = h.captureTimestamp.toString(10);
  if (h.videoFrameMarking !== undefined) {
    const v = h.videoFrameMarking;
    const vfm: Record<string, unknown> = {
      startOfFrame: v.startOfFrame,
      endOfFrame: v.endOfFrame,
      independent: v.independent,
      discardable: v.discardable,
      baseLayerSync: v.baseLayerSync,
      temporalId: v.temporalId,
    };
    if (v.layerId !== undefined) vfm['layerId'] = v.layerId;
    out['videoFrameMarking'] = vfm;
  }
  if (h.audioLevel !== undefined) {
    out['audioLevel'] = { voiceActivity: h.audioLevel.voiceActivity, level: h.audioLevel.level };
  }
  if (h.videoConfig !== undefined) out['videoConfig'] = toHex(h.videoConfig);
  if (h.unknown !== undefined) {
    out['unknown'] = [...h.unknown.entries()].map(([id, val]) => ({
      id: id.toString(10),
      name: null, // canonical contract: an unknown id carries an explicit null name
      value: typeof val === 'bigint' ? val.toString(10) : toHex(val),
    }));
  }
  return out;
}

/** Map a thrown decode error to a corpus error category (never message text). */
export function categorizeLocError(err: unknown): string {
  // A categorised property-wire violation from the shared core (length-overrun,
  // odd-value-too-long, delta-overflow, …). PropertyWireError extends RangeError,
  // so it must be checked first.
  if (err instanceof PropertyWireError) return err.category;
  // A varint/vi64 that runs off the end of the buffer.
  if (err instanceof RangeError) return 'truncated';
  // Any other error from the parser is an unexpected crash — surface it.
  throw err;
}

/** LOC parse options are now selected by the transport wire profile. */
function locOptionsFor(wireProfile: WireProfile): { wireProfile: WireProfile } {
  return { wireProfile };
}

/** Run parseLocHeaders (A+B end-to-end) under the vector's wire profile. */
export function runLocProperties(bytes: Uint8Array, wireProfile: WireProfile): LocRunResult {
  try {
    const headers = parseLocHeaders(bytes, locOptionsFor(wireProfile));
    return { status: 'ok', semantics: locProjection(headers) };
  } catch (err) {
    return { status: 'error', category: categorizeLocError(err) };
  }
}

/**
 * Run the Layer-B semantic resolver alone (structured PropertyMap → LocHeaders),
 * with no byte-level parsing. Exercises `resolveLocHeaders` directly.
 */
export function runLocSemantics(propertyMap: readonly PropertyMapEntryJson[]): LocRunResult {
  return { status: 'ok', semantics: locProjection(resolveLocHeaders(entriesFromJson(propertyMap))) };
}

/**
 * Run encodeLocHeaders (the encode direction) from a PropertyMap of known LOC
 * ids, under the vector's wire profile. A draft-18 target with a value >= 64 now
 * emits the correct vi64 form; a draft-16 target above the QUIC-varint range is a
 * typed value-out-of-range error.
 */
export function runLocEncode(propertyMap: readonly PropertyMapEntryJson[], wireProfile: WireProfile): LocRunResult {
  const headers: { -readonly [K in keyof LocHeaders]: LocHeaders[K] } = {};
  for (const e of propertyMap) {
    if (e.id === '2' && e.valueKind === 'varint') headers.captureTimestamp = BigInt(e.value);
    // (only Capture Timestamp is needed for the current encode drivers)
  }
  try {
    const bytes = encodeLocHeaders(headers, locOptionsFor(wireProfile)) ?? new Uint8Array(0);
    return { status: 'ok', bytesHex: toHex(bytes) };
  } catch (err) {
    return { status: 'error', category: categorizeLocError(err) };
  }
}
