/**
 * WebAudioOutput — schedules decoded audio for playout via AudioContext.
 *
 * Implements AudioOutputLike for use with CommandDispatcher.
 * Uses AudioBufferSourceNode for sample-accurate scheduling.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 * @see draft-ietf-moq-loc-01 §2.3.3.1 (AudioLevel for silence optimization)
 * @module
 */

import type { AudioOutputLike, AudioScheduleObservation, AudioScheduleObserver, AudioScheduleReason } from '@openmoq/player';
import type { ClockSource } from '@openmoq/playback';


/**
 * WebAudio playout behind AudioOutputLike.
 *
 * Schedules decoded AudioData as AudioBufferSourceNodes aligned with
 * the pipeline's render timeline (CaptureTimestamp-based A/V sync).
 * Maps renderTimeUs (performance.now domain) → AudioContext.currentTime
 * so audio playout is synchronized with video frame presentation.
 *
 * Falls back to seamless back-to-back chaining when render times would
 * cause overlap (contiguous samples) or when audio needs to catch up.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 */
export class WebAudioOutput implements AudioOutputLike {
  private readonly audioCtx: AudioContext;

  /**
   * Audio destination node. Sources connect here instead of directly
   * to audioCtx.destination. Defaults to audioCtx.destination but can
   * be overridden to insert a GainNode for volume control.
   */
  private readonly destination: AudioNode;

  /**
   * Next scheduled playout time in AudioContext.currentTime units.
   * Tracks the end of the last scheduled buffer for seamless playback.
   */
  private nextScheduledTime: number | null = null;

  /** Active source nodes — tracked for flush/destroy. */
  private readonly activeSources: AudioBufferSourceNode[] = [];
  private destroyed = false;
  private scheduleRevision = 0;
  private scheduleObservers: Set<AudioScheduleObserver> | undefined;
  // No PCM or source history: only observed, currently owned source nodes.
  private scheduleTokens: WeakMap<AudioBufferSourceNode, object> | undefined;

  /**
   * No pre-attachment history. Detach suppresses events without stopping media.
   * Released means the node ended, never proof of audible output. While an
   * AudioContext is suspended, a scheduled node may remain pending indefinitely.
   */
  observeSchedules(observer: AudioScheduleObserver): () => void {
    if (typeof observer !== 'function') throw new TypeError('Expected a schedule observer');
    const listeners = this.scheduleObservers ??= new Set();
    const member: AudioScheduleObserver = event => observer(event);
    listeners.add(member);
    return () => {
      listeners.delete(member);
      if (this.scheduleObservers === listeners && listeners.size === 0) this.scheduleObservers = undefined;
    };
  }

