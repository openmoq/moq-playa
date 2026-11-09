import type { MoqtObject, MoqtObjectData } from '@openmoq/transport';
import { toAudioChunkInit, toVideoChunkInit } from '@openmoq/loc';
import type { AudioChunkInit, LocHeaders, SourceTimestamp, VideoChunkInit } from '@openmoq/loc';
import { isKeyframePayload, type PlaybackSample } from '@openmoq/playback';
import { PreparedOutputEvidence } from './prepared-output-evidence.js';
import { nativeTimeUs, type FractionUs } from './presentation-placement.js';
import type { CmafAssemblyDiscardReason } from './interfaces.js';

/** Deterministic retained-proof accounting, not a JS heap measurement. */
export const LOC_SEEK_PROOF_BYTES = 256;
const MAX_ID = (1n << 64n) - 1n;
const typedByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;

export interface LocSeekLocation { readonly groupId: bigint; readonly objectId: bigint; }
/**
 * An explicit HOST policy for a validated, unit-rate source/content relation.
 * The indexed Object supplies the source anchor and quantized content anchor;
 * it does not prove a rate, continuity, or an encode-wallclock/capture relation.
 */
export interface LocIndexedPlacement {
  readonly sourceAnchor: SourceTimestamp;
  readonly mediaPts: number;
  readonly timestampRounding: 'floor' | 'nearest';
}
export interface LocIndexedTime {
  readonly nominalUs: FractionUs;
  readonly lowerUs: FractionUs;
  readonly upperUs: FractionUs;
  readonly upperInclusive: boolean;
}
/** An already observed source point under the host's existing placement. */
export interface LocSeekResumePoint {
  readonly source: SourceTimestamp;
  readonly placement: LocIndexedPlacement;
}

function snapshotSource(value: SourceTimestamp): SourceTimestamp {
  const { ticks, ticksPerSecond, domain } = value;
  if (typeof ticks !== 'bigint' || typeof ticksPerSecond !== 'bigint' || ticksPerSecond <= 0n
      || (domain !== 'media' && domain !== 'unix')) throw new TypeError('Invalid LOC placement source anchor');
  return Object.freeze({ ticks, ticksPerSecond, domain });
}

/** Snapshot a host-supplied placement before any output registration. */
export function snapshotLocIndexedPlacement(value: LocIndexedPlacement): LocIndexedPlacement {
  const { sourceAnchor, mediaPts, timestampRounding } = value;
  const anchor = snapshotSource(sourceAnchor);
  if (!Number.isSafeInteger(mediaPts)) throw new RangeError('Invalid LOC placement media index');
  if (timestampRounding !== 'floor' && timestampRounding !== 'nearest') throw new TypeError('Invalid LOC placement rounding');
  return Object.freeze({ sourceAnchor: anchor, mediaPts, timestampRounding });
}

/** Copy host-owned evidence, not network or native observation proof. */
export function snapshotLocResumePoint(value: LocSeekResumePoint): LocSeekResumePoint {
  const { source: requestedSource, placement: requestedPlacement } = value;
  const placement = snapshotLocIndexedPlacement(requestedPlacement), source = snapshotSource(requestedSource);
  if (source.domain !== placement.sourceAnchor.domain) throw new TypeError('LOC resume source domain differs from placement');
  return Object.freeze({ source, placement });
}

/** Project the observed nominal point without applying either index's uncertainty again. */
export function projectLocResumePoint(reference: LocSeekResumePoint, destination: LocIndexedPlacement): LocSeekResumePoint {
  const observed = snapshotLocResumePoint(reference), placement = snapshotLocIndexedPlacement(destination);
  const nominal = locIndexedTime(observed.placement, observed.source)!.nominalUs;
  const anchor = placement.sourceAnchor;
  // Express the exact seconds delta in destination ticks. Extend its supplied
  // scale only when necessary to represent a fractional tick; never round it.
  const deltaTicks = timeFraction((nominal.numerator - BigInt(placement.mediaPts) * 1000n * nominal.denominator)
    * anchor.ticksPerSecond, nominal.denominator * 1_000_000n);
  const source = Object.freeze({ ticks: anchor.ticks * deltaTicks.denominator + deltaTicks.numerator,
    ticksPerSecond: anchor.ticksPerSecond * deltaTicks.denominator, domain: anchor.domain });
  return Object.freeze({ source, placement });
}

