/**
 * StartupBuffer — holds frames before first drain to warm the jitter estimator.
 *
 * Prevents initial stutter by collecting N frames (determined by network class)
 * before allowing the pipeline to start draining. During the hold, the adaptive
 * tolerance controller calibrates from real arrival timing — so it's ready
 * when playback begins.
 *
 * Network classification uses the QUIC handshake RTT (available before any media)
 * to set initial parameters:
 * - LAN (<1ms): 2 frames / 80ms max — near-zero startup delay
 * - Near-LAN (1-5ms): 3 frames / 120ms
 * - Metro WAN (5-50ms): 8 frames / 300ms
 * - Long-haul WAN (>50ms): 12 frames / 500ms
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 * @module
 */

// ─── Network classification ─────────────────────────────────────────

export interface StartupParams {
  /** Minimum frames to collect before allowing drain. */
  readonly minFrames: number;
  /** Hard timeout — drain regardless of frame count. */
  readonly maxWaitMs: number;
}

/**
 * Classify network conditions from QUIC handshake RTT.
 *
 * @param handshakeRttMs Round-trip time from the QUIC/WebTransport handshake
 */
export function classifyNetwork(handshakeRttMs: number): StartupParams {
  if (handshakeRttMs < 1) {
    return { minFrames: 2, maxWaitMs: 80 };
  } else if (handshakeRttMs < 5) {
    return { minFrames: 3, maxWaitMs: 120 };
  } else if (handshakeRttMs < 50) {
    return { minFrames: 8, maxWaitMs: 300 };
  } else {
    return { minFrames: 12, maxWaitMs: 500 };
  }
}

// ─── StartupBuffer ──────────────────────────────────────────────────

/**
 * Gates pipeline draining until enough frames have arrived for smooth startup.
 *
 * Usage:
 * ```ts
 * // In pipeline.pushObject():
 * startupBuffer.recordFrame(clock.now() / 1000);
 *
 * // In pipeline.tick():
 * if (!startupBuffer.shouldDrain) return; // hold frames
 * // ... normal drain logic
 * ```
 */
export class StartupBuffer {
  private readonly minFrames: number;
  private readonly maxWaitMs: number;

  private _frameCount = 0;
  private _firstFrameMs = 0;
  private _lastFrameMs = 0;
  private _draining = false;

  constructor(params: StartupParams) {
    this.minFrames = params.minFrames;
    this.maxWaitMs = params.maxWaitMs;
  }

  /**
   * Record a frame arrival. Call from pushObject().
   * @param nowMs Current time in milliseconds
   */
  recordFrame(nowMs: number): void {
    this._frameCount++;
    if (this._frameCount === 1) {
      this._firstFrameMs = nowMs;
    }
    this._lastFrameMs = nowMs;

    // Check transition
    if (!this._draining) {
      const elapsed = this._lastFrameMs - this._firstFrameMs;
      if (this._frameCount >= this.minFrames || elapsed >= this.maxWaitMs) {
        this._draining = true;
      }
    }
  }

  /** Whether the pipeline should start draining (buffer phase complete). */
  get shouldDrain(): boolean {
    return this._draining;
  }

  /** Number of frames recorded. */
  get frameCount(): number {
    return this._frameCount;
  }

  /** Time elapsed since first frame in milliseconds. */
  get elapsedMs(): number {
    if (this._frameCount === 0) return 0;
    return this._lastFrameMs - this._firstFrameMs;
  }

  /** Accelerated EMA alpha for warmup (4x standard 1/16). */
  get warmupEmaAlpha(): number {
    return 0.25;
  }

  /** Reset to buffering state (e.g., after seek or pause→resume). */
  reset(): void {
    this._frameCount = 0;
    this._firstFrameMs = 0;
    this._lastFrameMs = 0;
    this._draining = false;
  }
}
