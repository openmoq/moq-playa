/**
 * Keyframe payload validation — verifies codec bitstream actually starts
 * with an independently decodable frame.
 *
 * Used to detect broken publishers that start MoQ groups with delta frames
 * instead of keyframes. Per LOC §4.2, the first object in a group MUST be
 * independently decodable (keyframe/IDR/key_frame).
 *
 * Supports H.264 (AVC), H.265 (HEVC), and AV1.
 * Returns null for unknown codecs (no opinion).
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 * @see ITU-T H.264 §7.3.1 (NAL unit syntax)
 * @see ITU-T H.265 §7.3.1.2 (NAL unit header)
 * @see AV1 §5.3.1 (OBU header)
 * @module
 */

/**
 * Check if a video payload starts with a keyframe.
 *
 * @param codec Codec string from catalog (e.g., 'avc1.42c01f', 'hvc1', 'av01.0.08M.10')
 * @param payload Raw bitstream payload from MoQ object
 * @returns true = keyframe, false = delta, null = can't determine (unknown codec or too short)
 */
export function isKeyframePayload(codec: string, payload: Uint8Array): boolean | null {
  const codecBase = codec.split('.')[0]!.toLowerCase();

  switch (codecBase) {
    case 'avc1':
    case 'avc3':
      return isH264Keyframe(payload);
    case 'hvc1':
    case 'hev1':
      return isH265Keyframe(payload);
    case 'av01':
      return isAV1Keyframe(payload);
    default:
      return null; // Unknown codec — no opinion
  }
}

/**
 * H.264: check for IDR slice (NAL type 5) or SPS (NAL type 7).
 *
 * LOC payloads use length-prefixed NAL units (AVCC format):
 * [4-byte length][NAL unit][4-byte length][NAL unit]...
 *
 * NAL header byte: forbidden_zero_bit(1) + nal_ref_idc(2) + nal_unit_type(5)
 * Keyframe NAL types: 5 (IDR slice), 7 (SPS), 8 (PPS)
 * Non-IDR types to skip: 6 (SEI), 9 (AUD)
 *
 * @see ITU-T H.264 §7.4.1 (NAL unit semantics)
 */
/**
 * Hard upper bound on NAL units inspected per access unit.
 *
 * Most real keyframe AUs have well under 32 NAL units (AUD + SPS + PPS +
 * SEI + a few slices). Multi-slice encoding (parallelism, low-latency,
 * error resilience) and SEI-heavy streams (HDR, captions, timecodes) can
 * push the count higher; HEVC tiles and SVC layers can push it higher
 * still. 256 is generous enough for legitimate content while preventing
 * pathological loops on crafted payloads (e.g., zero-length-NAL spam
 * or boundary bugs that fail to advance `pos`).
 *
 * If you hit this bound on a real stream, log + raise — the bound is
 * defense-in-depth, not a spec claim.
 */
const MAX_NAL_UNITS_PER_AU = 256;

function isH264Keyframe(payload: Uint8Array): boolean | null {
  if (payload.length < 5) return null;

  let pos = 0;
  let iterations = 0;
  while (pos + 4 < payload.length) {
    if (++iterations > MAX_NAL_UNITS_PER_AU) return null;

    // Read 4-byte big-endian NAL unit length
    const nalLen = (payload[pos]! << 24) | (payload[pos + 1]! << 16) |
                   (payload[pos + 2]! << 8) | payload[pos + 3]!;
    pos += 4;

    if (nalLen <= 0 || pos >= payload.length) break;

    const nalType = payload[pos]! & 0x1F;

    // Keyframe indicators
    if (nalType === 5) return true;  // IDR slice
    if (nalType === 7) return true;  // SPS (always precedes IDR in keyframe AU)

    // Non-VCL NALs to skip (may precede the actual slice)
    if (nalType === 6 || nalType === 8 || nalType === 9) {
      // SEI (6), PPS (8), AUD (9) — skip to next NAL
      pos += nalLen;
      continue;
    }

    // Any other VCL NAL type = delta frame
    return false;
  }

  return null; // Couldn't find a VCL NAL
}

/**
 * H.265: check for IDR_W_RADL (type 19) or IDR_N_LP (type 20).
 *
 * H.265 NAL header is 2 bytes:
 * forbidden_zero_bit(1) + nal_unit_type(6) + nuh_layer_id(6) + nuh_temporal_id_plus1(3)
 * Type is in bits 1-6 of the first byte: (byte >> 1) & 0x3F
 *
 * @see ITU-T H.265 §7.4.2.2 (NAL unit header semantics)
 */
function isH265Keyframe(payload: Uint8Array): boolean | null {
  if (payload.length < 6) return null;

  let pos = 0;
  let iterations = 0;
  while (pos + 4 < payload.length) {
    if (++iterations > MAX_NAL_UNITS_PER_AU) return null;

    const nalLen = (payload[pos]! << 24) | (payload[pos + 1]! << 16) |
                   (payload[pos + 2]! << 8) | payload[pos + 3]!;
    pos += 4;

    if (nalLen <= 0 || pos + 1 >= payload.length) break;

    const nalType = (payload[pos]! >> 1) & 0x3F;

    // IDR types
    if (nalType === 19 || nalType === 20) return true;  // IDR_W_RADL, IDR_N_LP
    if (nalType === 21) return true;  // CRA_NUT (clean random access)

    // VPS (32), SPS (33), PPS (34) — parameter sets precede IDR
    if (nalType === 32 || nalType === 33 || nalType === 34) {
      pos += nalLen;
      continue;
    }

    // SEI (39, 40), AUD (35) — skip
    if (nalType === 35 || nalType === 39 || nalType === 40) {
      pos += nalLen;
      continue;
    }

    // Any other slice type = delta
    return false;
  }

  return null;
}

/**
 * AV1: check for key_frame by looking for Sequence Header OBU.
 *
 * AV1 OBU header: forbidden(1) + obu_type(4) + extension_flag(1) + has_size_field(1) + reserved(1)
 * obu_type is bits 4-7: (byte >> 3) & 0x0F
 *
 * A keyframe access unit starts with OBU_SEQUENCE_HEADER (type 1).
 * A delta frame starts with OBU_FRAME (type 6) without a preceding sequence header.
 *
 * @see AV1 §5.3.1 (OBU header syntax)
 */
function isAV1Keyframe(payload: Uint8Array): boolean | null {
  if (payload.length < 2) return null;

  const obuType = (payload[0]! >> 3) & 0x0F;

  // Sequence header = keyframe (always precedes key frame in a temporal unit)
  if (obuType === 1) return true;   // OBU_SEQUENCE_HEADER

  // Temporal delimiter (type 2) — look at next OBU
  if (obuType === 2 && payload.length >= 3) {
    const nextObuType = (payload[2]! >> 3) & 0x0F;
    if (nextObuType === 1) return true;
  }

  // Frame or frame header without sequence header = delta
  if (obuType === 3 || obuType === 6) return false;  // OBU_FRAME_HEADER, OBU_FRAME

  return null; // Unknown OBU type first — can't determine
}