/** Pure exact placement, in microseconds. The nominal point is not exact PTS. */
export function locIndexedTime(placement: LocIndexedPlacement, point: SourceTimestamp): LocIndexedTime | null {
  const anchor = placement.sourceAnchor;
  if (!Number.isSafeInteger(placement.mediaPts)
      || (placement.timestampRounding !== 'floor' && placement.timestampRounding !== 'nearest')
      || typeof anchor.ticks !== 'bigint' || typeof anchor.ticksPerSecond !== 'bigint' || anchor.ticksPerSecond <= 0n
      || point.domain !== anchor.domain || (point.domain !== 'media' && point.domain !== 'unix')
      || typeof point.ticks !== 'bigint' || typeof point.ticksPerSecond !== 'bigint' || point.ticksPerSecond <= 0n) return null;
  const denominator = point.ticksPerSecond * anchor.ticksPerSecond;
  // Subtract exact source fractions before converting anything to Number. A
  // large Unix/application epoch must not erase a small presentation delta.
  const delta = point.ticks * anchor.ticksPerSecond - anchor.ticks * point.ticksPerSecond;
  const numerator = BigInt(placement.mediaPts) * 1000n * denominator + delta * 1_000_000n;
  const nearest = placement.timestampRounding === 'nearest';
  return Object.freeze({ nominalUs: timeFraction(numerator, denominator),
    lowerUs: timeFraction(numerator - (nearest ? 500n * denominator : 0n), denominator),
    upperUs: timeFraction(numerator + (nearest ? 500n : 1000n) * denominator, denominator), upperInclusive: nearest });
}

