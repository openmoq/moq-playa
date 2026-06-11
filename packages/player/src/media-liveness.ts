/**
 * MediaLivenessMonitor — per-track media-arrival starvation detection.
 *
 * The gap detector handles gaps BETWEEN arrivals; this monitor handles NO
 * arrivals: a track whose delivery stops entirely (transport stream death,
 * relay restart) never gives the gap detector a later group to anchor its
 * timeout on, so starvation must be detected from wall-clock staleness of
 * the last arrival.
 *
 * Entries are keyed by subscription identity (requestId) — track aliases can
 * be reused across resubscribes/quality switches, so an alias alone could let
 * a stale arrival refresh the wrong track. Arrivals are stamped by alias
 * (that is what the object carries) and resolved through an alias index that
 * always points at the newest registration.
 *
 * A track arms on its FIRST arrival; before that, startup is the
 * WatchdogController's job ('first_media_object'). A data-stream reset
 * shortens the armed track's fuse to `resetProbeMs`: a healthy track delivers
 * a successor stream within the probe and re-stamps, a dead one starves fast
 * instead of waiting out the full timeout.
 *
 * Detection is driven by `check(nowMs)` — the player calls it from its
 * existing tick loop (a handful of entries — cheap at tick rate); the
 * monitor owns no timers.
 *
 * @module
 */

/** Identity of a monitored track (one active subscription). */
export interface LivenessTrack {
  readonly requestId: bigint;
  readonly trackAlias: bigint;
  readonly mediaType: 'video' | 'audio';
  readonly trackName: string;
}

/** MediaLivenessMonitor configuration. */
export interface MediaLivenessOptions {
  /** Starvation threshold since the last arrival. 0 disables detection. */
  readonly livenessTimeoutMs: number;
  /** Shortened fuse after a data-stream reset on an armed track. */
  readonly resetProbeMs: number;
  /**
   * Fired once per starvation incident (re-armed by the next arrival).
   * `healthyForMs` is the duration of the UNINTERRUPTED arrival streak that
   * preceded this starvation — restart-budget resets must credit real
   * health, not merely time elapsed since the last incident.
   */
  readonly onStarved: (track: LivenessTrack, starvedForMs: number, healthyForMs: number) => void;
}

interface TrackEntry {
  readonly track: LivenessTrack;
  /** undefined = not yet armed (no object seen for this subscription). */
  lastArrivalMs: number | undefined;
  /** Start of the current uninterrupted arrival streak (set with arming). */
  streakStartMs: number | undefined;
  /** Shortened deadline after a stream reset; cleared by the next arrival. */
  fuseDeadlineMs: number | undefined;
  /** True after onStarved fired; suppresses re-fire until an arrival. */
  incidentActive: boolean;
}

/** Detects per-track delivery starvation from arrival staleness. */
export class MediaLivenessMonitor {
  private readonly livenessTimeoutMs: number;
  private readonly resetProbeMs: number;
  private readonly onStarved: (track: LivenessTrack, starvedForMs: number, healthyForMs: number) => void;

  /** Subscription identity → entry. */
  private readonly entries = new Map<bigint, TrackEntry>();
  /** Alias → requestId of the NEWEST registration for that alias. */
  private readonly aliasIndex = new Map<bigint, bigint>();

  constructor(options: MediaLivenessOptions) {
    this.livenessTimeoutMs = options.livenessTimeoutMs;
    this.resetProbeMs = options.resetProbeMs;
    this.onStarved = options.onStarved;
  }

  /**
   * Register an active media subscription. Re-points the alias index.
   * Idempotent for a known requestId: timing state is preserved so the
   * player can reconcile against its subscription map every tick (and so
   * a SUBSCRIBE_OK alias remap doesn't disarm detection).
   */
  registerTrack(track: LivenessTrack): void {
    const existing = this.entries.get(track.requestId);
    if (existing && this.aliasIndex.get(existing.track.trackAlias) === track.requestId
        && existing.track.trackAlias !== track.trackAlias) {
      this.aliasIndex.delete(existing.track.trackAlias); // alias remapped
    }
    this.entries.set(track.requestId, {
      track,
      lastArrivalMs: existing?.lastArrivalMs,
      streakStartMs: existing?.streakStartMs,
      fuseDeadlineMs: existing?.fuseDeadlineMs,
      incidentActive: existing?.incidentActive ?? false,
    });
    this.aliasIndex.set(track.trackAlias, track.requestId);
  }

