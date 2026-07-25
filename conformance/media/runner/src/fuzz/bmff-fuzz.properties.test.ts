/**
 * BMFF crash-fuzz through the current corpus operations (`trex`, `peek`,
 * `timeRanges` → the `@moqt/browser` mp4-box helpers).
 *
 * Contract: these operations are documented TOTAL — on ANY input (random,
 * truncated, box-shaped, inconsistent box sizes) they return a sane result rather
 * than throw. The projection must be deterministic and JSON-serialisable (no NaN,
 * Infinity, or accidental narrowing), and the input buffer must not be mutated.
 *
 * If fuzzing disproves totality, the minimized case is captured as a deterministic
 * red regression (see fuzz/bmff-regressions.test.ts) and the owning parser fixed.
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { runBmff, type BmffOp } from '../bmff-exec.js';
import { fc, fcParams, bmffFuzzBytes, toHex, expectParserSafe, allowNone, assertJsonSafe, assertNoMutation } from './media-fuzz.js';

const OPS: BmffOp[] = ['trex', 'peek', 'timeRanges'];

for (const op of OPS) {
  describe(`BMFF crash fuzz — ${op}`, () => {
    it('is total (never throws), JSON-safe, deterministic, and does not mutate the input', () => {
      fc.assert(
        fc.property(bmffFuzzBytes, (buf) => {
          const label = `bmff ${op}`;
          const repr = `0x${toHex(buf)}`;
          const before = buf.slice();
          // Totality: allowNone → ANY throw is a failure carrying the hex input.
          const r = expectParserSafe(label, repr, allowNone, () => runBmff(buf, op));
          expect(r.ok, `${label}: expected a total result`).toBe(true);
          if (!r.ok) return;
          const result = r.value;
          expect(result.status).toBe('ok');
          assertJsonSafe(label, result, repr);
          assertNoMutation(label, before, buf, repr);
          // Determinism: same bytes → same projection.
          const again = runBmff(buf, op);
          expect(again).toEqual(result);
        }),
        fcParams(),
      );
    });
  });
}
