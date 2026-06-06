/**
 * AUTHORIZATION_TOKEN structure parsing and encoding.
 *
 * Parses the Token structure from raw KVP parameter bytes into a typed
 * discriminated union based on the Alias Type field.
 *
 * @see draft-ietf-moq-transport-16 §9.2.2.1, Figure 4
 * @module
 */

import { varint, readVarint, writeVarint, varintEncodingLength } from '../primitives/varint.js';
import { readVi64, writeVi64, vi64EncodingLength } from '../primitives/vi64.js';
import { ProtocolViolationError } from '../errors.js';

// ─── Alias Type Constants ─────────────────────────────────────────────

/**
 * Authorization Token Alias Types.
 * @see draft-ietf-moq-transport-16 §9.2.2.1, §13.1
 */
export const AliasType = {
  /** Retire a previously registered alias. Has Alias, no Type/Value. */
  DELETE: varint(0x0),
  /** Associate an alias with a Token Type + Value. Has Alias, Type, Value. */
  REGISTER: varint(0x1),
  /** Reference a previously registered token by alias. Has Alias, no Type/Value. */
  USE_ALIAS: varint(0x2),
  /** Provide Token Type + Value directly (no caching). No Alias, has Type/Value. */
  USE_VALUE: varint(0x3),
} as const;

// ─── Token Types ──────────────────────────────────────────────────────

/**
 * DELETE token: retire a previously registered alias.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — DELETE (0x0)
 */
export interface DeleteToken {
  readonly aliasType: typeof AliasType.DELETE;
  /**
   * Token Alias — semantic value is a raw `bigint`. On draft-14/16 it is a QUIC
   * varint (≤ 2^62-1, enforced by the wire parser/encoder); on draft-18 it is a
   * vi64 (full uint64). See {@link parseAuthorizationToken18}.
   */
  readonly tokenAlias: bigint;
}

/**
 * REGISTER token: associate an alias with a Token Type + Value.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — REGISTER (0x1)
 */
export interface RegisterToken {
  readonly aliasType: typeof AliasType.REGISTER;
  /** Token Alias — see {@link DeleteToken.tokenAlias} (vi64 on draft-18). */
  readonly tokenAlias: bigint;
  /** Token Type — QUIC varint on draft-14/16, vi64 (full uint64) on draft-18. */
  readonly tokenType: bigint;
  readonly tokenValue: Uint8Array;
}

/**
 * USE_ALIAS token: reference a previously registered token by alias.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — USE_ALIAS (0x2)
 */
export interface UseAliasToken {
  readonly aliasType: typeof AliasType.USE_ALIAS;
  /** Token Alias — see {@link DeleteToken.tokenAlias} (vi64 on draft-18). */
  readonly tokenAlias: bigint;
}

/**
 * USE_VALUE token: provide Token Type + Value directly.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — USE_VALUE (0x3)
 */
export interface UseValueToken {
  readonly aliasType: typeof AliasType.USE_VALUE;
  /** Token Type — QUIC varint on draft-14/16, vi64 (full uint64) on draft-18. */
  readonly tokenType: bigint;
  readonly tokenValue: Uint8Array;
}

/**
 * Discriminated union of all Authorization Token variants.
 * @see draft-ietf-moq-transport-16 §9.2.2.1, Figure 4
 */
export type AuthorizationToken = DeleteToken | RegisterToken | UseAliasToken | UseValueToken;

/**
 * A resolved token — the final (tokenType, tokenValue) pair after alias resolution.
 * This is the output of processing any token through the alias cache.
 */
export interface ResolvedToken {
  /** Token Type — vi64 (full uint64) on draft-18, QUIC varint on draft-14/16. */
  readonly tokenType: bigint;
  readonly tokenValue: Uint8Array;
}

// ─── Parsing ──────────────────────────────────────────────────────────

