import { describe, expect, it } from 'vitest';
import { buildCatalog, parseCatalogAuto } from '@openmoq/msf';
import { mapAudioTracks, mapLevels } from './level-mapper.js';
import type { CatalogState } from '@openmoq/msf';

describe('catalog audio language mapping', () => {
  for (const version of [1, '1'] as const) {
    it(`maps the wire lang field through the public audio list for version ${JSON.stringify(version)}`, () => {
      const catalog = parseCatalogAuto(buildCatalog({ version, tracks: [
        { name: 'video', packaging: 'cmaf', isLive: true, codec: 'avc1.42c028' },
        { name: 'audio-en', packaging: 'cmaf', isLive: true, codec: 'mp4a.40.2', lang: 'en', label: 'English signal' },
        { name: 'audio-es', packaging: 'cmaf', isLive: true, codec: 'mp4a.40.2', lang: 'es' },
        { name: 'unlabelled', packaging: 'cmaf', isLive: true, codec: 'opus' },
      ] }));
      expect(mapAudioTracks(catalog)).toEqual([
        { index: 0, label: 'English signal', language: 'en', codec: 'mp4a.40.2' },
        { index: 1, label: 'es', language: 'es', codec: 'mp4a.40.2' },
        { index: 2, label: 'Audio 3', language: undefined, codec: 'opus' },
      ]);
    });
  }
});

describe('menu track identity', () => {
  const catalog = { version: 1, tracks: [
    { name: 'audio', codec: 'opus', packaging: 'loc', isLive: true, lang: 'en' },
    { name: 'audio', namespace: 'live/show', codec: 'opus', packaging: 'loc', isLive: true, lang: 'es' },
  ] } as CatalogState;

  it('keeps a configured namespace field containing a slash distinct from catalog text', () => {
    const tracks = mapAudioTracks(catalog, ['live/show']);
    expect(tracks.map(track => track.id)).toEqual([
      JSON.stringify([['live/show'], 'audio']), JSON.stringify([['live', 'show'], 'audio']),
    ]);
    expect(tracks.map(track => track.namespace)).toEqual([['live/show'], ['live', 'show']]);
    expect(tracks.map(track => track.trackName)).toEqual(['audio', 'audio']);
  });

  it('keeps identity stable when a catalog reorders languages or changes labels', () => {
    const before = mapAudioTracks(catalog, ['live/show']);
    const after = mapAudioTracks({ ...catalog, tracks: [...catalog.tracks].reverse()
      .map(track => ({ ...track, label: 'Renamed' })) }, ['live/show']);
    expect(before[0]!.id).toBeDefined();
    expect(after.map(track => track.id)).toEqual(before.map(track => track.id).reverse());
    expect(after.map(track => track.index)).toEqual([0, 1]);
  });

  it('does not borrow an unresolved track namespace to invent a stable id', () => {
    expect(mapAudioTracks(catalog)[0]).toEqual({ index: 0, label: 'en', language: 'en', codec: 'opus' });
  });

  it('copies resolved namespace fields before exposing them to a menu', () => {
    const fields = ['one/field'];
    const tracks = mapAudioTracks({ version: 1, tracks: [{ name: 'a', codec: 'opus', packaging: 'loc', isLive: true,
      resolvedNamespace: { fields, source: 'inherited' } }] } as CatalogState, 'ignored');
    fields[0] = 'changed';
    expect(tracks[0]!.namespace).toEqual(['one/field']);
    expect(tracks[0]!.id).toBe(JSON.stringify([['one/field'], 'a']));
  });

  it('reports rendition identity independently of its sorted index', () => {
    const levels = mapLevels({ version: 1, tracks: [
      { name: 'video', codec: 'avc1.42c028', packaging: 'loc', isLive: true, altGroup: 1, bitrate: 100,
        resolvedNamespace: { fields: ['low'], source: 'declared' } },
      { name: 'video', codec: 'avc1.42c028', packaging: 'loc', isLive: true, altGroup: 1, bitrate: 200,
        resolvedNamespace: { fields: ['high'], source: 'declared' } },
    ] } as CatalogState);
    expect(levels.map(level => level.id)).toEqual([
      JSON.stringify([['high'], 'video']), JSON.stringify([['low'], 'video']),
    ]);
  });
});
