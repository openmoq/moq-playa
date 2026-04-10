/**
 * MseMediaSource — stateless MSE SourceBuffer pipe for CMAF playback.
 *
 * Implements MediaSourceLike for use with MoqtPlayer.
 * The adapter is a dumb pipe: initialize() creates SourceBuffers,
 * appendChunk() appends data. All data ordering, moof+mdat concatenation,
 * and init-before-media sequencing is the player's responsibility.
 *
 * Uses 'segments' mode to preserve moof baseDecodeTime timestamps.
 * The caller sets timestampOffset via setTimestampOffset() to rebase
 * live timestamps to zero.
 *
 * @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers — ftyp+moov)
 * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging — moof+mdat)
 * @module
 */

import type { MediaSourceLike } from '@moqt/player';
import { readU32, writeU32, boxType, boxSize, trakHandlerType, trakTrackId, buildBox, filterMvex, filterInitSegment, describeBoxes } from './mp4-box.js';

// ─── Adapter ──────────────────────────────────────────────────────────

/**
 * Stateless MseMediaSource.
 *
 * The player MUST call initialize() before appendChunk(). Data ordering
 * (init before media, moof+mdat concatenation) is the player's job.
 * The adapter only handles SourceBuffer back-pressure (updateend drain).
 *
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 */
export class MseMediaSource implements MediaSourceLike {
  private ms: MediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;

  /** Back-pressure queues — only for SourceBuffer.updating serialization. */
  private readonly videoQueue: Uint8Array[] = [];
  private readonly audioQueue: Uint8Array[] = [];

  private readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;
  private destroyed = false;
  private initialized = false;

  // ─── Callbacks ──────────────────────────────────────────────────

  onFirstFrame: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onStall: ((durationMs: number) => void) | null = null;

  private firstFrameFired = false;
  private playTriggered = false;
  private stallStartTime: number | null = null;

