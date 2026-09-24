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

import {
  boxType,
  boxSize,
  readBaseMediaDecodeTime,
  patchBaseMediaDecodeTime,
  concatBuffers,
  rewriteFragmentDropSamples,
  firstHevcVclNalType,
  isHevcCraNalType,
  isHevcRaslNalType,
  readMdhdTimescale,
  readTrexDefaults,
  readSegmentTimeRanges,
  type TrexDefaults,
  type TrunSample,
} from './mp4-box.js';

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
   * `trackName` identifies the source MoQ track. Downstream consumers
   * (e.g. MseMediaSource's overlap detector) keep per-track state and need
   * to distinguish between same-track duplicates and across-track
   * splices (ABR switches).
   */
  readonly onSegment: (
    mediaType: 'video' | 'audio',
    segment: Uint8Array,
    trackName: string,
    groupId: bigint,
  ) => void;
  /**
   * Called when a decode-time discontinuity is detected (bmd went
   * backward). The MseMediaSource should clear its per-track replay index;
   * the assembler maps the new epoch after the prior emitted epoch so MSE
   * still sees one monotonic presentation timeline.
   */
  readonly onDiscontinuity?: (mediaType: 'video' | 'audio', trackName: string) => void;
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
  private readonly onSegment: CmafAssemblerOptions['onSegment'];
  private readonly onDiscontinuity: CmafAssemblerOptions['onDiscontinuity'];

  /**
   * Pending moofs keyed by "mediaType:trackName:groupId".
   * Multiple groups can have data in-flight simultaneously on different
   * QUIC streams — keying by groupId prevents cross-group contamination.
   */
  private pendingMoofs = new Map<string, Uint8Array>();

  /** Tracks (mediaType:trackName) already warned about non-media drops. */
  private readonly droppedNonMediaWarned = new Set<string>();

  /** Per-track rebase epoch (in that track's timescale units). */
  private videoEpoch: bigint | null = null;
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
  }> = [];

  /** Track name associated with the current epoch, for scoped timeline clear. */
  private videoTrackName: string | null = null;
  private audioTrackName: string | null = null;

  /** Track identities explicitly committed by the player after a switch. */
  private selectedVideoTrackName: string | null = null;
  private selectedAudioTrackName: string | null = null;

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
    if (mediaType === 'video') {
      this.videoTimescale = timescale;
    } else {
      this.audioTimescale = timescale;
    }
    const trexMap = readTrexDefaults(initBytes);
    const trex = trexMap.size > 0 ? trexMap.values().next().value! : null;
    if (mediaType === 'video') this.videoTrex = trex;
    else this.audioTrex = trex;
  }

  /**
   * Commit the track that may feed one media type.
   *
   * Track streams can overlap during a quality switch. Once the player has
   * committed the replacement, late objects from the retired track must not
   * be allowed to switch the assembler back. Pending half-pairs are discarded
   * at the same boundary so an old moof cannot pair with a later mdat.
   */
  selectTrack(mediaType: 'video' | 'audio', trackName: string): void {
    if (mediaType === 'video') this.selectedVideoTrackName = trackName;
    else this.selectedAudioTrackName = trackName;
    this.clearPending(mediaType);
  }

  /**
   * Push a CMAF MoQ object payload (moof or mdat).
   *
   * If it's a moof, buffer it keyed by (mediaType, trackName, groupId).
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
   */
  push(
    mediaType: 'video' | 'audio',
    trackName: string,
    groupId: bigint,
    payload: Uint8Array,
  ): void {
    const selectedTrackName = mediaType === 'video'
      ? this.selectedVideoTrackName
      : this.selectedAudioTrackName;
    if (selectedTrackName !== null && trackName !== selectedTrackName) return;
    if (payload.byteLength < 8) return;

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
      const warnKey = `${mediaType}:${trackName}`;
      if (!this.droppedNonMediaWarned.has(warnKey)) {
        this.droppedNonMediaWarned.add(warnKey);
        console.warn(
          `[CMAF] dropped ${mediaType} "${trackName}" object with no moof/mdat `
          + `(${payload.byteLength}B, first box "${boxType(payload, 0)}") — `
          + `in-band init segments must be handled before the assembler`);
      }
      return;
    }
    const type = boxType(payload, moofOffset);
    const key = `${mediaType}:${trackName}:${groupId}`;

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
        while (pos + 8 <= segment.byteLength) {
          const size = boxSize(segment, pos);
          if (size < 8 || pos + size > segment.byteLength) break;
          if (boxType(segment, pos) === 'moof') {
            const chunkMoof = segment.subarray(pos, pos + size);
            if (!this.patchEpoch(mediaType, trackName, chunkMoof, groupId)) return;
          }
          pos += size;
        }
        this.emitSegment(mediaType, segment, trackName, groupId);
        this.flushStartupGeometry();
        return;
      }

      // Legacy: moof-only object — buffer and wait for a separate mdat.
      // Copy — the original Uint8Array may share its ArrayBuffer with other
      // QUIC stream data. In-place tfdt patching would corrupt it.
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      this.pendingMoofs.set(key, copy);
      return;
    }

    if (type === 'mdat') {
      const pending = this.pendingMoofs.get(key);
      if (!pending) return; // Orphaned mdat — drop
      this.pendingMoofs.delete(key);

      if (!this.patchEpoch(mediaType, trackName, pending, groupId)) return;

      // Concatenate moof + mdat
      const segment = concatBuffers(pending, payload);
      this.emitSegment(mediaType, segment, trackName, groupId);
      this.flushStartupGeometry();
      return;
    }

    // Unknown box type — pass through as-is.
    this.onSegment(mediaType, payload, trackName, groupId);
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
  ): void {
    const output = this.maybeStripRaslSamples(mediaType, segment);
    const trex = mediaType === 'video' ? this.videoTrex : this.audioTrex;
    const ranges = readSegmentTimeRanges(output, trex ?? undefined);
    this.onSegment(mediaType, output, trackName, groupId);
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
    for (const key of [...this.pendingMoofs.keys()]) {
      if (key.startsWith(`${mediaType}:`)) this.pendingMoofs.delete(key);
    }
  }

  /** Clear all pending moofs, epoch state, and parsed init defaults. */
  reset(): void {
    this.pendingMoofs.clear();
    this.videoEpoch = null;
    this.audioEpoch = null;
    this.lastVideoBmd = null;
    this.lastAudioBmd = null;
    this.highestVideoGroupId = null;
    this.highestAudioGroupId = null;
    this.videoEpochGroupFloor = null;
    this.audioEpochGroupFloor = null;
    this.pendingDiscontinuities = [];
    this.videoTrackName = null;
    this.audioTrackName = null;
    this.selectedVideoTrackName = null;
    this.selectedAudioTrackName = null;
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
        this.onDiscontinuity?.(event.mediaType, event.trackName);
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
  ): boolean {
    const bmd = readBaseMediaDecodeTime(moof);
    if (bmd === null) return true;

    const currentTrackName = mediaType === 'video' ? this.videoTrackName : this.audioTrackName;
    const isTrackSwitch = currentTrackName !== null && currentTrackName !== trackName;
    const epochGroupFloor = mediaType === 'video'
      ? this.videoEpochGroupFloor
      : this.audioEpochGroupFloor;
    if (!isTrackSwitch && epochGroupFloor !== null && groupId < epochGroupFloor) {
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

    if (isTrackSwitch) {
      // Track switch (ABR splice): variants in a switching set are media-time
      // aligned. Keep the shared raw/output epochs so a switch cannot jump
      // back to presentation time zero after a source restart.
      const anchored = this.anchorEpoch(mediaType, bmd, false);
      if (mediaType === 'video') {
        this.videoEpoch = anchored;
        this.videoTrackName = trackName;
        this.lastVideoBmd = null;
        this.videoEpochGen = this.sharedEpochGen;
        this.highestVideoGroupId = null;
        this.videoOutputOffset = this.outputOffsetFor('video', bmd, anchored);
        this.videoEpochGroupFloor = null;
      } else {
        this.audioEpoch = anchored;
        this.audioTrackName = trackName;
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
        this.videoTrackName = trackName;
        this.lastVideoBmd = null;
        this.videoOutputOffset = this.outputOffsetFor('video', bmd, anchored);
      } else {
        this.audioEpoch = anchored;
        this.audioTrackName = trackName;
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
          this.lastVideoBmd = bmd;
          this.videoOutputOffset = this.outputOffsetFor('video', bmd, anchored);
          this.videoEpochGroupFloor = groupId;
        } else {
          this.audioEpoch = anchored;
          this.lastAudioBmd = bmd;
          this.audioOutputOffset = this.outputOffsetFor('audio', bmd, anchored);
          this.audioEpochGroupFloor = groupId;
        }
        this.pendingDiscontinuities.push({ mediaType, trackName });
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
    const patchedBmd = outputOffset + bmd - currentEpoch;
    if (patchedBmd < 0n) return false;
    patchBaseMediaDecodeTime(moof, patchedBmd);
    if (mediaType === 'video') {
      if (this.lastVideoOutputBmd === null || patchedBmd > this.lastVideoOutputBmd) {
        this.lastVideoOutputBmd = patchedBmd;
      }
    } else if (this.lastAudioOutputBmd === null || patchedBmd > this.lastAudioOutputBmd) {
      this.lastAudioOutputBmd = patchedBmd;
    }
    this.recordStartupGeometry(mediaType, bmd, patchedBmd);

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
}
