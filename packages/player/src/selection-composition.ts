/**
 * Composition of the catalog selection model with the quality controller.
 *
 * The division, and the whole point of the file: the MODEL decides which
 * tracks are eligible — which render scope, which declared alternate set,
 * which singleton — and the CONTROLLER decides which member of that set
 * plays and how quality moves within it. Member choice, the resolution cap
 * and quality ordering all belong to the controller; nothing here re-decides
 * them, so there is only ever one quality policy.
 *
 * Nothing here opens a subscription or touches a player. Every choice is
 * computed and validated BEFORE the controller is asked to adopt it, so a
 * rejected selection leaves the controller exactly as it was. The controller
 * passed in is the one mutated: a candidate session must bring its own.
 */

import type { CatalogNamespaceContext, CatalogState, CatalogTrack, TrackConstraints } from '@openmoq/msf';
import { selectTrack } from '@openmoq/msf';
import type { QualityController } from './quality-controller.js';
import { preferredLanguage } from './language-preference.js';
import {
  buildCatalogSelection,
  resolveSelection,
  type AlternateSet,
  type CatalogSelection,
  type ExcludedTrack,
  type SelectableTrack,
  type SelectionIntent,
  type SelectionScope,
} from './catalog-selection.js';

/** What happened to one output, in enough detail to act on. */
export type OutputOutcome =
  | {
      readonly state: 'selected';
      readonly track: SelectableTrack;
      /** The DECLARED set the track belongs to. Its members are alternates of
       *  one another by the catalog's own declaration, and are what a manual
       *  chooser may offer. A singleton set has exactly this one track. */
      readonly set: AlternateSet;
      /**
       * The members this selection may actually be switched between.
       *
       * Narrower than `set` wherever the player cannot move freely inside it:
       * for video it is the controller's codec-family-narrowed ladder, since
       * a cross-codec step needs a decoder reconfiguration rather than an ABR
       * step. Never wider than `set` — independent sets are not alternates of
       * one another, and listing them together would invent the very
       * relationship the catalog declined to declare.
       */
      readonly ladder: readonly SelectableTrack[];
      /** Everything weighed for this output in the chosen scope, in catalog
       *  order. For audio that spans the scope's sets, which is how an exact
       *  language constraint reaches a later one; it is NOT an alternate
       *  relationship. */
      readonly considered: readonly SelectableTrack[];
    }
  /** The caller disabled this output. */
  | { readonly state: 'disabled' }
  /** The chosen scope declares no track of this type. A video-only
   *  presentation is legitimate (msf-01 §5.6.15 declares audio in one render
   *  group only), so this is not by itself a failure. */
  | { readonly state: 'not-declared' }
  /** The scope DOES declare tracks of this type, but none survived to be
   *  offered — unsupported packaging, for instance. Distinct from
   *  `not-declared`, because here the publisher did intend this output and a
   *  caller may well want to fail rather than play without it. */
  | { readonly state: 'excluded'; readonly excluded: readonly ExcludedTrack[] }
  /** Tracks were available and a CONSTRAINT or the resolution cap matched
   *  none of them. Reported rather than substituted, and never widened to
   *  another scope. */
  | { readonly state: 'unsatisfied'; readonly reason: string };

export type ComposedSelection =
  | {
      readonly ok: true;
      readonly scope: SelectionScope;
      readonly video: OutputOutcome;
      readonly audio: OutputOutcome;
      /**
       * Whether this selection put the controller into manual mode, which an
       * explicit video pin does. A pin decides WHICH track plays, so
       * automatic quality must not immediately move off it; `unlockAuto()`
       * re-enables ABR when the viewer asks for it.
       */
      readonly manualVideo: boolean;
    }
  /** An explicit SELECTOR could not be satisfied. Never substituted: a caller
   *  who named a scope, a set or a track gets that or an error. */
  | { readonly ok: false; readonly reason: string };

export interface CompositionOptions {
  /** Startup-only video preference (`config.videoConstraints`). It picks the
   *  starting member inside the eligible ladder and is NOT a persistent
   *  restriction — that is `capLevelToResolution`, owned by the controller. */
  readonly videoConstraints?: TrackConstraints;
  /** Exact audio filtering (`config.audioConstraints`), applied before language preferences. */
  readonly audioConstraints?: TrackConstraints;
  /** Ordered basic language ranges. A pin wins; no match keeps the scope-local default. */
  readonly audioLanguages?: readonly string[];
}

/*
 * No resolution cap option: the cap is the controller's standing restriction
 * and binds every path that chooses or steps between members. A second cap
 * here could only agree with it or contradict it.
 */

