/**
 * Deterministic BMFF regressions — minimized inputs the fuzz lane discovered (or
 * would discover once its generator reaches the deep nested paths). Each pins a
 * totality-contract violation that was fixed narrowly in the owning parser
 * (`packages/browser/src/mp4-box.ts`).
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { runBmff } from '../bmff-exec.js';

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

describe('BMFF regression — truncated tfdt in a valid nested skeleton (peek must not throw)', () => {
  // moof(24) { traf(16) { tfdt(8) } } — the tfdt declares size 8 (header only), so
  // it has no version byte and no baseMediaDecodeTime. peekSegmentMetadata walked
  // moof→traf→tfdt and read the value past the DataView →
  //   RangeError: Offset is outside the bounds of the DataView
  // The fix bounds-checks the version byte and the value read, returning bmd:null.
  const INPUT = '000000186d6f6f6600000010747261660000000874666474';

  it('peek returns a total (null) result instead of throwing', () => {
    const bytes = hexToBytes(INPUT);
    const before = bytes.slice();
    const r = runBmff(bytes, 'peek');
    expect(r).toEqual({ status: 'ok', semantics: { bmd: null, mdatSize: null } });
    // and it does not mutate the input
    expect(bytes).toEqual(before);
  });

  it('trex and timeRanges are likewise total on the same input', () => {
    const bytes = hexToBytes(INPUT);
    expect(runBmff(bytes, 'trex')).toEqual({ status: 'ok', semantics: { trex: [] } });
    expect(runBmff(bytes, 'timeRanges')).toEqual({ status: 'ok', semantics: { ranges: null } });
  });

  it('a v1 tfdt truncated mid-value is also total (peek → bmd:null)', () => {
    // moof { traf { tfdt(size 14): version=1, flags=0, only 2 of 8 value bytes } }
    const tfdt = '0000000e74666474' + '01000000' + '0102'; // size 14, v1, 2 value bytes
    const traf = '0000001674726166' + tfdt; // traf size = 8 + 14 = 22 = 0x16
    const moof = '0000001e6d6f6f66' + traf; // moof size = 8 + 22 = 30 = 0x1e
    const bytes = hexToBytes(moof);
    const r = runBmff(bytes, 'peek');
    expect(r.status).toBe('ok');
    expect((r as { semantics: { bmd: unknown } }).semantics.bmd).toBeNull();
  });
});

describe('BMFF regression — trex declaring size 32 in a truncated moov→mvex→trex (trex/timeRanges must not throw)', () => {
  // moov(48) { mvex(40) { trex(32) } } but the buffer is only 24 bytes — the trex
  // header is present but its 24-byte body is absent. readTrexDefaults built a
  // DataView of the DECLARED size 32 over an 8-byte tail →
  //   RangeError: Invalid DataView length 32
  // The fix requires the 32 accessed bytes to actually be present and bounds the
  // DataView to 32 (not the declared size).
  const INPUT = '000000306d6f6f76000000286d7665780000002074726578';

  it('trex returns an empty map / timeRanges is total on the same input', () => {
    const bytes = hexToBytes(INPUT);
    const before = bytes.slice();
    expect(runBmff(bytes, 'trex')).toEqual({ status: 'ok', semantics: { trex: [] } });
    // A moov (init) with no moof yields an empty (not null) range list.
    expect(runBmff(bytes, 'timeRanges')).toEqual({ status: 'ok', semantics: { ranges: [] } });
    expect(runBmff(bytes, 'peek')).toEqual({ status: 'ok', semantics: { bmd: null, mdatSize: null } });
    expect(bytes).toEqual(before);
  });
});

describe('BMFF regression — a box must not read into a SIBLING (containment, not just buffer bounds)', () => {
  it('a header-only tfdt followed by a `free` sibling → bmd is null, not the free box bytes', () => {
    // moof { traf { tfdt(size 8, header-only), free(size 20) } }. The old
    // buffer-only bounds let readBaseMediaDecodeTime read tfdt.offset+12 — which
    // lands in the `free` box — returning 1718773093n ("free" as a u32). The
    // declared-size + containment check makes it null.
    const bytes = hexToBytes('0000002c6d6f6f66000000247472616600000008746664740000001466726565000000000000000000000000');
    expect(runBmff(bytes, 'peek')).toEqual({ status: 'ok', semantics: { bmd: null, mdatSize: null } });
  });

  it('a trex declaring size past its mvex → no fabricated trackId from the following `free`', () => {
    // moov { mvex(holds only the trex header) trex(declares 32) } free{...}. The
    // old `tpos+32 <= input.length` check passed (the free sibling supplied the
    // bytes), fabricating trackId/duration/flags. mvex containment rejects it.
    const bytes = hexToBytes('000000306d6f6f76000000106d766578000000207472657800000018667265650102030405060708090a0b0c0d0e0f10');
    expect(runBmff(bytes, 'trex')).toEqual({ status: 'ok', semantics: { trex: [] } });
  });

  it('a TOP-LEVEL moof declaring more bytes than present is rejected (not read from truncated content)', () => {
    // Same moof→traf→tfdt(v0, value=123). Honest (declared size 32) reads 123;
    // a moof declaring 96 while only 32 are present is truncated → bmd:null.
    const honest = hexToBytes('000000206d6f6f6600000018747261660000001074666474000000000000007b');
    expect(runBmff(honest, 'peek')).toEqual({ status: 'ok', semantics: { bmd: '123', mdatSize: null } });
    const overrun = hexToBytes('000000606d6f6f6600000018747261660000001074666474000000000000007b');
    expect(runBmff(overrun, 'peek')).toEqual({ status: 'ok', semantics: { bmd: null, mdatSize: null } });
  });
});