/**
 * Parse an Authorization Token from raw KVP parameter bytes.
 *
 * The Token structure (Figure 4) is:
 * ```
 * Token {
 *   Alias Type (i),
 *   [Token Alias (i),]
 *   [Token Type (i),]
 *   [Token Value (..)]
 * }
 * ```
 *
 * Token Value consumes all remaining bytes after Token Type.
 *
 * @throws {Error} if the token is malformed (truncated, unknown alias type)
 * @see draft-ietf-moq-transport-16 §9.2.2.1, Figure 4
 */
export function parseAuthorizationToken(data: Uint8Array): AuthorizationToken {
  if (data.length === 0) {
    throw new ProtocolViolationError('Empty AUTHORIZATION_TOKEN parameter');
  }

  let pos = 0;

  // Read Alias Type
  const { value: aliasTypeRaw, bytesRead: atBytes } = readVarint(data, pos);
  pos += atBytes;

  switch (aliasTypeRaw) {
    case AliasType.DELETE as bigint: {
      // DELETE: has Token Alias, no Type/Value
      if (pos >= data.length) {
        throw new ProtocolViolationError('DELETE token missing Token Alias');
      }
      const { value: tokenAlias, bytesRead: taBytes } = readVarint(data, pos);
      pos += taBytes;
      if (pos !== data.length) {
        throw new ProtocolViolationError(`DELETE token has ${data.length - pos} trailing bytes`);
      }
      return { aliasType: AliasType.DELETE, tokenAlias };
    }

    case AliasType.REGISTER as bigint: {
      // REGISTER: has Token Alias, Token Type, Token Value
      if (pos >= data.length) {
        throw new ProtocolViolationError('REGISTER token missing Token Alias');
      }
      const { value: tokenAlias, bytesRead: taBytes } = readVarint(data, pos);
      pos += taBytes;
      if (pos >= data.length) {
        throw new ProtocolViolationError('REGISTER token missing Token Type');
      }
      const { value: tokenType, bytesRead: ttBytes } = readVarint(data, pos);
      pos += ttBytes;
      // Token Value is all remaining bytes (may be empty)
      const tokenValue = data.slice(pos);
      return { aliasType: AliasType.REGISTER, tokenAlias, tokenType, tokenValue };
    }

    case AliasType.USE_ALIAS as bigint: {
      // USE_ALIAS: has Token Alias, no Type/Value
      if (pos >= data.length) {
        throw new ProtocolViolationError('USE_ALIAS token missing Token Alias');
      }
      const { value: tokenAlias, bytesRead: taBytes } = readVarint(data, pos);
      pos += taBytes;
      if (pos !== data.length) {
        throw new ProtocolViolationError(`USE_ALIAS token has ${data.length - pos} trailing bytes`);
      }
      return { aliasType: AliasType.USE_ALIAS, tokenAlias };
    }

    case AliasType.USE_VALUE as bigint: {
      // USE_VALUE: no Token Alias, has Token Type, Token Value
      if (pos >= data.length) {
        throw new ProtocolViolationError('USE_VALUE token missing Token Type');
      }
      const { value: tokenType, bytesRead: ttBytes } = readVarint(data, pos);
      pos += ttBytes;
      // Token Value is all remaining bytes (may be empty)
      const tokenValue = data.slice(pos);
      return { aliasType: AliasType.USE_VALUE, tokenType, tokenValue };
    }

    default:
      throw new ProtocolViolationError(`Unknown AUTHORIZATION_TOKEN Alias Type: ${aliasTypeRaw}`);
  }
}

// ─── Encoding ─────────────────────────────────────────────────────────

/**
 * Encode an Authorization Token to wire format bytes.
 * @see draft-ietf-moq-transport-16 §9.2.2.1, Figure 4
 */
