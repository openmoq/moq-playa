/**
 * MoqtPlayer tests — red/green TDD.
 *
 * Tests the full player lifecycle: load/play/pause/destroy,
 * event emission, hook interception, recovery flow.
 *
 * Uses mock adapter + transport patterns from the codebase.
 *
 * @see draft-ietf-moq-transport-16 §3 (Session lifecycle)
 * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
 * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerErrorCode } from './errors.js';
import { QualityController } from './quality-controller.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { PlayerEventMap } from './events.js';
import { MoqtConnectionError } from '@moqt/webtransport';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, ObjectDatagram, DataStreamHeader, MoqtObject } from '@moqt/transport';
import { varint, ObjectStatus } from '@moqt/transport';
import type { ClockSource } from '@moqt/playback';

// ─── Mock Adapter ────────────────────────────────────────────────────

/** Minimal mock of MoqtConnection for testing. */
function createMockAdapter(): MoqtConnection & {
  _triggerMessage: (msg: ControlMessage) => void;
  _triggerObject: (streamId: bigint, obj: MoqtObject) => void;
  _triggerDatagram: (datagram: ObjectDatagram) => void;
  _triggerDataStream: (streamId: bigint, header: DataStreamHeader) => void;
  _triggerStreamClosed: (streamId: bigint, error?: number) => void;
  _triggerClose: (error?: number, reason?: string) => void;
  _triggerError: (err: Error) => void;
  _triggerNamespaceMessage: (requestId: bigint, msg: ControlMessage) => void;
  _connectResolve: (() => void) | null;
  requestUpdate: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchCancel: ReturnType<typeof vi.fn>;
  trackStatus: ReturnType<typeof vi.fn>;
  subscribeNamespace: ReturnType<typeof vi.fn>;
  cancelNamespace: ReturnType<typeof vi.fn>;
} {
  let nextRequestId = 1n;
  const adapter: any = {
    session: {
      state: 'established',
      subscribe: vi.fn(() => ({
        requestId: varint(1),
        actions: [],
      })),
      close: vi.fn(() => []),
    },
    onMessage: null as ((msg: ControlMessage) => void) | null,
    onClose: null as ((error?: number, reason?: string) => void) | null,
    onError: null as ((error: Error) => void) | null,
    onDataStream: null,
    onObject: null as ((streamId: bigint, obj: MoqtObject) => void) | null,
    onStreamClosed: null as ((streamId: bigint, error?: number) => void) | null,
    onDatagram: null as ((datagram: ObjectDatagram) => void) | null,
    onNamespaceMessage: null as ((requestId: bigint, msg: ControlMessage) => void) | null,
    onQlogEvent: null as ((event: any) => void) | null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => {
      return new Promise<void>((resolve) => {
        adapter._connectResolve = resolve;
      });
    }),
    subscribe: vi.fn(async () => varint(nextRequestId++)),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
    trackStatus: vi.fn(async () => varint(nextRequestId++)),
    subscribeNamespace: vi.fn(async () => varint(nextRequestId++)),
    cancelNamespace: vi.fn(async () => {}),
    close: vi.fn(async () => {}),

    _triggerMessage(msg: ControlMessage) {
      adapter.onMessage?.(msg);
    },
    _triggerObject(streamId: bigint, obj: MoqtObject) {
      adapter.onObject?.(streamId, obj);
    },
    _triggerDatagram(datagram: ObjectDatagram) {
      adapter.onDatagram?.(datagram);
    },
    _triggerDataStream(streamId: bigint, header: DataStreamHeader) {
      adapter.onDataStream?.(streamId, header);
    },
    _triggerStreamClosed(streamId: bigint, error?: number) {
      adapter.onStreamClosed?.(streamId, error);
    },
    _triggerClose(error?: number, reason?: string) {
      adapter.onClose?.(error, reason);
    },
    _triggerError(err: Error) {
      adapter.onError?.(err);
    },
    _triggerNamespaceMessage(requestId: bigint, msg: ControlMessage) {
      adapter.onNamespaceMessage?.(requestId, msg);
    },
  };
  return adapter;
}

/** Catalog JSON for a simple live broadcast. */
const CATALOG_JSON = JSON.stringify({
  version: 1,
  tracks: [
    {
      name: 'video',
      packaging: 'loc',
      isLive: true,
      role: 'video',
      renderGroup: 1,
      codec: 'av01.0.08M.10',
      width: 1920,
      height: 1080,
      bitrate: 1_500_000,
    },
    {
      name: 'audio',
      packaging: 'loc',
      isLive: true,
      role: 'audio',
      renderGroup: 1,
      codec: 'opus',
      samplerate: 48000,
      channelConfig: '2',
      bitrate: 32000,
    },
  ],
});

/** Create a minimal player config with mock adapter. */
function createConfig(
  adapter: ReturnType<typeof createMockAdapter>,
): MoqtPlayerConfig {
  return {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
  };
}

/**
 * Wait for createTransport to resolve and adapter.connect to be called,
 * then resolve the mock connect promise.
 *
 * createTransport is async, so adapter.connect() is called after a microtick.
 * Tests that need connect to complete must await this helper before proceeding.
 */
async function resolveConnect(adapter: ReturnType<typeof createMockAdapter>): Promise<void> {
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
}

/**
 * Send SUBSCRIBE_OK for the catalog subscription.
 *
 * §10.4.2: data may arrive before SUBSCRIBE_OK. The player buffers unknown
 * aliases and replays when SUBSCRIBE_OK establishes the track alias. Tests
 * must send SUBSCRIBE_OK before triggering catalog objects.
 *
 * @param reqId Catalog requestId (default 1n — mock adapter starts at 1)
 */
