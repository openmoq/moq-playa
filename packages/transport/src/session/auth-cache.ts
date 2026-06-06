/**
 * Authorization Token alias cache.
 *
 * Manages the per-session cache of registered token aliases, enforcing
 * the MAX_AUTH_TOKEN_CACHE_SIZE byte budget.
 *
 * Cache entry size = 16 bytes + Token Value length (§9.3.1.4).
 *
 * @see draft-ietf-moq-transport-16 §9.2.2.1, §9.3.1.4, §9.3.1.5
 * @module
 */

import type { Varint } from '../primitives/varint.js';
import type { ResolvedToken } from '../control/auth-token.js';
import { SessionError } from '../errors.js';

/** Overhead per cache entry: 16 bytes per §9.3.1.4. */
const ENTRY_OVERHEAD = 16;

/**
 * Error thrown for auth token cache violations.
 * The `code` field maps to the SessionError code name for session termination.
 */
export class AuthCacheError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AUTH_TOKEN_CACHE_OVERFLOW'
      | 'DUPLICATE_AUTH_TOKEN_ALIAS'
      | 'UNKNOWN_AUTH_TOKEN_ALIAS'
      | 'EXPIRED_AUTH_TOKEN'
      | 'KEY_VALUE_FORMATTING_ERROR',
  ) {
    super(message);
    this.name = 'AuthCacheError';
  }

  /**
   * Get the corresponding session termination error code.
   * @see draft-ietf-moq-transport-16 §13.4.1
   */
  get sessionErrorCode(): Varint {
    return SessionError[this.code];
  }
}

/**
 * Per-session authorization token alias cache.
 *
 * Tracks registered aliases and enforces the byte budget communicated
 * via MAX_AUTH_TOKEN_CACHE_SIZE.
 *
 * @see draft-ietf-moq-transport-16 §9.3.1.4
 */
export class AuthTokenCache {
  /** Registered aliases: alias → resolved token. */
  private readonly cache = new Map<bigint, ResolvedToken>();

  /**
   * Current cache size in bytes.
   *
   * Calculated as: sum of (16 + tokenValue.length) for all registered entries
   * minus sum of (16 + tokenValue.length) for all deleted entries, since Session
   * initiation.
   *
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  private _currentSize = 0;

  /**
   * @param maxBytes Maximum cache size in bytes. 0 = aliases prohibited (default per spec).
   * @see draft-ietf-moq-transport-16 §9.3.1.4
   */
  constructor(readonly maxBytes: number) {}

  /**
   * Register a token alias in the cache.
   *
   * §9.2.2.1: "REGISTER (0x1): There is an Alias, a Type and a Value.
   * This Alias MUST be associated with the Token Value for the duration
   * of the Session or it is deleted."
   *
   * @param alias Token alias to register
   * @param tokenType Token type identifier
   * @param tokenValue Token value bytes
   * @param isClientSetup If true, exceeding cache → return null (treat as USE_VALUE) per §9.3.1.5.
   *                      If false, exceeding cache → throw AUTH_TOKEN_CACHE_OVERFLOW.
   * @returns The resolved token, or null if isClientSetup and cache would overflow.
   * @throws {AuthCacheError} DUPLICATE_AUTH_TOKEN_ALIAS if alias already registered
   * @throws {AuthCacheError} AUTH_TOKEN_CACHE_OVERFLOW if cache exceeded (non-setup)
   * @see draft-ietf-moq-transport-16 §9.2.2.1, §9.3.1.4, §9.3.1.5
   */
  register(
    alias: bigint,
    tokenType: bigint,
    tokenValue: Uint8Array,
    isClientSetup: boolean,
  ): ResolvedToken | null {
    // §9.2.2.1: "Once a Token Alias has been registered, it cannot be
    // re-registered by the same endpoint in the Session without first being deleted."
    if (this.cache.has(alias as bigint)) {
      throw new AuthCacheError(
        `Token alias ${alias} is already registered`,
        'DUPLICATE_AUTH_TOKEN_ALIAS',
      );
    }

    const entrySize = ENTRY_OVERHEAD + tokenValue.length;

    // Check byte budget
    if (this._currentSize + entrySize > this.maxBytes) {
      if (isClientSetup) {
        // §9.3.1.5: "If a server receives an AUTHORIZATION TOKEN parameter in
        // CLIENT_SETUP with Alias Type REGISTER that exceeds its
        // MAX_AUTH_TOKEN_CACHE_SIZE, it MUST NOT fail the session with
        // AUTH_TOKEN_CACHE_OVERFLOW. Instead, it MUST treat the parameter as
        // Alias Type USE_VALUE."
        return null;
      }
      throw new AuthCacheError(
        `Registering alias ${alias} would exceed MAX_AUTH_TOKEN_CACHE_SIZE ` +
        `(current: ${this._currentSize}, entry: ${entrySize}, max: ${this.maxBytes})`,
        'AUTH_TOKEN_CACHE_OVERFLOW',
      );
    }

    const resolved: ResolvedToken = { tokenType, tokenValue };
    this.cache.set(alias as bigint, resolved);
    this._currentSize += entrySize;

    return resolved;
  }

  /**
   * Delete (retire) a previously registered alias.
   *
   * §9.2.2.1: "DELETE (0x0): There is an Alias but no Type or Value.
   * This Alias and the Token Value it was previously associated with
   * MUST be retired."
   *
   * Note: per §9.3.1.4, deletion reduces the tracked cache size.
   *
   * @throws {AuthCacheError} UNKNOWN_AUTH_TOKEN_ALIAS if alias not registered
   * @see draft-ietf-moq-transport-16 §9.2.2.1
   */
  delete(alias: bigint): void {
    const entry = this.cache.get(alias as bigint);
    if (!entry) {
      throw new AuthCacheError(
        `Token alias ${alias} is not registered`,
        'UNKNOWN_AUTH_TOKEN_ALIAS',
      );
    }
    const entrySize = ENTRY_OVERHEAD + entry.tokenValue.length;
    this.cache.delete(alias as bigint);
    this._currentSize -= entrySize;
  }

  /**
   * Resolve an alias to its registered token.
   *
   * §9.2.2.1: "USE_ALIAS (0x2): There is an Alias but no Type or Value.
   * Use the Token Type and Value previously registered with this Alias."
   *
   * @throws {AuthCacheError} UNKNOWN_AUTH_TOKEN_ALIAS if alias not found
   * @see draft-ietf-moq-transport-16 §9.2.2.1
   */
  resolve(alias: bigint): ResolvedToken {
    const entry = this.cache.get(alias as bigint);
    if (!entry) {
      throw new AuthCacheError(
        `Token alias ${alias} is not registered`,
        'UNKNOWN_AUTH_TOKEN_ALIAS',
      );
    }
    return entry;
  }

  /** Current cache size in bytes. */
  get currentSize(): number {
    return this._currentSize;
  }

  /** Number of registered aliases. */
  get size(): number {
    return this.cache.size;
  }
}
