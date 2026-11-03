import { describe, expect, it } from 'vitest';
import { buildBox, readBaseMediaDecodeTime, readFirstSamplePresentationTime, writeU32 } from './mp4-box.js';
import { ascii, concat, fullBox, i32, u16, u32, u64 } from '../../locmaf/test-support/bytes.js';

const tfhd = (flags = 0x020000, fields: Uint8Array = new Uint8Array()) => fullBox('tfhd', 0, flags, u32(1), fields);
const tfdt = (time = 90_000n, version = 1, flags = 0) => fullBox('tfdt', version, flags,
  version === 0 ? u32(Number(time)) : u64(time));
const moof = (...children: Uint8Array[]) => buildBox('moof', [buildBox('traf', children)]);
function trun(flags = 0, version = 0, offsets = [0]): Uint8Array {
  const fields: Uint8Array[] = [u32(offsets.length)];
  if (flags & 1) fields.push(i32(-80));
  if (flags & 4) fields.push(u32(0x02000000));
  for (const offset of offsets) {
    if (flags & 0x100) fields.push(u32(960));
    if (flags & 0x200) fields.push(u32(24));
    if (flags & 0x400) fields.push(u32(0x02000000));
    if (flags & 0x800) fields.push(version === 1 ? i32(offset) : u32(offset));
  }
  return fullBox('trun', version, flags, ...fields);
}
const fragment = (run = trun(), time = tfdt(), header = tfhd()) => moof(header, time, run);

