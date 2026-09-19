/**
 * LOCMAF packaging mode of the node publisher (draft-einarsson-moq-locmaf-01
 * sections 3, 5, 6, 15.9): one LOCMAF Object per CMAF chunk, a full header on
 * the first Object of every group, deltas otherwise, and a catalog that
 * signals packaging "locmaf" with the init carried exactly as in CMAF mode.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTrackPackagingSupported, parseCatalogAuto, SUPPORTED_LOCMAF_VERSIONS } from '@moqt/msf';
import {
  LOCMAF_VERSION,
  LocmafTrackDecoder,
  buildCanonicalChunk,
  deserializeLocmafObject,
  parseCmafChunk,
  parseLocmafTrackContext,
} from '@moqt/locmaf';
import type { MoqtConnection } from '@moqt/webtransport';
import { NON_SYNC_FLAGS, SYNC_FLAGS, audioInit, buildChunk, videoInit } from '../../../packages/locmaf/test-support/cmaf.js';
import { loadFixtureFromDisk, type LoadedFixture, type LoadedTrack } from './fixture.js';
import { buildFixtureCatalog, publishFixture } from './publisher.js';
import { TrackObjectSource } from './track-packager.js';
import { loadSyntheticFixture } from './synthetic-fixture.js';

const VIDEO_DUR = 3000;
const AUDIO_DUR = 1024;

/**
 * Already-canonical video chunks (section 15: mfhd sequence 0, uniform duration
 * in tfhd, per-sample sizes, first-sample flags plus a tfhd default): 3 samples
 * each, sync first, continuous BMDT.
 */
function videoChunks(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, c) => buildChunk({
    bmdt: c * 3 * VIDEO_DUR,
    sequenceNumber: 0,
    tfhd: { duration: VIDEO_DUR, flags: NON_SYNC_FLAGS },
    trun: { size: true, firstSampleFlags: SYNC_FLAGS },
    samples: [0, 1, 2].map((s) => ({ duration: VIDEO_DUR, size: 20 + c + s, flags: s === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS })),
    mdat: Uint8Array.from({ length: 63 + 3 * c }, (_, i) => (i * 7 + c) & 0xff),
  }));
}

/** Non-canonical audio chunks (tfhd defaults instead of per-sample trun fields). */
function audioChunks(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, c) => buildChunk({
    trackId: 2,
    bmdt: c * 2 * AUDIO_DUR,
    samples: [{ duration: AUDIO_DUR, size: 8, flags: SYNC_FLAGS }, { duration: AUDIO_DUR, size: 8, flags: SYNC_FLAGS }],
    tfhd: { duration: AUDIO_DUR, size: 8, flags: SYNC_FLAGS },
    trun: {},
    mdat: Uint8Array.from({ length: 16 }, (_, i) => (i + c) & 0xff),
  }));
}

const videoTrack = (): LoadedTrack => ({
  meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.640028', init: 'init.mp4', chunks: [], width: 640, height: 360 },
  initData: videoInit(),
  chunks: videoChunks(4),
});

const audioTrack = (): LoadedTrack => ({
  meta: { name: 'audio', packaging: 'cmaf', role: 'audio', codec: 'mp4a.40.2', init: 'init.mp4', chunks: [], samplerate: 48000, channelConfig: '2' },
  initData: audioInit(),
  chunks: audioChunks(3),
});

const fixture = (): LoadedFixture => {
  const tracks = [videoTrack(), audioTrack()];
  return { manifest: { namespace: ['demo'], renderGroup: 1, chunkDurationMs: 100, tracks: tracks.map((t) => t.meta) }, tracks };
};

const eq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** The CMAF chunk a LOCMAF receiver reconstructs from `source` (section 15). */
function canonicalOf(source: Uint8Array, init: Uint8Array): Uint8Array {
  const context = parseLocmafTrackContext(init);
  const parsed = parseCmafChunk(source, context);
  if (!parsed.fits) throw new Error(parsed.reason);
  return buildCanonicalChunk(parsed.genBoxes, parsed.effective, parsed.mdat, context);
}

function isFullHeader(payload: Uint8Array): boolean {
  const o = deserializeLocmafObject(payload);
  if (o.kind !== 'moof') throw new Error(`expected a moof object, got ${o.kind}`);
  return o.header.full;
}

