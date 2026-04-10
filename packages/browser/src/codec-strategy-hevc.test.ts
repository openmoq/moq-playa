/**
 * Tests for HevcStrategy — H.265/HEVC codec strategy.
 *
 * @see ITU-T H.265 §7.3.1.2 (NAL unit header)
 * @see ITU-T H.265 Table 7-1 (NAL unit type codes)
 * @see ISO/IEC 14496-15 §8.3.3.1 (HEVCDecoderConfigurationRecord)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { HevcStrategy, getHvccLengthSize } from './codec-strategy-hevc.js';

/**
 * Encode an HEVC NAL type into the first byte of a 2-byte NAL header.
 * Format: forbidden_zero_bit(1) | nal_unit_type(6) | nuh_layer_id(6) | nuh_temporal_id_plus1(3)
 * Type is at bits 1-6: (type << 1)
 */
function hevcNalHeader(nalType: number): [number, number] {
  return [(nalType << 1) & 0x7E, 0x01]; // layer_id=0, temporal_id=1
}

/** Build a length-prefixed payload from HEVC NAL units with 4-byte lengths. */
function hvcc(nals: Uint8Array[]): Uint8Array {
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

/** Build a NAL unit with the given HEVC type and some payload bytes. */
function hevcNal(nalType: number, payloadSize = 2): Uint8Array {
  const [b0, b1] = hevcNalHeader(nalType);
  const nal = new Uint8Array(2 + payloadSize);
  nal[0] = b0;
  nal[1] = b1;
  for (let i = 0; i < payloadSize; i++) nal[2 + i] = 0xAA;
  return nal;
}

/** Build Annex B payload from HEVC NAL units. */
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

/** Build a minimal HVCC record (23 bytes minimum). */
function buildHvccDescription(lengthSizeMinusOne = 3): Uint8Array {
  const desc = new Uint8Array(23);
  desc[0] = 0x01; // configurationVersion
  desc[1] = 0x01; // general_profile_idc = 1 (Main)
  desc[12] = 93;  // general_level_idc (Level 3.1)
  desc[21] = 0xFC | (lengthSizeMinusOne & 0x03); // lengthSizeMinusOne
  desc[22] = 0;   // numOfArrays
  return desc;
}

describe('HevcStrategy', () => {
  describe('properties', () => {
    it('gates after reset', () => {
      expect(new HevcStrategy().gatesAfterReset).toBe(true);
    });

    it('uses description', () => {
      expect(new HevcStrategy().usesDescription).toBe(true);
    });

    it('does not support software preference', () => {
      expect(new HevcStrategy().supportsSoftwarePreference).toBe(false);
    });
  });

  describe('prepareChunkData', () => {
    it('passes through valid length-prefixed data', () => {
      const strategy = new HevcStrategy();
      const idr = hevcNal(19); // IDR_W_RADL
      const data = hvcc([idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result!.droppedReason).toBeNull();
    });

    it('converts Annex B to length-prefixed format', () => {
      const strategy = new HevcStrategy();
      const idr = hevcNal(19);
      const data = annexb([idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(hvcc([idr]));
    });

    it('strips AUD (type 35)', () => {
      const strategy = new HevcStrategy();
      const aud = hevcNal(35);
      const idr = hevcNal(19);
      const data = hvcc([aud, idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('aud');
      expect(result!.data).toEqual(hvcc([idr]));
    });

    it('strips EOS (type 36)', () => {
      const strategy = new HevcStrategy();
      const eos = hevcNal(36);
      const trail = hevcNal(1); // TRAIL_R
      const data = hvcc([trail, eos]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('eos');
    });

    it('strips EOB (type 37)', () => {
      const strategy = new HevcStrategy();
      const eob = hevcNal(37);
      const trail = hevcNal(1);
      const data = hvcc([trail, eob]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('eob');
    });

    it('strips filler data (type 38)', () => {
      const strategy = new HevcStrategy();
      const fd = hevcNal(38);
      const trail = hevcNal(1);
      const data = hvcc([trail, fd]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('fd');
    });

    it('keeps VPS (type 32)', () => {
      const strategy = new HevcStrategy();
      const vps = hevcNal(32);
      const idr = hevcNal(19);
      const data = hvcc([vps, idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(data);
      expect(result!.droppedReason).toBeNull();
    });

    it('keeps SPS (type 33)', () => {
      const strategy = new HevcStrategy();
      const sps = hevcNal(33);
      const idr = hevcNal(19);
      const data = hvcc([sps, idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toBeNull();
    });

    it('keeps PPS (type 34)', () => {
      const strategy = new HevcStrategy();
      const pps = hevcNal(34);
      const idr = hevcNal(19);
      const data = hvcc([pps, idr]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toBeNull();
    });

    it('returns null when no VCL NALs remain', () => {
      const strategy = new HevcStrategy();
      const aud = hevcNal(35);
      const data = hvcc([aud]);
      const result = strategy.prepareChunkData(data, undefined);
      expect(result).toBeNull();
    });

    it('discards RASL after IRAP (types 8,9)', () => {
      const strategy = new HevcStrategy();
      // First: an IRAP (IDR) — this sets discardRasl = false
      const idr = hevcNal(19);
      const idrData = hvcc([idr]);
      strategy.prepareChunkData(idrData, undefined);

      // But a fresh strategy starts with discardRasl=true
      const strategy2 = new HevcStrategy();
      const rasl = hevcNal(8); // RASL_N
      const trail = hevcNal(1); // TRAIL_R
      const data = hvcc([rasl, trail]);
      const result = strategy2.prepareChunkData(data, undefined);
      expect(result).not.toBeNull();
      expect(result!.droppedReason).toContain('rasl_n');
    });
  });

  describe('isAcceptableSyncPoint', () => {
    it('accepts IDR_W_RADL (type 19)', () => {
      const strategy = new HevcStrategy();
      const idr = hevcNal(19);
      const data = hvcc([idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });

    it('accepts IDR_N_LP (type 20)', () => {
      const strategy = new HevcStrategy();
      const idr = hevcNal(20);
      const data = hvcc([idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });

    it('accepts CRA (type 21)', () => {
      const strategy = new HevcStrategy();
      const cra = hevcNal(21);
      const data = hvcc([cra]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });

    it('accepts BLA types (16-18)', () => {
      const strategy = new HevcStrategy();
      for (const type of [16, 17, 18]) {
        const bla = hevcNal(type);
        const data = hvcc([bla]);
        expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
      }
    });

    it('rejects delta chunk type', () => {
      const strategy = new HevcStrategy();
      const idr = hevcNal(19);
      const data = hvcc([idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'delta', undefined)).toBe(false);
    });

    it('rejects non-IRAP VCL types', () => {
      const strategy = new HevcStrategy();
      const trail = hevcNal(1); // TRAIL_R
      const data = hvcc([trail]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(false);
    });

    it('accepts VPS + SPS + PPS + IDR combination', () => {
      const strategy = new HevcStrategy();
      const vps = hevcNal(32);
      const sps = hevcNal(33);
      const pps = hevcNal(34);
      const idr = hevcNal(19);
      const data = hvcc([vps, sps, pps, idr]);
      expect(strategy.isAcceptableSyncPoint(data, 'key', undefined)).toBe(true);
    });
  });

  describe('describeChunk', () => {
    it('returns NAL-level summary', () => {
      const strategy = new HevcStrategy();
      const idr = hevcNal(19);
      const data = hvcc([idr]);
      const desc = strategy.describeChunk!(data, 'key', undefined);
      expect(desc).toContain('irap=true');
      expect(desc).toContain('idr_w_radl');
    });
  });

  describe('describeConfig', () => {
    it('parses HVCC record', () => {
      const strategy = new HevcStrategy();
      const desc = strategy.describeConfig!(buildHvccDescription());
      expect(desc).toContain('hvcc');
      expect(desc).toContain('profile=1');
    });

    it('handles missing description', () => {
      const strategy = new HevcStrategy();
      expect(strategy.describeConfig!(undefined)).toBe('none');
    });
  });
});

describe('getHvccLengthSize', () => {
  it('extracts length size from byte 21', () => {
    const desc = buildHvccDescription(3); // lengthSizeMinusOne=3 → size=4
    expect(getHvccLengthSize(desc)).toBe(4);
  });

  it('returns 4 for undefined description', () => {
    expect(getHvccLengthSize(undefined)).toBe(4);
  });

  it('returns 4 for too-short description', () => {
    expect(getHvccLengthSize(new Uint8Array(10))).toBe(4);
  });

  it('extracts length size 2 (lengthSizeMinusOne=1)', () => {
    const desc = buildHvccDescription(1);
    expect(getHvccLengthSize(desc)).toBe(2);
  });
});
