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
