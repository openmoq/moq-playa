// Real draft-23 SDK loopback; decoder and renderer are modeled.
import { expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { parseMsfCatalog } from '@openmoq/msf';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { codecDescriptionFromInit } from '@openmoq/locmaf';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { VideoDecoderLike, VideoRendererLike } from './interfaces.js';

it.each(['track-property', 'object-property'])('uses MSF-02 %s initialization while consuming one object per subgroup', async type => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(23), server = new MoqtConnection(23, { role: 'server' });
    const requests: bigint[] = [];
    server.onSubscribe = id => { requests.push(id); };
    const video: VideoDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0,
        onFrame: null, onError: null, decode: vi.fn(chunk => { video.onFrame?.({ timestamp: chunk.timestamp, close() {} }, undefined, null); }) };
    const renderer: VideoRendererLike = { flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null, enqueue: vi.fn() };
    const config = codecDescriptionFromInit(videoInit())!;
    const catalog = parseMsfCatalog(JSON.stringify({ version: 'draft-02', initDataList: [{ id: 'init', type, data: '0x0D' }], tracks: [
        { name: 'v', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.4D4028', bitrate: 100, framerate: 30,
            initRef: 'init', packagingMetadata: 'streamMapping=object' },
    ] }), ['live']);
    let serving: Promise<void> | undefined, clock = 1000000;
    const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: 23,
        catalog, disableAudio: true, autoQuality: false, clock: { now: () => clock },
        createConnection: () => client, createTransport: async () => { serving = server.connect(b); return a; },
        createVideoDecoder: () => video, createRenderer: () => renderer });
    const errors: string[] = [];
    const received = vi.fn();
    player.on('catalog_received', received);
    player.on('error', e => errors.push(e.error.message));
    try {
        await player.load(); await flush(128);
        expect(requests).toHaveLength(1);
        await server.acceptSubscribe(requests[0]!, 77n, type === 'track-property' ? { trackProperties: new Map([[0x0Dn, [config]]]) } : {});
        await flush(128);
        for (let object = 0; object < 3; object++) {
            const extensions = encodeLocHeaders({ captureTimestamp: BigInt(clock + object * 33000),
                ...(type === 'object-property' ? { videoConfig: config } : {}),
                videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: object === 0, discardable: false, baseLayerSync: false, temporalId: 0 },
            }, { wireProfile: locWireProfileForDraft(23) });
            const stream = await server.openSubgroup(77n, 0n, BigInt(object), { publisherPriority: 128, hasExtensions: true });
            await server.sendObject(stream, BigInt(object), Uint8Array.of(0, 0, 0, 1, object === 0 ? 0x65 : 0x41, object), extensions);
            await server.closeSubgroup(stream); await flush(128);
        }
        for (let i = 0; i < 12; i++) { clock += 33000; player.tick(); }
        expect(video.configure).toHaveBeenCalled();
        const configured = vi.mocked(video.configure).mock.calls.at(-1)![0];
        expect(configured).toEqual(config);
        expect(video.decode).toHaveBeenCalledTimes(3);
        expect(received.mock.calls[0]![0].catalog.msfDraft).toBe('draft-02');
        expect(errors).toEqual([]);
    } finally { await player.destroy(); await server.close(); await serving; }
});
