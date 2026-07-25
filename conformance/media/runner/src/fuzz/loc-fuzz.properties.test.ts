/**
 * LOC-01 crash-fuzz across all three transport wire profiles (draft-14 absolute
 * QUIC-varint, draft-16 delta QUIC-varint, draft-18 delta vi64).
 *
 * Contract: `parseLocHeaders` may reject malformed extension bytes ONLY with a
 * PropertyWireError / RangeError. A TypeError / ReferenceError / assertion / non-
 * Error throw / hang is a bug. On success the parsed headers must have valid field
 * shapes and preserve full-width `bigint` unknown IDs, and re-parsing the same
 * bytes must yield the same projection.
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { parseLocHeaders, type LocHeaderOptions } from '@moqt/loc';
import { locProjection } from '../loc-exec.js';
import { fc, fcParams, locFuzzBytes, toHex, expectParserSafe, allowLocError, assertNoMutation } from './media-fuzz.js';

type Headers = ReturnType<typeof parseLocHeaders>;

/** Assert the structural invariants of a successfully-parsed LocHeaders. */
function assertLocShape(label: string, h: Headers, buf: Uint8Array): void {
  const where = ` (0x${toHex(buf)})`;
  if (h.captureTimestamp !== undefined) {
    expect(typeof h.captureTimestamp, `${label}: captureTimestamp is bigint${where}`).toBe('bigint');
  }
  if (h.videoConfig !== undefined) {
    expect(h.videoConfig instanceof Uint8Array, `${label}: videoConfig is bytes${where}`).toBe(true);
  }
  if (h.audioLevel !== undefined) {
    expect(typeof h.audioLevel.voiceActivity, `${label}: audioLevel.voiceActivity bool${where}`).toBe('boolean');
    expect(Number.isInteger(h.audioLevel.level), `${label}: audioLevel.level int${where}`).toBe(true);
  }
  if (h.videoFrameMarking !== undefined) {
    const v = h.videoFrameMarking;
    for (const k of ['startOfFrame', 'endOfFrame', 'independent', 'discardable', 'baseLayerSync'] as const) {
      expect(typeof v[k], `${label}: videoFrameMarking.${k} bool${where}`).toBe('boolean');
    }
    expect(Number.isInteger(v.temporalId), `${label}: temporalId int${where}`).toBe(true);
  }
  if (h.unknown !== undefined) {
    for (const [id, val] of h.unknown) {
      // Full-width IDs are preserved as bigint — never narrowed to number.
      expect(typeof id, `${label}: unknown id is bigint (never narrowed)${where}`).toBe('bigint');
      const okVal = typeof val === 'bigint' || val instanceof Uint8Array;
      expect(okVal, `${label}: unknown value is bigint|bytes${where}`).toBe(true);
      // Parity contract: even id → integer, odd id → bytes.
      if ((id & 1n) === 0n) expect(typeof val).toBe('bigint');
      else expect(val instanceof Uint8Array).toBe(true);
    }
  }
}

const PROFILES: NonNullable<LocHeaderOptions['wireProfile']>[] = [
  'd14-absolute-varint',
  'd16-delta-varint',
  'd18-delta-vi64',
];

for (const wireProfile of PROFILES) {
  describe(`LOC-01 crash fuzz — ${wireProfile}`, () => {
    it('parseLocHeaders is crash-safe (PropertyWireError/RangeError only), well-shaped, deterministic', () => {
      fc.assert(
        fc.property(locFuzzBytes, (buf) => {
          const label = `parseLocHeaders ${wireProfile}`;
          const repr = `0x${toHex(buf)}`;
          const before = buf.slice();
          const r = expectParserSafe(label, repr, allowLocError, () => parseLocHeaders(buf, { wireProfile }));
          // The parser must not mutate the caller's extension bytes (success or reject).
          assertNoMutation(label, before, buf, repr);
          if (r.ok) {
            assertLocShape(label, r.value, buf);
            // Determinism: same bytes → same projection.
            const again = parseLocHeaders(buf, { wireProfile });
            expect(locProjection(again)).toEqual(locProjection(r.value));
          }
        }),
        fcParams(),
      );
    });
  });
}
