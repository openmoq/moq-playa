/**
 * Tests for parseDeltaUpdate() and applyCatalogUpdate().
 *
 * Test vectors drawn from draft-ietf-moq-msf-00 §5.3.4, §5.3.5.
 * Validation rules from §5.2.
 *
 * @see draft-ietf-moq-msf-00 §5.2
 */

import { describe, it, expect } from 'vitest';
import { parseDeltaUpdate, applyCatalogUpdate } from './delta.js';
import { parseCatalog } from './catalog.js';
import { isDelta } from './catalog.js';
import type { CatalogState, CatalogDelta, CatalogObject } from './types.js';

// ─── Spec example deltas (§5.3) ─────────────────────────────────────

/** §5.3.4: Delta update - adding two tracks (add + clone) */
const EXAMPLE_ADD_CLONE = JSON.stringify({
    deltaUpdate: true,
    generatedAt: 1746104606044,
    addTracks: [
        {
            name: 'slides',
            isLive: true,
            role: 'video',
            codec: 'av01.0.08M.10.0.110.09',
            width: 1920,
            height: 1080,
            framerate: 15,
            bitrate: 750000,
            renderGroup: 1,
            packaging: 'loc',
        },
    ],
    cloneTracks: [
        {
            parentName: 'video-1080',
            name: 'video-720',
            width: 1280,
            height: 720,
            bitrate: 600000,
        },
    ],
});

/** §5.3.5: Delta update removing tracks */
const EXAMPLE_REMOVE = JSON.stringify({
    deltaUpdate: true,
    generatedAt: 1746104606044,
    removeTracks: [{ name: 'video' }, { name: 'slides' }],
});

// ─── Helper: create a base catalog state ─────────────────────────────

