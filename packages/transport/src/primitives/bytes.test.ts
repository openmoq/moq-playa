import { describe, it, expect } from 'vitest';
import {
  readUint8,
  writeUint8,
  readBytes,
  readLengthPrefixedBytes,
  writeLengthPrefixedBytes,
  lengthPrefixedBytesEncodingLength,
  readTuple,
  writeTuple,
  tupleEncodingLength,
  validateTrackNamespace,
  validateTrackNamespacePrefix,
  validateTrackNamespaceSuffix,
  validateFullTrackName,
  isReservedSessionNamespace,
  isReservedDotNamespace,
} from './bytes.js';
import { varint, writeVarint, varintEncodingLength } from './varint.js';
import { ProtocolViolationError } from '../errors.js';

describe('readUint8() / writeUint8()', () => {
  it('reads a byte at offset 0', () => {
    const buf = new Uint8Array([0x42]);
    const { value, bytesRead } = readUint8(buf, 0);
    expect(value).toBe(0x42);
    expect(bytesRead).toBe(1);
  });

  it('reads a byte at a non-zero offset', () => {
    const buf = new Uint8Array([0x00, 0xff, 0x00]);
    const { value } = readUint8(buf, 1);
    expect(value).toBe(0xff);
  });

  it('writes a byte at offset 0', () => {
    const buf = new Uint8Array(3);
    const written = writeUint8(0xab, buf, 0);
    expect(written).toBe(1);
    expect(buf[0]).toBe(0xab);
  });

  it('writes a byte at a non-zero offset', () => {
    const buf = new Uint8Array(3);
    writeUint8(0xcd, buf, 2);
    expect(buf[2]).toBe(0xcd);
  });

  it('round-trips 0 and 255', () => {
    const buf = new Uint8Array(2);
    writeUint8(0, buf, 0);
    writeUint8(255, buf, 1);
    expect(readUint8(buf, 0).value).toBe(0);
    expect(readUint8(buf, 1).value).toBe(255);
  });

  it('throws on out-of-bounds read', () => {
    const buf = new Uint8Array(1);
    expect(() => readUint8(buf, 1)).toThrow();
  });
});

describe('readBytes()', () => {
  it('reads a slice of bytes', () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const { value, bytesRead } = readBytes(buf, 1, 3);
    expect(bytesRead).toBe(3);
    expect(value).toEqual(new Uint8Array([0x02, 0x03, 0x04]));
  });

  it('reads 0 bytes', () => {
    const buf = new Uint8Array([0x01]);
    const { value, bytesRead } = readBytes(buf, 0, 0);
    expect(bytesRead).toBe(0);
    expect(value).toEqual(new Uint8Array(0));
  });

  it('throws if not enough bytes', () => {
    const buf = new Uint8Array(2);
    expect(() => readBytes(buf, 0, 3)).toThrow();
  });

  it('returns a copy, not a view', () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03]);
    const { value } = readBytes(buf, 0, 3);
    value[0] = 0xff;
    expect(buf[0]).toBe(0x01); // original unchanged
  });
});

describe('readLengthPrefixedBytes() / writeLengthPrefixedBytes()', () => {
  it('round-trips an empty byte array', () => {
    const data = new Uint8Array(0);
    const buf = new Uint8Array(10);
    const written = writeLengthPrefixedBytes(data, buf, 0);
    expect(written).toBe(1); // varint(0) = 1 byte, 0 data bytes
    const { value, bytesRead } = readLengthPrefixedBytes(buf, 0);
    expect(bytesRead).toBe(1);
    expect(value).toEqual(new Uint8Array(0));
  });

  it('round-trips a short byte array', () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    const buf = new Uint8Array(20);
    const written = writeLengthPrefixedBytes(data, buf, 0);
    expect(written).toBe(1 + 5); // varint(5) = 1 byte + 5 data bytes
    const { value, bytesRead } = readLengthPrefixedBytes(buf, 0);
    expect(bytesRead).toBe(6);
    expect(value).toEqual(data);
  });

  it('writes at a non-zero offset', () => {
    const data = new Uint8Array([0x01, 0x02]);
    const buf = new Uint8Array(20);
    const written = writeLengthPrefixedBytes(data, buf, 5);
    expect(written).toBe(3); // varint(2) + 2 bytes
    const { value } = readLengthPrefixedBytes(buf, 5);
    expect(value).toEqual(data);
  });

  it('round-trips a 100-byte array (2-byte varint length)', () => {
    const data = new Uint8Array(100);
    for (let i = 0; i < 100; i++) data[i] = i & 0xff;
    const buf = new Uint8Array(200);
    const written = writeLengthPrefixedBytes(data, buf, 0);
    // varint(100) fits in 2 bytes (64..16383 range)
    expect(written).toBe(2 + 100);
    const { value, bytesRead } = readLengthPrefixedBytes(buf, 0);
    expect(bytesRead).toBe(102);
    expect(value).toEqual(data);
  });
});

