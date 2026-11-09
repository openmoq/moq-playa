import { deserializeLocmafObject } from './deserializer.js';
import { LocmafFormatError } from './errors.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafReadBudget, type LocmafReadBudgetLimits } from './read-budget.js';
import { parseLocmafTrackContext, type LocmafTrackContext } from './track-context.js';
import { codecDescriptionFromInit, sliceFrames, type LocmafFrame } from './frame.js';
import { readCmafObjectSamples } from './chunk-samples.js';
import { childBoxes, readBoxHeader, type IsoBoxHeader } from './iso-box.js';
import { MAX_VI64 } from './vi64.js';

export interface LocmafFrameReaderLimits extends LocmafReadBudgetLimits {
    readonly maxGroups: number;
}
export interface LocmafFrameLocation { readonly groupId: bigint; readonly objectId: bigint; }
export interface LocmafFrameHeader {
    readonly bytes: Uint8Array;
    readonly context: LocmafTrackContext;
    readonly description: Uint8Array | null;
}
export interface LocmafFrameUnit {
    /** Sample index across every chunk of this wire Object, in decode order. */
    readonly sampleIndex: number;
    readonly data: Uint8Array;
    readonly decodeTime: bigint;
    readonly presentationTime: bigint;
    readonly duration: number;
    readonly timescale: number;
    readonly flags: number;
    readonly isSync: boolean;
}
/** Continuity within the retained window, never proof of a decoder reference. */
export type LocmafFrameContinuity = 'first' | 'contiguous' | 'gap';
export type LocmafFrameRead =
    | { readonly kind: 'batch'; readonly location: LocmafFrameLocation;
        readonly continuity: LocmafFrameContinuity; readonly units: readonly LocmafFrameUnit[];
        readonly header?: LocmafFrameHeader }
    | { readonly kind: 'reconfigure'; readonly location: LocmafFrameLocation;
        readonly header: LocmafFrameHeader; readonly replay: Uint8Array };

