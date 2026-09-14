/**
 * Growable big-endian byte writer (internal).
 *
 * @module
 */

import { encodeVi64 } from './vi64.js';

export class ByteWriter {
    private buf: Uint8Array;
    private view: DataView;
    private pos = 0;

    constructor(initialCapacity = 256) {
        this.buf = new Uint8Array(initialCapacity);
        this.view = new DataView(this.buf.buffer);
    }

    get length(): number {
        return this.pos;
    }

    private ensure(extra: number): void {
        const need = this.pos + extra;
        if (need <= this.buf.length) return;
        let cap = this.buf.length * 2;
        while (cap < need) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.pos));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    u8(v: number): void {
        this.ensure(1);
        this.buf[this.pos++] = v & 0xff;
    }

    u16(v: number): void {
        this.ensure(2);
        this.view.setUint16(this.pos, v);
        this.pos += 2;
    }

    u32(v: number): void {
        this.ensure(4);
        this.view.setUint32(this.pos, v >>> 0);
        this.pos += 4;
    }

    i32(v: number): void {
        this.ensure(4);
        this.view.setInt32(this.pos, v);
        this.pos += 4;
    }

    u64(v: bigint): void {
        this.ensure(8);
        this.view.setBigUint64(this.pos, v);
        this.pos += 8;
    }

    fourcc(type: string): void {
        this.ensure(4);
        for (let i = 0; i < 4; i++) this.buf[this.pos++] = type.charCodeAt(i) & 0xff;
    }

    bytes(b: Uint8Array): void {
        this.ensure(b.length);
        this.buf.set(b, this.pos);
        this.pos += b.length;
    }

    vi64(v: bigint): void {
        this.bytes(encodeVi64(v));
    }

    /**
     * The written bytes. When the writer was sized exactly, its buffer is
     * returned without a copy; the writer must not be used afterwards.
     */
    finish(): Uint8Array {
        return this.pos === this.buf.length ? this.buf : this.buf.slice(0, this.pos);
    }
}
