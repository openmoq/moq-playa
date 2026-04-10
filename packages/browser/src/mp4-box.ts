/**
 * MP4/ISO BMFF box parsing utilities.
 *
 * Pure functions for reading, writing, and filtering MP4 box structures.
 * Used by both CmafAssembler (moof/mdat pairing) and MseMediaSource
 * (init segment filtering).
 *
 * @see ISO/IEC 14496-12 (ISO Base Media File Format)
 * @module
 */

/** Read a big-endian uint32 from a Uint8Array at offset. */
export function readU32(data: Uint8Array, offset: number): number {
  return ((data[offset]! << 24) | (data[offset + 1]! << 16) |
          (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

/** Write a big-endian uint32 into a Uint8Array at offset. */
export function writeU32(data: Uint8Array, offset: number, value: number): void {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

/** Get the 4-character box type at offset. */
export function boxType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset + 4]!, data[offset + 5]!,
                             data[offset + 6]!, data[offset + 7]!);
}

/** Get box size at offset (supports standard 32-bit size only). */
export function boxSize(data: Uint8Array, offset: number): number {
  return readU32(data, offset);
}

/**
 * Find the handler type (hdlr box → handler_type) inside a trak box.
 * Returns 'vide', 'soun', or null.
 */
export function trakHandlerType(data: Uint8Array, trakStart: number, trakEnd: number): string | null {
  let pos = trakStart + 8;
  while (pos + 8 <= trakEnd) {
    const size = boxSize(data, pos);
    if (size < 8) break;
    const type = boxType(data, pos);
    if (type === 'mdia') {
      let mdiaPos = pos + 8;
      const mdiaEnd = pos + size;
      while (mdiaPos + 8 <= mdiaEnd) {
        const mSize = boxSize(data, mdiaPos);
        if (mSize < 8) break;
        if (boxType(data, mdiaPos) === 'hdlr' && mdiaPos + 16 <= mdiaEnd) {
          return String.fromCharCode(
            data[mdiaPos + 16]!, data[mdiaPos + 17]!,
            data[mdiaPos + 18]!, data[mdiaPos + 19]!,
          );
        }
        mdiaPos += mSize;
      }
    }
    pos += size;
  }
  return null;
}

/** Get track_id from tkhd inside a trak. */
export function trakTrackId(data: Uint8Array, trakStart: number, trakEnd: number): number | null {
  let pos = trakStart + 8;
  while (pos + 8 <= trakEnd) {
    const size = boxSize(data, pos);
    if (size < 8) break;
    if (boxType(data, pos) === 'tkhd') {
      const version = data[pos + 8]!;
      const trackIdOffset = version === 1 ? pos + 32 : pos + 20;
      if (trackIdOffset + 4 <= trakEnd) {
        return readU32(data, trackIdOffset);
      }
    }
    pos += size;
  }
  return null;
}

/** Build a container box from a type string and children. */
export function buildBox(type: string, children: Uint8Array[]): Uint8Array {
  const contentSize = children.reduce((sum, c) => sum + c.byteLength, 0);
  const box = new Uint8Array(8 + contentSize);
  writeU32(box, 0, 8 + contentSize);
  box[4] = type.charCodeAt(0);
  box[5] = type.charCodeAt(1);
  box[6] = type.charCodeAt(2);
  box[7] = type.charCodeAt(3);
  let offset = 8;
  for (const child of children) {
    box.set(child, offset);
    offset += child.byteLength;
  }
  return box;
}

/** Filter mvex to keep only trex entries matching keepTrackId. */
export function filterMvex(data: Uint8Array, mvexStart: number, mvexEnd: number, keepTrackId: number): Uint8Array {
  const children: Uint8Array[] = [];
  let pos = mvexStart + 8;
  while (pos + 8 <= mvexEnd) {
    const size = boxSize(data, pos);
    if (size < 8) break;
    const type = boxType(data, pos);
    if (type === 'trex') {
      if (pos + 16 <= mvexEnd) {
        const trexTrackId = readU32(data, pos + 12);
        if (trexTrackId === keepTrackId) {
          children.push(data.slice(pos, pos + size));
        }
      }
    } else {
      children.push(data.slice(pos, pos + size));
    }
    pos += size;
  }
  return buildBox('mvex', children);
}

/**
 * Filter a multiplexed init segment to keep only the trak matching
 * the given handler type. MSE rejects moovs with non-matching traks.
 */
export function filterInitSegment(initData: Uint8Array, keepHandler: 'vide' | 'soun'): Uint8Array {
  let moovStart = -1;
  let moovSize = 0;
  let pos = 0;
  while (pos + 8 <= initData.byteLength) {
    const size = boxSize(initData, pos);
    if (size < 8) break;
    if (boxType(initData, pos) === 'moov') {
      moovStart = pos;
      moovSize = size;
      break;
    }
    pos += size;
  }
  if (moovStart < 0) return initData;

  const moovEnd = moovStart + moovSize;
  let keepTrackId: number | null = null;
  let trakCount = 0;

  pos = moovStart + 8;
  while (pos + 8 <= moovEnd) {
    const size = boxSize(initData, pos);
    if (size < 8) break;
    if (boxType(initData, pos) === 'trak') {
      trakCount++;
      const handler = trakHandlerType(initData, pos, pos + size);
      if (handler === keepHandler) {
        keepTrackId = trakTrackId(initData, pos, pos + size);
      }
    }
    pos += size;
  }

  if (trakCount <= 1 || keepTrackId === null) return initData;

  const moovChildren: Uint8Array[] = [];
  pos = moovStart + 8;
  while (pos + 8 <= moovEnd) {
    const size = boxSize(initData, pos);
    if (size < 8) break;
    const type = boxType(initData, pos);
    if (type === 'trak') {
      const handler = trakHandlerType(initData, pos, pos + size);
      if (handler === keepHandler) {
        moovChildren.push(initData.slice(pos, pos + size));
      }
    } else if (type === 'mvex') {
      moovChildren.push(filterMvex(initData, pos, pos + size, keepTrackId));
    } else {
      moovChildren.push(initData.slice(pos, pos + size));
    }
    pos += size;
  }

  const before = initData.slice(0, moovStart);
  const after = initData.slice(moovEnd);
  const newMoov = buildBox('moov', moovChildren);
  const result = new Uint8Array(before.byteLength + newMoov.byteLength + after.byteLength);
  let offset = 0;
  result.set(before, offset); offset += before.byteLength;
  result.set(newMoov, offset); offset += newMoov.byteLength;
  result.set(after, offset);
  return result;
}

/** Debug: list top-level box types and sizes. */
export function describeBoxes(data: Uint8Array): string {
  const boxes: string[] = [];
  let pos = 0;
  while (pos + 8 <= data.byteLength) {
    const size = boxSize(data, pos);
    if (size < 8) break;
    const type = boxType(data, pos);
    boxes.push(`${type}(${size})`);
    if (type === 'moov') {
      let cpos = pos + 8;
      while (cpos + 8 <= pos + size) {
        const cs = boxSize(data, cpos);
        if (cs < 8) break;
        boxes.push(`  ${boxType(data, cpos)}(${cs})`);
        cpos += cs;
      }
    }
    pos += size;
  }
  return boxes.join(', ');
}

// ─── tfdt helpers (for CMAF segment assembler) ──────────────────────

/**
 * Find the tfdt box offset inside a moof.
 * Walks: moof → traf → tfdt.
 *
 * @returns offset of the tfdt box start and its version, or null if not found
 */
export function findTfdtOffset(moof: Uint8Array): { offset: number; version: number } | null {
  // moof is the entire box including header
  if (moof.byteLength < 8 || boxType(moof, 0) !== 'moof') return null;

  const moofEnd = boxSize(moof, 0);
  let pos = 8; // skip moof header

  while (pos + 8 <= moofEnd) {
    const size = boxSize(moof, pos);
    if (size < 8) break;

    if (boxType(moof, pos) === 'traf') {
      // Search inside traf for tfdt
      let trafPos = pos + 8;
      const trafEnd = pos + size;
      while (trafPos + 8 <= trafEnd) {
        const tSize = boxSize(moof, trafPos);
        if (tSize < 8) break;
        if (boxType(moof, trafPos) === 'tfdt') {
          const version = moof[trafPos + 8]!; // version byte
          return { offset: trafPos, version };
        }
        trafPos += tSize;
      }
    }
    pos += size;
  }
  return null;
}

/**
 * Read baseMediaDecodeTime from a moof's tfdt box.
 *
 * @returns baseMediaDecodeTime as bigint, or null if tfdt not found
 */
export function readBaseMediaDecodeTime(moof: Uint8Array): bigint | null {
  const tfdt = findTfdtOffset(moof);
  if (!tfdt) return null;

  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  // tfdt layout: size(4) + type(4) + version(1) + flags(3) + baseMediaDecodeTime(4 or 8)
  const valueOffset = tfdt.offset + 12; // after box header (8) + fullbox header (4)

  if (tfdt.version === 0) {
    return BigInt(view.getUint32(valueOffset));
  } else {
    return view.getBigUint64(valueOffset);
  }
}

/**
 * Patch baseMediaDecodeTime in-place inside a moof's tfdt box.
 * Zero-copy — modifies the existing Uint8Array via DataView.
 *
 * @param moof The moof Uint8Array to modify in-place
 * @param newValue New baseMediaDecodeTime value
 */
export function patchBaseMediaDecodeTime(moof: Uint8Array, newValue: bigint): void {
  const tfdt = findTfdtOffset(moof);
  if (!tfdt) return;

  const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
  const valueOffset = tfdt.offset + 12;

  if (tfdt.version === 0) {
    view.setUint32(valueOffset, Number(newValue));
  } else {
    view.setBigUint64(valueOffset, newValue);
  }
}

/**
 * Concatenate two Uint8Arrays into a single buffer.
 * Used for moof+mdat assembly.
 */
export function concatBuffers(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

// ─── Segment-level time range (timeline-owned append) ───────────────
//
// Supports the MseMediaSource's timeline index by deriving each moof's
// [startTime, endTime) from tfdt + {trun per-sample | tfhd default |
// trex default}. Returns per-moof ranges so multi-moof payloads are
// handled correctly; returns null on any unscorable moof so the caller
// drops the whole payload (unscored bytes must not reach MSE).
//
// @see ISO/IEC 14496-12 §8.8.7 (tfhd), §8.8.8 (trun), §8.8.3 (trex)

export interface SegmentTimeRange {
  readonly startTime: bigint;
  readonly endTime: bigint;
  readonly sampleCount: number;
}

/**
 * Sample defaults from a track's trex box in the init segment.
 *
 * The trex box body has a fixed layout — `default_sample_duration`,
 * `default_sample_size`, and `default_sample_flags` are at known offsets
 * and are always present on the wire (per ISO/IEC 14496-12 §8.8.3).
 *
 * A value of 0 for any field is treated as "no usable default" by the
 * resolution priority in `iterateTrunSamples`: per-sample value in trun
 * (if its flag is set) → tfhd default → trex default → 0. A
 * well-authored encoder fills these fields; 0 here means either the
 * encoder didn't, or the value genuinely is 0 (which for duration
 * implies variable-rate with per-sample durations in trun).
 */
export interface TrexDefaults {
  readonly trackId: number;
  readonly defaultSampleDuration: number;
  readonly defaultSampleSize: number;
  readonly defaultSampleFlags: number;
}

/** Reasons `readSegmentTimeRanges` gives up on a specific moof. */
export type DiagnosticKind =
  | 'multi-traf'
  | 'no-tfdt'
  | 'no-trun'
  | 'no-duration'
  | 'malformed-moof';

// tfhd flags (ISO/IEC 14496-12 §8.8.7)
const TFHD_FLAG_BASE_DATA_OFFSET = 0x000001;
const TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_FLAG_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_FLAG_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_FLAG_DEFAULT_SAMPLE_FLAGS = 0x000020;

// trun flags (ISO/IEC 14496-12 §8.8.8)
const TRUN_FLAG_DATA_OFFSET = 0x000001;
const TRUN_FLAG_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_FLAG_SAMPLE_DURATION = 0x000100;
const TRUN_FLAG_SAMPLE_SIZE = 0x000200;
const TRUN_FLAG_SAMPLE_FLAGS = 0x000400;
const TRUN_FLAG_SAMPLE_CTO = 0x000800;

/**
 * Parse tfhd for its flags-gated default_sample_duration.
 *
 * Layout: boxHeader(8) + version(1) + flags(3) + track_ID(4) +
 *         [base_data_offset(8) if flag 0x1] +
 *         [sample_description_index(4) if flag 0x2] +
 *         [default_sample_duration(4) if flag 0x8] +
 *         ... (remaining fields we don't need)
 */
function parseTfhd(box: Uint8Array): { defaultSampleDuration?: number } {
  if (box.byteLength < 16) return {};
  const view = new DataView(box.buffer, box.byteOffset, box.byteLength);
  const flags = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);
  let pos = 16; // after box header + version/flags + track_ID
  if ((flags & TFHD_FLAG_BASE_DATA_OFFSET) !== 0) pos += 8;
  if ((flags & TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX) !== 0) pos += 4;
  if ((flags & TFHD_FLAG_DEFAULT_SAMPLE_DURATION) === 0) return {};
  if (pos + 4 > box.byteLength) return {};
  return { defaultSampleDuration: view.getUint32(pos) };
}

/**
 * Compute the total sample duration contributed by one trun box, using
 * per-sample durations if present, else the supplied defaults.
 *
 * @returns `{ totalDuration, sampleCount, scored }` — `scored: false`
 *          means no duration source was usable for this trun.
 */
function computeTrunDuration(
  box: Uint8Array,
  tfhdDefault: number | undefined,
  trexDefault: number | undefined,
): { totalDuration: bigint; sampleCount: number; scored: boolean } {
  if (box.byteLength < 16) return { totalDuration: 0n, sampleCount: 0, scored: false };
  const view = new DataView(box.buffer, box.byteOffset, box.byteLength);
  const flags = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);
  const sampleCount = view.getUint32(12);
  let pos = 16;
  if ((flags & TRUN_FLAG_DATA_OFFSET) !== 0) pos += 4;
  if ((flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) !== 0) pos += 4;

  const hasPerSampleDuration = (flags & TRUN_FLAG_SAMPLE_DURATION) !== 0;

  if (hasPerSampleDuration) {
    const hasSize = (flags & TRUN_FLAG_SAMPLE_SIZE) !== 0;
    const hasFlags = (flags & TRUN_FLAG_SAMPLE_FLAGS) !== 0;
    const hasCto = (flags & TRUN_FLAG_SAMPLE_CTO) !== 0;
    const recordSize = 4 + (hasSize ? 4 : 0) + (hasFlags ? 4 : 0) + (hasCto ? 4 : 0);
    if (pos + sampleCount * recordSize > box.byteLength) {
      return { totalDuration: 0n, sampleCount: 0, scored: false };
    }
    let total = 0n;
    let p = pos;
    for (let i = 0; i < sampleCount; i++) {
      total += BigInt(view.getUint32(p));
      p += recordSize;
    }
    return { totalDuration: total, sampleCount, scored: true };
  }

  const fallback = tfhdDefault ?? (trexDefault && trexDefault > 0 ? trexDefault : undefined);
  if (fallback === undefined) {
    return { totalDuration: 0n, sampleCount, scored: false };
  }
  return {
    totalDuration: BigInt(sampleCount) * BigInt(fallback),
    sampleCount,
    scored: true,
  };
}

