/**
 * draft-18 unified SETUP interpretation in the Session (Slice C, skeletal).
 *
 * The codec produces a role-neutral SETUP; the session interprets it by role.
 * draft-18 does not require or emit MAX_REQUEST_ID, and draft-14/16 behavior is
 * unaffected (covered by the existing setup tests).
 */
import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SessionState, type SendControlAction, type CloseConnectionAction } from './types.js';
import { SetupGate, SetupError } from './setup.js';
import { SetupOption18 } from '../control/codes-18.js';
import { AliasType, encodeAuthorizationToken18 } from '../control/auth-token.js';
import { createControlCodec } from '../control/codec.js';
import { varint } from '../primitives/varint.js';
import type { Setup, Subscribe } from '../control/messages.js';

const MOQT_IMPL = BigInt(SetupOption18.MOQT_IMPLEMENTATION);

describe('draft-18 client SETUP', () => {
  it('initiateSetup emits a unified SETUP (not CLIENT_SETUP) with no MAX_REQUEST_ID', () => {
    const client = new Session(EndpointRole.CLIENT, 18);
    const actions = client.initiateSetup({ implementation: 'playa' });
    expect(client.state).toBe(SessionState.SETUP_PENDING);
    const msg = (actions[0] as SendControlAction).message as Setup;
    expect(msg.type).toBe('SETUP');
    expect(msg.setupOptions.has(MOQT_IMPL)).toBe(true);
    // draft-18 has no MAX_REQUEST_ID option (0x02); none should be present.
    expect(msg.setupOptions.has(0x02n)).toBe(false);
  });

  it('reaches ESTABLISHED on the peer SETUP, with peerMaxRequestId = 0 (no credit)', () => {
    const client = new Session(EndpointRole.CLIENT, 18);
    client.initiateSetup();
    client.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    expect(client.state).toBe(SessionState.ESTABLISHED);
    expect(client.peerMaxRequestId).toBe(0n);
  });

  it('interprets Setup Options into a role-neutral result (no MAX_REQUEST_ID)', () => {
    const gate = new SetupGate(EndpointRole.CLIENT, 18);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([
      [MOQT_IMPL, [new TextEncoder().encode('relay/1.0')]],
      [BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE), [4096n]],
    ]);
    const result = gate.handleSetup18({ type: 'SETUP', setupOptions: opts });
    expect(result.peerImplementation).toBe('relay/1.0');
    expect(result.peerMaxAuthTokenCacheSize).toBe(4096n);
    expect(result.peerMaxRequestId).toBe(0n); // draft-18 has no request credit
  });
});

describe('draft-18 server SETUP', () => {
  it('handles the client SETUP then completes with its own SETUP', () => {
    const server = new Session(EndpointRole.SERVER, 18);
    server.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    expect(server.state).toBe(SessionState.SETUP_PENDING);
    const actions = server.completeSetup({ implementation: 'srv' });
    expect(server.state).toBe(SessionState.ESTABLISHED);
    const msg = (actions[0] as SendControlAction).message as Setup;
    expect(msg.type).toBe('SETUP');
    expect(msg.setupOptions.has(MOQT_IMPL)).toBe(true);
  });

  it('rejects a non-SETUP first message before established', () => {
    const server = new Session(EndpointRole.SERVER, 18);
    const sub = {
      type: 'SUBSCRIBE', requestId: 0n,
      trackNamespace: [new Uint8Array([1])], trackName: new Uint8Array([2]), parameters: new Map(),
    } as Subscribe;
    const actions = server.handleControlMessage(sub);
    expect(actions.some((a) => a.type === 'close_connection')).toBe(true);
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction;
    expect(close.reason).toMatch(/SETUP/i);
  });
});

