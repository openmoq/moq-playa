/**
 * Tests for catalog builder — constructs MSF catalog JSON for publishers.
 *
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { buildCatalog } from './catalog-builder.js';
import { parseMsfCatalog } from './catalog-msf00.js';

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
