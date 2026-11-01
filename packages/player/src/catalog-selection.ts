/**
 * Catalog selection model — what a catalog offers, and which of it an intent
 * chooses. Pure: no subscriptions, no mutation, no ABR, no player.
 *
 * Vocabulary is the catalog's. Render groups, alternate groups, track
 * identity, `lang` and `label` are declared by the formats; "program", "view"
 * and "language" are application presentations of them. The fields do not
 * mean what a UI would assume: msf-01 §5.6.15 separates entitlement tiers by
 * render group, cf01 §3.4.2 uses an alternate group for a bitrate ladder.
 *
 * The one rule everything here follows: tracks are laddered only where the
 * catalog DECLARED them alternates. Which grouping carries the timing
 * requirement differs by format, and only the alternate group carries it in
 * all three:
 *
 *   msf-00 §4.2  common RENDER group MUST be time-aligned; equally numbered
 *                groups' first objects MUST overlap in presentation time.
 *                §5.1.19 alternate groups MUST have matching media time
 *                sequences.
 *   msf-01 §4.2  the common-group requirement moved to the ALTERNATE group
 *                (MUST); the equal-numbered overlap became SHOULD. §5.2.11
 *                asks only that a render group be rendered simultaneously.
 *   cf01  §3.2.14 alternate groups SHOULD match framerate and media time
 *                sequences; §3.2.13 calls a render group "usually"
 *                time-aligned, and gives no equal-numbered guarantee.
 *
 * So a render group may not be treated as interchangeable anywhere, and an
 * equal group number is never by itself evidence of alignment. A track that
 * declares no group is UNSPECIFIED association, not a declaration that it is
 * unrelated to everything else.
 *
 * Neither format defines a default or autoselect flag, so every default here
 * is this player's policy and is documented where it is applied.
 *
 * @see draft-ietf-moq-msf-01 §4.2, §5.2.2, §5.2.3, §5.2.11, §5.2.12
 * @see draft-ietf-moq-msf-00 §4.2, §5.1.19
 * @see draft-ietf-moq-catalogformat-01 §3.2.13, §3.2.14, §3.2.31
 */

import type { CatalogNamespaceContext, CatalogState, CatalogTrack } from '@openmoq/msf';
import {
  assertUtf8EncodableIdentity, groupByAlt, groupByRender, identityKey, isTrackPackagingSupported,
  namespaceDisplay, namespaceFieldsOf, sameNamespaceFields, contextFields,
} from '@openmoq/msf';

/**
 * A track's identity.
 *
 * A name alone does not identify a track: msf-01 §5.2.3 makes names unique
 * only "per namespace", and §5.2.2 lets a track override the namespace it
 * inherits from the catalog. Two tracks may therefore share a name and be
 * different tracks.
 */
export interface TrackIdentity {
  /**
   * Resolved wire namespace fields (transport §2.4.1), compared by exact
   * content and order. Fields rather than text because a joined string
   * cannot distinguish one field containing a separator from two fields.
   */
  readonly namespaceFields: readonly string[];
  readonly name: string;
}

/** A track the catalog offers, with the metadata an application names it by. */
export interface SelectableTrack {
  readonly id: TrackIdentity;
  readonly mediaType: 'video' | 'audio';
  /**
   * Position in the catalog's own track list.
   *
   * Carried because catalog order is the only ordering a publisher actually
   * expressed, and this model's defaults follow it. Scope and set ordering
   * cannot stand in for it: a scope is ordered by its first track of ANY
   * type, so the first scope offering video need not hold the first video.
   */
  readonly catalogIndex: number;
  /** §5.2.x `label` — human-readable, carried verbatim when present. */
  readonly label?: string;
  /** §5.2.x / cf01 §3.2.31 `lang` — a language TAG, carried verbatim. Matching
   *  is RFC 4647 lookup and is deliberately NOT done here. */
  readonly lang?: string;
  /** The catalog's own track object, unmodified. */
  readonly track: CatalogTrack;
}