describe('draft-18 NATIVE-QUIC role-level PATH / AUTHORITY policy (parity with 14/16)', () => {
  it('client rejects a server SETUP containing PATH', () => {
    const gate = new SetupGate(EndpointRole.CLIENT, 18);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([
      [BigInt(SetupOption18.PATH), [new TextEncoder().encode('/x')]],
    ]);
    expect(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts })).toThrow(/PATH or AUTHORITY/i);
  });

  it('client rejects a server SETUP containing AUTHORITY', () => {
    const gate = new SetupGate(EndpointRole.CLIENT, 18);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([
      [BigInt(SetupOption18.AUTHORITY), [new TextEncoder().encode('host')]],
    ]);
    expect(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts })).toThrow(/PATH or AUTHORITY/i);
  });

  it('server accepts a client SETUP containing PATH over NATIVE QUIC (decoded, not rejected)', () => {
    const gate = new SetupGate(EndpointRole.SERVER, 18); // not WebTransport → native rules
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([
      [BigInt(SetupOption18.PATH), [new TextEncoder().encode('/live')]],
    ]);
    const result = gate.handleSetup18({ type: 'SETUP', setupOptions: opts });
    expect(result.path).toBe('/live');
  });
});

describe('draft-18 WebTransport PATH / AUTHORITY policy (§10.3.1.1/§10.3.1.2)', () => {
  const codeOf = (fn: () => unknown): string | undefined => {
    try { fn(); } catch (e) { return e instanceof SetupError ? e.code : 'OTHER'; }
    return undefined;
  };
  it('over WebTransport, a server receiving a client SETUP with PATH closes with INVALID_PATH', () => {
    const gate = new SetupGate(EndpointRole.SERVER, 18, true); // webtransport
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.PATH), [new TextEncoder().encode('/live')]]]);
    expect(codeOf(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts }))).toBe('INVALID_PATH');
  });
  it('over WebTransport, a SETUP with AUTHORITY closes with INVALID_AUTHORITY', () => {
    const gate = new SetupGate(EndpointRole.SERVER, 18, true);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.AUTHORITY), [new TextEncoder().encode('host')]]]);
    expect(codeOf(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts }))).toBe('INVALID_AUTHORITY');
  });
  it('a WebTransport Session(server) closes the connection with INVALID_PATH on an inbound SETUP with PATH', () => {
    const s = new Session(EndpointRole.SERVER, 18, { webtransport: true });
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.PATH), [new TextEncoder().encode('/live')]]]);
    const actions = s.handleControlMessage({ type: 'SETUP', setupOptions: opts } as Setup);
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close?.error).toBe(0x8n); // INVALID_PATH
  });
});

describe('draft-18 MAX_AUTH_TOKEN_CACHE_SIZE is vi64 (§10.3.1.3)', () => {
  it('accepts and stores an above-QUIC value (2^63)', () => {
    const big = 1n << 63n; // > 2^62-1
    const gate = new SetupGate(EndpointRole.CLIENT, 18);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE), [big]]]);
    const result = gate.handleSetup18({ type: 'SETUP', setupOptions: opts });
    expect(result.peerMaxAuthTokenCacheSize).toBe(big);
  });
  it('surfaces the full-uint64 value on the Session getter', () => {
    const big = (1n << 64n) - 1n;
    const c = new Session(EndpointRole.CLIENT, 18);
    c.initiateSetup();
    c.handleControlMessage({ type: 'SETUP', setupOptions: new Map([[BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE), [big]]]) } as Setup);
    expect(c.peerMaxAuthTokenCacheSize).toBe(big);
  });
});

