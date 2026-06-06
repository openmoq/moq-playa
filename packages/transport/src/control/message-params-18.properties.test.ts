/**
 * PR2 — property tests for the draft-18 Message Parameter and Track Property
 * codecs (§10.2, §2.5/§12). Valid-first generators over the per-kind value
 * encodings, asserting encode→decode→re-encode byte-identity plus a couple of
 * targeted invalid-shape "throws" properties. Env knobs: FC_RUNS, FC_SEED.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeMessageParams18,
  decodeMessageParams18,
  DEFAULT_MESSAGE_PARAM_REGISTRY,
  type MessageParamValue,
  type MessageParams18,
} from './message-params-18.js';
import {
  encodeTrackProperties18,
  decodeTrackProperties18,
} from './track-properties-18.js';
import { MessageParam18 } from './codes-18.js';
import { ProtocolViolationError } from '../errors.js';
import type { TrackExtensions } from './messages.js';
import { fc, fcParams, vi64Value, bytes, namespaceTuple } from '../testkit/arbitraries.js';

// ─── Message Parameters (§10.2) ──────────────────────────────────────────────

const REGISTRY_ENTRIES = Object.values(MessageParam18).map((d) => ({
  type: BigInt(d.type),
  kind: d.kind,
}));
const KNOWN_TYPES = new Set(REGISTRY_ENTRIES.map((e) => e.type));

function valueArbForKind(kind: string): fc.Arbitrary<MessageParamValue> {
  switch (kind) {
    case 'uint8':
      return fc.integer({ min: 0, max: 255 }).map((value) => ({ kind: 'uint8', value }));
    case 'varint':
      return vi64Value.map((value) => ({ kind: 'varint', value }));
    case 'location':
      return fc.tuple(vi64Value, vi64Value).map(([group, object]) => ({ kind: 'location', group, object }));
    case 'bytes':
      return bytes().map((value) => ({ kind: 'bytes', value }));
    case 'namespace':
      return namespaceTuple.map((value) => ({ kind: 'namespace', value }));
    default:
      throw new Error(`unhandled kind ${kind}`);
  }
}

/** A valid params map: an independent optional value for each known registry Type. */
const messageParamsArb: fc.Arbitrary<MessageParams18> = fc
  .tuple(...REGISTRY_ENTRIES.map((e) => fc.option(valueArbForKind(e.kind), { nil: undefined })))
  .map((values) => {
    const m = new Map<bigint, MessageParamValue[]>();
    REGISTRY_ENTRIES.forEach((e, i) => {
      const v = values[i];
      if (v !== undefined) m.set(e.type, [v]);
    });
    return m;
  });

describe('Message Parameters (§10.2) properties', () => {
  it('encode→decode→re-encode is byte-identical and consumes all bytes', () => {
    fc.assert(
      fc.property(messageParamsArb, (params) => {
        const e1 = encodeMessageParams18(params);
        const { params: decoded, bytesRead } = decodeMessageParams18(e1, 0, DEFAULT_MESSAGE_PARAM_REGISTRY);
        expect(bytesRead).toBe(e1.length);
        expect(decoded.size).toBe(params.size);
        const e2 = encodeMessageParams18(decoded);
        expect([...e2]).toEqual([...e1]); // canonical round-trip
      }),
      fcParams(),
    );
  });

  it('decoded values are semantically equal by Type and kind', () => {
    fc.assert(
      fc.property(messageParamsArb, (params) => {
        const { params: decoded } = decodeMessageParams18(
          encodeMessageParams18(params),
          0,
          DEFAULT_MESSAGE_PARAM_REGISTRY,
        );
        for (const [type, values] of params) {
          expect(decoded.get(type)).toEqual(values);
        }
      }),
      fcParams(),
    );
  });

  it('an unknown parameter Type is rejected on encode (ProtocolViolationError)', () => {
    const unknownType = fc.bigInt({ min: 0n, max: 0xffffn }).filter((t) => !KNOWN_TYPES.has(t));
    fc.assert(
      fc.property(unknownType, vi64Value, (type, value) => {
        const params = new Map<bigint, MessageParamValue[]>([[type, [{ kind: 'varint', value }]]]);
        expect(() => encodeMessageParams18(params)).toThrow(ProtocolViolationError);
      }),
      fcParams(),
    );
  });

  it('a value whose kind mismatches its Type is rejected on encode (ProtocolViolationError)', () => {
    // FORWARD (0x10) is uint8; handing it a bytes value is a kind mismatch.
    fc.assert(
      fc.property(bytes(), (value) => {
        const params = new Map<bigint, MessageParamValue[]>([[0x10n, [{ kind: 'bytes', value }]]]);
        expect(() => encodeMessageParams18(params)).toThrow(ProtocolViolationError);
      }),
      fcParams(),
    );
  });
});

