/**
 * Option-A widening guardrail (Codex #4/#6, encode half): message `requestId`
 * is now `bigint` so draft-18 can carry the full uint64 range, but the draft-14
 * and draft-16 encoders MUST still reject a value outside the QUIC-varint range
 * rather than silently truncating it. (The decode-flows-for-d18 half lands with
 * Draft18Codec.)
 */
import { describe, it, expect } from 'vitest';
import { encodeControlMessage } from './encoder.js';
import { createControlCodec } from './codec.js';
import { varint } from '../primitives/varint.js';
import type { Subscribe, SubscribeOk } from './messages.js';

const ABOVE_QUIC = 1n << 63n; // > 2^62-1, valid as a bigint requestId, invalid for QUIC varint

function subscribeWith(requestId: bigint): Subscribe {
  return {
    type: 'SUBSCRIBE',
    requestId,
    trackNamespace: [new Uint8Array([0x6c])],
    trackName: new Uint8Array([0x76]),
    parameters: new Map(),
  };
}

describe('draft-16 encoder range enforcement', () => {
  it('throws (no silent truncation) when requestId exceeds the QUIC range', () => {
    expect(() => encodeControlMessage(subscribeWith(ABOVE_QUIC))).toThrow(RangeError);
    expect(() => createControlCodec(16).encode(subscribeWith(ABOVE_QUIC))).toThrow(RangeError);
  });

  it('still encodes an in-range requestId', () => {
    expect(() => createControlCodec(16).encode(subscribeWith(varint(42n)))).not.toThrow();
  });
});

describe('draft-14 encoder range enforcement', () => {
  it('throws when requestId exceeds the QUIC range', () => {
    expect(() => createControlCodec(14).encode(subscribeWith(ABOVE_QUIC))).toThrow(RangeError);
  });
});

describe('trackAlias range enforcement (control-plane widening)', () => {
  function subscribeOkWith(trackAlias: bigint): SubscribeOk {
    return {
      type: 'SUBSCRIBE_OK',
      requestId: varint(0n),
      trackAlias,
      parameters: new Map(),
      trackExtensions: new Map(),
    };
  }
  it('draft-16/14 throw when a SUBSCRIBE_OK trackAlias exceeds the QUIC range', () => {
    expect(() => createControlCodec(16).encode(subscribeOkWith(ABOVE_QUIC))).toThrow(RangeError);
    expect(() => createControlCodec(14).encode(subscribeOkWith(ABOVE_QUIC))).toThrow(RangeError);
  });
  it('still encodes an in-range trackAlias', () => {
    expect(() => createControlCodec(16).encode(subscribeOkWith(varint(9n)))).not.toThrow();
  });
});
