/**
 * Tests for parseCatalog() — independent catalog parsing and validation.
 *
 * Test vectors are drawn directly from draft-ietf-moq-msf-00 §5.3 examples.
 * Each test is annotated with the spec section it validates.
 *
 * @see draft-ietf-moq-msf-00 §5
 */

import { describe, it, expect } from 'vitest';
import { parseCatalog } from './catalog.js';
import type { Catalog } from './types.js';

// ─── Spec example catalogs (§5.3) ───────────────────────────────────

/** §5.3.1: Time-aligned Audio/Video Tracks with single quality */
const EXAMPLE_AV_SINGLE = JSON.stringify({
    version: 1,
    generatedAt: 1746104606044,
    tracks: [
        {
            name: '1080p-video',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'loc',
            isLive: true,
            targetLatency: 2000,
            role: 'video',
            renderGroup: 1,
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            framerate: 30,
            bitrate: 1500000,
        },
        {
            name: 'audio',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'loc',
            isLive: true,
            targetLatency: 2000,
            role: 'audio',
            renderGroup: 1,
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
        },
    ],
});

/** §5.3.2: Simulcast video tracks - 3 alternate qualities along with audio */
const EXAMPLE_SIMULCAST = JSON.stringify({
    version: 1,
    generatedAt: 1746104606044,
    tracks: [
        {
            name: 'hd',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            targetLatency: 1500,
            role: 'video',
            codec: 'av01',
            width: 1920,
            height: 1080,
            bitrate: 5000000,
            framerate: 30,
            altGroup: 1,
        },
        {
            name: 'md',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            targetLatency: 1500,
            role: 'video',
            codec: 'av01',
            width: 720,
            height: 640,
            bitrate: 3000000,
            framerate: 30,
            altGroup: 1,
        },
        {
            name: 'sd',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            targetLatency: 1500,
            role: 'video',
            codec: 'av01',
            width: 192,
            height: 144,
            bitrate: 500000,
            framerate: 30,
            altGroup: 1,
        },
        {
            name: 'audio',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            targetLatency: 1500,
            role: 'audio',
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
        },
    ],
});

/** §5.3.3: SVC video tracks with 2 spatial and 2 temporal qualities */
const EXAMPLE_SVC = JSON.stringify({
    version: 1,
    generatedAt: 1746104606044,
    tracks: [
        {
            name: '480p15',
            namespace: 'conference.example.com/conference123/alice',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.01M.10.0.110.09',
            width: 640,
            height: 480,
            bitrate: 3000000,
            framerate: 15,
        },
        {
            name: '480p30',
            namespace: 'conference.example.com/conference123/alice',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.04M.10.0.110.09',
            width: 640,
            height: 480,
            bitrate: 3000000,
            framerate: 30,
            depends: ['480p15'],
        },
        {
            name: '1080p15',
            namespace: 'conference.example.com/conference123/alice',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.05M.10.0.110.09',
            width: 1920,
            height: 1080,
            bitrate: 3000000,
            framerate: 15,
            depends: ['480p15'],
        },
        {
            name: '1080p30',
            namespace: 'conference.example.com/conference123/alice',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            role: 'video',
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            bitrate: 5000000,
            framerate: 30,
            depends: ['480p30', '1080p15'],
        },
        {
            name: 'audio',
            namespace: 'conference.example.com/conference123/alice',
            renderGroup: 1,
            packaging: 'loc',
            isLive: true,
            role: 'audio',
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
        },
    ],
});

/** §5.3.6: Time-aligned Audio/Video Tracks with custom field values */
const EXAMPLE_CUSTOM_FIELDS = JSON.stringify({
    version: 1,
    generatedAt: 1746104606044,
    tracks: [
        {
            name: '1080p-video',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'loc',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            framerate: 30,
            bitrate: 1500000,
            'com.example-billing-code': 3201,
            'com.example-tier': 'premium',
            'com.example-debug': 'h349835bfkjfg82394d945034jsdfn349fns',
        },
        {
            name: 'audio',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'loc',
            isLive: true,
            role: 'audio',
            renderGroup: 1,
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
        },
    ],
});

