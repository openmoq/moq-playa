/**
 * Tests for shared NAL unit framing utilities.
 *
 * These utilities handle length-prefix and Annex B start-code formats
 * used by both H.264/AVC and H.265/HEVC bitstreams.
 *
 * @see draft-ietf-moq-loc-01 §2.1.3 (length prefixes)
 * @see draft-ietf-moq-loc-01 §2.1.4 (start code prefixes)
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  isValidLengthPrefixed,
  isAnnexB,
  annexBToLengthPrefixed,
  findStartCode,
  writeLength,
} from './nal-framing.js';

describe('isValidLengthPrefixed', () => {
  it('validates a single NAL with 4-byte length prefix', () => {
    // 4-byte length = 3, then 3 bytes of NAL data
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84]);
    expect(isValidLengthPrefixed(data, 4)).toBe(true);
  });

  it('validates two chained NALs with 4-byte length prefixes', () => {
    const data = new Uint8Array([
      0x00, 0x00, 0x00, 0x02, 0x67, 0x42, // NAL 1: len=2
      0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84, // NAL 2: len=3
    ]);
    expect(isValidLengthPrefixed(data, 4)).toBe(true);
  });

  it('validates with 2-byte length prefix', () => {
    const data = new Uint8Array([0x00, 0x03, 0x65, 0x88, 0x84]);
    expect(isValidLengthPrefixed(data, 2)).toBe(true);
  });

  it('rejects truncated data', () => {
    // Length says 10 bytes but only 3 available
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x0A, 0x65, 0x88, 0x84]);
    expect(isValidLengthPrefixed(data, 4)).toBe(false);
  });

  it('rejects zero-length NAL', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    expect(isValidLengthPrefixed(data, 4)).toBe(false);
  });

  it('rejects data too short for even one length prefix', () => {
    const data = new Uint8Array([0x00, 0x00]);
    expect(isValidLengthPrefixed(data, 4)).toBe(false);
  });

  it('rejects data with leftover bytes after last NAL', () => {
    // NAL len=2 + 2 bytes, then 1 extra byte
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88, 0xFF]);
    expect(isValidLengthPrefixed(data, 4)).toBe(false);
  });
});

describe('isAnnexB', () => {
  it('detects 3-byte start code (00 00 01)', () => {
    const data = new Uint8Array([0x00, 0x00, 0x01, 0x65, 0x88]);
    expect(isAnnexB(data)).toBe(true);
  });

  it('detects 4-byte start code (00 00 00 01)', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    expect(isAnnexB(data)).toBe(true);
  });

  it('rejects non-start-code data', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x65]);
    expect(isAnnexB(data)).toBe(false);
  });

  it('rejects data shorter than 3 bytes', () => {
    const data = new Uint8Array([0x00, 0x00]);
    expect(isAnnexB(data)).toBe(false);
  });
});

describe('annexBToLengthPrefixed', () => {
  it('converts single NAL with 4-byte start code', () => {
    const annexB = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84]);
    const result = annexBToLengthPrefixed(annexB, 4);
    // Expect: 4-byte length (3) + 3 bytes NAL data
    expect(result).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84]));
  });

  it('converts single NAL with 3-byte start code', () => {
    const annexB = new Uint8Array([0x00, 0x00, 0x01, 0x65, 0x88, 0x84]);
    const result = annexBToLengthPrefixed(annexB, 4);
    expect(result).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84]));
  });

  it('converts two NALs', () => {
    const annexB = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, // SPS (2 bytes)
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, // IDR (3 bytes)
    ]);
    const result = annexBToLengthPrefixed(annexB, 4);
    expect(result).toEqual(new Uint8Array([
      0x00, 0x00, 0x00, 0x02, 0x67, 0x42,
      0x00, 0x00, 0x00, 0x03, 0x65, 0x88, 0x84,
    ]));
  });

  it('strips trailing zeros between NALs', () => {
    const annexB = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, // SPS
      0x00, // trailing zero before next start code
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, // IDR
    ]);
    const result = annexBToLengthPrefixed(annexB, 4);
    // SPS should be 2 bytes (trailing zero stripped), IDR 2 bytes
    expect(result).toEqual(new Uint8Array([
      0x00, 0x00, 0x00, 0x02, 0x67, 0x42,
      0x00, 0x00, 0x00, 0x02, 0x65, 0x88,
    ]));
  });

  it('returns original data when no start codes found', () => {
    const data = new Uint8Array([0x65, 0x88, 0x84]);
    const result = annexBToLengthPrefixed(data, 4);
    expect(result).toBe(data); // same reference
  });
});

describe('findStartCode', () => {
  it('finds 4-byte start code at beginning', () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    expect(findStartCode(data, 0)).toBe(0);
  });

  it('finds 3-byte start code at beginning', () => {
    const data = new Uint8Array([0x00, 0x00, 0x01, 0x65]);
    expect(findStartCode(data, 0)).toBe(0);
  });

  it('finds start code after offset', () => {
    const data = new Uint8Array([
      0x67, 0x42, // data
      0x00, 0x00, 0x00, 0x01, 0x65, // start code at offset 2
    ]);
    expect(findStartCode(data, 1)).toBe(2);
  });

  it('returns -1 when no start code found', () => {
    const data = new Uint8Array([0x65, 0x88, 0x84, 0xFF]);
    expect(findStartCode(data, 0)).toBe(-1);
  });
});

describe('writeLength', () => {
  it('writes 4-byte big-endian length', () => {
    const buf = new Uint8Array(4);
    writeLength(buf, 0, 258, 4); // 0x00000102
    expect(buf).toEqual(new Uint8Array([0x00, 0x00, 0x01, 0x02]));
  });

  it('writes 2-byte big-endian length', () => {
    const buf = new Uint8Array(2);
    writeLength(buf, 0, 258, 2);
    expect(buf).toEqual(new Uint8Array([0x01, 0x02]));
  });

  it('writes at offset', () => {
    const buf = new Uint8Array(8);
    writeLength(buf, 4, 3, 4);
    expect(buf[4]).toBe(0);
    expect(buf[5]).toBe(0);
    expect(buf[6]).toBe(0);
    expect(buf[7]).toBe(3);
  });
});
