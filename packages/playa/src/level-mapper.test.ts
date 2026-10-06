import { describe, expect, it } from 'vitest';
import { buildCatalog, parseCatalogAuto } from '@openmoq/msf';
import { mapAudioTracks } from './level-mapper.js';

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
