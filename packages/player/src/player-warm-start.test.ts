/**
 * LOC warm start via joining FETCH (§5.1.3, §9.16.2 / draft-18 §10.12.2).
 *
 * With `warmStartCurrentGroup: true`, live LOC media tracks subscribe with
 * the Largest Object filter and immediately issue a relative joining FETCH
 * (joiningStart 0) against the SUBSCRIBE request ID, so the current group's
 * head arrives on the FETCH stream while live delivery continues from
 * {Largest.Group, Largest.Object + 1} — contiguous, non-overlapping.
 *
 * Guardrails pinned here:
 *   - INITIAL TUNE-IN ONLY: the ABR switch path (selectVideoTrack) never
 *     issues a joining FETCH.
 *   - FETCH failure is non-fatal: warn + clean up + live-only.
 *   - CMAF and non-live tracks are skipped (LOC-only slice).
 *   - Default behavior (warm start off) keeps NextGroupStart untouched.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';

// ─── Mock adapter (thin copy of the player.test.ts harness) ──────────

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []) },
    onMessage: null, onClose: null, onError: null, onDataStream: null,
    onObject: null, onStreamClosed: null, onDatagram: null,
    onNamespaceMessage: null, onQlogEvent: null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
    subscribe: vi.fn(async () => varint(nextRequestId++)),
    joiningFetch: vi.fn(async () => varint(nextRequestId++)),
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
    _triggerDataStream: (streamId: bigint, header: unknown) => adapter.onDataStream?.(streamId, header),
    _triggerStreamClosed: (streamId: bigint, error?: number) => adapter.onStreamClosed?.(streamId, error),
  };
  return adapter;
}

function locCatalog(tracks: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, tracks });
}

const VIDEO_LOC = {
  name: 'video', packaging: 'loc', isLive: true, role: 'video',
  renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000,
};
const VIDEO_LOC_ALT = {
  ...VIDEO_LOC, name: 'video-2', codec: 'av01.0.05M.10', width: 1280, height: 720, bitrate: 800_000,
};
const AUDIO_LOC = {
  name: 'audio', packaging: 'loc', isLive: true, role: 'audio',
  renderGroup: 1, codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000,
};

async function bootPlayer(
  catalogJson: string,
  cfg?: Partial<MoqtPlayerConfig>,
  mutateAdapter?: (adapter: ReturnType<typeof createMockAdapter>) => void,
) {
  const adapter = createMockAdapter();
  mutateAdapter?.(adapter);
  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    ...cfg,
  });
  const errors: any[] = [];
  player.on('error', (e) => errors.push(e.error));

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
    objectId: varint(0), payload: new TextEncoder().encode(catalogJson),
  } as MoqtObject);
  await new Promise((r) => setTimeout(r, 30)); // async subscribe fan-out

  /** [trackName, subscribeOptions] per media subscribe() call. */
  const subscribeCalls = () => adapter.subscribe.mock.calls.map((c: any[]) => [
    (() => { try { return new TextDecoder().decode(c[1]); } catch { return '?'; } })(),
    c[2],
  ]);
  const reqIdFor = async (name: string) => {
    const idx = subscribeCalls().findIndex(([n]: [string, unknown]) => n === name);
    return idx >= 0 ? BigInt(await adapter.subscribe.mock.results[idx]?.value) : undefined;
  };
  return { player, adapter, errors, subscribeCalls, reqIdFor };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('warm start ON (warmStartCurrentGroup: true, live LOC)', () => {
  it('media subscribes use the Largest Object filter and each gets a relative joining FETCH (joiningStart 0)', async () => {
    const { player, adapter, subscribeCalls, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC, AUDIO_LOC]), { warmStartCurrentGroup: true });

    for (const name of ['video', 'audio']) {
      const call = subscribeCalls().find(([n]: [string, unknown]) => n === name);
      expect(call, `subscribe(${name})`).toBeDefined();
      expect(call![1]?.subscriptionFilter?.type).toBe('LargestObject');
    }

    expect(adapter.joiningFetch).toHaveBeenCalledTimes(2);
    const videoReqId = await reqIdFor('video');
    const audioReqId = await reqIdFor('audio');
    const joinedIds = adapter.joiningFetch.mock.calls.map((c: any[]) => BigInt(c[0].joiningRequestId));
    expect(joinedIds).toContain(videoReqId);
    expect(joinedIds).toContain(audioReqId);
    for (const c of adapter.joiningFetch.mock.calls) {
      expect(c[0].joiningFetchType).toBe('relative');
      expect(c[0].joiningStart).toBe(0n);
    }
    await player.destroy();
  });

  it('fetched objects remap onto the LIVE track alias and route like live objects', async () => {
    const routed: Array<{ alias: bigint; groupId: bigint; objectId: bigint }> = [];
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC, AUDIO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') {
            routed.push({ alias: BigInt(obj.trackAlias), groupId: BigInt(obj.groupId), objectId: BigInt(obj.objectId) });
          }
          return obj;
        },
      });
    const videoReqId = await reqIdFor('video');
    const videoJoinCall = adapter.joiningFetch.mock.calls.findIndex(
      (c: any[]) => BigInt(c[0].joiningRequestId) === videoReqId);
    const fetchReqId = BigInt(await adapter.joiningFetch.mock.results[videoJoinCall]?.value);

    // FETCH data stream announces itself, then delivers alias-0 objects.
    const streamId = 77n;
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(fetchReqId) } });
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(4n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0xaa]),
    } as MoqtObject);
    // A live object on the real alias routes identically.
    adapter._triggerObject(1n, {
      kind: 'data', trackAlias: varint(videoReqId!), groupId: varint(4n), subgroupId: varint(0),
      objectId: varint(1n), payload: new Uint8Array([0xbb]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));

    // Both reached routeObject under the SAME live alias.
    expect(routed).toEqual([
      { alias: videoReqId!, groupId: 4n, objectId: 0n },
      { alias: videoReqId!, groupId: 4n, objectId: 1n },
    ]);
    await player.destroy();
  });

  it('REQUEST_ERROR for the joining fetch is non-fatal: warns, cleans up, playback continues live-only', async () => {
    const { player, adapter, errors, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), { warmStartCurrentGroup: true });
    const videoReqId = await reqIdFor('video');
    const fetchReqId = BigInt(await adapter.joiningFetch.mock.results[0]?.value);

    adapter._triggerMessage({
      type: 'REQUEST_ERROR', requestId: varint(fetchReqId),
      errorCode: 0x11n, retryInterval: 0n, errorReason: 'no objects published',
    } as unknown as ControlMessage);
    await new Promise((r) => setTimeout(r, 10));

    expect(player.state).not.toBe(PlayerState.ERROR); // non-fatal
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    // The live subscription is untouched: live objects still accepted.
    adapter._triggerObject(1n, {
      kind: 'data', trackAlias: varint(videoReqId!), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: new Uint8Array([0xcc]),
    } as MoqtObject);
    expect(player.state).not.toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('GUARDRAIL: selectVideoTrack (ABR switch) does NOT issue a joining FETCH', async () => {
    const { player, adapter } = await bootPlayer(
      locCatalog([VIDEO_LOC, VIDEO_LOC_ALT, AUDIO_LOC]), { warmStartCurrentGroup: true });
    const joinsAfterTuneIn = adapter.joiningFetch.mock.calls.length;
    expect(joinsAfterTuneIn).toBe(2); // video + audio at tune-in

    await player.selectVideoTrack('video-2');
    await new Promise((r) => setTimeout(r, 10));

    expect(adapter.joiningFetch.mock.calls.length).toBe(joinsAfterTuneIn); // unchanged
    await player.destroy();
  });

  it('CMAF tracks are skipped (LOC-only slice): no joining FETCH, NextGroupStart preserved', async () => {
    const cmafCatalog = locCatalog([
      { name: 'video', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1,
        codec: 'avc1.4D4028', width: 1280, height: 720, bitrate: 2_500_000 },
    ]);
    const { player, adapter, subscribeCalls } = await bootPlayer(
      cmafCatalog, { warmStartCurrentGroup: true });

    expect(adapter.joiningFetch).not.toHaveBeenCalled();
    const call = subscribeCalls().find(([n]: [string, unknown]) => n === 'video');
    expect(call![1]?.subscriptionFilter?.type).toBe('NextGroupStart');
    await player.destroy();
  });

  it('non-live (VOD) tracks are skipped: AbsoluteStart preserved, no joining FETCH', async () => {
    const vodCatalog = locCatalog([{ ...VIDEO_LOC, isLive: false }]);
    const { player, adapter, subscribeCalls } = await bootPlayer(
      vodCatalog, { warmStartCurrentGroup: true });

    expect(adapter.joiningFetch).not.toHaveBeenCalled();
    const call = subscribeCalls().find(([n]: [string, unknown]) => n === 'video');
    expect(call![1]?.subscriptionFilter?.type).toBe('AbsoluteStart');
    await player.destroy();
  });
});

