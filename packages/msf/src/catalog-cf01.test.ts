/**
 * Tests for parseCatalogFormat01() — catalogformat-01 catalog parsing.
 *
 * @see draft-ietf-moq-catalogformat-01 §3
 */

import { describe, it, expect, vi } from 'vitest';
import { parseCatalogFormat01, applyCf01Patch } from './catalog-cf01.js';

// ─── Test data: moq-rs style catalog ──────────────────────────────────

const MOQ_RS_CATALOG = {
    version: 1,
    streamingFormat: 1,
    streamingFormatVersion: '0.2',
    supportsDeltaUpdates: true,
    commonTrackFields: {
        namespace: 'bbb',
        packaging: 'cmaf',
        renderGroup: 1,
    },
    tracks: [
        {
            name: '1.m4s',
            initTrack: '0.mp4',
            selectionParams: {
                codec: 'avc1.640028',
                mimeType: 'video/mp4',
                width: 1280,
                height: 720,
                framerate: 24,
                bitrate: 1500000,
            },
        },
        {
            name: '2.m4s',
            initTrack: '0.mp4',
            selectionParams: {
                codec: 'mp4a.40.2',
                mimeType: 'audio/mp4',
                samplerate: 44100,
                channelConfig: '2',
            },
        },
    ],
};

// ─── Happy path ────────────────────────────────────────────────────────

