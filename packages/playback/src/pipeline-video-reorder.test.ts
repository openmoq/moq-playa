/**
 * Bounded LOC decode-order waits across two temporal-layer streams:
 * even Objects on Subgroup0, odd Objects on Subgroup1.
 * @see docs/draft-ietf-moq-loc-04.txt sections4.2/4.3.
 * Sans-I/O command/input assertions; no decoder/native/network claim.
 */
import { describe, expect, it } from 'vitest';
import { ObjectStatus, varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { DecoderCommand, PlaybackEvent, PlaybackInputDiscardReason } from './types.js';

const GAP = 200_000;
const wire = (group: number, object: number, priority = 128): MoqtObjectData => ({
  kind: 'data', trackAlias: varint(1), groupId: varint(group), objectId: varint(object),
  subgroupId: varint(object % 2), publisherPriority: priority, extensions: undefined,
  payload: Uint8Array.of(group, object),
});
function headers(group: number, object: number, key: boolean): LocHeaders {
  return { captureTimestamp: 1_000_000_000n + BigInt(group * 100_000 + object * 1000),
    videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: key,
      discardable: object % 2 === 1, baseLayerSync: false, temporalId: object % 2 },
    ...(key ? { videoConfig: Uint8Array.of(1, 100) } : {}) };
}
function fixture(options: { mediaType?: 'video' | 'audio'; depth?: number; release?: number } = {}) {
  let serial = 0;
  const highestObject = new Map<bigint, bigint>();
  let now = 5_000_000, onNow: (() => void) | undefined;
  const clock = { now: () => { const hook = onNow; onNow = undefined; hook?.(); return now; } };
  const commands: DecoderCommand[] = [], events: PlaybackEvent[] = [];
  const discards: Array<{ input: object; reason: PlaybackInputDiscardReason }> = [];
  const sync = new SyncController({ clock, driftThresholdUs: 500_000 });
  sync.setAudioReference(1_000_000_000n);
  const pipeline = new PlaybackPipeline({ mediaType: options.mediaType ?? 'video', clock, sync,
    config: { gapTimeoutUs: GAP, driftThresholdUs: 500_000, maxBufferDepth: options.depth ?? 100, ...(options.release === undefined ? {} : { maxReleasePerTick: options.release }) },
    onCommand: command => { commands.push(command); }, onEvent: event => { events.push(event); } });
  pipeline.inputObserver = (input, reason) => { discards.push({ input, reason }); };
  if (options.mediaType === 'audio') pipeline.configure(Uint8Array.of(1));
  const push = (group: number, object: number, key = false, priority = 128) => {
    const groupId = BigInt(group), objectId = BigInt(object);
    if (objectId > (highestObject.get(groupId) ?? -1n)) highestObject.set(groupId, objectId);
    const input = { group, object, serial: ++serial };
    pipeline.pushObject(wire(group, object, priority), options.mediaType === 'audio'
      ? { captureTimestamp: 1_000_000_000n + BigInt(object * 1000) } : headers(group, object, key), input);
    return input;
  };
  // Root exposes completion through the existing status input, not endGroup().
  // A bound after the highest supplied Object does not assert every earlier Object arrived.
  const endGroup = (groupId: bigint) => pipeline.pushObject({ kind: 'gap', trackAlias: varint(1),
    groupId: varint(groupId), subgroupId: varint(0),
    objectId: varint((highestObject.get(groupId) ?? -1n) + 1n), status: ObjectStatus.END_OF_GROUP });
  const decoded = () => commands.filter(command => command.type === 'decode_video' || command.type === 'decode_audio');
  const resets = () => commands.filter(command => command.type === 'reset');
  const seed = () => { push(0, 0, true); pipeline.tick(); expect(decoded()).toHaveLength(1); };
  return { pipeline, endGroup, sync, commands, events, discards, push, decoded, resets, seed,
    advance(us: number) { now += us; }, armClock(hook: () => void) { onNow = hook; } };
}

