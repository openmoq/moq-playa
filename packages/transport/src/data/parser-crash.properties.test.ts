/**
 * PR2.5 — data-plane crash fuzz.
 *
 * Feeds arbitrary / truncated / malformed byte strings (and random decoder
 * context: prior, hasExtensions, isFirstObject, groupOrder) to the draft-14/16/18
 * data parser entrypoints and asserts they are CRASH-SAFE: classify / decode must
 * either return a structurally sane result or throw ONLY an expected parser error
 * class (ProtocolViolationError / RangeError) — never a TypeError / plain Error,
 * never a bytesRead outside the buffer, never hang.
 *
 * Not semantic validation: arbitrary bytes are not expected to decode.
 * Env knobs: FC_RUNS (default 200), FC_SEED.
 */
import { describe, it, expect } from 'vitest';
import { createDataCodec } from './data-codec.js';
import type { DraftVersion } from '../versions.js';
import type { FetchPriorContext } from './decoder.js';
import type { FetchObjectPrior18 } from './decoder-18.js';
import type { GroupOrder } from './types.js';
import { ProtocolViolationError } from '../errors.js';
import { fc, fcParams, fuzzBytes, fuzzOffset, vi64Value, priorityByte, toHex } from '../testkit/arbitraries.js';

function expectParserSafe<T>(label: string, input: Uint8Array, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ProtocolViolationError || e instanceof RangeError) return undefined;
    const name = e instanceof Error ? e.constructor.name : typeof e;
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: unexpected ${name}: ${message}\n  input(${input.length}B)=0x${toHex(input)}`);
  }
}

function assertSaneBytesRead(label: string, input: Uint8Array, offset: number, bytesRead: unknown): void {
  expect(typeof bytesRead, `${label}: bytesRead is a number (0x${toHex(input)})`).toBe('number');
  const n = bytesRead as number;
  expect(Number.isInteger(n), `${label}: bytesRead is an integer (0x${toHex(input)})`).toBe(true);
  expect(n, `${label}: bytesRead > 0 (0x${toHex(input)})`).toBeGreaterThan(0);
  expect(offset + n, `${label}: offset+bytesRead ≤ length (0x${toHex(input)})`).toBeLessThanOrEqual(input.length);
}

// ── random decoder context ───────────────────────────────────────────────────
const aBigInt = vi64Value; // boundary-biased 0..2^64-1 (exercises overflow checks)
const optionalNumber = fc.option(priorityByte, { nil: undefined });

const fetchPrior14: fc.Arbitrary<FetchPriorContext | undefined> = fc.option(
  fc.record({ groupId: aBigInt, subgroupId: aBigInt, objectId: aBigInt, priority: optionalNumber }),
  { nil: undefined },
);
const fetchPrior18: fc.Arbitrary<FetchObjectPrior18 | undefined> = fc.option(
  fc.record({
    groupId: aBigInt,
    objectId: aBigInt,
    lastObjectSubgroupId: fc.option(aBigInt, { nil: undefined }),
    lastObjectPriority: optionalNumber,
  }),
  { nil: undefined },
);
const groupOrder: fc.Arbitrary<GroupOrder> = fc.constantFrom('ascending', 'descending');

const VERSIONS: DraftVersion[] = [14, 16, 18];

for (const version of VERSIONS) {
  const codec = createDataCodec(version);

  describe(`draft-${version} data parser crash fuzz`, () => {
    it('classifyStream / classifyDatagram never hard-crash', () => {
      fc.assert(
        fc.property(fuzzBytes, fuzzOffset, (buf, offset) => {
          const s = expectParserSafe(`classifyStream d${version}`, buf, () => codec.classifyStream(buf, offset));
          if (s !== undefined) expect(typeof s).toBe('string');
          const d = expectParserSafe(`classifyDatagram d${version}`, buf, () => codec.classifyDatagram(buf, offset));
          if (d !== undefined) expect(typeof d).toBe('string');
        }),
        fcParams(),
      );
    });

    it('decodeSubgroupHeader never hard-crashes; any result is structurally sane', () => {
      fc.assert(
        fc.property(fuzzBytes, fuzzOffset, (payload, offset) => {
          const buf = atOffset(payload, offset);
          if (offset >= buf.length) return;
          const r = expectParserSafe(`subgroupHeader d${version}`, buf, () => codec.decodeSubgroupHeader(buf, offset));
          if (r !== undefined) assertSaneBytesRead(`subgroupHeader d${version}`, buf, offset, r.bytesRead);
        }),
        fcParams(),
      );
    });

    it('decodeSubgroupObject never hard-crashes (random hasExtensions / prevObjectId / isFirst)', () => {
      fc.assert(
        fc.property(fuzzBytes, fc.boolean(), aBigInt, fc.boolean(), (buf, hasExt, prevObjId, isFirst) => {
          const r = expectParserSafe(
            `subgroupObject d${version}`,
            buf,
            () => codec.decodeSubgroupObject(buf, 0, hasExt, prevObjId, isFirst),
          );
          if (r !== undefined) assertSaneBytesRead(`subgroupObject d${version}`, buf, 0, r.bytesRead);
        }),
        fcParams(),
      );
    });

    it('decodeFetchHeader never hard-crashes; any result is structurally sane', () => {
      fc.assert(
        fc.property(fuzzBytes, fuzzOffset, (payload, offset) => {
          const buf = atOffset(payload, offset);
          if (offset >= buf.length) return;
          const r = expectParserSafe(`fetchHeader d${version}`, buf, () => codec.decodeFetchHeader(buf, offset));
          if (r !== undefined) assertSaneBytesRead(`fetchHeader d${version}`, buf, offset, r.bytesRead);
        }),
        fcParams(),
      );
    });

    it('decodeObjectDatagram never hard-crashes; any result is structurally sane', () => {
      fc.assert(
        fc.property(fuzzBytes, (buf) => {
          const r = expectParserSafe(`objectDatagram d${version}`, buf, () => codec.decodeObjectDatagram(buf, 0));
          if (r !== undefined) assertSaneBytesRead(`objectDatagram d${version}`, buf, 0, r.bytesRead);
        }),
        fcParams(),
      );
    });

    if (version === 18) {
      it('decodeFetchObject18 never hard-crashes (random prior / isFirst / groupOrder)', () => {
        fc.assert(
          fc.property(fuzzBytes, fetchPrior18, fc.boolean(), groupOrder, (buf, prior, isFirst, order) => {
            const r = expectParserSafe(
              'fetchObject18',
              buf,
              () => codec.decodeFetchObject18(buf, 0, prior, isFirst, order),
            );
            if (r !== undefined) assertSaneBytesRead('fetchObject18', buf, 0, r.bytesRead);
          }),
          fcParams(),
        );
      });
    } else {
      it('decodeFetchObject never hard-crashes (random prior / isFirst)', () => {
        fc.assert(
          fc.property(fuzzBytes, fetchPrior14, fc.boolean(), (buf, prior, isFirst) => {
            const r = expectParserSafe(
              `fetchObject d${version}`,
              buf,
              () => codec.decodeFetchObject(buf, 0, prior, isFirst),
            );
            if (r !== undefined) assertSaneBytesRead(`fetchObject d${version}`, buf, 0, r.bytesRead);
          }),
          fcParams(),
        );
      });
    }
  });
}

/** Prepend `offset` filler bytes so decoding starts at a non-zero offset. */
function atOffset(payload: Uint8Array, offset: number): Uint8Array {
  const buf = new Uint8Array(offset + payload.length);
  buf.set(payload, offset);
  return buf;
}
