/**
 * Media-liveness integration tests — starvation detection + restart ladder.
 *
 * The gap detector handles gaps BETWEEN arrivals; these tests prove the
 * player handles NO arrivals: REQUEST_UPDATE refresh, escalation to full
 * resubscribe, fatal MEDIA_STARVED after the ladder is exhausted, the
 * stream-reset shortened fuse, and the quiet paths (benign resets,
 * pause/resume, destroy mid-incident).
 *
 * Uses real timers with millisecond-scale liveness config — the ladder is
 * wall-clock driven (performance.now), so fake timers would skew it.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerErrorCode } from './errors.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, DataStreamHeader, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';

// ─── Mock adapter (thin copy of the player.test.ts harness) ──────────

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []) },
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
    subscribe: vi.fn(async () => varint(nextRequestId++)),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
    trackStatus: vi.fn(async () => varint(nextRequestId++)),
    subscribeNamespace: vi.fn(async () => varint(nextRequestId++)),
    cancelNamespace: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    _triggerMessage: (msg: ControlMessage) => adapter.onMessage?.(msg),
    _triggerObject: (streamId: bigint, obj: MoqtObject) => adapter.onObject?.(streamId, obj),
    _triggerDataStream: (streamId: bigint, header: DataStreamHeader) => adapter.onDataStream?.(streamId, header),
    _triggerStreamClosed: (streamId: bigint, error?: number) => adapter.onStreamClosed?.(streamId, error),
  };
  return adapter;
}

const CATALOG_JSON = JSON.stringify({
  version: 1,
  tracks: [
    {
      name: 'video', packaging: 'loc', isLive: true, role: 'video',
      renderGroup: 1, codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000,
    },
    {
      name: 'audio', packaging: 'loc', isLive: true, role: 'audio',
      renderGroup: 1, codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000,
    },
  ],
});

/** Millisecond-scale liveness config so tests run in a few hundred ms. */
const FAST_LIVENESS = {
  livenessTimeoutMs: 60,
  livenessResetProbeMs: 40,
  livenessMaxRestarts: 2,
  livenessRestartBackoffMs: 20,
  livenessHealthyResetMs: 10_000,
} as const;

function createConfig(
  adapter: ReturnType<typeof createMockAdapter>,
  overrides?: Partial<MoqtPlayerConfig>,
): MoqtPlayerConfig {
  return {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    ...FAST_LIVENESS,
    ...overrides,
  };
}

const VIDEO_ALIAS = 50n;
const AUDIO_ALIAS = 51n;

/**
 * Boot to PLAYING with media subscriptions established under server-assigned
 * aliases (video reqId=2→alias 50, audio reqId=3→alias 51).
 */
async function startPlaying(
  adapter: ReturnType<typeof createMockAdapter>,
  overrides?: Partial<MoqtPlayerConfig>,
): Promise<{ player: MoqtPlayer; videoReqId: ReturnType<typeof varint> }> {
  const player = new MoqtPlayer(createConfig(adapter, overrides));
  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;

  const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map(),
  } as unknown as ControlMessage);
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
    objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
  } as MoqtObject);
  await new Promise((r) => setTimeout(r, 0)); // media subscribes are async

  const videoReqId = await adapter.subscribe.mock.results[1]?.value;
  const audioReqId = await adapter.subscribe.mock.results[2]?.value;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
    parameters: new Map(), trackExtensions: [],
  } as unknown as ControlMessage);
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: audioReqId, trackAlias: varint(AUDIO_ALIAS),
    parameters: new Map(), trackExtensions: [],
  } as unknown as ControlMessage);

  player.play();
  expect(player.state).toBe(PlayerState.PLAYING);
  return { player, videoReqId };
}

