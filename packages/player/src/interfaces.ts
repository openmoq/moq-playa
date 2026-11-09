/**
 * Browser adapter interfaces — contracts for swappable layers.
 *
 * The player defines these interfaces but does NOT implement them.
 * Browser adapters (WebCodecs, MSE, WASM) implement them and are
 * injected via MoqtPlayerConfig factory functions.
 *
 * Uses `unknown` for browser-only types (VideoFrame, AudioData)
 * since this package runs in Node.js for testing.
 *
 * @see draft-ietf-moq-loc-01 §2 (LOC payload = WebCodecs chunk data)
 * @see draft-ietf-moq-loc-01 §2.3.2.1 (Video Config = VideoDecoderConfig.description)
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF packaging for MSE fallback)
 * @module
 */

import type { VideoChunkInit, AudioChunkInit, SourceTimestamp } from '@openmoq/loc';
import type { VideoRenderTiming, AudioRenderTiming } from '@openmoq/playback';
import type { FractionUs, PresentationPlacement } from './presentation-placement.js';

// ─── Layer 3: Decoder Backend (Swappable) ────────────────────────────

/**
 * Video decoder interface — consumes decoder commands, produces decoded frames.
 *
 * Implementations wrap WebCodecs VideoDecoder, MSE SourceBuffer,
 * or WASM decoders (libav.js).
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream format)
 */
export interface VideoDecoderLike {
  /** Explicit capability: preserves producing timing, or reports null if association is lost. */
  readonly supportsOutputTiming?: true;
  /**
   * Configure the decoder with codec extradata.
   *
   * @param config Codec-specific configuration bytes (e.g., SPS/PPS for H.264, ConfigOBU for AV1).
   *               Maps to VideoDecoderConfig.description.
   * @param codec Codec string from MSF catalog (e.g., "avc1.42001f", "av01.0.08M.10").
   * @param width Coded width from MSF catalog. Maps to VideoDecoderConfig.codedWidth.
   * @param height Coded height from MSF catalog. Maps to VideoDecoderConfig.codedHeight.
   *
   * @see draft-ietf-moq-loc-01 §2.3.2.1 (Video Config extension)
   * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
   * @see draft-ietf-moq-msf-00 §5.1.29 (width)
   * @see draft-ietf-moq-msf-00 §5.1.30 (height)
   */
  configure(config: Uint8Array, codec: string, width?: number, height?: number): void;

  /**
   * Decode a video chunk. Frames are delivered via the onFrame callback.
   * @see draft-ietf-moq-loc-01 §2 (LOC payload = EncodedVideoChunk.data)
   */
  decode(chunk: VideoChunkInit, renderTimeUs: number, inputToken?: object, renderTiming?: VideoRenderTiming): void;

  /** Flush pending frames. Resolves when all pending frames are decoded. */
  flush(): Promise<void>;

  /**
   * Reset the decoder (e.g., after a gap or quality switch).
   * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
   */
  reset(): void;

  /**
   * Current decode queue depth. Used for backpressure decisions.
   * @see draft-ietf-moq-transport-16 §7 (Priority scheduling)
   */
  readonly queueDepth: number;

  /**
   * Optional native queue progress, independent of VideoFrames or output readiness.
   * Each registration owns its unsubscribe; ending one must not remove another.
   * Notify only for the current configured native decoder generation.
   */
  observeQueueDepth?(observer: () => void): () => void;

  /**
   * Callback: decoded frame ready for rendering. Optional source time belongs to
   * this output's decode input; null/omitted means unavailable, never guessed from
   * the latest input or catalog. It is not a render observation or track identity.
   */
  // Omitted timing retains ordinary scheduling. Explicit null refuses mapped
  // output whose input association is ambiguous, unsafe or no longer retained.
  onFrame: ((frame: unknown, renderTimeUs: number, sourceTimestamp?: SourceTimestamp | null, inputToken?: object,
    renderTiming?: VideoRenderTiming | null) => void) | null;

  /** Callback: decode error occurred. */
  onError: ((error: Error) => void) | null;

  /** Release all resources. */
  destroy(): void;
}

