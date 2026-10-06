import { describe, expect, it } from 'vitest';
import { inspectLocmafTrack } from './locmaf.js';
import type { LoadedTrack } from '../../examples/node-publisher/src/fixture.js';
import { TrackObjectSource } from '../../examples/node-publisher/src/track-packager.js';
import { buildChunk, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';

function track(): LoadedTrack {
  return { meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
    initData: videoInit(), chunks: [0, 1, 2].map((i) => buildChunk({ bmdt: i * 6000,
      samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS, cto: 100 },
        { duration: 4000, size: 4, flags: NON_SYNC_FLAGS, cto: -100 }],
      mdat: Uint8Array.from({ length: 8 }, (_, j) => i * 10 + j) })) };
}

describe('LOCMAF acceptance fixture proof', () => {
  it('preserves coded samples, variable durations and composition offsets across loop groups', () => {
    const proof = inspectLocmafTrack(track());
    expect(proof).toMatchObject({ full: 2, delta: 4, timescale: 90000 });
    expect(proof.groups).toHaveLength(2);
    expect(proof.groups[0]![0]!.canonicalSha256).not.toBe(proof.groups[1]![0]!.canonicalSha256);
    expect(proof.groups.flat().every((object) => object.samples === 2 && /^[0-9a-f]{64}$/.test(object.objectSha256))).toBe(true);
  });

  it('rejects a changed coded sample rather than accepting decodability as equivalence', () => {
    const source = new TrackObjectSource(track(), 'locmaf');
    const groups = [source.objectsForGroup(0).map((bytes) => bytes.slice()), source.objectsForGroup(1)];
    const changed = groups[0]![1]!;
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(() => inspectLocmafTrack(track(), groups)).toThrow(/differs/);
  });

  it('rejects a missing object', () => {
    const source = new TrackObjectSource(track(), 'locmaf');
    expect(() => inspectLocmafTrack(track(), [source.objectsForGroup(0).slice(1), source.objectsForGroup(1)]))
      .toThrow(/count/);
  });

  it('requires a full header at a fresh group', () => {
    const source = new TrackObjectSource(track(), 'locmaf');
    const second = [...source.objectsForGroup(1)];
    second[0] = second[1]!;
    expect(() => inspectLocmafTrack(track(), [source.objectsForGroup(0), second])).toThrow(/full group start/);
  });

  it('rejects fixtures with no delta headers', () => {
    const one = track();
    expect(() => inspectLocmafTrack({ ...one, chunks: one.chunks.slice(0, 1) })).toThrow(/full and delta/);
  });
});