/**
 * Resolve an intent against a catalog and choose the members to play.
 *
 * `controller` is mutated: its ladder, index and audio track become the
 * selection. Hand a candidate session its own controller.
 */
export function composeSelection(
  catalog: CatalogState,
  options: {
    readonly catalogNamespace: CatalogNamespaceContext;
    readonly intent?: SelectionIntent;
    readonly controller: QualityController;
  } & CompositionOptions,
): ComposedSelection {
  const selection = buildCatalogSelection(catalog, { catalogNamespace: options.catalogNamespace });
  return composeResolvedSelection(selection, options);
}

/** As {@link composeSelection}, for a model that is already built. */
export function composeResolvedSelection(
  selection: CatalogSelection,
  options: {
    readonly intent?: SelectionIntent;
    readonly controller: QualityController;
  } & CompositionOptions,
): ComposedSelection {
  const intent = options.intent ?? {};
  const { controller } = options;
  const resolved = resolveSelection(selection, intent);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const { scope } = resolved;
  const wantVideo = intent.disableVideo !== true;
  const wantAudio = intent.disableAudio !== true;
  // Validate even an unmatched lower-priority range before controller adoption.
  if (wantAudio && options.audioLanguages !== undefined) preferredLanguage([], options.audioLanguages);
  // A selector for a disabled output is ignored here exactly as the model
  // ignores it, so a stale pin cannot re-enter through the composition.
  const videoPinned = wantVideo && intent.videoTrack !== undefined;

  // ── Candidates ───────────────────────────────────────────────────────
  // Video: the chosen SET and nothing else, prepared by the controller so the
  // cap and the quality order have a single owner. The cap filters within the
  // set; it never reaches another one, because answering a bandwidth question
  // by changing which camera plays is not a quality decision.
  const videoSet = resolved.video?.set;
  const videoDeclared = videoSet?.tracks ?? [];
  const videoLadder = wantVideo
    ? controller.eligibleLadder(videoDeclared.map(t => t.track)) : [];

  // Audio: every audio track of the chosen scope, in catalog order, across
  // all its sets — an exact constraint must still find a language declared on
  // a later singleton or alternate set. The candidate list IS the scope, so
  // nothing can satisfy a constraint by leaving it. These are candidates, not
  // alternates of one another.
  const audioConsidered: SelectableTrack[] = wantAudio && resolved.audio !== null
    ? scope.audio.flatMap(set => [...set.tracks]).sort((a, b) => a.catalogIndex - b.catalogIndex)
    : [];
  // An explicit audio selector keeps its restriction: a constraint then
  // applies within that set only.
  const audioRestricted = intent.audioTrack !== undefined || intent.audioAltGroup !== undefined;
  const audioCandidates = audioRestricted
    ? (resolved.audio ? [...resolved.audio.set.tracks] : []) : audioConsidered;

  const byTrack = new Map<CatalogTrack, SelectableTrack>(
    [...videoDeclared, ...audioConsidered, ...audioCandidates].map(t => [t.track, t]));

  // ── Validate before anything is adopted ──────────────────────────────
  // An explicit request that cannot be met is an error, never a substitution,
  // and it must not leave the controller holding a half-applied selection.
  const videoPin = videoPinned && resolved.video ? resolved.video.track : undefined;
  if (videoPin !== undefined && !videoLadder.includes(videoPin.track)) {
    const cap = controller.resolutionCap;
    return {
      ok: false,
      reason: cap !== undefined
        ? `video track "${videoPin.id.name}" exceeds the ${cap.width}x${cap.height} resolution cap`
        : `video track "${videoPin.id.name}" is not eligible in the selected set`,
    };
  }
  const audioPin = wantAudio && intent.audioTrack !== undefined && resolved.audio
    ? resolved.audio.track : undefined;
  if (audioPin !== undefined && !audioCandidates.includes(audioPin)) {
    return { ok: false, reason: `audio track "${audioPin.id.name}" is not eligible in this scope` };
  }
  // An explicit audio identity or set that an exact constraint contradicts is
  // a conflict between two things the caller asked for, and is reported
  // instead of resolved by precedence. Satisfaction is tested with the same
  // shared matcher the controller uses, so there is one definition of an
  // exact constraint; this validates, it does not re-pick.
  if (wantAudio && audioRestricted && options.audioConstraints !== undefined) {
    const restricted = audioPin !== undefined
      ? [audioPin.track] : audioCandidates.map(t => t.track);
    if (selectTrack(restricted, options.audioConstraints) === undefined) {
      return {
        ok: false,
        reason: audioPin !== undefined
          ? 'the selected audio track does not satisfy the audio constraints'
          : 'the selected audio alternate group satisfies none of the audio constraints',
      };
    }
  }

  const preferredAudio = wantAudio && audioPin === undefined && options.audioLanguages !== undefined
    ? preferredLanguage(audioCandidates.map(member => member.track).filter(track => options.audioConstraints === undefined
      || selectTrack([track], options.audioConstraints) !== undefined), options.audioLanguages)
    : undefined;

  // ── Adopt ────────────────────────────────────────────────────────────
  const chosen = controller.selectEligibleMembers({
    videoLadder: videoLadder,
    audioCandidates: audioCandidates.map(t => t.track),
  }, {
    ...(options.videoConstraints !== undefined ? { videoConstraints: options.videoConstraints } : {}),
    ...(options.audioConstraints !== undefined ? { audioConstraints: options.audioConstraints } : {}),
    // An explicit identity pins the member outright; the start level and the
    // startup preference choose only when nothing was pinned.
    ...(videoPin !== undefined ? { videoPin: videoPin.track } : {}),
    ...(audioPin !== undefined ? { audioPin: audioPin.track }
      : preferredAudio !== undefined ? { audioPin: preferredAudio } : {}),
  });

  // A pin decides which track plays, so quality must not move off it until
  // the caller asks. Applied only on a selection that actually succeeded.
  const manualVideo = videoPinned && chosen.video !== undefined;
  if (manualVideo) controller.lockManual();

  const capped = controller.resolutionCap !== undefined
    && videoDeclared.length > 0 && videoLadder.length === 0;

  return {
    ok: true,
    scope,
    video: outcomeFor({
      want: wantVideo,
      chosen: chosen.video,
      byTrack,
      sets: scope.video,
      // What ABR may actually use is the controller's own narrowed ladder.
      ladder: controller.alternatives,
      considered: videoDeclared,
      declared: scope.video.length > 0,
      excludedFor: 'video',
      selection,
      scopeRef: scope,
      unsatisfiedReason: capped
        ? `no video within ${controller.resolutionCap!.width}x${controller.resolutionCap!.height} in the selected set`
        : 'no video satisfied the video constraints',
    }),
    audio: outcomeFor({
      want: wantAudio,
      chosen: chosen.audio,
      byTrack,
      sets: scope.audio,
      // Audio has no automatic switching here, so the declared set is the
      // whole of what this selection may move between.
      ladder: undefined,
      considered: audioConsidered,
      declared: scope.audio.length > 0,
      excludedFor: 'audio',
      selection,
      scopeRef: scope,
      unsatisfiedReason: 'no audio in this render scope satisfied the audio constraints',
    }),
    manualVideo,
  };
}