// ─── Track Properties (§2.5, §12) ────────────────────────────────────────────

/**
 * A valid Track Property entry. Types are restricted to [0x100, 0x3FFE] — clear
 * of the known constrained Types (< 0x100), Object-only Types (0x3C/0x3E), and
 * the Mandatory range (0x4000–0x7FFF) — so the only rule in play is the parity
 * encoding: even Type → vi64 value; odd Type → length-prefixed bytes.
 */
const trackPropEntryArb: fc.Arbitrary<{ type: bigint; values: (bigint | Uint8Array)[] }> = fc
  .integer({ min: 0x100, max: 0x3ffe })
  .chain((tNum) => {
    const type = BigInt(tNum);
    const even = (type & 1n) === 0n;
    const valueArb: fc.Arbitrary<bigint | Uint8Array> = even ? vi64Value : bytes(48);
    // 1..3 values under one Type exercises duplicate preservation.
    return fc.array(valueArb, { minLength: 1, maxLength: 3 }).map((values) => ({ type, values }));
  });

/** A valid Track Properties map (distinct Types). */
const trackPropsArb: fc.Arbitrary<TrackExtensions> = fc
  .uniqueArray(trackPropEntryArb, { selector: (e) => e.type, maxLength: 8 })
  .map((entries) => {
    const m = new Map<bigint, (bigint | Uint8Array)[]>();
    for (const e of entries) m.set(e.type, e.values);
    return m as unknown as TrackExtensions;
  });

describe('Track Properties (§2.5, §12) properties', () => {
  it('encode→decode→re-encode is byte-identical (unknown Types + duplicates preserved)', () => {
    fc.assert(
      fc.property(trackPropsArb, (props) => {
        const e1 = encodeTrackProperties18(props);
        const { properties, bytesRead } = decodeTrackProperties18(e1, 0);
        expect(bytesRead).toBe(e1.length);
        const e2 = encodeTrackProperties18(properties);
        expect([...e2]).toEqual([...e1]);
      }),
      fcParams(),
    );
  });

  it('decoded entries preserve Type, value, and duplicate count', () => {
    fc.assert(
      fc.property(trackPropsArb, (props) => {
        const { properties } = decodeTrackProperties18(encodeTrackProperties18(props), 0);
        const original = props as unknown as Map<bigint, (bigint | Uint8Array)[]>;
        const decoded = properties as unknown as Map<bigint, (bigint | Uint8Array)[]>;
        expect(decoded.size).toBe(original.size);
        for (const [type, values] of original) {
          expect(decoded.get(type)).toEqual(values);
        }
      }),
      fcParams(),
    );
  });

  it('a known Track Property obeys its semantic constraint (DEFAULT_PUBLISHER_PRIORITY 0x0E, 0..255)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 255n }), (v) => {
        const props = new Map<bigint, bigint[]>([[0x0en, [v]]]) as unknown as TrackExtensions;
        const { properties } = decodeTrackProperties18(encodeTrackProperties18(props), 0);
        expect((properties as unknown as Map<bigint, bigint[]>).get(0x0en)).toEqual([v]);
      }),
      fcParams(),
    );
    // Out-of-range value is rejected on encode.
    fc.assert(
      fc.property(fc.bigInt({ min: 256n, max: (1n << 64n) - 1n }), (v) => {
        const props = new Map<bigint, bigint[]>([[0x0en, [v]]]) as unknown as TrackExtensions;
        expect(() => encodeTrackProperties18(props)).toThrow(ProtocolViolationError);
      }),
      fcParams(),
    );
  });
});
