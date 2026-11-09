import { describe, expect, it } from 'vitest';
import * as headBoundary from './seek-fetch-pages.js';
import { createControlCodec, decodeFetchLocationFilter, MAX_VARINT, MAX_VI64, varint } from '@openmoq/transport';
import type { MediaTimelineEntry } from '@openmoq/msf';
import type { TimelineState } from './timeline-manager.js';
import { advanceSeekFetchCut, planSeekFetchPage, seekFetchResponseCut, type SeekFetchCut } from './seek-fetch-pages.js';

const before = (groupId: bigint, objectId = 0n): SeekFetchCut => ({ kind: 'before', groupId, objectId });
const entry = (mediaPts: number, group: number, object = 0): MediaTimelineEntry => ({ mediaPts, location: [group, object], wallclockTime: 0 });
const timeline = (entries: MediaTimelineEntry[], isLive = true): TimelineState => ({ entries, isLive, depends: ['video'], trackName: 'timeline', trackDuration: 86_400_000 });
const response = (group: bigint, object: bigint, endOfTrack = false) => ({ endOfTrack, endLocation: { group, object } });
const plan = (entries: MediaTimelineEntry[], cut = before(3n), draftVersion: 14 | 16 | 18 | 22 = 18) =>
  planSeekFetchPage({ draftVersion, trackName: 'video', timeline: timeline(entries), cut, endOfTrack: false });

