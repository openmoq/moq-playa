/**
 * MSF-02 (draft-ietf-moq-msf-02) catalog acceptance, driven by real catalogs emitted by
 * the moqxr publisher (`--msf-version 02`, the default) for CMAF and for every LOC codec.
 *
 * @see draft-ietf-moq-msf-02 §5.1.1, §5.1.7, §5.2.15, §7.2
 * @module
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseMsfCatalog } from './catalog-msf00.js';
import { parseCatalogAuto } from './catalog-detect.js';

const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'moqxr-msf02');
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.catalog.json')).sort();
const load = (name: string): string => readFileSync(join(dir, `${name}.catalog.json`), 'utf8');

describe('MSF-02 catalogs from moqxr', () => {
    it('has a fixture per packaging and codec', () => {
        expect(fixtures).toEqual([
            'cmaf-av.catalog.json', 'loc-av1.catalog.json', 'loc-avc-aac.catalog.json',
            'loc-hevc.catalog.json', 'loc-opus.catalog.json', 'loc-vp9.catalog.json',
        ]);
    });

    for (const file of fixtures) {
        it(`parses ${file}`, () => {
            const catalog = parseCatalogAuto(readFileSync(join(dir, file), 'utf8'));
            expect(catalog.tracks.length).toBeGreaterThan(0);
            for (const track of catalog.tracks) {
                expect(typeof track.name).toBe('string');
            }
        });
    }

    it('accepts the draft-02 version string and still rejects other revisions', () => {
        const base = JSON.parse(load('loc-hevc'));
        expect(() => parseMsfCatalog(JSON.stringify(base))).not.toThrow();
        expect(() => parseMsfCatalog(JSON.stringify({ ...base, version: 'draft-03' }))).toThrow(/Unsupported catalog version/);
        expect(() => parseMsfCatalog(JSON.stringify({ ...base, version: 'draft-00' }))).toThrow(/Unsupported catalog version/);
    });

    it('keeps object-property init entries as declared and resolves the initRef to them', () => {
        const catalog = parseMsfCatalog(load('loc-avc-aac'));
        const video = catalog.tracks.find((t) => t.name === 'vide_1')!;
        const audio = catalog.tracks.find((t) => t.name === 'soun_2')!;
        const entry = (id: string | undefined) => catalog.initDataList?.find((e) => e.id === id);
        expect(entry(video.initRef)).toMatchObject({ type: 'object-property', data: '0x0D' });
        expect(entry(audio.initRef)).toMatchObject({ type: 'object-property', data: '0x0F' });
    });

    it('VP9 declares no initRef (its codec has no description)', () => {
        const catalog = parseMsfCatalog(load('loc-vp9'));
        expect(catalog.tracks[0]!.initRef).toBeUndefined();
        expect(catalog.initDataList).toBeUndefined();
    });
});

describe('depends renderGroup entries (§5.2.15, §7.2)', () => {
    it('expands a renderGroup entry into the names of the tracks in that group', () => {
        const catalog = parseMsfCatalog(load('loc-avc-aac'));
        const timeline = catalog.tracks.find((t) => t.name === 'timeline')!;
        expect(timeline.dependsRenderGroups).toEqual([1]);
        expect([...(timeline.depends ?? [])].sort()).toEqual(['soun_2', 'vide_1']);
        // The event timelines keep naming their single track.
        expect(catalog.tracks.find((t) => t.name === 'vide_1_sap')!.depends).toEqual(['vide_1']);
    });

    it('combines declared names with expanded groups without duplicates', () => {
        const base = JSON.parse(load('loc-avc-aac'));
        const timeline = base.tracks.find((t: { name: string }) => t.name === 'timeline');
        timeline.depends = ['vide_1', 1];
        const parsed = parseMsfCatalog(JSON.stringify(base)).tracks.find((t) => t.name === 'timeline')!;
        expect([...(parsed.depends ?? [])].sort()).toEqual(['soun_2', 'vide_1']);
        expect(parsed.dependsRenderGroups).toEqual([1]);
    });

    it('rejects a renderGroup that no other track carries', () => {
        const base = JSON.parse(load('loc-avc-aac'));
        base.tracks.find((t: { name: string }) => t.name === 'timeline').depends = [9];
        expect(() => parseMsfCatalog(JSON.stringify(base))).toThrow(/renderGroup 9/);
    });

    it('rejects non-string, non-integer depends entries', () => {
        const base = JSON.parse(load('loc-avc-aac'));
        base.tracks.find((t: { name: string }) => t.name === 'timeline').depends = [true];
        expect(() => parseMsfCatalog(JSON.stringify(base))).toThrow(/depends/);
    });
});