  constructor(videoElement: HTMLVideoElement) {
    this.video = videoElement;
    this.ms = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.ms);
    this.video.src = this.objectUrl;
    this.video.addEventListener('playing', this.handlePlaying);
    this.video.addEventListener('waiting', this.handleWaiting);
    this.video.addEventListener('timeupdate', this.handleTimeUpdate);
  }

  // ─── MediaSourceLike ───────────────────────────────────────────

  get mediaElement(): HTMLVideoElement {
    return this.video;
  }

  /**
   * Create SourceBuffers and append init segments.
   * MUST be called exactly once, before any appendChunk() calls.
   */
  initialize(config: {
    video?: { codec: string; initData: Uint8Array };
    audio?: { codec: string; initData: Uint8Array };
  }): void {
    if (this.initialized) return;
    this.initialized = true;

    const doInit = () => {
      try {
        if (config.video) {
          const mimeType = `video/mp4; codecs="${config.video.codec}"`;
          console.log('[MSE] Creating video SourceBuffer:', mimeType);
          this.videoBuffer = this.ms.addSourceBuffer(mimeType);
          this.videoBuffer.mode = 'segments';
          this.videoBuffer.addEventListener('error', () => {
            const e = this.video.error;
            console.error('[MSE] Video SourceBuffer error: code=%s msg=%s', e?.code, e?.message);
            // Log buffered ranges for diagnosis
            try {
              const vb = this.videoBuffer;
              if (vb) {
                for (let i = 0; i < vb.buffered.length; i++) {
                  console.error('[MSE] Video buffered[%d]: %f - %f', i, vb.buffered.start(i), vb.buffered.end(i));
                }
              }
            } catch { /* */ }
            this.onError?.(new Error(`Video SourceBuffer error (code=${e?.code}, ${e?.message ?? 'unknown'})`));
          });
          this.videoBuffer.addEventListener('updateend', () => this.drainQueue('video'));
          if (config.video.initData.byteLength > 0) {
            const videoInit = filterInitSegment(config.video.initData, 'vide');
            console.log('[MSE] Video init: %d bytes, boxes: %s', videoInit.byteLength, describeBoxes(videoInit));
            this.videoBuffer.appendBuffer(videoInit.buffer as ArrayBuffer);
          }
        }

        if (config.audio) {
          const mimeType = `audio/mp4; codecs="${config.audio.codec}"`;
          console.log('[MSE] Creating audio SourceBuffer:', mimeType);
          this.audioBuffer = this.ms.addSourceBuffer(mimeType);
          this.audioBuffer.mode = 'segments';
          this.audioBuffer.addEventListener('error', () => {
            const e = this.video.error;
            console.error('[MSE] Audio SourceBuffer error: code=%s msg=%s', e?.code, e?.message);
            this.onError?.(new Error(`Audio SourceBuffer error (code=${e?.code}, ${e?.message ?? 'unknown'})`));
          });
          this.audioBuffer.addEventListener('updateend', () => this.drainQueue('audio'));
          if (config.audio.initData.byteLength > 0) {
            const audioInit = filterInitSegment(config.audio.initData, 'soun');
            console.log('[MSE] Audio init: %d bytes, boxes: %s', audioInit.byteLength, describeBoxes(audioInit));
            this.audioBuffer.appendBuffer(audioInit.buffer as ArrayBuffer);
          }
        }
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    if (this.ms.readyState === 'open') {
      doInit();
    } else {
      this.ms.addEventListener('sourceopen', doInit, { once: true });
    }
  }

  /**
   * Append a complete CMAF segment (moof+mdat) to the SourceBuffer.
   *
   * The caller MUST:
   * - Call initialize() first
   * - Concatenate moof+mdat into a single buffer before calling this
   * - Only send data that follows the init segment's codec context
   *
   * The adapter handles only SourceBuffer back-pressure (updateend queue).
   */
  appendChunk(mediaType: 'video' | 'audio', data: Uint8Array): void {
    if (this.destroyed) return;

    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) {
      // Not initialized yet — caller should not be sending data.
      // Drop silently to avoid corruption.
      return;
    }

    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;

    if (buffer.updating || queue.length > 0) {
      queue.push(data);
    } else {
      try {
        // Log first few appends for debugging
        if (!this.playTriggered) {
          const hex = Array.from(data.slice(0, 24)).map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
          console.log('[MSE] appendBuffer %s: %dB head=[%s]', mediaType, data.byteLength, hex);
        }
        buffer.appendBuffer(data.buffer as ArrayBuffer);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Set the timestampOffset on a SourceBuffer.
   * Used by the assembler to rebase CMAF timestamps to zero so that
   * MSE 'segments' mode starts playback immediately.
   */
  setTimestampOffset(mediaType: 'video' | 'audio', offset: number): void {
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) return;
    try {
      if (!buffer.updating) {
        buffer.timestampOffset = offset;
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  endOfStream(): void {
    if (this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch { /* already ended */ }
    }
  }

  reset(): void {
    try {
      if (this.videoBuffer && !this.videoBuffer.updating) {
        this.ms.removeSourceBuffer(this.videoBuffer);
      }
      if (this.audioBuffer && !this.audioBuffer.updating) {
        this.ms.removeSourceBuffer(this.audioBuffer);
      }
    } catch { /* MediaSource may be closed */ }
    this.videoBuffer = null;
    this.audioBuffer = null;
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
    this.initialized = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.video.removeEventListener('playing', this.handlePlaying);
    this.video.removeEventListener('waiting', this.handleWaiting);
    this.video.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.reset();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
    this.onFirstFrame = null;
    this.onError = null;
    this.onStall = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Drain queued chunks after SourceBuffer updateend. */
  private drainQueue(mediaType: 'video' | 'audio'): void {
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;

    if (!buffer || buffer.updating || queue.length === 0) {
      // Trigger play after first media data is buffered
      if (!this.playTriggered && this.video.buffered.length > 0) {
        this.playTriggered = true;
        this.video.play().catch(() => { /* autoplay policy */ });
      }
      return;
    }

    const next = queue.shift()!;
    try {
      buffer.appendBuffer(next.buffer as ArrayBuffer);
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ─── Event handlers ────────────────────────────────────────────

  private handlePlaying = (): void => {
    if (this.stallStartTime !== null) this.stallStartTime = null;
    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      this.onFirstFrame?.();
    }
  };

  private handleWaiting = (): void => {
    this.stallStartTime = performance.now();
  };

  private handleTimeUpdate = (): void => {
    if (!this.firstFrameFired && this.video.currentTime > 0) {
      this.firstFrameFired = true;
      this.onFirstFrame?.();
    }
    if (this.stallStartTime !== null) {
      const durationMs = performance.now() - this.stallStartTime;
      this.stallStartTime = null;
      this.onStall?.(durationMs);
    }
  };
}
