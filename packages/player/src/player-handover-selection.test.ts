import { describe, expect, it } from 'vitest';
import type { CatalogState, CatalogTrack } from '@openmoq/msf';
import type { ClockSource } from '@openmoq/playback';
import { QualityController } from './quality-controller.js';
import type { TrackIdentity } from './catalog-selection.js';
import { selectHandoverTracks, type HandoverIntent } from './player-handover-selection.js';

const clock: ClockSource = { now: () => 1_000_000 };

function video(name: string, options: Partial<CatalogTrack> = {}): CatalogTrack {
  return { name, packaging: 'loc', role: 'video', isLive: true, altGroup: 1,
    codec: 'avc1.640028', ...options };
}

function singletonVideo(name: string, options: Partial<CatalogTrack> = {}): CatalogTrack {
  const { altGroup: _altGroup, ...track } = video(name, options);
  return track;
}

function audio(name: string, options: Partial<CatalogTrack> = {}): CatalogTrack {
  return { name, packaging: 'loc', role: 'audio', isLive: true, codec: 'opus',
    lang: 'en', ...options };
}

function catalog(): CatalogState {
  return { version: 1, tracks: [
    video('high', { bitrate: 3_000_000, width: 1920, height: 1080 }),
    video('middle', { bitrate: 1_500_000, width: 1280, height: 720 }),
    video('low', { bitrate: 300_000, width: 640, height: 360 }),
    audio('english'),
    audio('french', { lang: 'fr' }),
  ] };
}

/** This suite's catalogs declare no namespace, so every track inherits this. */
const NS = 'live/show';
/** A full identity for a track of this suite's catalogs, by name. */
const id = (name: string): TrackIdentity => ({ namespaceFields: ['live', 'show'], name });

function intent(overrides: Partial<HandoverIntent> = {}): HandoverIntent {
  return {
    autoQuality: true, startLevel: 'auto', qualitySwitchCooldownMs: 5000,
    manualLevel: null, catalogNamespace: NS,
    activeVideoTrack: null, activeAudioTrack: null,
    pinnedVideo: false, pinnedAudio: false,
    disableVideo: false, disableAudio: false, ...overrides,
  };
}

