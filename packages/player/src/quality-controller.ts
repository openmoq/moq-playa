/**
 * QualityController — ABR track selection using @moqt/msf APIs.
 *
 * Selects initial video and audio tracks from the catalog.
 * Responds to `reduce_quality` recovery actions by stepping down
 * through the altGroup (lower bitrate alternatives).
 *
 * Quality switches happen at MOQT Group boundaries per §4.2
 * (tracks in common renderGroup are time-aligned).
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 * @see draft-ietf-moq-msf-00 §4.2 (time-alignment)
 * @see draft-ietf-moq-msf-00 §5.1.18 (renderGroup)
 * @module
 */

import type { CatalogTrack, CatalogState, TrackConstraints } from '@moqt/msf';
import { groupByAlt, selectTrack } from '@moqt/msf';
import type { ClockSource } from '@moqt/playback';

/** Configuration for the quality controller. */
export interface QualityControllerConfig {
  /** Enable automatic quality selection. Default: true. */
  readonly autoQuality: boolean;
  /** Initial quality level. Default: 'auto'. */
  readonly startLevel: number | 'lowest' | 'auto';
  /** Maximum resolution cap. */
  readonly capLevelToResolution?: { readonly width: number; readonly height: number };
  /** Minimum time between quality switches. Default: 5000. */
  readonly qualitySwitchCooldownMs: number;
  /** Clock for cooldown tracking. */
  readonly clock: ClockSource;
}

/** Selection constraints for initial track selection. */
export interface SelectionConstraints {
  readonly videoConstraints?: TrackConstraints;
  readonly audioConstraints?: TrackConstraints;
  readonly disableVideo?: boolean;
  readonly disableAudio?: boolean;
}

/** Result of initial track selection. */
export interface SelectedTracks {
  readonly video: CatalogTrack | undefined;
  readonly audio: CatalogTrack | undefined;
}

/**
 * Manages track quality selection and ABR step-down.
 */
export class QualityController {
  private autoQuality: boolean;
  private readonly startLevel: number | 'lowest' | 'auto';
  private readonly capLevelToResolution: { readonly width: number; readonly height: number } | undefined;
  private readonly qualitySwitchCooldownMs: number;
  private readonly clock: ClockSource;

  /** ABR-switchable alternatives — same codec family, sorted by bitrate (highest first). */
  private videoAlternatives: CatalogTrack[] = [];
  /** ALL video alternatives including cross-codec (for manual selection UI). */
  private allVideoAlternatives: CatalogTrack[] = [];

  /** Current index into videoAlternatives. */
  private videoIndex = 0;

  /** Selected audio track. */
  private _audioTrack: CatalogTrack | undefined;

  /** Timestamp of last quality switch for cooldown enforcement. Undefined = never switched. */
  private lastSwitchTimeUs: number | undefined;

  constructor(config?: QualityControllerConfig) {
    this.autoQuality = config?.autoQuality ?? true;
    this.startLevel = config?.startLevel ?? 'auto';
    this.capLevelToResolution = config?.capLevelToResolution;
    this.qualitySwitchCooldownMs = config?.qualitySwitchCooldownMs ?? 0;
    this.clock = config?.clock ?? { now: () => performance.now() * 1000 };
  }

  /** Current video track. */
  get currentVideoTrack(): CatalogTrack | undefined {
    return this.videoAlternatives[this.videoIndex];
  }

  /** Current audio track. */
  get currentAudioTrack(): CatalogTrack | undefined {
    return this._audioTrack;
  }

