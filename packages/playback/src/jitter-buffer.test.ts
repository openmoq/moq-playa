/**
 * Tests for the min-heap jitter buffer.
 *
 * The jitter buffer merges objects from multiple subgroups (arriving on
 * separate QUIC streams) into strict (groupId, objectId) decode order.
 *
 * Uses a binary min-heap (NOT Array.sort()) for O(log N) insert/extract.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (single track, groupId then objectId order)
 * @see draft-ietf-moq-loc-01 §4.3 (temporal layers, cross-subgroup ordering)
 */

import { describe, it, expect } from 'vitest';
import { varint } from '@moqt/transport';
import type { MoqtObjectData, MoqtObjectGap } from '@moqt/transport';
import { JitterBuffer } from './jitter-buffer.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeData(
    groupId: number,
    objectId: number,
    opts?: { subgroupId?: number; payload?: Uint8Array; priority?: number },
): MoqtObjectData {
    return {
        kind: 'data',
        trackAlias: varint(0),
        groupId: varint(groupId),
        subgroupId: varint(opts?.subgroupId ?? 0),
        objectId: varint(objectId),
        publisherPriority: opts?.priority,
        extensions: undefined,
        payload: opts?.payload ?? new Uint8Array([0xCA, 0xFE]),
    };
}

function makeGap(groupId: number, objectId: number, status: number): MoqtObjectGap {
    return {
        kind: 'gap',
        trackAlias: varint(0),
        groupId: varint(groupId),
        subgroupId: varint(0),
        objectId: varint(objectId),
        status: varint(status),
    };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('JitterBuffer', () => {
    it('empty buffer — peek and extract return undefined', () => {
        const buf = new JitterBuffer(100);
        expect(buf.peek()).toBeUndefined();
        expect(buf.extract()).toBeUndefined();
        expect(buf.size).toBe(0);
    });

    it('single insert/extract round-trip', () => {
        const buf = new JitterBuffer(100);
        const obj = makeData(0, 0);
        expect(buf.insert(obj)).toBe(true);
        expect(buf.size).toBe(1);
        expect(buf.peek()).toBe(obj);
        expect(buf.extract()).toBe(obj);
        expect(buf.size).toBe(0);
    });

    it('out-of-order insertion → sorted extraction within a group (§4.2)', () => {
        const buf = new JitterBuffer(100);
        const o2 = makeData(0, 2);
        const o0 = makeData(0, 0);
        const o1 = makeData(0, 1);

        buf.insert(o2);
        buf.insert(o0);
        buf.insert(o1);

        expect(buf.extract()!.objectId).toBe(varint(0));
        expect(buf.extract()!.objectId).toBe(varint(1));
        expect(buf.extract()!.objectId).toBe(varint(2));
    });

    it('cross-group ordering — group 0 before group 1 (§4.2)', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(1, 0));
        buf.insert(makeData(0, 0));

        expect(buf.extract()!.groupId).toBe(varint(0));
        expect(buf.extract()!.groupId).toBe(varint(1));
    });

    it('cross-subgroup interleaving — same group, different subgroups (§4.3)', () => {
        const buf = new JitterBuffer(100);
        // Temporal layers: subgroup 0 has keyframe (o:0), subgroup 1 has delta (o:1)
        buf.insert(makeData(0, 1, { subgroupId: 1 }));
        buf.insert(makeData(0, 0, { subgroupId: 0 }));

        const first = buf.extract()!;
        const second = buf.extract()!;
        expect(first.objectId).toBe(varint(0));
        expect(second.objectId).toBe(varint(1));
    });

    it('hasContiguous — true when next expected is buffered', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(0, 0));
        buf.insert(makeData(0, 1));

        expect(buf.hasContiguous(0n, 0n)).toBe(true);
        expect(buf.hasContiguous(0n, 3n)).toBe(false);
    });

    it('buffer full — insert returns false when maxDepth exceeded', () => {
        const buf = new JitterBuffer(2);
        expect(buf.insert(makeData(0, 0))).toBe(true);
        expect(buf.insert(makeData(0, 1))).toBe(true);
        expect(buf.insert(makeData(0, 2))).toBe(false);
        expect(buf.size).toBe(2);
    });

    it('discardBefore — removes objects from old groups', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(5, 0));
        buf.insert(makeData(5, 1));
        buf.insert(makeData(6, 0));
        buf.insert(makeData(7, 0));

        const removed = buf.discardBefore(6n);
        expect(removed).toBe(2); // group 5 objects
        expect(buf.size).toBe(2);
        expect(buf.peek()!.groupId).toBe(varint(6));
    });

    it('drainGroup — returns all objects for a group in order', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(5, 2));
        buf.insert(makeData(5, 0));
        buf.insert(makeData(5, 1));
        buf.insert(makeData(6, 0));

        const drained = buf.drainGroup(5n);
        expect(drained).toHaveLength(3);
        expect(drained[0]!.objectId).toBe(varint(0));
        expect(drained[1]!.objectId).toBe(varint(1));
        expect(drained[2]!.objectId).toBe(varint(2));

        // Group 6 still in buffer
        expect(buf.size).toBe(1);
        expect(buf.peek()!.groupId).toBe(varint(6));
    });

    it('gap objects sort correctly by (groupId, objectId) (§10.2.1.1)', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(0, 0));
        buf.insert(makeGap(0, 2, 0x3)); // END_OF_GROUP
        buf.insert(makeData(0, 1));

        const first = buf.extract()!;
        const second = buf.extract()!;
        const third = buf.extract()!;
        expect(first.objectId).toBe(varint(0));
        expect(second.objectId).toBe(varint(1));
        expect(third.objectId).toBe(varint(2));
        expect(third.kind).toBe('gap');
    });

    // ─── Priority-aware eviction (§7) ───────────────────────────────

    it('evictLowestImportance() on empty buffer → undefined', () => {
        const buf = new JitterBuffer(100);
        expect(buf.evictLowestImportance()).toBeUndefined();
    });

    it('evictLowestImportance() returns object with highest publisherPriority (§7)', () => {
        const buf = new JitterBuffer(100);
        // Priority: 0 = max importance, 255 = min importance
        buf.insert(makeData(0, 0, { priority: 10 }));  // important
        buf.insert(makeData(0, 1, { priority: 200 })); // least important
        buf.insert(makeData(0, 2, { priority: 50 }));  // medium

        const evicted = buf.evictLowestImportance();
        expect(evicted).toBeDefined();
        expect(evicted!.objectId).toBe(varint(1));
        expect(evicted!.publisherPriority).toBe(200);
        expect(buf.size).toBe(2);
    });

    it('evictLowestImportance() tiebreaker — same priority → evicts oldest group', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(5, 0, { priority: 200 })); // oldest, priority 200
        buf.insert(makeData(8, 0, { priority: 200 })); // newest, priority 200

        const evicted = buf.evictLowestImportance();
        expect(evicted).toBeDefined();
        expect(evicted!.groupId).toBe(varint(5)); // oldest group evicted
    });

    it('evictLowestImportance() skips gap objects (no priority)', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeGap(0, 0, 0x3));                // gap — not evictable
        buf.insert(makeData(0, 1, { priority: 100 })); // data — evictable

        const evicted = buf.evictLowestImportance();
        expect(evicted).toBeDefined();
        expect(evicted!.kind).toBe('data');
        expect(evicted!.objectId).toBe(varint(1));
        // Gap object still in buffer
        expect(buf.size).toBe(1);
        expect(buf.peek()!.kind).toBe('gap');
    });

    it('evictLowestImportance() maintains heap property after eviction', () => {
        const buf = new JitterBuffer(100);
        buf.insert(makeData(0, 0, { priority: 10 }));
        buf.insert(makeData(0, 1, { priority: 255 })); // will be evicted
        buf.insert(makeData(0, 2, { priority: 10 }));
        buf.insert(makeData(1, 0, { priority: 10 }));

        buf.evictLowestImportance();
        expect(buf.size).toBe(3);

        // Extraction should still be in sorted order
        expect(buf.extract()!.objectId).toBe(varint(0));
        expect(buf.extract()!.objectId).toBe(varint(2));
        const last = buf.extract()!;
        expect(last.groupId).toBe(varint(1));
        expect(last.objectId).toBe(varint(0));
    });

    it('property test — 100 random inserts extract in sorted order', () => {
        const buf = new JitterBuffer(200);
        const objs: MoqtObjectData[] = [];

        // Generate 100 random objects across 10 groups
        for (let i = 0; i < 100; i++) {
            const g = Math.floor(Math.random() * 10);
            const o = Math.floor(Math.random() * 20);
            objs.push(makeData(g, o));
        }

        for (const obj of objs) {
            buf.insert(obj);
        }

        let prevGroup = -1n;
        let prevObj = -1n;
        while (buf.size > 0) {
            const extracted = buf.extract()!;
            const g = extracted.groupId as bigint;
            const o = extracted.objectId as bigint;

            if (g === prevGroup) {
                expect(o >= prevObj).toBe(true);
            } else {
                expect(g > prevGroup).toBe(true);
            }
            prevGroup = g;
            prevObj = o;
        }
    });
});
