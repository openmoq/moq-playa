/**
 * Aggregate stats — polled QoE metrics for dashboards, A/B testing, alerting.
 *
 * Direct writes, not event listeners: StatsAccumulator methods called inline
 * at each milestone. Zero event subscription overhead.
 *
 * Wall-clock for TTFF: Date.now() for human dashboards / cross-session
 * comparison, not the player's ClockSource (microsecond monotonic for render).
 *
 * TTFF stores absolute, snapshot computes relative: Internal timestamps are
 * absolute Date.now() values. snapshot() converts to ms-relative-to-loadStart.
 *
 * @see draft-jennings-moq-metrics-02 (informational — metrics transport)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status — gap counting)
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 * @module
 */

// ─── TTFF Breakdown ──────────────────────────────────────────────────

/**
 * Time-to-first-frame breakdown — each milestone relative to loadCalledMs.
 *
 * All values are milliseconds relative to when load() was called (0).
 * null means the stage has not been reached yet.
 *
 * @see draft-jennings-moq-metrics-02 §4 (startup latency)
 */
export interface TTFFBreakdown {
  /** Reference point — always 0. */
  readonly loadCalledMs: 0;
  /** Time from load() to WebTransport connection established. */
  readonly transportConnectedMs: number | null;
  /** Time from load() to MOQT session setup complete (SERVER_SETUP received). */
  readonly setupCompleteMs: number | null;
  /** Time from load() to first catalog object received and parsed. */
  readonly catalogReceivedMs: number | null;
  /** Time from load() to first media object received on any track. */
  readonly firstObjectReceivedMs: number | null;
  /** Time from load() to first decoder configured with codec parameters. */
  readonly decoderConfiguredMs: number | null;
  /** Time from load() to first video frame rendered to the display surface. */
  readonly firstFrameRenderedMs: number | null;
}

// ─── PlayerStats ─────────────────────────────────────────────────────

/**
 * Aggregate player statistics — polled snapshot of QoE metrics.
 *
 * Returned by player.stats as a plain frozen object. Deferred fields
 * (currentLatencyMs, buffer depths, framesDropped) default to 0 until
 * their dependencies (Items 7, 8) are built.
 *
 * @see draft-jennings-moq-metrics-02 (informational)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 */
export interface PlayerStats {
  // ── Timing ──────────────────────────────────────────────────
  /** Total time from load() to first frame rendered (ms). null if not yet reached. */
  readonly timeToFirstFrameMs: number | null;
  /** Detailed TTFF breakdown. null before load() is called. */
  readonly ttffBreakdown: TTFFBreakdown | null;
  /** Current end-to-end latency (ms). 0 until Item 8. */
  readonly currentLatencyMs: number;
  /** Target latency from MSF catalog (ms). @see draft-ietf-moq-msf-00 §5.1.16 */
  readonly targetLatencyMs: number;
  /** Cumulative active playback time (ms). Excludes paused/stalled time. */
  readonly playbackDurationMs: number;
  /** Time since load() was called (ms). */
  readonly sessionAgeMs: number;

  // ── Quality ─────────────────────────────────────────────────
  /** Current track bitrate (bps). */
  readonly currentBitrate: number;
  /** Current video resolution. null before catalog received. */
  readonly currentResolution: { width: number; height: number } | null;
  /** Current video codec string. null before catalog received. */
  readonly currentVideoCodec: string | null;
  /** Current audio codec string. null before catalog received. */
  readonly currentAudioCodec: string | null;
  /** Number of quality (ABR) switches since session start. */
  readonly qualitySwitchCount: number;

  // ── Frames ──────────────────────────────────────────────────
  /** Number of frames decoded. */
  readonly framesDecoded: number;
  /** Number of frames dropped. 0 until Item 7. */
  readonly framesDropped: number;
  /** Number of frames rendered to the display surface. */
  readonly framesRendered: number;
  /** Ratio of dropped to (decoded + dropped). 0 when none dropped. */
  readonly dropRatio: number;

