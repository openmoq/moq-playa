import { describe, expect, it, vi } from 'vitest';
import { parseLocHeaders } from '@openmoq/loc';
import { prepareLocTrack, locFrameProperties, publishLocFixture } from './loc-fixture.js';
import type { LoadedTrack, LoadedFixture } from './fixture.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import { videoInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../../packages/locmaf/test-support/cmaf.js';
import { concat, fullBox, isoBox, u32, ascii } from '../../../packages/locmaf/test-support/bytes.js';

function opusTrack(): LoadedTrack {
  const entryFields = new Uint8Array(28);
  new DataView(entryFields.buffer).setUint16(6, 1);
  new DataView(entryFields.buffer).setUint16(16, 1);
  new DataView(entryFields.buffer).setUint32(24, 48000 << 16);
  const initData = isoBox('moov', isoBox('trak',
    fullBox('tkhd', 0, 7, new Uint8Array(8), u32(2), new Uint8Array(64)),
    isoBox('mdia', fullBox('mdhd', 0, 0, new Uint8Array(8), u32(48000), new Uint8Array(8)),
      fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(12)),
      isoBox('minf', isoBox('stbl', fullBox('stsd', 0, 0, u32(1),
        isoBox('Opus', entryFields, isoBox('dOps', concat(Uint8Array.of(0, 1, 0, 0), u32(48000), Uint8Array.of(0, 0, 0))))))))),
    isoBox('mvex', fullBox('trex', 0, 0, u32(2), u32(1), u32(0), u32(0), u32(0))));
  return { meta: { name: 'audio', packaging: 'cmaf', role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '1', init: 'init.mp4', chunks: [] },
    initData, chunks: [buildChunk({ trackId: 2, bmdt: 0,
      samples: Array.from({ length: 4 }, () => ({ duration: 960, size: 2, flags: SYNC_FLAGS })), mdat: Uint8Array.of(252, 2, 252, 4, 252, 6, 252, 8) })] };
}

function connection() {
  const streams = new Map<number, { alias: bigint; group: bigint; subgroup: bigint; options: unknown }>();
  const sent: { stream: number; object: bigint; payload: Uint8Array; properties?: Uint8Array; time: number }[] = [];
  const closed: number[] = [];
  let request = 0n;
  const conn = {
    onMessage: undefined as ((m: { type: string; requestId: bigint }) => void) | undefined,
    async publish() { const id = request++; setTimeout(() => conn.onMessage?.({ type: 'REQUEST_OK', requestId: id }), 0); return id; },
    async openSubgroup(alias: bigint, group: bigint, subgroup: bigint, options: unknown) {
      const stream = streams.size + 1; streams.set(stream, { alias, group, subgroup, options }); return stream;
    },
    async sendObject(stream: number, object: bigint, payload: Uint8Array, properties?: Uint8Array) {
      sent.push({ stream, object, payload, ...(properties ? { properties } : {}), time: performance.now() });
    },
    async closeSubgroup(stream: number) { closed.push(stream); },
  };
  return { conn: conn as unknown as MoqtConnection, streams, sent, closed };
}

