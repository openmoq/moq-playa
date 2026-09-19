/**
 * LOCMAF header shorthands for tests.
 *
 * @module
 */

import { LocmafFieldId } from '../src/fields.js';
import { LocmafHeader } from '../src/model.js';
import { zigzagEncode } from '../src/vi64.js';

/** Java LocmafReconstructorFullTest.full(count, bmdt). */
export function fullHeader(count: number | bigint, bmdt: number | bigint): LocmafHeader {
    const h = new LocmafHeader(true);
    h.set(LocmafFieldId.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: BigInt(count) });
    h.set(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME, { kind: 'scalar', value: BigInt(bmdt) });
    return h;
}

export function setScalar(h: LocmafHeader, id: number, value: number | bigint): LocmafHeader {
    h.set(id, { kind: 'scalar', value: BigInt(value) });
    return h;
}

export function setList(h: LocmafHeader, id: number, values: ReadonlyArray<number | bigint>): LocmafHeader {
    h.set(id, { kind: 'list', values: values.map((x) => BigInt(x)) });
    return h;
}

export function setBytes(h: LocmafHeader, id: number, bytes: Uint8Array): LocmafHeader {
    h.set(id, { kind: 'bytes', bytes });
    return h;
}

/** Zigzag-encode small signed numbers for delta headers. */
export function zz(...values: Array<number | bigint>): bigint[] {
    return values.map((x) => zigzagEncode(BigInt(x)));
}