/**
 * Read ranges from every moof in the payload.
 *
 * Tri-state return:
 *   - `null`: at least one moof was found but could not be fully
 *             scored (missing tfdt, missing trun, no duration source,
 *             multi-traf, malformed). Caller MUST drop the whole
 *             payload — appending unscored bytes would bypass the
 *             overlap check.
 *   - `[]`:   no moofs in the payload (init segment, mdat-only,
 *             unknown). Caller fails open.
 *   - `[r1,...]`: every moof scored successfully. Caller checks each
 *             range against its timeline before appending.
 *
 * @param segment Payload bytes (may start with styp/sidx prefix).
 * @param trex Track's trex defaults from the init segment, if known.
 * @param onDiagnostic Optional callback for per-moof failure signals.
 *                     Caller is responsible for deduping (warn-once).
 */
export function readSegmentTimeRanges(
  segment: Uint8Array,
  trex?: TrexDefaults,
  onDiagnostic?: (kind: DiagnosticKind, detail: string) => void,
): readonly SegmentTimeRange[] | null {
  const ranges: SegmentTimeRange[] = [];
  let moofCount = 0;
  let anyUnscorable = false;

  const emit = (kind: DiagnosticKind, detail: string) => {
    onDiagnostic?.(kind, detail);
    anyUnscorable = true;
  };

  let pos = 0;
  while (pos + 8 <= segment.byteLength) {
    const type = boxType(segment, pos);
    const size = boxSize(segment, pos);
    if (size < 8) break; // malformed top level, stop walking
    if (type !== 'moof') {
      pos += size;
      continue;
    }

    moofCount++;
    const moofStart = pos;
    const moof = segment.subarray(pos, pos + size);
    pos += size;

    // Walk moof for traf boxes.
    const trafs: Uint8Array[] = [];
    let innerPos = 8;
    let malformed = false;
    while (innerPos + 8 <= moof.byteLength) {
      const s = boxSize(moof, innerPos);
      if (s < 8) {
        emit('malformed-moof', `moof at ${moofStart}: inner box size ${s} at ${innerPos}`);
        malformed = true;
        break;
      }
      if (boxType(moof, innerPos) === 'traf') {
        trafs.push(moof.subarray(innerPos, innerPos + s));
      }
      innerPos += s;
    }
    if (malformed) continue;

    if (trafs.length === 0) {
      emit('no-trun', `moof at ${moofStart}: no traf`);
      continue;
    }
    if (trafs.length > 1) {
      emit('multi-traf', `moof at ${moofStart}: ${trafs.length} traf boxes (only first supported)`);
      continue;
    }

    const traf = trafs[0]!;

    // Walk traf for tfhd, tfdt, and all trun boxes.
    let tfhdBox: Uint8Array | null = null;
    let tfdtBox: Uint8Array | null = null;
    const trunBoxes: Uint8Array[] = [];
    let trafPos = 8;
    let trafMalformed = false;
    while (trafPos + 8 <= traf.byteLength) {
      const s = boxSize(traf, trafPos);
      if (s < 8) {
        emit('malformed-moof', `traf at moof ${moofStart}: inner box size ${s} at ${trafPos}`);
        trafMalformed = true;
        break;
      }
      const t = boxType(traf, trafPos);
      const sub = traf.subarray(trafPos, trafPos + s);
      if (t === 'tfhd') tfhdBox = sub;
      else if (t === 'tfdt') tfdtBox = sub;
      else if (t === 'trun') trunBoxes.push(sub);
      trafPos += s;
    }
    if (trafMalformed) continue;

    if (!tfdtBox) {
      emit('no-tfdt', `moof at ${moofStart}: traf has no tfdt`);
      continue;
    }
    if (trunBoxes.length === 0) {
      emit('no-trun', `moof at ${moofStart}: traf has no trun`);
      continue;
    }

    // Read bmd from tfdt.
    const tfdtView = new DataView(tfdtBox.buffer, tfdtBox.byteOffset, tfdtBox.byteLength);
    const tfdtVersion = tfdtBox[8]!;
    let bmd: bigint;
    if (tfdtVersion === 0) {
      if (tfdtBox.byteLength < 16) {
        emit('malformed-moof', `moof at ${moofStart}: tfdt v0 too short`);
        continue;
      }
      bmd = BigInt(tfdtView.getUint32(12));
    } else {
      if (tfdtBox.byteLength < 20) {
        emit('malformed-moof', `moof at ${moofStart}: tfdt v1 too short`);
        continue;
      }
      bmd = tfdtView.getBigUint64(12);
    }

    // Resolve per-sample duration source for this moof's truns.
    const tfhdInfo = tfhdBox ? parseTfhd(tfhdBox) : {};
    const trexDefault = trex?.defaultSampleDuration;

    let totalDuration = 0n;
    let totalSamples = 0;
    let allTrunsScored = true;
    for (const trun of trunBoxes) {
      const r = computeTrunDuration(trun, tfhdInfo.defaultSampleDuration, trexDefault);
      if (!r.scored) {
        allTrunsScored = false;
        break;
      }
      totalDuration += r.totalDuration;
      totalSamples += r.sampleCount;
    }
    if (!allTrunsScored) {
      emit(
        'no-duration',
        `moof at ${moofStart}: no duration resolvable from trun/tfhd/trex`,
      );
      continue;
    }

    ranges.push({
      startTime: bmd,
      endTime: bmd + totalDuration,
      sampleCount: totalSamples,
    });
  }

  if (moofCount === 0) return [];
  if (anyUnscorable) return null;
  return ranges;
}

