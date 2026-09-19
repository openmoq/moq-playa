/**
 * vi64 and zigzag, as used by LOCMAF (draft-einarsson-moq-locmaf-01 section 2
 * defers vi64 to draft-ietf-moq-transport-18 section 1.4.1; zigzag is section 7.4).
 *
 * The Java reference port used QUIC varints here; its round-trip values are
 * kept, but its byte vectors are replaced by the draft-18 Table 2 examples and
 * a value observed in the Eyevinn golden vectors.
 */
import { describe, it, expect } from 'vitest';
import {
    MAX_VI64,
    encodeVi64,
    readVi64,
    vi64Length,
    vi64ToNumber,
    zigzagDecode,
    zigzagEncode,
} from './vi64.js';
import { LocmafFormatError } from './errors.js';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

describe('vi64', () => {
    it('writes the shortest draft-18 forms (Table 2)', () => {
        const table: ReadonlyArray<[string, bigint]> = [
            ['25', 37n],
            ['bbbd', 15293n],
            ['ed7f3e7d', 226442877n],
            ['faa1a0e403d8', 2893212287960n],
            ['fc8998abc66bc0', 151288809941952n],
            ['fefa318fa8e3ca11', 70423237261249041n],
            ['ffffffffffffffffff', MAX_VI64],
        ];
        for (const [h, v] of table) {
            expect(hex(encodeVi64(v))).toBe(h);
            expect(readVi64(bytes(h), 0)).toEqual({ value: v, bytesRead: h.length / 2 });
        }
    });

    it('decodes the 3-byte BMDT 90000 carried by the Eyevinn event-only vector', () => {
        expect(readVi64(bytes('c15f90'), 0).value).toBe(90000n);
    });

    it('reports lengths at the boundaries and reads back what it wrote', () => {
        expect(vi64Length(127n)).toBe(1);
        expect(vi64Length(128n)).toBe(2);
        expect(vi64Length(16383n)).toBe(2);
        expect(vi64Length(16384n)).toBe(3);
        const values = [0n, 1n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, (1n << 62n) - 1n, MAX_VI64];
        for (const value of values) {
            const enc = encodeVi64(value);
            expect(enc.length).toBe(vi64Length(value));
            expect(readVi64(enc, 0)).toEqual({ value, bytesRead: enc.length });
        }
    });

    it('rejects out-of-range values on write', () => {
        expect(() => encodeVi64(-1n)).toThrow(RangeError);
        expect(() => encodeVi64(MAX_VI64 + 1n)).toThrow(RangeError);
    });

    it('rejects truncated input with a LocmafFormatError at the start offset', () => {
        const err = (() => {
            try {
                readVi64(bytes('00c219'), 1);
            } catch (e) {
                return e;
            }
            return undefined;
        })();
        expect(err).toBeInstanceOf(LocmafFormatError);
        expect((err as LocmafFormatError).offset).toBe(1);
        expect(() => readVi64(new Uint8Array(0), 0)).toThrow(LocmafFormatError);
    });

    it('converts to number only within the safe integer range', () => {
        expect(vi64ToNumber(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
        expect(() => vi64ToNumber(9007199254740992n)).toThrow(RangeError);
    });
});

describe('zigzag (section 7.4)', () => {
    it('matches the draft mapping table', () => {
        const pairs: ReadonlyArray<[bigint, bigint]> = [[0n, 0n], [-1n, 1n], [1n, 2n], [-2n, 3n], [2n, 4n], [-3n, 5n], [3n, 6n]];
        for (const [n, z] of pairs) {
            expect(zigzagEncode(n)).toBe(z);
            expect(zigzagDecode(z)).toBe(n);
        }
    });

    it('covers the signed 64-bit extremes', () => {
        const min = -(1n << 63n);
        const max = (1n << 63n) - 1n;
        expect(zigzagEncode(min)).toBe(MAX_VI64);
        expect(zigzagDecode(zigzagEncode(min))).toBe(min);
        expect(zigzagDecode(zigzagEncode(max))).toBe(max);
        expect(() => zigzagEncode(max + 1n)).toThrow(RangeError);
    });
});