describe('bounded video cross-stream Object reorder', () => {
  it('waits for Object1 after Object2 on an already started Group without resetting', () => {
    const f = fixture(); f.seed();
    const second = f.push(0, 2); f.pipeline.tick();
    expect.soft(f.resets()).toEqual([]); expect.soft(f.discards).toEqual([]);
    f.advance(50_000); const first = f.push(0, 1); f.pipeline.tick();
    expect(f.resets()).toEqual([]);
    expect(f.decoded().map(c => c.chunk.data[1])).toEqual([0, 1, 2]);
    expect(f.decoded().slice(1).map(c => c.inputToken)).toEqual([first, second]);
  });

  it('waits for a new Group RAP that completes after its delta', () => {
    const f = fixture(); f.seed(); f.push(0, 1); f.pipeline.tick(); f.endGroup(0n);
    const delta = f.push(1, 1); f.pipeline.tick();
    expect.soft(f.resets()).toEqual([]); expect.soft(f.discards).toEqual([]);
    f.advance(50_000); const key = f.push(1, 0, true); f.pipeline.tick();
    expect(f.resets()).toEqual([]);
    expect(f.decoded().slice(-2).map(c => c.inputToken)).toEqual([key, delta]);
    expect(f.pipeline.currentGroupId).toBe(1n);
  });

  it('skips a still-missing Object only after the existing gap timeout', () => {
    const f = fixture(); f.seed(); const suffix = f.push(0, 2); f.pipeline.tick();
    expect.soft(f.resets()).toEqual([]); expect.soft(f.discards).toEqual([]);
    f.advance(GAP + 1); f.pipeline.tick();
    expect(f.resets()).toHaveLength(1);
    expect(f.discards).toEqual([{ input: suffix, reason: 'skipped' }]);
    expect(f.decoded()).toHaveLength(1);
  });

  it('retains startup delta1 until Object0 arrives without premature initial cursor mutation', () => {
    const f = fixture(), delta = f.push(0, 1);
    const before = f.pipeline.currentGroupId; f.pipeline.tick();
    expect.soft(f.discards).toEqual([]); expect.soft(f.pipeline.currentGroupId).toBe(before);
    expect.soft(f.commands).toEqual([]);
    f.advance(GAP - 1); const key = f.push(0, 0, true); f.pipeline.tick();
    expect(f.decoded().map(c => c.inputToken)).toEqual([key, delta]);
    expect(f.resets()).toEqual([]); expect(f.discards).toEqual([]);
  });
});

