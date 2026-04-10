/**
 * LOC header extension parsing and encoding.
 *
 * Parses the opaque `extensions: Uint8Array` from MOQ Object Header
 * Extensions into structured LOC headers (CaptureTimestamp, VideoFrameMarking,
 * AudioLevel, VideoConfig). Unknown extensions are preserved.
 *
 * Wire format: delta-encoded KVP per draft-ietf-moq-transport-16 §1.4.2.
 * Even IDs → varint value. Odd IDs → length-prefixed bytes.
 *
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-transport-16 §2.5 (Extension Headers)
 * @module
 */

import {
    readVarint,
    writeVarint,
    varint,
    varintEncodingLength,
    readLengthPrefixedBytes,
    writeLengthPrefixedBytes,
    lengthPrefixedBytesEncodingLength,
} from '@moqt/transport';
import { LocExtensionId } from './types.js';
import type {
    LocHeaders,
    LocExtensionValue,
    VideoChunkInit,
    AudioChunkInit,
} from './types.js';
import { parseVideoFrameMarking, encodeVideoFrameMarking } from './video.js';
import { parseAudioLevel, encodeAudioLevel } from './audio.js';

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
     * Default: true (draft-16 delta encoding).
     *
     * @see draft-ietf-moq-transport-16 §1.4.2
     * @see draft-ietf-moq-transport-14 §1.4.2
     */
    readonly deltaEncoded?: boolean;
}

/**
 * Parse LOC header extensions from raw MOQ Object extension bytes.
 *
 * Iterates through KVP entries until all bytes are consumed.
 * Known LOC extension IDs are parsed into structured fields; unknown IDs
 * are collected into the `unknown` map.
 *
 * Type IDs are delta-encoded by default (draft-16 §1.4.2). Pass
 * `{ deltaEncoded: false }` for draft-14 absolute type IDs.
 *
 * @param extensions Raw extension bytes from `MoqtObjectData.extensions`
 * @param options Parsing options (deltaEncoded defaults to true)
 * @returns Parsed LOC headers
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-transport-16 §1.4.2 (delta-encoded KVP)
 * @see draft-ietf-moq-transport-14 §1.4.2 (absolute KVP)
 */
export function parseLocHeaders(
    extensions: Uint8Array | undefined,
    options?: LocHeaderOptions,
): LocHeaders {
    if (!extensions || extensions.length === 0) {
        return {};
    }

    let captureTimestamp: bigint | undefined;
    let videoFrameMarking: LocHeaders['videoFrameMarking'];
    let audioLevel: LocHeaders['audioLevel'];
    let videoConfig: Uint8Array | undefined;
    let unknown: Map<number, LocExtensionValue> | undefined;

    const deltaEncoded = options?.deltaEncoded !== false; // default true
    let pos = 0;
    let prevType = 0n;

    while (pos < extensions.length) {
        // Read type ID — delta-encoded (draft-16) or absolute (draft-14)
        const { value: typeVal, bytesRead: typeBytes } = readVarint(extensions, pos);
        pos += typeBytes;

        const absType = deltaEncoded ? prevType + typeVal : typeVal;
        prevType = absType;
        const id = Number(absType);

        if (absType % 2n === 0n) {
            // Even type → value is a single varint
            const { value, bytesRead: valBytes } = readVarint(extensions, pos);
            pos += valBytes;

            switch (id) {
                case LocExtensionId.CAPTURE_TIMESTAMP:
                    captureTimestamp = value;
                    break;
                case LocExtensionId.VIDEO_FRAME_MARKING:
                    videoFrameMarking = parseVideoFrameMarking(value);
                    break;
                case LocExtensionId.AUDIO_LEVEL:
                    audioLevel = parseAudioLevel(value);
                    break;
                default: {
                    if (!unknown) unknown = new Map();
                    unknown.set(id, value);
                    break;
                }
            }
        } else {
            // Odd type → length-prefixed bytes
            const { value: bytes, bytesRead: valBytes } = readLengthPrefixedBytes(extensions, pos);
            pos += valBytes;

            switch (id) {
                case LocExtensionId.VIDEO_CONFIG:
                    videoConfig = bytes;
                    break;
                default: {
                    if (!unknown) unknown = new Map();
                    unknown.set(id, bytes);
                    break;
                }
            }
        }
    }

    const result: LocHeaders = {};
    if (captureTimestamp !== undefined) (result as any).captureTimestamp = captureTimestamp;
    if (videoFrameMarking !== undefined) (result as any).videoFrameMarking = videoFrameMarking;
    if (audioLevel !== undefined) (result as any).audioLevel = audioLevel;
    if (videoConfig !== undefined) (result as any).videoConfig = videoConfig;
    if (unknown !== undefined) (result as any).unknown = unknown;

    return result;
}

/**
 * Encode LOC headers into raw MOQ Object extension bytes.
 *
 * Produces delta-encoded KVP entries in ascending ID order.
 * Returns undefined if no headers are present.
 *
 * @param headers Structured LOC headers
 * @param options Encoding options (deltaEncoded defaults to true)
 * @returns Encoded extension bytes, or undefined if empty
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-transport-16 §1.4.2 (delta-encoded KVP)
 * @see draft-ietf-moq-transport-14 §1.4.2 (absolute KVP)
 */
export function encodeLocHeaders(
    headers: LocHeaders,
    options?: LocHeaderOptions,
): Uint8Array | undefined {
    // Collect entries as [id, value] pairs
    const entries: Array<{ id: number; value: bigint | Uint8Array }> = [];

    if (headers.captureTimestamp !== undefined) {
        entries.push({ id: LocExtensionId.CAPTURE_TIMESTAMP, value: headers.captureTimestamp });
    }
    if (headers.videoFrameMarking !== undefined) {
        entries.push({
            id: LocExtensionId.VIDEO_FRAME_MARKING,
            value: encodeVideoFrameMarking(headers.videoFrameMarking),
        });
    }
    if (headers.audioLevel !== undefined) {
        entries.push({
            id: LocExtensionId.AUDIO_LEVEL,
            value: encodeAudioLevel(headers.audioLevel),
        });
    }
    if (headers.videoConfig !== undefined) {
        entries.push({ id: LocExtensionId.VIDEO_CONFIG, value: headers.videoConfig });
    }
    if (headers.unknown) {
        for (const [id, value] of headers.unknown) {
            entries.push({ id, value });
        }
    }

    if (entries.length === 0) return undefined;

    const deltaEncoded = options?.deltaEncoded !== false; // default true

    // Sort by ID for ascending order
    entries.sort((a, b) => a.id - b.id);

    // Compute total size
    let size = 0;
    let prevId = 0;
    for (const entry of entries) {
        const typeField = deltaEncoded ? entry.id - prevId : entry.id;
        prevId = entry.id;
        size += varintEncodingLength(varint(typeField));

        if (entry.id % 2 === 0) {
            size += varintEncodingLength(varint(entry.value as bigint));
        } else {
            size += lengthPrefixedBytesEncodingLength(entry.value as Uint8Array);
        }
    }

    // Write
    const buf = new Uint8Array(size);
    let pos = 0;
    prevId = 0;
    for (const entry of entries) {
        const typeField = deltaEncoded ? entry.id - prevId : entry.id;
        prevId = entry.id;
        pos += writeVarint(varint(typeField), buf, pos);

        if (entry.id % 2 === 0) {
            pos += writeVarint(varint(entry.value as bigint), buf, pos);
        } else {
            pos += writeLengthPrefixedBytes(entry.value as Uint8Array, buf, pos);
        }
    }

    return buf;
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
