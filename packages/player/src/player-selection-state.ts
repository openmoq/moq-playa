import type { ScopeId, TrackIdentity } from './catalog-selection.js';

export interface AudioSelectionOptions {
  readonly timeline?:
    | { readonly kind: 'reference-map'; readonly referenceToken: object;
        readonly sourceTimeUs: bigint; readonly referenceTimeUs: bigint }
    | { readonly kind: 'live-resync' };
}

/** Raw presentation domain of the currently adopted audio, normalized to microseconds. */
export interface AudioTimelineReference {
  /** Identity witness; retain this object, never serialize or reconstruct it. */
  readonly token: object;
  readonly track: TrackIdentity;
  readonly domain: 'wall-clock' | 'media-time' | 'unknown';
  /** Source metadata, not an output playhead or evidence of presentation. */
  readonly observedSourceTimeUs: bigint;
}

/** Accepted/adopted outputs. These identities survive finite track completion. */
export interface MediaSelectionSnapshot {
  readonly revision: number;
  readonly scope: ScopeId | null;
  readonly video: TrackIdentity | null;
  readonly audio: TrackIdentity | null;
  readonly videoAlternatives: readonly TrackIdentity[];
  readonly audioChoices: readonly TrackIdentity[];
  readonly autoQuality: boolean;
}

/** Copy every nested identity so callers cannot mutate engine selection state. */
export function copyMediaSelection(selection: MediaSelectionSnapshot): MediaSelectionSnapshot {
  const identity = (value: TrackIdentity): TrackIdentity => Object.freeze({
    name: value.name, namespaceFields: Object.freeze([...value.namespaceFields]),
  });
  return Object.freeze({
    ...selection,
    scope: selection.scope === null ? null : Object.freeze({ ...selection.scope }),
    video: selection.video === null ? null : identity(selection.video),
    audio: selection.audio === null ? null : identity(selection.audio),
    videoAlternatives: Object.freeze(selection.videoAlternatives.map(identity)),
    audioChoices: Object.freeze(selection.audioChoices.map(identity)),
  });
}

export function emptyMediaSelection(revision = 0, autoQuality = true): MediaSelectionSnapshot {
  return copyMediaSelection({ revision, scope: null, video: null, audio: null,
    videoAlternatives: [], audioChoices: [], autoQuality });
}
