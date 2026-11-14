/**
 * Differential tests: each object header parser against its complete-object
 * decoder, on the same bytes and the same uncommitted decoder state.
 *
 * At every prefix length of every input:
 * - decoder succeeds  -> header succeeds, agrees on kind, identity, declared
 *   length, Object Status, property bytes and next-prior state, and
 *   headerBytes + payload length accounts for every consumed byte;
 * - decoder needs more bytes -> the header is incomplete too, or it is complete
 *   and its declared payload extends past the buffer;
 * - decoder raises anything else -> the header raises the same class and message.
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeSubgroupObject,
  decodeSubgroupObjectHeader,
  decodeFetchObject,
  decodeFetchObjectHeader,
  decodeFetchObjectV14,
  decodeFetchObjectHeaderV14,
  type FetchPriorContext,
  type DecodedFetchItem,
} from './decoder.js';
import {
  decodeSubgroupObject18,
  decodeSubgroupObjectHeader18,
  decodeFetchObject18,
  decodeFetchObjectHeader18,
  type FetchObjectPrior18,
} from './decoder-18.js';
import { encodeSubgroupObject } from './encoder.js';
import { encodeSubgroupObject18, encodeFetchObject18, encodeFetchEndOfRange18, encodeFetchEndMarker23 } from './encoder-18.js';
import type { GroupOrder, ObjectHeaderLayout, SubgroupObject } from './types.js';
import { writeVarint, varint } from '../primitives/varint.js';
import { writeVi64, vi64EncodingLength } from '../primitives/vi64.js';
import { fc, fcParams, fuzzBytes, vi64Value, varintValue, priorityByte, bytes, toHex } from '../testkit/arbitraries.js';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function attempt<T>(fn: () => T): Outcome<T> {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error }; }
}

/** What a complete decode produced, normalized across decoder families. */
interface Decoded {
  readonly kind: 'object' | 'range';
  readonly bytesRead: number;
  readonly payload: Uint8Array | null;
  readonly status: bigint | undefined;
  readonly extensions: Uint8Array | undefined;
  readonly groupId: bigint | undefined;
  readonly subgroupId: bigint | undefined;
  readonly objectId: bigint;
  readonly publisherPriority: number | undefined;
  readonly isDatagram: boolean;
  readonly nextPrior?: FetchObjectPrior18;
  /** The decoder's item omits priority and properties (draft-14 status Objects); compare only what it carries. */
  readonly itemOmitsFields?: true;
}

function fromSubgroup(r: { object: SubgroupObject; bytesRead: number }): Decoded {
  return {
    kind: 'object', bytesRead: r.bytesRead, payload: r.object.payload, status: r.object.status,
    extensions: r.object.extensions, groupId: undefined, subgroupId: undefined, objectId: r.object.objectId,
    publisherPriority: undefined, isDatagram: false,
  };
}

function fromFetch(r: { item: DecodedFetchItem; bytesRead: number; nextPrior?: FetchObjectPrior18 }): Decoded {
  const { item } = r;
  if ('payload' in item) {
    return {
      kind: 'object', bytesRead: r.bytesRead, payload: item.payload, status: undefined, extensions: item.extensions,
      groupId: item.groupId, subgroupId: item.subgroupId, objectId: item.objectId,
      publisherPriority: item.publisherPriority, isDatagram: item.isDatagram,
      ...(r.nextPrior ? { nextPrior: r.nextPrior } : {}),
    };
  }
  // A draft-14 status Object is returned as an end-of-range item carrying its
  // raw status; a draft-16/18/22/23 End-of-Range, and a draft-23 End of Group or
  // End of Track marker, have no raw status.
  const rawStatus = 'rawStatus' in item ? item.rawStatus : undefined;
  return {
    kind: rawStatus !== undefined ? 'object' : 'range', bytesRead: r.bytesRead, payload: null,
    status: rawStatus, extensions: undefined, groupId: item.groupId, subgroupId: undefined,
    objectId: item.objectId, publisherPriority: undefined, isDatagram: false,
    ...(r.nextPrior ? { nextPrior: r.nextPrior } : {}),
    ...(rawStatus !== undefined ? { itemOmitsFields: true as const } : {}),
  };
}

