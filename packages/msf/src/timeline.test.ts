/**
 * Tests for timeline parsing: parseMediaTimeline, parseEventTimeline,
 * findLocationForPts, mergeMediaTimeline.
 *
 * Test vectors from draft-ietf-moq-msf-00 §7.1 (media timeline),
 * §8.4.1 (event timeline — sports scores), §8.4.2 (event timeline — GPS).
 *
 * @see draft-ietf-moq-msf-00 §7, §8
 */

import { describe, it, expect } from 'vitest';
import {
    parseMediaTimeline,
    parseEventTimeline,
    parseSapTimeline,
    findLocationForPts,
    mergeMediaTimeline,
} from './timeline.js';

// ─── Spec test vectors ───────────────────────────────────────────────

/** §7.1: Media timeline example */
const MEDIA_TIMELINE_JSON = JSON.stringify([
    [0, [0, 0], 1759924158381],
    [2002, [1, 0], 1759924160383],
    [4004, [2, 0], 1759924162385],
    [6006, [3, 0], 1759924164387],
    [8008, [4, 0], 1759924166389],
]);

/** §8.4.1: Event timeline — sports scores (wallclock time 't' index) */
const EVENT_SPORTS_JSON = JSON.stringify([
    {
        t: 1756885678361,
        data: {
            status: 'in_progress',
            period: 1,
            clock: '12:00',
            homeScore: 0,
            awayScore: 0,
            lastPlay: 'Game Start',
        },
    },
    {
        t: 1756885981542,
        data: {
            status: 'in_progress',
            period: 1,
            clock: '09:25',
            homeScore: 2,
            awayScore: 0,
            lastPlay: 'Team A: #23 makes 2-pt jump shot',
        },
    },
]);

/** §8.4.2: Event timeline — GPS coordinates (MOQT Location 'l' index) */
const EVENT_GPS_JSON = JSON.stringify([
    { l: [0, 0], data: [47.1812, 8.4592] },
    { l: [1, 0], data: [47.1662, 8.5155] },
]);

// ─── parseMediaTimeline tests ────────────────────────────────────────

describe('parseMediaTimeline', () => {
    it('parses §7.1 example — 5 entries with correct fields', () => {
        const entries = parseMediaTimeline(MEDIA_TIMELINE_JSON);
        expect(entries).toHaveLength(5);

        expect(entries[0]!.mediaPts).toBe(0);
        expect(entries[0]!.location).toEqual([0, 0]);
        expect(entries[0]!.wallclockTime).toBe(1759924158381);

        expect(entries[2]!.mediaPts).toBe(4004);
        expect(entries[2]!.location).toEqual([2, 0]);
        expect(entries[2]!.wallclockTime).toBe(1759924162385);

        expect(entries[4]!.mediaPts).toBe(8008);
        expect(entries[4]!.location).toEqual([4, 0]);
        expect(entries[4]!.wallclockTime).toBe(1759924166389);
    });

    it('parses empty array', () => {
        const entries = parseMediaTimeline('[]');
        expect(entries).toHaveLength(0);
    });

    it('handles VOD entries (wallclockTime = 0)', () => {
        const json = JSON.stringify([
            [0, [0, 0], 0],
            [5000, [1, 0], 0],
        ]);
        const entries = parseMediaTimeline(json);
        expect(entries).toHaveLength(2);
        expect(entries[0]!.wallclockTime).toBe(0);
        expect(entries[1]!.wallclockTime).toBe(0);
    });

    it('accepts Uint8Array input', () => {
        const bytes = new TextEncoder().encode(MEDIA_TIMELINE_JSON);
        const entries = parseMediaTimeline(bytes);
        expect(entries).toHaveLength(5);
    });

    it('rejects non-array input', () => {
        expect(() => parseMediaTimeline('{"not": "array"}')).toThrow(/array/i);
    });

    it('rejects malformed entries — wrong element count', () => {
        const json = JSON.stringify([[0, [0, 0]]]);  // missing wallclockTime
        expect(() => parseMediaTimeline(json)).toThrow();
    });

    it('rejects malformed entries — wrong types', () => {
        const json = JSON.stringify([['not-a-number', [0, 0], 1234]]);
        expect(() => parseMediaTimeline(json)).toThrow();
    });
});

// ─── parseEventTimeline tests ────────────────────────────────────────

