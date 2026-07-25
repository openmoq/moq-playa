/**
 * LOC header extension parsing and encoding.
 *
 * Bridges the opaque `extensions: Uint8Array` from MOQ Object Header Extensions
 * and structured {@link LocHeaders}. This module is the compatibility layer over
 * the two-layer split:
 *   - Layer A ({@link @moqt/transport}) — the profile-aware property WIRE codec
 *     (bytes ⇄ ordered `PropertyMap`), shared across draft-14/16/18.
 *   - Layer B ({@link ./property-map.js}) — LOC semantic resolution (PropertyMap
 *     ⇄ `LocHeaders`).
 *
 * The wire profile is selected explicitly: `deltaEncoded: false` → draft-14
 * absolute QUIC-varint; the default → draft-16 delta QUIC-varint; an explicit
 * `wireProfile` → any of the three (draft-18 carries a **vi64** block, whose
 * integers diverge from the QUIC varint at value 64, so it needs its own
 * profile — `deltaEncoded` alone cannot express it).
 *
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-transport-16 §2.5 (Extension Headers)
 * @module
 */

import { decodePropertyBlock, encodePropertyBlock, type PropertyWireProfile } from '@moqt/transport';
import type {
    LocHeaders,
    VideoChunkInit,
    AudioChunkInit,
} from './types.js';
import { resolveLocHeaders, locHeadersToPropertyMap } from './property-map.js';

/**
 * Options for LOC header parsing/encoding.
 */
export interface LocHeaderOptions {
    /**
     * Whether type IDs are delta-encoded (draft-16) or absolute (draft-14).
     *
     * Draft-16 §1.4.2: "Key-Value-Pairs encode a Type value as a delta from
     * the previous Type value, or from 0 if there is no previous Type value."
     *
     * Draft-14 §1.4.2: "Type: an unsigned integer, encoded as a varint,
     * identifying the type of the value."
     *
     * Default: true (draft-16 delta encoding). Ignored when {@link wireProfile}
     * is set.
     *
     * @see draft-ietf-moq-transport-16 §1.4.2
     * @see draft-ietf-moq-transport-14 §1.4.2
     */
    readonly deltaEncoded?: boolean;

    /**
     * Explicit transport wire profile. Overrides {@link deltaEncoded}. Draft-18
     * (`d18-delta-vi64`) MUST be selected here — it uses a vi64 integer codec
     * that diverges from the QUIC varint at value 64, so `deltaEncoded: true`
     * (which stays on the draft-16 QUIC-varint profile) would mis-encode and
     * mis-decode every value ≥ 64.
     *
     * @see draft-ietf-moq-transport-18 §1.4.1 (vi64), §1.4.3 (property block)
     */
    readonly wireProfile?: PropertyWireProfile;
}

/** Map LOC options to a transport wire profile, preserving legacy defaults. */
function resolveWireProfile(options?: LocHeaderOptions): PropertyWireProfile {
    if (options?.wireProfile) return options.wireProfile;
    return options?.deltaEncoded === false ? 'd14-absolute-varint' : 'd16-delta-varint';
}

/** The transport wire profile for a negotiated MoQT draft version. */
export function locWireProfileForDraft(draft: number): PropertyWireProfile {
    switch (draft) {
        case 14:
            return 'd14-absolute-varint';
        case 18:
            return 'd18-delta-vi64';
        default:
            return 'd16-delta-varint';
    }
}

/**
 * Parse LOC header extensions from raw MOQ Object extension bytes.
 *
 * Decodes the property block (Layer A) then resolves LOC semantics (Layer B).
 * Known LOC extension IDs become structured fields; unknown IDs are preserved in
 * `unknown` under their full-width `bigint` id.
 *
 * Type IDs are delta-encoded by default (draft-16 §1.4.2). Pass
 * `{ deltaEncoded: false }` for draft-14 absolute type IDs, or
 * `{ wireProfile: 'd18-delta-vi64' }` for draft-18.
 *
 * @param extensions Raw extension bytes from `MoqtObjectData.extensions`
 * @param options Parsing options (defaults to draft-16 delta)
 * @returns Parsed LOC headers
 * @see draft-ietf-moq-loc-01 §2.3
 */
export function parseLocHeaders(
    extensions: Uint8Array | undefined,
    options?: LocHeaderOptions,
): LocHeaders {
    if (!extensions || extensions.length === 0) {
        return {};
    }
    const { entries } = decodePropertyBlock(extensions, 0, { profile: resolveWireProfile(options) });
    return resolveLocHeaders(entries);
}

/**
 * Encode LOC headers into raw MOQ Object extension bytes.
 *
 * Projects to a PropertyMap (Layer B) then encodes canonically (Layer A):
 * stable ascending-ID order, minimal integer encodings. Returns undefined if no
 * headers are present.
 *
 * @param headers Structured LOC headers
 * @param options Encoding options (defaults to draft-16 delta)
 * @returns Encoded extension bytes, or undefined if empty
 * @see draft-ietf-moq-loc-01 §2.3
 */
export function encodeLocHeaders(
    headers: LocHeaders,
    options?: LocHeaderOptions,
): Uint8Array | undefined {
    const entries = locHeadersToPropertyMap(headers);
    if (entries.length === 0) return undefined;
    return encodePropertyBlock(entries, resolveWireProfile(options));
}

/**
 * Create a WebCodecs-compatible `EncodedVideoChunkInit` from LOC payload + headers.
 *
 * - `type`: "key" if VideoFrameMarking.independent is true, "delta" otherwise
 * - `timestamp`: from CaptureTimestamp (microseconds), or 0 if absent
 * - `data`: the LOC payload (zero-copy reference)
 *
 * @param payload LOC payload (= MoqtObjectData.payload)
 * @param headers Parsed LOC headers
 * @returns VideoChunkInit ready for `new EncodedVideoChunk(init)`
 * @see draft-ietf-moq-loc-01 §2.1, §2.2, §2.3.1.1 (CaptureTimestamp), §2.3.2.2 (VideoFrameMarking)
 */
export function toVideoChunkInit(
    payload: Uint8Array,
    headers: LocHeaders,
): VideoChunkInit {
    const isKey = headers.videoFrameMarking?.independent === true;
    const timestamp = headers.captureTimestamp !== undefined
        ? Number(headers.captureTimestamp)
        : 0;

    return {
        type: isKey ? 'key' : 'delta',
        timestamp,
        data: payload,
    };
}

/**
 * Create a WebCodecs-compatible `EncodedAudioChunkInit` from LOC payload + headers.
 *
 * Audio chunks are always "key" type — each encoded audio chunk is
 * independently decodable (Opus, AAC-LC frames are self-contained).
 *
 * @param payload LOC payload (= MoqtObjectData.payload)
 * @param headers Parsed LOC headers
 * @returns AudioChunkInit ready for `new EncodedAudioChunk(init)`
 * @see draft-ietf-moq-loc-01 §2 (payload format), §2.3.1.1 (CaptureTimestamp)
 */
export function toAudioChunkInit(
    payload: Uint8Array,
    headers: LocHeaders,
): AudioChunkInit {
    const timestamp = headers.captureTimestamp !== undefined
        ? Number(headers.captureTimestamp)
        : 0;

    return {
        type: 'key',
        timestamp,
        data: payload,
    };
}
