/**
 * Player — batteries-included MoQ media player.
 *
 * Pass a container element and options, call load() + play(), done.
 * Internally creates an MoqtPlayer with the appropriate adapters based
 * on browser capabilities (WebCodecs+Canvas or MSE+<video>).
 *
 * **Classic usage** (Player manages DOM elements automatically):
 * ```ts
 * const player = new Player(document.getElementById('container')!, {
 *   url: 'https://relay.example.com/moq',
 *   namespace: 'live/stream',
 * });
 * await player.load();
 * player.play();
 * ```
 *
 * **Framework usage** (caller owns DOM elements, e.g. React):
 * ```ts
 * const player = new Player(null, {
 *   url: 'https://relay.example.com/moq',
 *   namespace: 'live/stream',
 *   canvas: canvasRef.current,   // <canvas> declared in JSX
 *   video: videoRef.current,     // <video> declared in JSX
 * });
 * await player.load();
 * player.play();
 * ```
 * When elements are provided via options the Player never touches the DOM
 * (no `appendChild`, no `removeChild`, no `hidden` or style mutations).
 *
 * @see draft-ietf-moq-transport-16 §3 (Session lifecycle)
 * @module
 */

import {
  MoqtPlayer, TypedEmitter, checkSupport,
} from '@moqt/player';
import type { MoqtPlayerConfig, SupportReport } from '@moqt/player';
import { MoqtConnection } from '@moqt/webtransport';
import {
  AudioAlignedClock,
  WebCodecsVideoDecoder,
  WebCodecsAudioDecoder,
  CanvasRenderer,
  DeferredAudioOutput,
  WebAudioOutput,
  MseMediaSource,
  CmafAssembler,
  createWebTransport,
} from '@moqt/browser';

import { detectStrategy } from './auto-detect.js';
import type { DecoderStrategy } from './auto-detect.js';
import { VolumeController } from './volume-controller.js';
import { TimeController } from './time-controller.js';
import { mapLevels, mapAudioTracks } from './level-mapper.js';
import type { PlayerOptions, Level, AudioTrack, PlayerStats, PlayerState } from './types.js';
import type { PlayerEventMap } from './events.js';

/** Default player options, merged with user-provided options. */
const DEFAULTS = {
  draftVersion: 16 as const,
  autoplay: false,
  volume: 1,
  muted: false,
  autoQuality: true,
  startLevel: 'auto' as const,
} satisfies Partial<PlayerOptions>;

/**
 * Batteries-included MoQ media player.
 *
 * Wraps MoqtPlayer (@moqt/player) with browser adapters (@moqt/browser)
 * and a UI-friendly API. Handles DOM element creation, adapter wiring,
 * volume control, time tracking, and event bridging automatically.
 */
export class Player {
  // ─── Static ──────────────────────────────────────────────────────

  /** Player version (set at build time). */
  static readonly version = '0.5.3';

  /** Check if the current browser supports MoQ playback. */
  static isSupported(): boolean {
    return checkSupport().supported;
  }

  /** Detailed capability report. */
  static checkSupport(): SupportReport {
    return checkSupport();
  }

  // ─── Internals ───────────────────────────────────────────────────

  private readonly engine: MoqtPlayer;
  private readonly emitter = new TypedEmitter<PlayerEventMap>();
  private readonly container: HTMLElement | null;
  private readonly options: PlayerOptions;
  private readonly strategy: DecoderStrategy;

  // DOM elements — may be user-provided (borrowed) or created by Player (owned).
  private canvas: HTMLCanvasElement | null = null;
  private videoElement: HTMLVideoElement | null = null;
  // Track whether each element was created by the Player (owned) or supplied by the
  // caller (borrowed).  Owned elements are appended to the container in the
  // constructor and removed in destroy().  Borrowed elements are never touched.
  private ownsCanvas = false;
  private ownsVideo = false;

  // Resolved after catalog_received — 'canvas' for LOC/WebCodecs, 'video' for CMAF/MSE.
  private _activeMediaType: 'canvas' | 'video' | null = null;

