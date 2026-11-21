/**
 * A refused video switch target must not cost playback its current track.
 *
 * Seen against a relay whose origin went away: the relay refused an
 * emergency-downshift SUBSCRIBE ("origin unreachable"). The player waited
 * out the whole switch deadline, and the starvation report for the playing
 * track, which arrived while the switch was pending, was dropped and never
 * raised again, so the old track was never restarted.
 *
 * Real timers, millisecond-scale liveness config (see player-liveness.test.ts).
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { ControlMessage, DataStreamHeader, MoqtObject } from '@openmoq/transport';
import { varint } from '@openmoq/transport';
import type { DataStreamTerminal } from '@openmoq/webtransport';

// ─── Mock adapter (thin copy of the player.test.ts harness) ──────────

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []), getSubscription: vi.fn(() => ({ state: 'established' })) },
    onMessage: null,
    onClose: null,
    onError: null,
    onDataStream: null,
    onObject: null,
    onStreamClosed: null,
    onDatagram: null,
    onNamespaceMessage: null,
    onQlogEvent: null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
    // The real contract: the ownership hook runs before the request is on the wire.
    subscribe: vi.fn(async (_ns: unknown, _n: unknown, opts?: { onRequestId?: (id: bigint) => void }) => {
      const requestId = varint(nextRequestId++);
      opts?.onRequestId?.(BigInt(requestId));
      return requestId;
    }),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
    // Mirrors the real contract: the pre-send ownership hook fires between
    // request-ID allocation and wire emission, so a caller can register before
    // any response (or a request-stream GOAWAY) can be handled.
    trackStatus: vi.fn(async (_ns: unknown, _n: unknown, opts?: { onRequestId?: (id: bigint) => void }) => {
      const requestId = varint(nextRequestId++);
      opts?.onRequestId?.(BigInt(requestId));
      return requestId;
    }),
    subscribeNamespace: vi.fn(async () => varint(nextRequestId++)),
    cancelNamespace: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    _triggerMessage: (msg: ControlMessage) => adapter.onMessage?.(msg),
    _triggerObject: (streamId: bigint, obj: MoqtObject) => adapter.onObject?.(streamId, obj),
    _triggerDataStream: (streamId: bigint, header: DataStreamHeader) => adapter.onDataStream?.(streamId, header),
    /**
     * Ordinary calls default to the terminal their error code implies: no error
     * means a peer FIN, a numeric error means a peer reset. Ambiguity tests pass
     * the kind explicitly — the player accepts only 'fin' as completion evidence,
     * so an unclassified call would silently stop being a clean FIN.
     */
    _triggerStreamClosed: (streamId: bigint, error?: number, terminal?: DataStreamTerminal) =>
      adapter.onStreamClosed?.(streamId, error, terminal ?? (error === undefined ? 'fin' : 'reset')),
  };
  return adapter;
}

const CATALOG_JSON = JSON.stringify({
  version: 1,
  tracks: [
    { name: 'video-hi', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
      codec: 'av01.0.08M.10', width: 1280, height: 720, bitrate: 2_500_000 },
    { name: 'video-lo', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
      codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 600_000 },
    { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', renderGroup: 1,
      codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000 },
  ],
});

const VIDEO_ALIAS = 50n;
const AUDIO_ALIAS = 51n;
const REQUEST_ERROR_INTERNAL = 0x0n;

const names = (adapter: any): string[] => adapter.subscribe.mock.calls.map(
  (c: any[]) => new TextDecoder().decode(c[1] as Uint8Array));

async function startPlaying(adapter: any, overrides?: Partial<MoqtPlayerConfig>) {
  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe',
    startLevel: 0,
    ...overrides,
  });
  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;
  const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
  adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map() } as unknown as ControlMessage);
  adapter._triggerObject(0n, { kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
    objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON) } as MoqtObject);
  await new Promise((r) => setTimeout(r, 0));
  expect(names(adapter).slice(1, 3)).toEqual(['video-hi', 'audio']);
  const videoReqId = await adapter.subscribe.mock.results[1]?.value;
  const audioReqId = await adapter.subscribe.mock.results[2]?.value;
  for (const [requestId, alias] of [[videoReqId, VIDEO_ALIAS], [audioReqId, AUDIO_ALIAS]] as const) {
    adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(alias), parameters: new Map(), trackExtensions: [] } as unknown as ControlMessage);
  }
  player.play();
  expect(player.state).toBe(PlayerState.PLAYING);
  return { player, videoReqId };
}