function propertyBytes(buf: Uint8Array, layout: ObjectHeaderLayout): Uint8Array | undefined {
  return layout.propertiesOffset === undefined
    ? undefined
    : buf.slice(layout.propertiesOffset, layout.propertiesOffset + layout.propertiesLength);
}

/** The header must agree with the decoder for this exact buffer, offset and state. */
function agree(
  label: string,
  buf: Uint8Array,
  offset: number,
  decode: () => Decoded,
  header: () => ObjectHeaderLayout & { nextPrior?: FetchObjectPrior18 },
  /** draft-14 FETCH and draft-14/16 subgroup objects carry no header-level subgroup identity of their own. */
  headerSupplies: { subgroupId: boolean } = { subgroupId: true },
): void {
  const where = `${label} @${offset} len=${buf.length} 0x${toHex(buf)}`;
  const d = attempt(decode);
  const h = attempt(header);
  if (d.ok) {
    expect(h.ok, `${where}: header parses wherever the decoder succeeds`).toBe(true);
    if (!h.ok) return;
    const layout = h.value, item = d.value;
    expect(layout.kind, where).toBe(item.kind);
    expect(layout.objectId, where).toBe(item.objectId);
    expect(layout.groupId, where).toBe(item.groupId);
    if (headerSupplies.subgroupId) expect(layout.subgroupId, where).toBe(item.subgroupId);
    expect(layout.objectStatus, where).toBe(item.status);
    if (item.kind === 'object' && !item.itemOmitsFields) {
      expect(layout.publisherPriority, where).toBe(item.publisherPriority);
      expect(layout.isDatagram, where).toBe(item.isDatagram);
      expect(propertyBytes(buf, layout), where).toEqual(item.extensions);
      expect(layout.payloadLength, where).toBe(BigInt(item.payload?.length ?? 0));
    }
    if (item.itemOmitsFields) expect(layout.payloadLength, where).toBe(0n);
    // Every consumed byte is header or declared payload.
    expect(BigInt(layout.headerBytes) + layout.payloadLength, where).toBe(BigInt(item.bytesRead));
    if (item.nextPrior !== undefined) expect(layout.nextPrior, where).toEqual(item.nextPrior);
    return;
  }
  if (d.error instanceof RangeError) {
    if (h.ok) {
      const end = BigInt(offset + h.value.headerBytes) + h.value.payloadLength;
      expect(end > BigInt(buf.length), `${where}: a complete header with a short payload is the only other outcome`).toBe(true);
    } else {
      expect(h.error, `${where}: header incomplete exactly when the decoder's header is`).toBeInstanceOf(RangeError);
    }
    return;
  }
  expect(h.ok, `${where}: the decoder's violation is a header violation`).toBe(false);
  if (h.ok) return;
  expect((h.error as Error).constructor, where).toBe((d.error as Error).constructor);
  expect((h.error as Error).message, where).toBe((d.error as Error).message);
}

/** Check every prefix, including the empty one and the whole buffer. */
function everyPrefix(buf: Uint8Array, check: (prefix: Uint8Array) => void): void {
  for (let n = 0; n <= buf.length; n++) check(buf.subarray(0, n));
}

const aBigInt = vi64Value;
const optionalPriority = fc.option(priorityByte, { nil: undefined });
const fetchPrior16: fc.Arbitrary<FetchPriorContext | undefined> = fc.option(
  fc.record({ groupId: varintValue, subgroupId: varintValue, objectId: varintValue, priority: optionalPriority })
    .map(({ priority, ...rest }): FetchPriorContext => (priority === undefined ? rest : { ...rest, priority })),
  { nil: undefined },
);
const fetchPrior18: fc.Arbitrary<FetchObjectPrior18 | undefined> = fc.option(
  fc.record({
    groupId: aBigInt,
    objectId: aBigInt,
    lastObjectSubgroupId: fc.option(aBigInt, { nil: undefined }),
    lastObjectPriority: optionalPriority,
  }),
  { nil: undefined },
);
const groupOrder: fc.Arbitrary<GroupOrder> = fc.constantFrom('ascending', 'descending');