  // Controllers
  private volumeCtrl: VolumeController | null = null;
  private timeCtrl: TimeController | null = null;

  // Adapter instances (held for lifecycle)
  private readonly audioClock = new AudioAlignedClock();
  private readonly deferredAudio = new DeferredAudioOutput();
  private renderer: CanvasRenderer | null = null;
  private audioCtx: AudioContext | null = null;
  private _prepareAudioPromise: Promise<void> | null = null;

  // State
  private _state: PlayerState = 'idle';
  private _levels: Level[] = [];
  private _audioTracks: AudioTrack[] = [];
  private _currentLevel = -1;
  private _currentAudioTrack = 0;
  private _autoQuality: boolean;
  private _volume: number;
  private _muted: boolean;
  private _duration: number | undefined;
  private _currentTime = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Constructor ─────────────────────────────────────────────────

  /**
   * Create a new Player.
   *
   * @param container DOM element to render into.  When neither `options.canvas`
   *                  nor `options.video` is supplied the Player creates
   *                  `<canvas>` and/or `<video>` elements inside this container
   *                  automatically (classic behaviour).  Pass `null` when you
   *                  supply both media elements via `options` (e.g. in React).
   * @param options   Connection and playback options.  Optionally includes
   *                  `canvas` and/or `video` elements owned by the caller.
   */
  constructor(container: HTMLElement | null, options: PlayerOptions) {
    this.container = container;
    this.options = options;
    this._autoQuality = options.autoQuality ?? DEFAULTS.autoQuality;
    this._volume = this.clampVolume(options.volume ?? DEFAULTS.volume);
    this._muted = options.muted ?? DEFAULTS.muted;

    // Detect decode strategy
    this.strategy = detectStrategy();

    // ── Canvas element ──────────────────────────────────────────────
    if (options.canvas) {
      // Caller owns this element — use it as-is, no DOM mutations.
      this.canvas = options.canvas;
      this.ownsCanvas = false;
    } else if (container) {
      // Classic mode: create the element and append it to the container.
      this.canvas = document.createElement('canvas');
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.objectFit = 'contain';
      this.canvas.hidden = this.strategy !== 'webcodecs';
      container.appendChild(this.canvas);
      this.ownsCanvas = true;
    }

    // ── Video element ───────────────────────────────────────────────
    if (options.video) {
      // Caller owns this element — use it as-is, no DOM mutations.
      this.videoElement = options.video;
      this.videoElement.volume = this._volume;
      this.videoElement.muted = this._muted;
      this.ownsVideo = false;
    } else if (container) {
      // Classic mode: create the element and append it to the container.
      this.videoElement = document.createElement('video');
      this.videoElement.style.width = '100%';
      this.videoElement.style.height = '100%';
      this.videoElement.style.objectFit = 'contain';
      this.videoElement.playsInline = true;
      this.videoElement.hidden = this.strategy === 'webcodecs';
      this.videoElement.volume = this._volume;
      this.videoElement.muted = this._muted;
      container.appendChild(this.videoElement);
      this.ownsVideo = true;
    }

    // Build MoqtPlayer config and create MoqtPlayer
    const moqtPlayerConfig = this.buildMoqtPlayerConfig();
    this.engine = new MoqtPlayer(moqtPlayerConfig);

    // Wire MoqtPlayer events → Player events
    this.wireEngineEvents();

    // Time controller for timeupdate events
    this.timeCtrl = new TimeController(() => {
      // Use the video element's native currentTime when it is the active sink.
      // For owned elements we check the hidden flag; for borrowed elements we
      // rely on _activeMediaType (set after catalog_received), falling back to
      // the capability-detected strategy before the catalog arrives.
      let videoIsActive: boolean;
      if (this.ownsVideo) {
        videoIsActive = this.videoElement != null && !this.videoElement.hidden;
      } else {
        const effectiveType = this._activeMediaType ?? (this.strategy === 'webcodecs' ? 'canvas' : 'video');
        videoIsActive = effectiveType === 'video';
      }
      if (videoIsActive && this.videoElement) {
        this._currentTime = this.videoElement.currentTime * 1000;
      } else {
        this._currentTime = this.engine.stats.playbackDurationMs;
      }
      this.emitter.emit('timeupdate', { currentTime: this._currentTime });
    });
  }

