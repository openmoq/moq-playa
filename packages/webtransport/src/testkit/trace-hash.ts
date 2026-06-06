/**
 * FNV-1a 64-bit hash over deterministic scenario trace records (testkit).
 *
 * Mirrors LibMoQ's determinism oracle: run a scenario twice with the same seed
 * and compare the hash of its trace. The hash folds only **deterministic**
 * fields (step, op code, side, request/alias/group ids, an outcome code) — never
 * object identities, real time, `Math.random`, or `Date.now` — so an identical
 * seed must produce an identical hash. A mismatch means protocol divergence.
 *
 * @module
 */

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** One deterministic trace record (all fields are stable across replays). */
export interface TraceRecord {
  readonly step: number;
  /** Numeric op code (stable enum value). */
  readonly op: number;
  /** 0 = client, 1 = server. */
  readonly side: number;
  /** Target request id (or 0). */
  readonly requestId: bigint;
  /** Track alias involved (or 0). */
  readonly alias: bigint;
  /** Group id involved (or 0). */
  readonly group: bigint;
  /** Op outcome code (e.g. 1 = ok, 0 = skipped, 2 = rejected). */
  readonly outcome: number;
}

/** Fold one unsigned 64-bit value into an FNV-1a accumulator. */
function fold(h: bigint, v: bigint): bigint {
  return ((h ^ (v & MASK64)) * FNV_PRIME) & MASK64;
}

/** FNV-1a 64-bit hash of a deterministic trace. */
export function fnv1a64(records: readonly TraceRecord[]): bigint {
  let h = FNV_OFFSET;
  for (const r of records) {
    h = fold(h, BigInt(r.step));
    h = fold(h, BigInt(r.op));
    h = fold(h, BigInt(r.side));
    h = fold(h, r.requestId);
    h = fold(h, r.alias);
    h = fold(h, r.group);
    h = fold(h, BigInt(r.outcome));
  }
  return h;
}