/**
 * Audio decoder interface — parallel structure to video.
 *
 * @see draft-ietf-moq-loc-01 §4.1 (audio object mapping)
 */
export interface AudioDecoderLike {
  /** Preserves producing timing or explicitly reports an unproven association. */
  readonly supportsOutputTiming?: true;
  /**
   * Configure the decoder with codec parameters.
   *
   * @param config Codec-specific configuration bytes (may be empty for self-describing codecs like Opus).
   * @param codec Codec string from MSF catalog (e.g., "mp4a.40.2", "opus").
   * @param sampleRate Sample rate in Hz from MSF catalog.
   * @param channels Number of audio channels from MSF catalog channelConfig.
   *
   * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
   * @see draft-ietf-moq-msf-00 §5.1.25 (samplerate)
   * @see draft-ietf-moq-msf-00 §5.1.26 (channelConfig)
   * @see draft-ietf-moq-loc-01 §4.1 (audio is independently decodable)
   */
  configure(config: Uint8Array, codec: string, sampleRate?: number, channels?: number): void;

  /**
   * Decode an audio chunk. Data is delivered via the onData callback.
   * @see draft-ietf-moq-loc-01 §2 (LOC payload = EncodedAudioChunk.data)
   */
  decode(chunk: AudioChunkInit, renderTimeUs: number, inputToken?: object, renderTiming?: AudioRenderTiming): void;

  /** Flush pending audio data. */
  flush(): Promise<void>;

  /** Reset the decoder. */
  reset(): void;

  /** Current decode queue depth. */
  readonly queueDepth: number;

  /**
   * Optional native queue progress, independent of PCM or output readiness.
   * Each registration owns its unsubscribe; ending one must not remove another.
   * Notify only for the current native decoder generation.
   */
  observeQueueDepth?(observer: () => void): () => void;

  /** Callback: decoded audio data ready for playout. */
  // Omitted = ordinary scheduling; null = armed producing association unavailable.
  onData: ((data: unknown, renderTimeUs: number, inputToken?: object,
    outputTiming?: AudioProducedTiming | null) => void) | null;

  /** Callback: decode error occurred. */
  onError: ((error: Error) => void) | null;

  /** Release all resources. */
  destroy(): void;
}

// ─── Layer 4: Renderer and Audio Output (Swappable) ──────────────────

/** Historical render evidence, not a content playhead or seek-completion signal. */
export interface VideoPresentation {
  /** Decoded frame timestamp in microseconds; null if numeric precision is unavailable. */
  readonly frameTimestampUs: bigint | null;
  /** The decoder timestamp's origin is not inferred from its value. */
  readonly timestampDomain: 'unknown';
  /** Renderer monotonic clock sampled after the successful draw call returns, in microseconds. */
  readonly renderedAtUs: number;
}

/**
 * Video renderer interface — draws decoded frames to a display surface.
 *
 * Implementations: Canvas2D, WebGL, OffscreenCanvas.
 * MUST call frame.close() after rendering (GPU memory management).
 */
export type VideoFrameReason = 'destroyed' | 'flushed' | 'late frame' | 'draw failed' | 'completion unproven';
/** Actual decoded output association; presentation still needs the renderer's draw witness. */
export interface VideoProducedTiming {
  readonly context: VideoRenderTiming;
  readonly sourceTimestamp: SourceTimestamp;
}

export interface VideoFrameObservation {
  readonly token: object;
  readonly state: 'scheduled' | 'presented' | 'discarded' | 'unavailable';
  readonly reason: VideoFrameReason | null;
  /** Present only when the decoded output supplied its producing association. */
  readonly outputTiming?: VideoProducedTiming;
}
export type VideoFrameObserver = (event: VideoFrameObservation) => void | Promise<void>;

export interface VideoRendererLike {
  /** Preserves producing timing in actual queue/draw outcomes. */
  readonly supportsOutputTiming?: true;
  /** Most recent successful render observation; null when draw order or timing is unavailable. */
  readonly videoPresentation?: VideoPresentation | null;