describe('object header parsers agree with complete decoders on arbitrary bytes', () => {
  it('draft-14/16 subgroup objects', () => {
    fc.assert(fc.property(
      fuzzBytes, fc.integer({ min: 0, max: 3 }), fc.boolean(), varintValue, fc.boolean(), fc.constantFrom(14 as const, 16 as const),
      (raw, offset, hasExtensions, previous, isFirst, version) => {
        everyPrefix(raw, prefix => {
          if (offset > prefix.length) return;
          agree(`subgroup${version}`, prefix, offset,
            () => fromSubgroup(decodeSubgroupObject(prefix, offset, hasExtensions, previous, isFirst, version)),
            () => decodeSubgroupObjectHeader(prefix, offset, hasExtensions, previous, isFirst, version),
            { subgroupId: false });
        });
      },
    ), fcParams());
  });

  it('draft-16 FETCH items', () => {
    fc.assert(fc.property(fuzzBytes, fc.integer({ min: 0, max: 3 }), fetchPrior16, fc.boolean(),
      (raw, offset, prior, isFirst) => {
        everyPrefix(raw, prefix => {
          if (offset > prefix.length) return;
          agree('fetch16', prefix, offset,
            () => fromFetch(decodeFetchObject(prefix, offset, prior, isFirst)),
            () => decodeFetchObjectHeader(prefix, offset, prior, isFirst));
        });
      },
    ), fcParams());
  });

  it('draft-14 FETCH objects', () => {
    fc.assert(fc.property(fuzzBytes, fc.integer({ min: 0, max: 3 }), (raw, offset) => {
      everyPrefix(raw, prefix => {
        if (offset > prefix.length) return;
        agree('fetch14', prefix, offset,
          () => fromFetch(decodeFetchObjectV14(prefix, offset)),
          () => decodeFetchObjectHeaderV14(prefix, offset),
          // draft-14 status Objects are delivered through an item without a Subgroup ID.
          { subgroupId: false });
      });
    }), fcParams());
  });

  it('draft-18/22 subgroup objects', () => {
    fc.assert(fc.property(fuzzBytes, fc.integer({ min: 0, max: 3 }), fc.boolean(), aBigInt, fc.boolean(),
      (raw, offset, hasProperties, previous, isFirst) => {
        everyPrefix(raw, prefix => {
          if (offset > prefix.length) return;
          agree('subgroup18', prefix, offset,
            () => fromSubgroup(decodeSubgroupObject18(prefix, offset, hasProperties, previous, isFirst)),
            () => decodeSubgroupObjectHeader18(prefix, offset, hasProperties, previous, isFirst),
            { subgroupId: false });
        });
      },
    ), fcParams());
  });

  it('draft-18/22/23 FETCH items, including the version-specific End-of-Range set', () => {
    fc.assert(fc.property(
      fuzzBytes, fc.integer({ min: 0, max: 3 }), fetchPrior18, fc.boolean(), groupOrder, fc.constantFrom(18 as const, 22 as const, 23 as const),
      (raw, offset, prior, isFirst, order, version) => {
        everyPrefix(raw, prefix => {
          if (offset > prefix.length) return;
          agree(`fetch${version}`, prefix, offset,
            () => fromFetch(decodeFetchObject18(prefix, offset, prior, isFirst, order, version)),
            () => decodeFetchObjectHeader18(prefix, offset, prior, isFirst, order, version));
        });
      },
    ), fcParams());
  });
});

// ── Valid streams: every chunk boundary inside every object, with threaded state ──

/** draft-14 FETCH object bytes (all fields always present). */
function encodeFetch14(o: { groupId: bigint; subgroupId: bigint; objectId: bigint; priority: number;
  extensions: Uint8Array; payload: Uint8Array; status?: bigint }): Uint8Array {
  const out = new Uint8Array(64 + o.extensions.length + o.payload.length);
  let p = 0;
  p += writeVarint(o.groupId, out, p); p += writeVarint(o.subgroupId, out, p); p += writeVarint(o.objectId, out, p);
  out[p++] = o.priority;
  p += writeVarint(BigInt(o.extensions.length), out, p); out.set(o.extensions, p); p += o.extensions.length;
  p += writeVarint(BigInt(o.payload.length), out, p);
  if (o.payload.length === 0) p += writeVarint(o.status ?? 0n, out, p);
  out.set(o.payload, p); p += o.payload.length;
  return out.slice(0, p);
}