describe('published historical page planning', () => {
  it.each([14, 16, 18, 22] as const)('draft %i limits far-behind playback to an indexed page instead of fetching the tip', draft => {
    const result = plan([entry(0, 3), entry(2000, 4), entry(4000, 5), entry(6000, 6), entry(3_600_000, 999)], before(3n), draft);
    expect(result).toMatchObject({ kind: 'fetch-page', start: { groupId: 3n, objectId: 0n },
      end: { groupId: 4n, objectId: 0n }, through: before(5n) });
  });

  it.each([14, 16, 18, 22] as const)('draft %i can bound initial preparation at the final indexed Object without inferring a live head', draftVersion => {
    const options = { draftVersion, trackName: 'video', timeline: timeline([entry(4000, 3, 0)]), cut: before(3n), endOfTrack: false };
    expect(planSeekFetchPage({ ...options, includeIndexedTip: true })).toMatchObject({ kind: 'fetch-page',
      start: { groupId: 3n, objectId: 0n }, end: { groupId: 3n, objectId: 1n }, through: before(3n, 1n) });
    expect(planSeekFetchPage(options).kind).toBe('probe-live');
    expect(planSeekFetchPage({ ...options, cut: before(3n, 1n), includeIndexedTip: true })).toEqual({ kind: 'wait-for-index', reason: 'index-behind-cursor' });
  });

  it('same-group sparse locations make a finite page without assuming dense Object IDs', () => {
    expect(plan([entry(0, 3, 10), entry(2000, 3, 20), entry(4000, 3, 90), entry(8000, 3, 500)], before(3n, 11n)))
      .toMatchObject({ kind: 'fetch-page', start: { groupId: 3n, objectId: 11n }, end: { groupId: 3n, objectId: 90n }, through: before(3n, 90n) });
  });

  it('a coarse index supplies the next actual boundary, never a fabricated five-second Location', () => {
    expect(plan([entry(0, 3), entry(60_000, 17)])).toMatchObject({ kind: 'fetch-page', end: { groupId: 16n, objectId: 0n }, through: before(17n) });
  });

  it('probes only when the cut reaches the actual indexed tip', () => {
    expect(plan([entry(0, 3), entry(2000, 4)], before(4n))).toMatchObject({ kind: 'probe-live', indexedTip: { groupId: 4n, objectId: 0n, mediaPts: 2000 } });
    expect(plan([entry(0, 3)], before(3n, 50n))).toEqual({ kind: 'wait-for-index', reason: 'index-behind-cursor' });
  });

  it('does not turn a catalog duration, VOD designation, or an empty index into publication/finality', () => {
    expect(plan([])).toEqual({ kind: 'wait-for-index', reason: 'no-index' });
    expect(planSeekFetchPage({ draftVersion: 18, trackName: 'video', timeline: timeline([entry(0, 3)], false), cut: before(3n), endOfTrack: false }))
      .toEqual({ kind: 'wait-for-index', reason: 'no-new-indexed-range' });
    expect(planSeekFetchPage({ draftVersion: 22, trackName: 'video', timeline: timeline([]), cut: before(3n), endOfTrack: true }))
      .toEqual({ kind: 'finished', cut: before(3n) });
  });

  it('keeps roles independent and refuses an index that does not cover this track', () => {
    const source = timeline([entry(0, 3), entry(2000, 4)]);
    expect(planSeekFetchPage({ draftVersion: 18, trackName: 'audio', timeline: source, cut: before(3n), endOfTrack: false }))
      .toEqual({ kind: 'wait-for-index', reason: 'timeline-does-not-cover-track' });
    expect(plan(source.entries, before(3n)).kind).toBe('fetch-page');
    expect(plan(source.entries, before(4n)).kind).toBe('probe-live');
  });

  it('waits after a zero-progress page until a strictly newer publication witness exists, then enlarges the range', () => {
    const initial = plan([entry(0, 3), entry(2000, 4), entry(4000, 5), entry(6000, 6)]);
    if (initial.kind !== 'fetch-page') throw new Error('Expected page');
    const unchanged = { draftVersion: 18 as const, trackName: 'video', timeline: timeline([entry(0, 3), entry(2000, 4), entry(4000, 5), entry(6000, 6)]),
      cut: before(3n), endOfTrack: false, lastNonProgress: initial.proof };
    expect(planSeekFetchPage(unchanged)).toEqual({ kind: 'wait-for-index', reason: 'no-new-publication' });
    const changed = planSeekFetchPage({ ...unchanged, timeline: timeline([...unchanged.timeline.entries, entry(8000, 7)]) });
    expect(changed).toMatchObject({ kind: 'fetch-page', through: before(6n) });
  });

  it('does not repeat a rejected probe for the same cut/index and ignores another cursor’s stalled proof', () => {
    const source = timeline([entry(0, 3), entry(2000, 4)]), probe = plan(source.entries, before(4n));
    if (probe.kind !== 'probe-live') throw new Error('Expected probe');
    expect(planSeekFetchPage({ draftVersion: 18, trackName: 'video', timeline: source, cut: before(4n), endOfTrack: false, lastNonProgress: probe.proof }))
      .toEqual({ kind: 'wait-for-index', reason: 'no-new-publication' });
    expect(planSeekFetchPage({ draftVersion: 18, trackName: 'video', timeline: source, cut: before(3n), endOfTrack: false, lastNonProgress: probe.proof }).kind)
      .toBe('fetch-page');
  });

  it('continues from an actual clamped response rather than the planned endpoint', () => {
    const entries = [entry(0, 3), entry(2000, 4), entry(4000, 5), entry(6000, 6), entry(8000, 7)];
    const first = plan(entries);
    if (first.kind !== 'fetch-page') throw new Error('Expected page');
    const accepted = advanceSeekFetchCut(18, before(3n), response(3n, 21n));
    expect(accepted.cut).toEqual(before(3n, 21n));
    const next = planSeekFetchPage({ draftVersion: 18, trackName: 'video', timeline: timeline(entries), cut: accepted.cut,
      endOfTrack: false, lastNonProgress: first.proof });
    expect(next).toMatchObject({ kind: 'fetch-page', start: { groupId: 3n, objectId: 21n }, through: before(5n) });
  });

  it('pages across an evolving index with strictly advancing cuts and no state mutation', () => {
    const source = timeline(Array.from({ length: 11 }, (_, i) => entry(i * 2000, i + 3)));
    let cut = before(3n), pages = 0;
    while (true) {
      const next = planSeekFetchPage({ draftVersion: 18, trackName: 'video', timeline: source, cut, endOfTrack: false });
      if (next.kind === 'probe-live') { expect(next.indexedTip.groupId).toBe(13n); break; }
      if (next.kind !== 'fetch-page') throw new Error('Expected advancing page');
      const accepted = advanceSeekFetchCut(18, cut, response(next.end.groupId, next.end.objectId));
      expect(accepted.advanced).toBe(true); expect(accepted.cut).toEqual(next.through);
      cut = accepted.cut; pages++; if (pages > 10) throw new Error('Planner did not advance');
    }
    expect(pages).toBe(5); expect(source.entries).toHaveLength(11);
  });

  it('a stalled proof from another role does not suppress a same-numbered cut', () => {
    const source = timeline([entry(0, 3), entry(2000, 4)]); source.depends.push('audio');
    const video = plan(source.entries, before(4n));
    if (video.kind !== 'probe-live') throw new Error('Expected probe');
    expect(planSeekFetchPage({ draftVersion: 18, trackName: 'audio', timeline: source, cut: before(4n), endOfTrack: false,
      lastNonProgress: video.proof }).kind).toBe('probe-live');
  });

  it('uses one proven interval when valid nonmonotone PTS cannot price a five-second window', () => {
    expect(plan([entry(-1000, 3), entry(3000, 4), entry(0, 5), entry(7000, 6)]))
      .toMatchObject({ kind: 'fetch-page', through: before(4n), end: { groupId: 3n, objectId: 0n } });
  });

  it('canonicalizes a whole-group cut before building a new page', () => {
    expect(plan([entry(0, 3), entry(2000, 4), entry(4000, 5)], { kind: 'after-group', groupId: 3n }))
      .toMatchObject({ kind: 'fetch-page', start: { groupId: 4n, objectId: 0n }, end: { groupId: 4n, objectId: 0n }, through: before(5n) });
  });

  it('sorts a copied snapshot and accepts an identical repeated entry without mutating TimelineState', () => {
    const entries = [entry(4000, 5), entry(0, 3), entry(2000, 4), entry(2000, 4)];
    const original = entries.slice();
    expect(plan(entries)).toMatchObject({ kind: 'fetch-page', through: before(5n) }); expect(entries).toEqual(original);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses an inexact/invalid index coordinate %s', group => {
    expect(() => plan([entry(0, group), entry(2000, 4)])).toThrow();
  });

  it('refuses contradictory locations/timestamps rather than pricing a fabricated live distance', () => {
    expect(() => plan([entry(0, 3), entry(2000, 3)])).toThrow();
    expect(plan([entry(2000, 3), entry(0, 4)])).toMatchObject({ kind: 'fetch-page', through: before(4n) });
    expect(() => plan([entry(Infinity, 3), entry(1000, 4)])).toThrow();
    expect(plan([entry(1000, 4)], before(3n))).toEqual({ kind: 'wait-for-index', reason: 'cursor-not-indexed' });
  });
});

