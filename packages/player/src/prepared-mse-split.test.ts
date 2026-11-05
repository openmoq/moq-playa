import { expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { PreparedOutputEvidence } from './prepared-output-evidence.js';
import { preflightMseOutputs } from './prepared-mse-output.js';

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};
function fixture(prefix: 'none' | 'free' | 'styp') {
  const init = buildInit({ trackId: 11, timescale: 90000, handler: 'vide' });
  const samples = Uint8Array.of(11, 2, 3, 4);
  const raw = buildChunk({ trackId: 11, bmdt: 8_100_000n,
    samples: [{ duration: 1800, size: samples.length, flags: SYNC_FLAGS }], mdat: samples });
  const size = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
  const moof = raw.slice(0, size);
  const boxes = prefix === 'none' ? new Uint8Array() : prefix === 'free'
    ? Uint8Array.of(0, 0, 0, 8, 102, 114, 101, 101)
    : Uint8Array.of(0, 0, 0, 20, 115, 116, 121, 112, 99, 109, 102, 115, 0, 0, 0, 0, 99, 109, 102, 115);
  // Keep the fixture's trun data_offset relative to the unchanged moof start.
  let trun = -1;
  for (let i = 0; i + 20 <= moof.length; i++) {
    if (String.fromCharCode(...moof.subarray(i + 4, i + 8)) === 'trun') { trun = i; break; }
  }
  expect(trun).toBeGreaterThan(0);
  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  view.setInt32(trun + 16, view.getInt32(trun + 16) + boxes.length);
  const tail = concat(boxes, raw.subarray(size)), context = parseLocmafTrackContext(init);
  expect(readCmafChunkSamples(concat(moof, tail), context).mdat).toEqual(samples);
  const object = (payload: Uint8Array, id: bigint, group = 7n): MoqtObject => ({ kind: 'data', payload,
    trackAlias: varint(10), groupId: varint(group), objectId: varint(id), subgroupId: varint(0), publisherPriority: 0 });
  return { init, moof, tail, context, samples, object };
}

// Match existing assembler compatibility; this does not claim CMSF-01 permits
// splitting its required complete chunk across separate MOQT Objects (§3.3).
for (const prefix of ['none', 'free', 'styp'] as const) {
  it(`preflights the same split ${prefix} tail accepted by the playback assembler`, () => {
    const f = fixture(prefix), originals = [f.moof.slice(), f.tail.slice()];
    const emitted = vi.fn(), actual = new CmafAssembler({ onSegment: emitted });
    const live = new CmafAssembler({ onSegment() {} }), key = JSON.stringify([['example'], 'video']);
    try {
      actual.setInitSegment('video', f.init); actual.selectTrack('video', 'video', key);
      actual.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n,
        rebasedTimeUs: { numerator: 10_000_000n, denominator: 1n } });
      actual.push('video', 'video', 7n, f.moof, undefined, undefined, key);
      actual.push('video', 'video', 7n, f.tail, undefined, undefined, key);
      expect(emitted).toHaveBeenCalledOnce();
      const delivered = readCmafChunkSamples(emitted.mock.calls[0]![1], f.context);
      expect(delivered.effective.baseMediaDecodeTime).toBe(900_000n);
      expect(delivered.mdat).toEqual(f.samples);
      expect(() => preflightMseOutputs(options => new CmafAssembler(options), live, [{ role: 'video',
        trackName: 'video', sourceKey: key, packaging: 'cmaf', init: f.init,
        anchor: { sourceTimeUs: 90_000_000n, rebasedTimeUs: { numerator: 10_000_000n, denominator: 1n } },
        objects: [f.object(f.moof, 0n), f.object(f.tail, 1n)] }], () => {})).not.toThrow();
      expect([f.moof, f.tail]).toEqual(originals);
    } finally { actual.destroy(); live.destroy(); }
  });

  it(`uses the complete split ${prefix} tail as readiness evidence without changing source time`, () => {
    const f = fixture(prefix), evidence = new PreparedOutputEvidence('cmaf', 'video');
    evidence.setInit(f.init);
    expect(evidence.inspect(f.object(f.moof, 0n))).toBe(false);
    expect(evidence.firstPresentationTimeUs).toBeNull();
    expect(evidence.inspect(f.object(f.tail, 1n))).toBe(true);
    expect(evidence.firstPresentationTimeUs).toBe(90_000_000n);
    expect(evidence.firstUsableLocation).toEqual({ groupId: 7n, objectId: 0n });
  });
}

it('does not pair a tail with a moof retained for a different group', () => {
  const f = fixture('none'), evidence = new PreparedOutputEvidence('cmaf', 'video');
  evidence.setInit(f.init);
  expect(evidence.inspect(f.object(f.moof, 0n))).toBe(false);
  expect(evidence.inspect(f.object(f.tail, 1n, 8n))).toBe(false);
  expect(evidence.firstPresentationTimeUs).toBeNull();
  expect(evidence.inspect(f.object(f.tail, 1n))).toBe(true);
});

it('refuses malformed tail boxes rather than accepting a pending moof as readiness', () => {
  const f = fixture('free'), evidence = new PreparedOutputEvidence('cmaf', 'video');
  evidence.setInit(f.init);
  expect(evidence.inspect(f.object(f.moof, 0n))).toBe(false);
  expect(() => evidence.inspect(f.object(f.tail.subarray(0, 7), 1n))).toThrow();
  expect(evidence.firstPresentationTimeUs).toBeNull();
});
