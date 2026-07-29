/**
 * Player-level catalog bootstrap wiring (MSF-01 §5 SUBSCRIBE + Joining FETCH).
 *
 * The convergence state machine has its own unit suite
 * (catalog-bootstrap.test.ts); this file proves the WIRE: subscribe options
 * chosen atomically with the join, pre-send ownership, drain opt-in,
 * fetch-stream routing, fallback wire behavior, coexistence with
 * fetchCatalog()/warm start/knownTracks, per-draft defaults, and teardown.
 *
 * @see draft-ietf-moq-msf-01 §5, draft-ietf-moq-transport-16 §9.16.2
 */

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject, DataStreamHeader } from '@moqt/transport';
import { varint } from '@moqt/transport';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const CATALOG = {
    version: 'draft-01',
    tracks: [
        { name: 'video', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video',
          codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000 },
        { name: 'audio', packaging: 'loc', renderGroup: 1, isLive: true, role: 'audio',
          codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 },
    ],
};

/** Mock adapter honoring adapter-level option callbacks (onRequestId). */
function createMockAdapter(draft: 14 | 16 | 18 = 16) {
    let nextRequestId = 1n;
    const adapter: any = {
        draftVersion: draft,
        onMessage: null, onClose: null, onError: null, onDataStream: null,
        onObject: null, onStreamClosed: null, onDatagram: null,
        onNamespaceMessage: null, onQlogEvent: null,
        _connectResolve: null,
        connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
        close: vi.fn(async () => { /* noop */ }),
        subscribe: vi.fn(async (_ns: unknown, _name: unknown, options?: { onRequestId?: (id: bigint) => void }) => {
            const id = nextRequestId; nextRequestId += 2n;
            options?.onRequestId?.(id);           // pre-send ownership, adapter-faithful
            return varint(id);
        }),
        joiningFetch: vi.fn(async (options?: { onRequestId?: (id: bigint) => void }) => {
            const id = nextRequestId; nextRequestId += 2n;
            options?.onRequestId?.(id);
            return varint(id);
        }),
        fetch: vi.fn(async (_ns: unknown, _name: unknown, options?: { onRequestId?: (id: bigint) => void }) => {
            const id = nextRequestId; nextRequestId += 2n;
            options?.onRequestId?.(id);
            return varint(id);
        }),
        fetchCancel: vi.fn(async () => { /* noop */ }),
        unsubscribe: vi.fn(async () => { /* noop */ }),
        requestUpdate: vi.fn(async () => { /* noop */ }),
        trackStatus: vi.fn(async () => varint(99n)),
        subscribeNamespace: vi.fn(async () => varint(98n)),
        cancelNamespace: vi.fn(async () => { /* noop */ }),
        publishDone: vi.fn(async () => { /* noop */ }),
        _triggerMessage: (msg: ControlMessage) => adapter.onMessage?.(msg),
        _triggerObject: (streamId: bigint, obj: MoqtObject) => adapter.onObject?.(streamId, obj),
        _triggerDataStream: (streamId: bigint, header: DataStreamHeader) => adapter.onDataStream?.(streamId, header),
        _triggerStreamClosed: (streamId: bigint, error?: number) => adapter.onStreamClosed?.(streamId, error),
        _triggerClose: (error?: number, reason?: string) => adapter.onClose?.(error, reason),
    };
    return adapter;
}

function makePlayer(adapter: ReturnType<typeof createMockAdapter>, cfg?: Partial<MoqtPlayerConfig>) {
    return new MoqtPlayer({
        url: 'https://relay.example.com/moq',
        namespace: 'live/broadcast',
        createTransport: vi.fn(async () => ({}) as never),
        createConnection: () => adapter as unknown as MoqtConnection,
        ...cfg,
    });
}

async function loadPlayer(adapter: ReturnType<typeof createMockAdapter>, cfg?: Partial<MoqtPlayerConfig>) {
    const player = makePlayer(adapter, cfg);
    const events: string[] = [];
    player.on('catalog_received', () => events.push('catalog_received'));
    player.on('catalog_updated', () => events.push('catalog_updated'));
    const errors: unknown[] = [];
    player.on('error', (e) => errors.push(e.error));
    const loadPromise = player.load();
    await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
    adapter._connectResolve?.();
    await loadPromise;
    return { player, events, errors };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** SUBSCRIBE_OK for the catalog subscription (no LARGEST_OBJECT parameter). */
function ackCatalog(adapter: ReturnType<typeof createMockAdapter>, reqId = 1n, alias = 1n): void {
    adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: varint(reqId), trackAlias: varint(alias),
        parameters: new Map(), trackExtensions: [],
    } as unknown as ControlMessage);
}

/** Deliver a fetch-stream catalog object for the given fetch reqId. */
async function deliverFetchObject(
    adapter: ReturnType<typeof createMockAdapter>,
    fetchReqId: bigint, streamId: bigint, groupId: bigint, objectId: bigint, payload: Uint8Array,
): Promise<void> {
    adapter._triggerDataStream(streamId, { type: 'fetch', header: { requestId: varint(fetchReqId) } } as unknown as DataStreamHeader);
    adapter._triggerObject(streamId, {
        kind: 'data', trackAlias: varint(0n), groupId: varint(groupId), subgroupId: varint(0n),
        objectId: varint(objectId), publisherPriority: 128, extensions: undefined, payload,
    } as unknown as MoqtObject);
    await flush();
}

describe('catalog bootstrap wiring — subscribe + join', () => {
    it('#2/#22: default auto on d16 → catalog subscribe LargestObject + relative join offset 0 referencing it, chosen atomically', async () => {
        const adapter = createMockAdapter(16);
        await loadPlayer(adapter);
        await flush();
        const subOpts = adapter.subscribe.mock.calls[0]![2];
        expect(subOpts.subscriptionFilter.type).toBe('LargestObject');
        // The joining fetch references the catalog subscription's request id.
        expect(adapter.joiningFetch).toHaveBeenCalledTimes(1);
        const join = adapter.joiningFetch.mock.calls[0]![0];
        expect(join.joiningFetchType).toBe('relative');
        expect(BigInt(join.joiningRequestId)).toBe(1n);
        expect(join.joiningStart).toBe(0n);
        // 10b: ascending group order explicit on bootstrap fetches.
        expect(BigInt(join.groupOrder)).toBe(0x1n);
    });

    it('#4c: the catalog subscribe carries the terminal-drain opt-in AND onDrained', async () => {
        const adapter = createMockAdapter(16);
        await loadPlayer(adapter);
        const subOpts = adapter.subscribe.mock.calls[0]![2];
        expect(subOpts.terminalDelivery).toBe('drain');
        expect(typeof subOpts.onDrained).toBe('function');
        expect(typeof subOpts.onRequestId).toBe('function');
    });

    it('#3: the join fires against the PENDING subscription (no SUBSCRIBE_OK yet)', async () => {
        const adapter = createMockAdapter(16);
        await loadPlayer(adapter);
        await flush();
        // No ackCatalog was sent — the join was still issued.
        expect(adapter.joiningFetch).toHaveBeenCalledTimes(1);
    });

    it('#1 guard: explicit "subscribe" reproduces today\'s exact wire behavior', async () => {
        const adapter = createMockAdapter(16);
        await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        const subOpts = adapter.subscribe.mock.calls[0]![2];
        expect(subOpts.subscriptionFilter.type).toBe('AbsoluteStart');
        expect(BigInt(subOpts.subscriptionFilter.startGroup)).toBe(0n);
        expect(BigInt(subOpts.subscriptionFilter.startObject)).toBe(0n);
        // Terminal-drain semantics apply in legacy mode too — adapter-local
        // options (stripped before Session), wire bytes unchanged.
        expect(subOpts.terminalDelivery).toBe('drain');
        expect(typeof subOpts.onDrained).toBe('function');
        expect(adapter.joiningFetch).not.toHaveBeenCalled();
    });

    it('#25: d14 auto AND explicit joining-fetch both join — after SUBSCRIBE_OK (§9.16.2 active-subscription rule)', async () => {
        // MSF-01 §5's retrieval MUST applies on every draft: d14 auto issues
        // the joining fetch too, sequenced after SUBSCRIBE_OK.
        for (const cfg of [
            { draftVersion: 14 as const },
            { draftVersion: 14 as const, catalogBootstrap: 'joining-fetch' as const },
        ]) {
            const a = createMockAdapter(14);
            await loadPlayer(a, cfg);
            await flush();
            expect(a.joiningFetch).not.toHaveBeenCalled();   // existing subscription required
            const opts = a.subscribe.mock.calls[0]![2];
            expect(opts.subscriptionFilter.type).toBe('LargestObject');
            ackCatalog(a);
            await flush();
            expect(a.joiningFetch).toHaveBeenCalledTimes(1);
        }
        // The legacy escape hatch is EXPLICIT now: 'subscribe' keeps d14
        // byte-identical AbsoluteStart with no fetch.
        const legacy = createMockAdapter(14);
        await loadPlayer(legacy, { draftVersion: 14, catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(legacy);
        await flush();
        expect(legacy.joiningFetch).not.toHaveBeenCalled();
        expect(legacy.subscribe.mock.calls[0]![2].subscriptionFilter.type).toBe('AbsoluteStart');
    });
});

describe('catalog bootstrap wiring — convergence end-to-end', () => {
    it('#4/#7: fetched head+delta then FETCH_OK+FIN → ONE catalog_received; live delta → catalog_updated', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        await deliverFetchObject(adapter, 3n, 100n, 5n, 1n, enc({
            deltaUpdate: [{ op: 'add', tracks: [{ name: 'captions', packaging: 'loc', renderGroup: 1, isLive: true }] }],
        }));
        expect(events).toEqual([]);                        // prefix incomplete
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(2n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(events).toEqual([]);                        // FETCH_OK alone ≠ complete
        adapter._triggerStreamClosed(100n);                // clean FIN
        await flush();
        expect(events).toEqual(['catalog_received']);      // converged, once
        expect(errors).toEqual([]);

        // Live delta after readiness (on the catalog alias).
        adapter._triggerObject(200n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(2n), publisherPriority: 128, extensions: undefined,
            payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'hd', packaging: 'loc', renderGroup: 1, isLive: true }] }] }),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('#5/#8 race: ownership is pre-send — data + FIN + FETCH_OK racing the joiningFetch() continuation are all owned', async () => {
        const adapter = createMockAdapter(16);
        // Real-adapter shape: onRequestId fires SYNCHRONOUSLY inside the call
        // (post-allocation, pre-emission); the returned promise settles later.
        let settleJoin: (() => void) | null = null;
        adapter.joiningFetch = vi.fn((options: { onRequestId?: (id: bigint) => void }) => {
            options.onRequestId?.(3n);                     // pre-send ownership
            return new Promise<unknown>((resolve) => { settleJoin = () => resolve(varint(3n)); });
        });
        const { events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        // Everything arrives BEFORE the await continuation resolves — all owned.
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);      // no loss, no parking limbo
        settleJoin!();
        await flush();
        expect(events).toEqual(['catalog_received']);      // late continuation is a no-op
    });

    it('#14: fetch REQUEST_ERROR INVALID_RANGE → no resubscribe; first live head completes', async () => {
        const adapter = createMockAdapter(16);
        const { events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x11n),
            retryInterval: varint(0n), errorReason: 'no objects',
        } as unknown as ControlMessage);
        await flush();
        expect(adapter.subscribe).toHaveBeenCalledTimes(1);   // catalog only, no resubscribe
        adapter._triggerObject(300n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
    });

    it('#17b: refusal WITHOUT a known largest → rung-2 legacy resubscribe (AbsoluteStart)', async () => {
        const adapter = createMockAdapter(16);
        await loadPlayer(adapter);
        await flush();
        // No SUBSCRIBE_OK largest exists → rung 1 is skipped by design and the
        // refusal falls through to rung 2. (The rung-1 wire shape with a known
        // largest is asserted in the F5/F8 test below.)
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x10n),
            retryInterval: varint(0n), errorReason: 'track not found',
        } as unknown as ControlMessage);
        await flush(); await flush();
        // Rung 2: unsubscribe the LargestObject sub, fresh AbsoluteStart{0,0}.
        expect(adapter.unsubscribe).toHaveBeenCalledTimes(1);
        expect(adapter.subscribe).toHaveBeenCalledTimes(2);
        const resub = adapter.subscribe.mock.calls[1]![2];
        expect(resub.subscriptionFilter.type).toBe('AbsoluteStart');
    });

    it('#19/#26: fetchCatalog() runs concurrently with an active bootstrap — both streams route independently', async () => {
        const adapter = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);

        // Standalone fetchCatalog on its own request/stream.
        const fetchPromise = player.fetchCatalog({ timeoutMs: 500 });
        await flush();
        const standaloneReqId = 5n;                        // 1=subscribe, 3=join, 5=fetchCatalog
        adapter._triggerDataStream(400n, { type: 'fetch', header: { requestId: varint(standaloneReqId) } } as unknown as DataStreamHeader);
        adapter._triggerObject(400n, {
            kind: 'data', trackAlias: varint(0n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        const snapshot = await fetchPromise;
        expect(snapshot.tracks.map((t) => t.name)).toEqual(['video', 'audio']);
        expect(events).toEqual([]);                        // side-effect-free: no catalog_received

        // The bootstrap fetch still converges normally afterwards.
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);
    });

    it('#27: warm start + bootstrap coexist — 2 media joins + 1 catalog join, media bookkeeping clean', async () => {
        const adapter = createMockAdapter(16);
        const { events } = await loadPlayer(adapter, { warmStartCurrentGroup: true });
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);
        for (let i = 0; i < 6; i++) await flush();
        // Catalog join + one per live LOC media track.
        expect(adapter.joiningFetch.mock.calls.length).toBe(3);
        const joined = adapter.joiningFetch.mock.calls.map((c: unknown[]) => BigInt((c[0] as { joiningRequestId: bigint }).joiningRequestId));
        expect(joined[0]).toBe(1n);                        // catalog first
    });

    it('#21f3: d14 PUBLISH_DONE 0x7 (MALFORMED_TRACK) → fatal; d16 0x7 is unknown → retriable, not fatal', async () => {
        const a1 = createMockAdapter(14);
        const r1 = await loadPlayer(a1, { draftVersion: 14, catalogBootstrap: 'joining-fetch' });
        await flush();
        ackCatalog(a1);
        await flush();
        a1._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x7n),
            streamCount: varint(0n), errorReason: 'malformed',
        } as unknown as ControlMessage);
        await flush();
        expect(r1.errors.length).toBeGreaterThan(0);       // fatal-track surfaced

        const a2 = createMockAdapter(16);
        const r2 = await loadPlayer(a2);
        await flush();
        ackCatalog(a2);
        a2._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x7n),
            streamCount: varint(0n), errorReason: 'unknown-code',
        } as unknown as ControlMessage);
        await flush();
        expect(r2.errors).toEqual([]);                     // unknown on d16 → retriable, deferred to drain
    });

    it('#22: destroy() mid-bootstrap — late fetch traffic is inert, no unhandled rejections', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, errors } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await player.destroy();
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual([]);
        expect(errors).toEqual([]);
    });
});

