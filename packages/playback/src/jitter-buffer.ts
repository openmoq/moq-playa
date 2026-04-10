/**
 * Min-heap jitter buffer ordered by (groupId, objectId).
 *
 * Merges objects arriving from multiple subgroups (on separate QUIC streams)
 * into strict decode order. Uses an array-based binary min-heap for
 * O(log N) insert/extract — NOT Array.sort().
 *
 * @see draft-ietf-moq-loc-01 §4.2 (single track: groupId then objectId order)
 * @see draft-ietf-moq-loc-01 §4.3 (temporal layers: cross-subgroup ordering)
 * @module
 */

import type { MoqtObject, MoqtObjectData } from '@moqt/transport';

/**
 * Compare two objects by (groupId, objectId) ascending.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compare(a: MoqtObject, b: MoqtObject): number {
    if (a.groupId < b.groupId) return -1;
    if (a.groupId > b.groupId) return 1;
    if (a.objectId < b.objectId) return -1;
    if (a.objectId > b.objectId) return 1;
    return 0;
}

/**
 * Min-heap jitter buffer for MoqtObject ordering.
 *
 * @see draft-ietf-moq-loc-01 §4.2, §4.3
 */
export class JitterBuffer {
    private readonly heap: MoqtObject[] = [];
    private readonly maxDepth: number;

    constructor(maxDepth: number) {
        this.maxDepth = maxDepth;
    }

    /** Number of objects currently buffered. */
    get size(): number {
        return this.heap.length;
    }

    /**
     * Insert an object into the buffer.
     * @returns true if accepted, false if buffer is full.
     */
    insert(obj: MoqtObject): boolean {
        if (this.heap.length >= this.maxDepth) return false;
        this.heap.push(obj);
        this.bubbleUp(this.heap.length - 1);
        return true;
    }

    /**
     * Peek at the minimum object without removing it.
     */
    peek(): MoqtObject | undefined {
        return this.heap[0];
    }

    /**
     * Remove and return the minimum object.
     */
    extract(): MoqtObject | undefined {
        if (this.heap.length === 0) return undefined;
        const min = this.heap[0]!;
        const last = this.heap.pop()!;
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.sinkDown(0);
        }
        return min;
    }

    /**
     * Check if the object at (groupId, objectId) is the minimum in the buffer.
     */
    hasContiguous(groupId: bigint, objectId: bigint): boolean {
        if (this.heap.length === 0) return false;
        const top = this.heap[0]!;
        return top.groupId === groupId && top.objectId === objectId;
    }

    /**
     * Remove and return all objects for a given group, in sorted order.
     */
    drainGroup(groupId: bigint): MoqtObject[] {
        const result: MoqtObject[] = [];
        const remaining: MoqtObject[] = [];

        // Extract all, separate target group from rest
        for (const obj of this.heap) {
            if (obj.groupId === groupId) {
                result.push(obj);
            } else {
                remaining.push(obj);
            }
        }

        // Sort the target group's objects by objectId
        result.sort(compare);

        // Rebuild heap from remaining
        this.heap.length = 0;
        for (const obj of remaining) {
            this.heap.push(obj);
        }
        this.rebuild();

        return result;
    }

    /**
     * Remove all objects with groupId less than the given threshold.
     * @returns Number of objects removed.
     */
    discardBefore(groupId: bigint): number {
        const remaining: MoqtObject[] = [];
        let removed = 0;

        for (const obj of this.heap) {
            if (obj.groupId < groupId) {
                removed++;
            } else {
                remaining.push(obj);
            }
        }

        this.heap.length = 0;
        for (const obj of remaining) {
            this.heap.push(obj);
        }
        this.rebuild();

        return removed;
    }

    /**
     * Evict the least-important object from the buffer.
     *
     * Finds the data object with the highest publisherPriority number
     * (= lowest importance per §7: "lower priority number indicates higher
     * priority"). Tiebreaker: oldest group (lowest groupId).
     *
     * Gap objects and objects with undefined priority are not evictable.
     *
     * @returns The evicted object, or undefined if no candidate exists.
     * @see draft-ietf-moq-transport-16 §7 (Priority-based dropping)
     */
    evictLowestImportance(): MoqtObjectData | undefined {
        if (this.heap.length === 0) return undefined;

        let worstIdx = -1;
        let worstPriority = -1;
        let worstGroupId = -1n;

        for (let i = 0; i < this.heap.length; i++) {
            const obj = this.heap[i]!;
            if (obj.kind !== 'data' || obj.publisherPriority === undefined) continue;

            const p = obj.publisherPriority;
            if (
                p > worstPriority ||
                (p === worstPriority && obj.groupId < worstGroupId)
            ) {
                worstIdx = i;
                worstPriority = p;
                worstGroupId = obj.groupId;
            }
        }

        if (worstIdx === -1) return undefined;

        const evicted = this.heap[worstIdx]! as MoqtObjectData;

        // Remove by swapping with last element and rebuilding
        const last = this.heap.pop()!;
        if (worstIdx < this.heap.length) {
            this.heap[worstIdx] = last;
            this.rebuild();
        }

        return evicted;
    }

    /**
     * Clear all buffered objects.
     */
    clear(): void {
        this.heap.length = 0;
    }

    // ─── Heap internals ─────────────────────────────────────────────

    private bubbleUp(index: number): void {
        while (index > 0) {
            const parentIdx = (index - 1) >> 1;
            if (compare(this.heap[index]!, this.heap[parentIdx]!) >= 0) break;
            this.swap(index, parentIdx);
            index = parentIdx;
        }
    }

    private sinkDown(index: number): void {
        const length = this.heap.length;
        while (true) {
            let smallest = index;
            const left = 2 * index + 1;
            const right = 2 * index + 2;

            if (left < length && compare(this.heap[left]!, this.heap[smallest]!) < 0) {
                smallest = left;
            }
            if (right < length && compare(this.heap[right]!, this.heap[smallest]!) < 0) {
                smallest = right;
            }
            if (smallest === index) break;
            this.swap(index, smallest);
            index = smallest;
        }
    }

    private swap(i: number, j: number): void {
        const tmp = this.heap[i]!;
        this.heap[i] = this.heap[j]!;
        this.heap[j] = tmp;
    }

    /** Rebuild the heap from an unordered array (O(n)). */
    private rebuild(): void {
        for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) {
            this.sinkDown(i);
        }
    }
}
