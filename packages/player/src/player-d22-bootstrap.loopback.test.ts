/**
 * Catalog bootstrap over the in-memory draft-22 loopback: a REAL MoqtPlayer
 * drives a REAL MoqtConnection(22) client against a REAL server connection
 * acting as a minimal catalog publisher. Draft 22 has no Joining FETCH: the
 * catalog SUBSCRIBE carries FILL_PARAMETERS for the current group and the
 * publisher answers on a fill fetch stream (no FETCH_OK; the FIN completes it).
 *
 * @see draft-ietf-moq-msf-01 §5, draft-ietf-moq-transport-22 §3.4
 */

import { describe, it, expect } from 'vitest';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { MoqtPlayer } from './player.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import { varint } from '@openmoq/transport';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const td = new TextDecoder();
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await flush(); };
const FILL_PARAMETERS = 0x23n;

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
    catalogAlias: bigint;
    catalogFill: Uint8Array | null;
    fetches: number;
    mediaSubs: Array<{ reqId: bigint; name: string; fill: boolean }>;
}

function wireServer(server: MoqtConnection, opts?: { resetFill?: boolean; empty?: boolean }): ServerState {
    const state: ServerState = { catalogAlias: 40n, catalogFill: null, fetches: 0, mediaSubs: [] };
    let nextAlias = 41n;
    server.onFetch = () => { state.fetches += 1; };
    server.onSubscribe = (requestId, _ns, trackName, params) => {
        const name = td.decode(trackName);
        const fill = (params as Map<bigint, unknown[]> | undefined)?.get(FILL_PARAMETERS)?.[0] as Uint8Array | undefined;
        void (async () => {
            if (name !== 'catalog') {
                state.mediaSubs.push({ reqId: requestId, name, fill: fill !== undefined });
                await server.acceptSubscribe(requestId, nextAlias++);
                return;
            }
            state.catalogFill = fill ?? null;
            if (opts?.empty) {
                // No content yet: no LARGEST_OBJECT, so no fill stream (§3.4).
                await server.acceptSubscribe(requestId, state.catalogAlias);
                return;
            }
            await server.acceptSubscribe(requestId, state.catalogAlias, {
                parameters: new Map([[0x09n, [{ group: 5n, object: 1n }]]]) as never,
            });
            if (fill === undefined) return;
            const sid = await server.openFillStream(requestId);
            await server.sendFetchObject(sid, { groupId: 5n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: enc(CATALOG) });
            if (opts?.resetFill) {
                // No public reset API for served fetch streams: abort the writer.
                const streams = (server as unknown as { fetchOutgoingStreams: Map<bigint, { writer: WritableStreamDefaultWriter }> })
                    .fetchOutgoingStreams;
                await streams.get(sid)!.writer.abort(new Error('fill failed'));
                return;
            }
            await server.sendFetchObject(sid, { groupId: 5n, subgroupId: 0n, objectId: 1n, publisherPriority: 5, payload: enc(DELTA) });
            await server.closeFetchStream(sid);
        })();
    };
    return state;
}

function newPlayer(client: unknown): MoqtPlayer {
    return new MoqtPlayer({
        url: 'https://unused.example/moq',
        namespace: 'live/broadcast',
        connection: client as MoqtConnection,
        createTransport: async () => ({}) as never,
        draftVersion: 22,
    });
}

