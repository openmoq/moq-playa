/**
 * PR2 — narrow draft-14 / draft-16 codec smoke properties.
 *
 * Deliberately small (no giant legacy generator): setup round-trips, a d16
 * SUBSCRIBE field round-trip, and REQUEST_ERROR — including the draft-14
 * `requestKind` → specific-error-type path added in the previous slice, which is
 * the main regression this guards. Env knobs: FC_RUNS (default 200), FC_SEED.
 */
import { describe, it, expect } from 'vitest';
import { createControlCodec } from './codec.js';
import { SetupParam } from './parameters.js';
import { varint } from '../primitives/varint.js';
import type { Subscribe, RequestErrorMsg, RequestErrorKind, ClientSetup, ServerSetup } from './messages.js';
import { fc, fcParams, varintValue, bytes, namespaceTuple, reasonPhrase } from '../testkit/arbitraries.js';

const codec14 = createControlCodec(14);
const codec16 = createControlCodec(16);

const setupParams = fc
  .option(varintValue, { nil: undefined })
  .map((maxReq) => {
    const m = new Map<bigint, unknown[]>();
    if (maxReq !== undefined) m.set(SetupParam.MAX_REQUEST_ID, [maxReq]);
    return m as never;
  });

describe('legacy SETUP round-trips (draft-14 + draft-16)', () => {
  for (const version of [14, 16] as const) {
    const codec = version === 14 ? codec14 : codec16;
    it(`draft-${version} CLIENT_SETUP encode→decode→re-encode is byte-identical`, () => {
      fc.assert(
        fc.property(setupParams, (parameters) => {
          const msg: ClientSetup = { type: 'CLIENT_SETUP', parameters };
          const e1 = codec.encode(msg);
          const { message, bytesRead } = codec.decode(e1, 0);
          expect(bytesRead).toBe(e1.length);
          expect(message.type).toBe('CLIENT_SETUP');
          expect([...codec.encode(message)]).toEqual([...e1]);
        }),
        fcParams(),
      );
    });

    it(`draft-${version} SERVER_SETUP encode→decode→re-encode is byte-identical`, () => {
      fc.assert(
        fc.property(setupParams, (parameters) => {
          const msg: ServerSetup = { type: 'SERVER_SETUP', parameters };
          const e1 = codec.encode(msg);
          const { message, bytesRead } = codec.decode(e1, 0);
          expect(bytesRead).toBe(e1.length);
          expect(message.type).toBe('SERVER_SETUP');
          expect([...codec.encode(message)]).toEqual([...e1]);
        }),
        fcParams(),
      );
    });
  }
});

describe('draft-16 SUBSCRIBE field round-trip', () => {
  it('preserves requestId, namespace, and track name', () => {
    fc.assert(
      fc.property(varintValue, namespaceTuple, bytes(16), (requestId, ns, name) => {
        const sub: Subscribe = {
          type: 'SUBSCRIBE', requestId, trackNamespace: ns, trackName: name, parameters: new Map(),
        };
        const { message, bytesRead } = codec16.decode(codec16.encode(sub), 0);
        expect(bytesRead).toBe(codec16.encode(sub).length);
        const m = message as Subscribe;
        expect(m.requestId).toBe(requestId);
        expect(m.trackNamespace.map((f) => [...f])).toEqual(ns.map((f) => [...f]));
        expect([...m.trackName]).toEqual([...name]);
      }),
      fcParams(),
    );
  });
});

describe('REQUEST_ERROR round-trips', () => {
  it('draft-16 generic REQUEST_ERROR is byte-identical on re-encode', () => {
    fc.assert(
      fc.property(varintValue, varintValue, reasonPhrase, (requestId, errorCode, errorReason) => {
        const err: RequestErrorMsg = {
          type: 'REQUEST_ERROR', requestId, errorCode, retryInterval: varint(0n), errorReason,
        };
        const e1 = codec16.encode(err);
        const { message, bytesRead } = codec16.decode(e1, 0);
        expect(bytesRead).toBe(e1.length);
        expect(message.type).toBe('REQUEST_ERROR');
        expect([...codec16.encode(message)]).toEqual([...e1]);
      }),
      fcParams(),
    );
  });

  // The draft-14 codec has no generic REQUEST_ERROR: the session stamps a
  // `requestKind` so the codec can emit the specific wire type. This guards that
  // path (added last slice) for every kind, and that decode normalizes back.
  const KIND_TO_TYPE: Record<RequestErrorKind, number> = {
    SUBSCRIBE: 0x05,
    FETCH: 0x19,
    TRACK_STATUS: 0x0f,
    SUBSCRIBE_NAMESPACE: 0x13,
  };

  it('draft-14 REQUEST_ERROR encodes to the specific type for each requestKind and round-trips fields', () => {
    const kinds = Object.keys(KIND_TO_TYPE) as RequestErrorKind[];
    fc.assert(
      fc.property(fc.constantFrom(...kinds), varintValue, varintValue, reasonPhrase, (requestKind, requestId, errorCode, errorReason) => {
        const err: RequestErrorMsg = {
          type: 'REQUEST_ERROR', requestId, errorCode, retryInterval: varint(0n), errorReason, requestKind,
        };
        const e1 = codec14.encode(err);
        expect(e1[0]).toBe(KIND_TO_TYPE[requestKind]); // specific wire type, not generic
        const { message, bytesRead } = codec14.decode(e1, 0);
        expect(bytesRead).toBe(e1.length);
        expect(message.type).toBe('REQUEST_ERROR'); // decode normalizes back
        const m = message as RequestErrorMsg;
        expect(m.requestId).toBe(requestId);
        expect(m.errorCode).toBe(errorCode);
        expect(m.errorReason).toBe(errorReason);
      }),
      fcParams(),
    );
  });

  it('draft-14 refuses a REQUEST_ERROR with no requestKind context', () => {
    fc.assert(
      fc.property(varintValue, varintValue, (requestId, errorCode) => {
        const err: RequestErrorMsg = {
          type: 'REQUEST_ERROR', requestId, errorCode, retryInterval: varint(0n), errorReason: 'x',
        };
        expect(() => codec14.encode(err)).toThrow(/specific error types/);
      }),
      fcParams(),
    );
  });
});
