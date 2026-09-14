/**
 * LOCMAF element types and header field IDs.
 *
 * @see draft-einarsson-moq-locmaf-01 section 7.1 (Table 3), section 10 (Table 4)
 * @module
 */

/**
 * The LOCMAF packaging version this package implements, as signalled by the
 * catalog `locmafVersion` field.
 *
 * @see section 5
 */
export const LOCMAF_VERSION = '0.3';

/**
 * Top-level element types. An element type not listed here is not
 * self-delimiting and makes the Object malformed.
 *
 * @see section 7.1
 */
export const LocmafElementType = {
    /** One generic pre-moof ISO box. @see section 8 */
    GEN_BOX: 1,
    /** Full (absolute) moof header. @see section 11 */
    FULL_HEADER: 2,
    /** Delta moof header. @see section 12 */
    DELTA_HEADER: 3,
    /** Complete ISO boxes, verbatim; sole element of its Object. @see section 9 */
    RAW_BOXES: 4,
} as const;

/**
 * Header field IDs. Even IDs are scalars (one vi64), odd IDs are
 * length-prefixed (section 7.3 parity rule).
 *
 * @see section 10, Table 4
 */
export const LocmafFieldId = {
    /** trun sample sizes, n-1 entries (section 11.2). */
    TRUN_SAMPLE_SIZES: 1,
    /** tfhd sample_description_index. */
    TFHD_SAMPLE_DESCRIPTION_INDEX: 2,
    /** trun per-sample durations. */
    TRUN_SAMPLE_DURATIONS: 3,
    /** tfhd default_sample_duration. */
    TFHD_DEFAULT_SAMPLE_DURATION: 4,
    /** trun composition time offsets; zigzag in both header kinds (section 7.3). */
    TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS: 5,
    /** tfhd default_sample_size. */
    TFHD_DEFAULT_SAMPLE_SIZE: 6,
    /** trun per-sample flags, full 32-bit values (section 10.1). */
    TRUN_SAMPLE_FLAGS: 7,
    /** tfhd default_sample_flags. */
    TFHD_DEFAULT_SAMPLE_FLAGS: 8,
    /** senc per-sample IVs, raw bytes overwritten in deltas. */
    SENC_INITIALIZATION_VECTOR: 9,
    /** tfdt baseMediaDecodeTime; full headers only (section 12.2). */
    TFDT_BASE_MEDIA_DECODE_TIME: 10,
    /** senc subsample_count per sample. */
    SENC_SUBSAMPLE_COUNT: 11,
    /** trun first_sample_flags. */
    TRUN_FIRST_SAMPLE_FLAGS: 12,
    /** senc BytesOfClearData, flattened. */
    SENC_BYTES_OF_CLEAR_DATA: 13,
    /** trun sample_count; anchors every list length (section 10.2). */
    TRUN_SAMPLE_COUNT: 14,
    /** senc BytesOfProtectedData, flattened. */
    SENC_BYTES_OF_PROTECTED_DATA: 15,
    /** senc per_sample_IV_size. */
    SENC_PER_SAMPLE_IV_SIZE: 16,
    /** Delta-only deletion marker, plain vi64 field IDs (section 10.4). */
    DELTA_DELETED_LOCMAF_IDS: 27,
} as const;

export type LocmafFieldIdValue = (typeof LocmafFieldId)[keyof typeof LocmafFieldId];

/**
 * Value interpretation of a known field.
 * - `scalar`: even ID, absolute vi64 in full, zigzag delta in delta
 * - `list`: odd ID, vi64 elements, absolute in full, zigzag deltas in delta
 * - `signed-list`: odd ID, zigzag elements in both contexts (field 5)
 * - `bytes`: odd ID, opaque bytes, overwrite in both contexts (field 9)
 * - `deletion-list`: odd ID, plain vi64 field IDs, delta only (field 27)
 */
export type LocmafFieldKind = 'scalar' | 'list' | 'signed-list' | 'bytes' | 'deletion-list';

const KINDS: ReadonlyMap<number, LocmafFieldKind> = new Map<number, LocmafFieldKind>([
    [1, 'list'], [2, 'scalar'], [3, 'list'], [4, 'scalar'], [5, 'signed-list'], [6, 'scalar'],
    [7, 'list'], [8, 'scalar'], [9, 'bytes'], [10, 'scalar'], [11, 'list'], [12, 'scalar'],
    [13, 'list'], [14, 'scalar'], [15, 'list'], [16, 'scalar'], [27, 'deletion-list'],
]);

/** The kind of a known field ID, or `undefined` for an ID this document does not define. */
export function fieldKind(id: number): LocmafFieldKind | undefined {
    return KINDS.get(id);
}

/** Whether the field ID is defined in Table 4. */
export function isKnownField(id: number): boolean {
    return KINDS.has(id);
}

/** Fields 9, 11, 13, 15, 16: allowed only on protected tracks (section 10.3). */
export function isCencField(id: number): boolean {
    return id === 9 || id === 11 || id === 13 || id === 15 || id === 16;
}