describe('TrackObjectSource', () => {
  it('cmaf mode sends the original chunks in group 0 and rebased copies afterwards', () => {
    const t = videoTrack();
    const src = new TrackObjectSource(t, 'cmaf');
    expect(src.spanTicks).toBe(BigInt(4 * 3 * VIDEO_DUR));
    expect(src.objectsForGroup(0)).toEqual(t.chunks);
    const g1 = src.objectsForGroup(1);
    expect(g1).toHaveLength(4);
    expect(eq(g1[0]!, t.chunks[0]!)).toBe(false);
  });

  it('locmaf objects decode back to the exact CMAF chunks cmaf mode sends (canonical source)', () => {
    const t = videoTrack();
    const cmaf = new TrackObjectSource(t, 'cmaf');
    const locmaf = new TrackObjectSource(t, 'locmaf');
    const decoder = new LocmafTrackDecoder(t.initData);
    for (let g = 0; g < 3; g++) {
      const expected = cmaf.objectsForGroup(g);
      const objects = locmaf.objectsForGroup(g);
      expect(objects).toHaveLength(expected.length);
      objects.forEach((payload, i) => {
        const r = decoder.push(BigInt(g), BigInt(i), payload);
        if (r.kind !== 'chunk') throw new Error(`group ${g} object ${i}: ${r.kind}`);
        expect(eq(r.bytes, expected[i]!)).toBe(true);
      });
    }
  });

  it('locmaf objects decode to the canonical form of a non-canonical source chunk', () => {
    const t = audioTrack();
    const cmaf = new TrackObjectSource(t, 'cmaf');
    const locmaf = new TrackObjectSource(t, 'locmaf');
    const decoder = new LocmafTrackDecoder(t.initData);
    for (let g = 0; g < 2; g++) {
      const sent = cmaf.objectsForGroup(g);
      locmaf.objectsForGroup(g).forEach((payload, i) => {
        const r = decoder.push(BigInt(g), BigInt(i), payload);
        if (r.kind !== 'chunk') throw new Error(`group ${g} object ${i}: ${r.kind}`);
        expect(eq(r.bytes, canonicalOf(sent[i]!, t.initData))).toBe(true);
      });
    }
  });

  it('puts a full header on the first object of every group and deltas after it', () => {
    const src = new TrackObjectSource(videoTrack(), 'locmaf');
    for (let g = 0; g < 3; g++) {
      expect(src.objectsForGroup(g).map(isFullHeader)).toEqual([true, false, false, false]);
    }
  });

  it('keeps BMDT monotonic across the loop seam, where the new group opens on a full header', () => {
    const t = videoTrack();
    const src = new TrackObjectSource(t, 'locmaf');
    const decoder = new LocmafTrackDecoder(t.initData);
    let expectedNext = 0n;
    for (let g = 0; g < 3; g++) {
      const objects = src.objectsForGroup(g);
      expect(isFullHeader(objects[0]!)).toBe(true);
      objects.forEach((payload, i) => {
        const r = decoder.push(BigInt(g), BigInt(i), payload);
        if (r.kind !== 'chunk') throw new Error(r.kind);
        expect(r.baseMediaDecodeTime).toBe(expectedNext);
        expectedNext += BigInt(r.effective.durations.reduce((a, d) => a + d, 0));
      });
    }
    expect(expectedNext).toBe(3n * src.spanTicks!);
  });

  it('re-anchors with a full header when the timeline jumps inside a group', () => {
    const chunks = videoChunks(3);
    const jumped = [chunks[0]!, chunks[1]!, buildChunk({
      bmdt: 900_000,
      samples: [{ duration: VIDEO_DUR, size: 30, flags: SYNC_FLAGS }],
      mdat: new Uint8Array(30),
    })];
    const src = new TrackObjectSource({ ...videoTrack(), chunks: jumped }, 'locmaf');
    expect(src.objectsForGroup(0).map(isFullHeader)).toEqual([true, false, true]);
  });

  // The prepared ffmpeg fixture is gitignored; run against it when it has been generated.
  const testsrc = fileURLToPath(new URL('../fixtures/testsrc', import.meta.url));
  it.skipIf(!existsSync(join(testsrc, 'manifest.json')))('encodes the prepared testsrc fixture across a loop seam', () => {
    for (const t of loadFixtureFromDisk(testsrc).tracks) {
      const cmaf = new TrackObjectSource(t, 'cmaf');
      const locmaf = new TrackObjectSource(t, 'locmaf');
      const decoder = new LocmafTrackDecoder(t.initData);
      let lastBmdt = -1n;
      for (let g = 0; g < 2; g++) {
        const sent = cmaf.cmafChunksForGroup(g);
        const objects = locmaf.objectsForGroup(g);
        expect(objects.map(isFullHeader)).toEqual(objects.map((_, i) => i === 0));
        objects.forEach((payload, i) => {
          const r = decoder.push(BigInt(g), BigInt(i), payload);
          if (r.kind !== 'chunk') throw new Error(`${t.meta.name} ${g}/${i}: ${r.kind}`);
          expect(eq(r.bytes, canonicalOf(sent[i]!, t.initData))).toBe(true);
          expect(r.baseMediaDecodeTime > lastBmdt).toBe(true);
          lastBmdt = r.baseMediaDecodeTime;
        });
      }
    }
  });

  it('refuses locmaf for a track whose init is not a CMAF Header', () => {
    const synthetic = loadSyntheticFixture().tracks[0]!;
    expect(() => new TrackObjectSource(synthetic, 'locmaf')).toThrow(/locmaf/i);
  });
});

