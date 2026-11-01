/**
 * QualityController — ABR track selection using @openmoq/msf APIs.
 *
 * Selects initial video and audio tracks from the catalog.
 * Responds to `reduce_quality` recovery actions by stepping down
 * through the altGroup (lower bitrate alternatives).
 *
 * Quality switches happen at MOQT Group boundaries per §4.2
 * (tracks in a common altGroup are time-aligned).
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 * @see draft-ietf-moq-msf-00 §4.2 (time-alignment)
 * @see draft-ietf-moq-msf-00 §5.1.18 (renderGroup)
 * @module
 */

import type { CatalogTrack, CatalogState, TrackConstraints } from '@openmoq/msf';
import { selectVideoAltGroup, selectTrack, isTrackPackagingSupported } from '@openmoq/msf';
import type { ClockSource } from '@openmoq/playback';

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
  readonly videoAltGroup?: number;
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
   * @deprecated Use the player's scoped catalog selection, or pass already
   * eligible members to selectEligibleMembers. This legacy entry point has
   * no catalog namespace context and cannot resolve presentation scopes.
   *
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup for video)
   */
  selectInitialTracks(
    catalog: CatalogState,
    constraints?: SelectionConstraints,
  ): SelectedTracks {
    // LOCMAF §5: a receiver MUST NOT subscribe to a locmafVersion it does not
    // support — exclude those tracks so an alternative packaging is chosen.
    const usable = catalog.tracks.filter(isTrackPackagingSupported);

    // Split tracks by role
    const videoTracks = usable.filter(t => t.role === 'video');
    const audioTracks = usable.filter(t => t.role === 'audio');

    // Build video alternatives from altGroup, then prepare them exactly as the
    // composed path does — one definition of cap and quality order.
    const videoAlts = this.eligibleLadder(constraints?.disableVideo
      ? [] : selectVideoAltGroup(videoTracks, constraints?.videoAltGroup));

    // Store ALL alternatives (for availableVideoTracks / manual selection)
    this.allVideoAlternatives = videoAlts;

    const video = this.chooseVideoMember(videoAlts, constraints?.videoConstraints);

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
   * Prepare a ladder for selection: the persistent resolution cap applied,
   * ordered by descending bitrate.
   *
   * The cap lives here because it is this controller's standing restriction —
   * it must bind every path that chooses a member or steps between them, and
   * a second cap elsewhere could only disagree with it. Quality order is
   * likewise this controller's: the catalog's order decides which SET is
   * eligible, but within a declared ladder "one step down" has to mean lower
   * bitrate, or a downshift can raise it.
   *
   * Pure — the input array is not modified and no state is assigned.
   */
  eligibleLadder(tracks: readonly CatalogTrack[]): CatalogTrack[] {
    const cap = this.capLevelToResolution;
    const capped = cap === undefined ? [...tracks] : tracks.filter(
      t => (t.width ?? 0) <= cap.width && (t.height ?? 0) <= cap.height);
    // Stable: equal bitrates keep catalog order.
    return capped.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  }

  /** The standing resolution cap, if one was configured. */
  get resolutionCap(): { readonly width: number; readonly height: number } | undefined {
    return this.capLevelToResolution;
  }

  /**
   * Choose the MEMBER to play from an already-eligible ladder, and adopt it.
   *
   * The one implementation of member choice: `startLevel`, the startup-only
   * `videoConstraints`, the resolution cap applied by the caller, and the
   * codec-family narrowing that keeps ABR from bouncing between codecs. Both
   * the catalog path and the composed path call it, so the two cannot drift
   * into separate quality policies.
   *
   * `pin` is an explicit choice of track: it overrides the start-level
   * default entirely, and selects nothing at all when it is not eligible.
   * Manual mode is the caller's to apply — an application's pin and a member
   * carried across an evaluation are different intents.
   */
  private chooseVideoMember(
    ladder: readonly CatalogTrack[],
    videoConstraints?: TrackConstraints,
    pin?: CatalogTrack,
  ): CatalogTrack | undefined {
    const alts = [...ladder];
    let video: CatalogTrack | undefined;
    if (pin !== undefined) {
      // A pin that is not eligible selects NOTHING. Falling through to a
      // default here would answer an explicit request for one track by
      // playing another — the caller asked for that track or an error.
      if (!alts.includes(pin)) {
        this.videoAlternatives = [];
        this.videoIndex = 0;
        return undefined;
      }
      video = pin;
    } else if (this.startLevel === 'lowest') {
      video = alts[alts.length - 1];
    } else if (typeof this.startLevel === 'number') {
      // Clamp to valid range
      const idx = Math.min(this.startLevel, alts.length - 1);
      video = alts[idx];
    } else {
      // 'auto' — use constraints or pick middle of ladder. Starting at
      // the highest bitrate is catastrophic on constrained networks
      // (conference WiFi, cellular) — the player stalls before the
      // recovery controller can downshift. Middle is safe: one
      // downshift reaches low quality, one upshift reaches high.
      video = videoConstraints ? selectTrack(alts, videoConstraints) : alts[Math.floor(alts.length / 2)];
    }

    if (video === undefined) {
      // Nothing was chosen, so nothing is playing: leave no switchable set
      // behind. Otherwise `currentVideoTrack` would name a track the
      // selection declined, and ABR would authorize moving between tracks
      // that were never selected.
      this.videoAlternatives = [];
      this.videoIndex = 0;
      return undefined;
    }

    // Narrow ABR alternatives to the selected track's codec family.
    // Cross-codec switches (AVC↔HEVC) require changeType/reconfigure
    // and interleave different codecs at similar bitrates — ABR would
    // bounce between codecs instead of stepping down in quality.
    // Manual selection (selectVideoTrack) can still cross codecs.
    if (video.codec) {
      const codecFamily = video.codec.split('.')[0]; // 'avc1', 'hvc1', 'av01'
      this.videoAlternatives = alts.filter(t => t.codec?.split('.')[0] === codecFamily);
    } else {
      this.videoAlternatives = alts;
    }

    // Set videoIndex to match selected track in the narrowed list
    this.videoIndex = this.videoAlternatives.indexOf(video);
    if (this.videoIndex === -1) this.videoIndex = 0;
    return video;
  }

  /**
   * Choose members from candidates a catalog-selection model already found
   * ELIGIBLE, without consulting a catalog.
   *
   * The division of labour: the model decides which set is eligible — which
   * render scope, which declared alternate group, which singleton — and this
   * decides which member of it plays. Nothing here may reach outside the
   * candidates it is given, so no cap, constraint or start level can move
   * playback to another view.
   *
   * MUTATES this controller: its ladder, index and audio track become the
   * selection. Evaluating a candidate session must therefore use its own
   * controller, never the one driving playback.
   */
  selectEligibleMembers(candidates: {
    readonly videoLadder: readonly CatalogTrack[];
    readonly audioCandidates: readonly CatalogTrack[];
  }, options: {
    readonly videoConstraints?: TrackConstraints;
    readonly audioConstraints?: TrackConstraints;
    readonly videoPin?: CatalogTrack;
    readonly audioPin?: CatalogTrack;
  } = {}): SelectedTracks {
    // Prepared here, not by the caller: the cap and the quality order are this
    // controller's, and an empty ladder means nothing here qualifies — it is
    // never widened to find something.
    const ladder = this.eligibleLadder(candidates.videoLadder);
    this.allVideoAlternatives = ladder;
    const video = this.chooseVideoMember(ladder, options.videoConstraints, options.videoPin);

    let audio: CatalogTrack | undefined;
    if (options.audioPin !== undefined) {
      // As for video: a pin outside the candidates selects nothing rather
      // than quietly becoming a default.
      audio = candidates.audioCandidates.includes(options.audioPin) ? options.audioPin : undefined;
    } else if (options.audioConstraints !== undefined) {
      // Exact constraints filter the whole scope's audio, in catalog order,
      // so a language declared on a later set is still found — without
      // escaping the scope, because the candidates ARE the scope.
      audio = selectTrack(candidates.audioCandidates, options.audioConstraints);
    } else {
      audio = candidates.audioCandidates[0];
    }
    this._audioTrack = audio;
    return { video, audio };
  }

  /**
   * Commit a quality switch by track REFERENCE rather than by name.
   *
   * A name is not an identity: msf-01 §5.2.3 makes names unique only per
   * namespace, so {@link commitVideoTrack}'s first-name match can commit a
   * different track than the one selected. This takes the object the
   * selection produced, so no lookup can go astray.
   */
  commitVideoTrackRef(track: CatalogTrack): void {
    if (!this.allVideoAlternatives.includes(track)) return;
    this.adoptCommittedTrack(track);
  }

  /** The one commit body: narrow to the track's codec family, index it, and
   *  start the switch cooldown. */
  private adoptCommittedTrack(track: CatalogTrack): void {
    const family = track.codec?.split('.')[0];
    this.videoAlternatives = family === undefined ? [...this.allVideoAlternatives]
      : this.allVideoAlternatives.filter(t => t.codec?.split('.')[0] === family);
    this.videoIndex = this.videoAlternatives.indexOf(track);
    this.lastSwitchTimeUs = this.clock.now();
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
   * @deprecated Use commitVideoTrackRef for namespace-aware selection.
   */
  commitVideoTrack(trackName: string): void {
    const matches = this.allVideoAlternatives.filter(t => t.name === trackName);
    if (matches.length > 1) throw new Error(`Ambiguous video track name "${trackName}"`);
    const track = matches[0];
    if (!track) return;
    this.adoptCommittedTrack(track);
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
