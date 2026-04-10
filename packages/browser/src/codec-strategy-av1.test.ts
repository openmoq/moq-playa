/**
 * Tests for Av1Strategy — AV1 codec strategy.
 *
 * @see AV1 Spec §5.3.1 (OBU header syntax)
 * @see AV1 Spec §6.2.2 (OBU types)
 * @see W3C WebCodecs AV1 Registration (description not used)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { Av1Strategy, readLeb128 } from './codec-strategy-av1.js';

// OBU type constants
const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;
const OBU_FRAME_HEADER = 3;
const OBU_FRAME = 6;
const OBU_REDUNDANT_FRAME_HEADER = 7;
const OBU_TILE_LIST = 8;
const OBU_PADDING = 15;

/**
 * Build an OBU with header + LEB128 size + payload.
 * Header byte: forbidden(0) | obu_type(4) | extension_flag(0) | has_size_field(1) | reserved(0)
 */
function obu(type: number, payload: Uint8Array): Uint8Array {
  const headerByte = ((type & 0x0F) << 3) | 0x02; // has_size_field=1
  const sizeBytes = encodeLeb128(payload.byteLength);
  const out = new Uint8Array(1 + sizeBytes.byteLength + payload.byteLength);
  out[0] = headerByte;
  out.set(sizeBytes, 1);
  out.set(payload, 1 + sizeBytes.byteLength);
  return out;
}

/** Build an OBU stream from multiple OBUs. */
function obuStream(obus: Uint8Array[]): Uint8Array {
  const totalSize = obus.reduce((sum, o) => sum + o.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const o of obus) {
    out.set(o, pos);
    pos += o.byteLength;
  }
  return out;
}

/** Encode a value as LEB128. */
function encodeLeb128(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7F;
    value >>>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return new Uint8Array(bytes);
}

