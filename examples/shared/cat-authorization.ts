import type { ConnectionAuthorization } from '@openmoq/webtransport';

/**
 * Token type for an example page's CAT profile setting.
 *
 * `cat4moq` is the registered CAT4MOQ token type (draft-01 section 7.1.1);
 * `moqx-compat` is the type current moqx relays expect. An unknown profile is
 * refused rather than mapped to a default.
 */
export function catTokenType(profile: string): bigint {
  if (profile !== 'cat4moq' && profile !== 'moqx-compat') throw new Error('Invalid authorization profile');
  return profile === 'cat4moq' ? 1n : 16n;
}

/** Provider that presents one opaque CAT on SETUP and every authorized request. The bytes are snapshotted. */
export function catAuthorization(tokenType: bigint, token: Uint8Array): Omit<ConnectionAuthorization, 'relayUrl'> {
  if (token.length === 0 || token.length > 32768) throw new Error('Invalid CAT token');
  const value = Uint8Array.from(token);
  return { getTokens: () => [{ tokenType, value: Uint8Array.from(value) }] };
}
