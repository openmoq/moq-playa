/// <reference lib="es2024.arraybuffer" />
import { describe, expect, it } from 'vitest';
import type { MoqtObjectData, MoqtObject } from '@openmoq/transport';
import { encodeLocHeaders, parseLocHeaders } from '@openmoq/loc';
import type { LocHeaders, SourceTimestamp, VideoFrameMarking } from '@openmoq/loc';
import { LOC_SEEK_PROOF_BYTES, LocSeekInput, locIndexedPositionMs, locIndexedTime,
  projectLocResumePoint, snapshotLocResumePoint } from './loc-seek-input.js';
import type { LocIndexedPlacement, LocSeekInputOptions, LocSeekPreparation, LocSeekResumePoint } from './loc-seek-input.js';

const idr = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88);
const delta = Uint8Array.of(0, 0, 0, 2, 0x41, 0x88);
const marking = (independent: boolean): VideoFrameMarking => ({ startOfFrame: true, endOfFrame: true,
  independent, discardable: false, baseLayerSync: false, temporalId: 0 });
const opts = (extra: Partial<LocSeekInputOptions> = {}): LocSeekInputOptions => ({ role: 'video', codec: 'avc1.640028',
  location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, targetMs: 5000, timestampRounding: 'floor',
  maxObjects: 20, maxBytes: 64 * 1024, ...extra });
const object = (id = 0n, payload = id === 0n ? idr : delta, extra: Partial<MoqtObjectData> = {}): MoqtObjectData => ({
  kind: 'data', trackAlias: 7n, groupId: 3n, subgroupId: 0n, objectId: id, publisherPriority: 128, payload, ...extra });
const headers = (pts: bigint, independent: boolean, scale = 1000n): LocHeaders => ({
  timestamp: pts, timescale: scale, captureTimestamp: pts * 1_000_000n / scale, timestampIsWallClock: false,
  version: 4, videoFrameMarking: marking(independent) });
const ready = (result: LocSeekPreparation) => {
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Expected ready fixture');
  return result;
};

describe('observed LOC source resume threshold', () => {
  it.each(['floor', 'nearest'] as const)('retains the known 2100 picture instead of selecting 2300: %s', timestampRounding => {
    const sourceAnchor = { ticks: 1_800_000_000_000_000n, ticksPerSecond: 1_000_000n, domain: 'unix' as const };
    const source = { ...sourceAnchor, ticks: sourceAnchor.ticks + 100_000n };
    const placement = { sourceAnchor, mediaPts: 2000, timestampRounding };
    const options = { ...opts({ placementMode: 'indexed-relative', mediaPts: 2000, targetMs: 2100, timestampRounding }),
      resume: { source, placement } };
    const input = new LocSeekInput(options);
    // A compatible later indexed source point must not replace the observed phase.
    input.push(object(), { captureTimestamp: sourceAnchor.ticks + 250n, timestampIsWallClock: true, videoFrameMarking: marking(true) });
    input.push(object(1n), { captureTimestamp: source.ticks, timestampIsWallClock: true, videoFrameMarking: marking(false) });
    input.push(object(2n), { captureTimestamp: sourceAnchor.ticks + 300_000n, timestampIsWallClock: true, videoFrameMarking: marking(false) });
    const result = ready(input.finishGroup(3n));
    expect(result.selected.location.objectId).toBe(1n);
    expect(result.selected.sourceTimestamp).toEqual(source);
    expect(result.placement).toEqual(placement);
  });
});