describe('Av1Strategy', () => {
  const strategy = new Av1Strategy();

  describe('properties', () => {
    it('gates after reset', () => {
      expect(strategy.gatesAfterReset).toBe(true);
    });

    it('does NOT use description', () => {
      expect(strategy.usesDescription).toBe(false);
    });

    it('does not support software preference', () => {
      expect(strategy.supportsSoftwarePreference).toBe(false);
    });
  });

  describe('prepareChunkData', () => {
    it('passes through data with no strippable OBUs', () => {
      const seqHdr = obu(OBU_SEQUENCE_HEADER, new Uint8Array([0x01, 0x02, 0x03]));
      const frame = obu(OBU_FRAME, new Uint8Array([0x10, 0x20]));
      const data = obuStream([seqHdr, frame]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toBe(data); // same reference — no copy
      expect(result!.droppedReason).toBeNull();
    });

    it('strips OBU_TEMPORAL_DELIMITER (type 2)', () => {
      const td = obu(OBU_TEMPORAL_DELIMITER, new Uint8Array(0));
      const frame = obu(OBU_FRAME, new Uint8Array([0x10, 0x20]));
      const data = obuStream([td, frame]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('td');
      // Only the frame OBU should remain
      expect(result!.data).toEqual(frame);
    });

    it('strips OBU_REDUNDANT_FRAME_HEADER (type 7)', () => {
      const frame = obu(OBU_FRAME, new Uint8Array([0x10]));
      const redundant = obu(OBU_REDUNDANT_FRAME_HEADER, new Uint8Array([0x10]));
      const data = obuStream([frame, redundant]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('redundant_hdr');
      expect(result!.data).toEqual(frame);
    });

    it('strips OBU_TILE_LIST (type 8)', () => {
      const frame = obu(OBU_FRAME, new Uint8Array([0x10]));
      const tileList = obu(OBU_TILE_LIST, new Uint8Array([0x01, 0x02]));
      const data = obuStream([frame, tileList]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('tile_list');
    });

    it('strips OBU_PADDING (type 15)', () => {
      const frame = obu(OBU_FRAME, new Uint8Array([0x10]));
      const padding = obu(OBU_PADDING, new Uint8Array(16)); // 16 bytes of padding
      const data = obuStream([frame, padding]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('padding');
      expect(result!.data).toEqual(frame);
    });

    it('keeps OBU_SEQUENCE_HEADER (type 1)', () => {
      const seqHdr = obu(OBU_SEQUENCE_HEADER, new Uint8Array([0x01]));
      const data = obuStream([seqHdr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toBe(data);
      expect(result!.droppedReason).toBeNull();
    });

    it('keeps OBU_FRAME_HEADER (type 3)', () => {
      const frameHdr = obu(OBU_FRAME_HEADER, new Uint8Array([0x01]));
      const data = obuStream([frameHdr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toBeNull();
    });

    it('handles OBU with extension flag', () => {
      // Header with extension_flag=1, has_size_field=1
      const headerByte = ((OBU_FRAME & 0x0F) << 3) | 0x06; // ext=1, size=1
      const extByte = 0x00; // temporal_id=0, spatial_id=0
      const payload = new Uint8Array([0x10, 0x20]);
      const sizeBytes = encodeLeb128(payload.byteLength);
      const obuData = new Uint8Array(2 + sizeBytes.byteLength + payload.byteLength);
      obuData[0] = headerByte;
      obuData[1] = extByte;
      obuData.set(sizeBytes, 2);
      obuData.set(payload, 2 + sizeBytes.byteLength);

      const result = strategy.prepareChunkData(obuData, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toBe(obuData);
      expect(result!.droppedReason).toBeNull();
    });

    it('strips multiple OBU types in one stream', () => {
      const td = obu(OBU_TEMPORAL_DELIMITER, new Uint8Array(0));
      const seqHdr = obu(OBU_SEQUENCE_HEADER, new Uint8Array([0x01]));
      const padding = obu(OBU_PADDING, new Uint8Array(4));
      const frame = obu(OBU_FRAME, new Uint8Array([0x10]));
      const data = obuStream([td, seqHdr, padding, frame]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('td');
      expect(result!.droppedReason).toContain('padding');
      expect(result!.data).toEqual(obuStream([seqHdr, frame]));
    });
  });

  describe('isAcceptableSyncPoint', () => {
    it('accepts when OBU_SEQUENCE_HEADER present and chunk type is key', () => {
      const seqHdr = obu(OBU_SEQUENCE_HEADER, new Uint8Array([0x01, 0x02]));
      const frame = obu(OBU_FRAME, new Uint8Array([0x10]));
      const data = obuStream([seqHdr, frame]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });

    it('rejects delta chunk type even with sequence header', () => {
      const seqHdr = obu(OBU_SEQUENCE_HEADER, new Uint8Array([0x01]));
      const data = obuStream([seqHdr]);
      expect(strategy.isAcceptableSyncPoint(data, 'delta', undefined)).toBe(false);
    });

    it('rejects key chunk without sequence header', () => {
      const frame = obu(OBU_FRAME, new Uint8Array([0x10, 0x20]));
      const data = obuStream([frame]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(false);
    });
  });

  describe('describeChunk', () => {
    it('returns OBU-level summary', () => {
      const seqHdr = obu(OBU_SEQUENCE_HEADER, new Uint8Array([0x01]));
      const frame = obu(OBU_FRAME, new Uint8Array([0x10]));
      const data = obuStream([seqHdr, frame]);
      const desc = strategy.describeChunk!(data, 'key', undefined);
      expect(desc).toContain('seqhdr=true');
      expect(desc).toContain('seq_hdr');
      expect(desc).toContain('frame');
    });
  });
});

describe('readLeb128', () => {
  it('reads single-byte value', () => {
    const data = new Uint8Array([0x7F]); // 127
    const result = readLeb128(data, 0);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(127);
    expect(result!.bytesRead).toBe(1);
  });

  it('reads zero', () => {
    const data = new Uint8Array([0x00]);
    const result = readLeb128(data, 0);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(0);
    expect(result!.bytesRead).toBe(1);
  });

  it('reads multi-byte value', () => {
    // 300 = 0b100101100 → LEB128: [0xAC, 0x02]
    const data = new Uint8Array([0xAC, 0x02]);
    const result = readLeb128(data, 0);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(300);
    expect(result!.bytesRead).toBe(2);
  });

  it('reads at offset', () => {
    const data = new Uint8Array([0xFF, 0xFF, 0x7F]); // skip first 2
    const result = readLeb128(data, 2);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(127);
    expect(result!.bytesRead).toBe(1);
  });

  it('returns null for empty data', () => {
    expect(readLeb128(new Uint8Array(0), 0)).toBeNull();
  });

  it('returns null when offset past end', () => {
    const data = new Uint8Array([0x01]);
    expect(readLeb128(data, 5)).toBeNull();
  });
});