let nextObjectId = 0n;
/** Deliver one video object (arms/stamps the liveness monitor). */
function feedVideo(adapter: ReturnType<typeof createMockAdapter>, streamId = 0n): void {
  adapter._triggerObject(streamId, {
    kind: 'data', trackAlias: varint(VIDEO_ALIAS), groupId: varint(0), subgroupId: varint(0),
    objectId: varint(nextObjectId++), payload: new Uint8Array([0xaa, 0xbb]),
  } as MoqtObject);
}

function subgroupHeader(trackAlias: bigint): DataStreamHeader {
  return {
    type: 'subgroup',
    header: {
      typeByte: 0x10, trackAlias, groupId: 0n, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: false,
    },
  } as DataStreamHeader;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Tests ───────────────────────────────────────────────────────────

describe('media liveness (starvation detection + restart ladder)', () => {
  it('starved track → REQUEST_UPDATE refresh (NextGroupStart) + track_restart event', async () => {
    const adapter = createMockAdapter();
    const { player, videoReqId } = await startPlaying(adapter);
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    feedVideo(adapter); // arm
    // …then silence. Starvation fires after livenessTimeoutMs.
    await vi.waitFor(() => expect(adapter.requestUpdate).toHaveBeenCalled(), { timeout: 2_000 });

    expect(adapter.requestUpdate).toHaveBeenCalledWith(
      videoReqId,
      expect.objectContaining({ subscriptionFilter: { type: 'NextGroupStart' } }),
    );
    expect(recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'track_restart', mediaType: 'video', trackName: 'video', attempt: 1 }),
    ]));

    feedVideo(adapter); // delivery resumes — ladder ends quietly
    await player.destroy();
  });

  it('refresh failure (draft-18 dead request stream) escalates to full resubscribe in the same attempt', async () => {
    const adapter = createMockAdapter();
    adapter.requestUpdate.mockRejectedValue(
      new Error('requestUpdate: no open draft-18 request stream for request 2'));
    const { player, videoReqId } = await startPlaying(adapter);

    feedVideo(adapter);
    // Attempt 1: refresh throws → unsubscribe dead sub + fresh SUBSCRIBE for "video".
    await vi.waitFor(() => expect(adapter.unsubscribe).toHaveBeenCalledWith(videoReqId), { timeout: 2_000 });
    await vi.waitFor(() => {
      const names = adapter.subscribe.mock.calls.map(
        (c: any[]) => new TextDecoder().decode(c[1] as Uint8Array));
      // catalog + video + audio + liveness resubscribe of video
      expect(names.filter((n: string) => n === 'video').length).toBeGreaterThanOrEqual(2);
    }, { timeout: 2_000 });

    // Recover on the NEW subscription (optimistically registered under its reqId).
    const newReqId = await adapter.subscribe.mock.results.at(-1)?.value;
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: newReqId, groupId: varint(1), subgroupId: varint(0),
      objectId: varint(0), payload: new Uint8Array([0xcc]),
    } as MoqtObject);
    await sleep(50);
    expect(player.state).toBe(PlayerState.PLAYING); // no fatal — recovered
    await player.destroy();
  });

  it('exhausted ladder → fatal MEDIA_STARVED + ERROR state', async () => {
    const adapter = createMockAdapter();
    adapter.requestUpdate.mockRejectedValue(new Error('request stream gone'));
    const { player } = await startPlaying(adapter);
    const errors: any[] = [];
    player.on('error', (e) => errors.push(e.error));

    feedVideo(adapter); // arm, then permanent silence — resubscribes never deliver
    await vi.waitFor(() => {
      expect(errors.some((e) => e.code === PlayerErrorCode.MEDIA_STARVED)).toBe(true);
    }, { timeout: 3_000 });

    const starved = errors.find((e) => e.code === PlayerErrorCode.MEDIA_STARVED);
    expect(starved.severity).toBe('fatal');
    expect(starved.source).toBe('connection');
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('a data-stream reset shortens the fuse — starvation fires long before the full timeout', async () => {
    const adapter = createMockAdapter();
    // Full timeout far away (5s): only the reset fuse (40ms) can fire below.
    const { player } = await startPlaying(adapter, { livenessTimeoutMs: 5_000 });
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    adapter._triggerDataStream(7n, subgroupHeader(VIDEO_ALIAS));
    feedVideo(adapter, 7n); // arm
    adapter._triggerStreamClosed(7n, 0x1); // reset, and no successor ever delivers

    await vi.waitFor(() => {
      expect(recoveries.some((a) => a.type === 'track_restart')).toBe(true);
    }, { timeout: 2_000 });
    feedVideo(adapter); // recover
    await player.destroy();
  });

  it('benign reset with a flowing successor stream triggers nothing', async () => {
    const adapter = createMockAdapter();
    const { player } = await startPlaying(adapter);
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    adapter._triggerDataStream(7n, subgroupHeader(VIDEO_ALIAS));
    const feeder = setInterval(() => feedVideo(adapter), 15);
    await sleep(40);
    adapter._triggerStreamClosed(7n, 0x1); // group-end style reset; objects keep flowing
    await sleep(200);
    clearInterval(feeder);

    expect(recoveries.filter((a) => a.type === 'track_restart')).toHaveLength(0);
    expect(adapter.requestUpdate).not.toHaveBeenCalled();
    await player.destroy();
  });

  it('fetch stream resets never touch track liveness', async () => {
    const adapter = createMockAdapter();
    const { player } = await startPlaying(adapter, { livenessTimeoutMs: 5_000 });
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    feedVideo(adapter); // arm
    adapter._triggerDataStream(9n, {
      type: 'fetch', header: { typeByte: 0x05, requestId: 77n },
    } as unknown as DataStreamHeader);
    adapter._triggerStreamClosed(9n, 0x1);

    await sleep(150); // fuse (40ms) would have fired by now if mis-wired
    expect(recoveries.filter((a) => a.type === 'track_restart')).toHaveLength(0);
    await player.destroy();
  });

  it('destroy() during a starvation incident stays quiet — no MEDIA_STARVED', async () => {
    const adapter = createMockAdapter();
    adapter.requestUpdate.mockRejectedValue(new Error('request stream gone'));
    const { player } = await startPlaying(adapter);
    const errors: any[] = [];
    player.on('error', (e) => errors.push(e.error));
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    feedVideo(adapter);
    await vi.waitFor(() => {
      expect(recoveries.some((a) => a.type === 'track_restart')).toBe(true);
    }, { timeout: 2_000 });

    await player.destroy(); // intentional teardown mid-ladder
    await sleep(300);       // long enough for the ladder to have exhausted
    expect(errors.some((e) => e.code === PlayerErrorCode.MEDIA_STARVED)).toBe(false);
    expect(player.state).toBe(PlayerState.ENDED);
  });

  it('pause → resume does not read the pause as starvation', async () => {
    const adapter = createMockAdapter();
    const { player } = await startPlaying(adapter);
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    feedVideo(adapter); // arm
    player.pause();
    await sleep(150);   // well past livenessTimeoutMs, but PAUSED
    player.play();
    await sleep(150);   // resumed; stamps were cleared — tracks re-arm on next arrival

    expect(recoveries.filter((a) => a.type === 'track_restart')).toHaveLength(0);
    await player.destroy();
  });

  it('livenessTimeoutMs: 0 disables monitoring entirely', async () => {
    const adapter = createMockAdapter();
    const { player } = await startPlaying(adapter, { livenessTimeoutMs: 0 });
    const recoveries: any[] = [];
    player.on('recovery_action', (e) => recoveries.push(e.action));

    feedVideo(adapter);
    await sleep(250); // many times the (disabled) timeout
    expect(recoveries.filter((a) => a.type === 'track_restart')).toHaveLength(0);
    expect(adapter.requestUpdate).not.toHaveBeenCalled();
    await player.destroy();
  });
});
