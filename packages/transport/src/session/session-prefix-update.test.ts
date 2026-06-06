/**
 * draft-18 §10.9.2 — Updating Namespace Subscriptions.
 *
 * A REQUEST_UPDATE carrying TRACK_NAMESPACE_PREFIX (0x34) changes the Track
 * Namespace Prefix of an established SUBSCRIBE_NAMESPACE or SUBSCRIBE_TRACKS.
 * Overlap is enforced independently per request type (§10.18/§10.19). These
 * tests drive the sans-I/O Session directly (both subscriber and publisher side).
 */
import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, type SendControlAction, type CloseConnectionAction } from './types.js';
import { RequestError } from '../errors.js';
import type {
  Setup, RequestOk, RequestUpdate, RequestErrorMsg, SubscribeNamespace, SubscribeTracks,
} from '../control/messages.js';

const f = (s: string) => new TextEncoder().encode(s);
const PREFIX = 0x34n; // TRACK_NAMESPACE_PREFIX

function client(): Session {
  const c = new Session(EndpointRole.CLIENT, 18);
  c.initiateSetup();
  c.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
  return c;
}

function server(): Session {
  const s = new Session(EndpointRole.SERVER, 18);
  s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
  s.completeSetup();
  return s;
}

const sendControlMsg = (actions: ReturnType<Session['handleControlMessage']>) =>
  (actions.find((a) => a.type === 'send_control') as SendControlAction | undefined)?.message;

describe('outbound prefix update (subscriber side)', () => {
  it('SUBSCRIBE_NAMESPACE: REQUEST_UPDATE creates a pending update applied on REQUEST_OK', () => {
    const c = client();
    const { requestId } = c.subscribeNamespace([f('a')]);
    c.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() } as RequestOk); // → ACTIVE
    expect(c.getNamespaceSubscription(requestId)!.namespacePrefix).toEqual([f('a')]);

    const upd = c.requestUpdate(requestId, { trackNamespacePrefix: [f('a'), f('b')] });
    const msg = (upd.actions[0] as SendControlAction).message as RequestUpdate;
    expect(msg.type).toBe('REQUEST_UPDATE');
    expect(msg.existingRequestId).toBe(requestId);
    expect(msg.parameters.get(PREFIX)).toEqual([[f('a'), f('b')]]);
    // Not applied until the matching REQUEST_OK arrives.
    expect(c.getNamespaceSubscription(requestId)!.namespacePrefix).toEqual([f('a')]);

    c.handleControlMessage({ type: 'REQUEST_OK', requestId: upd.requestId, parameters: new Map() } as RequestOk);
    expect(c.getNamespaceSubscription(requestId)!.namespacePrefix).toEqual([f('a'), f('b')]);
  });

  it('SUBSCRIBE_TRACKS: REQUEST_UPDATE prefix applied on REQUEST_OK', () => {
    const c = client();
    const { requestId } = c.subscribeTracks([f('a')]);
    c.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() } as RequestOk); // → active
    expect(c.getTrackSubscription(requestId)!.state).toBe('active');

    const upd = c.requestUpdate(requestId, { trackNamespacePrefix: [f('c')] });
    expect((upd.actions[0] as SendControlAction).message.type).toBe('REQUEST_UPDATE');
    c.handleControlMessage({ type: 'REQUEST_OK', requestId: upd.requestId, parameters: new Map() } as RequestOk);
    expect(c.getTrackSubscription(requestId)!.trackNamespacePrefix).toEqual([f('c')]);
  });

  it('throws if no trackNamespacePrefix is supplied for a namespace/tracks update', () => {
    const c = client();
    const { requestId } = c.subscribeNamespace([f('a')]);
    c.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() } as RequestOk);
    expect(() => c.requestUpdate(requestId, { forward: 1 })).toThrow(/requires trackNamespacePrefix/i);
  });

  it('throws when trackNamespacePrefix is given for a normal SUBSCRIBE update (no silent no-op)', () => {
    const c = client();
    const { requestId } = c.subscribe([f('a')], f('vid'));
    c.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 7n, parameters: new Map(), trackExtensions: new Map() } as never);
    expect(() => c.requestUpdate(requestId, { trackNamespacePrefix: [f('a')] })).toThrow(/trackNamespacePrefix/i);
  });
});

