import { describe, expect, it } from 'vitest';
import type { CatalogState } from '@openmoq/msf';
import type { MediaSelectionSnapshot } from '@openmoq/player';
import { selectionMenu } from './selection-menu.js';

const catalog = { version: 1, tracks: [
  { name: 'video', codec: 'avc1.42c028', packaging: 'loc', isLive: true, altGroup: 1, bitrate: 100, namespace: 'a' },
  { name: 'audio', codec: 'opus', packaging: 'loc', isLive: true, lang: 'en', namespace: 'a' },
  { name: 'video', codec: 'avc1.42c028', packaging: 'loc', isLive: true, altGroup: 1, bitrate: 200, namespace: 'b' },
  { name: 'audio', codec: 'opus', packaging: 'loc', isLive: true, lang: 'es', namespace: 'b' },
] } as CatalogState;
const ref = (namespace: string, name: string) => ({ namespaceFields: [namespace], name });
const selection: MediaSelectionSnapshot = {
  revision: 1, scope: { kind: 'unassigned' }, video: ref('a', 'video'), audio: ref('b', 'audio'),
  videoAlternatives: [ref('a', 'video'), ref('b', 'video')],
  audioChoices: [ref('a', 'audio'), ref('b', 'audio')], autoQuality: true,
};

describe('committed selection menus', () => {
  it('matches selected rows by full identity after rendition sorting', () => {
    const menu = selectionMenu(catalog, selection, 'unrelated');
    expect(menu.levels.map(level => level.namespace)).toEqual([['b'], ['a']]);
    expect(menu.currentLevel).toBe(1);
    expect(menu.currentAudioTrack).toBe(1);
    expect(menu.audioTracks[menu.currentAudioTrack]!.language).toBe('es');
  });

  it('uses engine choice order independently of catalog order', () => {
    const menu = selectionMenu({ ...catalog, tracks: [...catalog.tracks].reverse() }, selection, 'unrelated');
    // The engine's choice order is authoritative, not the catalog's order.
    expect(menu.audioTracks.map(track => track.namespace)).toEqual([['a'], ['b']]);
    expect(menu.audioTracks[menu.currentAudioTrack]!.id).toBe(JSON.stringify([['b'], 'audio']));
    const reversedChoices = selectionMenu(catalog, { ...selection, audioChoices: [...selection.audioChoices].reverse() }, 'unrelated');
    expect(reversedChoices.currentAudioTrack).toBe(0);
    expect(reversedChoices.audioTracks[0]!.id).toBe(JSON.stringify([['b'], 'audio']));
    expect(catalog.tracks[0]!.namespace).toBe('a');
  });

  it('reports an absent selected identity without choosing the remaining namesake', () => {
    const menu = selectionMenu({ ...catalog, tracks: catalog.tracks.filter(track => track.namespace === 'a') },
      selection, 'unrelated');
    expect(menu.audioTracks).toHaveLength(1);
    expect(menu.currentAudioTrack).toBe(-1);
    expect(menu.audio).toBeUndefined();
    expect(menu.currentLevel).toBe(0);
  });

  it('keeps disabled outputs empty even when other tracks are offered', () => {
    const menu = selectionMenu(catalog, { ...selection, audio: null, audioChoices: [] }, 'unrelated');
    expect(menu.currentAudioTrack).toBe(-1);
    expect(menu.audioTracks).toEqual([]);
    expect(menu.currentLevel).toBe(1);
  });
});