describe('inclusive publisher head to exclusive application cut', () => {
  it.each([14, 16, 18, 22] as const)('draft %i includes Object0 and does not mutate its head', draft => {
    const head = Object.freeze({ groupId: 3n, objectId: 0n });
    expect(headBoundary.seekCutAfterLocation(draft, head)).toEqual(before(3n, 1n));
    expect(head).toEqual({ groupId: 3n, objectId: 0n });
  });
  it.each([14, 16, 18, 22] as const)('draft %i normalizes maximum Object and final Group without wrapping', draft => {
    const max = draft < 18 ? MAX_VARINT : MAX_VI64;
    expect(headBoundary.seekCutAfterLocation(draft, { groupId: 3n, objectId: max })).toEqual(before(4n));
    expect(headBoundary.seekCutAfterLocation(draft, { groupId: max, objectId: max }))
      .toEqual({ kind: 'after-group', groupId: max });
    expect(headBoundary.seekCutAfterLocation(draft, { groupId: max, objectId: max - 1n })).toEqual(before(max, max));
  });
  it.each([14, 16, 18, 22] as const)('draft %i refuses negative and out-of-domain publisher coordinates', draft => {
    const max = draft < 18 ? MAX_VARINT : MAX_VI64;
    expect(() => headBoundary.seekCutAfterLocation(draft, { groupId: -1n, objectId: 0n })).toThrow(RangeError);
    expect(() => headBoundary.seekCutAfterLocation(draft, { groupId: 0n, objectId: -1n })).toThrow(RangeError);
    expect(() => headBoundary.seekCutAfterLocation(draft, { groupId: max + 1n, objectId: 0n })).toThrow(RangeError);
    expect(() => headBoundary.seekCutAfterLocation(draft, { groupId: 0n, objectId: max + 1n })).toThrow(RangeError);
  });
  it.each([14, 16, 18] as const)('draft %i keeps the inclusive ACK boundary distinct from one-past FETCH response metadata', draft => {
    expect(headBoundary.seekCutAfterLocation(draft, { groupId: 3n, objectId: 7n })).toEqual(before(3n, 8n));
    expect(seekFetchResponseCut(draft, response(3n, 7n))).toEqual(before(3n, 7n));
    expect(headBoundary.seekCutAfterLocation(draft, { groupId: 3n, objectId: 0n })).toEqual(before(3n, 1n));
    expect(seekFetchResponseCut(draft, response(3n, 0n))).toEqual(before(4n));
  });
});

