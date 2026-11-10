import { describe, it, expect } from 'vitest';
import type { PropertyEntry } from '@openmoq/transport';
import { locHeadersToPropertyMap, resolveLocHeaders } from './property-map.js';
import { LocEncodeError, LocHeaderError } from './errors.js';

const e = (id: number, value: bigint | Uint8Array): PropertyEntry => ({ id: BigInt(id), value });

describe('resolveLocHeaders — dialect detection', () => {
    it('LOC-01 ids only → version 1, captureTimestamp is wall clock', () => {
        const h = resolveLocHeaders([e(0x02, 1_700_000_000_000_000n), e(0x04, 0x20n), e(0x06, 0x7fn)]);
        expect(h.version).toBe(1);
        expect(h.captureTimestamp).toBe(1_700_000_000_000_000n);
        expect(h.timestamp).toBe(1_700_000_000_000_000n);
        expect(h.timescale).toBeUndefined();
        expect(h.timestampIsWallClock).toBe(true);
        expect(h.videoFrameMarking?.independent).toBe(true);
        expect(h.audioLevel).toEqual({ voiceActivity: false, level: 127 });
        expect(h.unknown).toBeUndefined();
    });

    it('LOC-04 ids only → version 4', () => {
        const h = resolveLocHeaders([
            e(0x10, 900_000n), e(0x08, 90_000n), e(0x09, Uint8Array.from([0x20])),
            e(0x0c, 0x85n), e(0x0f, Uint8Array.from([0x12, 0x10])),
        ]);
        expect(h.version).toBe(4);
        expect(h.timestamp).toBe(900_000n);
        expect(h.timescale).toBe(90_000n);
        expect(h.captureTimestamp).toBe(10_000_000n);
        expect(h.timestampIsWallClock).toBe(false);
        expect(h.videoFrameMarking?.independent).toBe(true);
        expect(h.audioLevel).toEqual({ voiceActivity: true, level: 5 });
        expect(h.audioConfig).toEqual(Uint8Array.from([0x12, 0x10]));
    });

    it('LOC-04 timestamp without timescale is microseconds and wall clock', () => {
        const h = resolveLocHeaders([e(0x10, 42n)]);
        expect(h.version).toBe(4);
        expect(h.captureTimestamp).toBe(42n);
        expect(h.timestampIsWallClock).toBe(true);
    });

    it('only Video Config → version undefined', () => {
        const h = resolveLocHeaders([e(0x0d, Uint8Array.from([1, 2]))]);
        expect(h.version).toBeUndefined();
        expect(h.videoConfig).toEqual(Uint8Array.from([1, 2]));
        expect(h.timestampIsWallClock).toBeUndefined();
    });

    it('empty map → empty headers', () => {
        expect(resolveLocHeaders([])).toEqual({});
    });

    it('mixed ids → version 4 wins and LOC-01 ids move to unknown', () => {
        const h = resolveLocHeaders([e(0x02, 7n), e(0x04, 0x20n), e(0x10, 99n), e(0x0d, Uint8Array.from([9]))]);
        expect(h.version).toBe(4);
        expect(h.captureTimestamp).toBe(99n);
        expect(h.videoFrameMarking).toBeUndefined();
        expect(h.videoConfig).toEqual(Uint8Array.from([9]));
        expect(h.unknown?.get(0x02n)).toBe(7n);
        expect(h.unknown?.get(0x04n)).toBe(0x20n);
    });

    it('mixed block with no 0x10 Timestamp keeps 0x02 opaque', () => {
        const h = resolveLocHeaders([e(0x02, 7n), e(0x09, Uint8Array.from([0x20]))]);
        expect(h.version).toBe(4);
        expect(h.captureTimestamp).toBeUndefined();
        expect(h.timestampIsWallClock).toBeUndefined();
        expect(h.unknown?.get(0x02n)).toBe(7n);
    });

    it('a Timescale does not make a mixed-block 0x02 value a timestamp', () => {
        const h = resolveLocHeaders([e(0x02, 7n), e(0x08, 90_000n), e(0x09, Uint8Array.from([0x20]))]);
        expect(h.captureTimestamp).toBeUndefined();
        expect(h.timescale).toBe(90_000n);
        expect(h.timestampIsWallClock).toBeUndefined();
    });

    it('truly unknown ids are preserved in either dialect', () => {
        const h1 = resolveLocHeaders([e(0x02, 1n), e(0x20, 5n)]);
        expect(h1.version).toBe(1);
        expect(h1.unknown?.get(0x20n)).toBe(5n);
        const h4 = resolveLocHeaders([e(0x10, 1n), e(0x21, Uint8Array.from([1]))]);
        expect(h4.unknown?.get(0x21n)).toEqual(Uint8Array.from([1]));
    });
});

describe('resolveLocHeaders — timescale derivation', () => {
    it('48 kHz audio', () => {
        const h = resolveLocHeaders([e(0x10, 96_000n), e(0x08, 48_000n)]);
        expect(h.captureTimestamp).toBe(2_000_000n);
    });

    it('truncates toward zero', () => {
        const h = resolveLocHeaders([e(0x10, 1n), e(0x08, 3n)]);
        expect(h.captureTimestamp).toBe(333_333n);
    });

    it('stays exact above 2^53', () => {
        const big = 9_007_199_254_740_993n;
        const h = resolveLocHeaders([e(0x10, big), e(0x08, 1_000_000n)]);
        expect(h.captureTimestamp).toBe(big);
    });

    it('timescale zero is malformed', () => {
        expect(() => resolveLocHeaders([e(0x10, 1n), e(0x08, 0n)])).toThrow(LocHeaderError);
    });

    it('duplicates resolve last-wins', () => {
        const h = resolveLocHeaders([e(0x10, 1n), e(0x10, 2n)]);
        expect(h.timestamp).toBe(2n);
    });
});

