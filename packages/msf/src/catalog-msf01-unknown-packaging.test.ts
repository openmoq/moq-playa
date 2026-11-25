import { describe, expect, it } from 'vitest';
import { applyMsf01Delta, isTrackPackagingSupported, parseMsf01Delta, parseMsfCatalog } from './index.js';

const video = { name: 'v', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.640028' };
const parse = (tracks: unknown[], version: unknown = 'draft-01') => parseMsfCatalog(JSON.stringify({ version, tracks }), 'live');

describe.each(['draft-01', '1', 1])('MSF version %j: a packaging this build does not support', version => {
    it('is carried and never subscribed, while the rest of the catalog stays playable', () => {
        const catalog = parse([video, { name: 'r', packaging: 'x-custom', isLive: true }], version);
        expect(catalog.tracks.map(t => [t.name, t.packaging])).toEqual([['v', 'loc'], ['r', 'x-custom']]);
        expect(catalog.tracks.map(t => isTrackPackagingSupported(t))).toEqual([true, false]);
    });

    it('still may not carry eventType or locmafVersion', () => {
        expect(() => parse([{ name: 'r', packaging: 'x-custom', isLive: true, eventType: 'e' }], version)).toThrow(/eventType MUST NOT/);
        expect(() => parse([{ name: 'r', packaging: 'x-custom', isLive: true, locmafVersion: '9' }], version)).toThrow(/locmafVersion MUST NOT/);
    });

    it('is still held to the rules every track obeys', () => {
        const custom = { name: 'r', packaging: 'x-custom', isLive: true };
        expect(() => parse([{ ...custom, name: undefined }], version)).toThrow(/name is required/);
        expect(() => parse([{ ...custom, isLive: 'yes' }], version)).toThrow(/isLive is required/);
        expect(() => parse([custom, custom], version)).toThrow(/Duplicate track name "r"/);
    });

    it('differs from a missing or non-string packaging, which still rejects the catalog', () => {
        expect(() => parse([{ name: 'r', isLive: true }], version)).toThrow(/"r" at index 0: packaging is required but missing/);
        expect(() => parse([{ name: 'r', packaging: 7, isLive: true }], version)).toThrow(/packaging is required and must be a string/);
        expect(() => parse([{ name: 'r', packaging: 'x-custom', isLive: true }], version)).not.toThrow();
    });
});

it('carries an MSF-01 delta addition with an unsupported packaging, held to the locmafVersion rule', () => {
    const base = parse([video]);
    const apply = (track: object) => applyMsf01Delta({ ...base, tracks: [...base.tracks] },
        parseMsf01Delta(JSON.stringify({ deltaUpdate: [{ op: 'add', tracks: [track] }] })), 'live');
    const custom = { name: 'r', packaging: 'x-custom', isLive: true };
    expect(apply(custom).tracks.map(t => [t.name, isTrackPackagingSupported(t)])).toEqual([['v', true], ['r', false]]);
    expect(() => apply({ ...custom, locmafVersion: '9' })).toThrow(/locmafVersion MUST NOT/);
});

it('rejects eventType or locmafVersion on an unsupported MSF-02 packaging, as before', () => {
    const custom = { name: 'r', packaging: 'x-custom', isLive: true };
    expect(() => parse([{ ...custom, eventType: 'e' }], 'draft-02')).toThrow(/eventType MUST NOT/);
    expect(() => parse([{ ...custom, locmafVersion: '9' }], 'draft-02')).toThrow(/locmafVersion MUST NOT/);
    expect(isTrackPackagingSupported(parse([custom], 'draft-02').tracks[0]!)).toBe(false);
});
