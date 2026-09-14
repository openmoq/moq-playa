/**
 * Stateful per-track LOCMAF decoder for playback: feed MOQT Objects in order,
 * get canonical CMAF chunks (for MSE) or verbatim rawBoxes back.
 *
 * Keeps one in-group reference per recent MOQT group: each group rides its own
 * subgroup stream, so the tail of one group routinely interleaves with the head
 * of the next, and a single shared reference would reject both. A group seen for
 * the first time starts a fresh reference, so its first moof-carrying Object must
 * be a full header (section 7.1). Rejections are returned, not thrown, and discard
 * that group's reference until its next full header (section 3). Free of browser
 * APIs.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 3, 6, 15, 16
 * @module
 */

import { deserializeLocmafObject } from './deserializer.js';
import { isSyncSampleFlags, type LocmafEffectiveSamples } from './effective.js';
import { LocmafFormatError } from './errors.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafReconstructor } from './reconstruct.js';
import { parseLocmafTrackContext, type LocmafTrackContext } from './track-context.js';

/** Outcome of {@link LocmafTrackDecoder.push}. */
export type LocmafDecodeResult =
    | {
          readonly kind: 'chunk';
          /** Canonical CMAF chunk: genBoxes, moof, mdat. */
          readonly bytes: Uint8Array;
          /** The first sample's effective flags have sample_is_non_sync_sample clear. */
          readonly startsWithSync: boolean;
          readonly baseMediaDecodeTime: bigint;
          /** mdhd.timescale of the track. */
          readonly timescale: number;
          readonly sampleCount: number;
          /** Effective per-sample values, for frame-based consumers (section 16). */
          readonly effective: LocmafEffectiveSamples;
      }
    | {
          /** A rawBoxes Object: complete ISO boxes, verbatim (possibly a CMAF Header). */
          readonly kind: 'raw';
          readonly bytes: Uint8Array;
      }
    | {
          readonly kind: 'rejected';
          readonly error: LocmafFormatError;
      };

/** Groups whose in-group references are kept at once; older ones are dropped first. */
export const MAX_TRACKED_GROUPS = 8;

export class LocmafTrackDecoder {
    /** Constants from the CMAF Header. */
    readonly context: LocmafTrackContext;
    private readonly reconstructor = new LocmafReconstructor();
    /** In-group reference per MOQT group, in first-seen order. */
    private readonly states = new Map<bigint, LocmafGroupState>();

    /**
     * @param init the track's CMAF Header (ftyp + moov with exactly one trak).
     * @throws {LocmafFormatError} when the CMAF Header cannot seed reconstruction.
     */
    constructor(init: Uint8Array) {
        this.context = parseLocmafTrackContext(init);
    }

    /** Decode one MOQT Object payload. Objects of a group must arrive in Object ID order. */
    push(groupId: bigint, objectId: bigint, payload: Uint8Array): LocmafDecodeResult {
        let state = this.states.get(groupId);
        if (!state) {
            state = new LocmafGroupState();
            this.states.set(groupId, state);
            if (this.states.size > MAX_TRACKED_GROUPS) {
                const oldest = this.states.keys().next().value;
                if (oldest !== undefined) this.states.delete(oldest);
            }
        }
        try {
            const object = deserializeLocmafObject(payload);
            const out = this.reconstructor.reconstruct(object, state, this.context, objectId);
            if (out.kind === 'raw') return { kind: 'raw', bytes: out.bytes };
            const effective = out.effective;
            const first = effective.flags[0];
            return {
                kind: 'chunk',
                bytes: out.bytes,
                startsWithSync: first !== undefined && isSyncSampleFlags(first),
                baseMediaDecodeTime: effective.baseMediaDecodeTime,
                timescale: this.context.timescale,
                sampleCount: effective.durations.length,
                effective,
            };
        } catch (e) {
            if (e instanceof LocmafFormatError) {
                state.clear();
                return { kind: 'rejected', error: e };
            }
            throw e;
        }
    }

    /** Forget every group's reference (e.g. after a subscription restart). */
    reset(): void {
        this.states.clear();
    }
}
