import { describe, expect, it } from 'vitest';
import { LocmafFrameReader, LocmafFrameReadError } from './frame-reader.js';
import { LocmafEncoder } from './encoder.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafFormatError } from './errors.js';
import { parseLocmafTrackContext } from './track-context.js';
import { serializeLocmafObject } from './serializer.js';
import { buildChunk, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../test-support/cmaf.js';
const limits = {maxGroups: 2, maxSamples: 8, maxEntries: 4096, maxBytes: 100000};
function packets() {
  const context = parseLocmafTrackContext(videoInit()), encoder = new LocmafEncoder(), state = new LocmafGroupState();
  return [0n, 1n].map(id => serializeLocmafObject(encoder.encode(buildChunk({bmdt: id * 3000n,
    samples: [{duration: 3000,size: 1,flags: id === 0n ? SYNC_FLAGS : NON_SYNC_FLAGS}], mdat: Uint8Array.of(42)}),state,context,false,id)));
}

describe('committed live LOCMAF frame inputs', () => {
  it('rejects stale copies without losing a successfully reconstructed delta reference', () => {
    const [full,delta] = packets(), reader = new LocmafFrameReader(videoInit(),limits,'committed');
    reader.push(3n,0n,full!);
    expect(() => reader.push(3n,0n,full!)).toThrow(LocmafFrameReadError);
    expect(reader.push(3n,1n,delta!)).toMatchObject({kind:'batch',continuity:'contiguous',units:[{decodeTime:3000n}]});
  });
  it('failed far-future attempts retain the committed frontier while still destroying the reference', () => {
    const [full,delta] = packets(), reader = new LocmafFrameReader(videoInit(),limits,'committed');
    reader.push(3n,0n,full!);
    expect(() => reader.push(3n,99n,delta!)).toThrow(LocmafFormatError);
    expect(() => reader.push(3n,1n,delta!)).toThrow(LocmafFormatError);
    expect(reader.push(3n,1n,full!)).toMatchObject({kind:'batch',continuity:'gap',location:{objectId:1n}});
  });
  it('an explicit native Group reset starts fresh input admission without preserving a delta reference', () => {
    const [full,delta] = packets(), reader = new LocmafFrameReader(videoInit(),limits,'committed');
    reader.push(3n,0n,full!); reader.push(4n,0n,full!); reader.resetGroup(3n);
    expect(() => reader.push(3n,1n,delta!)).toThrow(LocmafFormatError);
    expect(reader.push(4n,1n,delta!)).toMatchObject({kind:'batch',continuity:'contiguous'});
    expect(reader.push(3n,0n,full!)).toMatchObject({kind:'batch',continuity:'first'});
    expect(reader.retainedUsage.groups).toBe(2);
  });
  it('default attempted readers preserve their stricter existing replay/reset semantics', () => {
    const [full,delta] = packets(), reader = new LocmafFrameReader(videoInit(),limits);
    reader.push(3n,0n,full!);
    expect(() => reader.push(3n,0n,full!)).toThrow(LocmafFrameReadError);
    expect(() => reader.push(3n,1n,delta!)).toThrow(LocmafFormatError);
    reader.resetGroup(3n);
    expect(() => reader.push(3n,0n,full!)).toThrow(LocmafFrameReadError);
  });
});
