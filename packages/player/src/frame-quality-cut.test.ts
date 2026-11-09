import { describe, it, expect } from 'vitest';
import type { MediaTimelineEntry } from '@openmoq/msf';
import { selectFrameQualityCut } from './seek-fetch-pages.js';
// Synthetic index entries use the ordinary zero wallclock anchor; cuts use mediaPts and Location.
const entry = (mediaPts: number, group: number, object = 0): MediaTimelineEntry => ({ mediaPts, location: [group, object], wallclockTime: 0 });
const plan = (entries = [entry(3000, 3), entry(3500, 4), entry(4000, 5)], afterContentMs = 3300) =>
  selectFrameQualityCut({ draftVersion: 18, trackName: 'low', timeline: { depends: ['high', 'low'], entries }, afterContentMs });
describe('frame quality indexed cut prefilter', () => {
  it('selects a declared future group without requiring a native buffered range', () => {
    expect(plan()).toEqual({kind:'candidate',location:{groupId:4n,objectId:0n},indexedPts:3500});
  });
  it('moves beyond already committed output including an equal boundary', () => {
    expect(plan(undefined, 3500)).toMatchObject({indexedPts:4000});
  });
  it('orders by content time rather than Group number and does not mutate the index', () => {
    const entries=[entry(5000,3),entry(3500,8),entry(4000,6)]; const before=structuredClone(entries);
    expect(plan(entries)).toMatchObject({indexedPts:3500}); expect(entries).toEqual(before);
  });
  it('does not invent an Object0 for a nonzero indexed object', () => {
    expect(plan([entry(3500,4,2)])).toEqual({kind:'unavailable',reason:'no-indexed-group-start'});
  });
  it('reports no future entry without borrowing a past location', () => {
    expect(plan(undefined, 4000)).toEqual({kind:'unavailable',reason:'no-future-content-entry'});
  });
  it('requires coverage of the target track', () => {
    expect(selectFrameQualityCut({draftVersion:22,trackName:'other',timeline:{depends:['low'],entries:[entry(3500,4)]},afterContentMs:3300})).toEqual({kind:'unavailable',reason:'timeline-does-not-cover-track'});
  });
  it.each([NaN,Infinity,-1])('refuses an invalid content frontier %s', after => {expect(()=>plan(undefined,after)).toThrow(RangeError);});
  it('keeps the shared contradictory-location validation', () => {expect(()=>plan([entry(3500,4),entry(3501,4)])).toThrow(/Contradictory/);});
});
