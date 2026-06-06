/**
 * Shared fast-check arbitraries + run configuration for the transport codec
 * property tests (PR2). Test-only: excluded from the published build (see
 * `tsconfig.json`), imported solely by `*.properties.test.ts` files.
 *
 * The generators are deliberately *valid-first* — they produce values inside the
 * documented semantic range so encode/decode round-trips are meaningful. Targeted
 * invalid arbitraries (e.g. {@link aboveVarint}) are provided separately for the
 * "out-of-range throws" properties.
 *
 * @module
 */
import * as fc from 'fast-check';
import { MAX_VARINT } from '../primitives/varint.js';
import { MAX_VI64 } from '../primitives/vi64.js';

/**
 * fast-check run parameters honoring the env knobs:
 *   - `FC_RUNS`  — iterations per property (default 200; task range 100–300).
 *   - `FC_SEED`  — fixed seed for reproduction (default: fast-check chooses).
 * On failure fast-check prints the seed, the shrunk counterexample, and the
 * replay `path`, so a failing run is always reproducible.
 */
export function fcParams(overrides: fc.Parameters<unknown> = {}): fc.Parameters<unknown> {
  const runs = process.env.FC_RUNS !== undefined ? Number(process.env.FC_RUNS) : 200;
  const seedEnv = process.env.FC_SEED;
  return {
    numRuns: runs,
    ...(seedEnv !== undefined ? { seed: Number(seedEnv) } : {}),
    ...overrides,
  };
}

// ─── integer arbitraries (boundary-biased) ───────────────────────────────────

/** Length-class boundaries for a QUIC varint (1/2/4/8 byte thresholds, §RFC9000). */
const VARINT_BOUNDARIES: bigint[] = [
  0n, 1n, 63n, 64n, 16383n, 16384n, 1073741823n, 1073741824n,
  (1n << 62n) - 1n, MAX_VARINT - 1n, MAX_VARINT,
];

/** Length-class boundaries for a vi64 (1..9 byte thresholds, draft-18 §1.4.1). */
const VI64_BOUNDARIES: bigint[] = [
  0n, 1n, 0x7fn, 0x80n, 0x3fffn, 0x4000n, 0x1fffffn, 0x200000n,
  0xfffffffn, 0x10000000n, 0x7ffffffffn, 0x800000000n, 0x3ffffffffffn,
  0x1ffffffffffffn, 0xffffffffffffffn, 0x100000000000000n,
  1n << 62n, 1n << 63n, MAX_VI64 - 1n, MAX_VI64,
];

/** A valid QUIC-varint value in [0, 2^62-1], biased toward length boundaries. */
export const varintValue: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: MAX_VARINT }) },
  { weight: 1, arbitrary: fc.constantFrom(...VARINT_BOUNDARIES) },
);

/** A valid vi64 value in [0, 2^64-1], biased toward length boundaries. */
export const vi64Value: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: MAX_VI64 }) },
  { weight: 1, arbitrary: fc.constantFrom(...VI64_BOUNDARIES) },
);

/** An out-of-range QUIC-varint value ( > 2^62-1 ) — must be rejected on write. */
export const aboveVarint: fc.Arbitrary<bigint> = fc.bigInt({ min: MAX_VARINT + 1n, max: MAX_VI64 });

/** An out-of-range vi64 value ( > 2^64-1 ) — must be rejected on write. */
export const aboveVi64: fc.Arbitrary<bigint> = fc.bigInt({ min: MAX_VI64 + 1n, max: (MAX_VI64 + 1n) * 4n });

/** A small priority byte (0..255). */
export const priorityByte: fc.Arbitrary<number> = fc.integer({ min: 0, max: 255 });

// ─── byte / namespace arbitraries ────────────────────────────────────────────

/** A bounded byte payload (default ≤ 64 bytes). */
export function bytes(maxLength = 64): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ maxLength });
}

/** A single non-empty Track Namespace field (1..16 bytes). */
const nsField: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 1, maxLength: 16 });