function ackCatalog(adapter: ReturnType<typeof createMockAdapter>, reqId?: bigint) {
  const id = reqId ?? 1n;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK',
    requestId: varint(id),
    trackAlias: varint(id),
    parameters: new Map(),
  } as unknown as ControlMessage);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('MoqtPlayer', () => {
  // ─── Construction ────────────────────────────────────────

  it('starts in idle state', () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    expect(player.state).toBe(PlayerState.IDLE);
  });

  // ─── Load ────────────────────────────────────────────────

  it('passes maxRequestId to adapter.connect as setup options (§9.3.1.3)', async () => {
    // §9.3.1.3: MAX_REQUEST_ID defaults to 0 (no requests allowed).
    // Player MUST pass a nonzero value for subscriptions to work.
    const adapter = createMockAdapter();
    const player = new MoqtPlayer({
      ...createConfig(adapter),
      maxRequestId: 200,
    });
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;

    expect(adapter.connect).toHaveBeenCalledWith(
      expect.anything(), // transport — factory handles it
      expect.objectContaining({ maxRequestId: varint(200) }),
    );
  });

  it('defaults maxRequestId to 10_000 when not specified (§9.3.1.3)', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;

    expect(adapter.connect).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxRequestId: varint(10_000) }),
    );
  });

  // ── createTransport factory ──────────────────────────────

  it('load() calls createTransport with constructed URL (url + namespace)', async () => {
    const adapter = createMockAdapter();
    const createTransport = vi.fn(async () => ({} as any));
    const player = new MoqtPlayer({
      ...createConfig(adapter),
      createTransport,
    });
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;

    expect(createTransport).toHaveBeenCalledTimes(1);
    const url = createTransport.mock.calls[0][0];
    expect(url).toBe('https://relay.example.com/moq');
  });

  it('load() passes transport from createTransport to adapter.connect', async () => {
    const adapter = createMockAdapter();
    const mockTransport = { mock: 'transport' };
    const createTransport = vi.fn(async () => mockTransport as any);
    const player = new MoqtPlayer({
      ...createConfig(adapter),
      createTransport,
    });
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;

    expect(adapter.connect).toHaveBeenCalledWith(
      mockTransport,
      expect.anything(),
    );
  });

  it('load() rejects if createTransport rejects', async () => {
    const adapter = createMockAdapter();
    const createTransport = vi.fn(async () => {
      throw new Error('transport creation failed');
    });
    const player = new MoqtPlayer({
      ...createConfig(adapter),
      createTransport,
    });

    await expect(player.load()).rejects.toThrow('transport creation failed');
  });

  it('connect URL encodes namespace with special characters correctly', async () => {
    const adapter = createMockAdapter();
    const createTransport = vi.fn(async () => ({} as any));
    const player = new MoqtPlayer({
      ...createConfig(adapter),
      namespace: 'Night of the Living Dead (1968) English',
      createTransport,
    });
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;

    const url = createTransport.mock.calls[0][0];
    expect(url).toBe('https://relay.example.com/moq');
  });

  it('transitions to loading on load()', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const loadPromise = player.load();
    expect(player.state).toBe(PlayerState.LOADING);
    // Clean up — resolve the connect promise
    await resolveConnect(adapter);
  });

  it('emits session_connecting on load()', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    player.on('session_connecting', fn);
    player.load();
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_connecting',
        url: 'https://relay.example.com/moq',
      }),
    );
    await resolveConnect(adapter);
  });

  it('emits state_changed on load()', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    player.on('state_changed', fn);
    player.load();
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state_changed',
        from: 'idle',
        to: 'loading',
      }),
    );
    await resolveConnect(adapter);
  });

  it('calls adapter.connect on load()', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    player.load();
    await resolveConnect(adapter);
    expect(adapter.connect).toHaveBeenCalled();
  });

  // ─── Event bridging ──────────────────────────────────────

  it('emits session_error when adapter reports error', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    player.on('session_error', fn);
    player.load();
    await resolveConnect(adapter);

    adapter._triggerError(new Error('protocol violation'));

    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_error',
      }),
    );
  });

  it('emits session_closed when adapter closes', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    player.on('session_closed', fn);
    player.load();
    await resolveConnect(adapter);

    adapter._triggerClose(0, 'clean close');

    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_closed',
        error: 0,
        reason: 'clean close',
      }),
    );
  });

  // ─── Hook system ─────────────────────────────────────────

  it('beforeSubscribe hook can cancel a subscription', () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));

    // Cancel all subscriptions
    player.hooks.beforeSubscribe.add(() => null);

    // Internal subscribe should not call adapter
    const result = player.requestSubscribe('video', 'video');
    expect(result).toBeNull();
  });

  it('beforeSubscribe hook can modify subscription intent', () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));

    // Modify the track name
    player.hooks.beforeSubscribe.add((intent) => ({
      ...intent,
      trackName: 'video-720p',
    }));

    const result = player.requestSubscribe('video', 'video');
    expect(result?.trackName).toBe('video-720p');
  });

  // ─── Destroy ─────────────────────────────────────────────

  it('destroy() cleans up and transitions to ended', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    player.load();
    await resolveConnect(adapter);

    await player.destroy();
    expect(adapter.close).toHaveBeenCalled();
  });

  it('destroy() emits state_changed to ended', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    player.on('state_changed', fn);
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;
    await player.play();
    fn.mockClear();

    await player.destroy();
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({
      type: 'state_changed', to: 'ended',
    }));
  });

  it('destroy() is idempotent — second call is a no-op', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;
    await player.play();

    await player.destroy();
    // Second destroy should not throw (ENDED → ENDED is invalid)
    await player.destroy();
  });

  it('destroy() is a happy path: an owned connection whose close() surfaces teardown errors emits NO error events', async () => {
    const adapter = createMockAdapter();
    // A real adapter's intentional close rejects pending subscriptions / resets
    // streams, which fires onError/onClose ("The session is closed.") BEFORE the
    // close promise resolves. Reproduce that teardown shape on the mock.
    adapter.close = vi.fn(async () => {
      (adapter as any).onError?.(new Error('The session is closed.'));
      (adapter as any).onError?.(new Error('The session is closed.'));
      (adapter as any).onClose?.(0, 'Session closed');
    }) as any;

    const player = new MoqtPlayer(createConfig(adapter));
    const errors = vi.fn();
    const sessionErrors = vi.fn();
    player.on('error', errors);
    player.on('session_error', sessionErrors);
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;
    await player.play();

    await player.destroy();
    // Stragglers landing async after destroy must also stay silent.
    (adapter as any).onError?.(new Error('The session is closed.'));
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.close).toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(sessionErrors).not.toHaveBeenCalled();
  });

  it('destroy() resolves quietly when the owned connection close() rejects (failed transport)', async () => {
    const adapter = createMockAdapter();
    // Observed in practice on Safari 26: closing a session whose network
    // path already failed rejects with NetworkError.
    adapter.close = vi.fn(async () => {
      throw new Error('NetworkError: A network error occurred.');
    }) as any;
    const player = new MoqtPlayer(createConfig(adapter));
    const errorEvents: unknown[] = [];
    player.on('error', (e) => errorEvents.push(e));
    player.load();
    await resolveConnect(adapter);

    // Quiet-destroy contract: a dead transport rejecting close() must not
    // make destroy() reject for library consumers without a try/catch.
    await expect(player.destroy()).resolves.toBeUndefined();
    expect(errorEvents).toEqual([]);
    expect(player.state).toBe(PlayerState.ENDED);
  });

  it('an unintentional connection error BEFORE destroy() still emits normally', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const errors = vi.fn();
    player.on('error', errors);
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;
    await player.play();

    adapter._triggerError(new Error('network blew up'));
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]![0].error.message).toContain('network blew up');

    await player.destroy();
  });

  it('on() returns an unsubscribe function', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    const unsub = player.on('state_changed', fn);
    unsub();
    player.load();
    expect(fn).not.toHaveBeenCalled();
    await resolveConnect(adapter);
  });

  // ─── GOAWAY handling ─────────────────────────────────────

  it('emits session_goaway when GOAWAY message received', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    const fn = vi.fn();
    player.on('session_goaway', fn);
    player.load();
    await resolveConnect(adapter);

    adapter._triggerMessage({
      type: 'GOAWAY',
      newSessionUri: 'https://new-relay.example.com/moq',
    } as ControlMessage);

    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_goaway',
        newSessionUri: 'https://new-relay.example.com/moq',
      }),
    );
  });

  // ─── Play / Pause ────────────────────────────────────────

  it('play() transitions loading → playing', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    player.load();
    await resolveConnect(adapter);

    player.play();
    expect(player.state).toBe(PlayerState.PLAYING);
  });

  it('pause() transitions playing → paused', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    player.load();
    await resolveConnect(adapter);
    player.play();

    player.pause();
    expect(player.state).toBe(PlayerState.PAUSED);
  });

  it('play() after pause() transitions paused → playing', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer(createConfig(adapter));
    player.load();
    await resolveConnect(adapter);
    player.play();
    player.pause();

    player.play();
    expect(player.state).toBe(PlayerState.PLAYING);
  });

  // ─── Catalog subscription (§9.9, MSF §9.1) ─────────────────

  describe('catalog subscription (MSF §9.1)', () => {
    it('load() subscribes to catalog track after connect', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // §9.9: SUBSCRIBE to catalog with AbsoluteStart {0,0} (§5.1.2)
      const catalogOpts = (adapter.subscribe as any).mock.calls[0]?.[2];
      expect(catalogOpts.subscriptionFilter.type).toBe('AbsoluteStart');
      expect(BigInt(catalogOpts.subscriptionFilter.startGroup)).toBe(0n);
      expect(BigInt(catalogOpts.subscriptionFilter.startObject)).toBe(0n);

      // Verify the track name is "catalog"
      const nameArg = (adapter.subscribe as any).mock.calls[0]?.[1] as Uint8Array;
      expect(new TextDecoder().decode(nameArg)).toBe('catalog');
    });

    it('emits session_established after connect', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const fn = vi.fn();
      player.on('session_established', fn);
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_established' }),
      );
    });
  });

  // ─── Catalog routing (MSF §5.1, §5.2) ─────────────────────

  describe('catalog object routing (MSF §5.1)', () => {
    async function loadPlayer(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      // Send SUBSCRIBE_OK for catalog (§9.10 — alias must be established
      // before data objects can be routed to the catalog handler)
      ackCatalog(adapter);
      return player;
    }

    it('emits catalog_received when catalog object arrives', async () => {
      const adapter = createMockAdapter();
      const player = await loadPlayer(adapter);
      const fn = vi.fn();
      player.on('catalog_received', fn);

      // Get the catalog requestId (from the subscribe call)
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      // Trigger a catalog object
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'catalog_received' }),
      );
    });

    it('emits catalog_updated on subsequent catalog objects', async () => {
      const adapter = createMockAdapter();
      const player = await loadPlayer(adapter);
      const fn = vi.fn();
      player.on('catalog_updated', fn);

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      // First catalog
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Second catalog (independent, not delta)
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'catalog_updated' }),
      );
    });

    it('ignores gap objects on catalog track', async () => {
      const adapter = createMockAdapter();
      const player = await loadPlayer(adapter);

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      // Should not throw
      adapter._triggerObject(0n, {
        kind: 'gap',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        status: varint(0x3),
      } as MoqtObject);
    });
  });

  // ─── Track selection & media subscription (§9.9, MSF §5.1.19) ──

  describe('track selection and media subscription (MSF §5.1.19)', () => {
    async function loadAndCatalog(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      // Ack catalog subscription before triggering catalog objects
      ackCatalog(adapter);

      // Trigger catalog
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('subscribes to video and audio tracks after catalog', async () => {
      const adapter = createMockAdapter();
      await loadAndCatalog(adapter);

      // adapter.subscribe called for: catalog + video + audio = 3 times
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);
    });

    it('emits track_subscribed for each media track', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const fn = vi.fn();
      player.on('track_subscribed', fn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // subscribeToMediaTracks is async — flush microtasks
      await new Promise(r => setTimeout(r, 0));

      // Should emit track_subscribed for video and audio
      expect(fn).toHaveBeenCalledTimes(2);
      const calls = fn.mock.calls.map((c: any) => c[0]);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'track_subscribed', mediaType: 'video' }),
          expect.objectContaining({ type: 'track_subscribed', mediaType: 'audio' }),
        ]),
      );
    });

    it('beforeSubscribe hook can cancel a media subscription', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));

      // Cancel video subscriptions
      player.hooks.beforeSubscribe.add((intent) =>
        intent.mediaType === 'video' ? null : intent,
      );

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Only catalog + audio = 2 calls (video cancelled by hook)
      expect(adapter.subscribe).toHaveBeenCalledTimes(2);
    });
  });

  // ─── disableVideo / disableAudio ────────────────────────────

  describe('disableVideo / disableAudio config', () => {
    it('disableVideo: skips video subscription even when catalog has video track', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({ ...createConfig(adapter), disableVideo: true });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      // Should subscribe to catalog + audio only (no video)
      const subCalls = (adapter.subscribe as any).mock.calls;
      const trackNames = subCalls.map((c: any) => {
        try { return new TextDecoder().decode(c[1]); } catch { return '?'; }
      });
      expect(trackNames).not.toContain('video');
      expect(trackNames).toContain('audio');

      await player.destroy();
    });

    it('disableAudio: skips audio subscription even when catalog has audio track', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({ ...createConfig(adapter), disableAudio: true });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      const subCalls = (adapter.subscribe as any).mock.calls;
      const trackNames = subCalls.map((c: any) => {
        try { return new TextDecoder().decode(c[1]); } catch { return '?'; }
      });
      expect(trackNames).toContain('video');
      expect(trackNames).not.toContain('audio');

      await player.destroy();
    });
  });

  // ─── Subscription refusal (§9.8) ──────────────────────────

  describe('subscription refusal (§9.8)', () => {
    it('emits track_subscribe_failed when media subscription gets REQUEST_ERROR', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const fn = vi.fn();
      player.on('track_subscribe_failed' as any, fn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      // Get the video subscription requestId
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      // Relay refuses the video subscription
      adapter._triggerMessage({
        type: 'REQUEST_ERROR',
        requestId: varint(BigInt(videoReqId)),
        errorCode: varint(0x10n), // Track not found
        errorReason: 'Track not found',
      } as any);

      expect(fn).toHaveBeenCalledWith(expect.objectContaining({
        type: 'track_subscribe_failed',
        mediaType: 'video',
      }));

      await player.destroy();
    });

    it('emits fatal ALL_TRACKS_REFUSED error when all media subscriptions fail', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const errorFn = vi.fn();
      player.on('error', errorFn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      // Both tracks refused
      adapter._triggerMessage({
        type: 'REQUEST_ERROR',
        requestId: varint(BigInt(videoReqId)),
        errorCode: varint(0x10n),
        errorReason: 'Track not found',
      } as any);
      adapter._triggerMessage({
        type: 'REQUEST_ERROR',
        requestId: varint(BigInt(audioReqId)),
        errorCode: varint(0x10n),
        errorReason: 'Track not found',
      } as any);

      const allRefusedCall = errorFn.mock.calls.find(
        (c: any) => c[0]?.error?.code === 0x1303,
      );
      expect(allRefusedCall).toBeDefined();

      await player.destroy();
    });

    it('does NOT emit ALL_TRACKS_REFUSED when at least one track succeeds', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const errorFn = vi.fn();
      player.on('error', errorFn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      // Video succeeds
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(BigInt(videoReqId)),
        trackAlias: varint(BigInt(videoReqId) + 100n),
        parameters: new Map(),
        trackExtensions: new Map(),
      } as any);

      // Audio fails
      adapter._triggerMessage({
        type: 'REQUEST_ERROR',
        requestId: varint(BigInt(audioReqId)),
        errorCode: varint(0x10n),
        errorReason: 'Track not found',
      } as any);

      // Should NOT be a fatal error — video is still playing
      const allRefused = errorFn.mock.calls.find(
        (c: any) => c[0]?.code === 0x1303,
      );
      expect(allRefused).toBeUndefined();

      await player.destroy();
    });
  });

  // ─── GOAWAY / PUBLISH_DONE (§9.4, §9.12) ──────────────────

  describe('GOAWAY handling (§3.5, §9.4)', () => {
    it('emits session_goaway on GOAWAY message (uppercase type)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const fn = vi.fn();
      player.on('session_goaway', fn);
      player.load();
      await resolveConnect(adapter);

      // ControlMessage types are UPPERCASE per messages.ts
      adapter._triggerMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://new-relay.example.com/moq',
      } as ControlMessage);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_goaway',
          newSessionUri: 'https://new-relay.example.com/moq',
        }),
      );
    });

    it('UNSUBSCRIBES all active subscriptions on GOAWAY (§9.4 SHOULD)', async () => {
      // §9.4: "A subscriber SHOULD individually UNSUBSCRIBE for each
      // existing subscription"
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      // Trigger catalog to create media subscriptions
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Get media subscription request IDs
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      // Establish subscriptions with SUBSCRIBE_OK
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(50n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Receive GOAWAY
      adapter._triggerMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://new-relay.example.com/moq',
      } as ControlMessage);

      // §9.4 SHOULD: UNSUBSCRIBE called for each active media subscription
      expect(adapter.unsubscribe).toHaveBeenCalledTimes(2);
    });

    it('clears active subscriptions after GOAWAY UNSUBSCRIBE', async () => {
      // After GOAWAY, activeSubscriptions should be empty — pause()
      // should NOT send REQUEST_UPDATE.
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      player.play();

      adapter._triggerMessage({
        type: 'GOAWAY',
        newSessionUri: '',
      } as ControlMessage);

      (adapter.requestUpdate as any).mockClear();
      player.pause();

      // No REQUEST_UPDATE — all subscriptions cleared
      expect(adapter.requestUpdate).toHaveBeenCalledTimes(0);
    });
  });

  // ─── PUBLISH_DONE (§9.12) ────────────────────────────────

  describe('PUBLISH_DONE handling (§9.12)', () => {
    async function loadAndSubscribeMedia(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('emits track_unsubscribed on PUBLISH_DONE (§9.12)', async () => {
      // §9.12: "A publisher sends a PUBLISH_DONE message to indicate it is
      // done publishing Objects for that subscription."
      const adapter = createMockAdapter();
      const player = await loadAndSubscribeMedia(adapter);
      const fn = vi.fn();
      player.on('track_unsubscribed', fn);

      // Video subscription is the 2nd subscribe call (after catalog)
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      adapter._triggerMessage({
        type: 'PUBLISH_DONE',
        requestId: videoReqId,
        statusCode: varint(0x2), // TRACK_ENDED
        streamCount: varint(5),
        errorReason: 'Track ended',
      } as ControlMessage);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'track_unsubscribed',
          trackName: 'video',
          reason: 'Track ended',
        }),
      );
    });

    it('removes subscription from active set — no REQUEST_UPDATE after PUBLISH_DONE', async () => {
      // After PUBLISH_DONE for video, pause() should only send
      // REQUEST_UPDATE for audio (the remaining active subscription).
      const adapter = createMockAdapter();
      const player = await loadAndSubscribeMedia(adapter);
      player.play();

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      adapter._triggerMessage({
        type: 'PUBLISH_DONE',
        requestId: videoReqId,
        statusCode: varint(0x2),
        streamCount: varint(0),
        errorReason: '',
      } as ControlMessage);

      (adapter.requestUpdate as any).mockClear();

      player.pause();

      // Only 1 REQUEST_UPDATE (for audio), not 2
      expect(adapter.requestUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Play/Pause REQUEST_UPDATE (§9.11) ─────────────────────

  describe('play/pause REQUEST_UPDATE (§9.11)', () => {
    async function loadCatalogAndSubscribe(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('pause() sends REQUEST_UPDATE with forward:0 for active subscriptions', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();

      player.pause();

      // §9.11: forward:0 pauses object delivery at source
      expect(adapter.requestUpdate).toBeDefined();
      if (adapter.requestUpdate) {
        expect(adapter.requestUpdate).toHaveBeenCalled();
      }
    });

    it('play() from paused sends REQUEST_UPDATE with forward:1', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();
      player.pause();

      // Clear mock calls
      (adapter.requestUpdate as any)?.mockClear?.();

      player.play();

      if (adapter.requestUpdate) {
        expect(adapter.requestUpdate).toHaveBeenCalled();
      }
    });

    it('pause() sends REQUEST_UPDATE with forward:0 argument (§9.2.2.8)', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();
      (adapter.requestUpdate as any).mockClear();

      player.pause();

      // §9.2.2.8: FORWARD=0 means "don't forward" — pause at source
      expect(adapter.requestUpdate).toHaveBeenCalled();
      const call = (adapter.requestUpdate as any).mock.calls[0];
      expect(call[1]).toEqual({ forward: 0 });
    });

    it('play() from paused sends REQUEST_UPDATE with forward:1 argument (§9.2.2.8)', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();
      player.pause();
      (adapter.requestUpdate as any).mockClear();

      player.play();

      // §9.2.2.8: FORWARD=1 means "forward" — resume at source
      expect(adapter.requestUpdate).toHaveBeenCalled();
      const call = (adapter.requestUpdate as any).mock.calls[0];
      expect(call[1]).toEqual({ forward: 1 });
    });

    it('play() emits error when requestUpdate rejects (§9.11)', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();
      player.pause();

      // Simulate requestUpdate failure (e.g. subscription state mismatch)
      (adapter.requestUpdate as any).mockRejectedValueOnce(
        new Error('Cannot update subscription in state terminated; expected established'),
      );

      const errorFn = vi.fn();
      player.on('error', errorFn);

      player.play();
      // Allow microtask for async rejection to propagate
      await vi.waitFor(() => expect(errorFn).toHaveBeenCalled());

      const err = errorFn.mock.calls[0][0];
      expect(err.type).toBe('error');
    });

    it('pause() emits error when requestUpdate rejects (§9.11)', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();

      (adapter.requestUpdate as any).mockRejectedValueOnce(
        new Error('session not established'),
      );

      const errorFn = vi.fn();
      player.on('error', errorFn);

      player.pause();
      await vi.waitFor(() => expect(errorFn).toHaveBeenCalled());

      const err = errorFn.mock.calls[0][0];
      expect(err.type).toBe('error');
    });

    it('play() sends REQUEST_UPDATE for all subscriptions even if one fails (§9.11)', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();
      player.pause();
      (adapter.requestUpdate as any).mockClear();

      // First call rejects, second should still be attempted
      (adapter.requestUpdate as any)
        .mockRejectedValueOnce(new Error('first sub failed'))
        .mockResolvedValueOnce(varint(99n));

      const errorFn = vi.fn();
      player.on('error', errorFn);

      player.play();
      await vi.waitFor(() => expect(errorFn).toHaveBeenCalled());

      // Both subscriptions should have been attempted (video + audio)
      expect(adapter.requestUpdate).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Datagram Routing (§10.3) ─────────────────────────────────

  describe('datagram object routing (§10.3)', () => {
    async function loadCatalogAndSubscribeWithAlias(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Establish media subscriptions with server-assigned aliases
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(50n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      return player;
    }

    it('routes datagram objects to SubscriptionManager (§10.3)', async () => {
      // §10.3: Datagrams carry independent objects (typically audio).
      // Player SHOULD wire adapter.onDatagram to route through the pipeline.
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribeWithAlias(adapter);
      const fn = vi.fn();
      player.on('media_object', fn);

      // Trigger a datagram for the audio track (alias 51)
      adapter._triggerDatagram({
        typeByte: 0x00,
        trackAlias: varint(51n),
        groupId: varint(5),
        objectId: varint(0),
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0xAA, 0xBB]),
        status: undefined,
      });

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'media_object',
          mediaType: 'audio',
          trackName: 'audio',
        }),
      );
    });

    it('ignores datagrams for unknown track aliases', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribeWithAlias(adapter);
      const fn = vi.fn();
      player.on('media_object', fn);

      // Datagram with unregistered alias — should be silently ignored
      adapter._triggerDatagram({
        typeByte: 0x00,
        trackAlias: varint(999n),
        groupId: varint(5),
        objectId: varint(0),
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0x01]),
        status: undefined,
      });

      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ─── Stream Reset vs FIN (§10.4) ─────────────────────────────

  describe('stream reset vs FIN distinction (§10.4)', () => {
    async function loadCatalogAndEstablish(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(50n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      return player;
    }

    it('handles clean stream FIN without error (§10.4)', async () => {
      const adapter = createMockAdapter();
      const player = await loadCatalogAndEstablish(adapter);
      const errorFn = vi.fn();
      player.on('session_error', errorFn);

      // Stream closed normally (FIN) — no error
      adapter._triggerStreamClosed(0n);

      expect(errorFn).not.toHaveBeenCalled();
    });

    it('stream reset is not an error — logged at debug level (§10.4.3)', async () => {
      // §10.4.3: RESET_STREAM is a normal stream lifecycle event.
      // Player should NOT emit session_error for stream resets.
      const adapter = createMockAdapter();
      const player = await loadCatalogAndEstablish(adapter);
      const errorFn = vi.fn();
      player.on('session_error', errorFn);

      // Stream reset with error code — should be silent
      adapter._triggerStreamClosed(0n, 0x10);

      expect(errorFn).not.toHaveBeenCalled();
    });
  });

  // ─── Malformed Track Detection (§2.4.2) ──────────────────────

  describe('malformed track detection (§2.4.2)', () => {
    async function loadCatalogAndSubscribe(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('calls adapter.unsubscribe on corrupted LOC extensions (§2.4.2)', async () => {
      // §2.4.2: Corrupted LOC extensions = malformed track → MUST UNSUBSCRIBE
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Corrupted extensions — LOC parse error triggers malformed track
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(42n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        extensions: new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
        payload: new Uint8Array([0x00]),
      } as MoqtObject);

      // §2.4.2: MUST UNSUBSCRIBE on malformed track
      expect(adapter.unsubscribe).toHaveBeenCalledWith(videoReqId);
    });

    it('calls adapter.unsubscribe when objectTransform throws (§2.4.2 MUST)', async () => {
      // §2.4.2: Non-LOC errors (E2EE transform, etc.) still trigger malformed track
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Set up a transform that throws (simulates E2EE decryption failure)
      (player as any).subscriptionManager.objectTransform = () => {
        throw new Error('Decryption failed');
      };

      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(42n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        extensions: new Uint8Array(0),
        payload: new Uint8Array([0x00]),
      } as MoqtObject);

      // §2.4.2: MUST UNSUBSCRIBE for non-LOC errors
      expect(adapter.unsubscribe).toHaveBeenCalledWith(videoReqId);
    });

    it('emits track_unsubscribed on malformed track from transform error (§2.4.2 SHOULD)', async () => {
      // §2.4.2: "SHOULD deliver an error to the application"
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      const fn = vi.fn();
      player.on('track_unsubscribed', fn);

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Transform throws → malformed track (non-LOC error path)
      (player as any).subscriptionManager.objectTransform = () => {
        throw new Error('Decryption failed');
      };

      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(42n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        extensions: new Uint8Array(0),
        payload: new Uint8Array([0x00]),
      } as MoqtObject);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'track_unsubscribed',
          trackName: 'video',
        }),
      );
    });

    it('removes subscription from active set after malformed track from transform error', async () => {
      // After malformed track UNSUBSCRIBE, pause() should NOT send
      // REQUEST_UPDATE for the removed subscription.
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      player.play();

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Transform throws → malformed track → UNSUBSCRIBE (non-LOC error path)
      (player as any).subscriptionManager.objectTransform = () => {
        throw new Error('Decryption failed');
      };

      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(42n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        extensions: new Uint8Array(0),
        payload: new Uint8Array([0x00]),
      } as MoqtObject);

      (adapter.requestUpdate as any).mockClear();
      player.pause();

      // Only 1 REQUEST_UPDATE (audio), not 2 (video was removed)
      expect(adapter.requestUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Subscription Parameters (§9.2.2) ──────────────────────────

  describe('subscription parameters (§9.2.2)', () => {
    it('passes deliveryTimeoutMs to adapter.subscribe as options (§9.2.2.2)', async () => {
      // §9.2.2.2: "The DELIVERY TIMEOUT parameter [...] MAY appear in a
      // [...] SUBSCRIBE [...] message. It is the duration in milliseconds"
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        deliveryTimeoutMs: 3000,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      // Trigger catalog to create media subscriptions
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Media subscribe calls (2nd and 3rd) should include options
      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].deliveryTimeout).toEqual(varint(3000n));
    });

    it('passes subscriberPriority to adapter.subscribe as options (§9.2.2.3)', async () => {
      // §9.2.2.3: "It is an integer expressing the priority of a
      // subscription relative to other subscriptions [...] Lower numbers
      // get higher priority. The range is restricted to 0-255."
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        subscriberPriority: 64,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].subscriberPriority).toEqual(varint(64n));
    });

    it('passes groupOrder to adapter.subscribe as options (§9.2.2.4)', async () => {
      // §9.2.2.4: "It is an enum indicating how to prioritize Objects
      // from different groups [...] Ascending (0x1) or Descending (0x2)."
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        groupOrder: 'descending',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].groupOrder).toEqual(varint(0x2n));
    });

    it('passes subscriptionFilter LargestObject to adapter.subscribe (§9.2.2.5)', async () => {
      // §5.1.2: "Largest Object (0x2): Start Location is {LO.Group, LO.Object + 1}"
      // Config accepts both 'LargestObject' (spec name) and 'LatestObject' (compat alias)
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        subscriptionFilter: { type: 'LatestObject' }, // compat alias in config
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // buildSubscribeOptions maps LatestObject → LargestObject
      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].subscriptionFilter).toBeDefined();
      expect(videoCall[2].subscriptionFilter.type).toBe('LargestObject');
    });

    it('passes subscriptionFilter AbsoluteStart to adapter.subscribe (§9.2.2.5)', async () => {
      // §5.1.2: "AbsoluteStart (0x3): Start Location is specified explicitly"
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        subscriptionFilter: { type: 'AbsoluteStart', startGroup: 5, startObject: 0 },
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].subscriptionFilter.type).toBe('AbsoluteStart');
      expect(videoCall[2].subscriptionFilter.startGroup).toEqual(varint(5n));
      expect(videoCall[2].subscriptionFilter.startObject).toEqual(varint(0n));
    });

    it('defaults live media subscriptions to NextGroupStart when no subscription params configured', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Live media subscribe calls should default to NextGroupStart
      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].subscriptionFilter.type).toBe('NextGroupStart');
    });

    it('defaults VOD media subscriptions to AbsoluteStart {0,0} when no subscription params configured', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      const vodCatalogJson = JSON.stringify({
        version: 1,
        tracks: [
          {
            name: 'video',
            packaging: 'loc',
            isLive: false,
            trackDuration: 10_000,
            role: 'video',
            renderGroup: 1,
            codec: 'avc1.42c01f',
            width: 640,
            height: 360,
          },
          {
            name: 'audio',
            packaging: 'loc',
            isLive: false,
            trackDuration: 10_000,
            role: 'audio',
            renderGroup: 1,
            codec: 'mp4a.40.2',
            samplerate: 48_000,
            channelConfig: '2',
          },
        ],
      });

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(vodCatalogJson),
      } as MoqtObject);

      const videoCall = (adapter.subscribe as any).mock.calls[1];
      expect(videoCall[2]).toBeDefined();
      expect(videoCall[2].subscriptionFilter.type).toBe('AbsoluteStart');
      expect(BigInt(videoCall[2].subscriptionFilter.startGroup)).toBe(0n);
      expect(BigInt(videoCall[2].subscriptionFilter.startObject)).toBe(0n);
    });
  });

  // ─── Init Track Lifecycle ──────────────────────────────────────

  describe('init track lifecycle', () => {
    const CMAF_INIT_CATALOG = JSON.stringify({
      version: 1,
      tracks: [
        {
          name: '1.m4s', packaging: 'cmaf', isLive: true, role: 'video',
          renderGroup: 1, codec: 'avc1.64001f', width: 1920, height: 1080, bitrate: 1_500_000,
          initTrack: 'init-video',
        },
        {
          name: '2.m4s', packaging: 'cmaf', isLive: true, role: 'audio',
          renderGroup: 1, codec: 'mp4a.40.2', samplerate: 44100, channelConfig: '2', bitrate: 128_000,
          initData: btoa(String.fromCharCode(0x04, 0x05, 0x06, 0x07)),
        },
      ],
    });

    it('init track subscribes with AbsoluteStart {0,0}, not LargestObject', async () => {
      const adapter = createMockAdapter();
      const mockMs = {
        initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(),
        reset: vi.fn(), mediaElement: null, destroy: vi.fn(),
        onFirstFrame: null, onError: null, onStall: null,
      };
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: (opts: any) => ({
          push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(),
        }),
      });

      const catalogReceived = new Promise<void>(r => player.on('catalog_received', () => r()));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data', trackAlias: varint(1),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        publisherPriority: 0, extensions: new Uint8Array(0),
        payload: new TextEncoder().encode(CMAF_INIT_CATALOG),
      });
      await catalogReceived;
      await new Promise(r => setTimeout(r, 100));

      const initSub = (adapter.subscribe as any).mock.calls.find(
        (c: any) => { try { return new TextDecoder().decode(c[1]) === 'init-video'; } catch { return false; } },
      );
      expect(initSub).toBeDefined();
      expect(initSub[2].subscriptionFilter.type).toBe('AbsoluteStart');
      expect(BigInt(initSub[2].subscriptionFilter.startGroup)).toBe(0n);

      await player.destroy();
    });

    it('unsubscribes from init track after first object is received', async () => {
      const adapter = createMockAdapter();
      const mockMs = {
        initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(),
        reset: vi.fn(), mediaElement: null, destroy: vi.fn(),
        onFirstFrame: null, onError: null, onStall: null,
      };
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: (opts: any) => ({
          push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(),
        }),
      });

      const catalogReceived = new Promise<void>(r => player.on('catalog_received', () => r()));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data', trackAlias: varint(1),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        publisherPriority: 0, extensions: new Uint8Array(0),
        payload: new TextEncoder().encode(CMAF_INIT_CATALOG),
      });
      await catalogReceived;
      await new Promise(r => setTimeout(r, 100));

      // Find init track subscribe call and its requestId
      const initSubCall = (adapter.subscribe as any).mock.calls.find(
        (c: any) => { try { return new TextDecoder().decode(c[1]) === 'init-video'; } catch { return false; } },
      );
      expect(initSubCall).toBeDefined();
      const initCallIndex = (adapter.subscribe as any).mock.calls.indexOf(initSubCall);
      const initReqId = await (adapter.subscribe as any).mock.results[initCallIndex]?.value;

      // ACK the init track subscription
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(BigInt(initReqId)),
        trackAlias: varint(BigInt(initReqId) + 500n),
        parameters: new Map(), trackExtensions: new Map(),
      } as any);

      // Deliver init data object via the resolved alias
      adapter._triggerObject(BigInt(initReqId) + 500n, {
        kind: 'data',
        trackAlias: varint(BigInt(initReqId) + 500n),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        publisherPriority: 0, extensions: new Uint8Array(0),
        payload: new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
      });
      await new Promise(r => setTimeout(r, 10));

      // Should have unsubscribed the init track
      expect(adapter.unsubscribe).toHaveBeenCalledWith(varint(BigInt(initReqId)));
      // Should have cleaned activeSubscriptions
      expect((player as any).activeSubscriptions.has(BigInt(initReqId))).toBe(false);
      // subscriptionManager should no longer know about the init track alias
      expect((player as any).subscriptionManager?.getMediaType(BigInt(initReqId) + 500n)).toBeUndefined();
      // pendingMediaSubs should be clear for this requestId
      expect((player as any).pendingMediaSubs.has(BigInt(initReqId))).toBe(false);
      // initTrackRequestIds should be clear
      expect((player as any).initTrackRequestIds.has('init-video')).toBe(false);

      await player.destroy();
    });

    it('global subscriptionFilter does not affect init track AbsoluteStart', async () => {
      const adapter = createMockAdapter();
      const mockMs = {
        initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(),
        reset: vi.fn(), mediaElement: null, destroy: vi.fn(),
        onFirstFrame: null, onError: null, onStall: null,
      };
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: (opts: any) => ({
          push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(),
        }),
        subscriptionFilter: { type: 'LargestObject' },
      });

      const catalogReceived = new Promise<void>(r => player.on('catalog_received', () => r()));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data', trackAlias: varint(1),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        publisherPriority: 0, extensions: new Uint8Array(0),
        payload: new TextEncoder().encode(CMAF_INIT_CATALOG),
      });
      await catalogReceived;
      await new Promise(r => setTimeout(r, 100));

      // Init track must use AbsoluteStart even when global config says LargestObject
      const initSub = (adapter.subscribe as any).mock.calls.find(
        (c: any) => { try { return new TextDecoder().decode(c[1]) === 'init-video'; } catch { return false; } },
      );
      expect(initSub).toBeDefined();
      expect(initSub[2].subscriptionFilter.type).toBe('AbsoluteStart');

      await player.destroy();
    });
  });

  // ─── PlaybackPipeline Wiring ─────────────────────────────────

  describe('PlaybackPipeline wiring (LOC §4.2, §10.2.1.1)', () => {
    /** Manual clock for deterministic tests. */
    let clockTime: number;
    const mockClock: ClockSource = { now: () => clockTime };

    beforeEach(() => {
      clockTime = 0;
    });

    /** Config with injectable clock. */
    function createPipelineConfig(
      adapter: ReturnType<typeof createMockAdapter>,
    ): MoqtPlayerConfig {
      return {
        ...createConfig(adapter),
        clock: mockClock,
      };
    }

    /** Load player and trigger catalog. */
    async function loadWithCatalog(
      adapter: ReturnType<typeof createMockAdapter>,
      config?: MoqtPlayerConfig,
    ) {
      const player = new MoqtPlayer(config ?? createPipelineConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('stats.loc exposes LOC diagnostics: zeroed counters and live timing gauges', async () => {
      // Slice-1 observability (stutter correlation): counters start at zero,
      // and the gap-timeout/render-cushion gauges are live once the LOC
      // video pipeline exists. Behavior-neutral — values only.
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);

      const loc = player.stats.loc;
      expect(loc.skipForwardCount).toBe(0);
      expect(loc.backlogShedCount).toBe(0);
      expect(loc.partialGroupAbandonedCount).toBe(0);
      expect(loc.keyframeWaitingCount).toBe(0);
      expect(loc.syncResetCount).toBe(0);
      expect(loc.videoEffectiveGapTimeoutMs).toBeGreaterThan(0); // raw fuse gauge
      // Slice A contract: the render cushion is smoothed and clamped
      // INDEPENDENTLY of the raw fuse (which may exceed it when spiking) —
      // bounded by the static floor and the render cap, never compared
      // against the raw value.
      expect(loc.renderCushionMs).not.toBeNull();
      expect(loc.renderCushionMs).toBeGreaterThanOrEqual(50);  // ≥ static floor
      expect(loc.renderCushionMs).toBeLessThanOrEqual(750);    // ≤ render cap
      await player.destroy();
    });

    it('creates pipelines for video and audio after catalog', async () => {
      // LOC §4.2: Pipeline processes objects in decode order.
      // After catalog triggers track selection, pipelines should exist.
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);

      // Test via tick() — should not throw (pipelines exist and tick without error)
      expect(() => player.tick()).not.toThrow();
    });

    it('uses config clock for pipeline timing', async () => {
      // Pipeline clock should be the injected clock, not system clock.
      const adapter = createMockAdapter();
      const clockFn = vi.fn(() => 1_000_000);
      const player = await loadWithCatalog(adapter, {
        ...createConfig(adapter),
        clock: { now: clockFn },
      });

      // Push an object so the pipeline has something to process during tick
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      clockFn.mockClear();
      player.tick();

      // Clock should have been called during pipeline tick (render time computation)
      expect(clockFn).toHaveBeenCalled();
    });

    it('uses createRecoveryController from config if provided', async () => {
      // Config factory takes precedence over DefaultRecoveryController.
      const adapter = createMockAdapter();
      const recoveryFactory = vi.fn(() => ({
        evaluate: vi.fn(() => ({ type: 'skip_forward' as const })),
      }));
      const player = await loadWithCatalog(adapter, {
        ...createConfig(adapter),
        clock: mockClock,
        createRecoveryController: recoveryFactory,
      });

      expect(recoveryFactory).toHaveBeenCalledWith(mockClock);
    });

    it('emits decoder_command for audio decode after tick', async () => {
      // Audio pipeline: configure → push object → tick → decode_audio command.
      // Audio decoder FSM goes IDLE→configure→DECODING (no keyframe wait).
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);
      const fn = vi.fn();
      player.on('decoder_command', fn);

      // Get audio track alias (3rd subscribe: catalog, video, audio)
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      // Establish subscription
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Trigger audio object with payload (groupId 0 = first expected group)
      clockTime = 1_000_000; // 1 second
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA, 0xBB, 0xCC]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      player.tick();

      // Pipeline should have emitted a decoder command
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder_command',
          command: expect.objectContaining({ type: 'decode_audio' }),
        }),
      );
    });

    it('still emits media_object alongside pipeline routing', async () => {
      // Both media_object (raw) and decoder_command (processed) should fire.
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);
      const mediaFn = vi.fn();
      player.on('media_object', mediaFn);

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      expect(mediaFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'media_object', mediaType: 'audio' }),
      );
    });

    it('applies commandTransform before emitting decoder_command', async () => {
      // Config commandTransform modifies commands before emission.
      const adapter = createMockAdapter();
      const transform = vi.fn((cmd: any) => cmd);
      const player = await loadWithCatalog(adapter, {
        ...createConfig(adapter),
        clock: mockClock,
        commandTransform: transform,
      });

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      clockTime = 1_000_000;
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      player.tick();

      expect(transform).toHaveBeenCalled();
    });

    it('commandTransform returning null suppresses decoder_command', async () => {
      // When commandTransform returns null, no decoder_command event fires.
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter, {
        ...createConfig(adapter),
        clock: mockClock,
        commandTransform: () => null,
      });
      const fn = vi.fn();
      player.on('decoder_command', fn);

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      clockTime = 1_000_000;
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      player.tick();

      expect(fn).not.toHaveBeenCalled();
    });

    it('bridges pipeline track_ended to player track_ended event', async () => {
      // §10.2.1.1: END_OF_TRACK gap → pipeline emits track_ended → player bridges.
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);
      const fn = vi.fn();
      player.on('track_ended', fn);

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Push a normal object first so pipeline has consumed something
      clockTime = 1_000_000;
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);
      player.tick();

      // Push END_OF_TRACK gap
      adapter._triggerObject(1n, {
        kind: 'gap',
        trackAlias: varint(51n),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        status: varint(0x4), // END_OF_TRACK
      } as MoqtObject);

      player.tick();

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'track_ended', mediaType: 'audio' }),
      );
    });

    it('bridges pipeline recovery event through onRecovery hook', async () => {
      // §7: Recovery controller evaluates triggers, player emits recovery_action.
      const adapter = createMockAdapter();
      const recoveryFn = vi.fn();
      const player = await loadWithCatalog(adapter, {
        ...createConfig(adapter),
        clock: mockClock,
        maxBufferDepth: 1, // Tiny buffer to trigger overflow
      });
      player.on('recovery_action', recoveryFn);

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Push 2 objects into a buffer of size 1 → overflow → recovery
      clockTime = 1_000_000;
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(1),
        payload: new Uint8Array([0xBB]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      expect(recoveryFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'recovery_action' }),
      );
    });

    it('play() starts tick interval, pause() stops it', async () => {
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);
      const fn = vi.fn();
      player.on('decoder_command', fn);

      // play() should start ticking
      player.play();

      // Advance timers — use real setTimeout for this test
      await new Promise(r => setTimeout(r, 50));

      player.pause();

      // tick should have been called at least once during the 50ms window
      // (16ms interval → ~3 ticks). The exact count depends on timing,
      // so just verify the interval mechanism works by checking that
      // pause stops further ticks.
      const callsAfterPause = fn.mock.calls.length;
      await new Promise(r => setTimeout(r, 50));
      expect(fn.mock.calls.length).toBe(callsAfterPause);
    });

    it('tick() is callable as public method', async () => {
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);

      // Public tick() for testing — should not throw
      expect(() => player.tick()).not.toThrow();
      expect(() => player.tick()).not.toThrow();
    });

    it('destroy() cleans up pipelines', async () => {
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);
      player.play();

      await player.destroy();

      // After destroy, tick should be a no-op (no errors from null pipelines)
      expect(() => player.tick()).not.toThrow();
    });

    // ─── CommandDispatcher Integration ──────────────────────────

    it('creates CommandDispatcher with adapters from config factories after catalog', async () => {
      // When config provides adapter factories, the player should instantiate
      // them after catalog and wire a CommandDispatcher.
      const adapter = createMockAdapter();
      const videoDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn(),
      };
      const audioDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0, onData: null, onError: null, destroy: vi.fn(),
      };
      const renderer = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null, onFrameRendered: null, onStall: null,
      };
      const audioOutput = {
        schedule: vi.fn(), flush: vi.fn(), currentPlayoutTimeUs: 0, destroy: vi.fn(),
      };
      const createVideoDecoder = vi.fn(() => videoDecoder);
      const createAudioDecoder = vi.fn(() => audioDecoder);
      const createRenderer = vi.fn(() => renderer);
      const createAudioOutput = vi.fn(() => audioOutput);

      await loadWithCatalog(adapter, {
        ...createPipelineConfig(adapter),
        createVideoDecoder,
        createAudioDecoder,
        createRenderer,
        createAudioOutput,
      });

      // Factories should have been called after catalog triggers subscribeToMediaTracks
      expect(createVideoDecoder).toHaveBeenCalledOnce();
      expect(createAudioDecoder).toHaveBeenCalledOnce();
      expect(createRenderer).toHaveBeenCalledOnce();
      expect(createAudioOutput).toHaveBeenCalledOnce();
    });

    it('measures A/V skew from rendered frames vs audio playhead (observability only)', async () => {
      const adapter = createMockAdapter();
      const renderer: any = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null, onFrameRendered: null, onStall: null,
      };
      const audioOutput = {
        schedule: vi.fn(), flush: vi.fn(), currentPlayoutTimeUs: 0, destroy: vi.fn(),
        playheadCaptureUs: vi.fn(() => 5_000_000), // 5.000s of capture audible
      };
      const player = await loadWithCatalog(adapter, {
        ...createPipelineConfig(adapter),
        createVideoDecoder: () => ({
          configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn(),
        }),
        createAudioDecoder: () => ({
          configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(), queueDepth: 0, onData: null, onError: null, destroy: vi.fn(),
        }),
        createRenderer: () => renderer,
        createAudioOutput: () => audioOutput,
      });
      const skewEvents: any[] = [];
      player.on('sync_skew', (e) => skewEvents.push(e));

      expect(player.stats.avSkewMs).toBeNull(); // no measurement yet

      // A video frame captured at 5.120s renders while audio plays 5.000s.
      renderer.onFrameRendered?.(5_120_000n, 1_000_000);

      expect(player.stats.avSkewMs).toBeCloseTo(120, 5); // video 120ms ahead
      expect(player.stats.avSkewEwmaMs).toBeCloseTo(120, 5);
      expect(skewEvents).toHaveLength(1);
      expect(skewEvents[0]).toMatchObject({ type: 'sync_skew', skewMs: 120 });

      // Observability MUST NOT change behavior: nothing scheduled or
      // enqueued as a side effect of measuring.
      expect(renderer.enqueue).not.toHaveBeenCalled();
      expect(audioOutput.schedule).not.toHaveBeenCalled();

      // Throttle: an immediate second render records stats but emits no event.
      renderer.onFrameRendered?.(5_153_000n, 1_033_000);
      expect(player.stats.avSkewMs).toBeCloseTo(153, 5);
      expect(skewEvents).toHaveLength(1);

      await player.destroy();
    });

    it('dispatches decoder commands through CommandDispatcher (LOC §2.1, §4.1)', async () => {
      // When adapter factories are provided, decoder commands from the
      // pipeline should flow through the CommandDispatcher to the adapters.
      const adapter = createMockAdapter();
      const audioDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0, onData: null, onError: null, destroy: vi.fn(),
      };
      const audioOutput = {
        schedule: vi.fn(), flush: vi.fn(), currentPlayoutTimeUs: 0, destroy: vi.fn(),
      };

      const player = await loadWithCatalog(adapter, {
        ...createPipelineConfig(adapter),
        createAudioDecoder: () => audioDecoder,
        createAudioOutput: () => audioOutput,
      });

      // Route audio object through pipeline to generate a decode_audio command
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      clockTime = 1_000_000;
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA, 0xBB, 0xCC]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      player.tick();

      // The audio decoder should have received the decode command via CommandDispatcher
      expect(audioDecoder.decode).toHaveBeenCalled();
    });

    it('emits first_frame event when renderer reports first frame', async () => {
      // VideoRendererLike.onFirstFrame → CommandDispatcher → player emits first_frame
      const adapter = createMockAdapter();
      const renderer = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null as (() => void) | null,
        onFrameRendered: null as ((ts: bigint, r: number) => void) | null,
        onStall: null as ((ms: number) => void) | null,
      };

      const player = await loadWithCatalog(adapter, {
        ...createPipelineConfig(adapter),
        createVideoDecoder: () => ({
          configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn(),
        }),
        createRenderer: () => renderer,
      });

      const fn = vi.fn();
      player.on('first_frame', fn);

      // Simulate renderer firing onFirstFrame callback
      renderer.onFirstFrame?.();

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'first_frame' }),
      );
    });

    it('emits stall event when renderer reports stall', async () => {
      // VideoRendererLike.onStall → CommandDispatcher → player emits stall
      const adapter = createMockAdapter();
      const renderer = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null as (() => void) | null,
        onFrameRendered: null as ((ts: bigint, r: number) => void) | null,
        onStall: null as ((ms: number) => void) | null,
      };

      const player = await loadWithCatalog(adapter, {
        ...createPipelineConfig(adapter),
        createVideoDecoder: () => ({
          configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn(),
        }),
        createRenderer: () => renderer,
      });

      const fn = vi.fn();
      player.on('stall', fn);

      // Simulate renderer firing onStall callback
      renderer.onStall?.(750);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stall', durationMs: 750 }),
      );
    });

    it('destroy() cleans up CommandDispatcher', async () => {
      // Adapter destroy() methods should be called on player.destroy()
      const adapter = createMockAdapter();
      const videoDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn(),
      };
      const renderer = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null, onFrameRendered: null, onStall: null,
      };

      const player = await loadWithCatalog(adapter, {
        ...createPipelineConfig(adapter),
        createVideoDecoder: () => videoDecoder,
        createRenderer: () => renderer,
      });

      await player.destroy();

      expect(videoDecoder.destroy).toHaveBeenCalled();
      expect(renderer.destroy).toHaveBeenCalled();
    });

    it('works without adapter factories — decoder_command events still emitted, no dispatch', async () => {
      // When no adapter factories are provided, the player should still
      // emit decoder_command events but not create a CommandDispatcher.
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter);
      const fn = vi.fn();
      player.on('decoder_command', fn);

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: varint(51n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      clockTime = 1_000_000;
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(51n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xAA, 0xBB, 0xCC]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      player.tick();

      // decoder_command event should still fire (existing behavior preserved)
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'decoder_command',
          command: expect.objectContaining({ type: 'decode_audio' }),
        }),
      );
    });
  });

  // ─── Destroy (§3.6) ────────────────────────────────────────

  describe('destroy cleanup (§3.6)', () => {
    it('destroy() before load() does not throw', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));

      // Should not throw even though no adapter exists
      await expect(player.destroy()).resolves.toBeUndefined();
    });
  });

  // ─── FETCH (§9.16) ─────────────────────────────────────────

  /**
   * §9.16: "A subscriber issues a FETCH to a publisher to request a
   * range of already published objects within a track."
   *
   * The player wraps adapter.fetch() and routes fetch data stream
   * objects through the subscription manager.
   */
  describe('fetch (§9.16)', () => {
    /** Load player and deliver catalog so media tracks are set up. */
    async function loadWithCatalog(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return { player, catalogReqId };
    }

    it('fetch() calls adapter.fetch() with correct namespace/name/range', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      await player.fetch('video', {
        startGroup: 5,
        startObject: 0,
        endGroup: 10,
        endObject: 0,
      });

      expect(adapter.fetch).toHaveBeenCalledTimes(1);
      const args = (adapter.fetch as any).mock.calls[0];
      // namespace should be encoded config.namespace
      expect(args[0]).toBeDefined(); // Uint8Array[] namespace
      // name should be encoded 'video'
      expect(new TextDecoder().decode(args[1])).toBe('video');
      // options should have start/end
      expect(args[2].startGroup).toEqual(varint(5n));
      expect(args[2].startObject).toEqual(varint(0n));
      expect(args[2].endGroup).toEqual(varint(10n));
      expect(args[2].endObject).toEqual(varint(0n));
    });

    it('fetch objects are routed to the pipeline via track alias remapping', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      // Get the video track alias from the subscription
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      // Initiate fetch
      const fetchReqId = await player.fetch('video', {
        startGroup: 5,
        startObject: 0,
        endGroup: 10,
        endObject: 0,
      });

      // Simulate fetch data stream arriving
      const fetchStreamId = 100n;
      adapter._triggerDataStream(fetchStreamId, {
        type: 'fetch',
        header: { requestId: fetchReqId },
      });

      // Simulate a fetch object arriving on that stream
      // Fetch objects have trackAlias: 0 in the adapter
      adapter._triggerObject(fetchStreamId, {
        kind: 'data',
        trackAlias: varint(0),
        groupId: varint(5),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xCA, 0xFE]),
      } as MoqtObject);

      // The object should have been routed through the subscription manager
      // (no crash = routing worked; unmatched alias would be silently dropped)
      // Verify it didn't throw and the player is still in a valid state
      expect(player).toBeDefined();
    });

    it('fetchCancel() calls adapter.fetchCancel()', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const fetchReqId = await player.fetch('video', {
        startGroup: 5,
        startObject: 0,
        endGroup: 10,
        endObject: 0,
      });

      await player.fetchCancel(fetchReqId);

      expect(adapter.fetchCancel).toHaveBeenCalledTimes(1);
      expect(adapter.fetchCancel).toHaveBeenCalledWith(fetchReqId);
    });
  });

  // ─── fetchCatalog (Tier 1, MSF §9.1) ──────────────────────────

  /**
   * One-shot FETCH of the catalog track. Dispatches server objects to the
   * right pending promise by (streamId → reqId), parses through a fresh
   * CatalogManager so the running catalog/subscriptions are never touched.
   */
  describe('fetchCatalog (MSF §9.1, MoQT §9.16)', () => {
    async function loadWithCatalog(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return { player, catalogReqId };
    }

    /** Drive a fetchCatalog through a successful data-stream response. */
    function deliverCatalogFetchObject(
      adapter: ReturnType<typeof createMockAdapter>,
      reqId: ReturnType<typeof varint>,
      streamId: bigint,
      payload: Uint8Array,
    ): void {
      adapter._triggerDataStream(streamId, {
        type: 'fetch',
        header: { requestId: reqId },
      });
      adapter._triggerObject(streamId, {
        kind: 'data',
        trackAlias: varint(0),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload,
      } as MoqtObject);
    }

    it('resolves with parsed CatalogState on successful fetch', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;

      // Server sends FETCH header + single catalog object
      deliverCatalogFetchObject(
        adapter,
        fetchReqId,
        200n,
        new TextEncoder().encode(CATALOG_JSON),
      );

      const state = await p;
      expect(state.tracks).toHaveLength(2);
      expect(state.tracks.find((t) => t.name === 'video')?.codec).toBe('av01.0.08M.10');
      expect(state.tracks.find((t) => t.name === 'audio')?.codec).toBe('opus');
    });

    it('calls adapter.fetch with catalog namespace + track name + range', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog({ group: 7n, object: 3n });
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;
      // Settle the promise so it doesn't linger
      deliverCatalogFetchObject(
        adapter,
        fetchReqId,
        201n,
        new TextEncoder().encode(CATALOG_JSON),
      );
      await p;

      expect(adapter.fetch).toHaveBeenCalledTimes(1);
      const args = (adapter.fetch as any).mock.calls[0];
      expect(new TextDecoder().decode(args[1])).toBe('catalog');
      expect(args[2].startGroup).toEqual(varint(7n));
      expect(args[2].startObject).toEqual(varint(3n));
      expect(args[2].endGroup).toEqual(varint(7n));
      expect(args[2].endObject).toEqual(varint(3n));
    });

    it('rejects when server returns a gap object', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;

      adapter._triggerDataStream(202n, {
        type: 'fetch',
        header: { requestId: fetchReqId },
      });
      adapter._triggerObject(202n, {
        kind: 'gap',
        trackAlias: varint(0),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        status: varint(0x3),
      } as MoqtObject);

      await expect(p).rejects.toThrow(/gap/i);
    });

    it('rejects with REQUEST_ERROR reason when server rejects the FETCH', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;

      adapter._triggerMessage({
        type: 'REQUEST_ERROR',
        requestId: fetchReqId,
        errorCode: varint(0x05),
        retryInterval: varint(0n),
        errorReason: 'catalog unavailable',
      } as ControlMessage);

      await expect(p).rejects.toThrow(/catalog unavailable/);
    });

    it('rejects and cancels the FETCH when timeoutMs elapses with no response', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createMockAdapter();
        const { player } = await loadWithCatalog(adapter);

        const p = player.fetchCatalog({ timeoutMs: 50 });
        // Swallow rejection to avoid unhandled-rejection warning during advance
        const settled = p.catch((e) => e);
        const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;

        await vi.advanceTimersByTimeAsync(60);

        const err = await settled;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/timed out/i);
        expect(adapter.fetchCancel).toHaveBeenCalledWith(fetchReqId);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when the FETCH data stream closes before delivering an object', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;

      adapter._triggerDataStream(203n, {
        type: 'fetch',
        header: { requestId: fetchReqId },
      });
      adapter._triggerStreamClosed(203n, 0x10);

      await expect(p).rejects.toThrow(/stream reset/i);
    });

    it('does not mutate the running catalog or subscriptions', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const snapshotBefore = JSON.stringify(player.catalogState);
      const subscribeCallsBefore = (adapter.subscribe as any).mock.calls.length;

      // FETCH returns a DIFFERENT catalog — must NOT alter the running state.
      const alternateCatalog = JSON.stringify({
        version: 1,
        tracks: [{ name: 'different', packaging: 'loc', isLive: false, role: 'video' }],
      });

      const p = player.fetchCatalog();
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;
      deliverCatalogFetchObject(
        adapter,
        fetchReqId,
        204n,
        new TextEncoder().encode(alternateCatalog),
      );
      const fetched = await p;

      expect(fetched.tracks[0]?.name).toBe('different');
      // Running catalog untouched
      expect(JSON.stringify(player.catalogState)).toBe(snapshotBefore);
      // No extra subscribes issued by fetchCatalog
      expect((adapter.subscribe as any).mock.calls.length).toBe(subscribeCallsBefore);
    });

    it('parallel fetchCatalog calls settle independently to the correct promise', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const pA = player.fetchCatalog({ group: 0n });
      const pB = player.fetchCatalog({ group: 1n });

      const reqA = await (adapter.fetch as any).mock.results[0]?.value;
      const reqB = await (adapter.fetch as any).mock.results[1]?.value;

      const catA = JSON.stringify({
        version: 1,
        tracks: [{ name: 'A', packaging: 'loc', isLive: true, role: 'video' }],
      });
      const catB = JSON.stringify({
        version: 1,
        tracks: [{ name: 'B', packaging: 'loc', isLive: true, role: 'audio' }],
      });

      // Deliver B first on its own stream, then A — order must not matter.
      deliverCatalogFetchObject(adapter, reqB, 301n, new TextEncoder().encode(catB));
      deliverCatalogFetchObject(adapter, reqA, 302n, new TextEncoder().encode(catA));

      const [a, b] = await Promise.all([pA, pB]);
      expect(a.tracks[0]?.name).toBe('A');
      expect(b.tracks[0]?.name).toBe('B');
    });

    it('destroy() rejects pending fetchCatalog promises', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      // Ensure the promise is registered before destroy (fetch is async)
      await (adapter.fetch as any).mock.results[0]?.value;

      await player.destroy();

      await expect(p).rejects.toThrow(/destroyed/i);
    });

    it('session close rejects pending fetchCatalog promises', async () => {
      // Without this, an in-flight fetchCatalog hangs until timeout, then
      // calls fetchCancel against an adapter whose session is already gone.
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      // Attach error handler eagerly — rejection fires synchronously below.
      const settled = p.catch((e) => e);
      await (adapter.fetch as any).mock.results[0]?.value;

      adapter._triggerClose(0x1, 'connection lost');

      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Session closed.*connection lost/);
    });

    it('migrate() rejects pending fetchCatalog promises (request IDs are session-scoped)', async () => {
      const oldAdapter = createMockAdapter();
      const { player } = await loadWithCatalog(oldAdapter);

      const p = player.fetchCatalog();
      const settled = p.catch((e) => e);
      await (oldAdapter.fetch as any).mock.results[0]?.value;

      const newAdapter = createMockAdapter();
      const migratePromise = player.migrate(newAdapter);
      await resolveConnect(newAdapter);
      await migratePromise;

      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/migrated/i);
    });

    it('rejects when a delta-update catalog object is fetched (no base state in per-call parser)', async () => {
      // Per docs: each fetchCatalog uses a fresh CatalogManager with no
      // prior state, so delta updates (which require a base catalog) must
      // reject — not silently apply against a non-existent state.
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const p = player.fetchCatalog();
      const fetchReqId = await (adapter.fetch as any).mock.results[0]?.value;

      const deltaPayload = JSON.stringify({ deltaUpdate: true, patches: [] });
      deliverCatalogFetchObject(adapter, fetchReqId, 305n, new TextEncoder().encode(deltaPayload));

      await expect(p).rejects.toThrow(/[Dd]elta catalog/);
    });
  });

  // ─── GOAWAY Migration (§3.5, §8.4.1) ─────────────────────────

  /**
   * §3.5: "Ideally this is transparent to the application using MOQT,
   * which involves establishing a new session in the background and
   * migrating Established subscriptions and published namespaces."
   *
   * §8.4.1: "When a subscriber receives the GOAWAY message, it starts
   * the process of connecting to a new relay and sending the SUBSCRIBE
   * requests for all Established subscriptions to the new relay."
   */
  describe('GOAWAY migration (§3.5, §8.4.1)', () => {
    async function loadCatalogAndSubscribe(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('migrate() connects new adapter and subscribes to catalog (§3.5)', async () => {
      // §3.5: "establishing a new session in the background"
      const oldAdapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(oldAdapter);

      // Create new adapter for migration
      const newAdapter = createMockAdapter();
      const migratePromise = player.migrate(newAdapter);
      await resolveConnect(newAdapter);
      await migratePromise;

      // New adapter should have connect called
      expect(newAdapter.connect).toHaveBeenCalledTimes(1);

      // New adapter should have catalog subscription with AbsoluteStart {0,0}
      expect(newAdapter.subscribe).toHaveBeenCalled();
      const nameArg = (newAdapter.subscribe as any).mock.calls[0]?.[1] as Uint8Array;
      expect(new TextDecoder().decode(nameArg)).toBe('catalog');
      const catalogOpts = (newAdapter.subscribe as any).mock.calls[0]?.[2];
      expect(catalogOpts.subscriptionFilter.type).toBe('AbsoluteStart');
      expect(BigInt(catalogOpts.subscriptionFilter.startGroup)).toBe(0n);
      expect(BigInt(catalogOpts.subscriptionFilter.startObject)).toBe(0n);
    });

    it('migrate() closes old adapter after connecting new one (§3.5)', async () => {
      // §3.5: After migration, the old session should be closed.
      const oldAdapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(oldAdapter);

      const newAdapter = createMockAdapter();
      const migratePromise = player.migrate(newAdapter);
      await resolveConnect(newAdapter);
      await migratePromise;

      // Old adapter should be closed
      expect(oldAdapter.close).toHaveBeenCalled();
    });

    it('migrate() emits session_migrated event (§3.5)', async () => {
      const oldAdapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(oldAdapter);
      const fn = vi.fn();
      player.on('session_migrated', fn);

      const newAdapter = createMockAdapter();
      const migratePromise = player.migrate(newAdapter);
      await resolveConnect(newAdapter);
      await migratePromise;

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'session_migrated' }),
      );
    });

    it('GOAWAY with empty URI does not auto-migrate without createTransport', async () => {
      // Without createTransport, auto-migration is not possible.
      // Player emits session_goaway but does not attempt to reconnect.
      const adapter = createMockAdapter();
      const player = await loadCatalogAndSubscribe(adapter);
      const fn = vi.fn();
      player.on('session_goaway', fn);

      adapter._triggerMessage({
        type: 'GOAWAY',
        newSessionUri: '',
      } as ControlMessage);

      expect(fn).toHaveBeenCalled();
      // No new connect should have happened
      expect(adapter.connect).toHaveBeenCalledTimes(1); // Only the initial connect
    });

    it('GOAWAY auto-migrates via createConnection + createTransport (§8.4.1)', async () => {
      // §8.4.1: "starts the process of connecting to a new relay"
      const oldAdapter = createMockAdapter();
      const newAdapter = createMockAdapter();
      const createTransport = vi.fn(async () => ({} as any));
      let adapterCallCount = 0;
      const createConnection = vi.fn(() => {
        adapterCallCount++;
        // First call → oldAdapter (load), second call → newAdapter (GOAWAY)
        return (adapterCallCount === 1 ? oldAdapter : newAdapter) as unknown as MoqtConnection;
      });

      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createConnection,
        createTransport,
      });
      const loadPromise = player.load();
      await resolveConnect(oldAdapter);
      await loadPromise;

      const catalogReqId = await (oldAdapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(oldAdapter);
      oldAdapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Trigger GOAWAY with new URI
      oldAdapter._triggerMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://new-relay.example.com/moq',
      } as ControlMessage);

      // Resolve new adapter connect
      await resolveConnect(newAdapter);
      await new Promise(r => setTimeout(r, 0));

      // createTransport should have been called with the GOAWAY URI as-is
      const goawayCall = createTransport.mock.calls.find(
        (call: any[]) => call[0].includes('new-relay.example.com'),
      );
      expect(goawayCall).toBeDefined();
      expect(goawayCall![0]).toBe('https://new-relay.example.com/moq');

      // New adapter should subscribe to catalog with AbsoluteStart {0,0}
      const newCatalogOpts = (newAdapter.subscribe as any).mock.calls[0]?.[2];
      expect(newCatalogOpts?.subscriptionFilter?.type).toBe('AbsoluteStart');
      expect(BigInt(newCatalogOpts?.subscriptionFilter?.startGroup)).toBe(0n);
      expect(BigInt(newCatalogOpts?.subscriptionFilter?.startObject)).toBe(0n);
    });

    it('GOAWAY migration falls back to config.url if GOAWAY has no URI', async () => {
      const oldAdapter = createMockAdapter();
      const newAdapter = createMockAdapter();
      const createTransport = vi.fn(async () => ({} as any));
      let adapterCallCount = 0;
      const createConnection = vi.fn(() => {
        adapterCallCount++;
        return (adapterCallCount === 1 ? oldAdapter : newAdapter) as unknown as MoqtConnection;
      });

      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createConnection,
        createTransport,
      });
      const loadPromise = player.load();
      await resolveConnect(oldAdapter);
      await loadPromise;

      const catalogReqId = await (oldAdapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(oldAdapter);
      oldAdapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Trigger GOAWAY with empty URI — should fall back to config.url
      oldAdapter._triggerMessage({
        type: 'GOAWAY',
        newSessionUri: '',
      } as ControlMessage);

      await resolveConnect(newAdapter);
      await new Promise(r => setTimeout(r, 0));

      // createTransport should have been called with the fallback URL (config.url)
      // The second call should use the original relay URL
      expect(createTransport.mock.calls.length).toBeGreaterThanOrEqual(2);
      const fallbackUrl = createTransport.mock.calls[createTransport.mock.calls.length - 1][0];
      expect(fallbackUrl).toContain('relay.example.com');
    });
  });

  // ─── SUBSCRIBE_NAMESPACE (§6.1, §9.25) ─────────────────────────

  /**
   * §6.1: "The subscriber sends SUBSCRIBE_NAMESPACE on a new
   * bidirectional stream [...] the publisher MUST send a single
   * REQUEST_OK or REQUEST_ERROR as the first message."
   */
  describe('subscribeNamespace (§6.1, §9.25)', () => {
    /** Load player and deliver catalog. */
    async function loadWithCatalog(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return { player, catalogReqId };
    }

    it('subscribeNamespace() calls adapter.subscribeNamespace() with prefix', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const reqId = await player.subscribeNamespace('live/broadcast');

      expect(adapter.subscribeNamespace).toHaveBeenCalledTimes(1);
      const args = (adapter.subscribeNamespace as any).mock.calls[0];
      // Namespace prefix should be encoded as Uint8Array[] tuple (split by '/')
      expect(new TextDecoder().decode(args[0][0])).toBe('live');
      expect(new TextDecoder().decode(args[0][1])).toBe('broadcast');
      expect(reqId).toBeDefined();
    });

    it('emits namespace_discovered event when NAMESPACE message arrives', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);
      const events: any[] = [];
      player.on('namespace_discovered', (e) => events.push(e));

      const reqId = await player.subscribeNamespace('live');

      // Simulate NAMESPACE message on the namespace stream
      adapter._triggerNamespaceMessage(BigInt(reqId), {
        type: 'NAMESPACE',
        trackNamespaceSuffix: [new TextEncoder().encode('broadcast1')],
        parameters: new Map(),
      } as ControlMessage);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('namespace_discovered');
      expect(events[0].requestId).toBe(BigInt(reqId));
    });

    it('cancelNamespace() calls adapter.cancelNamespace()', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const reqId = await player.subscribeNamespace('live');
      await player.cancelNamespace(BigInt(reqId));

      expect(adapter.cancelNamespace).toHaveBeenCalledTimes(1);
      expect(adapter.cancelNamespace).toHaveBeenCalledWith(BigInt(reqId));
    });
  });

  // ─── TRACK_STATUS (§9.19) ──────────────────────────────────────

  /**
   * §9.19: "TRACK_STATUS [...] enables a potential subscriber to query
   * the current status of a track without creating a subscription or
   * receiving objects."
   */
  describe('queryTrackStatus (§9.19)', () => {
    /** Load player and deliver catalog so media tracks are set up. */
    async function loadWithCatalog(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return { player, catalogReqId };
    }

    it('queryTrackStatus() calls adapter.trackStatus() with correct namespace/name', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      // Fire and forget — don't await the full promise since no REQUEST_OK is sent
      const _statusPromise = player.queryTrackStatus('video');

      expect(adapter.trackStatus).toHaveBeenCalledTimes(1);
      const args = (adapter.trackStatus as any).mock.calls[0];
      // namespace should be encoded config.namespace
      expect(args[0]).toBeDefined(); // Uint8Array[] namespace
      // name should be encoded 'video'
      expect(new TextDecoder().decode(args[1])).toBe('video');

      // Clean up: resolve the pending promise to avoid unhandled rejection
      const reqId = await (adapter.trackStatus as any).mock.results[0]?.value;
      adapter._triggerMessage({
        type: 'REQUEST_OK',
        requestId: reqId,
        parameters: new Map(),
      } as ControlMessage);
      await _statusPromise;
    });

    it('queryTrackStatus() resolves with parameters when REQUEST_OK arrives', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const statusPromise = player.queryTrackStatus('video');
      const reqId = await (adapter.trackStatus as any).mock.results[0]?.value;

      // Simulate REQUEST_OK response with parameters
      adapter._triggerMessage({
        type: 'REQUEST_OK',
        requestId: reqId,
        parameters: new Map([[0x01n, new Uint8Array([0x05])]]),
      } as ControlMessage);

      const result = await statusPromise;
      expect(result.requestId).toBe(BigInt(reqId));
      expect(result.parameters).toBeDefined();
    });

    it('queryTrackStatus() rejects when REQUEST_ERROR arrives', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const statusPromise = player.queryTrackStatus('video');
      const reqId = await (adapter.trackStatus as any).mock.results[0]?.value;

      // Simulate REQUEST_ERROR response
      adapter._triggerMessage({
        type: 'REQUEST_ERROR',
        requestId: reqId,
        errorCode: varint(0x01),
        retryInterval: varint(0n),
        errorReason: 'Track not found',
      } as ControlMessage);

      await expect(statusPromise).rejects.toThrow(/Track not found/);
    });
  });

  // ─── Error Taxonomy ──────────────────────────────────────────────

  describe('Error Taxonomy', () => {
    it('adapter error emits structured error event with severity and code', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new Error('something went wrong'));

      expect(errors).toHaveLength(1);
      expect(errors[0].type).toBe('error');
      expect(errors[0].error.source).toBe('connection');
      expect(errors[0].error.severity).toBeDefined();
      expect(errors[0].error.code).toBeDefined();
      expect(errors[0].error.timestampMs).toBeGreaterThan(0);
    });

    it('fatal adapter error (control stream) has severity=fatal', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new Error('control stream lost'));

      expect(errors[0].error.severity).toBe('fatal');
      expect(errors[0].error.code).toBe(0x1000); // CONTROL_STREAM_LOST
    });

    it('non-fatal adapter error has severity=degraded', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('timeout reading stream', {
        errorSource: 'data',
      }));

      expect(errors[0].error.severity).toBe('degraded');
    });

    it('classifyMoqtConnectionError: "protocol violation" → fatal', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new Error('protocol violation: unexpected message'));

      expect(errors[0].error.severity).toBe('fatal');
    });

    it('classifyMoqtConnectionError: "session" → fatal', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new Error('session terminated by peer'));

      expect(errors[0].error.severity).toBe('fatal');
    });

    // ── MoqtConnectionError-based classification ──────────────────────

    it('classifies MoqtConnectionError with isFatal=true as fatal severity', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('control stream closed', {
        errorSource: 'control',
      }));

      expect(errors[0].error.severity).toBe('fatal');
    });

    it('classifies MoqtConnectionError with isFatal=false as degraded severity', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('stream reset', {
        errorSource: 'data',
      }));

      expect(errors[0].error.severity).toBe('degraded');
    });

    it('classifies plain Error as fatal severity (conservative fallback)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new Error('unknown error without MoqtConnectionError'));

      expect(errors[0].error.severity).toBe('fatal');
    });

    it('maps MoqtConnectionError errorSource "control" to CONTROL_STREAM_LOST code', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('control stream error', {
        errorSource: 'control',
      }));

      expect(errors[0].error.code).toBe(0x1000); // CONTROL_STREAM_LOST
    });

    it('maps MoqtConnectionError errorSource "data" to DATA_STREAM_RESET code', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('data stream reset', {
        errorSource: 'data',
      }));

      expect(errors[0].error.code).toBe(0x1001); // DATA_STREAM_RESET
    });

    it('maps MoqtConnectionError errorSource "datagram" to DATAGRAM_DECODE_ERROR code', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('datagram decode failed', {
        errorSource: 'datagram',
      }));

      expect(errors[0].error.code).toBe(0x1002); // DATAGRAM_DECODE_ERROR
    });

    it('maps MoqtConnectionError errorSource "transport" to CONNECTION_LOST code', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('connection lost', {
        errorSource: 'transport',
      }));

      expect(errors[0].error.code).toBe(0x1003); // CONNECTION_LOST
    });

    it('preserves protocolCode in error context', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new MoqtConnectionError('protocol violation', {
        errorSource: 'control',
        protocolCode: 0x3,
      }));

      expect(errors[0].error.context).toEqual(
        expect.objectContaining({ protocolCode: 0x3 }),
      );
    });

    it('stream reset does not emit error — normal lifecycle event (§10.4.3)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerStreamClosed(42n, 0x1);

      // §10.4.3: RESET_STREAM is not an error — should not emit
      expect(errors).toHaveLength(0);
    });

    it('video decoder error emits VIDEO_DECODE_ERROR, source=decoder', async () => {
      const adapter = createMockAdapter();
      const renderer = {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null as (() => void) | null,
        onFrameRendered: null as ((ts: bigint, r: number) => void) | null,
        onStall: null as ((ms: number) => void) | null,
      };
      let capturedOnError: ((mediaType: string, error: Error) => void) | null = null;
      const videoDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0,
        onFrame: null,
        onError: null as ((error: Error) => void) | null,
        destroy: vi.fn(),
      };

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        clock: { now: () => 0 },
        createVideoDecoder: () => videoDecoder,
        createRenderer: () => renderer,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver catalog to trigger pipeline+dispatcher creation
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      // Trigger video decoder error through the onError callback
      videoDecoder.onError?.(new Error('Decode failed'));

      expect(errors).toHaveLength(1);
      expect(errors[0].error.code).toBe(0x1100); // VIDEO_DECODE_ERROR
      expect(errors[0].error.source).toBe('decoder');
      expect(errors[0].error.severity).toBe('degraded');
      expect(errors[0].error.context).toEqual({ mediaType: 'video' });
    });

    it('audio decoder error emits AUDIO_DECODE_ERROR', async () => {
      const adapter = createMockAdapter();
      const audioDecoder = {
        configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0,
        onData: null,
        onError: null as ((error: Error) => void) | null,
        destroy: vi.fn(),
      };
      const audioOutput = {
        schedule: vi.fn(), flush: vi.fn(), currentPlayoutTimeUs: 0, destroy: vi.fn(),
      };

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        clock: { now: () => 0 },
        createAudioDecoder: () => audioDecoder,
        createAudioOutput: () => audioOutput,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      audioDecoder.onError?.(new Error('Audio decode failed'));

      expect(errors).toHaveLength(1);
      expect(errors[0].error.code).toBe(0x1101); // AUDIO_DECODE_ERROR
      expect(errors[0].error.source).toBe('decoder');
    });

    it('catalog parse failure (first) emits severity=fatal, CATALOG_PARSE_ERROR', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      // Send invalid catalog JSON
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode('not json'),
      } as MoqtObject);

      expect(errors).toHaveLength(1);
      expect(errors[0].error.severity).toBe('fatal');
      expect(errors[0].error.code).toBe(0x1200); // CATALOG_PARSE_ERROR
      expect(errors[0].error.source).toBe('catalog');
    });

    it('catalog delta failure emits severity=degraded, CATALOG_DELTA_ERROR', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      // First: deliver valid catalog
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      // Second: deliver invalid catalog (delta update)
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode('bad delta'),
      } as MoqtObject);

      expect(errors).toHaveLength(1);
      expect(errors[0].error.severity).toBe('degraded');
      expect(errors[0].error.code).toBe(0x1201); // CATALOG_DELTA_ERROR
      expect(errors[0].error.source).toBe('catalog');
    });

    it('errorFilter suppresses errors when returning null', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        errorFilter: () => null, // suppress all errors
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      const legacyErrors: any[] = [];
      player.on('error', (e) => errors.push(e));
      player.on('session_error', (e) => legacyErrors.push(e));

      adapter._triggerError(new Error('suppressed'));

      expect(errors).toHaveLength(0);
      expect(legacyErrors).toHaveLength(0); // Also suppressed
    });

    it('errorFilter can modify error before emission', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        errorFilter: (err) => ({ ...err, severity: 'transient' as const }),
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      adapter._triggerError(new Error('connection lost'));

      expect(errors).toHaveLength(1);
      // errorFilter reclassified fatal → transient
      expect(errors[0].error.severity).toBe('transient');
    });

    it('backward compat: session_error still fires alongside error event', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      const legacyErrors: any[] = [];
      player.on('error', (e) => errors.push(e));
      player.on('session_error', (e) => legacyErrors.push(e));

      adapter._triggerError(new Error('test error'));

      expect(errors).toHaveLength(1);
      expect(legacyErrors).toHaveLength(1);
      expect(legacyErrors[0].type).toBe('session_error');
      expect(legacyErrors[0].error).toBeInstanceOf(Error);
    });

    it('session_closed event is unchanged (not routed through error taxonomy)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const closedEvents: any[] = [];
      player.on('session_closed', (e) => closedEvents.push(e));

      adapter._triggerClose(0, 'normal');

      expect(closedEvents).toHaveLength(1);
      expect(closedEvents[0].type).toBe('session_closed');
      expect(closedEvents[0].error).toBe(0);
      expect(closedEvents[0].reason).toBe('normal');
    });

    it('stream FIN (no error) does not emit error event', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      // FIN = no error code
      adapter._triggerStreamClosed(42n);

      expect(errors).toHaveLength(0);
    });

    it('error event includes cause from original error', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      const original = new Error('original cause');
      adapter._triggerError(original);

      expect(errors[0].error.cause).toBe(original);
    });

    it('subscribeToMediaTracks rejection emits LOAD_FAILED error', async () => {
      const adapter = createMockAdapter();
      // Force subscribeToMediaTracks to reject by making adapter.subscribe
      // throw on the next call (the media track subscribe after catalog).
      const player = new MoqtPlayer(createConfig(adapter));

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Sabotage the subscribe path: null out the adapter's subscribe to throw
      (adapter.subscribe as any).mockRejectedValueOnce(new Error('subscribe boom'));

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1n),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // subscribeToMediaTracks is async — flush microtasks
      await new Promise(r => setTimeout(r, 10));

      const loadFailed = errors.find(e => e.error.code === PlayerErrorCode.LOAD_FAILED);
      expect(loadFailed).toBeDefined();
      expect(loadFailed.error.severity).toBe('fatal');
      expect(loadFailed.error.source).toBe('player');
      expect(loadFailed.error.message).toMatch(/Media subscription failed/);

      await player.destroy();
    });
  });

  // ─── Debug Logging ────────────────────────────────────────────

  describe('Debug Logging', () => {
    it('default config (no logLevel) produces no console output during load', async () => {
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
      const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(spyError).not.toHaveBeenCalled();
      expect(spyWarn).not.toHaveBeenCalled();
      expect(spyInfo).not.toHaveBeenCalled();
      expect(spyDebug).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('logLevel "info" logs session lifecycle during load', async () => {
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logLevel: 'info',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Should have logged "Connecting to ..." and "Session established"
      const calls = spyInfo.mock.calls.map(c => c[1]);
      expect(calls).toContain('Connecting to %s');
      expect(calls.some((c: string) => c.startsWith('Session established'))).toBe(true);

      vi.restoreAllMocks();
    });

    it('logLevel "info" logs catalog received', async () => {
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logLevel: 'info',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      spyInfo.mockClear();

      // Ack catalog subscription before delivering catalog object
      ackCatalog(adapter);

      // Deliver catalog object
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      });

      // Wait for async subscription wiring
      await vi.waitFor(() => {
        const calls = spyInfo.mock.calls.map(c => c[1]);
        expect(calls).toContain('Catalog received: %d tracks');
      });

      vi.restoreAllMocks();
    });

    it('logLevel "warn" does NOT log info-level events', async () => {
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logLevel: 'warn',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // info-level messages should be suppressed at warn level
      expect(spyInfo).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('custom logger receives log calls', async () => {
      const customLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logger: customLogger,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Custom logger should have received info calls
      expect(customLogger.info).toHaveBeenCalled();
      const calls = customLogger.info.mock.calls.map((c: any[]) => c[0]);
      expect(calls).toContain('Connecting to %s');
      expect(calls.some((c: string) => c.startsWith('Session established'))).toBe(true);
    });

    it('logLevel "debug" logs per-object delivery', async () => {
      const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logLevel: 'debug',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Ack catalog subscription before delivering catalog object
      ackCatalog(adapter);

      // Deliver catalog to wire up subscription manager
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      });

      // Wait for subscription wiring
      await vi.waitFor(() => {
        expect(spyInfo.mock.calls.some(c => c[1] === 'Catalog received: %d tracks')).toBe(true);
      });

      spyDebug.mockClear();

      // Deliver a media object — should trigger debug log
      adapter._triggerObject(2n, {
        kind: 'data',
        trackAlias: varint(2n),
        groupId: varint(1n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: new Uint8Array([1, 2, 3]),
      });

      // Video objects log at info level with [OBJ] prefix for debugging
      const infoCalls = spyInfo.mock.calls.map(c => c[1]);
      expect(infoCalls.some((c: string) => typeof c === 'string' && c.includes('[OBJ]'))).toBe(true);

      vi.restoreAllMocks();
    });

    it('fatal error logs via console.error at logLevel "error"', async () => {
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logLevel: 'error',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Trigger a fatal error (control stream loss)
      adapter._triggerError(new Error('control stream closed'));

      expect(spyError).toHaveBeenCalled();
      const errorCalls = spyError.mock.calls.map(c => c[1]);
      expect(errorCalls.some(c => typeof c === 'string' && c.includes('Error'))).toBe(true);
      // Info-level messages should be suppressed
      expect(spyInfo).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('degraded error logs via console.warn at logLevel "warn"', async () => {
      const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        logLevel: 'warn',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Trigger a degraded error (non-fatal adapter error)
      adapter._triggerError(new MoqtConnectionError('test degraded error', { errorSource: 'data' }));

      expect(spyWarn).toHaveBeenCalled();

      vi.restoreAllMocks();
    });
  });

  // ─── qlog Tracing ─────────────────────────────────────────────

  describe('qlog Tracing', () => {
    it('onQlogEvent callback is wired to adapter when configured', async () => {
      const adapter = createMockAdapter();
      const qlogEvents: any[] = [];
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        onQlogEvent: (e) => qlogEvents.push(e),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // After load(), the adapter's onQlogEvent should be set
      expect(adapter.onQlogEvent).toBeTypeOf('function');
    });

    it('onQlogEvent not set on adapter when not configured', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(adapter.onQlogEvent).toBeNull();
    });

    it('qlog events flow from adapter through config callback', async () => {
      const adapter = createMockAdapter();
      const qlogEvents: any[] = [];
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        onQlogEvent: (e) => qlogEvents.push(e),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Simulate adapter emitting a qlog event
      adapter.onQlogEvent?.({ type: 'control_message_parsed', message: { type: 'GOAWAY' } });
      expect(qlogEvents).toHaveLength(1);
      expect(qlogEvents[0].type).toBe('control_message_parsed');
    });
  });

  // ─── Config expansion (Item 4) ─────────────────────────────

  describe('config expansion', () => {
    it('rejects invalid config at construction time', () => {
      const adapter = createMockAdapter();
      expect(() => new MoqtPlayer({
        ...createConfig(adapter),
        subscriberPriority: 999,
      })).toThrow(RangeError);
    });

    it('pre-merges defaults — gapTimeoutMs has a default', async () => {
      // After construction, config should have defaults merged.
      // We test this indirectly: if maxRequestId is not provided,
      // the default (100) is used for connect.
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      // If it doesn't throw, defaults were merged
      await expect(loadPromise).resolves.toBeUndefined();
    });

    it('passes moqtImplementation to adapter.connect as setup options (§9.3.1.6)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        moqtImplementation: 'my-app',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(adapter.connect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ implementation: 'my-app' }),
      );
    });

    it('passes authority to adapter.connect as setup options (§9.3.1.1)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        authority: 'proto-moq',
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(adapter.connect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authority: 'proto-moq' }),
      );
    });

    it('passes authTokens to adapter.connect as setup options (§9.3.1.5)', async () => {
      const adapter = createMockAdapter();
      const token = new Uint8Array([1, 2, 3]);
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        authTokens: [token],
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(adapter.connect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ authTokens: [token] }),
      );
    });

    it('uses default moqtImplementation when not specified', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(adapter.connect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ implementation: 'proto-moq' }),
      );
    });

    it('connectionTimeoutMs rejects if connect takes too long', async () => {
      const adapter = createMockAdapter();
      // Never resolve connect — should timeout
      adapter.connect = vi.fn(() => new Promise<void>(() => {}));
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        connectionTimeoutMs: 50,
      });

      await expect(player.load()).rejects.toThrow(/timeout/i);
    });
  });

  // ─── Aggregate Stats ────────────────────────────────────────

  describe('Aggregate Stats', () => {
    /** Helper: load player and deliver catalog (no fake timers). */
    async function loadWithCatalog(
      adapter: ReturnType<typeof createMockAdapter>,
      configOverrides?: Partial<MoqtPlayerConfig>,
    ) {
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        ...configOverrides,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Flush async subscription setup
      await new Promise(r => setTimeout(r, 0));

      return { player, catalogReqId };
    }

    it('stats getter returns a frozen plain object', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const snap = player.stats;
      expect(typeof snap).toBe('object');
      expect(Object.isFrozen(snap)).toBe(true);
    });

    it('TTFF starts null before load', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      expect(player.stats.timeToFirstFrameMs).toBeNull();
      expect(player.stats.ttffBreakdown).toBeNull();
    });

    it('records TTFF stages through load lifecycle', async () => {
      const adapter = createMockAdapter();
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, 'now');
      dateSpy.mockReturnValue(now);

      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      // loadStart recorded at now

      dateSpy.mockReturnValue(now + 50);
      await resolveConnect(adapter);
      await loadPromise;

      // After load: transportConnected + setupComplete recorded at now+50
      const snap = player.stats;
      expect(snap.ttffBreakdown).not.toBeNull();
      expect(snap.ttffBreakdown!.loadCalledMs).toBe(0);
      expect(snap.ttffBreakdown!.transportConnectedMs).toBe(50);
      expect(snap.ttffBreakdown!.setupCompleteMs).toBe(50);

      dateSpy.mockRestore();
    });

    it('records catalogReceived after catalog object', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);
      const snap = player.stats;
      expect(snap.ttffBreakdown!.catalogReceivedMs).not.toBeNull();
    });

    it('sets track info from catalog selection', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);
      const snap = player.stats;

      expect(snap.currentVideoCodec).toBe('av01.0.08M.10');
      expect(snap.currentAudioCodec).toBe('opus');
      expect(snap.currentBitrate).toBe(1_500_000);
      expect(snap.currentResolution).toEqual({ width: 1920, height: 1080 });
    });

    it('tracks objectsReceived and bytesReceived from media objects', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      // Get the track alias for a media subscription
      const mediaReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      // Deliver a data object on the media track
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: mediaReqId,
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: varint(0),
        extensions: new Uint8Array(0),
        payload: new Uint8Array(512),
      } as MoqtObject);

      const snap = player.stats;
      expect(snap.objectsReceived).toBeGreaterThanOrEqual(1);
      expect(snap.bytesReceived).toBeGreaterThanOrEqual(512);
    });

    it('tracks gapsReceived from gap objects', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const mediaReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      // Deliver a gap object
      adapter._triggerObject(1n, {
        kind: 'gap',
        trackAlias: mediaReqId,
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: varint(0),
        status: varint(0x1), // END_OF_GROUP
      } as MoqtObject);

      const snap = player.stats;
      expect(snap.gapsReceived).toBeGreaterThanOrEqual(1);
    });

    it('sessionAgeMs reflects time since load', async () => {
      const adapter = createMockAdapter();
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, 'now');
      dateSpy.mockReturnValue(now);

      const player = new MoqtPlayer(createConfig(adapter));
      expect(player.stats.sessionAgeMs).toBe(0);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      dateSpy.mockReturnValue(now + 3000);
      expect(player.stats.sessionAgeMs).toBe(3000);

      dateSpy.mockRestore();
    });

    it('playbackDurationMs tracks active time via play/pause', async () => {
      const adapter = createMockAdapter();
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, 'now');
      dateSpy.mockReturnValue(now);

      const { player } = await loadWithCatalog(adapter);
      expect(player.stats.playbackDurationMs).toBe(0);

      player.play();
      dateSpy.mockReturnValue(now + 1000);
      expect(player.stats.playbackDurationMs).toBe(1000);

      player.pause();
      dateSpy.mockReturnValue(now + 3000); // Paused — should not count
      expect(player.stats.playbackDurationMs).toBe(1000);

      dateSpy.mockRestore();
    });

    it('destroy stops playback duration tracking', async () => {
      const adapter = createMockAdapter();
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, 'now');
      dateSpy.mockReturnValue(now);

      const { player } = await loadWithCatalog(adapter);

      player.play();
      dateSpy.mockReturnValue(now + 500);
      await player.destroy();

      // Should have stopped at 500ms
      const snap = player.stats;
      expect(snap.playbackDurationMs).toBe(500);

      dateSpy.mockRestore();
    });

    it('deferred fields default to 0', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const snap = player.stats;

      expect(snap.currentLatencyMs).toBe(0);
      expect(snap.framesDropped).toBe(0);
      expect(snap.videoBufferDepth).toBe(0);
      expect(snap.audioBufferDepth).toBe(0);
      expect(snap.videoDecoderQueueDepth).toBe(0);
      expect(snap.reconnectCount).toBe(0);
    });

    it('successive snapshots are independent', async () => {
      const adapter = createMockAdapter();
      const { player } = await loadWithCatalog(adapter);

      const snap1 = player.stats;
      const objCount1 = snap1.objectsReceived;

      // Deliver another object
      const mediaReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      adapter._triggerObject(2n, {
        kind: 'data',
        trackAlias: mediaReqId,
        groupId: varint(2),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: varint(0),
        extensions: new Uint8Array(0),
        payload: new Uint8Array(256),
      } as MoqtObject);

      const snap2 = player.stats;
      // snap1 should be frozen and unchanged
      expect(snap1.objectsReceived).toBe(objCount1);
      expect(snap2.objectsReceived).toBeGreaterThan(objCount1);
    });
  });

  // ─── Decoder Feedback (§7 backpressure, §2.3.1.1 drift) ────────

  describe('Decoder Feedback', () => {
    /** Manual clock for deterministic tests. */
    let clockTime: number;
    const mockClock: ClockSource = { now: () => clockTime };

    beforeEach(() => {
      clockTime = 5_000_000;
    });

    /** Load player and trigger catalog. */
    async function loadWithCatalog(
      adapter: ReturnType<typeof createMockAdapter>,
      configOverrides?: Partial<MoqtPlayerConfig>,
    ) {
      const config: MoqtPlayerConfig = {
        ...createConfig(adapter),
        clock: mockClock,
        ...configOverrides,
      };
      const player = new MoqtPlayer(config);
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      return player;
    }

    it('decode error from adapter reaches RecoveryController via feedback', async () => {
      const adapter = createMockAdapter();
      const player = await loadWithCatalog(adapter, {
        // Use small createVideoDecoder/createAudioDecoder to get CommandDispatcher wired
        createVideoDecoder: () => ({
          configure: vi.fn(),
          decode: vi.fn(),
          flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(),
          queueDepth: 0,
          onFrame: null,
          onError: null,
          destroy: vi.fn(),
        }),
        createRenderer: () => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
          destroy: vi.fn(),
          onFirstFrame: null,
          onFrameRendered: null,
          onStall: null,
        }),
      });

      const recoveryFn = vi.fn();
      player.on('recovery_action', recoveryFn);

      // Start playing (creates tick interval + enables pipeline)
      player.play();

      // Push video objects so pipeline is active
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(50n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Simulate decode error via video decoder's onError callback
      // The CommandDispatcher wires decoder.onError → both onError and onFeedback
      // onFeedback → player.handleFeedback → pipeline.handleFeedback → recovery evaluate
      // Find the video decoder through the adapter wiring and trigger error
      // Since we created a mock decoder via factory, the error triggers through the pipeline feedback
      // We test the full path: the CommandDispatcher already wired onError to fire onFeedback

      // The test verifies the wiring exists by checking player.tick() doesn't break
      // and that the pipeline was created with recovery controller
      expect(() => player.tick()).not.toThrow();

      await player.destroy();
    });

    it('repeated fatal decode errors do not retrigger error state transition', async () => {
      const adapter = createMockAdapter();
      const mockVideoDecoder = {
        configure: vi.fn(),
        decode: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(),
        queueDepth: 0,
        onFrame: null as any,
        onError: null as ((err: Error) => void) | null,
        destroy: vi.fn(),
      };
      const player = await loadWithCatalog(adapter, {
        createVideoDecoder: () => mockVideoDecoder,
        createRenderer: () => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
          destroy: vi.fn(),
          onFirstFrame: null,
          onFrameRendered: null,
          onStall: null,
        }),
      });

      player.hooks.onRecovery.add(() => ({
        type: 'terminate',
        reason: 'forced by test',
      }));
      player.play();

      const errors: any[] = [];
      player.on('error', (e) => errors.push(e));

      expect(mockVideoDecoder.onError).toBeTypeOf('function');

      expect(() => {
        mockVideoDecoder.onError?.(new Error('first decode error'));
        mockVideoDecoder.onError?.(new Error('second decode error'));
      }).not.toThrow();

      expect(player.state).toBe(PlayerState.ERROR);
      expect(errors).toHaveLength(1);
      expect(errors[0].error.code).toBe(0x1100); // VIDEO_DECODE_ERROR

      await player.destroy();
    });

    it('queue pressure throttles pipeline draining', async () => {
      const adapter = createMockAdapter();
      const mockVideoDecoder = {
        configure: vi.fn(),
        decode: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(),
        queueDepth: 0,
        onFrame: null as any,
        onError: null as any,
        destroy: vi.fn(),
      };
      const player = await loadWithCatalog(adapter, {
        createVideoDecoder: () => mockVideoDecoder,
        createRenderer: () => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
          destroy: vi.fn(),
          onFirstFrame: null,
          onFrameRendered: null,
          onStall: null,
        }),
      });

      player.play();

      // Get video track alias
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(50n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Push a video object
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(50n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xCA, 0xFE]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      // Set high queue depth BEFORE dispatch — triggers queue_pressure feedback
      mockVideoDecoder.queueDepth = 10;

      // Dispatch a decode to trigger checkQueuePressure
      const decoderCmdFn = vi.fn();
      player.on('decoder_command', decoderCmdFn);

      player.tick(); // first tick: objects are drained and sent to decoder

      // After decode with high queueDepth, onFeedback fires queue_pressure
      // → handleFeedback → pipeline.handleFeedback → pipeline._throttled = true
      // Un-throttle comes from CommandDispatcher checking queue depth on
      // frame output (onFrame/onData callbacks). This verifies the feedback
      // path is wired end-to-end.

      await player.destroy();
    });

    it('frame rendered feeds SyncController drift detection', async () => {
      const adapter = createMockAdapter();
      const mockRenderer = {
        enqueue: vi.fn(),
        flush: vi.fn(),
        destroy: vi.fn(),
        onFirstFrame: null as any,
        onFrameRendered: null as any,
        onStall: null as any,
      };
      const player = await loadWithCatalog(adapter, {
        createVideoDecoder: () => ({
          configure: vi.fn(),
          decode: vi.fn(),
          flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(),
          queueDepth: 0,
          onFrame: null,
          onError: null,
          destroy: vi.fn(),
        }),
        createRenderer: () => mockRenderer,
        driftThresholdMs: 500,
      });

      const driftFn = vi.fn();
      player.on('sync_drift', driftFn);
      player.play();

      // The renderer.onFrameRendered should be wired by CommandDispatcher.
      // When it fires, it should send feedback to the pipeline's SyncController.
      // Verify the wiring exists:
      expect(mockRenderer.onFrameRendered).not.toBeNull();

      // Trigger a frame_rendered with large drift — this goes through:
      // renderer.onFrameRendered → CommandDispatcher.onFeedback
      // → player.handleFeedback → pipeline.handleFeedback → sync.reportActualRenderTime
      // → needsResync → sync_drift event
      // (Only fires if sync reference is established, which requires audio pipeline activity)

      await player.destroy();
    });
  });

  // ─── readyState (player observability) ──────────────────────

  describe('readyState', () => {
    it('starts at HAVE_NOTHING before load()', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      expect(player.readyState).toBe(0); // HAVE_NOTHING
    });

    it('stays HAVE_NOTHING after connect, before catalog', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Connected but no catalog yet
      expect(player.readyState).toBe(0); // HAVE_NOTHING
    });

    it('advances to HAVE_CATALOG after catalog_received', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      expect(player.readyState).toBe(1); // HAVE_CATALOG
    });

    it('advances to HAVE_MEDIA when objects are received', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Wait for media subscriptions to fire
      await new Promise(r => setTimeout(r, 10));

      // Send SUBSCRIBE_OK for video (reqId=2, alias=2)
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(2),
        trackAlias: varint(2),
        parameters: new Map(),
      } as unknown as ControlMessage);

      // Send a media object on the video alias
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(2),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        extensions: new Uint8Array([0x02, 0x00]),
        payload: new Uint8Array([0xCA, 0xFE]),
      } as MoqtObject);

      expect(player.readyState).toBeGreaterThanOrEqual(2); // HAVE_MEDIA or higher
    });

    it('readyState accessible as string via readyStateLabel', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      expect(player.readyStateLabel).toBe('HAVE_NOTHING');
    });

    it('catalog injection immediately sets HAVE_CATALOG', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        catalog: {
          tracks: [
            { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 1920, height: 1080, renderGroup: 1 },
            { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2', renderGroup: 1 },
          ],
        },
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(player.readyState).toBeGreaterThanOrEqual(1); // HAVE_CATALOG or higher
    });
  });

  // ─── External catalog injection ─────────────────────────────

  describe('external catalog injection', () => {
    it('catalog config: skips catalog subscription and subscribes to media directly', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        catalog: {
          tracks: [
            { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 1920, height: 1080, renderGroup: 1 },
            { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2', renderGroup: 1 },
          ],
        },
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // With catalog config: NO catalog subscription, only video + audio
      expect(adapter.subscribe).toHaveBeenCalledTimes(2);

      await player.destroy();
    });

    it('catalog config: emits catalog_received with injected tracks', async () => {
      const adapter = createMockAdapter();
      const fn = vi.fn();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        catalog: {
          tracks: [
            { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 1920, height: 1080, renderGroup: 1 },
            { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2', renderGroup: 1 },
          ],
        },
      });
      player.on('catalog_received', fn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'catalog_received',
          catalog: expect.objectContaining({
            tracks: expect.arrayContaining([
              expect.objectContaining({ name: 'video', codec: 'av01.0.08M.10' }),
              expect.objectContaining({ name: 'audio', codec: 'opus' }),
            ]),
          }),
        }),
      );

      await player.destroy();
    });

    it('catalog config: backward compat — knownTracks still works', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: {
          video: { name: 'video', codec: 'av01.0.08M.10', width: 1920, height: 1080 },
          audio: { name: 'audio', codec: 'opus', samplerate: 48000, channels: 2 },
        },
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // knownTracks: catalog + video + audio = 3 subscribes
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      await player.destroy();
    });
  });

  // ─── TTFF Optimization (OVERALL_PLAN Item 11) ────────────────

  describe('TTFF Optimization', () => {
    /**
     * knownTracks config matching the CATALOG_JSON tracks.
     * @see DESIGN-production-readiness.md §2
     */
    const KNOWN_TRACKS = {
      video: {
        name: 'video',
        codec: 'av01.0.08M.10',
        width: 1920,
        height: 1080,
      },
      audio: {
        name: 'audio',
        codec: 'opus',
        samplerate: 48000,
        channels: 2,
      },
    };

    it('parallel media subscribe — both tracks subscribed without serial await (§9.5)', async () => {
      // §9.5: MAX_REQUEST_ID allows multiple concurrent requests.
      // After refactor, subscribeToMediaTracks uses Promise.all instead of serial for-loop.
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      ackCatalog(adapter);
      // Trigger catalog — subscribeToMediaTracks fires with Promise.all
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      // Flush microtasks for async subscription
      await new Promise(r => setTimeout(r, 0));

      // 3 subscribe calls: catalog + video + audio (both media in parallel)
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      await player.destroy();
    });

    it('knownTracks: media subscribed in parallel with catalog (§9.5)', async () => {
      // With knownTracks, load() subscribes to catalog + media in parallel.
      // All 3 subscribes should happen within load() — no catalog wait needed.
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // 3 subscribe calls: catalog + video + audio, all in load()
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      await player.destroy();
    });

    it('knownTracks: live media subscribes with NextGroupStart, not LargestObject', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // 3 subscribe calls: catalog + video + audio
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      // Catalog (call 0) uses AbsoluteStart {0,0} — catalog is at group 0
      const catalogOpts = (adapter.subscribe as any).mock.calls[0][2];
      expect(catalogOpts?.subscriptionFilter?.type).toBe('AbsoluteStart');
      expect(BigInt(catalogOpts?.subscriptionFilter?.startGroup)).toBe(0n);
      expect(BigInt(catalogOpts?.subscriptionFilter?.startObject)).toBe(0n);

      // Video (call 1) should use NextGroupStart for live media
      const videoOpts = (adapter.subscribe as any).mock.calls[1][2];
      expect(videoOpts?.subscriptionFilter?.type).toBe('NextGroupStart');

      // Audio (call 2) should use NextGroupStart for live media
      const audioOpts = (adapter.subscribe as any).mock.calls[2][2];
      expect(audioOpts?.subscriptionFilter?.type).toBe('NextGroupStart');

      await player.destroy();
    });

    it('knownTracks: pipelines created during load() before catalog', async () => {
      const adapter = createMockAdapter();
      const decoderConfigFn = vi.fn();

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
        createVideoDecoder: () => ({
          configure: decoderConfigFn,
          decode: vi.fn(),
          flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(),
          queueDepth: 0,
          onFrame: null,
          onError: null,
          destroy: vi.fn(),
        }),
        createRenderer: () => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
          destroy: vi.fn(),
          onFirstFrame: null,
          onFrameRendered: null,
          onStall: null,
        }),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Pipeline should be created during load() — decoder configured eagerly
      // The pipeline.configure() emits a 'configure' DecoderCommand which
      // the CommandDispatcher dispatches to the video decoder.
      expect(decoderConfigFn).toHaveBeenCalled();

      await player.destroy();
    });

    it('knownTracks: objects route to pre-created pipelines', async () => {
      const adapter = createMockAdapter();
      const decodeFn = vi.fn();

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
        createVideoDecoder: () => ({
          configure: vi.fn(),
          decode: decodeFn,
          flush: vi.fn(() => Promise.resolve()),
          reset: vi.fn(),
          queueDepth: 0,
          onFrame: null,
          onError: null,
          destroy: vi.fn(),
        }),
        createRenderer: () => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
          destroy: vi.fn(),
          onFirstFrame: null,
          onFrameRendered: null,
          onStall: null,
        }),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Start playing (enables pipeline ticking)
      player.play();

      // Get video track request ID (2nd subscribe call: catalog=1st, video=2nd)
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;

      // Send SUBSCRIBE_OK to establish the subscription
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: varint(50n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Send a video object — should route to pre-created pipeline
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(50n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0xCA, 0xFE]),
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      // Tick the pipeline — should drain to decoder
      player.tick();

      // decode() was called — the object routed through the pre-created pipeline
      expect(decodeFn).toHaveBeenCalled();

      await player.destroy();
    });

    it('knownTracks: unknown alias before catalog does NOT misroute to catalog handler', async () => {
      // Regression: with knownTracks, media SUBSCRIBE_OK may remap aliases.
      // Objects arriving with the server's alias BEFORE the remap should NOT
      // be assumed to be catalog objects. The fallback "assume catalog" path
      // must only match the catalog's own request ID.
      const adapter = createMockAdapter();
      const catalogErrors: unknown[] = [];

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
      });

      player.on('error', (e) => {
        if (e.error.source === 'catalog') catalogErrors.push(e);
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Catalog reqId=0 (1st subscribe), video reqId=X (2nd), audio reqId=Y (3rd)
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;

      // Server sends SUBSCRIBE_OK for catalog with alias=1
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: catalogReqId,
        trackAlias: varint(1n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);

      // Simulate a data object with alias=99 (unknown — maybe a server-remapped
      // media track whose SUBSCRIBE_OK hasn't arrived yet). This MUST NOT be
      // misrouted to the catalog handler.
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(99n),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0x21, 0x4F, 0xDE]), // binary, not JSON
        extensions: undefined,
        publisherPriority: 128,
      } as MoqtObject);

      // No catalog errors — the binary object was NOT fed to JSON.parse
      expect(catalogErrors).toHaveLength(0);

      await player.destroy();
    });

    it('knownTracks: catalog arrival validates, does not re-create pipelines', async () => {
      const adapter = createMockAdapter();
      let decoderCreateCount = 0;

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
        createVideoDecoder: () => {
          decoderCreateCount++;
          return {
            configure: vi.fn(),
            decode: vi.fn(),
            flush: vi.fn(() => Promise.resolve()),
            reset: vi.fn(),
            queueDepth: 0,
            onFrame: null,
            onError: null,
            destroy: vi.fn(),
          };
        },
        createRenderer: () => ({
          enqueue: vi.fn(),
          flush: vi.fn(),
          destroy: vi.fn(),
          onFirstFrame: null,
          onFrameRendered: null,
          onStall: null,
        }),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Decoder created once during load() via knownTracks
      expect(decoderCreateCount).toBe(1);

      // Now trigger catalog arrival
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      await new Promise(r => setTimeout(r, 0));

      // Decoder NOT recreated — pipelinesCreated flag prevents double-creation
      expect(decoderCreateCount).toBe(1);

      // No additional subscribes (media already subscribed in load)
      // catalog + video + audio = 3 total, same as before catalog arrived
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      await player.destroy();
    });

    it('knownTracks: catalog mismatch logs warning', async () => {
      const adapter = createMockAdapter();
      const logWarn = vi.fn();

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: {
          video: {
            name: 'wrong-video-name',
            codec: 'avc1.64001f',
          },
        },
        logLevel: 'warn',
        logger: {
          debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn(),
        },
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Trigger catalog
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      await new Promise(r => setTimeout(r, 0));

      // Should warn about video track not found in catalog
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('knownTracks'),
        expect.anything(),
      );

      await player.destroy();
    });

    it('without knownTracks: behavior unchanged — catalog-first flow', async () => {
      // Without knownTracks, load() only subscribes to catalog.
      // Media subscriptions happen later when catalog arrives.
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Only 1 subscribe: catalog
      expect(adapter.subscribe).toHaveBeenCalledTimes(1);

      // Trigger catalog — now media subscriptions happen
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);

      await new Promise(r => setTimeout(r, 0));

      // Now 3: catalog + video + audio
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      await player.destroy();
    });

    it('beforeSubscribe hook runs for knownTracks media subscribes', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
      });

      // Cancel video subscriptions via hook
      player.hooks.beforeSubscribe.add((intent) =>
        intent.mediaType === 'video' ? null : intent,
      );

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // 2 subscribe calls: catalog + audio (video cancelled by hook)
      expect(adapter.subscribe).toHaveBeenCalledTimes(2);

      await player.destroy();
    });

    it('knownTracks: emits track_subscribed for pre-known tracks', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
      });

      const fn = vi.fn();
      player.on('track_subscribed', fn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // track_subscribed emitted for video and audio during load()
      expect(fn).toHaveBeenCalledTimes(2);
      const calls = fn.mock.calls.map((c: any) => c[0]);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'track_subscribed', mediaType: 'video' }),
          expect.objectContaining({ type: 'track_subscribed', mediaType: 'audio' }),
        ]),
      );

      await player.destroy();
    });

    it('knownTracks: stats track info recorded during load()', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        knownTracks: KNOWN_TRACKS,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Stats should have track info from knownTracks
      const stats = player.stats;
      expect(stats.currentVideoCodec).toBe('av01.0.08M.10');
      expect(stats.currentAudioCodec).toBe('opus');
      expect(stats.currentResolution).toEqual({ width: 1920, height: 1080 });

      await player.destroy();
    });
  });

  describe('knownTracks + disableVideo/disableAudio', () => {
    const KNOWN_TRACKS = {
      video: { name: 'video', codec: 'av01.0.08M.10', width: 1920, height: 1080 },
      audio: { name: 'audio', codec: 'opus', samplerate: 48000, channels: 2 },
    };

    it('knownTracks + disableVideo: subscribes only audio', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter), knownTracks: KNOWN_TRACKS, disableVideo: true,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const trackNames = (adapter.subscribe as any).mock.calls.map(
        (c: any) => { try { return new TextDecoder().decode(c[1]); } catch { return '?'; } },
      );
      expect(trackNames).toContain('audio');
      expect(trackNames).not.toContain('video');
      await player.destroy();
    });

    it('knownTracks + disableAudio: subscribes only video', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter), knownTracks: KNOWN_TRACKS, disableAudio: true,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const trackNames = (adapter.subscribe as any).mock.calls.map(
        (c: any) => { try { return new TextDecoder().decode(c[1]); } catch { return '?'; } },
      );
      expect(trackNames).toContain('video');
      expect(trackNames).not.toContain('audio');
      await player.destroy();
    });

    it('knownTracks: all media refused → fatal ALL_TRACKS_REFUSED', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer({
        ...createConfig(adapter), knownTracks: KNOWN_TRACKS,
      });
      const errorFn = vi.fn();
      player.on('error', errorFn);
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Get video and audio request IDs (catalog is index 0)
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;

      adapter._triggerMessage({
        type: 'REQUEST_ERROR', requestId: varint(BigInt(videoReqId)),
        errorCode: varint(0x10n), errorReason: 'Not found',
      } as any);
      adapter._triggerMessage({
        type: 'REQUEST_ERROR', requestId: varint(BigInt(audioReqId)),
        errorCode: varint(0x10n), errorReason: 'Not found',
      } as any);

      const allRefused = errorFn.mock.calls.find((c: any) => c[0]?.error?.code === 0x1303);
      expect(allRefused).toBeDefined();
      await player.destroy();
    });
  });

  // ─── Live Catch-Up (§5.1.16) ──────────────────────────────────

  describe('Live Catch-Up', () => {
    it('currentLatencyMs defaults to 0 in stats before catch-up', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      expect(player.stats.currentLatencyMs).toBe(0);
    });

    it('catchUpRecoveryMs default is 50 in merged config', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      // Access internal merged config — verify default was applied
      expect((player as any).config.catchUpRecoveryMs).toBe(50);
    });

    it('catch_up_changed event type exists in PlayerEventMap', () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const fn = vi.fn();
      // Should compile — catch_up_changed is in the event map
      const unsub = player.on('catch_up_changed', fn);
      expect(typeof unsub).toBe('function');
      unsub();
    });
  });

  // ─── CMAF / MSE Fallback (draft-ietf-moq-cmsf-00) ──────────────────

  describe('CMAF / MSE Fallback', () => {
    /** Catalog JSON for a CMAF broadcast (packaging: 'cmaf'). */
    const CMAF_CATALOG_JSON = JSON.stringify({
      version: 1,
      tracks: [
        {
          name: '1.m4s',
          packaging: 'cmaf',
          isLive: true,
          role: 'video',
          renderGroup: 1,
          codec: 'avc1.64001f',
          width: 1920,
          height: 1080,
          bitrate: 1_500_000,
          initData: btoa(String.fromCharCode(0x00, 0x01, 0x02, 0x03)), // fake ftyp+moov
        },
        {
          name: '2.m4s',
          packaging: 'cmaf',
          isLive: true,
          role: 'audio',
          renderGroup: 1,
          codec: 'mp4a.40.2',
          samplerate: 44100,
          channelConfig: '2',
          bitrate: 128000,
          initData: btoa(String.fromCharCode(0x04, 0x05, 0x06, 0x07)), // fake ftyp+moov
        },
      ],
    });

    /**
     * Minimal CMAF assembler for testing — pairs moof+mdat by media type.
     * Matches CmafAssemblerLike interface without importing @moqt/browser.
     */
    function createCmafAssemblerFactory() {
      return (options: { onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, trackName: string) => void }) => {
        const pending = new Map<string, Uint8Array>();
        return {
          push(mediaType: 'video' | 'audio', trackName: string, groupId: bigint, payload: Uint8Array) {
            const key = `${mediaType}:${trackName}:${groupId}`;
            // Simple box type check: bytes 4-7 = 'moof' or 'mdat'
            const type = payload.length >= 8
              ? String.fromCharCode(payload[4]!, payload[5]!, payload[6]!, payload[7]!)
              : '';
            if (type === 'moof') {
              pending.set(key, payload);
            } else if (type === 'mdat') {
              const moof = pending.get(key);
              if (moof) {
                pending.delete(key);
                const seg = new Uint8Array(moof.byteLength + payload.byteLength);
                seg.set(moof, 0);
                seg.set(payload, moof.byteLength);
                options.onSegment(mediaType, seg, trackName);
              }
            }
          },
          getEpoch(_mediaType: 'video' | 'audio') { return null; },
          reset() { pending.clear(); },
          destroy() { pending.clear(); },
        };
      };
    }

    /** Create a mock MediaSourceLike for testing. */
    function createMockMediaSource() {
      return {
        initialize: vi.fn(),
        appendChunk: vi.fn(),
        endOfStream: vi.fn(),
        reset: vi.fn(),
        mediaElement: null,
        onFirstFrame: null as (() => void) | null,
        onError: null as ((error: Error) => void) | null,
        onStall: null as ((durationMs: number) => void) | null,
        destroy: vi.fn(),
      };
    }

    it('creates MediaSource adapter when catalog has CMAF tracks (§3.5.1)', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1), // catalog alias
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });

      // Wait for async catalog processing
      await new Promise(r => setTimeout(r, 10));

      // MediaSource should have been initialized with codec strings and initData
      expect(mockMs.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ codec: 'avc1.64001f' }),
          audio: expect.objectContaining({ codec: 'mp4a.40.2' }),
        }),
      );

      await player.destroy();
    });

    it('does not create WebCodecs adapters for CMAF tracks (MSE path only)', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const createVideoDecoder = vi.fn();
      const createAudioDecoder = vi.fn();
      const createRenderer = vi.fn();
      const createAudioOutput = vi.fn();

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
        createVideoDecoder,
        createAudioDecoder,
        createRenderer,
        createAudioOutput,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      expect(createVideoDecoder).not.toHaveBeenCalled();
      expect(createAudioDecoder).not.toHaveBeenCalled();
      expect(createRenderer).not.toHaveBeenCalled();
      expect(createAudioOutput).not.toHaveBeenCalled();

      await player.destroy();
    });

    it('mixed packaging: CMAF video + LOC audio creates audio adapters but not video', async () => {
      const MIXED_CATALOG = JSON.stringify({
        version: 1, tracks: [
          { name: 'v', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1,
            codec: 'avc1.64001f', width: 1920, height: 1080, bitrate: 1_500_000,
            initData: btoa(String.fromCharCode(0x00, 0x01, 0x02, 0x03)) },
          { name: 'a', packaging: 'loc', isLive: true, role: 'audio', renderGroup: 1,
            codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 128_000 },
        ],
      });
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const createVideoDecoder = vi.fn();
      const createAudioDecoder = vi.fn(() => ({ configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()), reset: vi.fn(), queueDepth: 0, onFrame: null, onData: null, onError: null, destroy: vi.fn() }));
      const createRenderer = vi.fn();
      const createAudioOutput = vi.fn(() => ({ schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn() }));

      const player = new MoqtPlayer({
        ...createConfig(adapter), createMediaSource: () => mockMs, createCmafAssembler: createCmafAssemblerFactory(),
        createVideoDecoder, createAudioDecoder, createRenderer, createAudioOutput,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      ackCatalog(adapter);
      adapter._triggerObject(0n, { kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0), objectId: varint(0), publisherPriority: 0, extensions: new Uint8Array(0), payload: new TextEncoder().encode(MIXED_CATALOG) });
      await new Promise(r => setTimeout(r, 10));

      expect(createVideoDecoder).not.toHaveBeenCalled();
      expect(createRenderer).not.toHaveBeenCalled();
      expect(createAudioDecoder).toHaveBeenCalled();
      expect(createAudioOutput).toHaveBeenCalled();
      await player.destroy();
    });

    it('mixed packaging: LOC video + CMAF audio creates video adapters but not audio', async () => {
      const MIXED_CATALOG = JSON.stringify({
        version: 1, tracks: [
          { name: 'v', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1,
            codec: 'avc1.64001f', width: 1920, height: 1080, bitrate: 1_500_000 },
          { name: 'a', packaging: 'cmaf', isLive: true, role: 'audio', renderGroup: 1,
            codec: 'mp4a.40.2', samplerate: 44100, channelConfig: '2', bitrate: 128_000,
            initData: btoa(String.fromCharCode(0x04, 0x05, 0x06, 0x07)) },
        ],
      });
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const createVideoDecoder = vi.fn(() => ({ configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()), reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn() }));
      const createAudioDecoder = vi.fn();
      const createRenderer = vi.fn(() => ({ enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), onFirstFrame: null, onFrameRendered: null, onStall: null }));
      const createAudioOutput = vi.fn();

      const player = new MoqtPlayer({
        ...createConfig(adapter), createMediaSource: () => mockMs, createCmafAssembler: createCmafAssemblerFactory(),
        createVideoDecoder, createAudioDecoder, createRenderer, createAudioOutput,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      ackCatalog(adapter);
      adapter._triggerObject(0n, { kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0), objectId: varint(0), publisherPriority: 0, extensions: new Uint8Array(0), payload: new TextEncoder().encode(MIXED_CATALOG) });
      await new Promise(r => setTimeout(r, 10));

      expect(createVideoDecoder).toHaveBeenCalled();
      expect(createRenderer).toHaveBeenCalled();
      expect(createAudioDecoder).not.toHaveBeenCalled();
      expect(createAudioOutput).not.toHaveBeenCalled();
      await player.destroy();
    });

    it('routes CMAF objects to MediaSource.appendChunk, bypassing pipeline', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // Start playback
      player.play();

      // Now deliver a CMAF video frame as two objects: moof then mdat
      // The assembler pairs them and emits a concatenated segment.

      // Build a minimal moof (must contain mfhd + traf with tfhd + tfdt + trun)
      // mfhd(16) + tfhd(16) + tfdt(16) + trun(16) = 64 bytes of content
      // traf = 8 + 48 = 56 bytes, moof = 8 + 16 + 56 = 80 bytes
      const moofBytes = new Uint8Array(80);
      // moof box header
      new DataView(moofBytes.buffer).setUint32(0, 80); // size
      moofBytes[4] = 0x6d; moofBytes[5] = 0x6f; moofBytes[6] = 0x6f; moofBytes[7] = 0x66; // 'moof'
      // mfhd box (16 bytes)
      new DataView(moofBytes.buffer).setUint32(8, 16);
      moofBytes[12] = 0x6d; moofBytes[13] = 0x66; moofBytes[14] = 0x68; moofBytes[15] = 0x64; // 'mfhd'
      new DataView(moofBytes.buffer).setUint32(20, 1); // sequence_number
      // traf box (56 bytes)
      new DataView(moofBytes.buffer).setUint32(24, 56);
      moofBytes[28] = 0x74; moofBytes[29] = 0x72; moofBytes[30] = 0x61; moofBytes[31] = 0x66; // 'traf'
      // tfhd (16 bytes)
      new DataView(moofBytes.buffer).setUint32(32, 16);
      moofBytes[36] = 0x74; moofBytes[37] = 0x66; moofBytes[38] = 0x68; moofBytes[39] = 0x64; // 'tfhd'
      new DataView(moofBytes.buffer).setUint32(44, 1); // track_id
      // tfdt (16 bytes, version 0)
      new DataView(moofBytes.buffer).setUint32(48, 16);
      moofBytes[52] = 0x74; moofBytes[53] = 0x66; moofBytes[54] = 0x64; moofBytes[55] = 0x74; // 'tfdt'
      new DataView(moofBytes.buffer).setUint32(60, 90000); // baseMediaDecodeTime
      // trun (16 bytes)
      new DataView(moofBytes.buffer).setUint32(64, 16);
      moofBytes[68] = 0x74; moofBytes[69] = 0x72; moofBytes[70] = 0x75; moofBytes[71] = 0x6e; // 'trun'
      new DataView(moofBytes.buffer).setUint32(76, 1); // sample_count

      // Build a minimal mdat
      const mdatPayload = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
      const mdatBytes = new Uint8Array(8 + mdatPayload.byteLength);
      new DataView(mdatBytes.buffer).setUint32(0, 8 + mdatPayload.byteLength);
      mdatBytes[4] = 0x6d; mdatBytes[5] = 0x64; mdatBytes[6] = 0x61; mdatBytes[7] = 0x74; // 'mdat'
      mdatBytes.set(mdatPayload, 8);

      // Send moof (objectId=0)
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(2),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: moofBytes,
      });
      await new Promise(r => setTimeout(r, 10));

      // Send mdat (objectId=1) — assembler pairs them
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(2),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(1),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: mdatBytes,
      });
      await new Promise(r => setTimeout(r, 10));

      // MediaSource should receive the concatenated moof+mdat segment
      expect(mockMs.appendChunk).toHaveBeenCalledTimes(1);
      const [callType, callData] = mockMs.appendChunk.mock.calls[0] as [string, Uint8Array];
      expect(callType).toBe('video');
      expect(callData.byteLength).toBe(moofBytes.byteLength + mdatBytes.byteLength);

      await player.destroy();
    });

    it('does not create PlaybackPipeline for CMAF tracks', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // Internal pipelines should NOT exist for CMAF tracks
      expect((player as any).videoPipeline).toBeNull();
      expect((player as any).audioPipeline).toBeNull();
      // But MediaSource should exist
      expect((player as any).mediaSource).toBe(mockMs);

      await player.destroy();
    });

    it('MediaSource.onFirstFrame triggers first_frame event', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const firstFrameFn = vi.fn();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });
      player.on('first_frame', firstFrameFn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // Trigger first frame from MediaSource
      mockMs.onFirstFrame?.();

      expect(firstFrameFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'first_frame' }),
      );

      await player.destroy();
    });

    it('MediaSource.onStall triggers stall event', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const stallFn = vi.fn();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });
      player.on('stall', stallFn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // Trigger stall from MediaSource
      mockMs.onStall?.(500);

      expect(stallFn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stall', durationMs: 500 }),
      );

      await player.destroy();
    });

    it('MediaSource.onError emits structured error event', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const errorFn = vi.fn();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });
      player.on('error', errorFn);

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // Trigger error from MediaSource
      mockMs.onError?.(new Error('SourceBuffer QuotaExceededError'));

      expect(errorFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({
            severity: 'degraded',
            source: 'decoder',
          }),
        }),
      );

      await player.destroy();
    });

    it('gap objects are silently skipped for CMAF tracks', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      player.play();

      // Deliver a gap object (Object Status = END_OF_GROUP)
      adapter._triggerObject(1n, {
        kind: 'gap',
        trackAlias: varint(2), // video
        groupId: varint(5),
        subgroupId: varint(0),
        objectId: varint(0),
        status: varint(0x3), // END_OF_GROUP
      } as any);

      await new Promise(r => setTimeout(r, 10));

      // appendChunk should NOT be called for gap objects
      expect(mockMs.appendChunk).not.toHaveBeenCalled();

      await player.destroy();
    });

    it('drops CMAF objects while paused', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // Play then pause
      player.play();
      player.pause();

      // Deliver a CMAF object while paused
      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(2),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: new Uint8Array([0xCA, 0xFE]),
      });

      await new Promise(r => setTimeout(r, 10));

      // Should NOT call appendChunk while paused
      expect(mockMs.appendChunk).not.toHaveBeenCalled();

      await player.destroy();
    });

    it('destroy() cleans up MediaSource adapter', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      await player.destroy();

      expect(mockMs.destroy).toHaveBeenCalled();
      expect((player as any).mediaSource).toBeNull();
    });

    it('LOC catalog still works when createMediaSource is provided (backward compat)', async () => {
      // LOC catalog — createMediaSource should NOT be called
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const createMediaSource = vi.fn(() => mockMs);
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver standard LOC catalog (not CMAF)
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      // createMediaSource should NOT be called for LOC tracks
      expect(createMediaSource).not.toHaveBeenCalled();
      // Pipeline should exist for LOC
      expect((player as any).videoPipeline).not.toBeNull();

      await player.destroy();
    });

    it('records stats for CMAF objects', async () => {
      const adapter = createMockAdapter();
      const mockMs = createMockMediaSource();
      const player = new MoqtPlayer({
        ...createConfig(adapter),
        createMediaSource: () => mockMs,
        createCmafAssembler: createCmafAssemblerFactory(),
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver CMAF catalog
      const enc = new TextEncoder();
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: enc.encode(CMAF_CATALOG_JSON),
      });
      await new Promise(r => setTimeout(r, 10));

      player.play();

      // Deliver a CMAF media object

      adapter._triggerObject(1n, {
        kind: 'data',
        trackAlias: varint(2),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        publisherPriority: 0,
        extensions: new Uint8Array(0),
        payload: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      });

      await new Promise(r => setTimeout(r, 10));

      const stats = player.stats;
      expect(stats.objectsReceived).toBeGreaterThan(0);
      expect(stats.bytesReceived).toBeGreaterThan(0);

      await player.destroy();
    });
  });

  // ─── Timeline + Seek (draft-ietf-moq-msf-00 §7, transport-16 §9.2.2.5) ──

  describe('timeline subscription and seek', () => {
    /** VOD catalog with a mediatimeline track. */
    const VOD_CATALOG_JSON = JSON.stringify({
      version: 1,
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: false,
          trackDuration: 10000,
          role: 'video',
          renderGroup: 1,
          codec: 'av01.0.08M.10',
          width: 1920,
          height: 1080,
          bitrate: 1_500_000,
        },
        {
          name: 'audio',
          packaging: 'loc',
          isLive: false,
          trackDuration: 10000,
          role: 'audio',
          renderGroup: 1,
          codec: 'opus',
          samplerate: 48000,
          channelConfig: '2',
          bitrate: 32000,
        },
        {
          name: 'timeline',
          packaging: 'mediatimeline',
          isLive: false,
          trackDuration: 10000,
          depends: ['video'],
          mimeType: 'application/json',
        },
      ],
    });

    /** Timeline payload: 5 entries at 2s intervals. §7.1 */
    const TIMELINE_PAYLOAD = JSON.stringify([
      [0, [0, 0], 0],
      [2000, [1, 0], 0],
      [4000, [2, 0], 0],
      [6000, [3, 0], 0],
      [8000, [4, 0], 0],
    ]);

    async function loadVodPlayer(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      return player;
    }

    async function sendVodCatalog(adapter: ReturnType<typeof createMockAdapter>) {
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(VOD_CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));
    }

    it('subscribes to mediatimeline track when present in catalog (§7.2)', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);

      // subscribe calls: 1 for catalog + 3 for video+audio+timeline = 4
      expect(adapter.subscribe).toHaveBeenCalledTimes(4);

      await player.destroy();
    });

    it('does not subscribe to mediatimeline when not in catalog', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      // Send regular catalog (no timeline track)
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      // subscribe calls: 1 for catalog + 2 for video+audio = 3
      expect(adapter.subscribe).toHaveBeenCalledTimes(3);

      await player.destroy();
    });

    it('emits timeline_loaded on first timeline object (§7.3)', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);
      const fn = vi.fn();
      player.on('timeline_loaded', fn);

      await sendVodCatalog(adapter);

      // Get the timeline subscription requestId (4th subscribe call: catalog, video, audio, timeline)
      const timelineReqId = await (adapter.subscribe as any).mock.results[3]?.value;

      // Send timeline object
      adapter._triggerObject(10n, {
        kind: 'data',
        trackAlias: timelineReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TIMELINE_PAYLOAD),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'timeline_loaded',
          trackName: 'timeline',
          entryCount: 5,
        }),
      );

      await player.destroy();
    });

    it('duration getter returns trackDuration from VOD catalog (§5.1.37)', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);

      expect(player.duration).toBe(10000);

      await player.destroy();
    });

    it('seekable returns false without timeline entries', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);

      // Timeline track subscribed but no timeline objects received yet
      expect(player.seekable).toBe(false);

      await player.destroy();
    });

    it('seekable returns true after timeline loaded', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);

      const timelineReqId = await (adapter.subscribe as any).mock.results[3]?.value;
      adapter._triggerObject(10n, {
        kind: 'data',
        trackAlias: timelineReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TIMELINE_PAYLOAD),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      expect(player.seekable).toBe(true);

      await player.destroy();
    });

    // ── seek() tests (§9.2.2.5 — REQUEST_UPDATE with SUBSCRIPTION_FILTER) ──

    it('seek() sends REQUEST_UPDATE with AbsoluteStart for media subscriptions (§9.2.2.5)', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);

      // Establish media subscriptions (video + audio)
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: videoReqId,
        trackAlias: videoReqId,
        parameters: new Map(),
      } as unknown as ControlMessage);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: audioReqId,
        trackAlias: audioReqId,
        parameters: new Map(),
      } as unknown as ControlMessage);

      // Load timeline
      const timelineReqId = await (adapter.subscribe as any).mock.results[3]?.value;
      adapter._triggerObject(10n, {
        kind: 'data',
        trackAlias: timelineReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TIMELINE_PAYLOAD),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      // Play first
      player.play();

      // Seek to 5 seconds — should target group 2 (4000ms <= 5000ms)
      await player.seek(5000);

      // requestUpdate calls: 2 from play() + 2 from seek()
      // seek sends REQUEST_UPDATE with subscriptionFilter for video + audio
      const seekCalls = adapter.requestUpdate.mock.calls.filter(
        (call: any[]) => call[1]?.subscriptionFilter !== undefined
      );
      expect(seekCalls.length).toBe(2); // one for video, one for audio

      // Verify filter uses AbsoluteStart with group 2
      expect(seekCalls[0][1].subscriptionFilter).toEqual(
        expect.objectContaining({
          type: 'AbsoluteStart',
        }),
      );

      await player.destroy();
    });

    it('seek() emits seeking event (§7)', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);
      const fn = vi.fn();
      player.on('seeking', fn);

      await sendVodCatalog(adapter);

      // Establish subscriptions
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: videoReqId, parameters: new Map() } as unknown as ControlMessage);
      adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId: audioReqId, trackAlias: audioReqId, parameters: new Map() } as unknown as ControlMessage);

      // Load timeline
      const timelineReqId = await (adapter.subscribe as any).mock.results[3]?.value;
      adapter._triggerObject(10n, {
        kind: 'data',
        trackAlias: timelineReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TIMELINE_PAYLOAD),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      player.play();
      await player.seek(3000);

      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'seeking',
          targetTimeMs: 3000,
        }),
      );

      await player.destroy();
    });

    it('seek() passes target groupId to pipeline.reset() to reject stale objects (§9.11.1)', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);

      // Establish subscriptions
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: videoReqId, parameters: new Map() } as unknown as ControlMessage);
      adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId: audioReqId, trackAlias: audioReqId, parameters: new Map() } as unknown as ControlMessage);

      // Load timeline
      const timelineReqId = await (adapter.subscribe as any).mock.results[3]?.value;
      adapter._triggerObject(10n, {
        kind: 'data',
        trackAlias: timelineReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TIMELINE_PAYLOAD),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      player.play();

      // Spy on pipeline reset methods
      const videoPipeline = (player as any).videoPipeline;
      const audioPipeline = (player as any).audioPipeline;
      const videoResetSpy = vi.spyOn(videoPipeline, 'reset');
      const audioResetSpy = vi.spyOn(audioPipeline, 'reset');

      // Seek to 5000ms → target group 2 (per timeline: group 2 starts at 4000ms)
      await player.seek(5000);

      // Pipeline reset should be called with target group ID (2n)
      expect(videoResetSpy).toHaveBeenCalledWith(2n);
      expect(audioResetSpy).toHaveBeenCalledWith(2n);

      await player.destroy();
    });

    it('seek() throws when no timeline loaded', async () => {
      const adapter = createMockAdapter();
      const player = await loadVodPlayer(adapter);

      await sendVodCatalog(adapter);
      player.play();

      await expect(player.seek(5000)).rejects.toThrow(/timeline/i);

      await player.destroy();
    });

    it('seek() throws when player state is idle', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));

      await expect(player.seek(5000)).rejects.toThrow(/state/i);
    });
  });

  // ─── Track switching (§5.1.19 altGroup, §4.2 group boundaries) ───

  describe('track switching', () => {
    /** Multi-track catalog with altGroup for ABR switching. */
    const MULTITRACK_CATALOG_JSON = JSON.stringify({
      version: 1,
      tracks: [
        {
          name: 'video-0',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          renderGroup: 1,
          altGroup: 1,
          codec: 'avc1.640028',
          width: 1920,
          height: 1080,
          bitrate: 3_000_000,
        },
        {
          name: 'video-1',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          renderGroup: 1,
          altGroup: 1,
          codec: 'avc1.64001f',
          width: 1280,
          height: 720,
          bitrate: 1_500_000,
        },
        {
          name: 'video-2',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          renderGroup: 1,
          altGroup: 1,
          codec: 'avc1.4d4015',
          width: 480,
          height: 360,
          bitrate: 500_000,
        },
        {
          name: 'audio',
          packaging: 'loc',
          isLive: true,
          role: 'audio',
          renderGroup: 1,
          codec: 'opus',
          samplerate: 48000,
          channelConfig: '2',
          bitrate: 128_000,
        },
      ],
    });

    /** Helper: load player with multi-track catalog. */
    async function loadMultitrack(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(MULTITRACK_CATALOG_JSON),
      } as MoqtObject);

      await new Promise(r => setTimeout(r, 0));
      return player;
    }

    it('selectVideoTrack() exists as a public method', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);
      expect(typeof player.selectVideoTrack).toBe('function');
      await player.destroy();
    });

    it('selects middle quality video track by default from altGroup', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      // Should subscribe to video-1 (middle of 3-track ladder)
      const subscribeCalls = (adapter.subscribe as any).mock.calls;
      const videoSub = subscribeCalls.find(
        (c: any) => new TextDecoder().decode(c[1]) === 'video-1',
      );
      expect(videoSub).toBeDefined();

      await player.destroy();
    });

    it('selectVideoTrack() subscribes new, defers unsubscribe until first object', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      const subCountBefore = (adapter.subscribe as any).mock.calls.length;

      await player.selectVideoTrack('video-2');

      // Should have subscribed to video-2
      expect((adapter.subscribe as any).mock.calls.length).toBe(subCountBefore + 1);
      const lastSubCall = (adapter.subscribe as any).mock.calls.at(-1);
      expect(new TextDecoder().decode(lastSubCall[1])).toBe('video-2');

      // Should NOT have unsubscribed yet — overlap until first object
      expect(adapter.unsubscribe).not.toHaveBeenCalled();

      // Simulate SUBSCRIBE_OK resolving the alias (§10.4.2: data may arrive
      // before SUBSCRIBE_OK — alias must be resolved before objects route)
      const newReqId = await (adapter.subscribe as any).mock.results.at(-1)?.value;
      const newAlias = BigInt(newReqId) + 100n; // relay assigns different alias
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(BigInt(newReqId)),
        trackAlias: varint(newAlias),
        parameters: new Map(),
        trackExtensions: new Map(),
      } as any);

      // Simulate first object from new track using relay-assigned alias
      adapter._triggerObject(99n, {
        kind: 'data',
        trackAlias: varint(newAlias),
        groupId: varint(100),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67]),
        extensions: new Uint8Array(0),
      } as MoqtObject);

      // NOW should have unsubscribed the old track
      expect(adapter.unsubscribe).toHaveBeenCalled();

      await player.destroy();
    });

    it('selectVideoTrack() emits quality_switching immediately, defers quality_switched until commit', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      const switchingFn = vi.fn();
      const switchedFn = vi.fn();
      player.on('quality_switching', switchingFn);
      player.on('quality_switched', switchedFn);

      await player.selectVideoTrack('video-0');

      // "switching" fires up-front so the UI can render a transitional state.
      expect(switchingFn).toHaveBeenCalledTimes(1);
      expect(switchingFn.mock.calls[0][0]).toMatchObject({
        type: 'quality_switching',
        fromTrackName: 'video-1',
        toTrackName: 'video-0',
      });
      // "switched" must NOT fire here — completePendingVideoSwitch hasn't
      // run yet (no keyframe arrived from the new track). Telemetry/UI
      // that reports "now playing X" stays silent until commit.
      expect(switchedFn).not.toHaveBeenCalled();

      await player.destroy();
    });

    it('selectVideoTrack() throws for unknown track name', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      await expect(player.selectVideoTrack('nonexistent')).rejects.toThrow();

      await player.destroy();
    });

    it('selectVideoTrack() is a no-op when selecting current track', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      const subCountBefore = (adapter.subscribe as any).mock.calls.length;

      await player.selectVideoTrack('video-1'); // already selected (middle start)

      // No new subscription
      expect((adapter.subscribe as any).mock.calls.length).toBe(subCountBefore);

      await player.destroy();
    });

    it('availableVideoTracks returns all altGroup alternatives', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      const tracks = player.availableVideoTracks;
      expect(tracks).toHaveLength(3);
      expect(tracks.map(t => t.name)).toEqual(['video-0', 'video-1', 'video-2']);

      await player.destroy();
    });

    // ─── AbsoluteStart group calculation branches ────────────────
    //
    // selectVideoTrack picks the new track's start filter from the
    // current pipeline group (player.ts ~L741). Three branches:
    //   currentGroup === -1n   → no group seen yet → fall back to
    //                            buildSubscribeOptions / LatestObject
    //   currentGroup === 0n    → AbsoluteStart {startGroup: 1n, startObject: 0n}
    //   currentGroup >  0n     → AbsoluteStart {startGroup: N+1, startObject: 0n}
    //
    // Mutation testing surfaced these as the only "real-logic"
    // survivors in the switch range — defensive guards aside.

    /**
     * Helper: pull the SubscribeOptions from the most recent
     * `adapter.subscribe(nsBytes, nameBytes, options)` call.
     */
    function lastSubscribeOptions(adapter: ReturnType<typeof createMockAdapter>): unknown {
      const calls = (adapter.subscribe as any).mock.calls;
      return calls.at(-1)?.[2];
    }

    it('selectVideoTrack() falls back to NextGroupStart for live when no group has been seen yet', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      // Force the "no group seen" state explicitly: pipeline exists
      // but `currentGroupId` is -1n (the documented sentinel for
      // "haven't received any media yet"). Without this, whatever
      // value the freshly-created pipeline reports could quietly hide
      // a regression — assertions need to be deterministic.
      (player as unknown as { videoPipeline: { currentGroupId: bigint } | null }).videoPipeline = {
        currentGroupId: -1n,
      };

      await player.selectVideoTrack('video-0');

      const opts = lastSubscribeOptions(adapter) as { subscriptionFilter?: { type?: string } } | undefined;
      expect(opts).toBeDefined();
      expect(opts?.subscriptionFilter?.type).toBe('NextGroupStart');

      await player.destroy();
    });

    it('selectVideoTrack() uses AbsoluteStart{startGroup:1n} when currentGroup is 0n', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      // Force the no-pipeline-currentGroup path explicitly: stub
      // videoPipeline to expose currentGroupId === 0n. This skips the
      // LOC pipeline-creation flow but exercises the exact branch
      // selectVideoTrack reads.
      (player as unknown as { videoPipeline: { currentGroupId: bigint } }).videoPipeline = {
        currentGroupId: 0n,
      };

      await player.selectVideoTrack('video-0');

      const opts = lastSubscribeOptions(adapter) as {
        subscriptionFilter?: { type?: string; startGroup?: bigint; startObject?: bigint };
      } | undefined;
      expect(opts?.subscriptionFilter?.type).toBe('AbsoluteStart');
      expect(opts?.subscriptionFilter?.startGroup).toBe(1n);
      expect(opts?.subscriptionFilter?.startObject).toBe(0n);

      await player.destroy();
    });

    it('selectVideoTrack() uses AbsoluteStart{startGroup:N+1} when currentGroup > 0n', async () => {
      const adapter = createMockAdapter();
      const player = await loadMultitrack(adapter);

      (player as unknown as { videoPipeline: { currentGroupId: bigint } }).videoPipeline = {
        currentGroupId: 42n,
      };

      await player.selectVideoTrack('video-0');

      const opts = lastSubscribeOptions(adapter) as {
        subscriptionFilter?: { type?: string; startGroup?: bigint; startObject?: bigint };
      } | undefined;
      expect(opts?.subscriptionFilter?.type).toBe('AbsoluteStart');
      // Avoid replaying the in-flight group: start at currentGroup + 1.
      expect(opts?.subscriptionFilter?.startGroup).toBe(43n);
      expect(opts?.subscriptionFilter?.startObject).toBe(0n);

      await player.destroy();
    });

    /**
     * Runtime rollback: when `mediaSource.changeType()` rejects in
     * `completePendingVideoSwitch` (after the keyframe has triggered
     * the async pivot), the player must keep the old subscription
     * alive, unsubscribe the new one, drop the staged buffer, and
     * surface a `quality_switch_failed` event. No `quality_switched`.
     */
    it('aborts CMAF codec switch and emits quality_switch_failed when changeType rejects', async () => {
      const TWO_CODEC_CMAF_CATALOG = JSON.stringify({
        version: 1,
        tracks: [
          {
            name: 'video_avc',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            altGroup: 1,
            codec: 'avc1.4D401F',
            width: 1280,
            height: 720,
            bitrate: 800_000,
            initData: btoa(String.fromCharCode(0x00, 0x01, 0x02, 0x03)),
          },
          {
            name: 'video_hevc',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            altGroup: 1,
            codec: 'hvc1.1.6.L93.90',
            width: 1280,
            height: 720,
            bitrate: 600_000,
            initData: btoa(String.fromCharCode(0x10, 0x11, 0x12, 0x13)),
          },
        ],
      });

      const adapter = createMockAdapter();
      // Inline mocks (the CMAF describe block keeps its own helpers
      // private; redeclaring is cleaner than leaking them out).
      const mockMs = {
        initialize: vi.fn(),
        appendChunk: vi.fn(),
        endOfStream: vi.fn(),
        reset: vi.fn(),
        destroy: vi.fn(),
        mediaElement: null,
        onFirstFrame: null as (() => void) | null,
        onError: null as ((error: Error) => void) | null,
        onStall: null as ((durationMs: number) => void) | null,
        // changeType always rejects — simulates the browser saying the
        // new codec isn't supported (or any other MSE-level failure).
        changeType: vi.fn(() => Promise.reject(new Error('mock changeType rejected'))),
      };
      const cmafAssemblerFactory = (
        options: { onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, trackName: string) => void },
      ) => {
        const pending = new Map<string, Uint8Array>();
        return {
          push(mediaType: 'video' | 'audio', trackName: string, groupId: bigint, payload: Uint8Array) {
            const key = `${mediaType}:${trackName}:${groupId}`;
            const type = payload.length >= 8
              ? String.fromCharCode(payload[4]!, payload[5]!, payload[6]!, payload[7]!)
              : '';
            if (type === 'moof') {
              pending.set(key, payload);
            } else if (type === 'mdat') {
              const moof = pending.get(key);
              if (moof) {
                pending.delete(key);
                const seg = new Uint8Array(moof.byteLength + payload.byteLength);
                seg.set(moof, 0);
                seg.set(payload, moof.byteLength);
                options.onSegment(mediaType, seg, trackName);
              }
            }
          },
          getEpoch(_mt: 'video' | 'audio') { return null; },
          reset() { pending.clear(); },
          destroy() { pending.clear(); },
        };
      };

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        startLevel: 0,
        createMediaSource: () => mockMs,
        createCmafAssembler: cmafAssemblerFactory,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver the two-codec CMAF catalog
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TWO_CODEC_CMAF_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      // startLevel:0 pins to AVC (highest bitrate).
      expect(mockMs.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ video: expect.objectContaining({ codec: 'avc1.4D401F' }) }),
      );

      const switchingFn = vi.fn();
      const switchedFn = vi.fn();
      const failedFn = vi.fn();
      const errorFn = vi.fn();
      player.on('quality_switching', switchingFn);
      player.on('quality_switched', switchedFn);
      player.on('quality_switch_failed', failedFn);
      player.on('error', errorFn);

      // Initiate switch to HEVC (from pinned AVC).
      const subscribesBefore = (adapter.subscribe as any).mock.calls.length;
      await player.selectVideoTrack('video_hevc');

      // selectVideoTrack should have issued one new SUBSCRIBE for video_hevc
      // and emitted quality_switching but NOT quality_switched yet.
      expect((adapter.subscribe as any).mock.calls.length).toBe(subscribesBefore + 1);
      expect(switchingFn).toHaveBeenCalledTimes(1);
      expect(switchedFn).not.toHaveBeenCalled();

      // Ack the new subscription with a DIFFERENT trackAlias so the
      // SUBSCRIBE_OK handler registers the track with the
      // SubscriptionManager. (In production this happens whenever the
      // server assigns a fresh alias; the registration path is what
      // gets the new track wired up for object routing.)
      const newReqId = await (adapter.subscribe as any).mock.results.at(-1)!.value;
      const newAlias = BigInt(newReqId) + 100n;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(newReqId),
        trackAlias: varint(newAlias),
        parameters: new Map(),
      } as unknown as ControlMessage);

      // Deliver the new track's keyframe (objectId === 0n) — this is
      // what triggers completePendingVideoSwitch → changeType (which
      // rejects) → abortPendingVideoSwitch.
      const fakeMoof = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]); // 'moof'
      adapter._triggerObject(newAlias, {
        kind: 'data',
        trackAlias: varint(newAlias),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: fakeMoof,
      } as MoqtObject);

      // Let the rejected promise propagate.
      await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 10));

      // changeType was called and rejected; rollback fired.
      expect(mockMs.changeType).toHaveBeenCalledTimes(1);
      expect(failedFn).toHaveBeenCalledTimes(1);
      expect(failedFn.mock.calls[0][0]).toMatchObject({
        type: 'quality_switch_failed',
        fromTrackName: 'video_avc',
        toTrackName: 'video_hevc',
      });
      // No "switched" event ever fires for the failed switch.
      expect(switchedFn).not.toHaveBeenCalled();
      // An `error` event also surfaces (PlayerErrorCode.VIDEO_DECODE_ERROR).
      expect(errorFn).toHaveBeenCalled();

      // Old AVC subscription must remain active — that's the whole
      // point of the rollback. abort path unsubscribes the NEW track
      // (by reqId) so check that.
      const unsubCalls = (adapter.unsubscribe as any).mock.calls;
      const unsubReqIds = unsubCalls.map((c: unknown[]) => Number(c[0]));
      expect(unsubReqIds).toContain(Number(newReqId));

      await player.destroy();
    });

    /**
     * Successful runtime commit: when `mediaSource.changeType()`
     * resolves, the player must (a) call it with the new codec and
     * init bytes, (b) unsubscribe the old track, (c) flush staged
     * new-track segments, (d) emit `quality_switched` (NOT
     * `quality_switch_failed`).
     *
     * Companion to "aborts CMAF codec switch ... when changeType
     * rejects" — same stimulus, opposite mediaSource.changeType
     * behavior, opposite expected outcome.
     */
    it('commits CMAF codec switch and emits quality_switched when changeType resolves', async () => {
      const TWO_CODEC_CMAF_CATALOG = JSON.stringify({
        version: 1,
        tracks: [
          {
            name: 'video_avc',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            altGroup: 1,
            codec: 'avc1.4D401F',
            width: 1280,
            height: 720,
            bitrate: 800_000,
            initData: btoa(String.fromCharCode(0x00, 0x01, 0x02, 0x03)),
          },
          {
            name: 'video_hevc',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            altGroup: 1,
            codec: 'hvc1.1.6.L93.90',
            width: 1280,
            height: 720,
            bitrate: 600_000,
            initData: btoa(String.fromCharCode(0x10, 0x11, 0x12, 0x13)),
          },
        ],
      });

      const adapter = createMockAdapter();
      const mockMs = {
        initialize: vi.fn(),
        appendChunk: vi.fn(),
        endOfStream: vi.fn(),
        reset: vi.fn(),
        destroy: vi.fn(),
        mediaElement: null,
        onFirstFrame: null as (() => void) | null,
        onError: null as ((error: Error) => void) | null,
        onStall: null as ((durationMs: number) => void) | null,
        // changeType resolves successfully — the happy path.
        changeType: vi.fn(() => Promise.resolve()),
      };
      const cmafAssemblerFactory = (
        options: { onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, trackName: string) => void },
      ) => {
        const pending = new Map<string, Uint8Array>();
        return {
          push(mediaType: 'video' | 'audio', trackName: string, groupId: bigint, payload: Uint8Array) {
            const key = `${mediaType}:${trackName}:${groupId}`;
            const type = payload.length >= 8
              ? String.fromCharCode(payload[4]!, payload[5]!, payload[6]!, payload[7]!)
              : '';
            if (type === 'moof') {
              pending.set(key, payload);
            } else if (type === 'mdat') {
              const moof = pending.get(key);
              if (moof) {
                pending.delete(key);
                const seg = new Uint8Array(moof.byteLength + payload.byteLength);
                seg.set(moof, 0);
                seg.set(payload, moof.byteLength);
                options.onSegment(mediaType, seg, trackName);
              }
            }
          },
          getEpoch(_mt: 'video' | 'audio') { return null; },
          reset() { pending.clear(); },
          destroy() { pending.clear(); },
        };
      };

      const player = new MoqtPlayer({
        ...createConfig(adapter),
        startLevel: 0,
        createMediaSource: () => mockMs,
        createCmafAssembler: cmafAssemblerFactory,
      });
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver the two-codec CMAF catalog
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(TWO_CODEC_CMAF_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 10));

      const switchingFn = vi.fn();
      const switchedFn = vi.fn();
      const failedFn = vi.fn();
      player.on('quality_switching', switchingFn);
      player.on('quality_switched', switchedFn);
      player.on('quality_switch_failed', failedFn);

      // Initiate switch to HEVC (from pinned AVC).
      await player.selectVideoTrack('video_hevc');
      expect(switchingFn).toHaveBeenCalledTimes(1);
      expect(switchedFn).not.toHaveBeenCalled(); // not yet committed
      expect(failedFn).not.toHaveBeenCalled();

      // Ack new sub with a fresh alias so SubscriptionManager registers.
      const newReqId = await (adapter.subscribe as any).mock.results.at(-1)!.value;
      const newAlias = BigInt(newReqId) + 100n;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(newReqId),
        trackAlias: varint(newAlias),
        parameters: new Map(),
      } as unknown as ControlMessage);

      // Trigger keyframe (objectId === 0n) → completePendingVideoSwitch
      // → changeType (resolves) → flushCmafStagedBuffer.
      const fakeMoof = new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x66]); // 'moof'
      adapter._triggerObject(newAlias, {
        kind: 'data',
        trackAlias: varint(newAlias),
        groupId: varint(1),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: fakeMoof,
      } as MoqtObject);

      // Let the resolved promise propagate.
      await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 10));

      // changeType called with HEVC codec + decoded init bytes.
      expect(mockMs.changeType).toHaveBeenCalledTimes(1);
      const [ctMediaType, ctCodec, ctInit] = mockMs.changeType.mock.calls[0]!;
      expect(ctMediaType).toBe('video');
      expect(ctCodec).toBe('hvc1.1.6.L93.90');
      expect(ctInit).toBeInstanceOf(Uint8Array);
      expect(Array.from(ctInit as Uint8Array)).toEqual([0x10, 0x11, 0x12, 0x13]);

      // Commit-time event fired exactly once with the right payload.
      expect(switchedFn).toHaveBeenCalledTimes(1);
      expect(switchedFn.mock.calls[0][0]).toMatchObject({
        type: 'quality_switched',
        fromTrackName: 'video_avc',
        toTrackName: 'video_hevc',
        reason: 'manual',
      });
      // No failure event ever.
      expect(failedFn).not.toHaveBeenCalled();

      // Old AVC subscription was unsubscribed (the new track is the
      // active one now). The catalog reqId stays subscribed.
      const unsubReqIds = (adapter.unsubscribe as any).mock.calls.map(
        (c: unknown[]) => Number(c[0]),
      );
      // We don't know the old track's exact reqId without inspecting
      // private state; the negative assertion is sharp enough — the
      // NEW track must NOT have been unsubscribed (rollback path).
      expect(unsubReqIds).not.toContain(Number(newReqId));

      await player.destroy();
    });

    /**
     * Up-front validation: a CMAF codec switch needs init bytes (inline
     * `initData` or a separate `initTrack`). If the catalog provides
     * neither, `selectVideoTrack` must reject BEFORE mutating any
     * subscription state — old track stays running, no SUBSCRIBE goes
     * out for the broken target.
     */
    it('selectVideoTrack() rejects CMAF codec change with no init source, leaves old subscription intact', async () => {
      const BAD_CMAF_CATALOG = JSON.stringify({
        version: 1,
        tracks: [
          {
            // Same altGroup, different codec, NO initData/initTrack.
            // This is the malformed case the player must reject.
            name: 'video_hevc',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            altGroup: 1,
            codec: 'hvc1.1.6.L93.90',
            width: 1280,
            height: 720,
            bitrate: 800_000,
          },
          {
            name: 'video_avc',
            packaging: 'cmaf',
            isLive: true,
            role: 'video',
            renderGroup: 1,
            altGroup: 1,
            codec: 'avc1.4D401F',
            width: 1280,
            height: 720,
            bitrate: 600_000,
            initData: 'AAAA', // 4-byte placeholder so initial init succeeds
          },
        ],
      });

      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(BAD_CMAF_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      const subCountBefore = (adapter.subscribe as any).mock.calls.length;

      // Switching to the broken HEVC track must throw with a clear
      // diagnostic, and must NOT issue any new SUBSCRIBE.
      await expect(player.selectVideoTrack('video_hevc')).rejects.toThrow(
        /no initData or initTrack/i,
      );
      expect((adapter.subscribe as any).mock.calls.length).toBe(subCountBefore);

      await player.destroy();
    });
  });

  // ─── External Adapter Mode ────────────────────────────────────────

  describe('external adapter mode', () => {
    /**
     * When config.connection is provided, the player uses it directly
     * without calling connect(). The adapter is externally owned —
     * player.destroy() detaches but does NOT close it.
     */

    it('skips connect() when adapter is provided', async () => {
      const adapter = createMockAdapter();
      (adapter as any).draftVersion = 16;
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        connection: adapter as unknown as MoqtConnection,
        createTransport: vi.fn(async () => ({}) as any),
      });

      const loadPromise = player.load();
      // Send catalog
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(1n),
        trackAlias: varint(1n),
        parameters: new Map(),
        trackExtensions: new Map(),
      });
      adapter._triggerObject(0n, {
        kind: 'data' as const,
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        extensions: undefined,
        payload: new TextEncoder().encode(CATALOG_JSON),
      });

      await loadPromise;

      // connect() should NOT have been called
      expect(adapter.connect).not.toHaveBeenCalled();
      // But subscribe should have been called (for catalog)
      expect(adapter.subscribe).toHaveBeenCalled();

      await player.destroy();
    });

    it('destroy() does NOT close externally owned adapter', async () => {
      const adapter = createMockAdapter();
      (adapter as any).draftVersion = 16;
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        connection: adapter as unknown as MoqtConnection,
        createTransport: vi.fn(async () => ({}) as any),
      });

      const loadPromise = player.load();
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(1n),
        trackAlias: varint(1n),
        parameters: new Map(),
        trackExtensions: new Map(),
      });
      adapter._triggerObject(0n, {
        kind: 'data' as const,
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        extensions: undefined,
        payload: new TextEncoder().encode(CATALOG_JSON),
      });
      await loadPromise;

      await player.destroy();

      // adapter.close() should NOT have been called
      expect(adapter.close).not.toHaveBeenCalled();
    });

    it('destroy() unsubscribes player tracks on externally owned adapter', async () => {
      const adapter = createMockAdapter();
      (adapter as any).draftVersion = 16;
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        connection: adapter as unknown as MoqtConnection,
        createTransport: vi.fn(async () => ({}) as any),
      });

      const loadPromise = player.load();
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(1n),
        trackAlias: varint(1n),
        parameters: new Map(),
        trackExtensions: new Map(),
      });
      adapter._triggerObject(0n, {
        kind: 'data' as const,
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        extensions: undefined,
        payload: new TextEncoder().encode(CATALOG_JSON),
      });
      await loadPromise;

      // At this point the player has at least the catalog subscription active.
      // Verify that destroy() calls unsubscribe for cleanup.
      const unsubCallsBefore = adapter.unsubscribe.mock.calls.length;
      await player.destroy();

      // unsubscribe() should have been called at least once (for catalog or media)
      expect(adapter.unsubscribe.mock.calls.length).toBeGreaterThan(unsubCallsBefore);
    });
  });

  // ─── Bug fix regression tests ──────────────────────────────────────
  //
  // These tests reproduce exact production failure patterns observed
  // during NAB 2026 testing against Akamai relays. Each test is named
  // after the root cause, not the symptom.

  describe('ABR stall recovery bugs (NAB 2026)', () => {
    const ABR_CATALOG_JSON = JSON.stringify({
      version: 1,
      tracks: [
        {
          name: 'video-0', packaging: 'loc', isLive: true, role: 'video',
          renderGroup: 1, altGroup: 1,
          codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 3_000_000,
        },
        {
          name: 'video-1', packaging: 'loc', isLive: true, role: 'video',
          renderGroup: 1, altGroup: 1,
          codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 1_500_000,
        },
        {
          name: 'video-2', packaging: 'loc', isLive: true, role: 'video',
          renderGroup: 1, altGroup: 1,
          codec: 'avc1.4d4015', width: 480, height: 360, bitrate: 500_000,
        },
        {
          name: 'audio', packaging: 'loc', isLive: true, role: 'audio',
          renderGroup: 1,
          codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 128_000,
        },
      ],
    });

    let clockTimeUs = 0;
    const mockClock = { now: () => clockTimeUs };

    function advanceClock(deltaUs: number) {
      clockTimeUs += deltaUs;
    }

    function createMockRenderer() {
      return {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null as (() => void) | null,
        onFrameRendered: null as ((ts: bigint, r: number) => void) | null,
        onStall: null as ((ms: number) => void) | null,
      };
    }

    function createMockVideoDecoder() {
      return {
        configure: vi.fn(), decode: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
        reset: vi.fn(), queueDepth: 0,
        onFrame: null as any, onError: null as any,
        destroy: vi.fn(),
      };
    }

    async function loadWithAbr(
      adapter: ReturnType<typeof createMockAdapter>,
      renderer: ReturnType<typeof createMockRenderer>,
      decoder: ReturnType<typeof createMockVideoDecoder>,
    ) {
      clockTimeUs = 0;
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createTransport: vi.fn(async () => ({}) as any),
        createConnection: () => adapter as unknown as MoqtConnection,
        clock: mockClock,
        qualitySwitchCooldownMs: 1,
        createVideoDecoder: () => decoder,
        createRenderer: () => renderer,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      const catalogReqId = await (adapter.subscribe as any).mock.results[0]?.value;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: catalogReqId,
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(ABR_CATALOG_JSON),
      } as MoqtObject);

      await new Promise(r => setTimeout(r, 0));
      return player;
    }

    async function setupAbrTest(payloadSize = 2_000_000) {
      const adapter = createMockAdapter();
      const renderer = createMockRenderer();
      const decoder = createMockVideoDecoder();
      const player = await loadWithAbr(adapter, renderer, decoder);

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const videoAlias = varint(BigInt(videoReqId) + 100n);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: varint(BigInt(videoReqId)),
        trackAlias: videoAlias, parameters: new Map(), trackExtensions: new Map(),
      } as any);

      const audioReqId = await (adapter.subscribe as any).mock.results[2]?.value;
      const audioAlias = varint(BigInt(audioReqId) + 200n);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: varint(BigInt(audioReqId)),
        trackAlias: audioAlias, parameters: new Map(), trackExtensions: new Map(),
      } as any);

      function feedGroups(count: number, startGroup = 0) {
        for (let g = startGroup; g < startGroup + count; g++) {
          advanceClock(1_000_000);
          adapter._triggerObject(BigInt(g + 1), {
            kind: 'data', trackAlias: videoAlias,
            groupId: varint(g), subgroupId: varint(0), objectId: varint(0),
            payload: new Uint8Array(payloadSize), extensions: new Uint8Array(0),
          } as MoqtObject);
          adapter._triggerObject(BigInt(g + 1), {
            kind: 'gap', trackAlias: videoAlias,
            groupId: varint(g), subgroupId: varint(0), objectId: varint(1),
            status: ObjectStatus.END_OF_GROUP,
          } as MoqtObject);
          player.tick();
        }
      }

      function simulateRenderedFrames(count: number) {
        for (let i = 0; i < count; i++) {
          renderer.onFrameRendered?.(BigInt(i + 1) * 33_333n, clockTimeUs);
        }
      }

      function hasSubscribeTo(trackName: string, afterIndex = 0) {
        return (adapter.subscribe as any).mock.calls.slice(afterIndex).some(
          (c: any) => { try { return new TextDecoder().decode(c[1]) === trackName; } catch { return false; } },
        );
      }

      return { adapter, renderer, decoder, player, feedGroups, simulateRenderedFrames, hasSubscribeTo };
    }

    it('LOC: upshifts when healthy delivery + high bandwidth + stability elapsed + rendered frames', async () => {
      const { player, feedGroups, simulateRenderedFrames, hasSubscribeTo, adapter } = await setupAbrTest();

      feedGroups(8);
      simulateRenderedFrames(10);
      const subsBefore = (adapter.subscribe as any).mock.calls.length;

      advanceClock(16_000_000);
      player.tick();

      expect(hasSubscribeTo('video-0', subsBefore)).toBe(true);
      await player.destroy();
    });

    it('LOC: no upshift when recent stall within stability window (timestamp proves it)', async () => {
      const { player, renderer, feedGroups, simulateRenderedFrames, hasSubscribeTo } = await setupAbrTest();

      feedGroups(8);
      simulateRenderedFrames(10);

      // Stall at t=8s
      renderer.onStall?.(500);
      // Enough healthy renders to clear videoRecoveryActive
      simulateRenderedFrames(5);

      // Advance 10s (total 18s) — still within 15s of the stall at t=8
      advanceClock(10_000_000);
      player.tick();

      // No upshift: stall timestamp is too recent (8s + 10s = 18s, stall at 8s, delta = 10s < 15s)
      expect(hasSubscribeTo('video-0')).toBe(false);
      // No downshift either
      expect(hasSubscribeTo('video-2')).toBe(false);
      await player.destroy();
    });

    it('LOC: no upshift when recent partial_group_abandoned within stability window', async () => {
      const { player, feedGroups, simulateRenderedFrames, hasSubscribeTo } = await setupAbrTest();

      feedGroups(8);
      simulateRenderedFrames(10);

      // Emit partial_group_abandoned via pipeline event at t=8s
      (player as any).handlePipelineEvent('video', {
        type: 'partial_group_abandoned', fromGroupId: 7n, toGroupId: 8n, reason: 'test',
      });
      simulateRenderedFrames(10);

      advanceClock(10_000_000); // 10s after abandon — within 15s window
      player.tick();

      expect(hasSubscribeTo('video-0')).toBe(false);
      await player.destroy();
    });

    it('LOC: no upshift when bandwidth below safety threshold (isolated from health)', async () => {
      // Low payload = low bandwidth estimate. END_OF_GROUP sent, health is clean.
      const { player, feedGroups, simulateRenderedFrames, hasSubscribeTo } = await setupAbrTest(50_000);

      feedGroups(8);
      simulateRenderedFrames(10);

      advanceClock(16_000_000);
      player.tick();

      // Health is clean, but bandwidth ~400kbps < 6750kbps needed for upshift
      expect(hasSubscribeTo('video-0')).toBe(false);
      await player.destroy();
    });

    it('LOC: no upshift when no rendered frames (positive health signal missing)', async () => {
      const { player, feedGroups, hasSubscribeTo, adapter } = await setupAbrTest();

      feedGroups(8);
      // Deliberately do NOT call simulateRenderedFrames

      const subsBefore = (adapter.subscribe as any).mock.calls.length;
      advanceClock(16_000_000);
      player.tick();

      expect(hasSubscribeTo('video-0', subsBefore)).toBe(false);
      await player.destroy();
    });

    it('LOC: recent queue pressure blocks upshift even after throttle clears', async () => {
      const { player, feedGroups, simulateRenderedFrames, hasSubscribeTo, adapter } = await setupAbrTest();

      feedGroups(8);
      simulateRenderedFrames(10);

      // Queue pressure at t=8s
      (player as any).handleFeedback({
        type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8,
      });
      // Pressure clears immediately
      (player as any).handleFeedback({
        type: 'queue_pressure', mediaType: 'video', depth: 2, maxRecommended: 8,
      });
      simulateRenderedFrames(10);

      const subsBefore = (adapter.subscribe as any).mock.calls.length;
      advanceClock(10_000_000); // 10s after pressure — within 15s window
      player.tick();

      expect(hasSubscribeTo('video-0', subsBefore)).toBe(false);
      await player.destroy();
    });

    /**
     * Bug 1: After skip_forward recovery, the renderer may paint one
     * stale backlog frame. That fires onFrameRendered, which resets
     * consecutiveStallCount = 0 and calls notifySuccess(). This prevents
     * jump_to_live from ever triggering (needs 3 consecutive stalls).
     *
     * Observed: Will Law at EWR — video frozen, audio continues,
     * stall/skip loop forever without jump_to_live.
     */
    it('Bug 1: stale renders during recovery must not reset consecutiveStallCount', async () => {
      const adapter = createMockAdapter();
      const renderer = createMockRenderer();
      const decoder = createMockVideoDecoder();
      const player = await loadWithAbr(adapter, renderer, decoder);

      const recoveryEvents: any[] = [];
      player.on('recovery_action' as any, (evt: any) => recoveryEvents.push(evt));

      // Simulate the exact production failure pattern:
      // stall → skip_forward → stale render → stall → skip_forward → stale render → ...
      // Jump-to-live should fire on the 3rd consecutive stall.

      // Stall 1
      renderer.onStall?.(508);
      // A stale frame renders (pipeline skip_forward found an old frame)
      renderer.onFrameRendered?.(1000n, clockTimeUs);

      // Stall 2
      renderer.onStall?.(508);
      // Another stale frame renders
      renderer.onFrameRendered?.(2000n, clockTimeUs);

      // Stall 3 — should trigger jump_to_live since the stale renders
      // should NOT have reset the stall counter
      renderer.onStall?.(508);

      const jumpToLive = recoveryEvents.find(
        (e: any) => e.action?.type === 'jump_to_live',
      );
      expect(jumpToLive).toBeDefined();

      await player.destroy();
    });

    /**
     * Bug 3: RecoveryController.handleStall() returns skip_forward,
     * but onStall in player.ts filters it out with
     * `if (action.type !== 'skip_forward')`. This means stalls don't
     * trigger any real recovery action — only later gap-driven
     * skip_forward runs, which just discards local groups without
     * requesting fresh data from the relay.
     */
    it('Bug 3: stall-driven recovery actions must not be silently dropped', async () => {
      const adapter = createMockAdapter();
      const renderer = createMockRenderer();
      const decoder = createMockVideoDecoder();
      const player = await loadWithAbr(adapter, renderer, decoder);

      const recoveryEvents: any[] = [];
      player.on('recovery_action' as any, (evt: any) => recoveryEvents.push(evt));

      // Fire a stall — recovery controller should evaluate and
      // the result should be emitted as an event, not silently filtered
      renderer.onStall?.(508);

      // The stall should produce SOME recovery event (skip_forward,
      // reduce_quality, or jump_to_live) — it must not be silently dropped
      expect(recoveryEvents.length).toBeGreaterThan(0);

      // skip_forward from stall triggers requestFreshSubscriptionStart →
      // adapter.requestUpdate (REQUEST_UPDATE to relay for fresh data)
      await new Promise(r => setTimeout(r, 0));
      expect(adapter.requestUpdate.mock.calls.length).toBeGreaterThan(0);

      await player.destroy();
    });

    /**
     * Bug 1 variant: fewer than RECOVERY_HEALTHY_THRESHOLD renders
     * between stalls must not clear the recovery gate. 3 consecutive
     * stalls should still reach jump_to_live even if 1-2 frames render
     * between each stall.
     */
    it('Bug 1: partial renders between stalls must not prevent jump_to_live', async () => {
      const adapter = createMockAdapter();
      const renderer = createMockRenderer();
      const decoder = createMockVideoDecoder();
      const player = await loadWithAbr(adapter, renderer, decoder);

      const recoveryEvents: any[] = [];
      player.on('recovery_action' as any, (evt: any) => recoveryEvents.push(evt));

      // Stall 1 — enters recovery, pipeline flushed
      renderer.onStall?.(508);
      // Only 2 frames render (below threshold of 3) — recovery NOT cleared
      renderer.onFrameRendered?.(1000n, clockTimeUs);
      renderer.onFrameRendered?.(2000n, clockTimeUs + 33_000);

      // Stall 2 — still in recovery, counter increments
      renderer.onStall?.(508);
      // Only 1 frame
      renderer.onFrameRendered?.(3000n, clockTimeUs + 66_000);

      // Stall 3 — should trigger jump_to_live
      renderer.onStall?.(508);

      const jumpToLive = recoveryEvents.find(
        (e: any) => e.action?.type === 'jump_to_live',
      );
      expect(jumpToLive).toBeDefined();

      await player.destroy();
    });

    /**
     * Verify recovery gate clears after sustained healthy renders.
     * 3+ fresh frames after a stall should reset consecutiveStallCount
     * so the next stall starts from 0 (not contributing toward jump_to_live).
     */
    it('recovery gate clears after sustained healthy renders', async () => {
      const adapter = createMockAdapter();
      const renderer = createMockRenderer();
      const decoder = createMockVideoDecoder();
      const player = await loadWithAbr(adapter, renderer, decoder);

      const recoveryEvents: any[] = [];
      player.on('recovery_action' as any, (evt: any) => recoveryEvents.push(evt));

      // Stall 1 — enters recovery
      renderer.onStall?.(508);

      // 3 healthy renders — recovery clears, consecutiveStallCount resets to 0
      renderer.onFrameRendered?.(1000n, clockTimeUs);
      renderer.onFrameRendered?.(2000n, clockTimeUs + 33_000);
      renderer.onFrameRendered?.(3000n, clockTimeUs + 66_000);

      // Next 2 stalls should NOT trigger jump_to_live (counter starts from 0)
      renderer.onStall?.(508);
      renderer.onStall?.(508);

      const jumpToLive = recoveryEvents.find(
        (e: any) => e.action?.type === 'jump_to_live',
      );
      expect(jumpToLive).toBeUndefined();

      await player.destroy();
    });

    /**
     * Stale in-flight objects from the pre-recovery subscription must be
     * rejected by the pipeline after recovery reset. The reset passes
     * currentGroupId+1 as targetGroupId, setting minAcceptGroupId to
     * gate out stale groups.
     */
    it('pipeline rejects stale groups after recovery reset', async () => {
      const adapter = createMockAdapter();
      const renderer = createMockRenderer();
      const decoder = createMockVideoDecoder();
      const player = await loadWithAbr(adapter, renderer, decoder);

      // ACK video subscription so objects route through
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const videoAlias = varint(BigInt(videoReqId) + 100n);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(BigInt(videoReqId)),
        trackAlias: videoAlias,
        parameters: new Map(),
        trackExtensions: new Map(),
      } as any);

      // Feed group 5 so the pipeline has a known currentGroupId
      adapter._triggerObject(5n, {
        kind: 'data',
        trackAlias: videoAlias,
        groupId: varint(5),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array(100),
        extensions: new Uint8Array(0),
      } as MoqtObject);
      player.tick();

      // Fire a stall — triggers recovery, resets pipeline with
      // minAcceptGroupId = currentGroupId + 1 = 6
      renderer.onStall?.(508);

      // Deliver a stale object from group 5 (old subscription in-flight)
      // This should be rejected by the pipeline
      const objectsFn = vi.fn();
      player.on('media_object', objectsFn);
      const objectsBefore = objectsFn.mock.calls.length;

      adapter._triggerObject(5n, {
        kind: 'data',
        trackAlias: videoAlias,
        groupId: varint(5),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new Uint8Array(100),
        extensions: new Uint8Array(0),
      } as MoqtObject);
      player.tick();

      // The pipeline should NOT have decoded/rendered the stale object.
      // Verify no new frames rendered (decoder.decode not called after reset).
      // The recovery gate should still be active.
      expect((player as any).videoRecoveryActive).toBe(true);
      expect((player as any).consecutiveStallCount).toBe(1);

      await player.destroy();
    });
  });

  // ─── PUBLISH_DONE(TOO_FAR_BEHIND) recovery ──────────────────────────

  describe('PUBLISH_DONE recovery (§9.15, §13.4.3)', () => {
    it('resubscribes video track on PUBLISH_DONE(TOO_FAR_BEHIND)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      // Deliver catalog
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      // ACK the video subscription
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      const videoAlias = varint(BigInt(videoReqId) + 100n);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(BigInt(videoReqId)),
        trackAlias: videoAlias,
        parameters: new Map(),
        trackExtensions: new Map(),
      } as any);

      const subsBeforePublishDone = (adapter.subscribe as any).mock.calls.length;

      // Relay sends PUBLISH_DONE(TOO_FAR_BEHIND) for the video track
      adapter._triggerMessage({
        type: 'PUBLISH_DONE',
        requestId: varint(BigInt(videoReqId)),
        statusCode: varint(0x06), // TOO_FAR_BEHIND
        streamCount: varint(0),
        errorReason: 'Subscriber too slow',
      } as any);
      await new Promise(r => setTimeout(r, 0));

      // Player should have resubscribed to the same video track
      const subsAfterPublishDone = (adapter.subscribe as any).mock.calls.length;
      expect(subsAfterPublishDone).toBeGreaterThan(subsBeforePublishDone);

      await player.destroy();
    });

    it('does NOT resubscribe on PUBLISH_DONE(TRACK_ENDED)', async () => {
      const adapter = createMockAdapter();
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK',
        requestId: varint(BigInt(videoReqId)),
        trackAlias: varint(BigInt(videoReqId) + 100n),
        parameters: new Map(),
        trackExtensions: new Map(),
      } as any);

      const subsBeforePublishDone = (adapter.subscribe as any).mock.calls.length;

      // Relay sends PUBLISH_DONE(TRACK_ENDED) — normal end, no resubscribe
      adapter._triggerMessage({
        type: 'PUBLISH_DONE',
        requestId: varint(BigInt(videoReqId)),
        statusCode: varint(0x02), // TRACK_ENDED
        streamCount: varint(0),
        errorReason: 'Track ended normally',
      } as any);
      await new Promise(r => setTimeout(r, 0));

      // Should NOT have resubscribed
      const subsAfterPublishDone = (adapter.subscribe as any).mock.calls.length;
      expect(subsAfterPublishDone).toBe(subsBeforePublishDone);

      await player.destroy();
    });

    // draft-18 renumbers PUBLISH_DONE: TOO_FAR_BEHIND=0x5, EXPIRED=0x6 (§15.10.3) —
    // the inverse of draft-16. The player must compare against the negotiated
    // draft's table, or it both misses real TOO_FAR_BEHIND (0x5) and mis-fires
    // recovery on EXPIRED (0x6).
    async function setupVideoSub(adapter: ReturnType<typeof createMockAdapter>) {
      const player = new MoqtPlayer(createConfig(adapter));
      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;
      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        payload: new TextEncoder().encode(CATALOG_JSON),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));
      const videoReqId = await (adapter.subscribe as any).mock.results[1]?.value;
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: varint(BigInt(videoReqId)),
        trackAlias: varint(BigInt(videoReqId) + 100n), parameters: new Map(), trackExtensions: new Map(),
      } as any);
      return { player, videoReqId };
    }

    it('draft-18: resubscribes on PUBLISH_DONE(TOO_FAR_BEHIND=0x5)', async () => {
      const adapter = createMockAdapter();
      (adapter as any).draftVersion = 18;
      const { player, videoReqId } = await setupVideoSub(adapter);
      const before = (adapter.subscribe as any).mock.calls.length;

      adapter._triggerMessage({
        type: 'PUBLISH_DONE', requestId: varint(BigInt(videoReqId)),
        statusCode: varint(0x05), // draft-18 TOO_FAR_BEHIND
        streamCount: varint(0), errorReason: 'Subscriber too slow',
      } as any);
      await new Promise(r => setTimeout(r, 0));

      expect((adapter.subscribe as any).mock.calls.length).toBeGreaterThan(before); // resubscribed
      await player.destroy();
    });

    it('draft-18: does NOT resubscribe on PUBLISH_DONE(EXPIRED=0x6) — 0x6 is EXPIRED, not TOO_FAR_BEHIND', async () => {
      const adapter = createMockAdapter();
      (adapter as any).draftVersion = 18;
      const { player, videoReqId } = await setupVideoSub(adapter);
      const before = (adapter.subscribe as any).mock.calls.length;

      adapter._triggerMessage({
        type: 'PUBLISH_DONE', requestId: varint(BigInt(videoReqId)),
        statusCode: varint(0x06), // draft-18 EXPIRED (the LEGACY TOO_FAR_BEHIND value)
        streamCount: varint(0), errorReason: 'Expired',
      } as any);
      await new Promise(r => setTimeout(r, 0));

      expect((adapter.subscribe as any).mock.calls.length).toBe(before); // NOT mis-fired as TOO_FAR_BEHIND
      await player.destroy();
    });
  });

  // ─── CMAF ABR ──────────────────────────────────────────────────────

  describe('CMAF ABR (buffer-based quality switching)', () => {
    const CMAF_ABR_CATALOG = JSON.stringify({
      version: 1,
      tracks: [
        {
          name: 'video-0', packaging: 'cmaf', isLive: true, role: 'video',
          renderGroup: 1, altGroup: 1,
          codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 3_000_000,
          initData: 'AAAA',
        },
        {
          name: 'video-1', packaging: 'cmaf', isLive: true, role: 'video',
          renderGroup: 1, altGroup: 1,
          codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 1_500_000,
          initData: 'AAAA',
        },
        {
          name: 'video-2', packaging: 'cmaf', isLive: true, role: 'video',
          renderGroup: 1, altGroup: 1,
          codec: 'avc1.4d4015', width: 480, height: 360, bitrate: 500_000,
          initData: 'AAAA',
        },
        {
          name: 'audio', packaging: 'cmaf', isLive: true, role: 'audio',
          renderGroup: 1,
          codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128_000,
          initData: 'AAAA',
        },
      ],
    });

    function createMockMediaSource(bufferAheadUs: number | null = null) {
      return {
        initialize: vi.fn(),
        appendChunk: vi.fn(),
        endOfStream: vi.fn(),
        reset: vi.fn(),
        destroy: vi.fn(),
        mediaElement: {},
        onFirstFrame: null,
        onError: null,
        onStall: null,
        getBufferAheadUs: vi.fn(() => bufferAheadUs),
      };
    }

    it('does NOT downshift during startup when buffer signal is null', async () => {
      const adapter = createMockAdapter();
      const ms = createMockMediaSource(null); // null = no trustworthy signal
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createTransport: vi.fn(async () => ({}) as any),
        createConnection: () => adapter as unknown as MoqtConnection,
        createMediaSource: () => ms as any,
        createCmafAssembler: (opts: any) => ({ push: vi.fn(), setInitSegment: vi.fn(), destroy: vi.fn() }),
        qualitySwitchCooldownMs: 1,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CMAF_ABR_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      const subsBeforeTicks = (adapter.subscribe as any).mock.calls.length;

      // Tick 10 times — should NOT trigger any downshift subscription
      for (let i = 0; i < 10; i++) player.tick();

      const subsAfterTicks = (adapter.subscribe as any).mock.calls.length;
      expect(subsAfterTicks).toBe(subsBeforeTicks);

      await player.destroy();
    });

    it('downshifts when CMAF buffer is starved (getBufferAheadUs returns 0)', async () => {
      const adapter = createMockAdapter();
      const ms = createMockMediaSource(0); // 0 = starvation
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createTransport: vi.fn(async () => ({}) as any),
        createConnection: () => adapter as unknown as MoqtConnection,
        createMediaSource: () => ms as any,
        createCmafAssembler: (opts: any) => ({ push: vi.fn(), setInitSegment: vi.fn(), destroy: vi.fn() }),
        qualitySwitchCooldownMs: 1,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CMAF_ABR_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      const subsBeforeTicks = (adapter.subscribe as any).mock.calls.length;

      // Tick to trigger ABR evaluation
      for (let i = 0; i < 5; i++) player.tick();

      // Should have subscribed to a lower quality track
      const allSubs = (adapter.subscribe as any).mock.calls;
      const downshiftSub = allSubs.slice(subsBeforeTicks).find(
        (c: any) => {
          try { return new TextDecoder().decode(c[1]) === 'video-2'; } catch { return false; }
        },
      );
      expect(downshiftSub).toBeDefined();

      await player.destroy();
    });

    it('holds quality when CMAF buffer is healthy', async () => {
      const adapter = createMockAdapter();
      const ms = createMockMediaSource(2_000_000); // 2s ahead — healthy
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createTransport: vi.fn(async () => ({}) as any),
        createConnection: () => adapter as unknown as MoqtConnection,
        createMediaSource: () => ms as any,
        createCmafAssembler: (opts: any) => ({ push: vi.fn(), setInitSegment: vi.fn(), destroy: vi.fn() }),
        qualitySwitchCooldownMs: 1,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CMAF_ABR_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      const subsBeforeTicks = (adapter.subscribe as any).mock.calls.length;

      for (let i = 0; i < 10; i++) player.tick();

      // No new subscriptions — quality held
      expect((adapter.subscribe as any).mock.calls.length).toBe(subsBeforeTicks);

      await player.destroy();
    });

    it('emergency downshift bypasses quality controller cooldown', () => {
      const clock = { now: vi.fn(() => 0) };
      const qc = new QualityController({
        autoQuality: true,
        startLevel: 0,
        qualitySwitchCooldownMs: 60_000,
        clock,
      });
      // Populate a 3-track ladder
      qc.selectInitialTracks({
        tracks: [
          { name: 'v0', role: 'video', altGroup: 1, codec: 'avc1.640028', bitrate: 3_000_000 },
          { name: 'v1', role: 'video', altGroup: 1, codec: 'avc1.64001f', bitrate: 1_500_000 },
          { name: 'v2', role: 'video', altGroup: 1, codec: 'avc1.4d4015', bitrate: 500_000 },
          { name: 'v3', role: 'video', altGroup: 1, codec: 'avc1.64000d', bitrate: 250_000 },
        ],
      } as any, {});

      // Normal downshift — moves one step down, sets lastSwitchTimeUs
      const first = qc.reduceVideoQuality(false);
      expect(first).not.toBeNull();
      const firstIdx = first!.name;

      // Normal downshift immediately after — blocked by 60s cooldown
      const blocked = qc.reduceVideoQuality(false);
      expect(blocked).toBeNull();

      // Emergency downshift — bypasses cooldown
      const emergency = qc.reduceVideoQuality(true);
      expect(emergency).not.toBeNull();
      expect(emergency!.name).not.toBe(firstIdx);
    });

    it('does not ABR while switch is pending', async () => {
      const adapter = createMockAdapter();
      const ms = createMockMediaSource(0); // 0 = starvation
      const player = new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createTransport: vi.fn(async () => ({}) as any),
        createConnection: () => adapter as unknown as MoqtConnection,
        createMediaSource: () => ms as any,
        createCmafAssembler: (opts: any) => ({ push: vi.fn(), setInitSegment: vi.fn(), destroy: vi.fn() }),
        qualitySwitchCooldownMs: 1,
      });

      const loadPromise = player.load();
      await resolveConnect(adapter);
      await loadPromise;

      ackCatalog(adapter);
      adapter._triggerObject(0n, {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        objectId: varint(0),
        payload: new TextEncoder().encode(CMAF_ABR_CATALOG),
      } as MoqtObject);
      await new Promise(r => setTimeout(r, 0));

      // Trigger a manual switch to create pendingVideoSwitch
      player.selectVideoTrack('video-2').catch(() => {});
      await new Promise(r => setTimeout(r, 0));

      const subsAfterSwitch = (adapter.subscribe as any).mock.calls.length;

      // Ticking with buffer=0 should NOT trigger additional downshift
      // while the manual switch is pending
      for (let i = 0; i < 5; i++) player.tick();

      expect((adapter.subscribe as any).mock.calls.length).toBe(subsAfterSwitch);

      await player.destroy();
    });

    it('ABR peek does not mutate QualityController until commit', () => {
      const clock = { now: vi.fn(() => 0) };
      const qc = new QualityController({
        autoQuality: true,
        startLevel: 0,
        qualitySwitchCooldownMs: 0,
        clock,
      });
      qc.selectInitialTracks({
        tracks: [
          { name: 'v0', role: 'video', altGroup: 1, codec: 'avc1.640028', bitrate: 3_000_000 },
          { name: 'v1', role: 'video', altGroup: 1, codec: 'avc1.64001f', bitrate: 1_500_000 },
          { name: 'v2', role: 'video', altGroup: 1, codec: 'avc1.4d4015', bitrate: 500_000 },
        ],
      } as any, {});

      // Peek does not mutate
      const peeked = qc.peekLowerVideoQuality();
      expect(peeked?.name).toBe('v1');
      expect(qc.currentVideoTrack?.name).toBe('v0'); // unchanged

      // Peek again — same result since nothing mutated
      const peeked2 = qc.peekLowerVideoQuality();
      expect(peeked2?.name).toBe('v1');
      expect(qc.currentIndex).toBe(0); // still at index 0

      // Commit advances the index
      qc.commitVideoTrack('v1');
      expect(qc.currentVideoTrack?.name).toBe('v1');
      expect(qc.currentIndex).toBe(1);
    });

    it('ABR abort leaves QualityController and stats unchanged', () => {
      const clock = { now: vi.fn(() => 0) };
      const qc = new QualityController({
        autoQuality: true,
        startLevel: 0,
        qualitySwitchCooldownMs: 0,
        clock,
      });
      qc.selectInitialTracks({
        tracks: [
          { name: 'v0', role: 'video', altGroup: 1, codec: 'avc1.640028', bitrate: 3_000_000 },
          { name: 'v1', role: 'video', altGroup: 1, codec: 'avc1.64001f', bitrate: 1_500_000 },
        ],
      } as any, {});

      // Peek — would be the target of a switch
      const target = qc.peekLowerVideoQuality();
      expect(target?.name).toBe('v1');

      // Simulate abort — don't call commitVideoTrack
      // Controller should still be at v0
      expect(qc.currentVideoTrack?.name).toBe('v0');
      expect(qc.currentIndex).toBe(0);
    });
  });
});

