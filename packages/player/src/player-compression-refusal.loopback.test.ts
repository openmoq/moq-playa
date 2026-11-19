// Real SDK metadata refusals; no native playback claim.
import { expect, it } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { MoqtPlayer } from './player.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it.each(['draft-02', 'draft-01', '1'].flatMap(version => ['catalog', 'timeline'].map(target => ({ version, target }))))(
  'refuses unsupported $target track compression under $version', async ({ version, target }) => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
    const requests: { id: bigint; name: string }[] = [], stopped: bigint[] = [], errors: string[] = [];
    let catalogs = 0, timelines = 0, serving: Promise<void> | undefined;
    server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
    server.onSubscribeClosed = id => { stopped.push(id); };
    const player = new MoqtPlayer({ url: 'https://compression.invalid/moq', namespace: ['live'], draftVersion: 18,
      catalogBootstrap: 'subscribe', disableAudio: true, autoQuality: false,
      createConnection: () => client, createTransport: async () => { serving = server.connect(b); return a; } });
    player.on('error', event => { errors.push(event.error.message); });
    player.on('catalog_received', () => { catalogs++; }); player.on('timeline_loaded', () => { timelines++; });
    try {
      await player.load(); await flush(128);
      const catalog = requests[0]!;
      await server.acceptSubscribe(catalog.id, 10n, { trackProperties: target === 'catalog' ? new Map([[0x78n, [2n]]]) : new Map() });
      const stream = await server.openSubgroup(10n, 1n, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, encode({ version, tracks: [
        { name: 'v', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1', bitrate: 100, framerate: 30 },
        { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['v'] },
      ] })); await flush(256);
      if (target === 'catalog') {
        expect(catalogs).toBe(0); expect(requests.map(r => r.name)).toEqual(['catalog']);
        expect(stopped).toContain(catalog.id); expect(player.state).toBe('error');
      } else {
        expect(catalogs).toBe(1);
        const timeline = requests.find(r => r.name === 'timeline')!;
        await server.acceptSubscribe(requests.find(r => r.name === 'v')!.id, 20n);
        await server.acceptSubscribe(timeline.id, 21n, { trackProperties: new Map([[0x78n, [2n]]]) });
        const stream = await server.openSubgroup(21n, 1n, 0n, { publisherPriority: 128 });
        await server.sendObject(stream, 0n, encode([[1000, [3, 0], 0]])); await flush(256);
        expect(timelines).toBe(0); expect(stopped).toContain(timeline.id);
        expect(player.seekable).toBe(false); expect(player.state).not.toBe('error');
        player.play(); await expect(player.seek(500)).rejects.toThrow(/MSF_COMPRESSION 2/);
      }
      if (target === 'catalog') expect(errors.some(message => message.includes('MSF_COMPRESSION 2'))).toBe(true);
    } finally { await player.destroy(); await server.close(); await serving; }
  });