describe('raw LOC closed-group preparation contract', () => {
  it('uses explicit host parsing and chooses least target point in reordered PTS, preserving decode order', () => {
    const input = new LocSeekInput(opts());
    for (const [index, pts] of [4000n, 6000n, 5250n, 5750n].entries()) {
      const wire = encodeLocHeaders(headers(pts, index === 0), { locVersion: 4, wireProfile: 'd18-delta-vi64' });
      const parsed = parseLocHeaders(wire, { wireProfile: 'd18-delta-vi64' });
      input.push(object(BigInt(index), index ? delta : idr, { properties: wire }), parsed);
    }
    expect(input.retainedObjectCount).toBe(4); // No early transfer when 6000 first passes target.
    const result = ready(input.finishGroup(3n));
    expect(result.selected.location).toEqual({ groupId: 3n, objectId: 2n });
    expect(result.selected.sourceTimestamp).toEqual({ ticks: 5250n, ticksPerSecond: 1000n, domain: 'media' });
    expect(result.items.map(item => item.chunk.timestamp)).toEqual([4_000_000, 6_000_000, 5_250_000, 5_750_000]);
    expect(result.items.map(item => item.chunk.type)).toEqual(['key', 'delta', 'delta', 'delta']);
    expect(result.anchor).toEqual({ ticks: 4000n, ticksPerSecond: 1000n, domain: 'media' });
    expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
  });

  it('retains earlier independent preroll but anchors only the exact indexed dependent Object', () => {
    const input = new LocSeekInput(opts({ location: { groupId: 3n, objectId: 1n } }));
    input.push(object(), headers(3000n, true));
    input.push(object(1n), headers(4000n, false));
    input.push(object(2n), headers(5000n, false));
    const result = ready(input.finishGroup(3n));
    expect(result.anchor.ticks).toBe(4000n); expect(result.items).toHaveLength(3);
    expect(result.selected.location.objectId).toBe(2n);
  });

  it('does not allow an earlier independent sample to stand in for the missing indexed anchor', () => {
    const input = new LocSeekInput(opts({ location: { groupId: 3n, objectId: 2n } }));
    input.push(object(), headers(4000n, true));
    expect(() => input.finishGroup(3n)).toThrow(/exact indexed/);
  });

  it('rejects passing over the indexed location even with usable later independent media', () => {
    const input = new LocSeekInput(opts({ location: { groupId: 3n, objectId: 1n } }));
    input.push(object(), headers(3000n, true));
    expect(() => input.push(object(2n, idr), headers(4000n, true))).toThrow(/exact indexed/);
  });

  it('shares the independent-prefix validator: explicit dependent marking and known delta payload cannot start video', () => {
    for (const [payload, h] of [[idr, headers(4000n, false)], [delta, headers(4000n, true)]] as const) {
      const input = new LocSeekInput(opts());
      expect(() => input.push(object(0n, payload), h)).toThrow(/independently coded/);
    }
  });

  it('uses the shared Object-0 fallback without duplicating bitstream rules, and promotes that chunk to key', () => {
    const h = headers(4000n, true); const { videoFrameMarking: _marking, ...withoutMarking } = h;
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    input.push(object(), withoutMarking);
    expect(ready(input.finishGroup(3n)).items[0]!.chunk.type).toBe('key');
    const dependent = new LocSeekInput(opts({ location: { groupId: 3n, objectId: 1n } }));
    expect(() => dependent.push(object(1n, idr), withoutMarking)).toThrow(/independently coded/);
  });

  it('allows independent audio without video marking or bitstream keyframe policy', () => {
    const input = new LocSeekInput(opts({ role: 'audio', codec: 'opus', targetMs: 4000 }));
    input.push(object(0n, Uint8Array.of(0xf8)), headers(4000n, false));
    const result = ready(input.finishGroup(3n));
    expect(result.items[0]!.chunk.type).toBe('key'); expect(result.selected.sourceTimestamp.ticks).toBe(4000n);
  });

  it.each([
    ['floor', 4000, true], ['floor', 4001, false], ['nearest', 4000, false], ['nearest', 4001, true],
  ] as const)('checks exact 4000.666ms against %s index %s', (rounding, index, accepted) => {
    const input = new LocSeekInput(opts({ mediaPts: index, timestampRounding: rounding, targetMs: 4000 }));
    const push = () => input.push(object(), headers(12_002n, true, 3000n));
    if (!accepted) expect(push).toThrow(/media timeline index/);
    else {
      push(); const result = ready(input.finishGroup(3n));
      expect(result.anchor).toEqual({ ticks: 12_002n, ticksPerSecond: 3000n, domain: 'media' });
      expect(result.items[0]!.chunk.timestamp).toBe(4_000_666);
    }
  });

  it('preserves a non-ms tick and actual origin instead of rebasing it onto the rounded index', () => {
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    input.push(object(), headers(12_001n, true, 3000n));
    const result = ready(input.finishGroup(3n));
    expect(result.anchor.ticks).toBe(12_001n); expect(result.items[0]!.chunk.timestamp).toBe(4_000_333);
    const wrong = new LocSeekInput(opts());
    expect(() => wrong.push(object(), headers(90_000n, true))).toThrow(/media timeline index/);
  });

  it('accepts legitimate negative preroll and keeps its precise raw source', () => {
    const input = new LocSeekInput(opts({ location: { groupId: 3n, objectId: 1n } }));
    input.push(object(), headers(-1n, true, 3n));
    input.push(object(1n), headers(4000n, false));
    input.push(object(2n), headers(5000n, false));
    const result = ready(input.finishGroup(3n));
    expect(result.items[0]!.sourceTimestamp.ticks).toBe(-1n);
    expect(result.items[0]!.chunk.timestamp).toBe(-333333);
  });

  it('permits a negative indexed media timestamp with true floor, not bigint truncation', () => {
    const input = new LocSeekInput(opts({ mediaPts: -1, targetMs: 0 }));
    input.push(object(), headers(-1n, true, 3000n));
    input.push(object(1n), headers(0n, false));
    expect(ready(input.finishGroup(3n)).anchor.ticks).toBe(-1n);
  });

  it.each([
    ['missing', {}],
    ['unknown', { captureTimestamp: 4_000_000n }],
    ['unix', { timestamp: 4_000_000n, captureTimestamp: 4_000_000n, timestampIsWallClock: true }],
    ['contradictory units', { timestamp: 4000n, captureTimestamp: 90_000_000n, timescale: 1000n, timestampIsWallClock: false }],
    ['contradictory domain', { timestamp: 4000n, captureTimestamp: 4_000_000n, timescale: 1000n, timestampIsWallClock: true }],
    ['zero scale', { timestamp: 4000n, captureTimestamp: 4_000_000n, timescale: 0n }],
  ] as const)('never obtains readiness from %s timestamp metadata', (_name, bad) => {
    const input = new LocSeekInput(opts());
    expect(() => input.push(object(), { ...bad, videoFrameMarking: marking(true) })).toThrow(/declared media source timestamp/);
    expect(input.retainedObjectCount).toBe(0);
  });

  it('parses LOC-01 as Unix and refuses to reinterpret it as media despite a matching numeric index', () => {
    const ext = encodeLocHeaders({ captureTimestamp: 4_000_000n, videoFrameMarking: marking(true) }, { wireProfile: 'd14-absolute-varint' });
    const parsed = parseLocHeaders(ext, { wireProfile: 'd14-absolute-varint' });
    expect(parsed.timestampIsWallClock).toBe(true);
    const input = new LocSeekInput(opts());
    expect(() => input.push(object(0n, idr, { extensions: ext }), parsed)).toThrow(/declared media source/);
  });

  it('returns need-more for a closed group below target and keeps ownership for explicit cancellation', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(opts({ onDiscard: item => { discarded.push(item); } }));
    input.push(object(), headers(4000n, true), token);
    expect(input.finishGroup(3n)).toEqual({ kind: 'need-more', reason: 'target-not-in-closed-group' });
    expect(discarded).toEqual([]); expect(input.retainedObjectCount).toBe(1);
    expect(() => input.push(object(1n), headers(5000n, false))).toThrow(/closed/);
    input.cancel(); expect(discarded).toEqual([token]);
  });

  it('never infers closure from sparse inputs, gap status, end flags, or reaching target', () => {
    const input = new LocSeekInput(opts());
    input.push(object(0n, idr, { subgroupContainsEndOfGroup: true }), headers(4000n, true));
    const gap: MoqtObject = { kind: 'gap', groupId: 3n, objectId: 1n, subgroupId: 0n, trackAlias: 7n, status: 1n };
    input.push(gap, {});
    input.push(object(100n), headers(6000n, false));
    expect(input.retainedObjectCount).toBe(2);
    expect(ready(input.finishGroup(3n)).selected.location.objectId).toBe(100n);
  });

  it('does not return a target point rounded up from source ticks below target', () => {
    const input = new LocSeekInput(opts({ targetMs: 4000.5 }));
    input.push(object(), headers(12_001n, true, 3000n));
    expect(input.finishGroup(3n).kind).toBe('need-more'); input.cancel();
  });

  it('chooses by exact rational PTS across per-object timescales and retains decode order for ties', () => {
    const input = new LocSeekInput(opts());
    input.push(object(), headers(4000n, true));
    input.push(object(1n), headers(10_000n, false, 2000n));
    input.push(object(2n), headers(15_000n, false, 3000n));
    expect(ready(input.finishGroup(3n)).selected.location.objectId).toBe(1n);
  });

  it('copies raw payload, both property fields, nested metadata/config and unknown extension bytes before retention', () => {
    const payload = idr.slice(), ext = Uint8Array.of(1), prop = Uint8Array.of(2), config = Uint8Array.of(3), unknown = Uint8Array.of(4);
    const h = { ...headers(4000n, true), videoConfig: config, unknown: new Map([[99n, unknown]]) };
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    input.push(object(0n, payload, { extensions: ext, properties: prop }), h);
    payload.fill(0); ext.fill(0); prop.fill(0); config.fill(0); unknown.fill(0); h.unknown.clear();
    const item = ready(input.finishGroup(3n)).items[0]!;
    expect(item.object.payload).toEqual(idr); expect(item.chunk.data).toBe(item.object.payload);
    expect(item.object.extensions).toEqual(Uint8Array.of(1)); expect(item.object.properties).toEqual(Uint8Array.of(2));
    expect(item.headers.videoConfig).toEqual(Uint8Array.of(3)); expect(item.headers.unknown?.get(99n)).toEqual(Uint8Array.of(4));
    expect(Object.isFrozen(item.headers.videoFrameMarking)).toBe(true); expect(Object.isFrozen(item.sourceTimestamp)).toBe(true);
  });

  it('copies typed byte storage without delegating ownership to an overridable slice callback', () => {
    const payload = idr.slice(), properties = Uint8Array.of(9);
    payload.slice = () => payload; properties.slice = () => properties;
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    input.push(object(0n, payload, { properties }), headers(4000n, true));
    payload.fill(0); properties.fill(0);
    const item = ready(input.finishGroup(3n)).items[0]!;
    expect(item.object.payload).toEqual(idr); expect(item.object.properties).toEqual(Uint8Array.of(9));
  });

  it('does not let a later metadata callback grow byte storage after its budget was charged', () => {
    const buffer = new ArrayBuffer(6, { maxByteLength: 8192 }), payload = new Uint8Array(buffer);
    payload.set(idr);
    const h = headers(4000n, true);
    const input = new LocSeekInput(opts({ role: 'audio', targetMs: 4000, maxBytes: 512 }));
    input.push(object(0n, payload), { ...h, videoFrameMarking: {
      ...marking(true), get independent() { buffer.resize(8192); return true; },
    } });
    const item = ready(input.finishGroup(3n)).items[0]!;
    expect(item.object.payload).toEqual(idr);
    expect(item.object.payload.byteLength).toBeLessThanOrEqual(512);
  });

  it('does not mistake container-normalized media metadata without raw LOC Timestamp for raw LOC proof', () => {
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    expect(() => input.push(object(), { captureTimestamp: 4_000_000n, timestampIsWallClock: false,
      videoFrameMarking: marking(true) })).toThrow(/declared media source timestamp/);
  });

  it('retains the original failure when a synchronous discard observer throws', () => {
    const input = new LocSeekInput(opts({ onDiscard: () => { throw new Error('observer failure'); } }));
    input.push(object(), headers(4000n, true), {});
    expect(() => input.push(object(1n), headers(6000n, false), {})).not.toThrow();
    expect(() => input.finishGroup(4n)).toThrow(/Wrong LOC group closure/);
    expect(input.retainedObjectCount).toBe(0);
  });

  it('bounds retained objects even after encountering the indexed anchor; no silent preroll dropping', () => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(opts({ maxObjects: 1, onDiscard: item => { discarded.push(item); } }));
    input.push(object(), headers(4000n, true), a);
    expect(() => input.push(object(1n), headers(5000n, false), b)).toThrow(/object budget/);
    expect(discarded).toEqual([a, b]); expect(input.retainedBytes).toBe(0);
  });

  it('charges payload, raw properties and proof metadata, and enforces exact retained byte boundary', () => {
    const probe = new LocSeekInput(opts({ targetMs: 4000 }));
    probe.push(object(0n, idr, { extensions: Uint8Array.of(1, 2) }), headers(4000n, true));
    const size = probe.retainedBytes; expect(size).toBeGreaterThanOrEqual(LOC_SEEK_PROOF_BYTES + idr.length + 2);
    const exact = new LocSeekInput(opts({ targetMs: 4000, maxBytes: size }));
    exact.push(object(0n, idr, { extensions: Uint8Array.of(1, 2) }), headers(4000n, true));
    expect(ready(exact.finishGroup(3n)).items).toHaveLength(1);
    const short = new LocSeekInput(opts({ maxBytes: size - 1 }));
    expect(() => short.push(object(0n, idr, { extensions: Uint8Array.of(1, 2) }), headers(4000n, true))).toThrow(/byte\/proof budget/);
    probe.cancel();
  });

  it('bounds unknown metadata as well as raw bytes, and accounts cumulative staged proof', () => {
    const input = new LocSeekInput(opts({ maxBytes: 600 }));
    input.push(object(), headers(4000n, true));
    expect(() => input.push(object(1n), { ...headers(5000n, false), unknown: new Map([[91n, new Uint8Array(128)]]) })).toThrow(/byte\/proof/);
    expect(input.retainedObjectCount).toBe(0);
  });

  it('clears ownership before reentrant/throwing discard callbacks and contains rejected observer promises', async () => {
    const a = {}, b = {}, calls: object[] = [];
    const input = new LocSeekInput(opts({ onDiscard: async item => {
      calls.push(item); expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
      input.cancel(); expect(() => input.finishGroup(3n)).toThrow(/retired/);
      throw new Error('observer failure');
    } }));
    input.push(object(), headers(4000n, true), a); input.push(object(1n), headers(5000n, false), b);
    input.cancel(); input.cancel(); await Promise.resolve(); expect(calls).toEqual([a, b]);
  });

  it('deduplicates shared retained token ownership and never discards transferred inputs', () => {
    const token = {}, discarded: object[] = [];
    const input = new LocSeekInput(opts({ onDiscard: item => { discarded.push(item); } }));
    input.push(object(), headers(4000n, true), token); input.push(object(1n), headers(5000n, false), token);
    const result = ready(input.finishGroup(3n)); input.cancel();
    expect(result.items.map(item => item.input)).toEqual([token, token]); expect(discarded).toEqual([]);
    expect(() => input.finishGroup(3n)).toThrow(/retired/);
    const cancelled = new LocSeekInput(opts({ onDiscard: item => { discarded.push(item); } }));
    cancelled.push(object(), headers(4000n, true), token); cancelled.push(object(1n), headers(5000n, false), token);
    cancelled.cancel(); expect(discarded).toEqual([token]);
  });

  it('cannot publish a staged item if a header getter cancels during snapshot acquisition', () => {
    const calls: object[] = [], token = {};
    const input = new LocSeekInput(opts({ onDiscard: item => { calls.push(item); } }));
    const h: LocHeaders = { ...headers(4000n, true), get videoConfig() { input.cancel(); return Uint8Array.of(1); } };
    expect(() => input.push(object(), h, token)).toThrow(/retired/);
    expect(calls).toEqual([token]); expect(input.retainedObjectCount).toBe(0);
    expect(() => input.finishGroup(3n)).toThrow(/retired/);
  });

  it('does not admit a nested push/close while acquiring an outer input, with a healthy outer control', () => {
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    const h: LocHeaders = { ...headers(4000n, true), get videoConfig() {
      expect(() => input.push(object(1n), headers(5000n, false))).toThrow(/busy/);
      expect(() => input.finishGroup(3n)).toThrow(/busy/); return Uint8Array.of(1);
    } };
    input.push(object(), h); expect(ready(input.finishGroup(3n)).items).toHaveLength(1);
  });

  it('a cancellation observer cannot transfer a successor or mutate the independent successor helper', () => {
    const successor = new LocSeekInput(opts({ targetMs: 4000 }));
    const input = new LocSeekInput(opts({ onDiscard: () => {
      successor.push(object(), headers(4000n, true));
      expect(() => input.push(object(), headers(4000n, true))).toThrow(/retired/);
    } }));
    input.push(object(), headers(4000n, true), {}); input.cancel();
    expect(ready(successor.finishGroup(3n)).items).toHaveLength(1);
  });

  it.each(['duplicate', 'backward', 'new group', 'wrong closure'] as const)('rejects %s instead of guessing group history', fault => {
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    input.push(object(), headers(4000n, true));
    if (fault === 'wrong closure') expect(() => input.finishGroup(4n)).toThrow(/Wrong LOC group/);
    else if (fault === 'new group') expect(() => input.push(object(0n, idr, { groupId: 4n }), headers(5000n, true))).toThrow(/group changed/);
    else {
      if (fault === 'backward') input.push(object(2n), headers(5000n, false));
      expect(() => input.push(object(0n), headers(5000n, false))).toThrow(/decode Object order/);
    }
  });

  it('accepts maximum full-width scalar locations without synthesizing a successor', () => {
    const maximum = (1n << 64n) - 1n;
    const input = new LocSeekInput(opts({ targetMs: 4000, location: { groupId: maximum, objectId: maximum } }));
    input.push(object(maximum, idr, { groupId: maximum }), headers(4000n, true));
    expect(ready(input.finishGroup(maximum)).indexedLocation).toEqual({ groupId: maximum, objectId: maximum });
  });

  it.each([
    { targetMs: -1 }, { targetMs: Infinity }, { mediaPts: 0.5 }, { maxObjects: 0 }, { maxBytes: 0 },
    { location: { groupId: -1n, objectId: 0n } },
  ])('validates constructor domains before acquiring input: %o', bad => {
    expect(() => new LocSeekInput(opts(bad))).toThrow();
  });

  it('handles frozen caller inputs without mutating options, metadata or data', () => {
    const h = Object.freeze(headers(4000n, true)), o = Object.freeze(object());
    const input = new LocSeekInput(Object.freeze(opts({ targetMs: 4000 })));
    input.push(o, h); expect(ready(input.finishGroup(3n)).items[0]!.headers).toEqual(h);
    expect(o.payload).toEqual(idr);
  });
});