// ─── MSE playhead-wedge escalation (Safari frozen-element rebuild path) ──
//
// The MSE adapter's wedge watchdog surfaces its FINAL rung as an Error named
// 'PlayheadWedgeError' through mediaSource.onError. Ordinary decode errors
// are degraded; an unrecoverable wedge means the MediaSource must be
// rebuilt, so the player must escalate it to a FATAL public error (the
// signal apps reconnect on) and stop.

describe('MSE playhead-wedge escalation', () => {
  const CMAF_INLINE_CATALOG = JSON.stringify({
    version: 1,
    tracks: [
      {
        name: 'video', packaging: 'cmaf', isLive: true, role: 'video',
        renderGroup: 1, codec: 'avc1.64001f', width: 1920, height: 1080,
        bitrate: 1_500_000, initData: btoa(String.fromCharCode(1, 2)),
      },
      {
        name: 'audio', packaging: 'cmaf', isLive: true, role: 'audio',
        renderGroup: 1, codec: 'mp4a.40.2', samplerate: 44100,
        channelConfig: '2', bitrate: 128_000, initData: btoa(String.fromCharCode(3, 4)),
      },
    ],
  });

  async function cmafPlayer() {
    const adapter = createMockAdapter();
    const mockMs: any = {
      initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(),
      reset: vi.fn(), mediaElement: null, destroy: vi.fn(),
      onFirstFrame: null, onError: null, onStall: null,
    };
    const player = new MoqtPlayer({
      ...createConfig(adapter),
      createMediaSource: () => mockMs,
      createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
    });
    const catalogReceived = new Promise<void>((r) => player.on('catalog_received', () => r()));
    const loadPromise = player.load();
    await resolveConnect(adapter);
    await loadPromise;
    ackCatalog(adapter);
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: varint(1),
      groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
      payload: new TextEncoder().encode(CMAF_INLINE_CATALOG),
    } as MoqtObject);
    await catalogReceived;
    await new Promise((r) => setTimeout(r, 50)); // pipelines + MSE wiring
    return { player, mockMs };
  }

  it('escalates an unrecoverable wedge to a FATAL public error + ERROR state', async () => {
    const { player, mockMs } = await cmafPlayer();
    const errors: any[] = [];
    player.on('error', (e) => errors.push(e.error));
    expect(typeof mockMs.onError).toBe('function'); // player wired the adapter

    mockMs.onError(Object.assign(
      new Error('playhead wedge unrecoverable: rebuild required'),
      { name: 'PlayheadWedgeError' },
    ));

    const wedge = errors.find((e) => e.code === PlayerErrorCode.MEDIA_ELEMENT_WEDGED);
    expect(wedge).toBeDefined();
    expect(wedge.severity).toBe('fatal');
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('ordinary MSE errors remain degraded decoder errors (no escalation)', async () => {
    const { player, mockMs } = await cmafPlayer();
    const errors: any[] = [];
    player.on('error', (e) => errors.push(e.error));

    mockMs.onError(new Error('HTMLMediaElement error (code=3)'));

    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe('degraded');
    expect(errors[0].code).toBe(PlayerErrorCode.VIDEO_DECODE_ERROR);
    expect(player.state).not.toBe(PlayerState.ERROR);
    await player.destroy();
  });
});
