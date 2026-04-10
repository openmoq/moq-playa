/**
 * Codec strategy interface for multi-codec WebCodecs video decoder.
 *
 * Each codec (H.264, HEVC, AV1) has different NAL/OBU framing, keyframe
 * detection, and sanitization rules. The strategy pattern encapsulates
 * these differences behind a common interface, selected at configure() time.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video payload format)
 * @see ISO/IEC 14496-15 §5.3 (AVC configuration)
 * @see ISO/IEC 14496-15 §8.3 (HEVC configuration)
 * @see AV1 ISOBMFF §2.3 (AV1 codec configuration)
 * @module
 */

// ─── Types ──────────────────────────────────────────────────────────

/** Result of codec-specific chunk preparation. */
export interface PreparedChunk {
  /** Decoder-ready data (may be converted from Annex B, sanitized, etc.). */
  readonly data: Uint8Array;
  /** If non-null, describes what was stripped/modified and why. */
  readonly droppedReason: string | null;
}

// ─── Interface ──────────────────────────────────────────────────────

/**
 * Codec-specific strategy for video chunk processing.
 *
 * Implementations encapsulate format conversion, keyframe gating,
 * sanitization, and diagnostic formatting for a single video codec.
 *
 * Created once per configure() call. May hold mutable state (e.g.,
 * HEVC RASL discard tracking) scoped to the configured lifetime.
 */
export interface CodecStrategy {
  /**
   * Transform raw chunk data into decoder-ready format.
   *
   * For H.264/HEVC: AVCC/Annex B detection, format conversion, NAL sanitization.
   * For AV1: OBU stripping (temporal delimiters, padding).
   * Returns null if the chunk should be entirely dropped (no decodable data).
   */
  prepareChunkData(data: Uint8Array, description: Uint8Array | undefined): PreparedChunk | null;

  /**
   * Check whether a chunk satisfies the keyframe gate.
   *
   * Called only when gating is active (after configure/reset/error recovery).
   * Returns true if this chunk IS an acceptable sync point and the gate
   * should open.
   *
   * @param data Prepared chunk data (after prepareChunkData)
   * @param chunkType 'key' or 'delta' from LOC VideoFrameMarking
   * @param description Codec configuration record (AVCC/HVCC), if available
   */
  isAcceptableSyncPoint(data: Uint8Array, chunkType: 'key' | 'delta', description: Uint8Array | undefined): boolean;

  /** Whether gating should be active after configure/reset. */
  readonly gatesAfterReset: boolean;

  /** Whether VideoDecoderConfig needs the description field. */
  readonly usesDescription: boolean;

  /** Whether preferSoftwareDecoder config applies to this codec. */
  readonly supportsSoftwarePreference: boolean;

  /**
   * Whether optimizeForLatency should be set on VideoDecoderConfig.
   * H.264 Baseline (no B-frames): true — disable reorder buffer for 1-in-1-out.
   * HEVC with CRA/B-frames: false — decoder needs reorder buffer for
   * trailing pictures with PTS before the keyframe.
   */
  readonly optimizeForLatency: boolean;

  /**
   * Check if this codec configuration is supported by the browser.
   *
   * Each strategy builds the appropriate VideoDecoderConfig and calls
   * VideoDecoder.isConfigSupported(). Returns false if the codec is
   * definitely unsupported. Returns true if supported OR if the check
   * is unavailable (fail-open for older browsers).
   *
   * @param codec Full codec string from catalog
   * @param width Coded width
   * @param height Coded height
   * @param description Config record bytes (AVCC/HVCC), if any
   */
  checkSupport(codec: string, width?: number, height?: number, description?: Uint8Array): Promise<boolean>;

  /** Human-readable chunk summary for diagnostics. Optional. */
  describeChunk?(data: Uint8Array, chunkType: 'key' | 'delta', description: Uint8Array | undefined): string;

  /** Human-readable config record summary for diagnostics. Optional. */
  describeConfig?(description: Uint8Array | undefined): string;
}

// ─── Factory ────────────────────────────────────────────────────────

/**
 * Create the appropriate codec strategy for a given codec string.
 *
 * Dispatches on the codec base prefix (before the first '.'):
 * - avc1, avc3 → H264Strategy
 * - hvc1, hev1 → HevcStrategy
 * - av01 → Av1Strategy
 * - anything else → PassthroughStrategy
 *
 * @param codec Codec string from MSF catalog (e.g., "avc1.640028", "hvc1.1.6.L120.B0")
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 */
export function createCodecStrategy(codec: string): CodecStrategy {
  const base = codec.split('.')[0]!.toLowerCase();
  switch (base) {
    case 'avc1':
    case 'avc3':
      return new H264Strategy();
    case 'hvc1':
    case 'hev1':
      return new HevcStrategy();
    case 'av01':
      return new Av1Strategy();
    default:
      return new PassthroughStrategy();
  }
}

import { H264Strategy } from './codec-strategy-h264.js';
import { HevcStrategy } from './codec-strategy-hevc.js';
import { Av1Strategy } from './codec-strategy-av1.js';
import { PassthroughStrategy } from './codec-strategy-passthrough.js';
