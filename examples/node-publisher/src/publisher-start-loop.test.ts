/**
 * `startLoop` — beginning a live loop at a real media origin.
 *
 * A publisher that has been up for a while hands a joining subscriber decode
 * times far from zero. Starting the fixture loop at iteration N reproduces
 * that: the group IDs and the `tfdt` rebasing both move, while WALL-CLOCK
 * pacing still begins immediately, because `loops` is a COUNT of iterations
 * to send, not a terminal group number.
 *
 * These assert the bytes and the timing actually emitted, not that an option
 * was forwarded.
 */
import { describe, expect, it } from 'vitest';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { LoadedFixture } from './fixture.js';
import { publishFixture } from './publisher.js';
import { firstFragmentBmd, rebaseTfdtCopy } from './cmaf-loop-rebase.js';
import { TrackObjectSource } from './track-packager.js';
import { videoInit, audioInit, buildChunk, SYNC_FLAGS } from '../../../packages/locmaf/test-support/cmaf.js';

/** Video: 90 kHz, two 1 s chunks → a 180000-tick (2 s) loop span. */
const VIDEO_SPAN = 180000n;
/** Audio: 48 kHz, four 0.5 s chunks → a 96000-tick (2 s) loop span. */
const AUDIO_SPAN = 96000n;

