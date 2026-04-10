/**
 * LOC (Low Overhead Container) type definitions.
 *
 * All types correspond to fields defined in draft-ietf-moq-loc-01.
 * Each field is annotated with the spec section that defines it.
 *
 * @see draft-ietf-moq-loc-01
 * @module
 */

// ─── Extension IDs ──────────────────────────────────────────────────

/**
 * LOC header extension IDs registered in the MOQ Object Header Extensions
 * registry. Even IDs have varint values; odd IDs have length-prefixed byte values.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 */
export const LocExtensionId = {
    /** Wall-clock capture time in microseconds. @see §2.3.1.1 */
    CAPTURE_TIMESTAMP: 0x02,
    /** RFC 9626 video frame marking flags. @see §2.3.2.2 */
    VIDEO_FRAME_MARKING: 0x04,
    /** RFC 6464 audio level + voice activity. @see §2.3.3.1 */
    AUDIO_LEVEL: 0x06,
    /** Video codec configuration extradata. @see §2.3.2.1 */
    VIDEO_CONFIG: 0x0d,
} as const;

// ─── Video Frame Marking ────────────────────────────────────────────

/**
 * Parsed RFC 9626 video frame marking flags.
 *
 * Encoded as a varint in LOC extension ID 4. The least significant bits
 * carry the RFC 9626 header fields.
 *
 * First byte (always present):
 * ```
 * Bit 7: S — Start of frame
 * Bit 6: E — End of frame
 * Bit 5: I — Independent frame (keyframe)
 * Bit 4: D — Discardable frame
 * Bit 3: B — Base layer sync (if 1, second byte present)
 * Bits 2-0: TID — Temporal layer ID (0-7)
 * ```
 *
 * Second byte (present when varint value >= 256):
 * ```
 * Bits 7-0: LID — Layer ID (0-255)
 * ```
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.2
 * @see RFC 9626 §3.1
 */
export interface VideoFrameMarking {
    /** Start of frame. @see RFC 9626 §3.1 */
    readonly startOfFrame: boolean;
    /** End of frame. @see RFC 9626 §3.1 */
    readonly endOfFrame: boolean;
    /** Independent frame (keyframe). @see RFC 9626 §3.1 */
    readonly independent: boolean;
    /** Discardable frame. @see RFC 9626 §3.1 */
    readonly discardable: boolean;
    /** Base layer sync. MUST be 0 when TID is 0. @see RFC 9626 §3.1 */
    readonly baseLayerSync: boolean;
    /** Temporal layer ID (0-7). @see RFC 9626 §3.1 */
    readonly temporalId: number;
    /** Layer ID (0-255). Present when varint value >= 256. @see RFC 9626 §3.1 */
    readonly layerId?: number;
}

// ─── Audio Level ────────────────────────────────────────────────────

/**
 * Parsed RFC 6464 audio level indication.
 *
 * Encoded as a varint in LOC extension ID 6. The least significant 8 bits
 * carry the RFC 6464 header field.
 *
 * ```
 * Bit 7: V — Voice activity (1 = speech detected)
 * Bits 6-0: level — Audio magnitude in -dBov (0 = loudest, 127 = silence)
 * ```
 *
 * @see draft-ietf-moq-loc-01 §2.3.3.1
 * @see RFC 6464 §3
 */
export interface AudioLevel {
    /** Voice activity detected. @see RFC 6464 §3 */
    readonly voiceActivity: boolean;
    /** Audio magnitude in -dBov (0 = loudest, 127 = silence). @see RFC 6464 §3 */
    readonly level: number;
}

// ─── Parsed Headers ─────────────────────────────────────────────────

/** Value of an unknown extension: varint (even ID) or bytes (odd ID). */
export type LocExtensionValue = bigint | Uint8Array;

/**
 * Parsed LOC header extensions from a MOQ Object.
 *
 * Contains structured data extracted from the opaque `extensions: Uint8Array`
 * on `MoqtObjectData`. Unknown extension IDs are preserved in the `unknown` map.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 */
export interface LocHeaders {
    /**
     * Wall-clock capture time in microseconds since Unix epoch.
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     */
    readonly captureTimestamp?: bigint;
    /**
     * Video frame marking flags (RFC 9626).
     * @see draft-ietf-moq-loc-01 §2.3.2.2
     */
    readonly videoFrameMarking?: VideoFrameMarking;
    /**
     * Audio level indication (RFC 6464).
     * @see draft-ietf-moq-loc-01 §2.3.3.1
     */
    readonly audioLevel?: AudioLevel;
    /**
     * Video codec configuration "extradata" bytes.
     * Maps to WebCodecs `VideoDecoderConfig.description`.
     * @see draft-ietf-moq-loc-01 §2.3.2.1
     */
    readonly videoConfig?: Uint8Array;
    /**
     * Unknown extension headers, keyed by absolute extension ID.
     * Even IDs map to bigint (varint value), odd IDs to Uint8Array.
     */
    readonly unknown?: ReadonlyMap<number, LocExtensionValue>;
}

// ─── WebCodecs-compatible chunk init ─────────────────────────────────

/**
 * Initialization data for creating an `EncodedVideoChunk`.
 *
 * Pure TypeScript type compatible with the WebCodecs `EncodedVideoChunkInit`
 * interface, usable without browser APIs.
 *
 * @see draft-ietf-moq-loc-01 §2.1
 * @see https://www.w3.org/TR/webcodecs/#encodedvideochunk-interface
 */
export interface VideoChunkInit {
    /** "key" for independent frames, "delta" for dependent frames. */
    readonly type: 'key' | 'delta';
    /** Timestamp in microseconds. From CaptureTimestamp if available. */
    readonly timestamp: number;
    /** Duration in microseconds (optional). */
    readonly duration?: number;
    /** Raw codec bitstream (LOC payload = EncodedVideoChunk internal data). */
    readonly data: Uint8Array;
}

/**
 * Initialization data for creating an `EncodedAudioChunk`.
 *
 * Pure TypeScript type compatible with the WebCodecs `EncodedAudioChunkInit`
 * interface, usable without browser APIs.
 *
 * @see draft-ietf-moq-loc-01 §2
 * @see https://www.w3.org/TR/webcodecs/#encodedaudiochunk-interface
 */
export interface AudioChunkInit {
    /** Audio chunks are always "key" (each chunk is independently decodable). */
    readonly type: 'key';
    /** Timestamp in microseconds. From CaptureTimestamp if available. */
    readonly timestamp: number;
    /** Duration in microseconds (optional). */
    readonly duration?: number;
    /** Raw codec bitstream (LOC payload = EncodedAudioChunk internal data). */
    readonly data: Uint8Array;
}