/**
 * Tracks the catalog declared as alternates of one another, or a single track
 * that declared none.
 *
 * A singleton is selected by its member's identity and is never given a
 * fabricated group number: a number would claim a declaration the catalog did
 * not make, and would collide with the next singleton.
 */
export interface AlternateSet {
  readonly id: AlternateSetId;
  readonly tracks: readonly SelectableTrack[];
}

/**
 * Which set this is.
 *
 * Discriminated rather than a nullable number because zero is a valid group
 * number in both formats, so no numeric value is free to mean "none".
 */
export type AlternateSetId =
  | { readonly kind: 'declared'; readonly altGroup: number }
  | { readonly kind: 'singleton' };

/**
 * One self-sufficient selection scope: a declared render group, or the pool of
 * tracks that declared none.
 *
 * Scopes exist so that choosing a video cannot silently drag in audio the
 * publisher never said accompanies it.
 */
export interface SelectionScope {
  readonly id: ScopeId;
  readonly video: readonly AlternateSet[];
  readonly audio: readonly AlternateSet[];
}

/**
 * Which scope this is — a declared render group, or the pool of tracks that
 * declared none. Discriminated for the same reason as {@link AlternateSetId}:
 * render group zero is valid and must not collide with "unassigned".
 */
export type ScopeId =
  | { readonly kind: 'render-group'; readonly renderGroup: number }
  | { readonly kind: 'unassigned' };

/**
 * A track the model did not offer, and why. Nothing is dropped silently.
 *
 * `mediaType` and `renderGroup` are carried so a caller can tell a genuine
 * absence ("this scope declares no audio") from an exclusion ("it declares
 * audio this build cannot play"). Without them `audio === null` means both,
 * and a caller cannot know whether degrading is acceptable.
 */
export interface ExcludedTrack {
  readonly id: TrackIdentity;
  readonly reason: 'unsupported-packaging' | 'no-media-role';
  /** Declared role, when the track declared one. */
  readonly mediaType?: 'video' | 'audio';
  /** Declared render group; absent when the track declared none. */
  readonly renderGroup?: number;
}

/** What a catalog offers. */
export interface CatalogSelection {
  /** Declared render groups in catalog order, then the unassigned pool. */
  readonly scopes: readonly SelectionScope[];
  readonly excluded: readonly ExcludedTrack[];
}

/**
 * An explicit choice. Every field omitted means "apply the documented default".
 *
 * Deliberately absent: any way to pair a video in a declared render group with
 * audio from the unassigned pool. A track with no render group is not declared
 * to accompany anything, so such a pairing is a guess — and that guess is how a
 * match camera ends up playing the commentary booth's audio. A caller policy
 * describing a deliberate combination can be added later, as an explicit
 * request rather than a default.
 */
export interface SelectionIntent {
  /** A declared render group, or the unassigned pool. */
  readonly scope?: ScopeId;
  /** A DECLARED video alternate group. A singleton has no group number and is
   *  selected with {@link SelectionIntent.videoTrack} instead. */
  readonly videoAltGroup?: number;
  /**
   * An explicit choice of video track — a decision about WHICH track plays,
   * which a composed selection turns into manual quality mode.
   *
   * Distinct from a member an automatic selection happened to settle on: a
   * controller carrying that member across an evaluation has not been told
   * which track to play, and must not be treated as pinned.
   */
  readonly videoTrack?: TrackIdentity;
  /** A DECLARED audio alternate group — in practice how a catalog offers the
   *  same audio in several languages (issue #24's `audio_match_en`/`_es`). */
  readonly audioAltGroup?: number;
  readonly audioTrack?: TrackIdentity;
  readonly disableVideo?: boolean;
  readonly disableAudio?: boolean;
}

/** One side of a resolved selection. */
export interface ResolvedMedia {
  /** The set to play from. ABR, if any, stays inside it. */
  readonly set: AlternateSet;
  /** The member this intent selects — the default is catalog order. */
  readonly track: SelectableTrack;
}

