import { expect, it } from 'vitest';
import { object } from './object-reception.js';

// Draft 23 §11.3.1 retains the subgroup Object ID delta +1 rule.
// The FETCH delta +2 change (§11.4.1.1) does not apply to this helper.
for (const draft of [18, 22, 23] as const) it(`draft${draft} stalled-history subgroup object bytes`, () => {
  expect(object(draft, 0n, Uint8Array.of(8, 0), null)).toEqual(Uint8Array.of(0, 2, 8, 0));
  expect(object(draft, 1n, Uint8Array.of(8, 1), 0n)).toEqual(Uint8Array.of(0, 2, 8, 1));
});
