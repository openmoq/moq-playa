import type { MoqtObject } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { LocmafTrackDecoder, isCmafHeader, isSyncSampleFlags, parseLocmafTrackContext, readCmafObjectSamples } from '@openmoq/locmaf';
import type { LocmafTrackContext } from '@openmoq/locmaf';
import { isKeyframePayload } from '@openmoq/playback';
import type { TrackPackaging } from './subscription-manager.js';

/** Format evidence only; request ownership, deadlines and adoption belong to the player. */
export class PreparedOutputEvidence {
  sourcePresentationTimeUs: bigint | null = null;
  firstPresentationTimeUs: bigint | null = null;
  /** First retained object needed for the usable chunk, including a split moof. */
  firstUsableLocation: { readonly groupId: bigint; readonly objectId: bigint } | null = null;
  private context: LocmafTrackContext | undefined;
  private decoder: LocmafTrackDecoder | undefined;
  private readonly moofs = new Map<bigint, { readonly bytes: Uint8Array; readonly objectId: bigint }>();

  private usable(timeUs: bigint, groupId: bigint, objectId: bigint): void {
    this.sourcePresentationTimeUs = timeUs;
    if (this.firstPresentationTimeUs === null) {
      this.firstPresentationTimeUs = timeUs;
      this.firstUsableLocation = Object.freeze({ groupId, objectId });
    }
  }

  constructor(private readonly packaging: TrackPackaging, private readonly role: 'video' | 'audio' = 'audio', private readonly codec?: string) {}

  setInit(bytes: Uint8Array): void {
    if (this.packaging === 'loc') return;
    this.context = parseLocmafTrackContext(bytes);
    if (this.packaging === 'locmaf') this.decoder = new LocmafTrackDecoder(bytes);
  }

  inspect(obj: MoqtObject, headers?: LocHeaders): boolean {
    if (obj.kind !== 'data' || !obj.payload.byteLength) return false;
    if (this.packaging === 'loc') {
      // Without a source timestamp this target cannot join the established A/V timeline.
      if (headers?.captureTimestamp === undefined) throw new Error(`Target ${this.role} has no source timestamp`);
      if (this.role === 'video') {
        // LOC-04's group starts at an independent Object 0. An explicit
        // dependent marking takes precedence over that fallback. Unlike a
        // warning during playback, contradictory known bitstream evidence
        // cannot prove a candidate ready for a fresh decoder sequence.
        if (!(headers.videoFrameMarking?.independent ?? BigInt(obj.objectId) === 0n)) return false;
        // The shared checker expects four-byte NAL lengths. A three-byte
        // Annex B prefix is ambiguous with a large four-byte length, so it
        // cannot supply contradictory bitstream evidence here (LOC-04 §2.1.4).
        // Keep the declared independence authoritative for that representation.
        const nalCodec = this.codec && /^(avc1|avc3|hvc1|hev1)(\.|$)/i.test(this.codec);
        const ambiguousPrefix = nalCodec && obj.payload[0] === 0 && obj.payload[1] === 0 && obj.payload[2] === 1;
        if (this.codec && !ambiguousPrefix && isKeyframePayload(this.codec, obj.payload) === false) return false;
      }
      this.usable(headers.captureTimestamp, BigInt(obj.groupId), BigInt(obj.objectId));
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
    let firstObject = objectId;
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    const moof = this.moofs.get(group);
    if (moof) {
      this.moofs.delete(group);
      firstObject = moof.objectId;
      const combined = new Uint8Array(moof.bytes.byteLength + bytes.byteLength);
      combined.set(moof.bytes); combined.set(bytes, moof.bytes.byteLength); bytes = combined;
    } else if (type === 'mdat') return false; // a partial group is not usable evidence
    // CMSF permits successive chunks. The shared format reader validates the
    // whole object before we publish timing or use its first chunk as a witness.
    const reads = readCmafObjectSamples(bytes, this.context);
    if (reads === null) {
      this.moofs.set(group, { bytes, objectId: firstObject });
      return false; // ordinary split CMAF, including a pre-moof prefix
    }
    for (const read of reads) {
      const { durations, sizes } = read.effective;
      if (!durations.length || sizes.length !== durations.length || durations.some(value => value <= 0)
          || sizes.some(value => value <= 0) || sizes.reduce((sum, size) => sum + size, 0) > read.mdat.byteLength) {
        throw new Error(`Target ${this.role} has no complete coded samples`);
      }
    }
    // CMSF-01 §3.4 requires the starting SAP. The whole Object is replayed;
    // later sync cannot authorize a dependent prefix without explicit trimming.
    const first = reads[0]!;
    if (this.role === 'video' && (first.effective.flags[0] === undefined
        || !isSyncSampleFlags(first.effective.flags[0]))) return false;
    // Presentation includes the FIRST chunk's composition offset, not just tfdt.
    const sourceTimeUs = (first.effective.baseMediaDecodeTime
      + BigInt(first.effective.compositionTimeOffsets[0] ?? 0)) * 1_000_000n / BigInt(this.context.timescale);
    this.usable(sourceTimeUs, group, firstObject);
    return true;
  }
}
