/**
 * Typed Location parameter validation (Codex gap fix).
 *
 * A draft-18 typed `Location` parameter value is only defined for LARGEST_OBJECT.
 * Supplied for any other parameter (e.g. SUBSCRIPTION_FILTER, FORWARD) it must be
 * rejected with KEY_VALUE_FORMATTING_ERROR. And draft-14/16 cannot encode a
 * Location through KVP at all.
 */
import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, type CloseConnectionAction } from './types.js';
import { varint } from '../primitives/varint.js';
import { SetupParam, MessageParam } from '../control/parameters.js';
import { SessionError as SessionErrorCode } from '../errors.js';
import { createControlCodec } from '../control/codec.js';
import type { Location } from '../primitives/location.js';
import type { ServerSetup, ClientSetup, Subscribe, SubscribeOk, Publish, RequestOk } from '../control/messages.js';

const NS = [new Uint8Array([0x6c])];
const NAME = new Uint8Array([0x76]);
const LOC: Location = { group: varint(2n), object: varint(3n) };

function establishedClient(): Session {
  const s = new Session(EndpointRole.CLIENT);
  s.initiateSetup({ maxRequestId: varint(100n) });
  s.handleControlMessage({
    type: 'SERVER_SETUP',
    parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
  } as ServerSetup);
  return s;
}
function establishedServer(): Session {
  const s = new Session(EndpointRole.SERVER);
  s.handleControlMessage({ type: 'CLIENT_SETUP', parameters: new Map() } as ClientSetup);
  s.completeSetup({ maxRequestId: varint(200n) });
  return s;
}
function formattingError(actions: readonly { type: string }[]): boolean {
  return actions.some(
    (a) => a.type === 'close_connection' &&
      (a as CloseConnectionAction).error === SessionErrorCode.KEY_VALUE_FORMATTING_ERROR,
  );
}

describe('typed Location accepted only for LARGEST_OBJECT', () => {
  it('SUBSCRIBE_OK with LARGEST_OBJECT as a Location is accepted', () => {
    const s = establishedClient();
    const { requestId } = s.subscribe(NS, NAME);
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId,
      trackAlias: varint(7n),
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [LOC]]]),
      trackExtensions: new Map(),
    };
    expect(formattingError(s.handleControlMessage(ok))).toBe(false);
  });

  it('PUBLISH with LARGEST_OBJECT as a Location is not a formatting error', () => {
    const s = establishedClient();
    const pub: Publish = {
      type: 'PUBLISH',
      requestId: varint(1n),
      trackNamespace: NS,
      trackName: NAME,
      trackAlias: varint(5n),
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [LOC]]]),
      trackExtensions: new Map(),
    };
    expect(formattingError(s.handleControlMessage(pub))).toBe(false);
  });

  it('REQUEST_OK with LARGEST_OBJECT as a Location is not a formatting error', () => {
    const s = establishedClient();
    const ok: RequestOk = {
      type: 'REQUEST_OK',
      requestId: varint(0n),
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [LOC]]]),
    };
    expect(formattingError(s.handleControlMessage(ok))).toBe(false);
  });
});

describe('typed Location rejected for other parameters', () => {
  it('SUBSCRIBE with FORWARD as a Location → KEY_VALUE_FORMATTING_ERROR', () => {
    const s = establishedServer();
    const sub: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0n),
      trackNamespace: NS,
      trackName: NAME,
      parameters: new Map([[MessageParam.FORWARD, [LOC]]]),
    };
    expect(formattingError(s.handleControlMessage(sub))).toBe(true);
  });

  it('SUBSCRIBE with SUBSCRIPTION_FILTER as a Location → KEY_VALUE_FORMATTING_ERROR', () => {
    const s = establishedServer();
    const sub: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0n),
      trackNamespace: NS,
      trackName: NAME,
      parameters: new Map([[MessageParam.SUBSCRIPTION_FILTER, [LOC]]]),
    };
    expect(formattingError(s.handleControlMessage(sub))).toBe(true);
  });
});

describe('draft-14/16 cannot encode a Location parameter', () => {
  it('createControlCodec(16).encode throws for a Location-valued parameter', () => {
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId: varint(0n),
      trackAlias: varint(7n),
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [LOC]]]),
      trackExtensions: new Map(),
    };
    expect(() => createControlCodec(16).encode(ok)).toThrow(/Location/);
  });
  it('createControlCodec(14).encode rejects a Location-valued parameter', () => {
    // draft-14 encodes FORWARD as an inline field, so it rejects the Location
    // through that path rather than toKvpParams — either way it must throw.
    const sub: Subscribe = {
      type: 'SUBSCRIBE',
      requestId: varint(0n),
      trackNamespace: NS,
      trackName: NAME,
      parameters: new Map([[MessageParam.FORWARD, [LOC]]]),
    };
    expect(() => createControlCodec(14).encode(sub)).toThrow();
  });
});
