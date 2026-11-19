import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseCatalogAuto, resolveTrackDependencies } from './index.js';

it.each(['cmaf-av', 'loc-av1', 'loc-avc-aac', 'loc-hevc', 'loc-opus', 'loc-vp9'])('parses moqxr %s as MSF-02', name => {
    const json = readFileSync(new URL(`./fixtures/moqxr-msf02/${name}.catalog.json`, import.meta.url));
    const catalog = parseCatalogAuto(json, ['example.com', 'live']);
    expect(catalog.msfDraft).toBe('draft-02');
    expect(catalog.tracks.every(t => t.resolvedNamespace?.fields.join('/') === 'example.com/live')).toBe(true);
    const timeline = catalog.tracks.find(t => t.packaging === 'mediatimeline')!;
    expect(resolveTrackDependencies(timeline, catalog.tracks, catalog).map(t => t.name)).toEqual(
        catalog.tracks.filter(t => t.renderGroup === 1).map(t => t.name));
});
