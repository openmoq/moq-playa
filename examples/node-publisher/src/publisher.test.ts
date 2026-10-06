import { describe, expect, it, vi } from 'vitest';
import { parseCatalogAuto, parseMsf01Delta, applyMsf01Delta } from '@openmoq/msf';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { LoadedFixture } from './fixture.js';
import { buildFixtureCatalog, buildFixtureDelta, publishFixture } from './publisher.js';
import { videoInit, audioInit, buildInit, buildChunk, SYNC_FLAGS } from '../../../packages/locmaf/test-support/cmaf.js';

const fixture = (tracks: LoadedFixture['tracks']): LoadedFixture => ({
  manifest: {
    namespace: ['demo'],
    renderGroup: 1,
    chunkDurationMs: 500,
    tracks: tracks.map((t) => t.meta),
  },
  tracks,
});

function connection() {
  const sent: { stream: number; alias: bigint; group: bigint; object: bigint; time: number }[] = [];
  const streams = new Map<number, { alias: bigint; group: bigint; subgroup: bigint }>();
  const opens: { stream: number; subgroup: bigint; firstObject: boolean; endOfGroup: boolean }[] = [];
  const closed: number[] = [];
  let request = 0n;
  const conn = {
    onMessage: undefined as ((m: { type: string; requestId: bigint }) => void) | undefined,
    async publish() { const id = request++; setTimeout(() => conn.onMessage?.({ type: 'REQUEST_OK', requestId: id }), 0); return id; },
    async openSubgroup(alias: bigint, group: bigint, subgroup: bigint, options: { firstObject?: boolean; endOfGroup?: boolean }) {
      const stream = streams.size + 1; streams.set(stream, { alias, group, subgroup });
      opens.push({ stream, subgroup, firstObject: !!options.firstObject, endOfGroup: !!options.endOfGroup });
      return stream;
    },
    async sendObject(stream: number, object: bigint) {
      const identity = streams.get(stream)!;
      sent.push({ stream, alias: identity.alias, group: identity.group, object, time: performance.now() });
    },
    async closeSubgroup(stream: number) { closed.push(stream); },
  };
  return { conn: conn as unknown as MoqtConnection, sent, opens, closed };
}

const timedFixture = (): LoadedFixture => fixture([
  {
    meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
    initData: videoInit(),
    chunks: [0, 90000].map((bmdt) => buildChunk({ bmdt, samples: [{ duration: 90000, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8) })),
  },
  {
    meta: { name: 'audio', packaging: 'cmaf', role: 'audio', codec: 'mp4a.40.2', init: 'init.mp4', chunks: [] },
    initData: audioInit(),
    chunks: [0, 24000, 48000, 72000].map((bmdt) => buildChunk({ trackId: 2, bmdt, samples: [{ duration: 24000, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8) })),
  },
]);

describe('CMSF-01 media stream mapping and pacing', () => {
  it('sends each object on its own stream and closes every stream', async () => {
    const f = fixture([{ ...videoFixture().tracks[0]!, chunks: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])] }]);
    const recorded = connection();
    await publishFixture(recorded.conn, f, { catalogFormat: 'cmsf-01', loops: 2 });
    expect(new Set(recorded.sent.map((s) => s.stream)).size).toBe(recorded.sent.length);
    expect(recorded.closed).toEqual(recorded.opens.map((s) => s.stream));
    const media = recorded.opens.slice(1);
    expect(media.map((s) => s.subgroup)).toEqual([0n, 1n, 2n, 0n, 1n, 2n]);
    expect(media.every((s) => s.firstObject)).toBe(true);
    expect(media.map((s) => s.endOfGroup)).toEqual([false, false, true, false, false, true]);
  });

  it('also maps legacy-catalog objects to separate streams as MSF-00 section 6 requires', async () => {
    const f = fixture([{ ...videoFixture().tracks[0]!, chunks: [new Uint8Array([1]), new Uint8Array([2])] }]);
    const recorded = connection(); await publishFixture(recorded.conn, f);
    expect(recorded.opens).toHaveLength(3);
    expect(recorded.sent.slice(1).map((s) => s.stream)).toEqual([2, 3]);
  });

  it('paces unequal track durations from timestamps including the loop seam', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const recorded = connection();
      const publishing = publishFixture(recorded.conn, timedFixture(), { loops: 2, catalogFormat: 'cmsf-01', paceByMediaTime: true } as Parameters<typeof publishFixture>[2]);
      await vi.runAllTimersAsync(); await publishing;
      const video = recorded.sent.filter((s) => s.alias === 11n).map((s) => s.time);
      const audio = recorded.sent.filter((s) => s.alias === 12n).map((s) => s.time);
      expect(video.map((t) => t - video[0]!)).toEqual([0, 1000, 2000, 3000]);
      expect(audio.map((t) => t - audio[0]!)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
      expect(performance.now() - video[0]!).toBe(4000);
    } finally { vi.useRealTimers(); }
  });

  it('fails before publishing when timestamp pacing has no valid CMAF timing', async () => {
    const recorded = connection();
    await expect(publishFixture(recorded.conn, videoFixture(), { paceByMediaTime: true } as Parameters<typeof publishFixture>[2]))
      .rejects.toThrow(/timing/);
    expect(recorded.sent).toHaveLength(0);
  });

  it('rejects a trex-only middle fragment before publishing the catalog', async () => {
    const initData = buildInit({ trackId: 1, timescale: 90000, handler: 'vide', trex: { duration: 45000 } });
    const chunks = [0, 45000, 90000].map((bmdt, i) => buildChunk({ bmdt,
      samples: [{ duration: 45000, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8),
      ...(i === 1 ? { trun: { size: true, flags: true } } : {}),
    }));
    const f = fixture([{ ...timedFixture().tracks[0]!, initData, chunks }]);
    const recorded = connection();
    await expect(publishFixture(recorded.conn, f, { loops: 2, paceByMediaTime: true }))
      .rejects.toThrow(/timing/);
    expect(recorded.sent).toHaveLength(0);
    expect(recorded.opens).toHaveLength(0);
  });
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
