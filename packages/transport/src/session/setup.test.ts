/**
 * Setup handshake tests.
 * @see draft-ietf-moq-transport-16 §9.3
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SetupGate, SetupError } from './setup.js';
import { SessionState } from './types.js';
import { varint } from '../primitives/varint.js';
import type { ClientSetup, ServerSetup, Parameters, Setup, SetupOptionValue } from '../control/messages.js';
import { SetupParam } from '../control/parameters.js';
import { SetupOption18 } from '../control/codes-18.js';
import { AliasType, encodeAuthorizationToken, encodeAuthorizationToken18, type RegisterToken } from '../control/auth-token.js';

describe('SetupGate', () => {
  describe('client role', () => {
    let gate: SetupGate;

    beforeEach(() => {
      gate = new SetupGate('client');
    });

    it('starts in IDLE state', () => {
      expect(gate.sessionState).toBe(SessionState.IDLE);
      expect(gate.isComplete()).toBe(false);
    });

    it('creates CLIENT_SETUP and transitions to SETUP_PENDING', () => {
      const msg = gate.createClientSetup({ maxRequestId: varint(100n) });

      expect(msg.type).toBe('CLIENT_SETUP');
      expect(msg.parameters.get(varint(SetupParam.MAX_REQUEST_ID))?.[0]).toBe(100n);
      expect(gate.sessionState).toBe(SessionState.SETUP_PENDING);
    });

    it('creates CLIENT_SETUP with all options', () => {
      const msg = gate.createClientSetup({
        maxRequestId: varint(50n),
        path: '/live',
        authority: 'example.com',
        implementation: 'test-client/1.0',
      });

      expect(msg.parameters.get(varint(SetupParam.MAX_REQUEST_ID))?.[0]).toBe(50n);

      const path = msg.parameters.get(varint(SetupParam.PATH))?.[0];
      expect(path).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(path as Uint8Array)).toBe('/live');

      const authority = msg.parameters.get(varint(SetupParam.AUTHORITY))?.[0];
      expect(new TextDecoder().decode(authority as Uint8Array)).toBe('example.com');

      const impl = msg.parameters.get(varint(SetupParam.MOQT_IMPLEMENTATION))?.[0];
      expect(new TextDecoder().decode(impl as Uint8Array)).toBe('test-client/1.0');
    });

    it('handles SERVER_SETUP and completes handshake', () => {
      gate.createClientSetup();

      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(200n)]);
      serverParams.set(
        varint(SetupParam.MOQT_IMPLEMENTATION),
        [new TextEncoder().encode('test-server/1.0')],
      );

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: serverParams,
      };

      const result = gate.handleServerSetup(serverSetup);

      expect(gate.sessionState).toBe(SessionState.ESTABLISHED);
      expect(gate.isComplete()).toBe(true);
      expect(result.peerMaxRequestId).toBe(200n);
      expect(result.peerImplementation).toBe('test-server/1.0');
    });

    it('throws if SERVER_SETUP contains PATH', () => {
      gate.createClientSetup();

      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.PATH), [new TextEncoder().encode('/bad')]);

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: serverParams,
      };

      expect(() => gate.handleServerSetup(serverSetup)).toThrow(SetupError);
      try {
        gate.handleServerSetup(serverSetup);
      } catch (e) {
        expect((e as SetupError).code).toBe('INVALID_PATH');
      }
    });

    it('throws if SERVER_SETUP contains AUTHORITY', () => {
      gate.createClientSetup();

      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('bad.com')]);

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: serverParams,
      };

      expect(() => gate.handleServerSetup(serverSetup)).toThrow(SetupError);
      try {
        gate.handleServerSetup(serverSetup);
      } catch (e) {
        expect((e as SetupError).code).toBe('INVALID_AUTHORITY');
      }
    });

    it('throws if trying to create CLIENT_SETUP twice', () => {
      gate.createClientSetup();
      expect(() => gate.createClientSetup()).toThrow();
    });

    it('cannot create SERVER_SETUP as client', () => {
      expect(() => gate.createServerSetup()).toThrow();
    });

    it('cannot handle CLIENT_SETUP as client', () => {
      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: new Map(),
      };
      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });
  });

  describe('server role', () => {
    let gate: SetupGate;

    beforeEach(() => {
      gate = new SetupGate('server');
    });

    it('starts in IDLE state', () => {
      expect(gate.sessionState).toBe(SessionState.IDLE);
    });

    it('handles CLIENT_SETUP and transitions to SETUP_PENDING', () => {
      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]);
      clientParams.set(varint(SetupParam.PATH), [new TextEncoder().encode('/live')]);
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('example.com')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      const result = gate.handleClientSetup(clientSetup);

      expect(gate.sessionState).toBe(SessionState.SETUP_PENDING);
      expect(result.peerMaxRequestId).toBe(100n);
      expect(result.path).toBe('/live');
      expect(result.authority).toBe('example.com');
    });

    it('creates SERVER_SETUP and completes handshake', () => {
      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: new Map(),
      };
      gate.handleClientSetup(clientSetup);

      const msg = gate.createServerSetup({
        maxRequestId: varint(200n),
        implementation: 'test-server/1.0',
      });

      expect(msg.type).toBe('SERVER_SETUP');
      expect(msg.parameters.get(varint(SetupParam.MAX_REQUEST_ID))?.[0]).toBe(200n);
      expect(gate.sessionState).toBe(SessionState.ESTABLISHED);
      expect(gate.isComplete()).toBe(true);
    });

    it('cannot create CLIENT_SETUP as server', () => {
      expect(() => gate.createClientSetup()).toThrow();
    });

    it('cannot handle SERVER_SETUP as server', () => {
      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map(),
      };
      expect(() => gate.handleServerSetup(serverSetup)).toThrow(SetupError);
    });

    it('cannot create SERVER_SETUP before CLIENT_SETUP', () => {
      expect(() => gate.createServerSetup()).toThrow();
    });
  });

  describe('message validation', () => {
    it('client rejects receiving messages before sending CLIENT_SETUP', () => {
      const gate = new SetupGate('client');

      expect(() =>
        gate.validateMessage({ type: 'GOAWAY', newSessionUri: '' }),
      ).toThrow(SetupError);
    });

    it('server rejects non-CLIENT_SETUP as first message', () => {
      const gate = new SetupGate('server');

      expect(() =>
        gate.validateMessage({ type: 'GOAWAY', newSessionUri: '' }),
      ).toThrow(SetupError);

      expect(() =>
        gate.validateMessage({
          type: 'SERVER_SETUP',
          parameters: new Map(),
        }),
      ).toThrow(SetupError);
    });

    it('server accepts CLIENT_SETUP as first message', () => {
      const gate = new SetupGate('server');

      expect(() =>
        gate.validateMessage({
          type: 'CLIENT_SETUP',
          parameters: new Map(),
        }),
      ).not.toThrow();
    });

    it('client rejects non-SERVER_SETUP while pending', () => {
      const gate = new SetupGate('client');
      gate.createClientSetup();

      expect(() =>
        gate.validateMessage({ type: 'GOAWAY', newSessionUri: '' }),
      ).toThrow(SetupError);

      expect(() =>
        gate.validateMessage({
          type: 'CLIENT_SETUP',
          parameters: new Map(),
        }),
      ).toThrow(SetupError);
    });
  });

  describe('unknown parameters', () => {
    it('ignores unknown setup parameters', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]);
      clientParams.set(varint(0xFFFFn), [new TextEncoder().encode('unknown')]); // Unknown param

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      // Should not throw
      const result = gate.handleClientSetup(clientSetup);
      expect(result.peerMaxRequestId).toBe(100n);
    });
  });

  describe('getResult', () => {
    it('throws if called before handshake complete', () => {
      const gate = new SetupGate('client');
      expect(() => gate.getResult()).toThrow();

      gate.createClientSetup();
      expect(() => gate.getResult()).toThrow();
    });

    it('returns result after handshake complete', () => {
      const gate = new SetupGate('client');
      gate.createClientSetup();

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(50n)]]]),
      };
      gate.handleServerSetup(serverSetup);

      const result = gate.getResult();
      expect(result.peerMaxRequestId).toBe(50n);
    });
  });

  describe('default MAX_REQUEST_ID', () => {
    it('defaults to 0 if not provided (§9.3.1.3)', () => {
      // Per §9.3.1.3: absent MAX_REQUEST_ID means 0 (peer MUST NOT send requests).
      const gate = new SetupGate('client');
      gate.createClientSetup();

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map(), // No MAX_REQUEST_ID
      };

      const result = gate.handleServerSetup(serverSetup);
      expect(result.peerMaxRequestId).toBe(0n);
    });
  });

  describe('PATH validation (§9.3.1.2)', () => {
    it('accepts valid absolute paths', () => {
      const gate = new SetupGate('server');

      const validPaths = [
        '/',
        '/live',
        '/live/stream',
        '/path/with-dashes',
        '/path/with_underscores',
        '/path/with.dots',
        '/path/with%20encoding',
        '/path/~tilde',
        // Query strings are explicitly allowed per spec
        '/moq?query=value',
        '/live/stream?token=abc123',
        '/path?foo=bar&baz=qux',
        '/?query',
        // path-abempty allows empty path with query (§9.3.1.2)
        '?query',
        '?foo=bar',
        '?',
      ];

      for (const path of validPaths) {
        const newGate = new SetupGate('server');
        const clientParams: Parameters = new Map();
        clientParams.set(varint(SetupParam.PATH), [new TextEncoder().encode(path)]);

        const clientSetup: ClientSetup = {
          type: 'CLIENT_SETUP',
          parameters: clientParams,
        };

        expect(() => newGate.handleClientSetup(clientSetup)).not.toThrow();
      }
    });

    it('rejects paths not starting with /', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.PATH), [new TextEncoder().encode('live')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
      try {
        gate.handleClientSetup(clientSetup);
      } catch (e) {
        expect((e as SetupError).code).toBe('MALFORMED_PATH');
      }
    });

    it('rejects malformed percent encoding', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.PATH), [new TextEncoder().encode('/path/%GG')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });
  });

  describe('AUTHORITY validation (§9.3.1.1)', () => {
    it('accepts valid authorities (full RFC3986)', () => {
      const validAuthorities = [
        'example.com',
        'example.com:4433',
        'localhost',
        'localhost:8080',
        '127.0.0.1',
        '127.0.0.1:4433',
        '[::1]',
        '[::1]:4433',
        '[2001:db8::1]',
        'sub.domain.example.com',
        // userinfo is allowed per RFC3986
        'user@example.com',
        'user:pass@example.com',
        'user@example.com:4433',
        // IPvFuture
        '[v1.test]',
        '[vFF.something:more]',
        // IPv6 with embedded IPv4
        '[::ffff:192.168.1.1]',
        // IPv6 with :: directly before embedded IPv4
        '[::192.0.2.1]',
        '[2001:db8::192.0.2.1]',
        '[1:2:3:4:5::192.0.2.1]',
        // Empty port (valid per RFC3986)
        'example.com:',
      ];

      for (const authority of validAuthorities) {
        const gate = new SetupGate('server');
        const clientParams: Parameters = new Map();
        clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode(authority)]);

        const clientSetup: ClientSetup = {
          type: 'CLIENT_SETUP',
          parameters: clientParams,
        };

        expect(() => gate.handleClientSetup(clientSetup)).not.toThrow();
      }
    });

    it('rejects empty authority', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
      try {
        gate.handleClientSetup(clientSetup);
      } catch (e) {
        expect((e as SetupError).code).toBe('MALFORMED_AUTHORITY');
      }
    });

    it('rejects empty host with port (§3.1.2)', () => {
      // §3.1.2: "The authority portion MUST NOT contain an empty host portion"
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode(':443')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
      try {
        gate.handleClientSetup(clientSetup);
      } catch (e) {
        expect((e as SetupError).code).toBe('MALFORMED_AUTHORITY');
      }
    });

    it('rejects unclosed IPv6 bracket', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('[::1')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects invalid port number', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('example.com:99999')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects malformed IPv6 with multiple zero-compression', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // [:::] has three consecutive colons, which is two overlapping :: compressions
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('[:::]')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
      try {
        gate.handleClientSetup(clientSetup);
      } catch (e) {
        expect((e as SetupError).code).toBe('MALFORMED_AUTHORITY');
      }
    });

    it('rejects IPv6 with too many segments', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // Too many segments without compression
      clientParams.set(
        varint(SetupParam.AUTHORITY),
        [new TextEncoder().encode('[1:2:3:4:5:6:7:8:9]')],
      );

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 with invalid segment', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // 'gggg' is not valid hex
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('[::gggg]')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 with invalid embedded IPv4', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // 999 > 255
      clientParams.set(
        varint(SetupParam.AUTHORITY),
        [new TextEncoder().encode('[::ffff:192.168.1.999]')],
      );

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 with embedded IPv4 having leading zeros', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // Leading zeros are forbidden per RFC3986 dec-octet
      clientParams.set(
        varint(SetupParam.AUTHORITY),
        [new TextEncoder().encode('[::ffff:192.168.01.1]')],
      );

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 where :: compresses zero segments (trailing ::)', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // 8 segments plus :: means :: compresses nothing
      clientParams.set(
        varint(SetupParam.AUTHORITY),
        [new TextEncoder().encode('[1:2:3:4:5:6:7:8::]')],
      );

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 where :: compresses zero segments (leading ::)', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // :: followed by 8 segments means :: compresses nothing
      clientParams.set(
        varint(SetupParam.AUTHORITY),
        [new TextEncoder().encode('[::1:2:3:4:5:6:7:8]')],
      );

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 with stray leading colon', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // :1::2 has a single : before 1, not part of ::
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('[:1::2]')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });

    it('rejects IPv6 with stray trailing colon', () => {
      const gate = new SetupGate('server');

      const clientParams: Parameters = new Map();
      // 1::2: has a single : after 2, not part of ::
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('[1::2:]')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      expect(() => gate.handleClientSetup(clientSetup)).toThrow(SetupError);
    });
  });

  // ─── AUTHORIZATION_TOKEN + MAX_AUTH_TOKEN_CACHE_SIZE ─────────────────

  describe('AUTHORIZATION_TOKEN parsing (§9.2.2.1, §9.3.1.5)', () => {
    it('parses MAX_AUTH_TOKEN_CACHE_SIZE from CLIENT_SETUP', () => {
      const gate = new SetupGate('server');

      const params: Parameters = new Map();
      params.set(varint(SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE), [varint(1024n)]);

      const result = gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      });

      expect(result.peerMaxAuthTokenCacheSize).toBe(varint(1024n));
    });

    it('parses MAX_AUTH_TOKEN_CACHE_SIZE from SERVER_SETUP', () => {
      const gate = new SetupGate('client');
      gate.createClientSetup();

      const params: Parameters = new Map();
      params.set(varint(SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE), [varint(512n)]);

      const result = gate.handleServerSetup({
        type: 'SERVER_SETUP',
        parameters: params,
      });

      expect(result.peerMaxAuthTokenCacheSize).toBe(varint(512n));
    });

    it('parses REGISTER tokens from CLIENT_SETUP', () => {
      const gate = new SetupGate('server');

      const tokenBytes = encodeAuthorizationToken({
        aliasType: AliasType.REGISTER,
        tokenAlias: varint(1),
        tokenType: varint(42),
        tokenValue: new Uint8Array([0xde, 0xad]),
      });

      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [tokenBytes]);

      const result = gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      });

      expect(result.authTokens).toHaveLength(1);
      expect(result.authTokens![0].aliasType).toBe(AliasType.REGISTER);
    });

    it('parses USE_VALUE tokens from CLIENT_SETUP', () => {
      const gate = new SetupGate('server');

      const tokenBytes = encodeAuthorizationToken({
        aliasType: AliasType.USE_VALUE,
        tokenType: varint(7),
        tokenValue: new Uint8Array([0xca, 0xfe]),
      });

      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [tokenBytes]);

      const result = gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      });

      expect(result.authTokens).toHaveLength(1);
      expect(result.authTokens![0].aliasType).toBe(AliasType.USE_VALUE);
    });

    it('parses multiple tokens from CLIENT_SETUP', () => {
      const gate = new SetupGate('server');

      const token1 = encodeAuthorizationToken({
        aliasType: AliasType.REGISTER,
        tokenAlias: varint(1),
        tokenType: varint(1),
        tokenValue: new Uint8Array([0x01]),
      });
      const token2 = encodeAuthorizationToken({
        aliasType: AliasType.USE_VALUE,
        tokenType: varint(2),
        tokenValue: new Uint8Array([0x02]),
      });

      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [token1, token2]);

      const result = gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      });

      expect(result.authTokens).toHaveLength(2);
    });

    it('rejects DELETE in CLIENT_SETUP (§9.2.2.1)', () => {
      // §9.2.2.1: "If a server receives Alias Type DELETE (0x0) or USE_ALIAS (0x2)
      // in a CLIENT_SETUP message, it MUST close the session with a PROTOCOL_VIOLATION."
      const gate = new SetupGate('server');

      const tokenBytes = encodeAuthorizationToken({
        aliasType: AliasType.DELETE,
        tokenAlias: varint(1),
      });

      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [tokenBytes]);

      expect(() => gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      })).toThrow(SetupError);

      try {
        gate.handleClientSetup({
          type: 'CLIENT_SETUP',
          parameters: params,
        });
      } catch (e) {
        expect((e as SetupError).code).toBe('PROTOCOL_VIOLATION');
        expect((e as SetupError).message).toContain('DELETE');
      }
    });

    it('rejects USE_ALIAS in CLIENT_SETUP (§9.2.2.1)', () => {
      const gate = new SetupGate('server');

      const tokenBytes = encodeAuthorizationToken({
        aliasType: AliasType.USE_ALIAS,
        tokenAlias: varint(1),
      });

      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [tokenBytes]);

      expect(() => gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      })).toThrow(SetupError);
    });

    it('rejects malformed AUTHORIZATION_TOKEN', () => {
      const gate = new SetupGate('server');

      // Truncated: just alias type, no alias field
      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [new Uint8Array([0x00])]);

      expect(() => gate.handleClientSetup({
        type: 'CLIENT_SETUP',
        parameters: params,
      })).toThrow(SetupError);
    });

    it('rejects malformed AUTHORIZATION_TOKEN with KEY_VALUE_FORMATTING_ERROR code (§9.2.2.1)', () => {
      // §9.2.2.1: "If the Token structure cannot be decoded, the receiver
      //            MUST close the Session with KEY_VALUE_FORMATTING_ERROR."
      const gate = new SetupGate('server');

      // Truncated: just alias type, no alias field
      const params: Parameters = new Map();
      params.set(varint(SetupParam.AUTHORIZATION_TOKEN), [new Uint8Array([0x00])]);

      try {
        gate.handleClientSetup({
          type: 'CLIENT_SETUP',
          parameters: params,
        });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(SetupError);
        expect((e as SetupError).code).toBe('KEY_VALUE_FORMATTING_ERROR');
      }
    });

    it('includes MAX_AUTH_TOKEN_CACHE_SIZE in createClientSetup', () => {
      const gate = new SetupGate('client');
      const msg = gate.createClientSetup({ maxAuthTokenCacheSize: varint(2048n) });
      const values = msg.parameters.get(varint(SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE));
      expect(values).toBeDefined();
      expect(values![0]).toBe(2048n);
    });

    it('includes MAX_AUTH_TOKEN_CACHE_SIZE in createServerSetup', () => {
      const gate = new SetupGate('server');
      gate.handleClientSetup({ type: 'CLIENT_SETUP', parameters: new Map() });
      const msg = gate.createServerSetup({ maxAuthTokenCacheSize: varint(4096n) });
      const values = msg.parameters.get(varint(SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE));
      expect(values).toBeDefined();
      expect(values![0]).toBe(4096n);
    });
  });

  // ─── draft-18 AUTHORIZATION_TOKEN (vi64 inner Token structure) ─────────
  describe('draft-18 AUTHORIZATION_TOKEN parsing (§9.2.2.1, vi64 internals)', () => {
    it('parses a SETUP REGISTER token whose Token Alias / Token Type exceed the QUIC range', () => {
      // draft-18 encodes the inner Token's Alias/Type as vi64 (full uint64), so a
      // d18 SETUP must parse the option bytes with the vi64 parser. The semantic
      // values must survive exactly — 2^63 is above the QUIC-varint ceiling and
      // could not even be produced by the legacy QUIC-varint encoder.
      const big = 1n << 63n; // > 2^62-1
      const gate = new SetupGate('server', 18); // server interprets the peer SETUP
      const tokenBytes = encodeAuthorizationToken18({
        aliasType: AliasType.REGISTER,
        tokenAlias: big,
        tokenType: big,
        tokenValue: new Uint8Array([0xab, 0xcd]),
      });
      const setupOptions = new Map<bigint, SetupOptionValue[]>([
        [BigInt(SetupOption18.AUTHORIZATION_TOKEN), [tokenBytes]],
      ]);

      const result = gate.handleSetup18({ type: 'SETUP', setupOptions } as Setup);

      expect(result.authTokens).toHaveLength(1);
      const token = result.authTokens![0] as RegisterToken;
      expect(token.aliasType).toBe(AliasType.REGISTER);
      expect(token.tokenAlias).toBe(big);
      expect(token.tokenType).toBe(big);
      expect(token.tokenValue).toEqual(new Uint8Array([0xab, 0xcd]));
    });
  });
});
