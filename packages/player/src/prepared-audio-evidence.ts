import type { MoqtObject } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { LocmafTrackDecoder, isCmafHeader, parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';
import type { LocmafTrackContext } from '@openmoq/locmaf';
import type { TrackPackaging } from './subscription-manager.js';

/** Format evidence only; request ownership, deadlines and adoption belong to the player. */
export class PreparedAudioEvidence {
  sourcePresentationTimeUs: bigint | null = null;
  firstPresentationTimeUs: bigint | null = null;
  private context: LocmafTrackContext | undefined;
  private decoder: LocmafTrackDecoder | undefined;
  private readonly moofs = new Map<bigint, Uint8Array>();

  constructor(private readonly packaging: TrackPackaging) {}

  setInit(bytes: Uint8Array): void {
    if (this.packaging === 'loc') return;
    this.context = parseLocmafTrackContext(bytes);
    if (this.packaging === 'locmaf') this.decoder = new LocmafTrackDecoder(bytes);
  }

  inspect(obj: MoqtObject, headers?: LocHeaders): boolean {
    if (obj.kind !== 'data' || !obj.payload.byteLength) return false;
    if (this.packaging === 'loc') {
      // Without a source timestamp this target cannot join the established A/V timeline.
      if (headers?.captureTimestamp === undefined) throw new Error('Target audio has no source timestamp');
      this.sourcePresentationTimeUs = headers.captureTimestamp;
      this.firstPresentationTimeUs ??= headers.captureTimestamp;
      return true;
    }
    return this.inspectCmaf(obj.payload, BigInt(obj.groupId), BigInt(obj.objectId));
  }

  inspectCmaf(payload: Uint8Array, groupId: bigint, objectId = 0n): boolean {
    if (!this.context) return false;
    let bytes = payload;
    if (this.packaging === 'locmaf') {
      const result = this.decoder!.push(groupId, objectId, bytes);
      if (result.kind === 'rejected') throw result.error;
      bytes = result.bytes;
    }
    if (isCmafHeader(bytes)) return false;
    const group = groupId;
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    if (type === 'mdat') {
      const moof = this.moofs.get(group);
      if (!moof) return false; // a partial group is not usable evidence
      this.moofs.delete(group);
      const combined = new Uint8Array(moof.byteLength + bytes.byteLength);
      combined.set(moof); combined.set(bytes, moof.byteLength); bytes = combined;
    }
    try {
      const read = readCmafChunkSamples(bytes, this.context);
      const { durations, sizes } = read.effective;
      if (!durations.length || sizes.length !== durations.length || durations.some(value => value <= 0)
          || sizes.some(value => value <= 0) || sizes.reduce((sum, size) => sum + size, 0) > read.mdat.byteLength) {
        throw new Error('Target audio has no complete coded samples');
      }
      // Presentation includes the sample's composition offset; tfdt alone is decode time.
      this.sourcePresentationTimeUs = (read.effective.baseMediaDecodeTime
        + BigInt(read.effective.compositionTimeOffsets[0] ?? 0)) * 1_000_000n / BigInt(this.context.timescale);
      this.firstPresentationTimeUs ??= this.sourcePresentationTimeUs;
      return true;
    } catch (error) {
      // A standalone moof is ordinary split CMAF; the matching mdat must arrive.
      if (type === 'moof' && !containsMdat(bytes)) { this.moofs.set(group, bytes); return false; }
      throw error;
    }
  }
}

function containsMdat(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'mdat') return true;
    if (size < 8 || size > bytes.byteLength - offset) break;
    offset += size;
  }
  return false;
}
