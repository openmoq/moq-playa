/**
 * Tests for keyframe payload validation.
 *
 * Verifies that isKeyframePayload correctly identifies keyframe vs delta
 * frames from raw codec bitstream bytes (H.264, H.265, AV1).
 *
 * @see draft-ietf-moq-loc-01 §4.2 (group start = independently decodable)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { isKeyframePayload } from './keyframe-validator.js';

describe('isKeyframePayload', () => {
  describe('H.264 (avc1)', () => {
    it('detects IDR slice (NAL type 5) as keyframe', () => {
      // 4-byte length prefix + NAL type 5 (IDR)
      // NAL header: forbidden(0) + nal_ref_idc(11) + nal_type(00101) = 0x65
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x65, 0x88, 0x84]);
      expect(isKeyframePayload('avc1', payload)).toBe(true);
    });

    it('detects SPS (NAL type 7) as keyframe', () => {
      // SPS precedes IDR in a keyframe access unit
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x67, 0x42, 0xC0]);
      expect(isKeyframePayload('avc1', payload)).toBe(true);
    });

    it('detects non-IDR slice (NAL type 1) as delta', () => {
      // NAL type 1 = non-IDR coded slice
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x41, 0x9A, 0x24]);
      expect(isKeyframePayload('avc1', payload)).toBe(false);
    });

    it('detects SEI + IDR as keyframe (skip SEI prefix)', () => {
      // SEI (type 6) then IDR (type 5) — common in production encoders
      // SEI: 4-byte len + 0x06 + data
      // IDR: 4-byte len + 0x65 + data
      const payload = new Uint8Array([
        0x00, 0x00, 0x00, 0x03, 0x06, 0x01, 0x04, // SEI NAL (3 bytes)
        0x00, 0x00, 0x00, 0x04, 0x65, 0x88, 0x84, 0xFF, // IDR NAL (4 bytes)
      ]);
      expect(isKeyframePayload('avc1', payload)).toBe(true);
    });

    it('handles codec string with profile (avc1.42c01f)', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x65, 0x88]);
      expect(isKeyframePayload('avc1.42c01f', payload)).toBe(true);
    });

    it('returns null for too-short payload', () => {
      const payload = new Uint8Array([0x00, 0x00]);
      expect(isKeyframePayload('avc1', payload)).toBeNull();
    });
  });

  describe('H.265 (hvc1/hev1)', () => {
    it('detects IDR_W_RADL (NAL type 19) as keyframe', () => {
      // H.265 NAL header is 2 bytes: (type << 1) in first byte
      // Type 19 = IDR_W_RADL → (19 << 1) = 0x26, upper bits: 0x26
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x26, 0x01, 0xAF]);
      expect(isKeyframePayload('hvc1', payload)).toBe(true);
    });

    it('detects IDR_N_LP (NAL type 20) as keyframe', () => {
      // Type 20 → (20 << 1) = 0x28
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x28, 0x01]);
      expect(isKeyframePayload('hev1', payload)).toBe(true);
    });

    it('detects TRAIL_R (NAL type 1) as delta', () => {
      // Type 1 → (1 << 1) = 0x02
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x02, 0x01]);
      expect(isKeyframePayload('hvc1', payload)).toBe(false);
    });
  });

  describe('AV1 (av01)', () => {
    it('detects KEY_FRAME as keyframe', () => {
      // AV1 OBU: first byte has type in bits 4-7
      // Sequence Header OBU type=1 → (1 << 3) | flags = 0x0A (with size flag)
      // Then Frame OBU type=6, with frame_type=0 (KEY_FRAME) in the header
      // Simplified: check OBU sequence header presence
      const payload = new Uint8Array([0x0A, 0x0B, 0x00, 0x00, 0x00]); // Sequence header OBU
      expect(isKeyframePayload('av01', payload)).toBe(true);
    });

    it('detects non-key frame as delta', () => {
      // Frame OBU without sequence header, frame_type != 0
      // OBU type=6 (frame) → (6 << 3) | 0x02 = 0x32
      const payload = new Uint8Array([0x32, 0x10, 0x20]); // Frame OBU, not key
      expect(isKeyframePayload('av01', payload)).toBe(false);
    });
  });

  describe('unknown codec', () => {
    it('returns null for unsupported codec', () => {
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x10]);
      expect(isKeyframePayload('vp9', payload)).toBeNull();
    });
  });

  // ─── Iteration bound (mutation-test informed) ─────────────────────

  describe('iteration bound (DoS hardening)', () => {
    /**
     * Build an AVCC payload of N skip-able non-VCL NAL units (SEI=type 6).
     * Each NAL unit is 5 bytes total (4-byte length + 1-byte header).
     * No IDR/SPS, no delta — should fall off the end → null on a sound impl.
     * On a buggy impl with no iteration bound, this is just a slow walk;
     * the real protection is the bound, not the walk speed.
     */
    function makeNNalUnits(count: number, nalType: number = 6): Uint8Array {
      const buf = new Uint8Array(count * 5);
      for (let i = 0; i < count; i++) {
        const off = i * 5;
        buf[off] = 0; buf[off + 1] = 0; buf[off + 2] = 0; buf[off + 3] = 1;
        buf[off + 4] = nalType & 0x1F;
      }
      return buf;
    }

    /**
     * Build a payload with N skip-able NALs followed by an IDR.
     * Without the iteration bound, the validator walks through all N skips
     * and returns true. With the bound, it returns null after MAX iterations
     * — refusing to walk adversarial depth even though the data IS a keyframe.
     */
    function makeDeepKeyframe(skipCount: number): Uint8Array {
      const sei = makeNNalUnits(skipCount, 6); // SEI NALs
      const idr = new Uint8Array([0x00, 0x00, 0x00, 0x01, 5]); // IDR slice
      const payload = new Uint8Array(sei.length + idr.length);
      payload.set(sei, 0);
      payload.set(idr, sei.length);
      return payload;
    }

    it('H.264: returns null when an IDR is buried beyond MAX_NAL_UNITS_PER_AU', () => {
      // IDR is real but at position 400 — well past the bound (256).
      // Without the bound, the validator would walk to it and return true.
      // With the bound, it bails out at the bound and returns null.
      const payload = makeDeepKeyframe(400);
      expect(isKeyframePayload('avc1.64001e', payload)).toBeNull();
    });

    it('H.264: keyframe within the bound is still detected', () => {
      // IDR at position 10 — well within the bound. Returns true.
      const payload = makeDeepKeyframe(10);
      expect(isKeyframePayload('avc1.64001e', payload)).toBe(true);
    });

    it('H.265: returns null when payload requires walking past MAX_NAL_UNITS_PER_AU', () => {
      // 400 PPS NALs (type 34, skipped) followed by an IDR — IDR is real but
      // beyond the bound, so the validator returns null. Without the bound,
      // it would walk all the way and return true.
      const skipCount = 400;
      const skipBuf = new Uint8Array(skipCount * 6);
      for (let i = 0; i < skipCount; i++) {
        const off = i * 6;
        skipBuf[off] = 0; skipBuf[off + 1] = 0; skipBuf[off + 2] = 0; skipBuf[off + 3] = 2;
        skipBuf[off + 4] = (34 << 1) & 0xFE; // PPS = 34
        skipBuf[off + 5] = 1;
      }
      // IDR_W_RADL (type 19), 2-byte NAL header
      const idr = new Uint8Array([0x00, 0x00, 0x00, 0x02, (19 << 1) & 0xFE, 1]);
      const payload = new Uint8Array(skipBuf.length + idr.length);
      payload.set(skipBuf, 0);
      payload.set(idr, skipBuf.length);
      expect(isKeyframePayload('hvc1.1.6.L93.B0', payload)).toBeNull();
    });

    it('H.264: legitimate keyframe with few NAL units is not affected', () => {
      // SPS (type 7) + IDR (type 5) — typical keyframe, well under the bound
      const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 7]);
      const idr = new Uint8Array([0x00, 0x00, 0x00, 0x01, 5]);
      const payload = new Uint8Array(sps.length + idr.length);
      payload.set(sps, 0);
      payload.set(idr, sps.length);
      expect(isKeyframePayload('avc1.64001e', payload)).toBe(true);
    });
  });
});
