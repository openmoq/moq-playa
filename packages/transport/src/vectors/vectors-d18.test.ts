/**
 * Playa-authored draft-18 golden vectors (PR1).
 *
 * A small, spec-anchored corpus of draft-18 wire bytes committed under
 * `packages/transport/vectors/d18/`. The committed `.bin` files are the source
 * of truth and freeze the exact wire output of Playa's draft-18 encoders.
 *
 * - **Default run is READ-ONLY**: it loads the committed corpus and asserts that
 *   re-encoding from the canonical message spec still produces byte-identical
 *   output (catches accidental wire drift), plus a decode→re-encode symmetry
 *   check for the control + datagram forms.
 * - **Regeneration is explicit**: run with `GEN_VECTORS=1` to (re)write the
 *   `.bin` files + `manifest.json` after an intentional, reviewed wire change.
 *
 * (LibMoQ has no draft-18 binary corpus yet; once it does, these become a
 * cross-impl target too. For now they are a regression + spec-anchoring oracle.)
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadVectors, vectorsDir, bytesToHex } from './load-vectors.js';
import { createControlCodec } from '../control/codec.js';
import { varint } from '../primitives/varint.js';
import {
  encodeSubgroupHeader18, encodeSubgroupObject18, encodeObjectDatagram18,
  encodeFetchObject18, encodeFetchEndOfRange18,
} from '../data/encoder-18.js';
import {
  decodeObjectDatagram18, decodeSubgroupHeader18, decodeSubgroupObject18, decodeFetchObject18,
} from '../data/decoder-18.js';
import type { ControlMessage, SubgroupHeader, ObjectDatagram } from '../control/messages.js';
import type { FetchObject, FetchEndOfRange } from '../data/types.js';

const codec18 = createControlCodec(18);
const enc = (s: string) => new TextEncoder().encode(s);
const NS = [enc('live')];
const NAME = enc('vid');

type Kind = 'control' | 'datagram' | 'subgroup-header' | 'subgroup-object' | 'fetch-object' | 'fetch-eor';

interface BuiltVector {
  readonly file: string;
  readonly type: string;
  readonly kind: Kind;
  readonly bytes: Uint8Array;
  readonly expected: Record<string, unknown>;
}

/** Build the canonical draft-18 corpus from Playa's encoders (the single source). */
function buildVectors(): BuiltVector[] {
  const control = (file: string, type: string, msg: ControlMessage, expected: Record<string, unknown> = {}): BuiltVector =>
    ({ file, type, kind: 'control', bytes: codec18.encode(msg), expected });

  const subgroupHeader: SubgroupHeader = {
    typeByte: 0x14, // mode 0b10 (explicit Subgroup ID), no flags
    trackAlias: 7n, groupId: 42n, subgroupId: 3n, publisherPriority: 5,
    hasExtensions: false, isEndOfGroup: false,
  } as SubgroupHeader;
  const datagram: ObjectDatagram = {
    typeByte: 0x00, trackAlias: 7n, groupId: 42n, objectId: 3n, publisherPriority: 4,
    isEndOfGroup: false, extensions: undefined, payload: new Uint8Array([0x09, 0x08]), status: undefined,
  } as ObjectDatagram;

  return [
    control('setup.bin', 'SETUP', { type: 'SETUP', setupOptions: new Map() } as ControlMessage),
    control('subscribe.bin', 'SUBSCRIBE',
      { type: 'SUBSCRIBE', requestId: 0n, trackNamespace: NS, trackName: NAME, parameters: new Map() } as ControlMessage,
      { request_id: 0 }),
    control('subscribe_ok.bin', 'SUBSCRIBE_OK',
      { type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 9n, parameters: new Map(), trackProperties: new Map() } as ControlMessage,
      { track_alias: 9 }),
    control('request_ok.bin', 'REQUEST_OK',
      { type: 'REQUEST_OK', requestId: 0n, parameters: new Map() } as ControlMessage),
    control('request_error.bin', 'REQUEST_ERROR',
      { type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x10n), retryInterval: varint(3n), errorReason: 'nope' } as ControlMessage,
      { error_code: 16, retry_interval: 3, reason: 'nope' }),
    control('request_error_redirect.bin', 'REQUEST_ERROR',
      { type: 'REQUEST_ERROR', requestId: 0n, errorCode: 0x34n, retryInterval: 0n, errorReason: 'moved',
        redirect: { connectUri: enc('https://relay.example/2'), trackNamespace: NS, trackName: NAME } } as ControlMessage,
      { error_code: 52, redirect: true }),
    control('publish.bin', 'PUBLISH',
      { type: 'PUBLISH', requestId: 0n, trackNamespace: NS, trackName: NAME, trackAlias: 21n, parameters: new Map(), trackProperties: new Map() } as ControlMessage,
      { track_alias: 21 }),
    control('fetch.bin', 'FETCH',
      { type: 'FETCH', requestId: 0n, fetch: { fetchType: 0x1, trackNamespace: NS, trackName: NAME, startLocation: { group: 1n, object: 2n }, endLocation: { group: 9n, object: 4n } }, parameters: new Map() } as ControlMessage,
      { request_id: 0 }),
    control('fetch_ok.bin', 'FETCH_OK',
      { type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: 9n, object: 0n }, parameters: new Map(), trackProperties: new Map() } as ControlMessage,
      { end_group: 9 }),
    control('track_status_ok.bin', 'REQUEST_OK',
      { type: 'REQUEST_OK', requestId: 0n, parameters: new Map(), trackProperties: new Map([[0x0en, [3n]]]) } as ControlMessage,
      { track_status_ok: true, default_publisher_priority: 3 }),
    control('goaway.bin', 'GOAWAY',
      { type: 'GOAWAY', newSessionUri: 'https://relay.example/moq', timeout: 5000n, requestId: 0n } as ControlMessage,
      { new_session_uri: 'https://relay.example/moq', timeout: 5000, request_id: 0 }),

    { file: 'subgroup_header.bin', type: 'SUBGROUP_HEADER', kind: 'subgroup-header',
      bytes: encodeSubgroupHeader18(subgroupHeader),
      expected: { track_alias: 7, group_id: 42, subgroup_id: 3, publisher_priority: 5 } },
    { file: 'subgroup_object.bin', type: 'SUBGROUP_OBJECT', kind: 'subgroup-object',
      bytes: encodeSubgroupObject18(
        { objectId: 5n, extensions: undefined, payload: new Uint8Array([0xaa, 0xbb]), status: undefined },
        false, 0n, true),
      expected: { object_id: 5, payload_hex: 'aabb', first_object: true } },
    { file: 'object_datagram.bin', type: 'OBJECT_DATAGRAM', kind: 'datagram',
      bytes: encodeObjectDatagram18(datagram),
      expected: { track_alias: 7, group_id: 42, object_id: 3, publisher_priority: 4 } },
    { file: 'fetch_object.bin', type: 'FETCH_DATA', kind: 'fetch-object',
      bytes: encodeFetchObject18(
        { groupId: 10n, subgroupId: 2n, objectId: 5n, publisherPriority: 7, payload: new Uint8Array([0xaa]) },
        undefined, true, 'ascending').bytes,
      expected: { group_id: 10, subgroup_id: 2, object_id: 5, group_order: 'ascending', first_object: true } },
    // Empty-payload normal fetch object: Payload Length = 0 with NO trailing status
    // byte (a normal fetch object carries no Object Status; §11.4.4). Frozen as a
    // regression for the encoder/decoder empty-payload asymmetry the property
    // suite found — decode must consume every byte.
    { file: 'fetch_empty_object.bin', type: 'FETCH_DATA', kind: 'fetch-object',
      bytes: encodeFetchObject18(
        { groupId: 10n, subgroupId: 2n, objectId: 5n, publisherPriority: 7, payload: new Uint8Array(0) },
        undefined, true, 'ascending').bytes,
      expected: { group_id: 10, subgroup_id: 2, object_id: 5, group_order: 'ascending', first_object: true, payload_hex: '' } },
    { file: 'fetch_eor.bin', type: 'FETCH_DATA', kind: 'fetch-eor',
      bytes: encodeFetchEndOfRange18(true, 5n, 10n, undefined).bytes,
      expected: { end_of_range: true, non_existent: true, group_id: 5, object_id: 10 } },
  ];
}

