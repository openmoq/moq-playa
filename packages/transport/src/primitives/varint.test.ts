import { describe, it, expect } from 'vitest';
import {
  varint,
  readVarint,
  writeVarint,
  varintEncodingLength,
  MAX_VARINT,
  type Varint,
} from './varint.js';

describe('range enforcement for raw bigint inputs (Option-A widening guardrail)', () => {
  // After widening message fields to bigint, the QUIC encoders accept bigint and
  // MUST reject out-of-QUIC-range values rather than silently truncating, so a
  // draft-14/16 message can never encode a value > 2^62-1.
  it('varintEncodingLength throws on values above MAX_VARINT', () => {
    expect(() => varintEncodingLength((MAX_VARINT + 1n) as bigint)).toThrow(RangeError);
    expect(() => varintEncodingLength((1n << 63n) as bigint)).toThrow(RangeError);
  });
  it('varintEncodingLength throws on negative values', () => {
    expect(() => varintEncodingLength(-1n as bigint)).toThrow(RangeError);
  });
  it('writeVarint throws (no silent truncation) on values above MAX_VARINT', () => {
    const buf = new Uint8Array(8);
    expect(() => writeVarint((MAX_VARINT + 1n) as bigint, buf, 0)).toThrow(RangeError);
  });
  it('still accepts in-range bigint (Varint subtype) unchanged', () => {
    expect(varintEncodingLength(MAX_VARINT)).toBe(8);
    const buf = new Uint8Array(8);
    expect(writeVarint(MAX_VARINT, buf, 0)).toBe(8);
  });
});

