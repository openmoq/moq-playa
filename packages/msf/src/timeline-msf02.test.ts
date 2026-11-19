import { expect, it } from 'vitest';
import { parseEventTimeline, parseSapTimeline, parseMediaTimeline } from './index.js';

it('normalizes MSF-02 uppercase indexes while preserving arbitrary JSON data and earlier keys', () => {
    const records = [{ T: 5, data: null }, { L: [3, 2], data: [1, true] }, { M: 6, data: 'event' }];
    expect(parseEventTimeline(JSON.stringify(records), 'draft-02')).toEqual([
        { index: { t: 5 }, data: null }, { index: { l: [3, 2] }, data: [1, true] }, { index: { m: 6 }, data: 'event' },
    ]);
    expect(() => parseEventTimeline(JSON.stringify(records))).toThrow(/index/);
    expect(() => parseEventTimeline('[{"t":1,"data":null}]', 'draft-02')).toThrow(/index/);
    expect(parseEventTimeline('[{"t":1,"data":null}]')[0]!.index).toEqual({ t: 1 });
    expect(() => parseEventTimeline('[{"T":1,"M":2,"data":null}]', 'draft-02')).toThrow(/index/);
    expect(() => parseEventTimeline('[{"T":1}]', 'draft-02')).toThrow(/data/);
    expect(parseMediaTimeline('[[0,[1,0],0],[5,[9,0],0]]').map(e => e.location)).toEqual([[1, 0], [9, 0]]);
    expect(() => parseMediaTimeline('[[0,[1,0],0],[0,1,[1,0],[1,0],0,1]]')).toThrow();
});
it('requires uppercase location indexes for SAP timelines in MSF-02 catalogs', () => {
    expect(parseSapTimeline('[{"L":[3,0],"data":[1,25]}]', 'draft-02')).toEqual([
        { location: [3, 0], sapType: 1, earliestPresentationTimeMs: 25 },
    ]);
    expect(() => parseSapTimeline('[{"l":[3,0],"data":[1,25]}]', 'draft-02')).toThrow(/index/);
    expect(parseSapTimeline('[{"l":[3,0],"data":[1,25]}]')).toHaveLength(1);
});