/** draft-16 FETCH object bytes with explicit Group/Subgroup/Object/Priority fields. */
function encodeFetch16(o: { groupId: bigint; subgroupId: bigint; objectId: bigint; priority: number;
  extensions: Uint8Array | undefined; payload: Uint8Array }): Uint8Array {
  const flags = 0x08 | 0x04 | 0x10 | 0x03 | (o.extensions ? 0x20 : 0);
  const out = new Uint8Array(64 + (o.extensions?.length ?? 0) + o.payload.length);
  let p = 0;
  p += writeVarint(BigInt(flags), out, p);
  p += writeVarint(o.groupId, out, p); p += writeVarint(o.subgroupId, out, p); p += writeVarint(o.objectId, out, p);
  out[p++] = o.priority;
  if (o.extensions) { p += writeVarint(BigInt(o.extensions.length), out, p); out.set(o.extensions, p); p += o.extensions.length; }
  p += writeVarint(BigInt(o.payload.length), out, p);
  out.set(o.payload, p); p += o.payload.length;
  return out.slice(0, p);
}

/** draft-16 End-of-Range: flags, Group ID, Object ID, payload length (optionally non-zero, consumed and skipped). */
function encodeRange16(nonExistent: boolean, groupId: bigint, objectId: bigint, skipped: Uint8Array): Uint8Array {
  const out = new Uint8Array(32 + skipped.length);
  let p = 0;
  p += writeVarint(nonExistent ? 0x8cn : 0x10cn, out, p);
  p += writeVarint(groupId, out, p); p += writeVarint(objectId, out, p);
  p += writeVarint(BigInt(skipped.length), out, p); out.set(skipped, p); p += skipped.length;
  return out.slice(0, p);
}

/** draft-22 End of Timed-Out Range (0x20C), marker-only form. */
function encodeTimedOut22(groupId: bigint, objectId: bigint): Uint8Array {
  const out = new Uint8Array(vi64EncodingLength(0x20cn) + vi64EncodingLength(groupId) + vi64EncodingLength(objectId));
  let p = 0;
  p += writeVi64(0x20cn, out, p); p += writeVi64(groupId, out, p); p += writeVi64(objectId, out, p);
  return out;
}

const smallId = fc.bigInt({ min: 0n, max: 1000n });
const payloadBytes = fc.oneof({ weight: 1, arbitrary: fc.constant(new Uint8Array(0)) }, { weight: 4, arbitrary: bytes(40) });

