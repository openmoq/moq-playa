/**
 * CmafAssembler — assembles CMAF segments for MSE delivery.
 *
 * Per CMSF §3.3, each MoQ object MUST contain at least one complete CMAF
 * chunk (moof followed immediately by mdat in the same payload). This is
 * the spec-compliant path used by moqxr and other conforming publishers.
 *
 * Also handles the legacy two-object pattern (separate moof / mdat objects)
 * used by moq-rs and other non-compliant publishers.
 *
 * Patches tfdt.baseMediaDecodeTime to zero-based for MSE compatibility.
 * Pure data transformation — no MSE or DOM dependency. Testable in Node.js.
 *
 * @see draft-ietf-moq-cmsf-01 §3.3 (Object Packaging — moof+mdat)
 * @see ISO/IEC 14496-12 §8.8.12 (Track Fragment Decode Time Box)
 * @module
 */

import type { CmafAssemblyDiscardReason, CmafSourceReceipt } from '@openmoq/player';
import { mediaTrackIdentity } from './media-track-identity.js';

import {
  boxType,
  boxSize,
  readBaseMediaDecodeTime,
  findTfdtOffset,
  patchBaseMediaDecodeTime,
  concatBuffers,
  rewriteFragmentDropSamples,
  firstHevcVclNalType,
  isHevcCraNalType,
  isHevcRaslNalType,
  readMdhdTimescale,
  readTrexDefaults,
  readSegmentTimeRanges,
  readFirstSamplePresentationTime,
  type TrexDefaults,
  type TrunSample,
} from './mp4-box.js';

const SOURCE_PARTIAL = Object.freeze({ state: 'partial' as const });
const SOURCE_REFUSED = Object.freeze({ state: 'refused' as const });
const SOURCE_UNAVAILABLE = Object.freeze({ state: 'unavailable' as const });

/** Exact rational microseconds. The denominator is strictly positive. */
export interface FractionUs {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Immutable producing context; compare its token with a fresh capture for currentness. */
export interface CmafPresentationPlacement {
  readonly token: object;
  toRebasedTimeUs(sourcePresentationTimeUs: bigint): FractionUs | null;
}

export interface CmafPresentationAnchor {
  readonly sourceTimeUs: bigint;
  readonly rebasedTimeUs: FractionUs;
}

interface PresentationMap {
  readonly numerator: bigint;
  readonly denominator: bigint;
  replaced: boolean;
  refused: boolean;
}

interface PlacementState {
  revision: number;
  proven: number;
  patched: number;
  init: Uint8Array | null;
  map: PresentationMap | null;
  captured: CmafPresentationPlacement | null;
}

function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator < 0n ? quotient - 1n : quotient;
}

