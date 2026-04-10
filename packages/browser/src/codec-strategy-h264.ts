/**
 * H264Strategy — codec strategy for H.264/AVC video.
 *
 * Handles AVCC/Annex B format detection and conversion, NAL unit
 * sanitization (stripping unsupported types), IDR keyframe gating,
 * and H.264-specific diagnostic formatting.
 *
 * @see ITU-T H.264 §7.3.1 (NAL unit syntax)
 * @see ITU-T H.264 §7.4.1 (NAL unit semantics)
 * @see ISO/IEC 14496-15 §5.3.3.1 (AVCDecoderConfigurationRecord)
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

// ─── H.264 NAL unit types ───────────────────────────────────────────
// @see ITU-T H.264 Table 7-1

/** Non-IDR coded slice. VCL. */
const NAL_NON_IDR = 1;
/** Data partition A. Unsupported by modern decoders. */
const NAL_DATA_PARTITION_A = 2;
/** Data partition C. Unsupported by modern decoders. */
const NAL_DATA_PARTITION_C = 4;
/** IDR (Instantaneous Decoder Refresh) slice. VCL. Keyframe. */
const NAL_IDR = 5;
/** Supplemental enhancement information. Non-VCL. */
const NAL_SEI = 6;
/** Sequence parameter set. Non-VCL. */
const NAL_SPS = 7;
/** Picture parameter set. Non-VCL. */
const NAL_PPS = 8;
/** Access unit delimiter. Non-VCL. */
const NAL_AUD = 9;

// ─── Strategy ───────────────────────────────────────────────────────

export class H264Strategy implements CodecStrategy {
  readonly gatesAfterReset = true;
  readonly usesDescription = true;
  readonly supportsSoftwarePreference = true;
  readonly optimizeForLatency = true;

  prepareChunkData(data: Uint8Array, description: Uint8Array | undefined): PreparedChunk | null {
    const lengthSize = getAvccLengthSize(description);

    // Detect and convert framing format
    let avccData: Uint8Array;
    if (isValidLengthPrefixed(data, lengthSize)) {
      avccData = data;
    } else if (isAnnexB(data)) {
      avccData = annexBToLengthPrefixed(data, lengthSize);
    } else {
      avccData = data;
    }

    // Sanitize: strip unsupported NAL types
    return sanitizeAvccChunk(avccData, lengthSize);
  }

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
      return true; // fail-open: let runtime errors catch it
    }
  }

  isAcceptableSyncPoint(data: Uint8Array, chunkType: 'key' | 'delta', description: Uint8Array | undefined): boolean {
    if (chunkType !== 'key') return false;
    const lengthSize = getAvccLengthSize(description);
    const inspection = inspectChunk(data, lengthSize);
    return inspection.hasKeyframe;
  }

  describeChunk(data: Uint8Array, chunkType: 'key' | 'delta', description: Uint8Array | undefined): string {
    const lengthSize = getAvccLengthSize(description);
    const inspection = inspectChunk(data, lengthSize);
    if (!inspection.valid) {
      return `type=${chunkType}|invalid-avcc(offset=${inspection.invalidOffset},bytes=${data.byteLength})`;
    }
    const nalStr = inspection.nalTypes.map(t => nalTypeName(t)).join(',');
    return `type=${chunkType}|bytes=${data.byteLength}|idr=${inspection.hasKeyframe}|nals=[${nalStr}]`;
  }

  describeConfig(description: Uint8Array | undefined): string {
    if (!description || description.byteLength < 7 || description[0] !== 0x01) {
      return description ? `non-avcc(bytes=${description.byteLength})` : 'none';
    }
    const profile = description[1]!;
    const level = description[3]!;
    const lengthSize = getAvccLengthSize(description);
    const spsCount = description[5]! & 0x1F;
    return `avcc|profile=0x${profile.toString(16)}|level=0x${level.toString(16)}|len=${lengthSize}|sps=${spsCount}`;
  }
}

// ─── AVCC config parsing ────────────────────────────────────────────

/**
 * Extract NAL unit length size from AVCDecoderConfigurationRecord.
 *
 * Byte 4, bits 0-1: lengthSizeMinusOne. Value + 1 = actual length prefix
 * size in bytes (1, 2, 3, or 4). Almost always 4 in practice.
 *
 * @see ISO/IEC 14496-15 §5.3.3.1.2
 */
export function getAvccLengthSize(description: Uint8Array | undefined): number {
  if (!description || description.byteLength < 5 || description[0] !== 0x01) {
    return 4;
  }
  return (description[4]! & 0x03) + 1;
}

// ─── NAL inspection ─────────────────────────────────────────────────

interface ChunkInspection {
  valid: boolean;
  hasKeyframe: boolean;
  nalTypes: number[];
  invalidOffset?: number;
}

/**
 * Walk AVCC-framed NAL units and extract type information.
 *
 * H.264 NAL header is 1 byte: forbidden_zero_bit(1) + nal_ref_idc(2) + nal_unit_type(5).
 * Type extraction: byte & 0x1F.
 *
 * @see ITU-T H.264 §7.3.1 (NAL unit syntax)
 */
function inspectChunk(data: Uint8Array, lengthSize: number): ChunkInspection {
  const nalTypes: number[] = [];
  let pos = 0;

  while (pos + lengthSize <= data.byteLength) {
    let nalLength = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLength = (nalLength << 8) | data[pos + i]!;
    }
    pos += lengthSize;

    if (nalLength <= 0 || pos + nalLength > data.byteLength) {
      return { valid: false, hasKeyframe: false, nalTypes, invalidOffset: pos - lengthSize };
    }

    nalTypes.push(data[pos]! & 0x1F);
    pos += nalLength;
  }

  return {
    valid: true,
    hasKeyframe: nalTypes.includes(NAL_IDR),
    nalTypes,
  };
}

// ─── NAL sanitization ───────────────────────────────────────────────

/**
 * Strip H.264 NAL types that cause decode errors in Chrome's VideoDecoder.
 *
 * Drops:
 * - Type 0: Reserved (undefined behavior)
 * - Types 2-4: Data partitions (deprecated, unsupported by hardware decoders)
 *
 * Returns null if no VCL NAL units (type 1 or 5) remain after stripping.
 *
 * @see ITU-T H.264 Table 7-1 (NAL unit type codes)
 */
function sanitizeAvccChunk(data: Uint8Array, lengthSize: number): PreparedChunk | null {
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
    const nalType = nal[0]! & 0x1F;

    if (nalType === 0 || (nalType >= NAL_DATA_PARTITION_A && nalType <= NAL_DATA_PARTITION_C)) {
      droppedTypes.push(nalType);
    } else {
      kept.push(nal);
      if (nalType === NAL_NON_IDR || nalType === NAL_IDR) hasVcl = true;
    }
    pos += nalLength;
  }

  // No VCL NALs → drop entire chunk
  if (!hasVcl) {
    return null;
  }

  if (droppedTypes.length === 0) {
    return { data, droppedReason: null };
  }

  // Rebuild without dropped NALs
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
  const reason = unique.map(t => `nal-type-${t}`).join(',');
  return { data: out, droppedReason: reason };
}

// ─── Helpers ────────────────────────────────────────────────────────

function nalTypeName(type: number): string {
  switch (type) {
    case NAL_NON_IDR: return 'non-idr';
    case NAL_IDR: return 'idr';
    case NAL_SEI: return 'sei';
    case NAL_SPS: return 'sps';
    case NAL_PPS: return 'pps';
    case NAL_AUD: return 'aud';
    default: return `nal${type}`;
  }
}
