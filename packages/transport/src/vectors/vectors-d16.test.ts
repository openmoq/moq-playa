/**
 * Cross-implementation wire vectors — **draft-16 only** (PR1).
 *
 * Decodes LibMoQ's committed draft-16 binary corpus
 * (`packages/transport/vectors/d16-libmoq/`, vendored — see its PROVENANCE.md)
 * with Playa's draft-16 codec, then re-encodes and asserts the bytes are
 * IDENTICAL to LibMoQ's. Byte-identity across two independent implementations is
 * the strongest interop signal. A few fields are spot-checked against the
 * manifest's `expected`.
 *
 * draft-14 has distinct wire quirks and is intentionally NOT covered here (a d14
 * corpus would need its own separately-authored expectations).
 *
 * Three LibMoQ vectors currently DIVERGE from Playa's draft-16 codec (see
 * {@link KNOWN_DIVERGENCES}); they are documented + asserted-as-diverging rather
 * than silently skipped, so a future codec change that resolves the divergence
 * fails this test and prompts moving the vector into the passing set.
 */
import { describe, it, expect } from 'vitest';
import { loadVectors, vectorsDir, bytesToHex, type LoadedVector } from './load-vectors.js';
import { createControlCodec } from '../control/codec.js';
import { decodeObjectDatagram, decodeFetchObject, type FetchPriorContext } from '../data/decoder.js';
import { encodeObjectDatagram, encodeFetchObject, encodeFetchEndOfRange } from '../data/encoder.js';

const CONTROL_TYPES = new Set([
  'CLIENT_SETUP', 'SERVER_SETUP', 'SUBSCRIBE', 'SUBSCRIBE_OK', 'REQUEST_OK', 'REQUEST_ERROR',
  'PUBLISH', 'PUBLISH_OK', 'PUBLISH_DONE', 'FETCH', 'FETCH_OK', 'FETCH_CANCEL', 'GOAWAY',
  'UNSUBSCRIBE', 'TRACK_STATUS', 'PUBLISH_NAMESPACE', 'PUBLISH_NAMESPACE_DONE',
  'PUBLISH_NAMESPACE_CANCEL', 'SUBSCRIBE_NAMESPACE',
]);

/**
 * LibMoQ vectors that do NOT round-trip through Playa's draft-16 codec today.
 * These are genuine cross-impl divergences surfaced by this corpus — flagged for
 * a separate investigation (PR1 intentionally makes no codec changes).
 */
const KNOWN_DIVERGENCES: Record<string, string> = {
  'fetch_ok.bin':
    "draft-16 FETCH_OK: Playa's decoder diverges from LibMoQ's payload layout (params/extensions ordering) — decode throws",
  'fetch_eor_non_existent.bin':
    "draft-16 FETCH End-of-Range marker: Playa's decoder reads past LibMoQ's 4-byte marker — decode throws",
  'fetch_eor_unknown.bin':
    "draft-16 FETCH End-of-Range marker: Playa's decoder reads past LibMoQ's marker — decode throws",
};

const codec16 = createControlCodec(16);

/** Decode → re-encode a vector with Playa's draft-16 codec, by message family. */
function roundTrip(v: LoadedVector): { reencoded: Uint8Array; decoded: unknown } {
  if (CONTROL_TYPES.has(v.type)) {
    const { message } = codec16.decode(v.bytes, 0);
    return { reencoded: codec16.encode(message as never), decoded: message };
  }
  if (v.type === 'OBJECT_DATAGRAM') {
    const { datagram } = decodeObjectDatagram(v.bytes, 0, 16);
    return { reencoded: encodeObjectDatagram(datagram), decoded: datagram };
  }
  if (v.type === 'FETCH_DATA') {
    const prior = fetchPriorFromExpected(v);
    const { item } = decodeFetchObject(v.bytes, 0, prior, prior === undefined);
    const reencoded = 'nonExistent' in item ? encodeFetchEndOfRange(item) : encodeFetchObject(item);
    return { reencoded, decoded: item };
  }
  throw new Error(`unrouted vector type ${v.type} (${v.file})`);
}

/** Reconstruct the prior-object context a delta FETCH_DATA vector decodes against. */
function fetchPriorFromExpected(v: LoadedVector): FetchPriorContext | undefined {
  const p = v.expected?.prior as Record<string, number> | undefined;
  if (!p) return undefined;
  return {
    groupId: BigInt(p.group_id), subgroupId: BigInt(p.subgroup_id),
    objectId: BigInt(p.object_id), publisherPriority: p.publisher_priority,
  } as FetchPriorContext;
}

const vectors = loadVectors(vectorsDir('d16-libmoq'));
const interopVectors = vectors.filter((v) => !(v.file in KNOWN_DIVERGENCES));
const divergent = vectors.filter((v) => v.file in KNOWN_DIVERGENCES);

describe('draft-16 cross-impl vectors (LibMoQ corpus)', () => {
  it('loads the full vendored corpus', () => {
    expect(vectors.length).toBe(39);
  });

  describe('byte-identical decode → re-encode', () => {
    for (const v of interopVectors) {
      it(`${v.file} (${v.type})`, () => {
        const { reencoded, decoded } = roundTrip(v);
        // The strongest interop assertion: our bytes == LibMoQ's bytes.
        expect(bytesToHex(reencoded)).toBe(bytesToHex(v.bytes));
        // Loose spot-checks against the manifest's expected fields.
        const m = decoded as Record<string, unknown>;
        if (typeof v.expected?.request_id === 'number' && 'requestId' in m) {
          expect(m.requestId).toBe(BigInt(v.expected.request_id as number));
        }
        if (typeof v.expected?.track_alias === 'number' && 'trackAlias' in m) {
          expect(m.trackAlias).toBe(BigInt(v.expected.track_alias as number));
        }
        if (typeof v.expected?.group_id === 'number' && 'groupId' in m) {
          expect(m.groupId).toBe(BigInt(v.expected.group_id as number));
        }
      });
    }
  });

  describe('known cross-impl divergences (documented, flagged for investigation)', () => {
    for (const v of divergent) {
      it(`${v.file}: ${KNOWN_DIVERGENCES[v.file]}`, () => {
        // Assert the divergence STILL exists. If a codec fix makes this round-trip,
        // this test fails on purpose — move the vector into the passing set above.
        let roundTripped = false;
        try {
          const { reencoded } = roundTrip(v);
          roundTripped = bytesToHex(reencoded) === bytesToHex(v.bytes);
        } catch {
          roundTripped = false;
        }
        expect(roundTripped, `${v.file} now round-trips — promote it out of KNOWN_DIVERGENCES`).toBe(false);
      });
    }
  });
});
