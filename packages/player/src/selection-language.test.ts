import { describe, expect, it } from 'vitest';
import type { CatalogState } from '@openmoq/msf';
import { composeSelection } from './selection-composition.js';
import { QualityController } from './quality-controller.js';

const catalog: CatalogState = { version: 1, tracks: [
  { name: 'booth', role: 'audio', renderGroup: 1, altGroup: 3, lang: 'es', codec: 'opus', packaging: 'loc', isLive: true },
  { name: 'cam', role: 'video', renderGroup: 2, altGroup: 1, codec: 'avc1.42c028', packaging: 'loc', isLive: true },
  { name: 'english', role: 'audio', renderGroup: 2, altGroup: 3, lang: 'en-US', codec: 'opus', packaging: 'loc', isLive: true },
  { name: 'spanish', role: 'audio', renderGroup: 2, altGroup: 3, lang: 'es', codec: 'opus', packaging: 'loc', isLive: true },
  { name: 'other-set', role: 'audio', renderGroup: 2, altGroup: 4, lang: 'fr', codec: 'opus', packaging: 'loc', isLive: true },
] };
const controller = () => new QualityController({ autoQuality: true, startLevel: 'auto', qualitySwitchCooldownMs: 0, clock: { now: () => 0 } });
const name = (result: ReturnType<typeof composeSelection>) => result.ok && result.audio.state === 'selected' ? result.audio.track.id.name : null;

describe('language preferences within catalog selection', () => {
  it('chooses a preferred language without leaving the selected program', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { scope: { kind: 'render-group', renderGroup: 2 } }, audioLanguages: ['es', 'en'] });
    expect(name(result)).toBe('spanish');
  });

  it('leaves an explicit audio pin authoritative over language preference', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { audioTrack: { name: 'english', namespaceFields: ['live'] } }, audioLanguages: ['es'] });
    expect(name(result)).toBe('english');
  });

  it('does not escape an explicit alternate set to find a preferred language', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { scope: { kind: 'render-group', renderGroup: 2 }, audioAltGroup: 3 }, audioLanguages: ['fr', 'es'] });
    expect(name(result)).toBe('spanish');
  });

  it('keeps exact audioConstraints.lang distinct from a language preference', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { scope: { kind: 'render-group', renderGroup: 2 } }, audioLanguages: ['en'], audioConstraints: { lang: 'en' } });
    expect(result.ok && result.audio.state).toBe('unsatisfied');
  });

  it('filters exact constraints before choosing a preference', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { scope: { kind: 'render-group', renderGroup: 2 } }, audioLanguages: ['es'], audioConstraints: { codec: 'opus', lang: 'en-US' } });
    expect(name(result)).toBe('english');
  });

  it('falls back in the selected scope only when no preference matches', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { scope: { kind: 'render-group', renderGroup: 2 } }, audioLanguages: ['de'] });
    expect(name(result)).toBe('english');
  });

  it('refuses an invalid preference before mutating a populated controller', () => {
    const qc = controller();
    composeSelection(catalog, { catalogNamespace: ['live'], controller: qc,
      intent: { scope: { kind: 'render-group', renderGroup: 1 } } });
    const previous = qc.currentAudioTrack;
    expect(() => composeSelection(catalog, { catalogNamespace: ['live'], controller: qc,
      intent: { scope: { kind: 'render-group', renderGroup: 2 } }, audioLanguages: ['en', 'bad_range'] })).toThrow(/language range/);
    expect(qc.currentAudioTrack).toBe(previous);
  });

  it('ignores preferences for disabled audio without inventing a track', () => {
    const result = composeSelection(catalog, { catalogNamespace: ['live'], controller: controller(),
      intent: { scope: { kind: 'render-group', renderGroup: 2 }, disableAudio: true }, audioLanguages: ['bad_range'] });
    expect(result.ok && result.audio.state).toBe('disabled');
  });
});