describe('catalog bootstrap wiring — review-finding coverage', () => {
    /** SUBSCRIBE_OK carrying a d18-style TYPED largest location. */
    function ackCatalogWithLargest(adapter: ReturnType<typeof createMockAdapter>, group: bigint, object: bigint): void {
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map([[varint(0x09n), [{ group, object }]]]),  // MessageParam.LARGEST_OBJECT
            trackExtensions: [],
        } as unknown as ControlMessage);
    }

    it('F5+F8a: a SUBSCRIBE_OK typed largest that beats the join continuation anchors rung 1', async () => {
        const adapter = createMockAdapter(16);
        // The joining fetch is refused; the largest arrived FIRST (even before
        // the join continuation) and must anchor the rung-1 standalone fetch.
        adapter.subscribe = vi.fn(async (_ns: unknown, _name: unknown, options?: { onRequestId?: (id: bigint) => void }) => {
            options?.onRequestId?.(1n);
            // SUBSCRIBE_OK delivered synchronously after emission — before any
            // continuation runs. The coordinator must already be installed.
            queueMicrotask(() => ackCatalogWithLargest(adapter, 6n, 4n));
            return varint(1n);
        });
        adapter.joiningFetch = vi.fn(async (options?: { onRequestId?: (id: bigint) => void }) => {
            options?.onRequestId?.(3n);
            return varint(3n);
        });
        await loadPlayer(adapter);
        await flush(); await flush();
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x10n),
            retryInterval: varint(0n), errorReason: 'track not found',
        } as unknown as ControlMessage);
        await flush(); await flush();
        // Rung 1: standalone fetch anchored at the SUBSCRIBE_OK largest, using
        // the whole-group End.Object=0 encoding; live sub RETAINED (no churn).
        expect(adapter.unsubscribe).not.toHaveBeenCalled();
        expect(adapter.fetch).toHaveBeenCalledTimes(1);
        const fetchOpts = adapter.fetch.mock.calls[0]![2];
        expect(BigInt(fetchOpts.startGroup)).toBe(6n);
        expect(BigInt(fetchOpts.startObject)).toBe(0n);
        expect(BigInt(fetchOpts.endGroup)).toBe(6n);
        expect(BigInt(fetchOpts.endObject)).toBe(0n);      // whole-group form
    });

    it('the rung-2 resubscribe carries pre-send ownership AND the terminal drain', async () => {
        const adapter = createMockAdapter(16);
        await loadPlayer(adapter);
        await flush();
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x10n),
            retryInterval: varint(0n), errorReason: 'refused',
        } as unknown as ControlMessage);
        await flush(); await flush();
        expect(adapter.subscribe).toHaveBeenCalledTimes(2);
        const resubOpts = adapter.subscribe.mock.calls[1]![2];
        expect(resubOpts.subscriptionFilter.type).toBe('AbsoluteStart');
        expect(typeof resubOpts.onRequestId).toBe('function');
        expect(resubOpts.terminalDelivery).toBe('drain');
        expect(typeof resubOpts.onDrained).toBe('function');
    });

    it('bootstrap follows the NEGOTIATED draft — auto-negotiated d14 defers the join to SUBSCRIBE_OK despite config 16', async () => {
        const adapter = createMockAdapter(14);       // negotiated draft is 14
        await loadPlayer(adapter, { draftVersion: 16 });
        await flush();
        // d16 would have joined immediately (Pending association is legal);
        // the NEGOTIATED d14 must wait for the active subscription.
        expect(adapter.joiningFetch).not.toHaveBeenCalled();
        ackCatalog(adapter);
        await flush();
        expect(adapter.joiningFetch).toHaveBeenCalledTimes(1);
    });

    it('retriable DONE post-ready → staged recovery: candidate adopts atomically, active untouched until then', async () => {
        const adapter = createMockAdapter(16);
        const { events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);

        // TOO_FAR_BEHIND (0x6 on d16) → retriable; drained finalizes → recovery.
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);                     // adapter drain completes
        await flush(); await flush();

        // Candidate subscription (fresh reqId) with bootstrap options — media
        // subscribes from readiness sit between, so filter by shape.
        const catalogSubs = adapter.subscribe.mock.calls.filter(
            (c: unknown[]) => (c[2] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'LargestObject');
        expect(catalogSubs).toHaveLength(2);
        const candOpts = catalogSubs[1]![2];
        expect(candOpts.subscriptionFilter.type).toBe('LargestObject');
        expect(candOpts.terminalDelivery).toBe('drain');
        await flush();
        // Candidate join issued (2nd joiningFetch overall).
        expect(adapter.joiningFetch).toHaveBeenCalledTimes(2);
        const candJoin = adapter.joiningFetch.mock.calls[1]![0];
        const candSubReqId = BigInt(candJoin.joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);

        // Candidate SUBSCRIBE_OK, prefix served, converges → ADOPTION.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc({
            version: 'draft-01',
            tracks: [{ name: 'video', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video',
                codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000 },
            { name: 'audio2', packaging: 'loc', renderGroup: 1, isLive: true, role: 'audio',
                codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 }],
        }));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();

        // Adoption = ordinary catalog update: ONE catalog_received total, then
        // an update; no media churn at the adoption itself.
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('candidate failure leaves the active catalog untouched, degraded diagnostic, no second candidate', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candidateSubs = () => adapter.subscribe.mock.calls.filter(
            (c: unknown[]) => (c[2] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'LargestObject').length;
        expect(candidateSubs()).toBe(2);                      // initial + candidate

        // Candidate's join AND its rung-1 fetch both refused → ladder exhausts
        // → candidate failure, NOT another resubscribe loop.
        const candJoinId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(candJoinId), errorCode: varint(0x10n),
            retryInterval: varint(0n), errorReason: 'refused',
        } as unknown as ControlMessage);
        await flush(); await flush();
        expect(errors.length).toBeGreaterThan(0);             // degraded surfaced
        expect(candidateSubs()).toBe(2);                      // NO recursive candidate
        expect(events).toEqual(['catalog_received']);         // active untouched
    });

    it('#23f-race2: object + clean FIN before alias resolution replay as clean evidence', async () => {
        const adapter = createMockAdapter(16);
        const { events } = await loadPlayer(adapter);
        await flush();
        // Live catalog object arrives on an UNRESOLVED alias, then its stream
        // FINs cleanly — both before SUBSCRIBE_OK.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        adapter._triggerStreamClosed(700n);
        await flush();
        expect(events).toEqual([]);                           // still parked
        ackCatalog(adapter);                                   // alias resolves → replay incl. lifecycle
        await flush();
        // The replayed object supersedes (no largest) → ready — proving the
        // object survived parking; the replayed clean FIN keeps the stream's
        // evidence positive (asserted structurally: no reset-dirty diagnostics).
        expect(events).toEqual(['catalog_received']);
    });
});