  /** Enqueue a decoded frame for presentation at the specified time. */
  enqueue(frame: unknown, renderTimeUs: number, token?: object, outputTiming?: VideoProducedTiming): void;

  /** Optional single presentation tick while the embedding's automatic loop is stopped. */
  renderTick?(nowUs: number): void;

  /** Optional real queue/draw outcomes. No token or event history is retained without observation. */
  observeFrames?(observer: VideoFrameObserver): () => void;

  /** Discard all queued frames. MUST close() all held frames. */
  flush(): void;

  /** Release resources. MUST close() all held frames. */
  destroy(): void;

  /** Callback: first frame was rendered. */
  onFirstFrame: (() => void) | null;

  /** Callback: frame was rendered (for sync feedback). */
  /**
   * Presentation report. `scheduledRenderUs` is optional at this swappable
   * boundary: a custom renderer that cannot report the schedule causes the
   * presentation-drift diagnostic to be suppressed rather than fabricated.
   */
  onFrameRendered: ((captureTimestampUs: bigint, actualRenderUs: number, scheduledRenderUs?: number) => void) | null;

  /** Callback: no frames rendered for longer than stall threshold. */
  onStall: ((durationMs: number) => void) | null;
  /** A detected stall ended with a genuinely rendered frame. Full duration. */
  onStallRecovered?: ((durationMs: number) => void) | null;
  /** Cancel an in-flight stall episode without completing it (pause/seek/destroy). */
  cancelStallEpisode?: (() => void) | null;
}

/**
 * Audio output interface — schedules decoded audio for playout.
 *
 * Implementations: WebAudio AudioContext, MediaRecorder, NullOutput.
 */
/** Proven first decoded PCM point relative to its exact producing input. */
export interface AudioProducedTiming {
  readonly context: AudioRenderTiming;
  /** Safe integral microseconds, including proven native priming advancement. */
  readonly sourceOffsetUs: number;
}

/** Source position at the occupied audio graph head, not literal speaker output. */
export interface AudioSourcePosition {
  readonly epoch: object;
  readonly sourceTimestampUs: bigint;
  /** Bounded fractional offset: decoded start + integer-frame trim + graph progress. */
  readonly sourceOffsetUs: number;
}

export type AudioScheduleReason = 'destroyed' | 'flushed' | 'schedule failed' | 'preroll' | 'timing unavailable';
export interface AudioScheduleObservation {
  readonly token: object;
  readonly state: 'scheduled' | 'discarded' | 'released';
  readonly reason: AudioScheduleReason | null;
}
export type AudioScheduleObserver = (event: AudioScheduleObservation) => void | Promise<void>;

export interface AudioOutputLike {
  /** Producing timing, decoded PCM trim and owned head sampling. */
  readonly supportsOutputTiming?: true;
  /** Explicit activation may enable producing timing later; this is not readiness or a playhead. */
  readonly outputTimingDeferred?: true;
  /** Schedule an audio chunk for playout. */
  schedule(data: unknown, renderTimeUs: number, token?: object, outputTiming?: AudioProducedTiming | null): void;

  /** Null for wrong/retired epoch, unproven source, future data or starvation. */
  sampleSourcePosition?(epoch: object): AudioSourcePosition | null;

  /** Optional scheduling evidence. Released ends ownership, not proof of audible output. */
  observeSchedules?(observer: AudioScheduleObserver): () => void;

  /** Cancel all scheduled audio. */
  flush(): void;

  /**
   * Current playout position in microseconds (for clock bridging).
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
   */
  readonly currentPlayoutTimeUs: number;

  /**
   * Set playback rate for live catch-up. Optional — if not implemented,
   * catch-up degrades to video-only (frame dropping).
   * Rate 1.0 = normal, >1.0 = faster (catching up).
   * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
   */
  setPlaybackRate?(rate: number): void;

  /**
   * The capture timestamp (µs) at the audio graph's playhead, or null when
   * the graph is silent (not started / starved / video-only). Note this is
   * graph position, not literal speaker output — hardware output latency is
   * not applied. Optional — used for A/V skew observability; outputs that
   * cannot map playout position to the capture timeline simply omit it.
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
   */
  playheadCaptureUs?(): number | null;