const unixAnchor = 1_800_000_000_000_000n;
const unixHeaders = (timestamp: bigint, independent: boolean): LocHeaders => ({
  captureTimestamp: timestamp, timestampIsWallClock: true, version: 1, videoFrameMarking: marking(independent),
});

describe('explicit indexed-relative LOC placement', () => {
  it.each([1, 4] as const)('anchors actual LOC-%s Unix input without changing its raw chunk', locVersion => {
    const wire = encodeLocHeaders(unixHeaders(unixAnchor, true), { locVersion, wireProfile: 'd18-delta-vi64' });
    const parsed = parseLocHeaders(wire, { wireProfile: 'd18-delta-vi64' });
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', targetMs: 4000 }));
    input.push(object(0n, idr, { properties: wire }), parsed);
    const result = ready(input.finishGroup(3n));
    expect(result.anchor).toEqual({ ticks: unixAnchor, ticksPerSecond: 1_000_000n, domain: 'unix' });
    expect(result.placement).toEqual({ sourceAnchor: result.anchor, mediaPts: 4000, timestampRounding: 'floor' });
    expect(result.placement?.sourceAnchor).toBe(result.anchor);
    expect(Object.isFrozen(result.placement)).toBe(true);
    expect(result.items[0]!.chunk.timestamp).toBe(Number(unixAnchor));
    expect(result.items[0]!.sourceTimestamp.domain).toBe('unix');
    expect(result.items[0]!.object.properties).toEqual(wire);
  });

  it('uses a declared application media epoch and least provable B-frame PTS in decode order', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative' }));
    for (const [i, pts] of [90_000n, 92_000n, 91_250n, 91_750n].entries()) {
      input.push(object(BigInt(i)), headers(pts, i === 0));
    }
    const result = ready(input.finishGroup(3n));
    expect(result.selected.location.objectId).toBe(2n);
    expect(result.anchor.ticks).toBe(90_000n);
    expect(result.placement?.mediaPts).toBe(4000);
    expect(result.items.map(item => item.chunk.timestamp)).toEqual([90_000_000, 92_000_000, 91_250_000, 91_750_000]);
  });

  it('compares the full floor interval lower bound against a fractional target', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', targetMs: 4000.5 }));
    for (const [i, offset] of [0n, 400n, 600n].entries()) {
      input.push(object(BigInt(i)), unixHeaders(unixAnchor + offset, i === 0));
    }
    expect(ready(input.finishGroup(3n)).selected.location.objectId).toBe(2n);
  });

  it('does not call a nearest-index anchor at target provably eligible', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', targetMs: 4000,
      timestampRounding: 'nearest', onDiscard: value => { discarded.push(value); } }));
    input.push(object(), unixHeaders(unixAnchor, true), token);
    expect(input.finishGroup(3n)).toEqual({ kind: 'need-more', reason: 'target-not-in-closed-group' });
    expect(discarded).toEqual([]); input.cancel(); expect(discarded).toEqual([token]);
  });

  it('admits a nearest interval only after its lower edge reaches the integer target', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', targetMs: 4000, timestampRounding: 'nearest' }));
    input.push(object(), unixHeaders(unixAnchor, true));
    input.push(object(1n), unixHeaders(unixAnchor + 600n, false));
    expect(ready(input.finishGroup(3n)).selected.location.objectId).toBe(1n);
  });

  it('retains sub-microsecond source fractions rather than selecting from normalized chunk time', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', targetMs: 4000.6665 }));
    for (let i = 0; i < 3; i++) input.push(object(BigInt(i)), headers(270_001n + BigInt(i), i === 0, 3000n));
    const result = ready(input.finishGroup(3n));
    expect(result.selected.location.objectId).toBe(2n);
    expect(result.selected.sourceTimestamp.ticks).toBe(270_003n);
  });

  it('anchors the exact indexed dependent Object while retaining earlier independent preroll', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', targetMs: 4000,
      location: { groupId: 3n, objectId: 1n } }));
    input.push(object(), unixHeaders(unixAnchor - 2_000_000n, true));
    input.push(object(1n), unixHeaders(unixAnchor, false));
    const result = ready(input.finishGroup(3n));
    expect(result.placement?.sourceAnchor.ticks).toBe(unixAnchor);
    expect(result.selected.location.objectId).toBe(1n); expect(result.items).toHaveLength(2);
  });

  it.each([
    {}, { captureTimestamp: unixAnchor },
    { timestamp: 4n, captureTimestamp: unixAnchor, timescale: 1000n, timestampIsWallClock: false },
  ])('does not use missing, unknown or contradictory metadata as an anchor: %o', bad => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative' }));
    expect(() => input.push(object(), { ...bad, videoFrameMarking: marking(true) })).toThrow(/source timestamp/);
  });

  it.each(['unix', 'media'] as const)('retires all input on a change from %s source domain', domain => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', onDiscard: value => { discarded.push(value); } }));
    input.push(object(), domain === 'unix' ? unixHeaders(unixAnchor, true) : headers(90_000n, true), a);
    expect(() => input.push(object(1n), domain === 'unix' ? headers(91_000n, false) : unixHeaders(unixAnchor, false), b)).toThrow(/domain/);
    expect(discarded).toEqual([a, b]); expect(input.retainedObjectCount).toBe(0);
  });

  it('cannot replace a missing exact indexed Object with later usable input', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', location: { groupId: 3n, objectId: 1n } }));
    input.push(object(), unixHeaders(unixAnchor, true));
    expect(() => input.push(object(2n), unixHeaders(unixAnchor + 1000n, false))).toThrow(/exact indexed/);
  });

  it('snapshots explicit policy and transfers frozen placement without later cancellation discards', () => {
    const discarded: object[] = [], token = {}, options = opts({ placementMode: 'indexed-relative', targetMs: 4000,
      onDiscard: value => { discarded.push(value); } });
    const input = new LocSeekInput(options); Reflect.set(options, 'placementMode', undefined);
    input.push(Object.freeze(object()), Object.freeze(unixHeaders(unixAnchor, true)), token);
    const result = ready(input.finishGroup(3n)); input.cancel();
    expect(Object.isFrozen(result.placement?.sourceAnchor)).toBe(true); expect(discarded).toEqual([]);
    expect(result.items[0]!.input).toBe(token);
  });

  it('keeps existing object/proof budgets while staging placed Unix input', () => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', maxObjects: 1,
      onDiscard: value => { discarded.push(value); } }));
    input.push(object(), unixHeaders(unixAnchor, true), a);
    expect(() => input.push(object(1n), unixHeaders(unixAnchor + 1000n, false), b)).toThrow(/object budget/);
    expect(discarded).toEqual([a, b]); expect(input.retainedBytes).toBe(0);
  });

  it('refuses an unknown placement mode instead of enabling a guessed mapping', () => {
    const options = opts(); Reflect.set(options, 'placementMode', 'guess');
    expect(() => new LocSeekInput(options)).toThrow(/placement mode/);
  });

  it.each(['floor', 'nearest'] as const)('retains exact %s interval endpoints and inclusivity', timestampRounding => {
    const sourceAnchor = Object.freeze({ ticks: unixAnchor, ticksPerSecond: 1_000_000n, domain: 'unix' as const });
    const time = locIndexedTime({ sourceAnchor, mediaPts: 4000, timestampRounding }, { ...sourceAnchor, ticks: unixAnchor + 600n });
    expect(time).toEqual({ nominalUs: { numerator: 4_000_600n, denominator: 1n },
      lowerUs: { numerator: timestampRounding === 'floor' ? 4_000_600n : 4_000_100n, denominator: 1n },
      upperUs: { numerator: timestampRounding === 'floor' ? 4_001_600n : 4_001_100n, denominator: 1n },
      upperInclusive: timestampRounding === 'nearest' });
  });

  it('does not admit an interval below the exact fractional target by a floating tolerance', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative', timestampRounding: 'nearest', targetMs: 4000.1000000000004 }));
    input.push(object(), unixHeaders(unixAnchor, true));
    input.push(object(1n), unixHeaders(unixAnchor + 600n, false));
    expect(input.finishGroup(3n).kind).toBe('need-more'); input.cancel();
  });

  it('keeps the default ready shape and exact anchor validation without an implicit placement', () => {
    const input = new LocSeekInput(opts({ targetMs: 4000 }));
    input.push(object(), headers(12_001n, true, 3000n));
    const result = ready(input.finishGroup(3n));
    expect(Object.keys(result)).toEqual(['kind', 'anchor', 'indexedLocation', 'selected', 'items']);
    expect(result.placement).toBeUndefined(); expect(result.anchor.ticks).toBe(12_001n);
  });
});

