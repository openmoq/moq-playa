/** Internal prepared media state, independent of catalog/session retrieval. */
import type { CatalogState, CatalogTrack } from '@openmoq/msf';
import { identityKey } from '@openmoq/msf';
import type { QualityController } from './quality-controller.js';
import type { HandoverIntent } from './player-handover-selection.js';
import type { TrackPackaging } from './subscription-manager.js';

export interface PreparedMediaSelection {
  /** Prepared media subscriptions by the candidate's OWN request id. Request
   *  ids and track aliases collide freely across sessions, so these are never
   *  mixed into the live registries until adoption. */
  readonly media: Map<bigint, PreparedSub>;
  /** Init tracks the selection requires, by resolved track identity. */
  readonly initTracks: Map<string, PreparedInit>;
  /** Required media that is still unanswered or uninitialized. Readiness is
   *  reached when this empties — and only with a non-empty required set. */
  readonly awaiting: Set<string>;
  /** Settled once every required track is accepted AND initialized. */
  readonly ready: Promise<void>;
  resolveReady(): void;
  rejectReady(err: Error): void;
  /** The selection adoption applies, decided from a snapshot of live intent. */
  selection: { readonly video: CatalogTrack | null; readonly audio: CatalogTrack | null } | null;
  /** Immutable preparation inputs, kept apart from the latest catalog feed. */
  snapshot?: {
    readonly catalog: CatalogState;
    readonly intent: HandoverIntent;
    readonly selection: NonNullable<PreparedMediaSelection['selection']>;
  };
  /** Candidate-owned selection policy state, adopted with its subscriptions. */
  controller?: QualityController;
  /** Retypes finished, so a later validation failure can undo them safely. */
  reconfigurationComplete?: boolean;
  /** Initialization the running source buffer was RETYPED to during
   *  preparation, by media type. Adoption hands the same bytes to the
   *  assembler so the two agree about what the buffer now holds. */
  readonly reconfigured: Map<'video' | 'audio', Uint8Array>;
  /** Required tracks still owing an IN-BAND initialization header, by resolved
   *  track identity. Emptied as each one actually delivers it. */
  readonly inbandInit: Map<string, 'video' | 'audio'>;
  /** In-band initialization the candidate delivered, by media type. */
  readonly inbandBytes: Map<'video' | 'audio', Uint8Array>;
}

/** One media subscription the candidate issued, and what came back. */
export interface PreparedSub {
  readonly trackName: string;
  /** The tuple this candidate request was ISSUED with. */
  readonly namespace: readonly string[];
  readonly mediaType: 'video' | 'audio';
  readonly packaging: TrackPackaging;
  /** Bound by the candidate's own SUBSCRIBE_OK; null while unanswered — which
   *  is exactly why it is not readiness yet. */
  alias: bigint | null;
  /** Stable terminal/routing owner, installed in the live registry only at adoption. */
  subscription?: {
    trackName: string;
    namespace: readonly string[];
    mediaType: 'video' | 'audio';
    trackAlias: bigint | null;
  };
}

/** One init track the candidate must hold before it can be adopted. */
export interface PreparedInit {
  /** Name and namespace of the init track, which is the REFERENCING track's
   *  namespace. Two media types may name their init track identically in
   *  different namespaces, and those are different tracks. */
  readonly name: string;
  readonly namespace: readonly string[];
  reqId: bigint | null;
  alias: bigint | null;
  bytes: Uint8Array | null;
}

export function createPreparedMediaSelection(): PreparedMediaSelection {
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  // Media readiness can reject while catalog readiness is still awaited.
  // Keep its rejection owned before either preparation stage starts.
  void ready.catch(() => { /* owned by whichever stage awaits it */ });
  return {
    media: new Map(), initTracks: new Map(), awaiting: new Set(), reconfigured: new Map(),
    inbandInit: new Map(), inbandBytes: new Map(),
    ready, resolveReady, rejectReady, selection: null,
  };
}

/** Readiness always describes answered requests and delivered initialization. */
export function checkPreparedMediaReady(prep: PreparedMediaSelection): void {
  if (prep.awaiting.size || !prep.media.size) return;
  for (const sub of prep.media.values()) if (sub.alias === null) return;
  prep.resolveReady();
}

export function acceptPreparedMedia(prep: PreparedMediaSelection, requestId: bigint, alias: bigint): boolean {
  const media = prep.media.get(requestId);
  if (media) {
    media.alias = alias;
    media.subscription ??= { trackName: media.trackName, namespace: media.namespace,
      mediaType: media.mediaType, trackAlias: alias };
    media.subscription.trackAlias = alias;
    prep.awaiting.delete(identityKey(media.namespace, media.trackName));
    checkPreparedMediaReady(prep);
    return true;
  }
  for (const init of prep.initTracks.values()) if (init.reqId === requestId) {
    init.alias = alias;
    return true;
  }
  return false;
}
