/**
 * Per-track object source: turns a fixture track's CMAF chunks into the MoQT
 * Object payloads of one group, in either packaging.
 *
 *  - `cmaf`   (default): one CMAF chunk per Object, verbatim; loop iterations
 *    after the first send tfdt-rebased copies (see cmaf-loop-rebase.ts).
 *  - `locmaf`: the same (rebased) chunk, encoded as one LOCMAF Object
 *    (draft-einarsson-moq-locmaf-01). Each group starts from a fresh
 *    {@link LocmafGroupState} and its first Object is forced to a full header
 *    (section 3: the first moof-carrying Object of each group). A timeline jump
 *    inside a group re-anchors with a full header on its own (section 15.9,
 *    the encoder's BMDT derivation check).
 *
 * Group and Object numbering is the caller's and identical in both modes.
 *
 * @module
 */
import {
  LocmafEncoder,
  LocmafFormatError,
  LocmafGroupState,
  parseLocmafTrackContext,
  serializeLocmafObject,
  type LocmafTrackContext,
} from '@moqt/locmaf';
import type { LoadedTrack } from './fixture.js';
import { analyzeLoopSpan, rebaseTfdtCopy } from './cmaf-loop-rebase.js';

/** Media Object packaging for a publish run. */
export type MediaPackaging = 'cmaf' | 'locmaf';

export class TrackObjectSource {
  /** Loop span in the track's timescale, or null when the chunks are not parseable CMAF. */
  readonly spanTicks: bigint | null;
  private readonly context: LocmafTrackContext | null;
  private readonly encoder = new LocmafEncoder();

  /**
   * @throws {Error} in `locmaf` mode when the track's init is not a CMAF Header
   *   a LOCMAF receiver can seed reconstruction from (section 6).
   */
  constructor(private readonly track: LoadedTrack, readonly packaging: MediaPackaging) {
    this.spanTicks = track.meta.packaging === 'cmaf' ? analyzeLoopSpan(track.chunks) : null;
    if (packaging !== 'locmaf') {
      this.context = null;
      return;
    }
    try {
      this.context = parseLocmafTrackContext(track.initData);
    } catch (e) {
      const why = e instanceof LocmafFormatError ? e.message : String(e);
      throw new Error(`locmaf packaging needs a CMAF Header for track ${track.meta.name}: ${why}`);
    }
  }

  /** MoQT track name. */
  get name(): string {
    return this.track.meta.name;
  }

  /** The CMAF chunks of loop iteration `groupIndex`, rebased so BMDT stays monotonic. */
  cmafChunksForGroup(groupIndex: number): readonly Uint8Array[] {
    if (groupIndex === 0 || this.spanTicks === null) return this.track.chunks;
    // Always rebase from the ORIGINAL bytes, so offsets never compound.
    const delta = this.spanTicks * BigInt(groupIndex);
    return this.track.chunks.map((c) => rebaseTfdtCopy(c, delta));
  }

  /** Object payloads for loop iteration `groupIndex`; Object ID = array index. */
  objectsForGroup(groupIndex: number): readonly Uint8Array[] {
    const chunks = this.cmafChunksForGroup(groupIndex);
    const context = this.context;
    if (context === null) return chunks;
    const state = new LocmafGroupState();
    return chunks.map((chunk, i) =>
      serializeLocmafObject(this.encoder.encode(chunk, state, context, i === 0, BigInt(i))));
  }
}