describe('video wait ownership and actual local loss', () => {
  it('does not resurrect an abandoned Group when its old RAP completes after expiry', () => {
    const f = fixture(); f.seed(); f.endGroup(0n);
    const suffix = f.push(1, 1); f.pipeline.tick();
    expect.soft(f.resets()).toEqual([]);
    f.advance(GAP + 1); f.pipeline.tick();
    expect(f.discards).toContainEqual({ input: suffix, reason: 'skipped' });
    const before = f.decoded().length, old = f.push(1, 0, true); f.pipeline.tick();
    expect(f.decoded(), 'late RAP cannot reopen a Group already abandoned for its dependency hole').toHaveLength(before);
    expect(f.discards.some(d => d.input === old)).toBe(true);
    const fresh = f.push(2, 0, true); f.pipeline.tick();
    expect(f.decoded().at(-1)?.inputToken).toBe(fresh);
  });

  it.each(['reset', 'seek', 'trackSwitch'] as const)('starts a fresh wait deadline after %s changes the owner', operation => {
    const f = fixture(); f.seed(); f.push(0, 2); f.pipeline.tick(); f.advance(GAP - 1);
    if (operation === 'reset') f.pipeline.reset();
    else if (operation === 'seek') f.pipeline.reset(7n);
    else f.pipeline.resetForTrackSwitch(7n);
    f.commands.length = 0; f.discards.length = 0;
    const before = f.pipeline.currentGroupId, delta = f.push(7, 1); f.pipeline.tick();
    f.advance(2); f.pipeline.tick(); // Past old wait's deadline, inside new wait.
    expect.soft(f.discards).toEqual([]); expect.soft(f.pipeline.currentGroupId).toBe(before);
    expect.soft(f.commands).toEqual([]);
    const key = f.push(7, 0, true); f.pipeline.tick();
    expect(f.decoded().map(c => c.inputToken)).toEqual([key, delta]);
    expect(f.resets()).toEqual([]); expect(f.discards).toEqual([]);
  });

  it('keeps audio independently decodable while an earlier Object is missing', () => {
    const f = fixture({ mediaType: 'audio' }); f.seed(); const later = f.push(0, 2); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2); expect(f.decoded()[1]?.inputToken).toBe(later);
    expect(f.resets()).toEqual([]); expect(f.discards).toEqual([]);
  });

  it.each(['eviction', 'refusal'] as const)('skips promptly only when %s proves the exact missing Object was locally lost', loss => {
    const f = fixture({ depth: 2 }); f.seed();
    let missing: object;
    if (loss === 'eviction') {
      missing = f.push(0, 1, false, 200); f.push(0, 2, false, 100); f.push(0, 3, false, 10);
    } else {
      f.push(0, 2, false, 10); f.push(0, 3, false, 10); missing = f.push(0, 1, false, 200);
    }
    expect(f.discards).toContainEqual({ input: missing, reason: loss === 'eviction' ? 'buffer eviction' : 'buffer full' });
    f.pipeline.tick();
    expect(f.resets()).toHaveLength(1); expect(f.decoded()).toHaveLength(1);
    expect(f.pipeline.bufferedGroupCount).toBe(0);
  });

  it.each(['same-group-later', 'future-group'] as const)('does not treat a %s local refusal as proof the earlier in-flight hole is lost', location => {
    const f = fixture({ depth: 2 }); f.seed(); f.push(0, 2, false, 10); f.push(0, 3, false, 10);
    const refused = location === 'same-group-later' ? f.push(0, 4, false, 200) : f.push(1, 0, true, 200);
    expect(f.discards).toEqual([{ input: refused, reason: 'buffer full' }]);
    f.pipeline.tick(); f.advance(50_000); f.pipeline.tick();
    expect(f.resets(), 'local loss after Object1 does not prove Object1 is unavailable').toEqual([]);
    expect(f.discards).toEqual([{ input: refused, reason: 'buffer full' }]);
    expect(f.decoded()).toHaveLength(1);
  });

  it('accepts a retry of a refused Object and does not poison the next earlier-than-loss wait', () => {
    const f = fixture({ depth: 2, release: 1 }); f.seed(); f.push(0, 1, false, 10); f.push(0, 2, false, 10);
    const refused = f.push(0, 3, false, 200);
    expect(f.discards).toContainEqual({ input: refused, reason: 'buffer full' });
    f.pipeline.tick(); // Consume Object1: the retry now has real capacity.
    expect(f.decoded().map(c => c.chunk.data[1])).toEqual([0, 1]);
    const retry = f.push(0, 3, false, 10); f.pipeline.tick(); f.pipeline.tick();
    expect(f.decoded().map(c => c.chunk.data[1])).toEqual([0, 1, 2, 3]);
    expect(f.decoded().at(-1)?.inputToken).toBe(retry);
    const later = f.push(0, 5, false, 10); f.pipeline.tick(); // Object4 is still in flight.
    expect(f.resets()).toEqual([]); expect(f.discards.some(d => d.input === later)).toBe(false);
  });

  it('forgets refusals for unretained future Groups instead of using them as permanent loss proofs', () => {
    const f = fixture({ depth: 1 }); f.seed(); f.push(0, 1, false, 10);
    for (let group = 1; group <= 64; group++) {
      const refused = f.push(group, 0, true, 200);
      expect(f.discards.at(-1)).toEqual({ input: refused, reason: 'buffer full' });
      expect(f.pipeline.bufferedGroupCount).toBe(1);
    }
    f.pipeline.tick(); f.endGroup(0n);
    const delta = f.push(1, 1, false, 10); f.pipeline.tick();
    expect(f.resets(), 'an old refusal outside retained groups is not authority for an immediate later skip').toEqual([]);
    expect(f.discards.some(d => d.input === delta)).toBe(false);
    f.advance(GAP + 1); f.pipeline.tick();
    expect(f.resets()).toHaveLength(1); expect(f.discards).toContainEqual({ input: delta, reason: 'skipped' });
  });

  it('fences a clock callback replacing the waiting owner and buffer head', () => {
    const f = fixture(); f.seed(); const old = f.push(1, 1); let calls = 0, replacement: object | undefined;
    f.armClock(() => { calls++; f.pipeline.resetForTrackSwitch(7n); replacement = f.push(7, 0, true); });
    f.pipeline.tick(); expect(calls, 'premise: the actual decision clock reentered').toBe(1);
    expect(f.discards).toContainEqual({ input: old, reason: 'track superseded' });
    expect(f.decoded().some(c => c.inputToken === old)).toBe(false);
    f.pipeline.tick(); expect(f.decoded().at(-1)?.inputToken).toBe(replacement);
    expect(f.events.some(e => e.type === 'skip_forward')).toBe(false);
  });
});


it('retires the old Group completion clock before starting a new missing-RAP wait', () => {
  const f = fixture(); f.seed(); // Group0 has no EOG yet.
  const delta = f.push(1, 1); f.pipeline.tick(); // t0: waiting for Group0 completion.
  f.advance(50_000); f.endGroup(0n); f.pipeline.tick(); // t50: now waiting for Group1/Object0.
  f.advance(151_000); f.pipeline.tick(); // t201: old deadline expired, new one is t250.
  expect.soft(f.resets(), 'the completed old Group must not reset the newer waiting owner').toEqual([]);
  expect.soft(f.events.filter(e => e.type === 'partial_group_abandoned')).toEqual([]);
  expect(f.discards).toEqual([]);
  const key = f.push(1, 0, true); f.pipeline.tick();
  expect(f.decoded().slice(-2).map(c => c.inputToken)).toEqual([key, delta]);
  expect(f.resets()).toEqual([]);
});
