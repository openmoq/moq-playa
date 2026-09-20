/**
 * LOCMAF Object model: the two payload shapes, genBoxes, and the header
 * field map in wire form.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 7, 8, 9
 * @module
 */

import { LocmafFieldId, fieldKind } from './fields.js';

/**
 * A header field value in wire form. Scalars and list elements are the raw
 * unsigned vi64 values as they appear on the wire: absolute in a full header,
 * zigzag deltas in a delta header, and zigzag in both for field 5.
 */
export type LocmafValue =
    | { readonly kind: 'scalar'; readonly value: bigint }
    | { readonly kind: 'list'; readonly values: readonly bigint[] }
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

/**
 * One pre-moof ISO box carried as a genBox (section 8): the FourCC and the box
 * contents without the 8-byte ISO box header, carried verbatim.
 */
export interface GenBox {
    readonly type: string;
    readonly payload: Uint8Array;
}

/** A full (element type 2) or delta (element type 3) locmafHeader. @see section 7.2 */
export class LocmafHeader {
    readonly full: boolean;
    private readonly fields = new Map<number, LocmafValue>();

    constructor(full: boolean) {
        this.full = full;
    }

    /**
     * Set a known field.
     * @throws {TypeError} for an unknown ID, a value of the wrong kind, field 27
     *   in a full header (section 10.4) or field 10 in a delta header (section 12.2).
     */
    set(id: number, value: LocmafValue): void {
        const kind = fieldKind(id);
        if (kind === undefined) {
            throw new TypeError(`field ${id} is not defined by LOCMAF`);
        }
        if (this.full && id === LocmafFieldId.DELTA_DELETED_LOCMAF_IDS) {
            throw new TypeError('field 27 is delta-only (section 10.4)');
        }
        if (!this.full && id === LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME) {
            throw new TypeError('field 10 is full-only (section 12.2)');
        }
        const expected = kind === 'scalar' ? 'scalar' : kind === 'bytes' ? 'bytes' : 'list';
        if (value.kind !== expected) {
            throw new TypeError(`field ${id} takes a ${expected} value, got ${value.kind}`);
        }
        this.fields.set(id, value);
    }

    has(id: number): boolean {
        return this.fields.has(id);
    }

    get(id: number): LocmafValue | undefined {
        return this.fields.get(id);
    }

    delete(id: number): void {
        this.fields.delete(id);
    }

    /** Scalar value of a present scalar field. */
    scalar(id: number): bigint {
        const v = this.fields.get(id);
        if (v?.kind !== 'scalar') throw new TypeError(`field ${id} is not a present scalar`);
        return v.value;
    }

    /** Elements of a present list field. */
    list(id: number): readonly bigint[] {
        const v = this.fields.get(id);
        if (v?.kind !== 'list') throw new TypeError(`field ${id} is not a present list`);
        return v.values;
    }

    /** Bytes of a present raw-bytes field. */
    bytes(id: number): Uint8Array {
        const v = this.fields.get(id);
        if (v?.kind !== 'bytes') throw new TypeError(`field ${id} is not present raw bytes`);
        return v.bytes;
    }

    get size(): number {
        return this.fields.size;
    }

    /** Present field IDs in ascending order, the canonical emission order (section 15.9). */
    ids(): number[] {
        return [...this.fields.keys()].sort((a, b) => a - b);
    }

    /** A shallow copy (values are immutable). */
    copy(full: boolean = this.full): LocmafHeader {
        const out = new LocmafHeader(full);
        for (const [id, v] of this.fields) out.fields.set(id, v);
        return out;
    }
}

/**
 * The two LOCMAF Object payload shapes (section 7.1): a moof-carrying Object
 * (genBoxes, one header, the untagged mdat payload) or a rawBoxes Object.
 */
export type LocmafObject =
    | {
          readonly kind: 'moof';
          readonly genBoxes: readonly GenBox[];
          readonly header: LocmafHeader;
          readonly mdat: Uint8Array;
      }
    | { readonly kind: 'rawBoxes'; readonly boxes: Uint8Array };