describe('draft-18 repeated Setup Options on receive (§10.3)', () => {
  const f = (s: string) => new TextEncoder().encode(s);
  const codeOf = (fn: () => unknown): string | undefined => {
    try { fn(); } catch (e) { return e instanceof SetupError ? e.code : 'OTHER'; }
    return undefined;
  };
  it('rejects a repeated known singleton (MAX_AUTH_TOKEN_CACHE_SIZE) with PROTOCOL_VIOLATION', () => {
    const gate = new SetupGate(EndpointRole.CLIENT, 18);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE), [4096n, 8192n]]]);
    expect(codeOf(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts }))).toBe('PROTOCOL_VIOLATION');
  });
  it('rejects a repeated known singleton (PATH, native QUIC) with PROTOCOL_VIOLATION', () => {
    const gate = new SetupGate(EndpointRole.SERVER, 18); // native; PATH allowed once
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.PATH), [f('/a'), f('/b')]]]);
    expect(codeOf(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts }))).toBe('PROTOCOL_VIOLATION');
  });
  it('allows a repeated UNKNOWN option', () => {
    const gate = new SetupGate(EndpointRole.CLIENT, 18);
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[0x40n, [1n, 2n]]]); // unknown even-type option
    expect(() => gate.handleSetup18({ type: 'SETUP', setupOptions: opts })).not.toThrow();
  });
  it('allows a repeated AUTHORIZATION_TOKEN (explicitly repeatable)', () => {
    const gate = new SetupGate(EndpointRole.SERVER, 18);
    const tok = encodeAuthorizationToken18({ aliasType: AliasType.USE_VALUE, tokenType: 1n, tokenValue: new Uint8Array([0x01]) });
    const opts = new Map<bigint, (bigint | Uint8Array)[]>([[BigInt(SetupOption18.AUTHORIZATION_TOKEN), [tok, tok]]]);
    const result = gate.handleSetup18({ type: 'SETUP', setupOptions: opts }); // singleton guard MUST NOT fire
    expect(result.authTokens).toHaveLength(2);
  });
});

describe('draft-16 setup behavior is unchanged', () => {
  it('still emits CLIENT_SETUP', () => {
    const client = new Session(EndpointRole.CLIENT, 16);
    const actions = client.initiateSetup();
    expect((actions[0] as SendControlAction).message.type).toBe('CLIENT_SETUP');
  });
});

describe('outbound MAX_AUTH_TOKEN_CACHE_SIZE: draft-18 full vi64; draft-14/16 range-guarded (§10.3.1.3)', () => {
  const big = 1n << 63n; // > 2^62-1
  it('createSetup18 emits an above-QUIC value (2^63) in the SETUP options', () => {
    const setup = new SetupGate(EndpointRole.CLIENT, 18).createSetup18({ maxAuthTokenCacheSize: big });
    expect(setup.setupOptions.get(BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE))).toEqual([big]);
  });
  it('initiateSetup(18) emits a SETUP carrying the above-QUIC value', () => {
    const c = new Session(EndpointRole.CLIENT, 18);
    const actions = c.initiateSetup({ maxAuthTokenCacheSize: big });
    const setup = (actions[0] as SendControlAction).message as Setup;
    expect(setup.setupOptions.get(BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE))).toEqual([big]);
  });
  it('draft-16 setup encode REJECTS an above-QUIC MAX_AUTH_TOKEN_CACHE_SIZE (RangeError)', () => {
    const msg = new SetupGate(EndpointRole.CLIENT, 16).createClientSetup({ maxAuthTokenCacheSize: big });
    expect(() => createControlCodec(16).encode(msg)).toThrow(RangeError);
  });
  it('draft-14 setup encode REJECTS an above-QUIC MAX_AUTH_TOKEN_CACHE_SIZE (RangeError)', () => {
    const msg = new SetupGate(EndpointRole.CLIENT, 14).createClientSetup({ maxAuthTokenCacheSize: big });
    expect(() => createControlCodec(14).encode(msg)).toThrow(RangeError);
  });
  it('draft-16 still encodes a small MAX_AUTH_TOKEN_CACHE_SIZE', () => {
    const msg = new SetupGate(EndpointRole.CLIENT, 16).createClientSetup({ maxAuthTokenCacheSize: 2048n });
    expect(() => createControlCodec(16).encode(msg)).not.toThrow();
  });
});