export type SelectionOutcome =
  | {
      readonly ok: true;
      readonly scope: SelectionScope;
      /** `null` when video is disabled or the scope offers none. */
      readonly video: ResolvedMedia | null;
      /** `null` when audio is disabled or this scope declares none —
       *  video-only is a legitimate outcome, not a failure (msf-01 §5.6.15
       *  declares audio in render group 1 only). */
      readonly audio: ResolvedMedia | null;
    }
  | { readonly ok: false; readonly reason: string };

export function sameScope(a: ScopeId, b: ScopeId): boolean {
  if (a.kind === 'render-group' && b.kind === 'render-group') return a.renderGroup === b.renderGroup;
  return a.kind === b.kind;
}

/** Human-readable scope, for failure reasons. */
function describeScope(id: ScopeId): string {
  return id.kind === 'render-group'
    ? `render group ${id.renderGroup}`
    : 'the tracks with no declared render group';
}

/**
 * Stable, injective key for identity comparison and map keys. Delegates to
 * the catalog package so parser, delta and model agree on what makes two
 * tracks the same.
 */
export function trackIdentityKey(id: TrackIdentity): string {
  return identityKey(id.namespaceFields, id.name);
}

export function sameTrackIdentity(a: TrackIdentity, b: TrackIdentity): boolean {
  return a.name === b.name && sameNamespaceFields(a.namespaceFields, b.namespaceFields);
}

/** Display form of an identity's namespace. Presentation only, never compared. */
export function identityNamespaceDisplay(id: TrackIdentity): string {
  return namespaceDisplay(id.namespaceFields);
}

/**
 * Resolve a track's identity to wire fields.
 *
 * Prefers the resolution the parser recorded, which is the only thing that
 * can tell an inherited one-field namespace from declared text that happens
 * to print the same. Falls back to the supplied context for tracks that
 * carry no resolution — an injected catalog, or a parse without context.
 */
function identityOf(
  track: CatalogTrack, contextFieldsValue: readonly string[] | undefined,
): TrackIdentity {
  const namespaceFields = namespaceFieldsOf(track) ?? contextFieldsValue;
  // No context and no declared namespace means the track's wire identity is
  // genuinely unknown. Substituting zero fields would fabricate a real
  // namespace — the one a publisher declares as the empty tuple — and this
  // model's identity is required, so the honest outcome is to say what is
  // missing. A fully explicit catalog needs no context at all.
  if (namespaceFields === undefined) {
    throw new Error(
      `Track "${track.name}" declares no namespace and no catalog namespace context was ` +
      `supplied, so its namespace cannot be resolved (msf-01 §5.2.2). Pass the namespace ` +
      `the catalog was retrieved under as catalogNamespace.`,
    );
  }
  // The identity is constructed here, and this model compares identities field
  // by field without ever taking a key, so this is where the byte contract is
  // enforced for a track handed straight to the model. Validated AFTER
  // resolution, so it checks the fields the identity actually carries —
  // whether they came from the track or from the supplied context.
  assertUtf8EncodableIdentity(namespaceFields, track.name);
  return { namespaceFields, name: track.name };
}

function mediaRoleOf(track: CatalogTrack): 'video' | 'audio' | null {
  if (track.role === 'video') return 'video';
  if (track.role === 'audio') return 'audio';
  return null;
}

function toSelectable(
  track: CatalogTrack, mediaType: 'video' | 'audio',
  contextFieldsValue: readonly string[] | undefined, catalogIndex: number,
): SelectableTrack {
  return {
    id: identityOf(track, contextFieldsValue),
    mediaType,
    catalogIndex,
    ...(track.label !== undefined ? { label: track.label } : {}),
    ...(track.lang !== undefined ? { lang: track.lang } : {}),
    track,
  };
}

/**
 * Build the alternate sets of one media type, in catalog order.
 *
 * Declared groups come from the catalog; everything else becomes a set of one.
 * Order follows first appearance so a default is reproducible.
 */