describe('object header parsers agree at every chunk boundary of valid streams', () => {
  it('draft-14/16 and draft-18/22 subgroup streams, including zero-length status objects', () => {
    const object = fc.record({
      gap: fc.bigInt({ min: 0n, max: 3n }), payload: payloadBytes, status: fc.constantFrom(0n, 3n, 4n),
      extensions: fc.option(bytes(12), { nil: undefined }),
    });
    fc.assert(fc.property(fc.array(object, { minLength: 1, maxLength: 4 }), fc.boolean(), fc.constantFrom(14, 16, 18) ,
      (objects, hasExtensions, family) => {
        let previous = 0n, first = true;
        for (const o of objects) {
          const objectId = first ? o.gap : previous + o.gap + 1n;
          const status = o.payload.length === 0 ? o.status : undefined;
          // Properties are only legal on Normal objects.
          const extensions = hasExtensions ? (status !== undefined && status !== 0n ? new Uint8Array(0) : o.extensions ?? new Uint8Array(0)) : undefined;
          const sg: SubgroupObject = { objectId, payload: o.payload, status, extensions };
          const bytesOut = family === 18
            ? encodeSubgroupObject18(sg, hasExtensions, previous, first)
            : encodeSubgroupObject(sg, hasExtensions, varint(previous), first);
          const prevNow = previous, firstNow = first;
          everyPrefix(bytesOut, prefix => {
            if (family === 18) {
              agree('valid-subgroup18', prefix, 0,
                () => fromSubgroup(decodeSubgroupObject18(prefix, 0, hasExtensions, prevNow, firstNow)),
                () => decodeSubgroupObjectHeader18(prefix, 0, hasExtensions, prevNow, firstNow), { subgroupId: false });
            } else {
              const version = family as 14 | 16;
              agree(`valid-subgroup${version}`, prefix, 0,
                () => fromSubgroup(decodeSubgroupObject(prefix, 0, hasExtensions, prevNow, firstNow, version)),
                () => decodeSubgroupObjectHeader(prefix, 0, hasExtensions, prevNow, firstNow, version), { subgroupId: false });
            }
          });
          previous = objectId; first = false;
        }
      },
    ), fcParams());
  });

  it('draft-14 FETCH streams, including status Objects', () => {
    const object = fc.record({ groupId: smallId, subgroupId: smallId, objectId: smallId, priority: priorityByte,
      extensions: bytes(12), payload: payloadBytes, status: fc.constantFrom(0n, 1n, 3n, 4n) });
    fc.assert(fc.property(object, o => {
      everyPrefix(encodeFetch14(o), prefix => agree('valid-fetch14', prefix, 0,
        () => fromFetch(decodeFetchObjectV14(prefix, 0)), () => decodeFetchObjectHeaderV14(prefix, 0), { subgroupId: false }));
    }), fcParams());
  });

  it('draft-16 FETCH streams with End-of-Range markers, including a skipped non-zero marker payload', () => {
    const item = fc.oneof(
      fc.record({ kind: fc.constant('object' as const), groupId: smallId, subgroupId: smallId, objectId: smallId,
        priority: priorityByte, extensions: fc.option(bytes(12), { nil: undefined }), payload: payloadBytes }),
      fc.record({ kind: fc.constant('range' as const), nonExistent: fc.boolean(), groupId: smallId, objectId: smallId, skipped: bytes(6) }),
    );
    fc.assert(fc.property(fc.array(item, { minLength: 1, maxLength: 4 }), items => {
      let prior: FetchPriorContext | undefined, first = true;
      for (const it of items) {
        const encoded = it.kind === 'object' ? encodeFetch16(it) : encodeRange16(it.nonExistent, it.groupId, it.objectId, it.skipped);
        const priorNow = prior, firstNow = first;
        everyPrefix(encoded, prefix => agree('valid-fetch16', prefix, 0,
          () => fromFetch(decodeFetchObject(prefix, 0, priorNow, firstNow)),
          () => decodeFetchObjectHeader(prefix, 0, priorNow, firstNow)));
        if (it.kind === 'object') {
          prior = { groupId: it.groupId, subgroupId: it.subgroupId, objectId: it.objectId, priority: it.priority };
          first = false;
        }
      }
    }), fcParams());
  });

  it('draft-18/22/23 FETCH streams: threaded prior through objects and End-of-Range markers, both group orders', () => {
    const item = fc.oneof(
      { weight: 3, arbitrary: fc.record({ kind: fc.constant('object' as const), groupStep: fc.bigInt({ min: 0n, max: 2n }),
        objectStep: fc.bigInt({ min: 0n, max: 3n }), subgroupId: smallId, priority: priorityByte,
        extensions: fc.option(bytes(12), { nil: undefined }), payload: payloadBytes }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('range' as const),
        marker: fc.constantFrom('non-existent', 'unknown', 'timed-out', 'gone', 'end-of-group', 'end-of-track'),
        objectStep: fc.bigInt({ min: 1n, max: 3n }) }) },
    );
    fc.assert(fc.property(fc.array(item, { minLength: 1, maxLength: 5 }), groupOrder, fc.constantFrom(18 as const, 22 as const, 23 as const),
      (items, order, version) => {
        let prior: FetchObjectPrior18 | undefined, first = true;
        let groupId = order === 'ascending' ? 5n : 1000n, objectId = 0n;
        // After a draft-23 End of Group / End of Track the next Object starts a new Group.
        let groupEnded = false;
        for (const it of items) {
          let encoded: Uint8Array, nextPrior: FetchObjectPrior18;
          if (it.kind === 'object') {
            const step = groupEnded && it.groupStep === 0n ? 1n : it.groupStep;
            if (!first && step > 0n) { groupId = order === 'ascending' ? groupId + step : groupId - step; objectId = 0n; }
            // Draft 23's encoder requires Object IDs to increase within a Group.
            else if (!first) objectId += version === 23 && it.objectStep === 0n ? 1n : it.objectStep;
            groupEnded = false;
            ({ bytes: encoded, nextPrior } = encodeFetchObject18({ groupId, subgroupId: it.subgroupId, objectId,
              publisherPriority: it.priority, extensions: it.extensions, payload: it.payload }, prior, first, order, version));
          } else {
            if (first || groupEnded) continue; // a stream begins with an Object; a marker follows one
            if (it.marker === 'end-of-group' || it.marker === 'end-of-track') {
              if (version !== 23) continue;
              ({ bytes: encoded, nextPrior } = encodeFetchEndMarker23(it.marker, prior));
              groupEnded = true;
            } else {
              if (it.marker === 'gone' && version !== 23) continue;
              objectId += it.objectStep;
              if (it.marker === 'timed-out' && version === 22) {
                encoded = encodeTimedOut22(groupId, objectId);
                nextPrior = { groupId, objectId, lastObjectSubgroupId: prior?.lastObjectSubgroupId, lastObjectPriority: prior?.lastObjectPriority };
              } else if (it.marker === 'timed-out' && version === 18) {
                continue;
              } else {
                const kind = it.marker === 'non-existent' ? true : it.marker === 'unknown' ? false : it.marker;
                ({ bytes: encoded, nextPrior } = encodeFetchEndOfRange18(kind, groupId, objectId, prior, version, order));
              }
            }
          }
          const priorNow = prior, firstNow = first;
          everyPrefix(encoded, prefix => agree(`valid-fetch${version}`, prefix, 0,
            () => fromFetch(decodeFetchObject18(prefix, 0, priorNow, firstNow, order, version)),
            () => decodeFetchObjectHeader18(prefix, 0, priorNow, firstNow, order, version)));
          // The header never commits state: the next item is checked against the decoder's own nextPrior.
          const decoded = decodeFetchObject18(encoded, 0, priorNow, firstNow, order, version);
          expect(decoded.nextPrior).toEqual(nextPrior);
          prior = decoded.nextPrior; first = false;
        }
      },
    ), fcParams());
  });
});

