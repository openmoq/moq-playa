/**
 * Byte-level helpers shared by the LOCMAF tests.
 *
 * @module
 */

import { encodeVi64 } from '../src/vi64.js';

/** Concatenate vi64 encodings of the given values. */
export function vi(...values: Array<number | bigint>): Uint8Array {
    return concat(...values.map((v) => encodeVi64(BigInt(v))));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

export function ascii(s: string): Uint8Array {
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function u8(v: number): Uint8Array {
    return Uint8Array.of(v & 0xff);
}

export function u16(v: number): Uint8Array {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, v);
    return out;
}

export function u32(v: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, v >>> 0);
    return out;
}

export function i32(v: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setInt32(0, v);
    return out;
}

export function u64(v: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, v);
    return out;
}

/** An ISO BMFF box with a 32-bit size. */
export function isoBox(type: string, ...contents: Uint8Array[]): Uint8Array {
    const body = concat(...contents);
    return concat(u32(8 + body.length), ascii(type), body);
}

/** An ISO BMFF FullBox. */
export function fullBox(type: string, version: number, flags: number, ...contents: Uint8Array[]): Uint8Array {
    return isoBox(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...contents);
}

export function hex(b: Uint8Array): string {
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Index of the first occurrence of a FourCC, or -1. */
export function indexOfFourcc(haystack: Uint8Array, fourcc: string): number {
    const n = ascii(fourcc);
    for (let i = 0; i + 4 <= haystack.length; i++) {
        if (haystack[i] === n[0] && haystack[i + 1] === n[1] && haystack[i + 2] === n[2] && haystack[i + 3] === n[3]) {
            return i;
        }
    }
    return -1;
}

/** Deterministic PRNG (mulberry32) for reproducible test media. */
export function prng(seed: number): { next(): number; int(bound: number): number; fill(b: Uint8Array): Uint8Array } {
    let s = seed >>> 0;
    const next = (): number => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (bound) => Math.floor(next() * bound),
        fill: (b) => {
            for (let i = 0; i < b.length; i++) b[i] = Math.floor(next() * 256);
            return b;
        },
    };
}