function alternateSets(
  tracks: readonly SelectableTrack[],
): AlternateSet[] {
  const { groups, ungrouped } = groupByAlt(tracks.map(t => t.track));
  const byTrack = new Map<CatalogTrack, SelectableTrack>(tracks.map(t => [t.track, t]));
  const sets: Array<{ firstIndex: number; set: AlternateSet }> = [];
  const indexOf = (track: CatalogTrack): number => tracks.findIndex(t => t.track === track);

  for (const group of groups) {
    const members = group.tracks.map(t => byTrack.get(t)!).filter(Boolean);
    if (members.length === 0) continue;
    sets.push({
      firstIndex: Math.min(...group.tracks.map(indexOf)),
      set: { id: { kind: 'declared', altGroup: group.altGroup }, tracks: members },
    });
  }
  for (const track of ungrouped) {
    const member = byTrack.get(track);
    if (!member) continue;
    sets.push({ firstIndex: indexOf(track), set: { id: { kind: 'singleton' }, tracks: [member] } });
  }
  return sets.sort((a, b) => a.firstIndex - b.firstIndex).map(entry => entry.set);
}

/**
 * Build the selection model for a catalog.
 *
 * `catalogNamespace` is the namespace the catalog itself arrived under, which
 * §5.2.2 makes the inherited namespace of any track that declares none. It is
 * a parameter because a parsed catalog does not carry it.
 *
 * Excluded, and reported in `excluded` rather than dropped silently: tracks
 * with no media role, and tracks whose PACKAGING this build cannot handle
 * (LOCMAF §5 forbids subscribing to a locmafVersion we do not support). That
 * check is about packaging only — it says nothing about whether a decoder
 * exists for the codec, which is decided later and elsewhere. A set left
 * empty by exclusion disappears rather than gaining a substitute.
 */
export function buildCatalogSelection(
  catalog: CatalogState,
  options: { readonly catalogNamespace: CatalogNamespaceContext },
): CatalogSelection {
  const contextFieldsValue = contextFields(options.catalogNamespace);
  const excluded: ExcludedTrack[] = [];
  const selectable: SelectableTrack[] = [];

  for (const [catalogIndex, track] of catalog.tracks.entries()) {
    const mediaType = mediaRoleOf(track);
    const where = track.renderGroup !== undefined ? { renderGroup: track.renderGroup } : {};
    if (mediaType === null) {
      excluded.push({ id: identityOf(track, contextFieldsValue), reason: 'no-media-role', ...where });
      continue;
    }
    if (!isTrackPackagingSupported(track)) {
      excluded.push({
        id: identityOf(track, contextFieldsValue), reason: 'unsupported-packaging', mediaType, ...where,
      });
      continue;
    }
    selectable.push(toSelectable(track, mediaType, contextFieldsValue, catalogIndex));
  }

  const byTrack = new Map<CatalogTrack, SelectableTrack>(selectable.map(t => [t.track, t]));
  // `groupByRender` reads a catalog's tracks; the catalog is copied with the
  // playable subset rather than mutated, since this model owns nothing.
  const { groups, ungrouped } = groupByRender({ ...catalog, tracks: selectable.map(t => t.track) });
  const scopeOf = (id: ScopeId, members: readonly SelectableTrack[]): SelectionScope => ({
    id,
    video: alternateSets(members.filter(t => t.mediaType === 'video')),
    audio: alternateSets(members.filter(t => t.mediaType === 'audio')),
  });

  // A catalog that declares no render group at all has nothing to violate:
  // its tracks form one pool and may accompany one another. Once ANY render
  // group is declared, the undeclared tracks are their own pool and are not
  // copied into the declared ones.
  if (groups.length === 0) {
    return { scopes: [scopeOf({ kind: 'unassigned' }, selectable)], excluded };
  }

  const scopes: SelectionScope[] = groups.map(group => scopeOf(
    { kind: 'render-group', renderGroup: group.renderGroup },
    group.tracks.map(t => byTrack.get(t)!).filter(Boolean),
  ));
  if (ungrouped.length > 0) {
    scopes.push(scopeOf({ kind: 'unassigned' }, ungrouped.map(t => byTrack.get(t)!).filter(Boolean)));
  }
  return { scopes, excluded };
}

