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
  return {
    adapter: { unsubscribe: vi.fn() } as any,
    activeSubscriptions: new Map(),
    pendingMediaSubs: new Map(),
    pendingTrackStatuses: new Map(),
    catalogRequestId: null,
    catalogTrackAlias: null,
    subscriptionManager: null,
    log: { ...mockLog, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    setCatalogTrackAlias: vi.fn(),
    onGoaway: vi.fn(),
    ...overrides,
  };
}

// ─── handleControlMessage ───────────────────────────────────────────

describe('handleControlMessage', () => {
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

  it('SUBSCRIBE_OK: evicts optimistic media alias when catalog claims it (§9.10)', () => {
    // Scenario: catalog reqId=0, video reqId=1 (optimistically registered as alias=1).
    // Server returns SUBSCRIBE_OK for catalog with trackAlias=1.
    // The optimistic video registration at alias=1 must be evicted so catalog
    // objects route to the catalog handler, not the media pipeline.
    const subMgr = {
      unregisterTrack: vi.fn(),
      registerTrack: vi.fn(),
      getMediaType: vi.fn().mockReturnValue('video'), // alias=1 claimed by video
    };
    const ctx = createContext({
      catalogRequestId: 0n,
      subscriptionManager: subMgr as any,
    });
    // Video was optimistically registered at alias=1 (reqId=1)
    ctx.activeSubscriptions.set(1n, { trackName: 'video0', trackAlias: 1n });
    ctx.pendingMediaSubs.set(1n, { trackName: 'video0', mediaType: 'video', packaging: 'loc' });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 1n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    // Catalog alias should be set
    expect(ctx.setCatalogTrackAlias).toHaveBeenCalledWith(1n);
    // Video's optimistic alias=1 must be evicted
    expect(subMgr.unregisterTrack).toHaveBeenCalledWith(1n);
  });

  it('SUBSCRIBE_OK: re-registers track when alias differs (§9.10)', () => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn(), registerTrack: vi.fn(), getMediaType: vi.fn().mockReturnValue(undefined) };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(5n, { trackName: 'video', mediaType: 'video', packaging: 'loc' });
    ctx.activeSubscriptions.set(5n, { trackName: 'video', trackAlias: 5n });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 5n, trackAlias: 99n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    expect(subMgr.unregisterTrack).toHaveBeenCalledWith(5n);
    expect(subMgr.registerTrack).toHaveBeenCalledWith(99n, 'video', 'video', 'loc');
    expect(ctx.activeSubscriptions.get(5n)?.trackAlias).toBe(99n);
  });

  it('SUBSCRIBE_OK: re-registers mediatimeline track when alias differs (§9.10)', () => {
    const ctx = createContext();
    const subMgr = { unregisterTrack: vi.fn(), registerTrack: vi.fn(), getMediaType: vi.fn().mockReturnValue(undefined) };
    ctx.subscriptionManager = subMgr as any;
    ctx.pendingMediaSubs.set(7n, { trackName: 'mediatimeline', mediaType: 'mediatimeline', packaging: 'mediatimeline' });
    ctx.activeSubscriptions.set(7n, { trackName: 'mediatimeline', trackAlias: 7n });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 7n, trackAlias: 77n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    expect(subMgr.unregisterTrack).toHaveBeenCalledWith(7n);
    expect(subMgr.registerTrack).toHaveBeenCalledWith(77n, 'mediatimeline', 'mediatimeline', 'mediatimeline');
    expect(ctx.activeSubscriptions.get(7n)?.trackAlias).toBe(77n);
  });

  it('SUBSCRIBE_OK: skips re-register when alias collides with existing track (§9.10)', () => {
    const ctx = createContext();
    const subMgr = {
      unregisterTrack: vi.fn(),
      registerTrack: vi.fn(),
      getMediaType: vi.fn().mockReturnValue('video'), // alias 2n already has video track
    };
    ctx.subscriptionManager = subMgr as any;
    // Init track at reqId=6 gets server alias=2, which collides with video at alias=2
    ctx.pendingMediaSubs.set(6n, { trackName: '0.mp4', mediaType: 'video', packaging: 'init' });
    ctx.activeSubscriptions.set(6n, { trackName: '0.mp4', trackAlias: 6n });

    const msg: ControlMessage = {
      type: 'SUBSCRIBE_OK', requestId: 6n, trackAlias: 2n,
      expires: 0n, groupOrder: 0x1n, contentExists: false,
    };
    handleControlMessage(msg, ctx);

    // Should NOT re-register — alias 2n is occupied
    expect(subMgr.unregisterTrack).not.toHaveBeenCalled();
    expect(subMgr.registerTrack).not.toHaveBeenCalled();
    // Active subscription alias should remain unchanged
    expect(ctx.activeSubscriptions.get(6n)?.trackAlias).toBe(6n);
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

  it('REQUEST_ERROR: cleans optimistic active subscription and alias for refused media (§9.8)', () => {
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
    ctx.activeSubscriptions.set(5n, { trackName: 'video', mediaType: 'video', trackAlias: 5n });

    const msg: ControlMessage = {
      type: 'REQUEST_ERROR', requestId: 5n,
      errorCode: 0x10n, errorReason: 'Track not found',
    };
    handleControlMessage(msg, ctx);

    expect(ctx.pendingMediaSubs.size).toBe(0);
    expect(ctx.activeSubscriptions.size).toBe(0);
    expect(unregisterTrack).toHaveBeenCalledWith(5n);
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
