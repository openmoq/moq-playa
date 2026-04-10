/**
 * HevcStrategy — codec strategy for H.265/HEVC video.
 *
 * Handles HVCC/Annex B format detection and conversion, NAL unit
 * sanitization, IRAP keyframe gating with RASL discard, and
 * HEVC-specific diagnostic formatting.
 *
 * @see ITU-T H.265 §7.3.1.2 (NAL unit header)
 * @see ITU-T H.265 §7.4.2.2 (NAL unit header semantics)
 * @see ISO/IEC 14496-15 §8.3.3.1 (HEVCDecoderConfigurationRecord)
 * @see draft-ietf-moq-loc-01 §2.1 (video payload format)
 * @module
 */

import type { CodecStrategy, PreparedChunk } from './codec-strategy.js';
import {
  isValidLengthPrefixed,
  isAnnexB,
  annexBToLengthPrefixed,
  writeLength,
} from './nal-framing.js';

// ─── HEVC NAL unit types ────────────────────────────────────────────
// @see ITU-T H.265 Table 7-1

// VCL types (trailing/leading pictures)
const NAL_TRAIL_N = 0;
const NAL_TRAIL_R = 1;
const NAL_RADL_N = 6;
const NAL_RADL_R = 7;
const NAL_RASL_N = 8;
const NAL_RASL_R = 9;

// IRAP types (keyframes)
const NAL_BLA_W_LP = 16;
const NAL_IDR_N_LP = 20;
const NAL_CRA_NUT = 21;

// Parameter sets
const NAL_VPS = 32;
const NAL_SPS = 33;
const NAL_PPS = 34;

// Non-VCL to strip
const NAL_AUD = 35;
const NAL_EOS = 36;
const NAL_EOB = 37;
const NAL_FD = 38;
const NAL_PREFIX_SEI = 39;
const NAL_SUFFIX_SEI = 40;

// ─── Strategy ───────────────────────────────────────────────────────

export class HevcStrategy implements CodecStrategy {
  readonly gatesAfterReset = true;
  readonly usesDescription = true;
  readonly supportsSoftwarePreference = false;
  readonly optimizeForLatency = false;

  /** Track whether we need to discard RASL pictures after an IRAP. */
  private discardRasl = true;

  async checkSupport(codec: string, width?: number, height?: number, description?: Uint8Array): Promise<boolean> {
    if (typeof VideoDecoder === 'undefined' || !VideoDecoder.isConfigSupported) return true;
    const config: VideoDecoderConfig = { codec, optimizeForLatency: true };
    if (width !== undefined) config.codedWidth = width;
    if (height !== undefined) config.codedHeight = height;
    if (description && description.byteLength > 0) config.description = description;
    try {
      const result = await VideoDecoder.isConfigSupported(config);
      return result.supported === true;
    } catch {
      return true;
    }
  }

  prepareChunkData(data: Uint8Array, description: Uint8Array | undefined): PreparedChunk | null {
    const lengthSize = getHvccLengthSize(description);

    // Detect and convert framing format
    let framed: Uint8Array;
    if (isValidLengthPrefixed(data, lengthSize)) {
      framed = data;
    } else if (isAnnexB(data)) {
      framed = annexBToLengthPrefixed(data, lengthSize);
    } else {
      framed = data;
    }

    return this.sanitizeChunk(framed, lengthSize);
  }

  isAcceptableSyncPoint(data: Uint8Array, chunkType: 'key' | 'delta', description: Uint8Array | undefined): boolean {
    if (chunkType !== 'key') return false;
    const lengthSize = getHvccLengthSize(description);
    return hasIrapNal(data, lengthSize);
  }

  describeChunk(data: Uint8Array, chunkType: 'key' | 'delta', description: Uint8Array | undefined): string {
    const lengthSize = getHvccLengthSize(description);
    const nalTypes = extractNalTypes(data, lengthSize);
    const nalStr = nalTypes.map(t => hevcNalTypeName(t)).join(',');
    const irap = nalTypes.some(t => isIrapType(t));
    return `type=${chunkType}|bytes=${data.byteLength}|irap=${irap}|nals=[${nalStr}]`;
  }

