import type { LocHeaders } from '@openmoq/loc';

/** Timestamp spacing of consecutive LOC video Group starts, not receipt completion. */
export class LocGroupCadence {
  private highGroup: bigint | null = null;
  private anchor: { timestamp: bigint; scale: bigint; units: bigint; mediaTime: boolean } | null = null;
  private measuredUs: number | null = null;

  get durationUs(): number | null { return this.measuredUs; }

  /** The owner admits only selected-source data Object 0, excluding backfill. */
  observe(group: bigint, headers: LocHeaders): void {
    if (this.highGroup !== null && group <= this.highGroup) return;
    const previousGroup = this.highGroup, previous = this.anchor;
    this.highGroup = group;
    this.anchor = null;
    this.measuredUs = null;

    // LOC-01 §2.3.1.1 uses Unix microseconds. LOC-04 §2.3.1.1–2 uses
    // explicit-scale media time; captureTimestamp is already normalized.
    const mediaTime = headers.timescale !== undefined;
    if (mediaTime ? headers.timescale! <= 0n || headers.timestampIsWallClock === true
      : headers.timestampIsWallClock === false) return;
    const timestamp = mediaTime ? headers.timestamp ?? headers.captureTimestamp
      : headers.captureTimestamp ?? headers.timestamp;
    if (timestamp === undefined || timestamp < 0n) return;
    const scale = mediaTime && headers.timestamp !== undefined ? headers.timescale! : 1_000_000n;
    // Keep the declared scale in the identity even when only the normalized
    // compatibility field is present, so changing that declaration breaks a pair.
    const declaredScale = headers.timescale ?? 1_000_000n;
    const current = { timestamp, units: scale, scale: declaredScale, mediaTime };
    this.anchor = current;
    if (!previous || previousGroup === null || group !== previousGroup + 1n
        || previous.scale !== current.scale || previous.units !== current.units
        || previous.mediaTime !== current.mediaTime) return;
    const elapsed = (current.timestamp - previous.timestamp) * 1_000_000n / current.units;
    if (elapsed <= 0n || elapsed > BigInt(Number.MAX_SAFE_INTEGER)) return;
    this.measuredUs = Number(elapsed);
  }

  reset(): void { this.highGroup = null; this.anchor = null; this.measuredUs = null; }
}
