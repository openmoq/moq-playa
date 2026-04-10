/**
 * Tests for track selection: groupByRender, groupByAlt, selectTrack, resolveDependencies.
 *
 * Test vectors drawn from draft-ietf-moq-msf-00 §5.3.1, §5.3.2, §5.3.3.
 * Selection semantics from §5.1.18 (renderGroup), §5.1.19 (altGroup), §5.1.21 (depends).
 *
 * @see draft-ietf-moq-msf-00 §5.1.18, §5.1.19, §5.1.21
 */

import { describe, it, expect } from 'vitest';
import { groupByRender, groupByAlt, selectTrack, resolveDependencies } from './selection.js';
import type { CatalogTrack, CatalogState } from './types.js';

// ─── Test data from spec examples ────────────────────────────────────

/** §5.3.1: Simple audio/video — both renderGroup=1 */
const SIMPLE_AV: CatalogState = {
    version: 1,
    tracks: [
        {
            name: 'video',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            bitrate: 5000000,
            framerate: 30,
            renderGroup: 1,
        },
        {
            name: 'audio',
            packaging: 'loc',
            isLive: true,
            role: 'audio',
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
            renderGroup: 1,
        },
    ],
};

/** §5.3.2: Simulcast — 3 alternate video qualities + audio, all renderGroup=1 */
const SIMULCAST: CatalogState = {
    version: 1,
    tracks: [
        {
            name: 'hd',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01',
            width: 1920,
            height: 1080,
            bitrate: 5000000,
            framerate: 30,
            renderGroup: 1,
            altGroup: 1,
        },
        {
            name: 'md',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01',
            width: 720,
            height: 640,
            bitrate: 3000000,
            framerate: 30,
            renderGroup: 1,
            altGroup: 1,
        },
        {
            name: 'sd',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01',
            width: 192,
            height: 144,
            bitrate: 500000,
            framerate: 30,
            renderGroup: 1,
            altGroup: 1,
        },
        {
            name: 'audio',
            packaging: 'loc',
            isLive: true,
            role: 'audio',
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
            renderGroup: 1,
        },
    ],
};

/** §5.3.3: SVC — 4 video layers with dependency chain + audio */
const SVC: CatalogState = {
    version: 1,
    tracks: [
        {
            name: '480p15',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.01M.10.0.110.09',
            width: 640,
            height: 480,
            bitrate: 3000000,
            framerate: 15,
            renderGroup: 1,
        },
        {
            name: '480p30',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.04M.10.0.110.09',
            width: 640,
            height: 480,
            bitrate: 3000000,
            framerate: 30,
            renderGroup: 1,
            depends: ['480p15'],
        },
        {
            name: '1080p15',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.05M.10.0.110.09',
            width: 1920,
            height: 1080,
            bitrate: 3000000,
            framerate: 15,
            renderGroup: 1,
            depends: ['480p15'],
        },
        {
            name: '1080p30',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            bitrate: 5000000,
            framerate: 30,
            renderGroup: 1,
            depends: ['480p30', '1080p15'],
        },
        {
            name: 'audio',
            packaging: 'loc',
            isLive: true,
            role: 'audio',
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
            renderGroup: 1,
        },
    ],
};

// ─── groupByRender tests ─────────────────────────────────────────────

describe('groupByRender', () => {
    it('groups §5.3.1 audio+video into one render group', () => {
        const { groups, ungrouped } = groupByRender(SIMPLE_AV);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.renderGroup).toBe(1);
        expect(groups[0]!.tracks).toHaveLength(2);
        expect(ungrouped).toHaveLength(0);
    });

    it('groups §5.3.2 simulcast into one render group', () => {
        const { groups, ungrouped } = groupByRender(SIMULCAST);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.renderGroup).toBe(1);
        expect(groups[0]!.tracks).toHaveLength(4);
        expect(ungrouped).toHaveLength(0);
    });

    it('puts tracks without renderGroup into ungrouped', () => {
        const state: CatalogState = {
            version: 1,
            tracks: [
                { name: 'data', packaging: 'loc', isLive: true },
                { name: 'metadata', packaging: 'loc', isLive: true },
            ],
        };
        const { groups, ungrouped } = groupByRender(state);
        expect(groups).toHaveLength(0);
        expect(ungrouped).toHaveLength(2);
    });

    it('handles mixed grouped and ungrouped tracks', () => {
        const state: CatalogState = {
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, renderGroup: 1 },
                { name: 'audio', packaging: 'loc', isLive: true, renderGroup: 1 },
                { name: 'data', packaging: 'loc', isLive: true },
            ],
        };
        const { groups, ungrouped } = groupByRender(state);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.tracks).toHaveLength(2);
        expect(ungrouped).toHaveLength(1);
        expect(ungrouped[0]!.name).toBe('data');
    });
});

// ─── groupByAlt tests ────────────────────────────────────────────────

