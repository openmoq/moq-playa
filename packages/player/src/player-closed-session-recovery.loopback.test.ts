import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlCodec, SessionState, varint } from '@openmoq/transport';
import type { DraftVersion } from '@openmoq/transport';
import type { PlaybackEvent, RecoveryController } from '@openmoq/playback';
import type { MoqtConnection } from '@openmoq/webtransport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import type { VideoRendererLike } from './interfaces.js';

type Lifecycle = 'established' | 'draining' | 'peer close' | 'protocol violation';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(draft: DraftVersion, lifecycle: Lifecycle) {
  const pair = await connectedPair(draft, { serverSetup: { maxRequestUpdates: 100n } });
  pair.server.setLargestLocationProvider(() => ({ group: 0n, object: 0n }));
  const requests = new Map<string, bigint>();
  pair.server.onSubscribe = (id, _ns, name) => { requests.set(new TextDecoder().decode(name), id); };
  // Modeled renderer; transport, session, pipeline and recovery controller are real.
  const renderer: VideoRendererLike = { enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
    onFirstFrame: null, onFrameRendered: null, onStall: null };
  let now = 1_000_000;
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq', namespace: 'live', draftVersion: draft,
    // Source and built declarations have distinct private class members.
    connection: pair.client as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe', disableAudio: true, livenessTimeoutMs: 0,
    reconnectAttempts: 0, clock: { now: () => now }, createRenderer: () => renderer,
    createVideoDecoder: () => ({ configure: vi.fn(), decode: vi.fn(), flush: async () => {},
      reset: vi.fn(), queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn() }),
    // Keep the draining connection current while replacement setup is pending.
    createTransport: () => new Promise(() => {}),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  });
  const errors = vi.fn(), closed = vi.fn(), stalls = vi.fn(), recoveries = vi.fn();
  player.on('error', errors); player.on('session_closed', closed);
  player.on('stall', stalls); player.on('recovery_action', recoveries);
  await player.load(); await flush(256);
  await pair.server.acceptSubscribe(requests.get('catalog')!, 100n);
  const stream = await pair.server.openSubgroup(100n, 0n, 0n, { publisherPriority: 128 });
  await pair.server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
    { name: 'video', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640029',
      width: 640, height: 360, bitrate: 100000 },
  ] })));
  await pair.server.closeSubgroup(stream); await flush(256);
  expect(requests.get('video')).toBeDefined();
  await pair.server.acceptSubscribe(requests.get('video')!, 101n); await flush(256);
  expect(renderer.onStall).toBeTypeOf('function');
  expect(errors).not.toHaveBeenCalled();
  if (lifecycle === 'peer close') {
    await pair.server.close(varint(0n), 'finished');
    // The loopback exposes each endpoint's transport closure independently.
    pair.a.close({ closeCode: 0, reason: 'finished' });
  }
  if (lifecycle === 'protocol violation') {
    // SUBSCRIBE_OK belongs on a request stream, never the session control stream.
    pair.b.uniOut[0]!.injectRead(createControlCodec(draft).encode({ type: 'SUBSCRIBE_OK',
      requestId: varint(requests.get('video')!), trackAlias: varint(101n), parameters: new Map() }));
  }
  if (lifecycle === 'draining') await pair.server.sendGoaway({ newSessionUri: '', requestId: 4n, timeout: 0n });
  await flush(256);
  const isClosed = lifecycle === 'peer close' || lifecycle === 'protocol violation';
  expect(pair.client.session.state).toBe(isClosed ? SessionState.CLOSED
    : lifecycle === 'draining' ? SessionState.DRAINING : SessionState.ESTABLISHED);
  if (lifecycle === 'protocol violation') expect(closed).toHaveBeenCalledWith(expect.objectContaining({ error: draft === 23 ? 0x303 : 3 }));
  errors.mockClear();
  // Observe reset/escalation without replacing them; inject a pipeline recovery event
  // at its callback boundary to isolate the gap ladder from gap-detection policy.
  const internal = player as unknown as {
    videoPipeline: { reset(group?: bigint): void; onEvent(event: PlaybackEvent): void };
    recoveryController: RecoveryController; resetMediaClock(): void; consecutiveStallCount: number;
  };
  const reset = vi.spyOn(internal.videoPipeline, 'reset');
  const resetClock = vi.spyOn(internal, 'resetMediaClock');
  const evaluate = vi.spyOn(internal.recoveryController, 'evaluate');
  const update = vi.spyOn(pair.client, 'requestUpdate');
  const select = vi.spyOn(player, 'selectVideoTrack');
  return { player, internal, errors, stalls, recoveries, reset, resetClock, evaluate, update, select,
    async stall() { now += 600_000; renderer.onStall!(600); await flush(256); },
    async destroy() { await player.destroy(); await pair.client.close(); await pair.server.close(); },
  };
}

for (const draft of [18, 22, 23] as const) describe(`draft ${draft} session recovery`, () => {
  for (const lifecycle of ['peer close', 'protocol violation'] as const) {
    it.each([1, 3])(`records %i stalls without recovery after ${lifecycle}`, async count => {
      const f = await fixture(draft, lifecycle);
      try {
        for (let i = 0; i < count; i++) await f.stall();
        expect(f.stalls.mock.calls).toEqual(Array.from({ length: count }, () => [{ type: 'stall', durationMs: 600 }]));
        expect(f.player.stats.stallCount).toBe(count);
        expect.soft(f.recoveries).not.toHaveBeenCalled();
        expect.soft(f.update).not.toHaveBeenCalled();
        expect.soft(f.errors).not.toHaveBeenCalled();
        expect.soft(f.reset).not.toHaveBeenCalled();
        expect.soft(f.resetClock).not.toHaveBeenCalled();
        expect.soft(f.evaluate).not.toHaveBeenCalled();
        expect(f.select).not.toHaveBeenCalled();
        expect(f.internal.consecutiveStallCount).toBe(0);
      } finally { await f.destroy(); }
    });
    it(`does not resubscribe from the gap ladder after ${lifecycle}`, async () => {
      const f = await fixture(draft, lifecycle);
      try {
        f.internal.videoPipeline.onEvent({ type: 'recovery', action: { type: 'resubscribe', startGroup: 7n } });
        await flush(256);
        expect(f.recoveries).toHaveBeenCalledWith({ type: 'recovery_action', action: { type: 'resubscribe', startGroup: 7n } });
        expect.soft(f.update).not.toHaveBeenCalled();
        expect.soft(f.errors).not.toHaveBeenCalled();
      } finally { await f.destroy(); }
    });
  }
  for (const lifecycle of ['established', 'draining'] as const) {
    it(`resets and updates on three stalls while ${lifecycle}`, async () => {
      const f = await fixture(draft, lifecycle);
      try {
        for (let i = 0; i < 3; i++) await f.stall();
        expect(f.stalls).toHaveBeenCalledTimes(3);
        expect(f.player.stats.stallCount).toBe(3);
        expect(f.reset).toHaveBeenCalledTimes(3); expect(f.resetClock).toHaveBeenCalledTimes(3);
        expect(f.evaluate).toHaveBeenCalledTimes(2);
        expect(f.recoveries.mock.calls.map(([event]) => event.action)).toEqual([
          { type: 'skip_forward' }, { type: 'skip_forward' }, { type: 'jump_to_live', trigger: 'stalls' },
        ]);
        expect(f.update).toHaveBeenCalledTimes(3);
        expect(f.errors).not.toHaveBeenCalled();
      } finally { await f.destroy(); }
    });
  }
});