export function encodeAuthorizationToken(token: AuthorizationToken): Uint8Array {
  switch (token.aliasType) {
    case AliasType.DELETE as bigint: {
      const t = token as DeleteToken;
      const size = varintEncodingLength(AliasType.DELETE) + varintEncodingLength(t.tokenAlias);
      const buf = new Uint8Array(size);
      let pos = writeVarint(AliasType.DELETE, buf, 0);
      writeVarint(t.tokenAlias, buf, pos);
      return buf;
    }

    case AliasType.REGISTER as bigint: {
      const t = token as RegisterToken;
      const size = varintEncodingLength(AliasType.REGISTER)
        + varintEncodingLength(t.tokenAlias)
        + varintEncodingLength(t.tokenType)
        + t.tokenValue.length;
      const buf = new Uint8Array(size);
      let pos = writeVarint(AliasType.REGISTER, buf, 0);
      pos += writeVarint(t.tokenAlias, buf, pos);
      pos += writeVarint(t.tokenType, buf, pos);
      buf.set(t.tokenValue, pos);
      return buf;
    }

    case AliasType.USE_ALIAS as bigint: {
      const t = token as UseAliasToken;
      const size = varintEncodingLength(AliasType.USE_ALIAS) + varintEncodingLength(t.tokenAlias);
      const buf = new Uint8Array(size);
      let pos = writeVarint(AliasType.USE_ALIAS, buf, 0);
      writeVarint(t.tokenAlias, buf, pos);
      return buf;
    }

    case AliasType.USE_VALUE as bigint: {
      const t = token as UseValueToken;
      const size = varintEncodingLength(AliasType.USE_VALUE)
        + varintEncodingLength(t.tokenType)
        + t.tokenValue.length;
      const buf = new Uint8Array(size);
      let pos = writeVarint(AliasType.USE_VALUE, buf, 0);
      pos += writeVarint(t.tokenType, buf, pos);
      buf.set(t.tokenValue, pos);
      return buf;
    }

    default:
      throw new ProtocolViolationError(`Unknown Alias Type: ${(token as AuthorizationToken).aliasType}`);
  }
}

// ─── draft-18 (vi64) ──────────────────────────────────────────────────
//
// draft-18 encodes the Token structure's Alias Type, Token Alias, and Token Type
// as vi64 (full uint64), not the QUIC varint of draft-14/16. The wire bytes are
// identical for small values; they differ only above the QUIC range (2^62-1).
// The parse/encode helpers below mirror the legacy ones but with vi64, so a
// draft-18 token alias / type can carry any uint64.
//
// The SEMANTIC token shape is shared: the legacy {@link AuthorizationToken} types
// already carry `bigint` Token Alias / Token Type, so the `*18` names are aliases.
// Only the WIRE codec differs (QUIC varint vs vi64). The Alias Type discriminant
// values (0x0–0x3) are shared with draft-14/16.
// @see draft-ietf-moq-transport-18 §10.2 (message parameters), §9.2.2.1 (Token)

/** draft-18 DELETE token (vi64 wire); semantically identical to {@link DeleteToken}. */
export type DeleteToken18 = DeleteToken;
/** draft-18 REGISTER token (vi64 wire); semantically identical to {@link RegisterToken}. */
export type RegisterToken18 = RegisterToken;
/** draft-18 USE_ALIAS token (vi64 wire); semantically identical to {@link UseAliasToken}. */
export type UseAliasToken18 = UseAliasToken;
/** draft-18 USE_VALUE token (vi64 wire); semantically identical to {@link UseValueToken}. */
export type UseValueToken18 = UseValueToken;
/** draft-18 Authorization Token (vi64-encoded internals); alias of {@link AuthorizationToken}. */
export type AuthorizationToken18 = AuthorizationToken;

/**
 * Parse a draft-18 Authorization Token from raw parameter bytes (vi64 internals).
 * @throws {ProtocolViolationError} on a malformed / truncated / unknown-alias token.
 * @see draft-ietf-moq-transport-18 §9.2.2.1
 */
