import { describe, it, expect } from 'vitest';
import { varint } from '../primitives/varint.js';
import {
  AliasType,
  parseAuthorizationToken,
  encodeAuthorizationToken,
  type AuthorizationToken,
  type DeleteToken,
  type RegisterToken,
  type UseAliasToken,
  type UseValueToken,
} from './auth-token.js';
import { ProtocolViolationError } from '../errors.js';

describe('parseAuthorizationToken', () => {
  // §9.2.2.1, Figure 4: Token { Alias Type (i), [Token Alias (i),], [Token Type (i),], [Token Value (..)] }

  describe('DELETE (0x0)', () => {
    it('parses DELETE with alias', () => {
      // Alias Type = 0x0 (DELETE), Token Alias = 5
      const data = new Uint8Array([0x00, 0x05]);
      const token = parseAuthorizationToken(data);
      expect(token.aliasType).toBe(AliasType.DELETE);
      expect((token as DeleteToken).tokenAlias).toBe(varint(5));
    });

    it('rejects DELETE without alias', () => {
      const data = new Uint8Array([0x00]);
      expect(() => parseAuthorizationToken(data)).toThrow('DELETE token missing Token Alias');
    });

    it('rejects DELETE with trailing bytes', () => {
      const data = new Uint8Array([0x00, 0x05, 0xff]);
      expect(() => parseAuthorizationToken(data)).toThrow('trailing bytes');
    });
  });

  describe('REGISTER (0x1)', () => {
    it('parses REGISTER with alias, type, and value', () => {
      // Alias Type = 0x1, Alias = 1, Type = 42, Value = [0xde, 0xad]
      const data = new Uint8Array([0x01, 0x01, 0x2a, 0xde, 0xad]);
      const token = parseAuthorizationToken(data) as RegisterToken;
      expect(token.aliasType).toBe(AliasType.REGISTER);
      expect(token.tokenAlias).toBe(varint(1));
      expect(token.tokenType).toBe(varint(42));
      expect(token.tokenValue).toEqual(new Uint8Array([0xde, 0xad]));
    });

    it('parses REGISTER with empty token value', () => {
      // Alias Type = 0x1, Alias = 0, Type = 0
      const data = new Uint8Array([0x01, 0x00, 0x00]);
      const token = parseAuthorizationToken(data) as RegisterToken;
      expect(token.aliasType).toBe(AliasType.REGISTER);
      expect(token.tokenAlias).toBe(varint(0));
      expect(token.tokenType).toBe(varint(0));
      expect(token.tokenValue).toEqual(new Uint8Array([]));
    });

    it('rejects REGISTER without alias', () => {
      const data = new Uint8Array([0x01]);
      expect(() => parseAuthorizationToken(data)).toThrow('REGISTER token missing Token Alias');
    });

    it('rejects REGISTER without type', () => {
      const data = new Uint8Array([0x01, 0x01]);
      expect(() => parseAuthorizationToken(data)).toThrow('REGISTER token missing Token Type');
    });
  });

  describe('USE_ALIAS (0x2)', () => {
    it('parses USE_ALIAS with alias', () => {
      const data = new Uint8Array([0x02, 0x03]);
      const token = parseAuthorizationToken(data) as UseAliasToken;
      expect(token.aliasType).toBe(AliasType.USE_ALIAS);
      expect(token.tokenAlias).toBe(varint(3));
    });

    it('rejects USE_ALIAS without alias', () => {
      const data = new Uint8Array([0x02]);
      expect(() => parseAuthorizationToken(data)).toThrow('USE_ALIAS token missing Token Alias');
    });

    it('rejects USE_ALIAS with trailing bytes', () => {
      const data = new Uint8Array([0x02, 0x03, 0xff]);
      expect(() => parseAuthorizationToken(data)).toThrow('trailing bytes');
    });
  });

  describe('USE_VALUE (0x3)', () => {
    it('parses USE_VALUE with type and value', () => {
      // Alias Type = 0x3, Type = 7, Value = [0xca, 0xfe]
      const data = new Uint8Array([0x03, 0x07, 0xca, 0xfe]);
      const token = parseAuthorizationToken(data) as UseValueToken;
      expect(token.aliasType).toBe(AliasType.USE_VALUE);
      expect(token.tokenType).toBe(varint(7));
      expect(token.tokenValue).toEqual(new Uint8Array([0xca, 0xfe]));
    });

    it('parses USE_VALUE with empty value', () => {
      const data = new Uint8Array([0x03, 0x00]);
      const token = parseAuthorizationToken(data) as UseValueToken;
      expect(token.aliasType).toBe(AliasType.USE_VALUE);
      expect(token.tokenType).toBe(varint(0));
      expect(token.tokenValue).toEqual(new Uint8Array([]));
    });

    it('rejects USE_VALUE without type', () => {
      const data = new Uint8Array([0x03]);
      expect(() => parseAuthorizationToken(data)).toThrow('USE_VALUE token missing Token Type');
    });
  });

  describe('error cases', () => {
    it('rejects empty data with ProtocolViolationError', () => {
      try {
        parseAuthorizationToken(new Uint8Array([]));
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolViolationError);
        expect((e as Error).message).toMatch(/Empty/i);
      }
    });

    it('rejects unknown alias type with ProtocolViolationError', () => {
      const data = new Uint8Array([0x04, 0x01]);
      try {
        parseAuthorizationToken(data);
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolViolationError);
        expect((e as Error).message).toMatch(/Unknown/i);
      }
    });

    it('rejects DELETE without alias with ProtocolViolationError', () => {
      const data = new Uint8Array([0x00]);
      try {
        parseAuthorizationToken(data);
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolViolationError);
        expect((e as Error).message).toMatch(/DELETE token missing/i);
      }
    });
  });
});