describe('warm start — alias remap and stream races', () => {
  it('SUBSCRIBE_OK alias remap: fetch objects route to the NEW alias, not the request ID', async () => {
    // A relay that does not echo requestId as trackAlias must not orphan the
    // warm-start fetch: activeFetches and any existing fetchStreamAliases
    // entries must follow the SUBSCRIBE_OK remap.
    const routed: Array<{ alias: bigint; objectId: bigint }> = [];
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ alias: BigInt(obj.trackAlias), objectId: BigInt(obj.objectId) });
          return obj;
        },
      });
    const videoReqId = (await reqIdFor('video'))!;
    const fetchReqId = BigInt(await adapter.joiningFetch.mock.results[0]?.value);
    const newAlias = videoReqId + 100n;

    // Fetch data stream opens BEFORE SUBSCRIBE_OK (maps to the optimistic alias)…
    const streamA = 70n;
    adapter._triggerDataStream(streamA, { type: 'fetch', header: { requestId: varint(fetchReqId) } });
    // …then SUBSCRIBE_OK assigns a different alias.
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: varint(videoReqId), trackAlias: varint(newAlias), parameters: new Map(),
    } as unknown as ControlMessage);
    await new Promise((r) => setTimeout(r, 10));

    adapter._triggerObject(streamA, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(2n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    // A stream that opens AFTER the remap must also map to the new alias.
    const streamB = 71n;
    adapter._triggerDataStream(streamB, { type: 'fetch', header: { requestId: varint(fetchReqId) } });
    adapter._triggerObject(streamB, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(2n), subgroupId: varint(0),
      objectId: varint(1n), payload: new Uint8Array([0x02]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));

    expect(routed).toEqual([
      { alias: newAlias, objectId: 0n },
      { alias: newAlias, objectId: 1n },
    ]);
    await player.destroy();
  });

  it('EARLY DATA RACE: fetch stream + objects arriving before joiningFetch() resolves are buffered, then routed once', async () => {
    // §9.16.3: FETCH data may arrive at any time relative to FETCH_OK — and
    // therefore before the joiningFetch() promise continuation registers
    // activeFetches. Those objects must never route as alias 0; they buffer
    // per-stream and replay through the normal remap once registered.
    const routed: Array<{ alias: bigint; objectId: bigint }> = [];
    const FETCH_REQ = 500n;
    let resolveJoin!: (v: unknown) => void;
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ alias: BigInt(obj.trackAlias), objectId: BigInt(obj.objectId) });
          return obj;
        },
      }, (a) => {
        a.joiningFetch = vi.fn(() => new Promise((r) => { resolveJoin = r; }));
      });
    const videoReqId = (await reqIdFor('video'))!;
    expect(adapter.joiningFetch).toHaveBeenCalled(); // request sent, promise pending

    // Data stream + objects land BEFORE the player learns the request ID.
    const streamId = 80n;
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(FETCH_REQ) } });
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(3n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x0a]),
    } as MoqtObject);
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(3n), subgroupId: varint(0),
      objectId: varint(1n), payload: new Uint8Array([0x0b]),
    } as MoqtObject);
    expect(routed).toEqual([]); // never routed as alias 0

    resolveJoin(varint(FETCH_REQ)); // player now registers the fetch
    await new Promise((r) => setTimeout(r, 20));

    expect(routed).toEqual([          // replayed once, on the live alias
      { alias: videoReqId, objectId: 0n },
      { alias: videoReqId, objectId: 1n },
    ]);
    await player.destroy();
  });

  it('fetch stream FIN/reset cleans up fetch bookkeeping — later objects on that stream do not route', async () => {
    const routed: Array<{ alias: bigint; objectId: bigint }> = [];
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ alias: BigInt(obj.trackAlias), objectId: BigInt(obj.objectId) });
          return obj;
        },
      });
    const videoReqId = (await reqIdFor('video'))!;
    const fetchReqId = BigInt(await adapter.joiningFetch.mock.results[0]?.value);

    const streamId = 90n;
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(fetchReqId) } });
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(1n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));
    expect(routed).toEqual([{ alias: videoReqId, objectId: 0n }]);

    adapter._triggerStreamClosed(streamId); // FIN — pre-roll complete
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(1n), subgroupId: varint(0),
      objectId: varint(9n), payload: new Uint8Array([0xff]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));

    expect(routed).toHaveLength(1); // nothing routed after the FIN
    await player.destroy();
  });
});

describe('warm start — LatestObject compatibility alias', () => {
  it('warm start with an explicit LatestObject filter is accepted and subscribes as LargestObject', async () => {
    const { player, adapter, subscribeCalls } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        subscriptionFilter: { type: 'LatestObject' },
      });
    const call = subscribeCalls().find(([n]: [string, unknown]) => n === 'video');
    expect(call![1]?.subscriptionFilter?.type).toBe('LargestObject');
    expect(adapter.joiningFetch).toHaveBeenCalledTimes(1);
    await player.destroy();
  });
});

describe('warm start OFF (default)', () => {
  it('live LOC subscribes keep NextGroupStart and no joining FETCH is issued', async () => {
    const { player, adapter, subscribeCalls } = await bootPlayer(locCatalog([VIDEO_LOC, AUDIO_LOC]));

    expect(adapter.joiningFetch).not.toHaveBeenCalled();
    for (const name of ['video', 'audio']) {
      const call = subscribeCalls().find(([n]: [string, unknown]) => n === name);
      expect(call![1]?.subscriptionFilter?.type).toBe('NextGroupStart');
    }
    await player.destroy();
  });
});