describe('catalog bootstrap wiring — staged-recovery races (F1/F2/F4/F5/F6)', () => {
    /** Bring a player to READY, then trigger retriable DONE + drain → candidate. */
    async function toCandidate(adapter: ReturnType<typeof createMockAdapter>) {
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        return { ...loaded, candSubReqId, candFetchReqId };
    }

    /** Complete the candidate's prefix → adoption. */
    async function adoptCandidate(
        adapter: ReturnType<typeof createMockAdapter>,
        candSubReqId: bigint, candFetchReqId: bigint, alias: bigint,
    ): Promise<void> {
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(alias),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
    }

    it('the ADOPTED coordinator stays live — post-adoption deltas update state; a further retriable DONE degrades (one per generation)', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, candSubReqId, candFetchReqId } = await toCandidate(adapter);
        await adoptCandidate(adapter, candSubReqId, candFetchReqId, 9n);
        expect(events).toEqual(['catalog_received', 'catalog_updated']);   // adoption

        // Post-adoption LIVE DELTA on the candidate's alias must apply.
        adapter._triggerObject(600n, {
            kind: 'data', trackAlias: varint(9n), groupId: varint(8n), subgroupId: varint(0n),
            objectId: varint(1n), publisherPriority: 128, extensions: undefined,
            payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'late', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated', 'catalog_updated']);

        // A SECOND retriable DONE (on the adopted subscription) must not be
        // inert: it reports degraded (one recovery per generation).
        const candOpts = adapter.subscribe.mock.calls.find(
            (c: unknown[]) => (c[2] as { onDrained?: unknown })?.onDrained !== undefined
                && (c[2] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'LargestObject'
                && adapter.subscribe.mock.calls.indexOf(c) > 0)?.[2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(candSubReqId), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'again',
        } as unknown as ControlMessage);
        candOpts.onDrained(candSubReqId);
        await flush();
        expect(errors.length).toBeGreaterThan(0);   // NOT silently inert
    });

    it('F2/F6 (21i3b): retired-alias traffic racing the candidate SUBSCRIBE_OK parks and replays ONLY into the candidate', async () => {
        const adapter = createMockAdapter(16);
        const { events, candSubReqId, candFetchReqId } = await toCandidate(adapter);
        // The publisher REUSES the retired alias (1n): its first stream lands
        // BEFORE the candidate's SUBSCRIBE_OK — parked, and crucially NOT
        // applied to the active catalog.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined,
            payload: enc({ version: 'draft-01', tracks: [{ name: 'reused', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 500_000 }] }),
        } as unknown as MoqtObject);
        adapter._triggerStreamClosed(700n);          // clean FIN, pre-OK
        await flush();
        expect(events).toEqual(['catalog_received']); // active untouched, parked

        // Candidate SUBSCRIBE_OK binds the SAME (reused) alias → parked object
        // replays into the CANDIDATE, which reaches readiness → adoption.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(1n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush(); await flush();
        // (The candidate's fetch is still open; the replayed independent at a
        // NEWER group supersedes it: fetchCancel + adoption.)
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
        void candFetchReqId;
    });

    it('a refused candidate SUBSCRIBE fails the candidate — active retained, degraded surfaced', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, candSubReqId } = await toCandidate(adapter);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(candSubReqId), errorCode: varint(0x1n),
            retryInterval: varint(0n), errorReason: 'unauthorized',
        } as unknown as ControlMessage);
        await flush();
        expect(errors.length).toBeGreaterThan(0);
        expect(events).toEqual(['catalog_received']);   // active untouched
    });

    it('recovery parking overflow aborts the candidate; active preserved', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await toCandidate(adapter);
        // Flood the retired alias pre-OK beyond the object bound.
        for (let i = 0; i < 260; i++) {
            adapter._triggerObject(BigInt(800 + i), {
                kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined,
                payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: `t${i}`, packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
            } as unknown as MoqtObject);
        }
        await flush();
        expect(errors.length).toBeGreaterThan(0);       // fail-closed abort
        expect(events).toEqual(['catalog_received']);   // active untouched
    });

    it('a superseded session can neither settle current fetch state nor alias-route its fetch-stream objects', async () => {
        const adapter = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);

        // A one-shot fetchCatalog registers its data stream (id 200).
        const fc = player.fetchCatalog({ timeoutMs: 4000 });
        await flush();
        const fcReqId = BigInt(await adapter.fetch.mock.results[adapter.fetch.mock.results.length - 1]!.value);
        adapter._triggerDataStream(200n, { type: 'fetch', header: { requestId: varint(fcReqId) } } as unknown as DataStreamHeader);

        // MIGRATION SUPERSEDES this session: its callbacks now fire stale.
        const internals = player as unknown as { connection: unknown; pendingObjectsByAlias: Map<bigint, unknown[]> };
        const current = internals.connection;
        internals.connection = { draftVersion: 16 };

        // (a) A stale close with the COLLIDING stream id must not settle the
        // current session's pending fetchCatalog.
        adapter._triggerStreamClosed(200n);
        await flush();

        // (b) A stale fetch stream's objects carry wire alias 0 — they must be
        // discarded, never buffered/alias-routed on the current session.
        adapter._triggerDataStream(300n, { type: 'fetch', header: { requestId: varint(999n) } } as unknown as DataStreamHeader);
        adapter._triggerObject(300n, {
            kind: 'data', trackAlias: varint(0n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc({ junk: true }),
        } as unknown as MoqtObject);
        await flush();
        expect(internals.pendingObjectsByAlias.get(0n)).toBeUndefined();

        // Restored (i.e. delivered by the OWNING session), the close settles.
        internals.connection = current;
        adapter._triggerStreamClosed(200n);
        await expect(fc).rejects.toThrow(/closed without object/);
        expect(events).toEqual(['catalog_received']);
    });

    /** The candidate subscribe options (LargestObject + drain), found by shape. */
    function candidateSubOpts(adapter: ReturnType<typeof createMockAdapter>) {
        return adapter.subscribe.mock.calls.find(
            (c: unknown[], i: number) => i > 0
                && (c[2] as { onDrained?: unknown })?.onDrained !== undefined
                && (c[2] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'LargestObject')?.[2];
    }

    it('candidate readiness is HELD until SUBSCRIBE_OK binds the alias — the joining fetch completing on a Pending subscription does not adopt', async () => {
        const adapter = createMockAdapter(16);
        const { events, candSubReqId, candFetchReqId } = await toCandidate(adapter);
        // The candidate prefix completes while the subscription is still Pending.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);   // NOT adopted pre-bind
        // SUBSCRIBE_OK binds → adoption fires now.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('a candidate whose OWN feed already drained retriably is never adopted — active snapshot retained', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, candSubReqId, candFetchReqId } = await toCandidate(adapter);
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        // The candidate's subscription dies retriably and drains BEFORE its
        // prefix completes.
        const candOpts = candidateSubOpts(adapter);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(candSubReqId), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind again',
        } as unknown as ControlMessage);
        candOpts.onDrained(candSubReqId);
        await flush();
        // The prefix then completes — a DEAD candidate must not replace the
        // healthy active snapshot.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);   // no adoption
        expect(errors.length).toBeGreaterThan(0);       // degraded surfaced
    });

    it('once the candidate binds a different alias, retired-alias traffic PARKS for the next generation — it never mutates the active catalog', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, candSubReqId, candFetchReqId } = await toCandidate(adapter);
        const catalogs: string[][] = [];
        player.on('catalog_updated', (e) => catalogs.push(e.catalog.tracks.map((t: { name: string }) => t.name)));
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        // LATE traffic on the retired alias (1n): a NEWER-group independent
        // with a rogue track. Pre-retirement this would route into the active
        // coordinator and emit catalog_updated.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(10n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined,
            payload: enc({ version: 'draft-01', tracks: [{ name: 'rogue', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }] }),
        } as unknown as MoqtObject);
        adapter._triggerStreamClosed(700n);
        await flush();
        expect(events).toEqual(['catalog_received']);   // active untouched
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;
        // The traffic PARKS for whichever request next binds the alias (the
        // adapter freed it at drain completion) — it is never applied to the
        // active catalog and never dropped by a wall-clock rule.
        expect(pending.get(1n)).toHaveLength(1);
        // Adoption reflects the CANDIDATE catalog, never the rogue payload.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
        expect(catalogs[0]).not.toContain('rogue');
    });

    it('the recovery BYTE bound covers unknown-alias parking — overflow aborts the candidate and settles its ownership', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, errors, candSubReqId } = await toCandidate(adapter);
        // 5 × 1 MiB on an unknown alias (could be the candidate's, pre-OK) —
        // crosses the 4 MiB recovery bound; count alone (5) never would.
        const big = new Uint8Array(1024 * 1024);
        for (let i = 0; i < 5; i++) {
            adapter._triggerObject(BigInt(900 + i), {
                kind: 'data', trackAlias: varint(42n), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: big,
            } as unknown as MoqtObject);
        }
        await flush();
        expect(errors.length).toBeGreaterThan(0);       // fail-closed abort
        expect(events).toEqual(['catalog_received']);   // active untouched
        // Settlement: the CANDIDATE stops owning the speculative parking (it
        // can never replay on the candidate's behalf); entries survive only
        // for their concurrent MEDIA owners, whose own resolutions settle them.
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, { owners?: bigint[] }[]> }).pendingObjectsByAlias;
        for (const e of pending.get(42n) ?? []) {
            expect(e.owners ?? []).not.toContain(candSubReqId);
            expect((e.owners ?? []).length).toBeGreaterThan(0);   // never ownerless
        }
    });

    it('media subscription ownership is registered PRE-SEND — a same-tick SUBSCRIBE_OK alias remap is honored', async () => {
        const adapter = createMockAdapter(16);
        const td = new TextDecoder();
        const inner = adapter.subscribe;
        adapter.subscribe = vi.fn(async (ns: unknown, name: Uint8Array, options?: { onRequestId?: (id: bigint) => void }) => {
            const wrapped = {
                ...(options ?? {}),
                onRequestId: (id: bigint) => {
                    options?.onRequestId?.(id);
                    // A zero-latency SUBSCRIBE_OK with a SERVER-ASSIGNED alias,
                    // delivered before the subscribe() continuation resolves.
                    if (td.decode(name) === 'video') {
                        adapter._triggerMessage({
                            type: 'SUBSCRIBE_OK', requestId: varint(id), trackAlias: varint(77n),
                            parameters: new Map(), trackExtensions: [],
                        } as unknown as ControlMessage);
                    }
                },
            };
            return inner(ns, name, wrapped);
        });
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);
        // With post-await registration the remap would find no pending entry
        // and the server alias would never route.
        const sm = (player as unknown as { subscriptionManager: { getMediaType(a: bigint): unknown } }).subscriptionManager;
        expect(sm.getMediaType(77n)).toBe('video');
    });

    it('a warm-start joining FETCH that fails AFTER pre-send registration leaves no phantom fetch ownership', async () => {
        const adapter = createMockAdapter(16);
        let joinCalls = 0;
        let fetchIds = 51n;
        adapter.joiningFetch = vi.fn(async (options?: { onRequestId?: (id: bigint) => void }) => {
            const id = fetchIds; fetchIds += 2n;
            joinCalls += 1;
            options?.onRequestId?.(id);
            if (joinCalls > 1) throw new Error('request stream write failed'); // media warm fetches
            return varint(id);
        });
        const { player, events, errors } = await loadPlayer(adapter, { warmStartCurrentGroup: true });
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 51n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(51n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);
        // Both media warm fetches failed post-registration: the ownership was
        // reclaimed — no phantom entry can route raced traffic.
        expect(joinCalls).toBeGreaterThan(1);
        const active = (player as unknown as { activeFetches: Map<bigint, unknown> }).activeFetches;
        expect(active.size).toBe(0);
        expect(errors).toEqual([]);                     // warm start degrades silently
    });
});

