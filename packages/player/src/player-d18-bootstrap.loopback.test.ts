/**
 * Deterministic end-to-end catalog bootstrap over the in-memory draft-18
 * loopback: a REAL MoqtPlayer drives a REAL MoqtConnection(18) client against
 * a REAL server connection acting as a minimal catalog publisher. No network,
 * CI-safe. (Publisher-side fetch serving — openFetchStream — is draft-18-only,
 * which is why this integration lives on 18; 14/16 are covered at the codec,
 * session, and player-mock levels.)
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @moqt/webtransport.
 *
 * @see draft-ietf-moq-msf-01 §5, draft-ietf-moq-transport-18 §10.12.2
 */

import { describe, it, expect } from 'vitest';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { MoqtPlayer } from './player.js';
import type { MoqtConnection } from '@moqt/webtransport';
import { varint } from '@moqt/transport';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const td = new TextDecoder();
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await flush(); };

const CATALOG = {
    version: 'draft-01',
    tracks: [
        { name: 'video', packaging: 'loc', renderGroup: 1, isLive: true, role: 'video',
          codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000 },
    ],
};
const DELTA = {
    deltaUpdate: [{ op: 'add', tracks: [{ name: 'audio', packaging: 'loc', renderGroup: 1, isLive: true, role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 }] }],
};

interface ServerState {
    catalogSubReqId: bigint | null;
    catalogAlias: bigint;
    joinReqId: bigint | null;
    joinRange: { startLocation: { group: bigint; object: bigint }; endLocation: { group: bigint; object: bigint } } | null;
    mediaSubs: Array<{ reqId: bigint; name: string }>;
}

/** Wire the server side as a minimal catalog publisher. */
function wireServer(server: MoqtConnection, opts?: { refuseJoin?: boolean }): ServerState {
    const state: ServerState = { catalogSubReqId: null, catalogAlias: 40n, joinReqId: null, joinRange: null, mediaSubs: [] };
    let nextAlias = 41n;
    server.onSubscribe = (requestId, _ns, trackName) => {
        const name = td.decode(trackName);
        void (async () => {
            if (name === 'catalog') {
                state.catalogSubReqId = requestId;
                // §5.1: communicate the Largest Location {5,1} in SUBSCRIBE_OK
                // — the session SAVES it as the subscription's Joining
                // Location (the authoritative join anchor).
                await server.acceptSubscribe(requestId, state.catalogAlias, {
                    parameters: new Map([[0x09n, [{ group: 5n, object: 1n }]]]) as never,
                });
            } else {
                const alias = nextAlias++;
                state.mediaSubs.push({ reqId: requestId, name });
                await server.acceptSubscribe(requestId, alias);
            }
        })();
    };
    server.onFetch = (requestId) => {
        state.joinReqId = requestId;
        void (async () => {
            if (opts?.refuseJoin) {
                await server.rejectFetch(requestId, 0x10n, 'track not found');
                return;
            }
            // The SAVED Joining Location (from SUBSCRIBE_OK) anchors the
            // range — resolution takes NO app-supplied head.
            const range = server.resolveJoiningFetch(requestId);
            state.joinRange = range;
            await server.acceptFetch(requestId, { endLocation: range.endLocation });
            const sid = await server.openFetchStream(requestId);
            await server.sendFetchObject(sid, { groupId: 5n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: enc(CATALOG) });
            await server.sendFetchObject(sid, { groupId: 5n, subgroupId: 0n, objectId: 1n, publisherPriority: 5, payload: enc(DELTA) });
            await server.closeFetchStream(sid);
        })();
    };
    return state;
}

describe('d18 loopback — catalog bootstrap end-to-end (#28/#30)', () => {
    it('parked join on the Pending catalog subscription; served head+delta; live tail applies after readiness', async () => {
        const { client, server, errors } = await connectedPair(18);
        const state = wireServer(server as unknown as MoqtConnection);

        const player = new MoqtPlayer({
            url: 'https://unused.example/moq',
            namespace: 'live/broadcast',
            connection: client as unknown as MoqtConnection,
            createTransport: async () => ({}) as never,
            draftVersion: 18,
        });
        const events: string[] = [];
        const received: string[][] = [];
        player.on('catalog_received', (e) => { events.push('received'); received.push(e.catalog.tracks.map((t) => t.name)); });
        player.on('catalog_updated', (e) => { events.push('updated'); received.push(e.catalog.tracks.map((t) => t.name)); });
        const playerErrors: unknown[] = [];
        player.on('error', (e) => playerErrors.push(e.error));

        await player.load();
        await settle();

        // The join reached the server (released from its Pending-parking by the
        // accept), the prefix was served and converged: ONE catalog_received
        // with head + delta applied.
        expect(state.joinReqId).not.toBeNull();
        // End-location CONTINUITY: the served prefix ends exactly one past
        // the saved Joining Location {5,1} — contiguous with the Largest
        // Object subscription's delivery, no gap and no overlap.
        expect(state.joinRange?.startLocation).toEqual({ group: 5n, object: 0n });
        expect(state.joinRange?.endLocation).toEqual({ group: 5n, object: 2n });
        expect(events).toEqual(['received']);
        expect(received[0]).toEqual(['video', 'audio']);

        // Live tail on the catalog alias (contiguous after the join point).
        const gid = await (server as unknown as MoqtConnection).openSubgroup(
            varint(state.catalogAlias), varint(5n), varint(0n), { endOfGroup: false, publisherPriority: 128 });
        await (server as unknown as MoqtConnection).sendObject(gid, varint(2n), enc({
            deltaUpdate: [{ op: 'add', tracks: [{ name: 'captions', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }],
        }));
        await (server as unknown as MoqtConnection).closeSubgroup(gid);
        await settle();

        expect(events).toEqual(['received', 'updated']);
        expect(received[1]).toEqual(['video', 'audio', 'captions']);

        // The media subscription for the selected track went out.
        expect(state.mediaSubs.map((m) => m.name)).toContain('video');
        expect(playerErrors).toEqual([]);
        expect(errors).toEqual([]);
        await player.destroy();
    });

    it('refused join → fallback observed as a second inbound catalog SUBSCRIBE (AbsoluteStart)', async () => {
        const { client, server, errors } = await connectedPair(18);
        const subs: bigint[] = [];
        const state = wireServer(server as unknown as MoqtConnection, { refuseJoin: true });
        const origOnSubscribe = server.onSubscribe!;
        let catalogSubCount = 0;
        server.onSubscribe = (requestId, ns, trackName) => {
            subs.push(requestId);
            if (td.decode(trackName) === 'catalog') catalogSubCount += 1;
            origOnSubscribe(requestId, ns, trackName, new Map());
        };

        const player = new MoqtPlayer({
            url: 'https://unused.example/moq',
            namespace: 'live/broadcast',
            connection: client as unknown as MoqtConnection,
            createTransport: async () => ({}) as never,
            draftVersion: 18,
        });
        const playerErrors: unknown[] = [];
        player.on('error', (e) => playerErrors.push(e.error));

        await player.load();
        await settle(16);

        // Refusal (no largest known) → rung 2: unsubscribe + fresh AbsoluteStart
        // subscribe. Observed server-side as a SECOND inbound catalog SUBSCRIBE.
        expect(state.joinReqId).not.toBeNull();
        expect(catalogSubCount).toBe(2);
        expect(playerErrors).toEqual([]);
        expect(errors).toEqual([]);
        await player.destroy();
    });
});
