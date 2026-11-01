import type { MediaDiagnosticHost, MediaDiagnosticRuntime, MediaDiagnosticsFactory, MediaStageObservation, MediaStageObserver } from './media-diagnostic-types.js';

interface Slot {
  readonly factory: MediaDiagnosticsFactory;
  readonly listeners: Set<MediaStageObserver>;
  runtime?: MediaDiagnosticRuntime;
}

/** Lazy engine-owned lifetime. The implementation factory stays outside this import graph. */
export class MediaStageObservers {
  private slot: Slot | undefined;
  private disposed = false;
  constructor(private readonly host: MediaDiagnosticHost,
    private readonly changed: (runtime: MediaDiagnosticRuntime | undefined) => void) {}

  get runtime(): MediaDiagnosticRuntime | undefined { return this.slot?.runtime; }

  observe(listener: MediaStageObserver, createTracker?: MediaDiagnosticsFactory): () => void {
    if (typeof listener !== 'function') throw new TypeError('Expected a media-stage observer');
    if (this.disposed) return () => {};
    let slot = this.slot;
    if (slot && createTracker !== undefined && slot.factory !== createTracker) throw new TypeError('Media diagnostics already use a different factory');
    if (!slot) {
      if (typeof createTracker !== 'function') throw new TypeError('A media diagnostics factory is required');
      slot = { factory: createTracker, listeners: new Set() };
      this.slot = slot;
    }
    const owned = slot;
    // Each registration has its own membership, even for the same callback.
    const member: MediaStageObserver = event => listener(event);
    owned.listeners.add(member);
    if (!owned.runtime && owned.listeners.size === 1) {
      let runtime: MediaDiagnosticRuntime | undefined;
      try {
        runtime = owned.factory(this.host, event => this.deliver(owned, event));
        this.validate(runtime);
      } catch (error) {
        if (this.slot === owned) { this.slot = undefined; owned.listeners.clear(); }
        if (runtime) this.release(runtime);
        throw error;
      }
      if (this.slot !== owned || this.disposed) {
        this.release(runtime);
      } else {
        owned.runtime = runtime;
        try { this.changed(runtime); }
        catch (error) { this.close(owned); throw error; }
      }
    }
    return () => {
      owned.listeners.delete(member);
      if (this.slot === owned && owned.listeners.size === 0) this.close(owned);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.slot) this.close(this.slot);
  }

  private validate(value: MediaDiagnosticRuntime): void {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid media diagnostics runtime');
    for (const name of ['capture', 'discarded', 'decoded', 'reconstruct', 'bindMediaSource', 'appendToken', 'discardUnit', 'dispose'] as const) {
      if (typeof value[name] !== 'function') throw new TypeError(`Invalid media diagnostics runtime: ${name}`);
    }
    for (const counter of [value.decodedVideoCount, value.decodedAudioCount, value.evidenceLossCount, value.unobservableAppendCount, value.unattributedInputCount, value.unobservableVideoCount, value.unobservableAudioCount, value.refusedReconstructionCount, value.refusedVideoCount, value.refusedAudioCount]) {
      if (!Number.isSafeInteger(counter) || counter < 0) throw new TypeError('Invalid media diagnostics counter');
    }
  }

  private deliver(slot: Slot, event: MediaStageObservation): void {
    if (this.disposed || this.slot !== slot) return;
    for (const listener of [...slot.listeners]) {
      if (this.slot !== slot || !slot.listeners.has(listener)) continue;
      try { const pending = listener({ ...event, inputs: [...event.inputs] }); if (pending) void Promise.resolve(pending).catch(() => {}); }
      catch { /* An observer cannot change playback or another observer's data. */ }
    }
  }

  private close(slot: Slot): void {
    if (this.slot !== slot) return;
    this.slot = undefined; slot.listeners.clear();
    try { this.changed(undefined); } catch { /* Detachment must still release the runtime. */ }
    if (slot.runtime) this.release(slot.runtime);
  }

  private release(runtime: MediaDiagnosticRuntime): void {
    try { runtime.dispose(); } catch { /* Optional cleanup cannot interrupt playback teardown. */ }
  }
}
