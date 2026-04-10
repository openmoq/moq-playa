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
  private stallReported = false;
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
  onFrameRendered: ((captureTimestampUs: bigint, actualRenderUs: number) => void) | null = null;
  onStall: ((durationMs: number) => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    options?: { stallThresholdMs?: number; clock?: ClockSource },
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.stallThresholdMs = options?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
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
        this.stallReported = false;

        // First frame lifecycle
        if (!this.firstFrameRendered) {
          this.firstFrameRendered = true;
          this.onFirstFrame?.();
        }

        this.onFrameRendered?.(captureTimestampUs, nowUs);
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
      } else {
        // Future frame — stop processing
        break;
      }
    }

    // Stall detection: fires once per stall event (reset when a frame renders).
    // Suppressed when page is hidden — throttled ticks always exceed threshold.
    if (!rendered && this.firstFrameRendered && !this.stallReported
        && this.lastRenderTimeMs > 0 && !document.hidden) {
      const stallMs = performance.now() - this.lastRenderTimeMs;
      if (stallMs > this.stallThresholdMs) {
        this.stallReported = true;
        this.onStall?.(stallMs);
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
    // Reset stall tracking — after flush, stall detection is suppressed until
    // the next frame renders. This prevents false stalls during pause.
    this.lastRenderTimeMs = 0;
    this.stallReported = false;
  }

  /** Release resources. MUST close() all held frames. */
  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.flush();
    this.onFirstFrame = null;
    this.onFrameRendered = null;
    this.onStall = null;
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
        this.renderTick(this.clock.now());
      }, FALLBACK_INTERVAL_MS);
    } else {
      // Page is visible — use rAF for smooth rendering.
      const loop = (): void => {
        if (!this.running || this.destroyed) return;
        this.renderTick(this.clock.now());
        this.rafId = requestAnimationFrame(loop);
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