let nextObjectId = 0n;
function feedVideo(adapter: any): void {
  adapter._triggerObject(0n, { kind: 'data', trackAlias: varint(VIDEO_ALIAS), groupId: varint(0), subgroupId: varint(0),
    objectId: varint(nextObjectId++), payload: new Uint8Array([0xaa, 0xbb]) } as MoqtObject);
}

/** Start a switch to video-lo and return its request ID once it is on the wire. */
async function startSwitch(player: MoqtPlayer, adapter: any, reason = 'recovery'): Promise<{ requestId: bigint; done: Promise<unknown> }> {
  const before = adapter.subscribe.mock.calls.length;
  const done = player.selectVideoTrack('video-lo', reason, 'downshift').then(() => 'ok', (e: unknown) => e);
  await vi.waitFor(() => expect(adapter.subscribe.mock.calls.length).toBeGreaterThan(before));
  expect(names(adapter).at(-1)).toBe('video-lo');
  return { requestId: BigInt(await adapter.subscribe.mock.results.at(-1)!.value), done };
}

function refuse(adapter: any, requestId: bigint, reason = 'origin unreachable'): void {
  adapter._triggerMessage({ type: 'REQUEST_ERROR', requestId: varint(requestId), errorCode: varint(REQUEST_ERROR_INTERNAL),
    retryInterval: varint(0), errorReason: reason } as unknown as ControlMessage);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('refused video switch target', () => {
  it('fails the switch at once and keeps the playing track', async () => {
    const adapter = createMockAdapter();
    const { player, videoReqId } = await startPlaying(adapter, { livenessTimeoutMs: 0 });
    const failed: any[] = [];
    player.on('quality_switch_failed', (e) => failed.push(e));
    try {
      const { requestId, done } = await startSwitch(player, adapter);
      const refusedAt = performance.now();
      refuse(adapter, requestId);
      await vi.waitFor(() => expect(failed).toHaveLength(1), { timeout: 2_500 });
      // Well inside the 3 s staging deadline.
      expect(performance.now() - refusedAt).toBeLessThan(500);
      expect(failed[0]).toMatchObject({ fromTrackName: 'video-hi', toTrackName: 'video-lo' });
      expect(String(failed[0].error?.message)).toMatch(/origin unreachable/);
      await done;
      expect(adapter.unsubscribe).not.toHaveBeenCalledWith(videoReqId);
      expect(player.state).toBe(PlayerState.PLAYING);
      // The old track still plays, and a manual switch can start.
      feedVideo(adapter);
      const again = await startSwitch(player, adapter, 'manual');
      expect(again.requestId).not.toBe(requestId);
    } finally { await player.destroy(); }
  });

  it('restarts a playing track that starved while the switch was pending', async () => {
    const adapter = createMockAdapter();
    const { player, videoReqId } = await startPlaying(adapter, {
      livenessTimeoutMs: 60, livenessResetProbeMs: 40, livenessMaxRestarts: 2,
      livenessRestartBackoffMs: 20, livenessHealthyResetMs: 10_000,
    });
    try {
      feedVideo(adapter); // arm, then the origin goes away
      const { requestId } = await startSwitch(player, adapter);
      // Starvation is detected while the target is still unanswered.
      await sleep(150);
      expect(adapter.requestUpdate).not.toHaveBeenCalledWith(videoReqId, expect.anything());
      refuse(adapter, requestId);
      await vi.waitFor(() => expect(adapter.requestUpdate).toHaveBeenCalledWith(
        videoReqId, expect.objectContaining({ subscriptionFilter: { type: 'NextGroupStart' } })), { timeout: 1_000 });
      feedVideo(adapter); // the origin is back
    } finally { await player.destroy(); }
  });
});
