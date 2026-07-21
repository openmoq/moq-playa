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

describe('warm start — races against the joiningFetch() await window', () => {
  const FETCH_REQ = 600n;

  function deferredJoin() {
    let resolveJoin!: (v: unknown) => void;
    const mutate = (a: ReturnType<typeof createMockAdapter>) => {
      a.joiningFetch = vi.fn(() => new Promise((r) => { resolveJoin = r; }));
    };
    return { mutate, resolve: () => resolveJoin(varint(FETCH_REQ)) };
  }

  it('FIN racing registration: a complete early stream still replays its pre-roll once registered', async () => {
    const routed: Array<{ alias: bigint; objectId: bigint }> = [];
    const d = deferredJoin();
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ alias: BigInt(obj.trackAlias), objectId: BigInt(obj.objectId) });
          return obj;
        },
      }, d.mutate);
    const videoReqId = (await reqIdFor('video'))!;

    // Fast cached fetch: stream opens, delivers everything, and FINs — all
    // before the joiningFetch() promise continuation registers the request.
    const streamId = 88n;
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(FETCH_REQ) } });
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(2n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(2n), subgroupId: varint(0),
      objectId: varint(1n), payload: new Uint8Array([0x02]),
    } as MoqtObject);
    adapter._triggerStreamClosed(streamId); // FIN before registration
    expect(routed).toEqual([]);

    d.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(routed).toEqual([
      { alias: videoReqId, objectId: 0n },
      { alias: videoReqId, objectId: 1n },
    ]);
    await player.destroy();
  });

  it('REQUEST_ERROR racing registration: the refusal is honored, nothing leaks or routes later', async () => {
    const routed: Array<{ objectId: bigint }> = [];
    const d = deferredJoin();
    const { player, adapter, errors } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ objectId: BigInt(obj.objectId) });
          return obj;
        },
      }, d.mutate);

    // The refusal lands while the request ID is still in flight.
    adapter._triggerMessage({
      type: 'REQUEST_ERROR', requestId: varint(FETCH_REQ),
      errorCode: 0x11n, retryInterval: 0n, errorReason: 'no objects published',
    } as unknown as ControlMessage);

    d.resolve();
    await new Promise((r) => setTimeout(r, 20));

    // A later data stream claiming that request ID must NOT route (the fetch
    // was refused; registering it anyway would resurrect a dead request).
    const streamId = 89n;
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(FETCH_REQ) } });
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(2n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));

    expect(routed).toEqual([]);
    expect(errors.filter((e) => e.severity === 'fatal')).toEqual([]); // non-fatal throughout
    await player.destroy();
  });

  it('alias remap racing registration: fetched objects route to the POST-remap alias', async () => {
    const routed: Array<{ alias: bigint; objectId: bigint }> = [];
    const d = deferredJoin();
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ alias: BigInt(obj.trackAlias), objectId: BigInt(obj.objectId) });
          return obj;
        },
      }, d.mutate);
    const videoReqId = (await reqIdFor('video'))!;
    const newAlias = videoReqId + 500n;

    // SUBSCRIBE_OK remaps the alias while joiningFetch() is still in flight.
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: varint(videoReqId), trackAlias: varint(newAlias), parameters: new Map(),
    } as unknown as ControlMessage);
    d.resolve();
    await new Promise((r) => setTimeout(r, 20));

    const streamId = 90n;
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(FETCH_REQ) } });
    adapter._triggerObject(streamId, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(2n), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));

    expect(routed).toEqual([{ alias: newAlias, objectId: 0n }]);
    await player.destroy();
  });
});