describe('encodeAuthorizationToken', () => {
  it('encodes DELETE', () => {
    const token: DeleteToken = { aliasType: AliasType.DELETE, tokenAlias: varint(5) };
    const encoded = encodeAuthorizationToken(token);
    expect(encoded).toEqual(new Uint8Array([0x00, 0x05]));
  });

  it('encodes REGISTER', () => {
    const token: RegisterToken = {
      aliasType: AliasType.REGISTER,
      tokenAlias: varint(1),
      tokenType: varint(42),
      tokenValue: new Uint8Array([0xde, 0xad]),
    };
    const encoded = encodeAuthorizationToken(token);
    expect(encoded).toEqual(new Uint8Array([0x01, 0x01, 0x2a, 0xde, 0xad]));
  });

  it('encodes USE_ALIAS', () => {
    const token: UseAliasToken = { aliasType: AliasType.USE_ALIAS, tokenAlias: varint(3) };
    const encoded = encodeAuthorizationToken(token);
    expect(encoded).toEqual(new Uint8Array([0x02, 0x03]));
  });

  it('encodes USE_VALUE', () => {
    const token: UseValueToken = {
      aliasType: AliasType.USE_VALUE,
      tokenType: varint(7),
      tokenValue: new Uint8Array([0xca, 0xfe]),
    };
    const encoded = encodeAuthorizationToken(token);
    expect(encoded).toEqual(new Uint8Array([0x03, 0x07, 0xca, 0xfe]));
  });
});

describe('round-trip encode → decode', () => {
  const tokens: AuthorizationToken[] = [
    { aliasType: AliasType.DELETE, tokenAlias: varint(0) },
    { aliasType: AliasType.DELETE, tokenAlias: varint(255) },
    {
      aliasType: AliasType.REGISTER,
      tokenAlias: varint(1),
      tokenType: varint(0),
      tokenValue: new Uint8Array([]),
    },
    {
      aliasType: AliasType.REGISTER,
      tokenAlias: varint(100),
      tokenType: varint(42),
      tokenValue: new Uint8Array([1, 2, 3, 4, 5]),
    },
    { aliasType: AliasType.USE_ALIAS, tokenAlias: varint(7) },
    {
      aliasType: AliasType.USE_VALUE,
      tokenType: varint(99),
      tokenValue: new Uint8Array([0xff, 0x00, 0xab]),
    },
  ];

  for (const token of tokens) {
    it(`round-trips alias type ${token.aliasType}`, () => {
      const encoded = encodeAuthorizationToken(token);
      const decoded = parseAuthorizationToken(encoded);
      expect(decoded.aliasType).toBe(token.aliasType);

      if ('tokenAlias' in token && 'tokenAlias' in decoded) {
        expect(decoded.tokenAlias).toBe(token.tokenAlias);
      }
      if ('tokenType' in token && 'tokenType' in decoded) {
        expect(decoded.tokenType).toBe(token.tokenType);
      }
      if ('tokenValue' in token && 'tokenValue' in decoded) {
        expect(decoded.tokenValue).toEqual(token.tokenValue);
      }
    });
  }
});
