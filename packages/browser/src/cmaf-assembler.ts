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
 * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging — moof+mdat)
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
   * backward). The MseMediaSource should clear its per-track timeline
   * so old ranges don't cause overlap drops on the new epoch.
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
 * assembler.push(mediaType, obj.payload);
 * ```
 */
export class CmafAssembler {
  private readonly onSegment: CmafAssemblerOptions['onSegment'];
  private readonly onDiscontinuity: CmafAssemblerOptions['onDiscontinuity'];

  /**
   * Pending moofs keyed by "mediaType:groupId".
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

  /** Track name associated with the current epoch, for scoped timeline clear. */
  private videoTrackName: string | null = null;
  private audioTrackName: string | null = null;

  /**
   * Trex defaults parsed from the video init segment. Used by the
   * strip path so {@link iterateTrunSamples} can resolve sample
   * defaults for streams that don't carry them in tfhd. Without these,
   * the rewriter would emit zero-duration samples on streams that rely
   * on trex defaults exclusively. Audio is intentionally not stored —
   * the strip path skips audio tracks entirely.
   */
  private videoTrex: TrexDefaults | null = null;

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
   * Only the video init is consumed today (the strip path skips audio).
   * Single-track init segments (one trex per init) are the common
   * CMAF case — picks the first trex if multiple are present.
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
    if (mediaType !== 'video') return;
    const trexMap = readTrexDefaults(initBytes);
    this.videoTrex = trexMap.size > 0 ? trexMap.values().next().value! : null;
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
   * @param payload Raw MoQ object payload (a single MP4 box: moof or mdat)
   */
  push(
    mediaType: 'video' | 'audio',
    trackName: string,
    groupId: bigint,
    payload: Uint8Array,
  ): void {
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
        // §3.3 compliant: [styp+]moof+mdat combined in a single object.
        // Copy the moof for safe in-place tfdt patching, then reassemble
        // with original styp prefix (if present) and trailing mdat.
        const moof = new Uint8Array(moofSize);
        moof.set(payload.subarray(moofOffset, moofEnd));
        const rest = payload.subarray(moofEnd);

        this.patchEpoch(mediaType, trackName, moof, groupId);

        const segment = moofOffset > 0
          ? concatBuffers(concatBuffers(payload.subarray(0, moofOffset), moof), rest)
          : concatBuffers(moof, rest);
        this.onSegment(mediaType, this.maybeStripRaslSamples(mediaType, segment), trackName, groupId);
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

      this.patchEpoch(mediaType, trackName, pending, groupId);

      // Concatenate moof + mdat
      const segment = concatBuffers(pending, payload);
      this.onSegment(mediaType, this.maybeStripRaslSamples(mediaType, segment), trackName, groupId);
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
    this.videoTrackName = null;
    this.audioTrackName = null;
    this.videoTrex = null;
    this.videoTimescale = null;
    this.audioTimescale = null;
    this.sharedEpochBmd = null;
    this.sharedEpochTimescale = null;
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

  /**
   * Compute a track's rebase epoch from the shared cross-track epoch,
   * establishing or re-establishing the shared epoch as needed.
   *
   * - No timescale known for this track → per-track zero-basing (legacy).
   * - Shared epoch unset (or being re-established after a restart this
   *   track saw first) → this track's bmd becomes the shared epoch.
   * - Otherwise → adopt the shared epoch scaled to this track's units,
   *   clamped to the track's own bmd so a track whose content starts
   *   before the epoch track never rebases negative.
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
    }
    if (mediaType === 'video') {
      this.videoEpochGen = this.sharedEpochGen;
    } else {
      this.audioEpochGen = this.sharedEpochGen;
    }

    const shared = this.scaledSharedEpoch(timescale)!;
    return shared <= bmd ? shared : bmd;
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

  /** Record epoch from first moof, detect discontinuity, rebase tfdt. */
  private patchEpoch(mediaType: 'video' | 'audio', trackName: string, moof: Uint8Array, groupId?: bigint): void {
    const bmd = readBaseMediaDecodeTime(moof);
    if (bmd === null) return;

    const currentTrackName = mediaType === 'video' ? this.videoTrackName : this.audioTrackName;
    const isTrackSwitch = currentTrackName !== null && currentTrackName !== trackName;
    const lastBmd = mediaType === 'video' ? this.lastVideoBmd : this.lastAudioBmd;
    const epoch = mediaType === 'video' ? this.videoEpoch : this.audioEpoch;

    if (isTrackSwitch) {
      // Track switch (ABR splice) — re-anchor to this track's own bmd
      // without touching the shared epoch: variant timelines may be
      // unrelated to the timeline the shared epoch was anchored on.
      if (mediaType === 'video') {
        this.videoEpoch = bmd;
        this.videoTrackName = trackName;
        this.lastVideoBmd = null;
        this.videoEpochGen = this.sharedEpochGen;
      } else {
        this.audioEpoch = bmd;
        this.audioTrackName = trackName;
        this.lastAudioBmd = null;
        this.audioEpochGen = this.sharedEpochGen;
      }
    } else if (epoch === null) {
      // First segment — anchor against the shared cross-track epoch so
      // the publisher's A/V alignment survives the rebase to zero.
      const anchored = this.anchorEpoch(mediaType, bmd, false);
      if (mediaType === 'video') {
        this.videoEpoch = anchored;
        this.videoTrackName = trackName;
        this.lastVideoBmd = null;
      } else {
        this.audioEpoch = anchored;
        this.audioTrackName = trackName;
        this.lastAudioBmd = null;
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
      if (!isSmallAudioReorder) {
        if (this.debug) console.warn('[CMAF] %s discontinuity on "%s": bmd=%s < lastBmd=%s (jump=%s) — re-anchoring',
          mediaType, trackName, bmd, lastBmd, jumpBack);
        this.onDiscontinuity?.(mediaType, trackName);
        // A restart affects both tracks. The first track to detect it
        // re-establishes the shared epoch (generation bump); the second
        // track sees its generation is behind and adopts the new epoch
        // instead of zero-basing independently.
        const trackGen = mediaType === 'video' ? this.videoEpochGen : this.audioEpochGen;
        const anchored = this.anchorEpoch(mediaType, bmd, trackGen === this.sharedEpochGen);
        if (mediaType === 'video') {
          this.videoEpoch = anchored;
          this.lastVideoBmd = bmd;
        } else {
          this.audioEpoch = anchored;
          this.lastAudioBmd = bmd;
        }
      }
    }

    // Only advance the high-water mark — don't let out-of-order
    // delivery lower it, which would cause the NEXT in-order segment
    // to look like a forward jump past the reordered one.
    if (mediaType === 'video') {
      if (this.lastVideoBmd === null || bmd > this.lastVideoBmd) this.lastVideoBmd = bmd;
    } else {
      if (this.lastAudioBmd === null || bmd > this.lastAudioBmd) this.lastAudioBmd = bmd;
    }

    const currentEpoch = mediaType === 'video' ? this.videoEpoch! : this.audioEpoch!;
    const patchedBmd = bmd - currentEpoch;
    patchBaseMediaDecodeTime(moof, patchedBmd);
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
        const patched = bmd - currentEpoch;
        const sec = (t: bigint) => (timescale ? `${(Number(t) / timescale).toFixed(3)}s` : 'n/a');
        console.log(
          '[CMAF] startup#%d %s "%s" group=%s timescale=%s rawBmd=%s (%s) epoch=%s sharedEpoch=%s/%s patched=%s (%s)',
          seen + 1, mediaType, trackName, String(groupId ?? 'n/a'), String(timescale ?? 'unknown'),
          String(bmd), sec(bmd), String(currentEpoch),
          String(this.sharedEpochBmd ?? 'unset'), String(this.sharedEpochTimescale ?? 'unset'),
          String(patched), sec(patched),
        );
      }
    }
  }
}
