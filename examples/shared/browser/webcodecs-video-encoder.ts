/**
 * WebCodecsVideoEncoder — encodes VideoFrames to H.264/AV1 via browser VideoEncoder.
 *
 * Mirrors the WebCodecsVideoDecoder pattern: configure → encode → onChunk callback.
 * Used by the broadcast example to encode camera/screen capture for MoQ publishing.
 *
 * Key differences from decoder:
 * - Input: VideoFrame (from MediaStreamTrackProcessor)
 * - Output: encoded chunk data + metadata (keyframe flag, description/SPS+PPS)
 * - Manages keyframe interval (request keyframe every N frames)
 * - Reports encoder description (SPS/PPS) on keyframes for LOC VideoConfig extension
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.1 (VideoConfig extension)
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking extension)
 * @module
 */

/** Default keyframe interval in frames (2 seconds at 30fps). */
const DEFAULT_KEYFRAME_INTERVAL = 60;

/** Default bitrate in bits per second. */
const DEFAULT_BITRATE = 2_000_000;

/**
 * Browser VideoEncoder wrapper for MoQ publishing.
 *
 * Usage:
 * ```ts
 * const encoder = new WebCodecsVideoEncoder();
 * encoder.onChunk = (data, isKeyframe, timestamp, duration, description) => {
 *   // data: raw encoded bytes (H.264 Annex B or AV1 OBU)
 *   // isKeyframe: true for IDR frames
 *   // timestamp: capture timestamp in microseconds
 *   // duration: frame duration in microseconds
 *   // description: SPS/PPS on keyframes (for LOC VideoConfig)
 * };
 * encoder.configure('avc1.640028', 1920, 1080, { bitrate: 3_000_000 });
 * // In capture loop:
 * encoder.encode(videoFrame);
 * ```
 */
export class WebCodecsVideoEncoder {
  private encoder: VideoEncoder | null = null;
  private frameCount = 0;
  private keyframeInterval: number;
  private lastDescription: Uint8Array | null = null;

  /** Callback: encoded chunk ready for publishing. */
  onChunk: ((
    data: Uint8Array,
    isKeyframe: boolean,
    timestamp: number,
    duration: number,
    description: Uint8Array | undefined,
  ) => void) | null = null;

  /** Callback: encoder error. */
  onError: ((error: Error) => void) | null = null;

  constructor() {
    this.keyframeInterval = DEFAULT_KEYFRAME_INTERVAL;
  }

  /**
   * Configure the encoder.
   *
   * @param codec Codec string (e.g., 'avc1.640028', 'av01.0.08M.10')
   * @param width Encoded width in pixels
   * @param height Encoded height in pixels
   * @param options Encoding options
   */
  configure(
    codec: string,
    width: number,
    height: number,
    options?: {
      bitrate?: number;
      framerate?: number;
      keyframeInterval?: number;
      latencyMode?: 'quality' | 'realtime';
    },
  ): void {
    this.keyframeInterval = options?.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL;
    this.frameCount = 0;

    this.encoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
        // Extract raw bytes from EncodedVideoChunk
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);

        const isKeyframe = chunk.type === 'key';

        // Extract codec description (SPS/PPS for H.264, sequence header for AV1)
        // Only available on keyframes via decoderConfig metadata.
        let description: Uint8Array | undefined;
        if (isKeyframe && metadata?.decoderConfig?.description) {
          const desc = metadata.decoderConfig.description;
          if (desc instanceof ArrayBuffer) {
            description = new Uint8Array(desc);
          } else if (ArrayBuffer.isView(desc)) {
            description = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
          }
          this.lastDescription = description ?? null;
        }

        this.onChunk?.(
          data,
          isKeyframe,
          chunk.timestamp,
          chunk.duration ?? 0,
          description,
        );
      },
      error: (err: DOMException) => {
        this.onError?.(new Error(err.message));
      },
    });

    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: options?.bitrate ?? DEFAULT_BITRATE,
      framerate: options?.framerate ?? 30,
      latencyMode: options?.latencyMode ?? 'realtime',
    };

    this.encoder.configure(config);
  }

  /**
   * Encode a VideoFrame.
   *
   * Requests a keyframe every `keyframeInterval` frames.
   * The frame is NOT closed — caller retains ownership.
   *
   * @param frame VideoFrame from MediaStreamTrackProcessor or canvas
   */
  encode(frame: VideoFrame): void {
    if (!this.encoder || this.encoder.state !== 'configured') return;

    const isKeyframe = this.frameCount % this.keyframeInterval === 0;
    this.encoder.encode(frame, { keyFrame: isKeyframe });
    this.frameCount++;
  }

  /** Flush pending frames. */
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
    this.lastDescription = null;
  }

  /** Last known encoder description (SPS/PPS). */
  get description(): Uint8Array | null {
    return this.lastDescription;
  }

  /** Current encode queue depth. */
  get queueDepth(): number {
    return this.encoder?.encodeQueueSize ?? 0;
  }
}
