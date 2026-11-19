import { describe, expect, it } from 'vitest';
import { parseMsfCatalog, parseMsf02Delta, applyMsf02Delta, parseMsf01Delta, applyMsf01Delta } from './index.js';
import { CatalogManager } from '../../player/src/catalog-manager.js';
const video = { name: 'v', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1', bitrate: 1, framerate: 30 };
const base = () => { const cat = parseMsfCatalog(JSON.stringify({ version: 'draft-02', tracks: [video] }), ['live/show', 'one']); return { ...cat, tracks: [...cat.tracks] }; };
const delta = (op: string, tracks: unknown[], extra = {}) => JSON.stringify({ generatedAt: 2, deltaUpdate: [{ op, tracks }], ...extra });
const apply = (json: string) => applyMsf02Delta(base(), parseMsf02Delta(json), ['live/show', 'one']);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('MSF-02 ordered catalog deltas', () => {
    it('updates the addressed track and applies subsequent add and clone operations in order', () => {
        const result = apply(JSON.stringify({ generatedAt: 2, custom: true, deltaUpdate: [
            { op: 'update', tracks: [{ parentName: 'v', bitrate: 4000000, keyframeSpacing: 15 }] },
            { op: 'add', tracks: [{ name: 'e', packaging: 'eventtimeline', eventType: 'custom', isLive: true }] },
            { op: 'clone', tracks: [{ parentName: 'v', name: 'v2', bitrate: 2000000 }] },
        ] }));
        expect(result).toMatchObject({ msfDraft: 'draft-02', generatedAt: 2 });
        expect(result.tracks.map(t => t.name)).toEqual(['v', 'e', 'v2']);
        expect(result.tracks[2]).toMatchObject({ bitrate: 2000000, framerate: 30, keyframeSpacing: 15,
            resolvedNamespace: { fields: ['live/show', 'one'], source: 'inherited' } });
        expect(result.tracks[0]).not.toHaveProperty('parentName');
        expect(base().tracks[0]!.bitrate).toBe(1);
    });
    it.each(['version', 'tracks', 'isComplete', 'publishTracks', 'initDataList'])('rejects root field %s', field => {
        expect(() => parseMsf02Delta(delta('remove', [{ name: 'v' }], { [field]: [] }))).toThrow(/root|field/);
    });
    it('requires generatedAt and an operation array', () => {
        for (const json of [{ deltaUpdate: [{ op: 'remove', tracks: [{ name: 'v' }] }] },
            { generatedAt: 2, deltaUpdate: true }, { generatedAt: 2, deltaUpdate: [] },
            { generatedAt: 2, deltaUpdate: [{ op: 'future', tracks: [] }] }]) {
            expect(() => parseMsf02Delta(JSON.stringify(json))).toThrow(/generatedAt|deltaUpdate|operation/);
        }
        expect(() => parseMsf01Delta(delta('update', [{ parentName: 'v', bitrate: 2 }]))).toThrow(/unknown/);
    });
    it.each(['', 'a//b', Array(33).fill('a').join('/'), 5, '\uDEAD', '\0'])('checks namespace in every operation: %j', namespace => {
        for (const [op, fields] of [['add', { ...video, name: 'new', namespace }],
            ['remove', { name: 'v', namespace }], ['clone', { name: 'new', parentName: 'v', parentNamespace: namespace }],
            ['update', { parentName: 'v', parentNamespace: namespace }]] as const) {
            expect(() => parseMsf02Delta(delta(op, [fields]))).toThrow(/namespace|surrogate|NUL/i);
        }
    });
    it('requires complete additions and exact remove fields', () => {
        expect(() => apply(delta('add', [{ name: 'new' }]))).toThrow(/packaging|isLive/);
        expect(() => parseMsf02Delta(delta('remove', [{ name: 'v', bitrate: 3 }]))).toThrow(/remove/);
        expect(() => apply(delta('add', [video]))).toThrow(/exists/);
        const legacy = applyMsf01Delta({ version: 1, tracks: [] }, parseMsf01Delta(delta('add', [{ name: 'new' }])));
        expect(legacy.tracks[0]).toMatchObject({ packaging: 'loc', isLive: true });
    });
    it('rejects unknown parents, renames, and returning to live', () => {
        for (const fields of [{ parentName: 'missing' }, { parentName: '' }, { parentName: '\uDEAD' },
            { parentName: 'v', name: 'other' }, { parentName: 'v', namespace: 'other' }]) {
            expect(() => apply(delta('update', [fields]))).toThrow();
        }
        const stopped = apply(delta('update', [{ parentName: 'v', isLive: false, targetLatency: 99 }]));
        expect(stopped.tracks[0]).not.toHaveProperty('targetLatency');
        expect(() => applyMsf02Delta(stopped, parseMsf02Delta(delta('update', [{ parentName: 'v', isLive: true }])), ['live/show', 'one'])).toThrow(/isLive/);
        expect(apply(delta('update', [{ parentName: 'v', name: 'v' }])).tracks).toHaveLength(1);
    });
    it('validates dependencies after all operations and leaves the base unchanged on failure', () => {
        const manager = new CatalogManager(['live/show', 'one']);
        const previous = manager.processCatalogObject(encode({ version: 'draft-02', tracks: [video,
            { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['v'] }] }));
        expect(() => manager.processCatalogObject(new TextEncoder().encode(delta('remove', [{ name: 'v' }])))).toThrow(/depend/);
        expect(manager.currentState).toBe(previous);
        expect(() => manager.processCatalogObject(encode({ deltaUpdate: true, removeTracks: [{ name: 'v' }] }))).toThrow();
        const next = manager.processCatalogObject(encode({ generatedAt: 2, deltaUpdate: [
            { op: 'remove', tracks: [{ name: 'v' }] }, { op: 'add', tracks: [{ ...video, name: 'v2' }] },
            { op: 'update', tracks: [{ parentName: 'timeline', depends: ['v2'] }] },
        ] }));
        expect(next.tracks.map(t => t.name)).toEqual(['timeline', 'v2']);
        expect(next.msfDraft).toBe('draft-02');
    });
    it('rejects invalid bytes in deltas against a draft-02 base', () => {
        const manager = new CatalogManager(undefined);
        manager.processCatalogObject(encode({ version: 'draft-02', tracks: [video] }));
        const bytes = new TextEncoder().encode(delta('remove', [{ name: 'v' }]));
        expect(() => manager.processCatalogObject(new Uint8Array([239, 187, 191, ...bytes]))).toThrow(/BOM/);
    });
});

it('preserves object stream mapping on added tracks', () => {
    const result = apply(delta('add', [{ ...video, name: 'object-video', packagingMetadata: 'streamMapping=object' }]));
    expect(result.tracks[1]!.packagingMetadata).toEqual({ streamMapping: 'object' });
});

it.each(['[]', '{"version":"draft-02"}', '{"tracks":[]}',
    '{"generatedAt":1e999,"deltaUpdate":[{"op":"remove","tracks":[{"name":"v"}]}]}'])('identifies the draft in delta errors: %s', json => {
    expect(() => parseMsf02Delta(json)).toThrow(/MSF-02/);
});

it('lists update among the draft-02 operation alternatives', () => {
    expect(() => parseMsf02Delta(delta('unknown', []))).toThrow(/expected one of add, remove, clone, update/);
    expect(() => parseMsf01Delta(delta('unknown', []))).toThrow(/expected one of add, remove, clone \(§5.3\)/);
});