const inGroup = (groupId: bigint, objectId = 0n, payload = objectId === 0n ? idr : delta) => object(objectId, payload, { groupId });

describe('closed LOC group continuation', () => {
  it.each(['exact', 'floor', 'nearest'] as const)('keeps the original indexed anchor through sparse groups 0→1→2 with reordered PTS: %s', mode => {
    const discarded: Array<{ token: object; reason: string; retained: number }> = [];
    let current: LocSeekInput;
    const root = new LocSeekInput(opts({ location: { groupId: 0n, objectId: 0n }, targetMs: 5250,
      timestampRounding: mode === 'nearest' ? 'nearest' : 'floor',
      ...(mode === 'exact' ? {} : { placementMode: 'indexed-relative' as const }),
      onDiscard: (token, reason) => { discarded.push({ token, reason, retained: current.retainedObjectCount }); } }));
    current = root;
    const source = (ms: number, independent: boolean) => mode === 'exact' ? headers(BigInt(ms), independent)
      : unixHeaders(unixAnchor + BigInt(ms - 4000) * 1000n, independent);
    const old = [{}, {}, {}, {}], kept = [{}, {}, {}, {}];
    root.push(inGroup(0n), source(4000, true), old[0]); root.push(inGroup(0n, 1n), source(4200, false), old[1]);
    expect(root.finishGroup(0n).kind).toBe('need-more');
    const next = root.continueAt(1n); current = next;
    expect(root.retainedBytes).toBe(0);
    expect(next.retainedObjectCount).toBe(0); expect(next.retainedBytes).toBe(0);
    next.push(inGroup(1n), source(4500, true), old[2]); next.push(inGroup(1n, 1n), source(4800, false), old[3]);
    expect(next.finishGroup(1n).kind).toBe('need-more');
    const last = next.continueAt(2n); current = last;
    for (const [i, ms] of [5000, 5500, 5275, 5400].entries()) last.push(inGroup(2n, BigInt(i)), source(ms, i === 0), kept[i]);
    const result = ready(last.finishGroup(2n));
    expect(result.indexedLocation).toEqual({ groupId: 0n, objectId: 0n });
    expect(result.anchor).toEqual(mode === 'exact'
      ? { ticks: 4000n, ticksPerSecond: 1000n, domain: 'media' }
      : { ticks: unixAnchor, ticksPerSecond: 1_000_000n, domain: 'unix' });
    expect(result.selected.location).toEqual({ groupId: 2n, objectId: 2n });
    expect(result.items.map(item => item.object.groupId)).toEqual([2n, 2n, 2n, 2n]);
    expect(result.items.map(item => item.chunk.timestamp)).toEqual([5000, 5500, 5275, 5400].map(ms =>
      mode === 'exact' ? ms * 1000 : Number(unixAnchor + BigInt(ms - 4000) * 1000n)));
    expect(result.items.map(item => item.input)).toEqual(kept);
    if (mode === 'exact') expect(result.placement).toBeUndefined();
    else expect(result.placement).toEqual({ sourceAnchor: result.anchor, mediaPts: 4000,
      timestampRounding: mode === 'nearest' ? 'nearest' : 'floor' });
    expect(discarded).toEqual(old.map(token => ({ token, reason: 'decoder reset', retained: 0 })));
    root.cancel(); next.cancel(); last.cancel();
    expect(discarded).toHaveLength(4); expect(() => root.continueAt(3n)).toThrow(/retired/);
  });

  it.each(['open', 'ready', 'cancelled'] as const)('refuses continuation from %s preparation', state => {
    const input = new LocSeekInput(opts({ targetMs: state === 'ready' ? 4000 : 5000 }));
    input.push(object(), headers(4000n, true));
    if (state !== 'open') input.finishGroup(3n);
    if (state === 'cancelled') input.cancel();
    expect(() => input.continueAt(4n)).toThrow(/need-more|retired/); input.cancel();
  });

  it.each([-1n, 2n, 3n, 1n << 64n])('refuses invalid/non-increasing group %s without losing a retryable need-more prefix', groupId => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(opts({ onDiscard: value => { discarded.push(value); } }));
    input.push(object(), headers(4000n, true), token); input.finishGroup(3n);
    expect(() => input.continueAt(groupId)).toThrow(/Invalid LOC|increase/);
    expect(discarded).toEqual([]); expect(input.retainedObjectCount).toBe(1);
    const next = input.continueAt(4n); expect(discarded).toEqual([token]);
    next.push(inGroup(4n), headers(5000n, true));
    expect(ready(next.finishGroup(4n)).indexedLocation.groupId).toBe(3n);
  });

  it('does not coerce a numeric group into a Location integer', () => {
    const input = new LocSeekInput(opts()); input.push(object(), headers(4000n, true)); input.finishGroup(3n);
    expect(() => Reflect.apply(input.continueAt, input, [4])).toThrow(/Invalid LOC/); input.cancel();
  });

  it.each(['marking', 'payload'] as const)('requires a fresh independent successor prefix, including %s evidence', fault => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(opts({ onDiscard: value => { discarded.push(value); } }));
    input.push(object(), headers(4000n, true), a); input.finishGroup(3n);
    const next = input.continueAt(4n);
    expect(() => next.push(inGroup(4n, 0n, fault === 'payload' ? delta : idr), headers(5000n, fault !== 'marking'), b)).toThrow(/independently coded/);
    expect(discarded).toEqual([a, b]); expect(next.retainedBytes).toBe(0);
  });

  it.each(['media', 'unix'] as const)('keeps the original %s domain even before the successor first item', domain => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative' }));
    input.push(object(), domain === 'media' ? headers(90_000n, true) : unixHeaders(unixAnchor, true));
    input.finishGroup(3n); const next = input.continueAt(4n);
    expect(() => next.push(inGroup(4n), domain === 'media' ? unixHeaders(unixAnchor, true) : headers(91_000n, true))).toThrow(/domain/);
  });

  it('cannot obtain inherited readiness from unknown successor timing', () => {
    const input = new LocSeekInput(opts({ placementMode: 'indexed-relative' }));
    input.push(object(), unixHeaders(unixAnchor, true)); input.finishGroup(3n);
    const next = input.continueAt(4n);
    expect(() => next.push(inGroup(4n), { captureTimestamp: unixAnchor + 1_000_000n, videoFrameMarking: marking(true) })).toThrow(/source timestamp/);
  });

  it('uses the successor preparing group for closure rather than the original indexed group', () => {
    const input = new LocSeekInput(opts()); input.push(object(), headers(4000n, true)); input.finishGroup(3n);
    const next = input.continueAt(4n); next.push(inGroup(4n), headers(4500n, true));
    expect(() => next.finishGroup(3n)).toThrow(/Wrong LOC group closure/);
  });

  it('cancels handoff when old ownership is cancelled reentrantly during settled-token notification', () => {
    const token = {}, calls: Array<{ token: object; retained: number; nestedRefused: boolean }> = [];
    const input = new LocSeekInput(opts({ onDiscard: value => {
      let nestedRefused = false;
      try { input.continueAt(5n); } catch { nestedRefused = true; }
      calls.push({ token: value, retained: input.retainedObjectCount, nestedRefused }); input.cancel();
    } }));
    input.push(object(), headers(4000n, true), token); input.finishGroup(3n);
    expect(() => input.continueAt(4n)).toThrow(/retired|cancel/);
    expect(calls).toEqual([{ token, retained: 0, nestedRefused: true }]);
    expect(input.retainedBytes).toBe(0); expect(() => input.continueAt(6n)).toThrow(/retired/);
  });

  it.each(['throw', 'reject'] as const)('contains a %s observer and does not let old cancellation retire a returned successor', async kind => {
    const token = {}, discarded: object[] = [];
    const input = new LocSeekInput(opts({ onDiscard: value => {
      discarded.push(value);
      if (kind === 'throw') throw new Error('observer');
      return Promise.reject(new Error('observer'));
    } }));
    input.push(object(), headers(4000n, true), token); input.finishGroup(3n);
    const next = input.continueAt(4n); input.cancel(); input.cancel(); await Promise.resolve();
    next.push(inGroup(4n), headers(5000n, true));
    expect(ready(next.finishGroup(4n)).selected.location.groupId).toBe(4n);
    expect(discarded).toEqual([token]);
  });

  it('resets only the staged-prefix budget, then enforces the same bound in the next group', () => {
    const tokens = [{}, {}, {}, {}, {}], discarded: object[] = [];
    const input = new LocSeekInput(opts({ maxObjects: 2, onDiscard: value => { discarded.push(value); } }));
    input.push(object(), headers(4000n, true), tokens[0]); input.push(object(1n), headers(4200n, false), tokens[1]); input.finishGroup(3n);
    const next = input.continueAt(4n);
    expect(next.retainedBytes).toBe(0);
    next.push(inGroup(4n), headers(4500n, true), tokens[2]); next.push(inGroup(4n, 1n), headers(4800n, false), tokens[3]);
    expect(() => next.push(inGroup(4n, 2n), headers(4900n, false), tokens[4])).toThrow(/object budget/);
    expect(discarded).toEqual(tokens); expect(next.retainedBytes).toBe(0);
  });

  it('accepts the maximum group without inventing an overflowing successor', () => {
    const maximum = (1n << 64n) - 1n;
    const input = new LocSeekInput(opts({ location: { groupId: maximum - 1n, objectId: 0n } }));
    input.push(inGroup(maximum - 1n), headers(4000n, true)); input.finishGroup(maximum - 1n);
    const next = input.continueAt(maximum); next.push(inGroup(maximum), headers(4500n, true)); next.finishGroup(maximum);
    expect(() => next.continueAt(maximum + 1n)).toThrow(/Invalid LOC/); next.cancel();
  });

  it('never uses continuation to waive a failed original index match or create a fresh synthetic index', () => {
    const bad = new LocSeekInput(opts());
    expect(() => bad.push(object(), headers(90_000n, true))).toThrow(/media timeline index/);
    expect(() => bad.continueAt(4n)).toThrow(/retired/);
    const fresh = new LocSeekInput(opts({ location: { groupId: 4n, objectId: 0n } }));
    expect(() => fresh.push(inGroup(4n), headers(5000n, true))).toThrow(/media timeline index/);
  });

  it('keeps the established anchor through an authoritatively closed empty successor without claiming ready', () => {
    const input = new LocSeekInput(opts()); input.push(object(), headers(4000n, true)); input.finishGroup(3n);
    const empty = input.continueAt(4n);
    expect(empty.finishGroup(4n)).toEqual({ kind: 'need-more', reason: 'target-not-in-closed-group' });
    expect(() => empty.continueAt(3n)).toThrow(/increase/);
    expect(() => empty.continueAt(4n)).toThrow(/increase/);
    const last = empty.continueAt(5n); last.push(inGroup(5n), headers(5000n, true));
    const result = ready(last.finishGroup(5n));
    expect(result.indexedLocation).toEqual({ groupId: 3n, objectId: 0n });
    expect(result.anchor.ticks).toBe(4000n); expect(result.selected.location.groupId).toBe(5n);
    const initial = new LocSeekInput(opts()); expect(() => initial.finishGroup(3n)).toThrow(/exact indexed/);
  });

  it('keeps the same exact staged-byte bound after releasing the previous group', () => {
    const probe = new LocSeekInput(opts()); probe.push(object(), headers(4000n, true));
    const limit = probe.retainedBytes; probe.cancel();
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(opts({ maxBytes: limit, onDiscard: value => { discarded.push(value); } }));
    input.push(object(), headers(4000n, true), a); input.finishGroup(3n);
    const next = input.continueAt(4n);
    expect(() => next.push(object(0n, idr, { groupId: 4n, extensions: Uint8Array.of(1) }), headers(5000n, true), b)).toThrow(/byte\/proof budget/);
    expect(discarded).toEqual([a, b]); expect(next.retainedBytes).toBe(0);
  });
});