describe('parseCatalogFormat01', () => {
    it('parses moq-rs-style catalog with commonTrackFields + selectionParams', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        expect(result.catalog.version).toBe(1);
        expect(result.catalog.tracks).toHaveLength(2);
        expect(result.supportsDeltaUpdates).toBe(true);
        expect(result.rawDocument).toBeDefined();
    });

    it('inherits commonTrackFields via generic spread', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        const video = result.catalog.tracks[0]!;
        expect(video.packaging).toBe('cmaf');
        expect(video.renderGroup).toBe(1);
        expect(video.namespace).toBe('bbb');
    });

    it('flattens selectionParams to top-level track fields', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        const video = result.catalog.tracks[0]!;
        expect(video.codec).toBe('avc1.640028');
        expect(video.mimeType).toBe('video/mp4');
        expect(video.width).toBe(1280);
        expect(video.height).toBe(720);
        expect(video.framerate).toBe(24);
        expect(video.bitrate).toBe(1500000);
        // selectionParams should not appear as a key
        expect((video as Record<string, unknown>)['selectionParams']).toBeUndefined();
    });

    it('deep-merges selectionParams from commonTrackFields and track', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: {
                selectionParams: { codec: 'avc1.64001f', width: 640 },
            },
            tracks: [
                {
                    name: 'video',
                    packaging: 'loc',
                    selectionParams: { width: 1280, height: 720 },
                },
            ],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        const video = result.catalog.tracks[0]!;
        // Track-level width overrides commonTrackFields
        expect(video.width).toBe(1280);
        // codec inherited from commonTrackFields
        expect(video.codec).toBe('avc1.64001f');
        // height from track-level
        expect(video.height).toBe(720);
    });

    it('follows namespace inheritance precedence: track > commonTrackFields > root > catalogNamespace', () => {
        // catalogNamespace fallback (lowest priority)
        const catalog1 = {
            version: 1,
            streamingFormat: 1,
            tracks: [{ name: 'v', packaging: 'loc' }],
        };
        const r1 = parseCatalogFormat01(JSON.stringify(catalog1), 'fallback-ns');
        expect(r1.catalog.tracks[0]!.namespace).toBe('fallback-ns');

        // Root-level namespace overrides catalogNamespace (§3.2.9: TFC)
        const catalog1b = {
            version: 1,
            streamingFormat: 1,
            namespace: 'root-ns',
            tracks: [{ name: 'v', packaging: 'loc' }],
        };
        const r1b = parseCatalogFormat01(JSON.stringify(catalog1b), 'fallback-ns');
        expect(r1b.catalog.tracks[0]!.namespace).toBe('root-ns');

        // commonTrackFields overrides root-level
        const catalog2 = {
            version: 1,
            streamingFormat: 1,
            namespace: 'root-ns',
            commonTrackFields: { namespace: 'common-ns' },
            tracks: [{ name: 'v', packaging: 'loc' }],
        };
        const r2 = parseCatalogFormat01(JSON.stringify(catalog2), 'fallback-ns');
        expect(r2.catalog.tracks[0]!.namespace).toBe('common-ns');

        // Track-level overrides commonTrackFields
        const catalog3 = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: { namespace: 'common-ns' },
            tracks: [{ name: 'v', packaging: 'loc', namespace: 'track-ns' }],
        };
        const r3 = parseCatalogFormat01(JSON.stringify(catalog3), 'fallback-ns');
        expect(r3.catalog.tracks[0]!.namespace).toBe('track-ns');
    });

    it('inherits name from root level (§3.2.10: TFC)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            name: 'default-track',
            tracks: [{ packaging: 'loc' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.name).toBe('default-track');
    });

    it('inherits name from commonTrackFields (§3.2.10: TFC)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: { name: 'common-name' },
            tracks: [{ packaging: 'loc' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.name).toBe('common-name');
    });

    it('track name overrides commonTrackFields name (§3.2.10: TFC)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: { name: 'common-name' },
            tracks: [{ name: 'track-name', packaging: 'loc' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.name).toBe('track-name');
    });

    it('infers role from mimeType prefix', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        expect(result.catalog.tracks[0]!.role).toBe('video');
        expect(result.catalog.tracks[1]!.role).toBe('audio');
    });

    it('infers role from codec when mimeType is absent', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [
                { name: 'v', packaging: 'loc', selectionParams: { codec: 'avc1.640028' } },
                { name: 'a', packaging: 'loc', selectionParams: { codec: 'mp4a.40.2' } },
                { name: 'v2', packaging: 'loc', selectionParams: { codec: 'hev1.1.6' } },
                { name: 'a2', packaging: 'loc', selectionParams: { codec: 'opus' } },
            ],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.role).toBe('video');
        expect(result.catalog.tracks[1]!.role).toBe('audio');
        expect(result.catalog.tracks[2]!.role).toBe('video');
        expect(result.catalog.tracks[3]!.role).toBe('audio');
    });

    it('omits role when neither mimeType nor codec present', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [{ name: 'data', packaging: 'loc' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.role).toBeUndefined();
    });

    it('defaults isLive to true', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        for (const track of result.catalog.tracks) {
            expect(track.isLive).toBe(true);
        }
    });

    it('defaults packaging to cmaf when absent everywhere (interop mode)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [{ name: 'v' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.packaging).toBe('cmaf');
    });

    it('throws when packaging absent in strict mode', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            tracks: [{ name: 'v' }],
        };
        expect(() =>
            parseCatalogFormat01(JSON.stringify(catalog), undefined, { strict: true }),
        ).toThrow(/packaging/i);
    });

    it('preserves initTrack on output', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        expect(result.catalog.tracks[0]!.initTrack).toBe('0.mp4');
        expect(result.catalog.tracks[1]!.initTrack).toBe('0.mp4');
    });

    it('accepts version as number or string "1"', () => {
        const catalog1 = { version: 1, streamingFormat: 1, tracks: [] };
        expect(parseCatalogFormat01(JSON.stringify(catalog1)).catalog.version).toBe(1);

        const catalog2 = { version: '1', streamingFormat: 1, tracks: [] };
        expect(parseCatalogFormat01(JSON.stringify(catalog2)).catalog.version).toBe(1);
    });

    it('accepts streamingFormat as number or string', () => {
        const catalog1 = { version: 1, streamingFormat: 1, tracks: [] };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog1))).not.toThrow();

        const catalog2 = { version: 1, streamingFormat: 'cmaf', tracks: [] };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog2))).not.toThrow();
    });

    it('returns supportsDeltaUpdates in result', () => {
        const catalog = { version: 1, streamingFormat: 1, supportsDeltaUpdates: true, tracks: [] };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.supportsDeltaUpdates).toBe(true);

        const catalog2 = { version: 1, streamingFormat: 1, tracks: [] };
        const result2 = parseCatalogFormat01(JSON.stringify(catalog2));
        expect(result2.supportsDeltaUpdates).toBe(false);
    });

    it('returns rawDocument matching original JSON structure', () => {
        const result = parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
        // rawDocument should have the original cf01 structure (with selectionParams etc.)
        expect(result.rawDocument['streamingFormat']).toBe(1);
        expect(result.rawDocument['commonTrackFields']).toBeDefined();
        const tracks = result.rawDocument['tracks'] as unknown[];
        expect((tracks[0] as Record<string, unknown>)['selectionParams']).toBeDefined();
    });

    it('accepts Uint8Array input', () => {
        const bytes = new TextEncoder().encode(JSON.stringify(MOQ_RS_CATALOG));
        const result = parseCatalogFormat01(bytes);
        expect(result.catalog.tracks).toHaveLength(2);
    });

    // ─── Edge cases ──────────────────────────────────────────────────────

    it('works without commonTrackFields (all fields inline)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [
                {
                    name: 'video',
                    namespace: 'live',
                    packaging: 'loc',
                    selectionParams: { codec: 'avc1.64001f', width: 640, height: 480 },
                },
            ],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.namespace).toBe('live');
        expect(result.catalog.tracks[0]!.packaging).toBe('loc');
    });

    it('works with empty commonTrackFields object', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: {},
            tracks: [{ name: 'v', packaging: 'loc' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.packaging).toBe('loc');
    });

    it('track-level field overrides commonTrackFields', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: { packaging: 'cmaf' },
            tracks: [{ name: 'v', packaging: 'loc' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.packaging).toBe('loc');
    });

    // ─── Validation / error cases ────────────────────────────────────────

    it('throws on missing tracks array', () => {
        const catalog = { version: 1, streamingFormat: 1 };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/tracks/i);
    });

    it('throws on missing streamingFormat', () => {
        const catalog = { version: 1, tracks: [] };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/streamingFormat/i);
    });

    it('throws on catalogs-mode catalog', () => {
        const catalog = { version: 1, streamingFormat: 1, catalogs: [{}] };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/catalogs/i);
    });

    it('throws on track missing name', () => {
        const catalog = { version: 1, streamingFormat: 1, tracks: [{ packaging: 'loc' }] };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/name/i);
    });

    it('throws on duplicate track names in same namespace', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            commonTrackFields: { namespace: 'ns' },
            tracks: [{ name: 'v' }, { name: 'v' }],
        };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/duplicate/i);
    });

    it('throws when initTrack references a track in tracks array', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [
                { name: '0.mp4', packaging: 'cmaf' },
                { name: '1.m4s', packaging: 'cmaf', initTrack: '0.mp4' },
            ],
        };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/initTrack/i);
    });

    it('throws on empty selectionParams object (§3.2.17)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [{ name: 'v', packaging: 'loc', selectionParams: {} }],
        };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).toThrow(/selectionParams/i);
    });

    it('throws on invalid JSON', () => {
        expect(() => parseCatalogFormat01('not json')).toThrow();
    });

    it('accepts missing streamingFormatVersion in interop mode without throwing', () => {
        const catalog = { version: 1, streamingFormat: 1, tracks: [] };
        expect(() => parseCatalogFormat01(JSON.stringify(catalog))).not.toThrow();
    });

    it('throws when streamingFormatVersion is missing in strict mode', () => {
        const catalog = { version: 1, streamingFormat: 1, tracks: [] };
        expect(() =>
            parseCatalogFormat01(JSON.stringify(catalog), undefined, { strict: true }),
        ).toThrow(/streamingFormatVersion/i);
    });

    it('uses explicit role field when present', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            tracks: [{ name: 'v', packaging: 'loc', role: 'caption' }],
        };
        const result = parseCatalogFormat01(JSON.stringify(catalog));
        expect(result.catalog.tracks[0]!.role).toBe('caption');
    });
});

