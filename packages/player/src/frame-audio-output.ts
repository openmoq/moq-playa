import type {
  AudioOutputLike, AudioProducedTiming, AudioScheduleObservation, AudioScheduleObserver,
  AudioScheduleReason, AudioSourcePosition,
} from './interfaces.js';

interface Options {
  readonly target: AudioOutputLike;
  readonly maxChunks: number;
  readonly maxBytes: number;
  /** Keep staged PCM while an explicitly deferred target awaits activation. */
  readonly retainDeferred?: boolean;
  /** Coalesced notification of currently retained target-or-later PCM. */
  readonly onPrepared?: () => void;
}
interface PreparedAudio {
  readonly timing: AudioProducedTiming;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
}
interface Entry extends PreparedAudio {
  readonly data: unknown;
  readonly close: () => void;
  readonly renderTimeUs: number;
  readonly token: object | undefined;
  readonly bytes: number;
}
interface Observation {
  readonly tokens: WeakMap<object, { pending: number; scheduled: number }>;
  off?: () => void;
}
type Failure = { error: unknown } | undefined;

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Owns bounded decoded PCM until a fresh output graph can be activated.
 * Producing-timing capability means retention or explicit refusal, not a
 * native scheduling, presentation, or source-position promise.
 */
export class FrameAudioOutput implements AudioOutputLike {
  readonly supportsOutputTiming = true as const;
  private readonly target: AudioOutputLike;
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private readonly retainDeferred: boolean;
  private readonly onPrepared: (() => void) | undefined;
  private preparedNotificationQueued = false;
  private queue: Entry[] = [];
  private bytes = 0;
  private active = false;
  private destroyed = false;
  private revision = 0;
  private draining = false;
  private flushing = false;
  private boundary: AudioScheduleReason | undefined;
  private listeners: Set<AudioScheduleObserver> | undefined;
  private observation: Observation | undefined;
  private retiringObservation: Observation | undefined;
  private pendingRate: number | undefined;
  private rateRevision = 0;

