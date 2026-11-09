import type { MoqtObject } from '@openmoq/transport';
import { LocmafTrackDecoder, isCmafHeader, isSyncSampleFlags, parseLocmafTrackContext, readCmafObjectSamples } from '@openmoq/locmaf';
import type { LocmafTrackContext } from '@openmoq/locmaf';
import type { CmafAssemblyDiscardReason } from './interfaces.js';

/** Deterministic retained-proof accounting, not a measurement of JS heap allocation. */
export const SEEK_INTERVAL_BYTES = 64;
export interface SeekSampleInterval { readonly startTicks: bigint; readonly endTicks: bigint; }

/** Scalar facts from the input's existing validated sample walk. */
export interface SeekCmafTiming {
  readonly firstPtsTicks: bigint;
  readonly firstDurationTicks: bigint;
  readonly independent: boolean;
  readonly earliestPtsTicks: bigint;
  readonly intervals?: readonly SeekSampleInterval[];
}
export interface SeekCmafChunk {
  readonly bytes: Uint8Array;
  readonly groupId: bigint;
  readonly objectId: bigint;
  /** Opt-in source facts for indexed-boundary preparation. */
  readonly timing?: SeekCmafTiming;
  /** Actual contributing Object contexts; unknown split halves retain their slots. */
  readonly inputs?: readonly (object | undefined)[];
}
interface Options {
  readonly init: Uint8Array;
  readonly packaging: 'cmaf' | 'locmaf';
  readonly role: 'video' | 'audio';
  readonly location: { readonly groupId: bigint; readonly objectId: bigint };
  readonly mediaPts: number;
  readonly timestampRounding: 'nearest' | 'floor';
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly retainTiming?: boolean;
  readonly retainIntervals?: boolean;
  readonly indexedGroupStart?: boolean;
  /** Media outcomes only: verified initialization and benign statuses create no media unit. */
  readonly onDiscard?: (input: object, reason: CmafAssemblyDiscardReason) => void | Promise<void>;
}

/** Ordered FETCH preparation. The indexed Object, not an earlier SAP, anchors MSF media time. */
export class SeekCmafInput {
  readonly context: LocmafTrackContext;
  private readonly decoder: LocmafTrackDecoder | null;
  private staged: SeekCmafChunk[] = [];
  private pending: (SeekCmafChunk & { readonly inputCount: number }) | null = null;
  private retired: 'invalid media' | 'decoder reset' | null = null;
  private independent = false;
  /** Copied media plus retained sample-interval accounting. */
  private stagedBytes = 0;
  private stagedObjects = 0;
  private sourceTimeUs: bigint | null = null;
  private captureIntervals: boolean;
  private firstMedia = true;