/**
 * Read trex defaults for every track declared in an init segment's
 * moov → mvex → trex chain.
 *
 * trex body layout (fixed, no presence flags):
 *   version(1) + flags(3) + track_ID(4) +
 *   default_sample_description_index(4) +
 *   default_sample_duration(4) +
 *   default_sample_size(4) +
 *   default_sample_flags(4)
 *
 * @returns Map keyed by track_id. Empty if no mvex present.
 */
export function readTrexDefaults(initSegment: Uint8Array): Map<number, TrexDefaults> {
  const result = new Map<number, TrexDefaults>();

  let pos = 0;
  while (pos + 8 <= initSegment.byteLength) {
    const type = boxType(initSegment, pos);
    const size = boxSize(initSegment, pos);
    if (size < 8) break;
    if (type !== 'moov') {
      pos += size;
      continue;
    }

    // Walk moov for mvex.
    const moovEnd = pos + size;
    let mpos = pos + 8;
    while (mpos + 8 <= moovEnd) {
      const ms = boxSize(initSegment, mpos);
      if (ms < 8) break;
      if (boxType(initSegment, mpos) !== 'mvex') {
        mpos += ms;
        continue;
      }

      // Walk mvex for trex.
      const mvexEnd = mpos + ms;
      let tpos = mpos + 8;
      while (tpos + 8 <= mvexEnd) {
        const ts = boxSize(initSegment, tpos);
        if (ts < 8) break;
        if (boxType(initSegment, tpos) === 'trex' && ts >= 32) {
          const view = new DataView(
            initSegment.buffer,
            initSegment.byteOffset + tpos,
            ts,
          );
          // trex layout (after box header + version+flags):
          //   track_ID(4) + default_sample_description_index(4)
          //   + default_sample_duration(4) + default_sample_size(4)
          //   + default_sample_flags(4)
          const trackId = view.getUint32(12);
          const defaultSampleDuration = view.getUint32(20);
          const defaultSampleSize = view.getUint32(24);
          const defaultSampleFlags = view.getUint32(28);
          result.set(trackId, {
            trackId,
            defaultSampleDuration,
            defaultSampleSize,
            defaultSampleFlags,
          });
        }
        tpos += ts;
      }
      mpos += ms;
    }
    pos += size;
  }

  return result;
}