  /** Release resources. */
  destroy(): void;
}

// ─── Layer 5: MediaSource (CMAF/MSE Fallback) ─────────────────────────

/** Caller-owned opaque identity for one append; use a fresh object for every call. */
export type MediaAppendToken = object;
export type MediaAppendReason = 'destroyed' | 'not attached' | 'stale group' | 'treated as a replay' | 'append error' | 'retype' | 'flushed' | 'decoder reset' | 'append aborted' | 'completion unproven' | 'queue capacity' | 'late segment';
/** A terminal observation; unavailable does not assert a media discard or success. */
export interface MediaAppendObservation {
  readonly token: MediaAppendToken;
  readonly state: 'appended' | 'discarded' | 'unavailable';
  readonly reason: MediaAppendReason | null;
}
export type MediaAppendObserver = (event: MediaAppendObservation) => void | Promise<void>;

/**
 * A one-use permission to cross the buffered hole a live video switch can
 * leave when its history could not be retrieved and the target restarts
 * later than the outgoing track ended.
 *
 * Holding it permits nothing. `activate()` states that the target was
 * adopted. The media source then binds to the first target append submitted
 * afterwards and, if that append succeeds and creates one new buffered range
 * ahead of the outgoing media, may move the playhead once, from the hole in
 * front of that range to its start, when audio and video are both buffered
 * there. Authority comes from where the browser actually placed that append,
 * not from timestamps in the media. If the placement cannot be attributed,
 * or no shared landing appears, nothing is crossed and ordinary buffered-hole
 * handling applies.
 *
 * The crossing is a live recovery, not a seamless switch: media between the
 * playhead and the landing is skipped, including audio that was already
 * buffered. It is never used for finite playback or for a caller-chosen
 * subscription range.
 *
 * Pausing suspends the permission. A seek, a reset, a source or video
 * reconfiguration after activation, a changed video timestamp offset, or a
 * newer reservation ends it. Both calls are idempotent and never throw.
 */
export interface MediaSwitchRecovery {
  activate(): void;
  revoke(): void;
}

/** Native playback-quality counters, scoped to the media element's load.
 * They reset on the HTML media-element load algorithm, not on engine counters
 * or each SourceBuffer reconfiguration. Counts do not identify decoded output.
 */
export interface VideoPlaybackQualityStats {
  readonly totalVideoFrames: number;
  readonly droppedVideoFrames: number;
  /** Derived total minus dropped; not the engine's render-callback counter. */
  readonly displayedVideoFrames: number;
  /** Snapshot creation time in the source realm's performance-clock milliseconds. */
  readonly creationTimeMs: number;
}

/** Queue ownership only; this cannot undo native coded-frame replacement. */
export interface MediaAppendQueueLease {
  readonly current: boolean;
  resume(): void;
  discard(): void;
}

/** Actual native position and containing buffered interval, in seconds. Not a source PTS or paint. */
export interface MediaSeekSample {
  readonly epoch: object;
  readonly resource: object;
  readonly currentTime: number;
  readonly buffered: { readonly start: number; readonly end: number };
  /** Native paused flag when observable; false alone does not prove clock progress. */
  readonly paused?: boolean;
  /** Native effective rate when observable, without assuming forward or 1x playback. */
  readonly playbackRate?: number;
}

