/**
 * A chunk's effective values: the meaning of a LOCMAF chunk after deltas,
 * deletions and derivations, shared by the reconstructor and the encoder.
 *
 * @see draft-einarsson-moq-locmaf-01 section 15.1 (effective values), section 11.1
 * @module
 */

/** ISO sample_flags bit sample_is_non_sync_sample. */
export const SAMPLE_IS_NON_SYNC = 0x00010000;

/** Per-sample CENC auxiliary information (sections 10.2, 15.8), flattened in chunk order. */
export interface LocmafCencSamples {
    /** per_sample_IV_size in bytes (0, 8 or 16). */
    readonly perSampleIvSize: number;
    /** Concatenated per-sample IVs, `perSampleIvSize` bytes each. */
    readonly ivs: Uint8Array;
    /** subsample_count per sample, or null when no subsample map is present. */
    readonly subsampleCounts: readonly number[] | null;
    /** BytesOfClearData for every subsample, or null. */
    readonly clearBytes: readonly number[] | null;
    /** BytesOfProtectedData for every subsample, or null. */
    readonly protectedBytes: readonly number[] | null;
}

/** Effective values of one moof-carrying chunk (section 15.1). */
export interface LocmafEffectiveSamples {
    /** tfdt.baseMediaDecodeTime (absolute, or derived for a delta chunk). */
    readonly baseMediaDecodeTime: bigint;
    readonly sampleDescriptionIndex: number;
    /** Per-sample durations (32-bit). The array length is the sample count. */
    readonly durations: readonly number[];
    /** Per-sample sizes (32-bit). */
    readonly sizes: readonly number[];
    /** Per-sample sample_flags (32-bit unsigned). */
    readonly flags: readonly number[];
    /** Per-sample composition time offsets. */
    readonly compositionTimeOffsets: readonly number[];
    /** CENC auxiliary information, or null when the chunk carries none. */
    readonly cenc: LocmafCencSamples | null;
}

/** Sum of the effective durations: the BMDT increment for the next chunk (section 12.2). */
export function totalDuration(e: LocmafEffectiveSamples): bigint {
    let total = 0n;
    for (const d of e.durations) total += BigInt(d);
    return total;
}

/** True when every element equals the first (vacuously true when empty). */
export function allEqual(values: readonly number[]): boolean {
    for (let i = 1; i < values.length; i++) {
        if (values[i] !== values[0]) return false;
    }
    return true;
}

/** True when samples 1..n-1 share one value that differs from sample 0 (n > 1). */
export function equalExceptFirst(values: readonly number[]): boolean {
    if (values.length < 2) return false;
    for (let i = 2; i < values.length; i++) {
        if (values[i] !== values[1]) return false;
    }
    return values[0] !== values[1];
}

/** Whether a sample_flags value marks a sync sample (sample_is_non_sync_sample clear). */
export function isSyncSampleFlags(flags: number): boolean {
    return (flags & SAMPLE_IS_NON_SYNC) === 0;
}