/**
 * Read the baseMediaDecodeTime from a CMAF segment that may have prefix
 * boxes (styp, sidx) before the moof.
 *
 * @returns { bmd, mdatSize } or null if no moof/tfdt found. mdatSize is
 *          the mdat box size if present (useful for diagnosing size
 *          anomalies); null if the segment doesn't include one.
 */
export function peekSegmentMetadata(segment: Uint8Array): {
  bmd: bigint | null;
  mdatSize: number | null;
} | null {
  if (segment.byteLength < 8) return null;

  // Walk top-level boxes to find moof + mdat.
  let moofOffset: number | null = null;
  let moofSize = 0;
  let mdatSize: number | null = null;

  let pos = 0;
  while (pos + 8 <= segment.byteLength) {
    const t = boxType(segment, pos);
    const s = boxSize(segment, pos);
    if (s < 8) break; // malformed
    if (t === 'moof' && moofOffset === null) {
      moofOffset = pos;
      moofSize = s;
    } else if (t === 'mdat' && mdatSize === null) {
      mdatSize = s;
    }
    pos += s;
  }

  if (moofOffset === null) return { bmd: null, mdatSize };
  const bmd = readBaseMediaDecodeTime(segment.subarray(moofOffset, moofOffset + moofSize));
  return { bmd, mdatSize };
}