  /** Retire a subscription (unsubscribe/switch). Stale aliases stop stamping. */
  retireTrack(requestId: bigint): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    this.entries.delete(requestId);
    // Don't clobber the alias if it was already re-registered to a newer
    // subscription (make-before-break ordering registers new before retiring old).
    if (this.aliasIndex.get(entry.track.trackAlias) === requestId) {
      this.aliasIndex.delete(entry.track.trackAlias);
    }
  }

  /**
   * Stamp a media-object arrival. Arms the track, clears fuse + incident.
   * Returns false when the alias is unknown (e.g. the object raced the
   * caller's first reconcile) — the caller may reconcile and retry.
   */
  noteArrival(trackAlias: bigint, nowMs: number): boolean {
    const entry = this.entryByAlias(trackAlias);
    if (!entry) return false;
    // A fresh session or a liveness-sized delivery gap starts a new
    // healthy streak — no credit carries across gaps.
    if (entry.lastArrivalMs === undefined
        || nowMs - entry.lastArrivalMs > this.livenessTimeoutMs) {
      entry.streakStartMs = nowMs;
    }
    entry.lastArrivalMs = nowMs;
    entry.fuseDeadlineMs = undefined;
    entry.incidentActive = false;
    return true;
  }

  /**
   * A data stream belonging to this track was reset. Armed tracks get a
   * shortened fuse; unarmed tracks are ignored (startup watchdog territory).
   */
  noteStreamReset(trackAlias: bigint, nowMs: number): void {
    const entry = this.entryByAlias(trackAlias);
    if (!entry || entry.lastArrivalMs === undefined) return;
    const probeDeadline = nowMs + this.resetProbeMs;
    entry.fuseDeadlineMs = entry.fuseDeadlineMs === undefined
      ? probeDeadline
      : Math.min(entry.fuseDeadlineMs, probeDeadline);
  }

  /** Evaluate starvation. Called from the player tick while PLAYING. */
  check(nowMs: number): void {
    if (this.livenessTimeoutMs <= 0) return;
    for (const entry of this.entries.values()) {
      if (entry.lastArrivalMs === undefined || entry.incidentActive) continue;
      const sinceArrival = nowMs - entry.lastArrivalMs;
      const timedOut = sinceArrival > this.livenessTimeoutMs;
      const fuseBlown = entry.fuseDeadlineMs !== undefined && nowMs > entry.fuseDeadlineMs;
      if (timedOut || fuseBlown) {
        entry.incidentActive = true;
        const healthyForMs = entry.streakStartMs !== undefined
          ? entry.lastArrivalMs - entry.streakStartMs
          : 0;
        this.onStarved(entry.track, sinceArrival, healthyForMs);
      }
    }
  }

  /** Newest arrival stamp for a track name (restart-ladder probe). */
  lastArrivalForTrack(trackName: string, mediaType: 'video' | 'audio'): number | undefined {
    let newest: number | undefined;
    for (const entry of this.entries.values()) {
      if (entry.track.trackName !== trackName || entry.track.mediaType !== mediaType) continue;
      if (entry.lastArrivalMs !== undefined && (newest === undefined || entry.lastArrivalMs > newest)) {
        newest = entry.lastArrivalMs;
      }
    }
    return newest;
  }

  /**
   * Reconcile against the caller's authoritative subscription list:
   * registers new tracks (idempotent for known requestIds — stamps are
   * preserved) and retires entries no longer present. Cheap enough to call
   * every tick for a handful of tracks; immune to drift across the
   * caller's many subscribe/unsubscribe/switch code paths.
   */
  reconcile(tracks: readonly LivenessTrack[]): void {
    const want = new Set(tracks.map((t) => t.requestId));
    for (const requestId of [...this.entries.keys()]) {
      if (!want.has(requestId)) this.retireTrack(requestId);
    }
    for (const track of tracks) this.registerTrack(track);
  }

  /** Retire everything (stop/destroy). */
  clear(): void {
    this.entries.clear();
    this.aliasIndex.clear();
  }

  private entryByAlias(trackAlias: bigint): TrackEntry | undefined {
    const requestId = this.aliasIndex.get(trackAlias);
    return requestId === undefined ? undefined : this.entries.get(requestId);
  }
}