  // ── Buffer ──────────────────────────────────────────────────
  /** Video buffer depth (seconds). 0 until Item 7. */
  readonly videoBufferDepth: number;
  /** Audio buffer depth (seconds). 0 until Item 7. */
  readonly audioBufferDepth: number;
  /** Video decoder queue depth (frames). 0 until Item 7. */
  readonly videoDecoderQueueDepth: number;

  // ── Network (§10.2.1.1 Object Status) ──────────────────────
  /** Total media objects received. */
  readonly objectsReceived: number;
  /** Total bytes received (payload only). */
  readonly bytesReceived: number;
  /** Total gap objects received (Object Status signals). */
  readonly gapsReceived: number;

  // ── Errors ──────────────────────────────────────────────────
  /** Number of gap events detected by the pipeline. */
  readonly gapCount: number;
  /** Number of playback stalls. */
  readonly stallCount: number;
  /** Total stall duration (ms). */
  readonly totalStallDurationMs: number;
  /** Number of decode errors. */
  readonly decodeErrorCount: number;
  /** Number of recovery actions taken. */
  readonly recoveryActionCount: number;

  // ── Session ─────────────────────────────────────────────────
  /** Number of reconnections (GOAWAY migrations). 0 until reconnection logic. */
  readonly reconnectCount: number;

  // ── A/V sync (LOC observability) ────────────────────────────
  /**
   * Last measured A/V skew (ms): video frame CaptureTimestamp minus the
   * capture timestamp audibly playing at render time. Positive = video
   * ahead of audio. null until first measurement (CMAF, video-only, or
   * audio output without playhead support).
   */
  readonly avSkewMs: number | null;
  /** EWMA of measured A/V skew (ms, α=0.1). null until first measurement. */
  readonly avSkewEwmaMs: number | null;

  // ── LOC pipeline diagnostics (stutter observability) ────────
  /**
   * Cumulative counters and live timing gauges for the LOC pipeline's
   * disruptive events, so field stutter can be correlated with its cause:
   * gap-fuse skips vs backlog shedding vs decoder/keyframe waits, and A/V
   * skew steps with sync resets. Observability only — nothing acts on these.
   */
  readonly loc: LocDiagnostics;
}

/** Kinds of LOC pipeline diagnostic events counted in {@link LocDiagnostics}. */
export type LocDiagnosticKind =
  | 'gap_detected'
  | 'skip_forward'
  | 'keyframe_waiting'
  | 'partial_group_abandoned'
  | 'backlog_shed'
  | 'recovery_action'
  | 'sync_reset';

/** LOC pipeline diagnostics block of {@link PlayerStats}. */
export interface LocDiagnostics {
  /** Group gaps detected by the pipeline. */
  readonly gapDetectedCount: number;
  /** Skip-forwards past a (possibly merely-late) group. */
  readonly skipForwardCount: number;
  /** Keyframe waits after a gap/reset (visible freeze while waiting). */
  readonly keyframeWaitingCount: number;
  /** Partially-received video GOPs abandoned on intra-group timeout. */
  readonly partialGroupAbandonedCount: number;
  /** Backlog sheds (buffered groups dropped after a burst). */
  readonly backlogShedCount: number;
  /** Recovery actions that passed the player's recovery hook. */
  readonly recoveryActionCount: number;
  /** A/V sync baseline resets actually performed (skip-triggered). */
  readonly syncResetCount: number;
  /** Live adaptive gap-timeout of the video pipeline (ms). null without a LOC video pipeline. */
  readonly videoEffectiveGapTimeoutMs: number | null;
  /**
   * The SHARED playout cushion (ms): max(adaptive gap timeout, static
   * floor), the single policy source for BOTH media. Video render times
   * adopt it per-frame; audio adopts it at anchor/underrun boundaries
   * (a healthy audio chain is never retimed mid-run), so a cushion change
   * can diverge transiently until the next audio anchor. null without a
   * LOC video pipeline.
   */
  readonly renderCushionMs: number | null;
}

/** Live timing gauges supplied by the player at snapshot time. */
export interface LocTimingGauges {
  readonly videoEffectiveGapTimeoutMs: number | null;
  readonly renderCushionMs: number | null;
}

// ─── StatsAccumulator ────────────────────────────────────────────────

