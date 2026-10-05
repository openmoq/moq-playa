import { describe, expect, it, vi } from 'vitest';
import { parseAuthorizationToken, parseAuthorizationToken18, AliasType } from '@openmoq/transport';
import { AuthorizationSession, AuthorizationError, catToken, type AuthorizationContext } from './authorization.js';

describe('CAT credential acquisition', () => {
  it.each([14, 16, 18] as const)('encodes opaque CAT bytes using draft %i USE_VALUE', async draftVersion => {
    const value = new Uint8Array([0xd2, 0x84, 0xab, 0xcd]);
    const getTokens = vi.fn((_ctx: AuthorizationContext) => [catToken(value)]);
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example/moq', getTokens });
    const [wire] = await auth.resolve({ operation: 'SETUP', draftVersion });
    const parse = draftVersion === 18 ? parseAuthorizationToken18 : parseAuthorizationToken;
    expect(parse(wire!)).toEqual({ aliasType: AliasType.USE_VALUE, tokenType: 1n, tokenValue: value });
    expect(getTokens.mock.calls[0]![0]).toMatchObject({ relayUrl: 'https://relay.example/moq', operation: 'SETUP', draftVersion });
  });

  it('keeps namespace field boundaries and isolates provider mutation', async () => {
    const namespace = [new Uint8Array([0x61, 0x2f]), new Uint8Array([0xff])];
    const trackName = new Uint8Array([0xfe]);
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example/moq', getTokens: ctx => {
      expect(ctx.namespace).toEqual(namespace);
      ctx.namespace![0]![0] = 0;
      ctx.trackName![0] = 0;
      return [catToken(new Uint8Array([1]))];
    } });
    await auth.resolve({ operation: 'SUBSCRIBE', draftVersion: 18, namespace, trackName });
    expect(namespace[0]![0]).toBe(0x61);
    expect(trackName[0]).toBe(0xfe);
  });

  it.each([
    ['Uint8Array', Uint8Array.from([1, 2])],
    ['Buffer', Buffer.from([1, 2])],
  ] as const)('does not retain caller-owned CAT buffers (%s)', (_name, value) => {
    const token = catToken(value);
    value.fill(0);
    expect(token.value).toEqual(new Uint8Array([1, 2]));
  });

  it('isolates Buffer-backed namespace and name fields from provider mutation', async () => {
    const namespace = [Buffer.from('live')];
    const trackName = Buffer.from('video');
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example/moq', getTokens: context => {
      context.namespace![0]!.fill(0);
      context.trackName!.fill(0);
      return [catToken(new Uint8Array([1]))];
    } });
    await auth.resolve({ operation: 'SUBSCRIBE', draftVersion: 18, namespace, trackName });
    expect(namespace[0]!.toString()).toBe('live');
    expect(trackName.toString()).toBe('video');
  });

  it('does not allow caller mutation to change the destination or provider after binding', async () => {
    const original = vi.fn((_ctx: AuthorizationContext) => [catToken(new Uint8Array([1]))]);
    const replacement = vi.fn((_ctx: AuthorizationContext) => [catToken(new Uint8Array([2]))]);
    const options = { relayUrl: 'https://relay.example/moq', getTokens: original };
    const auth = new AuthorizationSession(options);
    options.relayUrl = 'https://untrusted.example/moq';
    options.getTokens = replacement;
    await auth.resolve({ operation: 'SETUP', draftVersion: 18 });
    expect(original).toHaveBeenCalledOnce();
    expect(original.mock.calls[0]![0].relayUrl).toBe('https://relay.example/moq');
    expect(replacement).not.toHaveBeenCalled();
  });

  it('aborts and rejects pending acquisition immediately on close, even if the provider ignores abort', async () => {
    let signal!: AbortSignal;
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens: ctx => {
      signal = ctx.signal;
      return new Promise(() => {});
    } });
    const pending = auth.resolve({ operation: 'SETUP', draftVersion: 18 });
    const rejected = expect(pending).rejects.toThrow(AuthorizationError);
    await Promise.resolve();
    auth.close();
    await rejected;
    expect(signal.aborted).toBe(true);
    await expect(auth.resolve({ operation: 'SETUP', draftVersion: 18 })).rejects.toThrow('closed');
  });

  it('bounds an unresponsive provider and aborts its signal', async () => {
    vi.useFakeTimers();
    try {
      let signal!: AbortSignal;
      const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', timeoutMs: 20, getTokens: ctx => {
        signal = ctx.signal;
        return new Promise(() => {});
      } });
      const pending = expect(auth.resolve({ operation: 'SETUP', draftVersion: 18 })).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(20);
      await pending;
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not expose a provider error or its secret through message, cause, or enumerable fields', async () => {
    const secret = 'issuer-secret-token';
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens: () => { throw new Error(secret); } });
    const error = await auth.resolve({ operation: 'SETUP', draftVersion: 18 }).catch(e => e);
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).not.toContain(secret);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('rejects empty credentials rather than making an authenticated request anonymous', async () => {
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens: () => [] });
    await expect(auth.resolve({ operation: 'SETUP', draftVersion: 18 })).rejects.toThrow('no credentials');
  });

  it('does not expose malformed relay URL input on authorization errors', () => {
    const secret = 'issuer-secret-token';
    let error: unknown;
    try {
      new AuthorizationSession({ relayUrl: `https://[${secret}`, getTokens: () => [] });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('rejects duplicate token type/value pairs', async () => {
    const token = catToken(new Uint8Array([1]));
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens: () => [token, token] });
    await expect(auth.resolve({ operation: 'SETUP', draftVersion: 18 })).rejects.toThrow('duplicate');
  });

  it.each([0, -1, NaN, Infinity, 1.5, 2 ** 31])('rejects invalid timeout %s before invoking the provider', timeoutMs => {
    const getTokens = vi.fn();
    expect(() => new AuthorizationSession({ relayUrl: 'https://relay.example', timeoutMs, getTokens })).toThrow();
    expect(getTokens).not.toHaveBeenCalled();
  });

  it('cleans up immediately when closed before the provider starts', async () => {
    const getTokens = vi.fn(() => [catToken(new Uint8Array([1]))]);
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens });
    const pending = auth.resolve({ operation: 'SETUP', draftVersion: 18 });
    const rejected = expect(pending).rejects.toThrow(AuthorizationError);
    auth.close();
    await rejected;
    expect(getTokens).not.toHaveBeenCalled();
  });

  it('bounds the number of concurrently pending credential providers', async () => {
    const auth = new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens: () => new Promise(() => {}) });
    const pending = Array.from({ length: 64 }, () => auth.resolve({ operation: 'SUBSCRIBE', draftVersion: 18 }).catch(e => e));
    await expect(auth.resolve({ operation: 'SUBSCRIBE', draftVersion: 18 })).rejects.toThrow('Too many pending');
    auth.close();
    expect((await Promise.all(pending)).every(e => e instanceof AuthorizationError)).toBe(true);
  });

  it('rejects oversized credentials and token types outside the selected draft range', async () => {
    const make = (value: Uint8Array, tokenType = 1n) => new AuthorizationSession({ relayUrl: 'https://relay.example', getTokens: () => [{ value, tokenType }] });
    await expect(make(new Uint8Array(32769)).resolve({ operation: 'SETUP', draftVersion: 18 })).rejects.toThrow('32 KiB');
    await expect(make(new Uint8Array([1]), 1n << 62n).resolve({ operation: 'SETUP', draftVersion: 16 })).rejects.toThrow('token type');
    const [wire] = await make(new Uint8Array([1]), 1n << 62n).resolve({ operation: 'SETUP', draftVersion: 18 });
    expect(parseAuthorizationToken18(wire!)).toMatchObject({ tokenType: 1n << 62n });
  });
});
