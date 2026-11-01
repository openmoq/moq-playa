/**
 * Selection + quality composition.
 *
 * The contract under test is the division: the model decides which set is
 * eligible, the controller decides which member of it plays. Every case here
 * is about that seam — a cap or a constraint must move the MEMBER and never
 * the view, and an explicit identity must outrank a quality default.
 *
 * Pins, scopes, and absence versus exclusion are tested independently of the
 * legacy catalog-wide selector, which cannot express those choices.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogState, CatalogTrack } from '@openmoq/msf';
import { QualityController } from './quality-controller.js';
import {
  buildCatalogSelection,
  type ScopeId,
  type SelectionIntent,
} from './catalog-selection.js';
import {
  composeResolvedSelection,
  composeSelection,
  type ComposedSelection,
  type CompositionOptions,
} from './selection-composition.js';

const NS = 'live/show';
const NS_FIELDS = ['live', 'show'] as const;
const renderGroup = (n: number): ScopeId => ({ kind: 'render-group', renderGroup: n });

function catalog(tracks: Array<Partial<CatalogTrack> & { name: string }>): CatalogState {
  return {
    version: 1,
    tracks: tracks.map(t => ({ packaging: 'loc', isLive: true, ...t })) as CatalogTrack[],
  };
}

function controller(overrides: Partial<{
  autoQuality: boolean; startLevel: number | 'lowest' | 'auto';
  capLevelToResolution: { width: number; height: number }; qualitySwitchCooldownMs: number;
}> = {}) {
  return new QualityController({
    autoQuality: overrides.autoQuality ?? true,
    startLevel: overrides.startLevel ?? 'auto',
    ...(overrides.capLevelToResolution ? { capLevelToResolution: overrides.capLevelToResolution } : {}),
    qualitySwitchCooldownMs: overrides.qualitySwitchCooldownMs ?? 0,
    clock: { now: () => 0 },
  });
}

function compose(
  state: CatalogState,
  intent?: SelectionIntent,
  options: CompositionOptions & { controller?: QualityController } = {},
): { result: ComposedSelection; qc: QualityController } {
  const qc = options.controller ?? controller();
  const result = composeSelection(state, {
    catalogNamespace: NS, controller: qc,
    ...(intent ? { intent } : {}),
    ...(options.videoConstraints ? { videoConstraints: options.videoConstraints } : {}),
    ...(options.audioConstraints ? { audioConstraints: options.audioConstraints } : {}),
  });
  return { result, qc };
}

const videoName = (r: ComposedSelection) =>
  r.ok && r.video.state === 'selected' ? r.video.track.id.name : undefined;
const audioName = (r: ComposedSelection) =>
  r.ok && r.audio.state === 'selected' ? r.audio.track.id.name : undefined;

/** A declared three-rung ladder plus audio, all in one render group. */
const ladderCatalog = (): CatalogState => catalog([
  { name: 'hd', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 5_000_000 },
  { name: 'md', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', width: 1280, height: 720, bitrate: 2_000_000 },
  { name: 'sd', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 500_000 },
  { name: 'audio', role: 'audio', renderGroup: 1, codec: 'opus' },
]);

/** Issue #24: a booth program and a two-camera match with two languages. */
const issue24 = (): CatalogState => catalog([
  { name: 'video_booth', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10', label: 'Booth' },
  { name: 'video_match_main', role: 'video', renderGroup: 2, altGroup: 1, codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 5_000_000 },
  { name: 'video_match_low', role: 'video', renderGroup: 2, altGroup: 1, codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 500_000 },
  { name: 'video_match_cam2', role: 'video', renderGroup: 2, altGroup: 2, codec: 'av01.0.08M.10' },
  { name: 'audio_booth', role: 'audio', renderGroup: 1, codec: 'opus' },
  { name: 'audio_match_en', role: 'audio', renderGroup: 2, altGroup: 3, codec: 'opus', lang: 'eng' },
  { name: 'audio_match_es', role: 'audio', renderGroup: 2, altGroup: 3, codec: 'opus', lang: 'spa' },
]);

describe('selection + quality composition', () => {
  describe('a declared ladder keeps its quality behavior', () => {
    it('lets startLevel choose the member, and reports the ladder as the switchable set', () => {
      const { result, qc } = compose(ladderCatalog(), undefined, { controller: controller({ startLevel: 'lowest' }) });
      expect(videoName(result)).toBe('sd');
      expect(qc.alternatives.map(t => t.name)).toEqual(['hd', 'md', 'sd']);
      expect(result.ok && result.video.state === 'selected' && result.video.ladder.map(t => t.id.name))
        .toEqual(['hd', 'md', 'sd']);
    });

    it("'auto' still starts in the middle of the ladder", () => {
      expect(videoName(compose(ladderCatalog()).result)).toBe('md');
    });

    it('honors a numeric startLevel as an index into the ladder', () => {
      const { result } = compose(ladderCatalog(), undefined, { controller: controller({ startLevel: 0 }) });
      expect(videoName(result)).toBe('hd');
    });

    it('keeps ABR inside the ladder after composing', () => {
      const { result, qc } = compose(ladderCatalog(), undefined, { controller: controller({ startLevel: 0 }) });
      expect(videoName(result)).toBe('hd');
      expect(qc.reduceVideoQuality()?.name).toBe('md');
      expect(qc.reduceVideoQuality()?.name).toBe('sd');
      expect(qc.reduceVideoQuality()).toBeNull();
    });

    it('narrows ABR to the selected codec family while listing all alternatives', () => {
      const state = catalog([
        { name: 'av1-hi', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', bitrate: 4_000_000 },
        { name: 'avc-hi', role: 'video', renderGroup: 1, altGroup: 1, codec: 'avc1.640028', bitrate: 3_000_000 },
        { name: 'av1-lo', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', bitrate: 1_000_000 },
      ]);
      const { result, qc } = compose(state, undefined, { controller: controller({ startLevel: 0 }) });
      expect(videoName(result)).toBe('av1-hi');
      expect(qc.alternatives.map(t => t.name)).toEqual(['av1-hi', 'av1-lo']);
      expect(qc.allAlternatives).toHaveLength(3);
    });

    it('applies the resolution cap within the ladder, never across views', () => {
      const { result, qc } = compose(issue24(), { scope: renderGroup(2) }, {
        controller: controller({ capLevelToResolution: { width: 1280, height: 720 } }),
      });
      expect(videoName(result)).toBe('video_match_low');
      expect(qc.alternatives.map(t => t.name)).toEqual(['video_match_low']);
      expect(result.ok && result.scope.id).toEqual(renderGroup(2));
    });

    it('reports an unsatisfiable cap instead of moving to another view', () => {
      const { result } = compose(issue24(), { scope: renderGroup(2), videoAltGroup: 1 }, {
        controller: controller({ capLevelToResolution: { width: 320, height: 240 } }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.video.state).toBe('unsatisfied');
      expect(result.scope.id).toEqual(renderGroup(2));
      // Not 'not-declared': the scope does declare video.
      expect(result.video.state === 'unsatisfied' && result.video.reason).toMatch(/320x240/);
    });

    it('applies startup videoConstraints inside the ladder only', () => {
      const { result } = compose(ladderCatalog(), undefined, {
        videoConstraints: { maxWidth: 1280, maxHeight: 720 },
      });
      // Highest that fits, from inside the declared set.
      expect(videoName(result)).toBe('md');
    });
  });

  describe('singletons', () => {
    it('are never laddered, so startLevel cannot choose between them', () => {
      const state = catalog([
        { name: 'cam_a', role: 'video', codec: 'av01.0.08M.10', bitrate: 5_000_000 },
        { name: 'cam_b', role: 'video', codec: 'av01.0.08M.10', bitrate: 500_000 },
      ]);
      for (const startLevel of ['lowest', 'auto', 0, 5] as const) {
        const { result, qc } = compose(state, undefined, { controller: controller({ startLevel }) });
        expect(videoName(result)).toBe('cam_a');
        expect(qc.alternatives).toHaveLength(1);
        expect(qc.reduceVideoQuality()).toBeNull();
      }
    });

    it('selects another singleton only by identity', () => {
      const state = catalog([
        { name: 'cam_a', role: 'video', codec: 'av01.0.08M.10' },
        { name: 'cam_b', role: 'video', codec: 'av01.0.08M.10' },
      ]);
      const { result } = compose(state, { videoTrack: { namespaceFields: NS_FIELDS, name: 'cam_b' } });
      expect(videoName(result)).toBe('cam_b');
    });

    it('keeps alternate group zero a declared ladder', () => {
      const state = catalog([
        { name: 'hi', role: 'video', altGroup: 0, codec: 'av01.0.08M.10', bitrate: 4_000_000 },
        { name: 'lo', role: 'video', altGroup: 0, codec: 'av01.0.08M.10', bitrate: 400_000 },
      ]);
      const { result, qc } = compose(state, { videoAltGroup: 0 }, { controller: controller({ startLevel: 'lowest' }) });
      expect(videoName(result)).toBe('lo');
      expect(qc.alternatives).toHaveLength(2);
    });
  });

  describe('an explicit track pin', () => {
    it('is not replaced by the start-level default', () => {
      for (const startLevel of ['lowest', 'auto', 0] as const) {
        const { result } = compose(ladderCatalog(), { videoTrack: { namespaceFields: NS_FIELDS, name: 'md' } },
          { controller: controller({ startLevel }) });
        expect(videoName(result)).toBe('md');
      }
    });

    it('is not replaced by the startup video constraints', () => {
      const { result } = compose(ladderCatalog(), { videoTrack: { namespaceFields: NS_FIELDS, name: 'sd' } }, {
        videoConstraints: { maxWidth: 1920, maxHeight: 1080 },
      });
      expect(videoName(result)).toBe('sd');
    });

    it('establishes manual video selection on the controller, and says so', () => {
      const { result, qc } = compose(ladderCatalog(), { videoTrack: { namespaceFields: NS_FIELDS, name: 'md' } });
      expect(result.ok && result.manualVideo).toBe(true);
      expect(qc.isAutoQuality).toBe(false);
      const auto = compose(ladderCatalog());
      expect(auto.result.ok && auto.result.manualVideo).toBe(false);
      expect(auto.qc.isAutoQuality).toBe(true);
    });

    it('holds the pinned member until auto is re-enabled, then switches normally', () => {
      const { result, qc } = compose(ladderCatalog(), { videoTrack: { namespaceFields: NS_FIELDS, name: 'md' } });
      expect(videoName(result)).toBe('md');
      expect(qc.isAutoQuality).toBe(false);
      // Manual mode is real, not advisory: ABR is refused until unlocked.
      expect(qc.reduceVideoQuality()).toBeNull();
      qc.unlockAuto();
      expect(qc.alternatives.map(t => t.name)).toEqual(['hd', 'md', 'sd']);
      expect(qc.reduceVideoQuality()?.name).toBe('sd');
    });

    it('fails when the pinned identity is gone — no same-index substitute', () => {
      const state = ladderCatalog();
      const without = { ...state, tracks: state.tracks.filter(t => t.name !== 'md') };
      const { result } = compose(without, { videoTrack: { namespaceFields: NS_FIELDS, name: 'md' } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/md/);
    });

    it('keeps identities rather than names in the result', () => {
      const state = catalog([
        { name: 'video', role: 'video', namespace: 'other/space', renderGroup: 1, codec: 'av01.0.08M.10' },
        { name: 'video', role: 'video', renderGroup: 2, codec: 'av01.0.08M.10' },
      ]);
      const { result } = compose(state, { videoTrack: { namespaceFields: ['other', 'space'], name: 'video' } });
      expect(result.ok && result.video.state === 'selected' && result.video.track.id)
        .toEqual({ namespaceFields: ['other', 'space'], name: 'video' });
      expect(result.ok && result.scope.id).toEqual(renderGroup(1));
    });
  });

  describe('audio constraints within the chosen scope', () => {
    it('finds a later member of one declared set', () => {
      const { result } = compose(issue24(), { scope: renderGroup(2) }, {
        audioConstraints: { lang: 'spa' },
      });
      expect(audioName(result)).toBe('audio_match_es');
    });

    it('finds a later singleton set in the same scope', () => {
      const state = catalog([
        { name: 'cam', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10' },
        { name: 'first_audio', role: 'audio', renderGroup: 1, codec: 'opus', lang: 'eng' },
        { name: 'later_audio', role: 'audio', renderGroup: 1, codec: 'opus', lang: 'spa' },
      ]);
      const { result } = compose(state, undefined, { audioConstraints: { lang: 'spa' } });
      expect(audioName(result)).toBe('later_audio');
    });

    it('does not escape the scope to satisfy a language', () => {
      const state = catalog([
        { name: 'cam', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10' },
        { name: 'en_here', role: 'audio', renderGroup: 1, codec: 'opus', lang: 'eng' },
        { name: 'es_elsewhere', role: 'audio', renderGroup: 2, codec: 'opus', lang: 'spa' },
      ]);
      const { result } = compose(state, { scope: renderGroup(1) }, { audioConstraints: { lang: 'spa' } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.audio.state).toBe('unsatisfied');
      expect(audioName(result)).toBeUndefined();
      expect(result.scope.id).toEqual(renderGroup(1));
    });

    it('fails honestly when an explicit audio track contradicts the constraint', () => {
      const { result } = compose(issue24(), {
        scope: renderGroup(2), audioTrack: { namespaceFields: NS_FIELDS, name: 'audio_match_en' },
      }, { audioConstraints: { lang: 'spa' } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/constraint/i);
    });

    it('fails honestly when an explicit audio set contradicts the constraint', () => {
      const state = catalog([
        { name: 'cam', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10' },
        { name: 'en', role: 'audio', renderGroup: 1, altGroup: 1, codec: 'opus', lang: 'eng' },
        { name: 'es', role: 'audio', renderGroup: 1, altGroup: 2, codec: 'opus', lang: 'spa' },
      ]);
      const { result } = compose(state, { audioAltGroup: 1 }, { audioConstraints: { lang: 'spa' } });
      expect(result.ok).toBe(false);
    });

    it('ignores audio constraints for a disabled output', () => {
      // startLevel 0 pins the video choice so this asserts the audio rule
      // rather than where 'auto' happens to land in a two-rung ladder.
      const { result } = compose(issue24(), { scope: renderGroup(2), disableAudio: true }, {
        audioConstraints: { lang: 'nonexistent' }, controller: controller({ startLevel: 0 }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.audio.state).toBe('disabled');
      expect(videoName(result)).toBe('video_match_main');
    });
  });

  describe('absence, exclusion, disablement and dissatisfaction are distinct', () => {
    it('reports not-declared for a scope that genuinely has no audio', () => {
      const state = catalog([{ name: 'cam', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10' }]);
      const { result } = compose(state);
      expect(result.ok && result.audio.state).toBe('not-declared');
    });

    it('reports excluded when the scope declared audio this build cannot play', () => {
      const state = catalog([
        { name: 'cam', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10' },
        { name: 'future_audio', role: 'audio', renderGroup: 1, packaging: 'locmaf',
          locmafVersion: 'draft-99', codec: 'opus' },
      ]);
      const { result } = compose(state);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.audio.state).toBe('excluded');
      if (result.audio.state !== 'excluded') return;
      expect(result.audio.excluded.map(e => e.id.name)).toEqual(['future_audio']);
    });

    it('reports disabled distinctly from both', () => {
      const { result } = compose(ladderCatalog(), { disableAudio: true });
      expect(result.ok && result.audio.state).toBe('disabled');
    });

    it('accepts a video-only scope without failing', () => {
      const state = catalog([
        { name: 'premium', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10' },
        { name: 'standard', role: 'video', renderGroup: 2, codec: 'av01.0.08M.10' },
        { name: 'audio', role: 'audio', renderGroup: 1, codec: 'opus' },
      ]);
      const { result } = compose(state, { scope: renderGroup(2) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(videoName(result)).toBe('standard');
      expect(result.audio.state).toBe('not-declared');
    });

    it('accepts an audio-only scope without inventing video', () => {
      const state = catalog([{ name: 'a', role: 'audio', renderGroup: 1, codec: 'opus' }]);
      const { result } = compose(state);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.video.state).toBe('not-declared');
      expect(audioName(result)).toBe('a');
    });
  });

  describe('candidate evaluation', () => {
    it('leaves a live controller untouched when a candidate is evaluated separately', () => {
      const live = controller({ startLevel: 0 });
      compose(ladderCatalog(), undefined, { controller: live });
      expect(live.currentVideoTrack?.name).toBe('hd');

      // A replacement catalog evaluated with its OWN controller.
      const candidateCatalog = catalog([
        { name: 'other', role: 'video', renderGroup: 1, altGroup: 9, codec: 'av01.0.08M.10', bitrate: 1_000 },
      ]);
      const candidate = controller({ startLevel: 0 });
      const { result } = compose(candidateCatalog, undefined, { controller: candidate });
      expect(videoName(result)).toBe('other');

      expect(live.currentVideoTrack?.name).toBe('hd');
      expect(live.alternatives.map(t => t.name)).toEqual(['hd', 'md', 'sd']);
    });

    it('commits by reference, so a same-named track in another namespace is not committed', () => {
      const state = catalog([
        { name: 'video', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01.0.08M.10', bitrate: 4_000_000 },
        { name: 'video', role: 'video', namespace: 'other/space', renderGroup: 1, altGroup: 1,
          codec: 'av01.0.08M.10', bitrate: 400_000 },
      ]);
      const qc = controller({ startLevel: 0 });
      const { result } = compose(state, undefined, { controller: qc });
      expect(result.ok && result.video.state === 'selected' && result.video.ladder).toHaveLength(2);
      const lower = result.ok && result.video.state === 'selected'
        ? result.video.ladder.find(t => t.id.namespaceFields.join('/') === 'other/space') : undefined;
      expect(lower).toBeDefined();
      qc.commitVideoTrackRef(lower!.track);
      expect(qc.currentVideoTrack).toBe(lower!.track);
      expect(qc.currentVideoTrack?.namespace).toBe('other/space');
    });
  });

  describe('quality ordering within a declared ladder', () => {
    // Adopted from review: the catalog's order decides which SET is eligible,
    // but inside a declared ladder a step must mean a step in quality.
    const unsorted = (order: readonly string[]) => {
      const by: Record<string, Partial<CatalogTrack> & { name: string }> = {
        hi: { name: 'hi', role: 'video', altGroup: 1, codec: 'av01', bitrate: 3000, width: 1920, height: 1080 },
        mid: { name: 'mid', role: 'video', altGroup: 1, codec: 'av01', bitrate: 2000, width: 1280, height: 720 },
        lo: { name: 'lo', role: 'video', altGroup: 1, codec: 'av01', bitrate: 1000, width: 640, height: 360 },
      };
      return catalog(order.map(n => by[n]!));
    };

    it('sorts by quality before startLevel chooses a member', () => {
      const { result } = compose(unsorted(['lo', 'mid', 'hi']), undefined,
        { controller: controller({ startLevel: 'lowest' }) });
      expect(videoName(result)).toBe('lo');
    });

    it('never increases bitrate while reducing quality on a catalog-ordered ladder', () => {
      const { result, qc } = compose(unsorted(['hi', 'lo', 'mid']), undefined,
        { controller: controller({ startLevel: 0 }) });
      expect(videoName(result)).toBe('hi');
      expect(qc.alternatives.map(t => t.name)).toEqual(['hi', 'mid', 'lo']);
      expect(qc.reduceVideoQuality()?.name).toBe('mid');
      expect(qc.reduceVideoQuality()?.name).toBe('lo');
    });

    it('does not reorder the catalog it was given', () => {
      const state = unsorted(['lo', 'mid', 'hi']);
      const before = state.tracks.map(t => t.name);
      compose(state, undefined, { controller: controller({ startLevel: 0 }) });
      expect(state.tracks.map(t => t.name)).toEqual(before);
    });

    it('keeps equal bitrates in catalog order', () => {
      const state = catalog([
        { name: 'first', role: 'video', altGroup: 1, codec: 'av01', bitrate: 1000 },
        { name: 'second', role: 'video', altGroup: 1, codec: 'av01', bitrate: 1000 },
      ]);
      const { qc } = compose(state, undefined, { controller: controller({ startLevel: 0 }) });
      expect(qc.alternatives.map(t => t.name)).toEqual(['first', 'second']);
    });
  });

  describe('the resolution cap has one owner', () => {
    const capped = () => controller({ capLevelToResolution: { width: 640, height: 360 } });

    it('honors a cap configured on the controller alone', () => {
      const { result, qc } = compose(ladderCatalog(), undefined, { controller: capped() });
      expect(videoName(result)).toBe('sd');
      expect(qc.allAlternatives.map(t => t.name)).toEqual(['sd']);
    });

    it('keeps the capped ladder as the only ABR range', () => {
      const { qc } = compose(ladderCatalog(), undefined, { controller: capped() });
      expect(qc.alternatives.map(t => t.name)).toEqual(['sd']);
      expect(qc.reduceVideoQuality()).toBeNull();
      expect(qc.increaseVideoQuality()).toBeNull();
    });

    it('reports the capped ladder in the outcome, not the uncapped set', () => {
      const { result } = compose(ladderCatalog(), undefined, { controller: capped() });
      expect(result.ok && result.video.state === 'selected' && result.video.ladder.map(t => t.id.name))
        .toEqual(['sd']);
      // The DECLARED set is unchanged — the cap restricts what we may play,
      // not what the publisher declared.
      expect(result.ok && result.video.state === 'selected' && result.video.set.tracks).toHaveLength(3);
    });

    it('does not substitute another member when the cap excludes an explicit pin', () => {
      // The cap is the controller's, so the conflict is between a standing
      // restriction and an explicit request — reported, never resolved by
      // playing a different track.
      const { result, qc } = compose(ladderCatalog(), { videoTrack: { namespaceFields: NS_FIELDS, name: 'hd' } },
        { controller: controller({ capLevelToResolution: { width: 1280, height: 720 } }) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/1280x720/);
      expect(qc.currentVideoTrack).toBeUndefined();
    });
  });

  describe('nothing is adopted before the selection is validated', () => {
    it('leaves a populated controller untouched when an explicit audio conflict is rejected', () => {
      const { qc } = compose(ladderCatalog(), undefined, { controller: controller({ startLevel: 0 }) });
      const before = qc.currentVideoTrack;
      const beforeLadder = qc.alternatives.map(t => t.name);
      const beforeAudio = qc.currentAudioTrack;
      const beforeAuto = qc.isAutoQuality;
      expect(before?.name).toBe('hd');
      expect(beforeAudio?.name).toBe('audio');

      const result = composeSelection(catalog([
        { name: 'new-camera', role: 'video', renderGroup: 1, codec: 'av01' },
        { name: 'en', role: 'audio', renderGroup: 1, codec: 'opus', lang: 'eng' },
      ]), {
        catalogNamespace: NS, controller: qc,
        intent: { audioTrack: { namespaceFields: NS_FIELDS, name: 'en' } },
        audioConstraints: { lang: 'spa' },
      });
      expect(result.ok).toBe(false);
      // Prior member, ladder, audio and mode all survive the rejection.
      expect(qc.currentVideoTrack).toBe(before);
      expect(qc.alternatives.map(t => t.name)).toEqual(beforeLadder);
      expect(qc.currentAudioTrack).toBe(beforeAudio);
      expect(qc.isAutoQuality).toBe(beforeAuto);
    });

    it('leaves a populated controller untouched when a pin is ineligible', () => {
      const { qc } = compose(ladderCatalog(), undefined, { controller: controller({ startLevel: 0 }) });
      const before = qc.currentVideoTrack;
      const result = composeSelection(ladderCatalog(), {
        catalogNamespace: NS, controller: qc,
        intent: { videoTrack: { namespaceFields: NS_FIELDS, name: 'absent' } },
      });
      expect(result.ok).toBe(false);
      expect(qc.currentVideoTrack).toBe(before);
    });
  });

  describe('a selection that chose nothing authorizes nothing', () => {
    it('reports unsatisfied and leaves no current video track', () => {
      const qc = controller({ startLevel: 'auto' });
      const { result } = compose(ladderCatalog(), undefined, {
        controller: qc, videoConstraints: { codec: 'unsupported-codec' },
      });
      expect(result.ok && result.video.state).toBe('unsatisfied');
      expect(qc.currentVideoTrack).toBeUndefined();
      expect(qc.alternatives).toEqual([]);
      expect(qc.reduceVideoQuality()).toBeNull();
      expect(qc.peekLowerVideoQuality()).toBeNull();
      expect(qc.peekHigherVideoQuality()).toBeNull();
    });

    it('still lists the declared alternatives for a manual chooser', () => {
      const qc = controller({ startLevel: 'auto' });
      compose(ladderCatalog(), undefined, { controller: qc, videoConstraints: { codec: 'nope' } });
      expect(qc.allAlternatives.map(t => t.name)).toEqual(['hd', 'md', 'sd']);
    });

    it('does not let a satisfied startup preference filter the later ABR ladder', () => {
      // videoConstraints choose the STARTING member; they are not a standing
      // restriction, so the whole declared ladder stays switchable.
      const { result, qc } = compose(ladderCatalog(), undefined, {
        videoConstraints: { maxWidth: 1280, maxHeight: 720 },
      });
      expect(videoName(result)).toBe('md');
      expect(qc.alternatives.map(t => t.name)).toEqual(['hd', 'md', 'sd']);
      expect(qc.increaseVideoQuality()?.name).toBe('hd');
    });
  });

  describe('what the result advertises as switchable', () => {
    it('advertises the same codec-compatible ladder the controller uses', () => {
      const state = catalog([
        { name: 'hi', role: 'video', altGroup: 1, codec: 'av01', bitrate: 3000 },
        { name: 'mid', role: 'video', altGroup: 1, codec: 'avc1', bitrate: 2000 },
        { name: 'lo', role: 'video', altGroup: 1, codec: 'av01', bitrate: 1000 },
      ]);
      const { result, qc } = compose(state, undefined, { controller: controller({ startLevel: 0 }) });
      expect(result.ok && result.video.state === 'selected' && result.video.ladder.map(t => t.id.name))
        .toEqual(qc.alternatives.map(t => t.name));
      expect(result.ok && result.video.state === 'selected' && result.video.ladder.map(t => t.id.name))
        .toEqual(['hi', 'lo']);
      // The declared set still has all three — a manual chooser may cross
      // codec families even though ABR may not.
      expect(result.ok && result.video.state === 'selected' && result.video.set.tracks).toHaveLength(3);
    });

    it('does not advertise independent audio singletons as one ladder', () => {
      const state = catalog([
        { name: 'en', role: 'audio', renderGroup: 1, codec: 'opus', lang: 'eng' },
        { name: 'es', role: 'audio', renderGroup: 1, codec: 'opus', lang: 'spa' },
      ]);
      const { result } = compose(state, undefined, { audioConstraints: { lang: 'spa' } });
      expect(audioName(result)).toBe('es');
      // Two singletons are not alternates of one another.
      expect(result.ok && result.audio.state === 'selected' && result.audio.ladder.map(t => t.id.name))
        .toEqual(['es']);
      // Both were weighed, which is how the constraint reached the later one.
      expect(result.ok && result.audio.state === 'selected' && result.audio.considered.map(t => t.id.name))
        .toEqual(['en', 'es']);
    });

    it('advertises a declared audio set as switchable, since the catalog declared it', () => {
      const { result } = compose(issue24(), { scope: renderGroup(2) }, {
        audioConstraints: { lang: 'spa' },
      });
      expect(audioName(result)).toBe('audio_match_es');
      expect(result.ok && result.audio.state === 'selected' && result.audio.ladder.map(t => t.id.name))
        .toEqual(['audio_match_en', 'audio_match_es']);
    });
  });

  describe('the member-selection boundary itself', () => {
    it('selects nothing for a video pin outside the candidates', () => {
      const qc = controller({ startLevel: 0 });
      const tracks = ladderCatalog().tracks.filter(t => t.role === 'video');
      const outside = { ...tracks[0]!, name: 'elsewhere' };
      const chosen = qc.selectEligibleMembers(
        { videoLadder: tracks, audioCandidates: [] }, { videoPin: outside });
      expect(chosen.video).toBeUndefined();
      expect(qc.currentVideoTrack).toBeUndefined();
    });

    it('selects nothing for an audio pin outside the candidates', () => {
      const qc = controller();
      const audio = ladderCatalog().tracks.filter(t => t.role === 'audio');
      const outside = { ...audio[0]!, name: 'elsewhere' };
      const chosen = qc.selectEligibleMembers(
        { videoLadder: [], audioCandidates: audio }, { audioPin: outside });
      expect(chosen.audio).toBeUndefined();
      expect(qc.currentAudioTrack).toBeUndefined();
    });
  });

  describe('composing an already-built model', () => {
    it('resolves without rebuilding the catalog', () => {
      const selection = buildCatalogSelection(issue24(), { catalogNamespace: NS });
      const result = composeResolvedSelection(selection, {
        controller: controller(), intent: { scope: renderGroup(1) },
      });
      expect(videoName(result)).toBe('video_booth');
      expect(audioName(result)).toBe('audio_booth');
    });

    it('propagates a model failure rather than selecting something else', () => {
      const selection = buildCatalogSelection(issue24(), { catalogNamespace: NS });
      const result = composeResolvedSelection(selection, {
        controller: controller(), intent: { scope: renderGroup(99) },
      });
      expect(result.ok).toBe(false);
    });
  });
});
