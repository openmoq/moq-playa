/**
 * WebCodecsAudioEncoder — encodes AudioData to Opus/AAC via browser AudioEncoder.
 *
 * Mirrors the WebCodecsAudioDecoder pattern: configure → encode → onChunk callback.
 * Used by the broadcast example to encode microphone audio for MoQ publishing.
 *
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 * @module
 */

/** Default audio bitrate in bits per second. */
const DEFAULT_AUDIO_BITRATE = 128_000;

/**
 * Browser AudioEncoder wrapper for MoQ publishing.
 *
 * Usage:
 * ```ts
 * const encoder = new WebCodecsAudioEncoder();
 * encoder.onChunk = (data, timestamp, duration) => {
 *   // data: raw encoded bytes (Opus or AAC)
 *   // timestamp: capture timestamp in microseconds
 *   // duration: chunk duration in microseconds
 * };
 * encoder.configure('opus', 48000, 2);
 * // In capture loop:
 * encoder.encode(audioData);
 * ```
 */
export class WebCodecsAudioEncoder {
  private encoder: AudioEncoder | null = null;

  /** Callback: encoded chunk ready for publishing. */
  onChunk: ((
    data: Uint8Array,
    timestamp: number,
    duration: number,
  ) => void) | null = null;

  /** Callback: encoder error. */
  onError: ((error: Error) => void) | null = null;

  /**
   * Configure the audio encoder.
   *
   * @param codec Codec string (e.g., 'opus', 'mp4a.40.2')
   * @param sampleRate Sample rate in Hz (e.g., 48000)
   * @param channels Number of audio channels (e.g., 2 for stereo)
   * @param options Encoding options
   */
  configure(
    codec: string,
    sampleRate: number,
    channels: number,
    options?: {
      bitrate?: number;
    },
  ): void {
    this.encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        this.onChunk?.(
          data,
          chunk.timestamp,
          chunk.duration ?? 0,
        );
      },
      error: (err: DOMException) => {
        this.onError?.(new Error(err.message));
      },
    });

    this.encoder.configure({
      codec,
      sampleRate,
      numberOfChannels: channels,
      bitrate: options?.bitrate ?? DEFAULT_AUDIO_BITRATE,
    });
  }

  /**
   * Encode an AudioData chunk.
   *
   * The AudioData is NOT closed — caller retains ownership.
   *
   * @param data AudioData from MediaStreamTrackProcessor
   */
  encode(data: AudioData): void {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    this.encoder.encode(data);
  }

  /** Flush pending audio. */
  async flush(): Promise<void> {
    if (!this.encoder || this.encoder.state !== 'configured') return;
    await this.encoder.flush();
  }

  /** Release all resources. */
  destroy(): void {
    if (this.encoder && this.encoder.state !== 'closed') {
      this.encoder.close();
    }
    this.encoder = null;
  }

  /** Current encode queue depth. */
  get queueDepth(): number {
    return this.encoder?.encodeQueueSize ?? 0;
  }
}