describe('parseEventTimeline', () => {
    it('parses §8.4.1 — sports scores with wallclock time index', () => {
        const records = parseEventTimeline(EVENT_SPORTS_JSON);
        expect(records).toHaveLength(2);

        expect(records[0]!.index).toEqual({ t: 1756885678361 });
        expect((records[0]!.data as Record<string, unknown>)['homeScore']).toBe(0);

        expect(records[1]!.index).toEqual({ t: 1756885981542 });
        expect((records[1]!.data as Record<string, unknown>)['homeScore']).toBe(2);
    });

    it('parses §8.4.2 — GPS coordinates with MOQT Location index', () => {
        const records = parseEventTimeline(EVENT_GPS_JSON);
        expect(records).toHaveLength(2);

        expect(records[0]!.index).toEqual({ l: [0, 0] });
        expect(records[0]!.data).toEqual([47.1812, 8.4592]);

        expect(records[1]!.index).toEqual({ l: [1, 0] });
        expect(records[1]!.data).toEqual([47.1662, 8.5155]);
    });

    it('parses media PTS index', () => {
        const json = JSON.stringify([
            { m: 5000, data: { event: 'goal' } },
        ]);
        const records = parseEventTimeline(json);
        expect(records).toHaveLength(1);
        expect(records[0]!.index).toEqual({ m: 5000 });
    });

    it('rejects record with no index field', () => {
        const json = JSON.stringify([{ data: { x: 1 } }]);
        expect(() => parseEventTimeline(json)).toThrow(/index/i);
    });

    it('rejects record with multiple index fields', () => {
        const json = JSON.stringify([{ t: 123, m: 456, data: {} }]);
        expect(() => parseEventTimeline(json)).toThrow(/index/i);
    });

    it('rejects record without data field', () => {
        const json = JSON.stringify([{ t: 123 }]);
        expect(() => parseEventTimeline(json)).toThrow(/data/i);
    });

    // ─── §8.1: Index value type validation ──────────────────────────

    it('rejects non-number wallclock time index (§8.1)', () => {
        const json = JSON.stringify([{ t: 'not-a-number', data: {} }]);
        expect(() => parseEventTimeline(json)).toThrow(/number/i);
    });

    it('rejects non-number media PTS index (§8.1)', () => {
        const json = JSON.stringify([{ m: 'not-a-number', data: {} }]);
        expect(() => parseEventTimeline(json)).toThrow(/number/i);
    });

    it('rejects malformed location index — not an array (§8.1)', () => {
        const json = JSON.stringify([{ l: 'not-an-array', data: {} }]);
        expect(() => parseEventTimeline(json)).toThrow(/location/i);
    });

    it('rejects malformed location index — wrong length (§8.1)', () => {
        const json = JSON.stringify([{ l: [1], data: {} }]);
        expect(() => parseEventTimeline(json)).toThrow(/location/i);
    });

    it('rejects malformed location index — non-number elements (§8.1)', () => {
        const json = JSON.stringify([{ l: [1, 'bad'], data: {} }]);
        expect(() => parseEventTimeline(json)).toThrow(/location/i);
    });
});

// ─── findLocationForPts tests ────────────────────────────────────────

describe('findLocationForPts', () => {
    const timeline = parseMediaTimeline(MEDIA_TIMELINE_JSON);

    it('finds exact match', () => {
        const loc = findLocationForPts(timeline, 4004);
        expect(loc).toEqual([2, 0]);
    });

    it('finds floor entry for PTS between entries', () => {
        const loc = findLocationForPts(timeline, 5000);
        expect(loc).toEqual([2, 0]); // floor of 5000 is entry at 4004
    });

    it('returns undefined for PTS before first entry', () => {
        const loc = findLocationForPts(timeline, -1);
        expect(loc).toBeUndefined();
    });

    it('returns last entry for PTS at or after last entry', () => {
        const loc = findLocationForPts(timeline, 10000);
        expect(loc).toEqual([4, 0]);
    });
});

// ─── mergeMediaTimeline tests ────────────────────────────────────────