export function parseAuthorizationToken18(data: Uint8Array): AuthorizationToken18 {
  if (data.length === 0) {
    throw new ProtocolViolationError('Empty AUTHORIZATION_TOKEN parameter');
  }
  let pos = 0;
  const { value: aliasTypeRaw, bytesRead: atBytes } = readVi64(data, pos);
  pos += atBytes;

  switch (aliasTypeRaw) {
    case AliasType.DELETE as bigint: {
      if (pos >= data.length) throw new ProtocolViolationError('DELETE token missing Token Alias');
      const { value: tokenAlias, bytesRead } = readVi64(data, pos); pos += bytesRead;
      if (pos !== data.length) throw new ProtocolViolationError(`DELETE token has ${data.length - pos} trailing bytes`);
      return { aliasType: AliasType.DELETE, tokenAlias };
    }
    case AliasType.REGISTER as bigint: {
      if (pos >= data.length) throw new ProtocolViolationError('REGISTER token missing Token Alias');
      const ta = readVi64(data, pos); pos += ta.bytesRead;
      if (pos >= data.length) throw new ProtocolViolationError('REGISTER token missing Token Type');
      const tt = readVi64(data, pos); pos += tt.bytesRead;
      return { aliasType: AliasType.REGISTER, tokenAlias: ta.value, tokenType: tt.value, tokenValue: data.slice(pos) };
    }
    case AliasType.USE_ALIAS as bigint: {
      if (pos >= data.length) throw new ProtocolViolationError('USE_ALIAS token missing Token Alias');
      const { value: tokenAlias, bytesRead } = readVi64(data, pos); pos += bytesRead;
      if (pos !== data.length) throw new ProtocolViolationError(`USE_ALIAS token has ${data.length - pos} trailing bytes`);
      return { aliasType: AliasType.USE_ALIAS, tokenAlias };
    }
    case AliasType.USE_VALUE as bigint: {
      if (pos >= data.length) throw new ProtocolViolationError('USE_VALUE token missing Token Type');
      const { value: tokenType, bytesRead } = readVi64(data, pos); pos += bytesRead;
      return { aliasType: AliasType.USE_VALUE, tokenType, tokenValue: data.slice(pos) };
    }
    default:
      throw new ProtocolViolationError(`Unknown AUTHORIZATION_TOKEN Alias Type: ${aliasTypeRaw}`);
  }
}

/**
 * Encode a draft-18 Authorization Token to wire bytes (vi64 internals).
 * @see draft-ietf-moq-transport-18 §9.2.2.1
 */
export function encodeAuthorizationToken18(token: AuthorizationToken18): Uint8Array {
  switch (token.aliasType) {
    case AliasType.DELETE as bigint: {
      const t = token as DeleteToken18;
      const buf = new Uint8Array(vi64EncodingLength(AliasType.DELETE) + vi64EncodingLength(t.tokenAlias));
      let p = writeVi64(AliasType.DELETE, buf, 0);
      writeVi64(t.tokenAlias, buf, p);
      return buf;
    }
    case AliasType.REGISTER as bigint: {
      const t = token as RegisterToken18;
      const buf = new Uint8Array(
        vi64EncodingLength(AliasType.REGISTER) + vi64EncodingLength(t.tokenAlias) + vi64EncodingLength(t.tokenType) + t.tokenValue.length,
      );
      let p = writeVi64(AliasType.REGISTER, buf, 0);
      p += writeVi64(t.tokenAlias, buf, p);
      p += writeVi64(t.tokenType, buf, p);
      buf.set(t.tokenValue, p);
      return buf;
    }
    case AliasType.USE_ALIAS as bigint: {
      const t = token as UseAliasToken18;
      const buf = new Uint8Array(vi64EncodingLength(AliasType.USE_ALIAS) + vi64EncodingLength(t.tokenAlias));
      let p = writeVi64(AliasType.USE_ALIAS, buf, 0);
      writeVi64(t.tokenAlias, buf, p);
      return buf;
    }
    case AliasType.USE_VALUE as bigint: {
      const t = token as UseValueToken18;
      const buf = new Uint8Array(
        vi64EncodingLength(AliasType.USE_VALUE) + vi64EncodingLength(t.tokenType) + t.tokenValue.length,
      );
      let p = writeVi64(AliasType.USE_VALUE, buf, 0);
      p += writeVi64(t.tokenType, buf, p);
      buf.set(t.tokenValue, p);
      return buf;
    }
    default:
      throw new ProtocolViolationError(`Unknown Alias Type: ${(token as AuthorizationToken18).aliasType}`);
  }
}