  constructor({ target, maxChunks, maxBytes, retainDeferred = false, onPrepared }: Options) {
    if (!Number.isSafeInteger(maxChunks) || maxChunks <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Invalid prepared audio budget');
    }
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) throw new TypeError('Expected audio output');
    if (typeof retainDeferred !== 'boolean' || onPrepared !== undefined && typeof onPrepared !== 'function') {
      throw new TypeError('Invalid prepared audio options');
    }
    // In particular, do not inspect or subscribe to the raw target here. The
    // caller retains responsibility for it until construction has returned.
    this.target = target; this.maxChunks = maxChunks; this.maxBytes = maxBytes;
    this.retainDeferred = retainDeferred; this.onPrepared = onPrepared;
  }

  get retainedChunkCount(): number { return this.queue.length; }
  /** Deterministic retained PCM accounting (frames × channels × float32 bytes). */
  get retainedBytes(): number { return this.bytes; }
  snapshotPrepared(): readonly PreparedAudio[] {
    return Object.freeze(this.queue.map(entry => Object.freeze({
      timing: entry.timing, numberOfFrames: entry.numberOfFrames, sampleRate: entry.sampleRate,
    })));
  }

  schedule(data: unknown, renderTimeUs: number, token?: object, outputTiming?: AudioProducedTiming | null): void {
    const revision = this.revision;
    let close: (() => void) | undefined;
    let preroll = false;
    let reason: AudioScheduleReason = 'schedule failed';
    try {
      const pcm = data as { close?: () => void; numberOfFrames: number; numberOfChannels: number; sampleRate: number } | null;
      close = pcm?.close;
      if (typeof close !== 'function') throw new TypeError('Expected owned decoded PCM');
      if (this.destroyed || this.boundary !== undefined) {
        reason = this.destroyed ? 'destroyed' : this.boundary!;
        throw new Error('Audio output is not accepting PCM');
      }
      if (token !== undefined && !isObject(token)) throw new TypeError('Expected an object audio token');
      reason = 'timing unavailable';
      const context = outputTiming?.context, sourceOffsetUs = outputTiming?.sourceOffsetUs;
      if (!context || !isObject(context.epoch)) throw new TypeError('Decoded audio needs proven producing timing');
      const sourceTimestampUs = context.sourceTimestampUs, presentFromSourceUs = context.presentFromSourceUs;
      if (typeof sourceTimestampUs !== 'bigint' || typeof presentFromSourceUs !== 'bigint'
          || typeof context.recomputeRenderTimeUs !== 'function'
          || typeof sourceOffsetUs !== 'number' || !Number.isSafeInteger(sourceOffsetUs) || sourceOffsetUs < 0) {
        throw new TypeError('Decoded audio needs proven producing timing');
      }
      reason = 'schedule failed';
      const numberOfFrames = pcm!.numberOfFrames, channels = pcm!.numberOfChannels, sampleRate = pcm!.sampleRate;
      if (![numberOfFrames, channels, sampleRate].every(value => Number.isSafeInteger(value) && value > 0)
          || !Number.isFinite(renderTimeUs)) throw new TypeError('Invalid decoded PCM dimensions or render time');
      if (!this.current(revision)) {
        reason = this.destroyed ? 'destroyed' : 'flushed';
        throw new Error('Decoded PCM admission was retired');
      }
      // Only sample starts on or after the bound may be presented. Subtract
      // exact source points before ceil-grid arithmetic, never Number epochs.
      const beforeUs = presentFromSourceUs - sourceTimestampUs - BigInt(sourceOffsetUs);
      preroll = beforeUs > 0n && (beforeUs * BigInt(sampleRate) + 999_999n) / 1_000_000n >= BigInt(numberOfFrames);
      if (!preroll) {
        const exactBytes = BigInt(numberOfFrames) * BigInt(channels) * 4n;
        if (this.queue.length >= this.maxChunks || exactBytes > BigInt(this.maxBytes - this.bytes)) {
          throw new RangeError('Prepared audio budget exceeded');
        }
        const bytes = Number(exactBytes);
        // The producing context is the owner's identity. Its validated carrier
        // fields belong to this admission, not to a caller's mutable object.
        const timing = Object.freeze({ context, sourceOffsetUs });
        this.queue.push({ data, close, renderTimeUs, token, timing, numberOfFrames, sampleRate, bytes });
        this.bytes += bytes;
      }
    } catch (error) {
      // This invocation still owns incoming PCM. A close failure cannot replace
      // the admission failure, or suppress its diagnostic terminal.
      try { close?.call(data); } catch {}
      if (token !== undefined && isObject(token)) this.emit(token, 'discarded', reason);
      throw error;
    }
    if (preroll) {
      // Outside admission's catch: a failed native close is attempted only once
      // and still has its one preroll terminal, never a second refusal terminal.
      try { close!.call(data); }
      finally { if (token !== undefined) this.emit(token, 'discarded', 'preroll'); }
      return;
    }
    if (this.active) this.drain();
    this.notifyPrepared();
  }

  private notifyPrepared(): void {
    const notify = this.onPrepared;
    if (!notify || this.preparedNotificationQueued || !this.queue.length || !this.current(this.revision)) return;
    this.preparedNotificationQueued = true;
    queueMicrotask(() => {
      this.preparedNotificationQueued = false;
      // This signals the current queue, including an admission after a flush.
      // It never reserves native scheduling or presentation authority.
      if (!this.queue.length || !this.current(this.revision)) return;
      try {
        const pending: unknown = notify();
        if (pending !== undefined) void Promise.resolve(pending).catch(() => {});
      } catch { /* Notifications cannot undo retained PCM ownership. */ }
    });
  }

  /** One-way activation; reentrant schedules join the same ordered drain. */
  activate(): void {
    if (this.destroyed) return;
    this.active = true;
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.destroyed || this.boundary !== undefined) return;
    this.draining = true;
    const revision = this.revision;
    let reason: AudioScheduleReason = 'schedule failed';
    try {
      this.applyRate(revision);
      while (this.current(revision) && this.queue.length) {
        reason = 'timing unavailable';
        if (!this.prepareTarget(revision)) break;
        reason = 'schedule failed';
        this.ensureObservation();
        if (!this.current(revision)) break;
        const schedule = this.target.schedule;
        if (!this.current(revision)) break;
        if (typeof schedule !== 'function') throw new TypeError('Audio target cannot schedule PCM');
        reason = 'timing unavailable';
        if (!this.prepareTarget(revision)) break;
        reason = 'schedule failed';
        const entry = this.queue.shift()!;
        this.bytes -= entry.bytes;
        const observation = this.observation;
        if (observation && entry.token !== undefined) {
          const owned = observation.tokens.get(entry.token) ?? { pending: 0, scheduled: 0 };
          owned.pending++; observation.tokens.set(entry.token, owned);
        }
        // Ownership transfers on invocation, even if the target throws or
        // publishes inline events. Never close this entry in our error path.
        schedule.call(this.target, entry.data, entry.renderTimeUs, entry.token, entry.timing);
        this.applyRate(revision);
      }
    } catch (error) {
      // A reset owns its cleanup; an older drain cannot discard successor PCM.
      if (this.current(revision)) this.discardRetained(reason);
      throw error;
    } finally { this.draining = false; }
  }

  private prepareTarget(revision: number): boolean {
    const capable = this.target.supportsOutputTiming === true;
    if (!this.current(revision)) return false;
    if (capable) return true;
    const deferred = this.target.outputTimingDeferred === true;
    if (!this.current(revision)) return false;
    // Marker access may activate, flush, or retire a custom target. Actual
    // capability wins; a marker alone is never scheduling or position proof.
    const activated = this.target.supportsOutputTiming === true;
    if (!this.current(revision)) return false;
    if (activated) return true;
    if (!deferred) throw new TypeError('Audio target cannot retain producing timing');
    if (this.retainDeferred) return false;
    const failure = this.discardRetained('timing unavailable');
    if (failure) throw failure.error;
    return false;
  }

  observeSchedules(observer: AudioScheduleObserver): () => void {
    if (typeof observer !== 'function') throw new TypeError('Expected a schedule observer');
    if (this.destroyed) return () => {};
    const listeners = this.listeners ??= new Set();
    const member: AudioScheduleObserver = event => observer(event);
    listeners.add(member);
    let removed = false;
    const release = () => {
      if (removed) return;
      removed = true; listeners.delete(member);
      if (this.listeners === listeners && listeners.size === 0) {
        this.listeners = undefined;
        this.detachObservation(this.observation);
      }
    };
    try { this.ensureObservation(); }
    catch (error) { try { release(); } catch {} throw error; }
    return release;
  }

  private ensureObservation(): void {
    const listeners = this.listeners, revision = this.revision;
    if (!this.active || !listeners || this.observation || !this.current(revision)) return;
    const observe = this.target.observeSchedules;
    if (!observe || !this.current(revision) || this.listeners !== listeners) return;
    // A supplied method getter can register and forward PCM reentrantly. Its
    // acquired binding already owns those tokens and must not be displaced.
    if (this.observation !== undefined) return;
    const observation: Observation = { tokens: new WeakMap() };
    this.observation = observation;
    let off: (() => void) | undefined;
    try {
      off = observe.call(this.target, event => this.relay(observation, event));
      if (typeof off !== 'function') throw new TypeError('Audio observation needs cleanup');
    } catch (error) {
      if (this.observation === observation) this.observation = undefined;
      throw error;
    }
    if (this.observation !== observation || !this.current(revision) || this.listeners !== listeners) {
      if (this.observation === observation) this.observation = undefined;
      off(); return;
    }
    observation.off = off;
  }

  private relay(observation: Observation, event: AudioScheduleObservation): void {
    if (this.observation !== observation || this.destroyed && this.retiringObservation !== observation) return;
    const { token, state, reason } = event, revision = this.revision;
    const owned = observation.tokens.get(token);
    if (!owned || owned.pending === 0 || this.observation !== observation
        || this.destroyed && this.retiringObservation !== observation) return;
    if (state === 'scheduled') {
      if (this.destroyed || owned.scheduled >= owned.pending) return;
      owned.scheduled++;
      this.emit(token, state, reason, () => this.current(revision) && this.observation === observation && owned.pending > 0);
    } else if (state === 'released' || state === 'discarded') {
      owned.pending--; owned.scheduled = Math.min(owned.scheduled, owned.pending);
      if (owned.pending === 0) observation.tokens.delete(token);
      this.emit(token, state, reason, () => this.observation === observation
        && (!this.destroyed || this.retiringObservation === observation));
    }
  }

  private detachObservation(observation: Observation | undefined): void {
    if (!observation) return;
    if (this.observation === observation) this.observation = undefined;
    const off = observation.off; delete observation.off;
    off?.();
  }

  private emit(token: object, state: AudioScheduleObservation['state'], reason: AudioScheduleReason | null,
      current?: () => boolean): void {
    const listeners = this.listeners;
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (this.listeners !== listeners || !listeners.has(listener)) continue;
      if (current && !current()) break;
      try {
        const pending = listener({ token, state, reason });
        if (pending) void Promise.resolve(pending).catch(() => {});
      } catch { /* Observations cannot undo ownership or stop cleanup. */ }
    }
  }

  private takeQueue(): Entry[] {
    const queue = this.queue; this.queue = []; this.bytes = 0; return queue;
  }
  private discard(entries: readonly Entry[], reason: AudioScheduleReason): Failure {
    let failure: Failure;
    for (const entry of entries) {
      try { entry.close.call(entry.data); } catch (error) { failure ??= { error }; }
      if (entry.token !== undefined) this.emit(entry.token, 'discarded', reason);
    }
    return failure;
  }
  private discardRetained(reason: AudioScheduleReason): Failure {
    const previous = this.boundary;
    this.boundary = reason;
    try { return this.discard(this.takeQueue(), reason); }
    finally { if (!this.destroyed) this.boundary = previous; }
  }

  flush(): void {
    if (this.destroyed || this.flushing) return;
    const previous = this.boundary;
    this.flushing = true;
    const revision = ++this.revision;
    this.boundary = 'flushed';
    let failure = this.discard(this.takeQueue(), 'flushed');
    try {
      if (!this.destroyed && this.revision === revision) {
        const flush = this.target.flush;
        if (!this.destroyed && this.revision === revision) flush.call(this.target);
      }
    } catch (error) { failure ??= { error }; }
    finally { this.flushing = false; if (!this.destroyed) this.boundary = previous; }
    if (failure) throw failure.error;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.active = false; this.revision++; this.boundary = 'destroyed';
    const queue = this.takeQueue(), observation = this.observation;
    // Native authority is already retired. Only known forwarded-token terminals
    // may pass through this exact binding until synchronous target cleanup ends.
    this.retiringObservation = observation;
    let failure = this.discard(queue, 'destroyed');
    try { this.target.destroy(); } catch (error) { failure ??= { error }; }
    finally {
      this.retiringObservation = undefined;
      try { this.detachObservation(observation); } catch (error) { failure ??= { error }; }
      this.listeners?.clear(); this.listeners = undefined;
    }
    if (failure) throw failure.error;
  }

  private current(revision: number): boolean {
    return !this.destroyed && this.revision === revision && this.boundary === undefined;
  }
  private readable(revision: number): boolean {
    if (!this.active || !this.current(revision)) return false;
    try { return this.target.supportsOutputTiming === true && this.current(revision); }
    catch { return false; }
  }
  sampleSourcePosition(epoch: object): AudioSourcePosition | null {
    const revision = this.revision;
    try {
      if (!this.readable(revision)) return null;
      const sample = this.target.sampleSourcePosition;
      if (!sample || !this.readable(revision)) return null;
      const value = sample.call(this.target, epoch);
      return this.readable(revision) ? value ?? null : null;
    } catch { return null; }
  }
  get currentPlayoutTimeUs(): number {
    const revision = this.revision;
    try {
      if (!this.readable(revision)) return NaN;
      const value = this.target.currentPlayoutTimeUs;
      return this.readable(revision) && Number.isFinite(value) ? value : NaN;
    } catch { return NaN; }
  }
  playheadCaptureUs(): number | null {
    const revision = this.revision;
    try {
      if (!this.readable(revision)) return null;
      const sample = this.target.playheadCaptureUs;
      if (!sample || !this.readable(revision)) return null;
      const value = sample.call(this.target);
      return this.readable(revision) && value !== null && Number.isFinite(value) ? value : null;
    } catch { return null; }
  }
  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) throw new RangeError('Invalid audio playback rate');
    if (this.destroyed) return;
    this.pendingRate = rate; this.rateRevision++;
    if (this.active && !this.draining) this.applyRate(this.revision);
  }
  private applyRate(revision: number): void {
    const rate = this.pendingRate, version = this.rateRevision;
    if (rate === undefined || !this.readable(revision)) return;
    const setRate = this.target.setPlaybackRate;
    if (!this.readable(revision) || this.rateRevision !== version) return;
    this.pendingRate = undefined;
    setRate?.call(this.target, rate);
  }
}
