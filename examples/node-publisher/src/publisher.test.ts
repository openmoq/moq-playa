import { describe, expect, it, vi } from 'vitest';
import { parseCatalogAuto, parseMsf01Delta, applyMsf01Delta } from '@moqt/msf';
import type { MoqtConnection } from '@moqt/webtransport';
import type { LoadedFixture } from './fixture.js';
import { buildFixtureCatalog, buildFixtureDelta, publishFixture } from './publisher.js';

const fixture = (tracks: LoadedFixture['tracks']): LoadedFixture => ({
  manifest: {
    namespace: ['demo'],
    renderGroup: 1,
    chunkDurationMs: 500,
    tracks: tracks.map((t) => t.meta),
  },
  tracks,
});

const videoFixture = (): LoadedFixture => fixture([
  {
    meta: {
      name: 'video-1080',
      packaging: 'cmaf',
      role: 'video',
      codec: 'avc1.640028',
      init: 'init.mp4',
      chunks: ['chunk-000.m4s'],
      width: 1920,
      height: 1080,
      bitrate: 2_500_000,
    },
    initData: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    chunks: [new Uint8Array([1, 2, 3])],
  },
]);

const audioOnlyFixture = (): LoadedFixture => fixture([
  {
    meta: {
      name: 'audio-en',
      packaging: 'cmaf',
      role: 'audio',
      codec: 'mp4a.40.2',
      init: 'init.mp4',
      chunks: ['chunk-000.m4s'],
      samplerate: 48_000,
      channelConfig: '2',
    },
    initData: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    chunks: [new Uint8Array([1, 2, 3])],
  },
]);

describe('node-publisher CMSF-01 catalog helpers', () => {
  it('emits string version, root initDataList, and per-track initRef without inline initData', () => {
    const bytes = buildFixtureCatalog(videoFixture(), 'cmsf-01');
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    expect(raw.version).toBe('1');
    expect(raw.initDataList).toEqual([
      { id: 'video-1080-init', type: 'inline', data: 'AAAAGGZ0eXA=' },
    ]);
    expect(raw.tracks).toHaveLength(1);
    expect(raw.tracks[0].initRef).toBe('video-1080-init');
    expect('initData' in raw.tracks[0]).toBe(false);

    const parsed = parseCatalogAuto(bytes);
    expect(parsed.tracks[0]!.initRef).toBe('video-1080-init');
    expect(parsed.initDataList).toHaveLength(1);
  });

  it('keeps the default MSF-00 catalog shape inline and root-list free', () => {
    const raw = JSON.parse(new TextDecoder().decode(buildFixtureCatalog(videoFixture())));
    expect(raw.version).toBe(1);
    expect(raw.tracks[0].initData).toBe('AAAAGGZ0eXA=');
    expect('initRef' in raw.tracks[0]).toBe(false);
    expect('initDataList' in raw).toBe(false);
  });

  it('builds a clone delta that applies against the emitted CMSF-01 catalog', () => {
    const base = parseCatalogAuto(buildFixtureCatalog(videoFixture(), 'cmsf-01'));
    const deltaBytes = buildFixtureDelta(videoFixture());
    expect(deltaBytes).not.toBeNull();
    const next = applyMsf01Delta(
      { ...base, tracks: [...base.tracks] },
      parseMsf01Delta(deltaBytes!),
    );
    const cloned = next.tracks.find((t) => t.name === 'video-1080-alt');
    expect(cloned?.initRef).toBe('video-1080-init');
    expect(cloned?.altGroup).toBe(9);
  });

  it('fails before publishing anything when --emit-delta is requested for an audio-only fixture', async () => {
    const conn = {
      publish: vi.fn(async () => 1n),
    } as unknown as MoqtConnection;
    await expect(publishFixture(conn, audioOnlyFixture(), { deltaAfterMs: 0 }))
      .rejects.toThrow(/no video track/i);
    expect(conn.publish).not.toHaveBeenCalled();
  });
});
