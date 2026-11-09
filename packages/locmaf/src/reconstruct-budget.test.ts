import { describe, expect, it, vi } from 'vitest';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafFormatError } from './errors.js';
import { LocmafHeader, type LocmafObject } from './model.js';
import { LocmafFieldId as F } from './fields.js';
import { parseLocmafTrackContext } from './track-context.js';
import { videoInit, cencVideoInit } from '../test-support/cmaf.js';
import { zigzagEncode } from './vi64.js';

import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
function budget(maxSamples: number, maxEntries = 1000, maxBytes = 10000) {
  return new LocmafReadBudget({ maxSamples, maxEntries, maxBytes });
}
const context = parseLocmafTrackContext(videoInit());
function full(n: number): LocmafObject {
  const header = new LocmafHeader(true);
  header.set(F.TFDT_BASE_MEDIA_DECODE_TIME, { kind: 'scalar', value: 0n });
  header.set(F.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: BigInt(n) });
  header.set(F.TFHD_DEFAULT_SAMPLE_DURATION, { kind: 'scalar', value: 1000n });
  header.set(F.TFHD_DEFAULT_SAMPLE_SIZE, { kind: 'scalar', value: 1n });
  header.set(F.TFHD_DEFAULT_SAMPLE_FLAGS, { kind: 'scalar', value: 0x02000000n });
  return { kind: 'moof', genBoxes: [], header, mdat: new Uint8Array(n) };
}
function bounded(reconstructor: LocmafReconstructor, object: LocmafObject, state: LocmafGroupState, objectId: bigint,
  allowance: ReturnType<typeof budget>) {
  return reconstructor.reconstruct(object, state, context, objectId, allowance);
}