/** Bound operations on one fresh native MediaSource; stale views cannot mutate a successor. */
export interface MediaSeekResource {
  readonly epoch: object;
  readonly resource: object;
  readonly current: boolean;
  readonly initialize: MediaSourceLike['initialize'];
  /** After accepted initialize(), wait for this resource's SourceBuffers to exist.
   * Not an append/position/presentation witness. Retirement or initialization failure rejects. */
  whenAttached(): Promise<void>;
  readonly appendChunk: MediaSourceLike['appendChunk'];
  observeAppends(observer: MediaAppendObserver): () => void;
  readonly getTimestampOffset: NonNullable<MediaSourceLike['getTimestampOffset']>;
  readonly setTimestampOffset: NonNullable<MediaSourceLike['setTimestampOffset']>;
  /**
   * Position in native seconds, finite and nonnegative. Returns the actual
   * native sample after owned seek completion, !seeking, current data and
   * buffered coverage. An already-ready fresh zero needs no seeked event.
   * Native clamping/approximation is returned; the caller owns target policy.
   * Supersession/cancellation rejects AbortError. Unproven positioning rejects
   * TimeoutError after a bounded application deadline; native failures reject.
   * Never starts playback. Completion proves native positioning, not a paint.
   */
  position(currentTime: number): Promise<MediaSeekSample>;
  /** Null before positioning or without current-resource native data/coverage. No extrapolation. */
  sample(): MediaSeekSample | null;
  /** Explicit true requires successful positioning; false preserves pause. */
  setPlaybackIntent(intent: boolean): void;
  /** Idempotent retirement, including pending native work; never affects a successor. */
  cancel(): void;
}

/**
 * MediaSource adapter interface for CMAF-packaged tracks.
 *
 * Unlike LOC (which uses VideoDecoderLike + VideoRendererLike + AudioOutputLike),
 * CMAF objects are fed directly to MSE SourceBuffers. The browser handles
 * demuxing, decoding, and rendering internally via `<video>`.
 *
 * This interface manages:
 * - SourceBuffer creation with codec strings from the catalog
 * - Init segment (ftyp+moov) appending from catalog initData
 * - Media segment (moof+mdat) appending from object payloads
 *
 * Implementations: MseMediaSource (browser), mock (tests).
 *
 * @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers)
 * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging — moof+mdat)
 * @see draft-ietf-moq-cmsf-00 §3.5.1 (packaging: "cmaf" in catalog)
 */
export interface MediaSourceLike {
  /**
   * Replace the native MediaSource with a fresh resource, retiring old append
   * work with existing terminal observations. Keeps element/DRM ownership and
   * implementation/attachment choices. Initialization/appending/positioning do
   * not play; request playback explicitly through the positioned resource.
   * Epoch is opaque caller metadata. No source-clock mapping is inferred.
   * reset/destroy/new beginSeek retire the view. Stale writes throw AbortError;
   * stale appends first report an eligible observed discard (decoder reset).
   */
  beginSeek?(epoch: object): MediaSeekResource;

  /** Preserves the optional source key through append ordering, replay and timeline state. */
  readonly supportsTrackIdentity?: true;
  /**
   * Initialize with codec strings and init segment bytes. Creates
   * SourceBuffers and appends the initialization segments (ftyp+moov).
   * Must be called before appendChunk().
   *
   * ALL-OR-NOTHING: an implementation that rejects any entry (unsupported
   * codec, empty init bytes) must create NO SourceBuffers, must remain
   * un-latched (a later corrected call may succeed), and must return
   * `false` after surfacing the reason via onError. `void`/`true`/
   * `undefined` mean success (back-compat with implementations that
   * return nothing).
   *
   * @param config Per-media-type codec string and decoded init bytes
   * @see draft-ietf-moq-cmsf-00 §3.1 (initData → ftyp+moov)
   * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
   */
  initialize(config: {
    video?: { codec: string; initData: Uint8Array };
    audio?: { codec: string; initData: Uint8Array };
  }): boolean | void;

  /**
   * Append a CMAF object payload (moof+mdat pairs) to the SourceBuffer.
   * The raw object payload bytes are appended directly — the adapter
   * does NOT need to parse moof/mdat box boundaries.
   *
   * @param mediaType Which SourceBuffer to append to
   * @param data Raw MOQT object payload (one or more moof+mdat pairs)
   * @param trackName Source MoQ track name. Adapters that maintain
   *                  per-track state (e.g. timeline containment-based
   *                  replay suppression) rely on this to distinguish
   *                  across-track splices (ABR switch) from same-track
   *                  replays.
   * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging)
   */
  appendChunk(
    mediaType: 'video' | 'audio',
    data: Uint8Array,
    trackName: string,
    groupId?: bigint,
    token?: MediaAppendToken,
    sourceKey?: string,
  ): void;

