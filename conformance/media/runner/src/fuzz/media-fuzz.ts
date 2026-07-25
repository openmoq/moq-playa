/**
 * Shared media-fuzz toolkit — bounded fast-check arbitraries, a single crash-safe
 * oracle (`expectParserSafe`), per-parser error-allow predicates, and returned-
 * value invariant checks. Test-only (imported by the `fuzz/*.properties.test.ts`
 * lanes and the oracle discrimination test).
 *
 * Design mirrors `packages/transport/src/testkit/arbitraries.ts`:
 *   - `fcParams()` honours FC_RUNS (default 200) and FC_SEED, so a failing run
 *     prints the seed + shrunk counterexample + replay `path` (fast-check does
 *     this automatically) and the minimized input is reproducible.
 *   - inputs are bounded in size AND nesting depth.
 *   - failure reports carry the minimized input: hex for bytes, an escaped +
 *     truncated form for text.
 *
 * The oracle is deliberately NOT "any Error is acceptable": each lane passes an
 * explicit `allow` predicate, and the discrimination test proves the oracle
 * rejects TypeError, non-Error throws, and (for catalog) a TypeError that merely
 * happens to extend Error.
 *
 * @module
 */

import * as fc from 'fast-check';
import { PropertyWireError } from '@moqt/transport';

// ─── run configuration (FC_RUNS / FC_SEED) ───────────────────────────────────

/** fast-check parameters honouring FC_RUNS (default 200) and FC_SEED. */
export function fcParams(overrides: fc.Parameters<unknown> = {}): fc.Parameters<unknown> {
  const runs = process.env.FC_RUNS !== undefined ? Number(process.env.FC_RUNS) : 200;
  const seedEnv = process.env.FC_SEED;
  return {
    numRuns: runs,
    ...(seedEnv !== undefined ? { seed: Number(seedEnv) } : {}),
    ...overrides,
  };
}

// ─── minimized-input reporting ───────────────────────────────────────────────

/** Lowercase hex of a buffer (for binary counterexamples). */
export function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Escaped, length-capped representation of a text input (for JSON/text lanes). */
export function describeText(s: string, max = 160): string {
  const shown = s.length > max ? `${s.slice(0, max)}…` : s;
  return `${JSON.stringify(shown)} (${s.length} chars)`;
}

// ─── the crash-safe oracle ───────────────────────────────────────────────────

export type SafeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Run `fn`. Return its value on success; on an ALLOWED rejection return `{ok:false}`;
 * on any DISALLOWED throw (or non-Error throw) raise a test failure carrying the
 * minimized input. `allow` is per-lane — there is no blanket "any Error is fine".
 */
