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
 * After activation: all calls forward to the real AudioOutputLike.
 *
 * @module
 */

import type { AudioOutputLike } from '@moqt/player';

/**
 * A deferred AudioOutputLike proxy.
 *
 * Usage:
 * 1. Pass to the player as the audio output at pipeline creation
 * 2. Audio data is silently dropped (and closed) until activate() is called
 * 3. On user gesture, create the real WebAudioOutput and call activate(real)
 * 4. From that point, all calls forward to the real output
 */
export class DeferredAudioOutput implements AudioOutputLike {
  private real: AudioOutputLike | null = null;
  private pendingRate = 1.0;
  private _enabled = true;

  /** Whether a real output has been activated. */
  get isActive(): boolean {
    return this.real !== null;
  }

  /**
   * Enable or disable audio forwarding. When disabled, schedule() drops
   * audio even if a real output is activated. Used for mute after activation.
   */
  set enabled(value: boolean) { this._enabled = value; }
  get enabled(): boolean { return this._enabled; }

  /**
   * Activate with a real AudioOutputLike.
   * All subsequent calls forward to it. Applies any pending playback rate.
   */
  activate(output: AudioOutputLike): void {
    this.real = output;
    if (this.pendingRate !== 1.0) {
      output.setPlaybackRate?.(this.pendingRate);
    }
  }

  schedule(data: unknown, renderTimeUs: number): void {
    if (this.real && this._enabled) {
      this.real.schedule(data, renderTimeUs);
      return;
    }
    // Drop audio — close AudioData to free native memory.
    (data as any)?.close?.();
  }

  flush(): void {
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
    this.real?.destroy();
  }
}
