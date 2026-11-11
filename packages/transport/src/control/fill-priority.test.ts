import { expect, it } from 'vitest';
import { encodeFillParameters } from './subscription-filter.js';
import { decodeFillParameters } from './fill-parameters.js';

it.each([0, 128, 255])('round trips typed uint8 fill priority %s in its separate scope', priority => {
  expect(decodeFillParameters(encodeFillParameters(undefined, 'descending', priority)))
    .toMatchObject({ subscriberPriority: priority, groupOrder: 'descending' });
});
it('omission stays absent rather than inventing the default or retaining an earlier override', () => {
  expect(decodeFillParameters(encodeFillParameters(undefined, undefined, 12)).subscriberPriority).toBe(12);
  expect(decodeFillParameters(encodeFillParameters()).subscriberPriority).toBeUndefined();
});
it.each([-1, 256, 1.5, NaN, Infinity])('rejects invalid local priority %s', priority => {
  expect(() => encodeFillParameters(undefined, undefined, priority)).toThrow(RangeError);
});
it('rejects duplicate nested priority and truncated uint8', () => {
  expect(() => decodeFillParameters(Uint8Array.of(2, 0x20, 1, 0x20, 2))).toThrow();
  expect(() => decodeFillParameters(Uint8Array.of(1, 0x20))).toThrow();
});
