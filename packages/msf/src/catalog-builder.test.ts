/**
 * Tests for catalog builder — constructs MSF catalog JSON for publishers.
 *
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { buildCatalog } from './catalog-builder.js';
import { parseMsfCatalog } from './catalog-msf00.js';
import { parseCatalogAuto } from './catalog-detect.js';

describe('buildCatalog', () => {
  it('builds valid MSF catalog JSON with video + audio', () => {
    const payload = buildCatalog({
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.640028',
          width: 1920,
          height: 1080,
          framerate: 30,
          bitrate: 3_000_000,
          renderGroup: 1,
        },
        {
          name: 'audio',
          packaging: 'loc',
          isLive: true,
          role: 'audio',
          codec: 'mp4a.40.2',
          samplerate: 48000,
          channelConfig: '2',
          bitrate: 128_000,
          renderGroup: 1,
        },
      ],
    });

    expect(payload).toBeInstanceOf(Uint8Array);
    expect(payload.length).toBeGreaterThan(0);

    // Should be valid JSON
    const text = new TextDecoder().decode(payload);
    const json = JSON.parse(text);
    expect(json.version).toBe(1);
    expect(json.tracks).toHaveLength(2);
    expect(json.tracks[0].name).toBe('video');
    expect(json.tracks[1].name).toBe('audio');
  });

  it('round-trips through parseMsfCatalog', () => {
    const payload = buildCatalog({
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.640028',
          width: 1280,
          height: 720,
          renderGroup: 1,
        },
        {
          name: 'audio',
          packaging: 'loc',
          isLive: true,
          role: 'audio',
          codec: 'opus',
          samplerate: 48000,
          channelConfig: '2',
          renderGroup: 1,
        },
      ],
    });

    // Should parse without errors
    const catalog = parseMsfCatalog(payload, 'test');
    expect(catalog.tracks).toHaveLength(2);
    expect(catalog.tracks[0]!.name).toBe('video');
    expect(catalog.tracks[0]!.codec).toBe('avc1.640028');
    expect(catalog.tracks[0]!.width).toBe(1280);
    expect(catalog.tracks[1]!.name).toBe('audio');
    expect(catalog.tracks[1]!.codec).toBe('opus');
  });

  it('includes optional fields when provided', () => {
    const payload = buildCatalog({
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.640028',
          width: 1920,
          height: 1080,
          framerate: 30,
          bitrate: 5_000_000,
          renderGroup: 1,
          initData: 'AQID', // base64
        },
      ],
    });

    const text = new TextDecoder().decode(payload);
    const json = JSON.parse(text);
    expect(json.tracks[0].framerate).toBe(30);
    expect(json.tracks[0].bitrate).toBe(5_000_000);
    expect(json.tracks[0].initData).toBe('AQID');
  });

  it('omits undefined optional fields', () => {
    const payload = buildCatalog({
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.640028',
          renderGroup: 1,
        },
      ],
    });

    const text = new TextDecoder().decode(payload);
    const json = JSON.parse(text);
    expect(json.tracks[0].width).toBeUndefined();
    expect(json.tracks[0].framerate).toBeUndefined();
    expect(json.tracks[0].bitrate).toBeUndefined();
  });
});

describe('buildCatalog — MSF-01/CMSF-01 init-by-reference emission', () => {
  const cmsf = () => buildCatalog({
    version: '1',
    initDataList: [{ id: 'init-video', type: 'inline', data: 'AAAAGGZ0eXA=' }],
    tracks: [
      { name: 'video', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.640028', renderGroup: 1, initRef: 'init-video', width: 1920, height: 1080 },
      { name: 'audio', packaging: 'cmaf', isLive: true, role: 'audio', codec: 'mp4a.40.2', renderGroup: 1, initRef: 'init-video', samplerate: 48000, channelConfig: '2' },
    ],
  });

  it('emits the string version "1", a root initDataList, and per-track initRef with NO inline initData', () => {
    const json = JSON.parse(new TextDecoder().decode(cmsf()));
    expect(json.version).toBe('1'); // string form, not numeric
    expect(json.initDataList).toEqual([{ id: 'init-video', type: 'inline', data: 'AAAAGGZ0eXA=' }]);
    for (const t of json.tracks) {
      expect(t.initRef).toBe('init-video');
      expect('initData' in t).toBe(false); // NO per-track inline init
      expect(t.packaging).toBe('cmaf');
    }
  });

  it('round-trips through parseCatalogAuto: version normalizes to 1 and initRefs resolve', () => {
    const cat = parseCatalogAuto(cmsf());
    expect(cat.version).toBe(1); // "1" normalized
    expect(cat.initDataList).toHaveLength(1);
    expect(cat.tracks.every((t) => t.initRef === 'init-video')).toBe(true);
    expect(cat.tracks.every((t) => t.initData === undefined)).toBe(true);
  });

  it('the numeric MSF-00 default is unchanged (version 1, inline initData, no initDataList)', () => {
    const json = JSON.parse(new TextDecoder().decode(buildCatalog({
      tracks: [{ name: 'v', packaging: 'cmaf', isLive: true, role: 'video', codec: 'avc1.640028', initData: 'AAAB' }],
    })));
    expect(json.version).toBe(1); // numeric
    expect(json.tracks[0].initData).toBe('AAAB');
    expect('initRef' in json.tracks[0]).toBe(false);
    expect('initDataList' in json).toBe(false);
  });
});
