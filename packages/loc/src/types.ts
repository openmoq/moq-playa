/**
 * LOC (Low Overhead Container) type definitions.
 *
 * All types correspond to fields defined in draft-ietf-moq-loc-01 and
 * draft-ietf-moq-loc-04.
 * Each field is annotated with the spec section that defines it.
 *
 * @see draft-ietf-moq-loc-01
 * @module
 */

// ─── Versions and property IDs ──────────────────────────────────────

/** Supported LOC draft dialects. */
export type LocVersion = 1 | 4;

/**
 * LOC-01 property IDs. Even IDs carry integer values; odd IDs carry
 * length-prefixed bytes.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 */
export const Loc01PropertyId = {
    /** Wall-clock capture time in microseconds. @see loc-01 §2.3.1.1 */
    CAPTURE_TIMESTAMP: 0x02,
    /** RFC 9626 video frame marking as an integer. @see loc-01 §2.3.2.2 */
    VIDEO_FRAME_MARKING: 0x04,
    /** RFC 6464 audio level + voice activity. @see loc-01 §2.3.3.1 */
    AUDIO_LEVEL: 0x06,
    /** Video codec configuration extradata. @see loc-01 §2.3.2.1 */
    VIDEO_CONFIG: 0x0d,
} as const;

/**
 * LOC-04 property IDs, as registered in the MOQ Properties registry.
 *
 * @see draft-ietf-moq-loc-04 §6.1
 */
export const Loc04PropertyId = {
    /** Timestamp units per second. Absent means microseconds. @see loc-04 §2.3.1.2 */
    TIMESCALE: 0x08,
    /** RFC 9626 video frame marking as 1 to 4 bytes. @see loc-04 §2.3.2.2 */
    VIDEO_FRAME_MARKING: 0x09,
    /** RFC 6464 audio level + voice activity. @see loc-04 §2.3.3.2 */
    AUDIO_LEVEL: 0x0c,
    /** Video codec configuration extradata. @see loc-04 §2.3.2.1 */
    VIDEO_CONFIG: 0x0d,
    /** Audio codec configuration. @see loc-04 §2.3.3.1 */
    AUDIO_CONFIG: 0x0f,
    /** Frame timestamp in Timescale units. @see loc-04 §2.3.1.1 */
    TIMESTAMP: 0x10,
} as const;

/** @deprecated Use {@link Loc01PropertyId}. Kept so existing imports compile. */
export const LocExtensionId = Loc01PropertyId;

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
    /**
     * Layer ID (0-255). Present when the LOC-01 integer form carries a second
     * byte (varint value >= 256) or the LOC-04 byte form has at least 2 bytes.
     * @see RFC 9626 §3.1
     */
    readonly layerId?: number;
    /**
     * TL0PICIDX (0-255). Present only when the LOC-04 byte form carries the
     * RFC 9626 long header. Never set by the LOC-01 integer form.
     * @see RFC 9626 §3.1
     */
    readonly tl0PicIdx?: number;
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
     * Presentation time in microseconds. Under LOC-01 this is the wall-clock
     * CaptureTimestamp. Under LOC-04 it is derived from Timestamp and
     * Timescale (`timestamp * 1e6 / timescale`, truncating); without a
     * Timescale it is the Timestamp itself. See {@link timestampIsWallClock}.
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     * @see draft-ietf-moq-loc-04 §2.3.1.1, §2.3.1.2
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
     * Audio codec configuration bytes. Maps to WebCodecs
     * `AudioDecoderConfig.description`. LOC-04 only.
     * @see draft-ietf-moq-loc-04 §2.3.3.1
     */
    readonly audioConfig?: Uint8Array;
    /**
     * Raw Timestamp value as carried on the wire, in {@link timescale} units.
     * Under LOC-01 this equals {@link captureTimestamp}.
     * @see draft-ietf-moq-loc-04 §2.3.1.1
     */
    readonly timestamp?: bigint;
    /**
     * Timestamp units per second. Never set by the LOC-01 path. When absent
     * the timestamp is microseconds since the Unix epoch.
     * @see draft-ietf-moq-loc-04 §2.3.1.2
     */
    readonly timescale?: bigint;
    /**
     * True when a timestamp was present and no Timescale was seen, so the
     * value is wall-clock microseconds since the Unix epoch. False when a
     * Timescale made it media time. Undefined when there is no timestamp.
     */
    readonly timestampIsWallClock?: boolean;
    /**
     * Dialect detected on parse: 4 if any LOC-04-only id was present, 1 if
     * only LOC-01 ids were present, undefined otherwise. Ignored on encode.
     */
    readonly version?: LocVersion;
    /**
     * Unknown extension headers, keyed by absolute extension ID.
     *
     * Keys are `bigint` so a full-width (up to 2^64-1) property ID is preserved
     * losslessly — a draft-18 property block can carry IDs above `Number`'s safe
     * range, and narrowing them would silently collide distinct extensions.
     * Even IDs map to bigint (varint/vi64 value), odd IDs to Uint8Array.
     */
    readonly unknown?: ReadonlyMap<bigint, LocExtensionValue>;
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

// ─── Track context ──────────────────────────────────────────────────

/**
 * Track-scoped defaults for properties that draft-04 allows at Track scope.
 * Object-level values always win; these fill only what the object omitted.
 *
 * @see draft-ietf-moq-loc-04 §6.1 (Scope column)
 */
export interface LocTrackContext {
    readonly timescale?: bigint;
    readonly videoConfig?: Uint8Array;
    readonly audioConfig?: Uint8Array;
}