export function expectParserSafe<T>(
  label: string,
  inputRepr: string,
  allow: (e: unknown) => boolean,
  fn: () => T,
): SafeResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (allow(e)) return { ok: false };
    const name = e instanceof Error ? e.constructor.name : typeof e;
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: unexpected ${name}: ${message}\n  input=${inputRepr}`);
  }
}

/** LOC: malformed bytes may be rejected ONLY with PropertyWireError/RangeError.
 *  (PropertyWireError extends RangeError; TypeError/ReferenceError do not.) */
export const allowLocError = (e: unknown): boolean =>
  e instanceof PropertyWireError || e instanceof RangeError;

/** Catalog: a native SyntaxError (JSON.parse) or an INTENTIONAL base `Error`.
 *  A TypeError/ReferenceError is a bug even though it extends Error, so the
 *  predicate requires the exact `Error` constructor, not `instanceof Error`. */
export const allowCatalogError = (e: unknown): boolean =>
  e instanceof SyntaxError || (e instanceof Error && e.constructor === Error);

/** BMFF: the operations are documented TOTAL — no throw is acceptable. */
export const allowNone = (): boolean => false;

// ─── returned-value invariants ───────────────────────────────────────────────

/**
 * Assert a projection is JSON-serialisable and free of non-finite NUMBERS and
 * non-JSON values (bigint/function/symbol/undefined). Bounded recursion.
 *
 * It does NOT reject the STRINGS "NaN"/"Infinity" — those are legitimate string
 * field values (a track literally named "NaN"). A projection that stringifies
 * numbers (e.g. BMFF) must guarantee finiteness of the SOURCE number before
 * projecting (BMFF reads are uint32/bigint, always finite); catalog validates
 * `Number.isFinite` on each numeric field before projection.
 */
export function assertJsonSafe(label: string, value: unknown, inputRepr: string, depth = 0): void {
  if (depth > 12) throw new Error(`${label}: projection nested too deep\n  input=${inputRepr}`);
  if (value === null) return;
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) throw new Error(`${label}: non-finite number ${String(value)}\n  input=${inputRepr}`);
    return;
  }
  if (t === 'string') return;
  if (t === 'boolean') return;
  if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') {
    throw new Error(`${label}: non-JSON ${t} in projection\n  input=${inputRepr}`);
  }
  if (Array.isArray(value)) {
    for (const el of value) assertJsonSafe(label, el, inputRepr, depth + 1);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) assertJsonSafe(label, v, inputRepr, depth + 1);
  // Round-trip once at the top to catch anything the walk missed.
  if (depth === 0) {
    const round = JSON.parse(JSON.stringify(value));
    if (JSON.stringify(round) !== JSON.stringify(value)) {
      throw new Error(`${label}: projection is not JSON-stable\n  input=${inputRepr}`);
    }
  }
}

/** Assert a byte buffer was not mutated in place by a (supposedly read-only) parser. */
export function assertNoMutation(label: string, before: Uint8Array, after: Uint8Array, inputRepr: string): void {
  if (before.length !== after.length) {
    throw new Error(`${label}: input length changed ${before.length}→${after.length}\n  input=${inputRepr}`);
  }
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      throw new Error(`${label}: input mutated at byte ${i} (${before[i]}→${after[i]})\n  input=${inputRepr}`);
    }
  }
}

// ─── byte arbitraries (bounded) ──────────────────────────────────────────────

/** 0–8 bytes: empty + truncated inputs. */
export const tinyBytes: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 0, maxLength: 8 });
/** 0–256 uniform random bytes. */
export const uniformBytes: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 0, maxLength: 256 });

/** vi64 / QUIC-varint length introducers, to drive deep into the property codec. */
const LEN_INTRODUCERS = [0x00, 0x40, 0x80, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc, 0xfe, 0xff];
const introducerPrefixed: fc.Arbitrary<Uint8Array> = fc
  .tuple(fc.constantFrom(...LEN_INTRODUCERS), fc.uint8Array({ maxLength: 64 }))
  .map(([lead, rest]) => Uint8Array.of(lead, ...rest));

/**
 * Bytes aimed at the LOC property block: id/value/length-prefix shaped, biased so
 * generation reaches deep into decodePropertyBlock rather than bouncing off byte 0.
 */
export const locFuzzBytes: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 2, arbitrary: tinyBytes },
  { weight: 3, arbitrary: uniformBytes },
  { weight: 2, arbitrary: introducerPrefixed },
);

// ─── BMFF box arbitraries (bounded, box-shaped + malformed) ───────────────────

const FOURCCS = [
  'ftyp', 'styp', 'moov', 'mvex', 'trex', 'trak', 'tkhd', 'mdia', 'minf', 'stbl',
  'moof', 'traf', 'tfhd', 'tfdt', 'trun', 'mdat', 'sidx', 'free', 'skip', 'AAAA',
];
const enc = new TextEncoder();

/** A leaf box `[size:u32 BE][type:4][body]`. `sizeMode` deliberately produces
 *  honest, too-large (overrun), too-small, and zero/one sentinel sizes. */
const leafBox: fc.Arbitrary<Uint8Array> = fc
  .tuple(
    fc.constantFrom(...FOURCCS),
    fc.uint8Array({ maxLength: 32 }),
    fc.constantFrom<'honest' | 'overrun' | 'tiny' | 'zero' | 'one'>('honest', 'overrun', 'tiny', 'zero', 'one'),
  )
  .map(([type, body, mode]) => {
    const total = 8 + body.length;
    const declared =
      mode === 'honest' ? total
      : mode === 'overrun' ? total + 64
      : mode === 'tiny' ? Math.max(0, total - 4)
      : mode === 'zero' ? 0 // "box extends to end of file"
      : 1; // 1 → 64-bit largesize follows (we don't provide it → malformed)
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, declared >>> 0, false);
    out.set(enc.encode(type), 4);
    out.set(body, 8);
    return out;
  });

/** A shallow container box wrapping 0..3 leaf boxes (bounded nesting depth = 1). */
const containerBox: fc.Arbitrary<Uint8Array> = fc
  .tuple(fc.constantFrom('moov', 'moof', 'traf', 'mvex', 'trak'), fc.array(leafBox, { maxLength: 3 }))
  .map(([type, children]) => {
    const bodyLen = children.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(8 + bodyLen);
    new DataView(out.buffer).setUint32(0, out.length, false);
    out.set(enc.encode(type), 4);
    let p = 8;
    for (const c of children) { out.set(c, p); p += c.length; }
    return out;
  });

/** A concatenation of 0..4 top-level boxes (leaf or one-deep container). */
const boxSequence: fc.Arbitrary<Uint8Array> = fc
  .array(fc.oneof(leafBox, containerBox), { maxLength: 4 })
  .map((boxes) => {
    const len = boxes.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(len);
    let p = 0;
    for (const b of boxes) { out.set(b, p); p += b.length; }
    return out;
  });

/** Truncate a box-shaped buffer at an arbitrary point (partial box). */
const truncatedBoxes: fc.Arbitrary<Uint8Array> = fc
  .tuple(boxSequence, fc.nat())
  .map(([buf, n]) => (buf.length === 0 ? buf : buf.slice(0, n % (buf.length + 1))));

// ─── structurally-valid NESTED skeletons (reach the deep parser paths) ────────
//
// The production ops require moov→mvex→trex or moof→traf→(tfdt/trun). A flat/one-
// deep generator mostly exercises top-level scanning, so these build valid nested
// skeletons whose leaf fullboxes are ALSO produced in truncated forms (e.g. a
// tfdt declaring size 8, header-only) — the exact shapes that exercise per-leaf
// bounds handling deep inside the parser.

function boxOf(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length >>> 0, false);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  return out;
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}
/** A fullbox: `[size][type][version:1][flags:3][payload]`. */
function fullbox(type: string, version: number, payload: Uint8Array): Uint8Array {
  return boxOf(type, concatBytes([Uint8Array.of(version & 0xff, 0, 0, 0), payload]));
}

/** tfdt: valid v0/v1, partial-value, and the header-only (size-8) truncation. */
const tfdtBox: fc.Arbitrary<Uint8Array> = fc.oneof(
  fc.uint8Array({ minLength: 4, maxLength: 4 }).map((v) => fullbox('tfdt', 0, v)), // valid v0
  fc.uint8Array({ minLength: 8, maxLength: 8 }).map((v) => fullbox('tfdt', 1, v)), // valid v1
  fc.uint8Array({ minLength: 0, maxLength: 6 }).map((v) => fullbox('tfdt', 1, v)), // partial value
  fc.constant(boxOf('tfdt', new Uint8Array(0))), // header-only: NO version byte
);
/** trun: valid-ish body + header-only truncation. */
const trunBox: fc.Arbitrary<Uint8Array> = fc.oneof(
  fc.uint8Array({ maxLength: 24 }).map((p) => fullbox('trun', 0, p)),
  fc.constant(boxOf('trun', new Uint8Array(0))),
);
const tfhdBox: fc.Arbitrary<Uint8Array> = fc.uint8Array({ maxLength: 16 }).map((p) => fullbox('tfhd', 0, p));
/** trex: full 20-byte body, partial, and header-only. */
const trexBox: fc.Arbitrary<Uint8Array> = fc.oneof(
  fc.uint8Array({ minLength: 20, maxLength: 20 }).map((p) => fullbox('trex', 0, p)),
  fc.uint8Array({ minLength: 0, maxLength: 12 }).map((p) => fullbox('trex', 0, p)),
  fc.constant(boxOf('trex', new Uint8Array(0))),
);
const trafBox: fc.Arbitrary<Uint8Array> = fc
  .tuple(fc.option(tfhdBox, { nil: undefined }), fc.option(tfdtBox, { nil: undefined }), fc.option(trunBox, { nil: undefined }))
  .map((kids) => boxOf('traf', concatBytes(kids.filter((k): k is Uint8Array => k !== undefined))));

const moofBox: fc.Arbitrary<Uint8Array> = fc
  .array(trafBox, { minLength: 1, maxLength: 2 })
  .map((trafs) => boxOf('moof', concatBytes([fullbox('mfhd', 0, Uint8Array.of(0, 0, 0, 1)), ...trafs])));

const mvexBox: fc.Arbitrary<Uint8Array> = fc
  .array(trexBox, { minLength: 1, maxLength: 2 })
  .map((trexs) => boxOf('mvex', concatBytes(trexs)));

const moovBox: fc.Arbitrary<Uint8Array> = mvexBox.map((mvex) => boxOf('moov', mvex));

/** A valid nested segment/init skeleton: moof(+mdat) or moov(mvex(trex)). */
const nestedSkeleton: fc.Arbitrary<Uint8Array> = fc.oneof(
  moofBox,
  fc.tuple(moofBox, fc.uint8Array({ maxLength: 16 })).map(([m, body]) => concatBytes([m, boxOf('mdat', body)])),
  moovBox,
);

/** A nested skeleton, optionally truncated at an arbitrary point. */
const nestedMutated: fc.Arbitrary<Uint8Array> = fc
  .tuple(nestedSkeleton, fc.nat())
  .map(([buf, n]) => (buf.length === 0 ? buf : buf.slice(0, n % (buf.length + 1))));

/** Bounded BMFF fuzz input: random, box-shaped, container, truncated, inconsistent,
 *  AND structurally-valid nested skeletons (reaching moof→traf→tfdt / moov→mvex→trex). */
export const bmffFuzzBytes: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 2, arbitrary: uniformBytes },
  { weight: 1, arbitrary: tinyBytes },
  { weight: 2, arbitrary: boxSequence },
  { weight: 2, arbitrary: truncatedBoxes },
  { weight: 3, arbitrary: nestedSkeleton },
  { weight: 2, arbitrary: nestedMutated },
);

// ─── catalog JSON / text arbitraries (bounded) ───────────────────────────────

/** Bounded arbitrary JSON value (depth ≤ 4), stringified. */
const structuredJson: fc.Arbitrary<string> = fc
  .jsonValue({ depthSize: 'small', maxDepth: 4 })
  .map((v) => JSON.stringify(v));

/** A catalog-SHAPED object with random/edge fields, so generation reaches past
 *  the top-level shape checks into per-track normalisation. */
const catalogShapedJson: fc.Arbitrary<string> = fc
  .record({
    streamingFormat: fc.oneof(fc.constant(1), fc.integer(), fc.string()),
    streamingFormatVersion: fc.oneof(fc.constant('0.2'), fc.string(), fc.integer()),
    version: fc.oneof(fc.constant(1), fc.integer(), fc.double()),
    tracks: fc.array(
      fc.record({
        name: fc.oneof(fc.string({ maxLength: 12 }), fc.integer()),
        packaging: fc.oneof(fc.constantFrom('loc', 'cmaf', 'mediatimeline'), fc.string({ maxLength: 8 })),
        isLive: fc.oneof(fc.boolean(), fc.string()),
        renderGroup: fc.oneof(fc.integer(), fc.double()),
        bitrate: fc.oneof(fc.integer(), fc.double()),
        width: fc.integer(),
        height: fc.integer(),
        codec: fc.string({ maxLength: 16 }),
      }, { requiredKeys: [] }),
      { maxLength: 4 },
    ),
  }, { requiredKeys: [] })
  .map((v) => JSON.stringify(v));

/** Arbitrary UTF-8 text decoded from random bytes (invalid sequences → U+FFFD). */
const utf8FromBytes: fc.Arbitrary<string> = uniformBytes.map((b) => new TextDecoder().decode(b));

/** Truncated / garbage JSON-ish strings. */
const malformedJson: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('', '{', '[', '{"a":', 'null', 'undefined', 'NaN', '{"tracks":[', '﻿{}', '{"version":1e999}'),
  structuredJson.map((s) => s.slice(0, Math.max(0, s.length - 1))),
);

/** A VALID catalog whose numeric field carries an overflow exponent literal
 *  (`1e999` → Infinity on JSON.parse). Built as raw text — JSON.stringify would
 *  collapse Infinity to null. The parser must REJECT these (base Error). */
const overflowExponent: fc.Arbitrary<string> = fc.constantFrom('1e999', '-1e999', '1e400', '2e308', '9'.repeat(320));
const catalogOverflowJson: fc.Arbitrary<string> = fc.oneof(
  overflowExponent.map((n) => `{"version":1,"generatedAt":${n},"tracks":[{"name":"v","packaging":"loc","isLive":true}]}`),
  overflowExponent.map((n) => `{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"bitrate":${n}}]}`),
  overflowExponent.map((n) => `{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"width":${n},"height":8}]}`),
);

/** Bounded catalog fuzz input: structured, catalog-shaped, malformed, arbitrary
 *  UTF-8, and overflow-exponent numbers (→ Infinity, must be rejected). */
export const catalogFuzzInput: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: structuredJson },
  { weight: 3, arbitrary: catalogShapedJson },
  { weight: 2, arbitrary: malformedJson },
  { weight: 2, arbitrary: utf8FromBytes },
  { weight: 1, arbitrary: catalogOverflowJson },
);

/** Catalog input as raw BYTES (the `Uint8Array` overload of parseCatalogAuto):
 *  raw random bytes AND the string inputs UTF-8-encoded (so the byte path reaches
 *  both JSON.parse failures and the normalisation success path). */
export const catalogFuzzBytes: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 3, arbitrary: uniformBytes },
  { weight: 2, arbitrary: catalogFuzzInput.map((s) => new TextEncoder().encode(s)) },
);

export { fc };