describe('resolveLocHeaders — track context', () => {
    it('fills omitted timescale, video config, and audio config', () => {
        const h = resolveLocHeaders([e(0x10, 90_000n)], {
            timescale: 90_000n, videoConfig: Uint8Array.from([1]), audioConfig: Uint8Array.from([2]),
        });
        expect(h.captureTimestamp).toBe(1_000_000n);
        expect(h.timescale).toBe(90_000n);
        expect(h.timestampIsWallClock).toBe(false);
        expect(h.videoConfig).toEqual(Uint8Array.from([1]));
        expect(h.audioConfig).toEqual(Uint8Array.from([2]));
    });

    it('never overrides object values', () => {
        const h = resolveLocHeaders([e(0x10, 10n), e(0x08, 10n), e(0x0d, Uint8Array.from([7]))], {
            timescale: 1n, videoConfig: Uint8Array.from([1]),
        });
        expect(h.timescale).toBe(10n);
        expect(h.captureTimestamp).toBe(1_000_000n);
        expect(h.videoConfig).toEqual(Uint8Array.from([7]));
    });

    it('does not set version on its own', () => {
        expect(resolveLocHeaders([], { timescale: 1n }).version).toBeUndefined();
    });
});

describe('LOC-05 Codec String (0x11)', () => {
    const utf8 = (text: string) => new TextEncoder().encode(text);

    it('0x11 makes the block version 5 and decodes as UTF-8', () => {
        const h = resolveLocHeaders([e(0x10, 42n), e(0x11, utf8('avc1.42001f'))]);
        expect(h.version).toBe(5);
        expect(h.codecString).toBe('avc1.42001f');
        expect(h.captureTimestamp).toBe(42n);
        expect(h.unknown).toBeUndefined();
    });

    it('0x11 alone is version 5, and LOC-01 ids beside it become unknown', () => {
        const h = resolveLocHeaders([e(0x02, 7n), e(0x11, utf8('opus'))]);
        expect(h.version).toBe(5);
        expect(h.codecString).toBe('opus');
        expect(h.captureTimestamp).toBeUndefined();
        expect(h.unknown?.get(0x02n)).toBe(7n);
    });

    it('a duplicate 0x11 resolves last-wins like other known ids', () => {
        expect(resolveLocHeaders([e(0x11, utf8('opus')), e(0x11, utf8('mp4a.40.2'))]).codecString).toBe('mp4a.40.2');
    });

    it('decodes non-ASCII UTF-8', () => {
        expect(resolveLocHeaders([e(0x11, utf8('caf\u00e9'))]).codecString).toBe('caf\u00e9');
    });

    it.each([
        ['an invalid lead byte', [0xff]],
        ['a truncated sequence', [0xe2, 0x82]],
        ['an overlong form', [0xc0, 0x80]],
        ['a surrogate', [0xed, 0xa0, 0x80]],
    ])('rejects %s as malformed', (_name, bytes) => {
        expect(() => resolveLocHeaders([e(0x11, Uint8Array.from(bytes))])).toThrow(LocHeaderError);
    });

    it('treats an empty value as absent', () => {
        const h = resolveLocHeaders([e(0x10, 1n), e(0x11, new Uint8Array())]);
        expect(h.version).toBe(5);
        expect(h.codecString).toBeUndefined();
    });

    it('track context fills an omitted codec string; the object wins', () => {
        expect(resolveLocHeaders([e(0x10, 1n)], { codecString: 'opus' }).codecString).toBe('opus');
        expect(resolveLocHeaders([e(0x11, utf8('avc1.42001f'))], { codecString: 'opus' }).codecString).toBe('avc1.42001f');
        expect(resolveLocHeaders([e(0x10, 1n)], { codecString: 'opus' }).version).toBe(4);
    });

    it('LOC-05 encodes 0x11 beside the LOC-04 properties', () => {
        const entries = locHeadersToPropertyMap({ captureTimestamp: 5n, codecString: 'avc1.42001f' }, 5);
        expect(entries).toEqual([
            { id: 0x10n, value: 5n },
            { id: 0x11n, value: utf8('avc1.42001f') },
        ]);
    });

    it('only LOC-05 can carry a codec string', () => {
        expect(() => locHeadersToPropertyMap({ codecString: 'opus' }, 4)).toThrow(/requires LOC-05/);
        expect(() => locHeadersToPropertyMap({ codecString: 'opus' }, 1)).toThrow(LocEncodeError);
    });

    it('rejects an empty or non-UTF-8 codec string on encode', () => {
        expect(() => locHeadersToPropertyMap({ codecString: '' }, 5)).toThrow(/empty/);
        expect(() => locHeadersToPropertyMap({ codecString: 'a\ud800' }, 5)).toThrow(/UTF-8/);
        expect(() => locHeadersToPropertyMap({ codecString: '\udc00a' }, 5)).toThrow(/UTF-8/);
    });

    it('LOC-05 without a codec string encodes exactly like LOC-04', () => {
        const headers = { captureTimestamp: 5n, audioConfig: Uint8Array.from([1]) };
        expect(locHeadersToPropertyMap(headers, 5)).toEqual(locHeadersToPropertyMap(headers, 4));
    });

    it('rejects an unknown LOC version', () => {
        expect(() => locHeadersToPropertyMap({}, 6 as never)).toThrow(/1, 4 or 5/);
    });
});