describe('varint()', () => {
  it('creates a branded Varint from valid number values', () => {
    expect(varint(0)).toBe(0n);
    expect(varint(1)).toBe(1n);
    expect(varint(63)).toBe(63n);
    expect(varint(64)).toBe(64n);
    expect(varint(16383)).toBe(16383n);
    expect(varint(16384)).toBe(16384n);
    expect(varint(1073741823)).toBe(1073741823n);
    expect(varint(1073741824)).toBe(1073741824n);
  });

  it('creates a branded Varint from valid bigint values', () => {
    expect(varint(0n)).toBe(0n);
    expect(varint(1n)).toBe(1n);
    expect(varint(63n)).toBe(63n);
    expect(varint(16383n)).toBe(16383n);
    expect(varint(1073741823n)).toBe(1073741823n);
  });

  it('accepts Number.MAX_SAFE_INTEGER', () => {
    expect(varint(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('accepts values > MAX_SAFE_INTEGER up to MAX_VARINT', () => {
    const big = 2n ** 53n; // just above MAX_SAFE_INTEGER
    expect(varint(big)).toBe(big);
    expect(varint(2n ** 60n)).toBe(2n ** 60n);
    expect(varint(MAX_VARINT)).toBe(MAX_VARINT);
  });

  it('throws RangeError for negative values', () => {
    expect(() => varint(-1)).toThrow(RangeError);
    expect(() => varint(-100)).toThrow(RangeError);
    expect(() => varint(-1n)).toThrow(RangeError);
  });

  it('throws RangeError for non-integer number values', () => {
    expect(() => varint(1.5)).toThrow(RangeError);
    expect(() => varint(0.1)).toThrow(RangeError);
    expect(() => varint(NaN)).toThrow(RangeError);
    expect(() => varint(Infinity)).toThrow(RangeError);
  });

  it('throws RangeError for values > MAX_VARINT', () => {
    expect(() => varint(MAX_VARINT + 1n)).toThrow(RangeError);
    expect(() => varint(2n ** 62n)).toThrow(RangeError);
    expect(() => varint(2n ** 63n)).toThrow(RangeError);
  });

  it('throws RangeError for number values > MAX_SAFE_INTEGER', () => {
    // Numbers above MAX_SAFE_INTEGER lose precision when converted to bigint
    // varint() should reject them and require bigint for large values
    const aboveSafe = Number.MAX_SAFE_INTEGER + 1; // 2^53, loses precision as number
    expect(() => varint(aboveSafe)).toThrow(RangeError);

    // Even larger values
    const wayAboveSafe = Number.MAX_SAFE_INTEGER + 1000;
    expect(() => varint(wayAboveSafe)).toThrow(RangeError);
  });

  it('accepts MAX_SAFE_INTEGER as number', () => {
    expect(() => varint(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(varint(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe('varintEncodingLength()', () => {
  it('returns 1 for values 0..63', () => {
    expect(varintEncodingLength(varint(0))).toBe(1);
    expect(varintEncodingLength(varint(1))).toBe(1);
    expect(varintEncodingLength(varint(63))).toBe(1);
  });

  it('returns 2 for values 64..16383', () => {
    expect(varintEncodingLength(varint(64))).toBe(2);
    expect(varintEncodingLength(varint(100))).toBe(2);
    expect(varintEncodingLength(varint(16383))).toBe(2);
  });

  it('returns 4 for values 16384..1073741823', () => {
    expect(varintEncodingLength(varint(16384))).toBe(4);
    expect(varintEncodingLength(varint(1073741823))).toBe(4);
  });

  it('returns 8 for values 1073741824..MAX_VARINT', () => {
    expect(varintEncodingLength(varint(1073741824))).toBe(8);
    expect(varintEncodingLength(varint(Number.MAX_SAFE_INTEGER))).toBe(8);
    expect(varintEncodingLength(varint(2n ** 53n))).toBe(8);
    expect(varintEncodingLength(varint(2n ** 60n))).toBe(8);
    expect(varintEncodingLength(MAX_VARINT)).toBe(8);
  });
});

describe('writeVarint() + readVarint() round-trip', () => {
  function roundTrip(n: number | bigint): bigint {
    const v = varint(n);
    const len = varintEncodingLength(v);
    const buf = new Uint8Array(8);
    const written = writeVarint(v, buf, 0);
    expect(written).toBe(len);
    const { value, bytesRead } = readVarint(buf, 0);
    expect(bytesRead).toBe(len);
    return value;
  }

  it('round-trips 0', () => {
    expect(roundTrip(0)).toBe(0n);
  });

  it('round-trips 1-byte boundary (63)', () => {
    expect(roundTrip(63)).toBe(63n);
  });

  it('round-trips 2-byte lower boundary (64)', () => {
    expect(roundTrip(64)).toBe(64n);
  });

  it('round-trips 2-byte upper boundary (16383)', () => {
    expect(roundTrip(16383)).toBe(16383n);
  });

  it('round-trips 4-byte lower boundary (16384)', () => {
    expect(roundTrip(16384)).toBe(16384n);
  });

  it('round-trips 4-byte upper boundary (1073741823)', () => {
    expect(roundTrip(1073741823)).toBe(1073741823n);
  });

  it('round-trips 8-byte lower boundary (1073741824)', () => {
    expect(roundTrip(1073741824)).toBe(1073741824n);
  });

  it('round-trips MAX_SAFE_INTEGER', () => {
    expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('round-trips values above MAX_SAFE_INTEGER', () => {
    expect(roundTrip(2n ** 53n)).toBe(2n ** 53n);
    expect(roundTrip(2n ** 60n)).toBe(2n ** 60n);
  });

  it('round-trips MAX_VARINT (2^62 - 1)', () => {
    expect(roundTrip(MAX_VARINT)).toBe(MAX_VARINT);
  });

  it('round-trips typical message type values', () => {
    expect(roundTrip(0x03)).toBe(3n); // SUBSCRIBE
    expect(roundTrip(0x20)).toBe(0x20n); // CLIENT_SETUP
    expect(roundTrip(0x21)).toBe(0x21n); // SERVER_SETUP
  });
});

describe('writeVarint() wire format', () => {
  it('encodes 0 as [0x00]', () => {
    const buf = new Uint8Array(1);
    writeVarint(varint(0), buf, 0);
    expect(buf[0]).toBe(0x00);
  });

  it('encodes 37 as [0x25] (1 byte, first 2 bits = 00)', () => {
    const buf = new Uint8Array(1);
    writeVarint(varint(37), buf, 0);
    expect(buf[0]).toBe(0x25);
  });

  it('encodes 63 as [0x3f]', () => {
    const buf = new Uint8Array(1);
    writeVarint(varint(63), buf, 0);
    expect(buf[0]).toBe(0x3f);
  });

  it('encodes 64 as [0x40, 0x40] (2 bytes, first 2 bits = 01)', () => {
    const buf = new Uint8Array(2);
    writeVarint(varint(64), buf, 0);
    expect(buf[0]).toBe(0x40);
    expect(buf[1]).toBe(0x40);
  });

  it('encodes 16383 as [0x7f, 0xff]', () => {
    const buf = new Uint8Array(2);
    writeVarint(varint(16383), buf, 0);
    expect(buf[0]).toBe(0x7f);
    expect(buf[1]).toBe(0xff);
  });

  it('encodes 16384 as [0x80, 0x00, 0x40, 0x00] (4 bytes, first 2 bits = 10)', () => {
    const buf = new Uint8Array(4);
    writeVarint(varint(16384), buf, 0);
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(0x00);
    expect(buf[2]).toBe(0x40);
    expect(buf[3]).toBe(0x00);
  });

  it('encodes 1073741823 as [0xbf, 0xff, 0xff, 0xff]', () => {
    const buf = new Uint8Array(4);
    writeVarint(varint(1073741823), buf, 0);
    expect(buf[0]).toBe(0xbf);
    expect(buf[1]).toBe(0xff);
    expect(buf[2]).toBe(0xff);
    expect(buf[3]).toBe(0xff);
  });

  it('encodes 1073741824 as 8 bytes (first 2 bits = 11)', () => {
    const buf = new Uint8Array(8);
    writeVarint(varint(1073741824), buf, 0);
    expect(buf[0]! & 0xc0).toBe(0xc0);
    const { value } = readVarint(buf, 0);
    expect(value).toBe(1073741824n);
  });

  it('encodes MAX_VARINT as 8 bytes with correct first byte', () => {
    const buf = new Uint8Array(8);
    writeVarint(MAX_VARINT, buf, 0);
    // MAX_VARINT = 2^62 - 1 = 0x3FFFFFFFFFFFFFFF
    // First byte = 0xC0 | 0x3F = 0xFF, remaining 7 bytes all 0xFF
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xff);
    expect(buf[2]).toBe(0xff);
    expect(buf[3]).toBe(0xff);
    expect(buf[4]).toBe(0xff);
    expect(buf[5]).toBe(0xff);
    expect(buf[6]).toBe(0xff);
    expect(buf[7]).toBe(0xff);
  });
});

describe('readVarint()', () => {
  it('reads from a non-zero offset', () => {
    const buf = new Uint8Array([0xff, 0xff, 0x25]); // junk + varint(37) at offset 2
    const { value, bytesRead } = readVarint(buf, 2);
    expect(value).toBe(37n);
    expect(bytesRead).toBe(1);
  });

  it('reads a 2-byte varint from the middle of a buffer', () => {
    const buf = new Uint8Array(10);
    buf[3] = 0x40;
    buf[4] = 0x40; // varint(64) at offset 3
    const { value, bytesRead } = readVarint(buf, 3);
    expect(value).toBe(64n);
    expect(bytesRead).toBe(2);
  });

  it('correctly masks off the length bits', () => {
    // 2-byte varint: first 2 bits are 01, remaining 14 bits are the value
    // value 494 = 0x01EE → with 01 prefix → 0x41, 0xEE
    const buf = new Uint8Array([0x41, 0xee]);
    const { value } = readVarint(buf, 0);
    expect(value).toBe(494n);
  });

  it('throws if buffer is too short for indicated length', () => {
    const buf = new Uint8Array([0x40]);
    expect(() => readVarint(buf, 0)).toThrow();
  });

  it('throws if offset is past end of buffer', () => {
    const buf = new Uint8Array(1);
    expect(() => readVarint(buf, 1)).toThrow();
  });

  it('reads MAX_VARINT from a hand-crafted 8-byte buffer', () => {
    // MAX_VARINT = 2^62 - 1 = 0x3FFFFFFFFFFFFFFF
    // With 8-byte prefix (11): 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF 0xFF
    const buf = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const { value, bytesRead } = readVarint(buf, 0);
    expect(value).toBe(MAX_VARINT);
    expect(bytesRead).toBe(8);
  });
});

describe('MAX_VARINT', () => {
  it('equals 2^62 - 1 as bigint', () => {
    expect(MAX_VARINT).toBe(2n ** 62n - 1n);
  });

  it('is a bigint', () => {
    expect(typeof MAX_VARINT).toBe('bigint');
  });
});
