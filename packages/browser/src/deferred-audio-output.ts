/**
 * DeferredAudioOutput — drops audio until a real AudioOutputLike is activated.
 *
 * Used for deferred audio activation (autoplay policy compliance).
 * The dispatcher binds audioDecoder.onData at pipeline creation, so an
 * AudioOutputLike must exist from the start. This proxy satisfies that
 * requirement while deferring actual AudioContext creation to a user gesture.
 *
 * Before activation: schedule() closes the AudioData (frees native memory)
 * and drops it. No AudioContext exists, no warnings logged.
 *
 * After activation: enabled legacy calls forward; producing timing requires
 * an explicitly capable real target.
 *
 * @module
 */

import type { AudioOutputLike, AudioProducedTiming, AudioSourcePosition, AudioScheduleObservation, AudioScheduleObserver } from '@openmoq/player';

interface ScheduleBinding {
  readonly target: AudioOutputLike;
  active: boolean;
  off: (() => void) | undefined;
}

function throwFailures(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Deferred audio cleanup failed');
}

/**
 * A deferred AudioOutputLike proxy.
 *
 * Usage:
 * 1. Pass to the player as the audio output at pipeline creation
 * 2. Audio data is silently dropped (and closed) until activate() is called
 * 3. On user gesture, create the real WebAudioOutput and call activate(real)
 * 4. Enabled calls forward; armed audio requires a timing-capable real output
 */
export class DeferredAudioOutput implements AudioOutputLike {
  readonly outputTimingDeferred = true as const;
  // Type-only declaration: the optional capability is absent until activation.
  declare supportsOutputTiming?: true;
  private real: AudioOutputLike | null = null;
  private pendingRate = 1.0;
  private _enabled = true;
  private revision = 0;
  private scheduleObservers: Set<AudioScheduleObserver> | undefined;
  private scheduleBinding: ScheduleBinding | undefined;

  /** Whether a real output has been activated. */
  get isActive(): boolean {
    return this.real !== null;
  }

  /**
   * Enable or disable audio forwarding. When disabled, schedule() drops
   * audio even if a real output is activated. Used for mute after activation.
   */
  set enabled(value: boolean) {
    if (this._enabled !== value) { this._enabled = value; this.revision++; }
  }
  get enabled(): boolean { return this._enabled; }

  /**
   * Activate with a real AudioOutputLike.
   * Enabled calls forward according to its capabilities. Applies pending rate.
   */
  activate(output: AudioOutputLike): void {
    const previous = this.real;
    const previousBinding = previous === output ? undefined : this.scheduleBinding;
    if (previous !== output) this.scheduleBinding = undefined;
    const revision = ++this.revision;
    this.real = output;
    delete this.supportsOutputTiming;
    const errors: unknown[] = [];
    try {
      let capable = false;
      try { capable = output.supportsOutputTiming === true; } catch { /* Optional capability unavailable. */ }
      if (this.current(output, revision)) {
        if (capable) this.supportsOutputTiming = true;
        this.bindSchedules(output, revision);
        if (this.current(output, revision) && this.pendingRate !== 1.0) output.setPlaybackRate?.(this.pendingRate);
      }
    } catch (error) { errors.push(error); }
    if (previous !== null && previous !== output) {
      // Cleanup callbacks may reactivate the previous output. Its old binding
      // still retires, but a current output must not be flushed or destroyed.
      for (const method of ['flush', 'destroy'] as const) {
        if (this.real === previous) break;
        try {
          const release = previous[method];
          if (this.real !== previous) release.call(previous);
        } catch (error) { errors.push(error); }
      }
    }
    try { this.endBinding(previousBinding); } catch (error) { errors.push(error); }
    throwFailures(errors);
  }

  schedule(data: unknown, renderTimeUs: number, token?: object, outputTiming?: AudioProducedTiming | null): void {
    const output = this.real, revision = this.revision;
    if (!output || !this._enabled || (outputTiming !== undefined && !this.timingCapable(output, revision))) {
      this.drop(data, token); return;
    }
    let schedule: AudioOutputLike['schedule'];
    try { schedule = output.schedule; }
    catch (error) { this.drop(data, token); throw error; }
    if (!this.current(output, revision) || !this._enabled) { this.drop(data, token); return; }
    // Ownership transfers on invocation. Do not close again if the real target
    // throws after consuming PCM, or alter a reentrant successor afterward.
    if (outputTiming !== undefined) schedule.call(output, data, renderTimeUs, token, outputTiming);
    else if (token !== undefined) schedule.call(output, data, renderTimeUs, token);
    else schedule.call(output, data, renderTimeUs);
  }

  private close(data: unknown): void {
    (data as { close?: () => void } | null)?.close?.();
  }

  private drop(data: unknown, token: object | undefined): void {
    try { this.close(data); }
    finally {
      if (token !== undefined && this.scheduleObservers?.size) {
        this.publish({ token, state: 'discarded', reason: 'timing unavailable' });
      }
    }
  }

