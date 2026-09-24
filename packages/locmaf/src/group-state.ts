/**
 * In-group reference state, one instance per MOQT group per track, shared in
 * shape by the encoder and the reconstructor so both keep identical references.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 3, 7.1, 9.3, 12.1 (the reference
 *   is the previous chunk's represented fields, not its expanded values)
 * @module
 */

import type { LocmafEffectiveSamples } from './effective.js';
import type { LocmafHeader } from './model.js';

export class LocmafGroupState {
    private ref: LocmafHeader | null = null;
    private effective: LocmafEffectiveSamples | null = null;
    private bmdt = 0n;
    private objectId = -1n;

    /** Whether a full header (or delta built on one) anchors this group. */
    get hasReference(): boolean {
        return this.ref !== null;
    }

    /** A copy of the previous chunk's represented fields, in full (absolute) form. */
    get reference(): LocmafHeader | null {
        return this.ref === null ? null : this.ref.copy(true);
    }

    /** Effective values of the previous chunk. */
    get lastEffective(): LocmafEffectiveSamples | null {
        return this.effective;
    }

    /** BMDT of the previous chunk. */
    get baseMediaDecodeTime(): bigint {
        return this.bmdt;
    }

    /** MOQT Object ID of the previous Object, or -1 before the first. */
    get lastObjectId(): bigint {
        return this.objectId;
    }

    /** Discard the reference: the next moof-carrying Object must carry a full header. */
    clear(): void {
        this.ref = null;
        this.effective = null;
        this.bmdt = 0n;
    }

    /** Record the represented fields and effective values of the chunk just processed. */
    anchor(represented: LocmafHeader, effective: LocmafEffectiveSamples, objectId: bigint): void {
        this.ref = represented.copy(true);
        this.effective = effective;
        this.bmdt = effective.baseMediaDecodeTime;
        this.objectId = objectId;
    }

    /** Record an Object that carried no reference (rawBoxes). */
    noteObject(objectId: bigint): void {
        this.objectId = objectId;
    }
}