const timedFixture = (): LoadedFixture => ({
  manifest: { namespace: ['demo'], renderGroup: 1, chunkDurationMs: 1000, tracks: [] },
  tracks: [
    {
      meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
      initData: videoInit(),
      chunks: [0, 90000].map((bmdt) => buildChunk({
        bmdt, samples: [{ duration: 90000, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8),
      })),
    },
    {
      meta: { name: 'audio', packaging: 'cmaf', role: 'audio', codec: 'mp4a.40.2', init: 'init.mp4', chunks: [] },
      initData: audioInit(),
      chunks: [0, 24000, 48000, 72000].map((bmdt) => buildChunk({
        trackId: 2, bmdt, samples: [{ duration: 24000, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8),
      })),
    },
  ],
});
/**
 * One chunk, one tick long: a structurally valid version-1 CMAF loop whose
 * span is 1, so even a near-MAX_SAFE_INTEGER origin stays inside tfdt range
 * and cannot mask a group-counter failure.
 */
const oneTickFixture = (): LoadedFixture => ({
  manifest: { namespace: ['demo'], renderGroup: 1, chunkDurationMs: 1, tracks: [] },
  tracks: [{
    meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
    initData: videoInit(),
    chunks: [buildChunk({ bmdt: 0n, samples: [{ duration: 1, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8) })],
  }],
});

/** Records the group, object id, payload and arrival time of everything sent. */
function recorder() {
  const sent: { alias: bigint; group: bigint; object: bigint; payload: Uint8Array; atMs: number }[] = [];
  const streams = new Map<number, { alias: bigint; group: bigint }>();
  const startMs = performance.now();
  let request = 0n;
  let published = 0;
  const conn = {
    onMessage: undefined as ((m: { type: string; requestId: bigint }) => void) | undefined,
    async publish() {
      published++;
      const id = request++;
      setTimeout(() => conn.onMessage?.({ type: 'REQUEST_OK', requestId: id }), 0);
      return id;
    },
    async openSubgroup(alias: bigint, group: bigint) {
      const stream = streams.size + 1;
      streams.set(stream, { alias, group });
      return stream;
    },
    async sendObject(stream: number, object: bigint, payload: Uint8Array) {
      const identity = streams.get(stream)!;
      sent.push({ ...identity, object, payload, atMs: performance.now() - startMs });
    },
    async closeSubgroup() {},
  };
  return { conn: conn as unknown as MoqtConnection, sent, startMs, publishes: () => published };
}

/** Media objects of one track, in send order (alias 10 is the catalog). */
const track = (sent: ReturnType<typeof recorder>['sent'], alias: bigint) =>
  sent.filter((s) => s.alias === alias);

describe('publishing from a later loop iteration', () => {
  it('starts group IDs and decode times at the requested iteration', async () => {
    const r = recorder();
    await publishFixture(r.conn, timedFixture(), { loops: 1, startLoop: 3, paceByMediaTime: true });
    const video = track(r.sent, 11n);
    const audio = track(r.sent, 12n);
    expect(video.map((o) => o.group)).toEqual([3n, 3n]);
    expect(audio.map((o) => o.group)).toEqual([3n, 3n, 3n, 3n]);
    // The decode time a subscriber receives FIRST, read back from the bytes.
    expect(firstFragmentBmd([video[0]!.payload])).toBe(3n * VIDEO_SPAN);
    expect(firstFragmentBmd([audio[0]!.payload])).toBe(3n * AUDIO_SPAN);
    // Both tracks land on the same 6 s media origin, in their own timescales.
    expect(Number(3n * VIDEO_SPAN) / 90000).toBeCloseTo(6, 6);
    expect(Number(3n * AUDIO_SPAN) / 48000).toBeCloseTo(6, 6);
  });

  it('treats loops as a COUNT of iterations, not a terminal group', async () => {
    const r = recorder();
    await publishFixture(r.conn, timedFixture(), { loops: 2, startLoop: 3, paceByMediaTime: true });
    const video = track(r.sent, 11n);
    expect([...new Set(video.map((o) => o.group))]).toEqual([3n, 4n]);
    expect(video).toHaveLength(4);
    expect(firstFragmentBmd([video.find((o) => o.group === 4n)!.payload])).toBe(4n * VIDEO_SPAN);
  });

  it('paces from launch, so a later origin does not delay the first group', async () => {
    // Scheduling by group number would hold group 3 back by 3 × 2 s.
    const r = recorder();
    await publishFixture(r.conn, timedFixture(), { loops: 1, startLoop: 3, paceByMediaTime: true });
    const video = track(r.sent, 11n);
    expect(video[0]!.atMs).toBeLessThan(1000);
    // The SECOND chunk still waits its real media duration (1 s at 90 kHz).
    expect(video[1]!.atMs).toBeGreaterThan(750);
  });

  it('keeps zero-origin behavior when startLoop is omitted', async () => {
    const r = recorder();
    await publishFixture(r.conn, timedFixture(), { loops: 2, paceByMediaTime: true });
    const video = track(r.sent, 11n);
    expect([...new Set(video.map((o) => o.group))]).toEqual([0n, 1n]);
    expect(firstFragmentBmd([video[0]!.payload])).toBe(0n);
  });

  it('offsets the one-shot path too', async () => {
    const r = recorder();
    await publishFixture(r.conn, timedFixture(), { startLoop: 2 });
    const video = track(r.sent, 11n);
    expect([...new Set(video.map((o) => o.group))]).toEqual([2n]);
    expect(firstFragmentBmd([video[0]!.payload])).toBe(2n * VIDEO_SPAN);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects startLoop %p before publishing anything', async (startLoop) => {
      const r = recorder();
      await expect(publishFixture(r.conn, timedFixture(), { loops: 1, startLoop, paceByMediaTime: true }))
        .rejects.toThrow(/startLoop/);
      // Rejected before the catalog, so nothing reached the wire.
      expect(r.publishes()).toBe(0);
      expect(r.sent).toEqual([]);
    });
});


/**
 * A decode time only exists if it FITS. `DataView.setBigUint64` wraps modulo
 * 2^64 instead of refusing, so an origin large enough to overflow would be
 * published as a plausible small timestamp — the kind of value a subscriber
 * cannot tell from a real one.
 */
describe('decode times must fit the tfdt field they are written to', () => {
  const U32_MAX = 0xffff_ffffn;
  const U64_MAX = 0xffff_ffff_ffff_ffffn;
  const fragment = (bmdt: bigint, tfdtVersion: 0 | 1) => buildChunk({
    bmdt, tfdtVersion, samples: [{ duration: 180000, size: 8, flags: SYNC_FLAGS }],
    mdat: new Uint8Array(8),
  });
  /** A 64-bit tfdt. */
  const wide = (bmdt: bigint) => fragment(bmdt, 1);
  /** A 32-bit tfdt — the width the generator emits for older fixtures. */
  const narrow = (bmdt: bigint) => fragment(bmdt, 0);

  it('refuses a 64-bit overflow instead of wrapping to zero', () => {
    expect(() => rebaseTfdtCopy(wide(U64_MAX), 1n)).toThrow(/out of range/);
  });

  it('keeps the largest representable 64-bit decode time', () => {
    expect(firstFragmentBmd([rebaseTfdtCopy(wide(U64_MAX - 1n), 1n)])).toBe(U64_MAX);
  });

  it('refuses a 32-bit overflow and keeps its last representable value', () => {
    expect(() => rebaseTfdtCopy(narrow(U32_MAX), 1n)).toThrow(/out of range/);
    expect(firstFragmentBmd([rebaseTfdtCopy(narrow(U32_MAX - 1n), 1n)])).toBe(U32_MAX);
  });

  it.each([1, 0] as const)('refuses a NEGATIVE result on a version-%i tfdt', (version) => {
    const chunk = version === 1 ? wide(10n) : narrow(10n);
    expect(() => rebaseTfdtCopy(chunk, -11n)).toThrow(/out of range/);
    // A negative delta is fine while the decode time stays representable.
    expect(firstFragmentBmd([rebaseTfdtCopy(chunk, -10n)])).toBe(0n);
  });

  it('refuses a loop origin whose rebased decode time cannot fit', () => {
    const source = new TrackObjectSource({
      meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e',
        init: 'init.mp4', chunks: [] },
      initData: videoInit(), chunks: [wide(0n)],
    }, 'cmaf');
    expect(() => source.objectsForGroup(Number.MAX_SAFE_INTEGER)).toThrow(/out of range/);
    // The origin this harness actually uses stays publishable.
    expect(firstFragmentBmd(source.cmafChunksForGroup(3))).toBe(3n * VIDEO_SPAN);
  });
});

describe('an unusable origin is refused before anything is published', () => {
  it('rejects an overflowing origin without emitting a catalog or media', async () => {
    const r = recorder();
    await expect(publishFixture(r.conn, timedFixture(), {
      loops: 1, startLoop: Number.MAX_SAFE_INTEGER, paceByMediaTime: true,
    })).rejects.toThrow(/not publishable.*out of range/s);
    expect(r.publishes()).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it('rejects a finite run whose LAST group would leave exact integer range', async () => {
    // A ONE-TICK loop keeps even this origin inside version-1 tfdt range, so
    // the timestamp guard cannot stand in for the group-counter check. The
    // required reason is the counter, and the required moment is before any
    // publish — the sum is computed exactly because
    // `MAX_SAFE_INTEGER + 2 - 1` rounds back to MAX_SAFE_INTEGER as a Number
    // and would report the rounded answer as safe.
    const r = recorder();
    await expect(publishFixture(r.conn, oneTickFixture(), {
      loops: 2, startLoop: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/exact integer range/);
    expect(r.publishes()).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it('publishes the last two representable groups of the neighbouring run', async () => {
    // One below the boundary: every group IS representable, so this must run
    // normally — the guard rejects an unrepresentable counter, not a large one.
    const last = BigInt(Number.MAX_SAFE_INTEGER);
    const r = recorder();
    await publishFixture(r.conn, oneTickFixture(), {
      loops: 2, startLoop: Number.MAX_SAFE_INTEGER - 1,
    });
    const video = track(r.sent, 11n);
    expect(video.map((o) => o.group)).toEqual([last - 1n, last]);
    // And their decode times still fit the field they were written to.
    expect(firstFragmentBmd([video[0]!.payload])).toBe(last - 1n);
    expect(firstFragmentBmd([video[1]!.payload])).toBe(last);
  });

  it.each([0, -1, 2.5, Number.NaN])('rejects a loops count of %p', async (loops) => {
    const r = recorder();
    await expect(publishFixture(r.conn, timedFixture(), { loops, startLoop: 3 }))
      .rejects.toThrow(/loops must be a positive safe integer or Infinity/);
    expect(r.publishes()).toBe(0);
  });

  it('stops an endless loop before it repeats a rounded group number', async () => {
    // Chunks that are not parseable CMAF are never rebased, so no decode time
    // overflows first — this is the only way the group counter itself is what
    // runs out. Beyond MAX_SAFE_INTEGER, `+ 1` stops changing the number, and
    // republishing one group forever is worse than stopping.
    const opaque: LoadedFixture = {
      manifest: { namespace: ['demo'], renderGroup: 1, chunkDurationMs: 1000, tracks: [] },
      tracks: [{
        meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
        initData: videoInit(), chunks: [Uint8Array.of(1)],
      }],
    };
    const r = recorder();
    await expect(publishFixture(r.conn, opaque, {
      loops: Number.POSITIVE_INFINITY, startLoop: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/beyond exact integer range/);
    // The last REPRESENTABLE group was still published before stopping.
    expect(track(r.sent, 11n).map((o) => o.group)).toEqual([BigInt(Number.MAX_SAFE_INTEGER)]);
  });

  it('still publishes the origin the handover case uses', async () => {
    const r = recorder();
    await publishFixture(r.conn, timedFixture(), { loops: 1, startLoop: 3, paceByMediaTime: true });
    expect(track(r.sent, 11n).map((o) => o.group)).toEqual([3n, 3n]);
  });
});
