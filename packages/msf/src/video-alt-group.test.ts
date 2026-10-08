import { describe, expect, it } from 'vitest';
import type { CatalogTrack } from './types.js';
import { selectVideoAltGroup } from './selection.js';

const tracks: CatalogTrack[] = [
    { name: 'landscape-high', role: 'video', packaging: 'loc', isLive: true, altGroup: 7, bitrate: 2000 },
    { name: 'portrait-high', role: 'video', packaging: 'loc', isLive: true, altGroup: 0, bitrate: 3000 },
    { name: 'landscape-low', role: 'video', packaging: 'loc', isLive: true, altGroup: 7, bitrate: 1000 },
    { name: 'portrait-low', role: 'video', packaging: 'loc', isLive: true, altGroup: 0, bitrate: 500 },
];

describe('video alternate-group selection', () => {
    it('preserves the first encountered group as the default, not the lowest group ID', () => {
        expect(selectVideoAltGroup(tracks).map(t => t.name)).toEqual(['landscape-high', 'landscape-low']);
    });

    it('selects group zero without treating it as an omitted option', () => {
        expect(selectVideoAltGroup(tracks, 0).map(t => t.name)).toEqual(['portrait-high', 'portrait-low']);
    });

    it('rejects a missing group instead of silently choosing different content', () => {
        expect(() => selectVideoAltGroup(tracks, 8)).toThrow('Unknown video altGroup: 8');
    });

    it('preserves the ungrouped legacy ladder without inventing an alternate-group ID', () => {
        const ungrouped = tracks.map(({ altGroup: _group, ...track }) => track);
        expect(selectVideoAltGroup(ungrouped)).toEqual(ungrouped);
        expect(() => selectVideoAltGroup(ungrouped, 0)).toThrow('Unknown video altGroup');
    });

    it('does not mix ungrouped tracks into a declared group', () => {
        expect(selectVideoAltGroup([...tracks, { name: 'other', role: 'video', packaging: 'loc', isLive: true }])).toEqual([tracks[0], tracks[2]]);
    });
});