describe('d22 loopback — catalog bootstrap from a SUBSCRIBE fill', () => {
    it('the fill supplies head + delta, no FETCH is sent, and the live tail applies after readiness', async () => {
        const { client, server, errors } = await connectedPair(22);
        const state = wireServer(server as unknown as MoqtConnection);
        const player = newPlayer(client);
        const events: string[] = [];
        const received: string[][] = [];
        player.on('catalog_received', (e) => { events.push('received'); received.push(e.catalog.tracks.map((t) => t.name)); });
        player.on('catalog_updated', (e) => { events.push('updated'); received.push(e.catalog.tracks.map((t) => t.name)); });
        const playerErrors: unknown[] = [];
        player.on('error', (e) => playerErrors.push(e.error));

        await player.load();
        await settle();

        // FILL_PARAMETERS = LOCATION_FILTER [1]: the current group.
        expect(state.catalogFill && Array.from(state.catalogFill)).toEqual([0x21, 0x01, 0x01]);
        expect(state.fetches).toBe(0);
        expect(events).toEqual(['received']);
        expect(received[0]).toEqual(['video', 'audio']);

        const gid = await (server as unknown as MoqtConnection).openSubgroup(
            varint(state.catalogAlias), varint(5n), varint(0n), { endOfGroup: false, publisherPriority: 128 });
        await (server as unknown as MoqtConnection).sendObject(gid, varint(2n), enc({
            deltaUpdate: [{ op: 'add', tracks: [{ name: 'captions', packaging: 'loc', renderGroup: 1, isLive: true, role: 'caption', codec: 'wvtt' }] }],
        }));
        await (server as unknown as MoqtConnection).closeSubgroup(gid);
        await settle();

        expect(events).toEqual(['received', 'updated']);
        expect(received[1]).toEqual(['video', 'audio', 'captions']);
        // Media subscriptions ask for no fill unless warm start is on.
        expect(state.mediaSubs.map((m) => [m.name, m.fill])).toContainEqual(['video', false]);
        expect(playerErrors).toEqual([]);
        expect(errors).toEqual([]);

        // PUBLISH_DONE statuses on draft 22: SUBSCRIPTION_ENDED (0x3) is gone.
        const done = player as unknown as { normalizePublishDoneStatus(code: bigint): string };
        expect(done.normalizePublishDoneStatus(0x2n)).toBe('ended');
        expect(done.normalizePublishDoneStatus(0x3n)).toBe('retriable');
        expect(done.normalizePublishDoneStatus(0x12n)).toBe('fatal-track');
        await player.destroy();
    });

    it('an empty track opens no fill: the first live catalog object completes the bootstrap', async () => {
        const { client, server, errors } = await connectedPair(22);
        const state = wireServer(server as unknown as MoqtConnection, { empty: true });
        let catalogSubs = 0;
        const orig = server.onSubscribe!;
        server.onSubscribe = (requestId, ns, trackName, params) => {
            if (td.decode(trackName) === 'catalog') catalogSubs += 1;
            orig(requestId, ns, trackName, params);
        };
        const player = newPlayer(client);
        const received: string[][] = [];
        player.on('catalog_received', (e) => received.push(e.catalog.tracks.map((t) => t.name)));

        await player.load();
        await settle();
        expect(received).toEqual([]);

        const gid = await (server as unknown as MoqtConnection).openSubgroup(
            varint(state.catalogAlias), varint(0n), varint(0n), { endOfGroup: false, publisherPriority: 128 });
        await (server as unknown as MoqtConnection).sendObject(gid, varint(0n), enc(CATALOG));
        await (server as unknown as MoqtConnection).closeSubgroup(gid);
        await settle();

        expect(received).toEqual([['video']]);
        expect(catalogSubs).toBe(1);
        expect(state.fetches).toBe(0);
        expect(errors).toEqual([]);
        await player.destroy();
    });

    it('a reset fill fails the attempt and the fallback ladder recovers', async () => {
        const { client, server, errors } = await connectedPair(22);
        const state = wireServer(server as unknown as MoqtConnection, { resetFill: true });
        let catalogSubs = 0;
        const orig = server.onSubscribe!;
        server.onSubscribe = (requestId, ns, trackName, params) => {
            if (td.decode(trackName) === 'catalog') catalogSubs += 1;
            orig(requestId, ns, trackName, params);
        };
        const player = newPlayer(client);
        const received: string[][] = [];
        player.on('catalog_received', (e) => received.push(e.catalog.tracks.map((t) => t.name)));

        await player.load();
        await settle(24);

        // The failed prefix is recovered by the fallback ladder; whichever rung
        // served it, the session survives and the catalog is never half-applied.
        expect(catalogSubs + state.fetches).toBeGreaterThan(1);
        expect(received.every((r) => r.includes('video'))).toBe(true);
        expect(errors).toEqual([]);
        await player.destroy();
    });
});
