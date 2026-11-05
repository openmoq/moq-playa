import { expect, it } from 'vitest';
import { supportedPropertyFault, hasUnsupportedMandatoryTrackProperty } from './property-semantics.js';
for (const type of [0x4000n, 0x4001n, 0x401dn, 0x7fffn]) it(`mandatory-range ${type.toString(16)} remains Track-only including legacy GREASE`, () => {
  const props = new Map([[type, [Uint8Array.of()]]]);
  expect(supportedPropertyFault(props, 'object')).toMatch(/track-only/);
  expect(supportedPropertyFault(props, 'track')).toBeNull();
  expect(hasUnsupportedMandatoryTrackProperty(props)).toBe(true);
});
for (const type of [0x0en, 0x22n, 0x30n]) it(`implemented Track-only ${type.toString(16)} never becomes an Object property`, () => {
  expect(supportedPropertyFault(new Map([[type, [1n]]]), 'object')).toMatch(/track-only/);
  expect(supportedPropertyFault(new Map([[type, [1n, 1n]]]), 'track')).toBeNull();
});
for (const type of [0x3cn, 0x3en]) it(`gap ${type.toString(16)} has explicit Object-only singleton semantics`, () => {
  expect(supportedPropertyFault(new Map([[type, [1n]]]), 'track')).toMatch(/object-only/);
  expect(supportedPropertyFault(new Map([[type, [1n]]]), 'object')).toBeNull();
  expect(supportedPropertyFault(new Map([[type, [1n, 2n]]]), 'object')).toMatch(/Repeated/);
});
it('both-scope and unknown optional repeated properties preserve legacy multiplicity', () => {
  for (const scope of ['track', 'object'] as const) for (const type of [0x02n, 0x06n, 0x42n]) {
    expect(supportedPropertyFault(new Map([[type, [1n, 2n]]]), scope)).toBeNull();
  }
});
