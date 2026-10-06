import { createHash } from 'node:crypto';
import type { LoadedTrack } from '../../examples/node-publisher/src/fixture.js';
import { TrackObjectSource } from '../../examples/node-publisher/src/track-packager.js';
import { LocmafTrackDecoder, buildCanonicalChunk, deserializeLocmafObject,
  parseCmafChunk, sliceFrames } from '../../packages/locmaf/src/index.js';

/** Local encode/decode proof, not an independent LOCMAF conformance oracle. */
export function inspectLocmafTrack(track: LoadedTrack, objectGroups?: readonly (readonly Uint8Array[])[]) {
  const source = new TrackObjectSource(track, 'locmaf');
  const decoder = new LocmafTrackDecoder(track.initData);
  const groups = objectGroups ?? [source.objectsForGroup(0), source.objectsForGroup(1)];
  if (groups.length < 2) throw new Error(`${track.meta.name}: qualification needs two LOCMAF groups`);
  let full = 0;
  let delta = 0;
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const equal = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
  const evidence = groups.map((objects, groupId) => {
    const chunks = source.cmafChunksForGroup(groupId);
    if (objects.length !== chunks.length) throw new Error(`${track.meta.name}: LOCMAF object count differs from CMAF`);
    return objects.map((bytes, objectId) => {
      const object = deserializeLocmafObject(bytes);
      if (object.kind !== 'moof' || (objectId === 0 && !object.header.full)) {
        throw new Error(`${track.meta.name}: expected moof Objects with a full group start`);
      }
      if (object.header.full) full++; else delta++;
      const decoded = decoder.push(BigInt(groupId), BigInt(objectId), bytes);
      const original = parseCmafChunk(chunks[objectId]!, decoder.context);
      if (!original.fits || decoded.kind !== 'chunk') throw new Error(`${track.meta.name}: LOCMAF reconstruction failed`);
      const canonical = buildCanonicalChunk(original.genBoxes, original.effective, original.mdat, decoder.context);
      if (!equal(decoded.bytes, canonical)) {
        const offset = canonical.findIndex((byte, i) => byte !== decoded.bytes[i]);
        throw new Error(`${track.meta.name}: group ${groupId} object ${objectId} reconstructed canonical chunk differs at byte ${offset}`);
      }
      const expectedFrames = sliceFrames(original.effective, original.mdat);
      const actualFrames = sliceFrames(decoded.effective, decoded.mdat);
      if (actualFrames.length !== expectedFrames.length || actualFrames.some((frame, i) => {
        const expected = expectedFrames[i]!;
        return frame.decodeTime !== expected.decodeTime || frame.presentationTime !== expected.presentationTime
          || frame.duration !== expected.duration || frame.flags !== expected.flags || !equal(frame.data, expected.data);
      })) throw new Error(`${track.meta.name}: LOCMAF coded samples or timing differ`);
      return { full: object.header.full, samples: actualFrames.length, objectSha256: hash(bytes),
        canonicalSha256: hash(canonical), mdatSha256: hash(decoded.mdat) };
    });
  });
  if (full < groups.length || delta === 0) throw new Error(`${track.meta.name}: fixture does not exercise full and delta headers`);
  return { name: track.meta.name, timescale: decoder.context.timescale, full, delta, groups: evidence };
}
