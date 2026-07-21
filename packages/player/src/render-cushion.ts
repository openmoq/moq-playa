/**
 * RenderCushionSmoother — the stable LOC render playout target.
 *
 * Field data showed the raw adaptive gap timeout swinging 50–2000 ms on a
 * mostly-clean network; applying that value stepwise to render scheduling
 * froze video for the length of each
 * collapse: frames already queued under the old larger cushion sat at the
 * queue head and blocked newer, earlier-scheduled frames. The smoother
 * decouples RENDER scheduling from the gap FUSE:
 *
 *   - the gap detector keeps consuming the raw adaptive timeout (50–2000 ms,
 *     unchanged skip policy);
 *   - render/audio scheduling consume this smoothed, clamped value.
 *
 * Slew rates are dt-based (cadence-independent) and small enough that the
 * cushion moves less than one frame interval between adjacent frames —
 * render times stay monotonic across any raw-input step, so no queue flush
 * or re-anchor is ever needed.
 *
 * @module
 */

import type { ClockSource } from '@moqt/playback';

/**
 * Render-range cap, independent of the gap fuse's 2000 ms max. The observed
 * 2000 ms excursions were estimator overreaction (the CMAF control absorbed
 * the same network with ≤0.2 s of buffer dip); 750 ms still buys real jitter
 * headroom while bounding the total cushion travel a collapse can unwind.
 */
export const RENDER_CUSHION_MAX_US = 750_000;

/**
 * Upward slew (µs of cushion per second of wall clock). The playout buffer
 * can only fill as fast as media arrives, so faster adoption buys nothing;
 * 100 ms/s reaches the cap from the floor in ~5.5 s.
 */
export const RENDER_CUSHION_RISE_US_PER_SEC = 100_000;

/**
 * Downward slew. Collapse is what froze video — decaying slowly costs only
 * latency (which live catch-up already manages). 25 ms/s ≈ 0.8 ms between
 * 30 fps frames: far below the 33 ms capture spacing, hence monotonic
 * render times by construction.
 */
export const RENDER_CUSHION_FALL_US_PER_SEC = 25_000;

export interface RenderCushionOptions {
  /** Static floor (µs): 200 ms, or 50 ms on sub-5 ms-RTT paths — unchanged from the unified policy. */
  floorUs: number;
  /** Render-range cap (µs). Default {@link RENDER_CUSHION_MAX_US}. */
  maxUs?: number;
  /** Upward slew (µs/s). Default {@link RENDER_CUSHION_RISE_US_PER_SEC}. */
  riseUsPerSec?: number;
  /** Downward slew (µs/s). Default {@link RENDER_CUSHION_FALL_US_PER_SEC}. */
  fallUsPerSec?: number;
}

/**
 * Slew-rate-limited, clamped smoother from the raw adaptive gap timeout to
 * the playout cushion used by video render-time recompute and audio
 * scheduling (audio adoption remains anchor/underrun-only downstream).
 */
export class RenderCushionSmoother {
  private readonly floorUs: number;
  private readonly maxUs: number;
  private readonly riseUsPerSec: number;
  private readonly fallUsPerSec: number;
  private readonly clock: ClockSource;

  private _currentUs: number | null = null;
  private lastUpdateUs = 0;

  constructor(options: RenderCushionOptions, clock: ClockSource) {
    this.floorUs = options.floorUs;
    this.maxUs = options.maxUs ?? RENDER_CUSHION_MAX_US;
    this.riseUsPerSec = options.riseUsPerSec ?? RENDER_CUSHION_RISE_US_PER_SEC;
    this.fallUsPerSec = options.fallUsPerSec ?? RENDER_CUSHION_FALL_US_PER_SEC;
    this.clock = clock;
  }

  /** The smoothed cushion (µs); floor before the first update. */
  get currentUs(): number {
    return this._currentUs ?? this.floorUs;
  }

  /**
   * Advance toward `clamp(max(rawAdaptiveUs, floor), floor, max)` at the
   * slew limits. The FIRST call snaps to the clamped target — no frames are
   * queued before the first decode output, so no discontinuity is possible
   * and slewing from an arbitrary initial value would be fiction.
   */
  update(rawAdaptiveUs: number | undefined): number {
    const nowUs = this.clock.now();
    const targetUs = Math.min(Math.max(rawAdaptiveUs ?? 0, this.floorUs), this.maxUs);

    if (this._currentUs === null) {
      this._currentUs = targetUs;
      this.lastUpdateUs = nowUs;
      return this._currentUs;
    }

    const dtSec = Math.max(0, (nowUs - this.lastUpdateUs) / 1_000_000);
    this.lastUpdateUs = nowUs;

    if (targetUs > this._currentUs) {
      this._currentUs = Math.min(targetUs, this._currentUs + this.riseUsPerSec * dtSec);
    } else if (targetUs < this._currentUs) {
      this._currentUs = Math.max(targetUs, this._currentUs - this.fallUsPerSec * dtSec);
    }
    return this._currentUs;
  }
}
