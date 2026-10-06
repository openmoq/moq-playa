import { concat, isoBox, u32, u64 } from '../../locmaf/test-support/bytes.js';

/** Structurally invalid rawBoxes that still begin with an apparent CMAF Header. */
export function malformedRawInits(init: Uint8Array): Array<[string, Uint8Array]> {
  const ftypSize = new DataView(init.buffer, init.byteOffset, init.byteLength).getUint32(0);
  return [
    ['trailing byte', concat(init, Uint8Array.of(42))],
    ['truncated trailing header', concat(init, u32(8))],
    ['oversized trailing box', concat(init, u32(16), isoBox('free').subarray(4))],
    ['size zero', concat(u32(0), init.subarray(4))],
    ['largesize before moov', concat(u32(1), init.subarray(4, 8), u64(BigInt(ftypSize + 8)), init.subarray(8))],
    ['largesize after moov', concat(init, u32(1), isoBox('free').subarray(4), u64(16n))],
  ];
}
