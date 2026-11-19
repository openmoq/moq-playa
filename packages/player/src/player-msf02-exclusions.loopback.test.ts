// Real draft-23 SDK subscription observation; no native browser is modeled.
import { expect, it } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { parseMsfCatalog } from '@openmoq/msf';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer, buildCatalogSelection, type ExcludedTrack } from './index.js';

it('reports MSF-02 exclusions and never subscribes excluded media, auxiliary or init references', async () => {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(23), server = new MoqtConnection(23, { role: 'server' });
  const names: string[] = [];
  server.onSubscribe = (_id, _ns, name) => { names.push(new TextDecoder().decode(name)); };
  const video = { packaging: 'loc', role: 'video', isLive: true, codec: 'avc1', bitrate: 100, framerate: 30, altGroup: 1 };
  const catalog = parseMsfCatalog(JSON.stringify({ version: 'draft-02', tracks: [
    { ...video, name: 'video', initTrack: 'reference' },
    { ...video, name: 'encrypted-video', encryptionScheme: 'cenc' },
    { ...video, name: 'video-%id%' },
    { name: 'reference', packaging: 'catalog', isLive: true },
    { name: 'encrypted-timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['video'], encryptionScheme: 'cenc' },
    { name: 'events-%id%', packaging: 'eventtimeline', isLive: true, eventType: 'example', depends: ['video'] },
    { name: 'encrypted-events', packaging: 'eventtimeline', isLive: true, eventType: 'example', depends: ['video'], encryptionScheme: 'cenc' },
  ] }), ['live']);
  let serving: Promise<void> | undefined;
  const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: 23,
    catalog, disableAudio: true, autoQuality: false,
    createConnection: () => client, createTransport: async () => { serving = server.connect(b); return a; } });
  let excluded: readonly ExcludedTrack[] = [];
  player.on('catalog_received', e => { excluded = buildCatalogSelection(e.catalog, { catalogNamespace: ['live'] }).excluded; });
  try {
    await player.load(); await flush(128);
    expect(names).toEqual(['video']);
    expect(player.availableVideoGroups.flatMap(g => g.tracks.map(t => t.name))).toEqual(['video']);
    expect(excluded.map(t => [t.id.name, t.reason])).toEqual([
      ['encrypted-video', 'encrypted'], ['video-%id%', 'unresolved-variable'], ['reference', 'catalog-reference'],
      ['encrypted-timeline', 'encrypted'], ['events-%id%', 'unresolved-variable'], ['encrypted-events', 'encrypted'],
    ]);
  } finally { await player.destroy(); await server.close(); await serving; }
});