// ─── HEVC NAL helpers ────────────────────────────────────────────────
//
// HEVC samples in CMAF use length-prefixed (HVCC) framing inside mdat:
// each NAL is preceded by a 4-byte big-endian length field (the
// "lengthSizeMinusOne" in hvcC is 3 → 4-byte lengths).
//
// HEVC NAL unit header (2 bytes):
//   forbidden_zero_bit (1) | nal_unit_type (6) | nuh_layer_id high (1)
//   nuh_layer_id low (5)   | nuh_temporal_id_plus1 (3)
//
// Relevant nal_unit_type values for splice / random-access decisions:
//   0    TRAIL_N        non-reference trailing picture
//   1    TRAIL_R        reference trailing picture
//   2-7  TSA_N..RADL_R  temporal sublayer / leading-decodable
//   8    RASL_N         non-reference leading-skipped picture
//   9    RASL_R         reference leading-skipped picture
//   16-18 BLA*          broken-link access (random-access)
//   19   IDR_W_RADL     IDR with possible RADL leading pictures
//   20   IDR_N_LP       IDR with no leading pictures
//   21   CRA            clean random access
//   32-34 VPS/SPS/PPS   parameter sets
//   35   AUD            access unit delimiter
//   39/40 PREFIX_SEI/SUFFIX_SEI
//
// VCL (video coding layer) range is 0..31. NAL types 32+ are non-VCL.
//
// @see ITU-T H.265 §7.3.1.2 (NAL unit header)
// @see ISO/IEC 14496-15 §8 (HEVC sample structure)

/** HEVC NAL unit type codes used by the RASL-strip path. */
export const HevcNalType = {
  RASL_N: 8,
  RASL_R: 9,
  IDR_W_RADL: 19,
  IDR_N_LP: 20,
  CRA: 21,
} as const;

/**
 * Extract the HEVC `nal_unit_type` from the first byte of a NAL unit's
 * RBSP. Returns -1 if the unit is too short to contain a valid header.
 */
export function getHevcNalType(nalUnit: Uint8Array): number {
  if (nalUnit.byteLength < 1) return -1;
  return (nalUnit[0]! >> 1) & 0x3f;
}

/** True for HEVC VCL NAL types (0..31). Non-VCL is 32+. */
export function isHevcVclNalType(nalType: number): boolean {
  return nalType >= 0 && nalType <= 31;
}

/** True for HEVC RASL pictures (NAL types 8 and 9). */
export function isHevcRaslNalType(nalType: number): boolean {
  return nalType === HevcNalType.RASL_N || nalType === HevcNalType.RASL_R;
}

/** True for HEVC CRA pictures (NAL type 21). */
export function isHevcCraNalType(nalType: number): boolean {
  return nalType === HevcNalType.CRA;
}

/**
 * Walk the length-prefixed (HVCC, 4-byte lengths) NAL units inside a
 * single sample's bytes and return the type of the first VCL NAL.
 * Returns null if no VCL NAL is found (e.g., a sample that contains
 * only parameter sets / SEIs — uncommon at the sample level but
 * possible in malformed feeds).
 *
 * Bounded walk: stops on length-zero or buffer underrun rather than
 * throwing, so a malformed sample yields null instead of crashing the
 * pipeline.
 */
export function firstHevcVclNalType(sampleBytes: Uint8Array): number | null {
  let pos = 0;
  while (pos + 5 <= sampleBytes.byteLength) {
    const len = readU32(sampleBytes, pos);
    pos += 4;
    if (len === 0 || pos + len > sampleBytes.byteLength) return null;
    const nalType = getHevcNalType(sampleBytes.subarray(pos, pos + 1));
    if (isHevcVclNalType(nalType)) return nalType;
    pos += len;
  }
  return null;
}

// ─── Per-sample iteration over trun ──────────────────────────────────

/** tfhd-derived defaults used by the sample iterator. */
export interface TfhdDefaults {
  readonly defaultSampleDuration?: number;
  readonly defaultSampleSize?: number;
  readonly defaultSampleFlags?: number;
}

/**
 * Parse tfhd flags-gated default fields. Layout per §8.8.7:
 *   header(8) + version(1) + flags(3) + track_ID(4) +
 *   [base_data_offset(8)            if 0x000001] +
 *   [sample_description_index(4)    if 0x000002] +
 *   [default_sample_duration(4)     if 0x000008] +
 *   [default_sample_size(4)         if 0x000010] +
 *   [default_sample_flags(4)        if 0x000020]
 */
export function parseTfhdDefaults(box: Uint8Array): TfhdDefaults {
  if (box.byteLength < 16) return {};
  const view = new DataView(box.buffer, box.byteOffset, box.byteLength);
  const flags = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);
  let pos = 16; // after box header + version/flags + track_ID
  if ((flags & TFHD_FLAG_BASE_DATA_OFFSET) !== 0) pos += 8;
  if ((flags & TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX) !== 0) pos += 4;
  const out: { defaultSampleDuration?: number; defaultSampleSize?: number; defaultSampleFlags?: number } = {};
  if ((flags & TFHD_FLAG_DEFAULT_SAMPLE_DURATION) !== 0) {
    if (pos + 4 > box.byteLength) return out;
    out.defaultSampleDuration = view.getUint32(pos);
    pos += 4;
  }
  if ((flags & TFHD_FLAG_DEFAULT_SAMPLE_SIZE) !== 0) {
    if (pos + 4 > box.byteLength) return out;
    out.defaultSampleSize = view.getUint32(pos);
    pos += 4;
  }
  if ((flags & TFHD_FLAG_DEFAULT_SAMPLE_FLAGS) !== 0) {
    if (pos + 4 > box.byteLength) return out;
    out.defaultSampleFlags = view.getUint32(pos);
    pos += 4;
  }
  return out;
}

/** One sample's metadata as resolved from trun + tfhd + trex. */
export interface TrunSample {
  /** Index within the trun (0-based). */
  readonly index: number;
  /** Byte offset into the mdat *payload* (i.e., after the 8-byte mdat header). */
  readonly mdatOffset: number;
  /** Sample size in bytes. */
  readonly size: number;
  /** Sample duration in track timescale ticks. */
  readonly duration: number;
  /**
   * Composition time offset (signed in v1, unsigned in v0).
   * 0 if not present and no default applies.
   */
  readonly ctsOffset: number;
  /**
   * 32-bit `sample_flags` word. 0 if neither per-sample flags nor a
   * tfhd/trex default are available. The first sample uses
   * `first_sample_flags` (trun flag 0x000004) when present.
   */
  readonly flags: number;
}