describe('lengthPrefixedBytesEncodingLength()', () => {
  it('returns 1 for empty data', () => {
    expect(lengthPrefixedBytesEncodingLength(new Uint8Array(0))).toBe(1);
  });

  it('returns varint length + data length', () => {
    const data = new Uint8Array(5);
    expect(lengthPrefixedBytesEncodingLength(data)).toBe(1 + 5); // varint(5)=1byte
  });

  it('accounts for 2-byte varint when data >= 64 bytes', () => {
    const data = new Uint8Array(64);
    expect(lengthPrefixedBytesEncodingLength(data)).toBe(2 + 64);
  });
});

describe('readTuple() / writeTuple()', () => {
  it('round-trips an empty tuple', () => {
    const segments: Uint8Array[] = [];
    const buf = new Uint8Array(10);
    const written = writeTuple(segments, buf, 0);
    expect(written).toBe(1); // varint(0)
    const { value, bytesRead } = readTuple(buf, 0);
    expect(bytesRead).toBe(1);
    expect(value).toEqual([]);
  });

  it('round-trips a single-segment tuple', () => {
    const segments = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
    const buf = new Uint8Array(20);
    const written = writeTuple(segments, buf, 0);
    // varint(1) + varint(4) + 4 bytes = 1 + 1 + 4 = 6
    expect(written).toBe(6);
    const { value, bytesRead } = readTuple(buf, 0);
    expect(bytesRead).toBe(6);
    expect(value.length).toBe(1);
    expect(value[0]).toEqual(segments[0]);
  });

  it('round-trips a multi-segment tuple', () => {
    const segments = [
      new Uint8Array([0x6c, 0x69, 0x76, 0x65]), // "live"
      new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]), // "video"
    ];
    const buf = new Uint8Array(30);
    const written = writeTuple(segments, buf, 0);
    // varint(2) + varint(4) + 4 + varint(5) + 5 = 1 + 1 + 4 + 1 + 5 = 12
    expect(written).toBe(12);
    const { value, bytesRead } = readTuple(buf, 0);
    expect(bytesRead).toBe(12);
    expect(value.length).toBe(2);
    expect(value[0]).toEqual(segments[0]);
    expect(value[1]).toEqual(segments[1]);
  });
});

describe('tupleEncodingLength()', () => {
  it('returns 1 for empty tuple', () => {
    expect(tupleEncodingLength([])).toBe(1);
  });

  it('returns correct length for single segment', () => {
    const segments = [new Uint8Array(4)];
    // varint(1) + varint(4) + 4 = 1 + 1 + 4 = 6
    expect(tupleEncodingLength(segments)).toBe(6);
  });
});

