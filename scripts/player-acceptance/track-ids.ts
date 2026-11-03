import assert from 'node:assert/strict';
import { childBoxes, viewOf, type IsoBoxHeader } from '../../packages/locmaf/src/iso-box.js';
import { parseLocmafTrackContext, parseCmafChunk } from '../../packages/locmaf/src/index.js';

function one(bytes: Uint8Array, start: number, end: number, type: string): IsoBoxHeader {
  const boxes = childBoxes(bytes, start, end, 'fixture').filter(box => box.type === type);
  assert.equal(boxes.length, 1, `fixture requires one ${type}`);
  return boxes[0]!;
}

function field(bytes: Uint8Array, box: IsoBoxHeader, offset: number, versions = [0]): number {
  assert.ok(versions.includes(bytes[box.contentStart]!), `unsupported ${box.type} version`);
  assert.ok(box.contentStart + offset + 4 <= box.end, `truncated ${box.type}`);
  return box.contentStart + offset;
}

/** Rewrite only parsed ID fields in this harness's single-track CMAF files. */
export function rewriteTrackIds(initData: Uint8Array, chunks: readonly Uint8Array[], trackId: number) {
  assert.ok(Number.isInteger(trackId) && trackId > 0 && trackId < 0xffffffff, 'invalid fixture track ID');
  assert.ok(chunks.length > 0, 'fixture needs media chunks');
  const original = parseLocmafTrackContext(initData);
  const init = Uint8Array.from(initData);
  const moov = one(init, 0, init.length, 'moov');
  const trak = one(init, moov.contentStart, moov.end, 'trak');
  assert.ok(!childBoxes(init, trak.contentStart, trak.end, 'fixture').some(box => box.type === 'tref'),
    'fixture track references are unsupported');
  const tkhd = one(init, trak.contentStart, trak.end, 'tkhd');
  const mvex = one(init, moov.contentStart, moov.end, 'mvex');
  const trex = one(init, mvex.contentStart, mvex.end, 'trex');
  const replace = (bytes: Uint8Array, offset: number) => {
    assert.equal(viewOf(bytes).getUint32(offset), original.trackId, 'inconsistent fixture track ID');
    viewOf(bytes).setUint32(offset, trackId);
  };
  replace(init, field(init, tkhd, init[tkhd.contentStart] === 1 ? 20 : 12, [0, 1]));
  replace(init, field(init, trex, 4));
  const movies = childBoxes(init, moov.contentStart, moov.end, 'fixture').filter(box => box.type === 'mvhd');
  assert.ok(movies.length <= 1, 'duplicate mvhd');
  if (movies[0]) {
    const movie = movies[0];
    const nextId = field(init, movie, init[movie.contentStart] === 1 ? 108 : 96, [0, 1]);
    viewOf(init).setUint32(nextId, Math.max(viewOf(init).getUint32(nextId), trackId + 1));
  }
  const context = parseLocmafTrackContext(init);
  assert.deepEqual(context, { ...original, trackId }, 'rewritten init read-back differs');
  const rewritten = chunks.map(chunk => {
    const before = parseCmafChunk(chunk, original);
    assert.ok(before.fits, 'unsupported original fixture chunk');
    const bytes = Uint8Array.from(chunk);
    const moof = one(bytes, 0, bytes.length, 'moof');
    const traf = one(bytes, moof.contentStart, moof.end, 'traf');
    const tfhd = one(bytes, traf.contentStart, traf.end, 'tfhd');
    replace(bytes, field(bytes, tfhd, 4));
    for (const sidx of childBoxes(bytes, 0, bytes.length, 'fixture').filter(box => box.type === 'sidx')) {
      replace(bytes, field(bytes, sidx, 4, [0, 1]));
    }
    const after = parseCmafChunk(bytes, context);
    assert.ok(after.fits, 'rewritten fixture chunk read-back failed');
    assert.deepEqual(after.effective, before.effective, 'rewrite changed sample timing');
    assert.equal(Buffer.compare(after.mdat, before.mdat), 0, 'rewrite changed coded media');
    return bytes;
  });
  return { initData: init, chunks: rewritten, context: { trackId: context.trackId, timescale: context.timescale } };
}