/** Pure nominal public position, after exact epoch subtraction; no output sampling. */
export function locIndexedPositionMs(placement: LocIndexedPlacement, source: SourceTimestamp): number | null {
  const time = locIndexedTime(placement, source);
  if (time === null || time.nominalUs.numerator < 0n) return null;
  const { numerator, denominator: scale } = time.nominalUs;
  const denominator = scale * 1000n, whole = numerator / denominator;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  // A bounded proper fraction avoids Infinity/Infinity for valid huge scales.
  const part = Number(((numerator % denominator) << 53n) / denominator) / 2 ** 53;
  const value = Number(whole) + part;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function timeFraction(numerator: bigint, denominator: bigint): FractionUs {
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b !== 0n) { const rest = a % b; a = b; b = rest; }
  const divisor = a || 1n;
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

export interface LocSeekInputOptions {
  readonly role: 'video' | 'audio';
  readonly codec?: string;
  readonly location: LocSeekLocation;
  readonly mediaPts: number;
  readonly targetMs: number;
  readonly timestampRounding: 'floor' | 'nearest';
  /** Omit for exact declared-media PTS; never auto-selected after an index mismatch. */
  readonly placementMode?: 'indexed-relative';
  /** Host-validated observed point; implies indexed-relative placement and preserves its phase. */
  readonly resume?: LocSeekResumePoint;
  readonly maxObjects: number;
  /** Retained coded units; defaults to maxObjects for the one-sample LOC path. */
  readonly maxSamples?: number;
  readonly maxBytes: number;
  readonly onDiscard?: (input: object, reason: CmafAssemblyDiscardReason) => void | Promise<void>;
}
export interface LocSeekItem {
  readonly object: MoqtObjectData;
  /** Present for a sample carried within a multi-sample wire Object. */
  readonly sampleIndex?: number;
  /** Host-parsed headers; all retained mutable byte/metadata containers are copied. */
  readonly headers: LocHeaders;
  readonly chunk: VideoChunkInit | AudioChunkInit;
  readonly sourceTimestamp: SourceTimestamp;
  readonly input?: object;
}
export interface LocSeekSampleObject {
  readonly object: MoqtObjectData;
  readonly samples: readonly PlaybackSample[];
  readonly input?: object;
}
/** Encoded audio ownership only; no selected time, PCM trim or coverage proof. */
export interface LocSeekAudioPrefix {
  readonly kind: 'audio-prefix';
  readonly anchor: SourceTimestamp;
  readonly indexedLocation: LocSeekLocation;
  readonly placement?: LocIndexedPlacement;
  readonly items: readonly LocSeekItem[];
  readonly sampleObjects?: readonly LocSeekSampleObject[];
}
export type LocSeekPreparation = {
  readonly kind: 'ready';
  /** The actual indexed sample, never an index-rebased source. */
  readonly anchor: SourceTimestamp;
  readonly indexedLocation: LocSeekLocation;
  /** Present only for explicit indexed-relative placement; raw anchor is retained. */
  readonly placement?: LocIndexedPlacement;
  /** Least provably eligible presentation point >= target, with decode-order tie breaking. */
  readonly selected: { readonly location: LocSeekLocation; readonly sourceTimestamp: SourceTimestamp; readonly sampleIndex?: number };
  /** Whole retained decode prefix. Selection does not trim decoder dependencies. */
  readonly items: readonly LocSeekItem[];
  readonly sampleObjects?: readonly LocSeekSampleObject[];
} | { readonly kind: 'need-more'; readonly reason: 'target-not-in-closed-group' };

/**
 * Raw LOC preparation of one group prefix. The host supplies parseLocHeaders output,
 * selected track identity, ordered transformed objects, and authoritative group
 * closure. No wire-profile inference, LOCMAF parsing, network pagination, or output clock.
 *
 * A live push takes ownership of its input token only after identifying DATA.
 * Calls refused because already closed/retired/busy do not acquire new ownership.
 * finishGroup('ready') transfers every item; need-more retains ownership until
 * cancel or continueAt. finishAudioGroup transfers its items but retains a
 * closed anchor context for continuation, without claiming PCM coverage.
 * Unix requires explicit indexed-relative host policy;
 * unknown timing cannot prove readiness. Exact declared-media behavior remains
 * the default.
 */
export class LocSeekInput {
  private readonly options: LocSeekInputOptions & { readonly maxSamples: number };
  private evidence: PreparedOutputEvidence | undefined;
  private readonly target;
  private items: LocSeekItem[] = [];
  private sampleObjects: LocSeekSampleObject[] | undefined;
  private bytes = 0;
  private anchor: SourceTimestamp | null = null;
  private preparingGroup: bigint;
  private inheritedAnchor = false;
  private cancelled = false;
  private lastObjectId: bigint | null = null;
  private lastSampleIndex = -1;
  private objectCount = 0;
  private closed = false;
  private retired = false;
  private busy = false;
  private activeInput: object | undefined;

  constructor(options: LocSeekInputOptions) {
    // Snapshot options once; later output/cleanup never consults caller getters.
    const { role, codec, mediaPts, targetMs, timestampRounding, placementMode, resume: requestedResume, maxObjects, maxSamples = maxObjects, maxBytes, onDiscard } = options;
    const resume = requestedResume === undefined ? undefined : snapshotLocResumePoint(requestedResume);
    const location = Object.freeze({ groupId: options.location.groupId, objectId: options.location.objectId });
    if (role !== 'video' && role !== 'audio') throw new TypeError('Unknown LOC role');
    if (!Number.isSafeInteger(mediaPts)) throw new RangeError('Seek index needs integral safe media milliseconds');
    if (!Number.isFinite(targetMs) || targetMs < 0) throw new RangeError('Invalid seek target');
    if (timestampRounding !== 'floor' && timestampRounding !== 'nearest') throw new TypeError('Unknown index rounding');
    if (placementMode !== undefined && placementMode !== 'indexed-relative') throw new TypeError('Unknown LOC placement mode');
    if (![maxObjects, maxSamples, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid preparation budget');
    checkId(location.groupId); checkId(location.objectId);
    this.options = Object.freeze({ role, ...(codec === undefined ? {} : { codec }), location, mediaPts, targetMs,
      timestampRounding, ...(placementMode === undefined && resume === undefined ? {} : { placementMode: 'indexed-relative' as const }),
      ...(resume === undefined ? {} : { resume }),
      maxObjects, maxSamples, maxBytes, ...(onDiscard === undefined ? {} : { onDiscard }) });
    this.preparingGroup = location.groupId;
    this.evidence = new PreparedOutputEvidence('loc', role, codec);
    // nativeTimeUs preserves the supplied binary64 exactly. Its input here is
    // milliseconds, so divide its microsecond result by 1000, without a rounded
    // Number division before rational comparison. This is not a native sample.
    const exact = nativeTimeUs(targetMs)!;
    this.target = { numerator: exact.numerator, denominator: exact.denominator * 1000n };
  }

  get retainedObjectCount(): number { return this.objectCount; }
  get retainedSampleCount(): number { return this.items.length; }
  get retainedBytes(): number { return this.bytes; }

  push(object: MoqtObject, headers: LocHeaders, input?: object): void {
    this.available();
    this.busy = true;
    try {
      const kind = object.kind;
      this.current();
      // Status/stream flags do not assert completeness, nor create a media unit.
      if (kind !== 'data') return;
      this.activeInput = input;
      if (this.sampleObjects) throw new Error('Cannot mix raw LOC and sample-batch preparation');
      if (this.objectCount >= this.options.maxObjects) throw new Error('LOC preparation object budget exceeded');
      if (this.items.length >= this.options.maxSamples) throw new Error('LOC preparation sample budget exceeded');
      const item = this.copyInput(object as MoqtObjectData, headers, input);
      this.admit(item);
      this.activeInput = undefined;
    } catch (error) {
      this.retire('invalid media');
      throw error;
    } finally { this.busy = false; }
  }

  /**
   * Admit already validated coded samples of ONE original wire Object. The
   * first sample alone anchors its index (MSF-01 §7.1.1). The Object is copied
   * once; sample storage/proofs have their own cumulative retained allowance.
   * Empty Header carriers advance only the wire frontier, never readiness.
   */
  pushSamples(object: MoqtObjectData, samples: readonly PlaybackSample[], input?: object): void {
    this.available(); this.busy = true;
    try {
      this.activeInput = input;
      if (this.items.length && !this.sampleObjects) throw new Error('Cannot mix raw LOC and sample-batch preparation');
      if (this.objectCount >= this.options.maxObjects) throw new Error('LOC preparation object budget exceeded');
      const { groupId, objectId } = object;
      checkId(groupId); checkId(objectId); this.current();
      if (groupId !== this.preparingGroup) throw new Error('LOC group changed without explicit closure');
      if (this.lastObjectId !== null && objectId <= this.lastObjectId) throw new Error('LOC inputs are not in decode Object order');
      // Freeze wire identity/storage before any sample/header/chunk getter.
      const owned = this.copyCarrier(object, { groupId, objectId });
      const count = samples.length;
      this.current();
      if (!Number.isSafeInteger(count) || count < 0 || count > this.options.maxSamples - this.items.length) throw new Error('LOC preparation sample budget exceeded');
      const capturedSamples: PlaybackSample[] = [];
      for (let index = 0; index < count; index++) {
        const sample = samples[index]; this.current();
        if (!sample || sample.sampleIndex !== index) throw new Error('Invalid flat sample index');
        const captured = { sampleIndex: index, headers: sample.headers, chunk: sample.chunk };
        const item = this.copyInput(owned, captured.headers, input, captured, owned);
        this.current(); this.admit(item);
        capturedSamples.push(Object.freeze({ sampleIndex: index, headers: item.headers, chunk: item.chunk }));
      }
      if (!count) { this.lastObjectId = objectId; this.lastSampleIndex = -1; this.objectCount++; }
      (this.sampleObjects ??= []).push(Object.freeze({ object: owned, samples: Object.freeze(capturedSamples),
        ...(input === undefined ? {} : { input }) }));
      this.activeInput = undefined;
    } catch (error) { this.retire('invalid media'); throw error; }
    finally { this.busy = false; }
  }

  private admit(item: LocSeekItem): void {
      this.current();
      if (item.object.groupId !== this.preparingGroup) throw new Error('LOC group changed without explicit closure');
      const sameObject = item.object.objectId === this.lastObjectId;
      if (this.lastObjectId !== null && (item.object.objectId < this.lastObjectId
          || sameObject && (item.sampleIndex === undefined || item.sampleIndex !== this.lastSampleIndex + 1))) throw new Error('LOC inputs are not in decode Object order');
      const domain = this.anchor?.domain ?? this.options.resume?.source.domain ?? this.items[0]?.sourceTimestamp.domain;
      if (this.options.placementMode && domain !== undefined && item.sourceTimestamp.domain !== domain) {
        throw new Error('LOC source domain changed within indexed placement');
      }
      if (!this.items.length) {
        const independent = item.sampleIndex === undefined ? this.evidence?.inspect(item.object, item.headers)
          : this.options.role === 'audio' || item.chunk.type === 'key'
            && (!this.options.codec || isKeyframePayload(this.options.codec, item.chunk.data) !== false);
        if (!independent) throw new Error('LOC retained prefix does not start with independently coded input');
      }
      this.current();
      if (!this.inheritedAnchor && item.object.objectId === this.options.location.objectId
          && (item.sampleIndex === undefined || item.sampleIndex === 0)) {
        if (this.options.resume) this.validateResumeAnchor(item.sourceTimestamp);
        else if (!this.options.placementMode) {
          const { ticks, ticksPerSecond } = item.sourceTimestamp;
          const difference = ticks * 1000n - BigInt(this.options.mediaPts) * ticksPerSecond;
          const matches = this.options.timestampRounding === 'floor'
            ? difference >= 0n && difference < ticksPerSecond
            : 2n * (difference < 0n ? -difference : difference) <= ticksPerSecond;
          if (!matches) throw new Error('LOC indexed sample does not match its media timeline index');
        }
        this.anchor = item.sourceTimestamp;
      } else if (!this.inheritedAnchor && this.anchor === null && item.object.objectId > this.options.location.objectId) {
        throw new Error('LOC preparation omitted its exact indexed Object');
      }
      this.current();
      this.items.push(item);
      if (!sameObject) this.objectCount++;
      this.lastObjectId = item.object.objectId;
      this.lastSampleIndex = item.sampleIndex ?? -1;
  }

  /** Caller-authoritative closure, never inferred from FIN or a sparse ObjectID. */
  finishGroup(groupId: bigint): LocSeekPreparation {
    const anchor = this.closeGroup(groupId), placement = this.placementFor(anchor);
    let selected: LocSeekItem | undefined;
    for (const item of this.items) {
      const source = item.sourceTimestamp;
      const observed = this.options.resume?.source;
      if (observed) {
        if (source.ticks * observed.ticksPerSecond < observed.ticks * source.ticksPerSecond) continue;
      } else if (placement) {
        const interval = locIndexedTime(placement, source)!;
        if (interval.lowerUs.numerator * this.target.denominator < this.target.numerator * interval.lowerUs.denominator) continue;
      } else if (source.ticks * 1_000_000n * this.target.denominator < this.target.numerator * source.ticksPerSecond) continue;
      if (!selected || source.ticks * selected.sourceTimestamp.ticksPerSecond
          < selected.sourceTimestamp.ticks * source.ticksPerSecond) selected = item;
    }
    if (!selected) return Object.freeze({ kind: 'need-more', reason: 'target-not-in-closed-group' });
    const result: LocSeekPreparation = Object.freeze({ kind: 'ready', anchor,
      indexedLocation: this.options.location, ...(placement === undefined ? {} : { placement }),
      selected: Object.freeze({ location: Object.freeze({ groupId: selected.object.groupId, objectId: selected.object.objectId }),
        sourceTimestamp: selected.sourceTimestamp, ...(selected.sampleIndex === undefined ? {} : { sampleIndex: selected.sampleIndex }) }), items: Object.freeze(this.items),
      ...(this.sampleObjects ? { sampleObjects: Object.freeze(this.sampleObjects) } : {}) });
    // No callbacks after the final owner check. Detach before transfer.
    this.current();
    this.clearPrefix(); this.anchor = null; this.retired = true;
    return result;
  }

  /**
   * Transfer an entire closed encoded audio prefix, including preroll. Only
   * the caller's actual decoded PCM can prove priming, trim and target coverage.
   * Keep a live closed anchor context; push/finish require a successor helper.
   */
  finishAudioGroup(groupId: bigint): LocSeekAudioPrefix {
    this.available();
    if (this.options.role !== 'audio') throw new TypeError('LOC prefix transfer requires audio role');
    const anchor = this.closeGroup(groupId), placement = this.placementFor(anchor);
    const result: LocSeekAudioPrefix = Object.freeze({ kind: 'audio-prefix', anchor,
      indexedLocation: this.options.location, ...(placement === undefined ? {} : { placement }),
      items: Object.freeze(this.items), ...(this.sampleObjects ? { sampleObjects: Object.freeze(this.sampleObjects) } : {}) });
    this.current();
    // Caller owns the array/items/tokens from here. Keep no prefix evidence,
    // bytes or input identities in the closed helper, only original anchoring.
    this.clearPrefix();
    return result;
  }

  private closeGroup(groupId: bigint): SourceTimestamp {
    this.available();
    if (groupId !== this.preparingGroup) {
      this.retire('invalid media'); throw new Error('Wrong LOC group closure');
    }
    if (this.anchor === null || (!this.items.length && !this.inheritedAnchor)) {
      this.retire('invalid media'); throw new Error('Closed LOC group has no exact indexed independent prefix');
    }
    this.closed = true;
    return this.anchor;
  }

  private placementFor(anchor: SourceTimestamp): LocIndexedPlacement | undefined {
    if (this.options.resume) return this.options.resume.placement;
    return this.options.placementMode
      ? Object.freeze({ sourceAnchor: anchor, mediaPts: this.options.mediaPts, timestampRounding: this.options.timestampRounding }) : undefined;
  }

  private validateResumeAnchor(anchor: SourceTimestamp): void {
    const predicted = locIndexedTime(this.options.resume!.placement, anchor);
    if (predicted === null) throw new Error('LOC resume anchor source domain changed');
    const indexed = locIndexedTime({ sourceAnchor: anchor, mediaPts: this.options.mediaPts,
      timestampRounding: this.options.timestampRounding }, anchor)!;
    const predictedEnd = predicted.upperUs.numerator * indexed.lowerUs.denominator
      - indexed.lowerUs.numerator * predicted.upperUs.denominator;
    const indexedEnd = indexed.upperUs.numerator * predicted.lowerUs.denominator
      - predicted.lowerUs.numerator * indexed.upperUs.denominator;
    if (predictedEnd < 0n || (predictedEnd === 0n && !predicted.upperInclusive)
        || indexedEnd < 0n || (indexedEnd === 0n && !indexed.upperInclusive)) {
      throw new Error('LOC resume placement contradicts the new media timeline index');
    }
  }

  /**
   * Advance after need-more or transferred audio-prefix closure. The original
   * indexed anchor/options survive, not a prefix or an invented later index.
   * Each successor must establish its own independent prefix before readiness.
   */
  continueAt(groupId: bigint): LocSeekInput {
    this.current();
    if (this.busy) throw new Error('Reentrant LOC preparation is busy');
    // Video ready is retired. Audio-prefix and need-more retain a closed anchor.
    if (!this.closed || this.anchor === null) throw new Error('LOC continuation requires a closed need-more or audio-prefix group');
    checkId(groupId);
    if (groupId <= this.preparingGroup) throw new RangeError('LOC continuation group must increase');
    const anchor = this.anchor;
    // Detach first. Observers can cancel the owner, but cannot acquire an
    // unreturned successor. Do not construct/return one after such cancellation.
    this.retire('decoder reset');
    if (this.cancelled) throw new Error('LOC continuation was retired during cleanup');
    const successor = new LocSeekInput(this.options);
    successor.preparingGroup = groupId;
    successor.anchor = anchor;
    successor.inheritedAnchor = true;
    return successor;
  }

  /** Idempotent: only preparation-owned inputs are discarded. */
  cancel(): void { this.cancelled = true; this.retire('decoder reset'); }

  private available(): void {
    if (this.retired || this.closed) throw new Error('LOC preparation is closed or retired');
    if (this.busy) throw new Error('Reentrant LOC preparation is busy');
  }
  private current(): void { if (this.retired) throw new Error('LOC preparation was retired during input'); }

  private clearPrefix(): void {
    this.items = []; this.bytes = 0; this.lastObjectId = null; this.lastSampleIndex = -1; this.objectCount = 0;
    this.sampleObjects = undefined;
    this.activeInput = undefined; this.evidence = undefined;
  }

  private copyInput(object: MoqtObjectData, headers: LocHeaders, input?: object, sample?: PlaybackSample, previous?: MoqtObjectData): LocSeekItem {
    // Capture every wire field before header accessors. Byte ownership is
    // acquired below under the same proof/byte allowance as the raw path.
    const offered = previous ?? copyWireObject(object, bytes => bytes);
    // Scalar snapshot first. Never spread arbitrary enumerable host properties.
    const scalar: { -readonly [K in keyof LocHeaders]: LocHeaders[K] } = {};
    for (const key of ['captureTimestamp', 'duration', 'timestamp', 'timescale', 'timestampIsWallClock', 'version'] as const) {
      const value = headers[key];
      if (value !== undefined) Object.assign(scalar, { [key]: value });
    }
    const marking = headers.videoFrameMarking, level = headers.audioLevel;
    const config = headers.videoConfig, audioConfig = headers.audioConfig, unknown = headers.unknown;
    let cost = LOC_SEEK_PROOF_BYTES;
    const charge = (amount: number) => {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.options.maxBytes - this.bytes - cost) {
        throw new Error('LOC preparation byte/proof budget exceeded');
      }
      cost += amount;
    };
    charge(0);
    for (const value of [scalar.captureTimestamp, scalar.timestamp, scalar.timescale]) {
      if (value !== undefined) charge(bigintBytes(value));
    }
    const copyBytes = (data: Uint8Array): Uint8Array => {
      // Intrinsic length + typed-array copy has no host callback between charge
      // and acquisition. Later metadata getters cannot resize retained storage.
      charge(typedByteLength.call(data) as number);
      return new Uint8Array(data);
    };
    const owned = previous ?? copyWireObject(offered, copyBytes);
    if (!sample && !owned.payload.byteLength) throw new Error('LOC input contains no coded payload');
    const ownedConfig = config === undefined ? undefined : copyBytes(config);
    const ownedAudioConfig = audioConfig === undefined ? undefined : copyBytes(audioConfig);
    const extra = new Map<bigint, bigint | Uint8Array>();
    if (unknown) for (const [id, value] of unknown) {
      charge(32 + bigintBytes(id));
      this.current();
      if (typeof value === 'bigint') { charge(bigintBytes(value)); extra.set(id, value); }
      else extra.set(id, copyBytes(value));
    }
    if (marking) scalar.videoFrameMarking = Object.freeze({ startOfFrame: marking.startOfFrame, endOfFrame: marking.endOfFrame,
      independent: marking.independent, discardable: marking.discardable, baseLayerSync: marking.baseLayerSync,
      temporalId: marking.temporalId, ...(marking.layerId === undefined ? {} : { layerId: marking.layerId }),
      ...(marking.tl0PicIdx === undefined ? {} : { tl0PicIdx: marking.tl0PicIdx }) });
    if (level) scalar.audioLevel = Object.freeze({ voiceActivity: level.voiceActivity, level: level.level });
    if (ownedConfig) scalar.videoConfig = ownedConfig;
    if (ownedAudioConfig) scalar.audioConfig = ownedAudioConfig;
    if (unknown) scalar.unknown = extra;
    const frozenHeaders = Object.freeze(scalar);
    const supplied = sample?.chunk;
    const base = supplied ? Object.freeze({ type: supplied.type, timestamp: supplied.timestamp,
      ...(supplied.duration === undefined ? {} : { duration: supplied.duration }), data: copyBytes(supplied.data),
      ...(supplied.sourceTimestamp === undefined ? {} : { sourceTimestamp: snapshotSource(supplied.sourceTimestamp) }) })
      : this.options.role === 'video' ? toVideoChunkInit(owned.payload, frozenHeaders) : toAudioChunkInit(owned.payload, frozenHeaders);
    const source = base.sourceTimestamp;
    const declaredMedia = source?.domain === 'media' && scalar.timestamp !== undefined && scalar.timescale !== undefined;
    const placedUnix = this.options.placementMode === 'indexed-relative' && source?.domain === 'unix';
    if (!source || (!declaredMedia && !placedUnix)) {
      throw new Error('LOC readiness requires a consistent declared media source timestamp');
    }
    if (sample && (!base.data.byteLength || source.domain !== 'media'
        || base.timestamp !== Number(source.ticks * 1_000_000n / source.ticksPerSecond)
        || scalar.timestamp !== source.ticks || scalar.timescale !== source.ticksPerSecond
        || scalar.captureTimestamp !== source.ticks * 1_000_000n / source.ticksPerSecond
        || this.options.role === 'audio' && base.type !== 'key'
        || this.options.role === 'video' && scalar.videoFrameMarking?.independent !== (base.type === 'key'))) {
      throw new Error('Inconsistent coded sample timing or independence');
    }
    if (!Number.isSafeInteger(base.timestamp)) throw new Error('LOC decode timestamp is not safely representable');
    if (base.duration !== undefined && (!Number.isFinite(base.duration) || base.duration <= 0)) throw new Error('Invalid LOC duration');
    this.current();
    this.bytes += cost;
    // PreparedOutputEvidence supplies first-input independence, including the
    // Object-0 fallback; conversion itself only sees explicit frame marking.
    const chunk = Object.freeze({ ...base, ...(!sample && this.options.role === 'video' && !this.items.length ? { type: 'key' as const } : {}) });
    return Object.freeze({ object: owned, headers: frozenHeaders, chunk, sourceTimestamp: source,
      ...(sample === undefined ? {} : { sampleIndex: sample.sampleIndex }),
      ...(input === undefined ? {} : { input }) });
  }

  private copyCarrier(object: MoqtObjectData, location: LocSeekLocation): MoqtObjectData {
    let cost = LOC_SEEK_PROOF_BYTES;
    const charge = (amount: number) => {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.options.maxBytes - this.bytes - cost) throw new Error('LOC preparation byte/proof budget exceeded');
      cost += amount;
    };
    charge(0);
    const owned = copyWireObject(object, bytes => {
      charge(typedByteLength.call(bytes) as number); return new Uint8Array(bytes);
    }, location);
    this.current(); this.bytes += cost;
    return owned;
  }

  private retire(reason: CmafAssemblyDiscardReason): void {
    if (this.retired) return;
    this.retired = true;
    const items = this.items, carriers = this.sampleObjects, active = this.activeInput;
    this.clearPrefix(); this.anchor = null;
    const notify = this.options.onDiscard;
    if (!notify) return;
    const inputs = new Set(items.flatMap(item => item.input === undefined ? [] : [item.input]));
    if (carriers) for (const carrier of carriers) if (carrier.input !== undefined) inputs.add(carrier.input);
    if (active !== undefined) inputs.add(active);
    for (const input of inputs) {
      try { const pending = notify(input, reason); if (pending) void Promise.resolve(pending).catch(() => {}); }
      catch { /* Optional diagnostics cannot change terminal ownership or the original error. */ }
    }
  }
}

function copyWireObject(object: MoqtObjectData, copy: (bytes: Uint8Array) => Uint8Array, location?: LocSeekLocation): MoqtObjectData {
  const groupId = location?.groupId ?? object.groupId, objectId = location?.objectId ?? object.objectId;
  const { trackAlias, subgroupId, publisherPriority, payload, extensions, properties,
    subgroupContainsEndOfGroup, isFirstObjectInSubgroup } = object;
  for (const id of [groupId, objectId, trackAlias, subgroupId]) checkId(id);
  return Object.freeze({ kind: 'data', groupId, objectId, trackAlias, subgroupId, publisherPriority, payload: copy(payload),
    ...(extensions === undefined ? {} : { extensions: copy(extensions) }),
    ...(properties === undefined ? {} : { properties: copy(properties) }),
    ...(subgroupContainsEndOfGroup === undefined ? {} : { subgroupContainsEndOfGroup }),
    ...(isFirstObjectInSubgroup === undefined ? {} : { isFirstObjectInSubgroup }) });
}

function checkId(value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_ID) throw new RangeError('Invalid LOC Location/identity integer');
}
function bigintBytes(value: bigint): number {
  if (typeof value !== 'bigint') throw new TypeError('Invalid LOC timestamp metadata');
  return Math.max(1, Math.ceil((value < 0n ? -value : value).toString(16).length / 2));
}
