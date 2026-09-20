/**
 * @moqt/loc — Low Overhead Media Container.
 *
 * Parses LOC header properties (LOC-01 and LOC-04) from MOQ Object property
 * bytes, and provides WebCodecs-compatible chunk init objects for zero-copy
 * media delivery.
 *
 * @see draft-ietf-moq-loc-01
 * @see draft-ietf-moq-loc-04
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────────

export type {
    VideoFrameMarking,
    AudioLevel,
    LocHeaders,
    LocExtensionValue,
    LocTrackContext,
    LocVersion,
    VideoChunkInit,
    AudioChunkInit,
} from './types.js';

export { LocExtensionId, Loc01PropertyId, Loc04PropertyId } from './types.js';
export { LocHeaderError, LocEncodeError } from './errors.js';

// ─── Header parsing ─────────────────────────────────────────────────

export { parseLocHeaders, encodeLocHeaders, toVideoChunkInit, toAudioChunkInit, locWireProfileForDraft } from './headers.js';
export type { LocHeaderOptions } from './headers.js';

// ─── Layer B — LOC semantic resolution (PropertyMap ⇄ LocHeaders) ────

export { resolveLocHeaders, locHeadersToPropertyMap } from './property-map.js';

// ─── Bit-level parsers ──────────────────────────────────────────────

export {
    parseVideoFrameMarking,
    encodeVideoFrameMarking,
    parseVideoFrameMarkingBytes,
    encodeVideoFrameMarkingBytes,
} from './video.js';
export { parseAudioLevel, encodeAudioLevel } from './audio.js';
