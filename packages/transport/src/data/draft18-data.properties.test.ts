/**
 * PR2 — property tests for the draft-18 data plane (§11.3 datagrams, §11.4
 * subgroups + fetch). Valid-first generators over a manageable subset; the
 * canonical invariant is encode → decode (consume all bytes) → re-encode is
 * byte-identical, with decoded semantic fields matching.
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED. Heavier soak:
 *   FC_RUNS=5000 npx vitest run packages/transport/src/data/draft18-data.properties.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  encodeSubgroupHeader18,
  encodeSubgroupObject18,
  encodeObjectDatagram18,
  encodeFetchHeader18,
  encodeFetchObject18,
  encodeFetchEndOfRange18,
  type FetchObjectFields,
} from './encoder-18.js';
import {
  decodeSubgroupHeader18,
  decodeSubgroupObject18,
  decodeObjectDatagram18,
  decodeFetchHeader18,
  decodeFetchObject18,
  type FetchObjectPrior18,
} from './decoder-18.js';
import type { SubgroupHeader, SubgroupObject, ObjectDatagram, FetchObject, FetchEndOfRange, GroupOrder } from './types.js';
import { fc, fcParams, vi64Value, bytes, priorityByte } from '../testkit/arbitraries.js';

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
}

// ─── SUBGROUP_HEADER + objects (§11.4) ───────────────────────────────────────

/** A valid SUBGROUP_HEADER type byte: form 0b0XX1XXXX, subgroup-ID mode ≠ 0b11. */
const subgroupTypeByte = fc
  .record({
    mode: fc.constantFrom(0, 1, 2), // 0b00 / 0b01 / 0b10 (explicit); 0b11 reserved
    properties: fc.boolean(),
    endOfGroup: fc.boolean(),
    defaultPriority: fc.boolean(),
    firstObject: fc.boolean(),
  })
  .map(({ mode, properties, endOfGroup, defaultPriority, firstObject }) => {
    let t = 0x10; // SUBGROUP_HEADER form bit
    t |= mode << 1;
    if (properties) t |= 0x01;
    if (endOfGroup) t |= 0x08;
    if (defaultPriority) t |= 0x20;
    if (firstObject) t |= 0x40;
    return t;
  });

function buildSubgroupObject(
  objectId: bigint,
  rec: { payload: Uint8Array; status: bigint; ext: Uint8Array | undefined },
): SubgroupObject {
  if (rec.payload.length > 0) {
    return { objectId, extensions: rec.ext, payload: rec.payload, status: undefined };
  }
  // Empty payload → a status object; Properties are only valid on Normal (0x0).
  const status = rec.status;
  return { objectId, extensions: status === 0n ? rec.ext : undefined, payload: rec.payload, status };
}

const subgroupCase = subgroupTypeByte.chain((typeByte) => {
  const hasProperties = (typeByte & 0x01) !== 0;
  const mode = (typeByte & 0x06) >> 1;
  const objRec = fc.record({
    payload: bytes(24),
    status: fc.constantFrom(0n, 3n, 4n),
    ext: hasProperties ? fc.option(bytes(12), { nil: undefined }) : fc.constant(undefined),
  });
  return fc.record({
    trackAlias: vi64Value,
    groupId: vi64Value,
    subgroupId: mode === 2 ? vi64Value : fc.constant(0n),
    priority: (typeByte & 0x20) !== 0 ? fc.constant(undefined) : priorityByte,
    obj1Id: fc.bigInt({ min: 0n, max: 1n << 40n }),
    gap: fc.bigInt({ min: 0n, max: 1000n }),
    rec1: objRec,
    rec2: objRec,
  }).map((f) => {
    const header: SubgroupHeader = {
      typeByte,
      trackAlias: f.trackAlias,
      groupId: f.groupId,
      subgroupId: f.subgroupId,
      publisherPriority: f.priority,
      hasExtensions: hasProperties,
      isEndOfGroup: (typeByte & 0x08) !== 0,
      isFirstObjectInSubgroup: (typeByte & 0x40) !== 0,
    };
    const o1 = buildSubgroupObject(f.obj1Id, f.rec1);
    const o2 = buildSubgroupObject(f.obj1Id + 1n + f.gap, f.rec2);
    return { header, hasProperties, o1, o2 };
  });
});

