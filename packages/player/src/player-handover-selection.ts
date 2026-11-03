import type { CatalogNamespaceContext, CatalogState, CatalogTrack, TrackConstraints } from '@openmoq/msf';
import { selectTrack } from '@openmoq/msf';
import type { SelectionIntent, TrackIdentity } from './catalog-selection.js';
import { buildCatalogSelection, sameScope, sameTrackIdentity } from './catalog-selection.js';
import { composeSelection } from './selection-composition.js';
import type { ClockSource } from '@openmoq/playback';
import { QualityController, type QualityControllerConfig } from './quality-controller.js';

/** Selection intent captured without retaining either live ABR controller. */
export interface HandoverIntent {
  readonly autoQuality: boolean;
  readonly startLevel: QualityControllerConfig['startLevel'];
  readonly capLevelToResolution?: QualityControllerConfig['capLevelToResolution'];
  readonly qualitySwitchCooldownMs: number;
  /** Index in the complete quality ladder, not its codec-family subset. */
  readonly manualLevel: number | null;
  /** The namespace the REPLACEMENT catalog was retrieved under, so a track
   *  that declares none resolves to the identity it will be requested as. */
  readonly catalogNamespace: CatalogNamespaceContext;
  /**
   * The established outputs, as full identities — namespace fields and name.
   * A bare name cannot carry a view across catalogs: §5.2.3 makes names
   * unique only per namespace, and a replacement may declare the same name
   * somewhere else entirely.
   */
  readonly activeVideoTrack: TrackIdentity | null;
  readonly activeAudioTrack: TrackIdentity | null;
  /** Captured members of the established set. Fallback requires identity
   * overlap with the replacement set; a reused group number is insufficient.
   * Omission retains legacy behavior for callers without a captured set. */
  readonly videoAlternates?: readonly TrackIdentity[];
  /** As {@link videoAlternates}, for the established audio set. */
  readonly audioAlternates?: readonly TrackIdentity[];
  /**
   * Whether the established video is an EXPLICIT choice — a configured pin or
   * a manual selection — rather than a member automatic quality settled on.
   *
   * The distinction decides what losing it means. An automatic member may be
   * replaced by another member of the same established set; a pin may not be
   * replaced at all, because the viewer asked for that track and a quality
   * substitute would be a different presentation wearing its slot.
   */
  readonly pinnedVideo: boolean;
  /** As {@link pinnedVideo}, for audio. */
  readonly pinnedAudio: boolean;
  readonly disableVideo: boolean;
  readonly disableAudio: boolean;
  /** null preserves an ungrouped view; omission permits default selection. */
  readonly videoAltGroup?: number | null;
  /** Captured declared audio alternate set, when one was selected. */
  readonly audioAltGroup?: number;
  /**
   * The RENDER GROUP the established presentation belongs to — a declared
   * number, or `null` for the tracks that declare none.
   *
   * A render group is what says which audio accompanies which video
   * (msf-01 §5.6.15), so a replacement that keeps the video but moves its
   * audio to another group is a different presentation, not a substitution.
   * Omitted when no scope was established or selected.
   */
  readonly scope?: number | null;
  /** Startup preferences; an eligible active video track remains preferred. */
  readonly videoConstraints?: TrackConstraints;
  readonly audioConstraints?: TrackConstraints;
  /** Ordered preferences; surviving eligible audio and explicit pins take precedence. */
  readonly audioLanguages?: readonly string[];
}

export type HandoverSelection =
  | { readonly ok: true; readonly video: CatalogTrack | null; readonly audio: CatalogTrack | null }
  | { readonly ok: false; readonly reason: string };

/** Select required tracks without changing live selection or ABR state. */
export function selectHandoverTracks(
  catalog: CatalogState, intent: HandoverIntent, clock: ClockSource,
): HandoverSelection {
  const prepared = prepareHandoverSelection(catalog, intent, clock);
  return prepared.ok ? { ok: true, video: prepared.video, audio: prepared.audio } : prepared;
}

