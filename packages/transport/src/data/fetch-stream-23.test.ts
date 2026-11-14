/**
 * draft-23 FETCH stream serialization (§11.4): the +2 Object ID Delta, delta
 * coded End of Range, End of Gone Range, End of Group and End of Track.
 */
import { describe, it, expect } from 'vitest';
import { decodeFetchObject18, type FetchObjectPrior18 } from './decoder-18.js';
import { encodeFetchObject18, encodeFetchEndOfRange18, encodeFetchEndMarker23, type FetchObjectFields } from './encoder-18.js';
import type { DecodedFetchItem } from './decoder.js';
import type { FetchEndMarker, FetchEndOfRange, FetchObject, FetchRangeKind, GroupOrder } from './types.js';
import { ProtocolViolationError } from '../errors.js';
import { MAX_VI64 } from '../primitives/vi64.js';
import { bytesToHex, hexToBytes } from '../vectors/load-vectors.js';

const obj = (groupId: bigint, objectId: bigint): FetchObjectFields => ({
  groupId, subgroupId: 0n, objectId, publisherPriority: 0x80, payload: new Uint8Array([0xaa]),
});

type Entry =
  | { readonly object: FetchObjectFields }
  | { readonly range: FetchRangeKind; readonly groupId: bigint; readonly objectId: bigint }
  | { readonly marker: FetchEndMarker['marker'] };

/** Encode `entries` as a draft-23 FETCH stream body (after the FETCH_HEADER). */
function encode(entries: readonly Entry[], order: GroupOrder = 'ascending'): Uint8Array {
  const parts: Uint8Array[] = [];
  let prior: FetchObjectPrior18 | undefined;
  for (const e of entries) {
    const r = 'object' in e
      ? encodeFetchObject18(e.object, prior, prior === undefined, order, 23)
      : 'range' in e
        ? encodeFetchEndOfRange18(e.range, e.groupId, e.objectId, prior, 23, order)
        : encodeFetchEndMarker23(e.marker, prior);
    parts.push(r.bytes);
    prior = r.nextPrior;
  }
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
}

/** Decode a whole FETCH stream body. */
function decode(buf: Uint8Array, order: GroupOrder = 'ascending', version: 22 | 23 = 23): DecodedFetchItem[] {
  const items: DecodedFetchItem[] = [];
  let prior: FetchObjectPrior18 | undefined;
  let p = 0;
  while (p < buf.length) {
    const r = decodeFetchObject18(buf, p, prior, items.length === 0, order, version);
    items.push(r.item);
    prior = r.nextPrior;
    p += r.bytesRead;
  }
  return items;
}

const at = (item: DecodedFetchItem) => [item.groupId, item.objectId];

function failureCode(fn: () => unknown): number | undefined {
  try { fn(); } catch (err) {
    if (err instanceof ProtocolViolationError) return err.code;
    throw err;
  }
  throw new Error('did not throw');
}

describe('draft-23 FETCH Object ID Delta (§11.4.1.1)', () => {
  it('is prior + delta + 2 within a Group; the next Object omits the delta', () => {
    const bytes = encode([{ object: obj(1n, 0n) }, { object: obj(1n, 3n) }, { object: obj(1n, 4n) }]);
    // flags 0x1F + group 1 + subgroup 0 + object 0, then 0x17 (delta 1 = 3 - 0 - 2), then 0x13 (no delta)
    expect(bytesToHex(bytes)).toBe('1f0100008001aa' + '1700018001aa' + '13008001aa');
    expect(decode(bytes).map(at)).toEqual([[1n, 0n], [1n, 3n], [1n, 4n]]);
  });

  it('decodes the same bytes differently from draft 22', () => {
    const bytes = hexToBytes('1f0100008001aa' + '1700018001aa');
    expect(decode(bytes, 'ascending', 22).map(at)).toEqual([[1n, 0n], [1n, 1n]]);
    expect(decode(bytes, 'ascending', 23).map(at)).toEqual([[1n, 0n], [1n, 3n]]);
  });
});

