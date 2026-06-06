/**
 * RequestEndpoint correlation seam on Session.handleControlMessage.
 *
 * Slice A: the optional `endpoint` argument is additive and inert for draft-14/16
 * (responses carry their Request ID on the wire). These tests prove two things:
 *   1. Passing an endpoint does not change draft-16 behavior (backward compatible).
 *   2. The seam genuinely works: a response whose Request ID is *absent* (as a
 *      draft-18 response would be after decode) correlates correctly when the
 *      topology supplies the Request ID via `endpoint` — no placeholder needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SubscriptionState } from './types.js';
import { varint } from '../primitives/varint.js';
import { SetupParam } from '../control/parameters.js';
import type { ServerSetup, ClientSetup, SubscribeOk, RequestUpdate } from '../control/messages.js';
import type { CloseConnectionAction } from './types.js';
import type { RequestEndpoint } from './request-endpoint.js';

const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

function established(): Session {
  const session = new Session(EndpointRole.CLIENT);
  session.initiateSetup({ maxRequestId: varint(100n) });
  const serverSetup: ServerSetup = {
    type: 'SERVER_SETUP',
    parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
  };
  session.handleControlMessage(serverSetup);
  return session;
}

describe('handleControlMessage(msg, endpoint?)', () => {
  let session: Session;

  beforeEach(() => {
    session = established();
  });

  it('is backward compatible: SUBSCRIBE_OK with wire requestId, no endpoint', () => {
    const { requestId } = session.subscribe(namespace, name);
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId: varint(requestId),
      trackAlias: varint(7n),
      parameters: new Map(),
      trackExtensions: new Map(),
    };
    session.handleControlMessage(ok);
    expect(session.getSubscription(requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
  });

  it('passing a matching endpoint does not change behavior', () => {
    const { requestId } = session.subscribe(namespace, name);
    const ok: SubscribeOk = {
      type: 'SUBSCRIBE_OK',
      requestId: varint(requestId),
      trackAlias: varint(7n),
      parameters: new Map(),
      trackExtensions: new Map(),
    };
    const endpoint: RequestEndpoint = { requestId };
    session.handleControlMessage(ok, endpoint);
    expect(session.getSubscription(requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
  });

  it('correlates a response whose Request ID is absent, using the endpoint', () => {
    const { requestId } = session.subscribe(namespace, name);
    // Simulate a draft-18 decoded response: requestId omitted on the wire.
    const okNoId = {
      type: 'SUBSCRIBE_OK',
      trackAlias: varint(7n),
      parameters: new Map(),
      trackExtensions: new Map(),
    } as unknown as SubscribeOk;
    const endpoint: RequestEndpoint = { requestId };
    const actions = session.handleControlMessage(okNoId, endpoint);
    // Must NOT have closed with INVALID_REQUEST_ID; subscription is established.
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
    expect(session.getSubscription(requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
  });

  it('carries a full-uint64 endpoint requestId without re-branding through varint() (Codex)', () => {
    const big = 1n << 63n; // > 2^62-1: would throw if passed through varint()
    const okNoId = {
      type: 'SUBSCRIBE_OK',
      trackAlias: varint(7n),
      parameters: new Map(),
      trackExtensions: new Map(),
    } as unknown as SubscribeOk;
    const endpoint: RequestEndpoint = { requestId: big };
    // Must NOT throw RangeError. With no subscription for `big`, it closes as an
    // unknown request — the point is the endpoint seam carries full uint64.
    let actions!: ReturnType<Session['handleControlMessage']>;
    expect(() => {
      actions = session.handleControlMessage(okNoId, endpoint);
    }).not.toThrow();
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close?.reason).toContain((1n << 63n).toString());
  });

  it('without the endpoint, an Request-ID-less response cannot correlate', () => {
    session.subscribe(namespace, name);
    const okNoId = {
      type: 'SUBSCRIBE_OK',
      trackAlias: varint(7n),
      parameters: new Map(),
      trackExtensions: new Map(),
    } as unknown as SubscribeOk;
    // No endpoint, no wire requestId → cannot map → protocol close (not a crash).
    const actions = session.handleControlMessage(okNoId);
    expect(actions.some((a) => a.type === 'close_connection')).toBe(true);
  });
});

describe('handleControlMessage — REQUEST_UPDATE endpoint context (Codex note #3)', () => {
  function establishedServer(): Session {
    const s = new Session(EndpointRole.SERVER);
    const clientSetup: ClientSetup = { type: 'CLIENT_SETUP', parameters: new Map() };
    s.handleControlMessage(clientSetup);
    s.completeSetup({ maxRequestId: varint(200n) });
    return s;
  }

  it('fills existingRequestId from the endpoint, NOT from the update\'s own requestId', () => {
    const server = establishedServer();
    // Draft-18 wire shape: REQUEST_UPDATE carries its own (new) Request ID = 0
    // (first valid incoming client ID), but omits "Existing Request ID".
    const update = {
      type: 'REQUEST_UPDATE',
      requestId: varint(0n),
      parameters: new Map(),
    } as unknown as RequestUpdate;
    // Topology recovers the target (existing request) from stream context.
    const endpoint: RequestEndpoint = { requestId: 0n, existingRequestId: 999n };

    const actions = server.handleControlMessage(update, endpoint);

    // The handler looks up Existing Request ID 999 (unknown) → PROTOCOL_VIOLATION
    // that references 999, proving the endpoint's existingRequestId was used and
    // the update's own requestId (0) was neither used as the target nor clobbered
    // (if requestId had been overwritten with 999 > max 200, we'd get a different
    // INVALID/too-many error referencing the new ID instead).
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close).toBeDefined();
    expect(close!.reason).toContain('999');
    expect(close!.reason).toMatch(/Existing Request ID/i);
  });

  it('does not overwrite a REQUEST_UPDATE requestId that is present on the wire', () => {
    const server = establishedServer();
    // requestId present (0) AND existingRequestId present (also via wire = 4, unknown).
    const update = {
      type: 'REQUEST_UPDATE',
      requestId: varint(0n),
      existingRequestId: varint(4n),
      parameters: new Map(),
    } as RequestUpdate;
    // Endpoint also supplied, but since wire fields are present it must be inert.
    const endpoint: RequestEndpoint = { requestId: 0n, existingRequestId: 999n };

    const actions = server.handleControlMessage(update, endpoint);
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close).toBeDefined();
    // Wire existingRequestId (4) wins; the endpoint's 999 must NOT override it.
    expect(close!.reason).toContain('4');
    expect(close!.reason).not.toContain('999');
  });
});
