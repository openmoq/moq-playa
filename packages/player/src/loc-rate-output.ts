import type { ClockSource, DecoderCommand, SyncController } from '@openmoq/playback';
import type { AudioOutputLike, VideoRendererLike } from './interfaces.js';
import type { PlaybackRateOutput } from './live-catch-up.js';

/** Output mechanics only: policy, ownership and standing-buffer decisions stay in the player. */
export class LocRateOutput implements PlaybackRateOutput {
  private rate = 1;
  private revision = 0;
  private lastUs: number | null = null;
  private readonly epoch = {};
  private readonly mediaEpoch = {};
  constructor(private readonly sync: SyncController, private readonly clock: ClockSource,
    private readonly renderer: VideoRendererLike | undefined, private readonly audio: AudioOutputLike | undefined,
    private readonly ahead: () => number | null, private readonly cushion: () => number,
    private readonly repaid: (byUs: number) => void) {}
  latencyUs(): number | null {
    const head = this.audio?.sampleSourcePosition?.(this.epoch);
    return head ? this.sync.measureLatency(head.sourceTimestampUs + BigInt(Math.round(head.sourceOffsetUs))) : null;
  }
  advance(): void {
    const now = this.clock.now(), elapsed = this.lastUs === null ? 0 : Math.max(0, now - this.lastUs);
    this.lastUs = now;
    if (this.rate > 1 && this.sync.hasReference && elapsed > 0) {
      const byUs = (this.rate - 1) * elapsed;
      this.sync.advanceReference(byUs); this.repaid(byUs);
    }
  }
  getBufferAheadUs(): number | null { this.advance(); return this.ahead(); }
  setPlaybackRate(rate: number): void {
    const revision = ++this.revision;
    this.advance(); if (revision !== this.revision) return;
    this.rate = rate; this.renderer?.setPlaybackRate?.(rate);
    if (revision === this.revision) this.audio?.setPlaybackRate?.(rate);
  }
  command(command: DecoderCommand): DecoderCommand {
    if (command.type !== 'decode_audio' || command.renderTiming) return command;
    const capture = BigInt(command.chunk.timestamp);
    return { ...command, renderTiming: { epoch: command.chunk.sourceTimestamp?.domain === 'unix' ? this.epoch : this.mediaEpoch, sourceTimestampUs: capture, presentFromSourceUs: capture,
      recomputeRenderTimeUs: offset => {
        const timing = this.sync.computeAudioRenderTime(capture);
        return timing ? timing.renderTimeUs + offset + this.cushion() : null;
      } } };
  }
}
