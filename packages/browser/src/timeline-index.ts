/**
 * TimelineIndex — the player's own record of what's been appended to a
 * SourceBuffer, maintained alongside MSE's `buffered` attribute.
 *
 * Rationale
 * ─────────
 * MSE's `sourceBuffer.buffered` is the browser's coarse-grained view —
 * it lags real appends by a full updateend cycle, it merges adjacent
 * ranges on its own schedule, and it is subject to quota eviction
 * without notice. Player-side logic that needs to decide "have I
 * already buffered this time range?" before the next append cannot
 * rely on `buffered`.
 *
 * This class is the adapter's private record: a sorted list of
 * non-overlapping half-open intervals `[start, end)` that the caller
 * has committed after a successful updateend. Insert merges adjacent
 * and overlapping ranges so the index stays minimal (typical live
 * playback ends up with one entry).
 *
 * Scope
 * ─────
 * Phase 1 — used only by MseMediaSource for overlap detection before
 * appendBuffer. Future phases extend it for eviction policy, target
 * latency accounting, and seek handling.
 *
 * @module
 */

/** A half-open time range `[start, end)`. Units are track timescale ticks. */
export interface TimeRange {
  readonly start: bigint;
  readonly end: bigint;
}

export class TimelineIndex {
  /** Sorted, non-overlapping, non-adjacent intervals. Invariant: start < end. */
  private readonly ranges: Array<{ start: bigint; end: bigint }> = [];

  /** Number of distinct ranges currently indexed. */
  get size(): number {
    return this.ranges.length;
  }

  /** Overall min → max span of buffered data, or null if empty. */
  get extent(): TimeRange | null {
    if (this.ranges.length === 0) return null;
    return {
      start: this.ranges[0]!.start,
      end: this.ranges[this.ranges.length - 1]!.end,
    };
  }

  /**
   * True if `[start, end)` intersects any existing range.
   *
   * Uses strict half-open semantics — touching ranges (end == start)
   * do NOT count as overlap. Degenerate empty ranges (start == end)
   * are never considered overlapping.
   */
  overlaps(start: bigint, end: bigint): boolean {
    if (start >= end) return false;
    for (const r of this.ranges) {
      // Two half-open intervals [a, b) and [c, d) overlap iff a < d && c < b.
      if (start < r.end && r.start < end) return true;
    }
    return false;
  }

  /**
   * Insert `[start, end)`. Merges with adjacent or overlapping ranges
   * so the index stays minimal. No-op if the range is empty.
   *
   * Linear in the current size of the index, which is typically 1-2.
   */
  insert(start: bigint, end: bigint): void {
    if (start >= end) return;

    // Walk from the left; swallow any range that overlaps or touches
    // the merging range; collect the result after the merge region.
    let mergedStart = start;
    let mergedEnd = end;
    const kept: Array<{ start: bigint; end: bigint }> = [];
    let placed = false;

    for (const r of this.ranges) {
      // r is fully left of the merging range and not adjacent — keep as-is.
      if (r.end < mergedStart) {
        kept.push(r);
        continue;
      }
      // r is fully right of the merging range and not adjacent — place
      // the merged range first (if not yet placed), then keep r.
      if (r.start > mergedEnd) {
        if (!placed) {
          kept.push({ start: mergedStart, end: mergedEnd });
          placed = true;
        }
        kept.push(r);
        continue;
      }
      // Otherwise, r overlaps or touches the merging range — swallow it.
      if (r.start < mergedStart) mergedStart = r.start;
      if (r.end > mergedEnd) mergedEnd = r.end;
    }
    if (!placed) kept.push({ start: mergedStart, end: mergedEnd });

    // Commit.
    this.ranges.length = 0;
    for (const k of kept) this.ranges.push(k);
  }

  /** Read-only snapshot of the indexed ranges, left → right. */
  getRanges(): readonly TimeRange[] {
    return this.ranges.map((r) => ({ start: r.start, end: r.end }));
  }

  /** Clear all ranges. Called on SourceBuffer reset / teardown. */
  clear(): void {
    this.ranges.length = 0;
  }

  /** Format for log output: "[0-180000), [360000-540000)" or "empty". */
  toString(): string {
    if (this.ranges.length === 0) return 'empty';
    return this.ranges.map((r) => `[${r.start}-${r.end})`).join(', ');
  }
}