  private observeSchedule(token: object, state: AudioScheduleObservation['state'], reason: AudioScheduleReason | null,
      stillScheduled?: () => boolean): void {
    const listeners = this.scheduleObservers;
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (this.scheduleObservers !== listeners || !listeners.has(listener)) continue;
      if (stillScheduled && !stillScheduled()) break;
      try { const pending = listener({ token, state, reason }); if (pending) void Promise.resolve(pending).catch(() => {}); }
      catch { /* Optional observations cannot interrupt scheduling. */ }
    }
  }

  private finishSource(source: AudioBufferSourceNode, state: 'released' | 'discarded', reason: AudioScheduleReason | null): void {
    const idx = this.activeSources.indexOf(source);
    if (idx !== -1) this.activeSources.splice(idx, 1);
    const token = this.scheduleTokens?.get(source);
    this.scheduleTokens?.delete(source);
    if (token !== undefined) this.observeSchedule(token, state, reason);
  }

  /**
   * Scheduled-buffer ring for playhead observability: which capture
   * timestamp is coming out of the speakers right now. One entry per
   * scheduled buffer; pruned lazily once playout passes a buffer's end.
   * `captureUs` is the decoded AudioData.timestamp — WebCodecs preserves
   * the EncodedAudioChunk timestamp, which LOC sets to CaptureTimestamp.
   */
  private readonly scheduledRing: Array<{
    captureUs: number;
    startSec: number;
    durSec: number;
    rate: number;
  }> = [];

  /** Current playback rate for live catch-up. @see draft-ietf-moq-msf-00 §5.1.16 */
  private _playbackRate = 1.0;

  /**
   * Local playback delay in seconds, applied at anchor/re-anchor time.
   *
   * Delay unification: integrated players pass 0 here — the shared playout
   * cushion (the same adaptive value the video render-time recompute uses)
   * arrives INSIDE `renderTimeUs`, applied upstream by the CommandDispatcher.
   * A non-zero value here is a second, independent delay policy that can
   * diverge from video's and re-assert that divergence on every underrun
   * re-anchor (A/V skew) — with the dispatcher composition it double-delays
   * audio. The default is therefore 0; pass a value only when using this
   * class standalone, without the dispatcher's cushion.
   */
  private readonly playbackDelaySec: number;

  /** Shared clock — when audio-backed, eliminates drift in toAudioCtxTime(). */
  private readonly clock: ClockSource;

  constructor(audioCtx: AudioContext, destination?: AudioNode, playbackDelayMs = 0, clock?: ClockSource) {
    this.audioCtx = audioCtx;
    this.destination = destination ?? audioCtx.destination;
    this.playbackDelaySec = playbackDelayMs / 1000;
    this.clock = clock ?? { now: () => performance.now() * 1000 };
  }

  /**
   * Convert renderTimeUs (pipeline clock domain) to AudioContext.currentTime seconds.
   *
   * Uses the shared clock for the delta computation. When the clock is audio-backed
   * (AudioAlignedClock), clock.now() and audioCtx.currentTime are on the same
   * oscillator — the delta has zero drift. When performance-backed, equivalent
   * to the original performance.now() conversion.
   */
  private toAudioCtxTime(renderTimeUs: number): number {
    const nowUs = this.clock.now();
    const deltaSec = (renderTimeUs - nowUs) / 1_000_000;
    return this.audioCtx.currentTime + deltaSec;
  }

  /**
   * Schedule an audio chunk for playout.
   *
   * Decodes AudioData to AudioBuffer, schedules via AudioBufferSourceNode.
   * Uses renderTimeUs to align with video, but ensures seamless back-to-back
   * when samples are contiguous.
   *
   * @param data AudioData from the decoder output callback
   * @param renderTimeUs Render time in microseconds (pipeline clock domain)
   *
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for A/V sync)
   */
  schedule(data: unknown, renderTimeUs: number, inputToken?: object): void {
    const audioData = data as AudioData;
    const token = this.scheduleObservers && inputToken !== undefined ? inputToken : undefined;
    if (this.destroyed) {
      try { audioData.close(); }
      finally { if (token !== undefined) this.observeSchedule(token, 'discarded', 'destroyed'); }
      return;
    }
    const revision = this.scheduleRevision;
    let source: AudioBufferSourceNode | undefined;
    let registered = false;
    try {
      let buf: AudioBuffer;
      let captureUs: number;
      try {
        // Copy decoded PCM into an AudioBuffer.
        // AudioData holds native memory — close() is required.
        buf = this.audioCtx.createBuffer(
          audioData.numberOfChannels,
          audioData.numberOfFrames,
          audioData.sampleRate,
        );

        for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
          const dest = buf.getChannelData(ch);
          audioData.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
        }
        // Capture timeline position of this buffer — read BEFORE close().
        captureUs = audioData.timestamp;
      } finally { audioData.close(); }
      if (this.destroyed || this.scheduleRevision !== revision) {
        if (token !== undefined) this.observeSchedule(token, 'discarded', this.destroyed ? 'destroyed' : 'flushed');
        return;
      }

      const now = this.audioCtx.currentTime;

      // Audio scheduling strategy:
      // - Normal playback: chain back-to-back (nextScheduledTime) for
      //   seamless, gap-free audio. Using targetTime per-sample causes
      //   drift when samples arrive in bursts from the jitter buffer.
      // - After stall/gap: snap to sync-aligned targetTime to re-sync
      //   with video (nextScheduledTime is in the past).
      // - playbackDelaySec matches the video output delay so both media
      //   types start at the same wall-clock offset.
      let startTime: number;
      if (this.nextScheduledTime !== null && this.nextScheduledTime >= now) {
        // Normal playback — back-to-back for seamless audio
        startTime = this.nextScheduledTime;
      } else if (renderTimeUs > 0) {
        // After stall — jump to sync-aligned position + playback delay
        startTime = Math.max(this.toAudioCtxTime(renderTimeUs) + this.playbackDelaySec, now);
      } else {
        // No render time (sync not established) — start from now + delay
        startTime = now + this.playbackDelaySec;
      }

      // Schedule for playout.
      source = this.audioCtx.createBufferSource();
      const owned = source;
      source.buffer = buf;
      source.playbackRate.value = this._playbackRate;
      // Own the source before calling start: wrappers may synchronously stop or end it.
      this.activeSources.push(source);
      registered = true;
      if (token !== undefined) (this.scheduleTokens ??= new WeakMap()).set(source, token);
      let starting = true;
      let ended = false;
      source.onended = () => {
        if (starting) { ended = true; return; }
        this.finishSource(owned, 'released', null);
      };
      source.connect(this.destination);
      if (this.destroyed || this.scheduleRevision !== revision) {
        this.finishSource(source, 'discarded', this.destroyed ? 'destroyed' : 'flushed');
        try { source.stop(); } catch { /* Not started. */ }
        try { source.disconnect(); } catch { /* Already disconnected. */ }
        return;
      }
      // A reentrant cancellation already consumed this source and its terminal.
      if (!this.activeSources.includes(source)) return;
      source.start(startTime);
      starting = false;
      if (this.destroyed || this.scheduleRevision !== revision || !this.activeSources.includes(source)) return;
      // Commit timeline state before notifying; reentrant flush must remain authoritative.
      this.nextScheduledTime = startTime + buf.duration / this._playbackRate;
      this.scheduledRing.push({ captureUs, startSec: startTime, durSec: buf.duration / this._playbackRate, rate: this._playbackRate });
      if (token !== undefined) this.observeSchedule(token, 'scheduled', null, () => this.scheduleTokens?.get(owned) === token);
      if (ended) this.finishSource(source, 'released', null);
    } catch (error) {
      if (source) {
        this.finishSource(source, 'discarded', 'schedule failed');
        try { source.disconnect(); } catch { /* Preserve the scheduling error. */ }
      }
      if (!registered && token !== undefined) this.observeSchedule(token, 'discarded', 'schedule failed');
      throw error;
    }
  }

  /**
   * Set playback rate for live catch-up.
   * Applied to each new AudioBufferSourceNode on schedule().
   * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
   */
  setPlaybackRate(rate: number): void {
    this._playbackRate = rate;
  }

  /**
   * The capture timestamp (µs) at the AUDIO GRAPH's playhead — i.e. the
   * position `AudioContext.currentTime` has reached in the scheduled-buffer
   * ring. NOT literal speaker output: hardware/output latency
   * (`AudioContext.outputLatency`, typically 10-40ms) is not applied here;
   * if measured skew shows a consistent offset, that is a later calibration
   * concern, not noise. Returns null when the graph is silent: nothing
   * scheduled, playout not yet started (first-anchor delay), or playout has
   * run past the last scheduled buffer (starvation).
   *
   * Observability only — the LOC A/V skew measurement compares this against
   * the video frame's CaptureTimestamp at render time. Exact across chained
   * buffers and playbackRate changes (rate recorded per buffer at schedule).
   */
  playheadCaptureUs(): number | null {
    const now = this.audioCtx.currentTime;
    // Lazy prune: drop buffers whose playout has fully passed.
    let firstLive = 0;
    while (firstLive < this.scheduledRing.length
        && this.scheduledRing[firstLive]!.startSec + this.scheduledRing[firstLive]!.durSec <= now) {
      firstLive++;
    }
    if (firstLive > 0) this.scheduledRing.splice(0, firstLive);

    const playing = this.scheduledRing[0];
    if (!playing || now < playing.startSec) return null; // silent: starved or not yet started
    const intoBufferSec = now - playing.startSec;
    return playing.captureUs + intoBufferSec * playing.rate * 1_000_000;
  }

  /** Cancel all scheduled audio. */
  flush(): void {
    this.scheduleRevision++;
    const sources = this.activeSources.splice(0);
    this.scheduledRing.length = 0;
    this.nextScheduledTime = null;
    // Detach ALL token ownership before stop/onended or observers can reenter.
    const tokens = sources.map(source => {
      const token = this.scheduleTokens?.get(source);
      this.scheduleTokens?.delete(source);
      return token;
    });
    const reason = this.destroyed ? 'destroyed' : 'flushed';
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]!;
      try { source.stop(); } catch { /* Already stopped or not started. */ }
      try { source.disconnect(); } catch { /* Already disconnected. */ }
      const token = tokens[i];
      if (token !== undefined) this.observeSchedule(token, 'discarded', reason);
    }
  }

  /**
   * Current playout position in microseconds.
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
   */
  get currentPlayoutTimeUs(): number {
    return this.audioCtx.currentTime * 1_000_000;
  }

  /** Release resources. */
  destroy(): void {
    this.destroyed = true;
    this.flush();
  }
}
