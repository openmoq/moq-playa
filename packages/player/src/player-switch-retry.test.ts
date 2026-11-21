/** Unit doubles with an empty media buffer; the player tick drives automatic switching. */
import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { ControlMessage, MoqtObject } from '@openmoq/transport';
import { varint } from '@openmoq/transport';

const CATALOG = JSON.stringify({
  version: 1,
  tracks: [
    { name: 'video-0', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
      codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 3_000_000, initData: 'AAAA' },
    { name: 'video-1', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
      codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 1_500_000, initData: 'AAAA' },
    { name: 'audio', packaging: 'cmaf', isLive: true, role: 'audio', renderGroup: 1,
      codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128_000, initData: 'AAAA' },
  ],
});

function createMockAdapter(refuse: (name: string) => boolean, retryInterval = 0n) {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []), getSubscription: vi.fn(() => undefined) },
    draftVersion: 16,
    onMessage: null, onClose: null, onError: null, onDataStream: null, onObject: null,
    onStreamClosed: null, onDatagram: null, onNamespaceMessage: null, onQlogEvent: null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
    subscribe: vi.fn(async (_ns: unknown, n: Uint8Array, opts?: { onRequestId?: (id: bigint) => void }) => {
      const requestId = varint(nextRequestId++);
      opts?.onRequestId?.(BigInt(requestId));
      const name = new TextDecoder().decode(n);
      if (refuse(name)) {
        // The relay answers at once (a few ms of RTT).
        setTimeout(() => adapter.onMessage?.({ type: 'REQUEST_ERROR', requestId, errorCode: varint(0n),
          retryInterval: varint(retryInterval), errorReason: 'origin unreachable' } as unknown as ControlMessage), 5);
      }
      return requestId;
    }),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
    trackStatus: vi.fn(async (_ns: unknown, _n: unknown, opts?: { onRequestId?: (id: bigint) => void }) => {
      const requestId = varint(nextRequestId++);
      opts?.onRequestId?.(BigInt(requestId));
      return requestId;
    }),
    subscribeNamespace: vi.fn(async () => varint(nextRequestId++)),
    cancelNamespace: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return adapter;
}

const names = (adapter: any): string[] => adapter.subscribe.mock.calls.map(
  (c: any[]) => new TextDecoder().decode(c[1] as Uint8Array));

describe('refused switch target retry rate with an empty buffer', () => {
  it('holds a refused automatic target for the staging timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    let started = false;
    const adapter = createMockAdapter(name => started && name === 'video-1');
    const ms = {
      initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
      mediaElement: {}, onFirstFrame: null, onError: null, onStall: null, setPlaybackIntent: vi.fn(),
      getBufferAheadUs: vi.fn(() => 0),
    };
    const player = new MoqtPlayer({
      url: 'https://relay.example.com/moq', namespace: 'live/broadcast',
      createTransport: vi.fn(async () => ({}) as any),
      createConnection: () => adapter as unknown as MoqtConnection,
      catalogBootstrap: 'subscribe', startLevel: 0, livenessTimeoutMs: 0,
      createMediaSource: () => ms as any,
      createCmafAssembler: () => ({ push: vi.fn(), setInitSegment: vi.fn(), destroy: vi.fn(), reset: vi.fn(), getEpoch: () => null }) as any,
    });
    const failed: unknown[] = [];
    const refusedEvents: unknown[] = [];
    player.on('quality_switch_failed', (e) => failed.push(e));
    player.on('track_subscribe_failed', (e) => refusedEvents.push(e));
    player.on('error', () => {});
    try {
      const load = player.load();
      await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
      adapter._connectResolve?.();
      await load;
      const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
      adapter.onMessage?.({ type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map() } as unknown as ControlMessage);
      adapter.onObject?.(0n, { kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
        objectId: varint(0), payload: new TextEncoder().encode(CATALOG) } as MoqtObject);
      await vi.advanceTimersByTimeAsync(0);
      expect(names(adapter).slice(1, 3)).toEqual(['video-0', 'audio']);
      for (const [i, alias] of [[1, 50n], [2, 51n]] as const) {
        const requestId = await adapter.subscribe.mock.results[i]?.value;
        adapter.onMessage?.({ type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(alias), parameters: new Map(), trackExtensions: [] } as unknown as ControlMessage);
      }
      started = true;
      player.play();
      await vi.advanceTimersByTimeAsync(1500);
      const targetSubscribes = names(adapter).filter(n => n === 'video-1').length;
      expect(targetSubscribes).toBe(1);
      expect(failed).toHaveLength(1);
      expect(refusedEvents).toHaveLength(1);
      await player.selectVideoTrack('video-1', 'recovery', 'downshift');
      expect(names(adapter).filter(n => n === 'video-1')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(names(adapter).filter(n => n === 'video-1')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(32);
      expect(names(adapter).filter(n => n === 'video-1')).toHaveLength(2);
      expect(failed).toHaveLength(2);
      const manual = player.selectVideoTrack('video-1').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      await manual;
      expect(names(adapter).filter(n => n === 'video-1')).toHaveLength(3);
    } finally { await player.destroy(); vi.useRealTimers(); }
  });
});