function outcomeFor(ctx: {
  want: boolean;
  chosen: CatalogTrack | undefined;
  byTrack: Map<CatalogTrack, SelectableTrack>;
  sets: readonly AlternateSet[];
  /** The switchable members, when narrower than the declared set. */
  ladder: readonly CatalogTrack[] | undefined;
  considered: readonly SelectableTrack[];
  declared: boolean;
  excludedFor: 'video' | 'audio';
  selection: CatalogSelection;
  scopeRef: SelectionScope;
  unsatisfiedReason: string;
}): OutputOutcome {
  if (!ctx.want) return { state: 'disabled' };
  const track = ctx.chosen !== undefined ? ctx.byTrack.get(ctx.chosen) : undefined;
  if (track !== undefined) {
    const set = ctx.sets.find(s => s.tracks.includes(track));
    // Every selected track came from one of these sets; if that stopped being
    // true the model and the composition would disagree about what was
    // offered, and inventing a set here would hide it.
    if (set === undefined) {
      throw new Error(`selected track "${track.id.name}" belongs to no offered set`);
    }
    const ladder = ctx.ladder === undefined
      ? set.tracks
      : ctx.ladder.map(t => ctx.byTrack.get(t)).filter((t): t is SelectableTrack => t !== undefined);
    return { state: 'selected', track, set, ladder, considered: ctx.considered };
  }
  if (ctx.declared) {
    // Declared, but a cap or a constraint matched nothing. Saying "not
    // declared" here would tell the caller the publisher offered no such
    // output, which is a different and wrong thing.
    return { state: 'unsatisfied', reason: ctx.unsatisfiedReason };
  }
  // Nothing of this type survived into the scope. Report exclusion when the
  // catalog DID declare such a track for this render group and the build
  // could not offer it — absence and exclusion call for different decisions.
  const excluded = ctx.selection.excluded.filter(e =>
    e.mediaType === ctx.excludedFor
    && (ctx.scopeRef.id.kind === 'render-group'
      ? e.renderGroup === ctx.scopeRef.id.renderGroup
      : e.renderGroup === undefined));
  if (excluded.length > 0) return { state: 'excluded', excluded };
  return { state: 'not-declared' };
}