  constructor(private readonly options: Options) {
    if (!Number.isSafeInteger(options.mediaPts) || options.mediaPts < 0) throw new RangeError('Seek index needs an integral nonnegative media timestamp');
    if (![options.maxObjects, options.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid seek preparation budget');
    if (options.timestampRounding !== 'nearest' && options.timestampRounding !== 'floor') throw new Error('Unknown media timeline timestamp rounding');
    this.context = parseLocmafTrackContext(options.init);
    this.decoder = options.packaging === 'locmaf' ? new LocmafTrackDecoder(options.init) : null;
    this.captureIntervals = options.retainIntervals === true;
  }

  get ready(): boolean { return this.retired === null && this.independent && this.sourceTimeUs !== null; }
  /** Existing raw-input counts only; callers own wire-byte accounting. */
  get retainedObjectCount(): number { return this.stagedObjects + (this.pending?.inputCount ?? 0); }
  /** Proof metadata only; decoder/reference and accepted raw work are unchanged. */
  finishGroupPreparation(): void { this.captureIntervals = false; }
  get anchor(): { readonly sourceTimeUs: bigint; readonly rebasedTimeUs: { readonly numerator: bigint; readonly denominator: bigint } } | null {
    return this.ready ? { sourceTimeUs: this.sourceTimeUs!,
      rebasedTimeUs: { numerator: this.sourceTimeUs!, denominator: 1n } } : null;
  }

  /** Retains only bounded preroll before preparation; afterwards returns one input's complete media. */
  push(object: MoqtObject, input?: object): SeekCmafChunk[] {
    // A completed pair leaves pending before sample/index validation. Retain its
    // diagnostic ownership locally until this call has actually returned it.
    const pendingInputs = this.pending?.inputs;
    try {
      if (this.retired !== null) throw new Error('Seek CMAF preparation is retired');
      return this.prepare(object, input);
    } catch (error) {
      this.retire(this.retired ?? 'invalid media', object.kind === 'data' ? input : undefined, pendingInputs);
      throw error;
    }
  }

  private prepare(object: MoqtObject, input: object | undefined): SeekCmafChunk[] {
    if (object.kind !== 'data') {
      if (this.pending) throw new Error('Seek stream ended a group with incomplete CMAF media');
      return [];
    }
    const groupId = BigInt(object.groupId), objectId = BigInt(object.objectId);
    let bytes: Uint8Array = object.payload;
    if (this.decoder) {
      const decoded = this.decoder.push(groupId, objectId, bytes);
      if (decoded.kind === 'rejected') throw decoded.error;
      bytes = decoded.bytes;
    }
    if (isCmafHeader(bytes)) {
      if (bytes.length !== this.options.init.length || bytes.some((value, i) => value !== this.options.init[i])) {
        throw new Error('Historical seek initialization differs from the selected output');
      }
      if (this.options.indexedGroupStart && this.firstMedia) throw new Error('Indexed group begins with initialization instead of media');
      return [];
    }
    // Count actual retained media Objects. Ignored initialization must neither
    // consume a media slot nor erase the pending/preroll ownership budget.
    const inputCount = (this.pending?.inputCount ?? 0) + 1;
    if (inputCount + this.stagedObjects > this.options.maxObjects) throw new Error('Seek partial media exceeds preparation object budget');
    let firstObjectId = objectId;
    let inputs: (object | undefined)[] | undefined;
    if (this.pending) {
      if (groupId !== this.pending.groupId) throw new Error('Seek group changed before its CMAF pair completed');
      firstObjectId = this.pending.objectId;
      if (bytes.length > this.options.maxBytes - this.stagedBytes - this.pending.bytes.length) {
        throw new Error('Seek partial media exceeds preparation byte budget');
      }
      const combined = new Uint8Array(this.pending.bytes.length + bytes.length);
      combined.set(this.pending.bytes); combined.set(bytes, this.pending.bytes.length); bytes = combined;
      if (this.pending.inputs !== undefined) inputs = [...this.pending.inputs, input];
      else if (input !== undefined) {
        inputs = new Array<object | undefined>(inputCount).fill(undefined);
        inputs[inputCount - 1] = input;
      }
      this.pending = null;
    } else if (input !== undefined) inputs = [input];
    const reads = readCmafObjectSamples(bytes, this.context);
    if (reads === null) {
      if (bytes.length > this.options.maxBytes - this.stagedBytes) throw new Error('Seek partial media exceeds preparation byte budget');
      this.pending = { bytes: bytes.slice(), groupId, objectId: firstObjectId, inputCount,
        ...(inputs === undefined ? {} : { inputs }) };
      return [];
    }
    const first = reads[0];
    if (!first || !first.effective.durations.length) throw new Error('Seek Object contains no media samples');
    let earliestPtsTicks: bigint | null = null;
    const intervals: SeekSampleInterval[] | undefined = this.captureIntervals ? [] : undefined;
    for (const read of reads) {
      const { durations, sizes, compositionTimeOffsets } = read.effective;
      if (sizes.length !== durations.length || compositionTimeOffsets.some(offset => !Number.isSafeInteger(offset))) {
        throw new Error('Seek Object has incomplete media samples');
      }
      let decodeTime = read.effective.baseMediaDecodeTime, sampleBytes = 0;
      for (let i = 0; i < durations.length; i++) {
        const duration = durations[i]!, size = sizes[i]!;
        if (!Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(size) || size <= 0) {
          throw new Error('Seek Object has incomplete media samples');
        }
        sampleBytes += size;
        if (this.options.retainTiming) {
          const pts = decodeTime + BigInt(compositionTimeOffsets[i] ?? 0);
          if (earliestPtsTicks === null || pts < earliestPtsTicks) earliestPtsTicks = pts;
          if (intervals) {
            if (intervals.length >= Math.floor((this.options.maxBytes - this.stagedBytes - bytes.length) / SEEK_INTERVAL_BYTES)) throw new Error('Group sample proof exceeds preparation byte budget');
            intervals.push(Object.freeze({ startTicks: pts, endTicks: pts + BigInt(duration) }));
          }
          decodeTime += BigInt(duration);
        }
      }
      if (sampleBytes > read.mdat.length) throw new Error('Seek Object has incomplete media samples');
    }
    const firstPts = first.effective.baseMediaDecodeTime + BigInt(first.effective.compositionTimeOffsets[0] ?? 0);
    if (this.options.indexedGroupStart && this.firstMedia && (groupId !== this.options.location.groupId || firstObjectId !== this.options.location.objectId
        || this.options.role === 'video' && !isSyncSampleFlags(first.effective.flags[0] ?? -1))) throw new Error('Group does not begin at its indexed independent media Object');
    this.firstMedia = false;
    if (groupId === this.options.location.groupId && firstObjectId === this.options.location.objectId) {
      // MSF-00 §7.1 rounds the actual first sample; MSF-01 §7.1.1 floors it.
      // The index locates media; it does not authorize rebasing a different
      // source timeline onto its rounded number. Keep the parsed precision.
      const scale = BigInt(this.context.timescale), actual = firstPts * 1000n;
      const indexed = BigInt(this.options.mediaPts) * scale, difference = actual - indexed;
      const matches = this.options.timestampRounding === 'floor'
        ? difference >= 0n && difference < scale
        : 2n * (difference < 0n ? -difference : difference) <= scale;
      if (!matches) throw new Error('CMAF first sample does not match its media timeline index');
      this.sourceTimeUs = firstPts * 1_000_000n / scale;
    } else if (this.sourceTimeUs === null && (groupId > this.options.location.groupId
        || groupId === this.options.location.groupId && firstObjectId > this.options.location.objectId)) {
      throw new Error('Seek FETCH did not contain its indexed Object');
    }
    this.independent ||= this.options.role === 'audio' || isSyncSampleFlags(first.effective.flags[0] ?? -1);
    const chunk: SeekCmafChunk = { bytes, groupId, objectId: firstObjectId,
      ...(this.options.retainTiming ? { timing: Object.freeze({ firstPtsTicks: firstPts,
        firstDurationTicks: BigInt(first.effective.durations[0]!),
        independent: this.options.role === 'audio' || isSyncSampleFlags(first.effective.flags[0] ?? -1),
        earliestPtsTicks: earliestPtsTicks!, ...(intervals ? { intervals: Object.freeze(intervals) } : {}) }) } : {}),
      ...(inputs === undefined ? {} : { inputs }) };
    if (!this.ready) {
      const retainedBytes = bytes.length + (intervals?.length ?? 0) * SEEK_INTERVAL_BYTES;
      if (this.stagedObjects >= this.options.maxObjects || retainedBytes > this.options.maxBytes - this.stagedBytes) {
        throw new Error('Seek preroll exceeds preparation budget');
      }
      this.staged.push({ ...chunk, bytes: bytes.slice() }); this.stagedBytes += retainedBytes;
      this.stagedObjects += inputCount;
      return [];
    }
    // The first retained media must itself start independently. A later SAP
    // cannot authorize an earlier dependent prefix on a fresh decoder.
    if (this.staged.length && this.options.role === 'video') {
      const start = readCmafObjectSamples(this.staged[0]!.bytes, this.context)![0]!;
      if (!isSyncSampleFlags(start.effective.flags[0] ?? -1)) throw new Error('Seek preroll does not begin at an independent sample');
    }
    const result = [...this.staged.splice(0), chunk];
    this.stagedBytes = 0; this.stagedObjects = 0;
    return result;
  }

  end(): void {
    if (!this.ready || this.pending) {
      this.retire(this.retired ?? 'invalid media');
      throw new Error('Seek FETCH ended without complete indexed media and independent preroll');
    }
  }

  /** Retire only preparation-owned inputs; returned chunks already belong to the caller. */
  cancel(): void {
    if (this.retired === null) this.retire('decoder reset');
  }

  private retire(reason: 'invalid media' | 'decoder reset', input?: object,
    previousPendingInputs?: readonly (object | undefined)[]): void {
    const staged = this.staged, pending = this.pending;
    this.retired ??= reason;
    this.staged = []; this.pending = null;
    this.stagedBytes = 0; this.stagedObjects = 0;
    this.independent = false; this.sourceTimeUs = null;
    this.decoder?.reset();
    if (!this.options.onDiscard) return;

    // Detach every held context before optional observers can reenter. Allocate
    // the bounded terminal list only when there is a known input to report.
    let known: object[] | undefined;
    const retain = (context: object | undefined) => {
      if (context !== undefined && !known?.includes(context)) (known ??= []).push(context);
    };
    for (const chunk of staged) if (chunk.inputs) for (const context of chunk.inputs) retain(context);
    if (pending?.inputs) for (const context of pending.inputs) retain(context);
    if (previousPendingInputs) for (const context of previousPendingInputs) retain(context);
    retain(input);
    if (known) for (const context of known) this.discardInput(context, this.retired);
  }

  private discardInput(input: object | undefined, reason: CmafAssemblyDiscardReason): void {
    if (input === undefined || !this.options.onDiscard) return;
    try {
      const result = this.options.onDiscard(input, reason);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch { /* Optional outcomes never change media delivery or the original refusal. */ }
  }
}

/** Coverage is measured on emitted presentation time. Without a target, observe ends only. */
export function seekChunkCoverage(bytes: Uint8Array, context: LocmafTrackContext, targetMs?: number, retainMinimum = false) {
  const reads = readCmafObjectSamples(bytes, context);
  if (reads === null) throw new Error('Seek assembler emitted incomplete media');
  const targetUs = targetMs === undefined ? undefined : targetMs * 1000;
  let endTimeSeconds = -Infinity, coversTarget = false, maxPresentationEndTicks: bigint | null = null;
  let minPresentationTicks: bigint | null = null;
  for (const read of reads) {
    let decodeTime = read.effective.baseMediaDecodeTime;
    for (let i = 0; i < read.effective.durations.length; i++) {
      const duration = BigInt(read.effective.durations[i]!);
      const presentation = decodeTime + BigInt(read.effective.compositionTimeOffsets[i] ?? 0);
      if (retainMinimum && (minPresentationTicks === null || presentation < minPresentationTicks)) minPresentationTicks = presentation;
      const startUs = Number(presentation) * 1_000_000 / context.timescale;
      const endUs = Number(presentation + duration) * 1_000_000 / context.timescale;
      if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || duration <= 0n) throw new Error('Seek presentation is not representable');
      endTimeSeconds = Math.max(endTimeSeconds, endUs / 1_000_000);
      const endTicks = presentation + duration;
      if (maxPresentationEndTicks === null || endTicks > maxPresentationEndTicks) maxPresentationEndTicks = endTicks;
      coversTarget ||= targetUs !== undefined && startUs <= targetUs && targetUs < endUs;
      decodeTime += duration;
    }
  }
  if (!Number.isFinite(endTimeSeconds) || maxPresentationEndTicks === null) throw new Error('Seek assembler emitted no samples');
  return { endTimeSeconds, coversTarget, maxPresentationEndTicks, ...(retainMinimum ? { minPresentationTicks: minPresentationTicks! } : {}) };
}