describe('draft-18 SUBGROUP_HEADER + objects round-trip', () => {
  it('header + first object + delta object: full consume + byte-identical re-encode', () => {
    fc.assert(
      fc.property(subgroupCase, ({ header, hasProperties, o1, o2 }) => {
        const hb = encodeSubgroupHeader18(header);
        const b1 = encodeSubgroupObject18(o1, hasProperties, 0n, true);
        const b2 = encodeSubgroupObject18(o2, hasProperties, o1.objectId, false);
        const full = concat(hb, b1, b2);

        const dh = decodeSubgroupHeader18(full, 0);
        const d1 = decodeSubgroupObject18(full, dh.bytesRead, hasProperties, 0n, true);
        const d2 = decodeSubgroupObject18(full, dh.bytesRead + d1.bytesRead, hasProperties, d1.object.objectId, false);
        expect(dh.bytesRead + d1.bytesRead + d2.bytesRead).toBe(full.length);

        expect(d1.object.objectId).toBe(o1.objectId);
        expect(d2.object.objectId).toBe(o2.objectId);
        expect(d1.object.payload).toEqual(o1.payload);
        expect(d2.object.payload).toEqual(o2.payload);

        const re = concat(
          encodeSubgroupHeader18(dh.header),
          encodeSubgroupObject18(d1.object, hasProperties, 0n, true),
          encodeSubgroupObject18(d2.object, hasProperties, d1.object.objectId, false),
        );
        expect([...re]).toEqual([...full]);
      }),
      fcParams(),
    );
  });
});

// ─── OBJECT_DATAGRAM (§11.3) ─────────────────────────────────────────────────

const datagramCase = fc
  .record({
    properties: fc.boolean(),
    endOfGroup: fc.boolean(),
    zeroObj: fc.boolean(),
    defaultPriority: fc.boolean(),
    trackAlias: vi64Value,
    groupId: vi64Value,
    objectId: vi64Value,
    priority: priorityByte,
    ext: bytes(16).filter((b) => b.length > 0), // PROPERTIES flag ⇒ non-empty block
    payload: bytes(24),
  })
  .map((f): ObjectDatagram => {
    let t = 0; // normal payload datagram → STATUS (0x20) not set
    if (f.properties) t |= 0x01;
    if (f.endOfGroup) t |= 0x02;
    if (f.zeroObj) t |= 0x04;
    if (f.defaultPriority) t |= 0x08;
    return {
      typeByte: t,
      trackAlias: f.trackAlias,
      groupId: f.groupId,
      objectId: f.zeroObj ? 0n : f.objectId,
      publisherPriority: f.defaultPriority ? undefined : f.priority,
      isEndOfGroup: (t & 0x02) !== 0,
      extensions: f.properties ? f.ext : undefined,
      payload: f.payload,
      status: undefined,
    };
  });

describe('draft-18 OBJECT_DATAGRAM round-trip (normal payload)', () => {
  it('encode → decode consume all bytes → re-encode byte-identical', () => {
    fc.assert(
      fc.property(datagramCase, (dg) => {
        const e1 = encodeObjectDatagram18(dg);
        const { datagram, bytesRead } = decodeObjectDatagram18(e1, 0);
        expect(bytesRead).toBe(e1.length);
        expect(datagram.trackAlias).toBe(dg.trackAlias);
        expect(datagram.groupId).toBe(dg.groupId);
        expect(datagram.objectId).toBe(dg.objectId);
        expect(datagram.payload).toEqual(dg.payload);
        const e2 = encodeObjectDatagram18(datagram);
        expect([...e2]).toEqual([...e1]);
      }),
      fcParams(),
    );
  });
});

// ─── FETCH header + objects (§11.4.4) ────────────────────────────────────────

const FETCH_PAYLOAD = bytes(16); // includes the empty payload (a normal fetch object carries no status)

/** A valid fetch object sequence for a given Group Order (non-empty payloads). */
function fetchStream(groupOrder: GroupOrder): fc.Arbitrary<{ requestId: bigint; objects: FetchObjectFields[] }> {
  const step = fc.record({
    newGroup: fc.boolean(),
    gGap: fc.bigInt({ min: 0n, max: 5n }),
    oAbs: fc.bigInt({ min: 0n, max: 1000n }),
    oInc: fc.bigInt({ min: 0n, max: 20n }),
    subgroupId: fc.bigInt({ min: 0n, max: 50n }),
    priority: priorityByte,
    payload: FETCH_PAYLOAD,
  });
  return fc
    .record({
      requestId: vi64Value,
      g0: fc.bigInt({ min: 1000n, max: 5000n }), // headroom for descending steps
      o0: fc.bigInt({ min: 0n, max: 1000n }),
      sg0: fc.bigInt({ min: 0n, max: 50n }),
      p0: priorityByte,
      pay0: FETCH_PAYLOAD,
      steps: fc.array(step, { minLength: 0, maxLength: 3 }),
    })
    .map((f) => {
      const objects: FetchObjectFields[] = [
        { groupId: f.g0, subgroupId: f.sg0, objectId: f.o0, publisherPriority: f.p0, payload: f.pay0 },
      ];
      let curG = f.g0;
      let curO = f.o0;
      for (const s of f.steps) {
        if (s.newGroup) {
          if (groupOrder === 'ascending') {
            curG = curG + 1n + s.gGap;
          } else {
            const down = 1n + s.gGap;
            if (down > curG) continue; // cannot go below group 0 → keep same group
            curG = curG - down;
          }
          curO = s.oAbs; // new group → absolute object id
        } else {
          curO = curO + s.oInc; // same group → non-decreasing object id
        }
        objects.push({ groupId: curG, subgroupId: s.subgroupId, objectId: curO, publisherPriority: s.priority, payload: s.payload });
      }
      return { requestId: f.requestId, objects };
    });
}