  /**
   * Optional actual append completion/policy outcomes. Each token belongs to
   * one append. No outcome history is replayed on attachment. If no listener
   * exists at submission, the token is not retained. Last-listener detach
   * suppresses events while detached; existing media operations continue.
   * A newly attached listener may observe a later completion of an already
   * token-bearing operation, but no past terminal is replayed.
   */
  observeAppends?(observer: MediaAppendObserver): () => void;

  /**
   * Retain receiving evidence for one current subgroup stream, not an entire
   * group. The caller releases it after FIN/reset AND accepted routing work
   * settles. `isCurrent` captures the registration and source owner; it must
   * not resolve a reused alias. An adapter may bound or decline this evidence.
   * No payload ownership, completion, or presentation is implied. This only
   * extends an already-known positive DTS gap, with a bounded deadline.
   * When supplied, sourceKey is the same opaque identity used for appendChunk
   * and clearTimeline; trackName remains the human-readable label.
   */
  retainReceivingGroup?(mediaType: 'video' | 'audio', trackName: string,
    groupId: bigint, isCurrent: () => boolean, sourceKey?: string): () => void;

  /**
   * Re-initialize a SourceBuffer for a new codec / init segment.
   *
   * Called by the player when a track switch crosses codec families
   * (e.g. AVC → HEVC). Adapters that delegate decoding to the browser
   * (MSE) implement this via `SourceBuffer.changeType()` plus the new
   * track's init segment. Adapters with custom decode pipelines (e.g.,
   * a future canvas-renderer adapter) need not implement it.
   *
   * Resolves once the init segment has been parsed by MSE and the
   * SourceBuffer is ready to accept media bytes for the new codec.
   * Any media bytes queued during the operation are appended after.
   *
   * @param mediaType Which SourceBuffer to retype.
   * @param codec Codec string for the new mime type
   *              (e.g. `"hvc1.1.6.L93.90"`).
   * @param initData Raw init segment bytes (ftyp+moov) for the new codec.
   */
  changeType?(
    mediaType: 'video' | 'audio',
    codec: string,
    initData: Uint8Array,
  ): Promise<void>;

  /**
   * The timestamp offset currently in force for a SourceBuffer.
   *
   * Exists so a caller that must RETAIN an ongoing media timeline across
   * {@link changeType} can put the offset back afterwards. `changeType`
   * rebases to the current playback position, which is right for a track
   * switch — the new track's segments are rebased to ~0 by a fresh per-track
   * epoch — and wrong for a session handover, where the same assembler and
   * the same epoch continue and the replacement's media is already on the
   * running timeline. Adding the playback position there would place the
   * replacement's first segment a full playback position into the future,
   * leaving a gap the element never crosses.
   *
   * Optional: an adapter that does not expose it simply cannot be corrected
   * this way, and the caller leaves the offset alone.
   */
  getTimestampOffset?(mediaType: 'video' | 'audio'): number | undefined;

  /**
   * Rebase a SourceBuffer's media timeline by `offset` seconds.
   *
   * Declared here because the player both establishes the initial offset and
   * must restore it after a {@link changeType} that retains an ongoing
   * timeline. Optional, like the accessor above.
   */
  setTimestampOffset?(mediaType: 'video' | 'audio', offset: number): void;

  /**
   * Retain queued old media during preparation, without cancelling a native
   * append in progress. The caller owns init/offset restoration before resume.
   * Reset/destroy invalidates the lease; current must be checked after awaits.
   */
  holdQueuedAppends?(mediaTypes: readonly ('video' | 'audio')[]): MediaAppendQueueLease;

  /**
   * Reserve a {@link MediaSwitchRecovery} for one video switch target while
   * the outgoing track is still the output. The player calls this only for a
   * live switch whose history retrieval failed, before it retires the
   * outgoing track.
   *
   * Optional. Return null when this source cannot attribute or perform such
   * a crossing now, for example during an owned seek, with video already
   * buffered ahead of the current output, or with no video buffered at or
   * before the playhead. When the method is absent or returns null the
   * player declines that switch and keeps the outgoing track playing, rather
   * than adopt a restart that could strand playback behind a hole. A custom
   * source that does not implement it therefore sees such switches fail with
   * the ordinary switch-failure event. A new reservation replaces the
   * previous one.
   */
  reserveSwitchRecovery?(target: { mediaType: 'video'; trackName: string; sourceKey?: string }): MediaSwitchRecovery | null;

