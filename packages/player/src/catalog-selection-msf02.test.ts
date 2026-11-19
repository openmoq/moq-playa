import { expect, it } from 'vitest';
import { isTrackPackagingSupported, parseMsfCatalog } from '@openmoq/msf';
import { buildCatalogSelection } from './catalog-selection.js';

it('reports draft-02 catalog, encryption, variable, and packaging exclusions', () => {
    const media = { packaging: 'loc', isLive: true, role: 'video', codec: 'avc1', bitrate: 1, framerate: 30 };
    const catalog = parseMsfCatalog(JSON.stringify({ version: 'draft-02', tracks: [
        { ...media, name: 'catalog', packaging: 'catalog' },
        { ...media, name: 'encrypted', encryptionScheme: 'custom' },
        { ...media, name: 'variable-%id%' },
        { ...media, name: 'other', namespace: 'live/%id%' },
        { ...media, name: 'future', packaging: 'custom' },
        { ...media, name: 'data', role: 'data' },
        { ...media, name: 'playable' },
    ] }), ['live', 'one']);
    const selection = buildCatalogSelection({ ...catalog, tracks: [...catalog.tracks] }, { catalogNamespace: ['live', 'one'] });
    expect(selection.excluded.map(t => t.reason)).toEqual([
        'catalog-reference', 'encrypted', 'unresolved-variable', 'unresolved-variable', 'unsupported-packaging', 'no-media-role',
    ]);
    expect(isTrackPackagingSupported(catalog.tracks[4]!, { msfDraft: 'draft-02' })).toBe(false);
    expect(isTrackPackagingSupported(catalog.tracks[4]!)).toBe(true);
    const legacy = parseMsfCatalog(JSON.stringify({ version: 'draft-01', tracks: [{ ...media, name: 'encrypted', encryptionScheme: 'custom' }] }), 'live');
    expect(buildCatalogSelection({ ...legacy, tracks: [...legacy.tracks] }, { catalogNamespace: 'live' }).excluded).toEqual([]);
});
