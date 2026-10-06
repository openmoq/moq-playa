import type { LoadedTrack } from '../../examples/node-publisher/src/fixture.js';
import { parseLocmafTrackContext, parseCmafChunk, sliceFrames } from '../../packages/locmaf/src/index.js';
import { analyzeCmafTimeline } from '../../examples/node-publisher/src/cmaf-loop-rebase.js';

/** Sample-level proof for the harness's no-B-frame, independently coded fragments. */
export function inspectAlternatives(tracks: readonly LoadedTrack[]) {
  const inspected = tracks.map((track) => {
    const context = parseLocmafTrackContext(track.initData);
    if (!analyzeCmafTimeline(track.initData, track.chunks)) throw new Error(`${track.meta.name}: unsupported CMAF timeline`);
    let nextDecode: bigint | undefined;
    const chunks = track.chunks.map((chunk) => {
      const parsed = parseCmafChunk(chunk, context);
      if (!parsed.fits) throw new Error(`${track.meta.name}: unsupported CMAF chunk`);
      const frames = sliceFrames(parsed.effective, parsed.mdat);
      if (!frames.length || !frames[0]!.isSync || (frames[0]!.flags >>> 24 & 3) !== 2) {
        throw new Error(`${track.meta.name}: fragment must start with an independent sync sample`);
      }
      const samples = frames.map((frame) => {
        if (frame.duration <= 0 || (nextDecode !== undefined && nextDecode !== frame.decodeTime)) {
          throw new Error(`${track.meta.name}: samples must be contiguous with positive durations`);
        }
        nextDecode = frame.decodeTime + BigInt(frame.duration);
        return { decodeTicks: frame.decodeTime.toString(), presentationTicks: frame.presentationTime.toString(),
          durationTicks: String(frame.duration), sync: frame.isSync };
      });
      return { samples };
    });
    return { name: track.meta.name, role: track.meta.role, timescale: context.timescale,
      durationTicks: (nextDecode! - BigInt(chunks[0]!.samples[0]!.decodeTicks)).toString(), chunks };
  });
  // Compare media time exactly, not rounded milliseconds; languages are separate
  // audio content, but their test signals intentionally use the same timing.
  for (const role of ['video', 'audio']) {
    const alternatives = inspected.filter((track) => track.role === role);
    const reference = alternatives[0];
    if (!reference) continue;
    for (const track of alternatives.slice(1)) {
      const sameTime = (a: string, b: string) => BigInt(a) * BigInt(track.timescale) === BigInt(b) * BigInt(reference.timescale);
      if (reference.chunks.length !== track.chunks.length || !sameTime(reference.durationTicks, track.durationTicks)
        || reference.chunks.some((chunk, i) => chunk.samples.length !== track.chunks[i]!.samples.length
          || chunk.samples.some((sample, j) => {
            const other = track.chunks[i]!.samples[j]!;
            return !sameTime(sample.decodeTicks, other.decodeTicks) || !sameTime(sample.presentationTicks, other.presentationTicks)
              || !sameTime(sample.durationTicks, other.durationTicks) || sample.sync !== other.sync;
          }))) throw new Error(`${track.name}: ${role} alternatives are not sample aligned`);
    }
  }
  return inspected;
}