  /** Per-source replay state; display names remain unchanged when an opaque key is supplied. */
  getCommittedGroupFloor?(mediaType: 'video' | 'audio', trackName: string, sourceKey?: string): bigint | undefined;
  clearTimeline?(mediaType: 'video' | 'audio', trackName: string, sourceKey?: string): void;

  /**
   * Signal end of stream. Called on live→ended or destroy().
   */
  endOfStream(): void;

  /**
   * Reset the MediaSource (e.g., quality switch requiring new init segment).
   * Implementations should remove SourceBuffers and prepare for re-initialization.
   */
  reset(): void;

  /**
   * The underlying media element. Used by the player for integration
   * (e.g., reading currentTime, attaching to DOM).
   */
  readonly mediaElement: unknown;

  /**
   * Playable buffer ahead of currentTime in microseconds.
   * Returns null when no trustworthy signal exists yet (pre-startup,
   * currentTime outside all buffered ranges before play). ABR treats
   * null as "hold zone" — no emergency downshift during startup.
   * Returns 0 as a trustworthy starvation signal (play started,
   * currentTime now outside all buffered ranges).
   */
  getBufferAheadUs?(): number | null;

  /** Native element-load-scoped video counters, or null without owned video,
   * support, or valid measurements. A supported all-zero snapshot is observed
   * zero, not unavailable. Optional for existing/custom media adapters.
   */
  getVideoPlaybackQuality?(): Readonly<VideoPlaybackQualityStats> | null;

  /**
   * Whether the media element has attached the MediaSource (MSE
   * `sourceopen`), i.e. SourceBuffers exist and appendChunk() can take
   * effect. Browsers defer that attachment while the document is hidden
   * (background tab). `undefined` means the implementation does not report
   * attachment and is treated as always attached.
   */
  readonly attached?: boolean;

  /** Callback: the MediaSource became attached (SourceBuffers created). */
  onAttached?: (() => void) | null;

  /** Callback: first frame rendered by the media element. */
  onFirstFrame: (() => void) | null;

  /** Callback: SourceBuffer error. */
  onError: ((error: Error) => void) | null;

  /** Callback: playback stall detected. `cause` is set when the adapter
   *  itself resolved the stall by jumping a source hole ('media-gap') —
   *  such stalls are not bandwidth signals. */
  onStall: ((durationMs: number, cause?: 'media-gap') => void) | null;
  /**
   * A detected stall ended with genuine playback resumption. Full duration.
   *
   * No cause parameter: the only causal variant, `media-gap`, is resolved at
   * report time and never completes, so advertising one would describe a
   * lifecycle no producer can emit.
   */
  onStallRecovered?: ((durationMs: number) => void) | null;
  /** Abandon an in-flight stall episode — playback superseded, not recovered. */
  cancelStallEpisode?: () => void;

  /**
   * OPTIONAL callback: the adapter jumped the playhead across a bounded
   * buffered hole (source media missing). Informational; the player wires
   * it into stats and the public `gap_jump` event.
   */
  onGapJump?: ((info: {
    from: number; to: number; holeSec: number; waitedMs: number;
    bufferedRanges: string;
  }) => void) | null;

  /**
   * OPTIONAL playback-intent contract.
   *
   * Arrival of media is not a request to play. Without this, an adapter that
   * starts playback when data lands has a second, implicit owner of startup —
   * it can begin playing while the player is still LOADING or has been paused.
   * The player calls `setPlaybackIntent(true)` on play() and `false` on
   * pause()/destroy(), and re-states the current intent on a media source
   * created later (a player paused before the catalog arrives must not get an
   * adapter that starts anyway). An adapter may buffer freely at any time but
   * must not begin its startup positioning/play sequence until intent is true;
   * withdrawing intent pauses playback that has already started.
   *
   * Optional for backward compatibility: an adapter that does not implement it
   * keeps its previous behavior. The player only states an intent it has
   * actually been given — a player whose play()/pause() was never called leaves
   * the adapter's own default untouched.
   */
  setPlaybackIntent?(intent: boolean): void;

