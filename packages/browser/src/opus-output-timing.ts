import type { AudioRenderTiming } from '@openmoq/playback';
import type { AudioTimingInput, AudioTimingResult } from './audio-output-timing.js';
import { inspectOpusPacket, type OpusSourceProfile } from './opus-source-packet.js';

export interface OpusTimingSubmission {
  readonly packet: Uint8Array;
  readonly context: AudioRenderTiming;
}
export interface AudioSampleSpan {
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
}

interface Span {
  readonly input: AudioTimingInput;
  readonly start: bigint;
  readonly end: bigint;
}
const RATE = 48_000n, US = 1_000_000n;
// Local representation allowance, not a WebCodecs timestamp guarantee.
// Compare to a fixed origin so integer-microsecond conversion cannot compound.
const sameMicrosecondPoint = (actual: bigint, expected: bigint) => actual >= expected - 1n && actual <= expected + 1n;

/**
 * Optional proof for one continuously submitted Opus decoder generation.
 * RFC7845 pre-skip and RFC6716 packet framing locate coded sample intervals;
 * actual PCM counts and timestamps must agree with them. No callback-to-input
 * FIFO, inferred offset, packet rewriting or native timestamp rewriting.
 *
 * Two timestamp conventions are recognized: WebCodecs §3.6's associated-input
 * timestamp plus priming, and a continuous emitted-sample clock rooted at the
 * first submitted timestamp (observed in Chromium). Models only narrow; both
 * must locate the SAME next, unconsumed coded interval. They never choose the
 * owner. Cross-input PCM and non-integral-us offsets remain unsupported by the
 * single-context output API. This is not source-to-content clock calibration.
 * Integer-microsecond native and source points may differ by at most one
 * microsecond from their respective fixed-origin sample clocks. Output model
 * checks use the same bound. Raw timestamps and returned source offsets are
 * never rewritten; the allowance cannot select a different coded interval.
 * These bounds compose: an associated-input output can be two microseconds
 * from the fixed native clock and three from the corresponding source point.
 * They do not prove absolute clock phase or improve the catalog's precision.
 */
export class OpusOutputTiming {
  private spans: Span[] = [];
  private submitted = 0n;
  private emitted = 0n;
  private origin: { timestamp: bigint; source: bigint; epoch: object } | undefined;
  private models = 3;
  private failure: string | null;

  constructor(private readonly profile: OpusSourceProfile | null, private readonly maxInputs: number, lateArm: boolean) {
    this.failure = lateArm ? 'source timing armed after submission' : profile ? null : 'unsupported OpusHead';
  }
  get unavailableReason(): string | null { return this.failure; }
  private refuse(reason: string): void { this.failure ??= reason; this.spans.length = 0; }

  remember(input: AudioTimingInput | undefined, submission?: OpusTimingSubmission): void {
    if (this.failure) return;
    if (!input || input.ambiguous || !submission) { this.refuse('missing or ambiguous source input'); return; }
    const samples = inspectOpusPacket(submission.packet)?.codedSamples48k;
    if (samples === undefined) { this.refuse('unsupported Opus packet framing'); return; }
    const timestamp = BigInt(input.timestamp), { sourceTimestampUs: source, epoch } = submission.context;
    const duration = BigInt(samples) * US / RATE;
    if (input.duration !== null && BigInt(input.duration) !== duration) { this.refuse('packet duration contradicts framing'); return; }
    this.origin ??= { timestamp, source, epoch };
    const elapsed = this.submitted * US / RATE;
    if (epoch !== this.origin.epoch || !sameMicrosecondPoint(timestamp, this.origin.timestamp + elapsed)
        || !sameMicrosecondPoint(source, this.origin.source + elapsed)) {
      this.refuse('discontinuous Opus source'); return;
    }
    const start = this.submitted, end = start + BigInt(samples);
    this.submitted = end;
    // Wholly skipped packets need no native callbacks and retain no owner.
    if (end <= BigInt(this.profile!.preSkip48k)) return;
    if (this.spans.length >= this.maxInputs) { this.refuse('Opus source history limit'); return; }
    this.spans.push({ input, start, end });
  }

  resolve(timestamp: number, pcm?: AudioSampleSpan): AudioTimingResult {
    const unavailable = (): AudioTimingResult => ({ renderTimeUs: 0, input: null, sourceOffsetUs: null });
    if (this.failure) return unavailable();
    if (!Number.isSafeInteger(timestamp) || !pcm || pcm.sampleRate !== 48_000
        || pcm.numberOfChannels !== this.profile!.channels || !Number.isSafeInteger(pcm.numberOfFrames) || pcm.numberOfFrames <= 0) {
      this.refuse('unsupported native Opus sample span'); return unavailable();
    }
    const cursor = BigInt(this.profile!.preSkip48k) + this.emitted;
    const span = this.spans[0], end = cursor + BigInt(pcm.numberOfFrames);
    if (!span || cursor < span.start || end > span.end) {
      this.refuse('native Opus output crosses or exceeds its source interval'); return unavailable();
    }
    const offset = (cursor - span.start) * US, emittedTime = this.emitted * US;
    if (offset % RATE !== 0n || emittedTime % RATE !== 0n) {
      this.refuse('native Opus offset is not representable in whole microseconds'); return unavailable();
    }
    const pts = BigInt(timestamp), inputTime = BigInt(span.input.timestamp) + offset / RATE;
    const streamTime = this.origin!.timestamp + emittedTime / RATE;
    this.models &= (sameMicrosecondPoint(pts, inputTime) ? 1 : 0) | (sameMicrosecondPoint(pts, streamTime) ? 2 : 0);
    if (this.models === 0) { this.refuse('native Opus timestamp contradicts sample accounting'); return unavailable(); }
    const sourceOffsetUs = Number(offset / RATE);
    this.emitted += BigInt(pcm.numberOfFrames);
    if (end === span.end) this.spans.shift();
    return { renderTimeUs: (span.input.renderTimeUs ?? 0) + sourceOffsetUs, input: span.input, sourceOffsetUs };
  }

  /** Flush is a sample-count boundary, not a new priming origin or end trim. */
  finish(): void {
    if (this.failure) return;
    const available = this.submitted > BigInt(this.profile!.preSkip48k) ? this.submitted - BigInt(this.profile!.preSkip48k) : 0n;
    if (this.emitted !== available) this.refuse('native Opus flush left unaccounted samples');
  }
  poison(): void { this.refuse('native Opus submission failed'); }
}