/** A valid Track Namespace tuple: 1..6 non-empty fields (≤32, total ≤4096). */
export const namespaceTuple: fc.Arbitrary<Uint8Array[]> = fc.array(nsField, { minLength: 1, maxLength: 6 });

/** A valid Track Namespace *prefix*: 0..6 non-empty fields (a 0-field prefix is legal). */
export const namespacePrefix: fc.Arbitrary<Uint8Array[]> = fc.array(nsField, { minLength: 0, maxLength: 6 });

/** A short ASCII-ish reason phrase. */
export const reasonPhrase: fc.Arbitrary<string> = fc.string({ maxLength: 32 });

// ─── crash-fuzz byte arbitraries ─────────────────────────────────────────────
//
// Biased generators of arbitrary / truncated / malformed buffers for the parser
// crash-fuzz suites. These are NOT valid messages — the oracle only asserts the
// parser never hard-crashes (only ProtocolViolationError / RangeError) and never
// returns an out-of-range bytesRead. Bias toward structurally plausible shapes so
// generation reaches deep into parsers rather than bouncing off the first byte.

/** Interesting leading bytes: control message types (14/16/18) + data type bytes. */
const KNOWN_TYPE_BYTES: number[] = [
  // control (draft-14/16/18 message type codes — overlapping spaces on purpose)
  0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0d, 0x0e, 0x0f, 0x10,
  0x13, 0x14, 0x15, 0x16, 0x18, 0x19, 0x1d, 0x1e, 0x20, 0x21, 0x2f, 0x50, 0x51,
  // data: datagram forms (0x00–0x2f), subgroup forms (0x10–0x7f), fetch header
  0x00, 0x01, 0x0c, 0x1f, 0x30, 0x3f, 0x40, 0x70, 0x7f,
  // vi64 length prefixes (2/4/8/9-byte introducers)
  0x80, 0xc0, 0xe0, 0xf0, 0xff,
];

/** 0–4 bytes: empty + truncated inputs. */
const tinyBytes = fc.uint8Array({ minLength: 0, maxLength: 4 });

/** 0–256 uniform random bytes. */
const uniformBytes = fc.uint8Array({ minLength: 0, maxLength: 256 });

/** A known type-ish byte followed by random bytes. */
const typePrefixed = fc
  .tuple(fc.constantFrom(...KNOWN_TYPE_BYTES), fc.uint8Array({ maxLength: 64 }))
  .map(([t, rest]) => Uint8Array.of(t, ...rest));

/** Control-framed-ish: type byte + uint16 BE length + payload-ish bytes (length need not match). */
const framedish = fc
  .tuple(fc.constantFrom(...KNOWN_TYPE_BYTES), fc.integer({ min: 0, max: 0xffff }), fc.uint8Array({ maxLength: 96 }))
  .map(([t, len, payload]) => {
    const out = new Uint8Array(3 + payload.length);
    out[0] = t;
    out[1] = (len >> 8) & 0xff;
    out[2] = len & 0xff;
    out.set(payload, 3);
    return out;
  });

/** A multi-byte vi64-ish prefix (draft-18) followed by random bytes. */
const vi64ishPrefixed = fc
  .tuple(fc.constantFrom(0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff), fc.uint8Array({ minLength: 0, maxLength: 48 }))
  .map(([lead, rest]) => Uint8Array.of(lead, ...rest));

/** Biased arbitrary buffer for parser crash fuzzing. */
export const fuzzBytes: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 2, arbitrary: tinyBytes },
  { weight: 3, arbitrary: uniformBytes },
  { weight: 2, arbitrary: typePrefixed },
  { weight: 2, arbitrary: framedish },
  { weight: 1, arbitrary: vi64ishPrefixed },
);

/** A small non-negative decode offset (parsers must respect it). */
export const fuzzOffset: fc.Arbitrary<number> = fc.integer({ min: 0, max: 5 });

/** Lowercase hex of a buffer, for counterexample reporting. */
export function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export { fc };