const video = (): LoadedTrack => ({
  meta: { name: 'video-360', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
  initData: videoInit(),
  chunks: [0, 7500].map((bmdt) => buildChunk({ bmdt, samples: [
    { duration: 3750, size: 2, flags: SYNC_FLAGS }, { duration: 3750, size: 2, flags: NON_SYNC_FLAGS },
  ], mdat: Uint8Array.of(1, 2, 3, 4) })),
});
const epoch = 1_790_000_000_000_000n;
const wire = { wireProfile: 'd18-delta-vi64' } as const;

describe('prepared LOC samples', () => {
  it('slices elementary frames and starts one group at each independent video sample', () => {
    const prepared = prepareLocTrack(video());
    expect(prepared.timescale).toBe(90000);
    expect(prepared.spanTicks).toBe(15000n);
    expect(prepared.groups.map((g) => g.frames.map((f) => [...f.payload]))).toEqual([[[1, 2], [3, 4]], [[1, 2], [3, 4]]]);
    expect(prepared.groups[1]!.frames[0]!.offsetTicks).toBe(7500n);
    expect(prepared.videoConfig).not.toBeNull();
  });

  it('maps each Opus packet to its own group without CMAF headers or video properties', () => {
    const prepared = prepareLocTrack(opusTrack());
    expect(prepared).toMatchObject({ video: false, timescale: 48000, spanTicks: 3840n, videoConfig: null });
    expect(prepared.groups.map((g) => g.frames.map((f) => [...f.payload]))).toEqual([[[252, 2]], [[252, 4]], [[252, 6]], [[252, 8]]]);
    const headers = parseLocHeaders(locFrameProperties(prepared, prepared.groups[1]!.frames[0]!, 1, 4, 'media', epoch), wire);
    expect(headers).toMatchObject({ timestamp: 4800n, timescale: 48000n, captureTimestamp: 100000n });
    expect(headers.videoConfig).toBeUndefined();
    expect(headers.videoFrameMarking).toBeUndefined();
  });

  it('publishes the LOC catalog, elementary samples, complete subgroups and timestamp-paced loop seams', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const tracks = [video(), opusTrack()];
      const fixture: LoadedFixture = { manifest: { namespace: ['test'], renderGroup: 1, chunkDurationMs: 500, tracks: tracks.map((t) => t.meta) }, tracks };
      const recorded = connection();
      const publishing = publishLocFixture(recorded.conn, fixture, 4, 'media', 2);
      await vi.runAllTimersAsync(); await publishing;
      const catalog = JSON.parse(new TextDecoder().decode(recorded.sent[0]!.payload));
      expect(catalog.version).toBe('1');
      expect(catalog.tracks.map((t: { packaging: string }) => t.packaging)).toEqual(['loc', 'loc']);
      expect(catalog.tracks.every((t: object) => !('initRef' in t) && !('initData' in t))).toBe(true);
      const videoSent = recorded.sent.filter((s) => recorded.streams.get(s.stream)!.alias === 11n);
      const audioSent = recorded.sent.filter((s) => recorded.streams.get(s.stream)!.alias === 12n);
      expect(videoSent.map((s) => [recorded.streams.get(s.stream)!.group, s.object])).toEqual([
        [0n, 0n], [0n, 1n], [1n, 0n], [1n, 1n], [2n, 0n], [2n, 1n], [3n, 0n], [3n, 1n],
      ]);
      expect(audioSent.map((s) => [recorded.streams.get(s.stream)!.group, s.object])).toEqual(Array.from({ length: 8 }, (_, i) => [BigInt(i), 0n]));
      expect(audioSent.map((s) => s.time - audioSent[0]!.time)).toEqual([0, 20, 40, 60, 80, 100, 120, 140]);
      expect(Math.abs(videoSent[4]!.time - videoSent[0]!.time - 1000 / 6)).toBeLessThan(1);
      expect(parseLocHeaders(videoSent[4]!.properties!, wire).timestamp).toBe(15000n);
      expect(new Set(recorded.sent.map((s) => s.stream)).size).toBe(recorded.sent.length);
      const videoStreams = videoSent.map((s) => recorded.streams.get(s.stream)!);
      expect(videoStreams.map((s) => s.subgroup)).toEqual([0n, 1n, 0n, 1n, 0n, 1n, 0n, 1n]);
      expect(videoStreams.map((s) => (s.options as { endOfGroup: boolean }).endOfGroup)).toEqual([false, true, false, true, false, true, false, true]);
      expect(new Set(recorded.closed)).toEqual(new Set(recorded.streams.keys()));
    } finally { vi.useRealTimers(); }
  });

  it('paces the full final Opus packet rather than carrying MP4 end trimming into LOC', () => {
    const audio = { ...opusTrack(), chunks: [buildChunk({ trackId: 2, bmdt: 0,
      samples: [{ duration: 960, size: 2, flags: SYNC_FLAGS }, { duration: 312, size: 2, flags: SYNC_FLAGS }], mdat: Uint8Array.of(252, 1, 252, 2) })] };
    expect(prepareLocTrack(audio).spanTicks).toBe(1920n);
    const prepared = prepareLocTrack(audio);
    expect(parseLocHeaders(locFrameProperties(prepared, prepared.groups[0]!.frames[0]!, 1, 4, 'media', epoch), wire).timestamp).toBe(1920n);
  });

  it('rejects Opus packet durations outside the declared synthetic 20ms profile', () => {
    const audio = { ...opusTrack(), chunks: [buildChunk({ trackId: 2, bmdt: 0,
      samples: [{ duration: 960, size: 2, flags: SYNC_FLAGS }], mdat: Uint8Array.of(244, 1) })] };
    expect(() => prepareLocTrack(audio)).toThrow(/20ms/);
  });

  it('carries LOC-01 Unix-epoch microseconds, not a zero-based decode timestamp', () => {
    const prepared = prepareLocTrack(video());
    const frame = { offsetTicks: 3750n, independent: false };
    const headers = parseLocHeaders(locFrameProperties(prepared, frame, 1, 1, 'wall-clock', epoch), wire);
    expect(headers).toMatchObject({ version: 1, captureTimestamp: epoch + 208333n, timestampIsWallClock: true,
      videoFrameMarking: { independent: false, startOfFrame: true, endOfFrame: true } });
    expect(headers.videoConfig).toBeUndefined();
  });

  it('carries LOC-04 media ticks with an explicit non-microsecond timescale', () => {
    const prepared = prepareLocTrack(video());
    const headers = parseLocHeaders(locFrameProperties(prepared, { offsetTicks: 3750n, independent: true }, 1, 4, 'media', epoch), wire);
    expect(headers).toMatchObject({ version: 4, timestamp: 18750n, timescale: 90000n,
      captureTimestamp: 208333n, timestampIsWallClock: false, videoFrameMarking: { independent: true } });
    expect(headers.videoConfig).toEqual(prepared.videoConfig);
  });

  it('supports LOC-04 wall-clock microseconds without a timescale', () => {
    const prepared = prepareLocTrack(video());
    const headers = parseLocHeaders(locFrameProperties(prepared, { offsetTicks: 0n, independent: true }, 0, 4, 'wall-clock', epoch), wire);
    expect(headers).toMatchObject({ version: 4, timestamp: epoch, captureTimestamp: epoch, timestampIsWallClock: true });
    expect(headers.timescale).toBeUndefined();
  });

  it('rejects media time for LOC-01 before anything can be emitted', () => {
    expect(() => locFrameProperties(prepareLocTrack(video()), { offsetTicks: 0n, independent: true }, 0, 1, 'media', epoch)).toThrow(/LOC-01/);
  });

  it('rejects a dependent first sample instead of manufacturing a group boundary', () => {
    const chunk = buildChunk({ bmdt: 0, samples: [{ duration: 3750, size: 2, flags: NON_SYNC_FLAGS }], mdat: new Uint8Array(2) });
    expect(() => prepareLocTrack({ ...video(), chunks: [chunk] })).toThrow(/independent/);
  });

  it('rejects decode-time holes and B-frame fixtures rather than rebasing incorrectly', () => {
    const chunk = buildChunk({ bmdt: 1, samples: [{ duration: 3750, size: 2, flags: SYNC_FLAGS }], mdat: new Uint8Array(2) });
    expect(() => prepareLocTrack({ ...video(), chunks: [video().chunks[0]!, chunk] })).toThrow(/contiguous/);
    const reordered = buildChunk({ bmdt: 0, samples: [{ duration: 3750, size: 2, flags: SYNC_FLAGS, cto: 1 }], mdat: new Uint8Array(2) });
    expect(() => prepareLocTrack({ ...video(), chunks: [reordered] })).toThrow(/composition/);
  });
});
