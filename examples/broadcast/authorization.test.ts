import { describe, expect, it } from 'vitest';
import { createBroadcastAuthorization } from './authorization.js';

describe('broadcast authorization', () => {
  it('does nothing when disabled, even with invalid credentials', () => {
    expect(createBroadcastAuthorization({ enabled: false, token: 'not a token', profile: 'invalid' })).toBeUndefined();
  });

  it.each(['', 'base64:', '%%%', 'YQ', 'Y===', 'YWJj====', 'YR=='])('rejects invalid credentials %j without echoing them', token => {
    expect(() => createBroadcastAuthorization({ enabled: true, token, profile: 'cat4moq' })).toThrow('Invalid CAT token');
  });

  it.each([['cat4moq', 1n], ['moqx-compat', 16n]] as const)('uses %s explicitly and preserves opaque bytes', async (profile, tokenType) => {
    const auth = createBroadcastAuthorization({ enabled: true, token: 'base64:AAH+/w==', profile })!;
    const ctx = { operation: 'SETUP' as const, draftVersion: 16 as const, relayUrl: 'https://relay.test/moq', signal: new AbortController().signal };
    const tokens = await auth.getTokens(ctx);
    expect(tokens).toEqual([{ tokenType, value: Uint8Array.of(0, 1, 254, 255) }]);
    tokens[0]!.value.fill(9);
    expect((await auth.getTokens({ ...ctx, operation: 'PUBLISH_NAMESPACE' }))[0]!.value).toEqual(Uint8Array.of(0, 1, 254, 255));
  });

  it('accepts bare padded base64 and trims surrounding whitespace', async () => {
    const auth = createBroadcastAuthorization({ enabled: true, token: '  YWJj \n', profile: 'cat4moq' })!;
    const tokens = await auth.getTokens({ operation: 'SETUP', draftVersion: 18, relayUrl: 'https://relay.test/moq', signal: new AbortController().signal });
    expect(tokens[0]!.value).toEqual(new TextEncoder().encode('abc'));
  });

  it('rejects unknown profiles rather than falling back', () => {
    expect(() => createBroadcastAuthorization({ enabled: true, token: 'YWJj', profile: 'invalid' })).toThrow('Invalid authorization profile');
  });

  it('bounds credential bytes', () => {
    expect(() => createBroadcastAuthorization({ enabled: true, token: btoa('a'.repeat(32769)), profile: 'cat4moq' })).toThrow('Invalid CAT token');
  });

  it('snapshots settings for the attempt', async () => {
    const settings = { enabled: true, token: 'YWJj', profile: 'cat4moq' };
    const auth = createBroadcastAuthorization(settings)!;
    settings.token = 'ZGVm'; settings.profile = 'moqx-compat'; settings.enabled = false;
    expect(await auth.getTokens({ operation: 'SETUP', draftVersion: 16, relayUrl: 'https://relay.test/moq', signal: new AbortController().signal })).toEqual([{tokenType: 1n, value: new TextEncoder().encode('abc')}]);
  });
});