describe('groupByAlt', () => {
    it('groups §5.3.2 simulcast video into one alt group, audio ungrouped', () => {
        const { groups, ungrouped } = groupByAlt(SIMULCAST.tracks);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.altGroup).toBe(1);
        expect(groups[0]!.tracks).toHaveLength(3);
        expect(groups[0]!.tracks.map(t => t.name).sort()).toEqual(['hd', 'md', 'sd']);
        expect(ungrouped).toHaveLength(1);
        expect(ungrouped[0]!.name).toBe('audio');
    });

    it('returns all tracks as ungrouped when none have altGroup', () => {
        const { groups, ungrouped } = groupByAlt(SIMPLE_AV.tracks);
        expect(groups).toHaveLength(0);
        expect(ungrouped).toHaveLength(2);
    });
});

// ─── selectTrack tests ───────────────────────────────────────────────

describe('selectTrack', () => {
    const candidates = SIMULCAST.tracks.filter(t => t.altGroup === 1);

    it('selects highest bitrate within maxBitrate constraint', () => {
        const track = selectTrack(candidates, { maxBitrate: 3000000 });
        expect(track).toBeDefined();
        expect(track!.name).toBe('md');
        expect(track!.bitrate).toBe(3000000);
    });

    it('selects highest bitrate when all fit', () => {
        const track = selectTrack(candidates, { maxBitrate: 10000000 });
        expect(track).toBeDefined();
        expect(track!.name).toBe('hd');
    });

    it('selects lowest bitrate when constrained very low', () => {
        const track = selectTrack(candidates, { maxBitrate: 600000 });
        expect(track).toBeDefined();
        expect(track!.name).toBe('sd');
    });

    it('filters by maxWidth and maxHeight', () => {
        const track = selectTrack(candidates, { maxWidth: 800, maxHeight: 700 });
        expect(track).toBeDefined();
        expect(track!.name).toBe('md');
    });

    it('filters by codec', () => {
        const mixed: CatalogTrack[] = [
            { name: 'h264', packaging: 'loc', isLive: true, codec: 'avc1', bitrate: 5000000 },
            { name: 'av1', packaging: 'loc', isLive: true, codec: 'av01', bitrate: 3000000 },
        ];
        const track = selectTrack(mixed, { codec: 'av01' });
        expect(track).toBeDefined();
        expect(track!.name).toBe('av1');
    });

    it('filters by lang', () => {
        const audioTracks: CatalogTrack[] = [
            { name: 'en', packaging: 'loc', isLive: true, lang: 'en', bitrate: 32000 },
            { name: 'de', packaging: 'loc', isLive: true, lang: 'de', bitrate: 32000 },
            { name: 'fr', packaging: 'loc', isLive: true, lang: 'fr', bitrate: 32000 },
        ];
        const track = selectTrack(audioTracks, { lang: 'de' });
        expect(track).toBeDefined();
        expect(track!.name).toBe('de');
    });

    it('returns undefined when no candidates match', () => {
        const track = selectTrack(candidates, { maxBitrate: 100 });
        expect(track).toBeUndefined();
    });

    it('returns undefined for empty candidates', () => {
        const track = selectTrack([], { maxBitrate: 5000000 });
        expect(track).toBeUndefined();
    });
});

// ─── resolveDependencies tests ───────────────────────────────────────

describe('resolveDependencies', () => {
    it('resolves §5.3.3 SVC dependency chain for 1080p30', () => {
        const track = SVC.tracks.find(t => t.name === '1080p30')!;
        const chain = resolveDependencies(track, SVC.tracks);
        const names = chain.map(t => t.name);
        // Must include all dependencies in order: base first, target last
        expect(names).toContain('480p15');
        expect(names).toContain('480p30');
        expect(names).toContain('1080p15');
        expect(names).toContain('1080p30');
        expect(names).toHaveLength(4);
        // Base layer must come before layers that depend on it
        expect(names.indexOf('480p15')).toBeLessThan(names.indexOf('480p30'));
        expect(names.indexOf('480p15')).toBeLessThan(names.indexOf('1080p15'));
        expect(names.indexOf('480p30')).toBeLessThan(names.indexOf('1080p30'));
        expect(names.indexOf('1080p15')).toBeLessThan(names.indexOf('1080p30'));
    });

    it('returns just the track itself when no depends', () => {
        const track = SVC.tracks.find(t => t.name === '480p15')!;
        const chain = resolveDependencies(track, SVC.tracks);
        expect(chain).toHaveLength(1);
        expect(chain[0]!.name).toBe('480p15');
    });

    it('throws on circular dependency', () => {
        const tracks: CatalogTrack[] = [
            { name: 'a', packaging: 'loc', isLive: true, depends: ['b'] },
            { name: 'b', packaging: 'loc', isLive: true, depends: ['a'] },
        ];
        expect(() => resolveDependencies(tracks[0]!, tracks)).toThrow(/circular/i);
    });

    it('throws when a dependency is missing', () => {
        const tracks: CatalogTrack[] = [
            { name: 'a', packaging: 'loc', isLive: true, depends: ['nonexistent'] },
        ];
        expect(() => resolveDependencies(tracks[0]!, tracks)).toThrow(/not found/i);
    });

    it('throws on self-referencing dependency', () => {
        const tracks: CatalogTrack[] = [
            { name: 'a', packaging: 'loc', isLive: true, depends: ['a'] },
        ];
        expect(() => resolveDependencies(tracks[0]!, tracks)).toThrow(/circular/i);
    });

    it('resolves dependencies within same namespace only (§5.1.21)', () => {
        // Two tracks named "base" in different namespaces
        const tracks: CatalogTrack[] = [
            { name: 'base', namespace: 'ns1', packaging: 'loc', isLive: true, bitrate: 100 },
            { name: 'base', namespace: 'ns2', packaging: 'loc', isLive: true, bitrate: 200 },
            { name: 'enhanced', namespace: 'ns2', packaging: 'loc', isLive: true, depends: ['base'] },
        ];
        // "enhanced" in ns2 depends on "base" — should resolve to ns2's base, not ns1's
        const chain = resolveDependencies(tracks[2]!, tracks);
        expect(chain).toHaveLength(2);
        expect(chain[0]!.namespace).toBe('ns2');
        expect(chain[0]!.bitrate).toBe(200);
        expect(chain[1]!.name).toBe('enhanced');
    });

    it('throws when dependency not found in declaring track namespace (§5.1.21)', () => {
        const tracks: CatalogTrack[] = [
            { name: 'base', namespace: 'other-ns', packaging: 'loc', isLive: true },
            { name: 'enhanced', namespace: 'ns1', packaging: 'loc', isLive: true, depends: ['base'] },
        ];
        // "base" exists in "other-ns" but not in "ns1" — should fail
        expect(() => resolveDependencies(tracks[1]!, tracks)).toThrow(/not found/i);
    });
});

