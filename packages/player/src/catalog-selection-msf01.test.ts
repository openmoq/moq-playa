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

    // Emitted by the FEC over MOQ publisher (catalog_json in fec-with-moq
    // src/fecmoq/media.py): the source as LOC video carrying an `x-fec` field,
    // and its repair rungs under an unregistered packaging.
    const fecCatalog = '{"version": "draft-01", "generatedAt": 1795440136390, "tracks": [{"name": "src", "packaging": "loc", "isLive": true, "role": "video", "renderGroup": 1, "codec": "av01.0.08M.08", "framerate": 60.0, "width": 1280, "height": 720, "x-fec": {"scheme": "rs-cauchy-gf256", "codec": 2, "symbolSize": 1100, "blockObjects": 12, "blockSeconds": 0.2, "rungs": ["rep1", "rep2", "rep3"], "rungFractions": [0.15, 0.15, 0.15], "objectFormat": "props_len:u16|properties|payload", "blocksPerGroup": 1, "objectStride": 256}}, {"name": "rep1", "packaging": "x-fec-repair", "isLive": true, "x-fec": {"source": "src", "rung": 1}}, {"name": "rep2", "packaging": "x-fec-repair", "isLive": true, "x-fec": {"source": "src", "rung": 2}}, {"name": "rep3", "packaging": "x-fec-repair", "isLive": true, "x-fec": {"source": "src", "rung": 3}}]}';

    it('let the FEC publisher catalog play its source track only', () => {
        const selection = select(fecCatalog);
        expect(selection.excluded.map(t => [t.id.name, t.reason])).toEqual([
            ['rep1', 'unsupported-packaging'], ['rep2', 'unsupported-packaging'], ['rep3', 'unsupported-packaging'],
        ]);
        const outcome = resolveSelection(selection);
        expect(outcome.ok && [outcome.video?.track.id.name, outcome.audio]).toEqual(['src', null]);
    });
});
