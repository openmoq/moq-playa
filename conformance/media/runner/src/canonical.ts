/**
 * Canonical encoding rules for the media conformance corpus.
 *
 * The corpus is consumed by two implementations (TypeScript here, C in LibMoQ).
 * To make cross-implementation comparison unambiguous AND safe in JavaScript
 * (where `JSON.parse` silently mangles integers above 2^53-1), the corpus JSON
 * obeys strict encoding rules:
 *
 *   - Every u64/i64-typed field (ids, values, ticks, timescales, wall-clock µs,
 *     byte offsets) is ALWAYS a decimal string — never a JSON number, even when
 *     the value is small. "Sometimes a number" is banned because it lets an
 *     unsafe wide value slip through a JSON parser unnoticed.
 *   - Floats are prohibited anywhere in the corpus. Rates are exact rationals.
 *   - Bytes are lowercase hex strings.
 *   - Strings compare as exact code points; no Unicode normalization.
 *
 * @module
 */

/** A JSON string of decimal digits (optional leading `-`), no leading zeros. */
const DECIMAL_INT = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Parse a wide-integer field, REJECTING a JSON number. This is the schema-
 * enforcement point: a corpus that wrote `"value": 42` (number) instead of
 * `"value": "42"` (string) fails loudly here rather than silently losing
 * precision above 2^53-1.
 *
 * @throws {Error} if `raw` is not a canonical decimal string.
 */
export function wideInt(raw: unknown, fieldPath = 'value'): bigint {
  if (typeof raw === 'number') {
    throw new Error(
      `wide-integer field "${fieldPath}" must be a decimal STRING, got a JSON number ${raw} ` +
      `(values above 2^53-1 lose precision as JSON numbers)`,
    );
  }
  if (typeof raw !== 'string' || !DECIMAL_INT.test(raw)) {
    throw new Error(`wide-integer field "${fieldPath}" must be a canonical decimal string, got ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}

/** Encode a bigint as the canonical decimal string used everywhere in the corpus. */
export function wideStr(value: bigint): string {
  return value.toString(10);
}

const HEX = /^(?:[0-9a-f]{2})*$/;

/** Parse a lowercase-hex byte string. @throws if not canonical lowercase hex. */
export function fromHex(hex: string, fieldPath = 'hex'): Uint8Array {
  if (typeof hex !== 'string' || !HEX.test(hex)) {
    throw new Error(`field "${fieldPath}" must be canonical lowercase hex (even length), got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode bytes as canonical lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** MAX_SAFE_INTEGER as a bigint — the boundary for safe JS Number conversion. */
export const MAX_SAFE = 9007199254740991n;

/**
 * Deep structural equality over the canonical projection JSON. Unlike the
 * transport golden-vectors' loose subset match, corpus projections ARE the
 * contract, so comparison is exact: extra keys on either side fail. Object key
 * ORDER is irrelevant (structural); arrays are order-significant.
 */
export function deepEqualCanonical(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualCanonical(x, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || !ak.every((k, i) => k === bk[i])) return false;
    return ak.every((k) => deepEqualCanonical(ao[k], bo[k]));
  }
  return false; // primitives already handled by === ; floats never appear
}
