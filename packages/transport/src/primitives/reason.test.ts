import { describe, it, expect } from 'vitest';
import { readReasonPhrase, writeReasonPhrase, reasonPhraseEncodingLength } from './reason.js';

describe('ReasonPhrase', () => {
  function roundTrip(reason: string): string {
    const len = reasonPhraseEncodingLength(reason);
    const buf = new Uint8Array(len + 10);
    const written = writeReasonPhrase(reason, buf, 0);
    expect(written).toBe(len);
    const { value, bytesRead } = readReasonPhrase(buf, 0);
    expect(bytesRead).toBe(len);
    return value;
  }

  it('round-trips an empty string', () => {
    expect(roundTrip('')).toBe('');
  });

  it('round-trips a short ASCII string', () => {
    expect(roundTrip('Internal Error')).toBe('Internal Error');
  });

  it('round-trips a UTF-8 string with multibyte chars', () => {
    expect(roundTrip('Error: café')).toBe('Error: café');
  });

  it('encoding length is varint(byte-length) + byte-length', () => {
    // ASCII: 1 byte per char
    expect(reasonPhraseEncodingLength('hello')).toBe(1 + 5); // varint(5) + 5
  });

  it('encoding length accounts for multibyte UTF-8', () => {
    // "é" is 2 bytes in UTF-8, so "café" = 5 bytes
    const reason = 'café';
    const encoded = new TextEncoder().encode(reason);
    expect(reasonPhraseEncodingLength(reason)).toBe(1 + encoded.length);
  });

  it('reads from non-zero offset', () => {
    const buf = new Uint8Array(30);
    buf[0] = 0xff; // junk
    const written = writeReasonPhrase('test', buf, 2);
    const { value, bytesRead } = readReasonPhrase(buf, 2);
    expect(bytesRead).toBe(written);
    expect(value).toBe('test');
  });

  it('throws if reason phrase exceeds 1024 bytes', () => {
    // 1025 ASCII chars = 1025 bytes
    const tooLong = 'x'.repeat(1025);
    const buf = new Uint8Array(2000);
    expect(() => writeReasonPhrase(tooLong, buf, 0)).toThrow(RangeError);
  });

  it('throws if multibyte reason phrase exceeds 1024 bytes', () => {
    // Each "á" is 2 bytes in UTF-8, so 513 chars = 1026 bytes
    const tooLong = 'á'.repeat(513);
    const buf = new Uint8Array(2000);
    expect(() => writeReasonPhrase(tooLong, buf, 0)).toThrow(RangeError);
  });

  it('accepts a reason phrase at exactly 1024 bytes', () => {
    const exact = 'x'.repeat(1024);
    const buf = new Uint8Array(2000);
    expect(() => writeReasonPhrase(exact, buf, 0)).not.toThrow();
  });
});

describe('ReasonPhrase decoding bounds checks', () => {
  it('readReasonPhrase throws if length exceeds 1024 bytes', () => {
    // Hand-craft a buffer with length = 1025
    // 1025 as varint (2-byte encoding: 01xxxxxx xxxxxxxx for values 64-16383)
    // 1025 = 0x401 → 2-byte varint: 0x44 0x01
    const buf = new Uint8Array(1030);
    buf[0] = 0x44; // 01 prefix (2-byte) + high 6 bits of 1025 (0x04)
    buf[1] = 0x01; // low 8 bits of 1025 (0x01)
    // Payload bytes don't matter since it should throw on length check

    expect(() => readReasonPhrase(buf, 0)).toThrow(RangeError);
  });

  it('readReasonPhrase accepts length at exactly 1024 bytes', () => {
    // 1024 as varint: 0x44 0x00
    const buf = new Uint8Array(1030);
    buf[0] = 0x44; // 01 prefix + high 6 bits of 1024 (0x04)
    buf[1] = 0x00; // low 8 bits of 1024 (0x00)
    // 1024 bytes of payload
    for (let i = 0; i < 1024; i++) {
      buf[2 + i] = 0x61; // 'a'
    }

    const { value, bytesRead } = readReasonPhrase(buf, 0);
    expect(bytesRead).toBe(2 + 1024);
    expect(value.length).toBe(1024);
  });

  it('readReasonPhrase throws when declared length exceeds remaining buffer', () => {
    // Declare length=10 but only provide 3 bytes of payload after the varint
    const buf = new Uint8Array(4);
    buf[0] = 0x0a; // varint(10) — 1 byte encoding
    buf[1] = 0x61; // 'a'
    buf[2] = 0x62; // 'b'
    buf[3] = 0x63; // 'c'
    // pos=1, numLen=10, pos+numLen=11 > buf.length=4

    expect(() => readReasonPhrase(buf, 0)).toThrow(RangeError);
  });
});