  describeConfig(description: Uint8Array | undefined): string {
    if (!description || description.byteLength < 23 || description[0] !== 0x01) {
      return description ? `non-hvcc(bytes=${description.byteLength})` : 'none';
    }
    const profileIdc = description[1]! & 0x1F;
    const levelIdc = description[12]!;
    const lengthSize = getHvccLengthSize(description);
    return `hvcc|profile=${profileIdc}|level=${levelIdc}|len=${lengthSize}`;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private sanitizeChunk(data: Uint8Array, lengthSize: number): PreparedChunk | null {
    const kept: Uint8Array[] = [];
    const droppedTypes: number[] = [];
    let hasVcl = false;
    let pos = 0;

    while (pos + lengthSize <= data.byteLength) {
      let nalLength = 0;
      for (let i = 0; i < lengthSize; i++) {
        nalLength = (nalLength << 8) | data[pos + i]!;
      }
      pos += lengthSize;

      if (nalLength <= 0 || pos + nalLength > data.byteLength) {
        return { data, droppedReason: null };
      }

      const nal = data.subarray(pos, pos + nalLength);
      const nalType = (nal[0]! >> 1) & 0x3F;

      // Strip non-essential non-VCL types
      if (nalType === NAL_AUD || nalType === NAL_EOS || nalType === NAL_EOB || nalType === NAL_FD) {
        droppedTypes.push(nalType);
      } else if (this.discardRasl && (nalType === NAL_RASL_N || nalType === NAL_RASL_R)) {
        // Discard RASL pictures after IRAP — they reference pictures
        // from before the IRAP that don't exist in the decoder buffer.
        // @see ITU-T H.265 §8.1 (RASL output suppression)
        droppedTypes.push(nalType);
      } else {
        kept.push(nal);
        // VCL range: 0-31
        if (nalType <= 31) {
          hasVcl = true;
          // IRAP re-arms RASL discard — RASL pictures that follow in
          // decode order reference pre-IRAP frames we don't have.
          // Only trailing pictures (non-IRAP, non-RASL) clear the flag.
          // @see ITU-T H.265 §8.1 (RASL output suppression)
          if (isIrapType(nalType)) {
            this.discardRasl = true;
          } else if (nalType !== NAL_RASL_N && nalType !== NAL_RASL_R) {
            this.discardRasl = false;
          }
        }
      }
      pos += nalLength;
    }

    if (!hasVcl) return null;

    if (droppedTypes.length === 0) {
      return { data, droppedReason: null };
    }

    const totalSize = kept.reduce((sum, nal) => sum + lengthSize + nal.byteLength, 0);
    const out = new Uint8Array(totalSize);
    let writePos = 0;
    for (const nal of kept) {
      writeLength(out, writePos, nal.byteLength, lengthSize);
      writePos += lengthSize;
      out.set(nal, writePos);
      writePos += nal.byteLength;
    }

    const unique = Array.from(new Set(droppedTypes));
    const reason = unique.map(t => `hevc-nal-${t}(${hevcNalTypeName(t)})`).join(',');
    return { data: out, droppedReason: reason };
  }
}

// ─── HVCC config parsing ────────────────────────────────────────────

/**
 * Extract NAL unit length size from HEVCDecoderConfigurationRecord.
 *
 * Byte 21, bits 0-1: lengthSizeMinusOne. Value + 1 = actual length prefix
 * size in bytes (1-4, almost always 4).
 *
 * @see ISO/IEC 14496-15 §8.3.3.1.2
 */
export function getHvccLengthSize(description: Uint8Array | undefined): number {
  if (!description || description.byteLength < 23 || description[0] !== 0x01) {
    return 4;
  }
  return (description[21]! & 0x03) + 1;
}

// ─── NAL type helpers ───────────────────────────────────────────────

/**
 * Extract HEVC NAL type from 2-byte NAL header.
 * Type is in bits 1-6 of the first byte: (byte >> 1) & 0x3F.
 * @see ITU-T H.265 §7.3.1.2
 */
function hevcNalType(firstByte: number): number {
  return (firstByte >> 1) & 0x3F;
}

/** Check if a NAL type is an IRAP (Intra Random Access Point). */
function isIrapType(nalType: number): boolean {
  return nalType >= NAL_BLA_W_LP && nalType <= NAL_CRA_NUT;
}

/** Check if any NAL in a length-prefixed chunk is an IRAP type. */
function hasIrapNal(data: Uint8Array, lengthSize: number): boolean {
  let pos = 0;
  while (pos + lengthSize <= data.byteLength) {
    let nalLength = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLength = (nalLength << 8) | data[pos + i]!;
    }
    pos += lengthSize;
    if (nalLength <= 0 || pos + nalLength > data.byteLength) break;

    const nalType = hevcNalType(data[pos]!);
    if (isIrapType(nalType)) return true;

    // Skip parameter sets (VPS, SPS, PPS) and look for VCL
    if (nalType !== NAL_VPS && nalType !== NAL_SPS && nalType !== NAL_PPS &&
        nalType !== NAL_AUD && nalType !== NAL_PREFIX_SEI && nalType !== NAL_SUFFIX_SEI) {
      // Non-parameter-set, non-IRAP VCL → not a sync point
      if (nalType <= 31 && !isIrapType(nalType)) return false;
    }

    pos += nalLength;
  }
  return false;
}

/** Extract all NAL types from a length-prefixed chunk. */
function extractNalTypes(data: Uint8Array, lengthSize: number): number[] {
  const types: number[] = [];
  let pos = 0;
  while (pos + lengthSize <= data.byteLength) {
    let nalLength = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLength = (nalLength << 8) | data[pos + i]!;
    }
    pos += lengthSize;
    if (nalLength <= 0 || pos + nalLength > data.byteLength) break;
    types.push(hevcNalType(data[pos]!));
    pos += nalLength;
  }
  return types;
}

function hevcNalTypeName(type: number): string {
  switch (type) {
    case NAL_TRAIL_N: return 'trail_n';
    case NAL_TRAIL_R: return 'trail_r';
    case NAL_RADL_N: return 'radl_n';
    case NAL_RADL_R: return 'radl_r';
    case NAL_RASL_N: return 'rasl_n';
    case NAL_RASL_R: return 'rasl_r';
    case NAL_BLA_W_LP: return 'bla_w_lp';
    case 17: return 'bla_w_radl';
    case 18: return 'bla_n_lp';
    case 19: return 'idr_w_radl';
    case NAL_IDR_N_LP: return 'idr_n_lp';
    case NAL_CRA_NUT: return 'cra';
    case NAL_VPS: return 'vps';
    case NAL_SPS: return 'sps';
    case NAL_PPS: return 'pps';
    case NAL_AUD: return 'aud';
    case NAL_EOS: return 'eos';
    case NAL_EOB: return 'eob';
    case NAL_FD: return 'fd';
    case NAL_PREFIX_SEI: return 'sei_prefix';
    case NAL_SUFFIX_SEI: return 'sei_suffix';
    default: return `nal${type}`;
  }
}
