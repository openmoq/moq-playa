/**
 * Av1Strategy — codec strategy for AV1 video.
 *
 * Handles OBU (Open Bitstream Unit) parsing, stripping of non-essential
 * OBU types, and keyframe detection via OBU_SEQUENCE_HEADER presence.
 *
 * Key difference from H.264/HEVC: AV1 does NOT use VideoDecoderConfig.description.
 * All configuration flows through in-band OBU_SEQUENCE_HEADER.
 *
 * @see AV1 Spec §5.3.1 (OBU header syntax)
 * @see AV1 Spec §5.3.2 (OBU header semantics)
 * @see AV1 ISOBMFF §2.3 (AV1CodecConfigurationRecord)
 * @see W3C WebCodecs AV1 Registration (description not used)
 * @module
 */

import type { CodecStrategy, PreparedChunk } from './codec-strategy.js';

// ─── AV1 OBU types ─────────────────────────────────────────────────
// @see AV1 Spec §6.2.2

const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;
const OBU_FRAME_HEADER = 3;
const OBU_TILE_GROUP = 4;
const OBU_METADATA = 5;
const OBU_FRAME = 6;
const OBU_REDUNDANT_FRAME_HEADER = 7;
const OBU_TILE_LIST = 8;
const OBU_PADDING = 15;

/** OBU types to strip for low-latency live playback. */
const STRIP_OBU_TYPES = new Set([
  OBU_TEMPORAL_DELIMITER,
  OBU_REDUNDANT_FRAME_HEADER,
  OBU_TILE_LIST,
  OBU_PADDING,
]);

// ─── Strategy ───────────────────────────────────────────────────────

export class Av1Strategy implements CodecStrategy {
  readonly gatesAfterReset = true;
  /** AV1 must NOT set VideoDecoderConfig.description. @see W3C WebCodecs AV1 Registration */
  readonly usesDescription = false;
  readonly supportsSoftwarePreference = false;
  readonly optimizeForLatency = true;

  /** AV1 must NOT set description — all config is in-band. */
  async checkSupport(codec: string, width?: number, height?: number): Promise<boolean> {
    if (typeof VideoDecoder === 'undefined' || !VideoDecoder.isConfigSupported) return true;
    const config: VideoDecoderConfig = { codec, optimizeForLatency: true };
    if (width !== undefined) config.codedWidth = width;
    if (height !== undefined) config.codedHeight = height;
    // No description for AV1 — intentionally omitted
    try {
      const result = await VideoDecoder.isConfigSupported(config);
      return result.supported === true;
    } catch {
      return true;
    }
  }

  prepareChunkData(data: Uint8Array): PreparedChunk | null {
    return sanitizeObuStream(data);
  }

  isAcceptableSyncPoint(data: Uint8Array, chunkType: 'key' | 'delta'): boolean {
    if (chunkType !== 'key') return false;
    return hasSequenceHeader(data);
  }

  describeChunk(data: Uint8Array, chunkType: 'key' | 'delta'): string {
    const types = extractObuTypes(data);
    const obuStr = types.map(t => obuTypeName(t)).join(',');
    const hasSeqHdr = types.includes(OBU_SEQUENCE_HEADER);
    return `type=${chunkType}|bytes=${data.byteLength}|seqhdr=${hasSeqHdr}|obus=[${obuStr}]`;
  }
}

// ─── OBU parsing ────────────────────────────────────────────────────

/**
 * Parse an OBU header and return the OBU type, header size, and payload size.
 *
 * OBU header (1 byte mandatory):
 *   forbidden(1) | obu_type(4) | extension_flag(1) | has_size_field(1) | reserved(1)
 *
 * If extension_flag: +1 byte (temporal_id, spatial_id, reserved)
 * If has_size_field: +LEB128 size of payload
 *
 * @see AV1 Spec §5.3.1
 */
function parseObuHeader(data: Uint8Array, offset: number): {
  obuType: number;
  headerSize: number;
  payloadSize: number;
  hasSizeField: boolean;
} | null {
  if (offset >= data.byteLength) return null;

  const headerByte = data[offset]!;
  const obuType = (headerByte >> 3) & 0x0F;
  const extensionFlag = (headerByte >> 2) & 0x01;
  const hasSizeField = (headerByte >> 1) & 0x01;

  let headerSize = 1;
  if (extensionFlag) headerSize += 1;

  if (offset + headerSize > data.byteLength) return null;

  let payloadSize: number;
  if (hasSizeField) {
    const leb = readLeb128(data, offset + headerSize);
    if (leb === null) return null;
    headerSize += leb.bytesRead;
    payloadSize = leb.value;
  } else {
    // No size field — payload extends to end of data
    payloadSize = data.byteLength - offset - headerSize;
  }

  return { obuType, headerSize, payloadSize, hasSizeField: hasSizeField === 1 };
}

