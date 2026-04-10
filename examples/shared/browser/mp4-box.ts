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