describe('LOCMAF reconstruction read allowances', () => {
  it.each(['reconstruct', 'reconstructSamples'] as const)('retires an earlier reference on initial snapshot refusal in %s', method => {
    const state = new LocmafGroupState(), reconstructor = new LocmafReconstructor();
    reconstructor[method](full(1), state, context, 0n);
    expect(() => reconstructor[method](full(1), state, context, 1n, budget(1, 1))).toThrow(LocmafReadLimitError);
    expect(state.hasReference).toBe(false); expect(state.lastObjectId).toBe(0n);
    const delta: LocmafObject = { kind: 'moof', genBoxes: [], header: new LocmafHeader(false), mdat: Uint8Array.of(1) };
    expect(() => reconstructor[method](delta, state, context, 2n)).toThrow(LocmafFormatError);
    reconstructor[method](full(1), state, context, 3n);
    const recovered = reconstructor[method](delta, state, context, 4n, budget(1));
    if (recovered.kind !== 'chunk') throw new Error('Expected recovered chunk');
    expect(recovered.effective.baseMediaDecodeTime).toBe(1000n);
  });

  it('reserves CENC subsample vectors before either list is mapped', () => {
    const object = full(1);
    if (object.kind !== 'moof') throw new Error('Expected moof');
    object.header.set(F.TFHD_DEFAULT_SAMPLE_SIZE, { kind: 'scalar', value: 32n });
    object.header.set(F.SENC_SUBSAMPLE_COUNT, { kind: 'list', values: [32n] });
    object.header.set(F.SENC_INITIALIZATION_VECTOR, { kind: 'bytes', bytes: new Uint8Array(8) });
    const clear = Array<bigint>(32).fill(0n), protectedBytes = Array<bigint>(32).fill(1n);
    object.header.set(F.SENC_BYTES_OF_CLEAR_DATA, { kind: 'list', values: clear });
    object.header.set(F.SENC_BYTES_OF_PROTECTED_DATA, { kind: 'list', values: protectedBytes });
    const protectedContext = parseLocmafTrackContext(cencVideoInit(8));
    const reconstructor = new LocmafReconstructor(), state = new LocmafGroupState();
    const healthy = reconstructor.effectiveValues(object.header, 32, state, protectedContext, true);
    expect(healthy.cenc?.clearBytes).toHaveLength(32);
    const mappedClear = vi.spyOn(clear, 'map'), mappedProtected = vi.spyOn(protectedBytes, 'map');
    const allowance = budget(1, 68);
    expect(() => reconstructor.effectiveValues(object.header, 32, state, protectedContext, true, allowance))
      .toThrow(LocmafReadLimitError);
    expect(mappedClear).not.toHaveBeenCalled(); expect(mappedProtected).not.toHaveBeenCalled();
  });
  it.each(['canonical', 'samples'] as const)('does not commit after a late group-snapshot refusal on %s', kind => {
    const state = new LocmafGroupState(), reconstructor = new LocmafReconstructor();
    reconstructor.reconstruct(full(1), state, context, 0n);
    const allowance = budget(1), originalClaim = allowance.claimEntries.bind(allowance);
    const anchor = state.anchor.bind(state);
    let committing = false;
    const allocation = vi.spyOn(allowance, 'claimEntries').mockImplementation(count => {
      if (committing) throw new LocmafReadLimitError('snapshot allocation refused');
      originalClaim(count);
    });
    const commit = vi.spyOn(state, 'anchor').mockImplementation((...args) => {
      committing = true;
      try { anchor(...args); } finally { committing = false; }
    });
    try {
      expect(() => kind === 'canonical' ? bounded(reconstructor, full(1), state, 1n, allowance)
        : reconstructor.reconstructSamples(full(1), state, context, 1n, allowance)).toThrow(LocmafReadLimitError);
      expect(commit).toHaveBeenCalledOnce(); expect(state.hasReference).toBe(false);
      expect(state.lastObjectId).toBe(0n);
    } finally { allocation.mockRestore(); commit.mockRestore(); }
  });

  it('refuses a full-header sample count before publishing a reference', () => {
    const state = new LocmafGroupState(), reconstructor = new LocmafReconstructor();
    expect(() => bounded(reconstructor, full(3), state, 0n, budget(2))).toThrow(LocmafReadLimitError);
    expect(state.hasReference).toBe(false);
  });
  it('checks a delta count before mapping its per-sample metadata', () => {
    const state = new LocmafGroupState(), reconstructor = new LocmafReconstructor();
    reconstructor.reconstruct(full(1), state, context, 0n);
    const durations = [0n, 0n, 0n], mapped = vi.spyOn(durations, 'map');
    const header = new LocmafHeader(false);
    header.set(F.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: zigzagEncode(2n) });
    header.set(F.TRUN_SAMPLE_DURATIONS, { kind: 'list', values: durations });
    const object: LocmafObject = { kind: 'moof', genBoxes: [], header, mdat: new Uint8Array(3) };
    expect(() => bounded(reconstructor, object, state, 1n, budget(2))).toThrow(LocmafReadLimitError);
    expect(mapped).not.toHaveBeenCalled(); expect(state.hasReference).toBe(false);
  });
  it('refuses metadata/vector storage rather than allocating solely from sample count', () => {
    const state = new LocmafGroupState(), reconstructor = new LocmafReconstructor();
    const object = full(3);
    if (object.kind !== 'moof') throw new Error('Expected media');
    const flags = [0x02000000n, 0x01010000n, 0x01010000n], mapped = vi.spyOn(flags, 'map');
    object.header.set(F.TRUN_SAMPLE_FLAGS, { kind: 'list', values: flags });
    expect(() => bounded(reconstructor, object, state, 0n, budget(3, 8))).toThrow(LocmafReadLimitError);
    expect(mapped).not.toHaveBeenCalled(); expect(state.hasReference).toBe(false);
  });
  it('refuses the canonical byte allocation before committing the group', () => {
    const state = new LocmafGroupState(), reconstructor = new LocmafReconstructor();
    expect(() => bounded(reconstructor, full(1), state, 0n, budget(1, 1000, 1))).toThrow(LocmafReadLimitError);
    expect(state.hasReference).toBe(false);
  });
  it('retains ordinary reconstruction and admits the exact sample allowance', () => {
    const object = full(3), normalState = new LocmafGroupState(), boundedState = new LocmafGroupState();
    const reconstructor = new LocmafReconstructor();
    const normal = reconstructor.reconstruct(object, normalState, context, 0n);
    expect(bounded(reconstructor, object, boundedState, 0n, budget(3))).toEqual(normal);
    expect(boundedState.lastEffective?.durations).toEqual([1000, 1000, 1000]);
    expect(boundedState.hasReference).toBe(true);
  });
});
