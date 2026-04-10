import { describe, it, expect } from 'vitest';
import { readLocation, writeLocation, locationEncodingLength, type Location } from './location.js';
import { varint } from './varint.js';

describe('Location', () => {
  function roundTrip(loc: Location): Location {
    const len = locationEncodingLength(loc);
    const buf = new Uint8Array(len + 10);
    const written = writeLocation(loc, buf, 0);
    expect(written).toBe(len);
    const { value, bytesRead } = readLocation(buf, 0);
    expect(bytesRead).toBe(len);
    return value;
  }

  it('round-trips {0, 0}', () => {
    const loc = { group: varint(0), object: varint(0) };
    const result = roundTrip(loc);
    expect(result.group).toBe(0n);
    expect(result.object).toBe(0n);
  });

  it('round-trips {1, 0} (first group, first object)', () => {
    const loc = { group: varint(1), object: varint(0) };
    const result = roundTrip(loc);
    expect(result.group).toBe(1n);
    expect(result.object).toBe(0n);
  });

  it('round-trips large values', () => {
    const loc = { group: varint(1073741824), object: varint(16384) };
    const result = roundTrip(loc);
    expect(result.group).toBe(1073741824n);
    expect(result.object).toBe(16384n);
  });

  it('encodes as two consecutive varints', () => {
    const loc = { group: varint(5), object: varint(10) };
    const len = locationEncodingLength(loc);
    expect(len).toBe(2); // both fit in 1-byte varints
  });

  it('reads from non-zero offset', () => {
    const loc = { group: varint(3), object: varint(7) };
    const buf = new Uint8Array(20);
    buf[0] = 0xff; // junk
    const written = writeLocation(loc, buf, 3);
    const { value, bytesRead } = readLocation(buf, 3);
    expect(bytesRead).toBe(written);
    expect(value.group).toBe(3n);
    expect(value.object).toBe(7n);
  });
});
