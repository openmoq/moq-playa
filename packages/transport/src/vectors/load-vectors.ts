/**
 * Wire-vector fixture loader (PR1 — golden vectors).
 *
 * Loads a `manifest.json` + `.bin` corpus from `packages/transport/vectors/<name>/`
 * for cross-implementation and regression byte-level tests. The manifest format
 * mirrors LibMoQ's: an array of `{ file, type, type_code, wire_hex, expected }`.
 *
 * @module
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** One manifest entry (as written on disk). */
export interface VectorManifestEntry {
  readonly file: string;
  /** Human-facing message/type name (informational; not the wire code). */
  readonly type: string;
  readonly type_code?: string;
  readonly description?: string;
  readonly wire_length?: number;
  /** Canonical wire bytes as a hex string. */
  readonly wire_hex: string;
  /** Decoded-field expectations to spot-check (loose subset). */
  readonly expected?: Record<string, unknown>;
}

/** A manifest entry plus the loaded `.bin` bytes. */
export interface LoadedVector extends VectorManifestEntry {
  readonly bytes: Uint8Array;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path of a vectors fixture dir (`packages/transport/vectors/<name>`). */
export function vectorsDir(name: string): string {
  // src/vectors/ -> packages/transport/vectors/<name>
  return join(HERE, '..', '..', 'vectors', name);
}

/** Load every vector in `dir` (which must contain `manifest.json` + the `.bin` files). */
export function loadVectors(dir: string): LoadedVector[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    vectors: VectorManifestEntry[];
  };
  return manifest.vectors.map((v) => {
    const bytes = new Uint8Array(readFileSync(join(dir, v.file)));
    if (v.wire_hex !== undefined && bytesToHex(bytes) !== v.wire_hex.toLowerCase()) {
      throw new Error(`vector ${v.file}: .bin bytes do not match manifest wire_hex`);
    }
    return { ...v, bytes };
  });
}

/** Lowercase hex string of `bytes`. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Parse a (possibly spaced) hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error(`hexToBytes: odd-length hex (${clean.length})`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