  // ─── Properties ──────────────────────────────────────────────────

  /** Current player state. */
  get state(): PlayerState { return this._state; }

  /**
   * Which media element is currently used as the render sink.
   *
   * Resolves to `'canvas'` (WebCodecs/LOC path) or `'video'` (MSE/CMAF path)
   * once the catalog has been received, or `null` before that.
   *
   * Useful when the caller owns the media elements (e.g. in React) and needs
   * to know which one to show after the `'ready'` event fires.
   */
  get activeMediaType(): 'canvas' | 'video' | null { return this._activeMediaType; }

  /** Current playback position in ms. */
  get currentTime(): number { return this._currentTime; }

  /** Stream duration in ms, or undefined for live. */
  get duration(): number | undefined { return this._duration; }

  /** Whether seek is available (timeline loaded). */
  get seekable(): boolean { return this.engine.seekable; }

  /** Current volume (0–1). */
  get volume(): number { return this._volume; }

  /** Whether audio is muted. */
  get muted(): boolean { return this._muted; }

  /** Available quality levels (sorted by bitrate, highest first). */
  get levels(): readonly Level[] { return this._levels; }

  /** Current quality level index, or -1 if unknown. */
  get currentLevel(): number { return this._currentLevel; }

  /** Whether ABR is active. */
  get autoQuality(): boolean { return this._autoQuality; }

  /** Available audio tracks. */
  get audioTracks(): readonly AudioTrack[] { return this._audioTracks; }

  /** Current audio track index. */
  get currentAudioTrack(): number { return this._currentAudioTrack; }

  /** Simplified stats for UI display. */
  get stats(): PlayerStats {
    const s = this.engine.stats;
    return {
      framesDecoded: s.framesDecoded,
      framesRendered: s.framesRendered,
      framesDropped: s.framesDropped,
      bitrate: s.currentBitrate,
      latencyMs: 0, // TODO: derive from sync controller
      stallCount: s.stallCount,
      timeToFirstFrameMs: s.timeToFirstFrameMs,
      resolution: s.currentResolution ?? null,
      videoCodec: s.currentVideoCodec ?? null,
      audioCodec: s.currentAudioCodec ?? null,
      sessionAgeMs: s.sessionAgeMs,
    };
  }

  // ─── Lifecycle Methods ───────────────────────────────────────────

  /**
   * Connect to the relay, fetch catalog, subscribe to tracks.
   * Resolves when the session is established and catalog is loaded.
   */
  async load(): Promise<void> {
    this.setState('loading');
    await this.engine.load();
  }

  /**
   * Start playback. In 'auto' mode, creates AudioContext eagerly.
   * In 'gesture' mode, audio stays deferred until prepareAudio()/unmute().
   */
  play(): void {
    if (this.options.audioActivation !== 'gesture') {
      this.ensureAudioContext();
    }
    this.engine.play();
    this.renderer?.start();
    this.timeCtrl?.start();
    this.startStatsTimer();
    this.setState('playing');
    this.emitter.emit('play', {});
  }

  /** Pause playback (REQUEST_UPDATE forward:0). */
  pause(): void {
    this.engine.pause();
    this.renderer?.stop();
    this.timeCtrl?.stop();
    this.setState('paused');
    this.emitter.emit('pause', {});
  }

  /** Toggle between play and pause. */
  togglePlay(): void {
    if (this._state === 'playing') this.pause();
    else this.play();
  }

  /** Seek to a position in ms (requires timeline). */
  async seek(timeMs: number): Promise<void> {
    this.emitter.emit('seeking', { targetTime: timeMs });
    await this.engine.seek(timeMs);
    this._currentTime = timeMs;
    this.emitter.emit('seeked', { currentTime: timeMs });
  }