describe('draft-23 End of Range (§11.4.2)', () => {
  it('is absolute as the first entry', () => {
    const bytes = encode([{ range: 'unknown', groupId: 2n, objectId: 5n }]);
    expect(bytesToHex(bytes)).toBe('810c' + '0205');
    expect(decode(bytes).map(at)).toEqual([[2n, 5n]]);
  });

  it('a Group ID Delta of 0 is the prior Group; the Object is prior + delta + 1', () => {
    const bytes = encode([{ object: obj(2n, 3n) }, { range: 'non-existent', groupId: 2n, objectId: 7n }]);
    expect(bytesToHex(bytes.subarray(-4))).toBe('808c' + '0003');
    const items = decode(bytes);
    expect(at(items[1]!)).toEqual([2n, 7n]);
    expect((items[1] as FetchEndOfRange).kind).toBe('non-existent');
  });

  it('a non-zero Group ID Delta has no +1 and carries the absolute Object ID', () => {
    const bytes = encode([{ object: obj(2n, 3n) }, { range: 'unknown', groupId: 5n, objectId: 1n }]);
    expect(bytesToHex(bytes.subarray(-4))).toBe('810c' + '0301');
    expect(at(decode(bytes)[1]!)).toEqual([5n, 1n]);
  });

  it('steps backwards in Descending Group Order', () => {
    const entries: Entry[] = [{ object: obj(5n, 0n) }, { range: 'unknown', groupId: 3n, objectId: 2n }, { object: obj(2n, 0n) }];
    const items = decode(encode(entries, 'descending'), 'descending');
    expect(items.map(at)).toEqual([[5n, 0n], [3n, 2n], [2n, 0n]]);
  });

  it('a following Object takes its prior Location from the End of Range', () => {
    const entries: Entry[] = [
      { object: obj(1n, 0n) },
      { range: 'timed-out', groupId: 1n, objectId: 4n },
      { object: obj(1n, 5n) },
      { range: 'unknown', groupId: 1n, objectId: 9n },
      { range: 'non-existent', groupId: 3n, objectId: 0n },
      { object: obj(4n, 2n) },
    ];
    expect(decode(encode(entries)).map(at)).toEqual([[1n, 0n], [1n, 4n], [1n, 5n], [1n, 9n], [3n, 0n], [4n, 2n]]);
  });

  it('End of Gone Range (0x40C) exists only on draft 23', () => {
    const bytes = encode([{ range: 'gone', groupId: 0n, objectId: 9n }]);
    expect(bytesToHex(bytes)).toBe('840c' + '0009');
    const item = decode(bytes)[0] as FetchEndOfRange;
    expect(item).toMatchObject({ kind: 'gone', nonExistent: false });
    expect(failureCode(() => decode(bytes, 'ascending', 22))).toBe(0x201);
    expect(() => encodeFetchEndOfRange18('gone', 0n, 9n, undefined, 22)).toThrow(/no gone/);
  });

  it('a Location past 2^64-1 is DELTA_ENCODING_OVERFLOW', () => {
    // prior Object (0, 2^64-2); End of Range with Group ID Delta 0, Object ID Delta 1
    const first = encodeFetchObject18(obj(0n, MAX_VI64 - 1n), undefined, true, 'ascending', 23);
    const bytes = new Uint8Array([...first.bytes, 0x81, 0x0c, 0x00, 0x01]);
    expect(failureCode(() => decode(bytes))).toBe(0x400);
  });
});

describe('draft-23 End of Group and End of Track (§11.4.2.2)', () => {
  it('carry no fields and locate the prior Object', () => {
    const bytes = encode([{ object: obj(1n, 0n) }, { marker: 'end-of-group' }, { object: obj(2n, 0n) }, { marker: 'end-of-track' }]);
    expect(bytesToHex(bytes)).toBe('1f0100008001aa' + '8080' + '1f0000008001aa' + '8081');
    const items = decode(bytes);
    expect(items[1]).toMatchObject({ marker: 'end-of-group', groupId: 1n, objectId: 0n });
    expect(items[3]).toMatchObject({ marker: 'end-of-track', groupId: 2n, objectId: 0n });
    expect(items[2] as FetchObject).toMatchObject({ groupId: 2n, objectId: 0n });
  });

  it('the next entry must start a new Group', () => {
    const bytes = new Uint8Array([...encode([{ object: obj(1n, 0n) }, { marker: 'end-of-group' }]), 0x13, 0x00, 0x80, 0x01, 0xaa]);
    expect(failureCode(() => decode(bytes))).toBe(0x400);
    expect(() => encode([{ object: obj(1n, 0n) }, { marker: 'end-of-group' }, { object: obj(1n, 1n) }])).toThrow();
  });

  it('as the first entry is MALFORMED_OBJECT', () => {
    expect(failureCode(() => decode(hexToBytes('8080')))).toBe(0x201);
  });

  it('are not markers before draft 23', () => {
    expect(failureCode(() => decode(hexToBytes('1f0100008001aa' + '8080'), 'ascending', 22))).toBe(0x201);
  });
});

describe('draft-23 Serialization Flags (§11.4.1)', () => {
  it('any other value above 127 is MALFORMED_OBJECT', () => {
    expect(failureCode(() => decode(hexToBytes('8090')))).toBe(0x201);
  });

  it('a first Object that references the prior Object is MALFORMED_OBJECT', () => {
    expect(failureCode(() => decode(hexToBytes('13008001aa')))).toBe(0x201);
  });
});
