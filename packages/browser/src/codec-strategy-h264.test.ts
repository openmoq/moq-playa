/**
 * Tests for H264Strategy — H.264/AVC codec strategy.
 *
 * @see ITU-T H.264 §7.3.1 (NAL unit syntax)
 * @see ISO/IEC 14496-15 §5.3.3.1 (AVCDecoderConfigurationRecord)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { H264Strategy, getAvccLengthSize } from './codec-strategy-h264.js';

/** Build an AVCC-framed payload from NAL units with 4-byte length prefixes. */
function avcc(nals: Uint8Array[]): Uint8Array {
  const totalSize = nals.reduce((sum, nal) => sum + 4 + nal.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const nal of nals) {
    out[pos] = (nal.byteLength >> 24) & 0xFF;
    out[pos + 1] = (nal.byteLength >> 16) & 0xFF;
    out[pos + 2] = (nal.byteLength >> 8) & 0xFF;
    out[pos + 3] = nal.byteLength & 0xFF;
    pos += 4;
    out.set(nal, pos);
    pos += nal.byteLength;
  }
  return out;
}

/** Build Annex B payload from NAL units with 4-byte start codes. */
function annexb(nals: Uint8Array[]): Uint8Array {
  const totalSize = nals.reduce((sum, nal) => sum + 4 + nal.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const nal of nals) {
    out[pos] = 0x00; out[pos + 1] = 0x00; out[pos + 2] = 0x00; out[pos + 3] = 0x01;
    pos += 4;
    out.set(nal, pos);
    pos += nal.byteLength;
  }
  return out;
}

/** Build a minimal valid AVCDecoderConfigurationRecord. */
function buildAvccDescription(lengthSizeMinusOne = 3): Uint8Array {
  return new Uint8Array([
    0x01,       // configurationVersion
    0x42,       // profile (Baseline)
    0xC0,       // compatibility
    0x1F,       // level 3.1
    0xFC | (lengthSizeMinusOne & 0x03), // lengthSizeMinusOne
    0xE1,       // 1 SPS
    0x00, 0x02, 0x67, 0x42, // SPS data (2 bytes)
    0x01,       // 1 PPS
    0x00, 0x01, 0x68,       // PPS data (1 byte)
  ]);
}

describe('H264Strategy', () => {
  const strategy = new H264Strategy();

  describe('properties', () => {
    it('gates after reset', () => {
      expect(strategy.gatesAfterReset).toBe(true);
    });

    it('uses description', () => {
      expect(strategy.usesDescription).toBe(true);
    });

    it('supports software preference', () => {
      expect(strategy.supportsSoftwarePreference).toBe(true);
    });
  });

  describe('prepareChunkData', () => {
    it('passes through valid AVCC data unchanged', () => {
      const idr = new Uint8Array([0x65, 0x88, 0x84]); // NAL type 5 (IDR)
      const data = avcc([idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result!.droppedReason).toBeNull();
    });

    it('converts Annex B to AVCC format', () => {
      const idr = new Uint8Array([0x65, 0x88, 0x84]);
      const data = annexb([idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      // Should be AVCC format: 4-byte length + NAL data
      expect(result!.data).toEqual(avcc([idr]));
    });

    it('strips reserved NAL type 0', () => {
      const reserved = new Uint8Array([0x00, 0xAA]); // NAL type 0
      const idr = new Uint8Array([0x65, 0x88, 0x84]); // NAL type 5
      const data = avcc([reserved, idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('nal-type-0');
      // Only IDR should remain
      expect(result!.data).toEqual(avcc([idr]));
    });

    it('strips data partition NAL types 2-4', () => {
      const partition = new Uint8Array([0x43, 0xAA]); // NAL type 3
      const idr = new Uint8Array([0x65, 0x88]); // NAL type 5
      const data = avcc([partition, idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('nal-type-3');
    });

    it('returns null when no VCL NALs remain', () => {
      const sei = new Uint8Array([0x06, 0x01, 0x04]); // NAL type 6 (SEI, non-VCL)
      const data = avcc([sei]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).toBeNull();
    });

    it('uses lengthSize from AVCC description', () => {
      // 2-byte length prefix (lengthSizeMinusOne = 1)
      const desc = buildAvccDescription(1);
      const idr = new Uint8Array([0x65, 0x88]);
      // Build with 2-byte length prefix
      const data = new Uint8Array([0x00, 0x02, 0x65, 0x88]);
      const result = strategy.prepareChunkData(data, desc);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
    });
  });

  describe('isAcceptableSyncPoint', () => {
    it('accepts IDR (NAL type 5) with key chunk type', () => {
      const idr = new Uint8Array([0x65, 0x88, 0x84]);
      const data = avcc([idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });

    it('rejects delta chunk type even with IDR NAL', () => {
      const idr = new Uint8Array([0x65, 0x88, 0x84]);
      const data = avcc([idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'delta', undefined)).toBe(false);
    });

    it('rejects key chunk without IDR NAL', () => {
      const nonIdr = new Uint8Array([0x41, 0x9A, 0x24]); // NAL type 1
      const data = avcc([nonIdr]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(false);
    });

    it('accepts SPS + IDR combination', () => {
      const sps = new Uint8Array([0x67, 0x42, 0xC0]); // NAL type 7
      const idr = new Uint8Array([0x65, 0x88, 0x84]); // NAL type 5
      const data = avcc([sps, idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });
  });

  describe('describeChunk', () => {
    it('returns NAL-level summary', () => {
      const idr = new Uint8Array([0x65, 0x88]);
      const data = avcc([idr]);
      const desc = strategy.describeChunk!(data, 'key', undefined);
      expect(desc).toContain('idr');
      expect(desc).toContain('type=key');
    });
  });

  describe('describeConfig', () => {
    it('parses AVCC record', () => {
      const desc = strategy.describeConfig!(buildAvccDescription());
      expect(desc).toContain('avcc');
      expect(desc).toContain('profile=0x42');
    });

    it('handles missing description', () => {
      expect(strategy.describeConfig!(undefined)).toBe('none');
    });
  });
});

describe('getAvccLengthSize', () => {
  it('extracts length size from byte 4', () => {
    const desc = buildAvccDescription(3); // lengthSizeMinusOne=3 → size=4
    expect(getAvccLengthSize(desc)).toBe(4);
  });

  it('returns 4 for undefined description', () => {
    expect(getAvccLengthSize(undefined)).toBe(4);
  });

  it('returns 4 for too-short description', () => {
    expect(getAvccLengthSize(new Uint8Array([0x01, 0x42]))).toBe(4);
  });

  it('extracts length size 2 (lengthSizeMinusOne=1)', () => {
    const desc = buildAvccDescription(1);
    expect(getAvccLengthSize(desc)).toBe(2);
  });
});