describe('exact declared lengths', () => {
  it('reports a payload length above 2^53 exactly while the decoder still waits for bytes', () => {
    const declared = (1n << 53n) + 1n;
    const out = new Uint8Array(16);
    let p = 0;
    p += writeVi64(0n, out, p);          // Object ID Delta
    p += writeVi64(declared, out, p);    // Object Payload Length
    out[p++] = 0xaa;                     // first payload byte
    const buf = out.subarray(0, p);
    const layout = decodeSubgroupObjectHeader18(buf, 0, false, 0n, true);
    expect(layout.payloadLength).toBe(declared);
    expect(layout.headerBytes).toBe(p - 1);
    expect(() => decodeSubgroupObject18(buf, 0, false, 0n, true)).toThrow(RangeError);
  });

  it('reports a draft-16 FETCH payload length at the varint maximum exactly', () => {
    const declared = (1n << 62n) - 1n;
    const encoded = encodeFetch16({ groupId: 1n, subgroupId: 0n, objectId: 2n, priority: 7, extensions: undefined, payload: new Uint8Array(0) });
    // Replace the trailing zero payload length (1 byte) with an 8-byte maximum.
    const out = new Uint8Array(encoded.length - 1 + 8);
    out.set(encoded.subarray(0, encoded.length - 1), 0);
    writeVarint(declared, out, encoded.length - 1);
    const layout = decodeFetchObjectHeader(out, 0, undefined, true);
    expect(layout.payloadLength).toBe(declared);
    expect(() => decodeFetchObject(out, 0, undefined, true)).toThrow(RangeError);
  });
});
