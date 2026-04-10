import { describe, it, expect } from 'vitest';
import { varint } from '../primitives/varint.js';
import { AuthTokenCache, AuthCacheError } from './auth-cache.js';

describe('AuthTokenCache', () => {
  // §9.3.1.4: entry size = 16 + tokenValue.length

  describe('register + resolve', () => {
    it('registers and resolves a token', () => {
      const cache = new AuthTokenCache(1024);
      const value = new Uint8Array([0xde, 0xad]);
      const resolved = cache.register(varint(1), varint(42), value, false);

      expect(resolved).not.toBeNull();
      expect(resolved!.tokenType).toBe(varint(42));
      expect(resolved!.tokenValue).toEqual(value);

      const looked = cache.resolve(varint(1));
      expect(looked.tokenType).toBe(varint(42));
      expect(looked.tokenValue).toEqual(value);
    });

    it('tracks cache size correctly', () => {
      const cache = new AuthTokenCache(1024);
      expect(cache.currentSize).toBe(0);

      // Entry: 16 + 2 = 18 bytes
      cache.register(varint(1), varint(0), new Uint8Array([0x01, 0x02]), false);
      expect(cache.currentSize).toBe(18);

      // Entry: 16 + 0 = 16 bytes
      cache.register(varint(2), varint(0), new Uint8Array([]), false);
      expect(cache.currentSize).toBe(34);
    });

    it('reports number of registered aliases', () => {
      const cache = new AuthTokenCache(1024);
      expect(cache.size).toBe(0);
      cache.register(varint(1), varint(0), new Uint8Array([]), false);
      expect(cache.size).toBe(1);
      cache.register(varint(2), varint(0), new Uint8Array([]), false);
      expect(cache.size).toBe(2);
    });
  });

  describe('delete', () => {
    it('deletes a registered alias', () => {
      const cache = new AuthTokenCache(1024);
      cache.register(varint(1), varint(42), new Uint8Array([0x01]), false);
      expect(cache.size).toBe(1);
      expect(cache.currentSize).toBe(17); // 16 + 1

      cache.delete(varint(1));
      expect(cache.size).toBe(0);
      expect(cache.currentSize).toBe(0);
    });

    it('allows re-registration after delete', () => {
      // §9.2.2.1: "Once a Token Alias has been registered, it cannot be
      // re-registered ... without first being deleted."
      const cache = new AuthTokenCache(1024);
      cache.register(varint(1), varint(1), new Uint8Array([0xaa]), false);
      cache.delete(varint(1));

      // Re-register with different value
      const resolved = cache.register(varint(1), varint(2), new Uint8Array([0xbb]), false);
      expect(resolved!.tokenType).toBe(varint(2));
      expect(cache.resolve(varint(1)).tokenType).toBe(varint(2));
    });

    it('throws UNKNOWN_AUTH_TOKEN_ALIAS for unregistered alias', () => {
      const cache = new AuthTokenCache(1024);
      expect(() => cache.delete(varint(99))).toThrow(AuthCacheError);
      try {
        cache.delete(varint(99));
      } catch (e) {
        expect((e as AuthCacheError).code).toBe('UNKNOWN_AUTH_TOKEN_ALIAS');
      }
    });
  });

  describe('DUPLICATE_AUTH_TOKEN_ALIAS', () => {
    it('throws when registering an already-registered alias', () => {
      // §9.2.2.1: "The receiver of a message attempting to register an Alias
      // which is already registered MUST close the Session with
      // DUPLICATE_AUTH_TOKEN_ALIAS."
      const cache = new AuthTokenCache(1024);
      cache.register(varint(1), varint(0), new Uint8Array([]), false);

      expect(() => cache.register(varint(1), varint(0), new Uint8Array([]), false))
        .toThrow(AuthCacheError);
      try {
        cache.register(varint(1), varint(0), new Uint8Array([]), false);
      } catch (e) {
        expect((e as AuthCacheError).code).toBe('DUPLICATE_AUTH_TOKEN_ALIAS');
      }
    });
  });

  describe('UNKNOWN_AUTH_TOKEN_ALIAS (resolve)', () => {
    it('throws when resolving an unregistered alias', () => {
      // §9.2.2.1: "The receiver of a message referencing an Alias that is not
      // currently registered MUST reject the message with UNKNOWN_AUTH_TOKEN_ALIAS."
      const cache = new AuthTokenCache(1024);
      expect(() => cache.resolve(varint(99))).toThrow(AuthCacheError);
      try {
        cache.resolve(varint(99));
      } catch (e) {
        expect((e as AuthCacheError).code).toBe('UNKNOWN_AUTH_TOKEN_ALIAS');
      }
    });

    it('throws when resolving a deleted alias', () => {
      const cache = new AuthTokenCache(1024);
      cache.register(varint(1), varint(0), new Uint8Array([]), false);
      cache.delete(varint(1));

      expect(() => cache.resolve(varint(1))).toThrow(AuthCacheError);
    });
  });

  describe('byte budget enforcement', () => {
    it('allows registration up to the limit', () => {
      // Max = 34 bytes → room for two entries of (16 + 1) = 17 each
      const cache = new AuthTokenCache(34);
      cache.register(varint(1), varint(0), new Uint8Array([0x01]), false);
      cache.register(varint(2), varint(0), new Uint8Array([0x02]), false);
      expect(cache.currentSize).toBe(34);
    });

    it('throws AUTH_TOKEN_CACHE_OVERFLOW when exceeded (non-setup)', () => {
      // §9.3.1.4: exceed cache → terminate with AUTH_TOKEN_CACHE_OVERFLOW
      const cache = new AuthTokenCache(17);
      cache.register(varint(1), varint(0), new Uint8Array([0x01]), false);

      // Next entry would be 16 + 1 = 17, total 34 > 17
      expect(() => cache.register(varint(2), varint(0), new Uint8Array([0x01]), false))
        .toThrow(AuthCacheError);
      try {
        cache.register(varint(2), varint(0), new Uint8Array([0x01]), false);
      } catch (e) {
        expect((e as AuthCacheError).code).toBe('AUTH_TOKEN_CACHE_OVERFLOW');
      }
    });

    it('returns null for CLIENT_SETUP overflow (§9.3.1.5)', () => {
      // §9.3.1.5: "If a server receives an AUTHORIZATION TOKEN parameter in
      // CLIENT_SETUP with Alias Type REGISTER that exceeds its
      // MAX_AUTH_TOKEN_CACHE_SIZE, it MUST NOT fail the session. Instead, it
      // MUST treat the parameter as Alias Type USE_VALUE."
      const cache = new AuthTokenCache(17);
      cache.register(varint(1), varint(0), new Uint8Array([0x01]), false);

      const result = cache.register(varint(2), varint(99), new Uint8Array([0x01]), true);
      expect(result).toBeNull();
      // Alias should NOT be registered
      expect(cache.size).toBe(1);
      expect(() => cache.resolve(varint(2))).toThrow();
    });

    it('prohibits aliases when maxBytes = 0 (default per spec)', () => {
      // §9.3.1.4: "The default value is 0 which prohibits the use of token Aliases."
      const cache = new AuthTokenCache(0);

      // Even an empty-value entry costs 16 bytes, exceeding 0
      expect(() => cache.register(varint(1), varint(0), new Uint8Array([]), false))
        .toThrow(AuthCacheError);
      try {
        cache.register(varint(1), varint(0), new Uint8Array([]), false);
      } catch (e) {
        expect((e as AuthCacheError).code).toBe('AUTH_TOKEN_CACHE_OVERFLOW');
      }
    });

    it('reclaims space after delete', () => {
      // §9.3.1.4: "minus the sum of the token sizes for all deregistered tokens"
      const cache = new AuthTokenCache(20);

      // Entry: 16 + 1 = 17
      cache.register(varint(1), varint(0), new Uint8Array([0x01]), false);
      expect(cache.currentSize).toBe(17);

      // Would overflow
      expect(() => cache.register(varint(2), varint(0), new Uint8Array([0x01]), false))
        .toThrow();

      // Delete first entry
      cache.delete(varint(1));
      expect(cache.currentSize).toBe(0);

      // Now registration succeeds
      const resolved = cache.register(varint(2), varint(0), new Uint8Array([0x01]), false);
      expect(resolved).not.toBeNull();
    });
  });

  describe('sessionErrorCode', () => {
    it('maps error codes correctly', () => {
      const cache = new AuthTokenCache(0);
      try {
        cache.register(varint(1), varint(0), new Uint8Array([]), false);
      } catch (e) {
        const err = e as AuthCacheError;
        // AUTH_TOKEN_CACHE_OVERFLOW = 0x13
        expect(err.sessionErrorCode).toBe(varint(0x13));
      }
    });
  });
});