function selected(state: CatalogState, overrides: Partial<HandoverIntent> = {}) {
  const result = selectHandoverTracks(state, intent(overrides), clock);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

function unavailable(state: CatalogState, overrides: Partial<HandoverIntent>, reason: RegExp) {
  const result = selectHandoverTracks(state, intent(overrides), clock);
  expect(result).toEqual({ ok: false, reason: expect.stringMatching(reason) });
}

describe('selectHandoverTracks', () => {
  it('discovers a singleton before a later declared alternate set', () => {
    const singleton = singletonVideo('camera', { bitrate: 100_000 });
    const state = { version: 1, tracks: [singleton, ...catalog().tracks] };
    expect(selected(state).video).toBe(singleton);
  });

  it('does not combine independent singleton videos into a quality ladder', () => {
    const first = singletonVideo('first', { bitrate: 3_000_000 });
    const second = singletonVideo('second', { bitrate: 100_000 });
    expect(selected({ version: 1, tracks: [first, second] }, { startLevel: 'lowest' }).video)
      .toBe(first);
  });

  it('defaults audio to the selected video render scope', () => {
    const mainAudio = audio('main-audio', { renderGroup: 1 });
    const sideVideo = video('side-video', { renderGroup: 2 });
    const sideAudio = audio('side-audio', { renderGroup: 2 });
    const result = selected({ version: 1, tracks: [mainAudio, sideVideo, sideAudio] });
    expect(result.video).toBe(sideVideo);
    expect(result.audio).toBe(sideAudio);
  });

  it.each(['video', 'audio'] as const)('does not replace a pinned %s with the same name in another namespace', role => {
    const established = role === 'video' ? 'middle' : 'english';
    const state = { ...catalog(), tracks: catalog().tracks.map(t => t.name === established
      ? { ...t, namespace: 'other/show' } : t) };
    unavailable(state, role === 'video'
      ? { activeVideoTrack: id(established), pinnedVideo: true }
      : { activeAudioTrack: id(established), pinnedAudio: true }, new RegExp(established));
  });

  it.each(['video', 'audio'] as const)('rejects losing established %s inside the captured scope', role => {
    const state = { version: 1, tracks: [
      video('side', { renderGroup: role === 'video' ? 1 : 2 }),
      audio('side-audio', { renderGroup: role === 'audio' ? 1 : 2 }),
    ] };
    unavailable(state, { scope: 2, activeVideoTrack: id('side'),
      activeAudioTrack: id('side-audio') }, new RegExp(role));
  });

  it('does not escape a singleton to satisfy a resolution cap', () => {
    unavailable({ version: 1, tracks: [
      singletonVideo('large', { width: 1920, height: 1080 }),
      singletonVideo('small', { width: 640, height: 360 }),
    ] }, { capLevelToResolution: { width: 640, height: 360 } }, /video/);
  });

  it('keeps automatic audio fallback inside its captured alternate set', () => {
    const outside = audio('outside', { altGroup: 1 });
    const inside = audio('inside', { altGroup: 0 });
    const state = { version: 1, tracks: [video('v'), outside, inside] };
    expect(selected(state, { activeAudioTrack: id('removed'), audioAltGroup: 0 }).audio).toBe(inside);
    unavailable(state, { audioAltGroup: 0, audioConstraints: { lang: 'fr' } }, /audio/);
  });

  it('keeps surviving automatic audio in its declared set after reordering', () => {
    const state = { version: 1, tracks: [video('v'),
      audio('other', { altGroup: 9 }), audio('retained', { altGroup: 0 })] };
    expect(selected(state, { activeAudioTrack: id('retained') }).audio).toBe(state.tracks[2]);
  });

  it('ignores disabled pins and groups when choosing the audio scope', () => {
    const a = audio('only-audio', { renderGroup: 2 });
    expect(selected({ version: 1, tracks: [video('disabled', { renderGroup: 1 }), a] }, {
      disableVideo: true, activeVideoTrack: id('disabled'), pinnedVideo: true, videoAltGroup: 99,
    }).audio).toBe(a);
  });

  it.each([
    ['auto', 'middle'], ['lowest', 'low'], [0, 'high'], [1, 'middle'], [20, 'low'],
  ] as const)('uses the existing %s startup selection when no active track survives', (startLevel, name) => {
    const result = selected(catalog(), { startLevel });
    expect(result.video?.name).toBe(name);
    expect(result.audio?.name).toBe('english');
  });

  it.each([true, false])('preserves active tracks instead of startup choices (auto=%s)', autoQuality => {
    const state = catalog();
    const result = selected(state, {
      autoQuality, startLevel: 0, manualLevel: 0,
      activeVideoTrack: id('low'), activeAudioTrack: id('french'),
    });
    expect(result.video).toBe(state.tracks[2]);
    expect(result.audio).toBe(state.tracks[4]);
  });

  it('uses the snapshotted manual level when the old track is absent', () => {
    expect(selected(catalog(), { autoQuality: false, manualLevel: 2,
      activeVideoTrack: id('old-low'), startLevel: 0 }).video?.name).toBe('low');
  });

  it.each([[0, 'high'], [20, 'low']] as const)('accepts manual level %s with the existing clamping rule', (manualLevel, name) => {
    expect(selected(catalog(), { autoQuality: false, manualLevel, startLevel: 1 })
      .video?.name).toBe(name);
  });

  it('ignores a stale manual level when automatic selection is enabled', () => {
    expect(selected(catalog(), { autoQuality: true, manualLevel: 2 }).video?.name).toBe('middle');
  });

  it('retains startup selection when manual mode has no recorded level', () => {
    expect(selected(catalog(), { autoQuality: false, manualLevel: null, startLevel: 'lowest' })
      .video?.name).toBe('low');
  });

  it('keeps a manual cross-codec track from the complete ladder', () => {
    const state = catalog();
    const av1 = video('av1', { codec: 'av01.0.05M.10', bitrate: 500_000 });
    state.tracks.push(av1);
    expect(selected(state, { autoQuality: false, activeVideoTrack: id('av1'), manualLevel: 2 })
      .video).toBe(av1);
  });

  it('uses the complete ladder index for a manual fallback, not a codec-family index', () => {
    const state = catalog();
    state.tracks.push(video('av1', { codec: 'av01.0.05M.10', bitrate: 2_000_000 }));
    expect(selected(state, { autoQuality: false, manualLevel: 2, startLevel: 0 })
      .video?.name).toBe('middle');
  });

  it('honors an explicit view including group zero', () => {
    const state = catalog();
    state.tracks.push(video('other-high', { altGroup: 0, bitrate: 2_000_000 }),
      video('other-low', { altGroup: 0, bitrate: 200_000 }));
    expect(selected(state, { videoAltGroup: 0, activeVideoTrack: id('high') }).video?.name).toBe('other-low');
  });

  it('keeps the active view when catalog order changes and no explicit group was supplied', () => {
    const state = catalog();
    state.tracks.unshift(video('other', { altGroup: 9, bitrate: 4_000_000 }));
    expect(selected(state, { activeVideoTrack: id('low') }).video?.name).toBe('low');
  });

  it('falls back within the snapshotted view when its active track was removed', () => {
    const state = catalog();
    state.tracks.unshift(video('other', { altGroup: 9, bitrate: 4_000_000 }));
    expect(selected(state, { videoAltGroup: 1, activeVideoTrack: id('old-track') }).video?.name).toBe('middle');
  });

  it('returns a rejection instead of throwing or switching a missing view', () => {
    unavailable(catalog(), { videoAltGroup: 9 }, /video.*altGroup.*9/i);
  });

  it('rejects a view whose only track has unsupported packaging', () => {
    const state = catalog();
    state.tracks.push(video('future', { altGroup: 9, packaging: 'locmaf', locmafVersion: '9.9' }));
    unavailable(state, { videoAltGroup: 9, activeVideoTrack: id('future') }, /video.*altGroup.*9/i);
  });

  it('preserves an ungrouped view instead of defaulting to a newly offered group', () => {
    const state = catalog();
    const ungrouped: CatalogTrack = { name: 'ungrouped', packaging: 'loc', role: 'video',
      isLive: true, codec: 'avc1.640028', bitrate: 100_000 };
    state.tracks.push(ungrouped);
    expect(selected(state, { videoAltGroup: null, activeVideoTrack: id('ungrouped') }).video).toBe(ungrouped);
  });

  it('declines a lost established singleton even when one new singleton is unambiguous', () => {
    unavailable({ version: 1, tracks: [singletonVideo('new-camera')] }, {
      videoAltGroup: null, activeVideoTrack: id('old-camera'),
    }, /video.*old-camera/);
  });

  it('allows an unambiguous singleton without an established video', () => {
    const camera = singletonVideo('camera');
    expect(selected({ version: 1, tracks: [camera] }, { videoAltGroup: null }).video).toBe(camera);
  });

  it.each(['video', 'audio'] as const)('rejects a reused %s group with no captured identities', role => {
    const state = { version: 1, tracks: [video('new-video'), audio('new-audio', { altGroup: 1 })] };
    unavailable(state, role === 'video' ? {
      activeVideoTrack: id('old-high'), videoAltGroup: 1,
      videoAlternates: [id('old-high'), id('old-low')],
    } : {
      activeAudioTrack: id('old-high'), audioAltGroup: 1,
      audioAlternates: [id('old-high'), id('old-low')],
    }, new RegExp(`${role}.*captured`));
  });

  it.each(['video', 'audio'] as const)('allows %s fallback when a captured sibling survives in the selected set', role => {
    const sibling = role === 'video' ? video('old-low') : audio('old-low', { altGroup: 1 });
    const state = { version: 1, tracks: [sibling] };
    const captured: readonly TrackIdentity[] = Object.freeze([
      Object.freeze({ name: 'old-high', namespaceFields: Object.freeze(['live', 'show']) }),
      Object.freeze({ name: 'old-low', namespaceFields: Object.freeze(['live', 'show']) }),
    ]);
    const snapshot = structuredClone(captured);
    const result = selected(state, role === 'video' ? {
      activeVideoTrack: id('old-high'), videoAltGroup: 1, videoAlternates: captured,
    } : {
      activeAudioTrack: id('old-high'), audioAltGroup: 1, audioAlternates: captured,
    });
    expect(result[role]).toBe(sibling);
    expect(captured).toEqual(snapshot);
  });

  it.each(['video', 'audio'] as const)('does not count a captured %s sibling from a different namespace', role => {
    const sibling = role === 'video'
      ? video('old-low', { namespace: 'other/show' })
      : audio('old-low', { namespace: 'other/show', altGroup: 1 });
    unavailable({ version: 1, tracks: [sibling] }, role === 'video' ? {
      activeVideoTrack: id('old-high'), videoAltGroup: 1,
      videoAlternates: [id('old-high'), id('old-low')],
    } : {
      activeAudioTrack: id('old-high'), audioAltGroup: 1,
      audioAlternates: [id('old-high'), id('old-low')],
    }, new RegExp(`${role}.*captured`));
  });

  it('does not count a captured sibling outside the selected video set', () => {
    unavailable({ version: 1, tracks: [video('new-camera'), video('old-low', { altGroup: 2 })] }, {
      activeVideoTrack: id('old-high'), videoAltGroup: 1,
      videoAlternates: [id('old-high'), id('old-low')],
    }, /video.*captured/);
  });

  it.each(['video', 'audio'] as const)('treats an empty captured %s set as no surviving alternates', role => {
    unavailable(catalog(), role === 'video' ? {
      activeVideoTrack: id('removed'), videoAltGroup: 1, videoAlternates: [],
    } : {
      activeAudioTrack: id('removed'), audioAlternates: [],
    }, new RegExp(`${role}.*captured`));
  });

  it.each(['video', 'audio'] as const)('does not substitute a captured sibling for a pinned %s', role => {
    unavailable(catalog(), role === 'video' ? {
      activeVideoTrack: id('removed'), pinnedVideo: true, videoAltGroup: 1,
      videoAlternates: [id('removed'), id('low')], autoQuality: false, manualLevel: 2,
    } : {
      activeAudioTrack: id('removed'), pinnedAudio: true,
      audioAlternates: [id('removed'), id('english')],
    }, /removed/);
  });

  it('ignores captured sets for disabled or never-established outputs', () => {
    const result = selected(catalog(), {
      disableVideo: true, activeVideoTrack: id('removed'), videoAlternates: [], audioAlternates: [],
    });
    expect(result.video).toBeNull();
    expect(result.audio?.name).toBe('english');
  });

  it('rejects a missing ungrouped view rather than changing to a grouped one', () => {
    unavailable(catalog(), { videoAltGroup: null, activeVideoTrack: id('old-ungrouped') }, /video/i);
  });

  it('does not let a surviving track name override the resolution cap', () => {
    expect(selected(catalog(), { activeVideoTrack: id('high'), startLevel: 0,
      capLevelToResolution: { width: 1280, height: 720 } }).video?.name).toBe('middle');
  });

  it('rejects an enabled video set emptied by the resolution cap', () => {
    unavailable(catalog(), { activeVideoTrack: id('high'),
      capLevelToResolution: { width: 320, height: 180 } }, /video/i);
  });

  it('uses video constraints for automatic startup selection', () => {
    expect(selected(catalog(), { videoConstraints: { maxHeight: 720 } }).video?.name).toBe('middle');
  });

  it('does not reapply startup video constraints over an existing manual choice', () => {
    expect(selected(catalog(), { autoQuality: false, activeVideoTrack: id('high'),
      videoConstraints: { maxHeight: 360 } }).video?.name).toBe('high');
  });

  it('rejects an enabled video set with no startup constraint match', () => {
    unavailable(catalog(), { videoConstraints: { codec: 'hvc1.1.6.L93.B0' } }, /video/i);
  });

  it('does not let a preferred audio name override the requested language', () => {
    expect(selected(catalog(), { activeAudioTrack: id('english'), audioConstraints: { lang: 'fr' } })
      .audio?.name).toBe('french');
  });

  it('rejects an enabled audio set without a constraint match', () => {
    unavailable(catalog(), { activeAudioTrack: id('english'), audioConstraints: { lang: 'de' } }, /audio/i);
  });

  it('rejects a replacement that drops the video that was ESTABLISHED', () => {
    const state = catalog();
    unavailable({ ...state, tracks: state.tracks.filter(t => t.role !== 'video') },
      { activeVideoTrack: id('middle') }, /video/);
  });

  it('accepts a replacement with no video when none was established', () => {
    // Symmetric with audio: requiredness comes from what was actually
    // selected. A presentation that never had video loses nothing when the
    // replacement declares none either.
    const state = catalog();
    const result = selected({ ...state, tracks: state.tracks.filter(t => t.role !== 'video') });
    expect(result.video).toBeNull();
    expect(result.audio?.name).toBe('english');
  });

  it('rejects a replacement that drops the audio that was ESTABLISHED', () => {
    const state = catalog();
    unavailable({ ...state, tracks: state.tracks.filter(t => t.role !== 'audio') },
      { activeAudioTrack: id('english') }, /audio/);
  });

  it('accepts a replacement with no audio when none was established', () => {
    // Requiredness comes from what was actually selected, not from audio
    // being enabled: a presentation that never had audio loses nothing when
    // the replacement declares none either.
    const state = catalog();
    const result = selected({ ...state, tracks: state.tracks.filter(t => t.role !== 'audio') });
    expect(result.audio).toBeNull();
    expect(result.video?.name).toBe('middle');
  });

  it.each(['video', 'audio'] as const)('does not restore an unsupported active %s track', role => {
    const state = catalog();
    const future = role === 'video'
      ? video('future', { packaging: 'locmaf', locmafVersion: '9.9' })
      : audio('future', { packaging: 'locmaf', locmafVersion: '9.9' });
    state.tracks.unshift(future);
    const result = selected(state, role === 'video'
      ? { activeVideoTrack: id('future') } : { activeAudioTrack: id('future') });
    expect(result[role]?.name).toBe(role === 'video' ? 'middle' : 'english');
  });

  it.each(['video', 'audio'] as const)('rejects an enabled %s set containing only unsupported tracks', role => {
    const state = catalog();
    const future = role === 'video'
      ? video('future', { packaging: 'locmaf', locmafVersion: '9.9' })
      : audio('future', { packaging: 'locmaf', locmafVersion: '9.9' });
    const replacement = { ...state, tracks: [...state.tracks.filter(t => t.role !== role), future] };
    unavailable(replacement, role === 'video'
      ? { activeVideoTrack: id('future') } : { activeAudioTrack: id('future') }, new RegExp(role));
  });

  it('retains a supported LOCMAF track', () => {
    const state = catalog();
    const locmaf = video('locmaf', { packaging: 'locmaf', locmafVersion: '0.3' });
    state.tracks.push(locmaf);
    expect(selected(state, { activeVideoTrack: id('locmaf') }).video).toBe(locmaf);
  });

  it('never uses a track of the wrong role merely because its name matches', () => {
    const result = selected(catalog(), { activeVideoTrack: id('english'), activeAudioTrack: id('high') });
    expect(result.video?.name).toBe('middle');
    expect(result.audio?.name).toBe('english');
  });

  it.each(['video', 'audio'] as const)('keeps disabled %s absent even when its active track is offered', role => {
    const result = selected(catalog(), { disableVideo: role === 'video', disableAudio: role === 'audio',
      activeVideoTrack: id('high'), activeAudioTrack: id('english') });
    expect(result[role]).toBeNull();
    expect(result[role === 'video' ? 'audio' : 'video']).not.toBeNull();
  });

  it('does not require a view when video is disabled', () => {
    expect(selected(catalog(), { disableVideo: true, videoAltGroup: 99 }).video).toBeNull();
  });

  it('returns two nulls when both media types are disabled', () => {
    expect(selected({ version: 1, tracks: [] }, { disableVideo: true, disableAudio: true }))
      .toEqual({ ok: true, video: null, audio: null });
  });

  it('does not mutate inputs or retain selection between calls', () => {
    const state = catalog();
    const snapshot = structuredClone(state);
    state.tracks.forEach(Object.freeze);
    Object.freeze(state.tracks);
    Object.freeze(state);
    const first = Object.freeze(intent({ autoQuality: false, activeVideoTrack: id('low'),
      capLevelToResolution: Object.freeze({ width: 1920, height: 1080 }),
      videoConstraints: Object.freeze({ maxHeight: 720 }),
      audioConstraints: Object.freeze({ lang: 'fr' }) }));
    const savedIntent = structuredClone(first);
    const before = selectHandoverTracks(state, first, clock);
    expect(selected(state, { startLevel: 0 }).video?.name).toBe('high');
    expect(selectHandoverTracks(state, first, { now: () => 900_000_000 })).toEqual(before);
    expect(state).toEqual(snapshot);
    expect(first).toEqual(savedIntent);
  });

  it('leaves the live quality controller selection, mode and cooldown alone', () => {
    const state = catalog();
    const live = new QualityController({ autoQuality: true, startLevel: 0,
      qualitySwitchCooldownMs: 5000, clock });
    live.selectInitialTracks(state);
    live.commitVideoTrack('low');
    live.lockManual();
    const before = { track: live.currentVideoTrack, index: live.currentIndex,
      alternatives: [...live.alternatives], auto: live.isAutoQuality };
    const snapshot = intent({ autoQuality: live.isAutoQuality,
      activeVideoTrack: id(live.currentVideoTrack!.name),
      manualLevel: live.allAlternatives.indexOf(live.currentVideoTrack!) });
    selected(state, { ...snapshot, activeVideoTrack: id('middle') });
    expect({ track: live.currentVideoTrack, index: live.currentIndex,
      alternatives: [...live.alternatives], auto: live.isAutoQuality }).toEqual(before);
    live.unlockAuto();
    expect(live.peekHigherVideoQuality()).toBeNull();
  });
});