describe('FETCH response cuts and strict progress', () => {
  it.each([14, 16, 18] as const)('draft %i response is already exclusive; whole-group zero advances to next group', draft => {
    expect(seekFetchResponseCut(draft, response(3n, 7n))).toEqual(before(3n, 7n));
    expect(seekFetchResponseCut(draft, response(3n, 0n))).toEqual(before(4n));
  });

  it('draft-22 response is inclusive, including Object0 and the largest Object ID', () => {
    expect(seekFetchResponseCut(22, response(3n, 0n))).toEqual(before(3n, 1n));
    expect(seekFetchResponseCut(22, response(3n, 7n))).toEqual(before(3n, 8n));
    expect(seekFetchResponseCut(22, response(3n, MAX_VI64))).toEqual(before(4n));
  });

  it.each([14, 16, 18, 22] as const)('draft %i never wraps the final group', draft => {
    const max = draft < 18 ? MAX_VARINT : MAX_VI64;
    const cut = { kind: 'after-group' as const, groupId: max };
    expect(seekFetchResponseCut(draft, response(max, draft === 22 ? max : 0n))).toEqual(cut);
    expect(planSeekFetchPage({ draftVersion: draft, trackName: 'video', timeline: timeline([]), cut, endOfTrack: false }))
      .toEqual({ kind: 'wait-for-index', reason: 'address-space-exhausted' });
    expect(() => seekFetchResponseCut(draft, response(max + 1n, 0n))).toThrow();
    expect(() => seekFetchResponseCut(draft, response(0n, max + 1n))).toThrow();
  });

  it('uses the actual clamped end, distinguishes no progress, and never rewinds', () => {
    expect(advanceSeekFetchCut(22, before(3n), response(3n, 1n))).toEqual({ cut: before(3n, 2n), advanced: true, endOfTrack: false });
    expect(advanceSeekFetchCut(18, before(3n, 2n), response(3n, 2n))).toEqual({ cut: before(3n, 2n), advanced: false, endOfTrack: false });
    expect(advanceSeekFetchCut(18, before(3n, 2n), response(3n, 2n, true))).toEqual({ cut: before(3n, 2n), advanced: false, endOfTrack: true });
    expect(() => advanceSeekFetchCut(18, before(3n, 2n), response(3n, 1n))).toThrow();
    expect(advanceSeekFetchCut(18, { kind: 'after-group', groupId: 3n }, response(4n, 0n)).advanced).toBe(true);
  });
});

describe('page endpoints through the actual transport codecs', () => {
  it.each([14, 16, 18, 22] as const)('draft %i encodes a boundary at Group4/Object0 as whole Group3, not whole Group4', draft => {
    const result = plan([entry(0, 3), entry(2000, 4)], before(3n), draft);
    if (result.kind !== 'fetch-page') throw new Error('Expected page');
    const codec = createControlCodec(draft);
    const bytes = codec.encode({ type: 'FETCH', requestId: varint(0), fetch: { fetchType: 1,
      trackNamespace: [new TextEncoder().encode('live')], trackName: new TextEncoder().encode('video'),
      startLocation: { group: result.start.groupId, object: result.start.objectId }, endLocation: { group: result.end.groupId, object: result.end.objectId } }, parameters: new Map() });
    const decoded = codec.decode(bytes, 0).message;
    if (decoded.type !== 'FETCH' || decoded.fetch.fetchType !== 1) throw new Error('Expected standalone FETCH');
    expect(decoded.fetch.endLocation.group).toBe(3n);
  });

  it.each([18, 22] as const)('draft %i keeps a same-group object boundary exclusive on request', draft => {
    const result = plan([entry(0, 3, 0), entry(2000, 3, 9)], before(3n), draft);
    if (result.kind !== 'fetch-page') throw new Error('Expected page');
    const codec = createControlCodec(draft), bytes = codec.encode({ type: 'FETCH', requestId: varint(0), fetch: { fetchType: 1,
      trackNamespace: [new TextEncoder().encode('live')], trackName: new TextEncoder().encode('video'),
      startLocation: { group: 3n, object: 0n }, endLocation: { group: result.end.groupId, object: result.end.objectId } }, parameters: new Map() });
    const decoded = codec.decode(bytes, 0).message;
    if (decoded.type !== 'FETCH' || decoded.fetch.fetchType !== 1) throw new Error('Expected standalone FETCH');
    expect(decoded.fetch.endLocation).toEqual({ group: 3n, object: 9n });
    if (draft === 22) {
      const filter = decoded.parameters.get(0x21n)?.[0];
      if (!(filter instanceof Uint8Array)) throw new Error('Expected encoded LOCATION_FILTER');
      expect(decodeFetchLocationFilter(filter)).toEqual([3n, 0n, 0n, 8n]);
    }
  });

  it.each([18, 22] as const)('draft %i decodes raw FETCH_OK without applying request translation', draft => {
    const codec = createControlCodec(draft), rawEnd = { group: 3n, object: draft === 22 ? 0n : 1n };
    const bytes = codec.encode({ type: 'FETCH_OK', requestId: varint(0), endOfTrack: 0, endLocation: rawEnd, parameters: new Map() });
    const decoded = codec.decode(bytes, 0).message;
    if (decoded.type !== 'FETCH_OK') throw new Error('Expected FETCH_OK');
    expect(decoded.endLocation).toEqual(rawEnd);
    expect(seekFetchResponseCut(draft, { endOfTrack: decoded.endOfTrack === 1, endLocation: decoded.endLocation })).toEqual(before(3n, 1n));
  });

});