const audioOptions = (extra: Partial<LocSeekInputOptions> = {}): LocSeekInputOptions => opts({ role: 'audio', codec: 'opus', ...extra });
const audioObject = (groupId = 3n, objectId = 0n): MoqtObjectData => inGroup(groupId, objectId, Uint8Array.of(0xf8));

describe('closed LOC audio prefix transfer', () => {
  it('transfers a pretarget encoded prefix without claiming selection, PCM duration, or native coverage', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(audioOptions({ targetMs: 4005, onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), token);
    const prefix = input.finishAudioGroup(3n);
    expect(Object.keys(prefix)).toEqual(['kind', 'anchor', 'indexedLocation', 'items']);
    expect(prefix.kind).toBe('audio-prefix'); expect(Object.hasOwn(prefix, 'selected')).toBe(false);
    expect(prefix.anchor).toEqual({ ticks: 4000n, ticksPerSecond: 1000n, domain: 'media' });
    expect(prefix.indexedLocation).toEqual({ groupId: 3n, objectId: 0n });
    expect(prefix.items[0]!.chunk.timestamp).toBe(4_000_000); expect(prefix.items[0]!.chunk.duration).toBeUndefined();
    expect(prefix.items[0]!.input).toBe(token); expect(prefix.items[0]!.chunk.type).toBe('key');
    expect(Object.isFrozen(prefix)).toBe(true); expect(Object.isFrozen(prefix.items)).toBe(true);
    expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
    input.cancel(); expect(discarded).toEqual([]); expect(prefix.items).toHaveLength(1);
  });

  it.each(['floor', 'nearest'] as const)('retains original indexed Unix placement through transferred audio groups: %s', timestampRounding => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(audioOptions({ placementMode: 'indexed-relative', timestampRounding,
      onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), unixHeaders(unixAnchor, false), a);
    const first = input.finishAudioGroup(3n), next = input.continueAt(4n);
    next.push(audioObject(4n), unixHeaders(unixAnchor + 20_000n, false), b);
    const second = next.finishAudioGroup(4n);
    expect(second.anchor).toBe(first.anchor); expect(second.indexedLocation).toEqual(first.indexedLocation);
    expect(second.placement).toEqual({ sourceAnchor: first.anchor, mediaPts: 4000, timestampRounding });
    expect(second.items[0]!.chunk.timestamp).toBe(Number(unixAnchor + 20_000n));
    expect(second.items[0]!.sourceTimestamp.domain).toBe('unix'); expect(second.items[0]!.input).toBe(b);
    expect(second.kind).toBe('audio-prefix'); expect(discarded).toEqual([]);
    input.cancel(); next.cancel(); expect(discarded).toEqual([]);
  });

  it('refuses video without closing or discarding its valid prefix, and leaves video ready retired', () => {
    const discarded: object[] = [], input = new LocSeekInput(opts({ targetMs: 4000, onDiscard: value => { discarded.push(value); } }));
    input.push(object(), headers(4000n, true), {});
    expect(() => input.finishAudioGroup(3n)).toThrow(/requires audio role/);
    expect(input.retainedObjectCount).toBe(1); expect(discarded).toEqual([]);
    expect(input.finishGroup(3n).kind).toBe('ready'); expect(() => input.continueAt(4n)).toThrow(/retired/);
  });

  it('cannot transfer an empty initial group or an earlier sample in place of the exact index', () => {
    const empty = new LocSeekInput(audioOptions()); expect(() => empty.finishAudioGroup(3n)).toThrow(/exact indexed/);
    const discarded: object[] = [], token = {};
    const missing = new LocSeekInput(audioOptions({ location: { groupId: 3n, objectId: 1n }, onDiscard: value => { discarded.push(value); } }));
    missing.push(audioObject(), headers(3000n, false), token);
    expect(() => missing.finishAudioGroup(3n)).toThrow(/exact indexed/); expect(discarded).toEqual([token]);
    expect(() => missing.continueAt(4n)).toThrow(/retired/);
  });

  it('keeps transferred data caller-owned across refused duplicate finish/push and later continuation', () => {
    const discarded: object[] = [], a = {}, late = {};
    const input = new LocSeekInput(audioOptions({ onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), a); const prefix = input.finishAudioGroup(3n);
    expect(() => input.finishAudioGroup(3n)).toThrow(/closed/);
    expect(() => input.finishGroup(3n)).toThrow(/closed/);
    expect(() => input.push(audioObject(3n, 1n), headers(4020n, false), late)).toThrow(/closed/);
    const next = input.continueAt(4n); next.push(audioObject(4n), headers(5100n, false));
    expect(next.finishAudioGroup(4n).kind).toBe('audio-prefix'); next.cancel(); input.cancel();
    expect(prefix.items[0]!.input).toBe(a); expect(discarded).toEqual([]);
  });

  it('cancel revokes continuation without discarding shared tokens already transferred', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(audioOptions({ onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), token); input.push(audioObject(3n, 1n), headers(4020n, false), token);
    const prefix = input.finishAudioGroup(3n); input.cancel(); input.cancel();
    expect(() => input.continueAt(4n)).toThrow(/retired/);
    expect(prefix.items.map(item => item.input)).toEqual([token, token]); expect(discarded).toEqual([]);
  });

  it('does not double-discard a transferred prefix when a successor takes the old need-more path', () => {
    const discarded: object[] = [], a = {}, b = {}, c = {};
    const input = new LocSeekInput(audioOptions({ onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), a); const first = input.finishAudioGroup(3n);
    const next = input.continueAt(4n); next.push(audioObject(4n), headers(4020n, false), b);
    expect(next.finishGroup(4n).kind).toBe('need-more'); const last = next.continueAt(5n);
    last.push(audioObject(5n), headers(5000n, false), c); const final = last.finishAudioGroup(5n);
    expect(final.anchor).toBe(first.anchor); expect(final.items[0]!.input).toBe(c);
    input.cancel(); next.cancel(); last.cancel(); expect(discarded).toEqual([b]);
  });

  it('checks current successor closure and discards only its still-owned inputs on error', () => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(audioOptions({ onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), a); input.finishAudioGroup(3n);
    const next = input.continueAt(4n); next.push(audioObject(4n), headers(4020n, false), b);
    expect(() => next.finishAudioGroup(3n)).toThrow(/Wrong LOC group closure/); expect(discarded).toEqual([b]);
  });

  it('can transfer an empty inherited prefix without fabricating coverage or a later index', () => {
    const input = new LocSeekInput(audioOptions()); input.push(audioObject(), headers(4000n, false));
    const first = input.finishAudioGroup(3n), next = input.continueAt(4n), empty = next.finishAudioGroup(4n);
    expect(empty.kind).toBe('audio-prefix'); expect(empty.items).toEqual([]);
    expect(empty.anchor).toBe(first.anchor); expect(empty.indexedLocation).toEqual(first.indexedLocation);
    const last = next.continueAt(5n); last.push(audioObject(5n), headers(4040n, false));
    expect(last.finishAudioGroup(5n).items).toHaveLength(1); last.cancel();
  });

  it('keeps current-prefix object bounds and does not discard caller-owned previous groups', () => {
    const discarded: object[] = [], a = {}, b = {}, c = {};
    const input = new LocSeekInput(audioOptions({ maxObjects: 1, onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), a); input.finishAudioGroup(3n);
    const next = input.continueAt(4n); next.push(audioObject(4n), headers(4020n, false), b);
    expect(() => next.push(audioObject(4n, 1n), headers(4040n, false), c)).toThrow(/object budget/);
    expect(discarded).toEqual([b, c]); expect(next.retainedBytes).toBe(0);
  });

  it('keeps the same exact byte bound after prefix transfer', () => {
    const probe = new LocSeekInput(audioOptions()); probe.push(audioObject(), headers(4000n, false));
    const limit = probe.retainedBytes; probe.cancel();
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(audioOptions({ maxBytes: limit, onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), a); input.finishAudioGroup(3n); const next = input.continueAt(4n);
    expect(() => next.push(object(0n, Uint8Array.of(0xf8), { groupId: 4n, extensions: Uint8Array.of(1) }), headers(4020n, false), b)).toThrow(/byte\/proof budget/);
    expect(discarded).toEqual([b]); expect(input.retainedBytes).toBe(0); expect(next.retainedBytes).toBe(0);
  });

  it('refuses reentrant transfer while acquiring a header, then transfers the healthy prefix once', () => {
    const input = new LocSeekInput(audioOptions()); let busy = false;
    input.push(audioObject(), { ...headers(4000n, false), get audioConfig() {
      try { input.finishAudioGroup(3n); } catch (error) { busy = error instanceof Error && /busy/.test(error.message); }
      return Uint8Array.of(9);
    } });
    expect(busy).toBe(true); expect(input.retainedObjectCount).toBe(1);
    expect(input.finishAudioGroup(3n).items).toHaveLength(1); input.cancel();
  });

  it('keeps old need-more ownership intact rather than allowing a second finish mode', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(audioOptions({ onDiscard: value => { discarded.push(value); } }));
    input.push(audioObject(), headers(4000n, false), token); expect(input.finishGroup(3n).kind).toBe('need-more');
    expect(() => input.finishAudioGroup(3n)).toThrow(/closed/); expect(discarded).toEqual([]);
    const next = input.continueAt(4n); expect(discarded).toEqual([token]); next.cancel();
  });

  it('does not relax original audio index matching and preserves precise raw media ticks', () => {
    const input = new LocSeekInput(audioOptions()); input.push(audioObject(), headers(12_001n, false, 3000n));
    const prefix = input.finishAudioGroup(3n); expect(prefix.anchor.ticks).toBe(12_001n);
    expect(prefix.items[0]!.chunk.timestamp).toBe(4_000_333); input.cancel();
    const bad = new LocSeekInput(audioOptions()); expect(() => bad.push(audioObject(), headers(90_000n, false))).toThrow(/media timeline index/);
    expect(() => bad.finishAudioGroup(3n)).toThrow(/retired/);
  });
});

const resumePlacement = (timestampRounding: 'floor' | 'nearest' = 'nearest'): LocIndexedPlacement => ({
  sourceAnchor: { ticks: unixAnchor, ticksPerSecond: 1_000_000n, domain: 'unix' }, mediaPts: 2000, timestampRounding,
});
const observedResume = (timestampRounding: 'floor' | 'nearest' = 'nearest'): LocSeekResumePoint => ({
  source: { ticks: unixAnchor + 100_000n, ticksPerSecond: 1_000_000n, domain: 'unix' },
  placement: resumePlacement(timestampRounding),
});
const sameSource = (a: SourceTimestamp, b: SourceTimestamp) => {
  expect(a.domain).toBe(b.domain);
  expect(a.ticks * b.ticksPerSecond).toBe(b.ticks * a.ticksPerSecond);
};

describe('exact LOC resume point projection and public conversion', () => {
  it('snapshots every source and placement field once and retains no mutable caller objects', () => {
    const reads: string[] = [];
    const source: SourceTimestamp = {
      get ticks() { reads.push('ticks'); return -7n; },
      get ticksPerSecond() { reads.push('scale'); return 3n; },
      get domain(): SourceTimestamp['domain'] { reads.push('domain'); return 'media'; },
    };
    const anchor = { ticks: -10n, ticksPerSecond: 3n, domain: 'media' as const };
    const placement = { sourceAnchor: anchor, mediaPts: 2000, timestampRounding: 'floor' as const };
    const snapshot = snapshotLocResumePoint({
      get source() { reads.push('source'); return source; },
      get placement() { reads.push('placement'); return placement; },
    });
    expect(reads).toEqual(['source', 'placement', 'ticks', 'scale', 'domain']);
    Reflect.set(anchor, 'ticks', 99n); Reflect.set(placement, 'mediaPts', 9000);
    expect(snapshot.source).toEqual({ ticks: -7n, ticksPerSecond: 3n, domain: 'media' });
    expect(snapshot.placement.sourceAnchor.ticks).toBe(-10n); expect(snapshot.placement.mediaPts).toBe(2000);
    for (const value of [snapshot, snapshot.source, snapshot.placement, snapshot.placement.sourceAnchor]) expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([
    ['ticks', 1], ['ticksPerSecond', 0n], ['ticksPerSecond', -1n], ['domain', 'unknown'], ['domain', 'media'],
  ] as const)('rejects invalid or placement-inconsistent observed source %s=%s', (key, value) => {
    const witness = observedResume(); Reflect.set(witness.source, key, value);
    expect(() => snapshotLocResumePoint(witness)).toThrow(/source|domain/);
  });

  it('rejects invalid placement data without accepting the observed point as new mapping proof', () => {
    const witness = observedResume(); Reflect.set(witness.placement, 'mediaPts', 2000.5);
    expect(() => snapshotLocResumePoint(witness)).toThrow(/media index/);
    const badRounding = observedResume(); Reflect.set(badRounding.placement, 'timestampRounding', 'truncate');
    expect(() => projectLocResumePoint(badRounding, resumePlacement())).toThrow(/rounding/);
  });

  it.each(['floor', 'nearest'] as const)('preserves the complete 2010.50025ms audio point without another uncertainty offset: %s', timestampRounding => {
    const placement = resumePlacement(timestampRounding);
    const source = { ticks: (unixAnchor + 10_500n) * 4n + 1n, ticksPerSecond: 4_000_000n, domain: 'unix' as const };
    const witness = snapshotLocResumePoint({ source, placement });
    const projected = projectLocResumePoint(witness, placement);
    sameSource(projected.source, source);
    expect(locIndexedTime(projected.placement, projected.source)?.nominalUs).toEqual({ numerator: 8_042_001n, denominator: 4n });
    expect(locIndexedPositionMs(placement, projected.source)).toBe(2010.50025);
    expect(projected.source.ticksPerSecond).toBe(4_000_000n);
    expect(Object.isFrozen(projected.source)).toBe(true); expect(Object.isFrozen(projected.placement.sourceAnchor)).toBe(true);
  });

  it('inverts full rational points across huge, unrelated epochs and source scales, including negative destination ticks', () => {
    const anchor = { ticks: (1n << 200n) * 3n + 1n, ticksPerSecond: 3n, domain: 'media' as const };
    const placement: LocIndexedPlacement = { sourceAnchor: anchor, mediaPts: 2000, timestampRounding: 'nearest' };
    const source = { ticks: anchor.ticks * 4_000_000n + 1n, ticksPerSecond: 12_000_000n, domain: 'media' as const };
    const destination: LocIndexedPlacement = { sourceAnchor: { ticks: -(1n << 280n) + 7n, ticksPerSecond: 7n, domain: 'unix' },
      mediaPts: 1000, timestampRounding: 'floor' };
    const projected = projectLocResumePoint({ source, placement }, destination);
    expect(projected.source.ticks).toBeLessThan(0n); expect(projected.source.domain).toBe('unix');
    expect(locIndexedTime(projected.placement, projected.source)?.nominalUs).toEqual(locIndexedTime(placement, source)?.nominalUs);
    sameSource(projectLocResumePoint(projected, placement).source, source);
    expect(locIndexedPositionMs(projected.placement, projected.source)).toBe(2000 + 1 / 12_000);
  });

  it('keeps a destination scale when it represents the projected point exactly', () => {
    const destination: LocIndexedPlacement = { sourceAnchor: { ticks: -8n, ticksPerSecond: 3n, domain: 'media' },
      mediaPts: 1100, timestampRounding: 'floor' };
    const projected = projectLocResumePoint(observedResume(), destination);
    expect(projected.source).toEqual({ ticks: -5n, ticksPerSecond: 3n, domain: 'media' });
  });

  it('projects negative nominal media positions exactly while public positions remain unavailable', () => {
    const placement: LocIndexedPlacement = { sourceAnchor: { ticks: 0n, ticksPerSecond: 3n, domain: 'media' },
      mediaPts: 0, timestampRounding: 'floor' };
    const witness = { source: { ticks: -1n, ticksPerSecond: 3n, domain: 'media' as const }, placement };
    const projected = projectLocResumePoint(witness, resumePlacement());
    expect(locIndexedTime(projected.placement, projected.source)?.nominalUs).toEqual({ numerator: -1_000_000n, denominator: 3n });
    expect(locIndexedPositionMs(projected.placement, projected.source)).toBeNull();
  });

  it('converts only a bounded proper fraction after exact subtraction even when source scale cannot become a Number', () => {
    const scale = 1n << 1200n, epoch = 1n << 1500n;
    const placement: LocIndexedPlacement = { sourceAnchor: { ticks: epoch * scale, ticksPerSecond: scale, domain: 'media' },
      mediaPts: 2000, timestampRounding: 'floor' };
    const source = { ticks: epoch * scale + scale / 2048n, ticksPerSecond: scale, domain: 'media' as const };
    expect(locIndexedPositionMs(placement, source)).toBe(2000.48828125);
    const tooLarge = { ...source, ticks: source.ticks + BigInt(Number.MAX_SAFE_INTEGER) * scale };
    expect(locIndexedPositionMs(placement, tooLarge)).toBeNull();
    expect(locIndexedPositionMs(placement, { ...source, domain: 'unix' })).toBeNull();
    expect(locIndexedPositionMs(placement, { ...source, ticksPerSecond: 0n })).toBeNull();
  });
});

describe('observed LOC resume anchoring and ownership', () => {
  it.each([
    ['floor', 'floor', 1000n, false], ['floor', 'floor', -1000n, false],
    ['nearest', 'nearest', 1000n, true], ['nearest', 'nearest', -1000n, true],
    ['floor', 'nearest', 500n, true], ['nearest', 'floor', -500n, true],
  ] as const)('requires exact interval overlap, including endpoint ownership: old %s new %s delta %s',
    (oldRounding, timestampRounding, offset, accepted) => {
      const discarded: object[] = [], token = {}, resume = observedResume(oldRounding);
      const input = new LocSeekInput(opts({ resume, mediaPts: 2000, targetMs: 2100, timestampRounding,
        onDiscard: value => { discarded.push(value); } }));
      const push = () => input.push(object(), unixHeaders(unixAnchor + offset, true), token);
      if (!accepted) {
        expect(push).toThrow(/contradicts.*timeline index/);
        expect(discarded).toEqual([token]); expect(input.retainedBytes).toBe(0);
        input.cancel(); expect(discarded).toEqual([token]);
      } else {
        push(); input.push(object(1n), unixHeaders(unixAnchor + 100_000n, false));
        const result = ready(input.finishGroup(3n));
        expect(result.placement).toEqual(resume.placement);
        expect(result.anchor.ticks).toBe(unixAnchor + offset);
        expect(result.selected.location.objectId).toBe(1n); input.cancel(); expect(discarded).toEqual([]);
      }
    });

  it('refuses a contradictory new index before transferring a decoder prefix', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(opts({ resume: observedResume(), mediaPts: 9000,
      onDiscard: value => { discarded.push(value); } }));
    expect(() => input.push(object(), unixHeaders(unixAnchor, true), token)).toThrow(/contradicts/);
    expect(() => input.finishGroup(3n)).toThrow(/retired/); expect(discarded).toEqual([token]);
  });

  it('rejects a new source domain even when its numerical point could overlap the index', () => {
    const discarded: object[] = [], token = {};
    const input = new LocSeekInput(opts({ resume: observedResume(), mediaPts: 2000,
      onDiscard: value => { discarded.push(value); } }));
    expect(() => input.push(object(), headers(2000n, true), token)).toThrow(/domain changed/);
    expect(discarded).toEqual([token]); expect(input.retainedObjectCount).toBe(0);
  });

  it('snapshots resume options at construction and never reacquires caller getters through group continuation', () => {
    let reads = 0;
    const resume = observedResume(), options = { ...opts({ mediaPts: 2000, targetMs: 2100 }),
      get resume() { reads++; return resume; } };
    const input = new LocSeekInput(options);
    Reflect.set(resume.source, 'ticks', 0n); Reflect.set(resume.placement, 'mediaPts', 9000);
    input.push(object(), unixHeaders(unixAnchor + 250n, true));
    expect(input.finishGroup(3n).kind).toBe('need-more');
    const next = input.continueAt(4n);
    next.push(object(0n, idr, { groupId: 4n }), unixHeaders(unixAnchor + 100_000n, true));
    expect(ready(next.finishGroup(4n)).selected.sourceTimestamp.ticks).toBe(unixAnchor + 100_000n);
    expect(reads).toBe(1);
  });

  it('carries the observed threshold through a closed earlier group and selects the least resumed B-frame PTS', () => {
    const discarded: object[] = [], a = {}, b = {}, c = {}, resume = observedResume();
    const input = new LocSeekInput(opts({ resume, mediaPts: 2000, targetMs: 2100,
      onDiscard: value => { discarded.push(value); } }));
    input.push(object(), unixHeaders(unixAnchor + 250n, true), a);
    input.push(object(1n), unixHeaders(unixAnchor + 50_000n, false), b);
    expect(input.finishGroup(3n).kind).toBe('need-more');
    const next = input.continueAt(4n); expect(discarded).toEqual([a, b]);
    for (const [i, offset] of [200_000n, 100_000n, 300_000n].entries()) {
      next.push(object(BigInt(i), i ? delta : idr, { groupId: 4n }), unixHeaders(unixAnchor + offset, i === 0), c);
    }
    const result = ready(next.finishGroup(4n));
    expect(result.selected.location).toEqual({ groupId: 4n, objectId: 1n });
    expect(result.placement).toEqual(resume.placement); expect(result.anchor.ticks).toBe(unixAnchor + 250n);
    next.cancel(); expect(discarded).toEqual([a, b]);
  });

  it('compares exact fractional source points rather than their identical normalized chunk microseconds', () => {
    const anchor: SourceTimestamp = { ticks: 270_000n, ticksPerSecond: 3000n, domain: 'media' };
    const placement: LocIndexedPlacement = { sourceAnchor: anchor, mediaPts: 2000, timestampRounding: 'nearest' };
    const source = { ticks: 1_081_200_001n, ticksPerSecond: 12_000_000n, domain: 'media' as const };
    const input = new LocSeekInput(opts({ resume: { source, placement }, mediaPts: 2000, targetMs: 2100.0000833333334,
      timestampRounding: 'nearest' }));
    input.push(object(), headers(270_000n, true, 3000n));
    input.push(object(1n), headers(1_081_200_001n, false, 12_000_000n));
    input.push(object(2n), headers(2_162_400_001n, false, 24_000_000n));
    const result = ready(input.finishGroup(3n));
    expect(result.selected.location.objectId).toBe(1n);
    expect(result.items[1]!.chunk.timestamp).toBe(result.items[2]!.chunk.timestamp);
    sameSource(result.selected.sourceTimestamp, source);
  });

  it('transfers audio prefixes with the preserved phase and no extra trim, retaining bounds and token ownership', () => {
    const discarded: object[] = [], a = {}, b = {}, placement = resumePlacement();
    const source = { ticks: (unixAnchor + 10_500n) * 4n + 1n, ticksPerSecond: 4_000_000n, domain: 'unix' as const };
    const input = new LocSeekInput(opts({ role: 'audio', codec: 'opus', resume: { source, placement },
      mediaPts: 2000, targetMs: 2010.50025, timestampRounding: 'nearest', maxObjects: 1,
      onDiscard: value => { discarded.push(value); } }));
    input.push(object(0n, Uint8Array.of(0xf8)), unixHeaders(unixAnchor + 250n, false), a);
    const first = input.finishAudioGroup(3n), next = input.continueAt(4n);
    next.push(object(0n, Uint8Array.of(0xf8), { groupId: 4n }), unixHeaders(unixAnchor + 20_000n, false), b);
    const second = next.finishAudioGroup(4n);
    expect(first.placement).toEqual(placement); expect(second.placement).toEqual(placement);
    sameSource(projectLocResumePoint({ source, placement }, second.placement!).source, source);
    expect(locIndexedPositionMs(second.placement!, source)).toBe(2010.50025);
    expect(first.items[0]!.input).toBe(a); expect(second.items[0]!.input).toBe(b);
    next.cancel(); input.cancel(); expect(discarded).toEqual([]);
    expect(() => next.continueAt(5n)).toThrow(/retired/);
  });

  it('keeps resume preparation object bounds and disposes each acquired token once on overflow', () => {
    const discarded: object[] = [], a = {}, b = {};
    const input = new LocSeekInput(opts({ resume: observedResume(), mediaPts: 2000, maxObjects: 1,
      onDiscard: value => { discarded.push(value); } }));
    input.push(object(), unixHeaders(unixAnchor, true), a);
    expect(() => input.push(object(1n), unixHeaders(unixAnchor + 100_000n, false), b)).toThrow(/object budget/);
    expect(discarded).toEqual([a, b]); input.cancel(); expect(discarded).toEqual([a, b]);
  });
});