function makeBaseState(): CatalogState {
    return {
        version: 1,
        tracks: [
            {
                name: 'video-1080',
                namespace: 'live.example.com/broadcast',
                packaging: 'loc',
                isLive: true,
                role: 'video',
                codec: 'av01.0.08M.10.0.110.09',
                width: 1920,
                height: 1080,
                bitrate: 5000000,
                framerate: 30,
                renderGroup: 1,
                altGroup: 1,
            },
            {
                name: 'audio',
                namespace: 'live.example.com/broadcast',
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
        generatedAt: 1746104600000,
    };
}

// ─── parseDeltaUpdate tests ──────────────────────────────────────────

describe('parseDeltaUpdate', () => {
    it('parses §5.3.4 — addTracks + cloneTracks delta', () => {
        const delta = parseDeltaUpdate(EXAMPLE_ADD_CLONE);
        expect(delta.deltaUpdate).toBe(true);
        expect(delta.generatedAt).toBe(1746104606044);
        expect(delta.addTracks).toHaveLength(1);
        expect(delta.addTracks![0]!.name).toBe('slides');
        expect(delta.cloneTracks).toHaveLength(1);
        expect(delta.cloneTracks![0]!.parentName).toBe('video-1080');
        expect(delta.cloneTracks![0]!.name).toBe('video-720');
    });

    it('parses §5.3.5 — removeTracks delta', () => {
        const delta = parseDeltaUpdate(EXAMPLE_REMOVE);
        expect(delta.deltaUpdate).toBe(true);
        expect(delta.removeTracks).toHaveLength(2);
        expect(delta.removeTracks![0]!.name).toBe('video');
        expect(delta.removeTracks![1]!.name).toBe('slides');
    });

    it('accepts Uint8Array input', () => {
        const bytes = new TextEncoder().encode(EXAMPLE_REMOVE);
        const delta = parseDeltaUpdate(bytes);
        expect(delta.deltaUpdate).toBe(true);
    });

    // ─── Validation errors ───────────────────────────────────────────

    it('rejects delta without deltaUpdate: true (§5.2)', () => {
        const json = JSON.stringify({ addTracks: [] });
        expect(() => parseDeltaUpdate(json)).toThrow(/deltaUpdate/i);
    });

    it('rejects delta with version field (§5.2)', () => {
        const json = JSON.stringify({
            deltaUpdate: true,
            version: 1,
            addTracks: [{ name: 'x', packaging: 'loc', isLive: true }],
        });
        expect(() => parseDeltaUpdate(json)).toThrow(/version/i);
    });

    it('rejects delta with tracks field (§5.2)', () => {
        const json = JSON.stringify({
            deltaUpdate: true,
            tracks: [],
            addTracks: [{ name: 'x', packaging: 'loc', isLive: true }],
        });
        expect(() => parseDeltaUpdate(json)).toThrow(/tracks/i);
    });

    it('rejects delta with no operations (§5.2)', () => {
        const json = JSON.stringify({ deltaUpdate: true });
        expect(() => parseDeltaUpdate(json)).toThrow(/at least one/i);
    });

    it('rejects removeTracks entry with extra fields (§5.1.4)', () => {
        const json = JSON.stringify({
            deltaUpdate: true,
            removeTracks: [{ name: 'video', codec: 'av01' }],
        });
        expect(() => parseDeltaUpdate(json)).toThrow(/removeTracks/i);
    });

    it('rejects cloneTracks entry without parentName (§5.1.5)', () => {
        const json = JSON.stringify({
            deltaUpdate: true,
            cloneTracks: [{ name: 'video-720', width: 1280, height: 720 }],
        });
        expect(() => parseDeltaUpdate(json)).toThrow(/parentName/i);
    });

    it('rejects invalid JSON', () => {
        expect(() => parseDeltaUpdate('not json')).toThrow();
    });
});

// ─── applyCatalogUpdate tests ────────────────────────────────────────

describe('applyCatalogUpdate', () => {
    it('applies addTracks — adds new tracks to state', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [
                { name: 'slides', packaging: 'loc', isLive: true, role: 'video' },
            ],
        };

        const result = applyCatalogUpdate(base, delta, 'live.example.com/broadcast');
        expect(result.tracks).toHaveLength(3);
        expect(result.tracks.find(t => t.name === 'slides')).toBeDefined();
    });

    it('applies removeTracks — removes tracks by name + namespace', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            removeTracks: [{ name: 'audio' }],
        };

        const result = applyCatalogUpdate(base, delta, 'live.example.com/broadcast');
        expect(result.tracks).toHaveLength(1);
        expect(result.tracks[0]!.name).toBe('video-1080');
    });

    it('applies removeTracks with explicit namespace', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            removeTracks: [{ name: 'audio', namespace: 'live.example.com/broadcast' }],
        };

        const result = applyCatalogUpdate(base, delta);
        expect(result.tracks).toHaveLength(1);
    });

    it('applies cloneTracks — clones parent with overrides', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            cloneTracks: [
                {
                    parentName: 'video-1080',
                    name: 'video-720',
                    width: 1280,
                    height: 720,
                    bitrate: 600000,
                    packaging: 'loc',
                    isLive: true,
                },
            ],
        };

        const result = applyCatalogUpdate(base, delta, 'live.example.com/broadcast');
        expect(result.tracks).toHaveLength(3);

        const clone = result.tracks.find(t => t.name === 'video-720');
        expect(clone).toBeDefined();
        // Overridden fields
        expect(clone!.width).toBe(1280);
        expect(clone!.height).toBe(720);
        expect(clone!.bitrate).toBe(600000);
        // Inherited fields
        expect(clone!.codec).toBe('av01.0.08M.10.0.110.09');
        expect(clone!.framerate).toBe(30);
        expect(clone!.role).toBe('video');
        expect(clone!.namespace).toBe('live.example.com/broadcast');
        expect(clone!.renderGroup).toBe(1);
        expect(clone!.altGroup).toBe(1);
    });

    it('clone inherits all parent attributes except name (§5.2)', () => {
        const base: CatalogState = {
            version: 1,
            tracks: [
                {
                    name: 'original',
                    packaging: 'loc',
                    isLive: true,
                    namespace: 'ns',
                    role: 'video',
                    codec: 'av01',
                    width: 1920,
                    height: 1080,
                    bitrate: 5000000,
                    framerate: 30,
                    label: 'Original HD',
                    renderGroup: 1,
                    altGroup: 1,
                    targetLatency: 2000,
                },
            ],
        };

        const delta: CatalogDelta = {
            deltaUpdate: true,
            cloneTracks: [
                { parentName: 'original', name: 'clone', packaging: 'loc', isLive: true },
            ],
        };

        const result = applyCatalogUpdate(base, delta);
        const clone = result.tracks.find(t => t.name === 'clone')!;

        // Name is new
        expect(clone.name).toBe('clone');
        // All other attributes inherited
        expect(clone.namespace).toBe('ns');
        expect(clone.role).toBe('video');
        expect(clone.codec).toBe('av01');
        expect(clone.width).toBe(1920);
        expect(clone.height).toBe(1080);
        expect(clone.bitrate).toBe(5000000);
        expect(clone.framerate).toBe(30);
        expect(clone.label).toBe('Original HD');
        expect(clone.renderGroup).toBe(1);
        expect(clone.altGroup).toBe(1);
        expect(clone.targetLatency).toBe(2000);
    });

    it('rejects clone with non-existent parent', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            cloneTracks: [
                { parentName: 'nonexistent', name: 'clone', packaging: 'loc', isLive: true },
            ],
        };

        expect(() => applyCatalogUpdate(base, delta)).toThrow(/parent/i);
    });

    it('rejects adding duplicate track name (§5.1.11)', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [
                {
                    name: 'video-1080',
                    namespace: 'live.example.com/broadcast',
                    packaging: 'loc',
                    isLive: true,
                },
            ],
        };

        expect(() => applyCatalogUpdate(base, delta)).toThrow(/duplicate|unique|exists/i);
    });

    it('operations applied sequentially — add then remove (§5.2)', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [
                {
                    name: 'temp',
                    namespace: 'live.example.com/broadcast',
                    packaging: 'loc',
                    isLive: true,
                },
            ],
            removeTracks: [{ name: 'temp', namespace: 'live.example.com/broadcast' }],
        };

        const result = applyCatalogUpdate(base, delta);
        // temp was added then removed — should not be in final state
        expect(result.tracks.find(t => t.name === 'temp')).toBeUndefined();
        expect(result.tracks).toHaveLength(2);
    });

    it('rejects add with existing namespace+name tuple — immutability (§5.2)', () => {
        const base = makeBaseState();
        // First add a track, then remove it, then try to add it back with different props
        // Actually per §5.2: "The tuple of Track Namespace and Track Name defines a
        // fixed set of Track attributes which MUST NOT be modified after being declared."
        // This means you can't add a track with the same namespace+name as an existing one.
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [
                {
                    name: 'audio',
                    namespace: 'live.example.com/broadcast',
                    packaging: 'loc',
                    isLive: true,
                },
            ],
        };

        expect(() => applyCatalogUpdate(base, delta)).toThrow(/duplicate|unique|exists/i);
    });

    it('updates generatedAt from delta', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            generatedAt: 9999999999999,
            addTracks: [
                { name: 'new', packaging: 'loc', isLive: true },
            ],
        };

        const result = applyCatalogUpdate(base, delta, 'live.example.com/broadcast');
        expect(result.generatedAt).toBe(9999999999999);
    });

    it('preserves version and isComplete from base state', () => {
        const base: CatalogState = {
            version: 1,
            tracks: [],
            isComplete: true,
        };
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [{ name: 'x', packaging: 'loc', isLive: true }],
        };

        const result = applyCatalogUpdate(base, delta, 'ns');
        expect(result.version).toBe(1);
        expect(result.isComplete).toBe(true);
    });

    it('namespace inheritance applies to addTracks', () => {
        const base: CatalogState = { version: 1, tracks: [] };
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [{ name: 'video', packaging: 'loc', isLive: true }],
        };

        const result = applyCatalogUpdate(base, delta, 'default/ns');
        expect(result.tracks[0]!.namespace).toBe('default/ns');
    });

    // ─── §5.1.7: isComplete persistence across deltas ─────────────────

    it('preserves isComplete=true through delta — MUST NOT be removed (§5.1.7)', () => {
        const base: CatalogState = {
            version: 1,
            tracks: [{ name: 'video', packaging: 'loc', isLive: true }],
            isComplete: true,
        };
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [{ name: 'audio', packaging: 'loc', isLive: true }],
        };

        const result = applyCatalogUpdate(base, delta, 'ns');
        expect(result.isComplete).toBe(true);
    });

    // ─── Combined delta: all 3 operations ─────────────────────────────

    it('applies all 3 operations in one delta — add + remove + clone (§5.2)', () => {
        const base: CatalogState = {
            version: 1,
            tracks: [
                {
                    name: 'video-1080',
                    namespace: 'ns',
                    packaging: 'loc',
                    isLive: true,
                    codec: 'av01',
                    width: 1920,
                    height: 1080,
                    bitrate: 5000000,
                },
                {
                    name: 'old-audio',
                    namespace: 'ns',
                    packaging: 'loc',
                    isLive: true,
                    codec: 'opus',
                    bitrate: 32000,
                },
            ],
        };

        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [
                { name: 'new-audio', packaging: 'loc', isLive: true, codec: 'opus', bitrate: 64000 },
            ],
            removeTracks: [{ name: 'old-audio' }],
            cloneTracks: [
                {
                    parentName: 'video-1080',
                    name: 'video-720',
                    width: 1280,
                    height: 720,
                    bitrate: 2500000,
                    packaging: 'loc',
                    isLive: true,
                },
            ],
        };

        const result = applyCatalogUpdate(base, delta, 'ns');
        // Original video stays
        expect(result.tracks.find(t => t.name === 'video-1080')).toBeDefined();
        // old-audio removed
        expect(result.tracks.find(t => t.name === 'old-audio')).toBeUndefined();
        // new-audio added
        expect(result.tracks.find(t => t.name === 'new-audio')).toBeDefined();
        expect(result.tracks.find(t => t.name === 'new-audio')!.bitrate).toBe(64000);
        // video-720 cloned from video-1080
        const clone = result.tracks.find(t => t.name === 'video-720');
        expect(clone).toBeDefined();
        expect(clone!.codec).toBe('av01'); // inherited
        expect(clone!.width).toBe(1280); // overridden
        expect(clone!.bitrate).toBe(2500000); // overridden
        // Total: video-1080, new-audio, video-720 = 3
        expect(result.tracks).toHaveLength(3);
    });

    // ─── §5.2: Remove of nonexistent track ───────────────────────────

    it('rejects removeTracks referencing a track that was never declared (§5.2)', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            removeTracks: [{ name: 'nonexistent' }],
        };
        // §5.2: "Remove a track that has been previously declared"
        // Removing a never-declared track cannot be "successfully applied"
        expect(() => applyCatalogUpdate(base, delta, 'live.example.com/broadcast'))
            .toThrow(/not found|does not exist|nonexistent/i);
    });

    it('rejects removeTracks referencing wrong namespace (§5.2)', () => {
        const base: CatalogState = {
            version: 1,
            tracks: [
                { name: 'video', namespace: 'ns1', packaging: 'loc', isLive: true },
            ],
        };
        const delta: CatalogDelta = {
            deltaUpdate: true,
            removeTracks: [{ name: 'video', namespace: 'ns2' }],
        };
        // "video" exists in ns1, but not in ns2
        expect(() => applyCatalogUpdate(base, delta))
            .toThrow(/not found|does not exist/i);
    });

    it('succeeds when removeTracks references an existing track (§5.2)', () => {
        const base = makeBaseState();
        const delta: CatalogDelta = {
            deltaUpdate: true,
            removeTracks: [{ name: 'audio' }],
        };
        const result = applyCatalogUpdate(base, delta, 'live.example.com/broadcast');
        expect(result.tracks.find(t => t.name === 'audio')).toBeUndefined();
        expect(result.tracks).toHaveLength(1); // only video remains
    });
});