function findSetContaining(
  sets: readonly AlternateSet[], id: TrackIdentity,
): ResolvedMedia | null {
  for (const set of sets) {
    const track = set.tracks.find(t => sameTrackIdentity(t.id, id));
    if (track) return { set, track };
  }
  return null;
}

function defaultFrom(sets: readonly AlternateSet[]): ResolvedMedia | null {
  const set = sets[0];
  if (!set || set.tracks.length === 0) return null;
  return { set, track: set.tracks[0]! };
}

/**
 * Apply an intent to a built model.
 *
 * Failure is returned, never thrown, and never silently substituted: an intent
 * naming a render group, alternate group or track the catalog does not offer
 * fails, so that a catalog update which removed the selection cannot quietly
 * start playing something else.
 *
 * Defaults, all of them this player's policy rather than anything the formats
 * state: the scope is the one holding the first playable video track in
 * catalog order (the first audio track when video is disabled or absent),
 * the set is the first of that scope in catalog order, and the member is the
 * first of that set. Catalog order is used because it is the only ordering the
 * publisher actually expressed.
 */
export function resolveSelection(
  selection: CatalogSelection,
  intent: SelectionIntent = {},
): SelectionOutcome {
  const wantVideo = intent.disableVideo !== true;
  const wantAudio = intent.disableAudio !== true;
  // A selector for a disabled media type is ignored outright, in scope choice
  // as well as in member choice. Letting one steer the scope would answer a
  // question the caller withdrew — a disabled `videoTrack` could pull audio
  // into a scope that has no audio and return a selection of nothing.
  const videoTrack = wantVideo ? intent.videoTrack : undefined;
  const videoAltGroup = wantVideo ? intent.videoAltGroup : undefined;
  const audioTrack = wantAudio ? intent.audioTrack : undefined;
  const audioAltGroup = wantAudio ? intent.audioAltGroup : undefined;
  const constrained = videoTrack !== undefined || videoAltGroup !== undefined
    || audioTrack !== undefined || audioAltGroup !== undefined;

  // ── Scope ────────────────────────────────────────────────────────────
  // Explicit constraints are resolved BEFORE any default, because a default
  // chosen first can exclude the very scope the caller named: asking for
  // video alternate group 1 would fail against whichever scope happened to
  // come first, even though another scope declares exactly that group.
  let scope: SelectionScope | undefined;
  if (intent.scope !== undefined) {
    scope = selection.scopes.find(s => sameScope(s.id, intent.scope!));
    if (!scope) return { ok: false, reason: `catalog offers no ${describeScope(intent.scope)}` };
    const unmet = unmetConstraint(scope, { videoTrack, videoAltGroup, audioTrack, audioAltGroup });
    if (unmet !== null) return { ok: false, reason: `${describeScope(scope.id)} ${unmet}` };
  } else if (constrained) {
    const satisfying = selection.scopes.filter(
      s => unmetConstraint(s, { videoTrack, videoAltGroup, audioTrack, audioAltGroup }) === null);
    if (satisfying.length === 0) {
      // Report the FIRST scope with an unmet constraint, in scope order, so
      // the reason names a constraint rather than the absence of a scope.
      // Deliberately not a ranking: "closest" would be a judgement the model
      // has no basis to make.
      const reasons = selection.scopes
        .map(s => ({ scope: s, unmet: unmetConstraint(s, { videoTrack, videoAltGroup, audioTrack, audioAltGroup }) }))
        .filter(entry => entry.unmet !== null);
      const first = reasons[0];
      return first !== undefined
        ? { ok: false, reason: `${describeScope(first.scope.id)} ${first.unmet!}` }
        : { ok: false, reason: 'catalog offers no scope satisfying this selection' };
    }
    if (satisfying.length > 1) {
      // Genuinely ambiguous — two scopes answer the same selector. Choosing
      // one would be a guess about which presentation the caller meant.
      return {
        ok: false,
        reason: `selection matches ${satisfying.length} scopes; name one explicitly`,
      };
    }
    scope = satisfying[0]!;
  } else {
    // Default: the scope holding the first playable video in CATALOG order,
    // falling back to the first audio. Scope order is a presentation order and
    // follows whichever track of any type appeared first, so it cannot stand
    // in for media order here.
    scope = (wantVideo ? scopeOfFirst(selection, 'video') : undefined)
      ?? (wantAudio ? scopeOfFirst(selection, 'audio') : undefined);
    if (!scope) return { ok: false, reason: 'catalog offers no playable media' };
  }

  // ── Members ──────────────────────────────────────────────────────────
  let video: ResolvedMedia | null = null;
  if (wantVideo) {
    const picked = pickMember(scope.video, videoTrack, videoAltGroup);
    if (!picked.ok) return { ok: false, reason: `${describeScope(scope.id)} ${picked.reason}` };
    video = picked.media;
  }

  let audio: ResolvedMedia | null = null;
  if (wantAudio) {
    // Only this scope's own audio. A scope that declares none yields none:
    // reaching into another scope would pair tracks the catalog never said
    // belong together, which is how a match camera ends up playing the
    // commentary booth's audio.
    const picked = pickMember(scope.audio, audioTrack, audioAltGroup);
    if (!picked.ok) return { ok: false, reason: `${describeScope(scope.id)} ${picked.reason}` };
    audio = picked.media;
  }

  return { ok: true, scope, video, audio };
}