/**
 * Iterate samples described by a single trun box. Yields metadata
 * needed to slice the corresponding bytes out of mdat for re-packing.
 *
 * Resolution priority (per §8.8.8 / §8.8.7):
 *   - per-sample value in trun (if its flag is set)
 *   - tfhd default (if its flag is set)
 *   - trex default (last resort)
 *
 * Returns null if the trun is malformed (sample_count exceeds the
 * remaining bytes for the declared per-sample fields). Caller must
 * fall back to leaving the fragment untouched.
 */
export function iterateTrunSamples(
  trun: Uint8Array,
  tfhd: TfhdDefaults,
  trex?: TrexDefaults,
): readonly TrunSample[] | null {
  if (trun.byteLength < 16) return null;
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const version = view.getUint8(8);
  const flags = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);
  const sampleCount = view.getUint32(12);

  let pos = 16;
  if ((flags & TRUN_FLAG_DATA_OFFSET) !== 0) pos += 4;
  let firstSampleFlags = 0;
  let hasFirstSampleFlags = false;
  if ((flags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) !== 0) {
    if (pos + 4 > trun.byteLength) return null;
    firstSampleFlags = view.getUint32(pos);
    hasFirstSampleFlags = true;
    pos += 4;
  }

  const hasPerDuration = (flags & TRUN_FLAG_SAMPLE_DURATION) !== 0;
  const hasPerSize = (flags & TRUN_FLAG_SAMPLE_SIZE) !== 0;
  const hasPerFlags = (flags & TRUN_FLAG_SAMPLE_FLAGS) !== 0;
  const hasPerCto = (flags & TRUN_FLAG_SAMPLE_CTO) !== 0;
  const recordSize = (hasPerDuration ? 4 : 0) + (hasPerSize ? 4 : 0)
    + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);
  if (pos + sampleCount * recordSize > trun.byteLength) return null;

  const defaultDuration = tfhd.defaultSampleDuration
    ?? (trex && trex.defaultSampleDuration > 0 ? trex.defaultSampleDuration : undefined);
  const defaultSize = tfhd.defaultSampleSize
    ?? (trex && trex.defaultSampleSize > 0 ? trex.defaultSampleSize : undefined);
  const defaultFlags = tfhd.defaultSampleFlags
    ?? (trex && trex.defaultSampleFlags > 0 ? trex.defaultSampleFlags : undefined);

  const out: TrunSample[] = [];
  let mdatOffset = 0;
  for (let i = 0; i < sampleCount; i++) {
    let duration = defaultDuration ?? 0;
    let size = defaultSize ?? 0;
    let sampleFlags = defaultFlags ?? 0;
    let ctsOffset = 0;
    let p = pos + i * recordSize;
    if (hasPerDuration) { duration = view.getUint32(p); p += 4; }
    if (hasPerSize) { size = view.getUint32(p); p += 4; }
    if (hasPerFlags) { sampleFlags = view.getUint32(p); p += 4; }
    if (hasPerCto) {
      ctsOffset = version === 0 ? view.getUint32(p) : view.getInt32(p);
      p += 4;
    }
    // first_sample_flags overrides per-sample/default flags for sample 0
    if (i === 0 && hasFirstSampleFlags) sampleFlags = firstSampleFlags;
    out.push({ index: i, mdatOffset, size, duration, ctsOffset, flags: sampleFlags });
    mdatOffset += size;
  }
  return out;
}

// ─── Fragment rewriter (drop samples by keep-mask) ──────────────────

/**
 * Locate the first moof and the immediately-following mdat in a CMAF
 * segment payload. Tolerates a styp / sidx prefix.
 *
 * Returns `null` if either box is missing or the segment is malformed.
 */
function locateMoofMdat(segment: Uint8Array): {
  moofOffset: number; moofSize: number;
  mdatOffset: number; mdatSize: number;
} | null {
  let pos = 0;
  let moofOffset = -1;
  let moofSize = 0;
  let mdatOffset = -1;
  let mdatSize = 0;
  while (pos + 8 <= segment.byteLength) {
    const t = boxType(segment, pos);
    const s = boxSize(segment, pos);
    if (s < 8) return null;
    if (t === 'moof' && moofOffset === -1) {
      moofOffset = pos;
      moofSize = s;
    } else if (t === 'mdat' && moofOffset !== -1 && mdatOffset === -1) {
      mdatOffset = pos;
      mdatSize = s;
    }
    pos += s;
  }
  if (moofOffset === -1 || mdatOffset === -1) return null;
  return { moofOffset, moofSize, mdatOffset, mdatSize };
}

/**
 * Locate the single traf inside a moof, plus its tfhd and trun. Returns
 * `null` for shapes the rewriter doesn't handle (multi-traf, multi-trun,
 * malformed). Caller falls back to leaving the fragment untouched.
 */
function locateTrafBoxes(moof: Uint8Array): {
  trafOffset: number; trafSize: number;
  tfhdOffset: number; tfhdSize: number;
  trunOffset: number; trunSize: number;
} | null {
  // Walk children of moof, find traf
  let trafOffset = -1;
  let trafSize = 0;
  let trafCount = 0;
  let pos = 8; // after moof box header
  while (pos + 8 <= moof.byteLength) {
    const s = boxSize(moof, pos);
    if (s < 8) return null;
    const t = boxType(moof, pos);
    if (t === 'traf') {
      trafCount++;
      if (trafOffset === -1) {
        trafOffset = pos;
        trafSize = s;
      }
    }
    pos += s;
  }
  if (trafCount !== 1 || trafOffset === -1) return null;

  // Walk children of traf, find tfhd + trun (single each)
  let tfhdOffset = -1;
  let tfhdSize = 0;
  let trunOffset = -1;
  let trunSize = 0;
  let trunCount = 0;
  pos = trafOffset + 8;
  const trafEnd = trafOffset + trafSize;
  while (pos + 8 <= trafEnd) {
    const s = boxSize(moof, pos);
    if (s < 8) return null;
    const t = boxType(moof, pos);
    if (t === 'tfhd' && tfhdOffset === -1) {
      tfhdOffset = pos;
      tfhdSize = s;
    } else if (t === 'trun') {
      trunCount++;
      if (trunOffset === -1) {
        trunOffset = pos;
        trunSize = s;
      }
    }
    pos += s;
  }
  if (tfhdOffset === -1 || trunOffset === -1 || trunCount !== 1) return null;
  return { trafOffset, trafSize, tfhdOffset, tfhdSize, trunOffset, trunSize };
}

