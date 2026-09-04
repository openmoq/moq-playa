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

import type { VideoChunkInit, AudioChunkInit } from '@moqt/loc';

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
  decode(chunk: VideoChunkInit, renderTimeUs: number): void;

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

  /** Callback: decoded frame ready for rendering. */
  onFrame: ((frame: unknown, renderTimeUs: number) => void) | null;

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
  decode(chunk: AudioChunkInit, renderTimeUs: number): void;

  /** Flush pending audio data. */
  flush(): Promise<void>;

  /** Reset the decoder. */
  reset(): void;

  /** Current decode queue depth. */
  readonly queueDepth: number;

  /** Callback: decoded audio data ready for playout. */
  onData: ((data: unknown, renderTimeUs: number) => void) | null;

  /** Callback: decode error occurred. */
  onError: ((error: Error) => void) | null;

  /** Release all resources. */
  destroy(): void;
}

// ─── Layer 4: Renderer and Audio Output (Swappable) ──────────────────

/**
 * Video renderer interface — draws decoded frames to a display surface.
 *
 * Implementations: Canvas2D, WebGL, OffscreenCanvas.
 * MUST call frame.close() after rendering (GPU memory management).
 */
export interface VideoRendererLike {
  /** Enqueue a decoded frame for presentation at the specified time. */
  enqueue(frame: unknown, renderTimeUs: number): void;

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
export interface AudioOutputLike {
  /** Schedule an audio chunk for playout. */
  schedule(data: unknown, renderTimeUs: number): void;

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
  ): void;

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
 * The concrete implementation lives in @moqt/browser.
 *
 * @see draft-ietf-moq-cmsf-01 §3.3 (Object Packaging — moof+mdat)
 */
export interface CmafAssemblerLike {
  push(
    mediaType: 'video' | 'audio',
    trackName: string,
    groupId: bigint,
    payload: Uint8Array,
  ): void;
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
  selectTrack?(mediaType: 'video' | 'audio', trackName: string): void;
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