describe('first raw sample presentation time', () => {
  it.each([0, 1])('reads tfdt version %s without inventing a composition offset', version => {
    expect(readFirstSamplePresentationTime(fragment(trun(), tfdt(0n, version)))).toBe(0n);
    expect(readFirstSamplePresentationTime(fragment(trun(), tfdt(90_000n, version)))).toBe(90_000n);
  });

  it.each([
    [0, 0xffffffff, 90_000n + 0xffffffffn],
    [1, -2_000, 88_000n],
    [1, -0x80000000, 90_000n - 0x80000000n],
    [1, 0x7fffffff, 90_000n + 0x7fffffffn],
  ] as const)('uses version %s signedness for CTO %s', (version, offset, expected) => {
    expect(readFirstSamplePresentationTime(fragment(trun(0x800, version, [offset])))).toBe(expected);
  });

  const layouts = Array.from({ length: 64 }, (_, bits) =>
    [1, 4, 0x100, 0x200, 0x400, 0x800].reduce((flags, flag, index) => flags | (bits & (1 << index) ? flag : 0), 0))
    .filter(flags => !((flags & 4) && (flags & 0x400)));
  it.each(layouts)('locates the first CTO with trun optional fields 0x%s', flags => {
    const expected = flags & 0x800 ? 90_007n : 90_000n;
    expect(readFirstSamplePresentationTime(fragment(trun(flags, 1, [7, -1000])))).toBe(expected);
  });

  it('retains bigint precision, input bytes, and the existing decode-time reader', () => {
    const time = (1n << 60n) + 123n, bytes = fragment(trun(0x800, 1, [-7]), tfdt(time)), before = bytes.slice();
    expect(readFirstSamplePresentationTime(bytes)).toBe(time - 7n);
    expect(readBaseMediaDecodeTime(bytes)).toBe(time);
    expect(bytes).toEqual(before);
    const backing = concat(u32(0), bytes, u32(0));
    expect(readFirstSamplePresentationTime(backing.subarray(4, backing.length - 4))).toBe(time - 7n);
  });

  it('accepts a styp/sidx prefix before one moof', () => {
    const media = buildBox('moof', [fullBox('mfhd', 0, 0, u32(1)),
      buildBox('traf', [tfhd(), tfdt(), trun(0x800, 1, [-20])])]);
    const bytes = concat(buildBox('styp', [ascii('msdh'), u32(0), ascii('msdh')]),
      fullBox('sidx', 0, 0, u32(1), u32(1000), u32(0), u32(0), u16(0), u16(1),
        u32(media.byteLength), u32(20), u32(0x90000000)), media);
    expect(readFirstSamplePresentationTime(bytes)).toBe(89_980n);
  });

  it('does not confuse tfhd defaults with trun sample fields', () => {
    const header = tfhd(0x3b, concat(u64(123n), u32(1), u32(960), u32(24), u32(0x02000000)));
    expect(readFirstSamplePresentationTime(fragment(trun(0x805, 1, [7]), tfdt(), header))).toBe(90_007n);
  });

  it('uses the first sample rather than a later run or minimum presentation time', () => {
    expect(readFirstSamplePresentationTime(moof(tfhd(), tfdt(), trun(0x800, 1, [20, -1000]),
      trun(0x800, 1, [-2000])))).toBe(90_020n);
    expect(readFirstSamplePresentationTime(moof(tfhd(), tfdt(), trun(0, 0, []), trun(0x800, 1, [9])))).toBe(90_009n);
  });

  const malformed: Array<[string, () => Uint8Array]> = [
    ['empty input', () => new Uint8Array()],
    ['no moof', () => buildBox('free', [])],
    ['no traf', () => buildBox('moof', [])],
    ['two moofs', () => concat(fragment(), fragment())],
    ['two trafs', () => buildBox('moof', [buildBox('traf', [tfhd(), tfdt(), trun()]), buildBox('traf', [])])],
    ['missing tfhd', () => moof(tfdt(), trun())],
    ['duplicate tfhd', () => moof(tfhd(), tfhd(), tfdt(), trun())],
    ['missing tfdt', () => moof(tfhd(), trun())],
    ['duplicate tfdt', () => moof(tfhd(), tfdt(), tfdt(), trun())],
    ['missing trun', () => moof(tfhd(), tfdt())],
    ['no samples', () => fragment(trun(0, 0, []))],
    ['unknown tfdt version', () => fragment(trun(), tfdt(90_000n, 2))],
    ['nonzero tfdt flags', () => fragment(trun(), tfdt(90_000n, 1, 1))],
    ['short tfdt', () => fragment(trun(), fullBox('tfdt', 1, 0, u32(90_000)))],
    ['unknown trun version', () => fragment(trun(0, 2))],
    ['unknown trun flags', () => fragment(trun(2))],
    ['conflicting sample flags', () => fragment(trun(0x404))],
    ['truncated sample table', () => fragment(fullBox('trun', 1, 0x800, u32(2), i32(7)))],
    ['short optional run fields', () => fragment(fullBox('trun', 0, 5, u32(1), u32(0)))],
    ['trailing run bytes', () => fragment(fullBox('trun', 0, 0, u32(1), u32(7)))],
    ['huge truncated sample count', () => fragment(fullBox('trun', 0, 0x100, u32(0xffffffff), u32(1)))],
    ['unknown tfhd version', () => fragment(trun(), tfdt(), fullBox('tfhd', 1, 0, u32(1)))],
    ['unknown tfhd flags', () => fragment(trun(), tfdt(), tfhd(4))],
    ['truncated tfhd defaults', () => fragment(trun(), tfdt(), tfhd(0x38, u32(1)))],
    ['empty-duration traf with samples', () => fragment(trun(), tfdt(), tfhd(0x010000))],
    ['zero track id', () => fragment(trun(), tfdt(), fullBox('tfhd', 0, 0, u32(0)))],
    ['invalid later run', () => moof(tfhd(), tfdt(), trun(), fullBox('trun', 1, 0x800, u32(1)))],
    ['partial outer header', () => concat(fragment(), Uint8Array.of(1, 2, 3))],
    ['partial child header', () => buildBox('moof', [buildBox('traf', [tfhd(), tfdt(), trun(), Uint8Array.of(1, 2, 3)])])],
    ['oversized moof', () => { const bytes = fragment(); writeU32(bytes, 0, bytes.length + 1); return bytes; }],
    ['oversized traf', () => { const bytes = fragment(); writeU32(bytes, 8, bytes.length); return bytes; }],
    ['truncated backing bytes', () => fragment().subarray(0, fragment().length - 1)],
  ];
  it.each(malformed)('returns null for %s without throwing', (_label, bytes) => {
    expect(readFirstSamplePresentationTime(bytes())).toBeNull();
  });
});