// ─── isDelta() type guard ─────────────────────────────────────────────

describe('isDelta()', () => {
    it('returns true for a CatalogDelta object', () => {
        const delta: CatalogDelta = {
            deltaUpdate: true,
            addTracks: [{ name: 'x', packaging: 'loc', isLive: true }],
        };
        expect(isDelta(delta)).toBe(true);
    });

    it('returns false for an independent Catalog', () => {
        const catalog: CatalogObject = {
            version: 1,
            tracks: [{ name: 'video', packaging: 'loc', isLive: true }],
        };
        expect(isDelta(catalog)).toBe(false);
    });

    it('narrows type — delta branch has deltaUpdate', () => {
        const obj: CatalogObject = {
            deltaUpdate: true,
            addTracks: [{ name: 'a', packaging: 'loc', isLive: true }],
        };
        if (isDelta(obj)) {
            // TypeScript should narrow to CatalogDelta
            expect(obj.deltaUpdate).toBe(true);
            expect(obj.addTracks).toBeDefined();
        } else {
            throw new Error('Expected isDelta to return true');
        }
    });

    it('narrows type — catalog branch has version and tracks', () => {
        const obj: CatalogObject = {
            version: 1,
            tracks: [{ name: 'v', packaging: 'loc', isLive: true }],
        };
        if (!isDelta(obj)) {
            // TypeScript should narrow to Catalog
            expect(obj.version).toBe(1);
            expect(obj.tracks).toHaveLength(1);
        } else {
            throw new Error('Expected isDelta to return false');
        }
    });
});
