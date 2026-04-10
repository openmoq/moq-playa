/**
 * Volume control via AudioContext GainNode.
 *
 * Inserted into the audio graph between WebAudioOutput and
 * audioCtx.destination. Provides volume (0–1) and mute toggle.
 *
 * @module
 */

/** Options for VolumeController construction. */
export interface VolumeControllerOptions {
  readonly initialVolume?: number;
  readonly initialMuted?: boolean;
}

/**
 * Controls audio volume and mute state via a GainNode.
 *
 * The `destinationNode` getter returns the GainNode that should be
 * passed to WebAudioOutput as its destination — sources connect
 * here instead of directly to audioCtx.destination.
 *
 * Audio graph: WebAudioOutput sources → gainNode → audioCtx.destination
 */
export class VolumeController {
  private readonly gainNode: GainNode;
  private _volume: number;
  private _muted: boolean;

  constructor(audioCtx: AudioContext, options?: VolumeControllerOptions) {
    this._volume = options?.initialVolume ?? 1;
    this._muted = options?.initialMuted ?? false;

    this.gainNode = audioCtx.createGain();
    this.gainNode.connect(audioCtx.destination);
    this.applyGain();
  }

  /** Current volume (0–1). */
  get volume(): number { return this._volume; }

  /** Whether audio is muted. */
  get muted(): boolean { return this._muted; }

  /**
   * The GainNode to use as WebAudioOutput's destination.
   * Pass this to `new WebAudioOutput(audioCtx, volumeCtrl.destinationNode)`.
   */
  get destinationNode(): AudioNode { return this.gainNode; }

  /** Set volume (0–1). Clamped to valid range. */
  setVolume(vol: number): void {
    this._volume = Math.max(0, Math.min(1, vol));
    if (!this._muted) this.applyGain();
  }

  /** Toggle mute on/off. */
  toggleMute(): void {
    this._muted = !this._muted;
    this.applyGain();
  }

  /** Set mute state explicitly. */
  setMuted(muted: boolean): void {
    this._muted = muted;
    this.applyGain();
  }

  private applyGain(): void {
    this.gainNode.gain.value = this._muted ? 0 : this._volume;
  }
}