  /**
   * Set quality level by index, or 'auto' for ABR.
   *
   * When a number is passed, ABR is disabled and the engine switches
   * to the specified track. `_currentLevel` is NOT updated until the
   * `quality_switched` event fires (deferred commit).
   *
   * When 'auto' is passed, ABR is re-enabled on the engine.
   */
  async setQuality(levelIndex: number | 'auto'): Promise<void> {
    if (levelIndex === 'auto') {
      this._autoQuality = true;
      this.engine.setAutoQuality(true);
      return;
    }
    if (levelIndex < 0 || levelIndex >= this._levels.length) return;
    this._autoQuality = false;
    this.engine.setAutoQuality(false);
    const level = this._levels[levelIndex]!;
    await this.engine.selectVideoTrack(level.trackName, 'manual');
  }

  /** Set audio track by index. */
  setAudioTrack(index: number): void {
    if (index >= 0 && index < this._audioTracks.length) {
      this._currentAudioTrack = index;
      // TODO: route to engine audio track switch when API is available
    }
  }

  /** Set volume (0–1). Does NOT activate audio — use unmute() for that. */
  setVolume(vol: number): void {
    this._volume = this.clampVolume(vol);
    this.applyVolumeState();
    this.emitter.emit('volumechange', { volume: this.volume, muted: this.muted });
  }

  /** Mute audio. */
  mute(): void {
    this._muted = true;
    this.applyVolumeState();
    this.emitter.emit('volumechange', { volume: this.volume, muted: this.muted });
  }

  /**
   * Unmute audio. If audio has not been prepared yet (audioActivation: 'gesture'),
   * this creates the AudioContext and activates the deferred audio output.
   * **Call from a user gesture** to satisfy browser autoplay policy.
   */
  async unmute(): Promise<void> {
    await this.prepareAudio();
    this._muted = false;
    this.applyVolumeState();
    this.emitter.emit('volumechange', { volume: this.volume, muted: this.muted });
  }

  /**
   * Toggle mute on/off. On first unmute with audioActivation: 'gesture',
   * creates the AudioContext (async). Returns a Promise — safe to ignore
   * if you don't need to await audio readiness.
   */
  async toggleMute(): Promise<void> {
    if (this._muted) {
      await this.unmute();
    } else {
      this.mute();
    }
  }

  /**
   * Prepare audio for playback. Creates AudioContext (WebCodecs path only),
   * attaches the audio-aligned clock, creates VolumeController, and activates
   * the deferred audio output.
   *
   * For CMAF/MSE playback, the HTMLVideoElement owns audio — no AudioContext
   * is created. Safe to call either way.
   *
   * **Call from a user gesture** to satisfy browser autoplay policy.
   *
   * Safe to call multiple times — returns the same promise if already in progress.
   * Retries on failure (does not latch on rejected resume).
   */
  async prepareAudio(): Promise<void> {
    // CMAF/MSE path: HTMLVideoElement owns audio. No AudioContext needed.
    if (this._activeMediaType === 'video') return;

    if (this._prepareAudioPromise) return this._prepareAudioPromise;

    this._prepareAudioPromise = (async () => {
      this.ensureAudioContext();
      await this.audioCtx!.resume();

      // Activate deferred audio output — real WebAudioOutput starts receiving data.
      // The deferred output may or may not have been wired into the pipeline yet
      // (depends on whether createAudioOutput factory has fired). Either way,
      // activating it now means any subsequent or queued schedule() calls forward
      // to the real output.
      if (!this.deferredAudio.isActive) {
        const dest = this.volumeCtrl?.destinationNode;
        // Delay unification: the shared playout cushion arrives inside
        // renderTimeUs (CommandDispatcher adds getPlaybackDelayUs) — the
        // output must not add a second, divergent delay of its own.
        const real = new WebAudioOutput(this.audioCtx!, dest, 0, this.audioClock);
        this.deferredAudio.activate(real);
      }
    })();

    try {
      await this._prepareAudioPromise;
    } catch (err) {
      // Reset so next call retries instead of returning a rejected promise
      this._prepareAudioPromise = null;
      throw err;
    }
  }