/** §5.3.7: Time-aligned VOD Audio/Video Tracks */
const EXAMPLE_VOD = JSON.stringify({
    version: 1,
    tracks: [
        {
            name: 'video',
            namespace: 'movies.example.com/assets/boy-meets-girl-season3/episode5',
            packaging: 'loc',
            isLive: false,
            trackDuration: 8072340,
            renderGroup: 1,
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            framerate: 30,
            bitrate: 1500000,
        },
        {
            name: 'audio',
            namespace: 'movies.example.com/assets/boy-meets-girl-season3/episode5',
            packaging: 'loc',
            isLive: false,
            trackDuration: 8072340,
            renderGroup: 1,
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
        },
    ],
});

/** §5.3.8: Media timeline and Event timeline */
const EXAMPLE_TIMELINES = JSON.stringify({
    version: 1,
    generatedAt: 1746104606044,
    tracks: [
        {
            name: 'history',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'mediatimeline',
            mimeType: 'application/json',
            depends: ['1080p-video', 'audio'],
            isLive: true,
        },
        {
            name: 'identified-objects',
            namespace: 'another-provider/time-synchronized-data',
            packaging: 'eventtimeline',
            eventType: 'com.ai-extraction/appID/v3',
            mimeType: 'application/json',
            depends: ['1080p-video'],
            isLive: true,
        },
        {
            name: '1080p-video',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'loc',
            isLive: true,
            targetLatency: 2000,
            role: 'video',
            renderGroup: 1,
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            framerate: 30,
            bitrate: 1500000,
        },
        {
            name: 'audio',
            namespace: 'conference.example.com/conference123/alice',
            packaging: 'loc',
            isLive: true,
            targetLatency: 2000,
            role: 'audio',
            renderGroup: 1,
            codec: 'opus',
            samplerate: 48000,
            channelConfig: '2',
            bitrate: 32000,
        },
    ],
});

/** §5.3.9: Terminating a live broadcast */
const EXAMPLE_TERMINATE = JSON.stringify({
    version: 1,
    generatedAt: 1746104606044,
    isComplete: true,
    tracks: [],
});

// ─── Tests ───────────────────────────────────────────────────────────