/**
 * Mutable accumulator for player statistics.
 *
 * Methods are called inline at each player milestone. snapshot() produces
 * an immutable plain object with computed fields (relative TTFF, dropRatio,
 * in-progress playback duration).
 *
 * @see draft-jennings-moq-metrics-02 (informational)
 */
export class StatsAccumulator {
  // ── TTFF absolute timestamps (Date.now()) ──────────────────
  private _loadStartMs: number | null = null;
  private _transportConnectedMs: number | null = null;
  private _setupCompleteMs: number | null = null;
  private _catalogReceivedMs: number | null = null;
  private _firstObjectReceivedMs: number | null = null;
  private _decoderConfiguredMs: number | null = null;
  private _firstFrameRenderedMs: number | null = null;

  // ── Quality ─────────────────────────────────────────────────
  private _currentBitrate = 0;
  private _currentResolution: { width: number; height: number } | null = null;
  private _currentVideoCodec: string | null = null;
  private _currentAudioCodec: string | null = null;
  private _qualitySwitchCount = 0;
  private _targetLatencyMs = 0;

  // ── Frames ──────────────────────────────────────────────────
  private _framesDecoded = 0;
  private _framesDropped = 0;
  private _framesRendered = 0;

  // ── Network ─────────────────────────────────────────────────
  private _objectsReceived = 0;
  private _bytesReceived = 0;
  private _gapsReceived = 0;

  // ── Errors ──────────────────────────────────────────────────
  private _gapCount = 0;
  private _stallCount = 0;
  private _totalStallDurationMs = 0;
  private _decodeErrorCount = 0;
  private _recoveryActionCount = 0;

  // ── Session ─────────────────────────────────────────────────
  private _reconnectCount = 0;

  // ── A/V sync observability ──────────────────────────────────
  private _avSkewMs: number | null = null;
  private _avSkewEwmaMs: number | null = null;

  // ── Latency (Item 8) ──────────────────────────────────────
  private _currentLatencyMs = 0;

  // ── Playback duration tracking ─────────────────────────────
  /** Whether currently in an active playback segment. */
  private _playing = false;
  /** Accumulated active playback time from completed segments. */
  private _accumulatedPlayMs = 0;
  /** Start of current playback segment (Date.now()). null when paused/stopped. */
  private _playSegmentStartMs: number | null = null;

  // ── TTFF recording (idempotent — first write wins) ─────────

  /** Mark load() called. */
  recordLoadStart(): void {
    if (this._loadStartMs === null) this._loadStartMs = Date.now();
  }

  /** Mark WebTransport connection established. */
  recordTransportConnected(): void {
    if (this._transportConnectedMs === null) this._transportConnectedMs = Date.now();
  }

  /** Mark MOQT session setup complete (SERVER_SETUP received). */
  recordSetupComplete(): void {
    if (this._setupCompleteMs === null) this._setupCompleteMs = Date.now();
  }

  /** Mark first catalog object received. */
  recordCatalogReceived(): void {
    if (this._catalogReceivedMs === null) this._catalogReceivedMs = Date.now();
  }

  /** Mark first media object received on any track. */
  recordFirstObjectReceived(): void {
    if (this._firstObjectReceivedMs === null) this._firstObjectReceivedMs = Date.now();
  }

  /** Mark first decoder configured. */
  recordDecoderConfigured(): void {
    if (this._decoderConfiguredMs === null) this._decoderConfiguredMs = Date.now();
  }

  /** Mark first video frame rendered. */
  recordFirstFrameRendered(): void {
    if (this._firstFrameRenderedMs === null) this._firstFrameRenderedMs = Date.now();
  }

  // ── Quality ─────────────────────────────────────────────────

  /**
   * Set initial track info from catalog selection.
   * @see draft-ietf-moq-msf-00 §5.1.24 (codec)
   * @see draft-ietf-moq-msf-00 §5.1.29 (width)
   * @see draft-ietf-moq-msf-00 §5.1.30 (height)
   */
  setTrackInfo(
    video?: { codec?: string; bitrate?: number; width?: number; height?: number },
    audio?: { codec?: string },
  ): void {
    if (video) {
      this._currentVideoCodec = video.codec ?? null;
      this._currentBitrate = video.bitrate ?? 0;
      if (video.width !== undefined && video.height !== undefined) {
        this._currentResolution = { width: video.width, height: video.height };
      }
    }
    if (audio) {
      this._currentAudioCodec = audio.codec ?? null;
    }
  }

