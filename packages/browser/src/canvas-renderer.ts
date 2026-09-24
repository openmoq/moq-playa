/**
 * CanvasRenderer — draws decoded VideoFrames to a Canvas2D surface.
 *
 * Implements VideoRendererLike for use with CommandDispatcher.
 * Maintains a frame queue and provides a renderTick() method
 * for timing control.
 *
 * **Critical invariant**: Every VideoFrame that enters enqueue() MUST be
 * closed — either by render+close, late drop+close, flush, or destroy.
 * VideoFrame holds GPU memory outside JavaScript GC (~200MB/sec for 1080p25).
 *
 * Uses requestAnimationFrame when the page is visible, and falls back to
 * setInterval (~16ms) when hidden. This ensures frames are still processed
 * even when the tab is backgrounded.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 * @module
 */

import type { VideoRendererLike } from '@moqt/player';
import type { ClockSource } from '@moqt/playback';
import { validateStallThresholdMs } from './mse-adapter.js';

/** A queued frame awaiting presentation. */
interface QueuedFrame {
  readonly frame: VideoFrame;
  readonly renderTimeUs: number;
}

/** Default stall threshold: 500ms without rendering a frame. */
const DEFAULT_STALL_THRESHOLD_MS = 500;

/** Maximum acceptable lateness before a frame is dropped (500ms). */
const LATE_THRESHOLD_US = 500_000;

/** Fallback interval when page is hidden (~60fps). */
const FALLBACK_INTERVAL_MS = 16;

/**
 * Canvas2D video renderer behind VideoRendererLike.
 *
 * Usage:
 * 1. Construct with a canvas element
 * 2. CommandDispatcher wires videoDecoder.onFrame → enqueue()
 * 3. Call start() to begin automatic rendering, or drive renderTick() manually
 * 4. Late frames are automatically dropped (with close())
 * 5. First frame and stall detection fire lifecycle callbacks
 */
export class CanvasRenderer implements VideoRendererLike {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly queue: QueuedFrame[] = [];
  private readonly stallThresholdMs: number;
  private readonly clock: ClockSource;
  private firstFrameRendered = false;
  private lastRenderTimeMs = 0;
  /**
   * The in-flight stall episode, if any.
   *
   * `startedMs` is when rendering actually stopped, so a completion reports the
   * whole outage rather than the detection latency. Survives a flush, because
   * the player's own stall recovery resets the pipeline and flushes this
   * renderer: dropping the episode there would make automatic recovery
   * permanently unable to report a completed stall.
   */
  private stallEpisode: { startedMs: number; detected: boolean } | null = null;
  private renderDiagCount = 0;
  private lastActualRenderUs = 0;
  private renderDiagEnabled = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('debug') === 'render';
  private rafId: number | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private destroyed = false;

  // ─── Callbacks ──────────────────────────────────────────────────

  onFirstFrame: (() => void) | null = null;
  /**
   * Presentation report. `scheduledRenderUs` is the EXACT time this frame was
   * queued to present at, which is the authority for presentation-schedule
   * drift — it already includes the playout cushion applied to this frame.
   */
  onFrameRendered: ((captureTimestampUs: bigint, actualRenderUs: number, scheduledRenderUs?: number) => void) | null = null;
  onStall: ((durationMs: number) => void) | null = null;

  /**
   * A detected stall ended with a rendered frame. Carries the full outage.
   */
  onStallRecovered: ((durationMs: number) => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    options?: { stallThresholdMs?: number; clock?: ClockSource },
  ) {
    // Validate before acquiring any browser state, so an invalid option
    // cannot leave a half-constructed renderer holding a 2d context.
    this.stallThresholdMs = options?.stallThresholdMs === undefined
      ? DEFAULT_STALL_THRESHOLD_MS
      : validateStallThresholdMs(options.stallThresholdMs);
    this.ctx = canvas.getContext('2d')!;
    this.clock = options?.clock ?? { now: () => performance.now() * 1000 };
  }

  /**
   * Enqueue a decoded frame for presentation.
   *
   * Frames are held until renderTick() presents them at the right time.
   * The frame WILL be closed by this renderer — callers must NOT close it.
   */
  enqueue(frame: unknown, renderTimeUs: number): void {
    if (this.destroyed) {
      (frame as VideoFrame).close();
      return;
    }
    this.queue.push({ frame: frame as VideoFrame, renderTimeUs });
  }