describe('parseCatalog', () => {
    // ─── Valid catalogs (spec examples) ──────────────────────────────

    it('parses minimal valid catalog', () => {
        const catalog = parseCatalog('{"version": 1, "tracks": []}');
        expect(catalog.version).toBe(1);
        expect(catalog.tracks).toEqual([]);
    });

    it('parses §5.3.1 — audio/video single quality', () => {
        const catalog = parseCatalog(EXAMPLE_AV_SINGLE);
        expect(catalog.version).toBe(1);
        expect(catalog.generatedAt).toBe(1746104606044);
        expect(catalog.tracks).toHaveLength(2);

        const video = catalog.tracks[0]!;
        expect(video.name).toBe('1080p-video');
        expect(video.namespace).toBe('conference.example.com/conference123/alice');
        expect(video.packaging).toBe('loc');
        expect(video.isLive).toBe(true);
        expect(video.targetLatency).toBe(2000);
        expect(video.role).toBe('video');
        expect(video.renderGroup).toBe(1);
        expect(video.codec).toBe('av01.0.08M.10.0.110.09');
        expect(video.width).toBe(1920);
        expect(video.height).toBe(1080);
        expect(video.framerate).toBe(30);
        expect(video.bitrate).toBe(1500000);

        const audio = catalog.tracks[1]!;
        expect(audio.name).toBe('audio');
        expect(audio.role).toBe('audio');
        expect(audio.codec).toBe('opus');
        expect(audio.samplerate).toBe(48000);
        expect(audio.channelConfig).toBe('2');
    });

    it('parses §5.3.2 — simulcast with altGroup', () => {
        const catalog = parseCatalog(EXAMPLE_SIMULCAST);
        expect(catalog.tracks).toHaveLength(4);

        // All 3 video tracks share altGroup=1
        const videoTracks = catalog.tracks.filter(t => t.role === 'video');
        expect(videoTracks).toHaveLength(3);
        for (const t of videoTracks) {
            expect(t.altGroup).toBe(1);
        }

        // hd, md, sd have distinct bitrates
        expect(videoTracks[0]!.name).toBe('hd');
        expect(videoTracks[0]!.bitrate).toBe(5000000);
        expect(videoTracks[1]!.name).toBe('md');
        expect(videoTracks[1]!.bitrate).toBe(3000000);
        expect(videoTracks[2]!.name).toBe('sd');
        expect(videoTracks[2]!.bitrate).toBe(500000);
    });

    it('parses §5.3.3 — SVC with depends', () => {
        const catalog = parseCatalog(EXAMPLE_SVC);
        expect(catalog.tracks).toHaveLength(5);

        const t480p30 = catalog.tracks.find(t => t.name === '480p30');
        expect(t480p30!.depends).toEqual(['480p15']);

        const t1080p15 = catalog.tracks.find(t => t.name === '1080p15');
        expect(t1080p15!.depends).toEqual(['480p15']);

        const t1080p30 = catalog.tracks.find(t => t.name === '1080p30');
        expect(t1080p30!.depends).toEqual(['480p30', '1080p15']);

        // Base layer has no depends
        const t480p15 = catalog.tracks.find(t => t.name === '480p15');
        expect(t480p15!.depends).toBeUndefined();
    });

    it('parses §5.3.7 — VOD tracks (isLive=false, trackDuration)', () => {
        const catalog = parseCatalog(EXAMPLE_VOD);
        expect(catalog.tracks).toHaveLength(2);

        for (const track of catalog.tracks) {
            expect(track.isLive).toBe(false);
            expect(track.trackDuration).toBe(8072340);
        }
    });

    it('parses §5.3.9 — broadcast termination (isComplete, empty tracks)', () => {
        const catalog = parseCatalog(EXAMPLE_TERMINATE);
        expect(catalog.isComplete).toBe(true);
        expect(catalog.tracks).toEqual([]);
        expect(catalog.generatedAt).toBe(1746104606044);
    });

    it('parses §5.3.6 — ignores custom fields (§5.1)', () => {
        const catalog = parseCatalog(EXAMPLE_CUSTOM_FIELDS);
        expect(catalog.tracks).toHaveLength(2);

        const video = catalog.tracks[0]!;
        expect(video.name).toBe('1080p-video');
        // Custom fields should not appear on the parsed track
        expect((video as Record<string, unknown>)['com.example-billing-code']).toBeUndefined();
        expect((video as Record<string, unknown>)['com.example-tier']).toBeUndefined();
        expect((video as Record<string, unknown>)['com.example-debug']).toBeUndefined();
    });

    it('parses §5.3.8 — timeline tracks (mediatimeline + eventtimeline)', () => {
        const catalog = parseCatalog(EXAMPLE_TIMELINES);
        expect(catalog.tracks).toHaveLength(4);

        const history = catalog.tracks.find(t => t.name === 'history');
        expect(history!.packaging).toBe('mediatimeline');
        expect(history!.mimeType).toBe('application/json');
        expect(history!.depends).toEqual(['1080p-video', 'audio']);

        const events = catalog.tracks.find(t => t.name === 'identified-objects');
        expect(events!.packaging).toBe('eventtimeline');
        expect(events!.eventType).toBe('com.ai-extraction/appID/v3');
    });

    it('accepts Uint8Array input', () => {
        const bytes = new TextEncoder().encode('{"version": 1, "tracks": []}');
        const catalog = parseCatalog(bytes);
        expect(catalog.version).toBe(1);
    });

    // ─── Namespace inheritance (§5.1.10) ─────────────────────────────

    it('inherits catalog namespace when track namespace is absent (§5.1.10)', () => {
        const catalog = parseCatalog(EXAMPLE_SIMULCAST, 'live.example.com/broadcast1');
        // Simulcast tracks have no namespace in JSON
        for (const track of catalog.tracks) {
            expect(track.namespace).toBe('live.example.com/broadcast1');
        }
    });

    it('track-level namespace overrides inherited namespace (§5.1.10)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, namespace: 'custom/ns' },
            ],
        });
        const catalog = parseCatalog(json, 'default/ns');
        expect(catalog.tracks[0]!.namespace).toBe('custom/ns');
    });

    // ─── Validation errors ───────────────────────────────────────────

    it('rejects unknown version (§5.1.1)', () => {
        expect(() => parseCatalog('{"version": 2, "tracks": []}')).toThrow(/version/i);
    });

    it('rejects missing version', () => {
        expect(() => parseCatalog('{"tracks": []}')).toThrow(/version/i);
    });

    it('rejects missing tracks array (§5.1.8)', () => {
        expect(() => parseCatalog('{"version": 1}')).toThrow(/tracks/i);
    });

    it('rejects track without name (§5.1.11)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ packaging: 'loc', isLive: true }],
        });
        expect(() => parseCatalog(json)).toThrow(/name/i);
    });

    it('accepts cmaf packaging (draft-ietf-moq-cmsf-00 §3.5.1)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: '1.m4s', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.64001f' }],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks[0]!.packaging).toBe('cmaf');
    });

    it('rejects track without packaging (§5.1.12)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'video', isLive: true }],
        });
        expect(() => parseCatalog(json)).toThrow(/packaging/i);
    });

    it('rejects track without isLive (§5.1.15)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'video', packaging: 'loc' }],
        });
        expect(() => parseCatalog(json)).toThrow(/isLive/i);
    });

    it('rejects duplicate track names within same namespace (§5.1.11)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, namespace: 'ns' },
                { name: 'video', packaging: 'loc', isLive: true, namespace: 'ns' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/unique|duplicate/i);
    });

    it('allows same track name in different namespaces (§5.1.11)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, namespace: 'ns1' },
                { name: 'video', packaging: 'loc', isLive: true, namespace: 'ns2' },
            ],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks).toHaveLength(2);
    });

    it('rejects targetLatency when isLive=false (§5.1.16)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: false, targetLatency: 2000 },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/targetLatency/i);
    });

    it('rejects trackDuration when isLive=true (§5.1.37)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, trackDuration: 5000 },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/trackDuration/i);
    });

    it('rejects eventType with non-eventtimeline packaging (§5.1.13)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, eventType: 'foo' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/eventType/i);
    });

    it('rejects eventtimeline packaging without eventType (§5.1.13)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'events', packaging: 'eventtimeline', isLive: true },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/eventType/i);
    });

    it('rejects invalid JSON', () => {
        expect(() => parseCatalog('not json')).toThrow();
    });

    // ─── §5.1.7: isComplete MUST NOT be included if false ─────────────

    it('rejects isComplete=false — MUST NOT be included if false (§5.1.7)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [],
            isComplete: false,
        });
        expect(() => parseCatalog(json)).toThrow(/isComplete/i);
    });

    // ─── §5.1.36: parentName MUST only appear in clone context ────────

    it('rejects parentName in independent catalog track (§5.1.36)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, parentName: 'something' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/parentName/i);
    });

    // ─── Field coverage: optional fields parsed correctly ─────────────

    // ─── §7.2/§8.2: Timeline track cross-validation ───────────────

    it('rejects mediatimeline track without depends (§7.2)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/depends/i);
    });

    it('rejects mediatimeline track without mimeType="application/json" (§7.2)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['video'], mimeType: 'text/plain' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/mimeType/i);
    });

    it('rejects mediatimeline track without mimeType at all (§7.2)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['video'] },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/mimeType/i);
    });

    it('rejects eventtimeline track without depends (§8.2)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'events', packaging: 'eventtimeline', isLive: true, eventType: 'scores', mimeType: 'application/json' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/depends/i);
    });

    it('rejects eventtimeline track without mimeType="application/json" (§8.2)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'events', packaging: 'eventtimeline', isLive: true, eventType: 'scores', depends: ['video'], mimeType: 'text/xml' },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/mimeType/i);
    });

    // ─── §5.1.16: targetLatency consistency ────────────────────────

    it('rejects inconsistent targetLatency within renderGroup (§5.1.16)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, renderGroup: 1, targetLatency: 2000 },
                { name: 'audio', packaging: 'loc', isLive: true, renderGroup: 1, targetLatency: 3000 },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/targetLatency/i);
    });

    it('rejects inconsistent targetLatency within altGroup (§5.1.16)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'hd', packaging: 'loc', isLive: true, altGroup: 1, targetLatency: 1500 },
                { name: 'sd', packaging: 'loc', isLive: true, altGroup: 1, targetLatency: 2500 },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/targetLatency/i);
    });

    it('accepts consistent targetLatency within renderGroup (§5.1.16)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, renderGroup: 1, targetLatency: 2000 },
                { name: 'audio', packaging: 'loc', isLive: true, renderGroup: 1, targetLatency: 2000 },
            ],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks).toHaveLength(2);
    });

    it('rejects when one track in renderGroup has targetLatency and another does not (§5.1.16)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, renderGroup: 1, targetLatency: 2000 },
                { name: 'audio', packaging: 'loc', isLive: true, renderGroup: 1 },
            ],
        });
        expect(() => parseCatalog(json)).toThrow(/targetLatency/i);
    });

    it('accepts valid mediatimeline track with depends + mimeType (§7.2)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['video'], mimeType: 'application/json' },
            ],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks[0]!.depends).toEqual(['video']);
        expect(catalog.tracks[0]!.mimeType).toBe('application/json');
    });

    // ─── Field coverage: optional fields parsed correctly ─────────────

    // ─── §5.1.35: BCP 47 language tag validation ──────────────────────

    it('accepts valid BCP 47 lang tags (§5.1.35)', () => {
        const validTags = ['en', 'de', 'zh-Hans', 'pt-BR', 'en-US', 'sr-Latn-RS', 'es-419'];
        for (const lang of validTags) {
            const json = JSON.stringify({
                version: 1,
                tracks: [{ name: 'audio', packaging: 'loc', isLive: true, lang }],
            });
            expect(() => parseCatalog(json)).not.toThrow();
        }
    });

    it('rejects invalid lang tag: empty string (§5.1.35)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'audio', packaging: 'loc', isLive: true, lang: '' }],
        });
        expect(() => parseCatalog(json)).toThrow(/lang/i);
    });

    it('rejects invalid lang tag: numeric-only (§5.1.35)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'audio', packaging: 'loc', isLive: true, lang: '123' }],
        });
        expect(() => parseCatalog(json)).toThrow(/lang/i);
    });

    it('rejects invalid lang tag: special characters (§5.1.35)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'audio', packaging: 'loc', isLive: true, lang: 'en_US' }],
        });
        expect(() => parseCatalog(json)).toThrow(/lang/i);
    });

    // ─── §5.1.20: initData Base64 validation ───────────────────────────

    it('accepts valid Base64 initData (§5.1.20)', () => {
        const validValues = ['AAAAAAA=', 'SGVsbG8gV29ybGQ=', 'dGVzdA==', 'YQ==', 'YWI='];
        for (const initData of validValues) {
            const json = JSON.stringify({
                version: 1,
                tracks: [{ name: 'video', packaging: 'loc', isLive: true, initData }],
            });
            expect(() => parseCatalog(json)).not.toThrow();
        }
    });

    it('rejects invalid Base64 initData: special characters (§5.1.20)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'video', packaging: 'loc', isLive: true, initData: 'not!valid@base64' }],
        });
        expect(() => parseCatalog(json)).toThrow(/initData/i);
    });

    it('rejects invalid Base64 initData: wrong padding (§5.1.20)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'video', packaging: 'loc', isLive: true, initData: 'abc' }],
        });
        expect(() => parseCatalog(json)).toThrow(/initData/i);
    });

    it('accepts empty string as valid Base64 initData (§5.1.20)', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [{ name: 'video', packaging: 'loc', isLive: true, initData: '' }],
        });
        expect(() => parseCatalog(json)).not.toThrow();
    });

    it('parses timescale, initData, temporalId, spatialId, displayWidth, displayHeight', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                {
                    name: 'video',
                    packaging: 'loc',
                    isLive: true,
                    timescale: 90000,
                    initData: 'AAAAAAA=',
                    temporalId: 0,
                    spatialId: 1,
                    displayWidth: 1920,
                    displayHeight: 1080,
                    width: 3840,
                    height: 2160,
                },
            ],
        });
        const catalog = parseCatalog(json);
        const t = catalog.tracks[0]!;
        expect(t.timescale).toBe(90000);
        expect(t.initData).toBe('AAAAAAA=');
        expect(t.temporalId).toBe(0);
        expect(t.spatialId).toBe(1);
        expect(t.displayWidth).toBe(1920);
        expect(t.displayHeight).toBe(1080);
    });

    // ─── CMSF catalog fields (draft-ietf-moq-cmsf-00 §3.5.2) ────────

    it('parses maxGrpSapStartingType from CMAF tracks (CMSF §3.5.2.1)', () => {
        // §3.5.2.1: "A number indicating the maximum SAP type the MOQT Groups
        // in the track start with."
        const json = JSON.stringify({
            version: 1,
            tracks: [{
                name: 'hd',
                packaging: 'cmaf',
                isLive: true,
                role: 'video',
                codec: 'avc1.640028',
                maxGrpSapStartingType: 2,
            }],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks[0]!.maxGrpSapStartingType).toBe(2);
    });

    it('parses maxObjSapStartingType from CMAF tracks (CMSF §3.5.2.2)', () => {
        // §3.5.2.2: "A number indicating the maximum SAP type the MOQT Objects
        // in the track start with."
        const json = JSON.stringify({
            version: 1,
            tracks: [{
                name: 'hd',
                packaging: 'cmaf',
                isLive: true,
                role: 'video',
                codec: 'avc1.640028',
                maxObjSapStartingType: 3,
            }],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks[0]!.maxObjSapStartingType).toBe(3);
    });

    it('parses CMSF simulcast catalog (CMSF §4.1)', () => {
        // §4.1: Example catalog with 3 alternate video qualities + audio
        const json = JSON.stringify({
            version: 1,
            generatedAt: 1746104606044,
            tracks: [
                {
                    name: 'hd',
                    renderGroup: 1,
                    packaging: 'cmaf',
                    isLive: true,
                    initData: 'AAAAIGZ0eXBpc281',
                    role: 'video',
                    codec: 'avc1.640028',
                    width: 1920,
                    height: 1080,
                    bitrate: 5000000,
                    framerate: 30,
                    altGroup: 1,
                    maxGrpSapStartingType: 2,
                    maxObjSapStartingType: 3,
                },
                {
                    name: 'md',
                    renderGroup: 1,
                    packaging: 'cmaf',
                    isLive: true,
                    initData: 'AAAAHGZ0eXBpc281',
                    role: 'video',
                    codec: 'avc1.64001e',
                    width: 720,
                    height: 640,
                    bitrate: 3000000,
                    framerate: 30,
                    altGroup: 1,
                },
                {
                    name: 'audio',
                    renderGroup: 1,
                    packaging: 'cmaf',
                    isLive: true,
                    initData: 'AAAAHGZ0eXBpc281',
                    role: 'audio',
                    codec: 'mp4a.40.5',
                    samplerate: 48000,
                    channelConfig: '2',
                    bitrate: 67071,
                },
            ],
        });
        const catalog = parseCatalog(json);
        expect(catalog.tracks).toHaveLength(3);
        expect(catalog.tracks[0]!.packaging).toBe('cmaf');
        expect(catalog.tracks[0]!.maxGrpSapStartingType).toBe(2);
        expect(catalog.tracks[0]!.maxObjSapStartingType).toBe(3);
        // Second track: SAP fields are optional — should be undefined
        expect(catalog.tracks[1]!.maxGrpSapStartingType).toBeUndefined();
        expect(catalog.tracks[1]!.maxObjSapStartingType).toBeUndefined();
    });
});
