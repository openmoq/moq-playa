/**
 * Tests for parseCatalogAuto() — format auto-detection dispatcher.
 *
 * @see catalog-detect.ts
 */

import { describe, it, expect } from 'vitest';
import { parseCatalogAuto } from './catalog-detect.js';

describe('parseCatalogAuto', () => {
    it('routes MSF-00 catalog (no streamingFormat) to MSF parser', () => {
        const json = JSON.stringify({
            version: 1,
            tracks: [
                { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f' },
            ],
        });
        const catalog = parseCatalogAuto(json);
        expect(catalog.version).toBe(1);
        expect(catalog.tracks[0]!.name).toBe('video');
    });

    it('routes cf01 catalog (has streamingFormat) to cf01 parser', () => {
        const json = JSON.stringify({
            version: 1,
            streamingFormat: 1,
            commonTrackFields: { packaging: 'cmaf', namespace: 'ns' },
            tracks: [
                {
                    name: '1.m4s',
                    selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4', width: 1280, height: 720 },
                },
            ],
        });
        const catalog = parseCatalogAuto(json);
        expect(catalog.tracks[0]!.codec).toBe('avc1.640028');
        expect(catalog.tracks[0]!.packaging).toBe('cmaf');
    });

    it('routes cf01 catalog WITHOUT commonTrackFields but with streamingFormat', () => {
        const json = JSON.stringify({
            version: 1,
            streamingFormat: 1,
            tracks: [
                { name: 'video', namespace: 'live', packaging: 'loc' },
            ],
        });
        const catalog = parseCatalogAuto(json);
        expect(catalog.tracks[0]!.namespace).toBe('live');
    });

    it('throws on invalid JSON', () => {
        expect(() => parseCatalogAuto('not json')).toThrow();
    });

    it('throws on array input (JSON Patch, not independent catalog)', () => {
        expect(() => parseCatalogAuto('[{"op":"add"}]')).toThrow(/array/i);
    });

    it('both formats produce valid Catalog with CatalogTrack[]', () => {
        const msf = parseCatalogAuto(JSON.stringify({
            version: 1,
            tracks: [{ name: 'v', packaging: 'loc', isLive: true }],
        }));
        expect(msf.tracks).toBeInstanceOf(Array);

        const cf01 = parseCatalogAuto(JSON.stringify({
            version: 1,
            streamingFormat: 1,
            tracks: [{ name: 'v', packaging: 'loc' }],
        }));
        expect(cf01.tracks).toBeInstanceOf(Array);
    });

    it('accepts Uint8Array input', () => {
        const bytes = new TextEncoder().encode(JSON.stringify({
            version: 1,
            tracks: [{ name: 'v', packaging: 'loc', isLive: true }],
        }));
        const catalog = parseCatalogAuto(bytes);
        expect(catalog.tracks).toHaveLength(1);
    });
});