  /**
   * Render tick — call from the render loop or manually.
   *
   * 1. Drop late frames (> LATE_THRESHOLD_US behind) — MUST close()
   * 2. Draw frames whose renderTime has passed
   * 3. Stall detection: no frames rendered for > threshold
   * 4. First frame tracking
   *
   * @param nowUs Current time in microseconds
   */
  renderTick(nowUs: number): void {
    if (this.destroyed) return;

    let rendered = false;

    // Process queue: drop late (keeping most recent), render on-time.
    // Late frames are only dropped when newer frames exist behind them.
    // The last late frame is always rendered rather than dropped — showing
    // the latest available frame is better than a black screen. This also
    // handles throttled ticks on hidden tabs where setInterval fires at ~1/sec.
    while (this.queue.length > 0) {
      const entry = this.queue[0]!;

      if (entry.renderTimeUs < nowUs - LATE_THRESHOLD_US && this.queue.length > 1) {
        // Late frame with newer frames behind it — drop (MUST close GPU memory)
        this.queue.shift();
        entry.frame.close();
        continue;
      }

      if (entry.renderTimeUs <= nowUs) {
        // On time — render
        this.queue.shift();

        // Capture timestamp BEFORE close — VideoFrame.timestamp is the
        // CaptureTimestamp set during toVideoChunkInit() (LOC §2.3.1.1).
        // Used for drift detection in the feedback path.
        const captureTimestampUs = BigInt(entry.frame.timestamp);

        this.ctx.drawImage(entry.frame, 0, 0, this.ctx.canvas.width, this.ctx.canvas.height);

        // frame.close() is NON-NEGOTIABLE — GPU memory outside GC
        entry.frame.close();

        rendered = true;
        // A genuinely rendered frame is the only thing that completes an
        // episode. Capture it here but publish only after every piece of frame
        // state below is committed: emit() propagates listener exceptions, and
        // a throwing listener must not leave this frame half-recorded or stop
        // the next one being scheduled.
        let recoveredMs: number | null = null;
        if (this.stallEpisode !== null) {
          const episode = this.stallEpisode;
          this.stallEpisode = null;
          if (episode.detected) recoveredMs = performance.now() - episode.startedMs;
        }

        // First frame lifecycle
        if (!this.firstFrameRendered) {
          this.firstFrameRendered = true;
          this.onFirstFrame?.();
        }

        this.onFrameRendered?.(captureTimestampUs, nowUs, entry.renderTimeUs);
        // Render-timing diagnostic: logs every 30th frame's scheduling
        // jitter (scheduled vs actual render time, inter-frame delta).
        // Enable via ?debug=render in the URL.
        this.renderDiagCount++;
        if (this.renderDiagEnabled && this.renderDiagCount % 30 === 0) {
          const deltaFromLastUs = this.lastActualRenderUs > 0
            ? nowUs - this.lastActualRenderUs : 0;
          const scheduleJitterUs = nowUs - entry.renderTimeUs;
          console.log('[render] frame=%d scheduled=%d actual=%d jitter=%dµs delta=%dµs',
            this.renderDiagCount,
            Math.round(entry.renderTimeUs),
            Math.round(nowUs),
            Math.round(scheduleJitterUs),
            Math.round(deltaFromLastUs));
        }
        this.lastActualRenderUs = nowUs;
        this.lastRenderTimeMs = performance.now();
        // All frame state committed — safe to publish.
        if (recoveredMs !== null) this.onStallRecovered?.(recoveredMs);
      } else {
        // Future frame — stop processing
        break;
      }
    }

    // Stall detection: once per episode. Suppressed when the page is hidden —
    // throttled ticks always exceed the threshold.
    if (!rendered && this.firstFrameRendered
        && this.lastRenderTimeMs > 0 && !document.hidden) {
      this.stallEpisode ??= { startedMs: this.lastRenderTimeMs, detected: false };
      if (!this.stallEpisode.detected) {
        const stallMs = performance.now() - this.stallEpisode.startedMs;
        if (stallMs > this.stallThresholdMs) {
          this.stallEpisode.detected = true;
          this.onStall?.(stallMs);
        }
      }
    }
  }

  /**
   * Start automatic rendering.
   *
   * Uses requestAnimationFrame when the page is visible, falls back to
   * setInterval when hidden (rAF is suspended for background tabs).
   */
  start(): void {
    if (this.destroyed || this.running) return;
    this.running = true;
    this.scheduleLoop();

    // Switch between rAF and setInterval when visibility changes
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Stop automatic rendering. */
  stop(): void {
    this.running = false;
    this.cancelLoop();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Discard all queued frames. MUST close() all held frames. */
  flush(): void {
    for (const entry of this.queue) {
      entry.frame.close();
    }
    this.queue.length = 0;
    // Suppress *new* detection until the next frame renders, so a pause does
    // not read as a stall. An already-detected episode is deliberately kept:
    // the player's stall recovery flushes this renderer, and discarding it here
    // would mean an automatically-recovered stall could never be completed.
    // Callers that genuinely supersede playback call cancelStallEpisode().
    this.lastRenderTimeMs = 0;
    if (this.stallEpisode !== null && !this.stallEpisode.detected) {
      this.stallEpisode = null;
    }
  }

  /**
   * Abandon any in-flight stall episode without completing it.
   *
   * For pause, user seek, and destroy: playback is superseded rather than
   * recovered, so no completion is published and nothing is contributed to
   * aggregate stall time.
   */
  cancelStallEpisode(): void {
    this.stallEpisode = null;
  }

  /** Release resources. MUST close() all held frames. */
  destroy(): void {
    this.cancelStallEpisode();
    this.destroyed = true;
    this.stop();
    this.flush();
    this.onFirstFrame = null;
    this.onFrameRendered = null;
    this.onStall = null;
    this.onStallRecovered = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private readonly onVisibilityChange = (): void => {
    if (!this.running) return;
    this.cancelLoop();
    this.scheduleLoop();
  };

  private scheduleLoop(): void {
    if (document.hidden) {
      // Page is hidden — rAF won't fire. Use setInterval fallback.
      this.intervalId = setInterval(() => {
        // No guard needed: setInterval re-fires regardless of a thrown
        // callback, so a listener exception cannot end this loop. Catching it
        // would only diverge from the rAF path, which propagates by contract.
        this.renderTick(this.clock.now());
      }, FALLBACK_INTERVAL_MS);
    } else {
      // Page is visible — use rAF for smooth rendering.
      const loop = (): void => {
        if (!this.running || this.destroyed) return;
        try {
          this.renderTick(this.clock.now());
        } finally {
          // renderTick publishes to application listeners, and the emitter
          // propagates their exceptions by design. Rescheduling in `finally`
          // keeps one bad listener from silently ending playback — but only
          // while still running, so stop()/destroy() from inside a listener
          // still terminates the loop.
          if (this.running && !this.destroyed) {
            this.rafId = requestAnimationFrame(loop);
          }
        }
      };
      this.rafId = requestAnimationFrame(loop);
    }
  }

  private cancelLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
