/**
 * Deterministic seeded PRNG (splitmix64) for reproducible scenario testing.
 *
 * No `Math.random`, no `Date.now` — output is a pure function of the seed, so a
 * scenario replays identically from its seed. Operates on `bigint` (full uint64).
 *
 * @module
 */

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

/** A deterministic seeded PRNG. */
export interface Prng {
  /** Next raw 64-bit value. */
  next(): bigint;
  /** Uniform integer in `[0, n)` (n must be > 0). */
  int(n: number): number;
  /** Pick an element of a non-empty array. */
  pick<T>(xs: readonly T[]): T;
}

/** Create a splitmix64 PRNG seeded by `seed`. */
export function makePrng(seed: bigint): Prng {
  let state = seed & MASK64;
  const next = (): bigint => {
    state = (state + GOLDEN) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * MIX1) & MASK64;
    z = ((z ^ (z >> 27n)) * MIX2) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
  const prng: Prng = {
    next,
    int(n: number): number {
      if (n <= 0) throw new RangeError(`Prng.int: n must be > 0 (got ${n})`);
      return Number(next() % BigInt(n));
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new RangeError('Prng.pick: empty array');
      return xs[prng.int(xs.length)]!;
    },
  };
  return prng;
}
