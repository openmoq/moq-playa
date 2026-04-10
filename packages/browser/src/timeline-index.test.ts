/**
 * Tests for TimelineIndex.
 *
 * Uses half-open interval semantics [start, end). Touching ranges
 * (end == start) are NOT overlapping but SHOULD merge on insert so
 * adjacent appends collapse into a single indexed range.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { TimelineIndex } from './timeline-index.js';

describe('TimelineIndex — empty state', () => {
    it('size is 0 and extent is null', () => {
        const t = new TimelineIndex();
        expect(t.size).toBe(0);
        expect(t.extent).toBeNull();
        expect(t.getRanges()).toEqual([]);
    });

    it('overlaps returns false for any query', () => {
        const t = new TimelineIndex();
        expect(t.overlaps(0n, 1n)).toBe(false);
        expect(t.overlaps(1000n, 2000n)).toBe(false);
    });

    it('toString returns "empty"', () => {
        const t = new TimelineIndex();
        expect(t.toString()).toBe('empty');
    });
});

describe('TimelineIndex — single insert', () => {
    it('size becomes 1 and extent reflects the inserted range', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.size).toBe(1);
        expect(t.extent).toEqual({ start: 100n, end: 200n });
    });

    it('overlaps detects exact match', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(100n, 200n)).toBe(true);
    });

    it('overlaps detects strict subset', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(120n, 180n)).toBe(true);
    });

    it('overlaps detects strict superset', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(50n, 250n)).toBe(true);
    });

    it('overlaps detects left-partial', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(50n, 150n)).toBe(true);
    });

    it('overlaps detects right-partial', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(150n, 250n)).toBe(true);
    });

    it('overlaps returns false for fully-left disjoint range', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(0n, 50n)).toBe(false);
    });

    it('overlaps returns false for fully-right disjoint range', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(300n, 400n)).toBe(false);
    });

    it('touching-left (end == start) does NOT overlap', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(50n, 100n)).toBe(false);
    });

    it('touching-right (start == end) does NOT overlap', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(200n, 300n)).toBe(false);
    });

    it('degenerate query (start >= end) never overlaps', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        expect(t.overlaps(150n, 150n)).toBe(false);
        expect(t.overlaps(180n, 120n)).toBe(false);
    });

    it('degenerate insert (start >= end) is a no-op', () => {
        const t = new TimelineIndex();
        t.insert(100n, 100n);
        expect(t.size).toBe(0);
        t.insert(200n, 100n);
        expect(t.size).toBe(0);
    });
});

describe('TimelineIndex — multiple inserts', () => {
    it('two non-adjacent inserts remain separate ranges, sorted', () => {
        const t = new TimelineIndex();
        t.insert(500n, 600n);
        t.insert(100n, 200n);
        expect(t.size).toBe(2);
        expect(t.getRanges()).toEqual([
            { start: 100n, end: 200n },
            { start: 500n, end: 600n },
        ]);
    });

    it('adjacent inserts (end == start) merge into one range', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        t.insert(200n, 300n);
        expect(t.size).toBe(1);
        expect(t.extent).toEqual({ start: 100n, end: 300n });
    });

    it('overlapping inserts merge into one range', () => {
        const t = new TimelineIndex();
        t.insert(100n, 250n);
        t.insert(200n, 400n);
        expect(t.size).toBe(1);
        expect(t.extent).toEqual({ start: 100n, end: 400n });
    });

    it('a bridging insert collapses three ranges into one', () => {
        const t = new TimelineIndex();
        t.insert(0n, 100n);
        t.insert(200n, 300n);
        t.insert(400n, 500n);
        expect(t.size).toBe(3);

        // Bridge all three with a single insert that spans them all.
        t.insert(50n, 450n);
        expect(t.size).toBe(1);
        expect(t.extent).toEqual({ start: 0n, end: 500n });
    });

    it('insert fully contained in existing range is idempotent', () => {
        const t = new TimelineIndex();
        t.insert(100n, 500n);
        t.insert(200n, 300n);
        expect(t.size).toBe(1);
        expect(t.extent).toEqual({ start: 100n, end: 500n });
    });

    it('insert that contains existing range replaces by merge', () => {
        const t = new TimelineIndex();
        t.insert(200n, 300n);
        t.insert(100n, 500n);
        expect(t.size).toBe(1);
        expect(t.extent).toEqual({ start: 100n, end: 500n });
    });
});

describe('TimelineIndex — clear + toString', () => {
    it('clear empties the index', () => {
        const t = new TimelineIndex();
        t.insert(100n, 200n);
        t.insert(300n, 400n);
        expect(t.size).toBe(2);
        t.clear();
        expect(t.size).toBe(0);
        expect(t.extent).toBeNull();
    });

    it('toString formats ranges in order', () => {
        const t = new TimelineIndex();
        t.insert(500n, 600n);
        t.insert(100n, 200n);
        expect(t.toString()).toBe('[100-200), [500-600)');
    });
});

describe('TimelineIndex — BigInt boundaries', () => {
    it('handles values above Number.MAX_SAFE_INTEGER', () => {
        const t = new TimelineIndex();
        const start = 2n ** 53n;
        const end = 2n ** 53n + 1000n;
        t.insert(start, end);
        expect(t.overlaps(start, end)).toBe(true);
        expect(t.overlaps(start + 500n, start + 500n + 100n)).toBe(true);
    });

    it('handles values near uint64 max', () => {
        const t = new TimelineIndex();
        const max = 2n ** 62n;
        t.insert(max, max + 100n);
        expect(t.extent).toEqual({ start: max, end: max + 100n });
    });

    it('zero is a valid boundary', () => {
        const t = new TimelineIndex();
        t.insert(0n, 100n);
        expect(t.overlaps(0n, 50n)).toBe(true);
        expect(t.overlaps(100n, 200n)).toBe(false);
    });
});