  /** Release all resources (MediaSource, SourceBuffers, object URLs). */
  destroy(): void;
}

// ─── CMAF Segment Assembler ────────────────────────────────────────

/**
 * Interface for a CMAF moof+mdat segment assembler.
 *
 * Pairs moof+mdat objects into complete segments, patches tfdt
 * baseMediaDecodeTime to zero-based, and emits via onSegment.
 * The concrete implementation lives in @openmoq/browser.
 *
 * @see draft-ietf-moq-cmsf-01 §3.3 (Object Packaging — moof+mdat)
 */
export type CmafAssemblyDiscardReason = 'track superseded' | 'invalid media' | 'orphaned media' | 'epoch refused' | 'superseded pending moof' | 'decoder reset' | 'out of order legacy object';

export type CmafSourceReceipt =
  | { readonly state: 'emitted'; readonly sourcePresentationTimeUs: bigint }
  | { readonly state: 'partial' | 'refused' | 'unavailable' };

export interface CmafAssemblerLike {
  /** Separates a source identity key from its display track name throughout assembly. */
  readonly supportsTrackIdentity?: true;
  push(
    mediaType: 'video' | 'audio',
    trackName: string,
    groupId: bigint,
    payload: Uint8Array,
    input?: object,
    sourceTiming?: true,
    sourceKey?: string,
    /** Optional raw Object ID for ordering pending legacy split halves only. */
    objectId?: bigint,
  ): void | CmafSourceReceipt;
  /**
   * Hand the assembler an init segment so it can extract trex defaults
   * (default_sample_duration / size / flags). Required for streams that
   * carry sample defaults only in the init segment (no tfhd defaults,
   * no per-sample fields in trun) — without this the strip path would
   * emit zero-duration samples on rewrite.
   *
   * Optional on the interface for back-compat; assemblers without
   * sample-table surgery may ignore the call.
   */
  setInitSegment?(mediaType: 'video' | 'audio', initBytes: Uint8Array): void;
  /**
   * Commit the track that may feed one media type after a successful switch.
   * Implementations may use this to discard late objects from the retired
   * track. Optional for compatibility with assemblers that do not retain
   * cross-object track state.
   */
  selectTrack?(mediaType: 'video' | 'audio', trackName: string, sourceKey?: string): void;
  /**
   * Map raw audio DTS (and therefore PTS, retaining composition offsets) into
   * the continuing reference domain before epoch/discontinuity processing.
   * Microseconds are bigint; null restores default switching behavior.
   * Video and shared epoch state are unchanged.
   */
  setAudioPresentationOffsetUs?(offsetUs: bigint | null): void;
  /** Stable mapped-domain witness; null after a refused restart or without an active map. */
  getAudioPresentationMappingWitness?(): object | null;
  /** Current, delivery-proven raw-to-rebased context; token changes invalidate preparation. */
  capturePresentationPlacement?(mediaType: 'video' | 'audio'): PresentationPlacement | null;
  /** Explicit absolute placement; raw timestamps and composition offsets are retained. */
  setPresentationPlacement?(mediaType: 'video' | 'audio', anchor: {
    readonly sourceTimeUs: bigint; readonly rebasedTimeUs: FractionUs;
  } | null): void;
  getEpoch(mediaType: 'video' | 'audio'): bigint | null;
  /**
   * Drop pending half-pairs (moof without mdat) for one media type, leaving
   * epochs and the other media type untouched. Used by the media-liveness
   * restart so a stale moof can't pair against a post-restart mdat.
   *
   * Optional on the interface for back-compat; assemblers without pairing
   * state may ignore the call.
   */
  clearPending?(mediaType: 'video' | 'audio'): void;
  reset(): void;
  destroy(): void;
}
