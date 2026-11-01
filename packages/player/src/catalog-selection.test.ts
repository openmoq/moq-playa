/**
 * Catalog selection model.
 *
 * The catalogs here are the ones the behavior is argued from: issue #24's
 * multi-program example, msf-01 §5.6.15 (premium/standard tiers with audio in
 * one render group only), and cf01 §3.4.2 (a declared bitrate ladder).
 */
import { describe, expect, it } from 'vitest';
import type { CatalogState, CatalogTrack } from '@openmoq/msf';
import { parseCatalogFormat01, parseMsfCatalog } from '@openmoq/msf';
import {
  buildCatalogSelection,
  resolveSelection,
  sameTrackIdentity,
  trackIdentityKey,
  type ScopeId,
  type SelectionIntent,
} from './catalog-selection.js';

const renderGroup = (n: number): ScopeId => ({ kind: 'render-group', renderGroup: n });
const unassigned: ScopeId = { kind: 'unassigned' };

const NS = 'live/handover';
const NS_FIELDS = ['live', 'handover'] as const;

function catalog(tracks: Array<Partial<CatalogTrack> & { name: string }>): CatalogState {
  return {
    version: 1,
    tracks: tracks.map(t => ({ packaging: 'loc', isLive: true, ...t })) as CatalogTrack[],
  };
}

/** Issue #24: a commentary booth, a two-camera match, and two match languages. */
function issue24(): CatalogState {
  return catalog([
    { name: 'video_booth', role: 'video', renderGroup: 1, codec: 'av01.0.08M.10', label: 'Commentator Booth' },
    { name: 'video_match_main', role: 'video', renderGroup: 2, altGroup: 1, codec: 'av01.0.08M.10', label: 'Main Camera' },
    { name: 'video_match_cam2', role: 'video', renderGroup: 2, altGroup: 2, codec: 'av01.0.08M.10', label: 'Tactical' },
    { name: 'audio_booth', role: 'audio', renderGroup: 1, codec: 'opus' },
    { name: 'audio_match_en', role: 'audio', renderGroup: 2, altGroup: 3, codec: 'opus', lang: 'eng' },
    { name: 'audio_match_es', role: 'audio', renderGroup: 2, altGroup: 3, codec: 'opus', lang: 'spa' },
  ]);
}

/** msf-01 §5.6.15 — two tiers in different render groups, audio in one. */
function msf0105615(): CatalogState {
  return catalog([
    { name: 'premium-4k-video', role: 'video', renderGroup: 1, codec: 'av01.0.12M.10', width: 3840, height: 2160, bitrate: 15_000_000 },
    { name: 'standard-720p-video', role: 'video', renderGroup: 2, codec: 'av01.0.05M.10', width: 1280, height: 720, bitrate: 2_500_000 },
    { name: 'audio', role: 'audio', renderGroup: 1, codec: 'opus' },
  ]);
}