/** Prepare the controller that must travel with the selected subscriptions. */
export function prepareHandoverSelection(
  catalog: CatalogState, intent: HandoverIntent, clock: ClockSource,
): (Extract<HandoverSelection, { ok: true }> & { readonly controller: QualityController })
  | Extract<HandoverSelection, { ok: false }> {
  const controller = new QualityController({
    autoQuality: intent.autoQuality,
    startLevel: !intent.autoQuality && intent.manualLevel !== null
      ? intent.manualLevel : intent.startLevel,
    ...(intent.capLevelToResolution ? { capLevelToResolution: intent.capLevelToResolution } : {}),
    qualitySwitchCooldownMs: intent.qualitySwitchCooldownMs,
    clock,
  });
  if (intent.disableVideo && intent.disableAudio) {
    return { ok: true, video: null, audio: null, controller };
  }
  const model = buildCatalogSelection(catalog, { catalogNamespace: intent.catalogNamespace });
  const findActive = (role: 'video' | 'audio', id: TrackIdentity | null) =>
    model.scopes.flatMap(scope => scope[role].flatMap(set =>
      set.tracks.map(track => ({ scope, set, track }))))
      .find(entry => id !== null && sameTrackIdentity(entry.track.id, id));
  const activeVideo = intent.disableVideo ? undefined : findActive('video', intent.activeVideoTrack);
  const activeAudio = intent.disableAudio ? undefined : findActive('audio', intent.activeAudioTrack);
  const scope = intent.scope !== undefined
    ? intent.scope === null ? { kind: 'unassigned' as const }
      : { kind: 'render-group' as const, renderGroup: intent.scope }
    : (activeVideo ?? activeAudio)?.scope.id;
  const videoAltGroup = intent.videoAltGroup !== undefined ? intent.videoAltGroup
    : activeVideo?.set.id.kind === 'declared' ? activeVideo.set.id.altGroup : undefined;
  const audioAltGroup = intent.audioAltGroup
    ?? (activeAudio?.set.id.kind === 'declared' ? activeAudio.set.id.altGroup : undefined);

  // A singleton has no declared alternates. An established one must survive;
  // without an established output, an unambiguous singleton may be selected.
  let singleton: TrackIdentity | undefined;
  if (!intent.disableVideo && videoAltGroup === null) {
    const singletons = model.scopes.filter(s => scope === undefined || sameScope(s.id, scope))
      .flatMap(s => s.video.filter(set => set.id.kind === 'singleton').flatMap(set => set.tracks));
    singleton = activeVideo?.set.id.kind === 'singleton' ? activeVideo.track.id
      : intent.activeVideoTrack === null && singletons.length === 1 ? singletons[0]!.id : undefined;
    if (singleton === undefined) {
      return { ok: false, reason: intent.activeVideoTrack !== null
        ? `replacement does not offer the selected video track "${intent.activeVideoTrack.name}"`
        : 'replacement offers no unambiguous video singleton' };
    }
  }
  const selectors: SelectionIntent = {
    ...(scope !== undefined ? { scope } : {}),
    ...(typeof videoAltGroup === 'number' ? { videoAltGroup } : {}),
    ...(audioAltGroup !== undefined ? { audioAltGroup } : {}),
    ...(singleton !== undefined ? { videoTrack: singleton } : {}),
    // A surviving singleton has no alternate set to fall back within.
    ...(!intent.disableVideo && videoAltGroup == null && activeVideo?.set.id.kind === 'singleton'
      ? { videoTrack: activeVideo.track.id } : {}),
    ...(!intent.disableVideo && intent.pinnedVideo && intent.activeVideoTrack !== null
      ? { videoTrack: intent.activeVideoTrack } : {}),
    ...(!intent.disableAudio && intent.pinnedAudio && intent.activeAudioTrack !== null
      ? { audioTrack: intent.activeAudioTrack } : {}),
    disableVideo: intent.disableVideo,
    disableAudio: intent.disableAudio,
  };
  const options = {
    catalogNamespace: intent.catalogNamespace,
    controller,
    ...(intent.videoConstraints !== undefined ? { videoConstraints: intent.videoConstraints } : {}),
    ...(intent.audioConstraints !== undefined ? { audioConstraints: intent.audioConstraints } : {}),
    ...(intent.audioLanguages !== undefined ? { audioLanguages: intent.audioLanguages } : {}),
  };
  let selected = composeSelection(catalog, { ...options, intent: selectors });
  if (!selected.ok) {
    return { ok: false, reason: typeof videoAltGroup === 'number' && !intent.disableVideo
      ? `replacement video altGroup ${videoAltGroup}: ${selected.reason}` : selected.reason };
  }

  // Continuity is a preference only among the composed candidates. Recompose
  // with surviving identities so caps, exact audio constraints and adoption
  // still belong to the shared policy, including cross-codec manual choices.
  const sameVideo = activeVideo !== undefined
    && controller.allAlternatives.includes(activeVideo.track.track) ? activeVideo.track : undefined;
  const sameAudio = activeAudio !== undefined && selected.audio.state === 'selected'
    && selected.audio.considered.some(t => sameTrackIdentity(t.id, activeAudio.track.id))
    && (audioAltGroup === undefined || (activeAudio.set.id.kind === 'declared'
      && activeAudio.set.id.altGroup === audioAltGroup))
    && (intent.audioConstraints === undefined
      || selectTrack([activeAudio.track.track], intent.audioConstraints) !== undefined)
    ? activeAudio.track : undefined;
  if (sameVideo !== undefined || sameAudio !== undefined) {
    selected = composeSelection(catalog, { ...options, intent: {
      ...selectors,
      ...(sameVideo !== undefined ? { videoTrack: sameVideo.id } : {}),
      ...(sameAudio !== undefined ? { audioTrack: sameAudio.id } : {}),
    } });
    if (!selected.ok) return selected;
  }

  // An established/requested output must survive. A declared but excluded or
  // unsatisfied output is also required; a genuinely absent output is not.
  for (const role of ['video', 'audio'] as const) {
    const outcome = selected[role];
    const established = role === 'video' ? intent.activeVideoTrack : intent.activeAudioTrack;
    const pinned = role === 'video' ? intent.pinnedVideo : intent.pinnedAudio;
    const captured = role === 'video' ? intent.videoAlternates : intent.audioAlternates;
    if (outcome.state === 'selected' && established !== null && captured !== undefined
        && !outcome.set.tracks.some(t => sameTrackIdentity(t.id, established))
        && !outcome.set.tracks.some(t => captured.some(id => sameTrackIdentity(t.id, id)))) {
      return { ok: false, reason: `replacement ${role} set retains no captured alternate identity` };
    }
    if (outcome.state !== 'selected' && outcome.state !== 'disabled'
        && (established !== null || pinned || outcome.state !== 'not-declared')) {
      return { ok: false, reason: `no eligible ${role} track in the replacement catalog` };
    }
  }
  // A surviving automatic member is continuity, not an explicit pin. The
  // composition's identity selector otherwise locks this controller manually.
  if (intent.autoQuality && (!intent.pinnedVideo || intent.disableVideo)) controller.unlockAuto();
  return {
    ok: true,
    controller,
    video: selected.video.state === 'selected' ? selected.video.track.track : null,
    audio: selected.audio.state === 'selected' ? selected.audio.track.track : null,
  };
}