// ─── Track Namespace validation tests (§2.4.1) ───────────────────────
describe('validateTrackNamespace()', () => {
  it('accepts 1-32 non-empty fields', () => {
    const segments = [new Uint8Array([0x61])]; // 1 field, 1 byte
    expect(() => validateTrackNamespace(segments)).not.toThrow();
  });

  it('accepts 32 fields (max)', () => {
    const segments = Array.from({ length: 32 }, () => new Uint8Array([0x61]));
    expect(() => validateTrackNamespace(segments)).not.toThrow();
  });

  it('throws ProtocolViolationError on 0 fields (§2.4.1)', () => {
    try {
      validateTrackNamespace([]);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as Error).message).toMatch(/field/i);
    }
  });

  it('throws ProtocolViolationError on >32 fields (§2.4.1)', () => {
    const segments = Array.from({ length: 33 }, () => new Uint8Array([0x61]));
    try {
      validateTrackNamespace(segments);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as Error).message).toMatch(/32/);
    }
  });

  it('throws ProtocolViolationError on empty field (§2.4.1)', () => {
    const segments = [new Uint8Array([0x61]), new Uint8Array(0)];
    try {
      validateTrackNamespace(segments);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as Error).message).toMatch(/length/i);
    }
  });

  it('throws ProtocolViolationError on total length >4096 (§2.4.1)', () => {
    // 4 fields of 1025 bytes each = 4100 bytes > 4096
    const segments = Array.from({ length: 4 }, () => new Uint8Array(1025));
    try {
      validateTrackNamespace(segments);
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as Error).message).toMatch(/4096/);
    }
  });

  it('accepts exactly 4096 bytes total', () => {
    // 4 fields of 1024 bytes each = 4096 bytes
    const segments = Array.from({ length: 4 }, () => new Uint8Array(1024));
    expect(() => validateTrackNamespace(segments)).not.toThrow();
  });
});

describe('validateTrackNamespacePrefix()', () => {
  it('accepts 0 fields (empty prefix)', () => {
    expect(() => validateTrackNamespacePrefix([])).not.toThrow();
  });

  it('accepts 1-32 non-empty fields', () => {
    const segments = [new Uint8Array([0x61])];
    expect(() => validateTrackNamespacePrefix(segments)).not.toThrow();
  });

  it('throws on >32 fields', () => {
    const segments = Array.from({ length: 33 }, () => new Uint8Array([0x61]));
    expect(() => validateTrackNamespacePrefix(segments)).toThrow(/PROTOCOL_VIOLATION|32/i);
  });

  it('throws on empty field (0-length)', () => {
    const segments = [new Uint8Array(0)];
    expect(() => validateTrackNamespacePrefix(segments)).toThrow(/PROTOCOL_VIOLATION|empty|length/i);
  });
});

describe('validateTrackNamespaceSuffix()', () => {
  it('accepts 0 fields (empty suffix when prefix is full namespace)', () => {
    expect(() => validateTrackNamespaceSuffix([])).not.toThrow();
  });

  it('accepts 1-32 non-empty fields', () => {
    const segments = [new Uint8Array([0x61])];
    expect(() => validateTrackNamespaceSuffix(segments)).not.toThrow();
  });

  it('accepts 32 fields (max)', () => {
    const segments = Array.from({ length: 32 }, () => new Uint8Array([0x61]));
    expect(() => validateTrackNamespaceSuffix(segments)).not.toThrow();
  });

  it('throws on >32 fields', () => {
    const segments = Array.from({ length: 33 }, () => new Uint8Array([0x61]));
    expect(() => validateTrackNamespaceSuffix(segments)).toThrow(/PROTOCOL_VIOLATION|32/i);
  });

  it('throws on empty field (0-length)', () => {
    const segments = [new Uint8Array([0x61]), new Uint8Array(0)];
    expect(() => validateTrackNamespaceSuffix(segments)).toThrow(/PROTOCOL_VIOLATION|empty|length/i);
  });

  it('throws on total length >4096', () => {
    // 4 fields of 1025 bytes each = 4100 bytes > 4096
    const segments = Array.from({ length: 4 }, () => new Uint8Array(1025));
    expect(() => validateTrackNamespaceSuffix(segments)).toThrow(/PROTOCOL_VIOLATION|4096/i);
  });

  it('accepts exactly 4096 bytes total', () => {
    // 4 fields of 1024 bytes each = 4096 bytes
    const segments = Array.from({ length: 4 }, () => new Uint8Array(1024));
    expect(() => validateTrackNamespaceSuffix(segments)).not.toThrow();
  });
});