/**
 * Build a new trun box that keeps only the samples for which
 * `keepMask[i] === true`. Preserves the original version, the
 * `data_offset` and `first_sample_flags` prelude flags, and the
 * `sample_size` / `sample_flags` / `sample_cto` per-sample fields.
 *
 * The output **always** has `TRUN_FLAG_SAMPLE_DURATION` set with
 * explicit per-sample durations, even when the input relied on
 * `default_sample_duration` from tfhd/trex. Resolved per-sample
 * durations come from `samples[i].duration` (which `iterateTrunSamples`
 * already factored in defaults for). This lets the rewriter extend the
 * last kept sample's duration to absorb dropped samples' decode time —
 * otherwise the fragment ends short and the next fragment's bmd leaves
 * a presentation-time gap that stalls MSE-style demuxers.
 *
 * `data_offset` (when its flag is set) is signed and, in CMAF profiles
 * that use `default_base_is_moof` (the norm), measured from moof start.
 * Since rewriting the trun is the only thing that changes the moof
 * size, the mdat that follows shifts earlier (or later) by exactly the
 * trun's size delta — so `data_offset` is rebased by the same delta to
 * keep pointing at the same mdat byte.
 *
 * Caller is responsible for validating that `keepMask.length` matches
 * the original sample_count and that `samples.length` matches too.
 */
function rewriteTrun(
  trun: Uint8Array,
  keepMask: readonly boolean[],
  samples: readonly TrunSample[],
  bumpLastDurationBy: number,
): Uint8Array {
  const view = new DataView(trun.buffer, trun.byteOffset, trun.byteLength);
  const inFlags = (view.getUint8(9) << 16) | (view.getUint8(10) << 8) | view.getUint8(11);

  // Input layout: size(4) + 'trun'(4) + version+flags(4) + sample_count(4)
  // = 16 bytes; followed by optional data_offset(4), first_sample_flags(4),
  // then per-sample records in field order [duration?, size?, flags?, cto?].
  const hasDataOffset = (inFlags & TRUN_FLAG_DATA_OFFSET) !== 0;
  const hasFirstSampleFlags = (inFlags & TRUN_FLAG_FIRST_SAMPLE_FLAGS) !== 0;
  const inHasPerDuration = (inFlags & TRUN_FLAG_SAMPLE_DURATION) !== 0;
  const hasPerSize = (inFlags & TRUN_FLAG_SAMPLE_SIZE) !== 0;
  const hasPerFlags = (inFlags & TRUN_FLAG_SAMPLE_FLAGS) !== 0;
  const hasPerCto = (inFlags & TRUN_FLAG_SAMPLE_CTO) !== 0;
  const prelude = 16 + (hasDataOffset ? 4 : 0) + (hasFirstSampleFlags ? 4 : 0);
  const inRecordSize = (inHasPerDuration ? 4 : 0) + (hasPerSize ? 4 : 0)
    + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);

  // Output layout always carries per-sample durations. Other field flags
  // are preserved from the input.
  const outFlags = inFlags | TRUN_FLAG_SAMPLE_DURATION;
  const outRecordSize = 4 /* sample_duration */
    + (hasPerSize ? 4 : 0) + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);

  let keptCount = 0;
  let lastKeptIndex = -1;
  for (let i = 0; i < keepMask.length; i++) {
    if (keepMask[i]) { keptCount++; lastKeptIndex = i; }
  }

  const newSize = prelude + keptCount * outRecordSize;
  const trunDelta = newSize - trun.byteLength; // negative when shrinking, 0 if no-op
  const out = new Uint8Array(newSize);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Copy prelude (box size, type, version+flags, sample_count, optional
  // data_offset + first_sample_flags). We patch fields below.
  out.set(trun.subarray(0, prelude), 0);
  writeU32(out, 0, newSize);
  // Patch flags to include TRUN_FLAG_SAMPLE_DURATION if input lacked it.
  out[9] = (outFlags >> 16) & 0xff;
  out[10] = (outFlags >> 8) & 0xff;
  out[11] = outFlags & 0xff;
  // Patch sample_count
  writeU32(out, 12, keptCount);
  // Re-anchor data_offset by the trun's overall size change. The
  // surrounding moof shrinks/grows by `trunDelta`, mdat shifts by the
  // same amount, so the offset (relative to moof start under
  // default_base_is_moof) must shift by `trunDelta`.
  if (hasDataOffset && trunDelta !== 0) {
    const oldOffset = view.getInt32(16);
    outView.setInt32(16, oldOffset + trunDelta);
  }

  // Write per-sample records. Duration is always written first
  // (sourced from samples[i].duration so defaults are honored).
  // Subsequent fields are byte-copied from the input record.
  let writePos = prelude;
  for (let i = 0; i < keepMask.length; i++) {
    if (!keepMask[i]) continue;
    const baseDuration = samples[i]!.duration;
    const duration = (i === lastKeptIndex)
      ? baseDuration + bumpLastDurationBy
      : baseDuration;
    writeU32(out, writePos, duration);
    writePos += 4;

    // Copy size / flags / cto verbatim from input record (skip its
    // duration field if it had one).
    let srcOffset = prelude + i * inRecordSize + (inHasPerDuration ? 4 : 0);
    const tailLen = (hasPerSize ? 4 : 0) + (hasPerFlags ? 4 : 0) + (hasPerCto ? 4 : 0);
    out.set(trun.subarray(srcOffset, srcOffset + tailLen), writePos);
    writePos += tailLen;
  }
  return out;
}

/**
 * Rewrite a CMAF fragment to drop a subset of samples chosen by
 * `shouldDrop(sample, sampleBytes)`. Returns the new segment bytes
 * (preserving any styp/sidx prefix and trailing boxes verbatim) or
 * `null` if:
 *   - the segment has no moof/mdat,
 *   - the moof has multi-traf or multi-trun,
 *   - the trun is malformed,
 *   - mdat is too small to contain the declared samples,
 *   - no samples would be dropped (caller can short-circuit on null).
 *
 * Pure: does not mutate the input.
 *
 * Sample-table surgery includes:
 *   - rewriting `trun.sample_count` and per-sample arrays
 *   - shrinking the mdat by the dropped samples' bytes
 *   - patching mdat box size, traf box size, and moof box size in turn
 *
 * Note on `tfhd.base_data_offset` / `trun.data_offset`: when the moof
 * shrinks, any absolute `base_data_offset` would need re-anchoring.
 * We do NOT support fragments that set tfhd flag 0x000001
 * (BASE_DATA_OFFSET) — return `null` in that case so the caller falls
 * back to the original. CMAF segments routinely use the
 * `default_base_is_moof` flag (0x020000) instead, where mdat data is
 * implicitly relative to moof; our rewrite preserves that.
 */
