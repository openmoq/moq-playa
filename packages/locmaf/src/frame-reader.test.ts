import { describe, expect, it } from 'vitest';
import { LocmafFrameReader, LocmafFrameReadError, type LocmafFrameRead, type LocmafFrameReaderLimits } from './frame-reader.js';
import { LocmafReadLimitError } from './read-budget.js';
import { LocmafFormatError } from './errors.js';
import { LocmafEncoder } from './encoder.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext } from './track-context.js';
import { serializeLocmafObject } from './serializer.js';
import { deserializeLocmafObject } from './deserializer.js';
import { childBoxes, findChild } from './iso-box.js';
import { MAX_VI64 } from './vi64.js';
import { buildChunk, buildInit, cencVideoInit, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../test-support/cmaf.js';
import { concat, isoBox } from '../test-support/bytes.js';

const limits: LocmafFrameReaderLimits = { maxSamples: 100, maxEntries: 10000, maxBytes: 100000, maxGroups: 2 };
const raw = (boxes: Uint8Array) => serializeLocmafObject({ kind: 'rawBoxes', boxes });
const sample = (flags = SYNC_FLAGS) => ({ duration: 3000, size: 1, flags });
const chunk = (time = 0n, flags = SYNC_FLAGS, trackId = 1) => buildChunk({ trackId, bmdt: time, samples: [sample(flags)], mdat: Uint8Array.of(41) });
function packets() {
  const context = parseLocmafTrackContext(videoInit()), encoder = new LocmafEncoder(), state = new LocmafGroupState();
  return [chunk(), chunk(3000n, NON_SYNC_FLAGS), chunk(6000n, NON_SYNC_FLAGS)]
    .map((bytes, index) => serializeLocmafObject(encoder.encode(bytes, state, context, false, BigInt(index))));
}
function batch(result: LocmafFrameRead) {
  if (result.kind !== 'batch') throw new Error('Expected a complete sample batch');
  return result;
}
function reason(run: () => unknown, expected: LocmafFrameReadError['reason']) {
  try { run(); throw new Error('Expected local refusal'); }
  catch (error) { expect(error).toBeInstanceOf(LocmafFrameReadError); expect((error as LocmafFrameReadError).reason).toBe(expected); }
}
function withBase(chunkBytes: Uint8Array, base: number): Uint8Array {
  const owned = chunkBytes.slice(), moof = childBoxes(owned, 0, owned.length, '16')[0]!;
  const traf = findChild(owned, moof.contentStart, moof.end, 'traf', '16')!;
  const tfhd = findChild(owned, traf.contentStart, traf.end, 'tfhd', '16')!;
  new DataView(owned.buffer).setBigUint64(tfhd.contentStart + 8, BigInt(base));
  return owned;
}

describe('owned LOCMAF frame Object reader', () => {
  it('resolves full and delta Objects at their original exact Locations', () => {
    const reader = new LocmafFrameReader(videoInit(), limits), [full, delta] = packets();
    expect(deserializeLocmafObject(delta!).kind).toBe('moof');
    const a = batch(reader.push(MAX_VI64, 0n, full!)), b = batch(reader.push(MAX_VI64, 1n, delta!));
    expect(a.location).toEqual({ groupId: MAX_VI64, objectId: 0n });
    expect(b.location).toEqual({ groupId: MAX_VI64, objectId: 1n });
    expect([a.continuity, b.continuity]).toEqual(['first', 'contiguous']);
    expect(a.units.map(unit => [unit.sampleIndex, unit.decodeTime, unit.isSync, [...unit.data]])).toEqual([[0, 0n, true, [41]]]);
    expect(b.units.map(unit => [unit.sampleIndex, unit.decodeTime, unit.isSync])).toEqual([[0, 3000n, false]]);
  });
  it('preserves decode order, signed composition offsets and one sample-index space across chunks', () => {
    const reader = new LocmafFrameReader(videoInit(), limits);
    const a = buildChunk({ bmdt: 0n, samples: [{ ...sample(), cto: 6000 }, { ...sample(NON_SYNC_FLAGS), cto: -3000 }], mdat: Uint8Array.of(1, 2) });
    const result = batch(reader.push(1n, 7n, raw(concat(a, chunk(6000n)))));
    expect(result.location).toEqual({ groupId: 1n, objectId: 7n });
    expect(result.units.map(unit => [unit.sampleIndex, unit.decodeTime, unit.presentationTime, unit.timescale])).toEqual([
      [0, 0n, 6000n, 90000], [1, 3000n, 0n, 90000], [2, 6000n, 6000n, 90000],
    ]);
    expect(result.units.map(unit => [...unit.data])).toEqual([[1], [2], [41]]);
  });
  it('reads base_data_offset on original raw-body coordinates with a Header and several chunks', () => {
    const init = videoInit(), a = buildChunk({ bmdt: 0n, baseDataOffset: true, samples: [sample()], mdat: Uint8Array.of(10) });
    const b = buildChunk({ bmdt: 3000n, baseDataOffset: true, samples: [sample()], mdat: Uint8Array.of(20) });
    const bytes = raw(concat(init, withBase(a, init.length), withBase(b, init.length + a.length)));
    const result = batch(new LocmafFrameReader(undefined, limits).push(3n, 9n, bytes));
    expect(result.header?.context.trackId).toBe(1);
    expect(result.units.map(unit => [unit.sampleIndex, unit.decodeTime, [...unit.data]])).toEqual([[0, 0n, [10]], [1, 3000n, [20]]]);
  });
  it('accepts an in-band Header alone with no samples and no readiness inference', () => {
    const reader = new LocmafFrameReader(undefined, limits), result = batch(reader.push(4n, 0n, raw(videoInit())));
    expect(result.header?.bytes).toEqual(videoInit()); expect(result.units).toEqual([]); expect(reader.hasHeader).toBe(true);
    expect(batch(reader.push(4n, 1n, packets()[0]!)).units).toHaveLength(1);
  });
  it('requires initialization for both raw media and field-model media', () => {
    reason(() => new LocmafFrameReader(undefined, limits).push(0n, 0n, raw(chunk())), 'header-required');
    reason(() => new LocmafFrameReader(undefined, limits).push(0n, 0n, packets()[0]!), 'header-required');
  });
  it('does not adopt an in-band Header from a batch whose later media is invalid', () => {
    const reader = new LocmafFrameReader(undefined, limits);
    expect(() => reader.push(0n, 0n, raw(concat(videoInit(), chunk(0n, SYNC_FLAGS, 2))))).toThrow(LocmafFormatError);
    expect(reader.hasHeader).toBe(false); expect(reader.retainedUsage).toEqual({ groups: 0, bytes: 0, entries: 0 });
    reason(() => reader.push(0n, 1n, packets()[0]!), 'header-required');
  });
  it('refuses an incomplete raw carrier locally rather than declaring raw-box syntax invalid', () => {
    const moof = childBoxes(chunk(), 0, chunk().length, '16')[0]!;
    const reader = new LocmafFrameReader(videoInit(), limits);
    reason(() => reader.push(0n, 0n, raw(chunk().subarray(0, moof.end))), 'incomplete');
    reason(() => reader.push(0n, 1n, raw(isoBox('mdat', Uint8Array.of(1)))), 'incomplete');
    expect(batch(reader.push(0n, 2n, raw(chunk()))).units).toHaveLength(1);
  });
  it('returns no partial batch when a later complete chunk has a foreign track', () => {
    const reader = new LocmafFrameReader(videoInit(), limits);
    let published: LocmafFrameRead | undefined;
    expect(() => { published = reader.push(0n, 0n, raw(concat(chunk(), chunk(3000n, SYNC_FLAGS, 2)))); }).toThrow(LocmafFormatError);
    expect(published).toBeUndefined(); expect(reader.retainedUsage.groups).toBe(0);
  });
  it('never treats a full metadata header as a coded keyframe', () => {
    const context = parseLocmafTrackContext(videoInit());
    const full = serializeLocmafObject(new LocmafEncoder().encode(chunk(0n, NON_SYNC_FLAGS), new LocmafGroupState(), context, false, 0n));
    expect(batch(new LocmafFrameReader(videoInit(), limits).push(8n, 0n, full)).units[0]!.isSync).toBe(false);
  });
  it('keeps a known loss marker after a gap, then accepts full metadata without hiding the gap', () => {
    const reader = new LocmafFrameReader(videoInit(), limits), [full, delta, later] = packets();
    reader.push(1n, 0n, full!);
    expect(() => reader.push(1n, 2n, later!)).toThrow(LocmafFormatError);
    expect(() => reader.push(1n, 3n, delta!)).toThrow(LocmafFormatError);
    expect(batch(reader.push(1n, 4n, full!)).continuity).toBe('gap');
    expect(batch(reader.push(1n, 5n, delta!)).continuity).toBe('contiguous');
  });
  it('invalidates only the replayed Group and never rewinds its frontier', () => {
    const reader = new LocmafFrameReader(videoInit(), limits), [full, delta] = packets();
    reader.push(1n, 0n, full!); reader.push(2n, 0n, full!);
    reason(() => reader.push(1n, 0n, full!), 'replay');
    expect(() => reader.push(1n, 1n, delta!)).toThrow(LocmafFormatError);
    expect(batch(reader.push(2n, 1n, delta!)).continuity).toBe('contiguous');
    expect(batch(reader.push(1n, 2n, full!)).continuity).toBe('gap');
  });
  it('explicit reset retains a bounded discontinuity marker', () => {
    const reader = new LocmafFrameReader(videoInit(), limits), [full, delta] = packets();
    reader.push(1n, 0n, full!); reader.resetGroup(1n);
    expect(() => reader.push(1n, 1n, delta!)).toThrow(LocmafFormatError);
    expect(batch(reader.push(1n, 2n, full!)).continuity).toBe('gap');
    const before = reader.retainedUsage; reader.resetGroup(9n); expect(reader.retainedUsage).toEqual(before);
  });
  it('rawBoxes resets only its own Group reference even when the Header is unchanged', () => {
    const reader = new LocmafFrameReader(videoInit(), limits), [full, delta] = packets();
    reader.push(1n, 0n, full!); reader.push(2n, 0n, full!);
    const header = batch(reader.push(1n, 1n, raw(videoInit())));
    expect(header.header).toBeUndefined(); expect(header.units).toEqual([]);
    expect(() => reader.push(1n, 2n, delta!)).toThrow(LocmafFormatError);
    expect(batch(reader.push(2n, 1n, delta!)).units[0]!.decodeTime).toBe(3000n);
  });
  it('stages eviction until a new Group is accepted and discloses unknown history after eviction', () => {
    const reader = new LocmafFrameReader(videoInit(), { ...limits, maxGroups: 1 }), [full, delta] = packets();
    reader.push(1n, 0n, full!);
    expect(() => reader.push(2n, 0n, Uint8Array.of(0xff))).toThrow(LocmafFormatError);
    expect(batch(reader.push(1n, 1n, delta!)).continuity).toBe('contiguous');
    reader.push(2n, 0n, full!);
    expect(reader.retainedUsage.groups).toBe(1);
    expect(batch(reader.push(1n, 9n, full!)).continuity).toBe('first');
  });
  it('transfers a changed Header and the original complete carrier for successor replay', () => {
    const reader = new LocmafFrameReader(videoInit(), limits);
    const init = buildInit({ trackId: 7, timescale: 48000, handler: 'vide' });
    const input = raw(concat(init, chunk(48000n, SYNC_FLAGS, 7))), result = reader.push(3n, 9n, input);
    expect(result.kind).toBe('reconfigure');
    if (result.kind !== 'reconfigure') throw new Error('Expected reconfiguration');
    expect(result.location).toEqual({ groupId: 3n, objectId: 9n }); expect(result.replay).toEqual(input);
    expect(result.replay).not.toBe(input); expect(result.header.context).toMatchObject({ trackId: 7, timescale: 48000 });
    expect(reader.retainedUsage).toEqual({ groups: 0, entries: 0, bytes: 0 });
    reason(() => reader.push(3n, 10n, input), 'retired');
    const successor = new LocmafFrameReader(result.header.bytes, limits);
    const replay = batch(successor.push(result.location.groupId, result.location.objectId, result.replay));
    expect(replay.header).toBeUndefined(); expect(replay.units[0]).toMatchObject({ sampleIndex: 0, decodeTime: 48000n, timescale: 48000 });
  });
  it('does not equate a reconfiguration offer with valid media', () => {
    const init = buildInit({ trackId: 7, timescale: 48000, handler: 'vide' });
    const result = new LocmafFrameReader(videoInit(), limits).push(0n, 0n, raw(concat(init, chunk())));
    expect(result.kind).toBe('reconfigure');
    if (result.kind !== 'reconfigure') throw new Error('Expected reconfiguration');
    expect(() => new LocmafFrameReader(result.header.bytes, limits).push(0n, 0n, result.replay)).toThrow(LocmafFormatError);
  });
  it('refuses a non-leading replacement Header instead of labeling its media with the previous timescale', () => {
    const init = buildInit({ trackId: 1, timescale: 48000, handler: 'vide' });
    const replacement = concat(init, chunk(48000n));
    const reader = new LocmafFrameReader(videoInit(), limits);
    reason(() => reader.push(0n, 0n, raw(concat(isoBox('free'), replacement))), 'initialization-placement');
    expect(reader.retainedUsage.groups).toBe(0);
    const leading = reader.push(0n, 1n, raw(replacement));
    expect(leading.kind).toBe('reconfigure');
    if (leading.kind !== 'reconfigure') throw new Error('Expected reconfiguration');
    expect(leading.header.context.timescale).toBe(48000);
  });
  it('refuses every unsupported initialization placement before returning any media', () => {
    for (const boxes of [concat(videoInit(), chunk(), videoInit()), concat(chunk(), videoInit()),
      concat(isoBox('free'), videoInit()), concat(videoInit(), isoBox('moov'))]) {
      reason(() => new LocmafFrameReader(videoInit(), limits).push(0n, 0n, raw(boxes)), 'initialization-placement');
    }
    expect(() => new LocmafFrameReader(concat(videoInit(), isoBox('moov')), limits)).toThrow(LocmafFrameReadError);
  });
  it('isolates constructor input, in-band Header snapshots and returned sample backing from retained state', () => {
    const init = videoInit(), reader = new LocmafFrameReader(init, limits), [full, delta] = packets();
    init.fill(0); const a = batch(reader.push(0n, 0n, full!));
    new Uint8Array(a.units[0]!.data.buffer).fill(0);
    expect(batch(reader.push(0n, 1n, delta!)).units[0]!.decodeTime).toBe(3000n);
    const inBand = new LocmafFrameReader(undefined, limits);
    const input = raw(concat(videoInit(), chunk())), first = batch(inBand.push(1n, 0n, input));
    input.fill(0); first.header!.bytes.fill(0); first.header!.description!.fill(0);
    new Uint8Array(first.units[0]!.data.buffer).fill(0);
    expect(batch(inBand.push(1n, 1n, full!)).units[0]!.timescale).toBe(90000);
  });
  it('returns an owned seeded configuration snapshot without mutating the retained Header', () => {
    const reader = new LocmafFrameReader(videoInit(), limits), header = reader.snapshotInitialization()!;
    header.bytes.fill(0); header.description!.fill(0);
    expect(reader.snapshotInitialization()!.bytes).toEqual(videoInit());
    expect(batch(reader.push(0n, 0n, raw(concat(videoInit(), chunk())))).units).toHaveLength(1);
    expect(new LocmafFrameReader(undefined, limits).snapshotInitialization()).toBeNull();
    reader.retire(); expect(reader.snapshotInitialization()).toBeNull();
  });
  it('reserves a detached Header snapshot in addition to private retained bytes', () => {
    const retained = new LocmafFrameReader(videoInit(), limits).retainedUsage.bytes;
    const reader = new LocmafFrameReader(videoInit(), { ...limits, maxBytes: retained });
    const before = reader.retainedUsage;
    expect(() => reader.snapshotInitialization()).toThrow(LocmafReadLimitError);
    expect(reader.retainedUsage).toEqual(before); expect(reader.hasHeader).toBe(true);
    const ample = new LocmafFrameReader(videoInit(), { ...limits, maxBytes: 2 * retained });
    expect(ample.snapshotInitialization()!.bytes).toEqual(videoInit());
  });
  it('compares only the CMAF Header when an external initialization has trailing non-media boxes', () => {
    const reader = new LocmafFrameReader(concat(videoInit(), isoBox('free', Uint8Array.of(1))), limits);
    expect(batch(reader.push(0n, 0n, raw(concat(videoInit(), chunk())))).units).toHaveLength(1);
  });
  it('refuses protected consumption as unsupported without changing generic reconstruction support', () => {
    reason(() => new LocmafFrameReader(cencVideoInit(8), limits), 'protected');
    const reader = new LocmafFrameReader(undefined, limits);
    reason(() => reader.push(0n, 0n, raw(cencVideoInit(8))), 'protected');
    expect(reader.hasHeader).toBe(false);
  });
  it('bounds all samples in a multichunk batch and retains no partial reference on refusal', () => {
    const reader = new LocmafFrameReader(videoInit(), { ...limits, maxSamples: 1 });
    expect(() => reader.push(1n, 0n, raw(concat(chunk(), chunk(3000n))))).toThrow(LocmafReadLimitError);
    expect(reader.retainedUsage.groups).toBe(0);
    expect(batch(reader.push(1n, 1n, raw(chunk()))).units).toHaveLength(1);
  });
  it('charges the owned payload copy even if its samples would otherwise be borrowed', () => {
    const init = videoInit(), reference = new LocmafFrameReader(init, limits), retained = reference.retainedUsage.bytes;
    const reader = new LocmafFrameReader(init, { ...limits, maxBytes: retained + packets()[0]!.length - 1 });
    expect(() => reader.push(0n, 0n, packets()[0]!)).toThrow(LocmafReadLimitError);
    expect(reader.retainedUsage.groups).toBe(0);
  });
  it('includes private retained metadata in the next read allowance, not only Group count', () => {
    const media = buildChunk({ bmdt: 0n, samples: Array.from({ length: 50 }, () => sample()) });
    const full = serializeLocmafObject(new LocmafEncoder().encode(media, new LocmafGroupState(), parseLocmafTrackContext(videoInit()), false, 0n));
    const ample = new LocmafFrameReader(videoInit(), limits); ample.push(0n, 0n, full!);
    const once = ample.retainedUsage.entries;
    // First read has no retained sample vectors. Find the smallest allowance
    // that admits it; the next Group must share that allowance with its state.
    let minimum = 1;
    for (; minimum < limits.maxEntries; minimum++) {
      try { new LocmafFrameReader(videoInit(), { ...limits, maxEntries: minimum }).push(0n, 0n, full!); break; }
      catch (error) { if (!(error instanceof LocmafReadLimitError)) throw error; }
    }
    expect(minimum).toBeGreaterThan(once);
    const reader = new LocmafFrameReader(videoInit(), { ...limits, maxEntries: minimum });
    reader.push(0n, 0n, full!);
    expect(() => reader.push(1n, 0n, full!)).toThrow(LocmafReadLimitError);
    expect(reader.retainedUsage.groups).toBe(1);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limits %s', value => {
    for (const key of ['maxSamples', 'maxEntries', 'maxBytes', 'maxGroups'] as const)
      expect(() => new LocmafFrameReader(undefined, { ...limits, [key]: value })).toThrow(RangeError);
  });
  it('snapshots limits once and does not invoke payload subclass hooks', () => {
    let reads = 0;
    const options = { get maxSamples() { reads++; return 100; }, get maxEntries() { reads++; return 10000; },
      get maxBytes() { reads++; return 100000; }, get maxGroups() { reads++; return 2; } };
    const reader = new LocmafFrameReader(videoInit(), options); expect(reads).toBe(4);
    class Bytes extends Uint8Array { static get [Symbol.species]() { throw new Error('Caller species executed'); } }
    const input = new Bytes(packets()[0]!);
    Object.defineProperty(input, 'byteLength', { get() { throw new Error('Caller length executed'); } });
    expect(batch(reader.push(0n, 0n, input)).units).toHaveLength(1); expect(reads).toBe(4);
  });
  it('validates exact wire bounds and retires idempotently with no retained state', () => {
    const reader = new LocmafFrameReader(videoInit(), limits);
    expect(() => reader.push(-1n, 0n, packets()[0]!)).toThrow(RangeError);
    expect(() => reader.push(0n, MAX_VI64 + 1n, packets()[0]!)).toThrow(RangeError);
    reader.push(0n, 0n, packets()[0]!); reader.retire(); reader.retire();
    expect(reader.hasHeader).toBe(false); expect(reader.retainedUsage).toEqual({ entries: 0, bytes: 0, groups: 0 });
    reason(() => reader.push(0n, 1n, packets()[1]!), 'retired');
  });
});
