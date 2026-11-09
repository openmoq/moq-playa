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

import type { AudioDecoderLike, AudioProducedTiming } from '@openmoq/player';
import type { AudioRenderTiming } from '@openmoq/playback';
import type { AudioChunkInit } from '@openmoq/loc';
import { type AudioTimingInput, AudioOutputTiming } from './audio-output-timing.js';

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
 * - Tracks render time by native output timestamp within its decoder generation
 *
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 */
export class WebCodecsAudioDecoder implements AudioDecoderLike {
  readonly supportsOutputTiming = true as const;
  private decoder: AudioDecoder | null = null;

  /** Stored config for recreating decoder after errors. */
  private lastCodec = '';
  private lastSampleRate = 48000;
  private lastChannels = 2;
  private lastDescription: Uint8Array | null = null;

  /** Whether the codec is AAC (needs ADTS wrapping). */
  private isAAC = false;

  /** Scalar timing state belongs to the current native decoder, never to output order. */
  private timing: AudioOutputTiming | null = null;
  private inputTokens: WeakMap<AudioTimingInput, object> | undefined;
  private outputTimings: WeakMap<AudioTimingInput, AudioRenderTiming> | undefined;

  /** Error count — limit logging. */
  private errorCount = 0;

  // ─── Callbacks ──────────────────────────────────────────────────

