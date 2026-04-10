/**
 * WebCodecsAudioDecoder — wraps browser AudioDecoder with ADTS support.
 *
 * Implements AudioDecoderLike for use with CommandDispatcher.
 * Includes ADTS wrapping for AAC codecs (Chrome's platform decoders
 * are more reliable with ADTS-framed data).
 *
 * @see draft-ietf-moq-loc-01 §4.1 (audio: each object independently decodable)
 * @see draft-ietf-moq-loc-01 §2.2 (LOC payload = EncodedAudioChunk.data)
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 * @see draft-ietf-moq-msf-00 §5.1.25 (samplerate)
 * @see draft-ietf-moq-msf-00 §5.1.26 (channelConfig)
 * @see ISO/IEC 14496-3 §1.A.3.1 (ADTS fixed header)
 * @see W3C AAC WebCodecs Registration §2 (ADTS mode = no description)
 * @module
 */

import type { AudioDecoderLike } from '@moqt/player';
import type { AudioChunkInit } from '@moqt/loc';

/** Maximum audio decode queue depth before dropping frames. */
const MAX_AUDIO_DECODE_QUEUE_SIZE = 32;

/** ADTS sample rate index lookup. @see ISO/IEC 14496-3 §1.A.3.1 */
const ADTS_FREQ_INDEX: Record<number, number> = {
  96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
  24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
};

/**
 * Wraps the browser's AudioDecoder API behind AudioDecoderLike.
 *
 * Key responsibilities:
 * - Maps configure() with catalog metadata → AudioDecoderConfig
 * - ADTS wrapping for AAC: prepends 7-byte header to raw access units
 * - Error recovery: recreates decoder on 'closed' state (each frame independently decodable)
 * - Tracks render time via FIFO queue
 *
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 */
export class WebCodecsAudioDecoder implements AudioDecoderLike {
  private decoder: AudioDecoder | null = null;

  /** Stored config for recreating decoder after errors. */
  private lastCodec = '';
  private lastSampleRate = 48000;
  private lastChannels = 2;

  /** Whether the codec is AAC (needs ADTS wrapping). */
  private isAAC = false;

  /** FIFO queue: renderTimeUs values awaiting output data. */
  private readonly renderTimeQueue: number[] = [];

  /** Error count — limit logging. */
  private errorCount = 0;

  // ─── Callbacks ──────────────────────────────────────────────────

