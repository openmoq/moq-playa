import { describe, expect, it } from 'vitest';
import { parseMsfCatalog } from '@openmoq/msf';
import { buildCatalogSelection, resolveSelection } from './catalog-selection.js';

const select = (json: string) => {
    const catalog = parseMsfCatalog(json, 'live');
    return buildCatalogSelection({ ...catalog, tracks: [...catalog.tracks] }, { catalogNamespace: 'live' });
};
const video = { packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.640028' };

describe('draft-01 tracks whose packaging this build does not support', () => {
    it('are reported as unsupported packaging, with or without a media role', () => {
        const selection = select(JSON.stringify({ version: 'draft-01', tracks: [
            { ...video, name: 'future-video', packaging: 'custom' },
            { name: 'future-data', packaging: 'custom', isLive: true },
            { ...video, name: 'playable' },
        ] }));
        expect(selection.excluded.map(t => [t.id.name, t.reason, t.mediaType])).toEqual([
            ['future-video', 'unsupported-packaging', 'video'], ['future-data', 'unsupported-packaging', undefined],
        ]);
        expect(selection.scopes.flatMap(s => s.video.flatMap(set => set.tracks.map(t => t.id.name)))).toEqual(['playable']);
    });

    it('leave a clear error when nothing else is playable', () => {
        const outcome = resolveSelection(select(JSON.stringify({ version: 'draft-01', tracks: [
            { ...video, name: 'future-video', packaging: 'custom' },
        ] })));
        expect(outcome).toMatchObject({ ok: false, reason: 'catalog offers no playable media' });
    });

    it('differ from a missing packaging, which still rejects the catalog', () => {
        expect(() => select(JSON.stringify({ version: 'draft-01', tracks: [{ ...video, name: 'v', packaging: undefined }] })))
            .toThrow(/packaging is required but missing/);
    });

    it('let a catalog with vendor extension tracks play its media track only', () => {
        const selection = select(JSON.stringify({ version: 'draft-01', tracks: [
            { ...video, name: 'main', 'x-vendor': { sidecars: ['side1', 'side2'] } },
            { name: 'side1', packaging: 'x-vendor-sidecar', isLive: true },
            { name: 'side2', packaging: 'x-vendor-sidecar', isLive: true },
        ] }));
        expect(selection.excluded.map(t => [t.id.name, t.reason])).toEqual([
            ['side1', 'unsupported-packaging'], ['side2', 'unsupported-packaging'],
        ]);
        const outcome = resolveSelection(selection);
        expect(outcome.ok && [outcome.video?.track.id.name, outcome.audio]).toEqual(['main', null]);
    });
});