  onData: ((data: unknown, renderTimeUs: number, inputToken?: object, outputTiming?: AudioProducedTiming | null) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  private queueObservers: Set<() => void> | undefined;

  /** Native queue progress can precede PCM; each observer owns its removal. */
  observeQueueDepth(observer: () => void): () => void {
    const observers = this.queueObservers ??= new Set();
    // A registration is distinct even when another uses the same observer.
    const notify = () => observer();
    observers.add(notify);
    return () => {
      observers.delete(notify);
      if (!observers.size && this.queueObservers === observers) this.queueObservers = undefined;
    };
  }

  // ─── AudioDecoderLike ───────────────────────────────────────────

  /**
   * Configure the decoder with codec metadata from the MSF catalog or a LOC Audio Config property.
   *
   * AAC uses raw access units when description bytes are provided; otherwise
   * it uses ADTS framing with catalog sample-rate and channel metadata.
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
    this.lastDescription = config.length > 0 ? config.slice() : null;
    // AAC without a description runs in ADTS mode (client-side framing).
    // With an Audio Config description the payload is raw access units.
    // @see draft-ietf-moq-loc-04 §2.3.3.1
    // @see W3C AAC WebCodecs Registration §2
    this.isAAC = codec.startsWith('mp4a.') && this.lastDescription === null;
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
  decode(chunk: AudioChunkInit, renderTimeUs: number, inputToken?: object, renderTiming?: AudioRenderTiming): void {
    if (!this.lastCodec || !this.decoder || this.decoder.state !== 'configured') return;

    // Backpressure: a queue this deep means the decoder stopped keeping up
    // (or stalled outright). Mirror the video decoder: reset — fresh decoder,
    // empty render-time queue — and surface an error so the pipeline's
    // recovery/throttle logic sees it. Never drop silently. Audio frames are
    // independently decodable (LOC §4.1), so playback resumes on the next frame.
    if (this.decoder.decodeQueueSize >= MAX_AUDIO_DECODE_QUEUE_SIZE) {
      this.reset();
      this.onError?.(new Error('audio decode queue overflow — decoder reset'));
      return;
    }

    let data = chunk.data;

    // Wrap raw AAC access unit in ADTS for Chrome's decoder.
    // LOC payload is the raw access unit (§2.2); ADTS framing is client-side.
    // @see ISO/IEC 14496-3 §1.A.3.1 (ADTS fixed header)
    // @see W3C AAC WebCodecs Registration §2 (ADTS mode = no description)
    if (this.isAAC) {
      data = wrapInADTS(data, this.lastSampleRate, this.lastChannels);
    }

    const chunkInit: EncodedAudioChunkInit = {
      type: chunk.type,
      timestamp: chunk.timestamp,
      data,
    };
    if (chunk.duration !== undefined) chunkInit.duration = chunk.duration;
    const decoder = this.decoder, timing = this.timing;
    const encoded = new EncodedAudioChunk(chunkInit);
    if (this.decoder !== decoder || !timing || this.timing !== timing) return;
    if (renderTiming !== undefined) timing.enableSourceTiming(hasOnlyInitialPriming(this.lastCodec),
      this.lastCodec === 'opus' ? this.lastDescription ?? undefined : undefined);
    // Only armed sample proof copies the chunk's ACTUAL submitted bytes. The
    // caller's buffer may have changed since the native constructor copied it.
    let packet: Uint8Array | undefined;
    if (renderTiming && timing.usesOpusSamples) {
      packet = new Uint8Array(encoded.byteLength); encoded.copyTo(packet);
      if (this.decoder !== decoder || this.timing !== timing) return;
    }
    const input = timing.remember(encoded.timestamp, encoded.duration, renderTimeUs,
      renderTiming && packet ? { packet, context: renderTiming } : undefined);
    // Context access and native chunk construction can reenter application code.
    // Neither may submit an old generation's chunk to its replacement.
    if (this.decoder !== decoder || this.timing !== timing) return;
    if (timing.sourceTimingFailure) throw new Error(`Opus source timing unavailable: ${timing.sourceTimingFailure}`);
    if (inputToken && input) (this.inputTokens ??= new WeakMap()).set(input, inputToken);
    if (renderTiming && input) (this.outputTimings ??= new WeakMap()).set(input, renderTiming);
    const tokens = this.inputTokens, outputTimings = this.outputTimings;
    try { decoder.decode(encoded); }
    catch (error) { timing.poison(encoded.timestamp); if (input) { tokens?.delete(input); outputTimings?.delete(input); } throw error; }
  }

  /** Flush pending audio data. */
  async flush(): Promise<void> {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    const decoder = this.decoder, timing = this.timing;
    await decoder.flush();
    if (this.decoder !== decoder || this.timing !== timing) return;
    timing?.finishSourceTiming();
    if (timing?.sourceTimingFailure) throw new Error(`Opus source timing unavailable: ${timing.sourceTimingFailure}`);
  }

  /** Reset the decoder — recreate and reconfigure. No-op if never configured. */
  reset(): void {
    this.timing?.clear();
    if (!this.lastCodec) return; // Not yet configured — nothing to reset
    this.createDecoder();
  }

  /** Current decode queue depth. */
  get queueDepth(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /** Release all resources. */
  destroy(): void {
    this.timing?.clear();
    const decoder = this.decoder;
    this.decoder = null;
    this.queueObservers?.clear(); this.queueObservers = undefined;
    if (decoder) decoder.ondequeue = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
    this.timing = null;
    this.inputTokens = undefined;
    this.outputTimings = undefined;
    this.onData = null;
    this.onError = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private createDecoder(): void {
    const previous = this.decoder;
    this.decoder = null;
    this.timing?.clear();
    this.inputTokens = undefined;
    this.outputTimings = undefined;
    if (previous) previous.ondequeue = null;
    if (previous && previous.state !== 'closed') previous.close();

    // AAC/Opus registration §5 limits priming to the initial prefix. Unknown
    // registrations keep conservative matching if later priming is possible.
    const timing = new AudioOutputTiming(256, this.lastCodec === 'opus' || this.lastCodec.startsWith('mp4a.'));
    const decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        if (this.decoder !== decoder) {
          // Retired decoder output cannot acquire the replacement's timing.
          audioData.close();
          return;
        }
        const timestamp = audioData.timestamp;
        if (this.decoder !== decoder) { audioData.close(); return; }
        const samples = timing.usesOpusSamples ? { numberOfFrames: audioData.numberOfFrames,
          sampleRate: audioData.sampleRate, numberOfChannels: audioData.numberOfChannels } : undefined;
        if (this.decoder !== decoder) { audioData.close(); return; }
        const result = timing.resolve(timestamp, samples);
        const failure = timing.takeSourceTimingFailure();
        if (failure) {
          // Capability refusal is explicit; do not leave a seek waiting for an
          // arbitrary preparation timeout or manufacture an output clock.
          try { this.onError?.(new Error(`Opus source timing unavailable: ${failure}`)); }
          catch (error) { audioData.close(); throw error; }
          if (this.decoder !== decoder) { audioData.close(); return; }
        }
        if (!this.onData) { audioData.close(); return; }
        // Zero is the existing no-timing sentinel; it never proves input identity.
        const inputToken = result.input ? this.inputTokens?.get(result.input) : undefined;
        if (result.sourceOffsetUs !== undefined) {
          const context = result.input ? this.outputTimings?.get(result.input) : undefined;
          let outputTiming: AudioProducedTiming | null = null;
          if (context && result.sourceOffsetUs !== null) {
            let schedule: number | null = null;
            try { schedule = context.recomputeRenderTimeUs(result.sourceOffsetUs); } catch { /* Unavailable producing schedule. */ }
            if (this.decoder !== decoder || !this.onData) { audioData.close(); return; }
            if (schedule !== null && Number.isFinite(schedule)) outputTiming = { context, sourceOffsetUs: result.sourceOffsetUs };
          }
          this.onData(audioData, result.renderTimeUs, inputToken, outputTiming);
        } else if (inputToken === undefined) this.onData(audioData, result.renderTimeUs);
        else this.onData(audioData, result.renderTimeUs, inputToken);
      },
      error: (err: DOMException) => {
        if (this.decoder !== decoder) return;
        this.errorCount++;

        // Chunks in flight died with the failed decoder — discard their
        // timing ownership before a callback can install a replacement.
        this.timing?.clear();
        this.inputTokens = undefined;
        this.outputTimings = undefined;
        this.onError?.(new Error(err.message));

        // Decoder enters 'closed' state on error — recreate.
        // Each audio frame is independently decodable (LOC §4.1),
        // so we can continue from the next frame.
        if (this.decoder === decoder) this.createDecoder();
      },
    });
    this.decoder = decoder;
    this.timing = timing;
    // WebCodecs §3.6 queues this event when decodeQueueSize decreases,
    // independently of whether the codec produces AudioData.
    decoder.ondequeue = () => {
      if (this.decoder !== decoder || decoder.state !== 'configured') return;
      const observers = this.queueObservers;
      if (!observers) return;
      let failures: unknown[] | undefined;
      for (const notify of [...observers]) {
        if (this.decoder !== decoder) break;
        if (observers.has(notify)) {
          try { notify(); } catch (error) { (failures ??= []).push(error); }
        }
      }
      // As with separate native event listeners, one observer's exception must
      // not suppress another's queue progress. Surface it after notification.
      if (failures?.length === 1) throw failures[0];
      if (failures?.length) throw new AggregateError(failures, 'Audio queue observers failed');
    };

    // AAC with an Audio Config description runs in raw mode via `description`
    // (payload is raw access units); AAC without one uses ADTS framing.
    // Non-AAC codecs (Opus) use raw mode with the codec string.
    const audioConfig: AudioDecoderConfig = {
      codec: this.lastCodec,
      sampleRate: this.lastSampleRate,
      numberOfChannels: this.lastChannels,
      ...(this.lastDescription ? { description: this.lastDescription } : {}),
    };

    this.decoder.configure(audioConfig);
  }
}

/** AAC registration §1/§5 and Opus registration §5, not every mp4a profile. */
function hasOnlyInitialPriming(codec: string): boolean {
  switch (codec) {
    case 'opus':
    case 'mp4a.40.2': case 'mp4a.40.02':
    case 'mp4a.40.5': case 'mp4a.40.05':
    case 'mp4a.40.29': case 'mp4a.40.42': case 'mp4a.67':
      return true;
    default: return false;
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