// ─── Delta (JSON Patch) tests ──────────────────────────────────────────

describe('applyCf01Patch', () => {
    function makeInitialResult() {
        return parseCatalogFormat01(JSON.stringify(MOQ_RS_CATALOG));
    }

    it('applies add operation to tracks array', () => {
        const initial = makeInitialResult();
        const patch = [
            {
                op: 'add',
                path: '/tracks/-',
                value: {
                    name: '3.m4s',
                    selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4', width: 640, height: 480 },
                },
            },
        ];
        const result = applyCf01Patch(initial.rawDocument, patch);
        expect(result.catalog.tracks).toHaveLength(3);
        expect(result.catalog.tracks[2]!.name).toBe('3.m4s');
    });

    it('applies remove operation on tracks array', () => {
        const initial = makeInitialResult();
        const patch = [{ op: 'remove', path: '/tracks/1' }];
        const result = applyCf01Patch(initial.rawDocument, patch);
        expect(result.catalog.tracks).toHaveLength(1);
        expect(result.catalog.tracks[0]!.name).toBe('1.m4s');
    });

    it('applies replace on non-selectionParams track field', () => {
        const initial = makeInitialResult();
        // renderGroup is not a selectionParam — replacing it is fine
        const patch = [
            { op: 'replace', path: '/tracks/0/renderGroup', value: 2 },
        ];
        // renderGroup came from commonTrackFields, but patch targets raw doc
        // which doesn't have it on individual tracks — add it first
        const patchAdd = [
            { op: 'add', path: '/tracks/0/renderGroup', value: 2 },
        ];
        const result = applyCf01Patch(initial.rawDocument, patchAdd);
        expect(result.catalog.tracks[0]!.renderGroup).toBe(2);
    });

    it('rejects patch that changes track name (§3.3)', () => {
        const initial = makeInitialResult();
        const patch = [
            { op: 'replace', path: '/tracks/0/name', value: 'renamed.m4s' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(/prohibited/i);
    });

    it('rejects patch that changes track namespace (§3.3)', () => {
        const initial = makeInitialResult();
        const patch = [
            { op: 'add', path: '/tracks/0/namespace', value: 'different-ns' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(/namespace.*prohibited/i);
    });

    it('rejects patch that adds selectionParams key (§3.3)', () => {
        const initial = makeInitialResult();
        const patch = [
            { op: 'add', path: '/tracks/0/selectionParams/samplerate', value: 48000 },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(/selection property/i);
    });

    it('rejects patch that removes selectionParams key (§3.3)', () => {
        const initial = makeInitialResult();
        const patch = [
            { op: 'remove', path: '/tracks/0/selectionParams/codec' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(/selection property/i);
    });

    it('rejects patch that replaces selectionParams value (§3.3 — contents may not vary)', () => {
        // §3.3: "Contents of the track selection properties object may not
        // be varied across updates. To adjust a track selection property, the
        // track must first be removed and then added with [...] a different name."
        const initial = makeInitialResult();
        const patch = [
            { op: 'replace', path: '/tracks/0/selectionParams/width', value: 1920 },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(/selection property/i);
    });

    it('allows removing track at index 0 (remaining tracks shift — not a name change)', () => {
        const initial = makeInitialResult();
        // Remove track at index 0 ("1.m4s"), leaving "2.m4s" at index 0
        const patch = [{ op: 'remove', path: '/tracks/0' }];
        const result = applyCf01Patch(initial.rawDocument, patch);
        expect(result.catalog.tracks).toHaveLength(1);
        expect(result.catalog.tracks[0]!.name).toBe('2.m4s');
    });

    it('allows remove+add to replace a track with different name and selectionParams', () => {
        const initial = makeInitialResult();
        const patch = [
            { op: 'remove', path: '/tracks/0' },
            {
                op: 'add',
                path: '/tracks/-',
                value: {
                    name: 'hd.m4s',
                    selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4', width: 1920, height: 1080, framerate: 24, bitrate: 3000000 },
                },
            },
        ];
        const result = applyCf01Patch(initial.rawDocument, patch);
        expect(result.catalog.tracks).toHaveLength(2);
        expect(result.catalog.tracks.find(t => t.name === 'hd.m4s')!.width).toBe(1920);
    });

    it('correctly matches tracks by namespace+name when same name exists in different namespaces', () => {
        // Two tracks with the same name but different namespaces
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            tracks: [
                { name: 'video', namespace: 'ns-a', packaging: 'cmaf', selectionParams: { codec: 'avc1.640028', width: 1280 } },
                { name: 'video', namespace: 'ns-b', packaging: 'cmaf', selectionParams: { codec: 'avc1.64001f', width: 640 } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));

        // Remove the first track (ns-a/video) — ns-b/video shifts to index 0.
        // This must NOT be flagged as a selectionParams change on "video".
        const patch = [{ op: 'remove', path: '/tracks/0' }];
        const result = applyCf01Patch(initial.rawDocument, patch);
        expect(result.catalog.tracks).toHaveLength(1);
        expect(result.catalog.tracks[0]!.namespace).toBe('ns-b');
        expect(result.catalog.tracks[0]!.width).toBe(640);
    });

    // ─── commonTrackFields bypass prevention (§3.3 / §3.3) ─────

    it('rejects namespace change via commonTrackFields (§3.3)', () => {
        // Tracks inherit namespace from commonTrackFields.
        // Patching commonTrackFields/namespace changes effective namespace.
        const initial = makeInitialResult();
        const patch = [
            { op: 'replace', path: '/commonTrackFields/namespace', value: 'different-ns' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /namespace.*prohibited/i,
        );
    });

    it('rejects name change via commonTrackFields (§3.3 — name is TFC)', () => {
        // Name inherited from commonTrackFields — patching it renames all inheriting tracks
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            commonTrackFields: { name: 'shared-name', namespace: 'ns', packaging: 'cmaf' },
            tracks: [
                { selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));
        expect(initial.catalog.tracks[0]!.name).toBe('shared-name');

        const patch = [
            { op: 'replace', path: '/commonTrackFields/name', value: 'renamed' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /name.*prohibited/i,
        );
    });

    it('rejects name change via root-level name (§3.3 — name is TFC)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            name: 'root-name',
            namespace: 'ns',
            tracks: [
                { packaging: 'cmaf', selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));
        expect(initial.catalog.tracks[0]!.name).toBe('root-name');

        const patch = [
            { op: 'replace', path: '/name', value: 'renamed' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /name.*prohibited/i,
        );
    });

    it('rejects namespace change via root-level namespace (§3.3 — namespace is TFC)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            namespace: 'root-ns',
            tracks: [
                { name: 'v', packaging: 'cmaf', selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));

        const patch = [
            { op: 'replace', path: '/namespace', value: 'different-ns' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /namespace.*prohibited/i,
        );
    });

    it('rejects name change via replace /commonTrackFields (whole-object, §3.3)', () => {
        // Replacing the entire commonTrackFields object with a different name inside
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            commonTrackFields: { name: 'original', namespace: 'ns', packaging: 'cmaf' },
            tracks: [
                { selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));

        const patch = [
            { op: 'replace', path: '/commonTrackFields', value: { name: 'renamed-via-parent-replace', namespace: 'ns', packaging: 'cmaf' } },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /name.*prohibited/i,
        );
    });

    it('rejects name change via remove /commonTrackFields/name (exposes lower layer, §3.3)', () => {
        // Removing commonTrackFields/name exposes root-level name (different value)
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            name: 'root-name',
            commonTrackFields: { name: 'common-name', namespace: 'ns', packaging: 'cmaf' },
            tracks: [
                { selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));
        expect(initial.catalog.tracks[0]!.name).toBe('common-name');

        const patch = [
            { op: 'remove', path: '/commonTrackFields/name' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /name.*prohibited/i,
        );
    });

    it('rejects remove /commonTrackFields when it contains namespace (§3.3)', () => {
        const initial = makeInitialResult();
        // MOQ_RS_CATALOG has commonTrackFields.namespace = 'bbb'
        const patch = [
            { op: 'remove', path: '/commonTrackFields' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /namespace.*prohibited/i,
        );
    });

    it('allows replace /commonTrackFields when name and namespace are unchanged', () => {
        const initial = makeInitialResult();
        // MOQ_RS_CATALOG commonTrackFields = { namespace: 'bbb', packaging: 'cmaf', renderGroup: 1 }
        // Replacing with same namespace (no name in either) — should be fine
        const patch = [
            { op: 'replace', path: '/commonTrackFields', value: { namespace: 'bbb', packaging: 'loc', renderGroup: 2 } },
        ];
        // This changes packaging (not a selectionParam) and renderGroup — allowed
        // But it also changes effective packaging on tracks... which is fine per spec
        // (only selectionParams contents are immutable, not packaging)
        const result = applyCf01Patch(initial.rawDocument, patch);
        expect(result.catalog.tracks[0]!.packaging).toBe('loc');
    });

    it('rejects selectionParams change via commonTrackFields (§3.3)', () => {
        // Catalog where selectionParams are inherited from commonTrackFields
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            commonTrackFields: {
                packaging: 'cmaf',
                selectionParams: { codec: 'avc1.640028', width: 1280 },
            },
            tracks: [
                { name: 'v', namespace: 'ns', selectionParams: { height: 720, mimeType: 'video/mp4' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));

        // Patch commonTrackFields selectionParams — changes effective width for all tracks
        const patch = [
            { op: 'replace', path: '/commonTrackFields/selectionParams/width', value: 1920 },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /selection property.*prohibited/i,
        );
    });

    it('rejects whole-track replace that changes name (§3.3)', () => {
        const initial = makeInitialResult();
        // Replace entire track object at index 0 with a different name
        const patch = [
            {
                op: 'replace',
                path: '/tracks/0',
                value: {
                    name: 'renamed.m4s',
                    selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4', width: 1280, height: 720, framerate: 24, bitrate: 1500000 },
                },
            },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /name.*prohibited/i,
        );
    });

    it('rejects whole-track replace that changes selectionParams (§3.3)', () => {
        const initial = makeInitialResult();
        // Replace entire track object at index 0 — same name but different selectionParams
        const patch = [
            {
                op: 'replace',
                path: '/tracks/0',
                value: {
                    name: '1.m4s',
                    selectionParams: { codec: 'hev1.1.6', mimeType: 'video/mp4', width: 3840, height: 2160, framerate: 60, bitrate: 8000000 },
                },
            },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /selection property.*prohibited/i,
        );
    });

    it('rejects whole-track replace that changes namespace (§3.3)', () => {
        const catalog = {
            version: 1,
            streamingFormat: 1,
            streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            tracks: [
                { name: 'v', namespace: 'ns-a', packaging: 'cmaf', selectionParams: { codec: 'avc1.640028' } },
            ],
        };
        const initial = parseCatalogFormat01(JSON.stringify(catalog));

        // Replace whole track — same name, different namespace
        const patch = [
            {
                op: 'replace',
                path: '/tracks/0',
                value: { name: 'v', namespace: 'ns-b', selectionParams: { codec: 'avc1.640028' } },
            },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow(
            /namespace.*prohibited/i,
        );
    });

    it('rejects malformed patch operations', () => {
        const initial = makeInitialResult();
        const patch = [
            { op: 'replace', path: '/tracks/99/name', value: 'nope' },
        ];
        expect(() => applyCf01Patch(initial.rawDocument, patch)).toThrow();
    });

    it('result rawDocument can be used for further patches', () => {
        const initial = makeInitialResult();
        // Use non-selectionParams field changes for chaining test
        const patch1 = [
            { op: 'add', path: '/tracks/0/label', value: 'HD video' },
        ];
        const result1 = applyCf01Patch(initial.rawDocument, patch1);

        const patch2 = [
            { op: 'add', path: '/tracks/1/label', value: 'Audio' },
        ];
        const result2 = applyCf01Patch(result1.rawDocument, patch2);
        expect(result2.catalog.tracks[0]!.label).toBe('HD video');
        expect(result2.catalog.tracks[1]!.label).toBe('Audio');
    });
});
