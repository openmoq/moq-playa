import { describe, expect, it } from 'vitest';
import { defaultQueueBytes } from './shaper.mjs';

describe('net shaper', () => {
  it('defaults the queue to about 100 ms or one BDP', () => {
    expect(defaultQueueBytes(1_000_000)).toBe(12500);
    expect(defaultQueueBytes(8_000_000, 100)).toBe(200000);
  });
});
