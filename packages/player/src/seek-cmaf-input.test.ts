import { describe, expect, it } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, NON_SYNC_FLAGS, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { SeekCmafInput, seekChunkCoverage } from './seek-cmaf-input.js';

const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
const object = (bytes: Uint8Array, id = 0n, group = 3n): MoqtObject => ({ kind: 'data', payload: bytes,
  trackAlias: varint(0), groupId: varint(group), objectId: varint(id), subgroupId: varint(0), publisherPriority: 128 });
const chunk = (pts: bigint, flags = SYNC_FLAGS, cto = 0, duration = 1000) => buildChunk({ trackId: 1, bmdt: pts - BigInt(cto),
  samples: [{ duration, size: 4, flags, cto }], mdat: Uint8Array.of(1, 2, 3, 4) });
function input(id = 0n, budget = 8 * 1024 * 1024) {
  return new SeekCmafInput({ init, packaging: 'cmaf', role: 'video', mediaPts: 4000, timestampRounding: 'floor',
    location: { groupId: 3n, objectId: id }, maxObjects: 500, maxBytes: budget });
}

describe('indexed CMAF seek preparation', () => {
  it('preserves actual nonzero media PTS, composition and sample offsets after validating the index', () => {
    const prepared = input(), bytes = chunk(4000n, SYNC_FLAGS, 40, 2000), emitted: Uint8Array[] = [];
    const ready = prepared.push(object(bytes));
    expect(prepared.ready).toBe(true); expect(prepared.anchor).toEqual({ sourceTimeUs: 4_000_000n,
      rebasedTimeUs: { numerator: 4_000_000n, denominator: 1n } });
    const assembler = new CmafAssembler({ onSegment: (_role, segment) => emitted.push(segment) });
    assembler.setInitSegment('video', init); assembler.setPresentationPlacement('video', prepared.anchor);
    for (const item of ready) assembler.push('video', 'v', item.groupId, item.bytes);
    expect(emitted).toHaveLength(1);
    expect(seekChunkCoverage(emitted[0]!, prepared.context, 5000)).toEqual({ endTimeSeconds: 6, coversTarget: true, maxPresentationEndTicks: 6000n });
    expect(bytes).toEqual(chunk(4000n, SYNC_FLAGS, 40, 2000));
  });

  it('anchors to the exact indexed dependent Object, keeping an earlier independent preroll distinct', () => {
    const prepared = input(1n);
    expect(prepared.push(object(chunk(3000n)))).toEqual([]);
    expect(prepared.anchor).toBeNull();
    const ready = prepared.push(object(chunk(4000n, NON_SYNC_FLAGS), 1n));
    expect(ready.map(item => item.objectId)).toEqual([0n, 1n]);
    expect(prepared.anchor?.sourceTimeUs).toBe(4_000_000n);
    expect(prepared.anchor?.sourceTimeUs).not.toBe(3_000_000n);
    prepared.end();
  });

  it('never certifies a dependent prefix merely because a later independent Object arrives', () => {
    const prepared = input(1n);
    prepared.push(object(chunk(3000n, NON_SYNC_FLAGS)));
    expect(() => prepared.push(object(chunk(4000n), 1n))).toThrow(/begin.*independent/i);
  });

  it('refuses missing indexed media even when the returned later Object is decodable', () => {
    const prepared = input();
    expect(() => prepared.push(object(chunk(4000n), 1n))).toThrow(/indexed Object/);
    expect(prepared.ready).toBe(false);
  });

  it('does not confuse decode-time coverage with actual presentation coverage', () => {
    const prepared = input();
    const bytes = chunk(6000n, SYNC_FLAGS, 2000, 1000);
    expect(seekChunkCoverage(bytes, prepared.context, 4500)).toEqual({ endTimeSeconds: 7, coversTarget: false, maxPresentationEndTicks: 7000n });
    expect(seekChunkCoverage(bytes, prepared.context, 6500)).toEqual({ endTimeSeconds: 7, coversTarget: true, maxPresentationEndTicks: 7000n });
  });

  it('does not infer coverage across a presentation-time hole inside an Object', () => {
    const prepared = input();
    const bytes = buildChunk({ trackId: 1, bmdt: 4000n, samples: [
      { duration: 100, size: 4, flags: SYNC_FLAGS, cto: 0 },
      { duration: 100, size: 4, flags: NON_SYNC_FLAGS, cto: 900 },
    ], mdat: new Uint8Array(8) });
    expect(seekChunkCoverage(bytes, prepared.context, 4500)).toEqual({ endTimeSeconds: 5.1, coversTarget: false, maxPresentationEndTicks: 5100n });
  });

  it('pairs an indexed moof with its mdat before proving the anchor', () => {
    const prepared = input(), bytes = chunk(4000n);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), moofSize = view.getUint32(0);
    expect(prepared.push(object(bytes.slice(0, moofSize)))).toEqual([]); expect(prepared.anchor).toBeNull();
    const ready = prepared.push(object(bytes.slice(moofSize), 1n));
    expect(ready).toHaveLength(1); expect(ready[0]!.objectId).toBe(0n); expect(ready[0]!.bytes).toEqual(bytes);
    expect(prepared.anchor?.sourceTimeUs).toBe(4_000_000n);
  });

  it('refuses an incomplete split pair on FIN and on a different group', () => {
    const bytes = chunk(4000n), moof = bytes.slice(0, new DataView(bytes.buffer).getUint32(0));
    const ended = input(); ended.push(object(moof));
    expect(() => ended.end()).toThrow(/complete indexed/);
    const changedGroup = input(); changedGroup.push(object(moof));
    expect(() => changedGroup.push(object(chunk(5000n), 0n, 4n))).toThrow(/group changed/i);
  });

  it('bounds retained preroll and rejects instead of silently dropping earlier samples', () => {
    const bytes = chunk(3000n), prepared = input(2n, bytes.length);
    prepared.push(object(bytes));
    expect(() => prepared.push(object(chunk(3500n, NON_SYNC_FLAGS), 1n))).toThrow(/budget/);
    expect(prepared.ready).toBe(false);
  });

  it('rejects a genuinely mismatched index before calling it a different source-clock epoch', () => {
    const prepared = input();
    expect(() => prepared.push(object(chunk(90_000n)))).toThrow(/does not match.*timeline index/);
    expect(prepared.ready).toBe(false);
  });

  it.each(['floor', 'nearest'] as const)('retains sample precision under the %s index rule', timestampRounding => {
    const preciseInit = buildInit({ trackId: 1, timescale: 90000, handler: 'vide' });
    const prepared = new SeekCmafInput({ init: preciseInit, packaging: 'cmaf', role: 'video',
      mediaPts: 4000, timestampRounding, location: { groupId: 3n, objectId: 0n }, maxObjects: 100, maxBytes: 4096 });
    prepared.push(object(buildChunk({ trackId: 1, bmdt: 360030n, samples: [{ duration: 90000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) })));
    expect(prepared.anchor).toEqual({ sourceTimeUs: 4_000_333n, rebasedTimeUs: { numerator: 4_000_333n, denominator: 1n } });
  });

  it('uses the actual format rule: floor accepts 4000.666ms at 4000, nearest requires 4001', () => {
    const preciseInit = buildInit({ trackId: 1, timescale: 90000, handler: 'vide' });
    const bytes = buildChunk({ trackId: 1, bmdt: 360060n, samples: [{ duration: 90000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
    const prepare = (timestampRounding: 'nearest' | 'floor', mediaPts: number) => new SeekCmafInput({ init: preciseInit, packaging: 'cmaf', role: 'video',
      mediaPts, timestampRounding, location: { groupId: 3n, objectId: 0n }, maxObjects: 100, maxBytes: 4096 });
    expect(() => prepare('floor', 4000).push(object(bytes))).not.toThrow();
    expect(() => prepare('nearest', 4000).push(object(bytes))).toThrow(/timeline index/);
    expect(() => prepare('nearest', 4001).push(object(bytes))).not.toThrow();
  });

  it('requires historical initialization to match instead of applying a current different codec context', () => {
    const prepared = input();
    expect(prepared.push(object(init))).toEqual([]);
    const changed = buildInit({ trackId: 1, timescale: 90000, handler: 'vide' });
    expect(() => prepared.push(object(changed))).toThrow(/initialization differs/);
  });

  it.each([NaN, Infinity, -1, 1.1])('refuses unusable index timestamp %s before parsing or mutation', mediaPts => {
    expect(() => new SeekCmafInput({ init, packaging: 'cmaf', role: 'video', mediaPts, timestampRounding: 'floor',
      location: { groupId: 3n, objectId: 0n }, maxBytes: 1024, maxObjects: 100 })).toThrow(/timestamp/);
  });
});


describe('seek preparation diagnostic input ownership', () => {
  function prepare(onDiscard?: (input: object, reason: string) => void | Promise<void>, id = 0n, packaging: 'cmaf' | 'locmaf' = 'cmaf', budget = 4096) {
    return new SeekCmafInput({ init, packaging, role: 'video', mediaPts: 4000, timestampRounding: 'floor',
      location: { groupId: 3n, objectId: id }, maxObjects: 500, maxBytes: budget,
      ...(onDiscard ? { onDiscard } : {}) });
  }
  function halves(bytes = chunk(4000n)) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    return [bytes.slice(0, size), bytes.slice(size)] as const;
  }

  it('carries the exact complete Object context without replacing or annotating it', () => {
    const prepared = prepare(), context = Object.freeze({ token: {} }), bytes = chunk(4000n);
    const result = prepared.push(object(bytes), context);
    expect(result[0]!.inputs).toHaveLength(1); expect(result[0]!.inputs![0]).toBe(context);
    expect(result[0]!.bytes).toBe(bytes); expect(context).toEqual({ token: {} });
  });

  it.each(['both', 'moof', 'mdat'] as const)('preserves split Object slots when %s inputs are known', known => {
    const prepared = prepare(), [moof, mdat] = halves();
    const first = known === 'mdat' ? undefined : {}, second = known === 'moof' ? undefined : {};
    expect(prepared.push(object(moof), first)).toEqual([]);
    const result = prepared.push(object(mdat, 1n), second);
    expect(result[0]!.inputs).toHaveLength(2);
    expect(result[0]!.inputs![0]).toBe(first); expect(result[0]!.inputs![1]).toBe(second);
    expect(result[0]!.objectId).toBe(0n); expect(result[0]!.bytes).toEqual(chunk(4000n));
  });

  it('retains exact contexts across bounded preroll and mixed known/unknown Objects', () => {
    const prepared = prepare(undefined, 2n), first = {}, target = {};
    prepared.push(object(chunk(2000n)), first);
    prepared.push(object(chunk(3000n, NON_SYNC_FLAGS), 1n));
    const result = prepared.push(object(chunk(4000n, NON_SYNC_FLAGS), 2n), target);
    expect(result.map(item => item.objectId)).toEqual([0n, 1n, 2n]);
    expect(result[0]!.inputs![0]).toBe(first); expect(result[1]).not.toHaveProperty('inputs');
    expect(result[2]!.inputs![0]).toBe(target);
  });

  it.each(['cmaf', 'locmaf'] as const)('keeps the legacy output shape without inputs for %s', packaging => {
    const prepared = prepare(undefined, 1n, packaging), encoder = new LocmafEncoder(), state = new LocmafGroupState();
    const wire = (pts: bigint, id: bigint) => packaging === 'cmaf' ? chunk(pts)
      : serializeLocmafObject(encoder.encode(chunk(pts), state, parseLocmafTrackContext(init), false, id));
    prepared.push(object(wire(3000n, 0n)));
    const result = prepared.push(object(wire(4000n, 1n), 1n));
    expect(result).toHaveLength(2);
    for (const item of result) expect(Object.keys(item).sort()).toEqual(['bytes', 'groupId', 'objectId']);
  });

  it('keeps split legacy output shape without an inputs property', () => {
    const prepared = prepare(), [moof, mdat] = halves();
    prepared.push(object(moof));
    expect(prepared.push(object(mdat, 1n))[0]).not.toHaveProperty('inputs');
  });

  it('LOCMAF reconstruction carries only the current Object receipt, never the reference/header receipt', () => {
    const prepared = prepare(undefined, 1n, 'locmaf'), encoder = new LocmafEncoder(), state = new LocmafGroupState();
    const contexts = [{ header: true }, { delta: true }];
    const wire = (pts: bigint, id: bigint) => serializeLocmafObject(encoder.encode(chunk(pts), state, parseLocmafTrackContext(init), false, id));
    prepared.push(object(wire(3000n, 0n)), contexts[0]);
    const result = prepared.push(object(wire(4000n, 1n), 1n), contexts[1]);
    expect(result[0]!.inputs).toHaveLength(1); expect(result[0]!.inputs![0]).toBe(contexts[0]);
    expect(result[1]!.inputs).toHaveLength(1); expect(result[1]!.inputs![0]).toBe(contexts[1]);
    expect(prepared.push(object(wire(5000n, 2n), 2n))[0]).not.toHaveProperty('inputs');
  });

  it('ignores a valid init header without inventing a discard or borrowing its receipt for later media', () => {
    const outcomes: [object, string][] = [], prepared = prepare((...args) => { outcomes.push(args); }), header = {};
    expect(prepared.push(object(init), header)).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(prepared.push(object(chunk(4000n)))[0]).not.toHaveProperty('inputs');
  });

  it.each(['parse', 'index', 'budget', 'init', 'locmaf'] as const)('terminates current and retained inputs on %s refusal', kind => {
    const outcomes: [object, string][] = [], first = {}, current = {};
    const prepared = prepare((...args) => { outcomes.push(args); }, kind === 'budget' ? 2n : 1n, kind === 'locmaf' ? 'locmaf' : 'cmaf', kind === 'budget' ? chunk(3000n).length : 4096);
    if (kind !== 'locmaf') prepared.push(object(chunk(3000n)), first);
    const invalid = kind === 'parse' ? Uint8Array.of(0, 0, 0, 1) : kind === 'index' ? chunk(90_000n)
      : kind === 'init' ? buildInit({ trackId: 1, timescale: 90000, handler: 'vide' })
      : kind === 'locmaf' ? Uint8Array.of(255) : chunk(4000n);
    expect(() => prepared.push(object(invalid, 1n), current)).toThrow();
    const expected = kind === 'locmaf' ? [current] : [first, current];
    expect(outcomes).toHaveLength(expected.length);
    expected.forEach((context, i) => expect(outcomes[i]![0]).toBe(context));
    expect(outcomes.every(item => item[1] === 'invalid media')).toBe(true);
    try { prepared.end(); } catch { /* Media validation remains unchanged. */ }
    expect(outcomes).toHaveLength(kind === 'locmaf' ? 1 : 2);
  });

  it('terminates both split inputs on rejection, without double-reporting either', () => {
    const outcomes: object[] = [], prepared = prepare(value => { outcomes.push(value); }), first = {}, second = {};
    const [moof, mdat] = halves(chunk(90_000n));
    prepared.push(object(moof), first);
    expect(() => prepared.push(object(mdat, 1n), second)).toThrow(/timeline index/);
    expect(outcomes).toEqual([first, second]);
    expect(() => prepared.end()).toThrow(); expect(outcomes).toEqual([first, second]);
  });

  it('retires incomplete pending input before a terminal observer can reenter end()', () => {
    const outcomes: object[] = [], context = {};
    const prepared = prepare(value => { outcomes.push(value); expect(() => prepared.end()).toThrow(); });
    prepared.push(object(halves()[0]), context);
    expect(() => prepared.end()).toThrow(/complete indexed/);
    expect(outcomes).toEqual([context]);
  });

  it('terminates a known gap Object and retained incomplete media on refusal', () => {
    const outcomes: object[] = [], prepared = prepare(value => { outcomes.push(value); }), pending = {}, status = {};
    prepared.push(object(halves()[0]), pending);
    const end: MoqtObject = { kind: 'gap', trackAlias: 0n, groupId: 3n, objectId: 1n, subgroupId: 0n, status: 3n };
    expect(() => prepared.push(end, status)).toThrow(/incomplete CMAF/);
    expect(outcomes).toHaveLength(1); expect(outcomes[0]).toBe(pending);
  });

  it('ignores synchronous and asynchronous observer failures on actual media refusal and cancellation', async () => {
    for (const fail of [() => { throw new Error('observer'); }, () => Promise.reject(new Error('observer'))]) {
      const refused = prepare(fail);
      expect(() => refused.push(object(chunk(90_000n)), {})).toThrow(/timeline index/);
      const cancelled = prepare(fail);
      cancelled.push(object(halves()[0]), {});
      expect(() => cancelled.cancel()).not.toThrow();
      expect(cancelled.ready).toBe(false);
    }
    await Promise.resolve();
  });

  it.each(['pending', 'preroll'] as const)('cancel clears %s ownership before observer reentry and is idempotent', retained => {
    const outcomes: [object, string][] = [], context = {};
    const prepared = prepare((...args) => {
      outcomes.push(args); prepared.cancel();
      expect(prepared.ready).toBe(false); expect(prepared.anchor).toBeNull();
      expect(() => prepared.end()).toThrow();
    }, 1n);
    prepared.push(object(retained === 'pending' ? halves(chunk(3000n))[0] : chunk(3000n)), context);
    prepared.cancel(); prepared.cancel();
    expect(outcomes).toHaveLength(1); expect(outcomes[0]![0]).toBe(context);
    expect(outcomes[0]![1]).toBe('decoder reset');
    expect(() => prepared.push(object(chunk(4000n), 1n))).toThrow(/retired/i);
    expect(outcomes).toHaveLength(1);
  });

  it('cancel retires staged and pending inputs, leaving already-emitted contexts alone', () => {
    const outcomes: [object, string][] = [], prepared = prepare((...args) => { outcomes.push(args); }, 2n);
    const staged = {}, pending = {}, [moof] = halves(chunk(3000n));
    prepared.push(object(chunk(2000n)), staged); prepared.push(object(moof, 1n), pending);
    prepared.cancel();
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]![0]).toBe(staged); expect(outcomes[1]![0]).toBe(pending);
    expect(outcomes.map(item => item[1])).toEqual(['decoder reset', 'decoder reset']);
    const emitted = prepare((...args) => { outcomes.push(args); });
    const returned = emitted.push(object(chunk(4000n)), {});
    emitted.cancel(); expect(outcomes).toHaveLength(2); expect(returned).toHaveLength(1);
  });

  it('cancel rejects late known input with a terminal outcome instead of emitting it', () => {
    const outcomes: [object, string][] = [], context = {}, prepared = prepare((...args) => { outcomes.push(args); });
    prepared.cancel();
    expect(() => prepared.push(object(chunk(4000n)), context)).toThrow(/retired/i);
    expect(outcomes).toHaveLength(1); expect(outcomes[0]![0]).toBe(context);
    expect(outcomes[0]![1]).toBe('decoder reset');
  });

  it('a matching init does not invoke a media observer or retire its preparation', () => {
    const outcomes: [object, string][] = [], header = {}, media = {};
    const prepared = prepare((...args) => { outcomes.push(args); prepared.cancel(); });
    expect(prepared.push(object(init), header)).toEqual([]);
    const returned = prepared.push(object(chunk(4000n)), media);
    expect(returned[0]!.inputs).toHaveLength(1); expect(returned[0]!.inputs![0]).toBe(media);
    expect(outcomes).toEqual([]); expect(prepared.ready).toBe(true);
  });

  it('a benign status marker creates no media observation and supplies no later media context', () => {
    const outcomes: object[] = [], prepared = prepare(value => { outcomes.push(value); }), status = {};
    const gap: MoqtObject = { kind: 'gap', trackAlias: 0n, groupId: 3n, objectId: 0n, subgroupId: 0n, status: 1n };
    expect(prepared.push(gap, status)).toEqual([]);
    expect(prepared.push(object(chunk(4000n)))[0]).not.toHaveProperty('inputs');
    prepared.cancel(); expect(outcomes).toEqual([]);
  });

  it('refusal is terminal before observers reenter push or cancel', () => {
    const outcomes: [object, string][] = [], current = {}, late = {};
    const prepared = prepare((...args) => {
      outcomes.push(args);
      if (args[0] === current) {
        prepared.cancel();
        expect(() => prepared.push(object(chunk(4000n)), late)).toThrow(/retired/i);
      }
    });
    expect(() => prepared.push(object(chunk(90_000n)), current)).toThrow(/timeline index/);
    expect(outcomes).toHaveLength(2); expect(outcomes[0]![0]).toBe(current); expect(outcomes[1]![0]).toBe(late);
    expect(outcomes.map(item => item[1])).toEqual(['invalid media', 'invalid media']);
    expect(prepared.anchor).toBeNull(); expect(prepared.ready).toBe(false);
  });

  it('does not synthesize outcomes for unknown inputs during cancel or refusal', () => {
    const outcomes: object[] = [], prepared = prepare(value => { outcomes.push(value); });
    prepared.push(object(halves()[0])); prepared.cancel();
    const refused = prepare(value => { outcomes.push(value); });
    expect(() => refused.push(object(chunk(90_000n)))).toThrow();
    expect(outcomes).toEqual([]);
  });

  it('does not terminate contexts already returned to the caller on a later refusal', () => {
    const outcomes: object[] = [], prepared = prepare(value => { outcomes.push(value); }), emitted = {}, refused = {};
    prepared.push(object(chunk(4000n)), emitted);
    expect(() => prepared.push(object(Uint8Array.of(0), 1n), refused)).toThrow();
    expect(outcomes).toEqual([refused]);
  });
});


describe('retained seek input Object budget across ignored initialization', () => {
  function prepare(onDiscard: (context: object, reason: string) => void, indexed = 0n) {
    return new SeekCmafInput({ init, packaging: 'cmaf', role: 'video', mediaPts: 4000, timestampRounding: 'floor',
      location: { groupId: 3n, objectId: indexed }, maxObjects: 2, maxBytes: 4096, onDiscard });
  }
  function halves(bytes = chunk(4000n)) {
    const cut = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    return [bytes.slice(0, cut), bytes.slice(cut)] as const;
  }

  it('adopted cold reproducer: matching init cannot reset the cap on retained split contexts', () => {
    const outcomes: object[] = [], prepared = prepare(context => { outcomes.push(context); });
    const first = { id: 0 }, contexts = [first];
    prepared.push(object(halves()[0]), first);
    let rejected = false;
    for (let i = 0; i < 4; i++) {
      try {
        prepared.push(object(init, BigInt(i * 2 + 1)));
        const context = { id: i + 1 }; contexts.push(context);
        prepared.push(object(new Uint8Array(), BigInt(i * 2 + 2)), context);
      } catch (error) { expect(String(error)).toMatch(/budget/); rejected = true; break; }
    }
    expect(rejected).toBe(true); expect(outcomes).toHaveLength(3);
    contexts.forEach((context, i) => expect(outcomes[i]).toBe(context));
    prepared.cancel(); expect(outcomes).toHaveLength(3);
  });

  it('adopted control: consecutive fragments enforce the cap and terminate held/current contexts once', () => {
    const outcomes: object[] = [], prepared = prepare(context => { outcomes.push(context); }), contexts = [{}, {}, {}];
    prepared.push(object(halves()[0]), contexts[0]);
    prepared.push(object(new Uint8Array(), 1n), contexts[1]);
    expect(() => prepared.push(object(new Uint8Array(), 2n), contexts[2])).toThrow(/budget/);
    expect(outcomes).toHaveLength(3); contexts.forEach((context, i) => expect(outcomes[i]).toBe(context));
    prepared.cancel(); expect(outcomes).toHaveLength(3);
  });

  it('adopted control: a complete two-half pair at the cap transfers both contexts', () => {
    const outcomes: object[] = [], prepared = prepare(context => { outcomes.push(context); }), contexts = [{}, {}];
    const [moof, mdat] = halves(); prepared.push(object(moof), contexts[0]);
    const result = prepared.push(object(mdat, 1n), contexts[1]);
    expect(result[0]!.inputs).toHaveLength(2); contexts.forEach((context, i) => expect(result[0]!.inputs![i]).toBe(context));
    expect(result[0]!.bytes).toEqual(chunk(4000n)); prepared.cancel(); expect(outcomes).toEqual([]);
  });

  it('matching init is not retained against the cap and does not erase preroll/pending counts', () => {
    const outcomes: [object, string][] = [], prepared = prepare((...args) => { outcomes.push(args); }, 2n);
    const staged = {}, pending = {}, rejected = {}, header = {};
    prepared.push(object(chunk(2000n)), staged);
    prepared.push(object(halves(chunk(3000n))[0], 1n), pending);
    expect(prepared.push(object(init, 2n), header)).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(() => prepared.push(object(new Uint8Array(), 3n), rejected)).toThrow(/budget/);
    expect(outcomes).toHaveLength(3);
    [staged, pending, rejected].forEach((context, i) => expect(outcomes[i]![0]).toBe(context));
    expect(outcomes.map(item => item[1])).toEqual(['invalid media', 'invalid media', 'invalid media']);
  });

  it('a matching header between moof and mdat neither consumes a slot nor loses either media context', () => {
    const outcomes: object[] = [], prepared = prepare(context => { outcomes.push(context); });
    const [moof, mdat] = halves(), first = {}, second = {};
    prepared.push(object(moof), first); prepared.push(object(init, 1n), {});
    const result = prepared.push(object(mdat, 2n), second);
    expect(result[0]!.inputs).toHaveLength(2);
    expect(result[0]!.inputs![0]).toBe(first); expect(result[0]!.inputs![1]).toBe(second);
    prepared.cancel(); expect(outcomes).toEqual([]);
  });
});


describe('exact emitted presentation end', () => {
  it('keeps the largest CTS-adjusted end across reordered samples and complete fragments', () => {
    const first = buildChunk({ trackId: 1, bmdt: 73729n, samples: [
      { duration: 1, size: 4, flags: SYNC_FLAGS, cto: 7 },
      { duration: 1, size: 4, flags: NON_SYNC_FLAGS, cto: -2 },
    ], mdat: new Uint8Array(8) });
    const second = buildChunk({ trackId: 1, bmdt: 73731n,
      samples: [{ duration: 1, size: 4, flags: NON_SYNC_FLAGS, cto: 0 }], mdat: new Uint8Array(4) });
    const joined = new Uint8Array(first.length + second.length); joined.set(first); joined.set(second, first.length);
    const context = parseLocmafTrackContext(buildInit({ trackId: 1, timescale: 12288, handler: 'vide' }));
    const evidence = seekChunkCoverage(joined, context);
    expect(evidence.maxPresentationEndTicks).toBe(73737n);
    expect(evidence.endTimeSeconds).toBe(Number(73737n) / 12288);
    expect(evidence.coversTarget).toBe(false);
  });

  it('retains exact submicrosecond end ticks without expanding ordinary chunk timing or own keys', () => {
    const preciseInit = buildInit({ trackId: 1, timescale: 10000000, handler: 'vide' });
    const prepared = new SeekCmafInput({ init: preciseInit, packaging: 'cmaf', role: 'video',
      mediaPts: 4000, timestampRounding: 'floor', location: { groupId: 3n, objectId: 0n }, maxObjects: 10, maxBytes: 8192 });
    const bytes = buildChunk({ trackId: 1, bmdt: 40000001n,
      samples: [{ duration: 1, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
    const chunks = prepared.push(object(bytes));
    expect(Object.keys(chunks[0]!).sort()).toEqual(['bytes', 'groupId', 'objectId']);
    expect(seekChunkCoverage(bytes, prepared.context).maxPresentationEndTicks).toBe(40000002n);
  });
});

it('exposes existing staged and partial raw counts without diagnostic contexts or chunk-shape changes', () => {
  const prepared = input(3n); expect(prepared.retainedObjectCount).toBe(0);
  prepared.push(object(chunk(3000n))); expect(prepared.retainedObjectCount).toBe(1);
  const bytes = chunk(3500n, NON_SYNC_FLAGS), moofSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  prepared.push(object(bytes.slice(0, moofSize), 1n)); expect(prepared.retainedObjectCount).toBe(2);
  prepared.push(object(bytes.slice(moofSize), 2n)); expect(prepared.retainedObjectCount).toBe(3);
  const chunks = prepared.push(object(chunk(4000n, NON_SYNC_FLAGS), 3n)); expect(prepared.retainedObjectCount).toBe(0);
  expect(chunks).toHaveLength(3); expect(chunks.every(value => Object.keys(value).sort().join(',') === 'bytes,groupId,objectId')).toBe(true);
});