  onData: ((data: unknown, renderTimeUs: number) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  // ─── AudioDecoderLike ───────────────────────────────────────────

  /**
   * Configure the decoder with codec metadata from MSF catalog.
   *
   * For AAC codecs, configures in ADTS mode (no description) because
   * Chrome's platform decoders (AudioToolbox on macOS, Media Foundation
   * on Windows) are more reliable with ADTS-framed data.
   *
   * @param config Codec-specific configuration bytes (may be empty for Opus).
   * @param codec Codec string from MSF catalog (e.g., "mp4a.40.2", "opus").
   * @param sampleRate Sample rate in Hz from MSF catalog.
   * @param channels Number of audio channels from MSF catalog.
   *
   * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
   * @see draft-ietf-moq-msf-00 §5.1.25 (samplerate)
   * @see draft-ietf-moq-msf-00 §5.1.26 (channelConfig)
   * @see W3C AAC WebCodecs Registration §2 (ADTS mode)
   */
  configure(config: Uint8Array, codec: string, sampleRate?: number, channels?: number): void {
    this.lastCodec = codec;
    this.lastSampleRate = sampleRate ?? 48000;
    this.lastChannels = channels ?? 2;
    this.isAAC = codec.startsWith('mp4a.');
    this.errorCount = 0;

    this.createDecoder();
  }

  /**
   * Decode an audio chunk. Data arrives via onData callback.
   *
   * For AAC codecs, wraps the raw access unit in ADTS before decoding.
   *
   * @see draft-ietf-moq-loc-01 §4.1 (each audio object independently decodable)
   * @see draft-ietf-moq-loc-01 §2.2 (LOC payload = EncodedAudioChunk.data)
   */
  decode(chunk: AudioChunkInit, renderTimeUs: number): void {
    if (!this.lastCodec || !this.decoder || this.decoder.state !== 'configured') return;

    // Backpressure: drop audio frames when decoder queue is too deep.
    if (this.decoder.decodeQueueSize >= MAX_AUDIO_DECODE_QUEUE_SIZE) return;

    let data = chunk.data;

    // Wrap raw AAC access unit in ADTS for Chrome's decoder.
    // LOC payload is the raw access unit (§2.2); ADTS framing is client-side.
    // @see ISO/IEC 14496-3 §1.A.3.1 (ADTS fixed header)
    // @see W3C AAC WebCodecs Registration §2 (ADTS mode = no description)
    if (this.isAAC) {
      data = wrapInADTS(data, this.lastSampleRate, this.lastChannels);
    }

    this.renderTimeQueue.push(renderTimeUs);

    this.decoder.decode(new EncodedAudioChunk({
      type: chunk.type,
      timestamp: chunk.timestamp,
      ...(chunk.duration != null ? { duration: chunk.duration } : {}),
      data,
    }));
  }

  /** Flush pending audio data. */
  async flush(): Promise<void> {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    await this.decoder.flush();
  }

  /** Reset the decoder — recreate and reconfigure. No-op if never configured. */
  reset(): void {
    this.renderTimeQueue.length = 0;
    if (!this.lastCodec) return; // Not yet configured — nothing to reset
    this.createDecoder();
  }

  /** Current decode queue depth. */
  get queueDepth(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /** Release all resources. */
  destroy(): void {
    this.renderTimeQueue.length = 0;
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
    this.onData = null;
    this.onError = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private createDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }

    this.decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        if (!this.onData) {
          // No consumer wired — MUST close to release native memory.
          audioData.close();
          return;
        }
        const renderTimeUs = this.renderTimeQueue.shift() ?? 0;
        this.onData(audioData, renderTimeUs);
      },
      error: (err: DOMException) => {
        this.errorCount++;
        this.onError?.(new Error(err.message));

        // Decoder enters 'closed' state on error — recreate.
        // Each audio frame is independently decodable (LOC §4.1),
        // so we can continue from the next frame.
        this.createDecoder();
      },
    });

    // Configure in ADTS mode for AAC (no description → ADTS framing expected).
    // Non-AAC codecs (Opus) use raw mode with the codec string.
    const audioConfig: AudioDecoderConfig = {
      codec: this.lastCodec,
      sampleRate: this.lastSampleRate,
      numberOfChannels: this.lastChannels,
    };

    this.decoder.configure(audioConfig);
  }
}

// ─── ADTS Helper ──────────────────────────────────────────────────────

/**
 * Prepend a 7-byte ADTS header to a raw AAC access unit.
 *
 * @see ISO/IEC 14496-3 §1.A.3.1 (ADTS fixed header)
 * @see W3C AAC WebCodecs Registration §2 (ADTS EncodedAudioChunk format)
 */
function wrapInADTS(
  rawFrame: Uint8Array,
  sampleRate: number,
  channels: number,
): Uint8Array {
  const freqIndex = ADTS_FREQ_INDEX[sampleRate] ?? 3; // default 48kHz
  const frameLen = rawFrame.byteLength + 7; // 7 = ADTS header (no CRC)
  const header = new Uint8Array(7);

  // Byte 0-1: Sync word (0xFFF), MPEG-4 (ID=0), Layer=0, no CRC
  header[0] = 0xFF;
  header[1] = 0xF1;
  // Byte 2: Profile (AAC-LC=1, i.e. objectType-1), freq index, private, channel config MSB
  header[2] = (1 << 6) | (freqIndex << 2) | (channels >> 2);
  // Byte 3: Channel config LSBs, frame length upper 2 bits
  header[3] = ((channels & 0x3) << 6) | ((frameLen >> 11) & 0x3);
  // Byte 4: Frame length mid 8 bits
  header[4] = (frameLen >> 3) & 0xFF;
  // Byte 5: Frame length lower 3 bits, buffer fullness upper 5 bits (0x7FF = VBR)
  header[5] = ((frameLen & 0x7) << 5) | 0x1F;
  // Byte 6: Buffer fullness lower 6 bits, number of raw_data_blocks - 1 = 0
  header[6] = 0xFC;

  const adtsFrame = new Uint8Array(frameLen);
  adtsFrame.set(header);
  adtsFrame.set(rawFrame, 7);
  return adtsFrame;
}