  /**
   * Record a quality switch (ABR).
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
   */
  recordQualitySwitch(
    newTrack: { codec?: string; bitrate?: number; width?: number; height?: number },
  ): void {
    this._qualitySwitchCount++;
    this._currentVideoCodec = newTrack.codec ?? this._currentVideoCodec;
    this._currentBitrate = newTrack.bitrate ?? this._currentBitrate;
    if (newTrack.width !== undefined && newTrack.height !== undefined) {
      this._currentResolution = { width: newTrack.width, height: newTrack.height };
    }
  }

  /** Set target latency from catalog. @see draft-ietf-moq-msf-00 §5.1.16 */
  setTargetLatency(ms: number): void {
    this._targetLatencyMs = ms;
  }

  // ── Frames ──────────────────────────────────────────────────

  /** Record a frame decoded. */
  recordFrameDecoded(): void {
    this._framesDecoded++;
  }

  /** Record a frame rendered. */
  recordFrameRendered(): void {
    this._framesRendered++;
  }

  // ── Network (§10.2.1.1) ────────────────────────────────────

  /**
   * Record a media object received.
   * @param bytes Payload byte count.
   */
  recordMediaObject(bytes: number): void {
    this._objectsReceived++;
    this._bytesReceived += bytes;
  }

  /** Record a gap object received (Object Status signal). */
  recordGapObject(): void {
    this._gapsReceived++;
  }

  // ── Errors ──────────────────────────────────────────────────

  /** Record a gap detected by the pipeline. */
  recordGapDetected(): void {
    this._gapCount++;
  }

  /** Record a playback stall. */
  recordStall(durationMs: number): void {
    this._stallCount++;
    this._totalStallDurationMs += durationMs;
  }

  /** Record a decode error. */
  recordDecodeError(): void {
    this._decodeErrorCount++;
  }

  /** Record a recovery action taken. */
  recordRecoveryAction(): void {
    this._recoveryActionCount++;
  }

  // ── Session ─────────────────────────────────────────────────

  /** Record a reconnection (GOAWAY migration). */
  recordReconnect(): void {
    this._reconnectCount++;
  }

  // ── A/V sync (LOC observability) ──────────────────────────

  /** Record a measured A/V skew sample (ms). */
  recordAvSkew(ms: number): void {
    this._avSkewMs = ms;
    this._avSkewEwmaMs = this._avSkewEwmaMs === null
      ? ms
      : this._avSkewEwmaMs * 0.9 + ms * 0.1;
  }

  // ── LOC pipeline diagnostics ─────────────────────────────

  private readonly _locCounts: Record<LocDiagnosticKind, number> = {
    gap_detected: 0, skip_forward: 0, keyframe_waiting: 0,
    partial_group_abandoned: 0, backlog_shed: 0,
    recovery_action: 0, sync_reset: 0,
  };

  /**
   * Count one LOC pipeline diagnostic event. Observability only — called
   * from the pipeline event handler; never influences behavior.
   */
  recordLocDiagnostic(kind: LocDiagnosticKind): void {
    this._locCounts[kind]++;
  }

  // ── Latency ──────────────────────────────────────────────

  /**
   * Record current end-to-end latency.
   * @param ms Latency in milliseconds (from CaptureTimestamp comparison)
   * @see draft-ietf-moq-loc-01 §2.3.1.1
   */
  recordLatency(ms: number): void {
    this._currentLatencyMs = ms;
  }

  // ── Playback duration ──────────────────────────────────────

  /** Mark start of active playback segment. */
  recordPlayStart(): void {
    if (!this._playing) {
      this._playing = true;
      this._playSegmentStartMs = Date.now();
    }
  }