export function rewriteFragmentDropSamples(
  segment: Uint8Array,
  shouldDrop: (sample: TrunSample, sampleBytes: Uint8Array) => boolean,
  trex?: TrexDefaults,
): Uint8Array | null {
  const loc = locateMoofMdat(segment);
  if (!loc) return null;

  const moof = segment.subarray(loc.moofOffset, loc.moofOffset + loc.moofSize);
  const mdatPayload = segment.subarray(
    loc.mdatOffset + 8,
    loc.mdatOffset + loc.mdatSize,
  );

  const traf = locateTrafBoxes(moof);
  if (!traf) return null;

  // Reject fragments using absolute base_data_offset — re-anchoring is
  // out of scope for this rewriter.
  const tfhdView = new DataView(
    moof.buffer, moof.byteOffset + traf.tfhdOffset, traf.tfhdSize,
  );
  const tfhdFlags =
    (tfhdView.getUint8(9) << 16) | (tfhdView.getUint8(10) << 8) | tfhdView.getUint8(11);
  if ((tfhdFlags & TFHD_FLAG_BASE_DATA_OFFSET) !== 0) return null;

  const tfhdBox = moof.subarray(traf.tfhdOffset, traf.tfhdOffset + traf.tfhdSize);
  const trunBox = moof.subarray(traf.trunOffset, traf.trunOffset + traf.trunSize);
  const tfhd = parseTfhdDefaults(tfhdBox);

  const samples = iterateTrunSamples(trunBox, tfhd, trex);
  if (!samples) return null;

  // Validate mdat is large enough for the declared samples
  let totalSampleBytes = 0;
  for (const s of samples) totalSampleBytes += s.size;
  if (totalSampleBytes > mdatPayload.byteLength) return null;

  // Build keep-mask. Track dropped sample bytes (for mdat resize) and
  // dropped sample durations (so we can extend the last kept sample to
  // absorb the time hole — otherwise the next fragment's bmd leaves a
  // presentation-time gap that stalls MSE-style demuxers).
  const keepMask: boolean[] = new Array(samples.length);
  let droppedCount = 0;
  let droppedBytes = 0;
  let droppedDuration = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const bytes = mdatPayload.subarray(s.mdatOffset, s.mdatOffset + s.size);
    const drop = shouldDrop(s, bytes);
    keepMask[i] = !drop;
    if (drop) {
      droppedCount++;
      droppedBytes += s.size;
      droppedDuration += s.duration;
    }
  }
  if (droppedCount === 0) return null;

  // Rewrite trun with kept samples only. Bumps the last kept sample's
  // duration so the fragment ends where the publisher said it would.
  // Output trun always includes per-sample durations (added if absent
  // in the input), sourced from the resolved `samples[i].duration`.
  const newTrun = rewriteTrun(trunBox, keepMask, samples, droppedDuration);
  const trunDelta = newTrun.byteLength - trunBox.byteLength; // can be + or -

  // Rewrite traf: copy through, splicing newTrun in place of old trun
  const newTrafSize = traf.trafSize + trunDelta;
  const newTraf = new Uint8Array(newTrafSize);
  // Copy traf header + everything before trun
  const trunRelInTraf = traf.trunOffset - traf.trafOffset;
  newTraf.set(moof.subarray(traf.trafOffset, traf.trafOffset + trunRelInTraf), 0);
  // Copy newTrun
  newTraf.set(newTrun, trunRelInTraf);
  // Copy everything after old trun (trailing boxes, e.g., sbgp, subs)
  const oldTrunEnd = traf.trunOffset + traf.trunSize;
  const trafEnd = traf.trafOffset + traf.trafSize;
  newTraf.set(
    moof.subarray(oldTrunEnd, trafEnd),
    trunRelInTraf + newTrun.byteLength,
  );
  // Patch traf size
  writeU32(newTraf, 0, newTrafSize);

  // Rewrite moof: copy through, splicing newTraf in place of old traf
  const newMoofSize = loc.moofSize + trunDelta;
  const newMoof = new Uint8Array(newMoofSize);
  const trafRelInMoof = traf.trafOffset; // moof is moof.subarray, traf.trafOffset is relative to moof start
  newMoof.set(moof.subarray(0, trafRelInMoof), 0);
  newMoof.set(newTraf, trafRelInMoof);
  newMoof.set(
    moof.subarray(trafRelInMoof + traf.trafSize, loc.moofSize),
    trafRelInMoof + newTrafSize,
  );
  writeU32(newMoof, 0, newMoofSize);

  // Rewrite mdat: keep only the bytes of kept samples, in order
  const newMdatPayloadSize = mdatPayload.byteLength - droppedBytes;
  const newMdat = new Uint8Array(8 + newMdatPayloadSize);
  writeU32(newMdat, 0, 8 + newMdatPayloadSize);
  newMdat[4] = 0x6d; newMdat[5] = 0x64; newMdat[6] = 0x61; newMdat[7] = 0x74; // 'mdat'
  let writePos = 8;
  for (let i = 0; i < samples.length; i++) {
    if (!keepMask[i]) continue;
    const s = samples[i]!;
    newMdat.set(mdatPayload.subarray(s.mdatOffset, s.mdatOffset + s.size), writePos);
    writePos += s.size;
  }

  // Stitch back: prefix (styp/sidx) + newMoof + newMdat + trailing
  const prefix = segment.subarray(0, loc.moofOffset);
  const trailing = segment.subarray(loc.mdatOffset + loc.mdatSize);
  const out = new Uint8Array(
    prefix.byteLength + newMoof.byteLength + newMdat.byteLength + trailing.byteLength,
  );
  let o = 0;
  out.set(prefix, o); o += prefix.byteLength;
  out.set(newMoof, o); o += newMoof.byteLength;
  out.set(newMdat, o); o += newMdat.byteLength;
  out.set(trailing, o);
  return out;
}
