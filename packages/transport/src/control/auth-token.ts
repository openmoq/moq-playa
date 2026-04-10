/**
 * AUTHORIZATION_TOKEN structure parsing and encoding.
 *
 * Parses the Token structure from raw KVP parameter bytes into a typed
 * discriminated union based on the Alias Type field.
 *
 * @see draft-ietf-moq-transport-16 §9.2.2.1, Figure 4
 * @module
 */

import { varint, readVarint, writeVarint, varintEncodingLength, type Varint } from '../primitives/varint.js';
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
  readonly tokenAlias: Varint;
}

/**
 * REGISTER token: associate an alias with a Token Type + Value.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — REGISTER (0x1)
 */
export interface RegisterToken {
  readonly aliasType: typeof AliasType.REGISTER;
  readonly tokenAlias: Varint;
  readonly tokenType: Varint;
  readonly tokenValue: Uint8Array;
}

/**
 * USE_ALIAS token: reference a previously registered token by alias.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — USE_ALIAS (0x2)
 */
export interface UseAliasToken {
  readonly aliasType: typeof AliasType.USE_ALIAS;
  readonly tokenAlias: Varint;
}

/**
 * USE_VALUE token: provide Token Type + Value directly.
 * @see draft-ietf-moq-transport-16 §9.2.2.1 — USE_VALUE (0x3)
 */
export interface UseValueToken {
  readonly aliasType: typeof AliasType.USE_VALUE;
  readonly tokenType: Varint;
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
  readonly tokenType: Varint;
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