const DIR = vectorsDir('d18');

// ─── GEN_VECTORS=1: (re)write the committed corpus ───────────────────────────
if (process.env.GEN_VECTORS === '1') {
  describe('GENERATE draft-18 vectors (GEN_VECTORS=1)', () => {
    it('writes .bin + manifest.json', () => {
      mkdirSync(DIR, { recursive: true });
      const built = buildVectors();
      const manifest = {
        note: 'Playa-authored draft-18 golden vectors. Regenerate via GEN_VECTORS=1. See vectors-d18.test.ts.',
        vectors: built.map((v) => ({
          file: v.file, type: v.type, wire_length: v.bytes.length,
          wire_hex: bytesToHex(v.bytes), expected: v.expected,
        })),
      };
      for (const v of built) writeFileSync(join(DIR, v.file), v.bytes);
      writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      expect(built.length).toBeGreaterThan(0);
    });
  });
}

// ─── default: READ-ONLY validation of the committed corpus ───────────────────
// Defined only when NOT generating, so first-time generation does not load a
// corpus that does not exist yet (a describe body runs at collection time).
if (process.env.GEN_VECTORS !== '1') {
  describe('draft-18 golden vectors (read-only regression)', () => {
    const built = buildVectors();
    const committed = loadVectors(DIR);

    it('committed corpus matches the builder set (no stray/missing vectors)', () => {
      expect(committed.map((v) => v.file).sort()).toEqual(built.map((v) => v.file).sort());
    });

    for (const b of built) {
      it(`${b.file} (${b.type}) — committed bytes decode and re-encode identically`, () => {
        const onDisk = committed.find((v) => v.file === b.file);
        expect(onDisk, `${b.file} missing on disk — run GEN_VECTORS=1`).toBeDefined();
        const wire = onDisk!.bytes;
        // Wire-drift regression: the encoder still produces exactly the frozen bytes.
        expect(bytesToHex(b.bytes)).toBe(bytesToHex(wire));
        // Decode→re-encode symmetry: the committed bytes are accepted by the
        // draft-18 decoders and round-trip back to the same bytes.
        expect(bytesToHex(reDecodeEncode(b.kind, wire))).toBe(bytesToHex(wire));
      });
    }
  });
}