describe('catalog bootstrap wiring — candidate adoption and ownership tombstones', () => {
    const MALFORMED = new TextEncoder().encode('{not json');

    async function toCandidate(adapter: ReturnType<typeof createMockAdapter>) {
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        return { ...loaded, candSubReqId, candFetchReqId };
    }

    function bindCandidate(adapter: ReturnType<typeof createMockAdapter>, candSubReqId: bigint, alias: bigint): void {
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(alias),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
    }

    async function completeCandidateFetch(adapter: ReturnType<typeof createMockAdapter>, candFetchReqId: bigint): Promise<void> {
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
    }

    it('a MALFORMED suffix delta between readiness and settlement ABORTS the candidate — never adopted, active retained', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, candSubReqId, candFetchReqId } = await toCandidate(adapter);
        bindCandidate(adapter, candSubReqId, 9n);
        await flush();
        // A live delta on the CANDIDATE alias buffers as suffix while its
        // fetch is still open — valid JSON, classified as an MSF delta, but
        // its application FAILS (bogus op).
        adapter._triggerObject(600n, {
            kind: 'data', trackAlias: varint(9n), groupId: varint(8n), subgroupId: varint(0n),
            objectId: varint(1n), publisherPriority: 128, extensions: undefined,
            payload: enc({ deltaUpdate: [{ op: 'bogus-op', tracks: [{ name: 'x' }] }] }),
        } as unknown as MoqtObject);
        await flush();
        // Prefix completes: the head is valid, but the suffix examination must
        // run BEFORE adoption — the malformed entry fails the transaction.
        await completeCandidateFetch(adapter, candFetchReqId);
        expect(events).toEqual(['catalog_received']);   // never adopted
        expect(errors.length).toBeGreaterThan(0);       // transaction failed loudly
    });

    it('a valid parked head followed by a MALFORMED parked delta fails the transaction — no mid-replay adoption', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, candSubReqId } = await toCandidate(adapter);
        // Retired-alias reuse: valid independent head, then a malformed delta,
        // both parked pre-SUBSCRIBE_OK.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined,
            payload: enc({ version: 'draft-01', tracks: [{ name: 'v2', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }] }),
        } as unknown as MoqtObject);
        adapter._triggerObject(701n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(1n), publisherPriority: 128, extensions: undefined, payload: MALFORMED,
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
        // SUBSCRIBE_OK reuses the retired alias: the head reaches readiness
        // mid-replay, but adoption is held until the WHOLE replay is examined
        // — the malformed delta aborts the transaction instead.
        bindCandidate(adapter, candSubReqId, 1n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);   // no adoption
        expect(errors.length).toBeGreaterThan(0);
    });

    it('the recovery OBJECT bound spans aliases — tiny objects across several unknown aliases still fail closed', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, errors, candSubReqId } = await toCandidate(adapter);
        for (const alias of [42n, 43n, 44n]) {
            for (let i = 0; i < 90; i++) {              // 270 total > 256
                adapter._triggerObject(BigInt(1000 + Number(alias) * 100 + i), {
                    kind: 'data', trackAlias: varint(alias), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                    objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
                } as unknown as MoqtObject);
            }
        }
        await flush();
        expect(errors.length).toBeGreaterThan(0);
        expect(events).toEqual(['catalog_received']);
        // Settlement (not blanket purge): candidate ownership is stripped;
        // surviving entries are retained only for concurrent media owners.
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, { owners?: bigint[] }[]> }).pendingObjectsByAlias;
        for (const e of pending.get(42n) ?? []) {
            expect(e.owners ?? []).not.toContain(candSubReqId);
            expect((e.owners ?? []).length).toBeGreaterThan(0);
        }
    });

    it('the recovery ALIAS bound fails closed — one tiny object on each of 65 distinct aliases aborts the candidate', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await toCandidate(adapter);
        for (let a = 0; a < 65; a++) {
            adapter._triggerObject(BigInt(3000 + a), {
                kind: 'data', trackAlias: varint(BigInt(200 + a)), groupId: varint(0n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        await flush();
        expect(errors.length).toBeGreaterThan(0);
        expect(events).toEqual(['catalog_received']);
    });

    it('GOAWAY quarantines old-session catalog delivery immediately — late data cannot mutate state', async () => {
        const adapter = createMockAdapter(16);
        const second = createMockAdapter(16);
        let connects = 0;
        const { events } = await loadPlayer(adapter, {
            createConnection: () => ((connects++ === 0 ? adapter : second)) as unknown as MoqtConnection,
        });
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);

        adapter._triggerMessage({ type: 'GOAWAY', newSessionUri: '' } as unknown as ControlMessage);
        await flush();
        // LATE catalog data on the GOAWAY'd session: quarantined, not applied
        // — regardless of how the in-flight migration ends.
        adapter._triggerObject(800n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(6n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined,
            payload: enc({ version: 'draft-01', tracks: [{ name: 'rogue', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }] }),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);   // no catalog_updated
    });

    it('a superseded session cannot overwrite the current session\'s subgroup-alias liveness entry', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        adapter._triggerDataStream(400n, { type: 'subgroup', header: { trackAlias: varint(5n), groupId: varint(0n), subgroupId: varint(0n), publisherPriority: 128 } } as unknown as DataStreamHeader);
        const internals = player as unknown as { connection: unknown; subgroupStreamAliases: Map<bigint, bigint> };
        expect(internals.subgroupStreamAliases.get(400n)).toBe(5n);
        const current = internals.connection;
        internals.connection = { draftVersion: 16 };
        adapter._triggerDataStream(400n, { type: 'subgroup', header: { trackAlias: varint(9n), groupId: varint(0n), subgroupId: varint(0n), publisherPriority: 128 } } as unknown as DataStreamHeader);
        expect(internals.subgroupStreamAliases.get(400n)).toBe(5n);   // NOT overwritten
        internals.connection = current;
    });

    it('retired-alias reuse is governed by request/generation ownership — data parks immediately, no wall-clock exclusion window', async () => {
        const adapter = createMockAdapter(16);
        const { player, candSubReqId } = await toCandidate(adapter);
        bindCandidate(adapter, candSubReqId, 9n);       // different alias → 1n retired
        await flush();
        // Data on the freed alias parks AT ONCE for the next generation — the
        // adapter released the alias at drain completion, so this data belongs
        // to whichever outstanding request the next SUBSCRIBE_OK resolves.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(20n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc({ later: 1 }),
        } as unknown as MoqtObject);
        await flush();
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;
        expect(pending.get(1n)).toHaveLength(1);
    });

    it('the LEGACY catalog subscribe registers ownership pre-send — a same-tick SUBSCRIBE_OK alias binds', async () => {
        const adapter = createMockAdapter(16);
        const td = new TextDecoder();
        const inner = adapter.subscribe;
        adapter.subscribe = vi.fn(async (ns: unknown, name: Uint8Array, options?: { onRequestId?: (id: bigint) => void }) => {
            const wrapped = {
                ...(options ?? {}),
                onRequestId: (id: bigint) => {
                    options?.onRequestId?.(id);
                    if (td.decode(name) === 'catalog') {
                        adapter._triggerMessage({
                            type: 'SUBSCRIBE_OK', requestId: varint(id), trackAlias: varint(33n),
                            parameters: new Map(), trackExtensions: [],
                        } as unknown as ControlMessage);
                    }
                },
            };
            return inner(ns, name, wrapped);
        });
        const { events } = await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        // The alias bound by the same-tick SUBSCRIBE_OK routes the catalog.
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(33n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
    });

    it('the PUBLISH_DONE resubscribe registers ownership pre-send — a same-tick SUBSCRIBE_OK alias remap is honored', async () => {
        const adapter = createMockAdapter(16);
        const td = new TextDecoder();
        let videoSubs = 0;
        const inner = adapter.subscribe;
        adapter.subscribe = vi.fn(async (ns: unknown, name: Uint8Array, options?: { onRequestId?: (id: bigint) => void }) => {
            const wrapped = {
                ...(options ?? {}),
                onRequestId: (id: bigint) => {
                    options?.onRequestId?.(id);
                    if (td.decode(name) === 'video') {
                        videoSubs += 1;
                        if (videoSubs === 2) {          // the RESUBSCRIBE
                            adapter._triggerMessage({
                                type: 'SUBSCRIBE_OK', requestId: varint(id), trackAlias: varint(88n),
                                parameters: new Map(), trackExtensions: [],
                            } as unknown as ControlMessage);
                        }
                    }
                },
            };
            return inner(ns, name, wrapped);
        });
        const { player } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush(); await flush();
        // The video subscription (reqId 5) falls behind → TOO_FAR_BEHIND (d16
        // 0x6) → resubscribe; its SUBSCRIBE_OK lands same-tick with alias 88.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(5n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush(); await flush();
        expect(videoSubs).toBe(2);
        const sm = (player as unknown as { subscriptionManager: { getMediaType(a: bigint): unknown } }).subscriptionManager;
        expect(sm.getMediaType(88n)).toBe('video');
    });

    it('rolled-back warm-fetch ownership leaves a QUARANTINE tombstone — late traffic drops, reclaimed at teardown', async () => {
        const adapter = createMockAdapter(16);
        let joinCalls = 0;
        let fetchIds = 51n;
        adapter.joiningFetch = vi.fn(async (options?: { onRequestId?: (id: bigint) => void }) => {
            const id = fetchIds; fetchIds += 2n;
            joinCalls += 1;
            options?.onRequestId?.(id);
            if (joinCalls > 1) throw new Error('request stream write failed');
            return varint(id);
        });
        const { player, events } = await loadPlayer(adapter, { warmStartCurrentGroup: true });
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 51n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(51n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush(); await flush();
        expect(events).toEqual(['catalog_received']);
        expect(joinCalls).toBeGreaterThan(1);           // the media warm fetches failed
        // Phase 1 — the tombstone QUARANTINES: a late data stream for the
        // failed fetch is dropped, never parked as an unowned pending stream.
        adapter._triggerDataStream(600n, { type: 'fetch', header: { requestId: varint(53n) } } as unknown as DataStreamHeader);
        adapter._triggerObject(600n, {
            kind: 'data', trackAlias: varint(0n), groupId: varint(4n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc({ media: true }),
        } as unknown as MoqtObject);
        await flush();
        const internals = player as unknown as {
            pendingFetchStreams: Map<bigint, unknown>;
            droppedFetchStreams: Set<bigint>;
            quarantinedFetchRequests: Set<bigint>;
            pendingObjectsByAlias: Map<bigint, unknown[]>;
        };
        expect(internals.pendingFetchStreams.size).toBe(0);
        expect(internals.droppedFetchStreams.has(600n)).toBe(true);
        expect(internals.pendingObjectsByAlias.get(0n)).toBeUndefined();
        expect(internals.quarantinedFetchRequests.has(53n)).toBe(true);
        // Phase 2 — reclaimed at the defined lifecycle boundary.
        await player.destroy();
        expect(internals.quarantinedFetchRequests.size).toBe(0);
    });
});

describe('catalog bootstrap wiring — terminal drain and shared parking budgets', () => {
    async function toReady(adapter: ReturnType<typeof createMockAdapter>, cfg?: Record<string, unknown>) {
        const loaded = await loadPlayer(adapter, cfg);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        return loaded;
    }

    const lateIndependent = (group: bigint) => enc({
        version: 'draft-01',
        tracks: [{ name: 'late', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }],
    });

    it('ended → drained → late object is NOT applied (route retired at drain completion)', async () => {
        const adapter = createMockAdapter(16);
        const { events } = await toReady(adapter);
        expect(events).toEqual(['catalog_received']);
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x2n),   // TRACK_ENDED
            streamCount: varint(0n), errorReason: 'track ended',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush();
        // A late post-drain object on the old catalog alias must not mutate
        // the (complete) catalog.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: lateIndependent(9n),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);   // no catalog_updated
    });

    it('second retriable → drained (recovery declined) → late object is NOT applied', async () => {
        const adapter = createMockAdapter(16);
        // First retriable DONE → candidate → adopt (consumes the recovery budget).
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(loaded.events).toEqual(['catalog_received', 'catalog_updated']);   // adopted

        // SECOND retriable DONE on the adopted feed: recovery is declined
        // (one per generation) — the route must be retired, not left live.
        const candOpts = adapter.subscribe.mock.calls.find(
            (c: unknown[], i: number) => i > 0
                && (c[2] as { onDrained?: unknown })?.onDrained !== undefined
                && (c[2] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'LargestObject')?.[2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(candSubReqId), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'again',
        } as unknown as ControlMessage);
        candOpts.onDrained(candSubReqId);
        await flush();
        expect(loaded.errors.length).toBeGreaterThan(0);   // degraded (declined)
        const eventsBefore = [...loaded.events];
        adapter._triggerObject(800n, {
            kind: 'data', trackAlias: varint(9n), groupId: varint(12n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: lateIndependent(12n),
        } as unknown as MoqtObject);
        await flush();
        expect(loaded.events).toEqual(eventsBefore);       // late object inert
    });

    it('draft-14 LEGACY mode carries terminal-drain semantics — late post-drain objects stop applying, wire filter unchanged', async () => {
        const adapter = createMockAdapter(14);
        const { events } = await loadPlayer(adapter, { draftVersion: 14, catalogBootstrap: 'subscribe' });
        await flush();
        const subOpts = adapter.subscribe.mock.calls[0]![2];
        expect(subOpts.subscriptionFilter.type).toBe('AbsoluteStart');
        expect(subOpts.terminalDelivery).toBe('drain');
        expect(typeof subOpts.onDrained).toBe('function');
        expect(adapter.joiningFetch).not.toHaveBeenCalled();
        ackCatalog(adapter);
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x2n),
            streamCount: varint(0n), errorReason: 'done',
        } as unknown as ControlMessage);
        subOpts.onDrained(1n);
        await flush();
        adapter._triggerObject(101n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(1n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: lateIndependent(1n),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);      // late object inert post-drain
    });

    it('a manually migrated-away session cannot mutate the replacement catalog through a colliding alias', async () => {
        const adapter = createMockAdapter(16);
        const second = createMockAdapter(16);
        const { player, events } = await toReady(adapter);
        expect(events).toEqual(['catalog_received']);

        const m = player.migrate(second as unknown as MoqtConnection);
        await vi.waitFor(() => expect(second.connect).toHaveBeenCalled());
        second._connectResolve?.();
        await m;

        // The NEW session's catalog binds the SAME alias (1n) the old one used.
        second._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await deliverFetchObject(second, 3n, 100n, 5n, 0n, enc(CATALOG));
        second._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        second._triggerStreamClosed(100n);
        await flush(); await flush();
        const afterMigration = [...events];
        expect(afterMigration).toContain('catalog_received');

        // LATE catalog data from the SUPERSEDED session, colliding alias and
        // stream id: quarantined — it must never reach the new coordinator.
        adapter._triggerObject(200n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: lateIndependent(9n),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(afterMigration);
    });

    it('a failed lazy init-track subscribe rejects ALL coalesced waiters, allows retry, and destroy() rejects stragglers', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await toReady(adapter);
        const internals = player as unknown as {
            ensureInitTrack(name: string): Promise<Uint8Array>;
            pendingInitTrackSubs: Map<string, unknown>;
        };
        const inner = adapter.subscribe;
        const td = new TextDecoder();
        let failInit = true;
        adapter.subscribe = vi.fn(async (ns: unknown, name: Uint8Array, options?: unknown) => {
            if (td.decode(name) === 'init0' && failInit) throw new Error('send failed');
            return inner(ns, name, options);
        });
        // Two CONCURRENT waiters coalesce onto one entry — both must reject.
        const w1 = internals.ensureInitTrack('init0');
        const w2 = internals.ensureInitTrack('init0');
        await expect(w1).rejects.toThrow('send failed');
        await expect(w2).rejects.toThrow('send failed');
        expect(internals.pendingInitTrackSubs.size).toBe(0);   // entry removed → retry possible
        // RETRY succeeds in creating a fresh coalesced entry (no poisoning).
        failInit = false;
        const w3 = internals.ensureInitTrack('init0');
        expect(internals.pendingInitTrackSubs.size).toBe(1);
        // destroy() settles the straggler instead of hanging it forever.
        const w3Result = w3.catch((e: Error) => e.message);
        await player.destroy();
        expect(await w3Result).toMatch(/destroyed/i);
    });

    it('retired-alias and generic candidate parking share ONE budget — split stores cannot double the limits', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, candSubReqId, candFetchReqId } = await (async () => {
            const loaded = await loadPlayer(adapter);
            await flush();
            ackCatalog(adapter);
            await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
            adapter._triggerMessage({
                type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
                endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
            } as unknown as ControlMessage);
            adapter._triggerStreamClosed(100n);
            await flush();
            const drainOpts = adapter.subscribe.mock.calls[0]![2];
            adapter._triggerMessage({
                type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
                streamCount: varint(0n), errorReason: 'too far behind',
            } as unknown as ControlMessage);
            drainOpts.onDrained(1n);
            await flush(); await flush();
            return {
                ...loaded,
                candSubReqId: BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId),
                candFetchReqId: BigInt(await adapter.joiningFetch.mock.results[1]!.value),
            };
        })();
        void candSubReqId; void candFetchReqId;
        // 150 objects on the RETIRED alias + 150 on a generic unknown alias:
        // each store alone is under its old 256 cap, the TRANSACTION is not.
        for (let i = 0; i < 150; i++) {
            adapter._triggerObject(BigInt(1000 + i), {
                kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        for (let i = 0; i < 150; i++) {
            adapter._triggerObject(BigInt(2000 + i), {
                kind: 'data', trackAlias: varint(42n), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        await flush();
        expect(errors.length).toBeGreaterThan(0);          // combined overflow → abort
        expect(events).toEqual(['catalog_received']);      // active untouched
    });
});

describe('catalog bootstrap wiring — staged recovery adoption and alias quarantine', () => {
    const rogue = () => enc({
        version: 'draft-01',
        tracks: [{ name: 'rogue', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }],
    });

    async function toCandidate(adapter: ReturnType<typeof createMockAdapter>) {
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        return { ...loaded, candSubReqId, candFetchReqId };
    }

    function ackMedia(adapter: ReturnType<typeof createMockAdapter>): void {
        for (const reqId of [5n, 7n]) {
            adapter._triggerMessage({
                type: 'SUBSCRIBE_OK', requestId: varint(reqId), trackAlias: varint(reqId),
                parameters: new Map(), trackExtensions: [],
            } as unknown as ControlMessage);
        }
    }

    it('unowned retired-alias data is DROPPED with no request outstanding, and PARKS once one is', async () => {
        const adapter = createMockAdapter(16);
        const { player, candSubReqId } = await toCandidate(adapter);
        ackMedia(adapter);                              // media OKs answered
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;

        // Phase 1 — NOTHING outstanding: post-drain stragglers on the retired
        // alias have no possible owner → dropped, never buffered.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(20n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(pending.get(1n)).toBeUndefined();

        // Phase 2 — a real request goes out (TOO_FAR_BEHIND resubscribe on the
        // video track) and is awaiting its OK: alias-1 data now has a
        // plausible owner → parks for that generation.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(5n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush(); await flush();
        adapter._triggerObject(701n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(21n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(pending.get(1n)).toHaveLength(1);
    });

    it('draft-14 auto surfaces MALFORMED_TRACK (0x7) fatally and quarantines catalog delivery', async () => {
        const adapter = createMockAdapter(14);
        const { events, errors } = await loadPlayer(adapter, { draftVersion: 14 });
        await flush();
        ackCatalog(adapter);
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x7n),   // d14 MALFORMED_TRACK
            streamCount: varint(0n), errorReason: 'malformed',
        } as unknown as ControlMessage);
        await flush();
        const fatal = errors.find((e) => (e as { severity?: string }).severity === 'fatal');
        expect(fatal).toBeDefined();
        // Late data during what would be the drain window: quarantined.
        adapter._triggerObject(101n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(1n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
    });

    it('explicit-subscribe retriable termination runs LEGACY staged recovery (AbsoluteStart candidate, no join)', async () => {
        // Post-catalog retriable → staged recovery with an AbsoluteStart
        // candidate (all-draft policy; legacy never issues a Joining FETCH).
        const a1 = createMockAdapter(16);
        const r1 = await loadPlayer(a1, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(a1);
        a1._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(r1.events).toEqual(['catalog_received']);
        a1._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush();
        // The TERMINAL-DRAIN BARRIER: no recovery yet, and a late delta
        // delivered during the drain window still APPLIES.
        expect(a1.subscribe.mock.calls.length).toBe(3);   // catalog + video + audio only
        a1._triggerObject(150n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(1n), publisherPriority: 128, extensions: undefined,
            payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'late', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
        } as unknown as MoqtObject);
        await flush();
        expect(r1.events).toEqual(['catalog_received', 'catalog_updated']);
        // Drain completes → NOW recovery starts.
        a1.subscribe.mock.calls[0]![2].onDrained(1n);
        await flush(); await flush();
        // The candidate subscribe went out: AbsoluteStart + drain, no join.
        expect(a1.joiningFetch).not.toHaveBeenCalled();
        const candCall = a1.subscribe.mock.calls[a1.subscribe.mock.calls.length - 1]!;
        expect(candCall[2].subscriptionFilter.type).toBe('AbsoluteStart');
        expect(candCall[2].terminalDelivery).toBe('drain');
        const candReqId = BigInt(await a1.subscribe.mock.results[a1.subscribe.mock.results.length - 1]!.value);
        // Candidate SUBSCRIBE_OK + first independent → atomic adoption.
        a1._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candReqId), trackAlias: varint(2n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        a1._triggerObject(200n, {
            kind: 'data', trackAlias: varint(2n), groupId: varint(3n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush(); await flush();
        expect(r1.events).toEqual(['catalog_received', 'catalog_updated', 'catalog_updated']);   // late delta + adoption

        // Pre-catalog UNAUTHORIZED → fatal.
        const a2 = createMockAdapter(16);
        const r2 = await loadPlayer(a2, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(a2);
        a2._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x1n),
            streamCount: varint(0n), errorReason: 'unauthorized',
        } as unknown as ControlMessage);
        await flush();
        expect(r2.errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
    });

    it('a candidate catalog drain completing BEFORE commit is replayed after the staged events — never lost', async () => {
        const adapter = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();

        // Candidate session whose subscribe we HOLD so pre-commit events stage.
        const second = createMockAdapter(16);
        let releaseSub: ((id: bigint) => void) | null = null;
        let candOpts: { onDrained?: (id: bigint) => void } | undefined;
        second.subscribe = vi.fn((_ns: unknown, _name: unknown, options?: { onRequestId?: (id: bigint) => void }) => {
            candOpts = options as never;
            return new Promise((resolve) => { releaseSub = (id) => { options?.onRequestId?.(id); resolve(varint(id)); }; });
        });
        const m = player.migrate(second as unknown as MoqtConnection);
        await vi.waitFor(() => expect(second.connect).toHaveBeenCalled());
        second._connectResolve?.();
        await vi.waitFor(() => expect(second.subscribe).toHaveBeenCalled());

        // PRE-COMMIT: the candidate catalog gets OK + ended DONE (staged) and
        // its drain COMPLETES (the buffered event under test).
        second._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(21n), trackAlias: varint(1n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        second._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(21n), statusCode: varint(0x2n),
            streamCount: varint(0n), errorReason: 'ended',
        } as unknown as ControlMessage);
        candOpts!.onDrained!(21n);
        releaseSub!(21n);
        await m;
        await flush();
        // The buffered drain replayed post-commit: an ENDED feed's route is
        // retired — a late object on the new session's catalog alias is inert.
        expect((player as unknown as { catalogTrackAlias: bigint | null }).catalogTrackAlias).toBeNull();
        const before = [...events];
        second._triggerObject(300n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(before);
    });

    it('adopting a candidate whose feed already ENDED does not resurrect the dead alias route', async () => {
        const adapter = createMockAdapter(16);
        const { events, candSubReqId, candFetchReqId, player } = await toCandidate(adapter);
        // The candidate's feed ends and DRAINS while still candidate-owned.
        const candOpts = adapter.subscribe.mock.calls.find(
            (c: unknown[], i: number) => i > 0
                && (c[2] as { onDrained?: unknown })?.onDrained !== undefined
                && (c[2] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'LargestObject')?.[2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(candSubReqId), statusCode: varint(0x2n),   // ENDED
            streamCount: varint(0n), errorReason: 'ended',
        } as unknown as ControlMessage);
        candOpts.onDrained(candSubReqId);
        await flush();
        // Prefix completes (readiness held), then SUBSCRIBE_OK binds → adopt.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated']);   // adopted for content
        // …but the DEAD alias is not routable.
        expect((player as unknown as { catalogTrackAlias: bigint | null }).catalogTrackAlias).toBeNull();
        adapter._triggerObject(800n, {
            kind: 'data', trackAlias: varint(9n), groupId: varint(12n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('a single-caller init-track subscribe failure rejects cleanly with NO unhandled rejection', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const td = new TextDecoder();
        const inner = adapter.subscribe;
        adapter.subscribe = vi.fn(async (ns: unknown, name: Uint8Array, options?: unknown) => {
            if (td.decode(name) === 'init0') throw new Error('send failed');
            return inner(ns, name, options);
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (r: unknown): void => { unhandled.push(r); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const internals = player as unknown as {
                ensureInitTrack(name: string): Promise<Uint8Array>;
                pendingInitTrackSubs: Map<string, unknown>;
            };
            await expect(internals.ensureInitTrack('init0')).rejects.toThrow('send failed');
            expect(internals.pendingInitTrackSubs.size).toBe(0);
            await flush();
            await new Promise((r) => setTimeout(r, 20));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('a quarantined session\'s catalog alias cannot cross into the media pipeline via alias reuse', async () => {
        const adapter = createMockAdapter(16);
        const second = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);

        const m = player.migrate(second as unknown as MoqtConnection);
        await vi.waitFor(() => expect(second.connect).toHaveBeenCalled());
        second._connectResolve?.();
        await m;
        // New session: catalog on a DIFFERENT alias; the OLD catalog alias
        // (1n) is reused for the VIDEO media track.
        second._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(40n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await deliverFetchObject(second, 3n, 100n, 5n, 0n, enc(CATALOG));
        second._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        second._triggerStreamClosed(100n);
        await flush(); await flush();
        second._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(5n), trackAlias: varint(1n),   // video ← old catalog alias
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        const sm = (player as unknown as { subscriptionManager: { getMediaType(a: bigint): unknown; routeObject: (...a: unknown[]) => unknown } }).subscriptionManager;
        expect(sm.getMediaType(1n)).toBe('video');
        const routeSpy = vi.spyOn(sm, 'routeObject');
        // LATE catalog bytes from the SUPERSEDED session on that alias: they
        // must never enter the media pipeline.
        adapter._triggerObject(200n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(routeSpy).not.toHaveBeenCalled();
        // Sanity: the NEW session's data on the same alias DOES route.
        second._triggerObject(201n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array([0]),
        } as unknown as MoqtObject);
        await flush();
        expect(routeSpy).toHaveBeenCalledTimes(1);
    });
});

describe('catalog bootstrap wiring — parked-data ownership and candidate teardown', () => {
    const rogue = () => enc({
        version: 'draft-01',
        tracks: [{ name: 'rogue', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }],
    });

    async function toReadyAcked(adapter: ReturnType<typeof createMockAdapter>, cfg?: Record<string, unknown>) {
        const loaded = await loadPlayer(adapter, cfg);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        // Answer the media subscribes so NOTHING is outstanding.
        for (const reqId of [5n, 7n]) {
            adapter._triggerMessage({
                type: 'SUBSCRIBE_OK', requestId: varint(reqId), trackAlias: varint(reqId),
                parameters: new Map(), trackExtensions: [],
            } as unknown as ControlMessage);
        }
        await flush();
        return loaded;
    }

    it('parked data is owned by the SPECIFIC requests that were pending — resolutions to other aliases strip ownership and drop ownerless entries', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await toReadyAcked(adapter);
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;
        // TWO real requests go out (video + audio TOO_FAR_BEHIND resubscribes).
        for (const reqId of [5n, 7n]) {
            adapter._triggerMessage({
                type: 'PUBLISH_DONE', requestId: varint(reqId), statusCode: varint(0x6n),
                streamCount: varint(0n), errorReason: 'too far behind',
            } as unknown as ControlMessage);
        }
        await flush(); await flush();
        const resubIds = adapter.subscribe.mock.results.slice(-2);
        const resubA = BigInt(await resubIds[0]!.value);
        const resubB = BigInt(await resubIds[1]!.value);
        // Unknown-alias data parks, owned by {A, B}.
        adapter._triggerObject(900n, {
            kind: 'data', trackAlias: varint(50n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(pending.get(50n)).toHaveLength(1);
        // A resolves to a DIFFERENT alias (60): entry still owned by B.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(resubA), trackAlias: varint(60n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(pending.get(50n)).toHaveLength(1);
        // B resolves to yet another alias (61): the entry is OWNERLESS — a
        // later unrelated request that gets alias 50 must never inherit it.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(resubB), trackAlias: varint(61n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(pending.get(50n)).toBeUndefined();
    });

    it('a failed recovery candidate reclaims its pendingAliasBinds entry — parking does not stay enabled forever', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await toReadyAcked(adapter);
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        // The candidate fails through a NON-REQUEST_ERROR path (parking
        // overflow), so failCatalogRecovery's own bind reclamation is the
        // only thing standing between us and eternal parking. (A peer
        // REQUEST_ERROR is additionally reclaimed by the central sweep.)
        for (let i = 0; i < 260; i++) {
            adapter._triggerObject(BigInt(3000 + i), {
                kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        await flush();
        expect(loaded.errors.length).toBeGreaterThan(0);
        const binds = (player_of(loaded).pendingAliasBinds);
        expect(binds.size).toBe(0);
        // With nothing outstanding, unknown-alias data DROPS (no eternal parking).
        adapter._triggerObject(950n, {
            kind: 'data', trackAlias: varint(70n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(player_of(loaded).pendingObjectsByAlias.get(70n)).toBeUndefined();

        function player_of(l: { player: unknown }) {
            return l.player as { pendingAliasBinds: Set<bigint>; pendingObjectsByAlias: Map<bigint, unknown[]> };
        }
    });

    it('legacy fatal termination quarantines the ALIAS — drained stragglers cannot park against a pending media request', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors, player } = await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(adapter);
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x12n),   // d16 MALFORMED_TRACK
            streamCount: varint(0n), errorReason: 'malformed',
        } as unknown as ControlMessage);
        await flush();
        expect(errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
        // Media subscribes are STILL pending (never OK'd) — yet the untrusted
        // catalog alias must not park (it could later replay into a media
        // track that reuses alias 1).
        adapter._triggerObject(101n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(1n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;
        expect(pending.get(1n)).toBeUndefined();
    });

    it('a recovery candidate whose session announces GOING_AWAY is aborted, never adoptable', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await toReadyAcked(adapter);
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        // The candidate's own subscription reports GOING_AWAY.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(candSubReqId), statusCode: varint(0x4n),   // GOING_AWAY
            streamCount: varint(0n), errorReason: 'going away',
        } as unknown as ControlMessage);
        await flush();
        expect(loaded.errors.length).toBeGreaterThan(0);   // candidate aborted
        // A later prefix completion must NOT adopt the dead candidate.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(loaded.events).toEqual(['catalog_received']);   // no adoption
    });
});

describe('catalog bootstrap wiring — parked replay binding and candidate fetch retirement', () => {
    const rogue = () => enc({
        version: 'draft-01',
        tracks: [{ name: 'rogue', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }],
    });

    async function toReadyAcked(adapter: ReturnType<typeof createMockAdapter>, cfg?: Record<string, unknown>) {
        const loaded = await loadPlayer(adapter, cfg);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        for (const reqId of [5n, 7n]) {
            adapter._triggerMessage({
                type: 'SUBSCRIBE_OK', requestId: varint(reqId), trackAlias: varint(reqId),
                parameters: new Map(), trackExtensions: [],
            } as unknown as ControlMessage);
        }
        await flush();
        return loaded;
    }

    it('a request binding an alias never inherits data parked for a DIFFERENT request', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await toReadyAcked(adapter);
        // Request B (video resubscribe) goes out and stays pending.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(5n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush(); await flush();
        // Data parks under alias 50, owned by {B} only.
        adapter._triggerObject(900n, {
            kind: 'data', trackAlias: varint(50n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        // Request A (audio resubscribe) starts LATER — it never owned that data.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(7n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush(); await flush();
        const resubA = BigInt(await adapter.subscribe.mock.results[adapter.subscribe.mock.results.length - 1]!.value);
        const sm = (player as unknown as { subscriptionManager: { routeObject: (...a: unknown[]) => unknown } }).subscriptionManager;
        const routeSpy = vi.spyOn(sm, 'routeObject');
        // A binds alias 50: B's parked data must NOT replay into A's track.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(resubA), trackAlias: varint(50n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(routeSpy).not.toHaveBeenCalled();
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;
        expect(pending.get(50n)).toBeUndefined();       // not retained either
    });

    it('a SEND-FAILURE rollback settles parked ownership like a response would', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await toReadyAcked(adapter);
        // The video resubscribe is HELD: pre-send ownership registers, data
        // parks against it, then the send FAILS.
        const inner = adapter.subscribe;
        let rejectSub: ((e: Error) => void) | null = null;
        let heldId: bigint | null = null;
        adapter.subscribe = vi.fn((ns: unknown, name: Uint8Array, options?: { onRequestId?: (id: bigint) => void }) => {
            return new Promise((_res, rej) => {
                heldId = 91n;
                options?.onRequestId?.(91n);
                rejectSub = rej;
            });
        });
        void inner;
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(5n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush();
        expect(heldId).toBe(91n);
        adapter._triggerObject(910n, {
            kind: 'data', trackAlias: varint(55n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        const pending = (player as unknown as { pendingObjectsByAlias: Map<bigint, unknown[]> }).pendingObjectsByAlias;
        expect(pending.get(55n)).toHaveLength(1);
        rejectSub!(new Error('send failed'));
        await flush(); await flush();
        // The rolled-back request's ownership settled → the entry is
        // ownerless → dropped, and parking is no longer enabled by it.
        expect(pending.get(55n)).toBeUndefined();
        expect((player as unknown as { pendingAliasBinds: Set<bigint> }).pendingAliasBinds.size).toBe(0);
    });

    it('a LEGACY recovery candidate whose subscription ends before its first base FAILS the transaction', async () => {
        const adapter = createMockAdapter(16);
        const r1 = await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(adapter);
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        // Retriable DONE + drain → legacy recovery candidate goes out.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        adapter.subscribe.mock.calls[0]![2].onDrained(1n);
        await flush(); await flush();
        const candReqId = BigInt(await adapter.subscribe.mock.results[adapter.subscribe.mock.results.length - 1]!.value);
        const candOpts = adapter.subscribe.mock.calls[adapter.subscribe.mock.calls.length - 1]![2];
        // The CANDIDATE's own subscription ends + drains BEFORE any base:
        // the transaction must fail (not hang forever), active retained.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candReqId), trackAlias: varint(2n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(candReqId), statusCode: varint(0x2n),
            streamCount: varint(0n), errorReason: 'ended',
        } as unknown as ControlMessage);
        candOpts.onDrained(candReqId);
        await flush();
        expect(r1.errors.length).toBeGreaterThan(0);       // transaction failed
        expect(r1.events).toEqual(['catalog_received']);   // active retained
        // A late candidate object is inert (candidate gone).
        adapter._triggerObject(200n, {
            kind: 'data', trackAlias: varint(2n), groupId: varint(3n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(r1.events).toEqual(['catalog_received']);
    });

    it('failing the candidate cancels + tombstones its FETCH — late fetch streams quarantine, never park unowned', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await toReadyAcked(adapter);
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        // The candidate subscribe is refused → transaction fails.
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(candSubReqId), errorCode: varint(0x1n),
            retryInterval: varint(0n), errorReason: 'unauthorized',
        } as unknown as ControlMessage);
        await flush();
        expect(loaded.errors.length).toBeGreaterThan(0);
        const internals = loaded.player as unknown as {
            quarantinedFetchRequests: Set<bigint>;
            pendingFetchStreams: Map<bigint, unknown>;
            droppedFetchStreams: Set<bigint>;
        };
        // The FETCH was cancelled on the wire AND tombstoned.
        expect(adapter.fetchCancel).toHaveBeenCalled();
        expect(internals.quarantinedFetchRequests.has(candFetchReqId)).toBe(true);
        // A LATE fetch stream for the dead candidate fetch quarantines.
        adapter._triggerDataStream(600n, { type: 'fetch', header: { requestId: varint(candFetchReqId) } } as unknown as DataStreamHeader);
        adapter._triggerObject(600n, {
            kind: 'data', trackAlias: varint(0n), groupId: varint(8n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(internals.pendingFetchStreams.size).toBe(0);
        expect(internals.droppedFetchStreams.has(600n)).toBe(true);
    });
});

describe('catalog bootstrap wiring — legacy terminal deferral and owner-scoped budgets', () => {
    const rogue = () => enc({
        version: 'draft-01',
        tracks: [{ name: 'rogue', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }],
    });

    it('legacy PRE-BASE retriable DONE defers — a base arriving during the drain still loads, then recovery runs at drained', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(adapter);
        // Retriable DONE BEFORE any catalog object: NOT fatal yet.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        await flush();
        expect(errors.filter((e) => (e as { severity?: string }).severity === 'fatal')).toHaveLength(0);
        // The base ARRIVES during the drain window → catalog loads.
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
        // Drained → the deferred retriable now runs staged recovery.
        const before = adapter.subscribe.mock.calls.length;
        adapter.subscribe.mock.calls[0]![2].onDrained(1n);
        await flush(); await flush();
        expect(adapter.subscribe.mock.calls.length).toBe(before + 1);
        expect(adapter.subscribe.mock.calls[before]![2].subscriptionFilter.type).toBe('AbsoluteStart');
    });

    it('legacy ENDED with no base after the whole drain window is fatal (nothing more can arrive)', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(adapter);
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x2n),   // TRACK_ENDED
            streamCount: varint(0n), errorReason: 'ended',
        } as unknown as ControlMessage);
        await flush();
        expect(errors).toHaveLength(0);                    // decision deferred to drain
        adapter.subscribe.mock.calls[0]![2].onDrained(1n);
        await flush();
        expect(events).toEqual([]);
        expect(errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
    });

    it('a stale legacy terminal record cannot leak across a migration', async () => {
        const adapter = createMockAdapter(16);
        const second = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter, { catalogBootstrap: 'subscribe' });
        await flush();
        ackCatalog(adapter);
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
        // A retriable DONE records the terminal — then the player MIGRATES
        // before the old drain completes.
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        const m = player.migrate(second as unknown as MoqtConnection);
        await vi.waitFor(() => expect(second.connect).toHaveBeenCalled());
        second._connectResolve?.();
        await m;
        // New session's catalog loads…
        second._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        second._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        // …and a NEW-session drain must not act on the OLD retriable record:
        // no spurious recovery subscribe.
        const before = second.subscribe.mock.calls.length;
        second.subscribe.mock.calls[0]![2].onDrained(1n);
        await flush(); await flush();
        expect(second.subscribe.mock.calls.length).toBe(before);
    });

    it('the rung-2 fallback settles the OLD (pre-OK) catalog request — no eternal parking enabled by a dead bind', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await loadPlayer(adapter);
        await flush();
        // The joining fetch is REFUSED with no known largest BEFORE the
        // catalog SUBSCRIBE_OK → rung 2 unsubscribes the pre-OK request 1.
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x1n),
            retryInterval: varint(0n), errorReason: 'joining fetch not supported',
        } as unknown as ControlMessage);
        await flush(); await flush();
        const binds = (player as unknown as { pendingAliasBinds: Set<bigint> }).pendingAliasBinds;
        expect(binds.has(1n)).toBe(false);   // dead request settled, not leaked
    });

    it('media pre-roll that merely COEXISTS with a recovery never charges the candidate budget', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        // The candidate BINDS (its request is answered — it no longer owns
        // future parking); the MEDIA subscribes are still awaiting their OKs.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        // 300 tiny media pre-roll objects across three aliases — over the
        // candidate's 256-object budget, but owned only by the MEDIA requests.
        for (const alias of [60n, 61n, 62n]) {
            for (let i = 0; i < 100; i++) {
                adapter._triggerObject(BigInt(5000 + Number(alias) * 100 + i), {
                    kind: 'data', trackAlias: varint(alias), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                    objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
                } as unknown as MoqtObject);
            }
        }
        await flush();
        expect(loaded.errors).toEqual([]);                 // candidate NOT aborted
        // The candidate is still adoptable.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(loaded.events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('a SUPERSEDED bootstrap fetch is retired — its late header quarantines instead of parking unowned', async () => {
        const adapter = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        // Mid-prefix, a NEWER-group live independent supersedes the fetch.
        adapter._triggerObject(700n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);      // supersession → ready
        expect(adapter.fetchCancel).toHaveBeenCalled();
        const internals = player as unknown as {
            quarantinedFetchRequests: Set<bigint>;
            pendingFetchStreams: Map<bigint, unknown>;
            droppedFetchStreams: Set<bigint>;
        };
        expect(internals.quarantinedFetchRequests.has(3n)).toBe(true);
        // A LATE header for the cancelled fetch: tombstoned, never parked.
        adapter._triggerDataStream(600n, { type: 'fetch', header: { requestId: varint(3n) } } as unknown as DataStreamHeader);
        adapter._triggerObject(600n, {
            kind: 'data', trackAlias: varint(0n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: rogue(),
        } as unknown as MoqtObject);
        await flush();
        expect(internals.pendingFetchStreams.size).toBe(0);
        expect(internals.droppedFetchStreams.has(600n)).toBe(true);
        expect(events).toEqual(['catalog_received']);
    });

    it('a media replay consumes the stream\'s lifecycle record — no stale evidence outlives its parked object', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        // Media pre-roll parks (video subscribe is pending) and its stream
        // CLOSES pre-OK → a lifecycle record is kept.
        adapter._triggerObject(910n, {
            kind: 'data', trackAlias: varint(66n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array([1]),
        } as unknown as MoqtObject);
        adapter._triggerStreamClosed(910n);
        await flush();
        const internals = player as unknown as { pendingStreamEvents: Map<bigint, unknown> };
        expect(internals.pendingStreamEvents.size).toBe(1);
        // The video SUBSCRIBE_OK binds alias 66 → the parked object replays
        // through the MEDIA branch — which must consume the record too.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(5n), trackAlias: varint(66n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(internals.pendingStreamEvents.size).toBe(0);
    });
});

describe('catalog bootstrap wiring — anchor-before-replay and lifecycle ownership', () => {
    it('the Largest anchor installs BEFORE parked replay — an older parked head cannot supersede the join', async () => {
        const adapter = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        const catalogs: string[][] = [];
        player.on('catalog_received', (e) => catalogs.push(e.catalog.tracks.map((t: { name: string }) => t.name)));
        // An OLD independent (group 5) parks BEFORE the catalog SUBSCRIBE_OK.
        adapter._triggerObject(300n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined,
            payload: enc({ version: 'draft-01', tracks: [{ name: 'old-head', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }] }),
        } as unknown as MoqtObject);
        await flush();
        // SUBSCRIBE_OK arrives with Largest {10,0}: the anchor must land
        // FIRST so the replayed group-5 head cannot cancel the joining fetch.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map([[varint(0x09n), [{ group: 10n, object: 0n }]]]),  // LARGEST_OBJECT
            trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        expect(adapter.fetchCancel).not.toHaveBeenCalled();   // join NOT superseded
        expect(events).toEqual([]);                           // still fetching
        // The joining fetch delivers the TRUE head (group 10) → readiness.
        await deliverFetchObject(adapter, 3n, 100n, 10n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(10n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);
        expect(catalogs[0]).toContain('video');
        expect(catalogs[0]).not.toContain('old-head');
    });

    it('a multi-object pre-alias stream replays ALL its objects before its terminal event', async () => {
        const adapter = createMockAdapter(16);
        const { player } = await loadPlayer(adapter);
        await flush();
        // Two objects on ONE stream park pre-OK, then the stream FINs.
        for (const [objectId, payload] of [
            [0n, enc(CATALOG)],
            [1n, enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'late', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] })],
        ] as Array<[bigint, Uint8Array]>) {
            adapter._triggerObject(300n, {
                kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
                objectId: varint(objectId), publisherPriority: 128, extensions: undefined, payload,
            } as unknown as MoqtObject);
        }
        adapter._triggerStreamClosed(300n);
        await flush();
        // Spy the coordinator's delivery ORDER through the replay.
        const coord = (player as unknown as { catalogBootstrapCoord: { onLiveCatalogObject: (...a: never[]) => void; onLiveStreamEvent: (...a: never[]) => void } }).catalogBootstrapCoord;
        const sequence: string[] = [];
        vi.spyOn(coord, 'onLiveCatalogObject').mockImplementation(() => { sequence.push('obj'); });
        vi.spyOn(coord, 'onLiveStreamEvent').mockImplementation(((_sid: bigint, kind: string) => { sequence.push(kind); }) as never);
        ackCatalog(adapter);
        await flush();
        expect(sequence).toEqual(['header', 'obj', 'header', 'obj', 'fin']);
    });

    it('65 unrelated media pre-roll closures never abort the recovery — lifecycle budget is candidate-owned', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        // The candidate binds — from here, parked data is MEDIA-owned only.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        // 65 media pre-roll objects, each on its OWN stream — and each stream
        // CLOSES, creating 65 lifecycle records (over the 64 budget).
        for (let i = 0; i < 65; i++) {
            const sid = BigInt(7000 + i);
            adapter._triggerObject(sid, {
                kind: 'data', trackAlias: varint(BigInt(300 + i)), groupId: varint(0n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
            adapter._triggerStreamClosed(sid);
        }
        await flush();
        expect(loaded.errors).toEqual([]);                 // recovery NOT aborted
        // …and the candidate remains adoptable.
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(loaded.events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('a bootstrap fetch send failure retires ALREADY-OBSERVED streams — they quarantine, never stay bootstrap-classified', async () => {
        const adapter = createMockAdapter(16);
        adapter.joiningFetch = vi.fn(async (options?: { onRequestId?: (id: bigint) => void }) => {
            options?.onRequestId?.(3n);
            // The FETCH header races in BETWEEN allocation and the failure.
            adapter._triggerDataStream(100n, { type: 'fetch', header: { requestId: varint(3n) } } as unknown as DataStreamHeader);
            throw new Error('request stream write failed');
        });
        const { player, events } = await loadPlayer(adapter);
        await flush(); await flush();
        const internals = player as unknown as {
            quarantinedFetchRequests: Set<bigint>;
            bootstrapFetchStreams: Map<bigint, unknown>;
            droppedFetchStreams: Set<bigint>;
        };
        expect(internals.quarantinedFetchRequests.has(3n)).toBe(true);
        expect(internals.bootstrapFetchStreams.size).toBe(0);
        expect(internals.droppedFetchStreams.has(100n)).toBe(true);
        // A late object on the observed stream is swallowed — never applied.
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(0n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual([]);
    });
});

describe('catalog bootstrap wiring — attempt identity and lifecycle evidence scoping', () => {
    it('a stale attempt-A rejection cannot retire the newer attempt B (per-call request identity)', async () => {
        const adapter = createMockAdapter(16);
        let rejectJoin: ((e: Error) => void) | null = null;
        adapter.joiningFetch = vi.fn((options?: { onRequestId?: (id: bigint) => void }) => {
            return new Promise((_res, rej) => {
                options?.onRequestId?.(51n);   // distinct from the fetch mock's counter
                rejectJoin = rej;
            });
        });
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        // Attempt A delivers a CF-01 PATCH head → the coordinator cancels A
        // and starts attempt B (full-history standalone fetch).
        await deliverFetchObject(adapter, 51n, 100n, 5n, 0n, enc([{ op: 'remove', path: '/tracks/0' }]));
        await flush();
        expect(adapter.fetch).toHaveBeenCalledTimes(1);   // attempt B went out
        const bReqId = BigInt(await adapter.fetch.mock.results[0]!.value);
        // A's AMBIGUOUS send rejection settles LATE — it must retire only A.
        rejectJoin!(new Error('request stream write failed'));
        await flush(); await flush();
        const internals = player as unknown as {
            quarantinedFetchRequests: Set<bigint>;
            bootstrapFetch: { reqId: bigint } | null;
        };
        expect(internals.quarantinedFetchRequests.has(bReqId)).toBe(false);
        expect(internals.bootstrapFetch?.reqId).toBe(bReqId);   // B still owned
        // B completes: cf01 independent history → readiness.
        await deliverFetchObject(adapter, bReqId, 200n, 0n, 0n, enc({
            version: 1, streamingFormat: 1, streamingFormatVersion: '0.2', supportsDeltaUpdates: true,
            commonTrackFields: { namespace: 'live/broadcast', packaging: 'cmaf', renderGroup: 1 },
            tracks: [{ name: '1.m4s', initTrack: '0.mp4', selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } }],
        }));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(bReqId), endOfTrack: 0,
            endLocation: { group: varint(0n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(200n);
        await flush();
        expect(events).toEqual(['catalog_received']);      // B survived A's rejection
    });

    it('64 unrelated media lifecycle records neither abort the recovery nor evict its first candidate-owned FIN', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        // 64 media pre-roll objects (the media subscribes are now pending),
        // each on its own stream, each CLOSED — 64 unrelated lifecycle
        // records exist BEFORE any recovery.
        for (let i = 0; i < 64; i++) {
            const sid = BigInt(8000 + i);
            adapter._triggerObject(sid, {
                kind: 'data', trackAlias: varint(BigInt(400 + i)), groupId: varint(0n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
            adapter._triggerStreamClosed(sid);
        }
        await flush();
        expect((loaded.player as unknown as { pendingStreamEvents: Map<unknown, Map<bigint, unknown>> }).pendingStreamEvents.get(adapter)?.size).toBe(64);
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        // ONE candidate-owned pre-roll object + FIN: candidate budget is 1 —
        // must survive AND its FIN must be retained (evict unrelated instead).
        adapter._triggerObject(9000n, {
            kind: 'data', trackAlias: varint(77n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
        } as unknown as MoqtObject);
        adapter._triggerStreamClosed(9000n);
        await flush();
        expect(loaded.errors).toEqual([]);                 // recovery survives
        const perConn = (loaded.player as unknown as { pendingStreamEvents: Map<unknown, Map<bigint, unknown>> }).pendingStreamEvents.get(adapter);
        expect(perConn?.has(9000n)).toBe(true);            // candidate FIN retained
        // Candidate still adoptable.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(loaded.events).toEqual(['catalog_received', 'catalog_updated']);
    });

    it('a colliding stream id on ANOTHER session cannot fabricate lifecycle evidence', async () => {
        const adapter = createMockAdapter(16);
        const second = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        expect(events).toEqual(['catalog_received']);
        const m = player.migrate(second as unknown as MoqtConnection);
        await vi.waitFor(() => expect(second.connect).toHaveBeenCalled());
        second._connectResolve?.();
        await m;
        // The NEW session parks an object on stream 910 (its catalog subscribe
        // is still awaiting SUBSCRIBE_OK — a plausible owner exists).
        second._triggerObject(910n, {
            kind: 'data', trackAlias: varint(70n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
        } as unknown as MoqtObject);
        await flush();
        const eventsMap = (player as unknown as { pendingStreamEvents: Map<unknown, Map<bigint, unknown>> }).pendingStreamEvents;
        // The OLD session closes ITS stream 910: same id, different session —
        // it must NOT fabricate evidence for the new session's parked object.
        adapter._triggerStreamClosed(910n);
        await flush();
        expect(eventsMap.get(adapter)).toBeUndefined();
        // The NEW session's own close records normally (sanity).
        second._triggerStreamClosed(910n);
        await flush();
        expect(eventsMap.get(second)?.has(910n)).toBe(true);
    });

    it('a real two-object pre-alias stream applies as a CLEAN independent-plus-delta chain (semantic companion to the multi-object pre-alias replay test)', async () => {
        const adapter = createMockAdapter(16);
        const { player, events } = await loadPlayer(adapter);
        await flush();
        const catalogs: string[][] = [];
        player.on('catalog_updated', (e) => catalogs.push(e.catalog.tracks.map((t: { name: string }) => t.name)));
        for (const [objectId, payload] of [
            [0n, enc(CATALOG)],
            [1n, enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'late', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] })],
        ] as Array<[bigint, Uint8Array]>) {
            adapter._triggerObject(300n, {
                kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
                objectId: varint(objectId), publisherPriority: 128, extensions: undefined, payload,
            } as unknown as MoqtObject);
        }
        adapter._triggerStreamClosed(300n);
        await flush();
        ackCatalog(adapter);   // largest absent → the replayed head supersedes the join
        await flush();
        expect(events).toEqual(['catalog_received', 'catalog_updated']);
        expect(catalogs[0]).toContain('late');             // the delta APPLIED after its head
    });
});

describe('catalog bootstrap wiring — unified lifecycle budget and explicit overflow', () => {
    it('retired-alias FINs and generic candidate FINs share ONE lifecycle budget — 64 + 1 fails closed', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        // 64 retired-alias objects, each on its own stream, each FINned →
        // 64 parkedEvents (exactly at the limit, no overflow yet).
        for (let i = 0; i < 64; i++) {
            const sid = BigInt(8000 + i);
            adapter._triggerObject(sid, {
                kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
            adapter._triggerStreamClosed(sid);
        }
        await flush();
        expect(loaded.errors).toEqual([]);                 // 64 = at the limit
        // The 65th lifecycle record arrives through the OTHER store (generic
        // candidate-owned parking): the SHARED budget must fail closed.
        adapter._triggerObject(9000n, {
            kind: 'data', trackAlias: varint(77n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
        } as unknown as MoqtObject);
        adapter._triggerStreamClosed(9000n);
        await flush();
        expect(loaded.errors.length).toBeGreaterThan(0);   // candidate aborted
        expect(loaded.events).toEqual(['catalog_received']);   // active retained
    });

    it('the MAIN bootstrap\'s pre-OK catalog evidence overflows EXPLICITLY into the ladder — never silent FIFO eviction', async () => {
        const adapter = createMockAdapter(16);
        const { events } = await loadPlayer(adapter);
        await flush();
        // 65 catalog-owned pre-alias streams during the initial bootstrap
        // (the catalog SUBSCRIBE_OK has not arrived): each parks one object
        // and FINs. The 65th must trip EXPLICIT overflow handling.
        const before = adapter.subscribe.mock.calls.length;
        for (let i = 0; i < 65; i++) {
            const sid = BigInt(8000 + i);
            adapter._triggerObject(sid, {
                kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
            adapter._triggerStreamClosed(sid);
        }
        await flush(); await flush();
        // Fail-closed ladder: with no known Largest the coordinator falls to
        // rung 2 — a fresh legacy catalog resubscribe goes out. Silent FIFO
        // eviction would leave the subscribe count unchanged.
        expect(adapter.subscribe.mock.calls.length).toBeGreaterThan(before);
        const resub = adapter.subscribe.mock.calls[adapter.subscribe.mock.calls.length - 1]!;
        expect(resub[2].subscriptionFilter.type).toBe('AbsoluteStart');
        expect(events).toEqual([]);                        // nothing blessed
    });

    it('the retained chain applies in RUNG 2 only under a CLEAN FIN — the replayed terminal is load-bearing', async () => {
        // Run the scenario twice: with the pre-alias FIN (chain applies) and
        // without it (chain dropped) — the FIN is the only difference.
        for (const withFin of [true, false]) {
            const adapter = createMockAdapter(16);
            const { player, events } = await loadPlayer(adapter);
            await flush();
            const catalogs: string[][] = [];
            player.on('catalog_updated', (e) => catalogs.push(e.catalog.tracks.map((t: { name: string }) => t.name)));
            // A two-object stream (independent head g5 + delta) parks pre-OK…
            for (const [objectId, payload] of [
                [0n, enc({ ...CATALOG, version: 1 })],
                [1n, enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'late', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] })],
            ] as Array<[bigint, Uint8Array]>) {
                adapter._triggerObject(300n, {
                    kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
                    objectId: varint(objectId), publisherPriority: 128, extensions: undefined, payload,
                } as unknown as MoqtObject);
            }
            if (withFin) adapter._triggerStreamClosed(300n);
            await flush();
            // …SUBSCRIBE_OK with Largest {5,1}: the head is NOT newer than the
            // join → it buffers as SUFFIX (with its stream evidence).
            adapter._triggerMessage({
                type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
                parameters: new Map([[varint(0x09n), [{ group: 5n, object: 1n }]]]),
                trackExtensions: [],
            } as unknown as ControlMessage);
            await flush();
            // The join AND the rung-1 emulation are refused → rung 2.
            adapter._triggerMessage({
                type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x1n),
                retryInterval: varint(0n), errorReason: 'join refused',
            } as unknown as ControlMessage);
            await flush();
            const rung1ReqId = BigInt(await adapter.fetch.mock.results[0]!.value);
            adapter._triggerMessage({
                type: 'REQUEST_ERROR', requestId: varint(rung1ReqId), errorCode: varint(0x1n),
                retryInterval: varint(0n), errorReason: 'fetch refused',
            } as unknown as ControlMessage);
            await flush(); await flush();
            // Rung-2 resubscribe binds a new alias; replayed history delivers
            // an OLD independent (group 2) → first acceptable base → ready.
            const rung2ReqId = BigInt(await adapter.subscribe.mock.results[adapter.subscribe.mock.results.length - 1]!.value);
            adapter._triggerMessage({
                type: 'SUBSCRIBE_OK', requestId: varint(rung2ReqId), trackAlias: varint(2n),
                parameters: new Map(), trackExtensions: [],
            } as unknown as ControlMessage);
            adapter._triggerObject(400n, {
                kind: 'data', trackAlias: varint(2n), groupId: varint(2n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined,
                payload: enc({ version: 1, tracks: [{ name: 'history', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video', codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 1 }] }),
            } as unknown as MoqtObject);
            await flush();
            if (withFin) {
                // CLEAN chain: the retained g5 head+delta supersedes history
                // (one catalog_updated per applied chain object).
                expect(events).toEqual(['catalog_received', 'catalog_updated', 'catalog_updated']);
                expect(catalogs[catalogs.length - 1]).toContain('late');
            } else {
                // No FIN evidence → the chain is NOT clean → never applied.
                expect(events).toEqual(['catalog_received']);
                expect(catalogs.every((c) => !c.includes('late'))).toBe(true);
            }
        }
    });
});

describe('catalog bootstrap wiring — main-bootstrap fail-closed budgets', () => {
    /** Drive object/byte/alias overflow against the MAIN bootstrap (pre-OK). */
    async function mainBootstrapOverflow(
        park: (adapter: ReturnType<typeof createMockAdapter>) => void,
    ): Promise<{ resubbed: boolean; events: string[] }> {
        const adapter = createMockAdapter(16);
        const { events } = await loadPlayer(adapter);
        await flush();
        const before = adapter.subscribe.mock.calls.length;
        park(adapter);
        await flush(); await flush();
        // Explicit fail-closed handling: with no known Largest the ladder
        // lands on rung 2 — a fresh AbsoluteStart catalog resubscribe.
        const resubbed = adapter.subscribe.mock.calls.length > before
            && adapter.subscribe.mock.calls[adapter.subscribe.mock.calls.length - 1]![2].subscriptionFilter.type === 'AbsoluteStart';
        return { resubbed, events };
    }

    it('main-bootstrap OBJECT overflow (spread across aliases) fails closed into the ladder', async () => {
        const { resubbed, events } = await mainBootstrapOverflow((adapter) => {
            for (const alias of [1n, 2n, 3n]) {
                for (let i = 0; i < 90; i++) {          // 270 > 256, each alias < 256
                    adapter._triggerObject(BigInt(4000 + Number(alias) * 500 + i), {
                        kind: 'data', trackAlias: varint(alias), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                        objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
                    } as unknown as MoqtObject);
                }
            }
        });
        expect(resubbed).toBe(true);
        expect(events).toEqual([]);
    });

    it('main-bootstrap BYTE overflow fails closed into the ladder', async () => {
        const big = new Uint8Array(1024 * 1024);
        const { resubbed, events } = await mainBootstrapOverflow((adapter) => {
            for (let i = 0; i < 5; i++) {               // 5 MiB > 4 MiB
                adapter._triggerObject(BigInt(4000 + i), {
                    kind: 'data', trackAlias: varint(1n), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                    objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: big,
                } as unknown as MoqtObject);
            }
        });
        expect(resubbed).toBe(true);
        expect(events).toEqual([]);
    });

    it('main-bootstrap ALIAS overflow (65 catalog-owned aliases) fails closed into the ladder', async () => {
        const { resubbed, events } = await mainBootstrapOverflow((adapter) => {
            for (let a = 0; a < 65; a++) {              // 65 > 64, generic cap is 1024
                adapter._triggerObject(BigInt(4000 + a), {
                    kind: 'data', trackAlias: varint(BigInt(500 + a)), groupId: varint(0n), subgroupId: varint(0n),
                    objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
                } as unknown as MoqtObject);
            }
        });
        expect(resubbed).toBe(true);
        expect(events).toEqual([]);
    });

    it('a BOUND candidate survives 257 unrelated media objects hitting the generic per-alias cap', async () => {
        const adapter = createMockAdapter(16);
        const loaded = await loadPlayer(adapter);
        await flush();
        ackCatalog(adapter);
        await deliverFetchObject(adapter, 3n, 100n, 5n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(3n), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(100n);
        await flush();
        const drainOpts = adapter.subscribe.mock.calls[0]![2];
        adapter._triggerMessage({
            type: 'PUBLISH_DONE', requestId: varint(1n), statusCode: varint(0x6n),
            streamCount: varint(0n), errorReason: 'too far behind',
        } as unknown as ControlMessage);
        drainOpts.onDrained(1n);
        await flush(); await flush();
        const candSubReqId = BigInt(adapter.joiningFetch.mock.calls[1]![0].joiningRequestId);
        const candFetchReqId = BigInt(await adapter.joiningFetch.mock.results[1]!.value);
        // The candidate BINDS — its request is answered, so subsequent parked
        // media is NOT catalog-owned.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(candSubReqId), trackAlias: varint(9n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        await flush();
        // 257 media pre-roll objects on ONE unresolved alias overflow the
        // GENERIC per-alias cap: generic drop policy only — the catalog
        // candidate must not be aborted for it.
        for (let i = 0; i < 257; i++) {
            adapter._triggerObject(BigInt(6000 + i), {
                kind: 'data', trackAlias: varint(60n), groupId: varint(BigInt(i)), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        await flush();
        expect(loaded.errors).toEqual([]);                 // candidate NOT aborted
        await deliverFetchObject(adapter, candFetchReqId, 500n, 8n, 0n, enc(CATALOG));
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(candFetchReqId), endOfTrack: 0,
            endLocation: { group: varint(8n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(500n);
        await flush(); await flush();
        expect(loaded.events).toEqual(['catalog_received', 'catalog_updated']);   // adopted
    });
});

describe('catalog bootstrap wiring — final-rung overflow terminals', () => {
    const baseAndDeltas = (adapter: ReturnType<typeof createMockAdapter>, alias: bigint, count: number) => {
        adapter._triggerObject(4000n, {
            kind: 'data', trackAlias: varint(alias), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        for (let i = 1; i <= count; i++) {
            adapter._triggerObject(BigInt(4000 + i), {
                kind: 'data', trackAlias: varint(alias), groupId: varint(5n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined,
                payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: `t${i}`, packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
            } as unknown as MoqtObject);
        }
    };

    it('overflow WITHIN rung 2 terminates the retrieval — a truncated catalog is never accepted and nothing revives it', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, errors } = await loadPlayer(adapter);
        await flush();
        // First overflow (65 catalog-owned aliases) → ladder → rung 2.
        for (let a = 0; a < 65; a++) {
            adapter._triggerObject(BigInt(3000 + a), {
                kind: 'data', trackAlias: varint(BigInt(500 + a)), groupId: varint(0n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        await flush(); await flush();
        const rung2ReqId = BigInt(await adapter.subscribe.mock.results[adapter.subscribe.mock.results.length - 1]!.value);
        expect(adapter.subscribe.mock.calls[adapter.subscribe.mock.calls.length - 1]![2].subscriptionFilter.type).toBe('AbsoluteStart');
        expect(errors).toEqual([]);                        // ladder, not fatal yet
        // WITHIN rung 2 (pre-OK): base + 256 deltas — the 257th delta is
        // load-bearing; dropping it silently would truncate the catalog.
        baseAndDeltas(adapter, 1n, 256);
        await flush();
        expect(errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
        expect(events).toEqual([]);                        // NOTHING accepted
        // Cleanup is complete: dead request, no binds, no revival.
        const internals = player as unknown as { catalogRequestId: bigint | null; pendingAliasBinds: Set<bigint> };
        expect(internals.catalogRequestId).toBeNull();
        expect(internals.pendingAliasBinds.size).toBe(0);
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(rung2ReqId), trackAlias: varint(2n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerObject(9000n, {
            kind: 'data', trackAlias: varint(2n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual([]);                        // late OK/object inert
    });

    it('direct-legacy pre-OK overflow (d14 auto AND explicit subscribe) terminates — no truncated catalog, no revival', async () => {
        for (const cfg of [
            { draftVersion: 14 as const, catalogBootstrap: 'subscribe' as const },
            { catalogBootstrap: 'subscribe' as const },
        ]) {
            const adapter = createMockAdapter('draftVersion' in cfg ? 14 : 16);
            const { player, events, errors } = await loadPlayer(adapter, cfg);
            await flush();
            // Base + 256 deltas park pre-OK; the 257th is load-bearing.
            baseAndDeltas(adapter, 1n, 256);
            await flush();
            expect(errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
            expect(events).toEqual([]);
            const internals = player as unknown as { catalogRequestId: bigint | null; pendingAliasBinds: Set<bigint> };
            expect(internals.catalogRequestId).toBeNull();
            expect(internals.pendingAliasBinds.size).toBe(0);
            // A late SUBSCRIBE_OK + object must not revive the retrieval.
            ackCatalog(adapter);
            adapter._triggerObject(9000n, {
                kind: 'data', trackAlias: varint(1n), groupId: varint(9n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
            } as unknown as MoqtObject);
            await flush();
            expect(events).toEqual([]);
        }
    });
});

describe('catalog bootstrap wiring — exception-safe terminal cleanup', () => {
    /** Drive: initial overflow → rung 2 → truncating overflow within rung 2. */
    async function rung2Overflow(adapter: ReturnType<typeof createMockAdapter>, cfg?: Record<string, unknown>) {
        const loaded = await loadPlayer(adapter, cfg);
        await flush();
        for (let a = 0; a < 65; a++) {
            adapter._triggerObject(BigInt(3000 + a), {
                kind: 'data', trackAlias: varint(BigInt(500 + a)), groupId: varint(0n), subgroupId: varint(0n),
                objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: new Uint8Array(1),
            } as unknown as MoqtObject);
        }
        await flush(); await flush();
        const rung2ReqId = BigInt(await adapter.subscribe.mock.results[adapter.subscribe.mock.results.length - 1]!.value);
        return { ...loaded, rung2ReqId };
    }

    function overflowRung2(adapter: ReturnType<typeof createMockAdapter>): void {
        adapter._triggerObject(4000n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        for (let i = 1; i <= 256; i++) {
            adapter._triggerObject(BigInt(4000 + i), {
                kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined,
                payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: `t${i}`, packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
            } as unknown as MoqtObject);
        }
    }

    function assertTerminalCleanup(
        adapter: ReturnType<typeof createMockAdapter>,
        player: unknown,
        rung2ReqId: bigint,
        events: string[],
    ): void {
        const internals = player as {
            catalogRequestId: bigint | null;
            pendingAliasBinds: Set<bigint>;
            pendingObjectsByAlias: Map<bigint, unknown[]>;
            pendingStreamEvents: Map<unknown, Map<bigint, unknown>>;
        };
        expect(internals.catalogRequestId).toBeNull();
        expect(internals.pendingAliasBinds.size).toBe(0);
        expect(internals.pendingObjectsByAlias.get(1n)).toBeUndefined();   // txn-owned objects reclaimed
        expect(internals.pendingStreamEvents.get(adapter) ?? new Map()).toEqual(new Map());
        // Unsubscribed EXACTLY once for the terminating request.
        const unsubs = adapter.unsubscribe.mock.calls.filter((c: unknown[]) => BigInt(c[0] as bigint) === rung2ReqId);
        expect(unsubs).toHaveLength(1);
        // Late SUBSCRIBE_OK + data are inert.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(rung2ReqId), trackAlias: varint(2n),
            parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerObject(9500n, {
            kind: 'data', trackAlias: varint(2n), groupId: varint(9n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        expect(events).toEqual([]);
    }

    it('final-rung cleanup completes even when an application ERROR LISTENER throws mid-publication', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, rung2ReqId } = await rung2Overflow(adapter);
        player.on('error', () => { throw new Error('listener boom'); });
        // Park base + 255 deltas (AT the limit, no overflow), and FIN one
        // contributing stream so real LIFECYCLE EVIDENCE exists.
        adapter._triggerObject(4000n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        for (let i = 1; i <= 255; i++) {
            adapter._triggerObject(BigInt(4000 + i), {
                kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
                objectId: varint(BigInt(i)), publisherPriority: 128, extensions: undefined,
                payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: `t${i}`, packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
            } as unknown as MoqtObject);
        }
        adapter._triggerStreamClosed(4001n);
        const lifecycle = (player as unknown as { pendingStreamEvents: Map<unknown, Map<bigint, unknown>> }).pendingStreamEvents;
        expect(lifecycle.get(adapter)?.has(4001n)).toBe(true);   // evidence EXISTS
        // The 257th (load-bearing) object overflows: fatal publication throws
        // through the listener (exception contract preserved)…
        expect(() => adapter._triggerObject(4300n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(5n), subgroupId: varint(0n),
            objectId: varint(300n), publisherPriority: 128, extensions: undefined,
            payload: enc({ deltaUpdate: [{ op: 'add', tracks: [{ name: 'load-bearing', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }] }),
        } as unknown as MoqtObject)).toThrow('listener boom');
        await flush();
        // …but cleanup ALREADY ran — including reclaiming that exact record.
        expect(lifecycle.get(adapter)?.has(4001n) ?? false).toBe(false);
        assertTerminalCleanup(adapter, player, rung2ReqId, events);
        await flush();
        expect(events).toEqual([]);
    });

    it('final-rung cleanup completes even when a configured errorFilter throws pre-emission', async () => {
        const adapter = createMockAdapter(16);
        const { player, events, rung2ReqId } = await rung2Overflow(adapter, {
            errorFilter: (e: unknown) => {
                if ((e as { severity?: string }).severity === 'fatal') throw new Error('filter boom');
                return e as never;
            },
        });
        expect(() => overflowRung2(adapter)).toThrow('filter boom');
        await flush();
        assertTerminalCleanup(adapter, player, rung2ReqId, events);
        await flush();
        expect(events).toEqual([]);
    });
});

describe('catalog bootstrap wiring — strict mode and draft boundaries', () => {
    it('STRICT standards mode never falls off the joining path — a refused join is FATAL, no emulation, no resubscribe', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await loadPlayer(adapter, { catalogBootstrap: 'strict' });
        await flush();
        // Largest IS known — compatibility mode would take rung-1 emulation.
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map([[varint(0x09n), [{ group: 5n, object: 1n }]]]),
            trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x1n),
            retryInterval: varint(0n), errorReason: 'joining fetch not supported',
        } as unknown as ControlMessage);
        await flush(); await flush();
        expect(errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
        expect(adapter.fetch).not.toHaveBeenCalled();              // no rung-1 emulation
        expect(adapter.subscribe.mock.calls.length).toBe(1);       // no rung-2 resubscribe
        expect(events).toEqual([]);
    });

    it('draft-14 empty-track uses INVALID_RANGE 0x5 — EMPTY_WAIT, not the refusal ladder', async () => {
        const adapter = createMockAdapter(14);
        const { events } = await loadPlayer(adapter, { draftVersion: 14 });
        await flush();
        ackCatalog(adapter);                                       // d14: join fires after SUBSCRIBE_OK
        await flush();
        expect(adapter.joiningFetch).toHaveBeenCalledTimes(1);
        const joinReqId = BigInt(await adapter.joiningFetch.mock.results[0]!.value);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(joinReqId), errorCode: varint(0x5n),   // d14 INVALID_RANGE
            retryInterval: varint(0n), errorReason: 'track has not published any objects',
        } as unknown as ControlMessage);
        await flush(); await flush();
        // EMPTY_WAIT: no rung-1 fetch, no legacy resubscribe — just wait.
        expect(adapter.fetch).not.toHaveBeenCalled();
        expect(adapter.subscribe.mock.calls.length).toBe(1);
        // The first live head completes the bootstrap.
        adapter._triggerObject(100n, {
            kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
            objectId: varint(0n), publisherPriority: 128, extensions: undefined, payload: enc(CATALOG),
        } as unknown as MoqtObject);
        await flush();
        expect(events).toEqual(['catalog_received']);
    });

    it('a draft-18 Largest above the QUIC-varint ceiling still drives the rung-1 emulation range (vi64 stays bigint)', async () => {
        const adapter = createMockAdapter(18);
        await loadPlayer(adapter, { draftVersion: 18 });
        await flush();
        const big = 2n ** 62n;                                     // legal d18 vi64, > QUIC varint max
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map([[varint(0x09n), [{ group: big, object: 3n }]]]),
            trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x1n),
            retryInterval: varint(0n), errorReason: 'join refused',
        } as unknown as ControlMessage);
        await flush(); await flush();
        // Rung 1 went out with the RAW vi64 range — no varint() rejection.
        expect(adapter.fetch).toHaveBeenCalledTimes(1);
        const range = adapter.fetch.mock.calls[0]![2];
        expect(BigInt(range.startGroup)).toBe(big);
        expect(BigInt(range.endGroup)).toBe(big);
        expect(BigInt(range.endObject)).toBe(0n);                  // whole-group encoding
    });
});

describe('catalog bootstrap wiring — MSF-01 fallback conformance', () => {
    /** Refuse the join (largest KNOWN) so rung-1 emulation serves the prefix. */
    async function viaEmulation(adapter: ReturnType<typeof createMockAdapter>, payload: Uint8Array) {
        const loaded = await loadPlayer(adapter);
        await flush();
        adapter._triggerMessage({
            type: 'SUBSCRIBE_OK', requestId: varint(1n), trackAlias: varint(1n),
            parameters: new Map([[varint(0x09n), [{ group: 5n, object: 1n }]]]),
            trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerMessage({
            type: 'REQUEST_ERROR', requestId: varint(3n), errorCode: varint(0x1n),
            retryInterval: varint(0n), errorReason: 'join refused',
        } as unknown as ControlMessage);
        await flush(); await flush();
        const emuReqId = BigInt(await adapter.fetch.mock.results[0]!.value);
        await deliverFetchObject(adapter, emuReqId, 200n, 5n, 0n, payload);
        adapter._triggerMessage({
            type: 'FETCH_OK', requestId: varint(emuReqId), endOfTrack: 0,
            endLocation: { group: varint(5n), object: varint(1n) }, parameters: new Map(), trackExtensions: [],
        } as unknown as ControlMessage);
        adapter._triggerStreamClosed(200n);
        await flush();
        return loaded;
    }

    it('an MSF-01 catalog acquired through the FALLBACK rung is REJECTED by default (§5 MUST is unconditional)', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await viaEmulation(adapter, enc(CATALOG));   // version 'draft-01' = MSF-01
        expect(events).toEqual([]);                                             // never blessed
        expect(errors.some((e) => (e as { severity?: string }).severity === 'fatal')).toBe(true);
    });

    it('an MSF-00 catalog through the SAME fallback path is accepted — no joining MUST exists for it', async () => {
        const adapter = createMockAdapter(16);
        const { events, errors } = await viaEmulation(adapter, enc({ ...CATALOG, version: 1 }));
        expect(events).toEqual(['catalog_received']);
        expect(errors).toEqual([]);
    });
});