/**
 * Read a LEB128-encoded unsigned integer.
 *
 * Each byte contributes its lower 7 bits, shifted left by 7 * byte_index.
 * MSB is a continuation flag. AV1 constrains to max 8 bytes, value ≤ 2^32 - 1.
 *
 * @see AV1 Spec §4.10.5 (leb128)
 */
export function readLeb128(data: Uint8Array, offset: number): { value: number; bytesRead: number } | null {
  let value = 0;
  let bytesRead = 0;

  for (let i = 0; i < 8; i++) {
    if (offset + i >= data.byteLength) return null;
    const byte = data[offset + i]!;
    value |= (byte & 0x7F) << (7 * i);
    bytesRead++;
    if ((byte & 0x80) === 0) break;
  }

  return { value: value >>> 0, bytesRead }; // >>> 0 ensures unsigned
}


// ─── OBU stream operations ──────────────────────────────────────────

/** Check if any OBU in the stream is OBU_SEQUENCE_HEADER. */
function hasSequenceHeader(data: Uint8Array): boolean {
  let pos = 0;
  while (pos < data.byteLength) {
    const obu = parseObuHeader(data, pos);
    if (!obu) break;
    if (obu.obuType === OBU_SEQUENCE_HEADER) return true;
    pos += obu.headerSize + obu.payloadSize;
  }
  return false;
}

/** Extract all OBU types from a stream. */
function extractObuTypes(data: Uint8Array): number[] {
  const types: number[] = [];
  let pos = 0;
  while (pos < data.byteLength) {
    const obu = parseObuHeader(data, pos);
    if (!obu) break;
    types.push(obu.obuType);
    pos += obu.headerSize + obu.payloadSize;
  }
  return types;
}

/**
 * Strip non-essential OBU types from an OBU stream.
 *
 * Strips: OBU_TEMPORAL_DELIMITER(2), OBU_REDUNDANT_FRAME_HEADER(7),
 * OBU_TILE_LIST(8), OBU_PADDING(15).
 *
 * @see AV1 ISOBMFF §2.1 (OBU_TEMPORAL_DELIMITER SHOULD NOT be used)
 */
function sanitizeObuStream(data: Uint8Array): PreparedChunk {
  // Fast path: scan to see if any strippable OBUs exist
  let hasStrippable = false;
  let pos = 0;
  while (pos < data.byteLength) {
    const obu = parseObuHeader(data, pos);
    if (!obu) break;
    if (STRIP_OBU_TYPES.has(obu.obuType)) {
      hasStrippable = true;
      break;
    }
    pos += obu.headerSize + obu.payloadSize;
  }

  if (!hasStrippable) {
    return { data, droppedReason: null };
  }

  // Rebuild without stripped OBUs
  const kept: Uint8Array[] = [];
  const droppedTypes: number[] = [];
  pos = 0;

  while (pos < data.byteLength) {
    const obu = parseObuHeader(data, pos);
    if (!obu) break;
    const obuStart = pos;
    const obuEnd = pos + obu.headerSize + obu.payloadSize;

    if (STRIP_OBU_TYPES.has(obu.obuType)) {
      droppedTypes.push(obu.obuType);
    } else {
      kept.push(data.subarray(obuStart, obuEnd));
    }
    pos = obuEnd;
  }

  if (kept.length === 0) {
    // All OBUs stripped — return empty but valid
    return { data: new Uint8Array(0), droppedReason: formatDroppedObus(droppedTypes) };
  }

  const totalSize = kept.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let writePos = 0;
  for (const chunk of kept) {
    out.set(chunk, writePos);
    writePos += chunk.byteLength;
  }

  return { data: out, droppedReason: formatDroppedObus(droppedTypes) };
}

function formatDroppedObus(types: number[]): string {
  const unique = Array.from(new Set(types));
  return unique.map(t => `obu-${t}(${obuTypeName(t)})`).join(',');
}

function obuTypeName(type: number): string {
  switch (type) {
    case OBU_SEQUENCE_HEADER: return 'seq_hdr';
    case OBU_TEMPORAL_DELIMITER: return 'td';
    case OBU_FRAME_HEADER: return 'frame_hdr';
    case OBU_TILE_GROUP: return 'tile_grp';
    case OBU_METADATA: return 'metadata';
    case OBU_FRAME: return 'frame';
    case OBU_REDUNDANT_FRAME_HEADER: return 'redundant_hdr';
    case OBU_TILE_LIST: return 'tile_list';
    case OBU_PADDING: return 'padding';
    default: return `obu${type}`;
  }
}