describe('mergeMediaTimeline', () => {
    it('appends new entries to base', () => {
        const base = parseMediaTimeline(JSON.stringify([
            [0, [0, 0], 1000],
            [2000, [1, 0], 3000],
        ]));
        const update = parseMediaTimeline(JSON.stringify([
            [4000, [2, 0], 5000],
            [6000, [3, 0], 7000],
        ]));
        const merged = mergeMediaTimeline(base, update);
        expect(merged).toHaveLength(4);
        expect(merged[3]!.mediaPts).toBe(6000);
    });

    it('returns base unchanged for empty update', () => {
        const base = parseMediaTimeline(JSON.stringify([
            [0, [0, 0], 1000],
        ]));
        const merged = mergeMediaTimeline(base, []);
        expect(merged).toHaveLength(1);
        expect(merged[0]!.mediaPts).toBe(0);
    });

    it('deduplicates by location', () => {
        const base = parseMediaTimeline(JSON.stringify([
            [0, [0, 0], 1000],
            [2000, [1, 0], 3000],
        ]));
        const update = parseMediaTimeline(JSON.stringify([
            [2000, [1, 0], 3000],  // duplicate
            [4000, [2, 0], 5000],  // new
        ]));
        const merged = mergeMediaTimeline(base, update);
        expect(merged).toHaveLength(3);
    });
});

// ─── SAP Type Timeline (CMSF §3.6.1) ──────────────────────────────

/**
 * @see draft-ietf-moq-cmsf-00 §3.6.1 (SAP Type timeline)
 * @see draft-ietf-moq-cmsf-00 §3.6.2 (SAP-type timeline track example)
 */
describe('parseSapTimeline (CMSF §3.6.1)', () => {
    it('parses the spec example SAP timeline (CMSF §3.6.2)', () => {
        // §3.6.2: 30-fps HEVC, 4s Groups, SAP-type 2 at group start,
        // SAP-type 3 (CRA) at 2 seconds in each Group.
        const json = JSON.stringify([
            { l: [0, 0], data: [2, 0] },
            { l: [0, 60], data: [3, 2100] },
            { l: [1, 0], data: [2, 4000] },
            { l: [1, 60], data: [3, 6100] },
        ]);

        const entries = parseSapTimeline(json);
        expect(entries).toHaveLength(4);

        expect(entries[0]!.location).toEqual([0, 0]);
        expect(entries[0]!.sapType).toBe(2);
        expect(entries[0]!.earliestPresentationTimeMs).toBe(0);

        expect(entries[1]!.location).toEqual([0, 60]);
        expect(entries[1]!.sapType).toBe(3);
        expect(entries[1]!.earliestPresentationTimeMs).toBe(2100);

        expect(entries[2]!.location).toEqual([1, 0]);
        expect(entries[2]!.sapType).toBe(2);
        expect(entries[2]!.earliestPresentationTimeMs).toBe(4000);

        expect(entries[3]!.location).toEqual([1, 60]);
        expect(entries[3]!.sapType).toBe(3);
        expect(entries[3]!.earliestPresentationTimeMs).toBe(6100);
    });

    it('rejects SAP timeline with non-location index (CMSF §3.6.1)', () => {
        // §3.6.1: "The index reference MUST be 'l' for Location"
        const json = JSON.stringify([
            { t: 1000, data: [2, 0] },
        ]);
        expect(() => parseSapTimeline(json)).toThrow(/location|'l'/i);
    });

    it('rejects SAP data with invalid SAP type (CMSF §3.6.1)', () => {
        // §3.6.1: "allowed value of 0,1,2 or 3"
        const json = JSON.stringify([
            { l: [0, 0], data: [5, 0] },
        ]);
        expect(() => parseSapTimeline(json)).toThrow(/SAP type/i);
    });

    it('rejects SAP data that is not a 2-element array (CMSF §3.6.1)', () => {
        // §3.6.1: "data field is a JSON Array containing two integers"
        const json = JSON.stringify([
            { l: [0, 0], data: [2] },
        ]);
        expect(() => parseSapTimeline(json)).toThrow(/two integers/i);
    });

    it('accepts SAP type 0 (no SAP) for non-first objects (CMSF §3.6.1)', () => {
        // §3.6.1: "value 0 indicates that the Object does not start with
        // an ISOBMFF stream access point"
        const json = JSON.stringify([
            { l: [0, 0], data: [1, 0] },    // Group start: SAP type 1
            { l: [0, 1], data: [0, 33] },   // Not a SAP
        ]);
        const entries = parseSapTimeline(json);
        expect(entries[1]!.sapType).toBe(0);
    });
});
