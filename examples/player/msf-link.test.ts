import { describe, expect, it } from 'vitest';
import { readMsfLink } from './msf-link.js';

const ctx = { operation: 'SETUP' as const, draftVersion: 16 as const, relayUrl: 'https://relay.test/moq', signal: new AbortController().signal };

describe('player MSF link', () => {
  it.each(['', '#', '#log', '#top&c4m=AAH-_w', '#https://relay.test/moq#msf:live--catalog'])('ignores the unrelated fragment %j', hash => {
    expect(readMsfLink(hash, '?ns=live&url=https://relay.test/moq')).toBeUndefined();
  });

  it('takes namespace and track from the fragment and leaves the relay to ?url=', () => {
    expect(readMsfLink('#msf:live-demo.2dtest--catalog', '?url=https://relay.test/moq&v=16')).toEqual({
      namespace: ['live', 'demo-test'], catalogTrackName: 'catalog', notes: [],
    });
    expect(readMsfLink('msf:live--catalog.2dv2', '')).toEqual({ namespace: ['live'], catalogTrackName: 'catalog-v2', notes: [] });
  });

  it.each([[undefined, 1n], ['cat4moq', 1n], ['moqx-compat', 16n]] as const)('presents c4m with ?authProfile=%s and preserves opaque bytes', async (profile, tokenType) => {
    const link = readMsfLink('#msf:live--catalog&c4m=AAH+/w==', profile ? `?authProfile=${profile}` : '')!;
    const tokens = await link.authorization!.getTokens(ctx);
    expect(tokens).toEqual([{ tokenType, value: Uint8Array.of(0, 1, 254, 255) }]);
    tokens[0]!.value.fill(9);
    expect((await link.authorization!.getTokens({ ...ctx, operation: 'SUBSCRIBE' }))[0]!.value).toEqual(Uint8Array.of(0, 1, 254, 255));
  });

  it('rejects unknown profiles rather than falling back, but only when a token is present', () => {
    expect(() => readMsfLink('#msf:live--catalog&c4m=YWJj', '?authProfile=invalid')).toThrow('Invalid authorization profile');
    expect(readMsfLink('#msf:live--catalog', '?authProfile=invalid')!.authorization).toBeUndefined();
  });

  it('refuses a required native QUIC connection and accepts WebTransport', () => {
    expect(() => readMsfLink('#msf:live--catalog&connection=q', '')).toThrow('native QUIC');
    expect(readMsfLink('#msf:live--catalog&connection=wt', '')).toBeDefined();
  });

  it.each([
    ['#msf:live--catalog', '?ns=live', '?ns='],
    ['#msf:live--catalog', '?ns=', '?ns='],
    ['#msf:live--catalog', '?nsField=live', '?nsField='],
    ['#msf:live--catalog&c4m=YWJj', '?fetchCatalog=1', '?fetchCatalog=1'],
  ])('refuses %j together with %j', (hash, search, message) => {
    expect(() => readMsfLink(hash, search)).toThrow(message);
  });

  it('allows ?url= and ?fetchCatalog=1 where the fragment does not set the same thing', () => {
    expect(readMsfLink('#msf:live--catalog', '?url=https://relay.test/moq&fetchCatalog=1')).toBeDefined();
  });

  it.each(['#msf:', '#msf:live', '#MSF:live--catalog', '#msf:live--catalog&c4m=%%%', '#msf:live--catalog&c4m=YQ&c4m=YQ'])('refuses the malformed MSF fragment %j', hash => {
    expect(() => readMsfLink(hash, '')).toThrow(/^MSF /);
  });

  it('counts what it does not act on, without names or values', () => {
    const link = readMsfLink('#msf:live--catalog&location-range=34-64&secret=hunter2&other=1', '')!;
    expect(link.notes).toEqual(['3 parameters are not supported by this page and ignored']);
    expect(readMsfLink('#msf:live--catalog&x=1', '')!.notes).toEqual(['1 parameter is not supported by this page and ignored']);
  });
});
