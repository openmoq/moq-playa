/**
 * MSF-02 §8.2 changed the event timeline index keys from lowercase ('t', 'l', 'm') to
 * uppercase ('T', 'L', 'M'). Both spellings parse to the same record shape.
 *
 * @see draft-ietf-moq-msf-02 §8.2, Appendix A.1.5
 * @module
 */
import { describe, it, expect } from 'vitest';
import { parseEventTimeline } from './timeline.js';

describe('event timeline index keys', () => {
    it('parses the uppercase MSF-02 keys', () => {
        const records = parseEventTimeline(JSON.stringify([
            { L: [0, 1], data: [1, 55] },
            { T: 1759924158381, data: { v: 1 } },
            { M: 2002, data: 'x' },
        ]));
        expect(records).toHaveLength(3);
        expect(records[0]!.index).toEqual({ l: [0, 1] });
        expect(records[1]!.index).toEqual({ t: 1759924158381 });
        expect(records[2]!.index).toEqual({ m: 2002 });
    });

    it('still parses the lowercase MSF-01 keys', () => {
        const [record] = parseEventTimeline(JSON.stringify([{ l: [3, 4], data: 1 }]));
        expect(record!.index).toEqual({ l: [3, 4] });
    });

    it('rejects a record that mixes index keys of either case', () => {
        expect(() => parseEventTimeline(JSON.stringify([{ L: [0, 0], t: 1, data: 1 }]))).toThrow(/exactly one index field/);
        expect(() => parseEventTimeline(JSON.stringify([{ L: [0, 0], M: 1, data: 1 }]))).toThrow(/exactly one index field/);
    });
});
