import type { ConnectionAuthorization } from '@openmoq/webtransport';

export interface BroadcastAuthorizationSettings {
  enabled: boolean;
  token: string;
  profile: string;
}

/** Credentials are attempt-local and never persisted or added to viewer links. */
export function createBroadcastAuthorization(settings: BroadcastAuthorizationSettings):
  Omit<ConnectionAuthorization, 'relayUrl'> | undefined {
  if (!settings.enabled) return undefined;
  if (settings.profile !== 'cat4moq' && settings.profile !== 'moqx-compat') {
    throw new Error('Invalid authorization profile');
  }
  const tokenType = settings.profile === 'cat4moq' ? 1n : 16n;
  const text = settings.token.trim().replace(/^base64:/, '');
  // Check the encoded size before decoding an untrusted pasted credential.
  if (!text || text.length > 4 * Math.ceil(32768 / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error('Invalid CAT token');
  }
  const binary = atob(text);
  if (binary.length > 32768 || btoa(binary) !== text) throw new Error('Invalid CAT token');
  const value = Uint8Array.from(binary, char => char.charCodeAt(0));
  return { getTokens: () => [{ tokenType, value: Uint8Array.from(value) }] };
}