/** cf01 §3.4.2 — a declared ladder of three, plus audio, all rendered together. */
function cf01342(): CatalogState {
  return catalog([
    { name: 'hd', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01', width: 1920, height: 1080, bitrate: 5_000_000 },
    { name: 'md', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01', width: 720, height: 640, bitrate: 3_000_000 },
    { name: 'sd', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01', width: 192, height: 144, bitrate: 500_000 },
    { name: 'audio', role: 'audio', renderGroup: 1, codec: 'opus' },
  ]);
}

const build = (state: CatalogState, ns = NS) =>
  buildCatalogSelection(state, { catalogNamespace: ns });
const resolve = (state: CatalogState, intent?: SelectionIntent, ns = NS) =>
  resolveSelection(build(state, ns), intent);
const names = (sets: readonly { tracks: readonly { id: { name: string } }[] }[]) =>
  sets.map(s => s.tracks.map(t => t.id.name));

describe('catalog selection model', () => {
  describe("issue #24's catalog", () => {
    it('keeps a video track that declares no alternate group selectable', () => {
      const scopes = build(issue24()).scopes;
      const booth = scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 1);
      expect(names(booth!.video)).toEqual([['video_booth']]);
    });

    it('offers the two cameras as separate sets, never one ladder', () => {
      const match = build(issue24()).scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 2);
      expect(names(match!.video)).toEqual([['video_match_main'], ['video_match_cam2']]);
      expect(match!.video.map(s => s.id)).toEqual([{ kind: 'declared', altGroup: 1 }, { kind: 'declared', altGroup: 2 }]);
    });

    it('does not let a match camera take the booth commentary', () => {
      const outcome = resolve(issue24(), { scope: renderGroup(2) });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('video_match_main');
      expect(outcome.audio?.track.id.name).not.toBe('audio_booth');
      expect(outcome.audio?.set.tracks.map(t => t.id.name)).toEqual(['audio_match_en', 'audio_match_es']);
    });

    it('offers both match languages as one alternate set, carrying lang and label', () => {
      const match = build(issue24()).scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 2)!;
      expect(match.audio).toHaveLength(1);
      expect(match.audio[0]!.id).toEqual({ kind: 'declared', altGroup: 3 });
      expect(match.audio[0]!.tracks.map(t => t.lang)).toEqual(['eng', 'spa']);
      expect(match.video[0]!.tracks[0]!.label).toBe('Main Camera');
    });

    it('selects a language by track identity without changing the video', () => {
      const selection = build(issue24());
      const outcome = resolveSelection(selection, {
        scope: renderGroup(2), audioTrack: { namespaceFields: NS_FIELDS, name: 'audio_match_es' },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.audio?.track.lang).toBe('spa');
      expect(outcome.video?.track.id.name).toBe('video_match_main');
    });

    it('selects the booth program as a whole', () => {
      const outcome = resolve(issue24(), { scope: renderGroup(1) });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('video_booth');
      expect(outcome.audio?.track.id.name).toBe('audio_booth');
    });
  });

  describe('msf-01 §5.6.15 — tiers in different render groups', () => {
    it('never ladders premium against standard', () => {
      const scopes = build(msf0105615()).scopes;
      expect(names(scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 1)!.video)).toEqual([['premium-4k-video']]);
      expect(names(scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 2)!.video)).toEqual([['standard-720p-video']]);
      for (const scope of scopes) {
        for (const set of scope.video) expect(set.tracks).toHaveLength(1);
      }
    });

    it('does not give render group 2 the audio declared in render group 1', () => {
      const outcome = resolve(msf0105615(), { scope: renderGroup(2) });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('standard-720p-video');
      // Video-only is the honest outcome, not a failure and not a borrow.
      expect(outcome.audio).toBeNull();
    });

    it('gives render group 1 its own audio', () => {
      const outcome = resolve(msf0105615(), { scope: renderGroup(1) });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.audio?.track.id.name).toBe('audio');
    });
  });

  describe('cf01 §3.4.2 — a declared ladder stays intact', () => {
    it('keeps the three declared alternates in one set', () => {
      const scope = build(cf01342()).scopes[0]!;
      expect(scope.video).toHaveLength(1);
      expect(scope.video[0]!.id).toEqual({ kind: 'declared', altGroup: 1 });
      expect(scope.video[0]!.tracks.map(t => t.id.name)).toEqual(['hd', 'md', 'sd']);
    });

    it('pairs it with the audio of the same render group', () => {
      const outcome = resolve(cf01342());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.set.tracks).toHaveLength(3);
      expect(outcome.audio?.track.id.name).toBe('audio');
    });
  });

  describe('alternate group zero', () => {
    it('is a declared group, not an absent one', () => {
      const state = catalog([
        { name: 'a', role: 'video', altGroup: 0, codec: 'av01', bitrate: 2_000 },
        { name: 'b', role: 'video', altGroup: 0, codec: 'av01', bitrate: 1_000 },
      ]);
      const scope = build(state).scopes[0]!;
      expect(scope.video).toHaveLength(1);
      expect(scope.video[0]!.id).toEqual({ kind: 'declared', altGroup: 0 });
      const outcome = resolve(state, { videoAltGroup: 0 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.set.tracks.map(t => t.id.name)).toEqual(['a', 'b']);
    });
  });

  describe('a catalog that declares no groups at all', () => {
    const state = () => catalog([
      { name: 'v1', role: 'video', codec: 'av01', bitrate: 5_000_000 },
      { name: 'v2', role: 'video', codec: 'av01', bitrate: 1_000_000 },
      { name: 'a1', role: 'audio', codec: 'opus' },
    ]);

    it('makes each video a selection of one, never an inferred ladder', () => {
      const scope = build(state()).scopes[0]!;
      expect(scope.id).toEqual({ kind: 'unassigned' });
      expect(names(scope.video)).toEqual([['v1'], ['v2']]);
    });

    it('defaults to catalog order — INTENTIONALLY not the old bitrate-based pick', () => {
      // The previous behavior inferred a ladder from these two and let
      // startLevel choose a rung, so a higher-bitrate track could win. With no
      // declared alternates there is no ladder and no quality ordering to
      // honor, and catalog order is the only ordering the publisher stated.
      const outcome = resolve(state());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('v1');
      expect(outcome.video?.set.tracks).toHaveLength(1);
    });

    it('still pairs audio, because nothing declared otherwise', () => {
      const outcome = resolve(state());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.audio?.track.id.name).toBe('a1');
    });

    it('selects a specific video by identity', () => {
      const outcome = resolve(state(), { videoTrack: { namespaceFields: NS_FIELDS, name: 'v2' } });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('v2');
    });
  });

  describe('tracks with no render group', () => {
    const mixed = () => catalog([
      { name: 'grouped_video', role: 'video', renderGroup: 1, codec: 'av01' },
      { name: 'loose_audio', role: 'audio', codec: 'opus' },
    ]);

    it('are their own pool, not copied into every render group', () => {
      const scopes = build(mixed()).scopes;
      expect(scopes.map(s => s.id)).toEqual([{ kind: 'render-group', renderGroup: 1 }, { kind: 'unassigned' }]);
      expect(scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 1)!.audio).toEqual([]);
      expect(names(scopes.find(s => s.id.kind === 'unassigned')!.audio)).toEqual([['loose_audio']]);
    });

    it('are never borrowed by default', () => {
      const outcome = resolve(mixed(), { scope: renderGroup(1) });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('grouped_video');
      expect(outcome.audio).toBeNull();
    });

    it('are selectable on their own scope, never borrowed into another', () => {
      // No option exists to pair them with a grouped video, deliberately.
      const outcome = resolve(mixed(), { scope: unassigned });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.audio?.track.id.name).toBe('loose_audio');
      expect(outcome.video).toBeNull();
    });
  });

  describe('track identity', () => {
    it('distinguishes identical names in different namespaces', () => {
      const state = catalog([
        { name: 'video', role: 'video', namespace: 'ns/a', renderGroup: 1, codec: 'av01' },
        { name: 'video', role: 'video', namespace: 'ns/b', renderGroup: 2, codec: 'av01' },
      ]);
      const selection = build(state);
      const a = resolveSelection(selection, { videoTrack: { namespaceFields: ['ns', 'a'], name: 'video' } });
      const b = resolveSelection(selection, { videoTrack: { namespaceFields: ['ns', 'b'], name: 'video' } });
      expect(a.ok && a.scope.id).toEqual(renderGroup(1));
      expect(b.ok && b.scope.id).toEqual(renderGroup(2));
      expect(trackIdentityKey({ namespaceFields: ['ns', 'a'], name: 'video' }))
        .not.toBe(trackIdentityKey({ namespaceFields: ['ns', 'b'], name: 'video' }));
    });

    it('keys two distinct pairs distinctly even across a delimiter', () => {
      // A delimiter-joined key would collide these: neither format excludes
      // NUL from a namespace or a name.
      expect(trackIdentityKey({ namespaceFields: ['live\u0000other'], name: 'camera' }))
        .not.toBe(trackIdentityKey({ namespaceFields: ['live'], name: 'other\u0000camera' }));
    });

    it('treats an omitted namespace and an explicitly inherited one as the same track', () => {
      // §5.2.2: a track that declares none inherits the catalog's.
      const omitted = build(catalog([{ name: 'v', role: 'video', codec: 'av01' }]));
      const explicit = build(catalog([{ name: 'v', role: 'video', namespace: NS, codec: 'av01' }]));
      const left = omitted.scopes[0]!.video[0]!.tracks[0]!.id;
      const right = explicit.scopes[0]!.video[0]!.tracks[0]!.id;
      expect(sameTrackIdentity(left, right)).toBe(true);
      expect(left.namespaceFields).toEqual([...NS_FIELDS]);
    });
  });

  describe('what it refuses to invent', () => {
    it('fails rather than substituting when the selected track is gone', () => {
      const before = build(issue24());
      const removed = issue24();
      const after = build({ ...removed, tracks: removed.tracks.filter(t => t.name !== 'video_match_cam2') });
      const intent: SelectionIntent = { videoTrack: { namespaceFields: NS_FIELDS, name: 'video_match_cam2' } };
      expect(resolveSelection(before, intent).ok).toBe(true);
      const outcome = resolveSelection(after, intent);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toMatch(/video_match_cam2/);
    });

    it('fails on a render group the catalog does not declare', () => {
      const outcome = resolve(issue24(), { scope: renderGroup(99) });
      expect(outcome.ok).toBe(false);
    });

    it('fails on an alternate group the catalog does not declare', () => {
      const outcome = resolve(issue24(), { scope: renderGroup(2), videoAltGroup: 42 });
      expect(outcome.ok).toBe(false);
    });

    it('survives catalog reorder — identity selects, position does not', () => {
      const original = issue24();
      const reordered: CatalogState = { ...original, tracks: [...original.tracks].reverse() };
      const intent: SelectionIntent = { videoTrack: { namespaceFields: NS_FIELDS, name: 'video_match_cam2' } };
      const before = resolve(original, intent);
      const after = resolve(reordered, intent);
      expect(before.ok && before.video?.track.id.name).toBe('video_match_cam2');
      expect(after.ok && after.video?.track.id.name).toBe('video_match_cam2');
    });

    it('excludes unsupported packaging instead of offering a substitute', () => {
      const state = catalog([
        { name: 'future', role: 'video', packaging: 'locmaf', locmafVersion: 'draft-99', codec: 'av01' },
        { name: 'playable', role: 'video', codec: 'av01' },
      ]);
      const selection = build(state);
      expect(selection.excluded.map(e => e.id.name)).toContain('future');
      expect(names(selection.scopes[0]!.video)).toEqual([['playable']]);
    });

    it('reports a track with no media role rather than guessing one', () => {
      const state = catalog([
        { name: 'timeline', packaging: 'mediatimeline' },
        { name: 'v', role: 'video', codec: 'av01' },
      ]);
      const selection = build(state);
      expect(selection.excluded).toContainEqual({
        id: { namespaceFields: NS_FIELDS, name: 'timeline' }, reason: 'no-media-role',
      });
      expect(names(selection.scopes[0]!.video)).toEqual([['v']]);
    });

    it('fabricates no group number for a singleton', () => {
      const scopes = build(issue24()).scopes;
      const booth = scopes.find(s => s.id.kind === 'render-group' && s.id.renderGroup === 1)!;
      expect(booth.video[0]!.id).toEqual({ kind: 'singleton' });
    });
  });

  describe('disabled media types', () => {
    it('omits video without inventing a replacement selection', () => {
      const outcome = resolve(issue24(), { scope: renderGroup(2), disableVideo: true });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video).toBeNull();
      expect(outcome.audio?.track.id.name).toBe('audio_match_en');
    });

    it('omits audio and still resolves the video', () => {
      const outcome = resolve(issue24(), { scope: renderGroup(2), disableAudio: true });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.audio).toBeNull();
      expect(outcome.video?.track.id.name).toBe('video_match_main');
    });

    it('picks an audio-only scope when video is disabled and the first scope has none', () => {
      const state = catalog([
        { name: 'v', role: 'video', renderGroup: 1, codec: 'av01' },
        { name: 'a', role: 'audio', renderGroup: 2, codec: 'opus' },
      ]);
      const outcome = resolve(state, { disableVideo: true });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.scope.id).toEqual(renderGroup(2));
      expect(outcome.audio?.track.id.name).toBe('a');
    });
  });

  describe('scope resolution', () => {
    // Adopted from review: defaults must follow catalog MEDIA order, and an
    // explicit selector must be resolved before a default scope can exclude it.
    const loose = (name: string, role: 'video' | 'audio', fields: Partial<CatalogTrack> = {}) =>
      ({ name, role, ...fields });

    it('defaults to the first video even when it is unassigned', () => {
      const outcome = resolve(catalog([
        loose('first', 'video'), loose('second', 'video', { renderGroup: 1 }),
      ]));
      expect(outcome.ok && outcome.video?.track.id.name).toBe('first');
    });

    it('defaults by video order rather than the first appearance of its render group', () => {
      // Scope order follows the first track of ANY type, so render group 1
      // leads while the first VIDEO belongs to render group 2.
      const outcome = resolve(catalog([
        loose('audio-first', 'audio', { renderGroup: 1 }),
        loose('first-video', 'video', { renderGroup: 2 }),
        loose('second-video', 'video', { renderGroup: 1 }),
      ]));
      expect(outcome.ok && outcome.video?.track.id.name).toBe('first-video');
    });

    it('defaults audio by catalog order rather than by scope order', () => {
      // The video puts render group 1 first among the scopes, while the first
      // AUDIO belongs to render group 2 — so scanning scopes and reading
      // catalog order give different answers, which is what makes this
      // fixture able to catch the defect at all.
      const outcome = resolve(catalog([
        loose('video-first', 'video', { renderGroup: 1 }),
        loose('first-audio', 'audio', { renderGroup: 2 }),
        loose('later-audio', 'audio', { renderGroup: 1 }),
      ]), { disableVideo: true });
      expect(outcome.ok && outcome.audio?.track.id.name).toBe('first-audio');
    });

    it('prefers unassigned audio that appears before any grouped audio', () => {
      // Scope order puts declared groups ahead of the unassigned pool, so a
      // scope scan would reach the grouped audio first even though the
      // catalog's first audio is unassigned.
      const outcome = resolve(catalog([
        loose('video', 'video', { renderGroup: 1 }),
        loose('loose-audio', 'audio'),
        loose('grouped-audio', 'audio', { renderGroup: 1 }),
      ]), { disableVideo: true });
      expect(outcome.ok && outcome.audio?.track.id.name).toBe('loose-audio');
    });

    it('honors an explicit video alternate group outside the default scope', () => {
      const outcome = resolve(catalog([
        loose('booth', 'video', { renderGroup: 1 }),
        loose('match', 'video', { renderGroup: 2, altGroup: 0 }),
      ]), { videoAltGroup: 0 });
      expect(outcome.ok && outcome.video?.track.id.name).toBe('match');
    });

    it('infers the scope of an explicit audio identity', () => {
      const outcome = resolve(catalog([
        loose('booth', 'video', { renderGroup: 1 }),
        loose('match', 'video', { renderGroup: 2 }),
        loose('commentary', 'audio', { renderGroup: 2 }),
      ]), { audioTrack: { namespaceFields: NS_FIELDS, name: 'commentary' } });
      expect(outcome.ok && outcome.audio?.track.id.name).toBe('commentary');
      expect(outcome.ok && outcome.video?.track.id.name).toBe('match');
    });

    it('infers the scope of an explicit audio alternate group', () => {
      const outcome = resolve(catalog([
        loose('booth', 'video', { renderGroup: 1 }),
        loose('match', 'video', { renderGroup: 2 }),
        loose('es', 'audio', { renderGroup: 2, altGroup: 5, lang: 'spa' }),
      ]), { audioAltGroup: 5 });
      expect(outcome.ok && outcome.audio?.track.lang).toBe('spa');
      expect(outcome.ok && outcome.video?.track.id.name).toBe('match');
    });

    it('fails rather than guessing when two scopes satisfy the same selector', () => {
      const outcome = resolve(catalog([
        loose('a', 'video', { renderGroup: 1, altGroup: 1 }),
        loose('b', 'video', { renderGroup: 2, altGroup: 1 }),
      ]), { videoAltGroup: 1 });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toMatch(/name one explicitly/);
    });

    it('fails when explicit video and audio demand different scopes', () => {
      const outcome = resolve(catalog([
        loose('cam', 'video', { renderGroup: 1 }),
        loose('booth_audio', 'audio', { renderGroup: 2 }),
      ]), {
        videoTrack: { namespaceFields: NS_FIELDS, name: 'cam' },
        audioTrack: { namespaceFields: NS_FIELDS, name: 'booth_audio' },
      });
      expect(outcome.ok).toBe(false);
    });

    it('keeps an explicit scope restrictive', () => {
      const outcome = resolve(issue24(), {
        scope: renderGroup(1), videoTrack: { namespaceFields: NS_FIELDS, name: 'video_match_main' },
      });
      expect(outcome.ok).toBe(false);
    });
  });

  describe('selectors that contradict each other', () => {
    it('rejects a track identity outside the requested alternate group', () => {
      const outcome = resolve(catalog([
        { name: 'camera-a', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01' },
        { name: 'camera-b', role: 'video', renderGroup: 1, altGroup: 2, codec: 'av01' },
      ]), { videoTrack: { namespaceFields: NS_FIELDS, name: 'camera-a' }, videoAltGroup: 2 });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toMatch(/alternate group 2/);
    });

    it('accepts a track identity that agrees with the requested alternate group', () => {
      const outcome = resolve(catalog([
        { name: 'camera-a', role: 'video', renderGroup: 1, altGroup: 1, codec: 'av01' },
        { name: 'camera-b', role: 'video', renderGroup: 1, altGroup: 2, codec: 'av01' },
      ]), { videoTrack: { namespaceFields: NS_FIELDS, name: 'camera-a' }, videoAltGroup: 1 });
      expect(outcome.ok && outcome.video?.track.id.name).toBe('camera-a');
    });

    it('rejects an audio identity outside the requested audio alternate group', () => {
      const outcome = resolve(issue24(), {
        audioTrack: { namespaceFields: NS_FIELDS, name: 'audio_booth' }, audioAltGroup: 3,
      });
      expect(outcome.ok).toBe(false);
    });
  });

  describe('selectors for a disabled media type', () => {
    it('does not let a disabled video identity steer the audio scope', () => {
      const outcome = resolve(catalog([
        { name: 'camera', role: 'video', renderGroup: 1, codec: 'av01' },
        { name: 'commentary', role: 'audio', renderGroup: 2, codec: 'opus' },
      ]), { disableVideo: true, videoTrack: { namespaceFields: NS_FIELDS, name: 'camera' } });
      expect(outcome.ok && outcome.audio?.track.id.name).toBe('commentary');
      expect(outcome.ok && outcome.video).toBeNull();
    });

    it('does not let a disabled audio identity steer the video scope', () => {
      const outcome = resolve(catalog([
        { name: 'camera', role: 'video', renderGroup: 1, codec: 'av01' },
        { name: 'commentary', role: 'audio', renderGroup: 2, codec: 'opus' },
      ]), { disableAudio: true, audioTrack: { namespaceFields: NS_FIELDS, name: 'commentary' } });
      expect(outcome.ok && outcome.video?.track.id.name).toBe('camera');
      expect(outcome.ok && outcome.audio).toBeNull();
    });

    it('ignores a disabled-type identity that the catalog no longer offers', () => {
      const outcome = resolve(issue24(), {
        disableVideo: true, videoTrack: { namespaceFields: NS_FIELDS, name: 'deleted_camera' },
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video).toBeNull();
    });
  });

  describe('catalogs offering only one media type', () => {
    it('resolves a video-only catalog without failing for want of audio', () => {
      const state = catalog([
        { name: 'v1', role: 'video', renderGroup: 1, codec: 'av01' },
        { name: 'v2', role: 'video', renderGroup: 1, altGroup: 7, codec: 'av01' },
      ]);
      const outcome = resolve(state);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video?.track.id.name).toBe('v1');
      expect(outcome.audio).toBeNull();
    });

    it('resolves an audio-only catalog without inventing a video', () => {
      const state = catalog([
        { name: 'a_en', role: 'audio', renderGroup: 1, altGroup: 1, codec: 'opus', lang: 'eng' },
        { name: 'a_es', role: 'audio', renderGroup: 1, altGroup: 1, codec: 'opus', lang: 'spa' },
      ]);
      const outcome = resolve(state);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.video).toBeNull();
      expect(outcome.audio?.set.tracks.map(t => t.lang)).toEqual(['eng', 'spa']);
      expect(outcome.audio?.track.lang).toBe('eng');
    });

    it('fails only when the catalog offers no playable media at all', () => {
      const outcome = resolve(catalog([{ name: 'timeline', packaging: 'mediatimeline' }]));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toMatch(/no playable media/);
    });
  });

  describe('through the real parsers', () => {
    // The fixtures above are hand-built normalized tracks, which prove the
    // selection policy but say nothing about what the parsers hand it. These
    // two go through the actual parsers for the fields identity and labelling
    // depend on.
    it('MSF: a track inherits the catalog namespace, another overrides it', () => {
      const parsed = parseMsfCatalog(JSON.stringify({
        version: '1',
        tracks: [
          { name: 'inherits', role: 'video', packaging: 'loc', codec: 'av01', renderGroup: 1,
            isLive: true },
          { name: 'overrides', role: 'video', packaging: 'loc', codec: 'av01', renderGroup: 2,
            isLive: true, namespace: 'other/space' },
        ],
      }), NS);
      const selection = buildCatalogSelection(parsed as CatalogState, { catalogNamespace: NS });
      const ids = selection.scopes.flatMap(sc => sc.video.flatMap(set => set.tracks.map(t => t.id)));
      expect(ids).toEqual([
        { namespaceFields: NS_FIELDS, name: 'inherits' },
        { namespaceFields: ['other', 'space'], name: 'overrides' },
      ]);
      // §5.2.3 makes names unique per namespace, so these stay distinct keys.
      expect(trackIdentityKey(ids[0]!)).not.toBe(trackIdentityKey(ids[1]!));
    });

    it('cf01: lang from selectionParams and label from the track object both reach the model', () => {
      const parsed = parseCatalogFormat01(JSON.stringify({
        version: 1,
        streamingFormat: 1,
        streamingFormatVersion: '0.2',
        commonTrackFields: { renderGroup: 1, packaging: 'loc' },
        tracks: [
          { name: 'cam', selectionParams: { codec: 'av01', width: 1920, height: 1080 },
            label: 'Main Camera' },
          { name: 'spanish', selectionParams: { codec: 'opus', samplerate: 48000, lang: 'spa' },
            altGroup: 4, label: 'Español' },
          { name: 'english', selectionParams: { codec: 'opus', samplerate: 48000, lang: 'en-US' },
            altGroup: 4, label: 'English' },
        ],
      }), NS);
      const scope = buildCatalogSelection(parsed.catalog as CatalogState,
        { catalogNamespace: NS }).scopes[0]!;
      expect(scope.video[0]!.tracks[0]!.label).toBe('Main Camera');
      // Carried verbatim — 'en-US' is a TAG, and matching it against a
      // preference is RFC 4647 lookup, deliberately not done here.
      expect(scope.audio[0]!.tracks.map(t => ({ lang: t.lang, label: t.label }))).toEqual([
        { lang: 'spa', label: 'Español' },
        { lang: 'en-US', label: 'English' },
      ]);
    });
  });

  describe('purity', () => {
    it('does not mutate the catalog it was given', () => {
      const state = issue24();
      const snapshot = JSON.stringify(state);
      const selection = build(state);
      resolveSelection(selection, { scope: renderGroup(2) });
      expect(JSON.stringify(state)).toBe(snapshot);
    });

    it('is deterministic for the same catalog and intent', () => {
      const state = issue24();
      const first = resolve(state, { scope: renderGroup(2) });
      const second = resolve(state, { scope: renderGroup(2) });
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });
});
