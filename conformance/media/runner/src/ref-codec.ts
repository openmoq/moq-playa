/**
 * INDEPENDENT reference codec for authoring spec-derived corpus bytes.
 *
 * Deliberately self-contained — it does NOT import `@moqt/transport`. The
 * production writeVarint/writeVi64 are exactly the primitives extracted into
 * the shared property-wire codec under test; authoring the "correct" bytes with
 * them would let a primitive defect bless itself. This module is small enough to
 * review directly against the cited specs, so the corpus bytes have an oracle
 * independent of the implementation. A sanity test additionally cross-checks it
 * against production (a disagreement flags a bug in EITHER, for a human to
 * resolve).
 *
 * @module
 */

const MAX_U62 = 4611686018427387903n; // 2^62 - 1 (QUIC varint max)
const MAX_U64 = 18446744073709551615n; // 2^64 - 1 (vi64 max)

/**
 * QUIC variable-length integer, minimal encoding. RFC 9000 §16: the top two bits
 * of the first byte select 1/2/4/8-byte length (00/01/10/11); the value occupies
 * the remaining 6/14/30/62 bits, big-endian.
 */
export function refQuicVarint(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_U62) throw new RangeError(`quic-varint range [0, 2^62-1]: ${value}`);
  let len: 1 | 2 | 4 | 8;
  let tag: number;
  if (value <= 63n) { len = 1; tag = 0x00; }
  else if (value <= 16383n) { len = 2; tag = 0x40; }
  else if (value <= 1073741823n) { len = 4; tag = 0x80; }
  else { len = 8; tag = 0xc0; }
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  out[0]! |= tag;
  return out;
}

/**
 * vi64 variable-length integer, minimal encoding. draft-ietf-moq-transport-18
 * §1.4.1: `k` leading 1-bits in the first byte signal a `k+1` byte encoding
 * (1..9 bytes); after the leading ones and the terminating 0 bit, the remaining
 * bits plus subsequent bytes hold the value big-endian.
 */
export function refVi64(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_U64) throw new RangeError(`vi64 range [0, 2^64-1]: ${value}`);
  // Minimal length: the smallest k+1 whose value bits hold `value`.
  const caps = [0x7fn, 0x3fffn, 0x1fffffn, 0xfffffffn, 0x7ffffffffn, 0x3ffffffffffn, 0x1ffffffffffffn, 0xffffffffffffffn];
  let len = 9;
  for (let i = 0; i < caps.length; i++) { if (value <= caps[i]!) { len = i + 1; break; } }
  const out = new Uint8Array(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  // Prefix: set the top (len-1) bits of the first byte to 1 (0xFF for len 9).
  if (len > 1) out[0]! |= (0xff << (9 - len)) & 0xff;
  return out;
}

export type WireProfile = 'd14-absolute-varint' | 'd16-delta-varint' | 'd18-delta-vi64';
export interface RefPropEntry { id: bigint; value: bigint | Uint8Array }

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Stable sort by ascending id (preserving the relative order of equal ids). */
export function stableSortById(entries: readonly RefPropEntry[]): RefPropEntry[] {
  return entries.map((e, i) => [e, i] as const).sort((a, b) => (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : a[1] - b[1])).map(([e]) => e);
}

/**
 * Encode a Key-Value-Pair property block on the given wire profile.
 *
 * `canonical: true` sorts the entries into stable ascending-ID order first (the
 * documented canonical encoding); `false` preserves caller order (used to author
 * a specific on-wire byte sequence for a decode vector). Even ids carry a varint
 * value; odd ids carry a length-prefixed byte value. draft-14 uses absolute type
 * ids; draft-16/18 delta-encode them (which forces non-decreasing ids on wire).
 */
export function refEncodeBlock(entries: readonly RefPropEntry[], profile: WireProfile, opts: { canonical: boolean }): Uint8Array {
  const ordered = opts.canonical ? stableSortById(entries) : [...entries];
  const wInt = profile === 'd18-delta-vi64' ? refVi64 : refQuicVarint;
  const parts: Uint8Array[] = [];
  let prev = 0n;
  for (const e of ordered) {
    const idField = profile === 'd14-absolute-varint' ? e.id : e.id - prev;
    if (idField < 0n) throw new RangeError(`delta wire requires non-decreasing ids; got id ${e.id} after ${prev}`);
    prev = e.id;
    parts.push(wInt(idField));
    if (typeof e.value === 'bigint') {
      if ((e.id & 1n) === 1n) throw new RangeError(`odd id ${e.id} must carry a byte value, not a varint (parity)`);
      parts.push(wInt(e.value));
    } else {
      if ((e.id & 1n) === 0n) throw new RangeError(`even id ${e.id} must carry a varint value, not bytes (parity)`);
      // draft-18 §1.4.3: the maximum length of a value is 2^16-1 bytes.
      if (e.value.length > 0xffff) throw new RangeError(`odd-property value length ${e.value.length} exceeds the 2^16-1 maximum`);
      parts.push(wInt(BigInt(e.value.length)));
      parts.push(e.value);
    }
  }
  return concat(parts);
}