/** Unsupported consumption is not a malformed rawBoxes or transport violation. */
export class LocmafFrameReadError extends Error {
    constructor(readonly reason: 'header-required' | 'protected' | 'incomplete' | 'initialization-placement' | 'replay' | 'retired' | 'busy', message: string) {
        super(message); this.name = 'LocmafFrameReadError';
    }
}
type Header = LocmafFrameHeader;
interface Group {
    readonly state: LocmafGroupState;
    frontier: bigint;
    loss: boolean;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayKind = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
function ownedBytes(bytes: Uint8Array, budget: LocmafReadBudget): Uint8Array {
    if (arrayKind.call(bytes) !== 'Uint8Array') throw new TypeError('Expected Uint8Array media bytes');
    const length: number = byteLength.call(bytes);
    budget.claimBytes(length);
    const owned = new Uint8Array(length);
    Uint8Array.prototype.set.call(owned, bytes);
    return owned;
}
function validId(id: bigint): void {
    if (typeof id !== 'bigint' || id < 0n || id > MAX_VI64) throw new RangeError('Invalid frame Object Location');
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
function headerEnd(top: readonly IsoBoxHeader[]): number | null {
    let ftyp = 0, moov = 0;
    for (const box of top) { if (box.type === 'ftyp') ftyp++; if (box.type === 'moov') moov++; }
    if (!ftyp && !moov) return null;
    if (ftyp === 1 && moov === 1 && top[0]?.type === 'ftyp' && top[1]?.type === 'moov') return top[1].end;
    // §9 permits complete boxes beyond the supported leading Header shape.
    // Refuse that read locally; never label its media with the previous epoch.
    throw new LocmafFrameReadError('initialization-placement', 'Frame consumption requires a single leading ftyp/moov Header');
}

/**
 * Clear frame consumption of complete LOCMAF carriers (§§3,6,9,16).
 * One instance owns one initialization epoch. Changed initialization is returned
 * for successor replay and retires this instance; the host owns reconfiguration.
 * Returned byte views/batches belong to the caller, which must bound their
 * retention. The limits cover private retained state plus each read's work,
 * in logical entries and explicit backing bytes, not measured JS heap usage.
 */
export class LocmafFrameReader {
    private readonly limits: LocmafFrameReaderLimits;
    private readonly groups = new Map<bigint, Group>();
    private readonly reconstructor = new LocmafReconstructor();
    private initialization: Header | null = null;
    private retired = false;
    private busy = false;

    /**
     * Attempted inputs are the default conservative seek-reader policy.
     * Committed consumers suppress stale copies without destroying their
     * reference; failed work still loses its reference, never the last accepted Location.
     */
    constructor(init: Uint8Array | undefined, limits: Readonly<LocmafFrameReaderLimits>,
        private readonly inputPolicy: 'attempted' | 'committed' = 'attempted') {
        if (inputPolicy !== 'attempted' && inputPolicy !== 'committed') throw new TypeError('Invalid frame input policy');
        const { maxSamples, maxEntries, maxBytes, maxGroups } = limits;
        for (const value of [maxSamples, maxEntries, maxBytes, maxGroups]) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Frame reader limits must be positive safe integers');
        }
        this.limits = Object.freeze({ maxSamples, maxEntries, maxBytes, maxGroups });
        if (init !== undefined) this.initialization = this.readHeader(init, this.budget());
    }

    get hasHeader(): boolean { return this.initialization !== null; }
    /** Owned configuration snapshot; null when uninitialized or retired. */
    snapshotInitialization(): LocmafFrameHeader | null {
        if (!this.initialization) return null;
        this.available();
        return this.snapshotHeader(this.initialization, this.budget());
    }
    get retainedUsage(): Readonly<{ entries: number; bytes: number; groups: number }> {
        let entries = this.initialization ? 3 : 0;
        const header = this.initialization;
        const bytes = header ? header.bytes.byteLength + (header.description?.byteLength ?? 0)
            + (header.context.defaultKid?.byteLength ?? 0) + (header.context.constantIv?.byteLength ?? 0) : 0;
        for (const group of this.groups.values()) entries += 2 + group.state.retainedEntryCount;
        return Object.freeze({ entries, bytes, groups: this.groups.size });
    }

    push(groupId: bigint, objectId: bigint, payload: Uint8Array): LocmafFrameRead {
        this.available(); validId(groupId); validId(objectId);
        const prior = this.groups.get(groupId);
        if (this.inputPolicy === 'committed' && prior && objectId <= prior.frontier) {
            throw new LocmafFrameReadError('replay', 'Frame input does not advance the retained Object frontier');
        }
        this.busy = true;
        try {
            const budget = this.budget();
            const bytes = ownedBytes(payload, budget);
            if (prior && objectId <= prior.frontier) throw new LocmafFrameReadError('replay', 'Frame input does not advance the retained Object frontier');
            budget.claimEntries(prior ? 1 : 2);
            let state: LocmafGroupState;
            if (prior) state = prior.state.fork(budget);
            else { budget.claimEntries(1); state = new LocmafGroupState(); }
            const continuity: LocmafFrameContinuity = !prior ? 'first'
                : prior.loss || objectId !== prior.frontier + 1n ? 'gap' : 'contiguous';
            const object = deserializeLocmafObject(bytes, budget);
            let initialization = this.initialization;
            let header: LocmafFrameHeader | undefined;
            const units: LocmafFrameUnit[] = [];
            if (object.kind === 'rawBoxes') {
                const raw = object.boxes;
                const top = childBoxes(raw, 0, raw.length, '9', budget);
                const end = headerEnd(top);
                if (end !== null) {
                    const prefix = raw.subarray(0, end);
                    if (!initialization || !sameBytes(initialization.bytes, prefix)) {
                        const next = this.readHeader(prefix, budget);
                        const snapshot = this.snapshotHeader(next, budget);
                        if (initialization) {
                            const result: LocmafFrameRead = Object.freeze({ kind: 'reconfigure',
                                location: Object.freeze({ groupId, objectId }), header: snapshot, replay: bytes });
                            this.retire();
                            return result;
                        }
                        initialization = next; header = snapshot;
                    }
                }
                if (top.some(box => box.type === 'moof')) {
                    if (!initialization) throw new LocmafFrameReadError('header-required', 'A CMAF Header is required before frame media');
                    const chunks = readCmafObjectSamples(raw, initialization.context, budget);
                    if (chunks === null) throw new LocmafFrameReadError('incomplete', 'Split moof/mdat Objects are unsupported by this frame reader');
                    for (const chunk of chunks) this.appendUnits(units, sliceFrames(chunk.effective, chunk.mdat, budget), initialization.context.timescale, budget);
                } else if (top.some(box => box.type === 'mdat')) {
                    throw new LocmafFrameReadError('incomplete', 'An mdat without its moof has no frame ownership');
                }
                // rawBoxes always breaks the delta reference, including Headers.
                state.clear(); state.noteObject(objectId);
            } else {
                if (!initialization) throw new LocmafFrameReadError('header-required', 'A CMAF Header is required before frame media');
                const chunk = this.reconstructor.reconstructSamples(object, state, initialization.context, objectId, budget);
                if (chunk.kind !== 'chunk') throw new Error('Expected effective LOCMAF samples');
                this.appendUnits(units, sliceFrames(chunk.effective, chunk.mdat, budget), initialization.context.timescale, budget);
            }
            // No source/codec callback can observe a partly accepted batch.
            const result: LocmafFrameRead = Object.freeze({ kind: 'batch', location: Object.freeze({ groupId, objectId }),
                continuity, units: Object.freeze(units), ...(header ? { header } : {}) });
            if (!this.groups.has(groupId) && this.groups.size === this.limits.maxGroups) {
                const oldest = this.groups.keys().next().value;
                if (oldest !== undefined) this.groups.delete(oldest);
            }
            this.initialization = initialization;
            this.groups.set(groupId, { state, frontier: objectId, loss: false });
            return result;
        } catch (error) {
            if (prior) {
                prior.state.clear(); prior.loss = true;
                if (this.inputPolicy === 'attempted' && objectId > prior.frontier) prior.frontier = objectId;
            }
            throw error;
        } finally { this.busy = false; }
    }

    /** Reset a native consumer Group; attempted readers retain a discontinuity marker. */
    resetGroup(groupId: bigint): void {
        if (this.inputPolicy === 'committed') { this.groups.delete(groupId); return; }
        const group = this.groups.get(groupId);
        if (group) { group.state.clear(); group.loss = true; }
    }
    retire(): void { this.retired = true; this.groups.clear(); this.initialization = null; }

    private budget(): LocmafReadBudget {
        const budget = new LocmafReadBudget(this.limits), retained = this.retainedUsage;
        budget.claimEntries(retained.entries); budget.claimBytes(retained.bytes);
        return budget;
    }
    private readHeader(bytes: Uint8Array, budget: LocmafReadBudget): Header {
        let owned = ownedBytes(bytes, budget);
        const first = readBoxHeader(owned, 0, owned.length, '6', budget);
        const second = readBoxHeader(owned, first.end, owned.length, '6', budget);
        if (first.type !== 'ftyp' || second.type !== 'moov') throw new LocmafFormatError('6', 0, 'CMAF Header must begin with ftyp and moov');
        const top = childBoxes(owned, 0, owned.length, '6', budget);
        headerEnd(top);
        if (top.some(box => box.type === 'moof' || box.type === 'mdat')) throw new LocmafFormatError('6', 0, 'Initialization contains media; submit it as a media Object');
        // Trailing non-media boxes are validated but are not the ftyp+moov
        // Header identity. Copy the prefix so their backing is not retained.
        if (second.end !== owned.length) owned = ownedBytes(owned.subarray(0, second.end), budget);
        const context = parseLocmafTrackContext(owned, budget);
        if (!Number.isInteger(context.timescale) || context.timescale <= 0) throw new LocmafFormatError('6', 0, 'Track timescale must be positive');
        if (context.isProtected) throw new LocmafFrameReadError('protected', 'Protected frame consumption requires a decrypting host');
        const description = codecDescriptionFromInit(owned, budget);
        budget.claimEntries(3);
        return { bytes: owned, context, description };
    }
    private snapshotHeader(header: Header, budget: LocmafReadBudget): LocmafFrameHeader {
        budget.claimEntries(2);
        const context = Object.freeze({ ...header.context,
            defaultKid: header.context.defaultKid ? ownedBytes(header.context.defaultKid, budget) : null,
            constantIv: header.context.constantIv ? ownedBytes(header.context.constantIv, budget) : null });
        return Object.freeze({ bytes: ownedBytes(header.bytes, budget), context,
            description: header.description ? ownedBytes(header.description, budget) : null });
    }
    private appendUnits(out: LocmafFrameUnit[], frames: readonly LocmafFrame[], timescale: number, budget: LocmafReadBudget): void {
        budget.claimEntries(frames.length);
        for (const frame of frames) out.push(Object.freeze({ sampleIndex: out.length, data: frame.data,
            decodeTime: frame.decodeTime, presentationTime: frame.presentationTime, duration: frame.duration,
            flags: frame.flags, isSync: frame.isSync, timescale }));
    }
    private available(): void {
        if (this.retired) throw new LocmafFrameReadError('retired', 'Frame reader is retired');
        if (this.busy) throw new LocmafFrameReadError('busy', 'Frame reader is processing another Object');
    }
}