/** The scope holding the first track of `mediaType` in catalog order. */
function scopeOfFirst(
  selection: CatalogSelection, mediaType: 'video' | 'audio',
): SelectionScope | undefined {
  let best: { index: number; scope: SelectionScope } | undefined;
  for (const scope of selection.scopes) {
    for (const set of mediaType === 'video' ? scope.video : scope.audio) {
      for (const track of set.tracks) {
        if (best === undefined || track.catalogIndex < best.index) {
          best = { index: track.catalogIndex, scope };
        }
      }
    }
  }
  return best?.scope;
}

/** Why `scope` cannot satisfy these selectors, or null if it can. */
function unmetConstraint(
  scope: SelectionScope,
  selectors: {
    videoTrack?: TrackIdentity | undefined; videoAltGroup?: number | undefined;
    audioTrack?: TrackIdentity | undefined; audioAltGroup?: number | undefined;
  },
): string | null {
  const video = pickMember(scope.video, selectors.videoTrack, selectors.videoAltGroup);
  if (!video.ok) return video.reason;
  const audio = pickMember(scope.audio, selectors.audioTrack, selectors.audioAltGroup);
  if (!audio.ok) return audio.reason;
  return null;
}

type MemberPick =
  | { readonly ok: true; readonly media: ResolvedMedia | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Apply one media type's selectors within a scope.
 *
 * Both selectors are honored together rather than by precedence: a track
 * identity and an alternate group that agree both hold, and ones that
 * disagree fail. Treating the identity as a winner would silently play a
 * track from a group the caller explicitly ruled out.
 */
function pickMember(
  sets: readonly AlternateSet[],
  wantTrack: TrackIdentity | undefined,
  wantAltGroup: number | undefined,
): MemberPick {
  if (wantTrack !== undefined) {
    const found = findSetContaining(sets, wantTrack);
    if (!found) return { ok: false, reason: `offers no track "${wantTrack.name}"` };
    if (wantAltGroup !== undefined
        && !(found.set.id.kind === 'declared' && found.set.id.altGroup === wantAltGroup)) {
      return {
        ok: false,
        reason: `track "${wantTrack.name}" is not in alternate group ${wantAltGroup}`,
      };
    }
    return { ok: true, media: found };
  }
  if (wantAltGroup !== undefined) {
    const set = sets.find(s => s.id.kind === 'declared' && s.id.altGroup === wantAltGroup);
    if (!set || set.tracks.length === 0) {
      return { ok: false, reason: `declares no alternate group ${wantAltGroup}` };
    }
    return { ok: true, media: { set, track: set.tracks[0]! } };
  }
  return { ok: true, media: defaultFrom(sets) };
}
