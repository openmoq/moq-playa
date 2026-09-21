/**
 * Tests for player-message.ts — control message routing + catalog handling.
 *
 * @see draft-ietf-moq-transport-16 §9.4 (GOAWAY)
 * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @see draft-ietf-moq-transport-16 §9.7 (REQUEST_OK)
 * @see draft-ietf-moq-transport-16 §9.8 (REQUEST_ERROR)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleControlMessage,
  removeSubscription,
  validateKnownTracks,
  type ControlMessageContext,
} from './player-message.js';
import type { ControlMessage } from '@moqt/transport';
import type { CatalogState, CatalogTrack } from '@moqt/msf';
import type { LoggerLike } from './logger.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const mockLog: LoggerLike = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function createContext(overrides: Partial<ControlMessageContext> = {}): ControlMessageContext {
  const ctx: ControlMessageContext = {
    adapter: { unsubscribe: vi.fn() } as any,
    activeSubscriptions: new Map(),
    pendingMediaSubs: new Map(),
    removeSubscription: (requestId) => removeSubscription(requestId, ctx),
    pendingTrackStatuses: new Map(),
    catalogRequestId: null,
    catalogTrackAlias: null,
    subscriptionManager: null,
    log: { ...mockLog, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    setCatalogTrackAlias: vi.fn(),
    clearCatalogState: vi.fn(),
    onGoaway: vi.fn(),
    ...overrides,
  };
  return ctx;
}

// ─── handleControlMessage ───────────────────────────────────────────

describe('handleControlMessage', () => {
  it('retains a shared alias until its last subscription is retired', () => {
    const ctx = createContext();
    const unregisterTrack = vi.fn();
    ctx.subscriptionManager = { registerTrack: vi.fn(), unregisterTrack, getMediaType: () => 'video' };
    ctx.activeSubscriptions.set(2n, { trackName: 'video', trackAlias: 40n });
    ctx.activeSubscriptions.set(4n, { trackName: 'video', trackAlias: 40n });
    ctx.removeSubscription(2n);
    expect(unregisterTrack).not.toHaveBeenCalled();
    ctx.removeSubscription(4n);
    expect(unregisterTrack).toHaveBeenCalledExactlyOnceWith(40n);
  });

  it.each(['init', 'mediatimeline', 'eventtimeline'] as const)('REQUEST_ERROR reclaims pending %s ownership', (packaging) => {
    const ctx = createContext();
    const unregisterTrack = vi.fn();
    ctx.subscriptionManager = { registerTrack: vi.fn(), unregisterTrack, getMediaType: () => 'video' };
    ctx.activeSubscriptions.set(2n, { trackName: 'video', trackAlias: 4n });
    ctx.activeSubscriptions.set(4n, { trackName: packaging, trackAlias: null });
    ctx.pendingMediaSubs.set(4n, { trackName: packaging, packaging, mediaType: packaging === 'init' ? 'video' : packaging });
    handleControlMessage({ type: 'REQUEST_ERROR', requestId: 4n, errorCode: 16n, errorReason: 'not found' } as ControlMessage, ctx);
    expect(ctx.activeSubscriptions.has(4n)).toBe(false);
    expect(ctx.pendingMediaSubs.has(4n)).toBe(false);
    expect(ctx.activeSubscriptions.get(2n)?.trackAlias).toBe(4n);
    expect(unregisterTrack).not.toHaveBeenCalled();
  });

  it('GOAWAY: unsubscribes all active subscriptions (§9.4)', () => {
    const ctx = createContext();
    ctx.activeSubscriptions.set(1n, { trackName: 'video', trackAlias: 1n });
    ctx.activeSubscriptions.set(2n, { trackName: 'audio', trackAlias: 2n });

    const msg: ControlMessage = { type: 'GOAWAY', newSessionUri: 'https://new-relay.example.com' };
    handleControlMessage(msg, ctx);

    expect(ctx.adapter!.unsubscribe).toHaveBeenCalledTimes(2);
    expect(ctx.activeSubscriptions.size).toBe(0);
  });

  it('GOAWAY: emits session_goaway event (§9.4)', () => {
    const ctx = createContext();
    const msg: ControlMessage = { type: 'GOAWAY', newSessionUri: 'https://new.example.com' };
    handleControlMessage(msg, ctx);

    expect(ctx.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session_goaway',
      newSessionUri: 'https://new.example.com',
    }));
  });

  it('GOAWAY: calls onGoaway callback (§3.5, §8.4.1)', () => {
    const ctx = createContext();
    const msg: ControlMessage = { type: 'GOAWAY', newSessionUri: 'https://new.example.com' };
    handleControlMessage(msg, ctx);

    expect(ctx.onGoaway).toHaveBeenCalledWith('https://new.example.com');
  });

  it('SUBSCRIBE_OK: stores catalog track alias (§9.10)', () => {
    const ctx = createContext({ catalogRequestId: 1n });
    const setCatalogAlias = vi.fn();
    ctx.setCatalogTrackAlias = setCatalogAlias;

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 1n, trackAlias: 42n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    expect(setCatalogAlias).toHaveBeenCalledWith(42n);
  });

  it('SUBSCRIBE_OK: a catalog alias can equal a pending media request ID', () => {
    const subMgr = {
      unregisterTrack: vi.fn(),
      registerTrack: vi.fn(),
      getMediaType: vi.fn(),
    };
    const ctx = createContext({
      catalogRequestId: 0n,
      subscriptionManager: subMgr as any,
    });
    ctx.activeSubscriptions.set(1n, { trackName: 'video0', trackAlias: null });
    ctx.pendingMediaSubs.set(1n, { trackName: 'video0', mediaType: 'video', packaging: 'loc' });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 1n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    // Catalog alias should be set
    expect(ctx.setCatalogTrackAlias).toHaveBeenCalledWith(1n);
    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
    expect(ctx.activeSubscriptions.get(1n)?.trackAlias).toBeNull();
  });

  it('SUBSCRIBE_OK: registers a pending track whose alias equals the request id when nothing is registered under it (switch target on an alias-echoing relay)', () => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn(), registerTrack: vi.fn(), getMediaType: vi.fn().mockReturnValue(undefined) };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(7n, { trackName: 'video-360', mediaType: 'video', packaging: 'locmaf' });
    ctx.activeSubscriptions.set(7n, { trackName: 'video-360', trackAlias: null });
    const resolved: bigint[] = [];
    ctx.onAliasResolved = (alias) => resolved.push(alias);

    handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId: 7n, trackAlias: 7n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    } as ControlMessage, ctx);

    expect(subMgr.registerTrack).toHaveBeenCalledWith(7n, 'video-360', 'video', 'locmaf');
    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
    expect(resolved).toEqual([7n]);
  });

  it('SUBSCRIBE_OK: a second subscription to the same track may share its alias', () => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn(), registerTrack: vi.fn(), getMediaType: vi.fn().mockReturnValue('video') };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(3n, { trackName: 'video', mediaType: 'video', packaging: 'loc' });
    ctx.activeSubscriptions.set(2n, { trackName: 'video', trackAlias: 3n });
    ctx.activeSubscriptions.set(3n, { trackName: 'video', trackAlias: null });

    handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId: 3n, trackAlias: 3n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    } as ControlMessage, ctx);

    expect(subMgr.registerTrack).toHaveBeenCalledWith(3n, 'video', 'video', 'loc');
    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
  });

  it('SUBSCRIBE_OK: binds and replays only the assigned alias, not the request ID', () => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn(), registerTrack: vi.fn(), getMediaType: vi.fn().mockReturnValue(undefined) };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(5n, { trackName: 'video', mediaType: 'video', packaging: 'loc' });
    ctx.activeSubscriptions.set(5n, { trackName: 'video', trackAlias: null });
    ctx.onAliasResolved = vi.fn();
    ctx.onMediaAliasBound = vi.fn();

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 5n, trackAlias: 99n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
    expect(subMgr.registerTrack).toHaveBeenCalledWith(99n, 'video', 'video', 'loc');
    expect(ctx.activeSubscriptions.get(5n)?.trackAlias).toBe(99n);
    expect(ctx.onAliasResolved).toHaveBeenCalledExactlyOnceWith(99n);
    expect(ctx.onMediaAliasBound).toHaveBeenCalledExactlyOnceWith(5n, 99n);
  });

  it.each(['mediatimeline', 'eventtimeline'] as const)('SUBSCRIBE_OK: binds %s without unregistering its request ID', (packaging) => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn(), registerTrack: vi.fn(), getMediaType: vi.fn().mockReturnValue(undefined) };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(7n, { trackName: packaging, mediaType: packaging, packaging });
    ctx.activeSubscriptions.set(7n, { trackName: packaging, trackAlias: null });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 7n, trackAlias: 77n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
    expect(subMgr.registerTrack).toHaveBeenCalledWith(77n, packaging, packaging, packaging);
    expect(ctx.activeSubscriptions.get(7n)?.trackAlias).toBe(77n);
  });

  it('SUBSCRIBE_OK: init alias may equal another pending request ID', () => {
    const ctx = createContext();
    const subMgr = {
      unregisterTrack: vi.fn(),
      registerTrack: vi.fn(),
      getMediaType: vi.fn(),
    };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(2n, { trackName: 'video', mediaType: 'video', packaging: 'cmaf' });
    ctx.activeSubscriptions.set(2n, { trackName: 'video', trackAlias: null });
    ctx.pendingMediaSubs.set(6n, { trackName: '0.mp4', mediaType: 'video', packaging: 'init' });
    ctx.activeSubscriptions.set(6n, { trackName: '0.mp4', trackAlias: null });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 6n, trackAlias: 2n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
    expect(subMgr.registerTrack).toHaveBeenCalledWith(2n, '0.mp4', 'video', 'init');
    expect(ctx.activeSubscriptions.get(6n)?.trackAlias).toBe(2n);
    expect(ctx.activeSubscriptions.get(2n)?.trackAlias).toBeNull();
  });

  it('PUBLISH_DONE: cleans up subscription and emits event (§9.15)', () => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn() };
    ctx.subscriptionManager = subMgr as any;
    ctx.activeSubscriptions.set(3n, { trackName: 'audio', trackAlias: 3n });

    const msg: ControlMessage = {
      type: 'PUBLISH_DONE', requestId: 3n,
      finalObject: undefined, errorCode: 0n, errorReason: 'stream ended',
    };
    handleControlMessage(msg, ctx);

    expect(ctx.activeSubscriptions.size).toBe(0);
    expect(subMgr.unregisterTrack).toHaveBeenCalledWith(3n);
    expect(ctx.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'track_unsubscribed',
      trackName: 'audio',
      reason: 'stream ended',
    }));
  });

  it('REQUEST_OK: resolves pending track status (§9.7)', () => {
    const ctx = createContext();
    const resolve = vi.fn();
    ctx.pendingTrackStatuses.set(10n, { resolve, reject: vi.fn() });

    const msg: ControlMessage = {
      type: 'REQUEST_OK', requestId: 10n, parameters: [],
    };
    handleControlMessage(msg, ctx);

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 10n,
    }));
    expect(ctx.pendingTrackStatuses.size).toBe(0);
  });

  it('REQUEST_ERROR: rejects pending track status (§9.8)', () => {
    const ctx = createContext();
    const reject = vi.fn();
    ctx.pendingTrackStatuses.set(11n, { resolve: vi.fn(), reject });

    const msg: ControlMessage = {
      type: 'REQUEST_ERROR', requestId: 11n,
      errorCode: 0x1n, errorReason: 'not found',
    };
    handleControlMessage(msg, ctx);

    expect(reject).toHaveBeenCalled();
    expect(ctx.pendingTrackStatuses.size).toBe(0);
  });

  it('REQUEST_ERROR: retires a pending request without unregistering an alias', () => {
    const unregisterTrack = vi.fn();
    const onMediaSubscribeError = vi.fn();
    const ctx = createContext({
      onMediaSubscribeError,
      subscriptionManager: {
        registerTrack: vi.fn(),
        unregisterTrack,
        getMediaType: vi.fn(),
      } as any,
    });
    ctx.pendingMediaSubs.set(5n, { trackName: 'video', mediaType: 'video' });
    ctx.activeSubscriptions.set(5n, { trackName: 'video', trackAlias: null });

    const msg: ControlMessage = {
      type: 'REQUEST_ERROR', requestId: 5n,
      errorCode: 0x10n, errorReason: 'Track not found',
    };
    handleControlMessage(msg, ctx);

    expect(ctx.pendingMediaSubs.size).toBe(0);
    expect(ctx.activeSubscriptions.size).toBe(0);
    expect(unregisterTrack).not.toHaveBeenCalled();
    expect(onMediaSubscribeError).toHaveBeenCalledWith(5n, 'video', 'video', 'Track not found', 0x10n);
  });

  it('ignores unhandled message types', () => {
    const ctx = createContext();
    const msg = { type: 'CLIENT_SETUP' } as any;
    // Should not throw
    handleControlMessage(msg, ctx);
    expect(ctx.emitEvent).not.toHaveBeenCalled();
  });
});

// ─── validateKnownTracks ────────────────────────────────────────────

describe('validateKnownTracks', () => {
  const log: LoggerLike = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };

  it('warns when video track not found in catalog', () => {
    const warnFn = vi.fn();
    const l = { ...log, warn: warnFn };
    const kt = { video: { name: 'video', codec: 'avc1' } };
    const catalog: CatalogState = { tracks: [] as CatalogTrack[] } as CatalogState;

    validateKnownTracks(kt as any, catalog, l);
    expect(warnFn).toHaveBeenCalledWith(expect.stringContaining('not found'), 'video');
  });

  it('warns on codec mismatch', () => {
    const warnFn = vi.fn();
    const l = { ...log, warn: warnFn };
    const kt = { video: { name: 'video', codec: 'avc1.64001e' } };
    const catalog: CatalogState = {
      tracks: [{ name: 'video', codec: 'vp09.00.10.08' }] as CatalogTrack[],
    } as CatalogState;

    validateKnownTracks(kt as any, catalog, l);
    expect(warnFn).toHaveBeenCalledWith(
      expect.stringContaining('codec mismatch'),
      'avc1.64001e', 'vp09.00.10.08',
    );
  });

  it('no warnings when tracks match', () => {
    const warnFn = vi.fn();
    const l = { ...log, warn: warnFn };
    const kt = {
      video: { name: 'video', codec: 'avc1.64001e' },
      audio: { name: 'audio', codec: 'opus' },
    };
    const catalog: CatalogState = {
      tracks: [
        { name: 'video', codec: 'avc1.64001e' } as CatalogTrack,
        { name: 'audio', codec: 'opus' } as CatalogTrack,
      ],
    } as CatalogState;

    validateKnownTracks(kt as any, catalog, l);
    expect(warnFn).not.toHaveBeenCalled();
  });

  it('warns when audio track not found', () => {
    const warnFn = vi.fn();
    const l = { ...log, warn: warnFn };
    const kt = { audio: { name: 'audio', codec: 'opus' } };
    const catalog: CatalogState = { tracks: [] as CatalogTrack[] } as CatalogState;

    validateKnownTracks(kt as any, catalog, l);
    expect(warnFn).toHaveBeenCalledWith(expect.stringContaining('not found'), 'audio');
  });
});