/**
 * Decode `wire` with the draft-18 decoder appropriate for `kind`, assert it
 * consumed every byte, and re-encode it. Proves the committed corpus is accepted
 * by the live decoders (not just that the encoder reproduces frozen bytes).
 */
function reDecodeEncode(kind: Kind, wire: Uint8Array): Uint8Array {
  switch (kind) {
    case 'control': {
      const { message, bytesRead } = codec18.decode(wire, 0);
      expect(bytesRead).toBe(wire.length);
      return codec18.encode(message as ControlMessage);
    }
    case 'datagram': {
      const { datagram, bytesRead } = decodeObjectDatagram18(wire, 0);
      expect(bytesRead).toBe(wire.length);
      return encodeObjectDatagram18(datagram);
    }
    case 'subgroup-header': {
      const { header, bytesRead } = decodeSubgroupHeader18(wire, 0);
      expect(bytesRead).toBe(wire.length);
      return encodeSubgroupHeader18(header);
    }
    case 'subgroup-object': {
      const { object, bytesRead } = decodeSubgroupObject18(wire, 0, false, 0n, true);
      expect(bytesRead).toBe(wire.length);
      return encodeSubgroupObject18(object, false, 0n, true);
    }
    case 'fetch-object': {
      const { item, bytesRead } = decodeFetchObject18(wire, 0, undefined, true, 'ascending');
      expect(bytesRead).toBe(wire.length);
      expect('nonExistent' in item).toBe(false); // a normal object, not an EOR marker
      const o = item as FetchObject;
      expect(o.publisherPriority).toBeDefined();
      return encodeFetchObject18(
        { groupId: o.groupId, subgroupId: o.subgroupId, objectId: o.objectId, publisherPriority: o.publisherPriority!, payload: o.payload },
        undefined, true, 'ascending',
      ).bytes;
    }
    case 'fetch-eor': {
      const { item, bytesRead } = decodeFetchObject18(wire, 0, undefined, true, 'ascending');
      expect(bytesRead).toBe(wire.length);
      expect('nonExistent' in item).toBe(true); // an End-of-Range marker
      const eor = item as FetchEndOfRange;
      expect(eor.nonExistent).toBe(true);
      return encodeFetchEndOfRange18(eor.nonExistent, eor.groupId, eor.objectId, undefined).bytes;
    }
  }
}