describe('inbound prefix update (publisher side)', () => {
  function withNamespace(s: Session, rid: bigint, prefix: Uint8Array[]): void {
    s.handleControlMessage({ type: 'SUBSCRIBE_NAMESPACE', requestId: rid, trackNamespacePrefix: prefix, parameters: new Map() } as SubscribeNamespace);
  }
  function withTracks(s: Session, rid: bigint, prefix: Uint8Array[]): void {
    s.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: rid, trackNamespacePrefix: prefix, parameters: new Map() } as SubscribeTracks);
  }
  const update = (s: Session, rid: bigint, existing: bigint, prefix: Uint8Array[]) =>
    s.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: rid, existingRequestId: existing, parameters: new Map([[PREFIX, [prefix]]]) } as RequestUpdate);

  it('SUBSCRIBE_NAMESPACE: accepts a valid prefix update with REQUEST_OK and stores it', () => {
    const s = server();
    withNamespace(s, 0n, [f('a')]);
    s.acceptSubscribeNamespace(0n);
    const actions = update(s, 2n, 0n, [f('a'), f('b')]);
    expect(sendControlMsg(actions)!.type).toBe('REQUEST_OK');
    expect(s.getIncomingNamespaceSubscription(0n)!.namespacePrefix).toEqual([f('a'), f('b')]);
  });

  it('SUBSCRIBE_TRACKS: accepts a valid prefix update with REQUEST_OK and stores it', () => {
    const s = server();
    withTracks(s, 0n, [f('a')]);
    s.acceptSubscribeTracks(0n);
    const actions = update(s, 2n, 0n, [f('z')]);
    expect(sendControlMsg(actions)!.type).toBe('REQUEST_OK');
    expect(s.getIncomingTrackSubscription(0n)!.trackNamespacePrefix).toEqual([f('z')]);
  });

  it('rejects an overlapping prefix with REQUEST_ERROR / PREFIX_OVERLAP (independent per type)', () => {
    const s = server();
    withNamespace(s, 0n, [f('x')]);
    s.acceptSubscribeNamespace(0n);
    withNamespace(s, 2n, [f('y')]); // distinct, no overlap
    s.acceptSubscribeNamespace(2n);
    const actions = update(s, 4n, 0n, [f('y')]); // now collides with rid 2
    const err = sendControlMsg(actions) as RequestErrorMsg;
    expect(err.type).toBe('REQUEST_ERROR');
    expect(err.errorCode).toBe(RequestError.PREFIX_OVERLAP);
  });

  it('a SUBSCRIBE_TRACKS prefix may collide with a SUBSCRIBE_NAMESPACE prefix (independent spaces)', () => {
    const s = server();
    withNamespace(s, 0n, [f('ns')]);
    withTracks(s, 2n, [f('a')]);
    s.acceptSubscribeTracks(2n);
    // Updating the tracks prefix to match the namespace prefix is allowed.
    const actions = update(s, 4n, 2n, [f('ns')]);
    expect(sendControlMsg(actions)!.type).toBe('REQUEST_OK');
    expect(s.getIncomingTrackSubscription(2n)!.trackNamespacePrefix).toEqual([f('ns')]);
  });

  it('closes the session with PROTOCOL_VIOLATION on a malformed (>32-field) prefix', () => {
    const s = server();
    withNamespace(s, 0n, [f('a')]);
    s.acceptSubscribeNamespace(0n);
    const big = Array.from({ length: 33 }, (_, i) => f(`n${i}`));
    const actions = update(s, 2n, 0n, big);
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close).toBeDefined();
  });

  it('a prefix update BEFORE the SUBSCRIBE_NAMESPACE is accepted is a PROTOCOL_VIOLATION', () => {
    const s = server();
    withNamespace(s, 0n, [f('a')]); // pending, not yet accepted
    const actions = update(s, 2n, 0n, [f('a'), f('b')]);
    expect(actions.find((a) => a.type === 'close_connection')).toBeDefined();
    // No update REQUEST_OK was produced.
    expect(actions.find((a) => a.type === 'send_control')).toBeUndefined();
  });

  it('a prefix update BEFORE the SUBSCRIBE_TRACKS is accepted is a PROTOCOL_VIOLATION', () => {
    const s = server();
    withTracks(s, 0n, [f('a')]); // pending
    const actions = update(s, 2n, 0n, [f('b')]);
    expect(actions.find((a) => a.type === 'close_connection')).toBeDefined();
    expect(actions.find((a) => a.type === 'send_control')).toBeUndefined();
  });
});