function fractionUs(numerator: bigint, denominator: bigint): FractionUs {
  let a = numerator < 0n ? -numerator : numerator, b = denominator;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return { numerator: numerator / a, denominator: denominator / a };
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

/**
 * Startup geometry: what the rebase produced for each track's FIRST fragment,
 * and the resulting cross-track start gap. `gapSec` is positive when video
 * starts later than audio (the mid-stream-join shape: audio joins at the live
 * edge, video waits for the next GoP boundary).
 */
export interface CmafStartupGeometry {
  readonly videoRawBmd: string;
  readonly audioRawBmd: string;
  readonly videoTimescale: number | null;
  readonly audioTimescale: number | null;
  readonly videoStartSec: number | null;
  readonly audioStartSec: number | null;
  readonly gapSec: number | null;
  readonly epochMode: 'shared' | 'legacy';
}

/** Options for CmafAssembler construction. */
export interface CmafAssemblerOptions {
  /**
   * Called when a complete moof+mdat segment is ready for MSE.
   *
   * `trackName` remains the source's display name. When supplied to push,
   * `sourceKey` identifies its full resolved namespace and name, allowing
   * downstream consumers to distinguish same-name tracks across namespaces.
   */
  readonly onSegment: (
    mediaType: 'video' | 'audio',
    segment: Uint8Array,
    trackName: string,
    groupId: bigint,
    inputs?: readonly (object | undefined)[],
    sourceKey?: string,
  ) => void;
  /**
   * Called when a decode-time discontinuity is detected (bmd went
   * backward). The MseMediaSource should clear its per-track replay index;
   * the assembler maps the new epoch after the prior emitted epoch so MSE
   * still sees one monotonic presentation timeline.
   */
  /** Optional input outcomes; never carries payloads or affects media delivery. */
  readonly onDiscard?: (input: object, reason: CmafAssemblyDiscardReason) => void | Promise<void>;
  readonly onDiscontinuity?: (mediaType: 'video' | 'audio', trackName: string, sourceKey?: string) => void;
  /**
   * DIAGNOSTIC ONLY — rebase epoch mode; see `CmafAssembler.epochMode`.
   * Construction-time so it cannot change once an epoch is established.
   * Defaults to `shared` (production behavior).
   */
  readonly epochMode?: 'shared' | 'legacy';
}

/**
 * Pairs moof+mdat MoQ objects into complete CMAF segments.
 *
 * Usage:
 * ```ts
 * const assembler = new CmafAssembler({
 *   onSegment: (mediaType, segment) => mediaSource.appendChunk(mediaType, segment),
 * });
 *
 * // In onCmafObject callback:
 * assembler.push(mediaType, trackName, groupId, obj.payload);
 * ```
 */
export class CmafAssembler {
  /** Opaque source keys are honored throughout assembly and callbacks. */
  readonly supportsTrackIdentity = true;
  private readonly onSegment: CmafAssemblerOptions['onSegment'];
  private readonly onDiscard: CmafAssemblerOptions['onDiscard'];
  private pendingInputs: WeakMap<Uint8Array, object> | undefined;
  /** Metadata belongs only to an existing pending legacy half, never completed history. */
  private pendingObjectIds: WeakMap<Uint8Array, bigint> | undefined;
  /** Opt-in configuration evidence keyed by the already owned moof copy. */
  private pendingSourceConfigurations: WeakMap<Uint8Array, {
    revision: number; timescale: number | null;
  }> | undefined;
  private readonly onDiscontinuity: CmafAssemblerOptions['onDiscontinuity'];

  /**
   * Pending moofs keyed by media type, tagged track identity, and group ID.
   * Multiple groups can have data in-flight simultaneously on different
   * QUIC streams — keying by groupId prevents cross-group contamination.
   */
  private pendingMoofs = new Map<string, Uint8Array>();

  /** Tracks (media type and tagged identity) already warned about non-media drops. */
  private readonly droppedNonMediaWarned = new Set<string>();

  /** Per-track rebase epoch (in that track's timescale units). */
  private videoEpoch: bigint | null = null;
  /** Whether the retained video epoch has known, rescalable tick units. */
  private videoEpochHasKnownTimescale = false;
  private audioEpoch: bigint | null = null;

  /** Media timescale per track, parsed from the init segment's mdhd. */
  private videoTimescale: number | null = null;
  private audioTimescale: number | null = null;

  /**
   * Shared cross-track epoch — the decode time (with its timescale) of the
   * first fragment from whichever track anchored first. Each track's rebase
   * epoch derives from this single origin so the publisher's A/V alignment
   * survives the rebase-to-zero. Without it, zero-basing each track at its
   * own first fragment bakes the audio-vs-video delivery-start gap (audio
   * joins at the live edge, video at the next GoP boundary) into every
   * segment as a constant A/V desync (RED5DEV-2315).
   *
   * Only established by tracks whose timescale is known (init seen);
   * tracks without a timescale fall back to per-track zero-basing.
   */
  private sharedEpochBmd: bigint | null = null;
  private sharedEpochTimescale: number | null = null;

  /**
   * Output position assigned to raw time zero of the current shared epoch.
   * Initial playback uses zero. A later publisher restart uses the exact end
   * of the first track that detects the restart, then scales that one origin
   * into the other track's timescale. This preserves A/V alignment while
   * preventing a looping source from overwriting presentation time zero.
   */
  private sharedOutputOffsetBmd: bigint | null = null;
  private sharedOutputOffsetTimescale: number | null = null;
  private videoOutputOffset = 0n;
  private audioOutputOffset = 0n;
  /** Explicit source-to-reference mapping; null preserves ordinary rebase policy. */
  private audioPresentationOffsetUs: bigint | null = null;
  private audioMappingReplaced = false;
  private audioPresentationMappingWitness: object | null = null;
  private readonly videoPlacement: PlacementState = { revision: 0, proven: -1, patched: -1, init: null, map: null, captured: null };
  private readonly audioPlacement: PlacementState = { revision: 0, proven: -1, patched: -1, init: null, map: null, captured: null };

  /** High-water marks of bytes actually emitted to MSE, in track ticks. */
  private lastVideoOutputBmd: bigint | null = null;
  private lastAudioOutputBmd: bigint | null = null;
  private lastVideoOutputEnd: bigint | null = null;
  private lastAudioOutputEnd: bigint | null = null;

  /**
   * Restart generation of the shared epoch. Bumped when a discontinuity
   * re-establishes the shared epoch; per-track generations record which
   * shared epoch a track's rebase derives from, so the second track to
   * see a publisher restart adopts the re-established epoch instead of
   * zero-basing independently (which would reintroduce the desync).
   */
  private sharedEpochGen = 0;
  private videoEpochGen = 0;
  private audioEpochGen = 0;

  /** Last raw bmd seen per media type — detects backward jumps (discontinuity). */
  private lastVideoBmd: bigint | null = null;
  private lastAudioBmd: bigint | null = null;
  private highestVideoGroupId: bigint | null = null;
  private highestAudioGroupId: bigint | null = null;

  /**
   * First Group ID accepted in the current source epoch. CMSF inherits MSF's
   * requirement that Group IDs increase monotonically, including across a
   * publisher restart. Once a timestamp restart is observed, a later-arriving
   * lower Group ID therefore belongs to the retired epoch and must not alter
   * timestamp state.
   */
  private videoEpochGroupFloor: bigint | null = null;
  private audioEpochGroupFloor: bigint | null = null;

  /** Discontinuities committed but not yet reported to the sink. */
  private pendingDiscontinuities: Array<{
    mediaType: 'video' | 'audio';
    trackName: string;
    sourceKey: string | undefined;
  }> = [];

  /** Tagged source identity associated with the current epoch. */
  private videoTrackIdentity: string | null = null;
  private audioTrackIdentity: string | null = null;

  /** Track identities explicitly committed by the player after a switch. */
  private selectedVideoTrackIdentity: string | null = null;
  private selectedAudioTrackIdentity: string | null = null;

  /**
   * Trex defaults parsed from each init segment. Video uses them for the
   * RASL strip path; both tracks use them to record the exact emitted decode
   * end that becomes the continuation point after a source restart.
   */
  private videoTrex: TrexDefaults | null = null;
  private audioTrex: TrexDefaults | null = null;

  /** Enable diagnostic logging. */
  debug = false;

  /**
   * DIAGNOSTIC ONLY — which rebase epoch to use. Default `shared` is production
   * behavior: both tracks derive from one cross-track origin, preserving the
   * publisher's real A/V offset. `legacy` restores the pre-RED5DEV-2315
   * per-track zero-basing, which maps BOTH first fragments to 0 and therefore
   * ERASES that offset.
   *
   * This exists so the two startup geometries (0/+gap vs 0/0) can be compared
   * in the SAME build, isolating the geometry from every other change. `legacy`
   * is knowingly incorrect — it reintroduces the desync the shared epoch fixed —
   * and must never be a production default.
   *
   * Construction-time and readonly: a mode change after a track has already
   * established an epoch would rebase later fragments against a different
   * origin than the earlier ones, producing a geometry that never existed.
   */
  readonly epochMode: 'shared' | 'legacy';

  /** First raw + patched decode time per track, for the startup geometry report. */
  private startupGeometryState: {
    video?: { rawBmd: bigint; patched: bigint; timescale: number | null };
    audio?: { rawBmd: bigint; patched: bigint; timescale: number | null };
  } = {};
  /**
   * Fired once BOTH tracks' first fragments are known AND the segment that
   * completed the pair has been delivered. Delivery order matters: reporting
   * from inside patchEpoch would announce geometry for a segment the sink has
   * not yet seen.
   */
  onStartupGeometry: ((g: CmafStartupGeometry) => void) | null = null;
  private startupGeometryReported = false;
  private pendingStartupGeometry: CmafStartupGeometry | null = null;

  /** How many startup fragments per media type carry a debug timing log. */
  private static readonly STARTUP_DIAG_COUNT = 5;
  private diagVideoCount = 0;
  private diagAudioCount = 0;

  constructor(options: CmafAssemblerOptions) {
    this.onSegment = options.onSegment;
    this.onDiscard = options.onDiscard;
    this.onDiscontinuity = options.onDiscontinuity;
    this.epochMode = options.epochMode ?? 'shared';
  }

  /**
   * Parse the init segment for trex defaults so the strip path can
   * fall back to them when tfhd doesn't carry sample defaults.
   *
   * Single-track init segments (one trex per init) are the common CMAF
   * case, so this picks the first trex if multiple are present.
   *
   * **Always overwrites** the stored trex (to the parsed value, or to
   * `null` if the new init has no mvex/trex). A new init means a new
   * track configuration — leftover trex from the previous track must
   * not leak into rewrites of the new stream's fragments.
   */
  setInitSegment(mediaType: 'video' | 'audio', initBytes: Uint8Array): void {
    // Record the track's media timescale (mdhd) — required to derive this
    // track's rebase epoch from the shared cross-track epoch. Overwrites on
    // every init for the same reason as the trex below.
    const timescale = readMdhdTimescale(initBytes);
    const previous = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    if (mediaType === 'video') {
      this.videoTimescale = timescale;
      if (previous === null || timescale === null) this.videoEpochHasKnownTimescale = false;
    } else {
      this.audioTimescale = timescale;
    }
    // A REPLACEMENT initialization can carry a different timescale for the
    // same continuing track — a session handover to a relay whose publisher
    // remuxed at another rate. Everything this assembler retains for the
    // track is in TICKS of its timescale, so leaving those values alone would
    // compare and subtract the new fragments' decode times against the old
    // rate. A live stream's epoch is its first fragment's decode time, so it
    // is normally far from zero and the error is correspondingly large.
    if (previous !== null && timescale !== null && timescale !== previous && previous > 0) {
      this.rescaleTrackTicks(mediaType, previous, timescale);
    }
    const trexMap = readTrexDefaults(initBytes);
    const trex = trexMap.size > 0 ? trexMap.values().next().value! : null;
    if (mediaType === 'video') this.videoTrex = trex;
    else this.audioTrex = trex;
    const placement = this.placementState(mediaType);
    if (!sameBytes(placement.init, initBytes)) {
      placement.init = initBytes.slice();
      this.invalidatePlacement(placement);
    }
  }

  /**
   * Convert everything retained for one track from `from` ticks to `to` ticks.
   *
   * Proportional, with floor division: the residual is under one tick, which
   * is microseconds at any realistic media timescale. The SHARED epoch is
   * deliberately untouched — it carries its own timescale and each track
   * derives from it, so rescaling it here would move the other track too.
   */
  private rescaleTrackTicks(mediaType: 'video' | 'audio', from: number, to: number): void {
    const convert = (value: bigint | null): bigint | null =>
      value === null ? null : (value * BigInt(to)) / BigInt(from);
    if (mediaType === 'video') {
      this.videoEpoch = convert(this.videoEpoch);
      this.lastVideoBmd = convert(this.lastVideoBmd);
      this.videoOutputOffset = convert(this.videoOutputOffset) ?? 0n;
      this.lastVideoOutputBmd = convert(this.lastVideoOutputBmd);
      this.lastVideoOutputEnd = convert(this.lastVideoOutputEnd);
    } else {
      this.audioEpoch = convert(this.audioEpoch);
      this.lastAudioBmd = convert(this.lastAudioBmd);
      this.audioOutputOffset = convert(this.audioOutputOffset) ?? 0n;
      this.lastAudioOutputBmd = convert(this.lastAudioOutputBmd);
      this.lastAudioOutputEnd = convert(this.lastAudioOutputEnd);
    }
  }

  /**
   * Commit the track that may feed one media type.
   *
   * Track streams can overlap during a quality switch. Once the player has
   * committed the replacement, late objects from the retired track must not
   * be allowed to switch the assembler back. Pending half-pairs are discarded
   * at the same boundary so an old moof cannot pair with a later mdat.
   */
  selectTrack(mediaType: 'video' | 'audio', trackName: string, sourceKey?: string): void {
    const identity = mediaTrackIdentity(trackName, sourceKey);
    const previous = mediaType === 'video'
      ? this.selectedVideoTrackIdentity ?? this.videoTrackIdentity
      : this.selectedAudioTrackIdentity ?? this.audioTrackIdentity;
    if (mediaType === 'video') this.selectedVideoTrackIdentity = identity;
    else this.selectedAudioTrackIdentity = identity;
    if (previous !== identity) this.invalidatePlacement(this.placementState(mediaType));
    this.clearPending(mediaType);
  }

  /**
   * Map replacement audio into the retained audio reference domain before
   * rebasing. The engine owns the application-supplied relationship and changes
   * it only at adoption. Decode and presentation times receive the same shift,
   * so composition offsets are preserved. Null restores ordinary switching.
   */
  setAudioPresentationOffsetUs(offsetUs: bigint | null): void {
    if (offsetUs !== null) {
      if (typeof offsetUs !== 'bigint') throw new TypeError('Audio presentation offset must be bigint microseconds');
      if (this.audioEpoch === null) throw new Error('An audio reference epoch is required for presentation mapping');
      if (this.audioTimescale === null) throw new Error('An audio timescale is required for presentation mapping');
    }
    const changed = this.audioPlacement.map !== null || offsetUs !== this.audioPresentationOffsetUs || offsetUs !== null;
    this.audioPlacement.map = null;
    this.audioPresentationOffsetUs = offsetUs;
    this.audioMappingReplaced = offsetUs !== null;
    this.audioPresentationMappingWitness = offsetUs === null ? null : Object.freeze({});
    if (changed) this.invalidatePlacement(this.audioPlacement);
  }

  /** Identity of an active mapping; a refused source restart invalidates it. */
  getAudioPresentationMappingWitness(): object | null { return this.audioPresentationMappingWitness; }

  private placementState(mediaType: 'video' | 'audio'): PlacementState {
    return mediaType === 'video' ? this.videoPlacement : this.audioPlacement;
  }

  private invalidatePlacement(state: PlacementState): void {
    state.revision++;
    state.proven = -1;
    state.patched = -1;
    state.captured = null;
  }

  /**
   * Capture the actual affine placement after successful segment delivery.
   * Fractions describe assembler output, excluding native timestampOffset.
   * Captures remain usable as historical contexts after reset or reconfiguration.
   */
  capturePresentationPlacement(mediaType: 'video' | 'audio'): CmafPresentationPlacement | null {
    if (mediaType !== 'video' && mediaType !== 'audio') return null;
    const state = this.placementState(mediaType);
    const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    if (state.proven !== state.revision || timescale === null || timescale <= 0) return null;
    if (state.map?.refused || mediaType === 'audio' && this.audioPresentationOffsetUs !== null
        && this.audioPresentationMappingWitness === null) return null;
    if (state.captured) return state.captured;
    const scale = BigInt(timescale);
    let shiftTicks: bigint;
    if (state.map) {
      shiftTicks = floorDivide(state.map.numerator * scale, state.map.denominator * 1_000_000n);
    } else {
      const epoch = mediaType === 'video' ? this.videoEpoch : this.audioEpoch;
      if (epoch === null) return null;
      shiftTicks = (mediaType === 'video' ? this.videoOutputOffset : this.audioOutputOffset) - epoch;
      if (mediaType === 'audio' && this.audioPresentationOffsetUs !== null) {
        // Preserve the legacy setter's existing truncation, rather than
        // retroactively assigning it the new rational-map rounding policy.
        shiftTicks += this.audioPresentationOffsetUs * scale / 1_000_000n;
      }
    }
    const shiftUsNumerator = shiftTicks * 1_000_000n;
    state.captured = Object.freeze({
      token: Object.freeze({}),
      toRebasedTimeUs(sourcePresentationTimeUs: bigint): FractionUs | null {
        return typeof sourcePresentationTimeUs === 'bigint'
          ? fractionUs(sourcePresentationTimeUs * scale + shiftUsNumerator, scale) : null;
      },
    });
    return state.captured;
  }

  /**
   * Place source presentation time directly on the rebased output timeline.
   * Source/init may arrive later. One floor operation converts the exact affine
   * translation to target ticks; DTS and PTS receive that same constant shift.
   * The latest audio setter owns audio mapping; null restores ordinary policy.
   */
  setPresentationPlacement(mediaType: 'video' | 'audio', anchor: CmafPresentationAnchor | null): void {
    if (mediaType !== 'video' && mediaType !== 'audio') throw new TypeError('Unknown presentation media type');
    let map: PresentationMap | null = null;
    if (anchor !== null) {
      const source = anchor?.sourceTimeUs;
      const numerator = anchor?.rebasedTimeUs?.numerator, denominator = anchor?.rebasedTimeUs?.denominator;
      if (typeof source !== 'bigint' || typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
        throw new TypeError('Presentation anchors and fractions must contain bigint scalars');
      }
      if (denominator <= 0n) throw new RangeError('Presentation fraction denominator must be positive');
      const offset = fractionUs(numerator - source * denominator, denominator);
      map = { numerator: offset.numerator, denominator: offset.denominator, replaced: true, refused: false };
    }
    const state = this.placementState(mediaType);
    if (map === null && state.map === null && (mediaType !== 'audio' || this.audioPresentationOffsetUs === null)) return;
    state.map = map;
    if (mediaType === 'audio') {
      this.audioPresentationOffsetUs = null;
      this.audioMappingReplaced = false;
      this.audioPresentationMappingWitness = null;
    }
    this.invalidatePlacement(state);
  }

  /**
   * Push a CMAF MoQ object payload (moof or mdat).
   *
   * If it's a moof, buffer it keyed by media type, source identity, and group ID.
   * If it's an mdat, pair with the pending moof from the same key,
   * patch tfdt, concatenate, and emit via onSegment.
   *
   * @param mediaType 'video' or 'audio'
   * @param trackName Source MoQ track name — propagates to onSegment so
   *                  downstream consumers can distinguish overlapping
   *                  ranges from different tracks (ABR splice) vs the
   *                  same track (contained replay candidates).
   * @param groupId MoQ group ID — ensures moof+mdat from different groups
   *                don't cross-contaminate when streams interleave
   * @param payload Raw MoQ object payload (moof, mdat, or combined CMAF chunks)
   * @param sourceTiming Request a raw source-PTS receipt after assembler
   * delivery. Multi-chunk objects report the last moof's first sample. This is
   * not append or presentation evidence. Omitted: no timing read or receipt.
   * @param sourceKey Optional opaque full track identity, separate from the
   * display name and from unkeyed legacy identities. Does not request timing.
   * @param objectId Logical Object ID, when known. Legacy split halves must
   * arrive in order within their source/group; an older half cannot replace
   * a newer pending moof. Complete CMAF chunks do not use this ordering rule.
   */
  push(
    mediaType: 'video' | 'audio',
    trackName: string,
    groupId: bigint,
    payload: Uint8Array,
    input?: object,
    sourceTiming?: true,
    sourceKey?: string,
    objectId?: bigint,
  ): void | CmafSourceReceipt {
    const trackIdentity = mediaTrackIdentity(trackName, sourceKey);
    this.placementState(mediaType).patched = -1;
    const selectedIdentity = mediaType === 'video'
      ? this.selectedVideoTrackIdentity
      : this.selectedAudioTrackIdentity;
    if (selectedIdentity !== null && trackIdentity !== selectedIdentity) { this.discardInput(input, 'track superseded'); return sourceTiming ? SOURCE_REFUSED : undefined; }
    if (payload.byteLength < 8) { this.discardInput(input, 'invalid media'); return sourceTiming ? SOURCE_REFUSED : undefined; }

    // CMAF segments may have prefix boxes before the moof: styp (Segment Type),
    // sidx (Segment Index), etc. Skip past all non-moof/non-mdat boxes to find
    // the moof for tfdt patching. The full payload (with prefixes) is preserved
    // in the output — MSE accepts the complete CMAF segment.
    // @see ISO/IEC 14496-12 §8.16.2 (styp), §8.16.3 (sidx)
    let moofOffset = 0;
    while (moofOffset + 8 <= payload.byteLength) {
      const t = boxType(payload, moofOffset);
      if (t === 'moof' || t === 'mdat') break;
      const s = boxSize(payload, moofOffset);
      if (s < 8) break; // malformed
      moofOffset += s;
    }

    if (moofOffset + 8 > payload.byteLength) {
      // No moof/mdat anywhere in the payload — e.g. an in-band ftyp+moov
      // init segment that should have been consumed by the player layer.
      // Silently eating it turns a publisher's init into a black screen;
      // warn once per track so the drop is diagnosable.
      const warnKey = `${mediaType}:${trackIdentity}`;
      if (!this.droppedNonMediaWarned.has(warnKey)) {
        this.droppedNonMediaWarned.add(warnKey);
        console.warn(
          `[CMAF] dropped ${mediaType} "${trackName}" object with no moof/mdat `
          + `(${payload.byteLength}B, first box "${boxType(payload, 0)}") — `
          + `in-band init segments must be handled before the assembler`);
      }
      this.discardInput(input, 'invalid media');
      return sourceTiming ? SOURCE_REFUSED : undefined;
    }
    const type = boxType(payload, moofOffset);
    const key = `${mediaType}:${trackIdentity}:${groupId}`;

    if (type === 'moof') {
      const moofSize = boxSize(payload, moofOffset);
      const moofEnd = moofOffset + moofSize;

      if (payload.byteLength > moofEnd) {
        // §3.3 compliant: [styp+]moof+mdat, optionally followed by more
        // successive CMAF chunks in the same Object. Patch every moof in a
        // private copy; leaving a later chunk on the publisher's raw epoch
        // would create a gap and corrupt the recorded output horizon.
        const segment = new Uint8Array(payload.byteLength);
        segment.set(payload);
        let pos = moofOffset;
        let sourcePresentationTimeUs: bigint | null = null;
        let sourceDecodeTimeUs: bigint | null = null;
        let sourceTimescale: number | null = null;
        let sourceTimingAvailable = true;
        while (pos + 8 <= segment.byteLength) {
          const size = boxSize(segment, pos);
          if (size < 8 || pos + size > segment.byteLength) break;
          if (boxType(segment, pos) === 'moof') {
            const chunkMoof = segment.subarray(pos, pos + size);
            if (sourceTiming) {
              const ticks = readFirstSamplePresentationTime(chunkMoof);
              const timescale = mediaType === 'audio' ? this.audioTimescale : this.videoTimescale;
              const decodeTicks = readBaseMediaDecodeTime(chunkMoof);
              sourceTimescale = timescale;
              sourceDecodeTimeUs = decodeTicks !== null && timescale !== null
                ? decodeTicks * 1_000_000n / BigInt(timescale) : null;
              if (ticks === null || timescale === null) sourceTimingAvailable = false;
              else sourcePresentationTimeUs = ticks * 1_000_000n / BigInt(timescale);
            }
            if (!this.patchEpoch(mediaType, trackName, chunkMoof, groupId, trackIdentity, sourceKey)) { this.discardInput(input, 'epoch refused'); return sourceTiming ? SOURCE_REFUSED : undefined; }
          }
          pos += size;
        }
        const revision = sourceTiming ? this.placementState(mediaType).revision : -1;
        this.emitSegment(mediaType, segment, trackName, groupId, input === undefined ? undefined : [input], sourceKey);
        this.flushStartupGeometry();
        return sourceTiming ? this.sourceTimingReceipt(mediaType,
          sourceTimingAvailable ? sourcePresentationTimeUs : null,
          sourceDecodeTimeUs, sourceTimescale, revision) : undefined;
      }

      // Legacy: moof-only object — buffer and wait for a separate mdat.
      const previous = this.pendingMoofs.get(key);
      const previousId = previous && this.pendingObjectIds?.get(previous);
      if (objectId !== undefined && previousId !== undefined && objectId <= previousId) {
        this.discardInput(input, 'out of order legacy object');
        return sourceTiming ? SOURCE_REFUSED : undefined;
      }
      // Copy — the original Uint8Array may share its ArrayBuffer with other
      // QUIC stream data. In-place tfdt patching would corrupt it.
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      if (input !== undefined) (this.pendingInputs ??= new WeakMap()).set(copy, input);
      if (objectId !== undefined) (this.pendingObjectIds ??= new WeakMap()).set(copy, objectId);
      if (sourceTiming) (this.pendingSourceConfigurations ??= new WeakMap()).set(copy, {
        revision: this.placementState(mediaType).revision,
        timescale: mediaType === 'audio' ? this.audioTimescale : this.videoTimescale,
      });
      this.pendingMoofs.set(key, copy);
      if (previous) this.discardPending(previous, 'superseded pending moof');
      return sourceTiming ? SOURCE_PARTIAL : undefined;
    }

    if (type === 'mdat') {
      const pending = this.pendingMoofs.get(key);
      if (!pending) { this.discardInput(input, 'orphaned media'); return sourceTiming ? SOURCE_REFUSED : undefined; }
      const pendingId = this.pendingObjectIds?.get(pending);
      if (objectId !== undefined && pendingId !== undefined && objectId <= pendingId) {
        this.discardInput(input, 'out of order legacy object');
        return sourceTiming ? SOURCE_REFUSED : undefined;
      }
      this.pendingMoofs.delete(key);
      this.pendingObjectIds?.delete(pending);
      const sourceConfiguration = this.pendingSourceConfigurations?.get(pending);
      this.pendingSourceConfigurations?.delete(pending);

      const priorInput = this.pendingInputs?.get(pending);
      this.pendingInputs?.delete(pending);
      let sourcePresentationTimeUs: bigint | null = null;
      let sourceDecodeTimeUs: bigint | null = null;
      const timescale = mediaType === 'audio' ? this.audioTimescale : this.videoTimescale;
      if (sourceTiming) {
        const ticks = readFirstSamplePresentationTime(pending);
        if (ticks !== null && timescale !== null) sourcePresentationTimeUs = ticks * 1_000_000n / BigInt(timescale);
        // Compare before patchEpoch: the first patch legitimately establishes
        // a new placement revision. An intervening init cannot prove this half.
        if (sourceConfiguration?.revision === this.placementState(mediaType).revision
            && sourceConfiguration.timescale === timescale && timescale !== null) {
          const decodeTicks = readBaseMediaDecodeTime(pending);
          if (decodeTicks !== null) sourceDecodeTimeUs = decodeTicks * 1_000_000n / BigInt(timescale);
        }
      }
      if (!this.patchEpoch(mediaType, trackName, pending, groupId, trackIdentity, sourceKey)) {
        this.discardInput(priorInput, 'epoch refused'); this.discardInput(input, 'epoch refused'); return sourceTiming ? SOURCE_REFUSED : undefined;
      }

      // Concatenate moof + mdat
      const segment = concatBuffers(pending, payload);
      const revision = sourceTiming ? this.placementState(mediaType).revision : -1;
      this.emitSegment(mediaType, segment, trackName, groupId,
        priorInput === undefined && input === undefined ? undefined : [priorInput, input], sourceKey);
      this.flushStartupGeometry();
      return sourceTiming ? this.sourceTimingReceipt(mediaType, sourcePresentationTimeUs,
        sourceDecodeTimeUs, timescale, revision) : undefined;
    }

    // Unknown box type — pass through as-is.
    if (sourceKey !== undefined) this.onSegment(mediaType, payload, trackName, groupId, input === undefined ? undefined : [input], sourceKey);
    else if (input === undefined) this.onSegment(mediaType, payload, trackName, groupId);
    else this.onSegment(mediaType, payload, trackName, groupId, [input]);
    return sourceTiming ? SOURCE_UNAVAILABLE : undefined;
  }

  private sourceTimingReceipt(
    mediaType: 'video' | 'audio', sourcePresentationTimeUs: bigint | null,
    sourceDecodeTimeUs: bigint | null, timescale: number | null, revision: number,
  ): CmafSourceReceipt {
    if (sourcePresentationTimeUs === null) return SOURCE_UNAVAILABLE;
    const receipt = { state: 'emitted' as const, sourcePresentationTimeUs };
    const state = this.placementState(mediaType);
    if (sourceDecodeTimeUs === null || timescale === null
        || state.revision !== revision || state.proven !== revision) return receipt;
    const placement = this.capturePresentationPlacement(mediaType);
    if (placement === null || state.revision !== revision || state.proven !== revision) return receipt;
    return { ...receipt, sourceDecodeTime: { timeUs: sourceDecodeTimeUs, timescale, placementToken: placement.token } };
  }

  /**
   * Strip RASL leading pictures from a fragment whose first sample is
   * a CRA random-access entry. Returns the rewritten segment when the
   * pattern matches and samples are dropped, otherwise the original
   * segment untouched.
   *
   * Why: when a fragment is delivered as a splice / random-access
   * entry (the typical case when MSE appends a CRA-led segment after
   * a flushing IDR — e.g., the Synamedia "tiny IDR + CRA-with-RASL"
   * shape), the CRA's associated RASL pictures reference frames from
   * before the CRA in decode order. After the IDR flushed the DPB
   * those references are gone, and HEVC decoders (notably
   * VideoToolbox) fail with `kVTVideoDecoderReferenceMissingErr`
   * (-17694).
   *
   * Per HEVC §8.1 (PicOutputFlag derivation), when a RASL picture is
   * associated with an IRAP that has `NoRaslOutputFlag = 1`,
   * `PicOutputFlag` is set to 0 and the DPB bumping process in C.5.2.4
   * therefore does not output the RASL. The clause-3 NOTE under the
   * CRA picture definition states such RASL pictures "are not output
   * by the decoder, because they may not be decodable". RFC 7798 §3
   * and the HEVC HLS design (Sjöberg/Chen/Wang) explicitly sanction
   * stripping RASL_N (NAL 8) and RASL_R (NAL 9) NAL units associated
   * with the random-access IRAP, since the observable output is
   * identical to a spec-compliant playthrough.
   *
   * Constraints honored:
   *   1. Stripping only applies when sample 0 is CRA (the random-access
   *      IRAP). Mid-stream CRAs that aren't tuning-in points have
   *      decodable RASLs that are meant to be output; we never see
   *      sample-0 != CRA in our path because CRA is always first in
   *      decode order.
   *   2. Atomic strip: every RASL sample in the fragment is dropped
   *      together. RASL_R may be referenced by other RASL pictures, so
   *      a partial drop would orphan retained samples.
   *
   * AVC fragments don't trigger this — `firstHevcVclNalType` returns
   * AVC NAL bytes interpreted as if they were HEVC, but AVC IDR (NAL
   * type 5) decodes as `((0x65 >> 1) & 0x3f) === 50`, never CRA(21).
   *
   * Audio fragments are skipped entirely — they have no NAL unit
   * structure, so feeding their bytes through `firstHevcVclNalType`
   * is meaningless and only safe by luck. Today we lack codec context
   * inside the assembler; in the future this gate could narrow further
   * to known hev1/hvc1 video tracks.
   */
  private maybeStripRaslSamples(
    mediaType: 'video' | 'audio',
    segment: Uint8Array,
  ): Uint8Array {
    if (mediaType !== 'video') return segment;
    let firstSampleIsCra = false;
    let sawRasl = false;
    const shouldDrop = (sample: TrunSample, sampleBytes: Uint8Array): boolean => {
      const nalType = firstHevcVclNalType(sampleBytes);
      if (nalType === null) return false;
      if (sample.index === 0) {
        firstSampleIsCra = isHevcCraNalType(nalType);
      }
      if (isHevcRaslNalType(nalType) && firstSampleIsCra) {
        sawRasl = true;
        return true;
      }
      return false;
    };
    const rewritten = rewriteFragmentDropSamples(
      segment, shouldDrop, this.videoTrex ?? undefined,
    );
    // Defensive: only return rewritten when both pattern conditions
    // matched. If first sample wasn't CRA, no RASLs got dropped, so
    // rewriter would have returned null anyway — but check explicitly.
    if (rewritten === null || !firstSampleIsCra || !sawRasl) return segment;
    return rewritten;
  }

  /**
   * Get the recorded epoch (first baseMediaDecodeTime) for a media type.
   * Returns null if no moof has been processed for that type.
   */
  getEpoch(mediaType: 'video' | 'audio'): bigint | null {
    return mediaType === 'video' ? this.videoEpoch : this.audioEpoch;
  }

  /** Deliver one final segment and retain its emitted decode-time extent. */
  private emitSegment(
    mediaType: 'video' | 'audio',
    segment: Uint8Array,
    trackName: string,
    groupId: bigint,
    inputs?: readonly (object | undefined)[],
    sourceKey?: string,
  ): void {
    const output = this.maybeStripRaslSamples(mediaType, segment);
    const trex = mediaType === 'video' ? this.videoTrex : this.audioTrex;
    const ranges = readSegmentTimeRanges(output, trex ?? undefined);
    const placement = this.placementState(mediaType), revision = placement.revision, patched = placement.patched;
    placement.patched = -1;
    if (sourceKey !== undefined) this.onSegment(mediaType, output, trackName, groupId, inputs, sourceKey);
    else if (inputs === undefined) this.onSegment(mediaType, output, trackName, groupId);
    else this.onSegment(mediaType, output, trackName, groupId, inputs);
    if (placement.revision === revision && patched === revision) placement.proven = revision;
    if (ranges !== null && ranges.length > 0) {
      const end = ranges.reduce(
        (max, range) => range.endTime > max ? range.endTime : max,
        ranges[0]!.endTime,
      );
      if (mediaType === 'video') {
        if (this.lastVideoOutputEnd === null || end > this.lastVideoOutputEnd) {
          this.lastVideoOutputEnd = end;
        }
      } else if (this.lastAudioOutputEnd === null || end > this.lastAudioOutputEnd) {
        this.lastAudioOutputEnd = end;
      }
    }
    this.flushDiscontinuities();
  }

  /**
   * Drop pending half-pairs (moof without mdat) for one media type.
   *
   * Used by the player's media-liveness restart: a delivery restart can
   * strand a moof whose mdat never arrived, and a post-restart mdat for the
   * same group must not pair against the stale moof. Epochs, bmd history,
   * and the other media type are untouched — this is NOT a full reset().
   */
  clearPending(mediaType: 'video' | 'audio'): void {
    const removed: Uint8Array[] | undefined = this.pendingInputs ? [] : undefined;
    for (const [key, bytes] of this.pendingMoofs) {
      if (key.startsWith(`${mediaType}:`)) {
        this.pendingMoofs.delete(key); this.pendingObjectIds?.delete(bytes); removed?.push(bytes);
        this.pendingSourceConfigurations?.delete(bytes);
      }
    }
    if (removed) for (const bytes of removed) this.discardPending(bytes, 'decoder reset');
  }

  private discardInput(input: object | undefined, reason: CmafAssemblyDiscardReason): void {
    if (input === undefined || !this.onDiscard) return;
    try { const pending = this.onDiscard(input, reason); if (pending) void Promise.resolve(pending).catch(() => {}); } catch { /* Optional outcomes never affect reconstruction. */ }
  }

  private discardPending(bytes: Uint8Array, reason: CmafAssemblyDiscardReason): void {
    this.pendingObjectIds?.delete(bytes);
    this.pendingSourceConfigurations?.delete(bytes);
    const input = this.pendingInputs?.get(bytes); this.pendingInputs?.delete(bytes);
    this.discardInput(input, reason);
  }

  /** Clear all pending moofs, epoch state, and parsed init defaults. */
  reset(): void {
    for (const placement of [this.videoPlacement, this.audioPlacement]) {
      placement.init = null;
      placement.map = null;
      this.invalidatePlacement(placement);
    }
    const removed = this.pendingInputs ? [...this.pendingMoofs.values()] : undefined;
    this.pendingMoofs.clear();
    this.pendingObjectIds = undefined;
    this.pendingSourceConfigurations = undefined;
    this.videoEpoch = null;
    this.videoEpochHasKnownTimescale = false;
    this.audioEpoch = null;
    this.lastVideoBmd = null;
    this.lastAudioBmd = null;
    this.highestVideoGroupId = null;
    this.highestAudioGroupId = null;
    this.videoEpochGroupFloor = null;
    this.audioEpochGroupFloor = null;
    this.pendingDiscontinuities = [];
    this.videoTrackIdentity = null;
    this.audioTrackIdentity = null;
    this.selectedVideoTrackIdentity = null;
    this.selectedAudioTrackIdentity = null;
    this.videoTrex = null;
    this.audioTrex = null;
    this.videoTimescale = null;
    this.audioTimescale = null;
    this.sharedEpochBmd = null;
    this.sharedEpochTimescale = null;
    this.sharedOutputOffsetBmd = null;
    this.sharedOutputOffsetTimescale = null;
    this.videoOutputOffset = 0n;
    this.audioOutputOffset = 0n;
    this.audioPresentationOffsetUs = null;
    this.audioMappingReplaced = false;
    this.audioPresentationMappingWitness = null;
    this.lastVideoOutputBmd = null;
    this.lastAudioOutputBmd = null;
    this.lastVideoOutputEnd = null;
    this.lastAudioOutputEnd = null;
    this.sharedEpochGen = 0;
    this.startupGeometryState = {};
    this.pendingStartupGeometry = null;
    this.startupGeometryReported = false;
    this.videoEpochGen = 0;
    this.audioEpochGen = 0;
    if (removed) for (const bytes of removed) this.discardPending(bytes, 'decoder reset');
  }

  /** Release all resources. */
  destroy(): void {
    this.reset();
  }

  /**
   * Scale the shared epoch into a track's timescale (floor division —
   * sub-tick error is at most one tick, i.e. microseconds).
   */
  private scaledSharedEpoch(timescale: number): bigint | null {
    if (this.sharedEpochBmd === null || this.sharedEpochTimescale === null) return null;
    if (this.sharedEpochTimescale === timescale) return this.sharedEpochBmd;
    return (this.sharedEpochBmd * BigInt(timescale)) / BigInt(this.sharedEpochTimescale);
  }

  /** Scale the current epoch's shared output origin into one track's ticks. */
  private scaledSharedOutputOffset(timescale: number): bigint | null {
    if (this.sharedOutputOffsetBmd === null || this.sharedOutputOffsetTimescale === null) return null;
    if (this.sharedOutputOffsetTimescale === timescale) return this.sharedOutputOffsetBmd;
    return (this.sharedOutputOffsetBmd * BigInt(timescale))
      / BigInt(this.sharedOutputOffsetTimescale);
  }

  /**
   * Start a new output epoch where the detecting track's prior emitted epoch
   * ended. If the fragment duration was unscorable, overlap the prior final
   * fragment rather than creating a hole; MSE's coded-frame replacement is
   * explicitly allowed to absorb that bounded overlap.
   */
  private reestablishOutputOrigin(mediaType: 'video' | 'audio'): void {
    const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    const scoredEnd = mediaType === 'video' ? this.lastVideoOutputEnd : this.lastAudioOutputEnd;
    const latestBmd = mediaType === 'video' ? this.lastVideoOutputBmd : this.lastAudioOutputBmd;
    this.sharedOutputOffsetBmd = scoredEnd !== null && scoredEnd > (latestBmd ?? 0n)
      ? scoredEnd
      : (latestBmd ?? scoredEnd ?? 0n);
    this.sharedOutputOffsetTimescale = timescale;
  }

  /** Resolve an offset that maps this fragment at or beyond committed media. */
  private outputOffsetFor(
    mediaType: 'video' | 'audio',
    bmd: bigint,
    epoch: bigint,
  ): bigint {
    const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    const lastOutputBmd = mediaType === 'video' ? this.lastVideoOutputBmd : this.lastAudioOutputBmd;
    let offset = timescale !== null
      ? (this.scaledSharedOutputOffset(timescale) ?? 0n)
      : (lastOutputBmd ?? 0n);
    const scoredEnd = mediaType === 'video' ? this.lastVideoOutputEnd : this.lastAudioOutputEnd;
    const reliableEnd = scoredEnd !== null && scoredEnd >= (lastOutputBmd ?? 0n)
      ? scoredEnd
      : null;
    if (reliableEnd !== null) {
      const mappedStart = offset + bmd - epoch;
      if (mappedStart < reliableEnd) offset += reliableEnd - mappedStart;
    }
    return offset;
  }

  /** Publish committed discontinuities after their triggering segment. */
  private flushDiscontinuities(): void {
    while (this.pendingDiscontinuities.length > 0) {
      const event = this.pendingDiscontinuities.shift()!;
      try {
        if (event.sourceKey === undefined) this.onDiscontinuity?.(event.mediaType, event.trackName);
        else this.onDiscontinuity?.(event.mediaType, event.trackName, event.sourceKey);
      } catch { /* diagnostic callback is contained */ }
    }
  }

  /**
   * Compute a track's rebase epoch from the shared cross-track epoch,
   * establishing or re-establishing the shared epoch as needed.
   *
   * - No timescale known for this track → per-track zero-basing (legacy).
   * - Shared epoch unset (or being re-established after a restart this
   *   track saw first) → this track's bmd becomes the shared epoch.
   * - Otherwise → adopt the shared epoch scaled to this track's units,
   *   clamped to the track's own bmd only when the resulting output would
   *   be negative. A later restart has a positive output origin, so a track
   *   that detects the epoch second may retain an earlier raw start.
   */
  private anchorEpoch(
    mediaType: 'video' | 'audio',
    bmd: bigint,
    reestablish: boolean,
  ): bigint {
    const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    if (timescale === null) return bmd;
    // Diagnostic control: per-track zero-basing, ignoring the shared origin.
    if (this.epochMode === 'legacy') return bmd;

    if (reestablish) {
      this.sharedEpochGen++;
      this.sharedEpochBmd = bmd;
      this.sharedEpochTimescale = timescale;
    } else if (this.sharedEpochBmd === null) {
      this.sharedEpochBmd = bmd;
      this.sharedEpochTimescale = timescale;
      this.sharedOutputOffsetBmd ??= 0n;
      this.sharedOutputOffsetTimescale ??= timescale;
    }
    if (mediaType === 'video') {
      this.videoEpochGen = this.sharedEpochGen;
    } else {
      this.audioEpochGen = this.sharedEpochGen;
    }

    const shared = this.scaledSharedEpoch(timescale)!;
    if (shared <= bmd) return shared;
    const outputOffset = this.scaledSharedOutputOffset(timescale) ?? 0n;
    return outputOffset >= shared - bmd ? shared : bmd;
  }

  /**
   * Capture each track's FIRST raw/patched decode time and, once both are
   * known, report the resulting cross-track start gap exactly once. This is the
   * geometry the browser actually receives — the number a startup skew must be
   * correlated against.
   */
  private recordStartupGeometry(mediaType: 'video' | 'audio', rawBmd: bigint, patched: bigint): void {
    if (this.startupGeometryReported) return;
    const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    if (this.startupGeometryState[mediaType] === undefined) {
      this.startupGeometryState[mediaType] = { rawBmd, patched, timescale };
    }
    const v = this.startupGeometryState.video;
    const a = this.startupGeometryState.audio;
    if (!v || !a) return; // wait until BOTH first fragments are known
    this.startupGeometryReported = true;
    const sec = (t: bigint, ts: number | null): number | null =>
      ts && ts > 0 ? Number(t) / ts : null;
    const videoStartSec = sec(v.patched, v.timescale);
    const audioStartSec = sec(a.patched, a.timescale);
    const geometry: CmafStartupGeometry = {
      videoRawBmd: String(v.rawBmd),
      audioRawBmd: String(a.rawBmd),
      videoTimescale: v.timescale,
      audioTimescale: a.timescale,
      videoStartSec,
      audioStartSec,
      gapSec: videoStartSec !== null && audioStartSec !== null
        ? videoStartSec - audioStartSec : null,
      epochMode: this.epochMode,
    };
    if (this.debug) {
      console.log('[CMAF] startup-geometry %s', JSON.stringify(geometry));
    }
    this.pendingStartupGeometry = geometry;
  }

  /**
   * Deliver staged startup geometry, after the segment that completed it has
   * reached the sink. A throwing diagnostic consumer must never affect media
   * delivery, so the callback is contained.
   */
  private flushStartupGeometry(): void {
    const geometry = this.pendingStartupGeometry;
    if (!geometry) return;
    this.pendingStartupGeometry = null;
    try { this.onStartupGeometry?.(geometry); } catch { /* contained */ }
  }

  /** Record epoch from first moof, detect discontinuity, and rebase tfdt. */
  private patchEpoch(
    mediaType: 'video' | 'audio',
    trackName: string,
    moof: Uint8Array,
    groupId: bigint,
    trackIdentity: string,
    sourceKey?: string,
  ): boolean {
    const rawBmd = readBaseMediaDecodeTime(moof);
    if (rawBmd === null) return true;
    const placement = this.placementState(mediaType);
    if (placement.map !== null) return this.patchPresentationPlacement(mediaType, trackIdentity, moof, groupId, rawBmd, placement);
    const previousEpoch = mediaType === 'video' ? this.videoEpoch : this.audioEpoch;
    const previousOffset = mediaType === 'video' ? this.videoOutputOffset : this.audioOutputOffset;
    const previousTrack = mediaType === 'video' ? this.videoTrackIdentity : this.audioTrackIdentity;
    const previousEpochGen = mediaType === 'video' ? this.videoEpochGen : this.audioEpochGen;
    const mappedAudio = mediaType === 'audio' && this.audioPresentationOffsetUs !== null;
    if (mappedAudio && (this.audioTimescale === null || this.audioEpoch === null)) return false;
    const bmd = rawBmd + (mappedAudio
      ? this.audioPresentationOffsetUs! * BigInt(this.audioTimescale!) / 1_000_000n : 0n);

    const currentIdentity = mediaType === 'video' ? this.videoTrackIdentity : this.audioTrackIdentity;
    const isTrackSwitch = currentIdentity !== null && currentIdentity !== trackIdentity;
    const epochGroupFloor = mediaType === 'video'
      ? this.videoEpochGroupFloor
      : this.audioEpochGroupFloor;
    if (!isTrackSwitch && !(mappedAudio && this.audioMappingReplaced) && epochGroupFloor !== null && groupId < epochGroupFloor) {
      if (this.debug) {
        console.warn(
          '[CMAF] ignored late %s segment on "%s": group=%s belongs to epoch before group=%s',
          mediaType,
          trackName,
          String(groupId),
          String(epochGroupFloor),
        );
      }
      return false;
    }
    const lastBmd = mediaType === 'video' ? this.lastVideoBmd : this.lastAudioBmd;
    const epoch = mediaType === 'video' ? this.videoEpoch : this.audioEpoch;

    if (mappedAudio) {
      // An explicit map fixes the output position. Neither a new source's Group
      // IDs nor the previous buffered end can redefine that relationship.
      if (isTrackSwitch || this.audioMappingReplaced) {
        this.audioTrackIdentity = trackIdentity;
        this.lastAudioBmd = null;
        this.highestAudioGroupId = null;
        this.audioEpochGroupFloor = null;
        this.audioMappingReplaced = false;
      } else if (lastBmd !== null && bmd < lastBmd
          && lastBmd - bmd > BigInt(this.audioTimescale!)
          && (this.highestAudioGroupId === null || groupId > this.highestAudioGroupId)) {
        // A new source epoch needs a new application map. It cannot reset the
        // shared A/V clock merely because this audio source restarted.
        this.audioPresentationMappingWitness = null;
        this.invalidatePlacement(placement);
        return false;
      }
    } else if (isTrackSwitch) {
      // Track switch (ABR splice): variants in a switching set are media-time
      // aligned. Keep the shared raw/output epochs so a switch cannot jump
      // back to presentation time zero after a source restart.
      const preserveVideoMapping = mediaType === 'video' && this.epochMode === 'shared'
        && this.videoEpochHasKnownTimescale && this.videoTimescale !== null
        && epoch !== null && this.videoEpochGen === this.sharedEpochGen;
      const anchored = preserveVideoMapping ? epoch : this.anchorEpoch(mediaType, bmd, false);
      if (mediaType === 'video') {
        this.videoEpoch = anchored;
        this.videoEpochHasKnownTimescale = this.videoTimescale !== null;
        this.videoTrackIdentity = trackIdentity;
        this.lastVideoBmd = null;
        this.videoEpochGen = this.sharedEpochGen;
        this.highestVideoGroupId = null;
        // Aligned replacements retain the existing video mapping, including
        // a startup clamp or a restart continuation offset (CMSF §3.2).
        // Re-anchor when the retained units are unknown or this track has
        // not adopted the current epoch.
        if (!preserveVideoMapping) {
          this.videoOutputOffset = this.epochMode === 'shared' && this.videoTimescale !== null
            ? this.scaledSharedOutputOffset(this.videoTimescale) ?? 0n
            : this.outputOffsetFor('video', bmd, anchored);
        }
        this.videoEpochGroupFloor = null;
      } else {
        this.audioEpoch = anchored;
        this.audioTrackIdentity = trackIdentity;
        this.lastAudioBmd = null;
        this.audioEpochGen = this.sharedEpochGen;
        this.highestAudioGroupId = null;
        this.audioOutputOffset = this.outputOffsetFor('audio', bmd, anchored);
        this.audioEpochGroupFloor = null;
      }
    } else if (epoch === null) {
      // First segment — anchor against the shared cross-track epoch so
      // the publisher's A/V alignment survives the rebase to zero.
      const anchored = this.anchorEpoch(mediaType, bmd, false);
      if (mediaType === 'video') {
        this.videoEpoch = anchored;
        this.videoEpochHasKnownTimescale = this.videoTimescale !== null;
        this.videoTrackIdentity = trackIdentity;
        this.lastVideoBmd = null;
        this.videoOutputOffset = this.outputOffsetFor('video', bmd, anchored);
      } else {
        this.audioEpoch = anchored;
        this.audioTrackIdentity = trackIdentity;
        this.lastAudioBmd = null;
        this.audioOutputOffset = this.outputOffsetFor('audio', bmd, anchored);
      }
    } else if (lastBmd !== null && bmd < lastBmd) {
      // Same track, bmd went backward.
      // Audio: backward jumps of at most one second in the track's media
      // timescale are late subgroup data, not a real discontinuity. Use
      // the historical 48 kHz window when no init segment was available.
      // Video: any backward jump is treated as a discontinuity.
      const jumpBack = lastBmd - bmd;
      const audioReorderWindow = BigInt(this.audioTimescale ?? 48000);
      const isSmallAudioReorder = mediaType === 'audio' && jumpBack <= audioReorderWindow;
      const highestGroupId = mediaType === 'video'
        ? this.highestVideoGroupId
        : this.highestAudioGroupId;
      const isOutOfOrderGroup = highestGroupId !== null && groupId <= highestGroupId;
      if (!isSmallAudioReorder && !isOutOfOrderGroup) {
        if (this.debug) console.warn('[CMAF] %s discontinuity on "%s": bmd=%s < lastBmd=%s (jump=%s) — re-anchoring',
          mediaType, trackName, bmd, lastBmd, jumpBack);
        // A restart affects both tracks. The first track to detect it
        // re-establishes the shared epoch (generation bump); the second
        // track sees its generation is behind and adopts the new epoch
        // instead of zero-basing independently.
        const trackGen = mediaType === 'video' ? this.videoEpochGen : this.audioEpochGen;
        const reestablish = trackGen === this.sharedEpochGen;
        if (reestablish) this.reestablishOutputOrigin(mediaType);
        const anchored = this.anchorEpoch(mediaType, bmd, reestablish);
        if (mediaType === 'video') {
          this.videoEpoch = anchored;
          this.videoEpochHasKnownTimescale = this.videoTimescale !== null;
          this.lastVideoBmd = bmd;
          this.videoOutputOffset = this.outputOffsetFor('video', bmd, anchored);
          this.videoEpochGroupFloor = groupId;
        } else {
          this.audioEpoch = anchored;
          this.lastAudioBmd = bmd;
          this.audioOutputOffset = this.outputOffsetFor('audio', bmd, anchored);
          this.audioEpochGroupFloor = groupId;
        }
        this.pendingDiscontinuities.push({ mediaType, trackName, sourceKey });
      }
    }

    // Only advance the high-water mark — don't let out-of-order
    // delivery lower it, which would cause the NEXT in-order segment
    // to look like a forward jump past the reordered one.
    if (mediaType === 'video') {
      if (this.lastVideoBmd === null || bmd > this.lastVideoBmd) this.lastVideoBmd = bmd;
      if (this.highestVideoGroupId === null || groupId > this.highestVideoGroupId) {
        this.highestVideoGroupId = groupId;
      }
    } else {
      if (this.lastAudioBmd === null || bmd > this.lastAudioBmd) this.lastAudioBmd = bmd;
      if (this.highestAudioGroupId === null || groupId > this.highestAudioGroupId) {
        this.highestAudioGroupId = groupId;
      }
    }

    const currentEpoch = mediaType === 'video' ? this.videoEpoch! : this.audioEpoch!;
    const outputOffset = mediaType === 'video' ? this.videoOutputOffset : this.audioOutputOffset;
    if (currentEpoch !== previousEpoch || outputOffset !== previousOffset
        || (mediaType === 'video' ? this.videoEpochGen : this.audioEpochGen) !== previousEpochGen
        || (mediaType === 'video' ? this.videoTrackIdentity : this.audioTrackIdentity) !== previousTrack) {
      this.invalidatePlacement(placement);
    }
    const patchedBmd = outputOffset + bmd - currentEpoch;
    if (patchedBmd < 0n) return false;
    patchBaseMediaDecodeTime(moof, patchedBmd);
    placement.patched = placement.revision;
    if (mediaType === 'video') {
      if (this.lastVideoOutputBmd === null || patchedBmd > this.lastVideoOutputBmd) {
        this.lastVideoOutputBmd = patchedBmd;
      }
    } else if (this.lastAudioOutputBmd === null || patchedBmd > this.lastAudioOutputBmd) {
      this.lastAudioOutputBmd = patchedBmd;
    }
    this.recordStartupGeometry(mediaType, rawBmd, patchedBmd);

    // Startup timing diagnostic (debug-only, first N fragments per media type).
    // These numbers describe DECODE-time rebasing only: raw bmd, the chosen
    // epoch, and the patched result, with the timescale needed to read them as
    // seconds. Presentation offsets (edit lists, composition offsets) are not
    // represented here — they are not parsed — so this is the rebasing story,
    // not a complete account of presentation alignment.
    if (this.debug) {
      const seen = mediaType === 'video' ? this.diagVideoCount : this.diagAudioCount;
      if (seen < CmafAssembler.STARTUP_DIAG_COUNT) {
        if (mediaType === 'video') this.diagVideoCount++; else this.diagAudioCount++;
        const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
        const patched = patchedBmd;
        const sec = (t: bigint) => (timescale ? `${(Number(t) / timescale).toFixed(3)}s` : 'n/a');
        console.log(
          '[CMAF] startup#%d %s "%s" group=%s timescale=%s rawBmd=%s (%s) epoch=%s sharedEpoch=%s/%s patched=%s (%s)',
          seen + 1, mediaType, trackName, String(groupId), String(timescale ?? 'unknown'),
          String(bmd), sec(bmd), String(currentEpoch),
          String(this.sharedEpochBmd ?? 'unset'), String(this.sharedEpochTimescale ?? 'unset'),
          String(patched), sec(patched),
        );
      }
    }
    return true;
  }

  /** Explicit placement is independent of the retired track's raw epoch. */
  private patchPresentationPlacement(
    mediaType: 'video' | 'audio', trackIdentity: string, moof: Uint8Array, groupId: bigint,
    rawBmd: bigint, placement: PlacementState,
  ): boolean {
    const map = placement.map!;
    const timescale = mediaType === 'video' ? this.videoTimescale : this.audioTimescale;
    if (map.refused || timescale === null || timescale <= 0) return false;
    const shift = floorDivide(map.numerator * BigInt(timescale), map.denominator * 1_000_000n);
    const patched = rawBmd + shift;
    const currentTrack = mediaType === 'video' ? this.videoTrackIdentity : this.audioTrackIdentity;
    const last = mediaType === 'video' ? this.lastVideoBmd : this.lastAudioBmd;
    const highest = mediaType === 'video' ? this.highestVideoGroupId : this.highestAudioGroupId;
    const newSource = map.replaced || currentTrack !== trackIdentity;
    if (!newSource && last !== null && rawBmd < last
        && last - rawBmd > (mediaType === 'audio' ? BigInt(timescale) : 0n)
        && (highest === null || groupId > highest)) {
      // A new source epoch needs a new explicit map. Never reset the shared
      // A/V epoch to conceal a restart in one independently mapped source.
      map.refused = true;
      this.invalidatePlacement(placement);
      return false;
    }
    const tfdt = findTfdtOffset(moof);
    if (tfdt === null || tfdt.version !== 0 && tfdt.version !== 1) return false;
    const max = tfdt.version === 0 ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
    if (patched < 0n || patched > max) return false;
    if (newSource) {
      map.replaced = false;
      if (mediaType === 'video') {
        this.videoTrackIdentity = trackIdentity;
        this.lastVideoBmd = null; this.highestVideoGroupId = null; this.videoEpochGroupFloor = null;
      } else {
        this.audioTrackIdentity = trackIdentity;
        this.lastAudioBmd = null; this.highestAudioGroupId = null; this.audioEpochGroupFloor = null;
      }
      this.invalidatePlacement(placement);
    }
    patchBaseMediaDecodeTime(moof, patched);
    placement.patched = placement.revision;
    if (mediaType === 'video') {
      if (this.lastVideoBmd === null || rawBmd > this.lastVideoBmd) this.lastVideoBmd = rawBmd;
      if (this.highestVideoGroupId === null || groupId > this.highestVideoGroupId) this.highestVideoGroupId = groupId;
      if (this.lastVideoOutputBmd === null || patched > this.lastVideoOutputBmd) this.lastVideoOutputBmd = patched;
    } else {
      if (this.lastAudioBmd === null || rawBmd > this.lastAudioBmd) this.lastAudioBmd = rawBmd;
      if (this.highestAudioGroupId === null || groupId > this.highestAudioGroupId) this.highestAudioGroupId = groupId;
      if (this.lastAudioOutputBmd === null || patched > this.lastAudioOutputBmd) this.lastAudioOutputBmd = patched;
    }
    this.recordStartupGeometry(mediaType, rawBmd, patched);
    return true;
  }
}