  /** No backend listener exists until somebody asks for scheduling evidence. */
  observeSchedules(observer: AudioScheduleObserver): () => void {
    const observers = this.scheduleObservers ??= new Set();
    observers.add(observer);
    try { if (this.real) this.bindSchedules(this.real, this.revision); }
    catch (error) {
      observers.delete(observer);
      if (this.scheduleObservers === observers && observers.size === 0) {
        this.scheduleObservers = undefined;
        const binding = this.scheduleBinding; this.scheduleBinding = undefined;
        try { this.endBinding(binding); } catch { /* Preserve the registration error. */ }
      }
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false; observers.delete(observer);
      if (this.scheduleObservers !== observers || observers.size) return;
      this.scheduleObservers = undefined;
      const binding = this.scheduleBinding; this.scheduleBinding = undefined;
      this.endBinding(binding);
    };
  }

  private bindSchedules(target: AudioOutputLike, revision: number): void {
    if (!this.scheduleObservers?.size || this.scheduleBinding?.target === target) return;
    const observe = target.observeSchedules;
    if (!this.current(target, revision) || !this.scheduleObservers?.size || typeof observe !== 'function') return;
    // The method getter may have registered another observer and acquired
    // this target already. That binding owns its cleanup; do not replace it.
    if (this.scheduleBinding !== undefined) return;
    const binding: ScheduleBinding = { target, active: true, off: undefined };
    this.scheduleBinding = binding;
    try {
      const off = observe.call(target, event => this.publish(event, binding));
      if (typeof off !== 'function') throw new TypeError('Audio schedule observation must return cleanup');
      binding.off = off;
    } catch (error) {
      if (this.scheduleBinding === binding) this.scheduleBinding = undefined;
      binding.active = false;
      throw error;
    }
    // Sampling revisions also change on mute/flush or same-target activation.
    // They do not retire this native listener or its outstanding tokens.
    if (this.scheduleBinding !== binding || this.real !== target || !binding.active || !this.scheduleObservers?.size) {
      if (this.scheduleBinding === binding) this.scheduleBinding = undefined;
      this.endBinding(binding);
    }
  }

  private endBinding(binding: ScheduleBinding | undefined): void {
    if (!binding) return;
    binding.active = false;
    const off = binding.off; binding.off = undefined;
    off?.();
  }

  private publish(event: AudioScheduleObservation, binding?: ScheduleBinding): void {
    const observers = this.scheduleObservers;
    if (!observers?.size || (binding && !binding.active)) return;
    const { token, state, reason } = event;
    for (const observer of [...observers]) {
      if (this.scheduleObservers !== observers || !observers.has(observer) || (binding && !binding.active)) continue;
      try {
        const pending = observer({ token, state, reason });
        if (pending) void Promise.resolve(pending).catch(() => {});
      } catch { /* Diagnostics cannot change native audio ownership. */ }
    }
  }

  private current(output: AudioOutputLike, revision: number): boolean {
    return this.real === output && this.revision === revision;
  }

  private timingCapable(output: AudioOutputLike, revision: number): boolean {
    let capable = false;
    try { capable = output.supportsOutputTiming === true; } catch { /* Fail closed before PCM transfer. */ }
    if (!this.current(output, revision)) return false;
    if (!capable) delete this.supportsOutputTiming;
    return capable;
  }

  /** The real target owns source proof. Muting or replacement makes it unavailable. */
  sampleSourcePosition(epoch: object): AudioSourcePosition | null {
    const output = this.real, revision = this.revision;
    if (!output || !this._enabled || !this.timingCapable(output, revision)) return null;
    try {
      const sample = output.sampleSourcePosition;
      if (!sample || !this.current(output, revision) || !this._enabled) return null;
      const position = sample.call(output, epoch);
      if (!this.timingCapable(output, revision) || !this.current(output, revision) || !this._enabled) return null;
      return position ?? null;
    } catch { return null; }
  }

  flush(): void {
    this.revision++;
    this.real?.flush();
  }

  get currentPlayoutTimeUs(): number {
    return this.real?.currentPlayoutTimeUs ?? 0;
  }

  /** Forward playhead observability to the real output once activated. */
  playheadCaptureUs(): number | null {
    return this.real?.playheadCaptureUs?.() ?? null;
  }

  setPlaybackRate(rate: number): void {
    this.pendingRate = rate;
    this.real?.setPlaybackRate?.(rate);
  }

  destroy(): void {
    const output = this.real;
    const binding = this.scheduleBinding;
    // Detach before external cleanup; it may activate a successor reentrantly.
    this.real = null;
    this.scheduleBinding = undefined;
    this.revision++;
    delete this.supportsOutputTiming;
    const errors: unknown[] = [];
    try { output?.destroy(); } catch (error) { errors.push(error); }
    try { this.endBinding(binding); } catch (error) { errors.push(error); }
    throwFailures(errors);
  }
}
