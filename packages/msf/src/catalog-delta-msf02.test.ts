/**
 * MSF-02 §5.1.6 adds the "update" delta operation: a track object names its target by
 * parentName (and optionally parentNamespace) and holds only the overriding attributes.
 *
 * @see draft-ietf-moq-msf-02 §5.1.6, §5.3
 * @module
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseMsfCatalog } from './catalog-msf00.js';
import { parseMsf01Delta, applyMsf01Delta } from './catalog-delta-msf01.js';

const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'moqxr-msf02');
const base = () => parseMsfCatalog(readFileSync(join(dir, 'loc-avc-aac.catalog.json'), 'utf8'));
const delta = (o: unknown) => parseMsf01Delta(JSON.stringify(o));

describe('update delta operation', () => {
    it('parses an update entry that carries no name', () => {
        const d = delta({ generatedAt: 5, deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'vide_1', bitrate: 3000000 }] }] });
        expect(d.deltaUpdate[0]!.op).toBe('update');
        expect(d.deltaUpdate[0]!.tracks[0]).toMatchObject({ parentName: 'vide_1', bitrate: 3000000 });
        expect(d.deltaUpdate[0]!.tracks[0]!.name).toBeUndefined();
    });

    it('overrides only the declared attributes of the target track', () => {
        const before = base();
        const d = delta({ generatedAt: 9, deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'vide_1', bitrate: 3000000, label: 'main' }] }] });
        const after = applyMsf01Delta(before, d);
        const video = after.tracks.find((t) => t.name === 'vide_1')!;
        const old = before.tracks.find((t) => t.name === 'vide_1')!;
        expect(video.bitrate).toBe(3000000);
        expect(video.label).toBe('main');
        expect(video.codec).toBe(old.codec);
        expect(video.initRef).toBe(old.initRef);
        expect(after.tracks).toHaveLength(before.tracks.length);
        expect(after.generatedAt).toBe(9);
    });

    it('addresses the target with parentNamespace when it is given', () => {
        const d = delta({ deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'vide_1', parentNamespace: 'nowhere', bitrate: 1 }] }] });
        expect(() => applyMsf01Delta(base(), d)).toThrow(/not found/);
    });

    it('rejects an update of an unknown track', () => {
        const d = delta({ deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'ghost', bitrate: 1 }] }] });
        expect(() => applyMsf01Delta(base(), d)).toThrow(/ghost/);
    });

    it('rejects an update entry without parentName', () => {
        const d = delta({ deltaUpdate: [{ op: 'update', tracks: [{ bitrate: 1 }] }] });
        expect(() => applyMsf01Delta(base(), d)).toThrow(/parentName/);
    });

    it('does not let an update rename or re-key the track', () => {
        const d = delta({ deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'vide_1', name: 'other', bitrate: 1 }] }] });
        expect(() => applyMsf01Delta(base(), d)).toThrow(/name/);
    });

    it('still rejects genuinely unknown operations', () => {
        expect(() => delta({ deltaUpdate: [{ op: 'frobnicate', tracks: [] }] })).toThrow(/unknown delta operation/);
    });
});
