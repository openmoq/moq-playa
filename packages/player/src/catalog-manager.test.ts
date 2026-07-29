/**
 * CatalogManager tests — red/green TDD.
 *
 * Manages the catalog subscription lifecycle:
 * - Parse initial catalog via parseCatalog()
 * - Handle delta updates via isDelta() + applyCatalogUpdate()
 * - Detect broadcast completion via isComplete
 *
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-msf-00 §5.2 (Delta Updates)
 * @see draft-ietf-moq-msf-00 §9.2 (Ending a live broadcast)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { CatalogManager } from './catalog-manager.js';

/** Minimal valid independent catalog JSON. */
const CATALOG_JSON = JSON.stringify({
  version: 1,
  tracks: [
    {
      name: 'video',
      packaging: 'loc',
      isLive: true,
      role: 'video',
      renderGroup: 1,
      codec: 'av01.0.08M.10.0.110.09',
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 1_500_000,
    },
    {
      name: 'audio',
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

/** Delta update that adds a lower quality video track. */
const DELTA_ADD_JSON = JSON.stringify({
  deltaUpdate: true,
  addTracks: [
    {
      name: 'video-low',
      packaging: 'loc',
      isLive: true,
      role: 'video',
      renderGroup: 1,
      altGroup: 1,
      codec: 'av01.0.04M.10',
      width: 640,
      height: 360,
      framerate: 30,
      bitrate: 300_000,
    },
  ],
});

/** Delta update that signals broadcast complete (§9.2). */
const DELTA_COMPLETE_JSON = JSON.stringify({
  version: 1,
  isComplete: true,
  tracks: [],
});

describe('CatalogManager', () => {
  it('parses an initial independent catalog', () => {
    const mgr = new CatalogManager('live/broadcast');
    const payload = new TextEncoder().encode(CATALOG_JSON);
    const state = mgr.processCatalogObject(payload);

    expect(state.version).toBe(1);
    expect(state.tracks).toHaveLength(2);
    expect(state.tracks[0]!.name).toBe('video');
    expect(state.tracks[1]!.name).toBe('audio');
  });

  it('returns current state after initial parse', () => {
    const mgr = new CatalogManager('live/broadcast');
    const payload = new TextEncoder().encode(CATALOG_JSON);
    mgr.processCatalogObject(payload);
    expect(mgr.currentState).not.toBeNull();
    expect(mgr.currentState!.tracks).toHaveLength(2);
  });

  it('applies delta update to existing state', () => {
    const mgr = new CatalogManager('live/broadcast');
    const initial = new TextEncoder().encode(CATALOG_JSON);
    mgr.processCatalogObject(initial);

    const delta = new TextEncoder().encode(DELTA_ADD_JSON);
    const state = mgr.processCatalogObject(delta);

    expect(state.tracks).toHaveLength(3);
    expect(state.tracks.find(t => t.name === 'video-low')).toBeDefined();
  });

  it('detects isComplete to signal broadcast ended', () => {
    const mgr = new CatalogManager('live/broadcast');
    const initial = new TextEncoder().encode(CATALOG_JSON);
    mgr.processCatalogObject(initial);

    // Independent catalog with isComplete=true and empty tracks (§9.2)
    const complete = new TextEncoder().encode(DELTA_COMPLETE_JSON);
    const state = mgr.processCatalogObject(complete);

    expect(state.isComplete).toBe(true);
    expect(state.tracks).toHaveLength(0);
  });

  it('throws on delta before initial catalog', () => {
    const mgr = new CatalogManager('live/broadcast');
    const delta = new TextEncoder().encode(DELTA_ADD_JSON);
    expect(() => mgr.processCatalogObject(delta)).toThrow();
  });

  it('throws on invalid catalog JSON', () => {
    const mgr = new CatalogManager('live/broadcast');
    const payload = new TextEncoder().encode('not json');
    expect(() => mgr.processCatalogObject(payload)).toThrow();
  });

  it('inherits catalog namespace into tracks missing namespace', () => {
    const mgr = new CatalogManager('live/broadcast');
    const payload = new TextEncoder().encode(CATALOG_JSON);
    const state = mgr.processCatalogObject(payload);

    // parseCatalog with catalogNamespace fills in missing namespace
    // Tracks in CATALOG_JSON don't have explicit namespace
    expect(state.tracks[0]!.namespace).toBe('live/broadcast');
  });

  // ─── catalogformat-01 paths ──────────────────────────────────────

  it('parses cf01 catalog (has streamingFormat)', () => {
    const mgr = new CatalogManager('bbb');
    const cf01 = JSON.stringify({
      version: 1,
      streamingFormat: 1,
      streamingFormatVersion: '0.2',
      supportsDeltaUpdates: true,
      commonTrackFields: { namespace: 'bbb', packaging: 'cmaf', renderGroup: 1 },
      tracks: [
        {
          name: '1.m4s',
          initTrack: '0.mp4',
          selectionParams: {
            codec: 'avc1.640028',
            mimeType: 'video/mp4',
            width: 1280,
            height: 720,
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
    });
    const payload = new TextEncoder().encode(cf01);
    const state = mgr.processCatalogObject(payload);

    expect(state.tracks).toHaveLength(2);
    expect(state.tracks[0]!.packaging).toBe('cmaf');
    expect(state.tracks[0]!.codec).toBe('avc1.640028');
    expect(state.tracks[0]!.role).toBe('video');
    expect(state.tracks[1]!.role).toBe('audio');
  });

  it('applies cf01 JSON Patch delta (add track)', () => {
    const mgr = new CatalogManager('bbb');
    const cf01 = JSON.stringify({
      version: 1,
      streamingFormat: 1,
      streamingFormatVersion: '0.2',
      supportsDeltaUpdates: true,
      commonTrackFields: { namespace: 'bbb', packaging: 'cmaf' },
      tracks: [
        { name: '1.m4s', selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4', width: 1280, height: 720 } },
      ],
    });
    mgr.processCatalogObject(new TextEncoder().encode(cf01));

    // JSON Patch: add a new track
    const patch = JSON.stringify([
      { op: 'add', path: '/tracks/-', value: {
        name: '2.m4s',
        selectionParams: { codec: 'mp4a.40.2', mimeType: 'audio/mp4', samplerate: 44100, channelConfig: '2' },
      }},
    ]);
    const state = mgr.processCatalogObject(new TextEncoder().encode(patch));

    expect(state.tracks).toHaveLength(2);
    expect(state.tracks[1]!.name).toBe('2.m4s');
    expect(state.tracks[1]!.role).toBe('audio');
    expect(mgr.objectCount).toBe(2);
  });

  it('throws on cf01 JSON Patch before initial catalog', () => {
    const mgr = new CatalogManager('bbb');
    const patch = JSON.stringify([{ op: 'add', path: '/tracks/-', value: { name: 'new' } }]);
    expect(() => mgr.processCatalogObject(new TextEncoder().encode(patch))).toThrow(/supportsDeltaUpdates/i);
  });

  it('throws on cf01 JSON Patch when supportsDeltaUpdates was false', () => {
    const mgr = new CatalogManager('bbb');
    const cf01 = JSON.stringify({
      version: 1,
      streamingFormat: 1,
      streamingFormatVersion: '0.2',
      supportsDeltaUpdates: false,
      tracks: [{ name: 'v', packaging: 'cmaf' }],
    });
    mgr.processCatalogObject(new TextEncoder().encode(cf01));

    const patch = JSON.stringify([{ op: 'add', path: '/tracks/-', value: { name: 'new' } }]);
    expect(() => mgr.processCatalogObject(new TextEncoder().encode(patch))).toThrow(/supportsDeltaUpdates/i);
  });

  it('resets cf01 state when switching to MSF-00 format', () => {
    const mgr = new CatalogManager('ns');
    // Start with cf01
    const cf01 = JSON.stringify({
      version: 1,
      streamingFormat: 1,
      streamingFormatVersion: '0.2',
      supportsDeltaUpdates: true,
      tracks: [{ name: 'v', packaging: 'cmaf' }],
    });
    mgr.processCatalogObject(new TextEncoder().encode(cf01));

    // Switch to MSF-00
    const msf = JSON.stringify({
      version: 1,
      tracks: [{ name: 'video', packaging: 'loc', isLive: true }],
    });
    const state = mgr.processCatalogObject(new TextEncoder().encode(msf));
    expect(state.tracks[0]!.name).toBe('video');
    expect(state.tracks[0]!.packaging).toBe('loc');

    // cf01 JSON Patch should now fail (state was reset)
    const patch = JSON.stringify([{ op: 'add', path: '/tracks/-', value: { name: 'new' } }]);
    expect(() => mgr.processCatalogObject(new TextEncoder().encode(patch))).toThrow(/supportsDeltaUpdates/i);
  });

  it('reports isDelta correctly for sequential objects', () => {
    const mgr = new CatalogManager('live/broadcast');

    // First: independent
    const initial = new TextEncoder().encode(CATALOG_JSON);
    mgr.processCatalogObject(initial);
    expect(mgr.objectCount).toBe(1);

    // Second: delta
    const delta = new TextEncoder().encode(DELTA_ADD_JSON);
    mgr.processCatalogObject(delta);
    expect(mgr.objectCount).toBe(2);
  });
});

// ─── MSF-01 / CMSF-01 root-field materialization ──────────────────────

const B64_INIT = btoa('\0\0\0\x18ftyp');

/** A CMSF-01 catalog: string version, root initDataList + contentProtections. */
const CMSF01_JSON = JSON.stringify({
  version: '1',
  tracks: [
    {
      name: 'video', packaging: 'cmaf', isLive: true, role: 'video',
      codec: 'avc1.640028', initRef: 'init-video', contentProtectionRefIDs: ['1'],
    },
  ],
  initDataList: [{ id: 'init-video', type: 'inline', data: B64_INIT }],
  contentProtections: [{
    refID: '1', defaultKID: ['01234567-89ab-cdef-0123-456789abcdef'], scheme: 'cbcs',
    drmSystem: { systemID: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', pssh: 'AAAB' },
  }],
});

describe('CatalogManager — MSF-01/CMSF-01 root fields survive materialization', () => {
  it('preserves root initDataList through processCatalogObject (not dropped)', () => {
    const mgr = new CatalogManager('live/broadcast');
    const state = mgr.processCatalogObject(new TextEncoder().encode(CMSF01_JSON));
    expect(state.initDataList).toEqual([{ id: 'init-video', type: 'inline', data: B64_INIT }]);
    // The per-track initRef survives too, so the player can resolve it.
    expect(state.tracks[0]!.initRef).toBe('init-video');
  });

  it('preserves root contentProtections and per-track contentProtectionRefIDs (metadata only)', () => {
    const mgr = new CatalogManager('live/broadcast');
    const state = mgr.processCatalogObject(new TextEncoder().encode(CMSF01_JSON));
    expect(state.contentProtections).toHaveLength(1);
    expect(state.contentProtections![0]!.refID).toBe('1');
    expect(state.contentProtections![0]!.drmSystem.systemID).toBe('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
    expect(state.tracks[0]!.contentProtectionRefIDs).toEqual(['1']);
  });

  it('leaves MSF-00 catalogs without the new root fields (byte/behavior compatible)', () => {
    const mgr = new CatalogManager('live/broadcast');
    const state = mgr.processCatalogObject(new TextEncoder().encode(CATALOG_JSON));
    expect('initDataList' in state).toBe(false);
    expect('contentProtections' in state).toBe(false);
    expect('publishTracks' in state).toBe(false);
  });
});

// ─── MSF-01 op-array delta application ────────────────────────────────

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

describe('CatalogManager — MSF-01 op-array delta application', () => {
  it('applies an op-array add after an MSF-01 catalog: the track appears, root fields survive', () => {
    const mgr = new CatalogManager('live/broadcast');
    mgr.processCatalogObject(new TextEncoder().encode(CMSF01_JSON));
    const state = mgr.processCatalogObject(enc({
      deltaUpdate: [{ op: 'add', tracks: [{ name: 'video-720', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.640028', initRef: 'init-video' }] }],
    }));
    expect(state.tracks.map((t) => t.name)).toContain('video-720');
    // Root initDataList / contentProtections carried forward, so the delta-added
    // track's initRef still resolves.
    expect(state.initDataList).toHaveLength(1);
    expect(state.contentProtections).toHaveLength(1);
    expect(state.tracks.find((t) => t.name === 'video-720')!.initRef).toBe('init-video');
    expect(mgr.objectCount).toBe(2);
  });

  it('applies an op-array remove without dropping root initDataList / contentProtections', () => {
    const mgr = new CatalogManager('live/broadcast');
    mgr.processCatalogObject(new TextEncoder().encode(CMSF01_JSON));
    const state = mgr.processCatalogObject(enc({ deltaUpdate: [{ op: 'remove', tracks: [{ name: 'video' }] }] }));
    expect(state.tracks).toHaveLength(0);
    expect(state.initDataList).toHaveLength(1);
    expect(state.contentProtections).toHaveLength(1);
  });

  it('rejects an op-array delta introducing a dangling initRef', () => {
    const mgr = new CatalogManager('live/broadcast');
    mgr.processCatalogObject(new TextEncoder().encode(CMSF01_JSON));
    expect(() => mgr.processCatalogObject(enc({
      deltaUpdate: [{ op: 'add', tracks: [{ name: 'bad', packaging: 'cmaf', isLive: true, initRef: 'nope' }] }],
    }))).toThrow(/unknown initDataList/i);
  });

  it('rejects an op-array delta received before any base catalog (§9.1)', () => {
    const mgr = new CatalogManager('live/broadcast');
    expect(() => mgr.processCatalogObject(enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'v', packaging: 'loc', isLive: true }] }] })))
      .toThrow(/before initial catalog/i);
  });

  it('keeps dialect separation: deltaUpdate:true still routes to the MSF-00 grouped path', () => {
    const mgr = new CatalogManager('live/broadcast');
    mgr.processCatalogObject(new TextEncoder().encode(CATALOG_JSON));
    const state = mgr.processCatalogObject(new TextEncoder().encode(DELTA_ADD_JSON));
    // MSF-00 grouped add still works and did not go through the op-array path.
    expect(state.tracks.map((t) => t.name)).toContain('video-low');
  });
});

// ─── Location-aware API for catalog bootstrap ────────────────────────

describe('CatalogManager.reset()', () => {
    it('clears state, object count, and cf01 patch context', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObject(enc(({
            version: 1, streamingFormat: 1, streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            tracks: [{ name: 'video', packaging: 'loc', renderGroup: 1, isLive: true }],
        })));
        expect(mgr.currentState).not.toBeNull();
        expect(mgr.objectCount).toBe(1);

        mgr.reset();
        expect(mgr.currentState).toBeNull();
        expect(mgr.objectCount).toBe(0);
        // cf01 patch context cleared: a patch now throws "before initial", it is
        // not applied against the pre-reset base.
        expect(() => mgr.processCatalogObject(enc(([
            { op: 'remove', path: '/tracks/0' },
        ])))).toThrow(/initial catalog|delta update support/i);
        // …and an independent re-parses from scratch.
        const state = mgr.processCatalogObject(enc(({
            version: 1, tracks: [{ name: 'audio', packaging: 'loc', renderGroup: 1, isLive: true }],
        })));
        expect(state.tracks.map((t) => t.name)).toEqual(['audio']);
    });
});

describe('CatalogManager.processCatalogObjectAt (exact-location dedup)', () => {
    const indep = () => enc(({
        version: 1, tracks: [
            { name: 'video', packaging: 'loc', renderGroup: 1, isLive: true },
        ],
    }));
    const addDelta = (name: string) => enc(({
        deltaUpdate: [{ op: 'add', tracks: [{ name, packaging: 'loc', renderGroup: 1, isLive: true }] }],
    }));

    it('dedup entries are NEVER evicted by age — an old location still deduplicates after thousands of applies (CF-01 replay safety)', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 0n, object: 0n }, indep());
        for (let g = 1; g < 1500; g++) {
            mgr.processCatalogObjectAt({ group: BigInt(g), object: 0n }, indep());
        }
        // A replayed patch/delta at the very first location must still be a
        // no-op — re-applying it positionally would corrupt a CF-01 document.
        expect(mgr.processCatalogObjectAt({ group: 0n, object: 0n }, addDelta('boom')).outcome).toBe('duplicate');
    });

    it('repeated SAME-GROUP heads cannot creep past capacity — the prune must actually free before the guard admits', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 8n, object: 0n }, indep());
        const locations = (mgr as unknown as { appliedLocations: Set<string> }).appliedLocations;
        for (let i = locations.size; i < 65_536; i++) locations.add(`8:${i + 1000}`);
        // A same-group "head": pruneBeforeOnSuccess(8) frees NOTHING — the
        // guard must refuse, not admit and grow the set to 65,537.
        expect(() => mgr.processCatalogObjectAt(
            { group: 8n, object: 500_000n }, indep(), { pruneBeforeOnSuccess: 8n },
        )).toThrow(/capacity/);
        expect(locations.size).toBe(65_536);
        // A NEWER-group head genuinely frees → admitted.
        expect(mgr.processCatalogObjectAt(
            { group: 9n, object: 0n }, indep(), { pruneBeforeOnSuccess: 9n },
        ).outcome).toBe('applied');
        expect(locations.size).toBe(1);
    });

    it('prune-on-success is ATOMIC — a failed replacement base leaves replay protection intact', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 0n, object: 0n }, indep());
        mgr.processCatalogObjectAt({ group: 0n, object: 1n }, addDelta('a'));
        // A replacement independent that FAILS to parse must not have pruned.
        expect(() => mgr.processCatalogObjectAt(
            { group: 8n, object: 0n }, new TextEncoder().encode('{broken'),
            { pruneBeforeOnSuccess: 8n },
        )).toThrow();
        expect(mgr.processCatalogObjectAt({ group: 0n, object: 1n }, addDelta('a')).outcome).toBe('duplicate');
        // A VALID replacement applies AND prunes atomically.
        expect(mgr.processCatalogObjectAt(
            { group: 8n, object: 0n }, indep(), { pruneBeforeOnSuccess: 8n },
        ).outcome).toBe('applied');
        const locations = (mgr as unknown as { appliedLocations: Set<string> }).appliedLocations;
        expect([...locations]).toEqual(['8:0']);
    });

    it('the dedup fails CLOSED at capacity and recovers via prune — never evicts by age', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 0n, object: 0n }, indep());
        // Fill to capacity cheaply (the guard counts entries, not history).
        const locations = (mgr as unknown as { appliedLocations: Set<string> }).appliedLocations;
        for (let i = locations.size; i < 65_536; i++) locations.add(`0:${i + 1000}`);
        // At capacity, a NEW location REFUSES (throw) instead of evicting old
        // duplicate knowledge…
        expect(() => mgr.processCatalogObjectAt({ group: 7n, object: 0n }, indep())).toThrow(/capacity/);
        // …and a duplicate still deduplicates (no age loss).
        expect(mgr.processCatalogObjectAt({ group: 0n, object: 0n }, indep()).outcome).toBe('duplicate');
        // A provable prune (new independent head) restores capacity.
        mgr.pruneLocationsBefore(7n);
        expect(mgr.processCatalogObjectAt({ group: 7n, object: 0n }, indep()).outcome).toBe('applied');
    });

    it('pruneLocationsBefore removes only PROVABLY OBSOLETE groups (below a new independent head)', () => {
        const mgr = new CatalogManager('live/test');
        for (let g = 0; g < 10; g++) {
            mgr.processCatalogObjectAt({ group: BigInt(g), object: 0n }, indep());
        }
        mgr.pruneLocationsBefore(8n);
        const locations = (mgr as unknown as { appliedLocations: Set<string> }).appliedLocations;
        expect(locations.size).toBe(2);                 // groups 8 and 9 retained
        expect(mgr.processCatalogObjectAt({ group: 9n, object: 0n }, indep()).outcome).toBe('duplicate');
        expect(mgr.processCatalogObjectAt({ group: 8n, object: 0n }, indep()).outcome).toBe('duplicate');
    });

    it('applies a fresh location and reports it', () => {
        const mgr = new CatalogManager('live/test');
        const r1 = mgr.processCatalogObjectAt({ group: 0n, object: 0n }, indep());
        expect(r1.outcome).toBe('applied');
        expect((r1 as { state: { tracks: unknown[] } }).state.tracks).toHaveLength(1);
        expect(mgr.lastApplied).toEqual({ group: 0n, object: 0n });
        expect(mgr.latestGroup).toBe(0n);
    });

    it('a duplicate exact location is a NO-OP, never a throw — deltas included', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 0n, object: 0n }, indep());
        const d1 = mgr.processCatalogObjectAt({ group: 0n, object: 1n }, addDelta('audio'));
        expect(d1.outcome).toBe('applied');
        // Replaying the SAME delta at the SAME location must not throw
        // "track already exists" — it is a duplicate, not a conflict.
        const d2 = mgr.processCatalogObjectAt({ group: 0n, object: 1n }, addDelta('audio'));
        expect(d2.outcome).toBe('duplicate');
        expect(mgr.currentState!.tracks).toHaveLength(2);
    });

    it('cf01 JSON Patch replay no longer corrupts (duplicate → no-op)', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 0n, object: 0n }, enc(({
            version: 1, streamingFormat: 1, streamingFormatVersion: '0.2',
            supportsDeltaUpdates: true,
            tracks: [
                { name: 'a', packaging: 'loc', renderGroup: 1, isLive: true },
                { name: 'b', packaging: 'loc', renderGroup: 1, isLive: true },
            ],
        })));
        const patch = enc(([{ op: 'remove', path: '/tracks/0' }]));
        const p1 = mgr.processCatalogObjectAt({ group: 0n, object: 1n }, patch);
        expect(p1.outcome).toBe('applied');
        expect(mgr.currentState!.tracks.map((t) => t.name)).toEqual(['b']);
        // The replay is positionally destructive if applied twice — must no-op.
        const p2 = mgr.processCatalogObjectAt({ group: 0n, object: 1n }, patch);
        expect(p2.outcome).toBe('duplicate');
        expect(mgr.currentState!.tracks.map((t) => t.name)).toEqual(['b']);
    });

    it('reset() clears the dedup set and location trackers', () => {
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObjectAt({ group: 3n, object: 0n }, indep());
        mgr.reset();
        expect(mgr.latestGroup).toBeNull();
        expect(mgr.lastApplied).toBeNull();
        const r = mgr.processCatalogObjectAt({ group: 3n, object: 0n }, indep());
        expect(r.outcome).toBe('applied');   // not 'duplicate' — dedup was cleared
    });

    it('processCatalogObject (payload-only) behavior is unchanged', () => {
        // Legacy callers keep exact semantics incl. duplicate-delta throws.
        const mgr = new CatalogManager('live/test');
        mgr.processCatalogObject(indep());
        mgr.processCatalogObject(addDelta('audio'));
        expect(() => mgr.processCatalogObject(addDelta('audio'))).toThrow(/already exists/);
    });
});
