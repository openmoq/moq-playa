import { describe, expect, it, vi } from 'vitest';
import { ByteWriter } from './byte-writer.js';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafEncoder } from './encoder.js';
import { deserializeLocmafObject } from './deserializer.js';
import { serializeLocmafObject } from './serializer.js';
import { LocmafFormatError } from './errors.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { parseLocmafTrackContext } from './track-context.js';
import { sliceFrames } from './frame.js';
import { buildChunk, videoInit, cencVideoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../test-support/cmaf.js';
import { isoBox } from '../test-support/bytes.js';

const context = parseLocmafTrackContext(videoInit());
const generous = (maxSamples: number, maxBytes = 100000) =>
  new LocmafReadBudget({ maxSamples, maxEntries: 10000, maxBytes });
function objects() {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState();
  return [
    { bmdt: 0, samples: [{ duration: 1000, size: 2, flags: SYNC_FLAGS, cto: 2000 },
      { duration: 1000, size: 2, flags: NON_SYNC_FLAGS, cto: -1000 }] },
    { bmdt: 2000, samples: [{ duration: 1000, size: 3, flags: NON_SYNC_FLAGS }] },
  ].map((spec, i) => deserializeLocmafObject(serializeLocmafObject(encoder.encode(buildChunk(spec), state, context, false, BigInt(i)))));
}

describe('LOCMAF effective samples without canonical serialization', () => {
  it('charges exactly one canonical allocation and borrows samples with no byte allowance left', () => {
    const reconstructor = new LocmafReconstructor(), object = objects()[0]!;
    if (object.kind !== 'moof') throw new Error('Expected moof');
    const canonical = reconstructor.reconstruct(object, new LocmafGroupState(), context, 0n);
    if (canonical.kind !== 'chunk') throw new Error('Expected chunk');
    const exact = generous(2, canonical.bytes.length);
    expect(reconstructor.reconstruct(object, new LocmafGroupState(), context, 0n, exact)).toEqual(canonical);
    expect(exact.usage.bytes).toBe(canonical.bytes.length);
    const spent = generous(2, 1); spent.claimBytes(1);
    const samples = reconstructor.reconstructSamples(object, new LocmafGroupState(), context, 0n, spent);
    if (samples.kind !== 'chunk') throw new Error('Expected chunk');
    expect(samples.mdat).toBe(object.mdat); expect(samples.effective).toEqual(canonical.effective);
    expect(spent.usage.bytes).toBe(1);
  });

  it('keeps full/delta effective values and original payloads identical to reconstruction', () => {
    const reconstructor = new LocmafReconstructor(), canonicalState = new LocmafGroupState(), frameState = new LocmafGroupState();
    for (const [i, object] of objects().entries()) {
      if (object.kind !== 'moof') throw new Error('Expected moof');
      const canonical = reconstructor.reconstruct(object, canonicalState, context, BigInt(i));
      const allowance = generous(3);
      const samples = reconstructor.reconstructSamples(object, frameState, context, BigInt(i), allowance);
      if (canonical.kind !== 'chunk' || samples.kind !== 'chunk') throw new Error('Expected chunks');
      expect(samples.effective).toEqual(canonical.effective);
      expect(samples.mdat).toBe(object.mdat); expect(samples.genBoxes).toBe(object.genBoxes);
      expect(frameState.reference).toEqual(canonicalState.reference);
      expect(frameState.lastObjectId).toBe(BigInt(i));
      expect(allowance.usage.samples).toBe(samples.effective.durations.length);
      expect(allowance.usage.bytes).toBe(0);
    }
  });
  it('preserves coded order and presentation offsets rather than sorting B frames', () => {
    const object = objects()[0]!, reconstructor = new LocmafReconstructor();
    const samples = reconstructor.reconstructSamples(object, new LocmafGroupState(), context, 0n);
    if (samples.kind !== 'chunk') throw new Error('Expected chunk');
    const frames = sliceFrames(samples.effective, samples.mdat);
    expect(frames.map(frame => frame.decodeTime)).toEqual([0n, 1000n]);
    expect(frames.map(frame => frame.presentationTime)).toEqual([2000n, 0n]);
    expect(frames.map(frame => frame.isSync)).toEqual([true, false]);
  });
  it('does not serialize bytes, with canonical writing as the positive witness', () => {
    const reconstructor = new LocmafReconstructor(), object = objects()[0]!, allowance = generous(2, 1);
    const writes = vi.spyOn(ByteWriter.prototype, 'bytes');
    try {
      expect(reconstructor.reconstructSamples(object, new LocmafGroupState(), context, 0n, allowance).kind).toBe('chunk');
      expect(writes).not.toHaveBeenCalled(); expect(allowance.usage.bytes).toBe(0);
      expect(() => reconstructor.reconstruct(object, new LocmafGroupState(), context, 0n, generous(2, 1))).toThrow(LocmafReadLimitError);
      reconstructor.reconstruct(object, new LocmafGroupState(), context, 0n);
      expect(writes).toHaveBeenCalled();
    } finally { writes.mockRestore(); }
  });
  it('shares one cumulative sample allowance and invalidates a refused delta', () => {
    const reconstructor = new LocmafReconstructor(), state = new LocmafGroupState(), [full, delta] = objects();
    const allowance = generous(2);
    reconstructor.reconstructSamples(full!, state, context, 0n, allowance);
    expect(allowance.usage.samples).toBe(2);
    expect(() => reconstructor.reconstructSamples(delta!, state, context, 1n, allowance)).toThrow(LocmafReadLimitError);
    expect(state.hasReference).toBe(false); expect(allowance.usage.samples).toBe(2);
    expect(() => reconstructor.reconstructSamples(delta!, state, context, 2n, generous(2))).toThrow(LocmafFormatError);
  });
  it('preserves raw-box reference reset and delta gap rejection', () => {
    const reconstructor = new LocmafReconstructor(), state = new LocmafGroupState(), [full, delta] = objects();
    reconstructor.reconstructSamples(full!, state, context, 0n);
    expect(() => reconstructor.reconstructSamples(delta!, state, context, 2n)).toThrow(LocmafFormatError);
    expect(state.hasReference).toBe(false);
    reconstructor.reconstructSamples(full!, state, context, 3n);
    const boxes = isoBox('free', Uint8Array.of(1));
    expect(reconstructor.reconstructSamples({ kind: 'rawBoxes', boxes }, state, context, 4n)).toEqual({ kind: 'raw', bytes: boxes });
    expect(state.lastObjectId).toBe(4n); expect(state.hasReference).toBe(false);
    expect(() => reconstructor.reconstructSamples(delta!, state, context, 5n)).toThrow(LocmafFormatError);
  });
  it('keeps genBox validation when the canonical writer is bypassed', () => {
    const [full] = objects(); if (full?.kind !== 'moof') throw new Error('Expected moof');
    const state = new LocmafGroupState();
    expect(() => new LocmafReconstructor().reconstructSamples({ ...full,
      genBoxes: [{ type: 'invalid', payload: new Uint8Array() }] }, state, context, 0n)).toThrow(LocmafFormatError);
    expect(state.hasReference).toBe(false);
  });
  it('retains protected sample metadata without claiming clear frame consumption', () => {
    const protectedContext = parseLocmafTrackContext(cencVideoInit(8));
    const encoder = new LocmafEncoder(), encodeState = new LocmafGroupState();
    const coded = buildChunk({ bmdt: 0, samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }],
      senc: { ivSize: 8, useSubsamples: false, samples: [{ iv: new Uint8Array(8), subsamples: [] }] } });
    const object = encoder.encode(coded, encodeState, protectedContext, false, 0n);
    const reconstructor = new LocmafReconstructor();
    const canonical = reconstructor.reconstruct(object, new LocmafGroupState(), protectedContext, 0n);
    const samples = reconstructor.reconstructSamples(object, new LocmafGroupState(), protectedContext, 0n, generous(1));
    if (canonical.kind !== 'chunk' || samples.kind !== 'chunk') throw new Error('Expected chunk');
    expect(samples.effective).toEqual(canonical.effective); expect(samples.effective.cenc?.ivs).toHaveLength(8);
  });
});