describe('warm start — lifecycle hardening', () => {
  it('pendingFetchStreams is BOUNDED: a peer cycling unknown fetch streams cannot grow it forever', async () => {
    const routed: Array<{ objectId: bigint }> = [];
    let resolveJoin!: (v: unknown) => void;
    const { player, adapter } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ objectId: BigInt(obj.objectId) });
          return obj;
        },
      }, (a) => { a.joiningFetch = vi.fn(() => new Promise((r) => { resolveJoin = r; })); });

    // Flood: 40 unknown fetch streams with distinct request IDs, each buffering
    // one object. The oldest entries must be evicted, not retained for the
    // session lifetime.
    for (let i = 0; i < 40; i++) {
      const sid = 1000n + BigInt(i);
      adapter._triggerDataStream(sid, { type: 'fetch', header: { requestId: varint(2000n + BigInt(i)) } });
      adapter._triggerObject(sid, {
        kind: 'data', trackAlias: varint(0n), groupId: varint(0), subgroupId: varint(0),
        objectId: varint(BigInt(i)), payload: new Uint8Array([i]),
      } as MoqtObject);
    }
    // The REAL fetch (request 2000, the FIRST/oldest) was evicted by the flood:
    // registering it must replay nothing.
    resolveJoin(varint(2000n));
    await new Promise((r) => setTimeout(r, 20));
    expect(routed).toEqual([]);
    // Bounded-map contract, asserted directly: the pending map never exceeds
    // its bound and the tombstone set only holds still-open evictees.
    const internals = player as unknown as {
      droppedFetchStreams: Set<bigint>;
      pendingFetchStreams: Map<bigint, unknown>;
    };
    expect(internals.pendingFetchStreams.size).toBeLessThanOrEqual(8);
    expect(internals.droppedFetchStreams.size).toBe(40 - internals.pendingFetchStreams.size);
    await player.destroy();
  });

  it('objects on an EVICTED fetch stream are swallowed — never routed as wire alias 0', async () => {
    // A LOC catalog track can plausibly sit at alias 0 (requestId-as-alias);
    // an overflowed fetch stream's later objects must not fall through the
    // alias path and misroute into it. The tombstone survives until FIN.
    const routed: Array<{ alias: bigint }> = [];
    const { player, adapter } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ alias: BigInt(obj.trackAlias) });
          return obj;
        },
      }, (a) => { a.joiningFetch = vi.fn(() => new Promise(() => { /* never resolves */ })); });

    // Make wire alias 0 a REAL media route: the video track remaps to alias 0
    // via SUBSCRIBE_OK — exactly the collision that turns fall-through into a
    // misroute.
    const videoReqId = 2n; // first media subscribe after catalog (1n)
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: varint(videoReqId), trackAlias: varint(0n), parameters: new Map(),
    } as unknown as ControlMessage);
    await new Promise((r) => setTimeout(r, 10));
    const before = routed.length;

    // Flood past the bound so the first stream is evicted.
    for (let i = 0; i < 12; i++) {
      adapter._triggerDataStream(3000n + BigInt(i), { type: 'fetch', header: { requestId: varint(4000n + BigInt(i)) } });
    }
    // The evicted (oldest) stream sends another object with wire alias 0 —
    // without a tombstone it would route INTO the video track.
    adapter._triggerObject(3000n, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    expect(routed.length).toBe(before); // swallowed, not misrouted
    await player.destroy();
  });

  it('public fetch() REJECTS when completion crosses destroy() (no false success with a dead request ID)', async () => {
    let resolveFetch!: (v: unknown) => void;
    const { player, adapter } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {},
      (a) => { a.fetch = vi.fn(() => new Promise((r) => { resolveFetch = r; })); });

    const fetchPromise = player.fetch('video', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
    await player.destroy();
    resolveFetch(varint(900n));

    await expect(fetchPromise).rejects.toThrow(/destroyed|migrat|abort/i);
    expect(adapter.fetchCancel).toHaveBeenCalled(); // best-effort cancel on the old connection
  });

  it('repeated header→FIN→overflow cycles leave no permanent tombstones (finished evictees skip the set)', async () => {
    const routed: Array<{ objectId: bigint }> = [];
    const { player, adapter, reqIdFor } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        objectTransform: (obj) => {
          if (obj.kind === 'data') routed.push({ objectId: BigInt(obj.objectId) });
          return obj;
        },
      }, (a) => { a.joiningFetch = vi.fn(() => new Promise(() => { /* pending forever */ })); });
    const videoReqId = (await reqIdFor('video'))!;

    // 50 cycles: unknown fetch stream opens, FINs immediately, then later
    // overflows out of the pending map. FINished evictees must NOT tombstone.
    for (let i = 0; i < 50; i++) {
      const sid = 5000n + BigInt(i);
      adapter._triggerDataStream(sid, { type: 'fetch', header: { requestId: varint(6000n + BigInt(i)) } });
      adapter._triggerStreamClosed(sid); // FIN before any eviction
    }
    // Direct map contract — alias registration cannot mask a stale tombstone
    // here: FINished evictees leave ZERO tombstones, and the pending map stays
    // at its bound regardless of how many cycles ran.
    const internals = player as unknown as {
      droppedFetchStreams: Set<bigint>;
      pendingFetchStreams: Map<bigint, unknown>;
    };
    expect(internals.droppedFetchStreams.size).toBe(0);
    expect(internals.pendingFetchStreams.size).toBeLessThanOrEqual(8);
    // The maps stay functional: a REAL fetch flow on a reused/new stream id
    // still registers and routes (nothing clogged, nothing mis-tombstoned).
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: varint(videoReqId), trackAlias: varint(videoReqId), parameters: new Map(),
    } as unknown as ControlMessage);
    // Use player.fetch (standalone) for a registered fetch that routes.
    const p = player.fetch('video', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
    const fetchReqId = BigInt(await p);
    const sid = 5000n; // REUSED id from a FINished cycle — must not be tombstoned
    adapter._triggerDataStream(sid, { type: 'fetch', header: { requestId: varint(fetchReqId) } });
    adapter._triggerObject(sid, {
      kind: 'data', trackAlias: varint(0n), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0n), payload: new Uint8Array([0x01]),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 10));
    expect(routed).toEqual([{ objectId: 0n }]); // routed — no stale tombstone swallowed it
    await player.destroy();
  });

  it('a joiningFetch completing after destroy() does not repopulate the player', async () => {
    let resolveJoin!: (v: unknown) => void;
    const { player, adapter } = await bootPlayer(
      locCatalog([VIDEO_LOC]), { warmStartCurrentGroup: true },
      (a) => { a.joiningFetch = vi.fn(() => new Promise((r) => { resolveJoin = r; })); });

    await player.destroy();          // clears all fetch state
    resolveJoin(varint(700n));       // late completion crosses destroy
    await new Promise((r) => setTimeout(r, 20));

    // A data stream for the late request must not route anywhere (no revived
    // registration in the destroyed player's maps).
    expect(() => {
      adapter._triggerDataStream(44n, { type: 'fetch', header: { requestId: varint(700n) } });
      adapter._triggerObject(44n, {
        kind: 'data', trackAlias: varint(0n), groupId: varint(0), subgroupId: varint(0),
        objectId: varint(0n), payload: new Uint8Array([1]),
      } as MoqtObject);
    }).not.toThrow();
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

describe('warm start — configured SUBSCRIBE options are preserved', () => {
  it('keeps deliveryTimeout, subscriberPriority, and groupOrder while overriding only the filter', async () => {
    const { player, adapter, subscribeCalls } = await bootPlayer(
      locCatalog([VIDEO_LOC]), {
        warmStartCurrentGroup: true,
        deliveryTimeoutMs: 2_000,
        subscriberPriority: 64,
        groupOrder: 'descending',
      });
    const call = subscribeCalls().find(([n]: [string, unknown]) => n === 'video');
    const opts = call![1];
    expect(opts?.subscriptionFilter?.type).toBe('LargestObject'); // the one override
    expect(opts?.deliveryTimeout).toBeDefined();                  // preserved
    expect(opts?.subscriberPriority).toBeDefined();               // preserved
    expect(opts?.groupOrder).toBeDefined();                       // preserved
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
