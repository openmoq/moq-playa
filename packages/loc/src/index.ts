/**
 * @moqt/loc — Low Overhead Media Container.
 *
 * Parses LOC header extensions (CaptureTimestamp, VideoFrameMarking,
 * AudioLevel, VideoConfig) from MOQ Object extension bytes, and provides
 * WebCodecs-compatible chunk init objects for zero-copy media delivery.
 *
 * @see draft-ietf-moq-loc-01
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────────

export type {
    VideoFrameMarking,
    AudioLevel,
    LocHeaders,
    LocExtensionValue,
    VideoChunkInit,
    AudioChunkInit,
} from './types.js';

export { LocExtensionId } from './types.js';

// ─── Header parsing ─────────────────────────────────────────────────

export { parseLocHeaders, encodeLocHeaders, toVideoChunkInit, toAudioChunkInit, locWireProfileForDraft } from './headers.js';
export type { LocHeaderOptions } from './headers.js';

// ─── Layer B — LOC semantic resolution (PropertyMap ⇄ LocHeaders) ────

export { resolveLocHeaders, locHeadersToPropertyMap } from './property-map.js';

// ─── Bit-level parsers ──────────────────────────────────────────────

export { parseVideoFrameMarking, encodeVideoFrameMarking } from './video.js';
export { parseAudioLevel, encodeAudioLevel } from './audio.js';