function roundTripFetchStream(groupOrder: GroupOrder) {
  return ({ requestId, objects }: { requestId: bigint; objects: FetchObjectFields[] }) => {
    const head = encodeFetchHeader18(requestId);
    const encoded: Uint8Array[] = [];
    let prior: FetchObjectPrior18 | undefined;
    objects.forEach((o, i) => {
      const r = encodeFetchObject18(o, prior, i === 0, groupOrder);
      encoded.push(r.bytes);
      prior = r.nextPrior;
    });
    const full = concat(head, ...encoded);

    const dh = decodeFetchHeader18(full, 0);
    expect(dh.header.requestId).toBe(requestId);
    let pos = dh.bytesRead;
    let dprior: FetchObjectPrior18 | undefined;
    const decoded: FetchObject[] = [];
    objects.forEach((_, i) => {
      const r = decodeFetchObject18(full, pos, dprior, i === 0, groupOrder);
      decoded.push(r.item as FetchObject);
      pos += r.bytesRead;
      dprior = r.nextPrior;
    });
    expect(pos).toBe(full.length); // consumed exactly

    objects.forEach((o, i) => {
      expect(decoded[i]!.groupId).toBe(o.groupId);
      expect(decoded[i]!.objectId).toBe(o.objectId);
      expect(decoded[i]!.subgroupId).toBe(o.subgroupId);
      expect(decoded[i]!.publisherPriority).toBe(o.publisherPriority);
      expect(decoded[i]!.payload).toEqual(o.payload);
    });

    // Re-encode the decoded fields and assert byte-identity with the original.
    const reEnc: Uint8Array[] = [];
    let rprior: FetchObjectPrior18 | undefined;
    decoded.forEach((item, i) => {
      const r = encodeFetchObject18(
        { groupId: item.groupId, subgroupId: item.subgroupId, objectId: item.objectId, publisherPriority: item.publisherPriority!, payload: item.payload },
        rprior,
        i === 0,
        groupOrder,
      );
      reEnc.push(r.bytes);
      rprior = r.nextPrior;
    });
    expect([...concat(...reEnc)]).toEqual([...concat(...encoded)]);
  };
}

describe('draft-18 FETCH header + objects round-trip', () => {
  it('ascending group order: full consume + byte-identical re-encode', () => {
    fc.assert(fc.property(fetchStream('ascending'), roundTripFetchStream('ascending')), fcParams());
  });

  it('descending group order: full consume + byte-identical re-encode', () => {
    fc.assert(fc.property(fetchStream('descending'), roundTripFetchStream('descending')), fcParams());
  });

  it('End-of-Range marker after a first object round-trips (both nonExistent flavors)', () => {
    const eorCase = fc.record({
      requestId: vi64Value,
      first: fc.record({ g: vi64Value, o: fc.bigInt({ min: 0n, max: 1000n }), sg: fc.bigInt({ min: 0n, max: 50n }), p: priorityByte, pay: FETCH_PAYLOAD }),
      nonExistent: fc.boolean(),
      eorGroup: vi64Value,
      eorObject: vi64Value,
    });
    fc.assert(
      fc.property(eorCase, ({ requestId, first, nonExistent, eorGroup, eorObject }) => {
        const head = encodeFetchHeader18(requestId);
        const f0: FetchObjectFields = { groupId: first.g, subgroupId: first.sg, objectId: first.o, publisherPriority: first.p, payload: first.pay };
        const r0 = encodeFetchObject18(f0, undefined, true, 'ascending');
        const eor = encodeFetchEndOfRange18(nonExistent, eorGroup, eorObject, r0.nextPrior);
        const full = concat(head, r0.bytes, eor.bytes);

        const dh = decodeFetchHeader18(full, 0);
        const d0 = decodeFetchObject18(full, dh.bytesRead, undefined, true, 'ascending');
        const dEor = decodeFetchObject18(full, dh.bytesRead + d0.bytesRead, d0.nextPrior, false, 'ascending');
        expect(dh.bytesRead + d0.bytesRead + dEor.bytesRead).toBe(full.length);

        const marker = dEor.item as FetchEndOfRange;
        expect(marker.groupId).toBe(eorGroup);
        expect(marker.objectId).toBe(eorObject);
        expect(marker.nonExistent).toBe(nonExistent);

        const reEor = encodeFetchEndOfRange18(marker.nonExistent, marker.groupId, marker.objectId, d0.nextPrior);
        expect([...reEor.bytes]).toEqual([...eor.bytes]);
      }),
      fcParams(),
    );
  });
});
