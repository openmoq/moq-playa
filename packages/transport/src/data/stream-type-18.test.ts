/**
 * draft-18 stream-type classification (Codex note #2): the stream type is a
 * vi64 VALUE, so multi-byte types (SETUP 0x2F00, PADDING 0x132B3E28) must be
 * decoded as a full vi64 — not classified by peeking the first byte.
 */
import { describe, it, expect } from 'vitest';
import { classifyStream18, classifyStreamTypeValue18 } from './stream-type-18.js';
import { StreamType18 } from './codes-18.js';
import { writeVi64 } from '../primitives/vi64.js';

function vi64Bytes(value: number | bigint): Uint8Array {
  const buf = new Uint8Array(9);
  const n = writeVi64(BigInt(value), buf, 0);
  return buf.subarray(0, n);
}

describe('classifyStream18', () => {
  it('classifies a 1-byte FETCH_HEADER (0x05)', () => {
    expect(classifyStream18(vi64Bytes(StreamType18.FETCH_HEADER), 0)).toEqual({
      streamType: 0x05n,
      kind: 'fetch',
      bytesRead: 1,
    });
  });

  it('classifies a 1-byte SUBGROUP_HEADER, including the FIRST_OBJECT band', () => {
    expect(classifyStream18(vi64Bytes(0x14)).kind).toBe('subgroup');
    expect(classifyStream18(vi64Bytes(0x54)).kind).toBe('subgroup'); // 0x14 | FIRST_OBJECT
  });

  it('classifies the 2-byte SETUP (0x2F00) — first wire byte is 0xAF, not a peek', () => {
    const buf = vi64Bytes(StreamType18.SETUP);
    expect(buf[0]).toBe(0xaf); // proves a 1-byte peek would NOT see 0x2F00
    expect(buf.length).toBe(2);
    expect(classifyStream18(buf, 0)).toEqual({ streamType: 0x2f00n, kind: 'setup', bytesRead: 2 });
  });

  it('classifies the multi-byte PADDING (0x132B3E28) — first wire byte is 0xF0', () => {
    const buf = vi64Bytes(StreamType18.PADDING);
    expect(buf[0]).toBe(0xf0);
    expect(classifyStream18(buf, 0)).toEqual({
      streamType: 0x132b3e28n,
      kind: 'padding',
      bytesRead: buf.length,
    });
  });

  it('returns unknown for an unrecognized vi64 stream type', () => {
    expect(classifyStream18(vi64Bytes(0x09)).kind).toBe('unknown');
    expect(classifyStream18(vi64Bytes(0x999999)).kind).toBe('unknown');
  });

  it('reads at an offset', () => {
    const padding = vi64Bytes(0xaa);
    const fetch = vi64Bytes(StreamType18.FETCH_HEADER);
    const buf = new Uint8Array([...padding, ...fetch]);
    expect(classifyStream18(buf, padding.length).kind).toBe('fetch');
  });
});

describe('classifyStreamTypeValue18 (value-only)', () => {
  it('maps the known stream type values', () => {
    expect(classifyStreamTypeValue18(0x05n)).toBe('fetch');
    expect(classifyStreamTypeValue18(0x2f00n)).toBe('setup');
    expect(classifyStreamTypeValue18(0x132b3e28n)).toBe('padding');
    expect(classifyStreamTypeValue18(0x10n)).toBe('subgroup');
    expect(classifyStreamTypeValue18(0x00n)).toBe('unknown'); // bit 4 clear
    expect(classifyStreamTypeValue18(0x40n)).toBe('unknown'); // bit 4 clear
  });
});