describe('buildFixtureCatalog packaging', () => {
  for (const format of ['msf-00', 'cmsf-01'] as const) {
    it(`${format}: signals packaging locmaf and locmafVersion, init carried as in cmaf mode`, () => {
      const f = fixture();
      const cmafRaw = JSON.parse(new TextDecoder().decode(buildFixtureCatalog(f, format)));
      const bytes = buildFixtureCatalog(f, format, 'locmaf');
      const raw = JSON.parse(new TextDecoder().decode(bytes));

      expect(raw.version).toEqual(cmafRaw.version);
      expect(raw.initDataList).toEqual(cmafRaw.initDataList);
      raw.tracks.forEach((t: Record<string, unknown>, i: number) => {
        expect(t['packaging']).toBe('locmaf');
        expect(t['locmafVersion']).toBe(LOCMAF_VERSION);
        const { packaging: _p, locmafVersion: _v, ...rest } = t;
        const { packaging: _cp, ...cmafRest } = cmafRaw.tracks[i];
        expect(rest).toEqual(cmafRest);
      });

      const parsed = parseCatalogAuto(bytes);
      expect(parsed.tracks).toHaveLength(2);
      for (const t of parsed.tracks) {
        expect(t.packaging).toBe('locmaf');
        expect(t.locmafVersion).toBe(LOCMAF_VERSION);
        expect(isTrackPackagingSupported(t)).toBe(true);
      }
      expect(SUPPORTED_LOCMAF_VERSIONS).toContain(LOCMAF_VERSION);
    });
  }

  it('leaves the default cmaf catalog without locmafVersion', () => {
    const raw = JSON.parse(new TextDecoder().decode(buildFixtureCatalog(fixture())));
    for (const t of raw.tracks) {
      expect(t.packaging).toBe('cmaf');
      expect('locmafVersion' in t).toBe(false);
    }
  });
});

interface Sent { alias: bigint; group: bigint; subgroup: bigint; objectId: bigint; payload: Uint8Array }

/** A connection double recording every object; PUBLISH is accepted immediately. */
function recordingConn(): { conn: MoqtConnection; sent: Sent[]; opens: { alias: bigint; group: bigint; firstObject: boolean }[] } {
  const sent: Sent[] = [];
  const opens: { alias: bigint; group: bigint; firstObject: boolean }[] = [];
  const streams = new Map<number, { alias: bigint; group: bigint; subgroup: bigint }>();
  let nextRequest = 1n;
  let nextStream = 1;
  const conn = {
    onMessage: undefined as ((m: unknown) => void) | undefined,
    async publish() {
      const id = nextRequest++;
      setTimeout(() => conn.onMessage?.({ type: 'REQUEST_OK', requestId: id }), 0);
      return id;
    },
    async openSubgroup(alias: bigint, group: bigint, subgroup: bigint, opts: { firstObject?: boolean }) {
      const sid = nextStream++;
      streams.set(sid, { alias, group, subgroup });
      opens.push({ alias, group, firstObject: opts.firstObject === true });
      return sid;
    },
    async sendObject(sid: number, objectId: bigint, payload: Uint8Array) {
      sent.push({ ...streams.get(sid)!, objectId, payload });
    },
    async closeSubgroup() { /* recorded by open/send */ },
  };
  return { conn: conn as unknown as MoqtConnection, sent, opens };
}

describe('publishFixture packaging', () => {
  const media = (sent: Sent[]) => sent.filter((s) => s.alias !== 10n);
  const numbering = (sent: Sent[]) => media(sent).map((s) => `${s.alias}/${s.group}/${s.subgroup}/${s.objectId}`);

  for (const loops of [1, 3]) {
    it(`loops=${loops}: locmaf keeps cmaf group/object numbering and every object decodes to what cmaf sent`, async () => {
      const f = fixture();
      const cmaf = recordingConn();
      await publishFixture(cmaf.conn, f, { loops });
      const locmaf = recordingConn();
      await publishFixture(locmaf.conn, f, { loops, packaging: 'locmaf' });

      expect(numbering(locmaf.sent)).toEqual(numbering(cmaf.sent));
      expect(locmaf.opens).toEqual(cmaf.opens);

      const catalog = parseCatalogAuto(locmaf.sent.find((s) => s.alias === 10n)!.payload);
      expect(catalog.tracks.map((t) => t.packaging)).toEqual(['locmaf', 'locmaf']);

      const decoders = new Map<bigint, LocmafTrackDecoder>();
      f.tracks.forEach((t, i) => decoders.set(11n + BigInt(i), new LocmafTrackDecoder(t.initData)));
      const cmafMedia = media(cmaf.sent);
      media(locmaf.sent).forEach((s, i) => {
        const init = f.tracks[Number(s.alias - 11n)]!.initData;
        const r = decoders.get(s.alias)!.push(s.group, s.objectId, s.payload);
        if (r.kind !== 'chunk') throw new Error(`${s.alias}/${s.group}/${s.objectId}: ${r.kind}`);
        expect(eq(r.bytes, canonicalOf(cmafMedia[i]!.payload, init))).toBe(true);
        expect(isFullHeader(s.payload)).toBe(s.objectId === 0n);
      });
    });
  }

  it('fails before publishing when locmaf is requested for a non-CMAF fixture', async () => {
    const { conn, sent } = recordingConn();
    await expect(publishFixture(conn, loadSyntheticFixture(), { packaging: 'locmaf' })).rejects.toThrow(/locmaf/i);
    expect(sent).toHaveLength(0);
  });
});