  // ─── Event API ───────────────────────────────────────────────────

  /**
   * Subscribe to a player event. Returns an unsubscribe function.
   *
   * ```ts
   * const unsub = player.on('timeupdate', (e) => seekBar.value = e.currentTime);
   * // later:
   * unsub();
   * ```
   */
  on<K extends keyof PlayerEventMap>(
    event: K,
    handler: (data: PlayerEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /** Unsubscribe from a player event. */
  off<K extends keyof PlayerEventMap>(
    event: K,
    handler: (data: PlayerEventMap[K]) => void,
  ): void {
    this.emitter.off(event, handler);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  /** Destroy the player and release all resources. */
  async destroy(): Promise<void> {
    this.timeCtrl?.stop();
    this.stopStatsTimer();
    this.renderer?.destroy();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      await this.audioCtx.close();
    }
    this.audioClock.detachAudioContext();
    await this.engine.destroy();

    // Remove owned DOM elements (never touch caller-provided elements).
    // ownsCanvas/ownsVideo are only true when container was non-null (invariant),
    // so the optional chaining on container is a safety net only.
    if (this.ownsCanvas && this.canvas?.parentNode === this.container) {
      this.container?.removeChild(this.canvas);
    }
    if (this.ownsVideo && this.videoElement?.parentNode === this.container) {
      this.container?.removeChild(this.videoElement);
    }

    this.setState('idle');
  }

  // ─── Private: MoqtPlayer Config ──────────────────────────────────────

  private buildMoqtPlayerConfig(): MoqtPlayerConfig {
    const opts = this.options;
    const draftVersion = opts.draftVersion ?? DEFAULTS.draftVersion;

    const base: MoqtPlayerConfig = {
      url: opts.url,
      namespace: opts.namespace,
      draftVersion,
      autoQuality: opts.autoQuality ?? DEFAULTS.autoQuality,
      startLevel: opts.startLevel ?? DEFAULTS.startLevel,
      clock: this.audioClock,
      createTransport: createWebTransport({
        ...(opts.certHash ? { certHash: opts.certHash } : {}),
        draftVersion,
      }),
      createConnection: () => new MoqtConnection(draftVersion),
    };

    if (this.strategy === 'webcodecs') {
      Object.assign(base, {
        createVideoDecoder: () => new WebCodecsVideoDecoder(),
        createAudioDecoder: () => new WebCodecsAudioDecoder(),
        createRenderer: () => {
          this.renderer = new CanvasRenderer(this.canvas!, { clock: this.audioClock });
          return this.renderer;
        },
        createAudioOutput: () => {
          if (this.options.audioActivation === 'gesture') {
            // Deferred: drops audio until prepareAudio()/unmute() from user gesture
            return this.deferredAudio;
          }
          // Eager: create AudioContext immediately (backward compat)
          this.ensureAudioContext();
          const dest = this.volumeCtrl?.destinationNode;
          // Delay unification: the shared playout cushion arrives inside
          // renderTimeUs (CommandDispatcher adds getPlaybackDelayUs) — the
          // output must not add a second, divergent delay of its own.
          return new WebAudioOutput(this.audioCtx!, dest, 0, this.audioClock);
        },
      });
    }

    Object.assign(base, {
      createMediaSource: () => new MseMediaSource(this.videoElement!),
      createCmafAssembler: (opts: { onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array) => void }) =>
        new CmafAssembler(opts),
    });

    if (opts.maxResolution) {
      (base as unknown as Record<string, unknown>).capLevelToResolution = opts.maxResolution;
    }
    if (opts.targetLatencyMs !== undefined) {
      (base as unknown as Record<string, unknown>).targetLatencyMs = opts.targetLatencyMs;
    }
    if (opts.authTokens) {
      (base as unknown as Record<string, unknown>).authTokens = opts.authTokens;
    }

    // Power-user escape hatch: merge moqtPlayerConfig overrides last
    if (opts.moqtPlayerConfig) {
      Object.assign(base, opts.moqtPlayerConfig);
    }

    return base;
  }

  // ─── Private: Event Bridging ─────────────────────────────────────

  private wireEngineEvents(): void {
    this.engine.on('catalog_received', (e) => {
      this._levels = mapLevels(e.catalog);
      this._audioTracks = mapAudioTracks(e.catalog);
      const hasCmaf = e.catalog.tracks.some(track => track.packaging === 'cmaf');

      // Record which element is the active render sink so callers can react.
      this._activeMediaType = hasCmaf ? 'video' : 'canvas';
      this.applyVolumeState();

      // Only toggle visibility on elements the Player created itself.
      // Caller-provided (borrowed) elements are never mutated.
      if (this.ownsCanvas && this.canvas) this.canvas.hidden = hasCmaf;
      if (this.ownsVideo && this.videoElement) this.videoElement.hidden = !hasCmaf;
      this.emitter.emit('ready', {
        levels: this._levels,
        audioTracks: this._audioTracks,
        duration: this._duration,
      });
      this.emitter.emit('levelsloaded', { levels: this._levels });
      if (this.options.autoplay ?? DEFAULTS.autoplay) this.play();
    });

    this.engine.on('first_frame', () => {
      this.emitter.emit('playing', {});
    });

    this.engine.on('stall', (e) => {
      this.emitter.emit('stall', { durationMs: e.durationMs });
    });

    this.engine.on('state_changed', (e) => {
      if (e.to === 'ended') {
        this.timeCtrl?.stop();
        this.stopStatsTimer();
        this.setState('ended');
        this.emitter.emit('ended', {});
      }
    });

    this.engine.on('quality_switched', (e) => {
      const level = this._levels.find(l => l.trackName === e.toTrackName);
      if (level) {
        this._currentLevel = level.index;
        this.emitter.emit('qualitychange', { level, auto: this._autoQuality });
      }
    });

    this.engine.on('duration_changed', (e) => {
      this._duration = e.durationMs;
      this.emitter.emit('durationchange', { duration: e.durationMs });
    });

    this.engine.on('error', (e) => {
      const severity = e.error.severity === 'fatal' ? 'fatal' as const : 'recoverable' as const;
      this.emitter.emit('error', {
        severity,
        code: e.error.code,
        message: e.error.message,
      });
      if (severity === 'fatal') {
        this.setState('error');
      }
    });
  }

  // ─── Private: State ──────────────────────────────────────────────

  private setState(state: PlayerState): void {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    // Avoid emitting during destroy after listeners are cleared
    if (prev !== 'idle' || state !== 'idle') {
      this.emitter.emit('statechange', { state });
    }
  }

  // ─── Private: Audio ──────────────────────────────────────────────

  private ensureAudioContext(): void {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext();
    this.audioClock.attachAudioContext(this.audioCtx);
    this.volumeCtrl = new VolumeController(this.audioCtx, {
      initialVolume: this._volume,
      initialMuted: this._muted,
    });
  }

  /**
   * Apply current volume/mute state to whichever sink is active.
   *
   * - CMAF/MSE path: HTMLVideoElement owns audio playout.
   * - LOC/WebCodecs path: WebAudioOutput graph owns audio playout.
   */
  private applyVolumeState(): void {
    if (this._activeMediaType === 'video' && this.videoElement) {
      this.videoElement.volume = this._volume;
      this.videoElement.muted = this._muted;
      return;
    }

    if (this.strategy === 'webcodecs') {
      // Don't create AudioContext from volume/mute state changes in gesture mode.
      // Audio activation only happens via prepareAudio()/unmute().
      if (this.options.audioActivation !== 'gesture') {
        this.ensureAudioContext();
      }
      this.volumeCtrl?.setVolume(this._volume);
      this.volumeCtrl?.setMuted(this._muted);
    }
  }

  private clampVolume(vol: number): number {
    return Math.max(0, Math.min(1, vol));
  }

  // ─── Private: Stats ──────────────────────────────────────────────

  private startStatsTimer(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      this.emitter.emit('stats', this.stats);
    }, 1000);
  }

  private stopStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }
}