// ─── Multiple distinct groups ──────────────────────────────────────

describe('groupByRender — multiple groups', () => {
    it('separates tracks into distinct render groups', () => {
        const state: CatalogState = {
            version: 1,
            tracks: [
                { name: 'cam1-video', packaging: 'loc', isLive: true, renderGroup: 1 },
                { name: 'cam1-audio', packaging: 'loc', isLive: true, renderGroup: 1 },
                { name: 'cam2-video', packaging: 'loc', isLive: true, renderGroup: 2 },
                { name: 'cam2-audio', packaging: 'loc', isLive: true, renderGroup: 2 },
                { name: 'slides', packaging: 'loc', isLive: true, renderGroup: 3 },
            ],
        };
        const { groups, ungrouped } = groupByRender(state);
        expect(groups).toHaveLength(3);
        expect(groups.find(g => g.renderGroup === 1)!.tracks).toHaveLength(2);
        expect(groups.find(g => g.renderGroup === 2)!.tracks).toHaveLength(2);
        expect(groups.find(g => g.renderGroup === 3)!.tracks).toHaveLength(1);
        expect(ungrouped).toHaveLength(0);
    });
});

describe('groupByAlt — multiple groups', () => {
    it('separates tracks into distinct alt groups', () => {
        const tracks: CatalogTrack[] = [
            { name: 'video-hd', packaging: 'loc', isLive: true, altGroup: 1, bitrate: 5000000 },
            { name: 'video-sd', packaging: 'loc', isLive: true, altGroup: 1, bitrate: 500000 },
            { name: 'audio-en', packaging: 'loc', isLive: true, altGroup: 2, lang: 'en' },
            { name: 'audio-de', packaging: 'loc', isLive: true, altGroup: 2, lang: 'de' },
        ];
        const { groups, ungrouped } = groupByAlt(tracks);
        expect(groups).toHaveLength(2);
        expect(groups.find(g => g.altGroup === 1)!.tracks).toHaveLength(2);
        expect(groups.find(g => g.altGroup === 2)!.tracks).toHaveLength(2);
        expect(ungrouped).toHaveLength(0);
    });
});

describe('selectTrack — role filtering', () => {
    it('filters by role', () => {
        const tracks: CatalogTrack[] = [
            { name: 'video', packaging: 'loc', isLive: true, role: 'video', bitrate: 5000000 },
            { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', bitrate: 32000 },
            { name: 'caption', packaging: 'loc', isLive: true, role: 'caption', bitrate: 1000 },
        ];
        const track = selectTrack(tracks, { role: 'audio' });
        expect(track).toBeDefined();
        expect(track!.name).toBe('audio');
    });

    it('applies minBitrate constraint', () => {
        const tracks: CatalogTrack[] = [
            { name: 'low', packaging: 'loc', isLive: true, bitrate: 100000 },
            { name: 'mid', packaging: 'loc', isLive: true, bitrate: 1000000 },
            { name: 'high', packaging: 'loc', isLive: true, bitrate: 5000000 },
        ];
        const track = selectTrack(tracks, { minBitrate: 500000, maxBitrate: 2000000 });
        expect(track).toBeDefined();
        expect(track!.name).toBe('mid');
    });
});
