import { describe, expect, it } from 'vitest';
import { parseMsfCatalog, parseCatalogAuto, parseMsf02Delta } from './index.js';
import { CatalogManager } from '../../player/src/catalog-manager.js';
const track = { name: 'v', packaging: 'loc', isLive: true };
const parse = (tracks: unknown[], version = 'draft-02', extra = {}) =>
    parseMsfCatalog(JSON.stringify({ version, tracks, ...extra }), ['live/show', 'one']);

describe('MSF-02 catalog constraints', () => {
    it.each(['', 'a//b', '/a', 'a/', Array(33).fill('a').join('/'), 5])('rejects declared namespace %j', namespace => {
        expect(() => parse([{ ...track, namespace }])).toThrow(/namespace/i);
        expect(() => parse([{ ...track, namespace }], 'draft-01')).not.toThrow();
    });
    it('rejects unmappable or empty names', () => {
        for (const name of ['', '\u0000', '\uDEAD']) {
        expect(() => parse([{ ...track, name }])).toThrow(/name|surrogate/i);
        }
    });
    it('rejects independent parent references', () => {
        for (const key of ['parentNamespace', 'parentName']) {
        expect(() => parse([{ ...track, [key]: 'parent' }])).toThrow(/parent/);
        }
    });
    it.each([
        { role: 'video', codec: 'avc1', bitrate: 1 },
        { role: 'audio', codec: 'opus', bitrate: 1, samplerate: 48000 },
        { role: 'audio', packaging: 'cmaf', codec: 'mp4a', bitrate: 1, samplerate: 48000 },
        { role: 'audiodescription', codec: 'opus', samplerate: 48000, channelConfig: '2' },
        { role: 'signlanguage', codec: 'avc1' },
    ])('requires fields for $packaging $role', fields => {
        expect(() => parse([{ ...track, ...fields }])).toThrow(/required/);
        expect(() => parse([{ ...track, ...fields }], 'draft-01')).not.toThrow();
    });
    it('keeps new metadata and ignores target latency on non-live tracks', () => {
        const input = { ...track, isLive: false, targetLatency: 2000, accessibleWindowTime: 300000,
            keyframeSpacing: 15, encryptionScheme: 'custom', authInfo: { scheme: 'custom' },
            packagingMetadata: 'broken;streamMapping=object;streamMapping=group;foo=1' };
        const parsed = parse([input]).tracks[0]!;
        expect(parsed).toMatchObject({ accessibleWindowTime: 300000, keyframeSpacing: 15,
            encryptionScheme: 'custom', authInfo: { scheme: 'custom' }, packagingMetadata: { streamMapping: 'object' } });
        expect(parsed).not.toHaveProperty('targetLatency');
        expect(parsed.resolvedNamespace).toEqual({ fields: ['live/show', 'one'], source: 'inherited' });
        expect(parse([track]).tracks[0]!.packagingMetadata).toEqual({ streamMapping: 'group' });
        expect(parse([{ ...track, packaging: 'custom', packagingMetadata: 'streamMapping=object' }]).tracks[0]!.packagingMetadata).toEqual({});
        const old = parse([{ ...input, isLive: true }], 'draft-01').tracks[0]!;
        expect(old).not.toHaveProperty('accessibleWindowTime');
        expect(old).not.toHaveProperty('packagingMetadata');
    });
    it.each([{ accessibleWindowTime: -1 }, { accessibleWindowTime: '1' }, { keyframeSpacing: 0 }, { keyframeSpacing: 1.5 }])('rejects invalid new fields %j', fields => {
        expect(() => parse([{ ...track, ...fields }])).toThrow(/accessibleWindowTime|keyframeSpacing/);
    });
    it('accepts draft packaging and event timelines without dependencies', () => {
        const catalog = parse([
            { ...track, packaging: 'catalog' },
            { ...track, name: 'e', packaging: 'eventtimeline', eventType: 'example.event' },
            { ...track, name: 'other', packaging: 'future' },
        ], 'draft-02', { publishTracks: [
            { ...track, name: 'log', packaging: 'moqlog' },
            { ...track, name: 'metric', packaging: 'moqmetrics' },
        ] });
        expect(catalog.tracks.map(t => t.packaging)).toEqual(['catalog', 'eventtimeline', 'future']);
        expect(catalog.publishTracks?.map(t => t.packaging)).toEqual(['moqlog', 'moqmetrics']);
    });
    it('checks publish track uniqueness within its own array', () => {
        expect(() => parse([track], 'draft-02', { publishTracks: [track, track] })).toThrow(/Duplicate/);
        expect(parse([track], 'draft-02', { publishTracks: [track] }).publishTracks).toHaveLength(1);
    });
    it('rejects BOM and invalid UTF-8 only for the declared draft', () => {
        for (const parser of [parseMsfCatalog, parseCatalogAuto, (b: Uint8Array) => new CatalogManager(undefined).processCatalogObject(b)]) {
            const encode = (version: string) => new TextEncoder().encode(JSON.stringify({ version, tracks: [track] }));
            expect(() => parser(new Uint8Array([239, 187, 191, ...encode('draft-02')]))).toThrow(/BOM/);
            expect(() => parser(new Uint8Array([239, 187, 191, ...encode('draft-01')]))).not.toThrow();
            const bad = encode('draft-02');
            bad[bad.indexOf(118, 24)] = 255;
            expect(() => parser(bad)).toThrow();
        }
    });
});

it('describes draft-02 packaging requirements for incomplete additions', () => {
    expect(() => parseMsf02Delta(JSON.stringify({ generatedAt: 2, deltaUpdate: [
        { op: 'add', tracks: [{ name: 'missing', isLive: true }] },
    ] }))).toThrow(/MSF-02.*packaging.*string/);
});
