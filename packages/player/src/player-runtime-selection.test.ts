import { describe, expect, it } from 'vitest';
import type { CatalogState, CatalogTrack } from '@openmoq/msf';
import { prepareRuntimeSelection } from './player-runtime-selection.js';
import type { MediaSelectionSnapshot } from './player-selection-state.js';

const track = (name: string, role: 'video' | 'audio', group: number, altGroup: number,
  namespace: readonly string[], extra: Partial<CatalogTrack> = {}): CatalogTrack => ({
  name, role, renderGroup: group, altGroup, packaging: 'loc', isLive: true,
  codec: role === 'video' ? 'avc1.42c01e' : 'opus',
  resolvedNamespace: { fields: namespace, source: 'declared' }, ...extra,
});
const catalog: CatalogState = { version: 1, tracks: [
  track('booth', 'video', 0, 9, ['booth']),
  track('v', 'video', 1, 1, ['old', 'picture'], { bitrate: 100_000, width: 640, height: 360 }),
  track('v-high', 'video', 1, 1, ['old', 'picture'], { bitrate: 900_000, width: 1920, height: 1080 }),
  track('a', 'audio', 1, 2, ['old', 'sound'], { lang: 'es' }),
  track('other-view', 'video', 1, 4, ['old', 'picture'], { width: 640, height: 360 }),
  track('v', 'video', 2, 10, ['next', 'picture'], { width: 1280, height: 720 }),
  track('a', 'audio', 2, 11, ['next', 'english'], { lang: 'en' }),
  track('a', 'audio', 2, 12, ['next', 'spanish'], { lang: 'es-MX' }),
  track('silent', 'video', 3, 13, ['silent'], { width: 640, height: 360 }),
] };
const current: MediaSelectionSnapshot = { revision: 1, scope: { kind: 'render-group', renderGroup: 1 },
  video: { name: 'v', namespaceFields: ['old', 'picture'] },
  audio: { name: 'a', namespaceFields: ['old', 'sound'] },
  videoAlternatives: [], audioChoices: [], autoQuality: true };
const options = { current, catalogNamespace: ['catalog'],
  quality: { startLevel: 'lowest' as const, qualitySwitchCooldownMs: 0 }, clock: { now: () => 0 } };

describe('runtime presentation policy', () => {
  it('retains adopted outputs inside the current scope instead of restarting at catalog order', () => {
    const result = prepareRuntimeSelection(catalog, { ...options, selection: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selected.scope.id).toEqual(current.scope);
    expect(result.selected.video.state === 'selected' && result.selected.video.track.id).toEqual(current.video);
    expect(result.selected.audio.state === 'selected' && result.selected.audio.track.id).toEqual(current.audio);
    expect(result.controller.isAutoQuality).toBe(true);
    expect(result.selected.manualVideo).toBe(false);
    expect(result.controller.peekHigherVideoQuality()?.name).toBe('v-high');
    expect(result.scopeChanged).toBe(false);
  });

  it('recomposes both outputs for an explicitly requested program and applies language preferences', () => {
    const result = prepareRuntimeSelection(catalog, { ...options, selection: { renderGroup: 2 }, audioLanguages: ['es'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeChanged).toBe(true);
    expect(result.selected.video.state === 'selected' && result.selected.video.track.id)
      .toEqual({ name: 'v', namespaceFields: ['next', 'picture'] });
    expect(result.selected.audio.state === 'selected' && result.selected.audio.track.id)
      .toEqual({ name: 'a', namespaceFields: ['next', 'spanish'] });
  });

  it('changes only video for a view request and preserves automatic quality mode', () => {
    const result = prepareRuntimeSelection(catalog, { ...options, selection: { videoAltGroup: 4 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selected.video.state === 'selected' && result.selected.video.track.id.name).toBe('other-view');
    expect(result.selected.audio.state === 'selected' && result.selected.audio.track.id).toEqual(current.audio);
    expect(result.controller.isAutoQuality).toBe(true);
  });

  it('does not infer a program change from an exact track in another scope', () => {
    expect(prepareRuntimeSelection(catalog, { ...options,
      selection: { videoTrack: { name: 'v', namespace: ['next', 'picture'] } } }).ok).toBe(false);
  });

  it('keeps a missing current output disabled unless the program or that output was requested', () => {
    const result = prepareRuntimeSelection(catalog, { ...options, current: { ...current, audio: null },
      selection: { videoAltGroup: 4 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selected.audio.state).toBe('disabled');
  });

  it('ignores a disabled video selector without moving audio to that selector’s program', () => {
    const result = prepareRuntimeSelection(catalog, { ...options, current: { ...current, video: null }, disableVideo: true,
      selection: { videoTrack: { name: 'booth', namespace: ['booth'] } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selected.audio.state === 'selected' && result.selected.audio.track.id).toEqual(current.audio);
    expect(result.selected.video.state).toBe('disabled');
  });

  it('accepts genuine target absence but refuses declared media that fails the cap', () => {
    const absent = prepareRuntimeSelection(catalog, { ...options, selection: { renderGroup: 3 } });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.selected.audio.state).toBe('not-declared');
    const capped = prepareRuntimeSelection(catalog, { ...options, selection: { renderGroup: 2 },
      quality: { ...options.quality, capLevelToResolution: { width: 1, height: 1 } } });
    expect(capped.ok).toBe(false);
  });

  it('makes an explicit video pin manual and otherwise retains manual mode', () => {
    const pin = prepareRuntimeSelection(catalog, { ...options,
      selection: { videoTrack: { name: 'v-high', namespace: ['old', 'picture'] } } });
    expect(pin.ok).toBe(true);
    if (pin.ok) {
      expect(pin.controller.isAutoQuality).toBe(false);
      expect(pin.selected.manualVideo).toBe(true);
    }
    const manual = prepareRuntimeSelection(catalog, { ...options, current: { ...current, autoQuality: false },
      selection: { videoAltGroup: 4 } });
    expect(manual.ok).toBe(true);
    if (manual.ok) expect(manual.controller.isAutoQuality).toBe(false);
    expect(current.autoQuality).toBe(true);
  });
});