  /**
   * Select initial tracks from a catalog.
   *
   * Video: picks from altGroup alternatives using constraints.
   * Audio: picks the best matching audio track.
   *
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup for video)
   */
  selectInitialTracks(
    catalog: CatalogState,
    constraints?: SelectionConstraints,
  ): SelectedTracks {
    // Split tracks by role
    const videoTracks = catalog.tracks.filter(t => t.role === 'video');
    const audioTracks = catalog.tracks.filter(t => t.role === 'audio');

    // Build video alternatives from altGroup
    let videoAlts: CatalogTrack[];
    const { groups } = groupByAlt(videoTracks);
    if (groups.length > 0) {
      // Use the first altGroup's tracks
      videoAlts = [...groups[0]!.tracks];
    } else {
      // No altGroup — treat all video tracks as alternatives
      videoAlts = [...videoTracks];
    }

    // Sort by bitrate descending (highest quality first)
    videoAlts.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));

    // Apply capLevelToResolution filter
    if (this.capLevelToResolution) {
      const cap = this.capLevelToResolution;
      videoAlts = videoAlts.filter(t =>
        (t.width ?? 0) <= cap.width && (t.height ?? 0) <= cap.height,
      );
    }

    // Store ALL alternatives (for availableVideoTracks / manual selection)
    this.allVideoAlternatives = videoAlts;

    // Select based on startLevel
    let video: CatalogTrack | undefined;
    if (this.startLevel === 'lowest') {
      video = videoAlts[videoAlts.length - 1];
    } else if (typeof this.startLevel === 'number') {
      // Clamp to valid range
      const idx = Math.min(this.startLevel, videoAlts.length - 1);
      video = videoAlts[idx];
    } else {
      // 'auto' — use constraints or pick middle of ladder. Starting at
      // the highest bitrate is catastrophic on constrained networks
      // (conference WiFi, cellular) — the player stalls before the
      // recovery controller can downshift. Middle is safe: one
      // downshift reaches low quality, one upshift reaches high.
      video = constraints?.videoConstraints
        ? selectTrack(videoAlts, constraints.videoConstraints)
        : videoAlts[Math.floor(videoAlts.length / 2)];
    }

    // Narrow ABR alternatives to the selected track's codec family.
    // Cross-codec switches (AVC↔HEVC) require changeType/reconfigure
    // and interleave different codecs at similar bitrates — ABR would
    // bounce between codecs instead of stepping down in quality.
    // Manual selection (selectVideoTrack) can still cross codecs.
    if (video?.codec) {
      const codecFamily = video.codec.split('.')[0]; // 'avc1', 'hvc1', 'av01'
      this.videoAlternatives = videoAlts.filter(t =>
        t.codec?.split('.')[0] === codecFamily,
      );
    } else {
      this.videoAlternatives = videoAlts;
    }

    // Set videoIndex to match selected track in the narrowed list
    this.videoIndex = video ? this.videoAlternatives.indexOf(video) : 0;
    if (this.videoIndex === -1) this.videoIndex = 0;

    // Select audio
    const audio = constraints?.audioConstraints
      ? selectTrack(audioTracks, constraints.audioConstraints)
      : audioTracks[0];
    this._audioTrack = audio;

    return {
      video: constraints?.disableVideo ? undefined : video,
      audio: constraints?.disableAudio ? undefined : audio,
    };
  }

  /**
   * Reduce video quality by one step (next-lower bitrate in altGroup).
   *
   * Returns null if:
   * - Already at the lowest quality
   * - autoQuality is disabled
   * - Cooldown period hasn't elapsed
   *
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup alternatives)
   * @see draft-ietf-moq-msf-00 §4.2 (switch at group boundaries)
   */
  reduceVideoQuality(emergency = false): CatalogTrack | null {
    if (!this.autoQuality) return null;

    // Enforce cooldown (bypassed for emergency downshifts)
    if (!emergency) {
      const now = this.clock.now();
      const cooldownUs = this.qualitySwitchCooldownMs * 1000;
      if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
        return null;
      }
    }

    if (this.videoIndex >= this.videoAlternatives.length - 1) {
      return null; // Already at lowest
    }
    this.videoIndex++;
    this.lastSwitchTimeUs = this.clock.now();
    return this.videoAlternatives[this.videoIndex] ?? null;
  }

  /**
   * Increase video quality by one step (next-higher bitrate in altGroup).
   * Returns the new track, or null if already at highest or blocked by
   * cooldown / autoQuality=false.
   */
  increaseVideoQuality(): CatalogTrack | null {
    if (!this.autoQuality) return null;

    const now = this.clock.now();
    const cooldownUs = this.qualitySwitchCooldownMs * 1000;
    if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
      return null;
    }

    if (this.videoIndex <= 0) {
      return null; // Already at highest
    }
    this.videoIndex--;
    this.lastSwitchTimeUs = now;
    return this.videoAlternatives[this.videoIndex] ?? null;
  }

  // ─── Non-mutating helpers for deferred commit ──────────────────

  /**
   * Peek at the next lower quality track WITHOUT mutating state.
   * Returns null if blocked by cooldown, autoQuality, or already at lowest.
   */
  peekLowerVideoQuality(emergency = false): CatalogTrack | null {
    if (!this.autoQuality) return null;
    if (!emergency) {
      const now = this.clock.now();
      const cooldownUs = this.qualitySwitchCooldownMs * 1000;
      if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
        return null;
      }
    }
    if (this.videoIndex >= this.videoAlternatives.length - 1) return null;
    return this.videoAlternatives[this.videoIndex + 1] ?? null;
  }

  /**
   * Peek at the next higher quality track WITHOUT mutating state.
   * Returns null if blocked by cooldown, autoQuality, or already at highest.
   */
  peekHigherVideoQuality(): CatalogTrack | null {
    if (!this.autoQuality) return null;
    const now = this.clock.now();
    const cooldownUs = this.qualitySwitchCooldownMs * 1000;
    if (this.lastSwitchTimeUs !== undefined && (now - this.lastSwitchTimeUs) < cooldownUs) {
      return null;
    }
    if (this.videoIndex <= 0) return null;
    return this.videoAlternatives[this.videoIndex - 1] ?? null;
  }

  /**
   * Commit a quality switch. Called after the switch is actually
   * committed to the pipeline/MSE, not when the subscription starts.
   */
  commitVideoTrack(trackName: string): void {
    const idx = this.videoAlternatives.findIndex(t => t.name === trackName);
    if (idx >= 0) {
      this.videoIndex = idx;
      this.lastSwitchTimeUs = this.clock.now();
    }
  }

  /** Lock to current quality — disables reduce/increase until unlocked. */
  lockManual(): void { this.autoQuality = false; }

  /** Re-enable automatic quality switching. */
  unlockAuto(): void { this.autoQuality = true; }

  /** Whether automatic quality switching is enabled. */
  get isAutoQuality(): boolean { return this.autoQuality; }

  /** ABR alternatives (same codec family, sorted by bitrate highest first). */
  get alternatives(): readonly CatalogTrack[] { return this.videoAlternatives; }

  /** ALL video alternatives including cross-codec (for UI / manual selection). */
  get allAlternatives(): readonly CatalogTrack[] { return this.allVideoAlternatives; }

  /** Current index into the alternatives array. */
  get currentIndex(): number { return this.videoIndex; }

  /** The track one step above current, or null if already at highest. */
  get nextHigherTrack(): CatalogTrack | undefined {
    if (this.videoIndex <= 0) return undefined;
    return this.videoAlternatives[this.videoIndex - 1];
  }
}
