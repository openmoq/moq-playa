/**
 * Location structure per draft-ietf-moq-transport-16 §1.4.1.
 * @module
 */

import { readVarint, writeVarint, varintEncodingLength } from './varint.js';

/**
 * Identifies a particular Object in a Group within a Track.
 *
 * Fields are `bigint`: draft-18 encodes Location as two vi64s spanning the full
 * unsigned 64-bit range. The QUIC-varint helpers below ({@link readLocation} /
 * {@link writeLocation}) remain the draft-14/16 wire codec and stay range-guarded
 * — `writeVarint` throws for values above 2^62-1 — so a draft-14/16 Location can
 * never encode out of range. The draft-18 codec serializes Location with vi64
 * directly (not via these helpers).
 */
export interface Location {
  readonly group: bigint;
  readonly object: bigint;
}

/** Read a Location (two consecutive varints). */
export function readLocation(
  buf: Uint8Array,
  offset: number,
): { value: Location; bytesRead: number } {
  let pos = offset;
  const { value: group, bytesRead: gBytes } = readVarint(buf, pos);
  pos += gBytes;
  const { value: object, bytesRead: oBytes } = readVarint(buf, pos);
  pos += oBytes;
  return { value: { group, object }, bytesRead: pos - offset };
}

/** Write a Location (two consecutive varints). Returns bytes written. */
export function writeLocation(
  loc: Location,
  buf: Uint8Array,
  offset: number,
): number {
  let pos = offset;
  pos += writeVarint(loc.group, buf, pos);
  pos += writeVarint(loc.object, buf, pos);
  return pos - offset;
}

/** Calculate encoding length for a Location. */
export function locationEncodingLength(loc: Location): number {
  return varintEncodingLength(loc.group) + varintEncodingLength(loc.object);
}