describe('validateFullTrackName()', () => {
  it('accepts valid namespace + track name', () => {
    const namespace = [new Uint8Array([0x61])];
    const trackName = new Uint8Array([0x62]);
    expect(() => validateFullTrackName(namespace, trackName)).not.toThrow();
  });

  it('throws on total length >4096 (namespace + track name)', () => {
    // 3 fields of 1000 bytes + track name of 1097 bytes = 4097 > 4096
    const namespace = Array.from({ length: 3 }, () => new Uint8Array(1000));
    const trackName = new Uint8Array(1097);
    expect(() => validateFullTrackName(namespace, trackName)).toThrow(/PROTOCOL_VIOLATION|4096/i);
  });

  it('accepts exactly 4096 bytes total', () => {
    const namespace = Array.from({ length: 3 }, () => new Uint8Array(1000));
    const trackName = new Uint8Array(1096); // 3000 + 1096 = 4096
    expect(() => validateFullTrackName(namespace, trackName)).not.toThrow();
  });

  // draft-18 §2.4.1: an EMPTY namespace (0 fields) is legal when opted in.
  it('accepts an empty namespace with allowEmptyNamespace (draft-18 §2.4.1)', () => {
    expect(() => validateFullTrackName([], new Uint8Array([0x62]), { allowEmptyNamespace: true })).not.toThrow();
  });

  it('still rejects an empty namespace by default (legacy draft-14/16 behavior)', () => {
    expect(() => validateFullTrackName([], new Uint8Array([0x62]))).toThrow(/PROTOCOL_VIOLATION|at least 1 field/i);
  });

  it('rejects an empty FIELD even with allowEmptyNamespace (0-length field ≠ empty namespace)', () => {
    const namespace = [new Uint8Array([0x61]), new Uint8Array(0)]; // second field length 0
    expect(() => validateFullTrackName(namespace, new Uint8Array([0x62]), { allowEmptyNamespace: true }))
      .toThrow(/PROTOCOL_VIOLATION|length 0|at least one byte/i);
  });

  it('enforces the 4096 limit with an empty namespace (track name alone)', () => {
    expect(() => validateFullTrackName([], new Uint8Array(4097), { allowEmptyNamespace: true })).toThrow(/4096/i);
    expect(() => validateFullTrackName([], new Uint8Array(4096), { allowEmptyNamespace: true })).not.toThrow();
  });
});

describe('draft-18 Track Namespace rules (§2.4.1, §3.2)', () => {
  const f = (s: string) => new TextEncoder().encode(s);

  describe('empty full namespace (§2.4.1)', () => {
    it('rejects a zero-field full namespace by default (draft-14/16)', () => {
      expect(() => validateTrackNamespace([])).toThrow(ProtocolViolationError);
    });
    it('accepts a zero-field full namespace with { allowEmpty: true } (draft-18)', () => {
      expect(() => validateTrackNamespace([], { allowEmpty: true })).not.toThrow();
    });
    it('still rejects a zero-length FIELD even when the namespace may be empty', () => {
      expect(() => validateTrackNamespace([new Uint8Array(0)], { allowEmpty: true })).toThrow(/length 0/);
    });
    it('still enforces the 32-field limit with allowEmpty', () => {
      const many = Array.from({ length: 33 }, () => new Uint8Array([0x61]));
      expect(() => validateTrackNamespace(many, { allowEmpty: true })).toThrow(/maximum is 32/);
    });
    it('prefix validation permits 0 fields regardless (separate from full namespace)', () => {
      expect(() => validateTrackNamespacePrefix([])).not.toThrow();
    });
  });

  describe('reserved .session namespace detection (§3.2.2)', () => {
    it('matches a .session first field (exact), with or without further fields', () => {
      expect(isReservedSessionNamespace([f('.session')])).toBe(true);
      expect(isReservedSessionNamespace([f('.session'), f('x')])).toBe(true);
    });
    it('does not match near-misses or non-first positions', () => {
      expect(isReservedSessionNamespace([f('.sessionx')])).toBe(false);
      expect(isReservedSessionNamespace([f('session')])).toBe(false);
      expect(isReservedSessionNamespace([f('x'), f('.session')])).toBe(false); // only the first field counts
      expect(isReservedSessionNamespace([])).toBe(false);
    });
  });

  describe('reserved single-period namespace detection (§3.2.1)', () => {
    it('matches an exact single-period first field', () => {
      expect(isReservedDotNamespace([f('.')])).toBe(true);
      expect(isReservedDotNamespace([f('.'), f('x')])).toBe(true);
    });
    it('does not match multi-char dot fields or .session', () => {
      expect(isReservedDotNamespace([f('..')])).toBe(false);
      expect(isReservedDotNamespace([f('.session')])).toBe(false);
      expect(isReservedDotNamespace([])).toBe(false);
    });
  });
});
