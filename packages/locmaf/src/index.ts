/**
 * @moqt/locmaf — Low Overhead CMAF for Media over QUIC.
 *
 * Parses LOCMAF Objects (genBox, full/delta moof headers, rawBoxes), keeps the
 * per-group delta reference, and reconstructs canonical CMAF chunks that feed
 * an unmodified CMAF pipeline such as MSE. Also encodes CMAF chunks into
 * canonical LOCMAF Objects. Pure TypeScript, no runtime dependencies, no
 * browser APIs.
 *
 * @see draft-einarsson-moq-locmaf-01
 * @module
 */

// ─── Errors ─────────────────────────────────────────────────────────

export { LocmafFormatError } from './errors.js';

// ─── vi64 and zigzag ────────────────────────────────────────────────

export { MAX_VI64, encodeVi64, readVi64, vi64Length, vi64ToNumber, zigzagDecode, zigzagEncode } from './vi64.js';

// ─── Element types, field IDs and the Object model ──────────────────

export { LOCMAF_VERSION, LocmafElementType, LocmafFieldId, fieldKind, isCencField, isKnownField } from './fields.js';
export type { LocmafFieldIdValue, LocmafFieldKind } from './fields.js';
export { LocmafHeader } from './model.js';
export type { GenBox, LocmafObject, LocmafValue } from './model.js';

// ─── Object codec ───────────────────────────────────────────────────

export { MAX_GEN_BOX_SIZE, deserializeLocmafObject, validateRawBoxes } from './deserializer.js';
export { serializeLocmafObject } from './serializer.js';

// ─── CMAF Header ────────────────────────────────────────────────────

export { parseLocmafTrackContext } from './track-context.js';
export type { LocmafTrackContext } from './track-context.js';

// ─── Reconstruction ─────────────────────────────────────────────────

export { LocmafGroupState } from './group-state.js';
export { LocmafReconstructor, MAX_SAMPLE_COUNT, buildCanonicalChunk } from './reconstruct.js';
export type { LocmafReconstruction } from './reconstruct.js';
export { SAMPLE_IS_NON_SYNC, isSyncSampleFlags, totalDuration } from './effective.js';
export type { LocmafCencSamples, LocmafEffectiveSamples } from './effective.js';

// ─── Encoding ───────────────────────────────────────────────────────

export { LocmafEncoder, deltaFields, representedFields } from './encoder.js';
export { extractEffectiveSamples, parseCmafChunk } from './cmaf-chunk.js';
export type { CmafChunkParse } from './cmaf-chunk.js';

// ─── Playback ───────────────────────────────────────────────────────

export { LocmafTrackDecoder } from './track-decoder.js';
export type { LocmafDecodeResult } from './track-decoder.js';