  /** Mark end of active playback segment. */
  recordPlayStop(): void {
    if (this._playing && this._playSegmentStartMs !== null) {
      this._accumulatedPlayMs += Date.now() - this._playSegmentStartMs;
      this._playSegmentStartMs = null;
      this._playing = false;
    }
  }

  // ─── Snapshot ──────────────────────────────────────────────

  /**
   * Produce an immutable snapshot of current stats.
   *
   * Computes relative TTFF, in-progress playback duration, session age,
   * and dropRatio. Returns a plain object (no class instance).
   */
  snapshot(locGauges?: LocTimingGauges): PlayerStats {
    const now = Date.now();
    const loadStart = this._loadStartMs;

    // Relative TTFF computation
    const relativeMs = (abs: number | null): number | null =>
      abs !== null && loadStart !== null ? abs - loadStart : null;

    const ttffBreakdown: TTFFBreakdown | null = loadStart !== null
      ? {
          loadCalledMs: 0,
          transportConnectedMs: relativeMs(this._transportConnectedMs),
          setupCompleteMs: relativeMs(this._setupCompleteMs),
          catalogReceivedMs: relativeMs(this._catalogReceivedMs),
          firstObjectReceivedMs: relativeMs(this._firstObjectReceivedMs),
          decoderConfiguredMs: relativeMs(this._decoderConfiguredMs),
          firstFrameRenderedMs: relativeMs(this._firstFrameRenderedMs),
        }
      : null;

    // Playback duration includes in-progress segment
    let playbackDurationMs = this._accumulatedPlayMs;
    if (this._playing && this._playSegmentStartMs !== null) {
      playbackDurationMs += now - this._playSegmentStartMs;
    }

    // Session age
    const sessionAgeMs = loadStart !== null ? now - loadStart : 0;

    // Drop ratio: avoid division by zero
    const totalFrames = this._framesDecoded + this._framesDropped;
    const dropRatio = totalFrames > 0 ? this._framesDropped / totalFrames : 0;

    return {
      // Timing
      timeToFirstFrameMs: relativeMs(this._firstFrameRenderedMs),
      ttffBreakdown,
      currentLatencyMs: this._currentLatencyMs,
      targetLatencyMs: this._targetLatencyMs,
      playbackDurationMs,
      sessionAgeMs,

      // Quality
      currentBitrate: this._currentBitrate,
      currentResolution: this._currentResolution,
      currentVideoCodec: this._currentVideoCodec,
      currentAudioCodec: this._currentAudioCodec,
      qualitySwitchCount: this._qualitySwitchCount,

      // Frames
      framesDecoded: this._framesDecoded,
      framesDropped: this._framesDropped,
      framesRendered: this._framesRendered,
      dropRatio,

      // Buffer (deferred: Item 7)
      videoBufferDepth: 0,
      audioBufferDepth: 0,
      videoDecoderQueueDepth: 0,

      // Network
      objectsReceived: this._objectsReceived,
      bytesReceived: this._bytesReceived,
      gapsReceived: this._gapsReceived,

      // Errors
      gapCount: this._gapCount,
      stallCount: this._stallCount,
      totalStallDurationMs: this._totalStallDurationMs,
      decodeErrorCount: this._decodeErrorCount,
      recoveryActionCount: this._recoveryActionCount,

      // Session
      reconnectCount: this._reconnectCount,

      // A/V sync (LOC observability)
      avSkewMs: this._avSkewMs,
      avSkewEwmaMs: this._avSkewEwmaMs,

      // LOC pipeline diagnostics
      loc: {
        gapDetectedCount: this._locCounts.gap_detected,
        skipForwardCount: this._locCounts.skip_forward,
        keyframeWaitingCount: this._locCounts.keyframe_waiting,
        partialGroupAbandonedCount: this._locCounts.partial_group_abandoned,
        backlogShedCount: this._locCounts.backlog_shed,
        recoveryActionCount: this._locCounts.recovery_action,
        syncResetCount: this._locCounts.sync_reset,
        videoEffectiveGapTimeoutMs: locGauges?.videoEffectiveGapTimeoutMs ?? null,
        renderCushionMs: locGauges?.renderCushionMs ?? null,
      },
    };
  }
}
