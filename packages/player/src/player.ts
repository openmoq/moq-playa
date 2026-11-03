/**
 * MoqtPlayer — convenience facade for MOQT playback.
 *
 * Thin orchestrator that wires together:
 * - MoqtConnection (connection + control stream)
 * - CatalogManager (catalog subscription lifecycle)
 * - QualityController (ABR track selection)
 * - SubscriptionManager (media object routing)
 * - PlaybackPipeline × N (sans-I/O decode pipeline)
 *
 * Exposes a simple load()/play()/pause()/destroy() API with
 * typed events and hook-based interception.
 *
 * @see draft-ietf-moq-transport-16 §3 (Session lifecycle)
 * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
 * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE for pause/resume)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-msf-00 §9.1 (Publisher MUST publish catalog before media)
 * @module
 */

import type { ControlMessage, Parameters, DraftVersion } from '@openmoq/transport';
import { varint, PublishDoneCode, PublishDoneCode18, RequestError, ObjectStatus } from '@openmoq/transport';
import { CatalogBootstrap } from './catalog-bootstrap.js';
import type { CatalogObjectEvent, PublishDoneReason } from './catalog-bootstrap.js';
import { MoqtConnectionError } from '@openmoq/webtransport';
import type { DataStreamTerminal, GoawayNotice, MoqtConnection, WebTransportLike, MoqtConnectionErrorSource } from '@openmoq/webtransport';
import type { DataStreamHeader, MoqtObject, ObjectDatagram, SubgroupHeader } from '@openmoq/transport';
import { getSubgroupIdMode, SubgroupIdMode } from '@openmoq/transport';
import { PlaybackPipeline, SyncController, BandwidthEstimator } from '@openmoq/playback';
import { BufferBasedController } from '@openmoq/playback';
import type { ClockSource, DecoderCommand, PlaybackEvent, RecoveryAction, RecoveryController, DecoderFeedback, PlaybackInputObserver } from '@openmoq/playback';
import type { AltGroup, CatalogState, CatalogTrack, ResolvedTrackNamespace } from '@openmoq/msf';
import type { SelectionIntent, TrackIdentity } from './catalog-selection.js';
import { buildCatalogSelection, resolveSelection } from './catalog-selection.js';
import { composeSelection } from './selection-composition.js';
import { selectionIntentFromConfig } from './configured-selection.js';
import type { LocHeaders } from '@openmoq/loc';
import { LocmafFormatError, LocmafTrackDecoder, deserializeLocmafObject, readVi64, sliceFrames, ticksToMicros, codecDescriptionFromInit, isCmafHeader, isSyncSampleFlags, readCmafChunkSamples, parseLocmafTrackContext, parseEmsgBoxes } from '@openmoq/locmaf';
import type { EmsgEvent, LocmafEffectiveSamples, GenBox, LocmafTrackContext } from '@openmoq/locmaf';
import { groupByAlt, parseSapTimeline, parseEventTimeline, CMSF_SAP_EVENT_TYPE, isTrackPackagingSupported,
  fieldsFromCatalogText, identityKey, namespaceFieldsOf, sameNamespaceFields } from '@openmoq/msf';

import { TypedEmitter } from './emitter.js';
import { HookChain } from './hooks.js';
import { WatchdogController } from './watchdog.js';
import { MediaLivenessMonitor, type LivenessTrack } from './media-liveness.js';
import { PlayerStateMachine, PlayerState, type PlayerStateValue } from './state.js';
import type { PlayerEventMap } from './events.js';
import type { PlayerConnectionObservation, PlayerDiagnosticConnection, PlayerDiagnosticSnapshot } from './diagnostics.js';
import {
  DEFAULT_PLAYER_CONFIG,
  validateConfig,
  type MoqtPlayerConfig,
} from './config.js';
import { createPlayerError, PlayerErrorCode, type PlayerError, type ErrorSeverity, type PlayerErrorCodeValue } from './errors.js';
import { createLogger, LOG_LEVELS, type LoggerLike } from './logger.js';
import { checkSupport as detectSupport } from './support.js';
import type { SupportReport } from './support.js';
import { CatalogManager } from './catalog-manager.js';
import { QualityController } from './quality-controller.js';
import { prepareHandoverSelection, type HandoverIntent } from './player-handover-selection.js';
import { MediaStageObservers } from './media-stage-observers.js';
import type { MediaDiagnosticRuntime, MediaDiagnosticsFactory, MediaStageObserver, MediaDiscardReason } from './media-diagnostic-types.js';
import type { ObjectRoutingContext, ObjectRoutingDiscardReason, ObjectDeliveryAdmission, ObjectDeliveryOptions } from './subscription-manager.js';
import { SubscriptionManager, type TrackPackaging } from './subscription-manager.js';
import { WarmStartHead } from './warm-start-head.js';

interface WarmMediaRoute {
  readonly permit: (admission: ObjectDeliveryAdmission) => void;
  readonly work: Promise<void>;
  readonly isLive: () => boolean;
}

interface WarmMediaOwner {
  readonly connection: MoqtConnection;
  readonly requestId: bigint;
  readonly subscription: { trackAlias: bigint | null };
  registration: (() => boolean) | null;
  head: WarmStartHead<WarmMediaRoute> | null;
  prefixFetch: MediaFetchInfo | null;
}

interface MediaFetchInfo {
  readonly requestId: bigint;
  readonly connection: MoqtConnection;
  readonly trackName: string;
  readonly mediaType: 'video' | 'audio';
  readonly subscriptionRequestId: bigint | null;
  trackAlias: bigint | null;
  readonly warmStart?: boolean;
  readonly warmOwner?: WarmMediaOwner;
  retired: boolean;
  readonly streams: Map<bigint, boolean>;
}
import { isMsePackaging, mediaTrackPackaging, usesMsePath } from './packaging.js';

/** What a reconstructed LOCMAF chunk exposes beyond its CMAF bytes (frame path, event-only tracks). */
interface LocmafChunkDetails {
  readonly effective: LocmafEffectiveSamples;
  readonly mdat: Uint8Array;
  readonly genBoxes: readonly GenBox[];
  readonly timescale: number;
  readonly baseMediaDecodeTime: bigint;
}
import type { MediaSourceLike, VideoPresentation } from './interfaces.js';
import { CommandDispatcher, type DispatcherOutputObserver } from './command-dispatcher.js';
import { StatsAccumulator } from './stats.js';
import type { PlayerStats } from './stats.js';
import type { CmafAssemblerLike } from './interfaces.js';
import { buildConnectUrl, buildSetupOptions, buildSubscribeOptions, invalidGoawayUriReason } from './player-connect.js';
import { computePlaybackDelayUs,
  createPipelines,
  configurePipelines,
  handlePipelineCommand as doPipelineCommand,
  handlePipelineEvent as doPipelineEvent,
  handleRecoveryAction as doRecoveryAction,
  type TrackInfo,
} from './player-pipeline.js';
import {
  handleControlMessage as doControlMessage,
  removeSubscription,
  validateKnownTracks as doValidateKnownTracks,
} from './player-message.js';
import { wireConnectionCallbacks } from './player-wiring.js';
import {
  createTimelineState,
  processTimelineObject,
  findSeekTarget,
  getTimelineDuration,
  type TimelineState,
} from './timeline-manager.js';
import { isDraft22, isRequestStreamDraft } from '@openmoq/transport';

// ─── Constants ──────────────────────────────────────────────────────

/** Object limit for a make-before-break video's retained input. */
const SWITCH_STAGING_MAX_OBJECTS = 100;

/** draft-22 FILL_PARAMETERS for joining the current group: a LOCATION_FILTER
 *  of [1] (the current group: Largest.Group + 1 - 1), the
 *  counterpart of a relative Joining FETCH at offset 0. */
const CURRENT_GROUP_FILL = { filter: { type: 'RelativeStart' as const, groups: 1n } };
const CATALOG_FILL = CURRENT_GROUP_FILL;

/** Max time (ms) to wait for a keyframe during make-before-break switch. */
const SWITCH_STAGING_TIMEOUT_MS = 3_000;

// ─── Helpers ─────────────────────────────────────────────────────────

/** MSF-01 §5 defaults to 'catalog'; other names are explicit compatibility overrides. */
function catalogTrackName(trackName: string | undefined): string {
  return trackName ?? 'catalog';
}

/**
 * Encode a namespace string as a Track Namespace tuple.
 *
 * Split by '/' to produce multiple tuple elements per the namespace convention.
 * §2.4.1: "A Track Namespace is an ordered set of between 1 and 32
 * Track Namespace Fields".
 */
/**
 * Encode a config-level namespace into Track Namespace Fields (spec §2.4.1).
 *
 * Per spec, a Track Namespace is an ordered set of 1-32 fields, each an
 * arbitrary byte sequence. The slash is purely a display convention and
 * has no protocol meaning. Implementations choose freely how a
 * user-facing string maps to fields.
 *
 * Convention here:
 * - `string`   → split on `/` for ergonomic multi-field tuples
 *                (e.g. `"live/broadcast"` → `["live", "broadcast"]`).
 * - `string[]` → each entry is one field, used verbatim
 *                (e.g. `["cmsf/clear"]` → one 10-byte field with the
 *                slash inside).
 */
function encodeNamespace(
  ns: string | readonly string[],
  enc: TextEncoder,
): Uint8Array[] {
  return namespaceFields(ns).map(segment => enc.encode(segment));
}

/** Stable key for a wire identity. Keeps same-name tracks in different
 *  namespaces apart in every map that records what was requested. */
function identityKeyOf(namespace: readonly string[], name: string): string {
  return identityKey(namespace, name);
}

/** The ordered wire fields a config namespace denotes. */
function namespaceFields(ns: string | readonly string[]): readonly string[] {
  return typeof ns === 'string' ? fieldsFromCatalogText(ns) : Array.from(ns);
}

/**
 * The namespace a TRACK is addressed in.
 *
 * A catalog track may declare its own namespace, which overrides the
 * inherited one (msf-01 §5.2.2), so the request has to carry the track's
 * fields rather than the player's configured namespace. Only a track with no
 * namespace of its own falls back to the configured context.
 */
function trackNamespaceFields(
  track: { readonly namespace?: string; readonly resolvedNamespace?: ResolvedTrackNamespace } | undefined,
  configured: string | readonly string[],
): readonly string[] {
  const declared = track === undefined ? undefined : namespaceFieldsOf(track);
  return declared ?? namespaceFields(configured);
}

/**
 * Check if two CMAF codec strings are compatible without changeType().
 * Returns true only if the exact codec string matches — different
 * profile/level/resolution within the same family (e.g., avc1.640028
 * vs avc1.64001e) still needs changeType() because the SourceBuffer's
 * init segment (SPS/PPS) must match the media segments.
 */
function codecsCompatible(a: string, b: string): boolean {
  return a === b;
}

/** Exact byte equality — MSE initialization is compared, never approximated. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function defaultMediaSubscriptionFilter(isLive: boolean) {
  if (isLive) {
    return { subscriptionFilter: { type: 'NextGroupStart' as const } };
  }
  return {
    subscriptionFilter: {
      type: 'AbsoluteStart' as const,
      startGroup: varint(0n),
      startObject: varint(0n),
    },
  };
}

/**
 * Strip keys with `undefined` values from an object literal.
 *
 * Required by `exactOptionalPropertyTypes` — TypeScript rejects
 * `{ key: undefined }` when the target type uses `key?: T`.
 * At runtime, removes keys whose value is `undefined`, so the
 * resulting object satisfies optional-property targets.
 *
 * The `as any` return is unavoidable: TypeScript cannot express
 * "same shape but undefined-valued keys removed" in its type system.
 * This is a well-known limitation of `exactOptionalPropertyTypes`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defined(obj: Record<string, unknown>): any {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

// ─── Hook intent types ───────────────────────────────────────────────

/**
 * Intent to subscribe to a track — passed through the beforeSubscribe hook.
 *
 * `namespace` is the ordered wire tuple the request will carry, which is the
 * track's own namespace when the catalog declares one (msf-01 §5.2.2) and the
 * configured namespace otherwise. A hook that may CANCEL a subscription has
 * to see the identity actually being requested; a name alone cannot tell two
 * same-name tracks apart (§5.2.3).
 */
export interface SubscribeIntent {
  readonly trackName: string;
  readonly mediaType: 'video' | 'audio' | 'init' | 'mediatimeline' | 'eventtimeline';
  readonly namespace: readonly string[];
}

/** Result of a TRACK_STATUS query (§9.19).
 * Parameters use the wire-format KVP type per §1.4.2. */
export interface TrackStatusResult {
  readonly requestId: bigint;
  readonly parameters: Parameters;
}

/** Intent to switch quality — passed through beforeQualitySwitch hook. */
export interface QualitySwitchIntent {
  readonly fromTrackName: string;
  readonly toTrackName: string;
  readonly reason: string;
}

/**
 * Estimate the bytes a value retains when captured in a staged closure — the
 * actual sum of its `Uint8Array` byte-lengths and string lengths, recursing
 * through arrays/maps/objects (bounded depth). Used to charge staged control /
 * namespace events (which retain parameter byte arrays, track names, and reason
 * strings) against the migration byte budget, not a flat guess.
 */
function estimateRetainedBytes(value: unknown, depth = 0): number {
  if (value == null || depth > 6) return 0;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === 'string') return value.length * 2; // UTF-16 code units
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return 8;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const el of value) sum += estimateRetainedBytes(el, depth + 1);
    return sum;
  }
  if (value instanceof Map) {
    let sum = 0;
    for (const [k, v] of value) sum += estimateRetainedBytes(k, depth + 1) + estimateRetainedBytes(v, depth + 1);
    return sum;
  }
  if (typeof value === 'object') {
    let sum = 0;
    for (const v of Object.values(value as Record<string, unknown>)) sum += estimateRetainedBytes(v, depth + 1);
    return sum;
  }
  return 0;
}

/**
 * Bytes an Error retains — its (mostly non-enumerable) message, stack, and cause
 * chain, plus a structured context — which the generic {@link estimateRetainedBytes}
 * would miss. Used to charge a staged degraded-error diagnostic honestly.
 */
function errorRetainedBytes(err: unknown, context: unknown, depth = 0): number {
  let bytes = estimateRetainedBytes(context);
  if (err instanceof Error && depth <= 4) {
    bytes += (err.message?.length ?? 0) * 2;
    bytes += (err.stack?.length ?? 0) * 2;
    if (err.cause) bytes += errorRetainedBytes(err.cause, undefined, depth + 1);
  }
  return bytes;
}

/**
 * One in-flight migration transaction (see {@link MoqtPlayer.currentMigration}).
 * Owns the candidate connection and its staged events so cleanup, abort, and
 * commit can prove ownership rather than clobbering a global slot.
 */
interface MigrationTxn {
  readonly conn: MoqtConnection;
  /** The endpoint this attempt is moving TO, recorded at adoption so a
   *  replacement that sends an empty New Session URI during retirement
   *  resolves against it rather than the configured origin. */
  readonly target?: string;
  /** Staged events, each tagged with the live-delivery error source used to
   *  classify a replay failure the same way live delivery would, and — for
   *  data — with the alias and stream it arrived on. The tag is what lets an
   *  object retained BEFORE its alias was bound be taken back out and handled
   *  as the evidence it turns out to be (16 §10.4.2, 18 §11.4.2, 22
   *  §3.1.3.1 reordering), instead of
   *  waiting for an adoption that can never happen without it. */
  readonly events: Array<{
    readonly run: () => void;
    readonly source: MoqtConnectionErrorSource;
    readonly alias?: bigint;
    readonly streamId?: bigint;
    readonly obj?: MoqtObject;
  }>;
  retainedBytes: number;
  /** Candidate reached a terminal state (closed/errored) or overflowed staging. */
  aborted: boolean;
  /** Wakes an attempt blocked on a factory, auth or connect promise that may
   *  never settle, so abort can release the single-flight slot and cancel the
   *  attempt timer without waiting for that promise. */
  wake?: () => void;
  /** The candidate's OWN catalog retrieval state. Live slots are never
   *  swapped: evidence arriving on the candidate's connection routes here
   *  instead, and adoption transfers this holder wholesale. */
  slots?: CatalogSlots;
  /** Everything the candidate has PREPARED but not yet had adopted. Each
   *  element is readiness evidence the replacement actually produced — an
   *  accepted request and its delivered payload — never a request we sent. */
  prep?: CandidatePrep;
  /** Candidate has been promoted — staging is closed; further events run live. */
  committed: boolean;
  /** Synchronous adoption is not a safe point for another media selection. */
  adopting?: boolean;
  /** The committed session closed/fatally-errored DURING drain — stop replaying
   *  its events and do not report a successful migration. */
  terminated: boolean;
  /** Registrations the adopted session superseded, pruned once the old
   *  session has actually been retired — never at commit, because until then
   *  it may still be delivering the media playback is running on. */
  superseded?: { ids: Set<bigint>; aliases: Set<bigint> } | undefined;
  /** The session being REPLACED died while this attempt was still preparing.
   *  Held rather than announced: a healthy replacement makes it a non-event,
   *  and only an attempt that then fails has to report it. */
  oldTerminal?: { kind: 'close'; error?: number; reason?: string }
    | { kind: 'error'; error: Error; severity: ErrorSeverity; code: PlayerErrorCodeValue;
        context?: Record<string, unknown> }
    | undefined;
}

/**
 * A replacement session's prepared, not-yet-adopted playback state.
 *
 * Readiness is EVIDENCE, not intent: a catalog that parsed, media
 * subscriptions the replacement ACCEPTED, and initialization we actually
 * hold. Sending a request proves nothing, so nothing here is recorded at send
 * time — only when the peer answers (draft-22 §7.4.1, 16 §8.4.1, 18 §9.4.1:
 * the old subscriptions may be cancelled once the new ones have succeeded).
 *
 * All of it is transaction-local. A candidate that fails is discarded whole
 * and live playback never observed it; adoption transfers it in one step.
 */
interface CandidatePrep {
  /** Resolves when the candidate's catalog CONVERGED through its own
   *  configured retrieval policy (legacy subscribe, joining FETCH, or a
   *  draft-22 fill), rejects when that retrieval failed. */
  readonly catalog: Promise<CatalogState>;
  resolveCatalog(state: CatalogState): void;
  rejectCatalog(err: Error): void;
  /** The converged catalog, and any pre-adoption delta applied to it. */
  state: CatalogState | null;
  /** Prepared media subscriptions by the candidate's OWN request id. Request
   *  ids and track aliases collide freely across sessions, so these are never
   *  mixed into the live registries until adoption. */
  readonly media: Map<bigint, PreparedSub>;
  /** Init tracks the selection requires, by track name. */
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
    readonly selection: NonNullable<CandidatePrep['selection']>;
  };
  /** Candidate-owned selection policy state, adopted with its subscriptions. */
  controller?: QualityController;
  /** Retypes finished, so a later validation failure can undo them safely. */
  reconfigurationComplete?: boolean;
  /** Initialization the running source buffer was RETYPED to during
   *  preparation, by media type. Adoption hands the same bytes to the
   *  assembler so the two agree about what the buffer now holds. */
  readonly reconfigured: Map<'video' | 'audio', Uint8Array>;
  /** Required tracks still owing an IN-BAND initialization header, by track
   *  name. Emptied as each one actually delivers it. */
  readonly inbandInit: Map<string, 'video' | 'audio'>;
  /** In-band initialization the candidate delivered, by media type. */
  readonly inbandBytes: Map<'video' | 'audio', Uint8Array>;
}

/** One media subscription the candidate issued, and what came back. */
interface PreparedSub {
  readonly trackName: string;
  /** The tuple this candidate request was ISSUED with. */
  readonly namespace: readonly string[];
  readonly mediaType: 'video' | 'audio';
  readonly packaging: TrackPackaging;
  /** Bound by the candidate's own SUBSCRIBE_OK; null while unanswered — which
   *  is exactly why it is not readiness yet. */
  alias: bigint | null;
}

/** One init track the candidate must hold before it can be adopted. */
interface PreparedInit {
  /** Name and namespace of the init track, which is the REFERENCING track's
   *  namespace. Two media types may name their init track identically in
   *  different namespaces, and those are different tracks. */
  readonly name: string;
  readonly namespace: readonly string[];
  reqId: bigint | null;
  alias: bigint | null;
  bytes: Uint8Array | null;
}

/**
 * The state one catalog retrieval owns.
 *
 * Held rather than spread across player fields so a handover candidate can run
 * its own retrieval — coordinator, manager, fetch and stream bookkeeping —
 * without touching the retrieval current playback depends on. Adoption
 * transfers the holder; a failed candidate's holder is discarded.
 *
 * Stream-keyed maps live here rather than globally: two concurrent retrievals
 * can legitimately see the same stream ID, and a candidate must not overwrite
 * the other's FIN/reset ownership.
 *
 * Deliberately NOT here: `pendingAliasBinds`, shared with video switches and
 * media subscriptions, and `bootstrapGeneration`, a cancellation token media
 * work observes — making it catalog-scoped would reintroduce a cancellation
 * that crosses owners and aborts unrelated media.
 */
interface CatalogSlots {
  /** Pending catalog-subscribe retry timer; null when none is pending. */
  catalogSubscribeRetryTimer: ReturnType<typeof setTimeout> | null;
  /**
   * FETCH/FILL streams this retrieval has seen but cannot attribute yet,
   * because the request they name is registered a microtask later than the
   * stream carrying its answer arrives.
   *
   * The live session parks these in the player's shared map, which is
   * authoritative only for the current connection — so a preparing candidate,
   * which is by definition not current, needs its own. Claimed by
   * {@link MoqtPlayer.registerBootstrapFetch} as soon as the request is
   * registered; a catalog may be a single object, so dropping them instead
   * would simply hang the retrieval.
   */
  candidateFetchStreams: Map<bigint, {
    requestId: bigint;
    objects: MoqtObject[];
    bytes: number;
    terminal?: DataStreamTerminal;
  }>;
  /**
   * Catalog bootstrap (MSF-01 §5 SUBSCRIBE + Joining FETCH) — one coordinator
   * per bootstrap generation; null in legacy 'subscribe' mode or with an
   * injected catalog. All async continuations capture {generation, conn} and
   * are inert on mismatch.
   */
  catalogBootstrapCoord: CatalogBootstrap | null;
  /** Fetch data streams belonging to the bootstrap — CONNECTION-SCOPED: an
   *  old session's stream 0 must never be read as the new session's stream 0
   *  during migration. */
  readonly bootstrapFetchStreams: Map<bigint, { attempt: number; conn: MoqtConnection }>;
  /** Deferred terminal record for the LEGACY (coordinator-less) catalog
   *  subscription — the DECISION (recovery / fatal-no-base / quiet end) is
   *  made only at drain completion, honoring the terminal-drain barrier: a
   *  base may still arrive during the drain. Generation-stamped so a stale
   *  record can never affect a later legacy subscription (cleared at
   *  migration commit and destroy). */
  legacyCatalogTerminal: { gen: number; reqId: bigint | null; reason: PublishDoneReason } | null;
  /** Live data streams observed carrying catalog objects (clean-FIN tracking),
   *  connection-scoped and tagged with the OWNING coordinator (main vs a
   *  staged-recovery candidate) so lifecycle events reach the right one. */
  readonly catalogLiveStreams: Map<bigint, { conn: MoqtConnection; coord: CatalogBootstrap }>;
  /** draft-22 catalog SUBSCRIBEs whose fill stands in for the Joining FETCH:
   *  retiring one cancels the fill, never the subscription it rides on. */
  readonly catalogFillRequests: Set<bigint>;
  /**
   * Request ID returned by the catalog SUBSCRIBE.
   * Used to match SUBSCRIBE_OK and identify catalog subscription.
   * @see draft-ietf-moq-msf-00 §5.1.10 (catalog track)
   */
  catalogRequestId: bigint | null;
  /**
   * Server-assigned Track Alias for the catalog subscription.
   * Set when SUBSCRIBE_OK arrives for the catalog request ID.
   * Data objects carry trackAlias (not requestId), so this is
   * what we match against in onObject routing.
   * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK assigns Track Alias)
   */
  catalogTrackAlias: bigint | null;
  /** Whether the first catalog object has been received. */
  catalogReceived: boolean;
  catalogManager: CatalogManager | null;
  /**
   * Staged recovery after a post-ready retriable PUBLISH_DONE: a CANDIDATE
   * coordinator + manager re-acquire the catalog on a fresh subscription while
   * the ACTIVE catalog stays ready and untouched. Adopted atomically at
   * candidate readiness; discarded wholesale on failure; one attempt per
   * bootstrap generation (no recursion). Ownership is transaction-local: the
   * active `catalogRequestId`/`catalogTrackAlias` are not touched pre-adoption.
   */
  catalogRecovery: {
    coord: CatalogBootstrap;
    manager: CatalogManager;
    conn: MoqtConnection;
    gen: number;
    reqId: bigint | null;
    alias: bigint | null;
    fetch: { reqId: bigint; attempt: number } | null;
    fetchStreams: Map<bigint, number>;
    /** The OLD catalog alias, retired at drain. A publisher may reuse it for
     *  the candidate; its traffic parks here (fail-closed) until the
     *  candidate SUBSCRIBE_OK binds or refutes the reuse. */
    retiredAlias: bigint | null;
    parked: Array<{ streamId: bigint; obj: MoqtObject }>;
    parkedBytes: number;
    parkedEvents: Map<bigint, DataStreamTerminal>;
    /** Candidate readiness held until the alias is BOUND: the joining fetch
     *  can legally complete on a Pending subscription, and adopting before
     *  SUBSCRIBE_OK would discard the transaction-local parked traffic. */
    readyState: CatalogState | null;
    /** True while parked traffic replays at SUBSCRIBE_OK: adoption is held
     *  until the WHOLE replay is examined — a malformed parked delta after a
     *  valid head must abort the transaction, not degrade adopted state. */
    replaying: boolean;
  } | null;
  /** The coordinator's CURRENT fetch: connection-scoped ownership. */
  bootstrapFetch: { conn: MoqtConnection; reqId: bigint; attempt: number; gen: number } | null;
  recoveryAttempted: boolean;
}

/** A holder for a fresh retrieval, every slot at its initial value. */
function createCatalogSlots(): CatalogSlots {
  return {
    catalogSubscribeRetryTimer: null,
    candidateFetchStreams: new Map(),
    catalogBootstrapCoord: null,
    bootstrapFetchStreams: new Map<bigint, { attempt: number; conn: MoqtConnection }>(),
    legacyCatalogTerminal: null,
    catalogLiveStreams: new Map<bigint, { conn: MoqtConnection; coord: CatalogBootstrap }>(),
    catalogFillRequests: new Set<bigint>(),
    catalogRequestId: null,
    catalogTrackAlias: null,
    catalogReceived: false,
    catalogManager: null,
    catalogRecovery: null,
    bootstrapFetch: null,
    recoveryAttempted: false,
  };
}

// ─── MoqtPlayer ──────────────────────────────────────────────────────

/**
 * MOQT player — load()/play()/pause()/destroy().
 *
 * @see draft-ietf-moq-transport-16 §3 (Session)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 */
export class MoqtPlayer {
  /** Player version (set at build time). */
  static readonly version = '0.6.1';

  private readonly config: MoqtPlayerConfig;
  private readonly emitter = new TypedEmitter<PlayerEventMap>();
  private mediaStageObservers: MediaStageObservers | undefined;
  private mediaDiagnosticRuntime: MediaDiagnosticRuntime | undefined;
  private locDiagnosticBindings: {
    readonly runtime: MediaDiagnosticRuntime;
    pipelines: PlaybackPipeline[];
    dispatcher: CommandDispatcher | null;
    readonly input: PlaybackInputObserver;
    readonly output: DispatcherOutputObserver;
    refused: number;
  } | undefined;
  private diagnosticConnectionListeners: Map<(event: PlayerConnectionObservation) => void | Promise<void>, Set<MoqtConnection>> | undefined;
  private readonly stateMachine = new PlayerStateMachine();
  private readonly _stats = new StatsAccumulator();
  private readonly log: LoggerLike;
  private readonly watchdog: WatchdogController;

  /** Hook chains for interception. */
  readonly hooks = {
    /** Intercept/modify/cancel subscription intents. @see §5.1 */
    beforeSubscribe: new HookChain<SubscribeIntent>(),
    /** Intercept ABR quality switch decisions. @see §5.1.19 */
    beforeQualitySwitch: new HookChain<QualitySwitchIntent>(),
    /** Intercept/override recovery actions. @see §7, §13.4 */
    onRecovery: new HookChain<RecoveryAction>(),
  };

  private connection: MoqtConnection | null = null;
  private _adapterOwned = true;
  private qualityController: QualityController | null = null;
  private bandwidthEstimator: BandwidthEstimator | null = null;
  private bufferAbrController: BufferBasedController | null = null;
  private bwEstimatorGroupId: bigint = -1n;
  private bwEstimatorGroupBytes = 0;
  /** Estimated GOP duration in µs, computed from first two group arrivals. */
  private estimatedGopDurationUs = 2_000_000; // default 2s
  private subscriptionManager: SubscriptionManager | null = null;

  /**
   * Sans-I/O playback pipelines — one per media track.
   * @see draft-ietf-moq-loc-01 §4.2 (decode order)
   */
  private videoPipeline: PlaybackPipeline | null = null;
  private audioPipeline: PlaybackPipeline | null = null;

  /** Shared A/V sync controller — audio-master model. @see draft-ietf-moq-loc-01 §2.3.1.1 */
  private syncController: SyncController | null = null;

  /** Recovery controller shared by both pipelines. */
  private recoveryController: RecoveryController | null = null;

  /**
   * Routes DecoderCommands to browser adapter instances.
   * Created when config provides adapter factories (createVideoDecoder, etc.).
   * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → adapter)
   * @see draft-ietf-moq-loc-01 §4.1 (audio → adapter)
   */
  private commandDispatcher: CommandDispatcher | null = null;

  /**
   * MediaSource adapter for CMAF-packaged tracks.
   * Created when catalog contains tracks with packaging='cmaf' and
   * createMediaSource factory is provided.
   * CMAF objects bypass PlaybackPipeline entirely — MSE handles
   * buffering, decoding, and rendering via <video>.
   * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
   */
  private mediaSource: MediaSourceLike | null = null;
  /**
   * Per-track LOCMAF reconstruction state, keyed by issued namespace and name: each decoder is
   * seeded from that track's CMAF Header and turns LOCMAF Objects back into
   * canonical CMAF chunks for the assembler.
   * @see draft-einarsson-moq-locmaf-01 §6, §15
   */
  private locmafDecoders = new Map<string, LocmafTrackDecoder>();
  /**
   * Malformed-track bookkeeping per LOCMAF track: for each recent group, whether it
   * decoded a chunk and whether it was already counted as failed. Keyed by group
   * because groups interleave (each rides its own stream).
   */
  private locmafHealth = new Map<string, { groups: Map<bigint, { decoded: boolean; counted: boolean }>; failedGroups: number }>();
  /** The CMAF Header each LOCMAF decoder was built from (a repeated in-band header is not a re-seed). */
  private locmafDecoderInit = new Map<string, Uint8Array>();
  /** LOCMAF tracks whose CMAF Header cannot seed reconstruction (not re-parsed for every object). */
  private locmafBadInit = new Set<string>();
  /** Once-per-track warning keys for LOCMAF rejections and missing CMAF Headers. */
  private locmafWarned = new Set<string>();
  /**
   * Frame path (§16) bookkeeping per LOCMAF track: the next synthetic object id
   * for each recent group, so every coded sample becomes one pipeline object in
   * decode order, and the codec description read from the CMAF Header the
   * track's decoder was seeded from.
   */
  private locmafFrameIds = new Map<string, Map<bigint, bigint>>();
  private locmafDescriptions = new Map<string, { init: Uint8Array; description: Uint8Array | null }>();
  /**
   * Playback intent as declared through play()/pause()/destroy(), or `null`
   * when the embedder has never declared one. A media source created later
   * inherits this rather than its own default, so a player paused before the
   * catalog arrived cannot get an adapter that starts anyway.
   */
  private playbackIntent: boolean | null = null;
  /** Pending `state_changed` announcements; see announceState(). */
  private readonly stateAnnouncements: { from: PlayerStateValue; to: PlayerStateValue }[] = [];
  private announcingState = false;
  /** Smoothed LOC render cushion getter (slice A); null for CMAF sessions. */
  private getRenderCushionUs: (() => number) | null = null;

  /** Whether mediaSource.initialize() has been called. */
  private cmafInitialized = false;
  /** Accepted source initialization, independent of later catalog declarations. */
  private readonly installedCmafInit = new Map<'video' | 'audio', { source: MediaSourceLike; bytes: Uint8Array }>();

  /**
   * CMAF init-source state machine: one entry per selected CMAF track,
   * `bytes` filled by whichever valid source arrives first — inline catalog
   * initData, an initTrack delivery, or an in-band ftyp+moov object.
   * initialize() fires exactly ONCE, when EVERY entry has bytes (the
   * adapter latches on first call, so a partial call would orphan the
   * other track's SourceBuffer).
   */
  private cmafPendingInit: {
    video?: { codec: string; bytes: Uint8Array | null };
    audio?: { codec: string; bytes: Uint8Array | null };
  } | null = null;

  /** Tracks already warned about pre-init media drops (once per track). */
  private readonly cmafPreInitDropWarned = new Set<string>();

  /** Whether the cmaf_init bootstrap deadline has been armed. */
  private cmafInitDeadlineArmed = false;

  /** Whether we've seen a keyframe (group start) since init — video only. */
  private cmafVideoSynced = false;

  /**
   * Wall-clock time `cmaf_init` fulfilled, i.e. when the `cmaf_first_frame`
   * watchdog expectation was first armed. Used to bound how long video
   * segment arrivals may keep renewing that deadline — see
   * `cmafFirstFrameMaxWaitMs`.
   */
  private cmafFirstFrameDeadlineStartedAt: number | undefined;

  /** Start of the current hidden interval while the first-frame deadline is pending. */
  private cmafFirstFrameHiddenAt: number | undefined;

  /**
   * CMAF media is being held because the MediaSource is not attached yet
   * (`mediaSource.attached === false`, e.g. hidden tab). See the attach gate
   * in the CMAF object path and {@link handleCmafMediaSourceAttached}.
   */
  private cmafHoldingForAttach = false;

  /** First-frame timeout to re-arm when a hidden document becomes visible. */
  private cmafFirstFrameDeferredTimeoutMs: number | undefined;

  /** `visibilitychange` listener installed while the first-frame deadline is pending. */
  private visibilityListener: (() => void) | null = null;

  /** Assembles moof+mdat pairs, patches tfdt, emits complete segments. */
  private cmafAssembler: CmafAssemblerLike | null = null;

  /**
   * Init segment bytes received from each subscribed init track, keyed
   * by namespace fields and track name. Populated as `onInitObject` fires; consulted on
   * track switch when the new track's codec differs from the SourceBuffer's
   * current codec, so we can call `mediaSource.changeType()` immediately
   * instead of re-subscribing.
   */
  private readonly initSegmentByTrack = new Map<string, Uint8Array>();

  /**
   * Pending lazy init-track subscriptions, keyed by namespace fields and name.
   * Resolved when the first init object for that track arrives.
   * Used by `selectVideoTrack` to await init bytes before initiating a
   * codec-changing switch.
   */
  private readonly pendingInitTrackSubs = new Map<
    string,
    { connection: MoqtConnection; promise: Promise<Uint8Array>; resolve: (data: Uint8Array) => void; reject: (err: Error) => void }
  >();
  /** Init track subscription requestIds — for unsubscribe after first object. */
  private readonly initTrackRequestIds = new Map<string, bigint>();

  /**
   * Codec string the video SourceBuffer was last initialized for (or
   * retyped to). Compared against the target track's codec on switch
   * to decide whether `mediaSource.changeType()` is required. Works
   * for both inline-`initData` catalogs and separate-`initTrack`
   * catalogs — the codec is the canonical canary either way.
   */
  private currentVideoCodec: string | null = null;
  /**
   * Media types whose source buffer is being RETYPED for a replacement right
   * now. While a type is in here no segment is appended for it: MSE queues
   * appends across `changeType` and drains them afterwards, so anything handed
   * over mid-retype would be interpreted against the wrong initialization.
   */
  private readonly retypingMedia = new Set<'video' | 'audio'>();
  /**
   * Source-buffer retypes that have been STARTED and not yet settled, with the
   * initialization to put back if they do not end in an adoption.
   *
   * Owned by the player rather than by the transaction, because the mutation
   * outlives the attempt that began it: `changeType` can still be in flight
   * when the attempt times out or is abandoned, and whoever cleans up must
   * know what the buffer held before. While this map is non-empty the media
   * source is not in a known state, so no attempt may adopt it.
   */
  /**
   * The routes a retired session still owns while it is being closed.
   *
   * Media registrations are keyed by track alias, and aliases belong to a
   * SESSION: the replacement is free to reuse one for a different track, or
   * to leave one of the old session's aliases unused entirely. So between
   * adoption and the old session's close — a window that exists precisely so
   * playback does not gap — an object has to be matched on its SOURCE as well
   * as its alias:
   *
   * - the old session's own objects still route, which is the continuity this
   *   overlap is for, but only on aliases the replacement did not take over,
   *   and not for a media type whose buffer was reconfigured for the
   *   replacement (old-format bytes cannot be appended to a retyped buffer);
   * - the current session's objects never inherit one of these routes, so an
   *   alias it has not bound cannot deliver through a retired track.
   *
   * Cleared when the old session is actually retired.
   */
  private supersededRouting: {
    readonly conn: MoqtConnection;
    readonly aliases: Set<bigint>;
    readonly reconfigured: Set<'video' | 'audio'>;
  } | null = null;

  /**
   * Connections a handover has replaced.
   *
   * Membership is permanent: a session that has been superseded never
   * delivers media again, however late its data arrives — an async object
   * transform can begin before a handover and resolve after the session it
   * came from is closed, and those bytes belong to no track. A connection
   * that has simply never been current is NOT in here; it has its own route
   * until something replaces it.
   */
  private readonly supersededConns = new WeakSet<MoqtConnection>();

  private readonly pendingRetypes = new Map<'video' | 'audio',
    { owner: object; source: MediaSourceLike; codec: string; previous: Uint8Array; offset: number | undefined }>();

  /**
   * Buffer for objects that arrive before SUBSCRIBE_OK resolves the alias.
   * MoQ allows data to flow before the control response — the relay starts
   * sending immediately after receiving SUBSCRIBE. Objects are keyed by
   * track alias and replayed when SUBSCRIBE_OK maps the alias to a track.
   *
   * Bounded on two axes so an unresolving peer cannot grow it without limit:
   * at most {@link MAX_PENDING_PER_ALIAS} objects per alias AND at most
   * {@link MAX_PENDING_ALIASES} distinct aliases (a new alias beyond the cap is
   * dropped, not buffered). Entries are reclaimed when their delivering session
   * closes ({@link purgePendingForConnection}) — which also releases the strong
   * reference each entry holds to its source connection, so a superseded adapter
   * is collectable after migration.
   * @see draft-ietf-moq-transport-16 §9.10 (Track Alias in SUBSCRIBE_OK)
   */
  /**
   * Per-connection subgroup lifecycle witness state.
   *
   * Keyed by connection, so a migration's reused stream ids and aliases cannot
   * collide with the previous connection's entries. A WeakMap also means a
   * discarded candidate's state is collectable without explicit teardown.
   */
  /** True when an info-level message can reach a sink. @see constructor */
  private readonly infoLoggingEnabled: boolean;

  private readonly subgroupWitness = new WeakMap<MoqtConnection, Map<bigint, {
    groupId: bigint;
    endOfGroup: boolean;
    subgroupId: bigint | undefined;
  }>>();

  private readonly pendingObjectsByAlias = new Map<bigint, { streamId: bigint; obj: MoqtObject; sourceDraft: DraftVersion | undefined; sourceConnection: MoqtConnection; locmafResetOrdinal?: number; locmafResetBeforeOrdinal?: number; owners?: bigint[] }[]>();
  /** Reset order shared by the bounded parked records; no separate reset queue. */
  private pendingResetOrdinal = 0;
  private static readonly MAX_PENDING_PER_ALIAS = 256;
  private static readonly MAX_PENDING_ALIASES = 1024;

  /**
   * The single in-flight migration transaction, or null. Migration is
   * single-flight: a second attempt while one is running is rejected. The record
   * owns the candidate connection and its STAGED application events (control,
   * object, data-stream, datagram, …) captured while the candidate is
   * established-but-not-promoted — a fast peer can return the catalog
   * SUBSCRIBE_OK (or objects) before `subscribe()` even resolves, and processing
   * those against the not-yet-current candidate would drop them (control guard)
   * or route them through old-session state. They are drained in arrival order
   * right after the handoff commits. `aborted` records candidate-terminal or
   * overflow; `committed` stops staging once the candidate is authoritative.
   */
  private currentMigration: MigrationTxn | null = null;

  /** The catalog retrieval current playback depends on. */
  private catalogSlots: CatalogSlots = createCatalogSlots();

  /**
   * The endpoint this session is actually connected to.
   *
   * Starts at `config.url` and advances on every successful handover. A GOAWAY
   * with a zero-length New Session URI means "reuse the CURRENT session URI"
   * (draft-16 §9.4, draft-18 §10.4, draft-22 §9.2) — after A→B that is B, not
   * the originally configured A, which is where `config.url` would send it.
   *
   * Deliberately separate from the credential trust anchor: `config.url` remains
   * the origin authorization was granted against, so moving the endpoint never
   * widens where credentials may be sent.
   */
  private activeEndpoint: string;
  /** A GOAWAY received from a session WHILE a handoff was in flight — acted on
   *  once the handoff finishes, but ONLY if its source is still the current
   *  session (see {@link processPendingGoaway}). The source matters: during
   *  candidate establishment the OLD session is still current and its GOAWAY would
   *  otherwise migrate away from the caller's chosen replacement after commit. */
  private pendingGoaway: { readonly uri: string; readonly sourceConnection: MoqtConnection } | null = null;
  /** Max staged candidate events before the transaction aborts (bounds closures). */
  private static readonly MAX_STAGED_EVENTS = 512;
  /** Max total retained bytes across staged events before aborting. */
  private static readonly MAX_STAGED_BYTES = 8 * 1024 * 1024;
  /** Per-event base cost — charges control/namespace/stream events (which retain
   *  parameter byte arrays and reason strings) so the byte budget covers them. */
  private static readonly STAGED_EVENT_BASE_BYTES = 1024;


  /** Tick interval handle for pipeline processing. */
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Guard against double sync reset within a single tick cycle.
   * When both audio and video pipelines skip_forward in the same tick,
   * only the first reset takes effect. Without this, audio's reset +
   * setAudioReference is immediately wiped by video's reset.
   */
  private syncResetThisTick = false;

  /** Injectable clock for playback timing (microseconds). */
  private readonly clock: ClockSource;

  /** QUIC handshake RTT — used for startup buffer network classification. */
  private _handshakeRttMs: number | undefined;


  private bootstrapGeneration = 0;
  /**
   * SUBSCRIBE requests issued on the CURRENT session that have not yet been
   * answered (SUBSCRIBE_OK / REQUEST_ERROR). Unknown-alias data may only be
   * PARKED while at least one of these exists — pre-OK data can belong only
   * to an unanswered request, so with none outstanding it is unownable and
   * dropped (request/generation ownership, not wall-clock). Cleared at
   * migration commit (old ids) and destroy.
   */
  private readonly pendingAliasBinds = new Set<bigint>();

  /** The catalog alias a quarantined (GOAWAY'd / migrated-away) session was
   *  using: its late objects are dropped BEFORE media routing, so a cross-role
   *  reuse of that alias on the replacement session cannot pull old catalog
   *  bytes into the media pipeline. */
  private readonly quarantinedCatalogAliases = new WeakMap<MoqtConnection, bigint>();

  /** Fetch data streams announced by a SUPERSEDED session after migration —
   *  their objects (wire alias 0) are discarded, never alias-routed. Entries
   *  are removed when the tagging session closes the stream. */
  private readonly staleFetchStreams = new Map<bigint, MoqtConnection>();

  /** Fail-closed recovery-parking bounds (objects / bytes / lifecycle). */
  private static readonly MAX_RECOVERY_PARKED_OBJECTS = 256;
  private static readonly MAX_RECOVERY_PARKED_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_RECOVERY_PARKED_EVENTS = 64;
  private static readonly MAX_RECOVERY_PARKED_ALIASES = 64;

  /**
   * FAIL-CLOSED pre-alias stream lifecycle record: close events for streams
   * whose objects sit in `pendingObjectsByAlias`, replayed to the coordinator
   * at alias resolution so a pre-alias FIN/reset is not lost (the retained
   * chain needs POSITIVE clean-FIN evidence; a missing record therefore fails
   * closed — the chain is treated as not-clean, never as clean). Bounded FIFO:
   * eviction only removes positive evidence, which is also fail-closed.
   */
  private readonly pendingStreamEvents =
    new Map<MoqtConnection, Map<bigint, { error: number | undefined; terminal: DataStreamTerminal }>>();
  private static readonly MAX_PENDING_STREAM_EVENTS = 64;

  private pendingStreamEventCount(): number {
    let n = 0;
    for (const perConn of this.pendingStreamEvents.values()) n += perConn.size;
    return n;
  }
  /** GOAWAY quarantine: old (connection, catalog) delivery dropped regardless
   *  of generation — the old generation stays authoritative until migration
   *  commits, so inertness must not rely on the generation guard. */
  private readonly catalogQuarantinedConns = new WeakSet<MoqtConnection>();




  /** Delay before re-issuing a catalog SUBSCRIBE refused with DOES_NOT_EXIST. */
  private static readonly CATALOG_SUBSCRIBE_RETRY_MS = 1_000;

  /** Stored catalog state for track switching. */
  private _catalogState: CatalogState | null = null;

  /**
   * Track Namespaces the peer has announced via control-stream
   * PUBLISH_NAMESPACE. Keyed by the publisher's request ID. Used to
   * suppress duplicate `namespace_announced` events on retransmits.
   *
   * @see draft-ietf-moq-transport-16 §6.2, §9.20
   */
  private readonly announcedNamespaces = new Map<bigint, Uint8Array[]>();

  /**
   * Pending track switch — defers old subscription teardown until the
   * new track's keyframe is ready (make-before-break switching).
   * @see draft-ietf-moq-msf-00 §4.2 (clean switch at group boundaries)
   */
  private pendingVideoSwitch: {
    connection: MoqtConnection;
    generation: number;
    mediaSource: MediaSourceLike | null;
    oldRequestId: bigint;
    oldTrackName: string;
    newTrackName: string;
    newRequestId: bigint | null;
    newTrackPackaging: TrackPackaging;
    targetTrack: CatalogTrack;
    catalog: CatalogState;
    initData: Uint8Array | undefined;
    cmafContext: LocmafTrackContext | null | undefined;
    phase: 'preparing' | 'staging' | 'committing' | 'restoring' | 'committed' | 'retired';
    requestReleased: boolean;
    failure: Error | undefined;
    stagedBytes: number;
    stagedObjects: number;
    done: Promise<void>;
    settle(): void;
    /** Carried from `selectVideoTrack` so commit/abort events report it. */
    reason: string;
    /** ABR direction — set by ABR/recovery paths for deferred commit. */
    abrAction?: 'downshift' | 'upshift';
  } | null = null;

  /**
   * Staging buffer for new-track objects during make-before-break switch.
   * Objects accumulate here until a keyframe (objectId === 0n) arrives,
   * then all are fed to the pipeline in order on switch completion.
   * LOC pipeline path.
   */
  private switchStagingBuffer: Array<{ obj: MoqtObject; headers: LocHeaders | undefined; input?: ObjectRoutingContext }> = [];

  /**
   * Staging buffer for new-track CMAF objects during make-before-break.
   * Without this, both old- and new-track segments hit MSE during the
   * overlap window — the resulting splice churn evicts decoder reference
   * frames and only keyframes from the new track decode.
   */
  private cmafSwitchStagingBuffer: Array<{
    trackName: string;
    mediaType: 'video' | 'audio';
    groupId: bigint;
    payload: Uint8Array;
    sync: boolean;
    input?: ObjectRoutingContext;
  }> = [];

  /** Timeout for keyframe arrival during make-before-break switch. */
  private switchStagingTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * True from the moment `completePendingVideoSwitch` starts until its
   * async tail (changeType + staged-flush) finishes. While set:
   *   - re-entry into `completePendingVideoSwitch` is a no-op (guards
   *     against the keyframe-detect path firing multiple times during
   *     the async window).
   *   - `pendingVideoSwitch` stays set, so further new-track objects
   *     keep getting staged. They get flushed (in arrival order, after
   *     the keyframe) when the .then fires.
   *
   * Without this, new-track P-frames that arrive between the sync part
   * of `completePendingVideoSwitch` and its async tail bypass staging
   * and end up in the MseMediaSource's back-pressure queue, ahead of the
   * staged keyframe — the decoder then sees P-frames first and chokes
   * with PIPELINE_ERROR_DECODE.
   */
  private switchInProgress = false;
  private videoSwitchRevision = 0;


  /**
   * Whether pipelines/CommandDispatcher have been created.
   * Guards against double-creation when knownTracks pre-creates them
   * before catalog arrives.
   * @see DESIGN-production-readiness.md §2 (TTFF optimization)
   */
  private pipelinesCreated = false;
  private _destroyed = false;

  /**
   * Active media subscriptions: requestId → track info.
   * Used by play()/pause() to send REQUEST_UPDATE.
   * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE)
   */
  /**
   * Live subscriptions by request id.
   *
   * `namespace` is the tuple the request was actually ISSUED with, retained
   * because it is the only record of which track owns this subscription: a
   * name is unique only per namespace (§5.2.3), so reconstructing the
   * identity later from a catalog would take whichever declaration happens
   * to come first rather than the one that is playing.
   */
  private readonly activeSubscriptions = new Map<
    bigint,
    {
      trackName: string;
      mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline';
      trackAlias: bigint | null;
      namespace?: readonly string[];
    }
  >();

  /**
   * Media-liveness: per-track starvation detection + restart ladder.
   * The gap detector handles gaps BETWEEN arrivals; this handles NO
   * arrivals (transport stream death, relay restart). null when disabled
   * (livenessTimeoutMs: 0).
   */
  private livenessMonitor: MediaLivenessMonitor | null = null;

  /**
   * streamId to track alias and group for SUBGROUP data streams only. Lets a stream
   * reset shorten the owning track's liveness fuse (§10.4.3 resets are
   * otherwise normal) and invalidate its LOCMAF reference (§3).
   * Fetch streams and datagrams never enter this map.
   */
  private readonly subgroupStreams = new Map<bigint, { trackAlias: bigint; groupId: bigint }>();

  /**
   * Restart-ladder state per track, keyed `${mediaType}:${trackName}`
   * (survives requestId/alias changes across full resubscribes).
   */
  private readonly livenessRestarts = new Map<string, {
    attempts: number;
    active: boolean;
    cancelled: boolean;
  }>();

  /**
   * Media subscriptions pending SUBSCRIBE_OK: requestId → track info.
   * Registration in SubscriptionManager is deferred until SUBSCRIBE_OK
   * provides the server-assigned Track Alias.
   * @see draft-ietf-moq-transport-16 §9.10 (Track Alias in SUBSCRIBE_OK)
   */
  private readonly pendingMediaSubs = new Map<
    bigint,
    { trackName: string; mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline'; packaging?: TrackPackaging }
  >();
  private _mediaSubsExpected = 0;
  private _mediaSubsOk = 0;
  private _mediaSubsFailed = 0;

  /** One initial retrieval and its completed/abandoned fence per issued owner. */
  private readonly warmMediaOwners = new Map<object, WarmMediaOwner>();

  private warmMediaOwnerCurrent(owner: WarmMediaOwner): boolean {
    if (this._destroyed || this.isTerminalState()
        || this.warmMediaOwners.get(owner.subscription) !== owner) return false;
    const current = this.connection === owner.connection;
    // Request IDs are session-local. Adoption may reuse this ID while the
    // retiring source still owns a distinct, unchanged alias and buffer.
    if (current && this.activeSubscriptions.get(owner.requestId) !== owner.subscription) return false;
    const alias = owner.subscription.trackAlias;
    return alias === null ? current
      : owner.registration?.() === true && this.mediaRouteBelongsTo(owner.connection, alias);
  }

  private retireWarmMediaOwners(connection: MoqtConnection): void {
    for (const [subscription, owner] of this.warmMediaOwners) {
      if (owner.connection !== connection) continue;
      this.warmMediaOwners.delete(subscription);
      owner.head?.retire();
    }
  }

  private armWarmMediaOwner(connection: MoqtConnection, requestId: bigint): WarmMediaOwner | null {
    const subscription = this.activeSubscriptions.get(requestId);
    if (!subscription) return null;
    const owner: WarmMediaOwner = { connection, requestId, subscription, registration: null, head: null, prefixFetch: null };
    this.warmMediaOwners.set(subscription, owner);
    const head = new WarmStartHead<WarmMediaRoute>({
      clock: this.clock,
      isCurrent: () => this.warmMediaOwnerCurrent(owner),
      deliver: (route, delivery) => {
        route.permit({ kind: 'deliver', backfill: delivery.backfill, isLive: () => route.isLive() && delivery.isLive() });
        return route.work;
      },
      discard: (route, reason) => {
        route.permit({ kind: 'discard', reason: reason === 'retired' ? 'route retired'
          : reason === 'overflow' ? 'buffer full' : reason === 'duplicate' || reason === 'stale prefix' || reason === 'outside prefix'
            ? 'treated as a replay' : 'warm start incomplete' });
      },
      onError: error => this.log.warn('[warm-start] admission failed: %s', error instanceof Error ? error.message : String(error)),
    });
    owner.head = head;
    if (!this.warmMediaOwnerCurrent(owner)) head.retire();
    return owner;
  }

  private finishWarmMediaPrefix(info: Pick<MediaFetchInfo, 'connection' | 'warmOwner' | 'warmStart'>, terminal: 'fin' | 'reset' | 'error'): void {
    const owner = info.warmOwner;
    if (info.warmStart && owner?.connection === info.connection
        && this.warmMediaOwners.get(owner.subscription) === owner) owner.head?.finishPrefix(terminal);
  }

  private warmMediaFetchForStream(connection: MoqtConnection, streamId: bigint): MediaFetchInfo | undefined {
    if (this.warmMediaOwners.size === 0) return undefined;
    for (const owner of this.warmMediaOwners.values()) {
      if (owner.connection === connection && owner.prefixFetch?.streams.has(streamId)) return owner.prefixFetch;
    }
    return undefined;
  }

  private bindWarmMediaFetch(info: MediaFetchInfo, streamId: bigint, closed = false): void {
    if (!info.warmOwner || info.streams.has(streamId)) return;
    if (info.streams.size >= MoqtPlayer.MAX_PENDING_FETCH_STREAMS) {
      info.retired = true;
      this.finishWarmMediaPrefix(info, 'error');
      return;
    }
    info.streams.set(streamId, closed);
  }

  /** Capture manager work/provenance now; only its admission waits for prefix order. */
  private routeMediaObject(streamId: bigint, obj: MoqtObject, sourceDraft?: DraftVersion, sourceConnection?: MoqtConnection,
    receiptInput: MoqtObject | ObjectDatagram = obj,
    fetchInfo?: Pick<MediaFetchInfo, 'subscriptionRequestId' | 'warmStart' | 'warmOwner'>): Promise<void> {
    const manager = this.subscriptionManager;
    if (!manager) return Promise.resolve();
    if (this.warmMediaOwners.size === 0) {
      return manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput,
        fetchInfo?.warmStart ? { isLive: () => false } : undefined);
    }
    const alias = BigInt(obj.trackAlias);
    const owner = fetchInfo ? (fetchInfo.warmStart ? fetchInfo.warmOwner : undefined)
      : [...this.warmMediaOwners.values()].find(candidate => candidate.connection === sourceConnection && candidate.subscription.trackAlias === alias);
    if (!owner || owner.connection !== sourceConnection || owner.subscription.trackAlias !== alias
        || this.warmMediaOwners.get(owner.subscription) !== owner) return manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput,
      fetchInfo?.warmStart ? { isLive: () => false } : undefined);
    const registration = manager.captureRoute(alias);
    const isLive = () => this.subscriptionManager === manager && registration?.() === true && this.warmMediaOwnerCurrent(owner);
    let permit!: WarmMediaRoute['permit'];
    const admission = new Promise<ObjectDeliveryAdmission>(resolve => { permit = resolve; });
    const work = manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput, { isLive, admission });
    const head = owner.head;
    if (!head) permit({ kind: 'discard', reason: 'route retired' });
    else head.push({ group: BigInt(obj.groupId), object: BigInt(obj.objectId),
      bytes: obj.kind === 'data' ? obj.payload.byteLength + (obj.extensions?.byteLength ?? 0) : 0,
      continuation: obj.kind === 'gap' && obj.status === ObjectStatus.END_OF_TRACK ? 'terminal'
        : obj.kind === 'data' && obj.payload.byteLength > 0 && BigInt(obj.objectId) === 0n ? 'group-start' : 'ordinary',
      source: fetchInfo ? 'prefix' : 'live', value: { permit, work, isLive } });
    return work;
  }

  /**
   * Active fetches: requestId → track info for routing fetch objects.
   * @see draft-ietf-moq-transport-16 §9.16 (FETCH)
   */
  private readonly activeFetches = new Map<
    bigint,
    MediaFetchInfo
  >();

  /**
   * Pending TRACK_STATUS queries: requestId → { resolve, reject }.
   * @see draft-ietf-moq-transport-16 §9.19
   */
  private readonly pendingTrackStatuses = new Map<
    bigint,
    { resolve: (result: TrackStatusResult) => void; reject: (error: Error) => void }
  >();

  /**
   * Pending {@link fetchCatalog} promises keyed by FETCH request ID.
   *
   * Self-contained one-shot lifecycle — does not share state with the
   * running catalog (`catalogManager` / `_catalogState`). Each entry
   * also owns a timeout handle so the promise is guaranteed to settle.
   *
   * @see draft-ietf-moq-transport-16 §9.16 (FETCH)
   */
  private readonly pendingCatalogFetches = new Map<
    bigint,
    {
      resolve: (state: CatalogState) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  /**
   * Map from FETCH data stream ID → request ID for in-flight catalog
   * fetches. Populated when `onDataStream` fires for a FETCH header
   * whose requestId is in `pendingCatalogFetches`. Used by `onObject`
   * to route the object to the right pending resolver.
   *
   * Kept separate from {@link fetchStreamAliases} (which serves media
   * fetches) so the catalog path doesn't need a synthetic media alias.
   */
  private readonly catalogFetchStreams = new Map<bigint, bigint>();

  /**
   * Confirmed FETCH stream -> alias routing. Streams waiting for their
   * subscription's SUBSCRIBE_OK stay in pendingFetchStreams instead.
   * @see draft-ietf-moq-transport-16 §10.4.4 (FETCH_HEADER)
   */
  private readonly fetchStreamAliases = new Map<bigint, bigint>();

  /**
   * Fetch stream → FETCH request ID, so a stream FIN/reset can clean up the
   * matching {@link activeFetches} entry (a fetch is complete when its single
   * data stream ends, §9.16.3).
   */
  private readonly fetchStreamRequestIds = new Map<bigint, bigint>();

  /**
   * FETCH data streams whose request or subscription alias is not yet known.
   * §9.16.3 allows fetch data at any time relative to
   * FETCH_OK — which can beat the joiningFetch()/fetch() promise continuation
   * that registers the fetch. Objects buffer here (bounded) and replay
   * through the normal alias remap once the fetch is registered; they are
   * NEVER routed under their wire trackAlias 0.
   */
  private readonly pendingFetchStreams = new Map<
    bigint,
    { requestId: bigint; sourceDraft: DraftVersion | undefined; sourceConnection: MoqtConnection; objects: MoqtObject[]; bytes: number; terminal?: DataStreamTerminal }
  >();

  /**
   * FETCH request IDs refused by REQUEST_ERROR BEFORE the fetch()/
   * joiningFetch() continuation registered them (§9.16.3 races). Registration
   * consults this so a refused request is never resurrected. Bounded FIFO.
   */
  private readonly refusedFetchRequests = new Map<bigint, { reason: string; code: bigint }>();
  private static readonly MAX_REFUSED_FETCHES = 16;
  /**
   * FETCH request IDs whose ownership was ROLLED BACK after an ambiguous send
   * failure (bytes may have reached the peer): late data streams for these
   * are tombstoned (droppedFetchStreams) rather than parked as unowned
   * pending streams. Bounded FIFO; reclaimed at migration/destroy — the
   * defined lifecycle boundary. */
  private readonly quarantinedFetchRequests = new Set<bigint>();
  private static readonly MAX_QUARANTINED_FETCHES = 16;

  private quarantineFetchRequest(reqId: bigint): void {
    const info = this.activeFetches.get(reqId);
    if (info) { info.retired = true; this.finishWarmMediaPrefix(info, 'error'); }
    this.activeFetches.delete(reqId);
    for (const [streamId, requestId] of this.fetchStreamRequestIds) {
      if (requestId !== reqId) continue;
      this.fetchStreamRequestIds.delete(streamId);
      this.fetchStreamAliases.delete(streamId);
      this.droppedFetchStreams.add(streamId);
    }
    if (this.quarantinedFetchRequests.size >= MoqtPlayer.MAX_QUARANTINED_FETCHES) {
      const oldest = this.quarantinedFetchRequests.values().next().value;
      if (oldest !== undefined) this.quarantinedFetchRequests.delete(oldest);
    }
    this.quarantinedFetchRequests.add(reqId);
    // Streams already parked for it become tombstoned; their buffered objects die.
    for (const [streamId, pending] of this.pendingFetchStreams) {
      if (pending.requestId === reqId) {
        this.pendingFetchStreams.delete(streamId);
        if (pending.terminal === undefined) this.droppedFetchStreams.add(streamId);
      }
    }
  }
  /** Entry-count bound for pendingFetchStreams (FIFO eviction of the oldest). */
  private static readonly MAX_PENDING_FETCH_STREAMS = 8;
  private static readonly MAX_PENDING_FETCH_BYTES = 4 * 1024 * 1024;

  /** Release a request's routing only on the session that created it. */
  private retireMediaSubscription(requestId: bigint, conn: MoqtConnection) {
    if (conn !== this.connection) return undefined;
    this.pendingMediaTerminals.get(conn)?.get(requestId)?.releaseEnd();
    this.pendingMediaTerminals.get(conn)?.delete(requestId);
    const ownerSubscription = this.activeSubscriptions.get(requestId);
    const warmOwner = ownerSubscription && this.warmMediaOwners.get(ownerSubscription);
    if (warmOwner?.connection === conn) {
      this.warmMediaOwners.delete(ownerSubscription!);
      warmOwner.head?.retire();
    }
    this.settleParkedOwnership(requestId, null, conn);
    const sub = removeSubscription(requestId, {
      activeSubscriptions: this.activeSubscriptions,
      pendingMediaSubs: this.pendingMediaSubs,
      subscriptionManager: this.subscriptionManager,
    });
    if (sub?.trackAlias != null && this.subscriptionManager?.getMediaType(sub.trackAlias) === undefined) {
      this.pendingObjectsByAlias.delete(sub.trackAlias);
    }
    for (const [fetchId, info] of this.activeFetches) {
      if (info.subscriptionRequestId === requestId) this.quarantineFetchRequest(fetchId);
    }
    try { this.reconsiderMseTrackEnds(); }
    catch (error) { try { this.log.warn('Track completion observer failed: %s', String(error)); } catch { /* observer failure */ } }
    return sub;
  }

  private readonly pendingMediaTerminals = new WeakMap<MoqtConnection, Map<bigint, {
    sub: object; reason: string; whenIdle: () => Promise<void> | undefined; releaseEnd: (completeTrack?: boolean) => void;
    trackEnded: boolean; completeMse: () => void;
  }>>();
  private readonly terminalMediaSubscriptions = new WeakSet<object>();
  private videoDeliveryEnding(): boolean {
    if (this.videoPipeline?.isEnding) return true;
    const video = [...this.activeSubscriptions.values()].filter(sub => sub.mediaType === 'video');
    if (video.length > 0 && video.every(sub => this.terminalMediaSubscriptions.has(sub))) return true;
    const completion = this.mseCompletions?.get('video');
    const selected = this.mseSelection('video');
    return completion?.emitted === true && completion.conn === this.connection && completion.source === this.mediaSource
      && completion.selection === selected?.selection && completion.key === selected.key;
  }
  private mseCompletions: Map<'video' | 'audio', {
    conn: MoqtConnection; source: MediaSourceLike; selection: object; key: string; emitted: boolean;
  }> | null = null;

  private mseSelection(mediaType: 'video' | 'audio'): { selection: object; key: string } | null {
    const track = mediaType === 'video' ? this.qualityController?.currentVideoTrack : this.qualityController?.currentAudioTrack;
    if (track) return { selection: track, key: identityKey(trackNamespaceFields(track, this.config.namespace), track.name) };
    const known = this.config.knownTracks?.[mediaType];
    return known ? { selection: known, key: identityKey(namespaceFields(this.config.namespace), known.name) } : null;
  }

  private reconsiderMseTrackEnds(): void {
    if (!this.mseCompletions) return;
    const initIds = new Set(this.initTrackRequestIds.values());
    for (const [mediaType, completion] of this.mseCompletions) {
      const selected = this.mseSelection(mediaType);
      if (this._destroyed || this.connection !== completion.conn || this.mediaSource !== completion.source
          || selected?.selection !== completion.selection || selected.key !== completion.key) {
        this.mseCompletions.delete(mediaType); continue;
      }
      if (completion.emitted || [...this.activeSubscriptions].some(([id, sub]) => sub.mediaType === mediaType && !initIds.has(id))) continue;
      completion.emitted = true;
      // MSE owns decoding: track delivery completion is not a presentation witness or global endOfStream.
      try { this.emitter.emitIsolated('track_ended', { type: 'track_ended', mediaType }); }
      catch (error) { try { this.log.warn('Track completion observer failed: %s', String(error)); } catch { /* observer failure */ } }
    }
  }

  private releaseMediaTerminals(conn: MoqtConnection): void {
    const terminals = this.pendingMediaTerminals.get(conn);
    this.pendingMediaTerminals.delete(conn);
    if (terminals) for (const terminal of terminals.values()) terminal.releaseEnd();
  }

  /** Retain normal completion data, not errors or stale live-edge recovery (§9.15 / §10.11 / §9.9). */
  private mediaTerminalOptions(conn: MoqtConnection) {
    return {
      terminalDelivery: 'drain' as const,
      terminalDeliveryCompletion: 'streams' as const,
      terminalDeliveryStatuses: isDraft22(conn.draftVersion) ? [2n] : [2n, 3n],
      onDrained: (id: bigint) => {
        const terminals = this.pendingMediaTerminals.get(conn);
        const terminal = terminals?.get(id);
        if (!terminal) return;
        const sub = this.activeSubscriptions.get(id);
        if (this._destroyed || this.connection !== conn || sub !== terminal.sub) { terminals!.delete(id); terminal.releaseEnd(); return; }
        const finish = () => {
          if (terminals?.get(id) !== terminal) return;
          terminals.delete(id);
          const owned = !this._destroyed && this.connection === conn && this.activeSubscriptions.get(id) === terminal.sub;
          terminal.releaseEnd(owned && terminal.trackEnded);
          if (!owned) return;
          this.retireMediaSubscription(id, conn);
          try {
            this.emitter.emit('track_unsubscribed', { type: 'track_unsubscribed', trackName: sub!.trackName, reason: terminal.reason });
          } finally { terminal.completeMse(); }
        };
        const pending = terminal.whenIdle();
        if (pending) void pending.then(finish).catch(error => {
          try { this.log.warn('Terminal media cleanup failed: %s', String(error)); } catch { /* observer failure */ }
        });
        else finish();
      },
    };
  }

  /**
   * Tombstones for discarded fetch streams: their later objects
   * must be swallowed (a fetch stream's wire trackAlias is 0, which can
   * collide with a real alias-0 subscription). Entries clear on FIN/reset,
   * so the set is bounded by the peer's concurrently-open streams.
   */
  private readonly droppedFetchStreams = new Set<bigint>();

  /**
   * Media timeline state — populated when catalog contains a mediatimeline track.
   * Enables seek() via PTS→location lookup.
   * @see draft-ietf-moq-msf-00 §7 (Media Timeline track)
   */
  private timelineState: TimelineState | null = null;

  /**
   * Request ID of the timeline subscription (to exclude from seek REQUEST_UPDATE).
   */
  private timelineRequestId: bigint | null = null;

  /** TextEncoder for namespace/name byte encoding. */
  private readonly enc = new TextEncoder();

  constructor(config: MoqtPlayerConfig) {
    // Validate + merge defaults — bad config fails fast, not 30 seconds into a stream.
    validateConfig(config);
    this.config = { ...DEFAULT_PLAYER_CONFIG, ...config };
    this.activeEndpoint = this.config.url;
    // Default clock: performance.now() in microseconds.
    // Must match the CanvasRenderer's rAF-driven renderTick(performance.now() * 1000)
    // to ensure render time domains are consistent.
    this.clock = this.config.clock ?? { now: () => performance.now() * 1000 };
    this.log = createLogger({
      ...(this.config.logLevel !== undefined ? { logLevel: this.config.logLevel } : {}),
      ...(this.config.logger !== undefined ? { logger: this.config.logger } : {}),
    });
    // Whether an info-level message can reach anything. A custom logger does
    // its own filtering, so it always can; otherwise `createLogger` returns
    // NULL_LOGGER below 'info' and the message would be built and discarded.
    // Diagnostics that serialize their payload check this first.
    this.infoLoggingEnabled = this.config.logger !== undefined
      || LOG_LEVELS[this.config.logLevel ?? 'none'] >= LOG_LEVELS.info;

    // Watchdog: detect "nothing happened" scenarios.
    // Fires timeout/warning events when expected lifecycle events don't arrive.
    this.watchdog = new WatchdogController({
      onTimeout: (e) => {
        if (e.event === 'catalog_received') {
          // An empty track and the peer's retry delay are intentional waits,
          // not failed delivery. A deadline alone cannot reject a valid
          // progressing fetch or replace the MSF-01 bootstrap procedure.
          if (this._destroyed || this.isTerminalState() || this.catalogSlots.catalogReceived
              || this.catalogSlots.catalogSubscribeRetryTimer !== null
              || this.catalogSlots.catalogBootstrapCoord?.phase === 'empty-wait') return;
          this.emitError(createPlayerError(
            'transient', 'catalog', PlayerErrorCode.CATALOG_WAIT_TIMEOUT,
            `Still waiting for a complete catalog after ${e.elapsedMs}ms`,
            { context: { bootstrapPhase: this.catalogSlots.catalogBootstrapCoord?.phase ?? 'subscribe', elapsedMs: e.elapsedMs } },
          ));
          return;
        }
        // CMAF bootstrap deadlines ESCALATE (fatal); all other
        // expectations keep the historical diagnostic-only behavior.
        if (e.event === 'cmaf_init' || e.event === 'cmaf_first_frame') {
          // Browsers (Chrome in particular) defer a media element's resource
          // load — for MSE, the MediaSource attachment that fires
          // `sourceopen` — while the document is hidden (background tab), and
          // resume it when the tab becomes visible. Until then no SourceBuffer
          // exists and nothing can render, no matter how healthy delivery is.
          // That is not a codec/init mismatch: suspend the deadline instead of
          // escalating, and re-arm it fresh once the document is visible.
          if (e.event === 'cmaf_first_frame' && this.documentHidden()) {
            this.deferCmafFirstFrameDeadline(e.timeoutMs);
            return;
          }
          if (e.event === 'cmaf_first_frame') {
            this.cmafFirstFrameDeadlineStartedAt = undefined;
            this.cmafFirstFrameHiddenAt = undefined;
          }
          this.removeVisibilityListenerIfIdle();
          const detail = e.event === 'cmaf_init'
            ? 'CMAF media arriving but no init segment materialized (initData / initTrack / in-band ftyp+moov)'
            : 'CMAF MediaSource initialized but no frame rendered (init/codec mismatch?)';
          this.emitError(createPlayerError(
            'fatal', 'catalog', PlayerErrorCode.CMAF_INIT_TIMEOUT,
            `${detail} within ${e.timeoutMs}ms`,
          ));
          if (!this.isTerminalState()) this.transitionState(PlayerState.ERROR);
          this.stopTicking();
          return;
        }
        this.log.warn('Watchdog timeout: %s after %dms', e.event, e.elapsedMs);
        // Through the queue like every other publication: emitting directly
        // would let a re-entrant listener here reorder state events.
        this.announceState(this.state, this.state); // state doesn't change — diagnostic only
      },
      onWarning: (e) => {
        this.log.info('Watchdog waiting: %s (%dms/%dms)', e.event, e.elapsedMs, e.timeoutMs);
      },
    });

    // Media-liveness monitor: detects per-track delivery starvation while
    // PLAYING and drives the restart ladder. Complements (does not replace)
    // the gap detector, which only handles gaps BETWEEN arrivals.
    if (this.config.livenessTimeoutMs! > 0) {
      this.livenessMonitor = new MediaLivenessMonitor({
        livenessTimeoutMs: this.config.livenessTimeoutMs!,
        resetProbeMs: this.config.livenessResetProbeMs!,
        onStarved: (track, starvedForMs, healthyForMs) => {
          void this.handleTrackStarvation(track, starvedForMs, healthyForMs);
        },
      });
    }
  }

  // ─── Capability Detection ──────────────────────────────────

  /**
   * Quick check: can this environment run MoQ playback?
   * Call before creating a player instance.
   *
   * @see DESIGN-browser-adapter-gaps.md §6
   */
  static isSupported(): boolean {
    return detectSupport().supported;
  }

  /**
   * Detailed capability report for the current environment.
   * Use to decide fallback strategy or show appropriate UI.
   *
   * @see DESIGN-browser-adapter-gaps.md §6
   */
  static checkSupport(): SupportReport {
    return detectSupport();
  }

  /** Current player state. */
  get state(): PlayerStateValue {
    return this.stateMachine.state;
  }

  /**
   * Historical video draw evidence, not an advancing content playhead.
   * Null after destruction or without renderer support (including MSE).
   */
  get videoPresentation(): VideoPresentation | null {
    if (this._destroyed) return null;
    const observation = this.commandDispatcher?.videoPresentation ?? null;
    return this._destroyed ? null : observation;
  }

  /**
   * Pipeline readiness level — indicates how far along the player is
   * in establishing playback. Useful for diagnosing "stuck" states.
   *
   * - 0 = HAVE_NOTHING — no catalog, no media
   * - 1 = HAVE_CATALOG — catalog received, tracks known
   * - 2 = HAVE_MEDIA — media objects arriving
   *
   * Unlike the player `state` which is about intent (playing/paused),
   * readyState is about data availability. A player can be in state
   * "playing" but readyState 0 (subscribed but no data arriving).
   */
  get readyState(): number {
    if (this._stats.snapshot().objectsReceived > 0) return 2; // HAVE_MEDIA
    if (this.catalogSlots.catalogReceived) return 1; // HAVE_CATALOG
    return 0; // HAVE_NOTHING
  }

  /** Human-readable label for the current readyState. */
  get readyStateLabel(): string {
    switch (this.readyState) {
      case 0: return 'HAVE_NOTHING';
      case 1: return 'HAVE_CATALOG';
      case 2: return 'HAVE_MEDIA';
      default: return 'UNKNOWN';
    }
  }

  /**
   * Aggregate stats snapshot — polled QoE metrics.
   *
   * Returns a frozen plain object. Each call reflects current state.
   * @see draft-jennings-moq-metrics-02 (informational)
   */
  get stats(): Readonly<PlayerStats> {
    // LOC timing gauges sampled at snapshot time (null on the CMAF path):
    // the live adaptive gap fuse and the render cushion actually applied
    // (same formula as recomputeVideoRenderTime — observability only).
    const gapUs = this.videoPipeline?.effectiveGapTimeoutUs;
    const locGauges = gapUs !== undefined ? {
      videoEffectiveGapTimeoutMs: gapUs / 1000, // raw adaptive fuse
      renderCushionMs: (this.getRenderCushionUs?.() ?? computePlaybackDelayUs(gapUs, this._handshakeRttMs)) / 1000,
    } : undefined;
    const ageUs = this.syncController?.captureTimestampAgeUs ?? null;
    const captureTimestampAgeMs = ageUs === null ? null : ageUs / 1000;
    let videoPlaybackQuality: PlayerStats['videoPlaybackQuality'] = null;
    try {
      const quality = this.mediaSource?.getVideoPlaybackQuality?.();
      if (quality) videoPlaybackQuality = Object.freeze({
        totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames,
        displayedVideoFrames: quality.displayedVideoFrames, creationTimeMs: quality.creationTimeMs,
      });
    } catch { /* Optional adapter measurements cannot break the stats getter. */ }
    return Object.freeze({
      ...this._stats.snapshot(locGauges),
      currentLatencyMs: captureTimestampAgeMs ?? 0,
      captureTimestampAgeMs,
      videoPlaybackQuality,
    });
  }

  /**
   * Known duration of the content in milliseconds.
   *
   * Returns `trackDuration` from the catalog for VOD content (§5.1.37),
   * or the extent of the media timeline entries for live DVR.
   * Returns `undefined` if no duration is known.
   *
   * @see draft-ietf-moq-msf-00 §5.1.37 (trackDuration)
   * @see draft-ietf-moq-msf-00 §7 (Media Timeline for live DVR extent)
   */
  get duration(): number | undefined {
    return this.timelineState ? getTimelineDuration(this.timelineState) : undefined;
  }

  /**
   * Whether seek() is available — true when timeline entries have been loaded.
   * @see draft-ietf-moq-msf-00 §7 (Media Timeline track)
   */
  get seekable(): boolean {
    return this.timelineState !== null && this.timelineState.entries.length > 0;
  }

  // ─── Track switching (§5.1.19 altGroup, §4.2 group boundaries) ───

  /** Catalog video views for selecting videoAltGroup on a new player. */
  get availableVideoGroups(): AltGroup[] {
    const tracks = this._catalogState?.tracks.filter(t => t.role === 'video' && isTrackPackagingSupported(t)) ?? [];
    return groupByAlt(tracks).groups.map(group => ({
      altGroup: group.altGroup, tracks: group.tracks.map(track => ({ ...track })),
    }));
  }

  /**
   * Available video tracks from the altGroup.
   * Sorted by bitrate descending (highest first).
   * Empty before catalog is received.
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
   */
  get availableVideoTracks(): Array<{ name: string; width?: number; height?: number; bitrate?: number; codec?: string }> {
    if (!this.qualityController) return [];
    const alts = this.qualityController.allAlternatives;
    return [...alts].map(t => defined({
      name: t.name,
      width: t.width,
      height: t.height,
      bitrate: t.bitrate,
      codec: t.codec,
    }));
  }

  /**
   * Enable or disable automatic quality switching (ABR).
   * When disabled, the player stays at the current quality until
   * selectVideoTrack() is called manually.
   */
  setAutoQuality(enabled: boolean): void {
    if (!this.qualityController) return;
    if (enabled) {
      this.qualityController.unlockAuto();
    } else {
      this.qualityController.lockManual();
    }
  }

  /**
   * Resolve a selected track's effective INLINE CMAF init segment (Base64),
   * the single source of init-source resolution for every CMAF site.
   *
   * Priority:
   *   1. `track.initData` — the MSF-00 inline init wins, unchanged.
   *   2. `track.initRef` → a root `initDataList` entry with `type:"inline"` → its
   *      `data`. This materializes the MSF-01/CMSF-01 init-by-reference form.
   *   3. otherwise `undefined` — `track.initTrack` subscription or an in-band
   *      ftyp+moov object supplies the bytes under the bootstrap deadline.
   *
   * A non-inline `initRef` target is deliberately NOT treated as inline bytes;
   * a dangling `initRef` is already rejected by the catalog parser, so the root
   * lookup here resolves or the reference simply yields no inline data.
   */
  private resolveInlineInitData(track: CatalogTrack, catalog?: CatalogState): string | undefined {
    if (track.initData !== undefined) return track.initData;
    if (track.initRef !== undefined) {
      // An initRef names an entry in the root of the catalog THIS TRACK came
      // from. A replacement's track resolved against the live catalog would
      // validate the wrong bytes — or silently pass because the live root
      // happens to carry an entry of that id — so the owning catalog is
      // explicit wherever the track is not the live session's own.
      const root = catalog ?? this._catalogState;
      const entry = root?.initDataList?.find((e) => e.id === track.initRef);
      if (entry?.type === 'inline') return entry.data;
    }
    return undefined;
  }

  /** Consecutive groups with no reconstructable chunk before a LOCMAF track is malformed (§2.4.2). */
  private static readonly LOCMAF_MAX_FAILED_GROUPS = 3;
  /** Recent groups kept in a LOCMAF track's malformed-track bookkeeping. */
  private static readonly LOCMAF_TRACKED_GROUPS = 8;

  /**
   * A LOCMAF media object: reconstruct the canonical CMAF chunk it carries and
   * feed it through the same gates and assembler as a CMAF object.
   *
   * The track's decoder sees every object that passes the init and attach
   * gates, in order, so its in-group delta reference stays exact. Objects
   * dropped before it leave a gap, which it rejects until the next full header
   * (§3): the same "resume at the next group" behaviour the CMAF gates have.
   * Video is spliced only on a chunk whose first sample is a sync sample (§10.1
   * sample flags), never on object ids.
   * @see draft-einarsson-moq-locmaf-01 §3, §9, §15, §16
   */
  private onLocmafMediaObject(mediaType: 'video' | 'audio' | 'eventtimeline', trackName: string, obj: MoqtObject, input?: ObjectRoutingContext, delivery?: ObjectDeliveryOptions): void {
    if (mediaType === 'eventtimeline') {
      this.onLocmafEventObject(trackName, obj);
      return;
    }
    // Liveness: stamp before every early return (gates, staging, drops).
    this.stampMediaArrival(BigInt(obj.trackAlias));

    this._stats.recordFirstObjectReceived();
    if (obj.kind === 'data') {
      const bytes = obj.payload ? obj.payload.byteLength : 0;
      this._stats.recordMediaObject(bytes);
      if (mediaType === 'video' && bytes > 0) {
        this.bandwidthEstimator?.recordGroup(bytes, this.clock.now());
      }
    } else {
      this._stats.recordGapObject();
    }
    this.emitter.emit('media_object', {
      type: 'media_object',
      mediaType,
      trackName,
      groupId: BigInt(obj.groupId),
      objectId: BigInt(obj.objectId),
      kind: obj.kind,
      ...(obj.kind === 'data' && obj.payload ? { payload: obj.payload } : {}),
      ...(obj.kind === 'gap' ? { status: BigInt(obj.status ?? 0n) } : {}),
    });

    if (delivery?.isLive && !delivery.isLive()) { this.discardMediaInput(input, 'route retired'); return; }
    if (this.stateMachine.state === PlayerState.PAUSED) { this.discardMediaInput(input, 'paused'); return; }
    if (obj.kind === 'gap') {
      // §16: END_OF_GROUP / END_OF_TRACK markers let the LOC pipeline advance
      // to the next group at once instead of waiting out the gap timeout.
      if (this.locmafFramePath) this.routeLocmafFrame(mediaType, trackName, obj, {}, input, delivery);
      return;
    }
    if (!obj.payload) return;

    // §9: a rawBoxes Object carries complete ISO boxes, possibly a CMAF Header.
    const rawBoxes = this.locmafRawBoxes(mediaType, trackName, obj);
    if (rawBoxes === undefined) { this.discardMediaInput(input, 'invalid media'); return; }

    // §16 frame interface: no MSE gates apply; the LOC pipeline takes the samples.
    if (this.locmafFramePath) {
      this.onLocmafFrameObject(mediaType, trackName, obj, rawBoxes, input, delivery);
      return;
    }

    // Gate: nothing reaches MSE before initialization. An in-band CMAF Header
    // (as rawBoxes) is an init source, exactly like a CMAF in-band ftyp+moov.
    if (!this.cmafInitialized) {
      const initBytes = rawBoxes ?? obj.payload;
      const initHeader = MoqtPlayer.looksLikeCmafInitSegment(initBytes);
      this.handlePreInitCmafObject(mediaType, trackName, initBytes, BigInt(obj.trackAlias));
      if (!initHeader) this.discardMediaInput(input, 'awaiting init');
      return;
    }

    // Gate: hold media while the MediaSource is not attached (see onCmafObject).
    if (this.mediaSource?.attached === false) {
      if (!this.cmafHoldingForAttach) {
        this.cmafHoldingForAttach = true;
        this.log.info('[LOCMAF] MediaSource not attached yet (sourceopen pending — hidden tab?); holding media until attached');
      }
      this.discardMediaInput(input, 'not attached');
      return;
    }

    if (this.switchInProgress && this.pendingVideoSwitch && mediaType === 'video'
        && trackName === this.pendingVideoSwitch.oldTrackName) {
      this.discardMediaInput(input, 'track superseded');
      return;
    }

    // A later in-band CMAF Header re-seeds this track's reconstruction (§6, §9.3).
    if (rawBoxes && MoqtPlayer.looksLikeCmafInitSegment(rawBoxes)) {
      this.noteLocmafInBandHeader(trackName, rawBoxes, BigInt(obj.trackAlias));
      return;
    }

    const groupId = BigInt(obj.groupId);
    const decoded = this.decodeLocmafObject(mediaType, trackName, BigInt(obj.trackAlias), groupId,
      BigInt(obj.objectId), obj.payload);
    if (!decoded) { this.discardMediaInput(input, 'invalid media'); return; }

    // Gate: video starts on a sync sample (the chunk's own sample flags).
    if (mediaType === 'video' && !this.cmafVideoSynced) {
      if (!decoded.sync) { this.discardMediaInput(input, 'awaiting keyframe'); return; }
      this.cmafVideoSynced = true;
      this.log.debug('[LOCMAF] video synced at g=%s o=%s', String(obj.groupId), String(obj.objectId));
    }

    // Make-before-break: stage the new track's chunks until a sync chunk, as for CMAF.
    if (this.pendingVideoSwitch && mediaType === 'video'
        && trackName === this.pendingVideoSwitch.newTrackName) {
      if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, decoded.bytes.byteLength)) {
        this.discardMediaInput(input, 'track superseded'); return;
      }
      this.cmafSwitchStagingBuffer.push({ trackName, mediaType, groupId, payload: decoded.bytes, sync: decoded.sync, ...(input ? { input } : {}) });
      this.armVideoSwitchTimeout(this.pendingVideoSwitch);
      if (decoded.sync) {
        this.completePendingVideoSwitch();
      }
      return;
    }

    // Early stale-group drop, as for CMAF.
    if (this.mediaSource && 'getCommittedGroupFloor' in this.mediaSource) {
      const floor = (this.mediaSource as { getCommittedGroupFloor: (mt: string, tn: string) => bigint | undefined })
        .getCommittedGroupFloor(mediaType, trackName);
      if (floor !== undefined && groupId < floor) { this.discardMediaInput(input, 'stale group'); return; }
    }

    this.pushCmafInput(mediaType, trackName, groupId, decoded.bytes, input);
  }

  /** Count reconstruction and pre-init rawBoxes validation through the same group-health policy. */
  private recordLocmafObjectResult(
    mediaType: 'video' | 'audio' | 'eventtimeline',
    trackName: string,
    trackAlias: bigint,
    groupId: bigint,
    objectId: bigint,
    error: LocmafFormatError | null,
  ): void {
    const key = this.mediaKey(trackName, mediaType, trackAlias);
    let health = this.locmafHealth.get(key);
    if (!health) {
      health = { groups: new Map(), failedGroups: 0 };
      this.locmafHealth.set(key, health);
    }
    let group = health.groups.get(groupId);
    if (!group) {
      group = { decoded: false, counted: false };
      health.groups.set(groupId, group);
      if (health.groups.size > MoqtPlayer.LOCMAF_TRACKED_GROUPS) {
        const oldest = health.groups.keys().next().value;
        if (oldest !== undefined) health.groups.delete(oldest);
      }
    }

    if (error !== null) {
      this._stats.recordLocmafObjectRejected();
      if (!this.locmafWarned.has(`rejected:${key}`)) {
        this.locmafWarned.add(`rejected:${key}`);
        this.log.warn('[LOCMAF] "%s" (%s): object g=%s o=%s rejected: %s',
          trackName, mediaType, String(groupId), String(objectId), error.message);
      }
      if (!group.decoded && !group.counted) {
        group.counted = true;
        health.failedGroups++;
        if (health.failedGroups >= MoqtPlayer.LOCMAF_MAX_FAILED_GROUPS) {
          this.locmafDecoders.delete(key);
          this.locmafDecoderInit.delete(key);
          this.locmafHealth.delete(key);
          this.handleMalformedTrack(trackAlias, trackName, error);
        }
      }
      return;
    }

    group.decoded = true;
    health.failedGroups = 0;
  }

  /**
   * Reconstruct one LOCMAF Object. Returns the CMAF bytes and whether they start
   * on a sync sample, or null when the object is rejected (counted, warned once
   * per track). A track whose last {@link LOCMAF_MAX_FAILED_GROUPS} groups each
   * produced nothing is malformed: a gap legitimately rejects the rest of its
   * group, but whole groups failing in a row means the stream cannot be decoded.
   */
  private decodeLocmafObject(
    mediaType: 'video' | 'audio' | 'eventtimeline',
    trackName: string,
    trackAlias: bigint,
    groupId: bigint,
    objectId: bigint,
    payload: Uint8Array,
  ): { bytes: Uint8Array; sync: boolean; chunk?: LocmafChunkDetails; rawError?: string } | null {
    const decoder = this.locmafDecoderFor(mediaType, trackName, trackAlias);
    if (!decoder) return null;
    const result = decoder.push(groupId, objectId, payload);
    this.recordLocmafObjectResult(mediaType, trackName, trackAlias, groupId, objectId,
      result.kind === 'rejected' ? result.error : null);
    if (result.kind === 'rejected') return null;
    if (result.kind === 'raw') {
      // rawBoxes media (§9): the chunk is carried verbatim, often because its
      // moof falls outside the LOCMAF field model. Read its samples leniently
      // (any decodable moof+mdat, not only what the encoder could have carried
      // as a header). A chunk whose samples cannot be placed has no header to
      // read sync from: fall back to the CMAF object-id rule and report why.
      try {
        const read = readCmafChunkSamples(result.bytes, decoder.context);
        const first = read.effective.flags[0];
        return {
          bytes: result.bytes,
          sync: first !== undefined && isSyncSampleFlags(first),
          chunk: {
            effective: read.effective,
            mdat: read.mdat,
            genBoxes: read.genBoxes,
            timescale: decoder.context.timescale,
            baseMediaDecodeTime: read.effective.baseMediaDecodeTime,
          },
        };
      } catch (err) {
        if (!(err instanceof LocmafFormatError)) throw err;
        return { bytes: result.bytes, sync: objectId <= 1n, rawError: err.message };
      }
    }
    return {
      bytes: result.bytes,
      sync: result.startsWithSync,
      chunk: {
        effective: result.effective,
        mdat: result.mdat,
        genBoxes: result.genBoxes,
        timescale: result.timescale,
        baseMediaDecodeTime: result.baseMediaDecodeTime,
      },
    };
  }

  /** Whether a track of this packaging plays through MSE in this player (LOCMAF may take the frame path). */
  private usesMse(packaging: string | undefined): boolean {
    return usesMsePath(packaging, this.config.locmafDecoding);
  }

  /** LOCMAF tracks are consumed through the §16 frame interface (LOC WebCodecs pipeline). */
  private get locmafFramePath(): boolean {
    return this.config.locmafDecoding === 'frame';
  }

  /**
   * The base64 init the pipelines are configured with: the catalog's inline init
   * as-is, except that a LOCMAF track on the frame path gets the codec
   * description read from its CMAF Header (§16) -- what a frame decoder takes as
   * `description`, not the whole ftyp+moov. Undefined when the Header has no
   * known codec configuration; the per-frame VideoConfig then configures video on
   * its first keyframe.
   */
  private pipelineInitData(track: CatalogTrack): string | undefined {
    if (track.packaging !== 'locmaf' || !this.locmafFramePath) return this.resolveInlineInitData(track);
    try {
      const init = this.decodeResolvedInlineInitData(track);
      const description = init ? codecDescriptionFromInit(init) : null;
      return description ? btoa(String.fromCharCode(...description)) : undefined;
    } catch {
      return undefined; // an invalid inline init was already surfaced at selection time
    }
  }

  private createSelectedPipelines(selected: {
    readonly video: CatalogTrack | null | undefined;
    readonly audio: CatalogTrack | null | undefined;
  }): void {
    this.createPipelinesFromTrackInfo({
      video: selected.video ? defined({
        codec: selected.video.codec, width: selected.video.width, height: selected.video.height,
        initData: this.pipelineInitData(selected.video), initTrack: selected.video.initTrack,
        packaging: mediaTrackPackaging(selected.video.packaging),
      }) : undefined,
      audio: selected.audio ? defined({
        codec: selected.audio.codec, samplerate: selected.audio.samplerate,
        channels: selected.audio.channelConfig ? Number(selected.audio.channelConfig) : undefined,
        initData: this.pipelineInitData(selected.audio), initTrack: selected.audio.initTrack,
        packaging: mediaTrackPackaging(selected.audio.packaging),
      }) : undefined,
      isLive: selected.video?.isLive === true || selected.audio?.isLive === true,
    });
  }

  /** The codec description of a LOCMAF track's current CMAF Header, cached per Header. */
  private locmafDescription(key: string): Uint8Array | null {
    const init = this.locmafDecoderInit.get(key);
    if (!init) return null;
    const cached = this.locmafDescriptions.get(key);
    if (cached && cached.init === init) return cached.description;
    let description: Uint8Array | null = null;
    try {
      description = codecDescriptionFromInit(init);
    } catch {
      description = null;
    }
    this.locmafDescriptions.set(key, { init, description });
    return description;
  }

  /** Next synthetic pipeline object id for `count` frames of a LOCMAF track's group. */
  private nextLocmafFrameId(key: string, groupId: bigint, count: number): bigint {
    let groups = this.locmafFrameIds.get(key);
    if (!groups) {
      groups = new Map();
      this.locmafFrameIds.set(key, groups);
    }
    const next = groups.get(groupId) ?? 0n;
    groups.set(groupId, next + BigInt(count));
    if (groups.size > MoqtPlayer.LOCMAF_TRACKED_GROUPS) {
      const oldest = groups.keys().next().value;
      if (oldest !== undefined) groups.delete(oldest);
    }
    return next;
  }

  /** Resolve switch cleanup while the retiring request still owns its identity. */
  private clearLocmafDecoderForRequest(requestId: bigint): void {
    const sub = this.activeSubscriptions.get(requestId);
    if (!sub) return;
    const key = this.mediaKey(sub.trackName, sub.mediaType, sub.trackAlias ?? undefined);
    this.locmafDecoders.delete(key);
    this.locmafDecoderInit.delete(key);
    this.locmafHealth.delete(key);
  }

  /**
   * An in-band CMAF Header on a LOCMAF track (rawBoxes, §9): remember it and
   * re-seed the decoder if it changed. A different header re-seeds
   * reconstruction; repeating the same one must not discard the in-flight
   * groups' references.
   */
  private noteLocmafInBandHeader(trackName: string, header: Uint8Array, alias?: bigint): void {
    const key = this.mediaKey(trackName, undefined, alias);
    this.initSegmentByTrack.set(key, header);
    const current = this.locmafDecoderInit.get(key);
    if (!current || !MoqtPlayer.sameBytes(current, header)) {
      this.locmafDecoders.delete(key);
      this.locmafDecoderInit.delete(key);
      this.locmafBadInit.delete(key);
      this.locmafFrameIds.delete(key);
    }
  }

  /**
   * A LOCMAF media object on the frame path (§16): reconstruct it, slice the
   * mdat payload into coded samples and push each one into the LOC pipeline as
   * its own object, in decode order, with LOC-shaped headers -- the presentation
   * time as CaptureTimestamp, the sync flag as the independent frame marking and
   * the CMAF Header's codec configuration as VideoConfig on keyframes. Protected
   * tracks are dropped: a frame decoder has no way to decrypt them.
   */
  private onLocmafFrameObject(
    mediaType: 'video' | 'audio',
    trackName: string,
    obj: MoqtObject & { kind: 'data' },
    rawBoxes: Uint8Array | null,
    input?: ObjectRoutingContext,
    delivery?: ObjectDeliveryOptions,
  ): void {
    if (rawBoxes && isCmafHeader(rawBoxes)) {
      this.noteLocmafInBandHeader(trackName, rawBoxes, BigInt(obj.trackAlias));
      return;
    }
    const key = this.mediaKey(trackName, mediaType, BigInt(obj.trackAlias));
    const groupId = BigInt(obj.groupId);
    const decoded = this.decodeLocmafObject(mediaType, trackName, BigInt(obj.trackAlias), groupId,
      BigInt(obj.objectId), obj.payload);
    if (!decoded) { this.discardMediaInput(input, 'invalid media'); return; }
    if (!decoded.chunk) {
      this._stats.recordLocmafObjectRejected();
      if (!this.locmafWarned.has(`raw:${key}`)) {
        this.locmafWarned.add(`raw:${key}`);
        this.log.warn('[LOCMAF] "%s" (%s): rawBoxes object g=%s o=%s carries no decodable chunk; dropped on the frame path: %s',
          trackName, mediaType, String(groupId), String(obj.objectId), decoded.rawError ?? 'unknown');
      }
      this.discardMediaInput(input, 'invalid media'); return;
    }
    const decoder = this.locmafDecoders.get(key);
    if (decoder?.context.isProtected) {
      if (!this.locmafWarned.has(`protected:${key}`)) {
        this.locmafWarned.add(`protected:${key}`);
        this.log.warn('[LOCMAF] "%s" (%s): protected track (%s) cannot be decrypted on the frame path — dropping objects; use locmafDecoding "mse"',
          trackName, mediaType, decoder.context.schemeType ?? 'cenc');
      }
      this.discardMediaInput(input, 'decoder policy'); return;
    }
    let frames;
    try {
      frames = sliceFrames(decoded.chunk.effective, decoded.chunk.mdat);
    } catch (err) {
      this._stats.recordLocmafObjectRejected();
      if (!this.locmafWarned.has(`frames:${key}`)) {
        this.locmafWarned.add(`frames:${key}`);
        this.log.warn('[LOCMAF] "%s" (%s): object g=%s o=%s cannot be sliced into frames: %s',
          trackName, mediaType, String(groupId), String(obj.objectId), err instanceof Error ? err.message : String(err));
      }
      this.discardMediaInput(input, 'invalid media'); return;
    }
    if (frames.length === 0) return;
    const description = mediaType === 'video' ? this.locmafDescription(key) : null;
    const timescale = decoded.chunk.timescale;
    const firstId = this.nextLocmafFrameId(key, groupId, frames.length);
    for (const frame of frames) {
      const synthetic: MoqtObject = {
        kind: 'data',
        trackAlias: obj.trackAlias,
        groupId: obj.groupId,
        subgroupId: obj.subgroupId,
        objectId: varint(firstId + BigInt(frame.index)),
        publisherPriority: obj.publisherPriority,
        payload: frame.data,
      };
      const headers: LocHeaders = {
        // CMAF presentation time is media time, never wall clock, so
        // wall-clock latency features must stay off for this path.
        captureTimestamp: ticksToMicros(frame.presentationTime, timescale),
        timestamp: frame.presentationTime,
        timescale: BigInt(timescale),
        duration: Number(ticksToMicros(BigInt(frame.duration), timescale)),
        timestampIsWallClock: false,
        ...(mediaType === 'video'
          ? {
              videoFrameMarking: {
                startOfFrame: true,
                endOfFrame: true,
                independent: frame.isSync,
                // sample_is_depended_on == 2: no other sample depends on this one.
                discardable: !frame.isSync && ((frame.flags >>> 22) & 0x3) === 2,
                baseLayerSync: false,
                temporalId: 0,
              },
              ...(frame.isSync && description ? { videoConfig: description } : {}),
            }
          : {}),
      };
      if (delivery?.isLive && !delivery.isLive()) { this.discardMediaInput(input, 'route retired'); return; }
      this.routeLocmafFrame(mediaType, trackName, synthetic, headers, input, delivery);
    }
  }

  /** Route one frame-path object like a LOC object: switch staging, old-track drop, pipeline push. */
  private routeLocmafFrame(mediaType: 'video' | 'audio', trackName: string, frame: MoqtObject, headers: LocHeaders, input?: ObjectRoutingContext, delivery?: ObjectDeliveryOptions): void {
    if (this.pendingVideoSwitch && mediaType === 'video'
        && trackName === this.pendingVideoSwitch.newTrackName) {
      if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, frame.kind === 'data' ? frame.payload.byteLength : 0)) {
        this.discardMediaInput(input, 'track superseded'); return;
      }
      this.switchStagingBuffer.push({ obj: frame, headers, ...(input ? { input } : {}) });
      this.armVideoSwitchTimeout(this.pendingVideoSwitch);
      if (headers.videoFrameMarking?.independent) {
        this.completePendingVideoSwitch();
      }
      return;
    }
    if (this.switchInProgress && this.pendingVideoSwitch
        && mediaType === 'video'
        && trackName === this.pendingVideoSwitch.oldTrackName) {
      this.discardMediaInput(input, 'track superseded'); return;
    }
    const pipeline = mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
    if (!pipeline) this.discardMediaInput(input, 'not attached');
    else if (delivery?.backfill) pipeline.pushObject(frame, headers, input, { backfill: true });
    else if (input) pipeline.pushObject(frame, headers, input);
    else pipeline.pushObject(frame, headers);
  }

  /**
   * A chunk of a LOCMAF event-only track (§14): reconstruct it for its genBoxes
   * and emit the parsed emsg boxes. The chunk carries no samples, so nothing
   * reaches a media sink; a version-0 emsg's presentation time is relative to
   * the chunk's base media decode time, which the event carries.
   */
  private onLocmafEventObject(trackName: string, obj: MoqtObject): void {
    if (obj.kind !== 'data' || !obj.payload) return;
    const rawBoxes = this.locmafRawBoxes('eventtimeline', trackName, obj);
    if (rawBoxes === undefined) return;
    if (rawBoxes && isCmafHeader(rawBoxes)) {
      this.noteLocmafInBandHeader(trackName, rawBoxes, BigInt(obj.trackAlias));
      return;
    }
    const groupId = BigInt(obj.groupId);
    const objectId = BigInt(obj.objectId);
    const decoded = this.decodeLocmafObject('eventtimeline', trackName, BigInt(obj.trackAlias), groupId, objectId, obj.payload);
    if (!decoded?.chunk) return;
    let events: EmsgEvent[];
    try {
      events = parseEmsgBoxes(decoded.chunk.genBoxes);
    } catch (err) {
      this.log.warn('[LOCMAF] "%s": emsg in g=%s o=%s does not parse: %s',
        trackName, String(groupId), String(objectId), err instanceof Error ? err.message : String(err));
      return;
    }
    this.emitter.emit('locmaf_event', {
      type: 'locmaf_event',
      trackName,
      groupId,
      objectId,
      timescale: decoded.chunk.timescale,
      baseMediaDecodeTime: decoded.chunk.baseMediaDecodeTime,
      events,
    });
  }

  /** The track's LOCMAF decoder, created from its CMAF Header on first use. */
  private locmafDecoderFor(mediaType: 'video' | 'audio' | 'eventtimeline', trackName: string, trackAlias: bigint): LocmafTrackDecoder | null {
    const key = this.mediaKey(trackName, mediaType, trackAlias);
    const existing = this.locmafDecoders.get(key);
    if (existing) return existing;
    if (this.locmafBadInit.has(key)) return null;
    const init = this.locmafInitBytes(trackName, trackAlias, mediaType);
    if (!init) {
      if (!this.locmafWarned.has(`noinit:${key}`)) {
        this.locmafWarned.add(`noinit:${key}`);
        this.log.warn('[LOCMAF] "%s" (%s): no CMAF Header to reconstruct against — dropping objects', trackName, mediaType);
      }
      return null;
    }
    try {
      const decoder = new LocmafTrackDecoder(init);
      this.locmafDecoders.set(key, decoder);
      this.locmafDecoderInit.set(key, init);
      return decoder;
    } catch (err) {
      if (err instanceof LocmafFormatError) {
        this.locmafBadInit.add(key);
        this.handleMalformedTrack(trackAlias, trackName, err);
        return null;
      }
      throw err;
    }
  }

  /**
   * CMAF Header bytes for a LOCMAF track: an in-band header seen on the track,
   * then the catalog's inline init (initData / initRef), then its init track.
   * Never another rendition's header: its timescale and trex defaults would
   * silently skew this track's durations and decode times.
   */
  private locmafInitBytes(trackName: string, alias?: bigint, mediaType?: string): Uint8Array | undefined {
    const key = this.mediaKey(trackName, mediaType, alias);
    const inBand = this.initSegmentByTrack.get(key);
    if (inBand) return inBand;
    const track = this._catalogState?.tracks.find(t => this.initKey(t) === key);
    if (track) {
      try {
        const inline = this.decodeResolvedInlineInitData(track);
        if (inline) return inline;
      } catch {
        // Invalid inline init was already surfaced at selection time.
      }
      if (track.initTrack) {
        const fromInitTrack = this.initSegmentByTrack.get(this.initKey(track, track.initTrack));
        if (fromInitTrack) return fromInitTrack;
      }
    }
    return undefined;
  }

  private static sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Validated rawBoxes (§9.1), null for another element, undefined for a rejected Object. */
  private locmafRawBoxes(
    mediaType: 'video' | 'audio' | 'eventtimeline',
    trackName: string,
    obj: MoqtObject & { kind: 'data' },
  ): Uint8Array | null | undefined {
    const payload = obj.payload;
    let elementType: bigint;
    try {
      elementType = readVi64(payload, 0).value;
    } catch {
      return null;
    }
    if (elementType !== 4n) return null;
    const groupId = BigInt(obj.groupId);
    // Even a repeated in-band Header ends this group's delta chain (§9.3).
    this.subscriptionManager?.invalidateLocmafGroup(BigInt(obj.trackAlias), groupId, this.connection);
    this.locmafDecoders.get(this.mediaKey(trackName, mediaType, BigInt(obj.trackAlias)))?.resetGroup(groupId);
    try {
      const object = deserializeLocmafObject(payload);
      return object.kind === 'rawBoxes' ? object.boxes : null;
    } catch (err) {
      if (!(err instanceof LocmafFormatError)) throw err;
      this.recordLocmafObjectResult(mediaType, trackName, BigInt(obj.trackAlias), groupId, BigInt(obj.objectId), err);
      return undefined;
    }
  }

  private decodeResolvedInlineInitData(track: CatalogTrack, catalog?: CatalogState): Uint8Array | undefined {
    const initB64 = this.resolveInlineInitData(track, catalog);
    if (initB64 === undefined) return undefined;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(initB64), (c) => c.charCodeAt(0));
    } catch {
      throw new Error('inline init data is not valid base64');
    }
    if (bytes.byteLength === 0) {
      throw new Error('inline init data decodes to zero bytes');
    }
    return bytes;
  }

  private catalogTrackFor(
    name: string, namespace: readonly string[], role?: string,
  ): CatalogTrack | undefined {
    return this._catalogState?.tracks.find(track => track.name === name
      && (role === undefined || track.role === role)
      && sameNamespaceFields(trackNamespaceFields(track, this.config.namespace), namespace));
  }

  private uniqueCatalogTrack(name: string): CatalogTrack | undefined {
    const tracks = this._catalogState?.tracks.filter(track => track.name === name) ?? [];
    if (tracks.length > 1) throw new Error(`Ambiguous track name "${name}": a namespace is required`);
    return tracks[0];
  }

  private subscribedTrack(mediaType: 'video' | 'audio'): CatalogTrack | undefined {
    for (const sub of this.activeSubscriptions.values()) {
      if (sub.mediaType !== mediaType) continue;
      if (sub.trackAlias !== null && this.supersededRouting?.aliases.has(sub.trackAlias)) continue;
      const track = this.catalogTrackFor(sub.trackName,
        sub.namespace ?? namespaceFields(this.config.namespace), mediaType);
      if (track !== undefined) return track;
    }
    return undefined;
  }

  private initKey(track: CatalogTrack, name: string = track.name): string {
    return identityKey(trackNamespaceFields(track, this.config.namespace), name);
  }

  private mediaKey(name: string, mediaType?: string, alias?: bigint): string {
    const issued = [...this.activeSubscriptions.values()].find(sub => sub.trackName === name
      && (mediaType === undefined || sub.mediaType === mediaType)
      && (alias === undefined || sub.trackAlias === alias));
    if (issued !== undefined) return identityKey(issued.namespace ?? namespaceFields(this.config.namespace), name);
    const tracks = this._catalogState?.tracks.filter(track => track.name === name
      && (mediaType === undefined || track.role === mediaType)) ?? [];
    if (tracks.length > 1) throw new Error(`Ambiguous track name "${name}": use its resolved identity`);
    return tracks[0] !== undefined ? this.initKey(tracks[0])
      : identityKey(namespaceFields(this.config.namespace), name);
  }

  private activeVideoSet(): readonly CatalogTrack[] {
    const active = this.subscribedTrack('video');
    if (!active || !this._catalogState) return [];
    const model = buildCatalogSelection(this._catalogState, { catalogNamespace: this.config.namespace });
    const resolved = resolveSelection(model, { disableAudio: true,
      videoTrack: { name: active.name, namespaceFields: trackNamespaceFields(active, this.config.namespace) } });
    return resolved.ok ? resolved.video?.set.tracks.map(track => track.track) ?? [] : [];
  }

  /**
   * Ensure init bytes for `initTrackName` are cached, lazy-subscribing
   * to the init track if necessary.
   *
   * Returns the init segment payload. Used by `selectVideoTrack` to
   * pre-fetch the new codec's init bytes before starting a switch that
   * crosses codec families — the make-before-break flow needs init in
   * hand at switch-completion time so it can call
   * `mediaSource.changeType()` synchronously between unsubscribing the
   * old track and flushing staged new-track segments.
   */
  private async ensureInitTrack(
    initTrackName: string, namespace: readonly string[] = namespaceFields(this.config.namespace),
  ): Promise<Uint8Array> {
    const connection = this.connection;
    if (!connection) throw new Error('ensureInitTrack: player not loaded');
    const key = identityKey(namespace, initTrackName);
    const cached = this.initSegmentByTrack.get(key);
    if (cached) return cached;

    // Coalesce concurrent waiters for the same init track.
    const existing = this.pendingInitTrackSubs.get(key);
    if (existing?.connection === connection) return existing.promise;
    if (existing) {
      this.pendingInitTrackSubs.delete(key);
      existing.reject(new Error('Init source session retired'));
    }

    let resolveInit!: (data: Uint8Array) => void;
    let rejectInit!: (err: Error) => void;
    const promise = new Promise<Uint8Array>((res, rej) => { resolveInit = res; rejectInit = rej; });
    // ONE shared operation: every caller (including the first) receives THIS
    // promise, and any failure settles it exactly once — so a single caller
    // cannot leave an internal rejection unobserved, and an unsettled entry
    // cannot strand later waiters. Failure also removes the entry (retry ok);
    // destroy() rejects whatever is still pending.
    this.pendingInitTrackSubs.set(key, { connection, promise, resolve: resolveInit, reject: rejectInit });
    const failInitTrack = (err: Error): void => {
      if (this.pendingInitTrackSubs.get(key)?.promise === promise) {
        this.pendingInitTrackSubs.delete(key);
      }
      rejectInit(err);
    };

    void (async () => {
      try {
        if (this.connection !== connection || !this.subscriptionManager) {
          throw new Error('ensureInitTrack: player not loaded');
        }
        const nsBytes = namespace.map(field => this.enc.encode(field));
        const nameBytes = this.enc.encode(initTrackName);
        const subscribeOptions = {
          subscriptionFilter: {
            type: 'AbsoluteStart' as const,
            startGroup: varint(0n),
            startObject: varint(0n),
          },
        };
        // Pre-send ownership (§9.10) — mediaType 'video' is a placeholder,
        // routing is driven by the 'init' packaging.
        const requestId = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, subscribeOptions, {
          trackName: initTrackName, mediaType: 'video', packaging: 'init',
        }, (id) => { this.initTrackRequestIds.set(key, id); },
        (id) => { if (this.connection === connection && this.initTrackRequestIds.get(key) === id) this.initTrackRequestIds.delete(key); });
        if (requestId === undefined) throw new Error(`Init subscription "${initTrackName}" cancelled by beforeSubscribe`);
      } catch (err) {
        failInitTrack(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return promise;
  }

  /**
   * Switch to a different video track from the altGroup.
   *
   * Keeps the current subscription while preparing target initialization
   * and independently decodable media. Commits only after reconfiguration;
   * a refused attempt restores the old source before reporting rollback.
   *
   * @param trackName Name of the video track to switch to
   * @throws If the track name is not found in the catalog
   * @see draft-ietf-moq-msf-00 §4.2 (clean switch at group boundaries)
   * @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
   */
  async selectVideoTrack(
    trackName: string,
    reason: string = 'manual',
    abrAction?: 'downshift' | 'upshift',
  ): Promise<void> {
    if (!this._catalogState || !this.connection || !this.subscriptionManager) {
      throw new Error('Cannot switch track: player not loaded');
    }
    if (this._destroyed || this.isTerminalState() || this.currentMigration?.adopting) {
      throw new Error('Cannot switch track: playback is not accepting selections');
    }
    const switchConn = this.connection;
    const generation = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState()
      && this.connection === switchConn && this.bootstrapGeneration === generation;

    const eligible = this.qualityController?.eligibleLadder(this.activeVideoSet()) ?? [];
    const candidates = eligible.filter(t => t.name === trackName);
    if (candidates.length > 1) throw new Error(`Ambiguous video track: "${trackName}"`);
    const catalogMatches = this._catalogState.tracks.filter(t => t.name === trackName && t.role === 'video');
    const targetTrack = candidates[0] ?? (catalogMatches.length === 1 ? catalogMatches[0] : undefined);
    if (!targetTrack) {
      throw new Error(`Unknown video track: "${trackName}"`);
    }
    // LOCMAF §5: a receiver MUST NOT subscribe to a locmafVersion it does not support.
    if (!isTrackPackagingSupported(targetTrack)) {
      throw new Error(
        `Cannot switch to "${trackName}": unsupported locmafVersion "${targetTrack.locmafVersion ?? ''}" (LOCMAF §5)`,
      );
    }

    // Find the current video subscription
    let currentVideoRequestId: bigint | null = null;
    let currentVideoTrackName: string | null = null;
    for (const [requestId, sub] of this.activeSubscriptions) {
      if (sub.mediaType === 'video') {
        currentVideoRequestId = requestId;
        currentVideoTrackName = sub.trackName;
        break;
      }
    }

    const currentTrack = this.subscribedTrack('video');
    if (!currentTrack) throw new Error('Cannot switch track: video selection not ready');
    if (!candidates.includes(targetTrack)) {
      throw new Error(`Cannot switch to "${trackName}": different video altGroup; select that view at tune-in with videoAltGroup`);
    }

    const pending = this.pendingVideoSwitch;
    if (pending?.newTrackName === trackName && pending.phase !== 'restoring') {
      if (reason === 'manual') this.qualityController?.lockManual();
      return;
    }
    if (this.switchInProgress || this.pendingRetypes.size > 0) {
      throw new Error('Cannot select a track while a switch is committing');
    }
    if (reason === 'manual') this.qualityController?.lockManual();
    const revision = ++this.videoSwitchRevision;
    if (pending) this.discardPendingVideoSwitch(pending, new Error('Switch superseded by a newer selection'));
    if (revision !== this.videoSwitchRevision || !live()) return;
    if (currentVideoTrackName === trackName) return;
    if (currentVideoRequestId === null) throw new Error('Cannot switch track: current video subscription is not ready');

    const targetNamespace = trackNamespaceFields(targetTrack, this.config.namespace);
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const sw: NonNullable<MoqtPlayer['pendingVideoSwitch']> = {
      connection: switchConn, generation, mediaSource: this.mediaSource,
      oldRequestId: currentVideoRequestId, oldTrackName: currentVideoTrackName ?? '',
      newTrackName: trackName, newRequestId: null, newTrackPackaging: mediaTrackPackaging(targetTrack.packaging),
      targetTrack, catalog: this._catalogState, initData: undefined, cmafContext: undefined,
      phase: 'preparing', requestReleased: false, failure: undefined, stagedBytes: 0, stagedObjects: 0, done, settle, reason,
      ...(abrAction ? { abrAction } : {}),
    };
    this.pendingVideoSwitch = sw;
    this.armVideoSwitchTimeout(sw, this.config.connectionTimeoutMs || SWITCH_STAGING_TIMEOUT_MS, true);
    this.emitQualityEvent('quality_switching', {
      type: 'quality_switching', fromTrackName: sw.oldTrackName, toTrackName: trackName, reason,
    });
    try {
      if (!this.switchIsCurrent(sw)) return;
      // Resolve each target's own header before subscribing, including
      // same-MIME targets with different track IDs or sample defaults.
      const needsCodecChange = this.usesMse(targetTrack.packaging)
          && targetTrack.codec !== undefined
          && (this.currentVideoCodec === null
              || !codecsCompatible(targetTrack.codec, this.currentVideoCodec));
      if (needsCodecChange || (this.usesMse(targetTrack.packaging)
          && (targetTrack.initData !== undefined || targetTrack.initRef !== undefined || targetTrack.initTrack !== undefined))) {
        // Resolve the inline init once (track.initData or an initRef → root inline
        // initDataList entry); fall back to an initTrack subscription otherwise.
        let inlineInit: Uint8Array | undefined;
        try {
          inlineInit = this.decodeResolvedInlineInitData(targetTrack, sw.catalog);
        } catch (err) {
          throw new Error(
            `Cannot switch to "${trackName}": ${err instanceof Error ? err.message : String(err)} for codec "${targetTrack.codec}"`,
          );
        }
        if (needsCodecChange && !inlineInit && !targetTrack.initTrack) {
          throw new Error(
            `Cannot switch to "${trackName}": catalog provides no inline init (initData/initRef) or initTrack for codec "${targetTrack.codec}"`,
          );
        }
        this.log.info('[SWITCH] prepare "%s" → "%s" (codec "%s" → "%s"): prefetching init',
          currentVideoTrackName, trackName,
          this.currentVideoCodec ?? '(unknown)', targetTrack.codec);
        if (!inlineInit && targetTrack.initTrack) {
          try {
            await this.awaitVideoSwitch(sw, this.ensureInitTrack(targetTrack.initTrack, targetNamespace));
          } catch (err) {
            this.log.warn('[SWITCH] init prefetch failed: %s',
              err instanceof Error ? err.message : String(err));
            throw err;
          }
        }
        // Inline init bytes — nothing to await.
      } else if (targetTrack.packaging === 'locmaf' && targetTrack.initTrack) {
        // LOCMAF reconstructs against the target's OWN CMAF Header (track_ID,
        // timescale, trex defaults feed durations and decode times), so even a
        // same-codec switch needs that header in hand before its objects arrive.
        // @see draft-einarsson-moq-locmaf-01 §6, §15.1
        let inlineInit: Uint8Array | undefined;
        try {
          inlineInit = this.decodeResolvedInlineInitData(targetTrack, sw.catalog);
        } catch (err) {
          throw new Error(`Cannot switch to "${trackName}": ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!inlineInit) {
          this.log.info('[SWITCH] locmaf "%s" → "%s": prefetching CMAF Header from init track "%s"',
            currentVideoTrackName, trackName, targetTrack.initTrack);
          await this.awaitVideoSwitch(sw, this.ensureInitTrack(targetTrack.initTrack, targetNamespace));
        }
      }

      if (!this.switchIsCurrent(sw)) return;
      // Readiness and installation must interpret samples against identical
      // header bytes, even if a later catalog replaces the referenced root.
      sw.initData = (this.decodeResolvedInlineInitData(targetTrack, sw.catalog)
        ?? (targetTrack.initTrack ? this.initSegmentByTrack.get(this.initKey(targetTrack, targetTrack.initTrack)) : undefined))?.slice();
      if (this.hooks.beforeSubscribe.run({ trackName, mediaType: 'video', namespace: targetNamespace }) === null) {
        this.discardPendingVideoSwitch(sw, new Error('Switch subscription declined by beforeSubscribe'));
        return;
      }
      if (!this.switchIsCurrent(sw)) return;
      const nsBytes = targetNamespace.map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(trackName);
      const currentGroup = this.videoPipeline?.currentGroupId ?? -1n;
      const nextGroup = currentGroup >= 0n ? currentGroup + 1n : undefined;
      const subscribeOptions = nextGroup !== undefined
        ? { subscriptionFilter: { type: 'AbsoluteStart' as const, startGroup: varint(nextGroup), startObject: varint(0n) } }
        : (buildSubscribeOptions(this.config) ?? defaultMediaSubscriptionFilter(targetTrack.isLive === true));
      const register = (id: bigint): void => {
        if (sw.newRequestId !== null) return;
        if (!this.switchIsCurrent(sw) || !this.subscriptionManager) throw new Error('Video switch retired before emission');
        sw.newRequestId = id;
        sw.phase = 'staging';
        this.armVideoSwitchTimeout(sw, SWITCH_STAGING_TIMEOUT_MS, true);
        this.pendingAliasBinds.add(id);
        this.activeSubscriptions.set(id, { trackName, mediaType: 'video', trackAlias: null, namespace: targetNamespace });
        this.pendingMediaSubs.set(id, { trackName, mediaType: 'video', packaging: sw.newTrackPackaging });
      };
      const sending = switchConn.subscribe(nsBytes, nameBytes,
        { ...subscribeOptions, ...this.mediaTerminalOptions(switchConn), onRequestId: (id: bigint) => register(BigInt(id)) } as never,
      ).then(id => {
        const requestId = BigInt(id);
        if (sw.phase !== 'committed' && !this.switchIsCurrent(sw)) {
          sw.newRequestId ??= requestId;
          this.retireVideoSwitchTarget(sw);
        }
        return requestId;
      });
      const requestId = await this.awaitVideoSwitch(sw, sending);
      if (requestId === undefined || sw.phase === 'committed') return;
      if (!this.switchIsCurrent(sw)) return;
      register(requestId);
    } catch (error) {
      if (this.switchIsCurrent(sw)) this.abortPendingVideoSwitch(sw, error instanceof Error ? error : new Error(String(error)));
      if (sw.phase !== 'committed') throw error;
    }
  }

  private emitQualityEvent<K extends 'quality_switching' | 'quality_switched' | 'quality_switch_failed'>(event: K, data: PlayerEventMap[K]): void {
    try { this.emitter.emitIsolated(event, data); }
    catch (error) {
      try { this.log.warn('Quality observer failed for %s: %s', event, error instanceof Error ? error.message : String(error)); }
      catch { /* An observer cannot revoke completed playback state. */ }
    }
  }

  private armVideoSwitchTimeout(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, ms = SWITCH_STAGING_TIMEOUT_MS, replace = false): void {
    if (this.switchStagingTimeout !== null) {
      if (!replace) return;
      clearTimeout(this.switchStagingTimeout);
    }
    const timer = setTimeout(() => {
      if (this.switchStagingTimeout !== timer) return;
      this.switchStagingTimeout = null;
      if (this.pendingVideoSwitch !== sw) return;
      if (this.pendingRetypes.get('video')?.owner === sw) {
        this.failCatalogPlayback(createPlayerError('fatal', 'player', PlayerErrorCode.CMAF_INIT_INVALID,
          'Video reconfiguration did not settle before its deadline'));
      } else this.abortPendingVideoSwitch(sw, new Error('Video switch deadline elapsed without a usable target'));
    }, Math.min(ms, 0x7fffffff));
    this.switchStagingTimeout = timer;
  }

  private admitVideoSwitchObject(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, bytes: number): boolean {
    if (!this.switchIsCurrent(sw)) return false;
    if (sw.stagedObjects >= SWITCH_STAGING_MAX_OBJECTS || bytes > MoqtPlayer.MAX_STAGED_BYTES - sw.stagedBytes) {
      this.abortPendingVideoSwitch(sw, new Error('Video switch staging capacity exhausted'));
      return false;
    }
    sw.stagedObjects++;
    sw.stagedBytes += bytes;
    return true;
  }

  /** A retired attempt cannot keep its caller waiting on an unrelated late promise. */
  private async awaitVideoSwitch<T>(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, work: Promise<T>): Promise<T | undefined> {
    const result = await Promise.race([
      work.then(value => ({ value })),
      sw.done.then(() => null),
    ]);
    if (result === null && sw.phase !== 'committed') throw sw.failure ?? new Error('Video switch retired');
    return result === null ? undefined : result.value;
  }

  private retireVideoSwitchTarget(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>): void {
    if (sw.newRequestId === null || sw.requestReleased) return;
    sw.requestReleased = true;
    if (sw.connection === this.connection) this.clearLocmafDecoderForRequest(sw.newRequestId);
    this.retireMediaSubscription(sw.newRequestId, sw.connection);
    void sw.connection.unsubscribe(sw.newRequestId).catch(() => {});
  }

  /**
   * Complete a pending make-before-break video track switch.
   *
   * Called once independently decodable target data is staged. Source
   * reconfiguration and staged replay finish before the switch is reported;
   * expiry or retention refusal restores the old track before reporting
   * rollback. A failure after irreversible commitment is terminal.
   *
   * The renderer's FIFO queue ensures old frames play out before new frames.
   */
  private completePendingVideoSwitch(): void {
    // A second target keyframe cannot start another source mutation while
    // the first is pending; later target objects stay in the bounded stage.
    if (this.switchInProgress) return;
    const sw = this.pendingVideoSwitch;
    if (!sw || sw.newRequestId === null || !this.switchIsCurrent(sw)) return;
    sw.phase = 'committing';
    this.switchInProgress = true;

    this.armVideoSwitchTimeout(sw, this.config.connectionTimeoutMs || SWITCH_STAGING_TIMEOUT_MS, true);

    if (!this.connection || !this.subscriptionManager) {
      this.pendingVideoSwitch = null;
      this.switchInProgress = false;
      this.discardLocStaging('decoder reset');
      this.discardCmafStaging('decoder reset');
      return;
    }

    const issued = sw.newRequestId === null ? undefined : this.activeSubscriptions.get(sw.newRequestId);
    const newTrack = issued === undefined ? undefined : this.catalogTrackFor(sw.newTrackName,
      issued.namespace ?? namespaceFields(this.config.namespace), 'video');
    if (!newTrack || mediaTrackPackaging(newTrack.packaging) !== sw.newTrackPackaging
        || newTrack.codec !== sw.targetTrack.codec) {
      this.abortPendingVideoSwitch(sw, new Error('Video switch target configuration changed'));
      return;
    }

    if (newTrack && this.usesMse(newTrack.packaging)) {
      if (!this.cmafSwitchStagingBuffer.some(entry => entry.sync)) {
        this.abortPendingVideoSwitch(sw, new Error('No independently decodable target sample arrived'));
        return;
      }
      try {
        this.validateVideoSwitchInit(sw, newTrack);
      } catch (error) {
        this.abortPendingVideoSwitch(sw, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const codecChanged = this.currentVideoCodec === null
        || !codecsCompatible(newTrack.codec ?? '', this.currentVideoCodec);
      if (codecChanged && sw.initData === undefined) {
        this.abortPendingVideoSwitch(sw, new Error(`Cannot switch to "${newTrack.name}": init bytes missing for codec "${newTrack.codec ?? ''}"`));
        return;
      }
      void this.completeMseVideoSwitch(sw, newTrack, sw.initData);
      return;
    }

    if (!this.switchStagingBuffer.some(entry => entry.obj.kind === 'data'
        && (entry.headers?.videoFrameMarking?.independent ?? BigInt(entry.obj.objectId) === 0n))) {
      this.abortPendingVideoSwitch(sw, new Error('No independently decodable target frame arrived'));
      return;
    }
    this.unsubscribeOldVideoTrack(sw);

    // Find the keyframe group ID for resetForTrackSwitch — use the
    // group that contains objectId=0, not the first staged object
    // (which might be a partial group from a mid-stream subscription).
    const keyframeEntry = this.switchStagingBuffer.find(
      s => s.obj.kind === 'data' && (s.headers?.videoFrameMarking?.independent ?? BigInt(s.obj.objectId) === 0n),
    );
    const firstGroupId = keyframeEntry
      ? BigInt(keyframeEntry.obj.groupId)
      : (this.switchStagingBuffer.length > 0
        ? BigInt(this.switchStagingBuffer[0]!.obj.groupId)
        : 0n);

    // Reset pipeline jitter buffer for new track
    this.videoPipeline?.resetForTrackSwitch(firstGroupId);

    // Reconfigure pipeline + decoder with new track's codec/initData.
    // The flush-before-reconfigure in WebCodecsVideoDecoder.configure()
    // pushes old decoder's pending frames to the renderer queue first.
    if (newTrack && this.videoPipeline) {
      this.commandDispatcher?.updateVideoCodec(
        newTrack.codec ?? '', newTrack.width, newTrack.height,
      );
      const trackInfo: TrackInfo = {
        video: defined({
          codec: newTrack.codec ?? '',
          initData: this.pipelineInitData(newTrack),
          width: newTrack.width,
          height: newTrack.height,
        }),
        audio: undefined,
      };
      configurePipelines(
        {
          videoPipeline: this.videoPipeline,
          audioPipeline: null,
          syncController: this.syncController!,
          recoveryController: this.recoveryController!,
          commandDispatcher: this.commandDispatcher!,
          mediaSource: null,
        },
        trackInfo,
      );
    }

    // Feed staged objects to pipeline, starting from the keyframe.
    // Drop any pre-keyframe objects: a mid-stream subscription can
    // deliver the tail of group G before the keyframe of group G+1.
    // Those tail P-frames have no reference in the new decoder and
    // would cause decode errors.
    const staged = this.switchStagingBuffer;
    this.switchStagingBuffer = [];
    const keyframeIdx = staged.findIndex(s => s.obj.kind === 'data' && (s.headers?.videoFrameMarking?.independent ?? BigInt(s.obj.objectId) === 0n));
    const toFlush = keyframeIdx >= 0 ? staged.slice(keyframeIdx) : staged;
    for (const entry of keyframeIdx > 0 ? staged.slice(0, keyframeIdx) : []) this.discardMediaInput(entry.input, 'awaiting keyframe');
    for (const { obj: stagedObj, headers: stagedHeaders, input } of toFlush) {
      if (!this.videoPipeline) this.discardMediaInput(input, 'not attached');
      else if (input) this.videoPipeline.pushObject(stagedObj, stagedHeaders, input);
      else this.videoPipeline.pushObject(stagedObj, stagedHeaders);
    }

    this.flushCmafStagedBuffer(sw);

    // Re-anchor A/V sync from the new track's first frame. Without this,
    // the sync controller keeps the old track's timing reference, and the
    // keyframe wait gap (decoder in NEEDS_KEYFRAME, audio keeps playing)
    // becomes a permanent A/V offset.
    this.syncController?.reset();

    this.log.info('[SWITCH] complete (sync): "%s" → "%s" (LOC staged=%d, firstGroup=%s)',
      sw.oldTrackName, sw.newTrackName, staged.length, firstGroupId);
  }

  private cmafSwitchSync(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, payload: Uint8Array): boolean | undefined {
    if (sw.cmafContext === undefined) {
      try {
        sw.cmafContext = sw.initData === undefined ? null : parseLocmafTrackContext(sw.initData);
      } catch { sw.cmafContext = null; }
    }
    if (sw.cmafContext === null) return undefined;
    try {
      const samples = readCmafChunkSamples(payload, sw.cmafContext).effective;
      return samples.flags.length ? isSyncSampleFlags(samples.flags[0]!) : undefined;
    } catch { return undefined; }
  }

  private validateVideoSwitchInit(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, track: CatalogTrack): void {
    const current = this.decodeResolvedInlineInitData(track)
      ?? (track.initTrack ? this.initSegmentByTrack.get(this.initKey(track, track.initTrack)) : undefined);
    if (sw.initData === undefined ? current !== undefined : current === undefined || !bytesEqual(sw.initData, current)) {
      throw new Error('Video switch target initialization changed during preparation');
    }
  }

  private switchIsCurrent(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>): boolean {
    return this.pendingVideoSwitch === sw && sw.phase !== 'retired' && sw.phase !== 'committed' && sw.phase !== 'restoring'
      && !this._destroyed && !this.isTerminalState()
      && this.connection === sw.connection && this.bootstrapGeneration === sw.generation
      && this.mediaSource === sw.mediaSource;
  }

  /** The handover and rendition paths share the same mutation owner and undo. */
  private async completeMseVideoSwitch(
    sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, track: CatalogTrack, initData: Uint8Array | undefined,
  ): Promise<void> {
    const source = sw.mediaSource;
    const assembler = this.cmafAssembler;
    const previous = this.runningInitBytes('video');
    const previousCodec = this.currentVideoCodec ?? '';
    let assemblerChanged = false;
    let committed = false;
    try {
      if (!this.switchIsCurrent(sw)) return;
      if (initData !== undefined) {
        if (source?.changeType) {
          if (previous === undefined) throw new Error('Cannot reconfigure video without its running initialization');
          const offset = source.getTimestampOffset?.('video');
          if (!this.switchIsCurrent(sw)) return;
          await this.applyMediaRetype(sw, { source, mediaType: 'video', codec: track.codec ?? '', next: initData,
            previousCodec, previous, offset });
        } else if (previous === undefined || !bytesEqual(previous, initData)
            || !codecsCompatible(previousCodec, track.codec ?? '')) {
          throw new Error('Media source cannot reconfigure the video initialization');
        }
      }
      if (!this.switchIsCurrent(sw)) {
        await this.restorePendingRetypes(sw);
        if (this.pendingVideoSwitch === sw) this.abortPendingVideoSwitch(sw, sw.failure ?? new Error('Video switch retired'));
        return;
      }
      const current = this.catalogTrackFor(sw.newTrackName,
        trackNamespaceFields(sw.targetTrack, this.config.namespace), 'video');
      if (!current || current.codec !== sw.targetTrack.codec
          || mediaTrackPackaging(current.packaging) !== sw.newTrackPackaging) {
        throw new Error('Video switch target configuration changed');
      }
      this.validateVideoSwitchInit(sw, current);
      assemblerChanged = true;
      assembler?.selectTrack?.('video', sw.newTrackName);
      if (initData !== undefined) assembler?.setInitSegment?.('video', initData);
      if (!this.switchIsCurrent(sw)) throw new Error('Video switch retired during initialization');
      const record = this.pendingRetypes.get('video');
      if (record?.owner === sw) {
        this.pendingRetypes.delete('video');
        this.retypingMedia.delete('video');
      }
      // Retiring the old request and appending target media are irreversible.
      // A later replay failure is terminal; it cannot promise old playback.
      committed = true;
      if (initData !== undefined && source) this.installedCmafInit.set('video', { source, bytes: initData.slice() });
      this.unsubscribeOldVideoTrack(sw);
      this.currentVideoCodec = track.codec ?? null;
      this.flushCmafStagedBuffer(sw);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (committed) {
        this.failCatalogPlayback(createPlayerError('fatal', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
          'Video switch failed after retiring the previous rendition', { cause }));
        return;
      }
      if (assemblerChanged && !this._destroyed && assembler === this.cmafAssembler) {
        try {
          assembler?.selectTrack?.('video', sw.oldTrackName);
          if (previous !== undefined) assembler?.setInitSegment?.('video', previous);
        } catch (restoreError) {
          this.failCatalogPlayback(createPlayerError('fatal', 'player', PlayerErrorCode.CMAF_INIT_INVALID,
            'Could not restore the video assembler after reconfiguration',
            restoreError instanceof Error ? { cause: restoreError } : {}));
        }
      }
      await this.restorePendingRetypes(sw);
      if (this.switchIsCurrent(sw) || (this.pendingVideoSwitch === sw && sw.phase === 'restoring')) {
        this.abortPendingVideoSwitch(sw, sw.failure ?? cause);
      } else if (this.pendingVideoSwitch === sw) {
        this.pendingVideoSwitch = null;
        this.switchInProgress = false;
        this.discardLocStaging('decoder reset');
        this.discardCmafStaging('decoder reset');
      }
    }
  }

  /**
   * Tear down the OLD track from a pending switch. Used by the
   * success paths (sync LOC/CMAF-same-codec, async CMAF-change after
   * `mediaSource.changeType` resolves).
   */
  private unsubscribeOldVideoTrack(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>): void {
    if (!this.switchIsCurrent(sw) || !this.subscriptionManager) return;
    this.clearLocmafDecoderForRequest(sw.oldRequestId);
    this.retireMediaSubscription(sw.oldRequestId, sw.connection);
    void sw.connection.unsubscribe(sw.oldRequestId).catch(() => {});
  }

  /**
   * Flush the CMAF staging buffer through the assembler in arrival
   * order — keyframe first, then any P-frames that piled up while
   * `changeType` was in flight. Releases the switch gate at the end.
   */
  private discardLocStaging(reason: MediaDiscardReason): void {
    const dropped = this.switchStagingBuffer;
    this.switchStagingBuffer = [];
    for (const entry of dropped) this.discardMediaInput(entry.input, reason);
  }

  private discardCmafStaging(reason: ObjectRoutingDiscardReason): void {
    const dropped = this.cmafSwitchStagingBuffer;
    this.cmafSwitchStagingBuffer = [];
    for (const entry of dropped) this.discardMediaInput(entry.input, reason);
  }

  private flushCmafStagedBuffer(
    sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>,
  ): void {
    if (!this.switchIsCurrent(sw)) return;
    // The replacement is now authoritative. Pin it before replaying staged
    // bytes so a late object from the retired stream cannot switch the
    // assembler back after this commit.
    this.cmafAssembler?.selectTrack?.('video', sw.newTrackName);
    if (!this.switchIsCurrent(sw)) return;
    const staged = this.cmafSwitchStagingBuffer;
    this.cmafSwitchStagingBuffer = [];
    const firstSync = staged.findIndex(entry => entry.sync);
    const cmafStaged = firstSync < 0 ? [] : staged.slice(firstSync);
    for (const entry of firstSync < 0 ? staged : staged.slice(0, firstSync)) this.discardMediaInput(entry.input, 'awaiting keyframe');
    let replayed = 0;
    try {
      for (const { trackName: stagedTrack, mediaType: stagedMt, groupId, payload, input } of cmafStaged) {
        if (!this.switchIsCurrent(sw)) break;
        this.pushCmafInput(stagedMt, stagedTrack, groupId, payload, input);
        replayed++;
      }
    } finally {
      // A callback may destroy playback or throw during replay. The local
      // batch still owns inputs that never reached the assembler.
      for (const entry of cmafStaged.slice(replayed)) this.discardMediaInput(entry.input, 'object processing failed');
    }
    if (!this.switchIsCurrent(sw)) return;
    if (cmafStaged.length > 0) {
      this.log.info('[SWITCH] CMAF flush: "%s" → "%s" (staged=%d)',
        sw.oldTrackName, sw.newTrackName, cmafStaged.length);
    }
    sw.phase = 'committed';
    sw.settle();
    if (this.switchStagingTimeout !== null) {
      clearTimeout(this.switchStagingTimeout);
      this.switchStagingTimeout = null;
    }
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;

    // Switch is now committed — commit controllers, record stat, fire event.
    // All mutation is deferred to this point. ABR/recovery initiation paths
    // use non-mutating peeks so abort leaves state unchanged.
    const issued = sw.newRequestId === null ? undefined : this.activeSubscriptions.get(sw.newRequestId);
    const newTrack = issued === undefined ? undefined : this.catalogTrackFor(sw.newTrackName,
      issued.namespace ?? namespaceFields(this.config.namespace), 'video');
    if (newTrack) {
      this._stats.recordQualitySwitch(defined({
        codec: newTrack.codec,
        bitrate: newTrack.bitrate,
        width: newTrack.width,
        height: newTrack.height,
      }));
    }
    // Commit QualityController to the new track index.
    if (newTrack && this._catalogState && this.qualityController) {
      const wasAuto = this.qualityController.isAutoQuality;
      composeSelection(this._catalogState, {
        catalogNamespace: this.config.namespace, controller: this.qualityController,
        intent: { videoTrack: { name: newTrack.name,
          namespaceFields: trackNamespaceFields(newTrack, this.config.namespace) }, disableAudio: true },
      });
      if (wasAuto) this.qualityController.unlockAuto();
      this.qualityController.commitVideoTrackRef(newTrack);
    }
    this.syncBufferAbrController();
    this.emitQualityEvent('quality_switched', {
      type: 'quality_switched',
      fromTrackName: sw.oldTrackName,
      toTrackName: sw.newTrackName,
      reason: sw.reason,
    });
  }

  /**
   * Roll back a pending switch when the codec pivot can't proceed
   * (changeType rejected, or init bytes missing). The old track stays
   * subscribed and continues feeding the (still-correctly-typed)
   * SourceBuffer; the new track is unsubscribed; staged bytes are
   * discarded; an error event surfaces to the application.
   */
  private discardPendingVideoSwitch(
    sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, cause: Error,
  ): boolean {
    if (sw.phase === 'retired' || sw.phase === 'committed') return false;
    sw.phase = 'retired';
    sw.failure = cause;
    sw.settle();
    this.retireVideoSwitchTarget(sw);
    if (this.pendingVideoSwitch !== sw) return false;
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;
    if (this.switchStagingTimeout !== null) {
      clearTimeout(this.switchStagingTimeout);
      this.switchStagingTimeout = null;
    }
    this.discardLocStaging('track superseded');
    this.discardCmafStaging('track superseded');
    if (!this._destroyed && !this.isTerminalState()) this.emitQualityEvent('quality_switch_failed', {
      type: 'quality_switch_failed', fromTrackName: sw.oldTrackName, toTrackName: sw.newTrackName,
      reason: sw.reason, error: cause,
    });
    return true;
  }

  private abortPendingVideoSwitch(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, cause: Error): void {
    if (this.pendingVideoSwitch === sw && this.pendingRetypes.get('video')?.owner === sw) {
      sw.phase = 'restoring';
      sw.failure = cause;
      sw.settle();
      this.retireVideoSwitchTarget(sw);
      this.discardLocStaging('track superseded');
      this.discardCmafStaging('track superseded');
      return;
    }
    if (!this.discardPendingVideoSwitch(sw, cause) || this._destroyed || this.isTerminalState()) return;
    this.emitError(createPlayerError(
      'degraded', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
      `Track switch to "${sw.newTrackName}" failed: ${cause.message}`,
      { cause, context: { newTrackName: sw.newTrackName, oldTrackName: sw.oldTrackName } },
    ));
  }

  // ─── Event API ──────────────────────────────────────────

  /**
   * Register an event listener.
   * @returns Unsubscribe function.
   */
  on<K extends keyof PlayerEventMap>(
    event: K,
    fn: (data: PlayerEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, fn);
  }

  /** Remove a specific event listener. */
  off<K extends keyof PlayerEventMap>(
    event: K,
    fn: (data: PlayerEventMap[K]) => void,
  ): void {
    this.emitter.off(event, fn);
  }

  /** Explicit optional media-stage observation; no implementation is imported by default. */
  observeMediaStages(listener: MediaStageObserver, options?: { createTracker?: MediaDiagnosticsFactory }): () => void {
    if (this._destroyed) return () => {};
    if (!this.mediaStageObservers) {
      const player = this;
      this.mediaStageObservers = new MediaStageObservers({
        get currentConnection() { return player.connection; },
        observeConnections: observer => player.observeConnections(observer),
      }, runtime => {
        const previous = this.mediaDiagnosticRuntime;
        this.mediaDiagnosticRuntime = runtime;
        if (this.subscriptionManager && (runtime || this.subscriptionManager.objectProvenance === previous)) {
          this.subscriptionManager.objectProvenance = runtime ?? null;
        }
        this.bindLocDiagnostics(runtime);
        runtime?.bindMediaSource(this.mediaSource);
      });
    }
    return this.mediaStageObservers.observe(listener, options?.createTracker);
  }

  /** Capability disclosure is pulled only by explicitly installed diagnostic tooling. */
  get mediaStageCapabilities(): readonly ('cmaf-append-stages' | 'loc-video-stages' | 'loc-audio-stages')[] {
    return ['cmaf-append-stages', 'loc-video-stages', 'loc-audio-stages'];
  }

  private bindLocDiagnostics(runtime: MediaDiagnosticRuntime | undefined): void {
    let binding = this.locDiagnosticBindings;
    if (binding && binding.runtime !== runtime) {
      this.locDiagnosticBindings = undefined;
      for (const pipeline of binding.pipelines) if (pipeline.inputObserver === binding.input) pipeline.inputObserver = undefined;
      if (binding.dispatcher) binding.dispatcher.outputObserver = undefined;
      binding = undefined;
    }
    if (!runtime) return;
    if (!binding) {
      binding = { runtime, pipelines: [], dispatcher: null, refused: 0,
        input: (input, reason) => runtime.discarded(input, reason),
        output: { decoded: (kind, input, target) => runtime.decoded(kind, input, target),
          discarded: (unit, reason) => runtime.discardUnit(unit, reason) },
      };
      this.locDiagnosticBindings = binding;
    }
    const pipelines = [this.videoPipeline, this.audioPipeline].filter((pipeline): pipeline is PlaybackPipeline => pipeline !== null);
    for (const previous of binding.pipelines) if (!pipelines.includes(previous)) {
      binding.refused += previous.inputEvidenceLossCount;
      if (previous.inputObserver === binding.input) previous.inputObserver = undefined;
    }
    for (const pipeline of pipelines) if (!binding.pipelines.includes(pipeline)) pipeline.inputObserver = binding.input;
    binding.pipelines = pipelines;
    // Pipelines are created once. Codec switches reuse the dispatcher; bind
    // at first creation or late installation, never detach a still-live owner.
    if (binding.dispatcher === null && this.commandDispatcher !== null) {
      binding.dispatcher = this.commandDispatcher;
      binding.dispatcher.outputObserver = binding.output;
    }
  }

  private discardMediaInput(input: ObjectRoutingContext | undefined, reason: MediaDiscardReason): void {
    if (!input) return;
    try { const pending = this.mediaDiagnosticRuntime?.discarded(input, reason); if (pending) void Promise.resolve(pending).catch(() => {}); }
    catch { /* Optional outcomes must not affect playback. */ }
  }

  private pushCmafInput(mediaType: 'video' | 'audio', trackName: string, groupId: bigint, payload: Uint8Array, input?: ObjectRoutingContext): void {
    if (input === undefined) this.cmafAssembler?.push(mediaType, trackName, groupId, payload);
    else this.cmafAssembler?.push(mediaType, trackName, groupId, payload, input);
  }

  /** On-demand copied metadata for optional tooling; never retains media or credentials. */
  diagnosticSnapshot(): PlayerDiagnosticSnapshot {
    const connections: PlayerDiagnosticConnection[] = [];
    const add = (connection: MoqtConnection | null | undefined, endpoint: string | undefined) => {
      if (!connection || connections.some(c => c.connection === connection)) return;
      let shown: PlayerDiagnosticConnection['endpoint'] = null;
      if (endpoint !== undefined) {
        try { const url = new URL(endpoint); shown = { origin: `${url.protocol}//${url.host}`, path: url.pathname }; }
        catch { /* An unknown destination stays unavailable. */ }
      }
      connections.push({ connection, endpoint: shown });
    };
    add(this.connection, this.activeEndpoint);
    add(this.currentMigration?.conn, this.currentMigration?.target);
    add(this.supersededRouting?.conn, undefined);
    const tracks = (this._catalogState?.tracks ?? []).map(track => ({
      namespace: [...trackNamespaceFields(track, this.config.namespace)], name: track.name,
      mediaType: track.role ?? null, codec: track.codec ?? null, packaging: track.packaging ?? null,
    }));
    const subscriptions: PlayerDiagnosticSnapshot['subscriptions'][number][] = [];
    for (const [requestId, sub] of this.activeSubscriptions) {
      const connection = sub.trackAlias !== null && this.supersededRouting?.aliases.has(sub.trackAlias)
        ? this.supersededRouting.conn : this.connection;
      if (connection) subscriptions.push({ connection, requestId, trackAlias: sub.trackAlias,
        namespace: [...(sub.namespace ?? namespaceFields(this.config.namespace))], name: sub.trackName, mediaType: sub.mediaType });
    }
    const candidate = this.currentMigration;
    if (candidate && !candidate.committed) for (const [requestId, sub] of candidate.prep?.media ?? []) {
      subscriptions.push({ connection: candidate.conn, requestId, trackAlias: sub.alias,
        namespace: [...sub.namespace], name: sub.trackName, mediaType: sub.mediaType });
    }
    let mediaStages: PlayerDiagnosticSnapshot['mediaStages'];
    const runtime = this.mediaDiagnosticRuntime;
    if (runtime) try { mediaStages = { evidenceLossCount: runtime.evidenceLossCount, unobservableAppendCount: runtime.unobservableAppendCount, unattributedInputCount: runtime.unattributedInputCount,
      decodedVideoCount: this.commandDispatcher?.canObserveDecodedOutputs('video') ? runtime.decodedVideoCount : null,
      decodedAudioCount: this.commandDispatcher?.canObserveDecodedOutputs('audio') ? runtime.decodedAudioCount : null,
      unobservableVideoCount: runtime.unobservableVideoCount, unobservableAudioCount: runtime.unobservableAudioCount,
      refusedReconstructionCount: runtime.refusedReconstructionCount, refusedVideoCount: runtime.refusedVideoCount, refusedAudioCount: runtime.refusedAudioCount,
      inputAdmissionRefusalCount: (this.locDiagnosticBindings?.refused ?? 0)
        + (this.locDiagnosticBindings?.pipelines.reduce((sum, pipeline) => sum + pipeline.inputEvidenceLossCount, 0) ?? 0),
    }; }
    catch { /* A faulty custom diagnostics getter cannot break a player snapshot. */ }
    return { destroyed: this._destroyed, state: this.state, connections, tracks, subscriptions, ...(mediaStages ? { mediaStages } : {}) };
  }

  /**
   * Observe connection ownership without replacing playback callbacks. A late
   * listener receives current handles, not invented startup history. Nothing
   * is sampled or retained unless the application installs optional tooling.
   */
  observeConnections(listener: (event: PlayerConnectionObservation) => void | Promise<void>): () => void {
    if (typeof listener !== 'function') throw new TypeError('Expected a connection observer');
    if (this._destroyed) return () => {};
    const listeners = this.diagnosticConnectionListeners ??= new Map();
    const known = listeners.get(listener) ?? new Set<MoqtConnection>();
    listeners.set(listener, known);
    for (const current of this.diagnosticSnapshot().connections) {
      if (listeners.get(listener) === known && !known.has(current.connection)) {
        known.add(current.connection);
        this.deliverConnectionObservation(listener, { kind: 'available', ...current });
      }
    }
    return () => {
      listeners.delete(listener);
      if (this.diagnosticConnectionListeners === listeners && listeners.size === 0) this.diagnosticConnectionListeners = undefined;
    };
  }

  private deliverConnectionObservation(listener: (event: PlayerConnectionObservation) => void | Promise<void>, event: PlayerConnectionObservation): void {
    try { const pending = listener(event); if (pending) void Promise.resolve(pending).catch(() => {}); }
    catch { /* Optional observation must not affect playback. */ }
  }

  private notifyConnectionObservation(kind: 'available' | 'retired', connection: MoqtConnection): void {
    const listeners = this.diagnosticConnectionListeners;
    if (!listeners) return;
    for (const [listener, known] of [...listeners]) {
      if (listeners.get(listener) !== known) continue;
      if (kind === 'retired') {
        if (known.delete(connection)) this.deliverConnectionObservation(listener, { kind, connection });
      }
      else {
        const current = this.diagnosticSnapshot().connections.find(c => c.connection === connection);
        if (current && !known.has(connection)) {
          known.add(connection);
          this.deliverConnectionObservation(listener, { kind, ...current });
        }
      }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /**
   * Connect to the relay and subscribe to the catalog.
   *
   * Sequence:
   * 1. Create adapter
   * 2. Connect (CLIENT_SETUP → SERVER_SETUP)
   * 3. Wire adapter callbacks
   * 4. Subscribe to catalog track
   *
   * @see draft-ietf-moq-transport-16 §3.3 (CLIENT_SETUP)
   * @see draft-ietf-moq-msf-00 §9.1 (catalog before media)
   * @see draft-ietf-moq-msf-00 §5.1.10 (catalog track name = "catalog")
   */
  async load(): Promise<void> {
    this.transitionState(PlayerState.LOADING);
    this._stats.recordLoadStart();
    this.log.info('Connecting to %s', this.config.url);

    this.emitter.emit('session_connecting', {
      type: 'session_connecting',
      url: this.config.url,
    });

    // Create or use externally owned connection
    let conn: MoqtConnection;
    if (this.config.connection) {
      conn = this.config.connection;
      this._adapterOwned = false;
    } else {
      conn = this.config.createConnection
        ? this.config.createConnection()
        : this.createDefaultConnection();
      this._adapterOwned = true;
    }
    this.connection = conn;

    // Wire connection callbacks before connect
    this.wireConnection(conn);
    if (this._destroyed || this.connection !== conn) {
      throw new Error('Player destroyed during connection observation');
    }

    // Initialize managers
    this.catalogSlots.catalogManager = new CatalogManager(this.config.namespace);
    this.qualityController = new QualityController({
      autoQuality: this.config.autoQuality!,
      startLevel: this.config.startLevel!,
      ...(this.config.capLevelToResolution ? { capLevelToResolution: this.config.capLevelToResolution } : {}),
      qualitySwitchCooldownMs: this.config.qualitySwitchCooldownMs!,
      clock: this.clock,
    });
    this.subscriptionManager = new SubscriptionManager();
    if (this.mediaDiagnosticRuntime) this.subscriptionManager.objectProvenance = this.mediaDiagnosticRuntime;
    this.bandwidthEstimator = new BandwidthEstimator();

    // Set draft version for version-aware KVP encoding
    // Draft-14 §1.4.2: absolute type IDs
    // Draft-16 §1.4.2: delta-encoded type IDs
    if (this.config.draftVersion) {
      this.subscriptionManager.draftVersion = this.config.draftVersion;
    }

    // Apply object transform from config
    // Ownership has to survive the await inside an async object transform: a
    // transform that began before a handover can resolve after the replacement
    // has been adopted and the old session retired, and its bytes belong to
    // neither. `sourceConnection` is the connection the object arrived on
    // (routeObject types it `unknown` so the manager stays adapter-agnostic).
    this.subscriptionManager.routeStillValid = (source, alias) =>
      source === undefined || source === null
        ? true
        : this.mediaRouteBelongsTo(source as MoqtConnection, alias);
    if (this.config.objectTransform) {
      this.subscriptionManager.objectTransform = this.config.objectTransform;
    }

    // Apply custom extension parser from config (e.g., non-LOC relay interop)
    if (this.config.extensionParser) {
      this.subscriptionManager.extensionParser = this.config.extensionParser;
    }

    // Wire object delivery → media_object events + pipeline routing
    this.subscriptionManager.onObject = (mediaType, trackName, obj, headers, input, delivery) => {
      // Liveness: ANY object on this track (data, gap, or staged-for-switch)
      // proves the delivery path is alive — stamp before every early return.
      this.stampMediaArrival(BigInt(obj.trackAlias));

      // Make-before-break track switch: stage new-track objects until a
      // keyframe arrives, keeping the old track playing the entire time.
      // @see draft-ietf-moq-msf-00 §4.2 (seamless switch at group boundaries)
      if (this.pendingVideoSwitch && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.newTrackName) {
        if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, obj.kind === 'data' ? obj.payload.byteLength : 0)) {
          this.discardMediaInput(input, 'track superseded'); return;
        }
        this.switchStagingBuffer.push({ obj, headers, ...(input ? { input } : {}) });

        // Start safety timeout on first staged object
        this.armVideoSwitchTimeout(this.pendingVideoSwitch);

        // Complete when keyframe arrives (LOC: objectId 0 = keyframe)
        if (obj.kind === 'data' && (headers?.videoFrameMarking?.independent ?? obj.objectId === 0n)) {
          this.completePendingVideoSwitch();
        }

        return; // don't route to old pipeline — staged for later
      }

      // Verbose during development — shows every video object routed
      if (mediaType === 'video') {
        this.log.info('[OBJ] %s "%s" group=%s obj=%s alias=%s %dB',
          mediaType, trackName, obj.groupId, obj.objectId, obj.trackAlias,
          obj.kind === 'data' && obj.payload ? obj.payload.byteLength : 0);
      } else {
        this.log.debug('Object %s group=%s obj=%s (%s, %dB)',
          mediaType, obj.groupId, obj.objectId, obj.kind,
          obj.kind === 'data' && obj.payload ? obj.payload.byteLength : 0);
      }

      // Stats: first object + network counters
      this._stats.recordFirstObjectReceived();
      if (obj.kind === 'data') {
        const bytes = obj.payload ? obj.payload.byteLength : 0;
        this._stats.recordMediaObject(bytes);
        if (mediaType === 'video' && bytes > 0) {
          const gid = BigInt(obj.groupId);
          if (gid !== this.bwEstimatorGroupId) {
            if (this.bwEstimatorGroupBytes > 0) {
              this.bandwidthEstimator?.recordGroup(
                this.bwEstimatorGroupBytes, this.clock.now(),
              );
            }
            this.bwEstimatorGroupId = gid;
            this.bwEstimatorGroupBytes = bytes;
          } else {
            this.bwEstimatorGroupBytes += bytes;
          }
        }
      } else {
        this._stats.recordGapObject();
      }

      // Emit raw event (recording, analytics, custom processing)
      this.emitter.emit('media_object', {
        type: 'media_object',
        mediaType,
        trackName,
        groupId: BigInt(obj.groupId),
        objectId: BigInt(obj.objectId),
        kind: obj.kind,
        ...(obj.kind === 'data' && obj.payload ? { payload: obj.payload } : {}),
        ...(obj.kind === 'data' && obj.extensions ? { extensions: obj.extensions } : {}),
        ...(obj.kind === 'gap' ? { status: BigInt(obj.status ?? 0n) } : {}),
        ...(headers.captureTimestamp !== undefined ? { captureTimestamp: headers.captureTimestamp } : {}),
        ...(headers.videoFrameMarking?.independent !== undefined ? { isKeyframe: headers.videoFrameMarking.independent } : {}),
      });

      if (delivery?.isLive && !delivery.isLive()) { this.discardMediaInput(input, 'route retired'); return; }

      // After switch commit starts (switchInProgress), drop old-track
      // objects. During the overlap window BEFORE commit, old-track
      // objects must keep flowing to sustain playback until the new
      // track's keyframe arrives.
      if (this.switchInProgress && this.pendingVideoSwitch
          && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.oldTrackName) {
        this.discardMediaInput(input, 'track superseded'); return;
      }

      // Route through pipeline for decode processing (LOC §4.2)
      // Drop objects while paused — the pipeline isn't ticking (not draining),
      // so buffering them just fills the jitter buffer and triggers
      // buffer_overflow recovery spam. On resume, pipeline.reset() clears
      // stale state and fresh objects arrive via REQUEST_UPDATE forward:1.
      if (this.stateMachine.state === PlayerState.PAUSED) { this.discardMediaInput(input, 'paused'); return; }
      const pipeline = mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
      if (!pipeline) this.discardMediaInput(input, 'not attached');
      else if (delivery?.backfill) pipeline.pushObject(obj, headers, input, { backfill: true });
      else if (input) pipeline.pushObject(obj, headers, input);
      else pipeline.pushObject(obj, headers);
    };

    // Wire LOCMAF object delivery → reconstruction into CMAF chunks → assembler.
    // @see draft-einarsson-moq-locmaf-01 §15, §16
    this.subscriptionManager.onLocmafObject = (mediaType, trackName, obj, input, delivery?: ObjectDeliveryOptions) => {
      this.onLocmafMediaObject(mediaType, trackName, obj, input, delivery);
    };

    // Wire CMAF object delivery → MediaSource adapter (pipeline bypass)
    // §3.3: CMAF objects are moof or mdat — concatenate then feed to MSE
    this.subscriptionManager.onCmafObject = (mediaType, trackName, obj, input, delivery?: ObjectDeliveryOptions) => {
      // Liveness: stamp before every early return (gates, staging, drops).
      this.stampMediaArrival(BigInt(obj.trackAlias));

      // CMAF switch completion handled at raw onObject level (above)

      // Stats
      this._stats.recordFirstObjectReceived();
      if (obj.kind === 'data') {
        const bytes = obj.payload ? obj.payload.byteLength : 0;
        this._stats.recordMediaObject(bytes);
        // CMAF: one moof+mdat per group — each object IS a group
        if (mediaType === 'video' && bytes > 0) {
          this.bandwidthEstimator?.recordGroup(bytes, this.clock.now());
        }
      } else {
        this._stats.recordGapObject();
      }

      // Emit media_object for CMAF too — sparkline jitter chart needs
      // inter-arrival timing from all video objects regardless of packaging.
      this.emitter.emit('media_object', {
        type: 'media_object',
        mediaType,
        trackName,
        groupId: BigInt(obj.groupId),
        objectId: BigInt(obj.objectId),
        kind: obj.kind,
        ...(obj.kind === 'data' && obj.payload ? { payload: obj.payload } : {}),
        ...(obj.kind === 'gap' ? { status: BigInt(obj.status ?? 0n) } : {}),
      });

      if (delivery?.isLive && !delivery.isLive()) { this.discardMediaInput(input, 'route retired'); return; }
      if (obj.kind !== 'data' || !obj.payload) return;
      if (this.stateMachine.state === PlayerState.PAUSED) { this.discardMediaInput(input, 'paused'); return; }

      // Gate: media cannot reach MSE before initialization. While init is
      // pending, an in-band ftyp+moov object is accepted as the init
      // source; moof/mdat is dropped loudly and arms the bootstrap
      // deadline (no more silent pre-init drops).
      if (!this.cmafInitialized) {
        const initHeader = MoqtPlayer.looksLikeCmafInitSegment(obj.payload);
        this.handlePreInitCmafObject(mediaType, trackName, obj.payload, BigInt(obj.trackAlias));
        if (!initHeader) this.discardMediaInput(input, 'awaiting init');
        return;
      }

      // Gate: the MediaSource must be attached (MSE `sourceopen`) before
      // anything can reach a SourceBuffer. Browsers defer that attachment
      // while the document is hidden (background tab). Hold media here rather
      // than feeding the assembler, so (a) the shared epoch anchors on the
      // first segment actually appended and (b) on attach we re-sync to the
      // next group start — playback resumes at the live edge on a keyframe
      // instead of on a stale timeline built from dropped segments.
      if (this.mediaSource?.attached === false) {
        if (!this.cmafHoldingForAttach) {
          this.cmafHoldingForAttach = true;
          this.log.info('[CMAF] MediaSource not attached yet (sourceopen pending — hidden tab?); holding media until attached');
        }
        this.discardMediaInput(input, 'not attached');
        return;
      }

      if (this.switchInProgress && this.pendingVideoSwitch && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.oldTrackName) {
        this.discardMediaInput(input, 'track superseded');
        return;
      }

      // Gate: video must start from a keyframe (group start, object 0/1).
      // After init, we may be mid-GOP — delta frames without a preceding
      // keyframe cause MSE decode errors. Skip until a new group starts.
      if (mediaType === 'video' && !this.cmafVideoSynced) {
        if (BigInt(obj.objectId) <= 1n) {
          this.cmafVideoSynced = true;
          this.log.debug('[CMAF] video synced at g=%s o=%s', String(obj.groupId), String(obj.objectId));
        } else {
          this.discardMediaInput(input, 'awaiting keyframe');
          return;
        }
      }

      // Keep target data separate until its initialization and splice are
      // ready. The old track remains selected throughout preparation.
      if (this.pendingVideoSwitch && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.newTrackName) {
        if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, obj.payload.byteLength)) {
          this.discardMediaInput(input, 'track superseded'); return;
        }
        // CMSF §3.4 requires a group-start SAP. Retain that fallback for
        // unreadable/legacy split chunks, but never override a known non-sync sample.
        const sync = this.cmafSwitchSync(this.pendingVideoSwitch, obj.payload)
          ?? BigInt(obj.objectId) === 0n;
        this.cmafSwitchStagingBuffer.push({
          trackName, mediaType, groupId: BigInt(obj.groupId), payload: obj.payload, sync,
          ...(input ? { input } : {}),
        });

        this.armVideoSwitchTimeout(this.pendingVideoSwitch);

        if (sync) {
          this.completePendingVideoSwitch();
        }
        return;
      }

      // Early stale-group drop: skip objects from groups older than what
      // MSE has already committed. Prevents late-arriving old groups from
      // poisoning the assembler's patchEpoch (false backward-bmd detection).
      const groupId = BigInt(obj.groupId);
      if (this.mediaSource && 'getCommittedGroupFloor' in this.mediaSource) {
        const floor = (this.mediaSource as { getCommittedGroupFloor: (mt: string, tn: string) => bigint | undefined })
          .getCommittedGroupFloor(mediaType, trackName);
        if (floor !== undefined && groupId < floor) { this.discardMediaInput(input, 'stale group'); return; }
      }

      // Feed through assembler: pairs moof+mdat per group, patches tfdt, emits segments.
      this.pushCmafInput(mediaType, trackName, groupId, obj.payload, input);
    };

    // §2.4.2: Malformed Track — MUST UNSUBSCRIBE, SHOULD deliver error
    this.subscriptionManager.onMalformedTrack = (trackAlias, _mediaType, trackName, error, sourceConnection) => {
      this.handleMalformedTrack(trackAlias, trackName, error, sourceConnection as MoqtConnection | undefined);
    };

    // §7: Media timeline object delivery → update timeline state
    this.subscriptionManager.onTimelineObject = (trackName, obj) => {
      if (obj.kind !== 'data' || !obj.payload) return;
      if (!this.timelineState) return;

      const prevEntryCount = this.timelineState.entries.length;
      this.timelineState = processTimelineObject(this.timelineState, obj.payload);

      const duration = getTimelineDuration(this.timelineState);
      if (prevEntryCount === 0) {
        // First timeline payload — emit timeline_loaded
        this.emitter.emit('timeline_loaded', {
          type: 'timeline_loaded',
          trackName,
          entryCount: this.timelineState.entries.length,
          ...(duration !== undefined ? { duration } : {}),
        });
        if (duration !== undefined) {
          this.emitter.emit('duration_changed', {
            type: 'duration_changed',
            durationMs: duration,
          });
        }
      } else {
        // Incremental update — emit timeline_updated
        this.emitter.emit('timeline_updated', {
          type: 'timeline_updated',
          trackName,
          entryCount: this.timelineState.entries.length,
          ...(duration !== undefined ? { duration } : {}),
        });
      }
    };

    // §8: Event timeline object delivery — parse SAP or generic event records
    // @see draft-ietf-moq-msf-00 §8 (Event Timeline track)
    // @see draft-ietf-moq-cmsf-00 §3.6 (SAP Type Timeline)
    this.subscriptionManager.onEventTimelineObject = (trackName, obj) => {
      if (obj.kind !== 'data' || !obj.payload) return;

      // Look up the catalog track to determine the eventType
      const catalog = this.catalogSlots.catalogManager?.currentState;
      const key = this.mediaKey(trackName, undefined, BigInt(obj.trackAlias));
      const catalogTrack = catalog?.tracks.find(track => this.initKey(track) === key);
      const eventType = catalogTrack?.eventType ?? '';

      try {
        if (eventType === CMSF_SAP_EVENT_TYPE) {
          // CMSF SAP timeline: parse as SAP entries and emit sap_event
          // @see draft-ietf-moq-cmsf-00 §3.6.1
          const entries = parseSapTimeline(obj.payload);
          this.emitter.emit('sap_event', {
            type: 'sap_event',
            trackName,
            entries,
          });
        } else {
          // Generic event timeline: parse records and emit event_timeline
          // @see draft-ietf-moq-msf-00 §8.1
          const records = parseEventTimeline(obj.payload);
          this.emitter.emit('event_timeline', {
            type: 'event_timeline',
            trackName,
            eventType,
            records,
          });
        }
      } catch (err) {
        this.log.warn('Failed to parse eventtimeline object for track "%s": %s',
          trackName, err instanceof Error ? err.message : String(err));
      }
    };

    // §3.1: Init track object delivery → initialize MediaSource with ftyp+moov
    this.subscriptionManager.onInitObject = (trackName, obj, source) => {
      this.log.debug('[INIT] onInitObject: track=%s kind=%s payloadLen=%d mediaSource=%s',
        trackName, obj.kind, obj.kind === 'data' && obj.payload ? obj.payload.byteLength : 0,
        this.mediaSource ? 'exists' : 'null');
      if (obj.kind !== 'data' || !obj.payload) return;
      if (source !== undefined && source !== this.connection) return;

      // Find which catalog tracks reference this initTrack
      const catalog = this.catalogSlots.catalogManager?.currentState;
      if (!catalog) return;

      const issued = [...this.activeSubscriptions.values()].find(sub =>
        sub.trackAlias === BigInt(obj.trackAlias) && sub.trackName === trackName);
      if (issued === undefined) return;
      const key = identityKey(issued.namespace ?? namespaceFields(this.config.namespace), trackName);
      const references = (mediaType: 'video' | 'audio'): CatalogTrack | undefined => {
        const selected = this.subscribedTrack(mediaType);
        return selected?.initTrack === trackName && this.initKey(selected, trackName) === key
          ? selected : undefined;
      };
      const videoTrack = references('video');
      const audioTrack = references('audio');

      // Cache the init bytes so future codec-changing track switches
      // can call mediaSource.changeType() immediately instead of
      // re-fetching. Resolves any pending lazy-subscribe waiter.
      this.initSegmentByTrack.set(key, obj.payload);
      const pending = this.pendingInitTrackSubs.get(key);
      if (pending?.connection === this.connection) {
        this.pendingInitTrackSubs.delete(key);
        pending.resolve(obj.payload);
      }

      // Unsubscribe and clean all bookkeeping — init track only needs one object.
      // Without cleanup, seek/recovery paths can send REQUEST_UPDATE to
      // a subscription that was already unsubscribed.
      const initReqId = this.initTrackRequestIds.get(key);
      if (initReqId !== undefined) {
        this.initTrackRequestIds.delete(key);
        if (this.connection) this.retireMediaSubscription(initReqId, this.connection);
        this.connection?.unsubscribe(varint(initReqId)).catch(() => {});
      }

      // Already initialized → this delivery is cache-warming for a future
      // codec switch only (the cache write above did the work). Without a
      // MediaSource (LOCMAF frame path) the cache is all the delivery feeds.
      if (this.cmafInitialized || !this.mediaSource) return;

      // Supply the bytes to the init state machine for every selected CMAF
      // track referencing this init track. initialize() fires once ALL
      // selected tracks have bytes (collect-then-initialize: split video/
      // audio init tracks initialize TOGETHER — a partial first call would
      // latch the adapter and orphan the other SourceBuffer).
      this.log.info('Init track "%s" received (%d bytes)', trackName, obj.payload.byteLength);
      if (videoTrack?.codec) this.supplyCmafInitBytes('video', obj.payload);
      if (audioTrack?.codec) this.supplyCmafInitBytes('audio', obj.payload);
    };

    if (this._adapterOwned) {
      // Connect (CLIENT_SETUP → SERVER_SETUP) §3.3
      // §9.3.1.3: MAX_REQUEST_ID defaults to 0 (no requests allowed).
      // Must pass a nonzero value for subscriptions to work.
      const setupOptions = buildSetupOptions(this.config);
      const transport = await this.config.createTransport!(buildConnectUrl(this.config));
      if (this._destroyed || this.connection !== conn || this.isTerminalState()) {
        transport.close();
        throw new Error('Player destroyed or connection superseded during transport creation');
      }
      this._handshakeRttMs = transport.handshakeRttMs;
      if (this._handshakeRttMs !== undefined) {
        const classification = this._handshakeRttMs < 1 ? 'LAN (2 frames)'
          : this._handshakeRttMs < 5 ? 'near-LAN (3 frames)'
          : this._handshakeRttMs < 50 ? 'WAN (8 frames)'
          : 'long-haul (12 frames)';
        this.log.info('Handshake RTT: %.1fms → startup buffer: %s',
          this._handshakeRttMs, classification);
      }
      const connectPromise = conn.connect(transport, setupOptions);

      // Wrap connect with connectionTimeoutMs
      if (this.config.connectionTimeoutMs) {
        const timeout = this.config.connectionTimeoutMs;
        await Promise.race([
          connectPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Connection timeout after ${timeout}ms`)), timeout),
          ),
        ]);
      } else {
        await connectPromise;
      }

      const peerMaxReqId = conn.session?.peerMaxRequestId ?? 'unknown';
      this.log.info('Session established (peer MAX_REQUEST_ID=%s)', peerMaxReqId);
    } else {
      // External adapter: already connected, skip handshake
      this.log.info('Using externally owned adapter (already connected)');
    }

    if (this._destroyed || this.connection !== conn || this.isTerminalState()) {
      throw new Error('Player destroyed or connection superseded during establishment');
    }

    // The NEGOTIATED draft is authoritative for the LOC property wire profile —
    // config.draftVersion is only a pre-connect hint. WT protocol negotiation (or
    // an externally-owned adapter) may land on a different draft (e.g. auto-18),
    // and decoding LOC with the wrong profile mis-reads every value >= 64.
    // (Guarded: destroy() may have nulled the manager during the connect await.)
    if (this.subscriptionManager) this.subscriptionManager.draftVersion = conn.draftVersion;

    this._stats.recordTransportConnected();
    this._stats.recordSetupComplete();
    this.emitter.emit('session_established', {
      type: 'session_established',
      selectedVersion: 0n,
    });

    // Watchdog: expect catalog within 10s (unless externally injected)
    if (!this.config.catalog && !this.config.knownTracks) {
      this.watchdog.expect('catalog_received', 10_000);
    }

    const nsBytes = encodeNamespace(this.config.namespace, this.enc);

    // DEBUG: log namespace tuple and track names for interop debugging
    {
      const dec = new TextDecoder();
      const nsTuple = nsBytes.map(b => `"${dec.decode(b)}"(${b.length}b)`).join(', ');
      this.log.info('Subscribe: namespace fields=[%s], catalog track="%s"',
        nsTuple, catalogTrackName(this.config.catalogTrackName));
    }

    if (this.config.catalog) {
      // ── External catalog injection: skip catalog subscription ──────
      // Track metadata provided externally — subscribe directly to media.
      // Same code path as receiving a catalog from the wire, but without
      // the catalog subscription + parse step.
      const injectedCatalog = this.config.catalog;
      const catalogState: CatalogState = {
        version: injectedCatalog.version ?? 1,
        tracks: [...injectedCatalog.tracks] as CatalogTrack[],
        ...(injectedCatalog.generatedAt !== undefined ? { generatedAt: injectedCatalog.generatedAt } : {}),
        ...(injectedCatalog.isComplete !== undefined ? { isComplete: injectedCatalog.isComplete } : {}),
        ...(injectedCatalog.initDataList !== undefined ? { initDataList: injectedCatalog.initDataList } : {}),
        ...(injectedCatalog.contentProtections !== undefined ? { contentProtections: injectedCatalog.contentProtections } : {}),
        ...(injectedCatalog.publishTracks !== undefined ? { publishTracks: injectedCatalog.publishTracks } : {}),
      };

      // Emit catalog_received so the app knows tracks are available
      this.catalogSlots.catalogReceived = true;
      this._catalogState = catalogState;
      this._stats.recordCatalogReceived();
      this.emitter.emit('catalog_received', {
        type: 'catalog_received',
        catalog: catalogState,
      });

      // Subscribe to media tracks from injected catalog
      await this.subscribeToMediaTracks(catalogState);
    } else if (this.config.knownTracks) {
      // ── TTFF fast path: pre-create pipelines + parallel subscribe ──
      // When track metadata is pre-known, create decoders/pipelines now
      // and subscribe to catalog + media tracks in parallel — saves 1 RTT.
      // @see draft-ietf-moq-transport-16 §9.5 (MAX_REQUEST_ID)
      // @see DESIGN-production-readiness.md §2 (TTFF optimization)

      const kt = this.config.knownTracks;
      const wantVideo = kt.video && !this.config.disableVideo;
      const wantAudio = kt.audio && !this.config.disableAudio;

      // Record initial track info for stats
      this._stats.setTrackInfo(
        wantVideo ? defined({ codec: kt.video!.codec, width: kt.video!.width, height: kt.video!.height }) : undefined,
        wantAudio ? defined({ codec: kt.audio!.codec }) : undefined,
      );

      this.createPipelinesFromTrackInfo({
        video: wantVideo ? defined({
          codec: kt.video!.codec,
          width: kt.video!.width,
          height: kt.video!.height,
          initData: kt.video!.initData,
        }) : undefined,
        audio: wantAudio ? defined({
          codec: kt.audio!.codec,
          samplerate: kt.audio!.samplerate,
          channels: kt.audio!.channels,
          initData: kt.audio!.initData,
        }) : undefined,
        isLive: true,
      });

      // Subscribe to catalog + pre-known media tracks in parallel
      const subscribeOptions = buildSubscribeOptions(this.config);
      const promises: Promise<void>[] = [];

      promises.push(this.subscribeCatalog(conn));

      // Pre-known media tracks (respecting disable flags)
      this._mediaSubsExpected = 0;
      this._mediaSubsOk = 0;
      this._mediaSubsFailed = 0;
      for (const [mediaType, track] of [
        ['video' as const, wantVideo ? kt.video : undefined],
        ['audio' as const, wantAudio ? kt.audio : undefined],
      ] as const) {
        if (!track) continue;
        promises.push((async () => {
          // The catalog-free path has no declared namespace to honor, so the
          // configured one is the identity.
          const intent = this.hooks.beforeSubscribe.run({
            trackName: track.name, mediaType, namespace: namespaceFields(this.config.namespace),
          });
          if (!intent) return;
          this._mediaSubsExpected++;
          const knownTrackOptions = subscribeOptions ?? defaultMediaSubscriptionFilter(true);
          // Pre-send ownership (§9.10): register inside onRequestId so a
          // zero-latency SUBSCRIBE_OK can never beat the registration; adapters
          // that don't invoke the callback fall back to post-await.
          let registered = false;
          const registerKnownSub = (reqIdBigInt: bigint): void => {
            if (registered) return;
            registered = true;
            if (this._destroyed || this.isTerminalState() || !this.subscriptionManager || this.connection !== conn) {
              throw new Error('Media subscription retired before emission');
            }
            this.pendingAliasBinds.add(reqIdBigInt);
            this.activeSubscriptions.set(reqIdBigInt, {
              trackName: track.name, mediaType, trackAlias: null,
            });
            this.pendingMediaSubs.set(reqIdBigInt, { trackName: track.name, mediaType });
            // Authorization may delay this registration until after the catalog
            // arrives. Adopt the registered view before ABR can use its ladder.
            if (mediaType === 'video' && this.catalogSlots.catalogReceived && this._catalogState) {
              this.selectCatalogTracks(this._catalogState);
            }
            this.log.info('Subscribe %s "%s" requestId=%s (pre-known)', mediaType, track.name, reqIdBigInt);
          };
          let knownRegisteredId: bigint | null = null;
          try {
            const reqId = await conn.subscribe(
              nsBytes, this.enc.encode(track.name),
              { ...(knownTrackOptions ?? {}), ...this.mediaTerminalOptions(conn), onRequestId: (id: bigint) => { knownRegisteredId = id; registerKnownSub(id); } } as never,
            );
            if (this._destroyed || this.isTerminalState() || this.connection !== conn) {
              if (knownRegisteredId === null) void conn.unsubscribe(varint(BigInt(reqId))).catch(() => { /* best effort */ });
              return;
            }
            registerKnownSub(BigInt(reqId));
            // The EVENT is emitted only once emission succeeded — ownership
            // registers pre-send, but a failed send must not have announced a
            // subscription that never (usably) existed.
            this.emitter.emit('track_subscribed', {
              type: 'track_subscribed',
              trackName: track.name,
              mediaType,
              requestId: BigInt(reqId),
            });
          } catch (err) {
            if (knownRegisteredId !== null) {
              this.retireMediaSubscription(knownRegisteredId, conn);
            }
            throw err;
          }
        })());
      }

      await Promise.all(promises);
    } else {
      // ── Standard path: catalog-first ───────────────────────────────
      await this.subscribeCatalog(conn);
    }
  }

  /**
   * Issue the catalog SUBSCRIBE (MSF §9.1, §5.1.10). Bootstrap mode pairs a
   * LargestObject filter with a Joining FETCH (MSF-01 §5); legacy mode keeps
   * AbsoluteStart{0,0}. Shared by the initial subscribe and by
   * {@link scheduleCatalogSubscribeRetry}.
   */
  private async subscribeCatalog(conn: MoqtConnection): Promise<void> {
    const gen = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState() && this.connection === conn
      && gen === this.bootstrapGeneration && !this.catalogQuarantinedConns.has(conn);
    if (!live()) return;
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName(this.config.catalogTrackName));
    const coord = this.resolvedCatalogMode(conn) === 'joining-fetch'
      ? this.createCatalogBootstrap(conn) : null;
    const options = this.catalogSubscribeOptions(conn);
    const register = options.onRequestId as (id: bigint) => void;
    let allocatedId: bigint | null = null;
    let reqId: Awaited<ReturnType<MoqtConnection['subscribe']>>;
    try {
      reqId = await conn.subscribe(nsBytes, nameBytes, {
        ...options,
        onRequestId: (id: bigint) => {
          if (!live()) throw new Error('Catalog subscription retired before emission');
          allocatedId = id;
          register(id);
        },
      } as never);
    } catch (err) {
      if (live()) {
        // The pre-send callback may have registered the bind — settle it.
        if (allocatedId !== null) this.settleParkedOwnership(allocatedId, null, conn);
        const preparing = this.currentMigration;
        if (preparing !== null && !preparing.committed && !preparing.aborted) {
          // A replacement for THIS session is already being prepared and will
          // bring its own catalog retrieval. Failing playback here would
          // discard a healthy candidate over a request on the session we are
          // leaving; if the candidate fails, its own failure is reported and
          // the old session's state is what it was.
          this.log.info('[handover] catalog subscribe failed on the session being replaced — held: %s',
            err instanceof Error ? err.message : String(err));
          throw err;
        }
        this.failCatalogPlayback(createPlayerError(
          'fatal', 'catalog', PlayerErrorCode.LOAD_FAILED,
          `Catalog subscription failed to send: ${err instanceof Error ? err.message : String(err)}`,
        ));
      }
      throw err;
    }
    if (!live()) {
      if (allocatedId === null) void conn.unsubscribe(varint(BigInt(reqId))).catch(() => { /* best effort */ });
      return;
    }
    // A response can precede send completion. Only callback-less adapters
    // still need registration here; never restore an already-retired request.
    if (allocatedId === null) {
      this.catalogSlots.catalogRequestId = BigInt(reqId);
      if (this.catalogSlots.catalogTrackAlias === null) this.pendingAliasBinds.add(BigInt(reqId));
    }
    coord?.start();
  }

  /**
   * Honor the peer's retry guidance for DOES_NOT_EXIST. Draft-16 9.8 and
   * draft-18 10.6.2 encode the minimum delay plus one; zero means no retry.
   */
  private scheduleCatalogSubscribeRetry(conn: MoqtConnection, retryInterval: bigint): void {
    if (retryInterval <= 0n) return;
    const gen = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState() && this.connection === conn
      && gen === this.bootstrapGeneration && !this.catalogSlots.catalogReceived
      && !this.catalogQuarantinedConns.has(conn);
    if (!live()) return;
    if (this.catalogSlots.catalogSubscribeRetryTimer !== null) return;
    let remaining = retryInterval - 1n;
    const backoff = BigInt(MoqtPlayer.CATALOG_SUBSCRIBE_RETRY_MS);
    if (remaining < backoff) remaining = backoff;
    const arm = (): void => {
      // Wire intervals can be uint64; platform timers are signed 32-bit.
      const delay = Number(remaining > 0x7fffffffn ? 0x7fffffffn : remaining);
      const timer = setTimeout(() => {
        if (this.catalogSlots.catalogSubscribeRetryTimer !== timer) return;
        this.catalogSlots.catalogSubscribeRetryTimer = null;
        if (!live()) return;
        remaining -= BigInt(delay);
        if (remaining > 0n) { arm(); return; }
        this.log.info('Retrying catalog subscription for namespace "%s" (no publisher yet)',
          this.config.namespace);
        if (!live()) return;
        this.subscribeCatalog(conn).catch((err) => {
          this.log.warn('Catalog subscribe retry failed to send: %s',
            err instanceof Error ? err.message : String(err));
        });
      }, delay);
      this.catalogSlots.catalogSubscribeRetryTimer = timer;
    };
    arm();
  }

  /** Retire bootstrap work and invalidate its outstanding async callbacks. */
  private cancelCatalogBootstrap(): void {
    this.bootstrapGeneration += 1;
    if (this.catalogSlots.catalogSubscribeRetryTimer !== null) {
      clearTimeout(this.catalogSlots.catalogSubscribeRetryTimer);
      this.catalogSlots.catalogSubscribeRetryTimer = null;
    }
    this.catalogSlots.catalogBootstrapCoord?.abort();
    this.catalogSlots.catalogBootstrapCoord = null;
  }

  /**
   * Start playback — begin ticking pipelines.
   *
   * If resuming from paused, sends REQUEST_UPDATE forward:1 to resume
   * object delivery at the source.
   * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE)
   * @see draft-ietf-moq-transport-16 §9.2.2.8 (FORWARD parameter)
   */
  play(): void {
    // Idempotent while playing, as HTMLMediaElement.play() is.
    if (this.stateMachine.state === PlayerState.PLAYING) return;
    this.log.info('play()');
    // ONE transaction. The transition is validated first (an invalid one throws
    // having changed nothing), then state, playback intent, adapter intent and
    // ticking are all committed, and only then is the completed transition
    // announced. Announcing earlier would let a listener observe — or re-enter
    // against — a half-applied play, and a throwing listener would strand it.
    const fromState = this.applyState(PlayerState.PLAYING);

    // Playback intent is the player's to declare. The media source may buffer
    // whenever data arrives, but must not start playing on its own. Recorded so
    // an adapter created LATER inherits it (see createPipelines wiring).
    this.playbackIntent = true;
    this.mediaSource?.setPlaybackIntent?.(true);
    this._stats.recordPlayStart();

    // Resuming from pause on a live stream: the media position has moved on.
    // Reset pipeline state so the first arriving group is accepted cleanly
    // without cascading gap-recovery escalation from the stale pre-pause position.
    if (fromState === PlayerState.PAUSED) {
      this.videoPipeline?.reset();
      this.audioPipeline?.reset();
      this.syncController?.reset();
      this.recoveryController?.reset?.();
    }

    // Liveness: drop stale arrival stamps — a pause (no delivery, no ticks)
    // must not read as starvation on resume. Tracks re-arm on their next
    // arrival; reconcile re-registers them on the first tick.
    this.livenessMonitor?.clear();

    // Start pipeline tick interval (~60fps for smooth playback)
    this.startTicking();

    // §9.11: REQUEST_UPDATE with forward:1 resumes delivery at source
    // §9.2.2.8: FORWARD=1 means "forward" — resume object delivery
    if (fromState === PlayerState.PAUSED && this.connection) {
      this.sendForwardUpdate(1);
    }

    // LAST: a listener may now pause/destroy, and its transaction — being
    // complete in itself — legitimately supersedes this one.
    this.announceState(fromState, PlayerState.PLAYING);
  }

  /**
   * Pause playback — stop ticking pipelines.
   *
   * Sends REQUEST_UPDATE forward:0 to stop object delivery at source.
   * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE with forward:0)
   * @see draft-ietf-moq-transport-16 §9.2.2.8 (FORWARD parameter)
   */
  pause(): void {
    this.log.info('pause()');
    // Same transaction shape as play(): validate, commit everything, announce
    // last. See play() for why the announcement cannot come earlier.
    const fromState = this.applyState(PlayerState.PAUSED);
    this.playbackIntent = false;
    this.mediaSource?.setPlaybackIntent?.(false);
    this._stats.recordPlayStop();
    this.stopTicking();

    // Flush pre-scheduled audio and queued video frames immediately
    this.commandDispatcher?.flush();

    // §9.11: REQUEST_UPDATE with forward:0 pauses delivery at source
    // §9.2.2.8: FORWARD=0 means "don't forward" — pause at source
    if (this.connection) {
      this.sendForwardUpdate(0);
    }

    this.announceState(fromState, PlayerState.PAUSED);
  }

  /**
   * Send REQUEST_UPDATE with FORWARD parameter to all active subscriptions.
   *
   * Each call is independent — a failure on one subscription must not
   * prevent the update from being sent to others. Errors are surfaced
   * via the error event (degraded severity — playback may continue on
   * subscriptions that succeeded).
   *
   * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE)
   * @see draft-ietf-moq-transport-16 §9.2.2.8 (FORWARD parameter)
   * @see draft-ietf-moq-transport-16 §5.1 (Forward State)
   */
  private sendForwardUpdate(forward: 0 | 1): void {
    if (!this.connection) return;
    for (const [requestId] of this.activeSubscriptions) {
      this.connection.requestUpdate(varint(requestId), { forward }).catch((err: unknown) => {
        const cause = err instanceof Error ? err : new Error(String(err));
        this.log.warn('REQUEST_UPDATE forward:%d failed for reqId=%s: %s', forward, requestId, cause.message);
        this.emitError(createPlayerError(
          'degraded', 'connection', PlayerErrorCode.REQUEST_UPDATE_FAILED,
          `REQUEST_UPDATE forward:${forward} failed: ${cause.message}`,
          { cause, context: { requestId, forward } },
        ));
      });
    }
  }

  /**
   * Seek to a specific media time position.
   *
   * Looks up the target PTS in the media timeline to find the corresponding
   * MOQT group/object, resets playback pipelines, and sends REQUEST_UPDATE
   * with an AbsoluteStart subscription filter to jump the active media
   * subscriptions to the new position.
   *
   * @param timeMs Target media presentation timestamp in milliseconds.
   * @throws If no timeline is loaded or player is not in a seekable state.
   *
   * @see draft-ietf-moq-msf-00 §7 (Media Timeline for PTS→location lookup)
   * @see draft-ietf-moq-transport-16 §9.2.2.5 (SUBSCRIPTION_FILTER in REQUEST_UPDATE)
   * @see draft-ietf-moq-transport-16 §9.11 (REQUEST_UPDATE)
   */
  async seek(timeMs: number): Promise<void> {
    // Guard: player must be in a seekable state
    const s = this.stateMachine.state;
    if (s !== PlayerState.PLAYING && s !== PlayerState.PAUSED) {
      throw new Error(`Cannot seek in state ${s}; expected playing or paused`);
    }

    // Guard: timeline must be loaded with entries
    if (!this.timelineState || this.timelineState.entries.length === 0) {
      throw new Error('Cannot seek: no media timeline loaded');
    }

    // §7: Look up the MOQT location for the target PTS
    const target = findSeekTarget(this.timelineState, timeMs);
    if (!target) {
      this.emitError(createPlayerError(
        'degraded', 'player', PlayerErrorCode.SEEK_FAILED,
        `Seek target ${timeMs}ms is before the start of the timeline`,
        { context: { timeMs } },
      ));
      return;
    }

    // Emit seeking event before pipeline reset
    this.emitter.emit('seeking', {
      type: 'seeking',
      targetTimeMs: timeMs,
    });

    // The seek is committed here: every guard passed and `seeking` has been
    // published. Only now does it supersede playback, so a rejected seek — bad
    // state, no timeline, target before the start — leaves a live stall alone
    // rather than censoring an outage that is still running. The LOC path is
    // cancelled inside CommandDispatcher.flush() below; CMAF needs its own
    // call, and it must land before the resets.
    this.mediaSource?.cancelStallEpisode?.();

    // Reset playback pipelines — flush jitter buffer, decoder state, sync reference.
    // §9.11.1: "it might still receive Objects outside the new range if the
    // publisher sent them before the update was processed."
    // Pass target groupId so pipelines reject stale in-flight objects.
    const targetGroupBigInt = BigInt(target.groupId);
    this.videoPipeline?.reset(targetGroupBigInt);
    this.audioPipeline?.reset(targetGroupBigInt);
    this.syncController?.reset();
    this.commandDispatcher?.flush();

    // §9.2.2.5: Send REQUEST_UPDATE with AbsoluteStart filter for each
    // active MEDIA subscription (not timeline subscription).
    if (this.connection) {
      for (const [requestId] of this.activeSubscriptions) {
        // Skip the timeline subscription — it should continue receiving updates
        if (requestId === this.timelineRequestId) continue;

        this.connection.requestUpdate(varint(requestId), {
          subscriptionFilter: {
            type: 'AbsoluteStart',
            startGroup: varint(BigInt(target.groupId)),
            startObject: varint(BigInt(target.objectId)),
          },
        }).catch((err: unknown) => {
          const cause = err instanceof Error ? err : new Error(String(err));
          this.log.warn('REQUEST_UPDATE seek failed for reqId=%s: %s', requestId, cause.message);
          this.emitError(createPlayerError(
            'degraded', 'connection', PlayerErrorCode.SEEK_FAILED,
            `Seek REQUEST_UPDATE failed: ${cause.message}`,
            { cause, context: { requestId, timeMs, groupId: target.groupId } },
          ));
        });
      }
    }

    // Emit seeked event — optimistic (REQUEST_UPDATE sent, awaiting objects)
    this.emitter.emit('seeked', {
      type: 'seeked',
      actualTimeMs: timeMs,
      groupId: target.groupId,
      objectId: target.objectId,
    });
  }

  /**
   * Migrate to a new relay after GOAWAY.
   *
   * Establishes a new session on the provided adapter, subscribes to
   * the catalog, and closes the old session. Media subscriptions
   * are re-established once the new catalog arrives.
   *
   * Can be called manually with a pre-created adapter.
   * For automatic GOAWAY migration, configure `createConnection` + `createTransport`.
   *
   * @param newConnection A new adapter connected to the target relay.
   *
   * @see draft-ietf-moq-transport-16 §3.5 (Migration)
   * @see draft-ietf-moq-transport-16 §8.4.1 (Graceful Subscriber Relay Switchover)
   */
  async migrate(newConnection: MoqtConnection): Promise<void> {
    if (!this.config.createTransport) {
      throw new Error('Cannot migrate: createTransport not configured (external adapter mode)');
    }
    const createTransport = this.config.createTransport;
    const setupOptions = buildSetupOptions(this.config);
    await this.runMigrationTransaction(newConnection, () => createTransport(buildConnectUrl(this.config)), setupOptions);

    this._stats.recordReconnect();
    this.log.info('Session migrated');
    this.emitter.emit('session_migrated', { type: 'session_migrated' });
  }

  /**
   * Which catalog retrieval owns evidence arriving on `conn` — or `null` when
   * nothing does.
   *
   * Three outcomes, all explicit: the live session's holder, a preparing
   * candidate's own holder, or no owner at all. "No owner" is the important
   * one: a superseded or unknown connection must not inherit live ownership
   * just because the live holder happens to be installed, which is the
   * connection authority the coordinator's liveness check relies on.
   */
  private slotsFor(conn: MoqtConnection): CatalogSlots | null {
    const txn = this.currentMigration;
    // `aborted` matters as much as `committed`: the deadline marks a candidate
    // aborted synchronously, and its asynchronous cleanup runs later. In that
    // window the candidate must already own nothing.
    if (txn?.slots && txn.conn === conn && !txn.committed && !txn.aborted) return txn.slots;
    // After adoption the transferred holder IS the live one, so callbacks the
    // adopted coordinator captured stay valid once `currentMigration` clears.
    if (this.connection === conn) return this.catalogSlots;
    return null;
  }

  /**
   * One deadline for a whole handover attempt — factory, auth, connect and
   * readiness — so a promise that never settles cannot hold the single-flight
   * slot. Marking the transaction aborted makes a late completion inert.
   *
   * This is our local `connectionTimeoutMs` budget. A peer's GOAWAY Timeout is a
   * hint and never authorizes terminating a healthy session.
   */
  private armHandoverDeadline(txn: MigrationTxn): { timedOut: Promise<'timeout'>; cancel: () => void } {
    const ms = this.config.connectionTimeoutMs;
    if (!ms) {
      return {
        timedOut: new Promise<'timeout'>(() => { /* never */ }),
        cancel: () => { /* nothing armed */ },
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // RESOLVES rather than rejects. A rejecting signal is only consumed by the
    // phase that happens to race it, so every other phase leaves it unowned and
    // an expiry surfaces as an unhandled rejection. The terminal outcome is
    // therefore a value, and only the awaiting operation turns it into a throw.
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        txn.aborted = true; // a late factory/connect completion cannot resurrect it
        resolve('timeout');
      }, ms);
    });
    return { timedOut, cancel: () => { if (timer !== undefined) clearTimeout(timer); } };
  }

  /**
   * Run one migration as a single-flight transaction. The single-flight slot is
   * reserved BEFORE the transport is created (so a concurrent migration can't
   * spin up an orphaned WebTransport). Establishment (transport + connect +
   * catalog subscribe) runs WITHOUT disturbing the current session and rolls back
   * completely on failure — including closing an orphaned transport. Only after
   * the candidate is validated does the handoff commit; POST-commit staged-event
   * draining is deliberately OUTSIDE the establishment rollback, so a throwing
   * application listener can never detach/close the already-authoritative session.
   */
  private async runMigrationTransaction(
    newConnection: MoqtConnection,
    makeTransport: () => Promise<WebTransportLike>,
    setupOptions: ReturnType<typeof buildSetupOptions>,
    target?: string,
  ): Promise<void> {
    if (this._destroyed) throw new Error('Cannot migrate: player is destroyed');
    if (this.isTerminalState()) throw new Error('Cannot migrate: playback has terminated');
    if (this.currentMigration) throw new Error('Cannot migrate: a migration is already in progress');
    // A previous attempt's `changeType` has not settled, so the media source
    // is not in a known state. Adopting a replacement onto a buffer another
    // attempt can still mutate would hand it an initialization that is about
    // to change under it, so this attempt does not start at all.
    if (this.pendingRetypes.size > 0) {
      throw new Error('Cannot migrate: a previous replacement\'s media reconfiguration is still in progress');
    }

    const oldConnection = this.connection;
    const txn: MigrationTxn = {
      conn: newConnection, events: [], retainedBytes: 0,
      aborted: false, committed: false, terminated: false,
      ...(target !== undefined ? { target } : {}),
    };
    this.currentMigration = txn; // reserve single-flight BEFORE creating the transport
    this.wireConnection(newConnection);
    this.assertMigrationLive(txn);

    let transport: WebTransportLike | undefined;
    // Armed BEFORE the factory/auth phase: a transport factory or an
    // authorization provider that never settles must not strand the handover.
    const deadline = this.armHandoverDeadline(txn);
    // Woken by any abort path (destroy, candidate death, fatal catalog failure)
    // so a never-settling factory cannot hold the slot or leave the timer armed.
    const abandoned = new Promise<'aborted'>((resolve) => {
      txn.wake = () => resolve('aborted');
    });
    // Races `work` against the attempt's terminal signals. Both signals are
    // VALUES and the only rejection is `work`'s own, so no promise is created
    // without an owner.
    const guard = async <T>(work: Promise<T>): Promise<T> => {
      const outcome = await Promise.race([
        work.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e })),
        deadline.timedOut,
        abandoned,
      ]);
      if (outcome === 'timeout') {
        throw new Error(`Handover timeout after ${this.config.connectionTimeoutMs}ms`);
      }
      if (outcome === 'aborted') throw new Error('Handover aborted during establishment');
      if (!outcome.ok) throw outcome.e;
      return outcome.v;
    };
    // `connect()` takes the transport AT ENTRY, including on authorization and
    // preflight failures, and closing the adapter closes it. Only a transport
    // connect never acquired is ours to dispose — the close-once flag below
    // cannot see `adapter.close()`.
    let adapterOwnsTransport = false;
    // Close-once owner for a transport that is still OURS, shared by the losing
    // branches and the establishment catch so none can double-close.
    let orphanClosed = false;
    const closeOrphan = (late: WebTransportLike): void => {
      if (orphanClosed) return;
      orphanClosed = true;
      try { late.close(); } catch { /* already closing/closed */ }
    };
    try {
      // The transport's owner follows the branch actually taken, never a flag
      // set by a side reaction: a derived promise reaches the race a job later
      // than the raw factory promise, so such a flag can be set while the
      // factory still wins, and both paths then close. Only a losing branch
      // attaches disposal, so the healthy path cannot close a transport it is
      // about to use.
      const settled = makeTransport().then(
        (t) => ({ ok: true as const, t }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      const outcome = await Promise.race([settled, deadline.timedOut, abandoned]);
      if (outcome === 'timeout' || outcome === 'aborted') {
        // We own nothing yet; dispose of whatever the factory eventually yields.
        void settled.then((r) => { if (r.ok) closeOrphan(r.t); });
        throw new Error(outcome === 'timeout'
          ? `Handover timeout after ${this.config.connectionTimeoutMs}ms`
          : 'Handover aborted before its transport settled');
      }
      if (!outcome.ok) throw outcome.e;
      transport = outcome.t;
      this.assertMigrationLive(txn); // destroyed/aborted during transport creation?
      // Recorded only once connect is about to be entered: set any earlier, a
      // resolved transport is stranded when abort wins in between, because the
      // adapter never took it.
      adapterOwnsTransport = true;
      await guard(newConnection.connect(transport, setupOptions));
      this.assertMigrationLive(txn);
      // ── Preparation (§7.4.1 / 16 §8.4.1 / 18 §9.4.1) ──────────────────
      // Establish a USABLE replacement before anything is retired: its own
      // catalog retrieval must converge, its required tracks must be ACCEPTED,
      // and initialization must be in hand. Every request below is issued
      // against candidate-owned state — request ids and track aliases collide
      // freely between sessions, so none of it touches live playback, and a
      // candidate that fails here leaves the old session exactly as it was.
      txn.slots = createCatalogSlots();
      txn.prep = this.createCandidatePrep();
      const candidateCatalog = await guard(this.prepareCandidateCatalog(txn, newConnection));
      this.assertMigrationLive(txn);
      txn.prep.state = candidateCatalog;
      await guard(this.prepareCandidateMedia(txn, newConnection, candidateCatalog));
      this.assertMigrationLive(txn); // validate immediately before the atomic commit
      this.revalidateCandidateSelection(txn.prep);
      if ([...this.pendingRetypes.values()].some(record => record.owner !== txn)) {
        throw new Error('Another media reconfiguration is still in progress');
      }
      if (txn.slots.catalogRequestId === null) throw new Error('Handover prepared no catalog subscription');
    } catch (err) {
      // ESTABLISHMENT rollback — nothing committed, old session untouched. Discard
      // the candidate and close any orphaned transport (idempotent with the
      // candidate close, which closes an attached transport).
      deadline.cancel();
      try {
        if (txn.prep?.reconfigurationComplete && txn.prep.reconfigured.size) await this.restorePendingRetypes(txn);
      } finally {
        if (this.currentMigration === txn) this.currentMigration = null;
        this.abandonCandidate(txn);
      }
      // Only a transport the adapter never took is disposed here; once connect
      // was entered, closing the candidate adapter closes it. A late one is
      // disposed by the losing branch above, where it really is an orphan.
      if (transport && !adapterOwnsTransport) closeOrphan(transport);
      // A terminal event on the replaced session was held while this attempt
      // looked like it would succeed. It did not, so there is no longer a
      // session to be transparent about: report it now, as the outcome it
      // actually is. Rollback is NOT claimed — there is nothing to roll back to.
      this.reportHeldOldTerminal(txn);
      // The old session was never disturbed and is still current — a GOAWAY it
      // sent while this (failed) handoff held the slot can now be acted on.
      this.processPendingGoaway();
      throw err;
    }

    deadline.cancel();
    // ── Point of no return: the candidate is validated. Commit atomically. ──
    // POST-commit: drain staged events, THEN retire the old session — with the
    // transaction kept REGISTERED (currentMigration === txn) through BOTH, so a
    // new-session close/fatal-error while the old close() is pending can still
    // mark txn.terminated. Cleanup runs in `finally` even if something throws — a
    // stranded transaction would leave a permanent "migration in progress" lock.
    // (drainStagedCandidate never throws; retireMigratedSession never throws.)
    try {
      this.commitMigration(txn, newConnection);
      this.drainStagedCandidate(txn);
    } finally {
      try {
        await this.retireMigratedSession(oldConnection);
        this.pruneSupersededSubscriptions(txn);
      } finally {
        if (this.currentMigration === txn) this.currentMigration = null;
        this.processPendingGoaway();
      }
    }
    // The single-flight slot is now released — a GOAWAY queued during drain or
    // retirement can be acted on (a fresh migration to its target). Done before
    // the termination check so a GOAWAY that raced a dying session still drives
    // recovery to the new relay.
    // The replacement may have died during drain OR during old-session
    // retirement, or the player was destroyed. In any of these the handoff did
    // not yield a usable session (session_closed/error was already surfaced), so
    // do NOT report a successful migration.
    if (txn.terminated || this._destroyed || this.isTerminalState()) throw new Error('Migration session closed during handoff');
  }

  /**
   * Throw if the in-flight transaction may no longer commit: the player was
   * destroyed, the candidate reached a terminal/overflow state, or it was
   * superseded by another transaction. Called right after each establishment
   * await, so a deferred candidate cannot resurrect a destroyed player or commit
   * a dead session.
   */
  /** A fresh prepared-candidate record. Nothing in it is readiness yet. */
  private createCandidatePrep(): CandidatePrep {
    let resolveCatalog!: (state: CatalogState) => void;
    let rejectCatalog!: (err: Error) => void;
    const catalog = new Promise<CatalogState>((res, rej) => { resolveCatalog = res; rejectCatalog = rej; });
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
    // Readiness has two faces and the attempt awaits them in sequence, so a
    // failure settles BOTH — whichever one is currently awaited must reject,
    // and the other must not be left unsettled to strand the attempt. Each
    // therefore carries its own handler: without it the face nobody is waiting
    // on rejects into no owner, which surfaces as an unhandled rejection even
    // though the attempt itself was failed correctly.
    void catalog.catch(() => { /* owned by whichever stage awaits it */ });
    void ready.catch(() => { /* idem */ });
    return {
      catalog, resolveCatalog, rejectCatalog, state: null,
      media: new Map(), initTracks: new Map(), awaiting: new Set(), reconfigured: new Map(),
      inbandInit: new Map(), inbandBytes: new Map(),
      ready, resolveReady, rejectReady, selection: null,
    };
  }

  /**
   * Run the candidate's catalog retrieval and wait for it to CONVERGE.
   *
   * Deliberately the real configured policy — the same mode resolution,
   * SUBSCRIBE options, coordinator and joining FETCH / draft-22 fill the live
   * session uses — against the candidate's OWN holder. A handover that
   * retrieved its catalog by some simplified path would prove nothing about
   * the retrieval playback then depends on.
   *
   * Convergence is the peer's answer plus a parsed catalog, never our sent
   * request: §7.4.1 (16 §8.4.1, 18 §9.4.1) lets the old subscriptions go only
   * once the replacement's have succeeded.
   */
  private async prepareCandidateCatalog(txn: MigrationTxn, conn: MoqtConnection): Promise<CatalogState> {
    const slots = txn.slots!;
    slots.catalogManager = new CatalogManager(this.config.namespace);
    await this.issueCandidateCatalogSubscribe(txn, conn);
    return txn.prep!.catalog;
  }

  /**
   * Send (or re-send) the candidate's catalog SUBSCRIBE.
   *
   * Separate from {@link prepareCandidateCatalog} because a replacement may
   * answer "not published yet, retry in N" — the same retriable refusal the
   * initial subscribe honors at startup. Within a handover that is not a
   * failure worth discarding the replacement for: the old session keeps
   * playing throughout and the attempt's own deadline bounds the waiting.
   */
  private async issueCandidateCatalogSubscribe(txn: MigrationTxn, conn: MoqtConnection): Promise<void> {
    const slots = txn.slots!;
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName(this.config.catalogTrackName));
    // Mode is resolved per CONNECTION: a replacement may negotiate a different
    // draft, and draft-22 retrieves its fill on the SUBSCRIBE itself.
    const startedCoord = slots.catalogBootstrapCoord !== null;
    const coord = slots.catalogBootstrapCoord ?? (this.resolvedCatalogMode(conn) === 'joining-fetch'
      ? this.createCatalogBootstrap(conn, slots) : null);
    const options = this.catalogSubscribeOptions(conn, slots);
    const register = options.onRequestId as (id: bigint) => void;
    let allocatedId: bigint | null = null;
    try {
      const reqId = await conn.subscribe(nsBytes, nameBytes, {
        ...options,
        onRequestId: (id: bigint) => {
          // Refuse emission rather than returning quietly: an aborted
          // candidate must not put an unowned request on the wire.
          if (txn.aborted || txn.committed) throw new Error('Handover catalog subscribe retired before emission');
          allocatedId = id;
          register(id);
        },
      } as never);
      // Callback-less adapters register after the await; a response can
      // precede send completion, so never restore an already-retired request.
      if (allocatedId === null && !txn.aborted) {
        slots.catalogRequestId = BigInt(reqId);
        this.pendingAliasBinds.add(BigInt(reqId));
      }
    } catch (err) {
      if (allocatedId !== null) this.settleParkedOwnership(allocatedId, null, conn);
      throw err;
    }
    // Started once per coordinator: a retry re-sends the SUBSCRIBE against the
    // coordinator that is already running its ladder.
    if (coord !== null && !startedCoord) coord.start();
  }

  /**
   * Honor a replacement's retry guidance for a catalog that is not published
   * yet, without failing the attempt.
   *
   * Scoped entirely to the transaction: the timer is cleared when the attempt
   * ends, the re-send is refused once the candidate is aborted or committed,
   * and the attempt deadline — not this timer — decides how long the whole
   * thing may take.
   */
  private scheduleCandidateCatalogRetry(txn: MigrationTxn, conn: MoqtConnection, retryInterval: bigint): void {
    const slots = txn.slots;
    if (slots === undefined || retryInterval <= 0n) {
      this.failCandidateCatalog(conn, 'replacement catalog is not published and gave no retry interval');
      return;
    }
    if (slots.catalogSubscribeRetryTimer !== null) return;
    // Draft-16 §9.8 / draft-18 §10.6.2 encode the minimum delay plus one.
    let remaining = retryInterval - 1n;
    const backoff = BigInt(MoqtPlayer.CATALOG_SUBSCRIBE_RETRY_MS);
    if (remaining < backoff) remaining = backoff;
    const live = (): boolean => !this._destroyed && !txn.aborted && !txn.committed
      && this.currentMigration === txn && !slots.catalogReceived;
    const arm = (): void => {
      // Wire intervals can be uint64; platform timers are signed 32-bit.
      const delay = Number(remaining > 0x7fffffffn ? 0x7fffffffn : remaining);
      const timer = setTimeout(() => {
        if (slots.catalogSubscribeRetryTimer !== timer) return;
        slots.catalogSubscribeRetryTimer = null;
        if (!live()) return;
        remaining -= BigInt(delay);
        if (remaining > 0n) { arm(); return; }
        this.log.info('[handover] retrying the replacement catalog subscribe (not published yet)');
        this.issueCandidateCatalogSubscribe(txn, conn).catch((err: unknown) => {
          if (!live()) return;
          this.failCandidateCatalog(conn, `replacement catalog retry failed to send: ${
            err instanceof Error ? err.message : String(err)}`);
        });
      }, delay);
      slots.catalogSubscribeRetryTimer = timer;
    };
    arm();
  }

  /**
   * Snapshot of the intent a replacement selection must honor.
   *
   * Taken rather than read live because selection on the live quality
   * controller would commit a track and rebuild the buffer ABR ladder for a
   * candidate that may never be adopted — mutating playback to evaluate a
   * replacement. The snapshot also carries what is PLAYING, so the
   * replacement prefers an equivalent track over re-choosing a view.
   */
  private captureHandoverIntent(): HandoverIntent {
    // The established outputs, taken from the SUBSCRIPTIONS that own them.
    // Not reconstructed from the catalog: a name is unique only per namespace
    // (§5.2.3), so a `find` by role and name would capture whichever
    // declaration comes first rather than the one that is playing.
    let activeVideoTrack: TrackIdentity | null = null;
    let activeAudioTrack: TrackIdentity | null = null;
    for (const sub of this.activeSubscriptions.values()) {
      if (sub.trackAlias !== null && this.supersededRouting?.aliases.has(sub.trackAlias)) continue;
      if (this._catalogState !== null && this.catalogTrackFor(sub.trackName,
        sub.namespace ?? namespaceFields(this.config.namespace), sub.mediaType) === undefined) continue;
      const identity: TrackIdentity = {
        namespaceFields: sub.namespace ?? namespaceFields(this.config.namespace),
        name: sub.trackName,
      };
      if (sub.mediaType === 'video' && activeVideoTrack === null) activeVideoTrack = identity;
      if (sub.mediaType === 'audio' && activeAudioTrack === null) activeAudioTrack = identity;
    }
    const establishedVideo = activeVideoTrack !== null;
    const configured = this.selectionIntent();
    activeVideoTrack ??= configured?.videoTrack ?? null;
    activeAudioTrack ??= configured?.audioTrack ?? null;
    // The CURRENT view, not the configured default: if the replacement's
    // catalog no longer carries the active track, selection must fail rather
    // than quietly switch the viewer to another angle. The live catalog is the
    // authority for which altGroup the active track belongs to.
    const activeVideo = activeVideoTrack !== null
      ? this._catalogState?.tracks.find(t => t.role === 'video'
        && t.name === activeVideoTrack!.name
        && sameNamespaceFields(trackNamespaceFields(t, this.config.namespace),
          activeVideoTrack!.namespaceFields))
      : undefined;
    // `null` and `undefined` are DIFFERENT intents: null means the established
    // view is ungrouped, undefined means there is no established view at all.
    // Collapsing them would let an ungrouped active view be replaced by some
    // grouped view once its own track disappears.
    const altGroup = activeVideo ? activeVideo.altGroup ?? null
      : this.config.videoAltGroup ?? this.config.selection?.videoAltGroup;
    const activeAudio = this.subscribedTrack('audio');
    const alternates = (track: CatalogTrack | undefined): readonly TrackIdentity[] => {
      if (track === undefined) return [];
      return (this._catalogState?.tracks.filter(other => other.role === track.role
        && other.renderGroup === track.renderGroup
        && (track.altGroup === undefined ? other === track : other.altGroup === track.altGroup)) ?? [])
        .map(other => ({ name: other.name, namespaceFields: [...trackNamespaceFields(other, this.config.namespace)] }));
    };
    const activeScope = activeVideo ?? activeAudio;
    return {
      // The LIVE mode, not the configured one: selectVideoTrack() and
      // unlockAuto() change auto quality at runtime.
      autoQuality: this.qualityController?.isAutoQuality ?? this.config.autoQuality !== false,
      startLevel: this.config.startLevel ?? 'auto',
      ...(this.config.capLevelToResolution !== undefined
        ? { capLevelToResolution: this.config.capLevelToResolution } : {}),
      qualitySwitchCooldownMs: this.config.qualitySwitchCooldownMs ?? 0,
      // Indexes allAlternatives: currentIndex is local to the codec family's
      // ladder, so it does not identify a level across catalogs.
      manualLevel: this.qualityController && !this.qualityController.isAutoQuality
        ? this.qualityController.allAlternatives.findIndex(t => activeVideoTrack !== null
          && this.initKey(t) === identityKey(activeVideoTrack.namespaceFields, activeVideoTrack.name))
        : null,
      catalogNamespace: this.config.namespace,
      // The scope this presentation belongs to: configured, else the one the
      // established video was declared in.
      ...(this.config.selection?.renderGroup !== undefined
        ? { scope: this.config.selection.renderGroup }
        : activeScope !== undefined ? { scope: activeScope.renderGroup ?? null } : {}),
      activeVideoTrack, activeAudioTrack,
      videoAlternates: alternates(activeVideo), audioAlternates: alternates(activeAudio),
      // A pin is an EXPLICIT choice: configured here, or made at runtime by
      // `selectVideoTrack()`, which is what leaving automatic mode records.
      pinnedVideo: establishedVideo && this.qualityController !== null
        ? !this.qualityController.isAutoQuality : configured?.videoTrack !== undefined,
      pinnedAudio: this.config.selection?.audioTrack !== undefined,
      disableVideo: this.config.disableVideo === true,
      disableAudio: this.config.disableAudio === true,
      ...(altGroup !== undefined ? { videoAltGroup: altGroup } : {}),
      ...(activeAudio?.altGroup !== undefined ? { audioAltGroup: activeAudio.altGroup }
        : this.config.selection?.audioAltGroup !== undefined
          ? { audioAltGroup: this.config.selection.audioAltGroup } : {}),
      ...(this.config.videoConstraints !== undefined ? { videoConstraints: this.config.videoConstraints } : {}),
      ...(this.config.audioConstraints !== undefined ? { audioConstraints: this.config.audioConstraints } : {}),
    };
  }

  /**
   * Prepare the replacement's media: select, validate initialization, issue
   * the real SUBSCRIBEs, and wait for the peer to ACCEPT every required track
   * and for initialization we can actually use.
   *
   * The subscriptions issued here are the ones adoption binds to the existing
   * pipelines — adoption never subscribes again.
   */
  private async prepareCandidateMedia(
    txn: MigrationTxn, conn: MoqtConnection, catalog: CatalogState,
  ): Promise<void> {
    const prep = txn.prep!;
    catalog = structuredClone(catalog);
    const intent = structuredClone(this.captureHandoverIntent());
    const chosen = prepareHandoverSelection(catalog, intent, this.clock);
    if (!chosen.ok) throw new Error(`replacement selection failed: ${chosen.reason}`);
    const required: Array<{ track: CatalogTrack; mediaType: 'video' | 'audio' }> = [];
    if (chosen.video) required.push({ track: chosen.video, mediaType: 'video' });
    if (chosen.audio) required.push({ track: chosen.audio, mediaType: 'audio' });
    // An empty required set is NOT success: there would be nothing to play on
    // the replacement, and adopting it would silence playback that still works.
    if (required.length === 0) throw new Error('replacement offers no enabled media track');
    prep.selection = { video: chosen.video ?? null, audio: chosen.audio ?? null };

    // Initialization is validated BEFORE any media SUBSCRIBE, exactly as the
    // live path does: a CMAF track with no codec or undecodable inline init
    // can never configure MSE, and must fail the candidate rather than
    // retire working playback in favor of a silent one.
    for (const { track, mediaType } of required) {
      if (!isMsePackaging(track.packaging)) continue;
      if (!track.codec) {
        throw new Error(`replacement CMAF track "${track.name}" (${mediaType}): no codec string — cannot configure MSE`);
      }
      if (track.initRef !== undefined
          && catalog.initDataList?.some(e => e.id === track.initRef) !== true) {
        throw new Error(`replacement CMAF track "${track.name}" (${mediaType}): initRef "${
          track.initRef}" is not in the replacement catalog — cannot configure MSE`);
      }
      try {
        // Resolved against the REPLACEMENT's own root: an initRef naming an
        // entry the live catalog happens to carry would otherwise validate
        // bytes this session will never send.
        this.decodeResolvedInlineInitData(track, catalog);
      } catch (err) {
        throw new Error(`replacement CMAF track "${track.name}" (${mediaType}): ${
          err instanceof Error ? err.message : String(err)} — cannot configure MSE`);
      }
    }

    // A handover keeps the RUNNING decoders: the pipelines, their MSE source
    // buffers and their configuration all survive it, which is what makes
    // playback continue across the move. A replacement that would need a
    // different decoder configuration therefore cannot simply be adopted — and
    // the place to find that out is HERE, before anything is retired, not
    // after the old session is gone. Changing codec mid-session is a separate
    // mechanism (the track-switch path's staged flush + `changeType`); until
    // adoption can drive it, such a replacement is declined with the old
    // session still playing.
    for (const { track, mediaType } of required) {
      const reason = this.unadoptableTransition(track, mediaType);
      if (reason !== null) throw new Error(`replacement ${mediaType} track "${track.name}": ${reason}`);
    }

    // §5.1: the application's own subscribe policy applies to a replacement
    // exactly as it does to a first subscribe — a hook that cancels a track
    // must not be bypassed just because this session is a handover. A
    // cancelled track stops being REQUIRED (the application declined it), and
    // if that leaves nothing to play the replacement is declined rather than
    // adopted silent.
    const wanted = required.filter(({ track, mediaType }) =>
      this.hooks.beforeSubscribe.run({
        trackName: track.name, mediaType,
        namespace: trackNamespaceFields(track, this.config.namespace),
      }) !== null);
    if (wanted.length === 0) {
      throw new Error('replacement has no subscribable media track (all cancelled by beforeSubscribe)');
    }
    required.length = 0;
    required.push(...wanted);
    prep.selection = {
      video: required.find(r => r.mediaType === 'video')?.track ?? null,
      audio: required.find(r => r.mediaType === 'audio')?.track ?? null,
    };
    prep.snapshot = {
      catalog,
      intent: {
        ...intent,
        scope: (chosen.video ?? chosen.audio)!.renderGroup ?? null,
        disableVideo: prep.selection.video === null,
        disableAudio: prep.selection.audio === null,
      },
      selection: prep.selection,
    };
    prep.controller = chosen.controller;

    const subscribeOptions = buildSubscribeOptions(this.config);
    // The candidate addresses each track by the identity the CATALOG gives
    // it, exactly as startup does — a request computed once from config would
    // send one namespace while the hook, the credentials and the selection
    // all describe another.
    const nsOf = (track: CatalogTrack): readonly string[] =>
      trackNamespaceFields(track, this.config.namespace);
    const keyOf = (track: CatalogTrack): string => identityKeyOf(nsOf(track), track.name);
    // Every required track, and every init track it needs, must be answered
    // before readiness. Recorded up front so an acceptance arriving while we
    // are still sending the next SUBSCRIBE finds its expectation in place.
    // Keyed by identity: two media types may name their tracks the same in
    // different namespaces, and those are different expectations.
    for (const { track } of required) prep.awaiting.add(keyOf(track));
    for (const { track, mediaType } of required) {
      if (!isMsePackaging(track.packaging) || track.initTrack !== undefined) continue;
      if (this.resolveInlineInitData(track, catalog) !== undefined) continue;
      // Neither inline nor an init track: initialization can still arrive
      // IN BAND as an ftyp+moov object, which is how an ordinary startup is
      // allowed to initialize too. So the replacement is not ready on
      // acceptance alone — it is ready once it has actually delivered that
      // header. Reusing the live session's initialization instead would adopt
      // on the strength of bytes this session never sent, and refusing
      // outright would reject a perfectly ordinary publisher.
      prep.awaiting.add(`in-band:${keyOf(track)}`);
      prep.inbandInit.set(keyOf(track), mediaType);
    }
    for (const { track } of required) {
      if (track.initTrack === undefined) continue;
      // Deliberately NOT short-circuited by the live init cache. A track name
      // is shared across sessions; its CONTENT is not. Reusing the old
      // session's cached init would adopt a replacement on the strength of
      // bytes the replacement never sent — and would hide the case where its
      // own init is missing, refused or different.
      // LIBRARY POLICY (cf01 §3.2.16 is silent; §3.2.18 states it for
      // `depends`): an init track belongs to the namespace of the track that
      // references it.
      const initNamespace = nsOf(track);
      prep.initTracks.set(identityKeyOf(initNamespace, track.initTrack), {
        name: track.initTrack, namespace: initNamespace,
        reqId: null, alias: null, bytes: null,
      });
      prep.awaiting.add(identityKeyOf(initNamespace, track.initTrack));
    }

    const issue = async (
      name: string, namespace: readonly string[], mediaType: 'video' | 'audio',
      packaging: TrackPackaging, isLive: boolean, initKey: string | null,
    ): Promise<void> => {
      if (initKey !== null && this.hooks.beforeSubscribe.run({
        trackName: name, namespace, mediaType: 'init',
      }) === null) throw new Error(`replacement init subscription "${name}" cancelled by beforeSubscribe`);
      const options = initKey !== null
        ? { subscriptionFilter: { type: 'AbsoluteStart' as const, startGroup: varint(0n), startObject: varint(0n) } }
        : (subscribeOptions ?? defaultMediaSubscriptionFilter(isLive));
      let allocated: bigint | null = null;
      const claim = (id: bigint): void => {
        if (txn.aborted || txn.committed) throw new Error('Handover media subscribe retired before emission');
        allocated = id;
        // Candidate-owned: request ids collide across sessions, so this never
        // reaches activeSubscriptions / pendingMediaSubs before adoption.
        if (initKey !== null) prep.initTracks.get(initKey)!.reqId = id;
        else prep.media.set(id, { trackName: name, namespace, mediaType, packaging, alias: null });
      };
      const reqId = await conn.subscribe(namespace.map(field => this.enc.encode(field)), this.enc.encode(name),
        { ...options, ...(initKey === null ? this.mediaTerminalOptions(conn) : {}), onRequestId: claim } as never);
      if (allocated === null) claim(BigInt(reqId));
    };

    for (const { track, mediaType } of required) {
      await issue(track.name, nsOf(track), mediaType,
        mediaTrackPackaging(track.packaging), track.isLive === true, null);
    }
    for (const [initKey, init] of prep.initTracks) {
      // mediaType is a placeholder — init routing is driven by packaging.
      await issue(init.name, init.namespace, 'video', 'init', false, initKey);
    }
    await prep.ready;
    this.revalidateCandidateSelection(prep);

    // ── Changed initialization: reconfigure, or decline ─────────────────
    // Initialization can only be compared once it is in hand, which for an
    // init track is after acceptance. Still BEFORE commit, so the old session
    // is intact for either outcome: the running source buffer is retyped to
    // the replacement's initialization, and only a media adapter that cannot
    // do that makes the replacement unusable.
    // Decided for EVERY required track before anything is mutated, so a
    // replacement that cannot be reconfigured is declined without having
    // touched the source buffers that are still playing.
    const retypes: Array<{ mediaType: 'video' | 'audio'; codec: string; next: Uint8Array; previous: Uint8Array }> = [];
    for (const { track, mediaType } of required) {
      if (!this.cmafInitialized || !this.usesMse(track.packaging)) continue;
      const delivered = this.preparedInitBytes(prep, track, catalog);
      if (track.initTrack !== undefined && delivered === undefined) {
        // Readiness cannot have resolved without these bytes; the check keeps
        // that invariant local rather than assuming it.
        throw new Error(`replacement ${mediaType} track "${track.name}": initialization was never delivered`);
      }
      const running = this.runningInitBytes(mediaType);
      if (delivered === undefined || running === undefined || bytesEqual(running, delivered)) continue;
      // The codec is unchanged here (a changed codec was declined above), but
      // the initialization is not: a source buffer's init segment must match
      // the media appended against it.
      if (this.mediaSource?.changeType === undefined) {
        throw new Error(`replacement ${mediaType} track "${track.name}": initialization changed and this media adapter cannot reconfigure (no changeType)`);
      }
      retypes.push({ mediaType, codec: track.codec ?? '', next: delivered, previous: running });
    }
    if (retypes.length > 0) await this.retypeForReplacement(txn, prep, retypes);
    prep.reconfigurationComplete = true;
  }

  /** Validate readiness against the latest catalog without changing playback. */
  private revalidateCandidateSelection(prep: CandidatePrep): void {
    const snapshot = prep.snapshot;
    if (snapshot === undefined || prep.state === null || prep.awaiting.size !== 0) {
      throw new Error('replacement selection has no complete preparation');
    }
    const latest = prepareHandoverSelection(prep.state, {
      ...snapshot.intent,
      ...this.captureHandoverIntent(),
      // A hook may have declined an output for this attempt. Revalidation
      // must not recreate that request, even when the old session has it.
      disableVideo: snapshot.intent.disableVideo,
      disableAudio: snapshot.intent.disableAudio,
    }, this.clock);
    if (!latest.ok) throw new Error(`replacement selection changed during preparation: ${latest.reason}`);
    for (const mediaType of ['video', 'audio'] as const) {
      const prepared = snapshot.selection[mediaType];
      const track = latest[mediaType];
      if (prepared === null && track === null) continue;
      if (prepared === null || track === null || this.initKey(prepared) !== this.initKey(track)) {
        throw new Error(`replacement ${mediaType} selected identity changed during preparation`);
      }
      // Decoder and subscription semantics must still describe the request
      // already accepted. Labels and unrelated catalog additions may change.
      const fields = ['role', 'packaging', 'codec', 'mimeType', 'locmafVersion', 'renderGroup',
        'altGroup', 'isLive', 'width', 'height', 'samplerate', 'channelConfig', 'timescale', 'initTrack'] as const;
      if (fields.some(field => prepared[field] !== track[field])) {
        throw new Error(`replacement ${mediaType} selection configuration changed during preparation`);
      }
      const subscribed = [...prep.media.values()].some(sub => sub.mediaType === mediaType
        && sub.alias !== null && sub.trackName === track.name
        && sameNamespaceFields(sub.namespace, trackNamespaceFields(track, this.config.namespace))
        && sub.packaging === mediaTrackPackaging(track.packaging));
      if (!subscribed) throw new Error(`replacement ${mediaType} selection has no accepted prepared subscription`);
      if (!isMsePackaging(track.packaging)) continue;
      if (track.initRef !== undefined && prep.state.initDataList?.some(e => e.id === track.initRef) !== true) {
        throw new Error(`replacement ${mediaType} initialization reference changed during preparation`);
      }
      const before = this.decodeResolvedInlineInitData(prepared, snapshot.catalog);
      const after = this.decodeResolvedInlineInitData(track, prep.state);
      if ((before === undefined) !== (after === undefined)
          || (before !== undefined && after !== undefined && !bytesEqual(before, after))) {
        throw new Error(`replacement ${mediaType} initialization changed during preparation`);
      }
      if (track.initTrack !== undefined) {
        const init = prep.initTracks.get(identityKeyOf(trackNamespaceFields(track, this.config.namespace), track.initTrack));
        if (init?.alias == null || init.bytes === null) {
          throw new Error(`replacement ${mediaType} initialization has no accepted prepared init subscription`);
        }
      }
      if (this.preparedInitBytes(prep, track, prep.state) === undefined) {
        throw new Error(`replacement ${mediaType} initialization was not prepared`);
      }
    }
    prep.selection = { video: latest.video, audio: latest.audio };
    prep.controller = latest.controller;
  }

  /** Record ownership before a source-buffer mutation; its caller adopts or restores it. */
  private async applyMediaRetype(owner: object, change: {
    source: MediaSourceLike;
    mediaType: 'video' | 'audio';
    codec: string;
    next: Uint8Array;
    previousCodec: string;
    previous: Uint8Array;
    offset: number | undefined;
  }): Promise<void> {
    const { source, mediaType, codec, next, previousCodec, previous, offset } = change;
    if (this._destroyed || this.isTerminalState() || source !== this.mediaSource) {
      throw new Error('Media source retired before reconfiguration');
    }
    if (this.pendingRetypes.has(mediaType)
        || [...this.pendingRetypes.values()].some(record => record.owner !== owner)) {
      throw new Error('Media reconfiguration is already in progress');
    }
    if (!source.changeType) throw new Error('Media source cannot reconfigure');
    this.retypingMedia.add(mediaType);
    this.pendingRetypes.set(mediaType, { owner, source, codec: previousCodec, previous, offset });
    await source.changeType(mediaType, codec, next);
    if (!this._destroyed && source === this.mediaSource) this.restoreTimestampOffset(mediaType, offset, source);
  }

  /**
   * Retype the running source buffers to the replacement's initialization.
   *
   * This is the one step of preparation that MUTATES live playback, so it
   * carries its own fence and its own undo:
   *
   * - each type is fenced before its retype starts, because MSE queues appends
   *   across `changeType` and drains them against the NEW initialization;
   * - the retypes run one at a time, so a failure has a known prefix;
   * - a failure UNDOES the retypes that already succeeded, because declining
   *   the candidate means the old session keeps playing and its media must
   *   still match its buffers. A video retype followed by an audio refusal
   *   must not leave video on the replacement's initialization.
   *
   * If the undo itself fails the buffer no longer matches either session, and
   * that is reported as what it is — a fatal playback fault — rather than
   * described as a successful rollback.
   */
  private async retypeForReplacement(
    txn: MigrationTxn, prep: CandidatePrep,
    retypes: Array<{ mediaType: 'video' | 'audio'; codec: string; next: Uint8Array; previous: Uint8Array }>,
  ): Promise<void> {
    const source = this.mediaSource!;
    // Snapshot every offset before any mutation. The ongoing timeline must
    // survive even a custom adapter that rebases during reconfiguration; a
    // throwing second accessor must not strand an already-mutated first type.
    const offsets = new Map<'video' | 'audio', number | undefined>();
    for (const { mediaType } of retypes) {
      // Nothing is fenced or mutated yet, so a throw here needs no undo.
      offsets.set(mediaType, source.getTimestampOffset?.(mediaType));
    }
    for (const { mediaType, codec, next, previous } of retypes) {
      this.log.info('[handover] reconfiguring %s for the replacement initialization', mediaType);
      const offset = offsets.get(mediaType);
      // Fence and record BEFORE the call. A `changeType` that throws may
      // already have changed the buffer, and one that never settles still
      // owns it, so both have to be recoverable from here.
      try {
        await this.applyMediaRetype(txn, {
          source, mediaType, codec, next, previousCodec: codec, previous, offset,
        });
      } catch (err) {
        await this.restorePendingRetypes(txn);
        throw err;
      }
      prep.reconfigured.set(mediaType, next);
      // Checked AFTER the mutation is recorded: a retype that completes late —
      // past the attempt deadline, or after the attempt was abandoned — has
      // still changed the buffer the OLD session is playing through, and
      // restoring it is the only thing that makes that session usable again.
      if (this._destroyed || txn.aborted || txn.committed || this.currentMigration !== txn) {
        await this.restorePendingRetypes(txn);
        throw new Error('Handover aborted during media reconfiguration');
      }
    }
  }

  /**
   * Put back the initialization of every buffer an unfinished handover
   * retyped, and lift its fence.
   *
   * Reached when the attempt will not be adopted: declined, timed out,
   * abandoned, or destroyed. If the media source is gone there is nothing to
   * restore and nothing to protect, so the records are simply dropped — a
   * destroyed source must never be reconfigured. If a restore itself fails the
   * buffer matches neither session, which is reported as the fatal fault it is
   * rather than described as a successful rollback.
   */
  private async restorePendingRetypes(owner: object): Promise<void> {
    for (const [mediaType, record] of [...this.pendingRetypes].reverse()) {
      if (record.owner !== owner) continue;
      const source = record.source;
      const changeType = source.changeType;
      if (this._destroyed || source !== this.mediaSource || changeType === undefined) {
        // Nothing to restore and nothing to protect: a destroyed source must
        // never be reconfigured.
        this.pendingRetypes.delete(mediaType);
        this.retypingMedia.delete(mediaType);
        continue;
      }
      try {
        // The record stays in place ACROSS the undo, so the migrate guard
        // cannot admit a successor onto a source this restore is still
        // mutating; it is released below, and only if it is still ours.
        await changeType.call(source, mediaType, record.codec, record.previous);
        // The old session's own media is on the original timeline, so putting
        // the initialization back without the offset would leave it
        // unplayable — which is why this failure is fatal below rather than
        // logged.
        this.restoreTimestampOffset(mediaType, record.offset, source);
      } catch (undoErr) {
        // A rejected `changeType` is NOT a promise that nothing changed —
        // there is no such guarantee in the interface, and a call that mutates
        // and then fails is exactly how this path is reached. So a buffer we
        // could not put back matches neither session, and that is reported as
        // the fatal fault it is rather than described as a rollback.
        this.failCatalogPlayback(createPlayerError(
          'fatal', 'player', PlayerErrorCode.CMAF_INIT_INVALID,
          `Could not restore ${mediaType} initialization after an abandoned media reconfiguration: ${
            undoErr instanceof Error ? undoErr.message : String(undoErr)}`,
          undoErr instanceof Error ? { cause: undoErr } : {},
        ));
      } finally {
        // Identity-safe release: a later attempt may legitimately have
        // recorded its OWN retype for this type while the undo was awaited,
        // and that one is not finished.
        if (this.pendingRetypes.get(mediaType) === record) {
          this.pendingRetypes.delete(mediaType);
          this.retypingMedia.delete(mediaType);
        }
      }
    }
  }

  /**
   * Put a source buffer's timestamp offset back after a retype.
   *
   * A handover retains the ongoing timeline, so the offset that was in force
   * before the retype is still the right one. Skipped when the adapter cannot
   * report or set it, in which case nothing here can improve on its choice.
   */
  private restoreTimestampOffset(mediaType: 'video' | 'audio', offset: number | undefined, source = this.mediaSource): void {
    // Nothing to put back: an adapter that cannot report its offset was never
    // rebased by us, and one that cannot set it has no offset to speak of.
    if (offset === undefined) return;
    if (source === null || source === undefined || source.setTimestampOffset === undefined) return;
    // Deliberately NOT swallowed. A buffer left on the retype's rebased offset
    // places the media it is about to receive a playback position away from
    // the timeline it is on, and the caller treats that as the failed
    // reconfiguration it is.
    source.setTimestampOffset(mediaType, offset);
    // "Did not throw" is NOT evidence that it took. A real MSE adapter cannot
    // write `timestampOffset` while its SourceBuffer is updating and declines
    // silently rather than failing, and an adapter may also catch its own
    // error. So the value is read back: a buffer still sitting on the retype's
    // rebased offset fails the reconfiguration instead of being adopted, and
    // fails the undo loudly instead of hiding it.
    const readback = source.getTimestampOffset?.(mediaType);
    if (readback !== undefined && readback !== offset) {
      throw new Error(`the ${mediaType} timestamp offset is ${readback} after being set to ${offset}`);
    }
  }

  /**
   * The initialization the REPLACEMENT will use for `track` — inline, resolved
   * through its own root, or delivered on its own init track.
   */
  private preparedInitBytes(
    prep: CandidatePrep, track: CatalogTrack, catalog: CatalogState,
  ): Uint8Array | undefined {
    if (track.initTrack !== undefined) {
      // The init track of THIS track, in THIS track's namespace.
      const key = identityKeyOf(trackNamespaceFields(track, this.config.namespace), track.initTrack);
      return prep.initTracks.get(key)?.bytes ?? undefined;
    }
    try {
      const inline = this.decodeResolvedInlineInitData(track, catalog);
      if (inline !== undefined) return inline;
    } catch {
      return undefined; // validated separately, before any media request
    }
    // Declared nowhere, delivered in band.
    for (const sub of prep.media.values()) {
      if (sub.trackName === track.name && sameNamespaceFields(sub.namespace,
        trackNamespaceFields(track, this.config.namespace))) return prep.inbandBytes.get(sub.mediaType);
    }
    return undefined;
  }

  /**
   * Why `track` cannot replace what `mediaType` is playing, or null if it can.
   *
   * Compares against the LIVE selection rather than a cached codec string, so
   * video and audio are checked the same way and the comparison is against
   * what the pipelines were actually built from.
   */
  private unadoptableTransition(track: CatalogTrack, mediaType: 'video' | 'audio'): string | null {
    if (!this.pipelinesCreated) return null; // nothing configured yet
    const running = this.subscribedTrack(mediaType);
    if (running === undefined) return null; // nothing to compare against
    if (mediaTrackPackaging(running.packaging) !== mediaTrackPackaging(track.packaging)) {
      return `packaging changes from "${running.packaging ?? ''}" to "${track.packaging ?? ''}"`;
    }
    if (this.cmafInitialized && this.usesMse(track.packaging) && !codecsCompatible(running.codec ?? '', track.codec ?? '')) {
      return `codec changes from "${running.codec ?? ''}" to "${track.codec ?? ''}"`;
    }
    // Changed INITIALIZATION is not decided here: it is handled after the
    // replacement has delivered it, by retyping the running source buffer, and
    // only an adapter that cannot retype declines. Deciding it here would also
    // be premature for an init track, whose bytes have not arrived yet.
    return null;
  }

  /** The initialization the running pipeline for `mediaType` was built from. */
  private runningInitBytes(mediaType: 'video' | 'audio'): Uint8Array | undefined {
    const installed = this.installedCmafInit.get(mediaType);
    if (installed && installed.source === this.mediaSource) return installed.bytes;
    const running = this.subscribedTrack(mediaType);
    if (running === undefined) return undefined;
    if (running.initTrack !== undefined) return this.initSegmentByTrack.get(this.initKey(running, running.initTrack));
    const inBand = this.initSegmentByTrack.get(this.initKey(running));
    if (inBand !== undefined) return inBand;
    try { return this.decodeResolvedInlineInitData(running); } catch { return undefined; }
  }

  /** Record a candidate media acceptance; readiness may now be complete. */
  private onCandidateSubscribeAccepted(txn: MigrationTxn, reqId: bigint, alias: bigint): void {
    const prep = txn.prep;
    if (!prep) return;
    const sub = prep.media.get(reqId);
    if (sub) {
      sub.alias = alias;
      // Media retained before this acceptance deliberately STAYS retained: it
      // is payload, not evidence, and must reach playback exactly once —
      // after adoption, through the ordinary replay, never into the session
      // that is still playing.
      // An accepted required track still needs initialization; the init track
      // (when the catalog uses one) clears separately.
      prep.awaiting.delete(identityKeyOf(sub.namespace, sub.trackName));
      this.checkCandidateReady(txn);
      return;
    }
    for (const init of prep.initTracks.values()) {
      if (init.reqId !== reqId) continue;
      init.alias = alias;
      // An init track is a single object too, and it may well have arrived
      // before this acceptance.
      this.releaseEarlyCandidateData(txn, alias, (_streamId, obj) => {
        if (obj.kind === 'data') this.onCandidateInitBytes(txn, alias, obj.payload);
      });
      return;
    }
  }

  /**
   * Note that a retained candidate media object carries the track's in-band
   * initialization.
   *
   * The object is still PAYLOAD and stays retained for the ordinary post
   * adoption replay — this only observes that the evidence exists. Handling it
   * here instead would deliver media into a session nobody is playing yet, and
   * then replay the same object again after adoption.
   */
  private noteCandidateInbandInit(txn: MigrationTxn, alias: bigint, obj: MoqtObject): void {
    const prep = txn.prep;
    if (prep === undefined || prep.inbandInit.size === 0 || obj.kind !== 'data') return;
    let trackKey: string | null = null;
    for (const sub of prep.media.values()) {
      const key = identityKeyOf(sub.namespace, sub.trackName);
      if (sub.alias === alias && prep.inbandInit.has(key)) { trackKey = key; break; }
    }
    if (trackKey === null) return;
    if (!isCmafHeader(obj.payload)) return;
    const mediaType = prep.inbandInit.get(trackKey)!;
    prep.inbandInit.delete(trackKey);
    prep.inbandBytes.set(mediaType, obj.payload);
    prep.awaiting.delete(`in-band:${trackKey}`);
    this.log.info('[handover] replacement delivered in-band %s initialization', mediaType);
    this.checkCandidateReady(txn);
  }

  /** Record delivered init bytes for a candidate init track. */
  private onCandidateInitBytes(txn: MigrationTxn, alias: bigint, bytes: Uint8Array): boolean {
    const prep = txn.prep;
    if (!prep) return false;
    for (const [name, init] of prep.initTracks) {
      if (init.alias !== alias) continue;
      if (init.bytes === null && bytes.byteLength > 0) {
        init.bytes = bytes;
        prep.awaiting.delete(name);
        this.checkCandidateReady(txn);
      }
      return true;
    }
    return false;
  }

  /** Readiness barrier: every required track accepted AND initialized. */
  private checkCandidateReady(txn: MigrationTxn): void {
    const prep = txn.prep;
    if (!prep || txn.aborted || txn.committed) return;
    if (prep.awaiting.size > 0) return;
    if (prep.media.size === 0) return;
    for (const sub of prep.media.values()) if (sub.alias === null) return;
    prep.resolveReady();
  }

  private assertMigrationLive(txn: MigrationTxn): void {
    if (this._destroyed) throw new Error('Migration aborted: player destroyed during establishment');
    if (this.isTerminalState()) throw new Error('Migration aborted: playback terminated during establishment');
    if (this.currentMigration !== txn || txn.aborted) throw new Error('Migration aborted: candidate no longer valid');
  }

  /**
   * Append a bounded event to a transaction's staged queue. Overflow (event or
   * byte cap) aborts and closes the candidate rather than silently dropping a
   * possibly-essential event. Shared by the callback staging wrapper and the
   * deferred degraded-error diagnostic.
   */
  private stageMigrationEvent(
    txn: MigrationTxn, run: () => void, bytes: number, source: MoqtConnectionErrorSource,
    tag?: { alias?: bigint; streamId?: bigint; obj?: MoqtObject },
  ): void {
    if (txn.events.length >= MoqtPlayer.MAX_STAGED_EVENTS || txn.retainedBytes + bytes > MoqtPlayer.MAX_STAGED_BYTES) {
      this.abortMigration(txn);
      return;
    }
    txn.retainedBytes += bytes;
    txn.events.push({ run, source, ...(tag ?? {}) });
  }

  /**
   * Take back the data a candidate retained for `alias` before that alias was
   * bound, now that binding says what it is.
   *
   * Draft-16 §10.4.2, draft-18 §11.4.2 and draft-22 §3.1.3.1 all permit data
   * to precede the message that establishes the track
   * alias, and for a catalog or an init track that data may be the ONLY object
   * there will ever be — so dropping it, or leaving it retained until an
   * adoption that depends on it, both deadlock the handover. Entries are
   * returned in arrival order and removed from the queue, so nothing is both
   * handled now and replayed again after adoption.
   */
  private takeStagedForAlias(txn: MigrationTxn, alias: bigint): Array<{ streamId: bigint; obj: MoqtObject }> {
    const taken: Array<{ streamId: bigint; obj: MoqtObject }> = [];
    const kept: MigrationTxn['events'][number][] = [];
    for (const event of txn.events) {
      if (event.alias === alias && event.obj !== undefined && event.streamId !== undefined) {
        taken.push({ streamId: event.streamId, obj: event.obj });
        txn.retainedBytes -= MoqtPlayer.STAGED_EVENT_BASE_BYTES
          + (event.obj.kind === 'data' ? event.obj.payload.byteLength : 0);
        continue;
      }
      kept.push(event);
    }
    if (taken.length === 0) return taken;
    txn.events.length = 0;
    txn.events.push(...kept);
    if (txn.retainedBytes < 0) txn.retainedBytes = 0;
    return taken;
  }

  /**
   * Take the retained LIFECYCLE events (FIN, reset, header) belonging to
   * `streams`, so they can be delivered after their objects.
   *
   * A terminal names a stream, not an alias, so it is reclaimed by stream once
   * that stream's objects turn out to be evidence. Delivered AFTER all of
   * them, exactly once: a multi-object stream must never see its terminal
   * between its own objects, which would corrupt the clean-chain evidence a
   * valid independent-plus-delta sequence depends on.
   */
  private takeStagedLifecycle(txn: MigrationTxn, streams: Set<bigint>): Array<() => void> {
    const taken: Array<() => void> = [];
    const kept: MigrationTxn['events'][number][] = [];
    for (const event of txn.events) {
      if (event.obj === undefined && event.streamId !== undefined && streams.has(event.streamId)) {
        taken.push(event.run);
        txn.retainedBytes -= MoqtPlayer.STAGED_EVENT_BASE_BYTES;
        continue;
      }
      kept.push(event);
    }
    if (taken.length === 0) return taken;
    txn.events.length = 0;
    txn.events.push(...kept);
    if (txn.retainedBytes < 0) txn.retainedBytes = 0;
    return taken;
  }

  /**
   * Deliver everything the candidate retained for an alias it has just bound.
   *
   * Objects first and in arrival order, then each affected stream's terminal.
   * `handle` decides what the data IS — a catalog object, or an init track's
   * bytes — because only the binding knew.
   */
  private releaseEarlyCandidateData(
    txn: MigrationTxn, alias: bigint, handle: (streamId: bigint, obj: MoqtObject) => void,
  ): void {
    const early = this.takeStagedForAlias(txn, alias);
    if (early.length === 0) return;
    const streams = new Set<bigint>();
    for (const { streamId, obj } of early) {
      streams.add(streamId);
      handle(streamId, obj);
    }
    for (const run of this.takeStagedLifecycle(txn, streams)) {
      try {
        run();
      } catch (err) {
        this.log.warn('[handover] retained stream lifecycle failed on release: %s',
          err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * Abort an in-flight transaction from an out-of-band signal (candidate close /
   * error, or staging overflow): mark it terminal, drop its staged events,
   * DETACH the candidate's callbacks so no racing event runs live, and close it.
   * The pending connect/subscribe then rejects (or {@link assertMigrationLive}
   * throws), routing the transaction through its rollback.
   */
  private abortMigration(txn: MigrationTxn): void {
    if (txn.aborted) return;
    txn.aborted = true;
    txn.wake?.();
    txn.committed = true; // stop staging
    txn.events.length = 0;
    txn.retainedBytes = 0;
    this.detachConnectionCallbacks(txn.conn);
    void txn.conn.close().catch(() => { /* candidate closing/closed */ });
  }

  /**
   * Roll back a failed transaction: detach the candidate's callbacks FIRST (so no
   * data racing its close runs live against old-session state), drop its staged
   * events, purge anything it buffered, and close it. Idempotent with a prior
   * {@link abortMigration}.
   */
  private abandonCandidate(txn: MigrationTxn): void {
    // A fence guarding an UNSETTLED retype stays up: its `changeType` may
    // still complete and change the buffer, and appending the old session's
    // media in between is exactly what the fence exists to prevent. Only
    // fences with no outstanding mutation come down here.
    for (const mediaType of [...this.retypingMedia]) {
      if (!this.pendingRetypes.has(mediaType)) this.retypingMedia.delete(mediaType);
    }
    if (txn.slots?.catalogSubscribeRetryTimer != null) {
      clearTimeout(txn.slots.catalogSubscribeRetryTimer);
      txn.slots.catalogSubscribeRetryTimer = null;
    }
    // Mark the transaction terminal so any callback reference captured before
    // detachment is permanently inert (see the owning-txn check in stageable).
    txn.aborted = true;
    txn.wake?.();
    txn.committed = true;
    txn.events.length = 0;
    txn.retainedBytes = 0;
    this.detachConnectionCallbacks(txn.conn);
    this.purgePendingForConnection(txn.conn);
    void txn.conn.close().catch(() => { /* candidate already dead */ });
  }

  /**
   * Replay the transaction's staged events IN ARRIVAL ORDER, now that the
   * candidate is authoritative. Runs synchronously right after
   * {@link commitMigration}, so the drained catalog SUBSCRIBE_OK resolves against
   * the committed `catalogRequestId`. `txn.committed` is already true, so any new
   * events run live rather than re-staging.
   */
  private drainStagedCandidate(txn: MigrationTxn): void {
    for (const { run, source } of txn.events) {
      // If the committed session closed/fatally-errored during a prior replayed
      // event, STOP — the session is dead, and continuing would re-buffer objects
      // for a closed connection that no future close event will ever purge.
      if (txn.terminated) break;
      // Per-event isolation: a staged listener throwing must not stop the drain
      // or escape to the caller and trip the establishment rollback of an
      // already-committed session — but it must NOT be silently swallowed either.
      try {
        run();
      } catch (err) {
        // Route it through the error channel using the SAME classification live
        // delivery would (by event source). Reporting must not escape (a filter/
        // listener may throw), so it is itself isolated — otherwise the exception
        // would strand the transaction (finally-clear + retire never run).
        try {
          const e = err instanceof Error ? err : new Error(String(err));
          const classified = e instanceof MoqtConnectionError
            ? this.classifyMoqtConnectionError(e)
            : {
                severity: (source === 'control' || source === 'transport' ? 'fatal' : 'degraded') as ErrorSeverity,
                code: this.connectionErrorSourceToCode(source),
                context: undefined as Record<string, unknown> | undefined,
              };
          this.emitError(createPlayerError(
            classified.severity, 'connection', classified.code,
            `A migrated session event failed during replay: ${e.message}`,
            defined({ cause: e, context: classified.context }),
          ));
        } catch (reportErr) {
          // Last resort — even the logger is configurable and may throw, which
          // must NOT escape and turn a committed migration into a rejection.
          try {
            this.log.warn('Error reporting a replay failure threw (ignored): %s',
              reportErr instanceof Error ? reportErr.message : String(reportErr));
          } catch { /* logger itself threw — nothing more we can safely do */ }
        }
      }
    }
    txn.events.length = 0;
    txn.retainedBytes = 0;
  }

  /**
   * Commit the handoff atomically — SYNCHRONOUS, no `await`, so no incoming
   * message can interleave and observe a half-migrated state. After this returns
   * `newConnection` is authoritative and its catalog SUBSCRIBE_OK (a later
   * network event) resolves against a consistent state.
   */
  private commitMigration(txn: MigrationTxn, newConnection: MoqtConnection): void {
    txn.adopting = true;
    try { this.adoptMigration(txn, newConnection); }
    finally { txn.adopting = false; }
  }

  private adoptMigration(txn: MigrationTxn, newConnection: MoqtConnection): void {
    // The session being retired, captured BEFORE `this.connection` moves: the
    // retained-route ownership below is about that connection, and reading it
    // afterwards would name the replacement as its own predecessor.
    const retiring = this.connection;
    txn.committed = true; // staging closed — further candidate events run live on the now-current session
    if (this.pendingVideoSwitch) {
      this.discardPendingVideoSwitch(this.pendingVideoSwitch, new Error('Session replaced during the video switch'));
    }
    // Record the endpoint HERE, not after the transaction resolves: the staged
    // drain and the queued-GOAWAY processing that follow can both act on an
    // empty New Session URI from the replacement, and they must resolve it
    // against the endpoint we just adopted.
    if (txn.target !== undefined) this.activeEndpoint = txn.target;
    // The superseded session's catalog delivery is quarantined for BOTH
    // migration flavors: if old and new sessions reuse an alias, late
    // old-session catalog data must never reach the new coordinator.
    if (this.connection) {
      this.catalogQuarantinedConns.add(this.connection);
      if (this.catalogSlots.catalogTrackAlias !== null) {
        this.quarantinedCatalogAliases.set(this.connection, this.catalogSlots.catalogTrackAlias);
      }
    }
    this.connection = newConnection;
    if (this.subscriptionManager) this.subscriptionManager.draftVersion = newConnection.draftVersion;

    // ── Adopt what the candidate PREPARED ───────────────────────────────
    // The replacement's catalog has already converged and its required tracks
    // are already accepted and initialized, so there is nothing to retrieve
    // again: adoption installs that work rather than restarting it. A second
    // catalog retrieval or a second SUBSCRIBE here would discard the evidence
    // the handover was granted on and re-race what it already settled.
    const prep = txn.prep;
    const prepared = txn.slots;
    if (prep !== undefined && prepared !== undefined) {
      // The OLD retrieval's in-flight work stops, WITHOUT bumping the
      // bootstrap generation: that token is captured by the candidate's own
      // coordinator, and invalidating it here would silence the live catalog
      // feed we are adopting.
      this.retireCatalogHolder(this.catalogSlots);
      // Whether the player had a catalog AT ALL before this handover decides
      // whether the adopted one is an update or a first arrival.
      const hadCatalog = this.catalogSlots.catalogReceived;
      this.catalogSlots = prepared;
      // Live playback's view of the catalog becomes the replacement's, with no
      // second `catalog_received` — the session changed, the broadcast did not.
      if (prep.state !== null) this._catalogState = prep.state;
      if (!hadCatalog && prep.state !== null) {
        // ...unless there was no catalog before: then this IS the player's
        // first one, and everything waiting on that — the watchdog, the
        // stats, the application — must hear it exactly as on a first load.
        this._stats.recordCatalogReceived();
        this.watchdog.fulfill('catalog_received');
        this.watchdog.expect('first_media_object', 20_000);
        this.emitter.emit('catalog_received', { type: 'catalog_received', catalog: prep.state });
        if (this._destroyed || this.connection !== newConnection || this.isTerminalState()) {
          txn.terminated = true;
          return;
        }
      }
      // Initialization the candidate actually received enters the live cache
      // only now; a candidate that was never adopted must not populate it.
      if (!this.pipelinesCreated && prep.selection !== null) this.createSelectedPipelines(prep.selection);
      this.initSegmentByTrack.clear();
      this.initTrackRequestIds.clear();
      for (const [name, init] of prep.initTracks) {
        if (init.bytes !== null) this.initSegmentByTrack.set(name, init.bytes);
      }
      // All retained initialization now belongs to the adopted session. This
      // also completes startup when the original source never delivered init.
      // Replace partial old-source bytes rather than mixing the two sessions.
      this.cmafPendingInit = {};
      for (const mediaType of ['video', 'audio'] as const) {
        const track = prep.selection?.[mediaType];
        if (!track || prep.state === null || !isMsePackaging(track.packaging)) continue;
        const bytes = this.preparedInitBytes(prep, track, prep.state);
        if (bytes === undefined || !track.codec) continue;
        this.initSegmentByTrack.set(this.initKey(track), bytes);
        if (this.usesMse(track.packaging)) this.cmafPendingInit[mediaType] = { codec: track.codec, bytes };
      }
      this.maybeApplyCmafInit();
      if (this._destroyed || this.connection !== newConnection || this.isTerminalState()) {
        txn.terminated = true;
        return;
      }
      if (!this.cmafInitialized && (this.cmafPendingInit?.video || this.cmafPendingInit?.audio)) {
        txn.terminated = true;
        this.failCatalogPlayback(createPlayerError('fatal', 'catalog', PlayerErrorCode.CMAF_INIT_INVALID,
          'Replacement initialization was rejected by the media adapter'));
        return;
      }
      // The source buffer was retyped during preparation; the assembler has to
      // agree, or it would keep prepending the old initialization to segments
      // the buffer no longer accepts. The fence comes down here — from now on
      // the media reaching this buffer is the replacement's.
      for (const [mediaType, bytes] of prep.reconfigured) {
        this.cmafAssembler?.setInitSegment?.(mediaType, bytes);
        if (this.mediaSource) this.installedCmafInit.set(mediaType, { source: this.mediaSource, bytes: bytes.slice() });
        if (mediaType === 'video') this.currentVideoCodec = prep.selection?.video?.codec ?? this.currentVideoCodec;
        // Adopted: the retype is no longer outstanding, and the buffer now
        // holds the initialization of the session that is about to play. The
        // fence comes down with it — from here the per-source routing gate is
        // what keeps the retiring session's old-format media out of this
        // buffer, which a type-wide fence could not do without also blocking
        // the replacement's own media during retirement.
        this.pendingRetypes.delete(mediaType);
        this.retypingMedia.delete(mediaType);
      }
      // The old session's registrations are SUPERSEDED, not deleted. Until its
      // close completes it may still be delivering media, and that media is
      // what playback is running on — dropping it at the instant of commit
      // would open exactly the gap this handover exists to avoid. Each object
      // carries its own connection and draft through routing, so old and new
      // deliveries stay distinguishable; what the replacement reuses it
      // overwrites, and the rest is pruned once the old session is retired.
      const preparedIds = new Set(prep.media.keys());
      const preparedAliases = new Set<bigint>();
      for (const sub of prep.media.values()) if (sub.alias !== null) preparedAliases.add(sub.alias);
      const supersededIds = new Set<bigint>();
      const supersededAliases = new Set<bigint>();
      for (const [reqId, sub] of this.activeSubscriptions) {
        // The ALIAS is collected even when the replacement reuses this entry's
        // request id: ids and aliases are independent namespaces, and an old
        // alias left registered because its id happened to be reused would
        // keep delivering through a retired track forever.
        if (sub.trackAlias !== null && !preparedAliases.has(sub.trackAlias)) {
          supersededAliases.add(sub.trackAlias);
        }
        if (preparedIds.has(reqId)) continue;
        supersededIds.add(reqId);
      }
      for (const reqId of this.pendingMediaSubs.keys()) if (!preparedIds.has(reqId)) supersededIds.add(reqId);
      txn.superseded = { ids: supersededIds, aliases: supersededAliases };
      // Source identity for those retained routes. The old connection is still
      // `this.connection` at this point in the commit.
      // Recorded whenever there IS a session being retired, even with no
      // retained aliases: the gate's other half — that the retiring session
      // may not deliver on an alias the replacement took over — is exactly
      // what matters when the replacement reused every one of them.
      if (retiring !== null && retiring !== newConnection) this.supersededConns.add(retiring);
      this.supersededRouting = retiring !== null && retiring !== newConnection
        ? { conn: retiring, aliases: new Set(supersededAliases), reconfigured: new Set(prep.reconfigured.keys()) }
        : null;
      this.pendingAliasBinds.clear();
      this.mseCompletions = null;
      for (const [reqId, sub] of prep.media) {
        // Exactly what SUBSCRIBE_OK installs for a live subscription — the
        // alias the replacement itself assigned, bound to the pipeline owner
        // that is already running. A colliding old request id or alias is
        // overwritten here: the replacement is authoritative for it now.
        this.pendingMediaSubs.delete(reqId);
        this.activeSubscriptions.set(reqId, {
          trackName: sub.trackName, mediaType: sub.mediaType, trackAlias: sub.alias,
          ...(sub.namespace !== undefined ? { namespace: sub.namespace } : {}),
        });
        if (sub.alias !== null) {
          this.subscriptionManager?.registerTrack(sub.alias, sub.trackName, sub.mediaType, sub.packaging,
            { sourceConnection: txn.conn, namespace: sub.namespace });
        }
      }
      this._mediaSubsExpected = prep.media.size;
      this._mediaSubsOk = prep.media.size;
      this._mediaSubsFailed = 0;
      // A catalog subscription still awaiting its alias keeps its ownership of
      // anything parked for it.
      if (prepared.catalogTrackAlias === null && prepared.catalogRequestId !== null) {
        this.pendingAliasBinds.add(prepared.catalogRequestId);
      }
      // ABR must ladder on the REPLACEMENT's catalog. Left alone, the live
      // quality controller would keep the retired session's alternatives and
      // could switch playback to a track that no longer exists; its view of
      // what is playing comes from the adopted subscriptions registered above,
      // so the committed track and both ABR ladders stay consistent.
      if (prep.controller !== undefined) {
        this.qualityController = prep.controller;
        this.syncBufferAbrController();
      }
      // Anything the preparation path parked for a now-bound alias belongs to
      // this session and is delivered through the ordinary replay, before the
      // staged media drain adds to it.
      for (const sub of prep.media.values()) {
        if (sub.alias !== null) this.replayPendingObjects(sub.alias, newConnection);
      }
      if (prepared.catalogTrackAlias !== null) {
        this.replayPendingObjects(prepared.catalogTrackAlias, newConnection);
      }
    }

    // Fetch bookkeeping is per-session and keyed by bare ids the replacement
    // reuses; the candidate's own fetch state travels in its holder.
    this.activeFetches.clear();
    this.fetchStreamAliases.clear();
    this.fetchStreamRequestIds.clear();
    this.pendingFetchStreams.clear();
    this.refusedFetchRequests.clear();
    this.quarantinedFetchRequests.clear();
    this.droppedFetchStreams.clear();
    this.rejectPendingCatalogFetches('Session migrated — fetchCatalog cancelled');
  }

  /**
   * Stop one catalog retrieval's outstanding work without touching another's.
   *
   * Deliberately NOT {@link cancelCatalogBootstrap}: that bumps the shared
   * bootstrap generation, which an adopted candidate's coordinator captured
   * and which unrelated media work also observes.
   */
  private retireCatalogHolder(slots: CatalogSlots): void {
    if (slots.catalogSubscribeRetryTimer !== null) {
      clearTimeout(slots.catalogSubscribeRetryTimer);
      slots.catalogSubscribeRetryTimer = null;
    }
    slots.catalogBootstrapCoord?.abort();
    slots.catalogBootstrapCoord = null;
    slots.catalogRecovery?.coord.abort();
    slots.catalogRecovery = null;
  }

  /**
   * Drop the registrations the adopted session superseded, now that the old
   * session is actually closed.
   *
   * Deferred to here rather than done at commit so the old session's in-flight
   * media keeps reaching playback for as long as it is still arriving. Only
   * the entries recorded at adoption are removed, so a subscription made
   * AFTER it — a quality switch, an init track — is never caught by this.
   */
  private pruneSupersededSubscriptions(txn: MigrationTxn): void {
    const superseded = txn.superseded;
    if (superseded === undefined) return;
    txn.superseded = undefined;
    // The overlap is over, so the retained routes go with it.
    if (this.supersededRouting) this.notifyConnectionObservation('retired', this.supersededRouting.conn);
    this.supersededRouting = null;
    for (const reqId of superseded.ids) {
      this.activeSubscriptions.delete(reqId);
      this.pendingMediaSubs.delete(reqId);
    }
    for (const alias of superseded.aliases) this.subscriptionManager?.unregisterTrack(alias);
    // Current-session completion may have been waiting only for these overlap registrations to retire.
    try { this.reconsiderMseTrackEnds(); }
    catch (error) { try { this.log.warn('Track completion observer failed after retirement: %s', String(error)); } catch { /* observer failure */ } }
  }

  /**
   * Announce a terminal event on the replaced session that was held during a
   * now-failed attempt.
   *
   * Held events are only ever deferred, never dropped: while a replacement
   * looked likely the closure was about to become irrelevant, but once the
   * attempt fails it is the session's real outcome and the application has to
   * hear it.
   */
  private reportHeldOldTerminal(txn: MigrationTxn): void {
    const held = txn.oldTerminal;
    if (held === undefined) return;
    txn.oldTerminal = undefined;
    if (held.kind === 'close') {
      this.emitter.emit('session_closed', defined({
        type: 'session_closed' as const, error: held.error, reason: held.reason,
      }));
      return;
    }
    this.emitError(createPlayerError(
      held.severity, 'connection', held.code, held.error.message,
      defined({ cause: held.error, context: held.context }),
    ));
  }

  /**
   * Close the superseded session (§3.5) and reclaim its buffered objects. A LOCAL
   * close does not emit onClose, so the onClose reclamation never runs for a
   * migration — purge here so the old entries (and the strong adapter reference)
   * are released instead of consuming the alias cap until player destruction.
   */
  private async retireMigratedSession(oldConnection: MoqtConnection | null): Promise<void> {
    if (!oldConnection) return;
    this.releaseMediaTerminals(oldConnection);
    this.retireInitWaiters(oldConnection);
    try {
      // BOUNDED. The replacement is already authoritative and playing, so the
      // old session's close is cleanup — and a relay that never answers it
      // must not hold `session_migrated`, the single-flight slot, or the end of
      // the overlap hostage. Past the bound the close is left running
      // detached (its own rejection stays handled) and retirement proceeds;
      // the reclamation in `finally` does not depend on it finishing.
      const closing = oldConnection.close();
      let bound: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<'bound'>((resolve) => {
        bound = setTimeout(() => resolve('bound'), this.config.connectionTimeoutMs ?? 10_000);
      });
      void closing.catch(() => { /* reported below or already detached */ });
      const outcome = await Promise.race([closing.then(() => 'closed' as const), bounded]);
      if (bound !== undefined) clearTimeout(bound);
      if (outcome === 'bound') {
        this.log.warn('Old session close did not complete within %dms — continuing, cleanup detached',
          this.config.connectionTimeoutMs ?? 10_000);
      }
    } catch (err) {
      // The handoff already committed — the replacement is authoritative and
      // usable, so a failure closing the OLD session is non-fatal. Log and finish
      // the migration rather than reporting it as failed. The logger is
      // configurable and may itself throw — that must not escape either.
      try {
        this.log.warn('Old session close failed after migration (non-fatal): %s',
          err instanceof Error ? err.message : String(err));
      } catch { /* logger threw — swallow, retirement is best-effort */ }
    } finally {
      this.retireWarmMediaOwners(oldConnection);
      this.purgePendingForConnection(oldConnection);
    }
  }

  private retireInitWaiters(connection: MoqtConnection): void {
    for (const [key, pending] of this.pendingInitTrackSubs) {
      if (pending.connection !== connection) continue;
      this.pendingInitTrackSubs.delete(key);
      pending.reject(new Error('Init source session retired'));
    }
  }

  /**
   * Migrate to a URL (used by GOAWAY auto-migration).
   *
   * Creates transport via `createTransport(url)` and connects the new adapter.
   *
   * @see draft-ietf-moq-transport-16 §3.5 (Migration)
   * @see draft-ietf-moq-transport-16 §8.4.1 (Graceful Subscriber Relay Switchover)
   */
  /**
   * Start an automatic (GOAWAY-driven) migration to `uri`. Creates the
   * replacement adapter only here — never before the migration is actually
   * attempted — so a queued/aborted GOAWAY leaks nothing. Failures are surfaced
   * through the error channel rather than left as an unhandled rejection.
   */
  private startGoawayMigration(uri: string): void {
    if (this._destroyed || this.isTerminalState() || !this.config.createConnection) return;
    // The URI is peer-controlled text — validate BEFORE creating any candidate
    // connection or transport. A non-empty invalid URI must not silently fall
    // back to the current URL (that would reconnect to a relay that just
    // declared itself unusable while hiding the peer's defect); the GOAWAY
    // quarantine installed at receipt stays in place.
    const invalidReason = invalidGoawayUriReason(uri);
    if (invalidReason !== null) {
      this.emitError(createPlayerError(
        'degraded', 'connection', PlayerErrorCode.CONNECTION_LOST,
        `Automatic GOAWAY migration rejected: ${invalidReason}`,
      ));
      return;
    }
    const newConnection = this.config.createConnection();
    this.migrateToUrl(newConnection, uri).catch((err) => {
      this.emitError(createPlayerError(
        'degraded', 'connection', PlayerErrorCode.CONNECTION_LOST,
        `Automatic GOAWAY migration failed: ${err instanceof Error ? err.message : String(err)}`,
        defined({ cause: err instanceof Error ? err : undefined }),
      ));
    });
  }

  /**
   * Act on a GOAWAY that arrived while a handoff held the single-flight slot —
   * but ONLY if its source session is still current. After establishment failure
   * the old session remains current (its GOAWAY is valid); after a successful
   * commit only the replacement's own GOAWAY is valid, while a GOAWAY the OLD
   * session sent during establishment is now moot (we already migrated away from
   * it) and must be discarded rather than migrating off the caller's replacement.
   */
  private processPendingGoaway(): void {
    const pending = this.pendingGoaway;
    this.pendingGoaway = null;
    if (pending !== null && !this._destroyed && !this.currentMigration && pending.sourceConnection === this.connection) {
      this.startGoawayMigration(pending.uri);
    }
  }

  private async migrateToUrl(newConnection: MoqtConnection, url: string): Promise<void> {
    const createTransport = this.config.createTransport!;
    const setupOptions = buildSetupOptions(this.config, url);
    await this.runMigrationTransaction(
      newConnection, () => createTransport(buildConnectUrl(this.config, url)), setupOptions, url,
    );

    this._stats.recordReconnect();
    this.log.info('Session migrated to %s', url);
    this.emitter.emit('session_migrated', { type: 'session_migrated' });
  }

  /**
   * Request a range of previously published objects via FETCH.
   *
   * Wraps adapter.fetch() and sets up routing so fetch data stream
   * objects are delivered through the subscription manager.
   *
   * @param trackName Track name to fetch from (must match a catalog track).
   * @param options Start/end group and object range.
   * @returns The fetch request ID (for use with fetchCancel).
   *
   * @see draft-ietf-moq-transport-16 §9.16 (FETCH)
   * @see draft-ietf-moq-transport-16 §10.4.4 (FETCH_HEADER data stream)
   */
  async fetch(
    trackName: string,
    options: { startGroup: number; startObject: number; endGroup: number; endObject: number },
  ): Promise<bigint> {
    if (!this.connection) throw new Error('Player not loaded');
    const connAtCall = this.connection;

    const target = this.uniqueCatalogTrack(trackName);
    const nsFields = trackNamespaceFields(target, this.config.namespace);
    const nsBytes = nsFields.map(field => this.enc.encode(field));
    const nameBytes = this.enc.encode(trackName);

    const fetchOptions = {
      startGroup: varint(BigInt(options.startGroup)),
      startObject: varint(BigInt(options.startObject)),
      endGroup: varint(BigInt(options.endGroup)),
      endObject: varint(BigInt(options.endObject)),
    };

    // Capture the owning subscription before sending. Its confirmed alias
    // may arrive later, but a replacement subscription must not inherit this FETCH.
    let mediaType: 'video' | 'audio' = 'video';
    let subscriptionRequestId: bigint | null = null;
    for (const [requestId, sub] of this.activeSubscriptions) {
      if (sub.trackName === trackName && sameNamespaceFields(
          sub.namespace ?? namespaceFields(this.config.namespace), nsFields) &&
          sub.mediaType !== 'mediatimeline' &&
          sub.mediaType !== 'eventtimeline') {
        mediaType = sub.mediaType;
        subscriptionRequestId = requestId;
        break;
      }
    }
    let fetchRegisteredId: bigint | null = null;
    const registerPublicFetch = (id: bigint): void => {
      if (fetchRegisteredId !== null) return;
      fetchRegisteredId = id;
      if (!this.subscriptionManager || this.connection !== connAtCall) return;
      this.registerMediaFetch(id, { trackName, mediaType, subscriptionRequestId, trackAlias: null }, connAtCall);
    };
    let reqId: Awaited<ReturnType<MoqtConnection['fetch']>>;
    try {
      reqId = await connAtCall.fetch(nsBytes, nameBytes,
        { ...fetchOptions, onRequestId: (id: bigint) => registerPublicFetch(BigInt(id)) } as never);
    } catch (err) {
      if (fetchRegisteredId !== null && this.connection === connAtCall) {
        this.quarantineFetchRequest(fetchRegisteredId);
      }
      throw err;
    }
    const reqIdBigInt = BigInt(reqId);

    // Completion crossed destroy()/migration: the request ID belongs to a
    // dead session — a caller could neither receive objects nor cancel it
    // (fetchCancel would target the NEW connection). Best-effort cancel on
    // the captured old connection and reject loudly.
    if (!this.subscriptionManager || this.connection !== connAtCall) {
      try { await connAtCall.fetchCancel(reqId); } catch { /* old session gone */ }
      throw new Error('fetch() aborted: player destroyed or session migrated while the FETCH was in flight');
    }
    registerPublicFetch(reqIdBigInt);

    return reqId;
  }

  /**
   * Register an active media FETCH and resolve any data streams that arrived
   * before registration (§9.16.3: fetch data may precede FETCH_OK — and the
   * fetch()/joiningFetch() promise continuation). Buffered objects replay
   * through the same alias remap as normally-ordered fetch objects.
   */
  private registerMediaFetch(
    fetchReqId: bigint,
    registration: Omit<MediaFetchInfo, 'requestId' | 'connection' | 'retired' | 'streams'>,
    connection: MoqtConnection,
  ): void {
    if (connection !== this.connection) return;
    const info: MediaFetchInfo = { ...registration, requestId: fetchReqId, connection, retired: false, streams: new Map() };
    if (info.warmOwner) info.warmOwner.prefixFetch = info;
    // A REQUEST_ERROR that raced the fetch()/joiningFetch() continuation
    // already refused this request — honor it instead of resurrecting a
    // dead fetch (its buffered streams are dropped with it).
    const refused = this.refusedFetchRequests.get(fetchReqId);
    if (refused) {
      info.retired = true;
      this.finishWarmMediaPrefix(info, 'error');
      this.refusedFetchRequests.delete(fetchReqId);
      this.quarantineFetchRequest(fetchReqId);
      this.log.warn('[%s] media FETCH %s for "%s" was refused before registration: %s (code=0x%s) — continuing live-only',
        info.warmStart ? 'warm-start' : 'fetch',
        fetchReqId, info.trackName, refused.reason, refused.code.toString(16));
      return;
    }

    if (this.quarantinedFetchRequests.has(fetchReqId)) {
      info.retired = true; this.finishWarmMediaPrefix(info, 'error'); return;
    }

    // Resolve only against the subscription that owned this FETCH when sent.
    // A replacement request for the same track must not inherit its data.
    const subscription = info.subscriptionRequestId === null
      ? undefined : this.activeSubscriptions.get(info.subscriptionRequestId);
    if (!subscription || info.warmOwner && subscription !== info.warmOwner.subscription) {
      info.retired = true; this.finishWarmMediaPrefix(info, 'error');
      this.quarantineFetchRequest(fetchReqId);
      return;
    }
    info.trackAlias = subscription.trackAlias;

    this.activeFetches.set(fetchReqId, info);
    for (const [streamId, pending] of this.pendingFetchStreams) {
      if (pending.requestId === fetchReqId && pending.sourceConnection === connection) {
        this.bindWarmMediaFetch(info, streamId, pending.terminal !== undefined);
      }
    }
    if (info.trackAlias === null) return;
    this.drainMediaFetch(fetchReqId);
  }

  private drainMediaFetch(fetchReqId: bigint): void {
    const info = this.activeFetches.get(fetchReqId);
    if (!info || info.trackAlias === null) return;
    const conn = this.connection;
    for (const [streamId, pending] of this.pendingFetchStreams) {
      if (pending.requestId !== fetchReqId) continue;
      this.pendingFetchStreams.delete(streamId);
      if (pending.terminal === undefined) {
        this.fetchStreamAliases.set(streamId, info.trackAlias);
        this.fetchStreamRequestIds.set(streamId, fetchReqId);
      }
      for (const obj of pending.objects) {
        if (this.connection !== conn || this.activeFetches.get(fetchReqId) !== info) break;
        this.routeFetchObject(streamId, info.trackAlias, obj, pending.sourceDraft, pending.sourceConnection, info);
      }
      if (this.connection !== conn) return;
      if (pending.terminal !== undefined && this.activeFetches.get(fetchReqId) === info) {
        this.finishWarmMediaPrefix(info, pending.terminal === 'fin' ? 'fin' : pending.terminal === 'reset' ? 'reset' : 'error');
        // The stream already ended — however it ended, no live routing maps
        // are needed and the fetch bookkeeping ends with it. Only the
        // BOOTSTRAP path below needs the terminal to be a peer FIN.
        this.activeFetches.delete(fetchReqId);
      }
    }
  }

  /**
   * Route one FETCH data-stream object: remap the wire trackAlias (0 on a
   * fetch stream, §10.4.4) to the live track's alias and hand it to the
   * same SubscriptionManager path live objects use.
   */
  private routeFetchObject(streamId: bigint, alias: bigint, obj: MoqtObject, sourceDraft?: DraftVersion, sourceConnection?: MoqtConnection,
    info?: Pick<MediaFetchInfo, 'subscriptionRequestId' | 'warmStart' | 'warmOwner'>): void {
    if (this.subscriptionManager?.getMediaType(alias) === undefined) return;
    const remapped: MoqtObject = { ...obj, trackAlias: varint(alias) };
    void this.routeMediaObject(streamId, remapped, sourceDraft, sourceConnection, obj, info ?? { subscriptionRequestId: null });
  }

  /**
   * Cancel an active fetch.
   *
   * @param requestId The fetch request ID returned by fetch().
   *
   * @see draft-ietf-moq-transport-16 §9.18 (FETCH_CANCEL)
   */
  async fetchCancel(requestId: bigint): Promise<void> {
    if (!this.connection) throw new Error('Player not loaded');
    this.quarantineFetchRequest(BigInt(requestId));
    await this.connection.fetchCancel(varint(requestId));
  }

  /**
   * Pull a single, **independent** catalog object via MoQ FETCH and
   * return its parsed `CatalogState`. One-shot, side-effect-free with
   * respect to the running catalog — does not subscribe to media tracks,
   * does not mutate `_catalogState`, does not advance the player's
   * `CatalogManager`. Caller decides what to do with the result.
   *
   * Each call parses through a fresh per-call `CatalogManager` with no
   * prior state, so the fetched object MUST be a self-contained catalog
   * (MSF / CF01 independent) — delta updates, which require a base
   * catalog to apply against, will reject. In practice that means the
   * caller is responsible for choosing a `(group, object)` known to be
   * an independent catalog; do not blindly fetch the latest object.
   *
   * Useful for VOD with a pinned catalog at `(0, 0)`, custom catalog
   * inspection / debugging UIs, and relays where SUBSCRIBE on the
   * catalog track is unreliable but FETCH works.
   *
   * @param opts.group Group ID to fetch. Default `0n`.
   * @param opts.object Object ID to fetch. Default `0n`.
   * @param opts.timeoutMs Reject after this many ms with no response.
   *                       Cancels the fetch. Default `5000`.
   * @returns The parsed `CatalogState` from the fetched object.
   * @throws If the player is not loaded.
   * @throws If the fetch times out, returns a gap, or the server
   *         responds with `REQUEST_ERROR`.
   * @throws If the fetched object is a delta update (no base catalog
   *         exists in the per-call parser).
   *
   * @see draft-ietf-moq-transport-16 §9.16 (FETCH)
   * @see draft-ietf-moq-transport-16 §9.18 (FETCH_CANCEL)
   * @see draft-ietf-moq-msf-00 §9.1 (catalog track)
   */
  async fetchCatalog(opts?: {
    group?: bigint;
    object?: bigint;
    timeoutMs?: number;
  }): Promise<CatalogState> {
    if (!this.connection) throw new Error('Player not loaded');
    const group = opts?.group ?? 0n;
    const object = opts?.object ?? 0n;
    const timeoutMs = opts?.timeoutMs ?? 5_000;

    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName(this.config.catalogTrackName));
    const fetchOptions = {
      startGroup: varint(group),
      startObject: varint(object),
      endGroup: varint(group),
      endObject: varint(object),
    };

    // Pre-send ownership: register the pending fetch inside `onRequestId`
    // (invoked by the adapter between request-ID allocation and wire
    // emission), so a zero-latency REQUEST_ERROR or data stream can never
    // beat the registration. Adapters that don't invoke the callback fall
    // back to post-await registration — the historical behavior.
    return new Promise<CatalogState>((resolve, reject) => {
      let registeredId: bigint | null = null;
      const register = (id: bigint): void => {
        if (registeredId !== null) return; // pre-send callback already ran
        registeredId = id;
        const timeout = setTimeout(() => {
          const pending = this.pendingCatalogFetches.get(id);
          if (!pending) return; // already resolved between expiration and fire
          this.cleanupCatalogFetch(id);
          // Best-effort cancel — server may have already finished.
          this.connection?.fetchCancel(varint(id)).catch(() => { /* ignore */ });
          pending.reject(new Error(`fetchCatalog timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.pendingCatalogFetches.set(id, { resolve, reject, timeout });
      };
      void (async () => {
        try {
          const reqId = await this.connection!.fetch(nsBytes, nameBytes, {
            ...fetchOptions,
            onRequestId: register,
          } as never);
          register(BigInt(reqId)); // fallback: adapter didn't invoke the callback
        } catch (err) {
          // Send failure: undo any pre-send registration so the timer can't
          // fire against a request that never went out.
          if (registeredId !== null) this.cleanupCatalogFetch(registeredId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  }

  /**
   * Process a single CMAF / catalog object delivered on a FETCH stream
   * for `fetchCatalog`. Parses through a *fresh* `CatalogManager`
   * scoped to this call so the player's long-lived catalog state stays
   * untouched. Resolves the pending promise on success, rejects on
   * gap / empty payload / parse error.
   */
  private handleCatalogFetchObject(reqId: bigint, obj: MoqtObject): void {
    const pending = this.pendingCatalogFetches.get(reqId);
    if (!pending) return;
    if (obj.kind === 'gap') {
      this.settleCatalogFetch(reqId, {
        ok: false,
        error: new Error('fetchCatalog: server returned gap (object not found in requested range)'),
      });
      return;
    }
    if (!obj.payload || obj.payload.byteLength === 0) {
      this.settleCatalogFetch(reqId, {
        ok: false,
        error: new Error('fetchCatalog: empty payload'),
      });
      return;
    }
    try {
      // Fresh per-call manager — doesn't read or mutate this.catalogSlots.catalogManager.
      const oneShot = new CatalogManager(this.config.namespace);
      const state = oneShot.processCatalogObject(obj.payload);
      this.settleCatalogFetch(reqId, { ok: true, state });
    } catch (err) {
      this.settleCatalogFetch(reqId, {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Reject every in-flight {@link fetchCatalog} with the given reason and
   * clear all bookkeeping. Called on session boundaries (close, migrate,
   * destroy) — pending fetches are scoped to the adapter that issued the
   * FETCH request, so once that session is gone the request IDs and
   * stream IDs are no longer valid against the new adapter.
   */
  private rejectPendingCatalogFetches(reason: string): void {
    for (const [, pending] of this.pendingCatalogFetches) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingCatalogFetches.clear();
    this.catalogFetchStreams.clear();
  }

  /** Drop a pending catalog-fetch entry and any stream mappings to it. */
  // ─── Catalog bootstrap (MSF-01 §5 SUBSCRIBE + Joining FETCH) ─────────

  /**
   * Resolve the catalog retrieval mode from config `catalogBootstrap`
   * (default 'auto') alone — no draft dependence and no per-connection memo.
   * Profile is unknowable before the first catalog parse, so this depends
   * only on configuration.
   */
  private usesCatalogFill(conn: MoqtConnection): boolean {
    // draft 22 has no Joining FETCH: the SUBSCRIBE carries FILL_PARAMETERS
    // and the fill fetch stream (FETCH_HEADER with the SUBSCRIBE's Request ID)
    // is the MSF-01 §5 prefix. There is no FETCH_OK; a FIN completes it.
    return isDraft22(conn.draftVersion);
  }

  private resolvedCatalogMode(_conn: MoqtConnection): 'joining-fetch' | 'subscribe' {
    const mode = this.config.catalogBootstrap ?? 'auto';
    if (mode === 'subscribe') return 'subscribe';
    if (mode === 'joining-fetch' || mode === 'strict') return 'joining-fetch';
    // 'auto': the MSF-01 §5 MUST applies on EVERY draft — draft 14 issues
    // the joining fetch too (after SUBSCRIBE_OK, per its §9.16.2
    // active-subscription rule; the coordinator sequences that). Relay
    // incompatibility is handled per-load by the fallback ladder — there is
    // deliberately NO refusal memo: memoizing 'subscribe' would silently
    // start later retrievals on a path MSF-01 forbids, without the
    // coordinator's fallback classification guarding it.
    return 'joining-fetch';
  }

  /** Draft-aware FETCH INVALID_RANGE code: d14 uses 0x5 (§9.18); 16/18 use
   *  the common table's 0x11. */
  private invalidRangeCode(draftVersion?: DraftVersion): bigint {
    const draft = draftVersion ?? this.connection?.draftVersion ?? this.config.draftVersion ?? 16;
    return draft === 14 ? 0x5n : 0x11n;
  }

  /** STRICT standards mode: fallbacks off the joining path are fatal. */
  private strictCatalogMode(): boolean {
    return (this.config.catalogBootstrap ?? 'auto') === 'strict';
  }

  /**
   * Subscribe options for the catalog track under the resolved mode. The
   * bootstrap options are chosen ATOMICALLY with the joining fetch (one code
   * path decides both) — §9.16.2 makes a joining fetch against any filter but
   * LargestObject a session-fatal PROTOCOL_VIOLATION, so the pairing can never
   * be assembled from two places. Ownership (`onRequestId`) is pre-send: a
   * zero-latency SUBSCRIBE_OK can never beat registration. `terminalDelivery`
   * + `onDrained` opt the subscription into the adapter's terminal drain so a
   * one-shot catalog's late delta survives PUBLISH_DONE.
   */
  private catalogSubscribeOptions(
    conn: MoqtConnection, slots: CatalogSlots = this.catalogSlots,
  ): Record<string, unknown> {
    if (this.resolvedCatalogMode(conn) === 'subscribe') {
      // Legacy escape hatch — today's exact WIRE options, byte-identical
      // (onRequestId is an adapter-local concern, stripped before Session):
      // ownership still registers pre-send so a zero-latency SUBSCRIBE_OK
      // finds catalogRequestId already set.
      const legacyGen = this.bootstrapGeneration;
      return {
        subscriptionFilter: {
          type: 'AbsoluteStart' as const,
          startGroup: varint(0n),
          startObject: varint(0n),
        },
        onRequestId: (id: bigint) => {
          if (legacyGen !== this.bootstrapGeneration) return;
          slots.catalogRequestId = id;
          this.pendingAliasBinds.add(id);
        },
        // Terminal-drain semantics apply on EVERY draft, including 14 and the
        // legacy retrieval mode: the adapter retains routing for the drain
        // window (late objects still deliver), then the player retires the
        // catalog route. Adapter-local options — wire bytes are unchanged.
        terminalDelivery: 'drain' as const,
        onDrained: (id: bigint) => {
          if (legacyGen !== this.bootstrapGeneration) return;
          if (id !== slots.catalogRequestId) return;
          this.deliverCatalogDrained(slots);
        },
      };
    }
    const gen = this.bootstrapGeneration;
    return {
      subscriptionFilter: { type: 'LargestObject' as const },
      ...(this.usesCatalogFill(conn) ? { fill: CATALOG_FILL } : {}),
      onRequestId: (id: bigint) => {
        if (gen !== this.bootstrapGeneration) return;
        slots.catalogRequestId = id;
        this.pendingAliasBinds.add(id);
      },
      terminalDelivery: 'drain' as const,
      onDrained: (id: bigint) => {
        if (gen !== this.bootstrapGeneration) return;
        if (id !== slots.catalogRequestId) return;
        const coord = slots.catalogBootstrapCoord;
        coord?.onSubscriptionDrained();
        // A drained 'ended' feed is OVER: retire the route so late objects
        // stop applying (retriable retirement happens in staged recovery).
        if (coord?.feedEnded) this.retireCatalogAliasRoute(slots);
      },
    };
  }

  /**
   * Create + install the bootstrap coordinator for `conn` (one per
   * generation) WITHOUT starting it. Installation must precede the catalog
   * subscribe: a zero-latency SUBSCRIBE_OK (Largest Location) or a first
   * catalog object must land in the coordinator, never the legacy path. The
   * caller invokes `.start()` once the subscribe has been issued (the
   * coordinator buffers everything that arrives in between).
   */
  private createCatalogBootstrap(conn: MoqtConnection, slots: CatalogSlots = this.catalogSlots): CatalogBootstrap {
    const gen = this.bootstrapGeneration;
    // Liveness is OPERATION-LOCAL, not just session-local. `abort()` stops the
    // coordinator's future work but cannot revoke an async call already in
    // flight, and retiring one request deliberately no longer bumps the shared
    // bootstrap generation (that token is also observed by unrelated media), so
    // neither the generation nor the connection can tell a retired coordinator's
    // late continuation from a live one. The installed-coordinator identity can:
    // retirement clears the slot, so every continuation below becomes inert.
    // Captured holder + coordinator identity: reading the player's current
    // slots late would let a retired candidate's continuation act on whichever
    // retrieval happens to be installed by then.
    const live = (): boolean => gen === this.bootstrapGeneration
      && this.slotsFor(conn) === slots && slots.catalogBootstrapCoord === coord;
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName(this.config.catalogTrackName));
    let pendingAttempt: number | null = null;

    const coord: CatalogBootstrap = new CatalogBootstrap({
      applyAt: (loc, payload, opts) => slots.catalogManager!.processCatalogObjectAt(loc, payload, opts),
      resetManager: () => slots.catalogManager?.reset(),
      currentState: () => slots.catalogManager?.currentState ?? null,
      issueJoiningFetch: (attempt) => {
        pendingAttempt = attempt;
        if (this.usesCatalogFill(conn)) {
          void Promise.resolve().then(() => {
            if (!live()) return;
            const subReqId = slots.catalogRequestId;
            if (subReqId === null) { coord.onFetchError(attempt, 'refused'); return; }
            slots.catalogFillRequests.add(subReqId);
            coord.onFetchOk(attempt, { group: 0n, object: 0n }, false);
            this.registerBootstrapFetch(slots, conn, subReqId, attempt, gen);
          });
          return;
        }
        void (async () => {
          let myFetchReqId: bigint | null = null;
          try {
            if (!live() || slots.catalogRequestId === null) throw new Error('no catalog subscription');
            await conn.joiningFetch({
              joiningFetchType: 'relative',
              joiningRequestId: slots.catalogRequestId,
              joiningStart: 0n,
              groupOrder: varint(0x1n), // ascending — explicit on every bootstrap fetch
              onRequestId: (id: bigint) => {
                if (!live() || pendingAttempt !== attempt) throw new Error('catalog fetch attempt retired');
                myFetchReqId = id;
                this.registerBootstrapFetch(slots, conn, id, attempt, gen);
              },
            } as never);
          } catch (err) {
            if (!live()) return;
            this.log.debug('[catalog-bootstrap] joining fetch failed locally: %s',
              err instanceof Error ? err.message : String(err));
            // RETIRE only THIS call's allocation — a rejection settling late
            // must never cancel a newer ladder attempt's request/streams.
            if (myFetchReqId !== null) {
              this.retireBootstrapFetch(slots, conn, myFetchReqId, { attempt });
              if (slots.bootstrapFetch?.reqId === myFetchReqId && slots.bootstrapFetch.conn === conn) {
                slots.bootstrapFetch = null;
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      issueStandaloneFetch: (range, attempt) => {
        pendingAttempt = attempt;
        void (async () => {
          let myFetchReqId: bigint | null = null;
          try {
            if (!live()) return;
            await conn.fetch(nsBytes, nameBytes, {
              // RAW bigints: draft-18 locations are vi64 (legal above the QUIC
              // varint ceiling); each draft's codec enforces its own width.
              startGroup: range.startGroup,
              startObject: range.startObject,
              // Whole-group End.Object = 0 encoding — deterministic, no
              // successor arithmetic, valid at Largest.Object = 2^64-1.
              endGroup: range.endGroupWholeOf,
              endObject: 0n,
              groupOrder: varint(0x1n),
              onRequestId: (id: bigint) => {
                if (!live() || pendingAttempt !== attempt) throw new Error('catalog fetch attempt retired');
                myFetchReqId = id;
                this.registerBootstrapFetch(slots, conn, id, attempt, gen);
              },
            } as never);
          } catch (err) {
            if (!live()) return;
            this.log.debug('[catalog-bootstrap] standalone fetch failed locally: %s',
              err instanceof Error ? err.message : String(err));
            // RETIRE only THIS call's allocation — never a newer attempt's.
            if (myFetchReqId !== null) {
              this.retireBootstrapFetch(slots, conn, myFetchReqId, { attempt });
              if (slots.bootstrapFetch?.reqId === myFetchReqId && slots.bootstrapFetch.conn === conn) {
                slots.bootstrapFetch = null;
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      cancelFetch: () => {
        pendingAttempt = null;
        const fetch = slots.bootstrapFetch;
        slots.bootstrapFetch = null;
        if (fetch) this.retireBootstrapFetch(slots, fetch.conn, fetch.reqId, { attempt: fetch.attempt });
      },
      onReady: (state) => {
        if (!live()) return;
        // A PREPARING candidate's coordinator reaching readiness is the
        // convergence the handover is waiting for — it is not a catalog for
        // playback, so it resolves the attempt instead of publishing state
        // and subscribing live media.
        const candidate = this.candidateTxnFor(slots);
        if (candidate !== null) {
          slots.catalogReceived = true;
          candidate.prep!.state = state;
          this.log.info('[handover] replacement catalog bootstrap converged: %d tracks', state.tracks.length);
          candidate.prep!.resolveCatalog(state);
          return;
        }
        this.onCatalogBootstrapReady(state);
      },
      onUpdated: (state) => {
        if (!live()) return;
        const candidate = this.candidateTxnFor(slots);
        if (candidate !== null) {
          // Kept, not announced: the delta belongs to a session nobody is
          // playing yet. Adoption publishes the converged state once.
          candidate.prep!.state = state;
          return;
        }
        this._catalogState = state;
        this.emitter.emit('catalog_updated', { type: 'catalog_updated', catalog: state });
      },
      requestLegacyResubscribe: () => {
        void (async () => {
          if (!live()) return;
          const oldReqId = slots.catalogRequestId;
          slots.catalogRequestId = null;
          slots.catalogTrackAlias = null;
          if (oldReqId !== null) {
            // Cancellation settles like a response: the dead request stops
            // owning parked data and stops enabling parking.
            this.settleParkedOwnership(oldReqId, null, conn);
            await conn.unsubscribe(varint(oldReqId)).catch(() => { /* best effort */ });
          }
          if (!live()) return;
          // Distinguishes a genuinely callback-less adapter from one whose
          // callback DID fire and whose request was retired afterwards. A null
          // current catalog ID cannot tell those apart, and treating the second
          // as the first resurrects the dead request.
          let callbackFired = false;
          try {
            // Pre-send ownership + terminal drain, exactly as the primary
            // catalog subscribe: a fast response must not beat registration,
            // and late objects after a PUBLISH_DONE must still drain.
            const reqId = await conn.subscribe(nsBytes, nameBytes, {
              subscriptionFilter: {
                type: 'AbsoluteStart', startGroup: varint(0n), startObject: varint(0n),
              },
              onRequestId: (id: bigint) => {
                // REFUSE emission rather than returning quietly: a silent
                // return lets an unowned request reach the peer on behalf of a
                // retired operation. Throwing here rolls the request back
                // before any bytes go out (the hook's documented contract).
                if (!live()) throw new Error('catalog bootstrap fallback retired before emission');
                callbackFired = true;
                slots.catalogRequestId = id;
                this.pendingAliasBinds.add(id);
              },
              terminalDelivery: 'drain',
              onDrained: (id: bigint) => {
                if (!live()) return;
                if (id !== slots.catalogRequestId) return;
                const drainCoord = slots.catalogBootstrapCoord;
                drainCoord?.onSubscriptionDrained();
                if (drainCoord?.feedEnded) this.retireCatalogAliasRoute();
              },
            } as never);
            if (!live()) return;
            if (!callbackFired) {
              slots.catalogRequestId = BigInt(reqId); // callback-less adapter fallback
              this.pendingAliasBinds.add(BigInt(reqId));
            }
          } catch (err) {
            // Ownership is checked BEFORE any mutation: a retired operation must
            // not settle parked ownership or raise a fatal error for a request
            // that is no longer ours.
            if (!live()) return;
            if (slots.catalogRequestId !== null) this.settleParkedOwnership(slots.catalogRequestId, null, conn);
            this.failCatalogPlayback(createPlayerError(
              'fatal', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
              `catalog bootstrap fallback resubscribe failed: ${err instanceof Error ? err.message : String(err)}`,
            ));
          }
        })();
      },
      onFatal: (reason) => {
        if (!live()) return;
        // Terminal for the CANDIDATE only: its own ladder bottoming out is
        // final for the attempt and invisible to live playback.
        const candidate = this.candidateTxnFor(slots);
        if (candidate !== null) {
          this.failCandidateCatalog(candidate.conn, `replacement catalog bootstrap failed: ${reason}`);
          return;
        }
        this.failCatalogPlayback(createPlayerError(
          'fatal', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
          `catalog bootstrap failed: ${reason}`,
        ));
      },
      onDegraded: (reason) => {
        if (!live()) return;
        const candidate = this.candidateTxnFor(slots);
        if (candidate !== null) {
          // Pre-adoption there is nothing to degrade: decline the candidate
          // rather than adopt a replacement with a known-bad catalog feed.
          this.failCandidateCatalog(candidate.conn, `replacement catalog update rejected: ${reason}`);
          return;
        }
        // Post-readiness catalog faults match the legacy severity model:
        // degraded, never silent.
        this.emitError(createPlayerError(
          'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
          `catalog update rejected: ${reason}`,
        ));
      },
      requestStagedRecovery: () => {
        if (!live()) return;
        // Staged recovery is a mechanism for the LIVE retrieval. A candidate
        // that needs it has failed: we already hold a working session, so the
        // attempt is declined rather than nested inside another recovery.
        const candidate = this.candidateTxnFor(slots);
        if (candidate !== null) {
          this.failCandidateCatalog(candidate.conn, 'replacement catalog needed staged recovery');
          return;
        }
        this.beginCatalogRecovery(conn);
      },
      log: (msg, ...args) => this.log.debug(msg, ...args),
    }, {
      draft: (conn.draftVersion ?? this.config.draftVersion ?? 16) as 14 | 16 | 18 | 22,
      strict: this.strictCatalogMode(),
    });

    slots.catalogBootstrapCoord = coord;
    return coord;
  }

  /** Pre-send bootstrap fetch ownership; claims any parked streams. */
  private registerBootstrapFetch(
    slots: CatalogSlots, conn: MoqtConnection, reqId: bigint, attempt: number, gen: number,
  ): void {
    if (gen !== this.bootstrapGeneration) return;
    slots.bootstrapFetch = { conn, reqId, attempt, gen };
    // Claim any stream parked by the defensive fallback at the onDataStream
    // site — a FETCH header whose request had no owner yet. Registration is
    // pre-send and synchronous, so this should find nothing.
    //
    // `pendingFetchStreams` is keyed by bare stream ID and is authoritative
    // ONLY for the current connection, exactly as the object router treats it.
    // A candidate must not claim an old session's park that happens to share a
    // request ID; its own pre-registration evidence never lands here, because
    // the router buffers non-current connections separately.
    // A candidate claims from its OWN parking; the shared map below belongs to
    // the current session.
    if (conn !== this.connection) {
      for (const [streamId, parked] of [...slots.candidateFetchStreams]) {
        if (parked.requestId !== reqId) continue;
        slots.candidateFetchStreams.delete(streamId);
        slots.bootstrapFetchStreams.set(streamId, { attempt, conn });
        for (const obj of parked.objects) {
          if (!this.emitCatalogRaw(obj)) return;
          slots.catalogBootstrapCoord?.onFetchObject(attempt, this.toCatalogEvent(obj));
        }
        if (parked.terminal !== undefined) {
          slots.bootstrapFetchStreams.delete(streamId);
          slots.catalogBootstrapCoord?.onFetchStreamClosed(attempt, parked.terminal === 'fin');
        }
      }
      return;
    }
    for (const [streamId, parked] of [...this.pendingFetchStreams]) {
      if (parked.requestId === reqId) {
        this.pendingFetchStreams.delete(streamId);
        slots.bootstrapFetchStreams.set(streamId, { attempt, conn });
        for (const obj of parked.objects) {
          if (!this.emitCatalogRaw(obj)) return;
          slots.catalogBootstrapCoord?.onFetchObject(attempt, this.toCatalogEvent(obj));
        }
        if (parked.terminal !== undefined) {
          // The stream ended before registration. Only a peer FIN completes the
          // attempt — a reset, our own discard, and a read failure are all
          // recorded here too, and none of them finished the fetch.
          slots.catalogBootstrapCoord?.onFetchStreamClosed(attempt, parked.terminal === 'fin');
        }
      }
    }
  }

  /** A recovery candidate's draft-22 fill stream can arrive before the
   *  coordinator asks for it (the fill rides on the SUBSCRIBE): claim it. */
  private claimParkedRecoveryFill(
    recovery: NonNullable<CatalogSlots['catalogRecovery']>, reqId: bigint, attempt: number,
  ): void {
    for (const [streamId, parked] of [...this.pendingFetchStreams]) {
      if (parked.requestId !== reqId) continue;
      this.pendingFetchStreams.delete(streamId);
      recovery.fetchStreams.set(streamId, attempt);
      for (const obj of parked.objects) recovery.coord.onFetchObject(attempt, this.toCatalogEvent(obj));
      if (parked.terminal !== undefined) recovery.coord.onFetchStreamClosed(attempt, parked.terminal === 'fin');
    }
  }

  /** Return whether the catalog owner survived the diagnostic callback. */
  private emitCatalogRaw(obj: MoqtObject): boolean {
    if (this._destroyed || this.isTerminalState()) return false;
    if (obj.kind !== 'data') return true;
    const conn = this.connection;
    const gen = this.bootstrapGeneration;
    const coord = this.catalogSlots.catalogBootstrapCoord;
    const recovery = this.catalogSlots.catalogRecovery;
    let text: string | undefined;
    try { text = new TextDecoder().decode(obj.payload); } catch { /* binary */ }
    this.emitter.emit('catalog_raw', { type: 'catalog_raw', payload: obj.payload, text: text ?? '' });
    return !this._destroyed && !this.isTerminalState() && this.connection === conn
      && this.bootstrapGeneration === gen && this.catalogSlots.catalogBootstrapCoord === coord && this.catalogSlots.catalogRecovery === recovery;
  }

  /** MoqtObject → coordinator event (status-aware gap classification). */
  private toCatalogEvent(obj: MoqtObject): CatalogObjectEvent {
    const location = { group: BigInt(obj.groupId), object: BigInt(obj.objectId) };
    if (obj.kind === 'gap') {
      // Object-Does-Not-Exist (0x1) is a MISSING object; END_OF_GROUP /
      // END_OF_TRACK / range terminators are accounting markers. Only a
      // missing head can mean "missing base" — a terminator never does.
      const missing = BigInt((obj as { status?: bigint }).status ?? 0n) === 0x1n;
      return { location, kind: 'gap', gapKind: missing ? 'missing' : 'terminator' };
    }
    return { location, kind: 'payload', payload: obj.payload };
  }

  /** Readiness: today's first-catalog block, run once with the converged state. */
  private onCatalogBootstrapReady(catalogState: CatalogState): void {
    if (this._destroyed || this.isTerminalState() || this.catalogSlots.catalogReceived) return;
    const conn = this.connection;
    const gen = this.bootstrapGeneration;
    this.catalogSlots.catalogReceived = true;
    this._catalogState = catalogState;
    this._stats.recordCatalogReceived();
    this.watchdog.fulfill('catalog_received');
    this.watchdog.expect('first_media_object', 20_000);
    this.emitter.emit('catalog_received', { type: 'catalog_received', catalog: catalogState });
    if (this._destroyed || this.isTerminalState() || this.connection !== conn || this.bootstrapGeneration !== gen) return;
    this.log.info('Catalog received (bootstrap): %d tracks', catalogState.tracks.length);
    if (this.pipelinesCreated) {
      // knownTracks path — pipelines already exist, media already subscribed.
      this.qualityController = new QualityController({
        autoQuality: this.config.autoQuality!,
        startLevel: this.config.startLevel!,
        ...(this.config.capLevelToResolution ? { capLevelToResolution: this.config.capLevelToResolution } : {}),
        qualitySwitchCooldownMs: this.config.qualitySwitchCooldownMs!,
        clock: this.clock,
      });
      this.selectCatalogTracks(catalogState);
      this.validateKnownTracks(catalogState);
    } else {
      this.subscribeToMediaTracks(catalogState).catch((err: unknown) => {
        if (this.connection !== conn || this.bootstrapGeneration !== gen) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('subscribeToMediaTracks failed: %s', msg);
        this.failCatalogPlayback(createPlayerError(
          'fatal', 'player', PlayerErrorCode.LOAD_FAILED,
          `Media subscription failed: ${msg}`,
          err instanceof Error ? { cause: err } : {},
        ));
      });
    }
  }

  /**
   * Begin the staged catalog recovery. The candidate runs the FULL bootstrap
   * (its own joining fetch) on a fresh subscription; the active catalog and
   * media subscriptions are untouched throughout. Candidate readiness adopts
   * atomically — the swap behaves like an ordinary `catalog_updated`, with NO
   * second `catalog_received` and NO media churn (a removed-active-track
   * limitation documented in the plan). Any candidate terminal outcome —
   * including its own fallback ladder bottoming out — is FINAL: discard,
   * degraded diagnostic, never a second candidate.
   */

  /** Dispatch a completed catalog terminal drain against the CURRENT catalog
   *  machinery: coordinator mode finalizes the deferred DONE (and retires the
   *  route for an ended feed); legacy mode retires the route and THEN applies
   *  the deferred status policy (retriable → staged recovery). */
  private deliverCatalogDrained(slots: CatalogSlots = this.catalogSlots): void {
    const coord = slots.catalogBootstrapCoord;
    if (coord) {
      coord.onSubscriptionDrained();
      if (coord.feedEnded) this.retireCatalogAliasRoute(slots);
      return;
    }
    const t = slots.legacyCatalogTerminal;
    slots.legacyCatalogTerminal = null;
    this.retireCatalogAliasRoute(slots);
    if (!t || t.gen !== this.bootstrapGeneration) return;
    if (!slots.catalogReceived) {
      // Ended OR retriable and still no base after the whole drain window:
      // nothing further can arrive.
      this.failCatalogPlayback(createPlayerError(
        'fatal', 'player', PlayerErrorCode.LOAD_FAILED,
        'catalog track ended before a catalog was received',
      ));
      return;
    }
    if (t.reason === 'retriable' && this.connection) {
      this.beginCatalogRecovery(this.connection);
    }
  }

  /**
   * Cancel + retire a bootstrap/candidate FETCH: FETCH_CANCEL on the wire,
   * quarantine the request id (late headers/streams tombstone, never park
   * unowned), and tombstone its already-known streams. The ONE path for
   * supersession, rung transitions, and candidate teardown.
   */
  private retireBootstrapFetch(
    slots: CatalogSlots, conn: MoqtConnection, reqId: bigint,
    opts?: { attempt?: number; extraStreams?: Iterable<bigint> },
  ): void {
    if (slots.catalogFillRequests.delete(reqId)) {
      void conn.cancelFill(reqId).catch(() => { /* gone */ });
    } else {
      void conn.fetchCancel(varint(reqId)).catch(() => { /* gone */ });
    }
    // The media-fetch registries (`activeFetches`, the stream→request and
    // stream→alias routes, the quarantine set) describe the LIVE session. A
    // candidate's bootstrap fetch has no entry in them, and touching them by
    // bare ID would retire a live fetch that merely shares an ID.
    const live = conn === this.connection;
    if (live) this.quarantineFetchRequest(reqId);
    for (const [sid, entry] of slots.bootstrapFetchStreams) {
      // Attempt-scoped: retiring attempt A must never sweep streams that a
      // NEWER attempt B (started while A's rejection was still settling)
      // already owns on the same connection.
      if (entry.conn === conn && (opts?.attempt === undefined || entry.attempt === opts.attempt)) {
        slots.bootstrapFetchStreams.delete(sid);
        // Tombstones are read through the same current-connection authority, so
        // recording a candidate's stream IDs here would only risk swallowing a
        // live stream that reuses the ID.
        if (live) this.droppedFetchStreams.add(sid);
      }
    }
    if (opts?.extraStreams && live) {
      for (const sid of opts.extraStreams) this.droppedFetchStreams.add(sid);
    }
  }

  /** Retire the live catalog alias route: a drained terminal subscription
   *  must not keep applying late objects through the global alias match.
   *  Post-drain traffic on the alias parks in the ordinary pre-SUBSCRIBE_OK
   *  buffer and belongs to whichever request next binds it. */
  private retireCatalogAliasRoute(slots: CatalogSlots = this.catalogSlots): void {
    slots.catalogTrackAlias = null;
  }

  private beginCatalogRecovery(conn: MoqtConnection): void {
    if (this._destroyed || this.isTerminalState() || this.connection !== conn) return;
    if (this.catalogSlots.recoveryAttempted || this.catalogSlots.catalogRecovery !== null) {
      // Recovery declined: the feed is over for good — retire the route so a
      // late post-drain object cannot keep mutating the frozen catalog.
      this.retireCatalogAliasRoute();
      this.emitError(createPlayerError(
        'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
        'catalog feed ended (retriable) and recovery was already attempted — updates stopped',
      ));
      return;
    }
    this.catalogSlots.recoveryAttempted = true;
    const gen = this.bootstrapGeneration;
    // Role-aware ownership: pre-adoption this coordinator lives in the
    // catalogRecovery slot; ADOPTION moves it into the main slot, after which
    // its callbacks keep working (deltas, DONE, further recovery requests) —
    // ownership follows the coordinator, not the transaction slot.
    const ownedAsCandidate = (): boolean =>
      gen === this.bootstrapGeneration && this.connection === conn && this.catalogSlots.catalogRecovery?.coord === coord;
    const ownedAsMain = (): boolean =>
      gen === this.bootstrapGeneration && this.connection === conn && this.catalogSlots.catalogBootstrapCoord === coord;
    const live = (): boolean => ownedAsCandidate() || ownedAsMain();
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName(this.config.catalogTrackName));
    const manager = new CatalogManager(this.config.namespace);
    let pendingAttempt: number | null = null;

    const failCandidate = (reason: string): void => {
      if (!ownedAsCandidate()) return; // post-adoption failures follow main-role paths
      this.failCatalogRecovery(reason);
    };

    const coord = new CatalogBootstrap({
      applyAt: (loc, payload, opts) => manager.processCatalogObjectAt(loc, payload, opts),
      resetManager: () => manager.reset(),
      currentState: () => manager.currentState,
      issueJoiningFetch: (attempt) => {
        pendingAttempt = attempt;
        if (this.usesCatalogFill(conn)) {
          void Promise.resolve().then(() => {
            if (!live()) return;
            const subReqId = ownedAsCandidate() ? this.catalogSlots.catalogRecovery!.reqId : this.catalogSlots.catalogRequestId;
            if (subReqId == null) { coord.onFetchError(attempt, 'refused'); return; }
            this.catalogSlots.catalogFillRequests.add(subReqId);
            coord.onFetchOk(attempt, { group: 0n, object: 0n }, false);
            if (ownedAsCandidate()) {
              this.catalogSlots.catalogRecovery!.fetch = { reqId: subReqId, attempt };
              this.claimParkedRecoveryFill(this.catalogSlots.catalogRecovery!, subReqId, attempt);
            } else if (ownedAsMain()) {
              this.registerBootstrapFetch(this.catalogSlots, conn, subReqId, attempt, this.bootstrapGeneration);
            }
          });
          return;
        }
        void (async () => {
          let myFetchReqId: bigint | null = null;
          try {
            const subReqId = ownedAsCandidate() ? this.catalogSlots.catalogRecovery!.reqId : this.catalogSlots.catalogRequestId;
            if (!live() || subReqId == null) throw new Error('no candidate subscription');
            await conn.joiningFetch({
              joiningFetchType: 'relative',
              joiningRequestId: subReqId,
              joiningStart: 0n,
              groupOrder: varint(0x1n),
              onRequestId: (id: bigint) => {
                if (!live() || pendingAttempt !== attempt) throw new Error('catalog fetch attempt retired');
                myFetchReqId = id;
                if (ownedAsCandidate()) {
                  this.catalogSlots.catalogRecovery!.fetch = { reqId: id, attempt };
                } else if (ownedAsMain()) {
                  this.registerBootstrapFetch(this.catalogSlots, conn, id, attempt, this.bootstrapGeneration);
                }
              },
            } as never);
          } catch {
            if (!live()) return;
            // RETIRE only THIS call's allocation (request id + this attempt's
            // streams) — a rejection settling late must never cancel a newer
            // ladder attempt's request or sweep its streams.
            if (myFetchReqId !== null) {
              if (ownedAsCandidate()) {
                const r = this.catalogSlots.catalogRecovery!;
                const mine: bigint[] = [];
                for (const [sid, a] of r.fetchStreams) {
                  if (a === attempt) { mine.push(sid); r.fetchStreams.delete(sid); }
                }
                this.retireBootstrapFetch(this.catalogSlots, conn, myFetchReqId, { attempt, extraStreams: mine });
                if (r.fetch?.reqId === myFetchReqId) r.fetch = null;
              } else {
                this.retireBootstrapFetch(this.catalogSlots, conn, myFetchReqId, { attempt });
                if (this.catalogSlots.bootstrapFetch?.reqId === myFetchReqId && this.catalogSlots.bootstrapFetch.conn === conn) {
                  this.catalogSlots.bootstrapFetch = null;
                }
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      issueStandaloneFetch: (range, attempt) => {
        pendingAttempt = attempt;
        void (async () => {
          let myFetchReqId: bigint | null = null;
          try {
            if (!live()) return;
            await conn.fetch(nsBytes, nameBytes, {
              // RAW bigints — see the main coordinator's issueStandaloneFetch.
              startGroup: range.startGroup, startObject: range.startObject,
              endGroup: range.endGroupWholeOf, endObject: 0n,
              groupOrder: varint(0x1n),
              onRequestId: (id: bigint) => {
                if (!live() || pendingAttempt !== attempt) throw new Error('catalog fetch attempt retired');
                myFetchReqId = id;
                if (ownedAsCandidate()) {
                  this.catalogSlots.catalogRecovery!.fetch = { reqId: id, attempt };
                } else if (ownedAsMain()) {
                  this.registerBootstrapFetch(this.catalogSlots, conn, id, attempt, this.bootstrapGeneration);
                }
              },
            } as never);
          } catch {
            if (!live()) return;
            // RETIRE only THIS call's allocation (request id + this attempt's
            // streams) — a rejection settling late must never cancel a newer
            // ladder attempt's request or sweep its streams.
            if (myFetchReqId !== null) {
              if (ownedAsCandidate()) {
                const r = this.catalogSlots.catalogRecovery!;
                const mine: bigint[] = [];
                for (const [sid, a] of r.fetchStreams) {
                  if (a === attempt) { mine.push(sid); r.fetchStreams.delete(sid); }
                }
                this.retireBootstrapFetch(this.catalogSlots, conn, myFetchReqId, { attempt, extraStreams: mine });
                if (r.fetch?.reqId === myFetchReqId) r.fetch = null;
              } else {
                this.retireBootstrapFetch(this.catalogSlots, conn, myFetchReqId, { attempt });
                if (this.catalogSlots.bootstrapFetch?.reqId === myFetchReqId && this.catalogSlots.bootstrapFetch.conn === conn) {
                  this.catalogSlots.bootstrapFetch = null;
                }
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      cancelFetch: () => {
        pendingAttempt = null;
        if (ownedAsCandidate()) {
          const r = this.catalogSlots.catalogRecovery!;
          if (r.fetch) {
            const cancelled = r.fetch;
            r.fetch = null;
            const mine: bigint[] = [];
            for (const [sid, a] of r.fetchStreams) {
              if (a === cancelled.attempt) { mine.push(sid); r.fetchStreams.delete(sid); }
            }
            this.retireBootstrapFetch(this.catalogSlots, conn, cancelled.reqId, { attempt: cancelled.attempt, extraStreams: mine });
          }
          return;
        }
        const fetch = this.catalogSlots.bootstrapFetch;
        if (fetch?.conn === conn) {
          this.catalogSlots.bootstrapFetch = null;
          this.retireBootstrapFetch(this.catalogSlots, conn, fetch.reqId, { attempt: fetch.attempt });
        }
      },
      onReady: (state) => {
        if (!ownedAsCandidate()) return;
        // Adoption barrier: ready AND alias bound AND readiness SETTLED
        // (onReadySettled) — the retained suffix is examined before adoption
        // so a malformed entry aborts the transaction, never the adopted
        // state. The joining fetch can complete while the subscription is
        // still Pending, so the alias half of the barrier matters too.
        this.catalogSlots.catalogRecovery!.readyState = state;
      },
      onReadySettled: () => {
        if (ownedAsCandidate()) this.maybeAdoptCatalogRecovery();
      },
      onUpdated: (state) => {
        if (ownedAsCandidate()) {
          // Pre-adoption candidate updates (replayed parked objects after the
          // held readiness) refresh the pending snapshot — the ACTIVE catalog
          // is never mutated by a candidate.
          const r = this.catalogSlots.catalogRecovery!;
          if (r.readyState !== null) r.readyState = state;
          return;
        }
        if (!ownedAsMain()) return;
        this._catalogState = state;
        this.emitter.emit('catalog_updated', { type: 'catalog_updated', catalog: state });
      },
      requestLegacyResubscribe: () => {
        if (ownedAsCandidate()) failCandidate('fallback ladder exhausted');
        // Post-adoption this is unreachable by construction (the adopted
        // coordinator is in steady state); nothing to do as main.
      },
      onFatal: (reason) => {
        if (ownedAsCandidate()) { failCandidate(reason); return; }
        if (!ownedAsMain()) return;
        this.failCatalogPlayback(createPlayerError(
          'fatal', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
          `catalog failed after recovery adoption: ${reason}`,
        ));
      },
      onDegraded: (reason) => {
        // PRE-ADOPTION, a degraded candidate is a FAILED transaction — the
        // active snapshot must stay untouched and the candidate dies, rather
        // than surfacing a degradation against state the player never adopted.
        if (ownedAsCandidate()) { failCandidate(`candidate update rejected: ${reason}`); return; }
        if (!ownedAsMain()) return;
        this.emitError(createPlayerError(
          'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
          `catalog update rejected: ${reason}`,
        ));
      },
      requestStagedRecovery: () => {
        if (ownedAsCandidate()) { failCandidate('candidate feed ended again'); return; }
        if (!ownedAsMain()) return;
        // The ADOPTED catalog's feed ended retriably again — one recovery per
        // generation: this reports degraded (documented limit, no recursion).
        this.beginCatalogRecovery(conn);
      },
      log: (msg, ...args) => this.log.debug(msg, ...args),
    }, {
      draft: (conn.draftVersion ?? this.config.draftVersion ?? 16) as 14 | 16 | 18 | 22,
      // Legacy catalog mode (the explicit 'subscribe' compatibility option):
      // the candidate is a fresh AbsoluteStart subscribe — subscription-only
      // retrieval, ready on the first acceptable base; NEVER a Joining FETCH.
      startMode: this.resolvedCatalogMode(conn) === 'subscribe' ? 'legacy' : 'joining',
      strict: this.strictCatalogMode(),
    });

    this.catalogSlots.catalogRecovery = {
      coord, manager, conn, gen, reqId: null, alias: null, fetch: null,
      fetchStreams: new Map(),
      retiredAlias: this.catalogSlots.catalogTrackAlias,
      parked: [], parkedBytes: 0, parkedEvents: new Map(),
      readyState: null, replaying: false,
    };
    // RETIRE the old catalog alias route: its subscription is dead (retriable
    // DONE + completed drain), so nothing may mutate the preserved active
    // catalog through it. In-window reuse parks via `retiredAlias` above; any
    // later traffic on the alias parks in the ordinary pre-SUBSCRIBE_OK
    // buffer and is attributed to whichever request next binds it — the
    // adapter freed the alias at drain completion, so post-drain data belongs
    // to the next generation (request/generation ownership, no wall-clock
    // exclusion).
    this.retireCatalogAliasRoute();

    void (async () => {
      let allocatedId: bigint | null = null;
      try {
        const candidateFilter = this.resolvedCatalogMode(conn) === 'subscribe'
          ? { type: 'AbsoluteStart' as const, startGroup: varint(0n), startObject: varint(0n) }
          : { type: 'LargestObject' as const };
        const reqId = await conn.subscribe(nsBytes, nameBytes, {
          subscriptionFilter: candidateFilter,
          ...(candidateFilter.type === 'LargestObject' && this.usesCatalogFill(conn) ? { fill: CATALOG_FILL } : {}),
          onRequestId: (id: bigint) => {
            const r = this.catalogSlots.catalogRecovery;
            if (!ownedAsCandidate() || !r || this._destroyed || this.isTerminalState()) {
              throw new Error('Catalog recovery retired before emission');
            }
            allocatedId = id;
            r.reqId = id;
            this.pendingAliasBinds.add(id);
          },
          terminalDelivery: 'drain',
          onDrained: (id: bigint) => {
            const matches = ownedAsCandidate()
              ? this.catalogSlots.catalogRecovery!.reqId === id
              : (ownedAsMain() && this.catalogSlots.catalogRequestId === id);
            if (!matches) return;
            coord.onSubscriptionDrained();
            if (ownedAsMain() && coord.feedEnded) this.retireCatalogAliasRoute();
          },
        } as never);
        const r = this.catalogSlots.catalogRecovery;
        if (!ownedAsCandidate() || !r) {
          if (allocatedId === null && !ownedAsMain()) {
            void conn.unsubscribe(varint(BigInt(reqId))).catch(() => { /* best effort */ });
          }
          return;
        }
        if (r.reqId === null) {
          r.reqId = BigInt(reqId); // callback-less adapter fallback
          this.pendingAliasBinds.add(BigInt(reqId));
        }
        coord.start();
      } catch (err) {
        failCandidate(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  /** Abort the staged-recovery candidate; the active catalog stays untouched. */
  private failCatalogRecovery(reason: string): void {
    if (!this.retireCatalogRecovery()) return;
    this.emitError(createPlayerError(
      'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
      `catalog recovery failed (${reason}) — active catalog retained, updates stopped`,
    ));
  }

  /** Retire candidate-owned requests without publishing a second diagnostic. */
  private retireCatalogRecovery(): boolean {
    const recovery = this.catalogSlots.catalogRecovery;
    if (!recovery) return false;
    this.catalogSlots.catalogRecovery = null;
    recovery.coord.abort();
    // The candidate's SUBSCRIBE ownership settles like any other failed
    // request: entries it owned exclusively drop; an entry ALSO owned by a
    // concurrent media request survives for that owner.
    if (recovery.reqId !== null) {
      this.settleParkedOwnership(recovery.reqId, null, recovery.conn);
    }
    // The candidate's FETCH ownership is retired EXPLICITLY — the
    // coordinator's cancelFetch callback is inert once the slot is cleared.
    if (recovery.fetch) {
      this.retireBootstrapFetch(this.catalogSlots, recovery.conn, recovery.fetch.reqId,
        { attempt: recovery.fetch.attempt, extraStreams: recovery.fetchStreams.keys() });
    } else {
      for (const sid of recovery.fetchStreams.keys()) this.droppedFetchStreams.add(sid);
    }
    if (recovery.reqId !== null) {
      void recovery.conn.unsubscribe(varint(recovery.reqId)).catch(() => { /* best effort */ });
    }
    return true;
  }

  /**
   * The full four-axis budget (objects / bytes / aliases / lifecycle) for the
   * ACTIVE catalog transaction on `conn` — the MAIN bootstrap pre-OK or the
   * staged-recovery candidate — computed over BOTH stores (retired-alias
   * parking and transaction-owned generic parking). Entries owned only by
   * unrelated media requests never charge it. True when no transaction.
   */
  private catalogParkingWithinBounds(conn: MoqtConnection): boolean {
    const txnReqId = this.activeCatalogTransactionReqId(conn);
    if (txnReqId === null) return true;
    let objects = 0;
    let bytes = 0;
    const aliases = new Set<bigint>();
    const r = this.catalogSlots.catalogRecovery;
    if (r && r.conn === conn) {
      objects += r.parked.length;
      bytes += r.parkedBytes;
      if (r.parked.length > 0 && r.retiredAlias !== null) aliases.add(r.retiredAlias);
    }
    for (const [alias, bucket] of this.pendingObjectsByAlias) {
      let inBucket = false;
      for (const e of bucket) {
        if (e.sourceConnection !== conn || !e.owners?.includes(txnReqId)) continue;
        inBucket = true;
        objects += 1;
        bytes += e.obj.kind === 'data' ? e.obj.payload.byteLength : 0;
      }
      if (inBucket) aliases.add(alias);
    }
    // Lifecycle: the unified count (parkedEvents + transaction-owned records).
    const events = this.catalogOwnedStreamEventCount(conn);
    return objects <= MoqtPlayer.MAX_RECOVERY_PARKED_OBJECTS
      && bytes <= MoqtPlayer.MAX_RECOVERY_PARKED_BYTES
      && aliases.size <= MoqtPlayer.MAX_RECOVERY_PARKED_ALIASES
      && events <= MoqtPlayer.MAX_RECOVERY_PARKED_EVENTS;
  }

  /**
   * The ONE settlement operation for a pending subscribe, used by responses
   * (SUBSCRIBE_OK → `boundAlias`; REQUEST_ERROR → null), send-failure
   * rollback, cancellation, and candidate failure:
   * - the request stops being a plausible owner (removed from the bind set
   *   and from every parked entry's owner set);
   * - the BOUND bucket keeps only entries the resolving request actually
   *   owns — a request must never inherit data parked for someone else;
   * - entries left ownerless are dropped (no future request inherits them);
   * - lifecycle records whose stream no longer has any parked object go too.
   */
  private settleParkedOwnership(reqId: bigint, boundAlias: bigint | null, conn: MoqtConnection): void {
    this.pendingAliasBinds.delete(reqId);
    for (const [alias, bucket] of this.pendingObjectsByAlias) {
      let changed = false;
      const bound = boundAlias !== null && alias === boundAlias;
      const kept = bucket.filter((e) => {
        if (e.sourceConnection !== conn || e.owners === undefined) return true;
        if (bound) {
          // Only entries this request OWNS ride the imminent replay.
          if (e.owners.includes(reqId)) return true;
          changed = true;
          return false;
        }
        const idx = e.owners.indexOf(reqId);
        if (idx === -1) return true;
        e.owners.splice(idx, 1);
        changed = true;
        return e.owners.length > 0;   // ownerless → dropped
      });
      if (!changed) continue;
      if (kept.length > 0) this.pendingObjectsByAlias.set(alias, kept);
      else this.pendingObjectsByAlias.delete(alias);
    }
    // Lifecycle evidence lives only as long as some parked object references
    // its stream.
    const perConn = this.pendingStreamEvents.get(conn);
    if (perConn) {
      for (const streamId of perConn.keys()) {
        let referenced = false;
        for (const bucket of this.pendingObjectsByAlias.values()) {
          if (bucket.some((e) => e.streamId === streamId && e.sourceConnection === conn)) { referenced = true; break; }
        }
        if (!referenced) perConn.delete(streamId);
      }
      if (perConn.size === 0) this.pendingStreamEvents.delete(conn);
    }
  }

  /** The request id of the ACTIVE catalog transaction on `conn`, if any:
   *  the staged-recovery candidate, or the MAIN bootstrap catalog subscribe
   *  while it is still awaiting SUBSCRIBE_OK (its pre-alias evidence is just
   *  as fail-closed as a candidate's). */
  private activeCatalogTransactionReqId(conn: MoqtConnection): bigint | null {
    const r = this.catalogSlots.catalogRecovery;
    if (r && r.conn === conn && r.reqId !== null) return r.reqId;
    // EVERY unanswered catalog SUBSCRIBE is a live transaction — the
    // coordinator modes AND the coordinator-less legacy retrieval (explicit
    // 'subscribe' mode) and the rung-2 AbsoluteStart resubscribe alike.
    if (conn === this.connection
        && this.catalogSlots.catalogRequestId !== null && this.catalogSlots.catalogTrackAlias === null) {
      return this.catalogSlots.catalogRequestId;
    }
    return null;
  }

  /** Whether an entry parked RIGHT NOW on `conn` would be owned by the
   *  active catalog transaction — i.e. that transaction's subscribe is still
   *  awaiting its SUBSCRIBE_OK (owner snapshots copy the bind set). */
  private wouldBeCatalogTransactionOwned(conn: MoqtConnection): boolean {
    if (conn !== this.connection) return false;
    const txnReqId = this.activeCatalogTransactionReqId(conn);
    return txnReqId !== null && this.pendingAliasBinds.has(txnReqId);
  }

  /** Whether `streamId` (on `conn`) carries a parked object owned by the
   *  active catalog transaction (main bootstrap pre-OK, or candidate). */
  private streamOwnedByCatalogTransaction(conn: MoqtConnection, streamId: bigint): boolean {
    const txnReqId = this.activeCatalogTransactionReqId(conn);
    if (txnReqId === null) return false;
    return this.streamOwnedByCandidateId(conn, streamId, txnReqId);
  }

  /** ONE transaction-wide lifecycle count: retired-alias parkedEvents AND
   *  transaction-owned generic records — split stores share the limit. */
  private catalogOwnedStreamEventCount(conn: MoqtConnection): number {
    let n = 0;
    const r = this.catalogSlots.catalogRecovery;
    if (r && r.conn === conn) n += r.parkedEvents.size;
    const perConn = this.pendingStreamEvents.get(conn);
    if (perConn) {
      for (const streamId of perConn.keys()) {
        if (this.streamOwnedByCatalogTransaction(conn, streamId)) n += 1;
      }
    }
    return n;
  }

  /** Evict the oldest lifecycle record NOT owned by an active catalog
   *  transaction. Returns false when everything retained is transaction
   *  evidence. */
  private evictOldestUnownedStreamEvent(): boolean {
    for (const [conn, perConn] of this.pendingStreamEvents) {
      for (const streamId of perConn.keys()) {
        if (this.streamOwnedByCatalogTransaction(conn, streamId)) continue;
        perConn.delete(streamId);
        if (perConn.size === 0) this.pendingStreamEvents.delete(conn);
        return true;
      }
    }
    return false;
  }

  private streamOwnedByCandidateId(conn: MoqtConnection, streamId: bigint, candidateReqId: bigint): boolean {
    for (const bucket of this.pendingObjectsByAlias.values()) {
      if (bucket.some((e) => e.streamId === streamId && e.sourceConnection === conn
          && e.owners?.includes(candidateReqId) === true)) {
        return true;
      }
    }
    return false;
  }

  /** Adoption barrier: candidate readiness AND a bound alias (SUBSCRIBE_OK). */
  private maybeAdoptCatalogRecovery(): void {
    const recovery = this.catalogSlots.catalogRecovery;
    if (!recovery || recovery.readyState === null || recovery.alias === null) return;
    if (this._destroyed || this.isTerminalState() || recovery.gen !== this.bootstrapGeneration
        || recovery.conn !== this.connection) return;
    if (recovery.replaying) return; // hold until the parked replay is fully examined
    this.adoptCatalogRecovery(recovery.readyState);
  }

  /**
   * Pre-alias parking overflow while catalog machinery is live on `conn`:
   * fail closed. A candidate is aborted (active catalog preserved); the main
   * coordinator fails its attempt into the fallback ladder. Never a silent
   * drop that could bless an incomplete delta chain.
   */
  private onCatalogParkingOverflow(conn: MoqtConnection): void {
    const r = this.catalogSlots.catalogRecovery;
    if (r && r.conn === conn) {
      this.failCatalogRecovery('pre-alias parking overflow');
      return;
    }
    const coord = this.catalogSlots.catalogBootstrapCoord;
    if (coord && this.connection === conn) {
      if (coord.phase === 'fallback-legacy') {
        // FINAL rung, pre-ready: no further fallback exists — a truncated
        // catalog is never accepted. CLEANUP BEFORE PUBLICATION: the
        // terminating identity is captured and retired first, so a throwing
        // application error listener/filter (invoked synchronously by the
        // coordinator's fatal below, preserving the listener exception
        // contract) can never leave the terminal request or its parking
        // ownership live.
        this.terminateCatalogRetrieval(conn, this.catalogSlots.catalogRequestId, null);
        coord.onParkingOverflow();   // → fatal → onFatal surfaces the error
        return;
      }
      coord.onParkingOverflow();
      return;
    }
    // LEGACY retrieval (no coordinator — explicit 'subscribe' mode):
    // a pre-ready overflow is terminal. A dropped pre-alias object could be a
    // load-bearing delta — accepting a truncated catalog is worse than
    // failing loudly.
    if (this.connection === conn && this.catalogSlots.catalogRequestId !== null && !this.catalogSlots.catalogReceived) {
      this.terminateCatalogRetrieval(conn, this.catalogSlots.catalogRequestId,
        'catalog pre-alias parking overflow during legacy retrieval — a truncated catalog cannot be accepted');
    }
  }

  /**
   * TERMINAL end of the catalog retrieval identified by `terminatingReqId`:
   * settle that request's ownership (dropping transaction-owned parked
   * objects and lifecycle evidence), retire the route, forget the deferred
   * legacy terminal, and unsubscribe exactly once. All CLEANUP runs before
   * any publication, and the slot is nulled ONLY while it still holds the
   * terminating request — re-entrant application code that installed a newer
   * request is never disturbed. `fatalReason` surfaces LOAD_FAILED last,
   * when the caller has not already surfaced one.
   */
  private terminateCatalogRetrieval(conn: MoqtConnection, terminatingReqId: bigint | null, fatalReason: string | null): void {
    if (terminatingReqId !== null && this.catalogSlots.catalogRequestId === terminatingReqId) {
      this.catalogSlots.catalogRequestId = null;
      this.retireCatalogAliasRoute();
      this.catalogSlots.legacyCatalogTerminal = null;
    }
    if (terminatingReqId !== null) {
      this.settleParkedOwnership(terminatingReqId, null, conn);
      void conn.unsubscribe(varint(terminatingReqId)).catch(() => { /* best effort */ });
    }
    if (fatalReason !== null) {
      this.failCatalogPlayback(createPlayerError(
        'fatal', 'player', PlayerErrorCode.LOAD_FAILED, fatalReason,
      ));
    }
  }

  /** Commit a catalog failure before invoking filters or application listeners. */
  private failCatalogPlayback(error: PlayerError): void {
    if (this._destroyed || this.isTerminalState()) return;
    const from = this.applyState(PlayerState.ERROR);
    if (this.pendingVideoSwitch) this.discardPendingVideoSwitch(this.pendingVideoSwitch, new Error(error.message));
    this.playbackIntent = false;
    this.stopTicking();
    this.watchdog.destroy();
    let failed = false;
    let cause: unknown;
    const attempt = (run: () => void): void => {
      try { run(); }
      catch (err) { if (!failed) { failed = true; cause = err; } }
    };
    this.pendingGoaway = null;
    if (this.currentMigration) {
      this.currentMigration.terminated = true;
      if (!this.currentMigration.committed) attempt(() => this.abortMigration(this.currentMigration!));
    }
    const conn = this.connection;
    const requestId = this.catalogSlots.catalogRequestId;
    if (conn) {
      this.catalogQuarantinedConns.add(conn);
      if (this.catalogSlots.catalogTrackAlias !== null) this.quarantinedCatalogAliases.set(conn, this.catalogSlots.catalogTrackAlias);
    }
    attempt(() => this.retireCatalogRecovery());
    attempt(() => this.cancelCatalogBootstrap());
    if (conn) {
      attempt(() => this.terminateCatalogRetrieval(conn, requestId, null));
      for (const id of new Set([...this.activeSubscriptions.keys(), ...this.pendingMediaSubs.keys()])) {
        attempt(() => this.retireMediaSubscription(id, conn));
        attempt(() => { void conn.unsubscribe(varint(id)).catch(() => { /* best effort */ }); });
      }
    }
    attempt(() => this.mediaSource?.setPlaybackIntent?.(false));
    attempt(() => this.commandDispatcher?.flush());

    // Both publications are attempted, even if a listener throws. State comes
    // first so a re-entrant destroy cannot publish ENDED before this ERROR.
    attempt(() => this.announceState(from, PlayerState.ERROR));
    attempt(() => this.emitError(error));
    if (failed) throw cause;
  }

  /** Atomic adoption: the candidate becomes the active catalog machinery. */
  private adoptCatalogRecovery(state: CatalogState): void {
    const recovery = this.catalogSlots.catalogRecovery;
    if (!recovery || this._destroyed || this.isTerminalState() || recovery.gen !== this.bootstrapGeneration
        || recovery.conn !== this.connection) return;
    this.catalogSlots.catalogRecovery = null;
    // Retire the OLD catalog machinery (its subscription already ended).
    this.catalogSlots.catalogBootstrapCoord?.abort();
    this.catalogSlots.catalogBootstrapCoord = recovery.coord;
    this.catalogSlots.catalogManager = recovery.manager;
    this.catalogSlots.catalogRequestId = recovery.reqId;
    // A candidate whose feed already ENDED (drained while awaiting the
    // SUBSCRIBE_OK barrier) is adopted for its CONTENT — the dead alias must
    // not become routable again.
    this.catalogSlots.catalogTrackAlias = recovery.coord.feedEnded ? null : recovery.alias;
    // Migrate any live bootstrap fetch-stream tagging.
    for (const [sid, attempt] of recovery.fetchStreams) {
      this.catalogSlots.bootstrapFetchStreams.set(sid, { attempt, conn: recovery.conn });
    }
    if (recovery.fetch) {
      this.catalogSlots.bootstrapFetch = { conn: recovery.conn, reqId: recovery.fetch.reqId, attempt: recovery.fetch.attempt, gen: this.bootstrapGeneration };
    }
    // Adoption is an ordinary catalog update: no second catalog_received, no
    // media churn (documented limitation: a removed currently-active track
    // keeps its old media subscription running until a later selection).
    this._catalogState = state;
    this.emitter.emit('catalog_updated', { type: 'catalog_updated', catalog: state });
  }

  /**
   * Normalize a PUBLISH_DONE status code per draft (the 0x5/0x6 meanings are
   * swapped between 16 and 18, and draft-14's MALFORMED_TRACK is 0x7, not
   * 0x12). Total: unknown/future codes degrade to 'retriable' + diagnostic —
   * never silently fatal.
   */
  private normalizePublishDoneStatus(code: bigint, draftVersion?: DraftVersion): PublishDoneReason {
    // NEGOTIATED draft: the status tables differ per draft, and the session's
    // actual draft can diverge from configuration under auto-negotiation. An
    // explicit version is passed when the DELIVERING session is not the live
    // one, as during a cross-draft handover.
    const draft = draftVersion ?? this.connection?.draftVersion ?? this.config.draftVersion ?? 16;
    if (code === 0x2n) return 'ended';                            // TRACK_ENDED
    if (code === 0x3n && !isDraft22(draft)) return 'ended';            // SUBSCRIPTION_ENDED (gone in draft 22)
    if (code === 0x4n) return 'going-away';                       // GOING_AWAY
    if (code === 0x1n) return 'fatal-track';                      // UNAUTHORIZED
    if (draft === 14 && code === 0x7n) return 'fatal-track';      // d14 MALFORMED_TRACK
    if (draft !== 14 && code === 0x12n) return 'fatal-track';     // d16+ MALFORMED_TRACK
    // INTERNAL_ERROR(0x0), EXPIRED/TOO_FAR_BEHIND (0x5/0x6, either draft
    // orientation), UPDATE_FAILED(0x8), d18/22 EXCESSIVE_LOAD(0x9), unknown.
    if (code !== 0x0n && code !== 0x5n && code !== 0x6n && code !== 0x8n && code !== 0x9n) {
      this.log.warn('[catalog-bootstrap] unknown PUBLISH_DONE status 0x%s — treated as retriable', code.toString(16));
    }
    return 'retriable';
  }

  private cleanupCatalogFetch(reqId: bigint): void {
    const pending = this.pendingCatalogFetches.get(reqId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCatalogFetches.delete(reqId);
    }
    for (const [streamId, mapped] of this.catalogFetchStreams) {
      if (mapped === reqId) this.catalogFetchStreams.delete(streamId);
    }
  }

  /**
   * Resolve / reject a pending fetchCatalog by request ID with a
   * parsed CatalogState (or an error). Used by the onObject + REQUEST_ERROR
   * code paths to dispatch FETCH responses to the right caller.
   */
  private settleCatalogFetch(
    reqId: bigint,
    result: { ok: true; state: CatalogState } | { ok: false; error: Error },
  ): void {
    const pending = this.pendingCatalogFetches.get(reqId);
    if (!pending) return;
    this.cleanupCatalogFetch(reqId);
    if (result.ok) pending.resolve(result.state);
    else pending.reject(result.error);
  }

  /**
   * Subscribe to a namespace prefix for dynamic track discovery.
   *
   * Sends SUBSCRIBE_NAMESPACE on a new bidirectional stream. NAMESPACE
   * and NAMESPACE_DONE messages are emitted as player events.
   *
   * §6.1: "The subscriber sends SUBSCRIBE_NAMESPACE on a new
   * bidirectional stream [...] the publisher MUST send a single
   * REQUEST_OK or REQUEST_ERROR as the first message."
   *
   * @param namespacePrefix Namespace prefix string (e.g., "live/broadcast").
   * @returns The request ID for cancellation.
   *
   * @see draft-ietf-moq-transport-16 §6.1
   * @see draft-ietf-moq-transport-16 §9.25
   */
  async subscribeNamespace(namespacePrefix: string): Promise<bigint> {
    if (!this.connection) throw new Error('Player not loaded');

    const nsBytes = encodeNamespace(namespacePrefix, this.enc);
    const reqId = await this.connection.subscribeNamespace(nsBytes);
    return BigInt(reqId);
  }

  /**
   * Cancel an active namespace subscription.
   *
   * Closes the namespace discovery stream with FIN.
   *
   * @param requestId The request ID returned by subscribeNamespace().
   *
   * @see draft-ietf-moq-transport-16 §6.1
   */
  async cancelNamespace(requestId: bigint): Promise<void> {
    if (!this.connection) throw new Error('Player not loaded');
    await this.connection.cancelNamespace(varint(requestId));
  }

  /**
   * Query the status of a track without subscribing.
   *
   * Returns a promise that resolves when REQUEST_OK arrives (with
   * the track's parameters) or rejects when REQUEST_ERROR arrives.
   *
   * §9.19: "TRACK_STATUS [...] enables a potential subscriber to query
   * the current status of a track without creating a subscription or
   * receiving objects."
   *
   * @param trackName Track name to query.
   * @returns Track status parameters from the publisher.
   *
   * @see draft-ietf-moq-transport-16 §9.19 (TRACK_STATUS)
   */
  async queryTrackStatus(trackName: string): Promise<TrackStatusResult> {
    if (!this.connection) throw new Error('Player not loaded');

    const nsBytes = trackNamespaceFields(this.uniqueCatalogTrack(trackName), this.config.namespace)
      .map(field => this.enc.encode(field));
    const nameBytes = this.enc.encode(trackName);

    const conn = this.connection;

    // ONE settlement promise for the whole operation, created and returned
    // without awaiting the send. The send runs detached, so an early
    // REQUEST_OK / REQUEST_ERROR / GOAWAY settles a promise the caller already
    // holds — rather than rejecting an internal promise nobody is observing
    // yet, which escapes as an unhandled rejection.
    let settleResolve!: (result: TrackStatusResult) => void;
    let settleReject!: (error: Error) => void;
    const promise = new Promise<TrackStatusResult>((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    const waiter = { resolve: settleResolve, reject: settleReject };
    // Remove only OUR entry. Request IDs are per-session, so a replacement
    // connection can legitimately register the same number; deleting by ID
    // alone would drop a successor's waiter and leave its query pending.
    const dropIfMine = (requestId: bigint): void => {
      if (this.pendingTrackStatuses.get(requestId) === waiter) {
        this.pendingTrackStatuses.delete(requestId);
      }
    };
    const abandoned = (): Error => new Error('TRACK_STATUS abandoned: its session was replaced');

    void (async () => {
      let registered: bigint | null = null;
      try {
        // Register ownership BEFORE the request reaches the peer: a response or
        // a GOAWAY on this very request stream can be handled before the send's
        // own continuation runs.
        await conn.trackStatus(nsBytes, nameBytes, {
          onRequestId: (requestId) => {
            // Teardown or a replacement between this call and the allocation
            // means this query has no owner; throwing here rolls the request
            // back before any bytes go out.
            if (this._destroyed || conn !== this.connection) throw abandoned();
            registered = requestId;
            this.pendingTrackStatuses.set(requestId, waiter);
          },
        });
      } catch (err) {
        // The send failed, so no response can arrive — drop the waiter and
        // settle the caller's promise rather than leaving it pending.
        if (registered !== null) dropIfMine(registered);
        settleReject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (registered !== null && conn !== this.connection) {
        dropIfMine(registered);
        settleReject(abandoned());
      }
    })();

    return promise;
  }

  /**
   * Tick playback pipelines — drain buffers, evaluate gaps, emit commands.
   *
   * Called automatically by play() on a 16ms interval.
   * Exposed publicly for testing and manual control.
   *
   * @see draft-ietf-moq-loc-01 §4.2 (decode order)
   */
  tick(): void {
    // Clear the per-tick sync reset guard. If both pipelines skip_forward
    // in the same tick, only the first (audio) resets the sync controller.
    this.syncResetThisTick = false;

    // Audio ticks first: its first sample establishes the sync reference
    // (LOC §2.3.1.1 CaptureTimestamp). Video needs this reference to compute
    // render times — without it, all frames render at clock.now() in a burst.
    this.audioPipeline?.tick();
    this.videoPipeline?.tick();

    // Proactive quality adaptation: if estimated bandwidth is below
    // 1.5× the current track's bitrate, downshift before stalls occur.
    this.checkBandwidthAdaptation();

    // Media liveness: reconcile monitored tracks with the live subscription
    // map (a handful of entries — cheap at tick rate, and immune to drift
    // across subscribe/unsubscribe/switch paths), then evaluate starvation.
    this.syncAndCheckLiveness();
  }

  /** Throttle for sync_skew diagnostic events (~1/s). */
  private lastSkewEmitMs = 0;

  /** Timestamp of last ABR downshift — gates upshift for stability. */
  private lastAbrDownshiftUs = 0;
  /** Timestamp (µs) of last video stall — gates LOC upshift. */
  private lastLocStallUs = 0;
  /** Timestamp (µs) of last video decode error — gates LOC upshift. */
  private lastLocDecodeErrorUs = 0;
  /** Timestamp (µs) of last partial_group_abandoned — gates LOC upshift. */
  private lastLocPartialAbandonUs = 0;
  /** Timestamp (µs) of last video queue pressure high — gates LOC upshift. */
  private lastLocQueuePressureUs = 0;
  /** Rendered video frames since last bad event — confirms sustained health. */
  private locHealthyRenderCount = 0;
  private static readonly LOC_MIN_HEALTHY_RENDERS = 5;
  /** Consecutive stalls without a rendered frame — triggers jump-to-live. */
  private consecutiveStallCount = 0;
  /**
   * True while recovering from a skip/jump — gates onFrameRendered from
   * resetting consecutiveStallCount until sustained healthy renders confirm
   * recovery succeeded (Shaka's didJump_ pattern).
   */
  private videoRecoveryActive = false;
  private videoRecoveryHealthyRenders = 0;
  private static readonly RECOVERY_HEALTHY_THRESHOLD = 3;
  private static readonly ABR_UPSHIFT_STABILITY_US = 15_000_000; // 15s

  private isLocDeliveryHealthy(): boolean {
    const now = this.clock.now();
    const window = MoqtPlayer.ABR_UPSHIFT_STABILITY_US;
    const lastBadEvent = Math.max(
      this.lastLocStallUs,
      this.lastLocDecodeErrorUs,
      this.lastLocPartialAbandonUs,
      this.lastLocQueuePressureUs,
      this.lastAbrDownshiftUs,
    );
    if (now - lastBadEvent < window) return false;
    if (this.videoRecoveryActive) return false;
    if (this.locHealthyRenderCount < MoqtPlayer.LOC_MIN_HEALTHY_RENDERS) return false;
    return true;
  }

  private checkBandwidthAdaptation(): void {
    if (!this.bufferAbrController || !this.qualityController) return;
    // Don't trigger ABR while a switch is in flight — give the current
    // switch time to deliver data before deciding to switch again.
    if (this.pendingVideoSwitch || this.switchInProgress) return;

    let effectiveBufferUs: number;

    if (this.videoPipeline) {
      // LOC path: health gates all upshift decisions. When unhealthy,
      // cap to hold zone regardless of buffer depth — prevents upshift
      // after stalls, decode errors, or partial group abandonment.
      const bufferedGroups = this.videoPipeline.bufferedGroupCount;
      const healthy = this.isLocDeliveryHealthy();
      if (!healthy) {
        effectiveBufferUs = this.bufferAbrController.lowThresholdUs;
      } else if (bufferedGroups === 0) {
        effectiveBufferUs = this.bufferAbrController.highThresholdUs;
      } else {
        effectiveBufferUs = bufferedGroups * this.estimatedGopDurationUs;
      }
    } else if (this.mediaSource?.getBufferAheadUs) {
      // CMAF path: read buffer depth from MSE.
      // MSE buffers are naturally thin on fast networks — data arrives
      // and is consumed almost simultaneously, keeping buffered.end near
      // currentTime. A thin buffer with high bandwidth is healthy (data
      // arrives on demand), not starving. Only report low buffer when
      // bandwidth can't sustain the current track.
      const bufferUs = this.mediaSource.getBufferAheadUs();
      if (bufferUs === null) return; // no trustworthy signal yet — hold
      if (bufferUs === 0) {
        // Truly empty — always report emergency, don't let stale
        // bandwidth estimates suppress the downshift.
        effectiveBufferUs = 0;
      } else if (bufferUs < this.bufferAbrController.lowThresholdUs) {
        // Thin but not empty — check if bandwidth sustains.
        // On fast networks MSE buffers are naturally thin; a thin
        // buffer with high bandwidth is healthy, not starving.
        const bwKbps = this.bandwidthEstimator?.getEstimateKbps() ?? 0;
        const currentTrack = this.bufferAbrController.currentTrack;
        const currentBitrateKbps = currentTrack ? currentTrack.bitrateKbps : 0;
        effectiveBufferUs = bwKbps > currentBitrateKbps * 1.5
          ? this.bufferAbrController.lowThresholdUs
          : bufferUs;
      } else {
        effectiveBufferUs = bufferUs;
      }
    } else {
      effectiveBufferUs = this.bufferAbrController.lowThresholdUs;
    }

    const bandwidthKbps = this.bandwidthEstimator?.getEstimateKbps() ?? 0;

    const decision = this.bufferAbrController.evaluate({
      bufferDepthUs: effectiveBufferUs,
      bandwidthEstimateKbps: bandwidthKbps,
    });

    if (decision.action === 'hold') return;

    // Block upshift for 15s after any downshift — prevents oscillation
    // where a lower-bitrate stream inflates the throughput estimate.
    if (decision.action === 'upshift') {
      const sinceDownshift = this.clock.now() - this.lastAbrDownshiftUs;
      if (sinceDownshift < MoqtPlayer.ABR_UPSHIFT_STABILITY_US) return;
    }

    const isDown = decision.action === 'downshift';
    const isEmergency = isDown && effectiveBufferUs < this.bufferAbrController.lowThresholdUs;
    // Non-mutating peek — state only changes on commit.
    const newTrack = isDown
      ? this.qualityController.peekLowerVideoQuality(isEmergency)
      : this.qualityController.peekHigherVideoQuality();

    if (newTrack) {
      if (isDown) this.lastAbrDownshiftUs = this.clock.now();
      const verb = isDown ? 'downshift' : 'upshift';
      this.log.warn('Buffer %.1fs, BW %.0fkbps → %s to %s',
        effectiveBufferUs / 1_000_000, bandwidthKbps, verb, newTrack.name);
      // No stats or controller mutation here — deferred to completePendingVideoSwitch.
      this.selectVideoTrack(newTrack.name, 'bandwidth', isDown ? 'downshift' : 'upshift')
        .catch((err) => {
          this.log.warn('ABR %s to "%s" failed: %s', verb, newTrack.name, err);
        });
    }
  }

  /**
   * Tear down everything — unsubscribe, close adapter, release resources.
   *
   * @see draft-ietf-moq-transport-16 §3.6 (Session Termination)
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const owner of this.warmMediaOwners.values()) owner.head?.retire();
    this.warmMediaOwners.clear();
    this.log.info('destroy()');
    this.mediaStageObservers?.dispose();
    this.mediaStageObservers = undefined;
    // Withdraw playback intent first: a late arrival must not start playback
    // on a player that is going away.
    this.playbackIntent = false;
    this.mediaSource?.setPlaybackIntent?.(false);
    // Cancel any in-flight migration: a deferred candidate connect()/subscribe()
    // must NOT resurrect this destroyed player by becoming this.connection. The
    // in-flight transaction sees _destroyed at its next validation and rolls back;
    // detaching + closing the candidate here stops its callbacks and unblocks it.
    this.pendingGoaway = null; // never act on a queued GOAWAY after destruction
    if (this.currentMigration) {
      const txn = this.currentMigration;
      this.currentMigration = null;
      txn.aborted = true;
      // Wake a pending attempt so its timer is cancelled and the slot released
      // even if the transport factory never settles.
      txn.wake?.();
      txn.committed = true;
      txn.events.length = 0;
      this.detachConnectionCallbacks(txn.conn);
      try { await txn.conn.close(); } catch { /* candidate transport already gone */ }
    }
    this._stats.recordPlayStop();
    this.stopTicking();
    // Liveness: quiet destroy — cancel any in-flight restart ladder (it must
    // never emit MEDIA_STARVED for an intentional teardown) and disarm.
    for (const restart of this.livenessRestarts.values()) restart.cancelled = true;
    this.livenessMonitor?.clear();
    this.subgroupStreams.clear();
    this.pendingMediaSubs.clear();
    this.activeFetches.clear();
    this.fetchStreamAliases.clear();
    this.fetchStreamRequestIds.clear();
    this.pendingFetchStreams.clear();
    this.catalogSlots.catalogFillRequests.clear();
    this.refusedFetchRequests.clear();
    this.quarantinedFetchRequests.clear();
    this.droppedFetchStreams.clear();
    this.pendingAliasBinds.clear();
    this.pendingObjectsByAlias.clear();
    this.pendingResetOrdinal = 0;
    this.pendingStreamEvents.clear();
    // Wake pending preparation before dropping its session and source.
    if (this.pendingVideoSwitch) this.discardPendingVideoSwitch(this.pendingVideoSwitch, new Error('Player destroyed'));
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;
    this.switchStagingBuffer = [];
    this.cmafSwitchStagingBuffer = [];
    if (this.switchStagingTimeout !== null) {
      clearTimeout(this.switchStagingTimeout);
      this.switchStagingTimeout = null;
    }
    // Reject any pending TRACK_STATUS queries
    for (const [, pending] of this.pendingTrackStatuses) {
      pending.reject(new Error('Player destroyed'));
    }
    this.pendingTrackStatuses.clear();
    this.cancelCatalogBootstrap();
    this.catalogSlots.catalogRecovery?.coord.abort();
    this.catalogSlots.catalogRecovery = null;
    this.catalogSlots.bootstrapFetch = null;
    this.catalogSlots.bootstrapFetchStreams.clear();
    this.rejectPendingCatalogFetches('Player destroyed');
    for (const [name, pending] of this.pendingInitTrackSubs) {
      pending.reject(new Error(`Player destroyed while awaiting init track "${name}"`));
    }
    this.pendingInitTrackSubs.clear();
    this.announcedNamespaces.clear();
    this.commandDispatcher?.destroy();
    this.commandDispatcher = null;
    this.cmafPendingInit = null;
    this.installedCmafInit.clear();
    this.cmafPreInitDropWarned.clear();
    this.locmafDecoders.clear();
    this.locmafDecoderInit.clear();
    this.locmafHealth.clear();
    this.locmafFrameIds.clear();
    this.locmafDescriptions.clear();
    this.locmafWarned.clear();
    this.locmafBadInit.clear();
    this.cmafInitDeadlineArmed = false;
    this.cmafFirstFrameDeadlineStartedAt = undefined;
    this.cmafFirstFrameHiddenAt = undefined;
    this.cmafFirstFrameDeferredTimeoutMs = undefined;
    this.removeVisibilityListener();
    this.watchdog.destroy();
    this.cmafAssembler?.destroy();
    this.cmafAssembler = null;
    this.mediaSource?.destroy();
    this.mediaSource = null;
    this.mseCompletions = null;
    this.videoPipeline = null;
    this.audioPipeline = null;
    this.syncController = null;
    this.recoveryController = null;
    this.pipelinesCreated = false;
    this.subscriptionManager?.clear();
    this.subscriptionManager = null;
    this.catalogSlots.catalogManager = null;
    this.qualityController = null;
    this.bandwidthEstimator = null;
    if (this.connection) {
      this.releaseMediaTerminals(this.connection);
      if (this._adapterOwned) {
        // Owned adapter: detach our callbacks FIRST so the intentional close's
        // teardown (pending-subscription rejections, stream resets, onClose) is
        // not surfaced back into the player as fatal/degraded connection errors —
        // destroy() is a happy path. Then close (cleans up subscriptions implicitly).
        // close() itself may reject when the underlying transport has already
        // failed or closed — destroy() must still resolve quietly.
        this.detachConnectionCallbacks(this.connection);
        try { await this.connection.close(); } catch { /* transport already failed/closed */ }
      } else {
        // Externally owned: explicitly unsubscribe player's tracks, then detach.
        // Don't close — the caller owns the adapter's lifecycle.
        for (const [requestId] of this.activeSubscriptions) {
          try { await this.connection.unsubscribe(varint(requestId)); } catch { /* ignore */ }
        }
        // Catalog subscription tracked separately
        if (this.catalogSlots.catalogRequestId !== null) {
          try { await this.connection.unsubscribe(varint(this.catalogSlots.catalogRequestId)); } catch { /* ignore */ }
        }
        this.detachConnectionCallbacks(this.connection);
      }
      this.connection = null;
    }
    this.activeSubscriptions.clear();
    if (this.stateMachine.state !== PlayerState.ENDED) {
      this.transitionState(PlayerState.ENDED);
    }
    // Retire every handle this listener saw, including an overlap already
    // detached before it attached. Membership makes retirement idempotent.
    if (this.diagnosticConnectionListeners) {
      for (const known of [...this.diagnosticConnectionListeners.values()]) {
        for (const conn of [...known]) this.notifyConnectionObservation('retired', conn);
      }
      this.diagnosticConnectionListeners.clear();
      this.diagnosticConnectionListeners = undefined;
    }
    this.emitter.removeAllListeners();
  }

  /**
   * Detach all player-installed callbacks from a connection so no further
   * adapter activity is surfaced into this (destroyed/destroying) player.
   * Use delete because exactOptionalPropertyTypes forbids assigning undefined.
   */
  private detachConnectionCallbacks(conn: MoqtConnection): void {
    this.notifyConnectionObservation('retired', conn);
    delete conn.onMessage;
    delete conn.onGoawayNotice;
    delete conn.onObject;
    delete conn.onClose;
    delete conn.onError;
    delete conn.onDataStream;
    delete conn.onStreamClosed;
    delete conn.onDatagram;
    delete conn.onNamespaceMessage;
    delete conn.onQlogEvent;
    delete conn.onSubgroupFin;
    // Deterministic purge — do not rely on the WeakMap being collected.
    this.subgroupWitness.delete(conn);
  }

  // ─── Subscription hook surface ──────────────────────────

  /**
   * Request a subscription, passing through the beforeSubscribe hook.
   *
   * Returns null if the hook cancels the subscription.
   * Used internally by the player and exposed for hook testing.
   *
   * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
   */
  requestSubscribe(
    trackName: string,
    mediaType: 'video' | 'audio',
    namespace: string | readonly string[] = this.config.namespace,
  ): SubscribeIntent | null {
    const intent: SubscribeIntent = { trackName, mediaType, namespace: namespaceFields(namespace) };
    return this.hooks.beforeSubscribe.run(intent);
  }

  // ─── Internal ───────────────────────────────────────────

  /** Whether the player is in a terminal state (no further transitions). */
  private isTerminalState(): boolean {
    const state = this.stateMachine.state;
    return state === PlayerState.ERROR || state === PlayerState.ENDED;
  }

  private transitionState(to: PlayerStateValue): void {
    const from = this.applyState(to);
    this.announceState(from, to);
  }

  /**
   * Apply a state transition WITHOUT announcing it, returning the prior state.
   *
   * Split from the announcement so a caller with more of the transaction to
   * commit (play()/pause(): playback intent, adapter intent, ticking) can finish
   * it BEFORE application listeners run. Throws on an invalid transition, having
   * changed nothing.
   */
  private applyState(to: PlayerStateValue): PlayerStateValue {
    const from = this.stateMachine.state;
    this.stateMachine.transition(to);
    return from;
  }

  /**
   * Announce a completed transition. Listeners run SYNCHRONOUSLY and may
   * re-enter the player (pause/play/destroy) or throw, so this must be the LAST
   * step of any transaction — everything a re-entrant call could contradict, or
   * a throwing listener could strand half-done, is already committed.
   *
   * Announcements are published by a FIFO drain rather than emitted directly.
   * A listener that re-enters the player triggers a nested transition whose
   * event would otherwise be broadcast INSIDE the current one: the listeners
   * that had not yet been called for the outer event would see the nested state
   * first and the outer state second, ending on a state the player has already
   * left. Enqueuing instead means every listener observes the same
   * chronological order, and every listener's last event is the player's
   * current state.
   *
   * A throwing listener may not censor the sequence either: each event goes to
   * EVERY listener (emitIsolated), the drain runs to completion, and the first
   * exception is rethrown afterwards. Otherwise a listener that re-enters the
   * player and then throws would leave the event it just queued stranded until
   * some unrelated future transition, with the listeners after it never having
   * seen the current event at all.
   */
  private announceState(from: PlayerStateValue, to: PlayerStateValue): void {
    this.stateAnnouncements.push({ from, to });
    if (this.announcingState) return; // the in-progress drain will publish it
    this.announcingState = true;
    let error: unknown;
    let failed = false;
    try {
      let next = this.stateAnnouncements.shift();
      while (next !== undefined) {
        try {
          this.emitter.emitIsolated('state_changed',
            { type: 'state_changed', from: next.from, to: next.to });
        } catch (err) {
          // Keep draining: the queue may already hold an event that a
          // re-entrant listener enqueued before it threw.
          if (!failed) { failed = true; error = err; }
        }
        next = this.stateAnnouncements.shift();
      }
    } finally {
      this.announcingState = false;
    }
    if (failed) throw error;
  }

  /**
   * Emit a structured error through the error taxonomy pipeline.
   *
   * 1. Applies config.errorFilter (return null = suppress)
   * 2. Emits structured `error` event
   * 3. Emits legacy `session_error` for backward compatibility
   */
  private emitError(playerError: PlayerError): void {
    // An intentionally destroyed player emits NO error events: teardown noise
    // (close/unsubscribe stragglers landing async during/after destroy()) is not
    // an error. Unintentional failures before destroy() emit normally.
    if (this._destroyed) return;
    const filtered = this.config.errorFilter
      ? this.config.errorFilter(playerError)
      : playerError;
    if (!filtered) return;

    if (filtered.severity === 'fatal') {
      this.log.error('Error [%s/%s] 0x%s: %s', filtered.severity, filtered.source, filtered.code.toString(16), filtered.message);
    } else {
      this.log.warn('Error [%s/%s] 0x%s: %s', filtered.severity, filtered.source, filtered.code.toString(16), filtered.message);
    }

    this.emitter.emit('error', { type: 'error', error: filtered });

    // Backward compat: also fire session_error with an Error wrapping the message
    const legacyError = filtered.cause ?? new Error(filtered.message);
    this.emitter.emit('session_error', { type: 'session_error', error: legacyError });
  }

  /**
   * Classify adapter error severity and map to player error code.
   *
   * Uses `MoqtConnectionError.isFatal` for structured classification (§3.2, §10.4).
   * Falls back to fatal for untyped errors (conservative).
   */
  private classifyMoqtConnectionError(error: Error): { severity: ErrorSeverity; code: PlayerErrorCodeValue; context?: Record<string, unknown> } {
    if (error instanceof MoqtConnectionError) {
      const severity: ErrorSeverity = error.isFatal ? 'fatal' : 'degraded';
      const code = this.connectionErrorSourceToCode(error.errorSource);
      const context: Record<string, unknown> = {};
      if (error.protocolCode !== undefined) context.protocolCode = error.protocolCode;
      if (error.streamId !== undefined) context.streamId = error.streamId;
      return {
        severity,
        code,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      };
    }
    // Untyped error — assume fatal (conservative fallback)
    return { severity: 'fatal', code: PlayerErrorCode.CONTROL_STREAM_LOST };
  }

  /**
   * Map MoqtConnectionError errorSource to PlayerErrorCode.
   *
   * @see draft-ietf-moq-transport-16 §3.2 (control stream)
   * @see draft-ietf-moq-transport-16 §10.3 (datagrams)
   * @see draft-ietf-moq-transport-16 §10.4 (data stream reset)
   */
  private connectionErrorSourceToCode(source: string): PlayerErrorCodeValue {
    switch (source) {
      case 'control': return PlayerErrorCode.CONTROL_STREAM_LOST;
      case 'data': return PlayerErrorCode.DATA_STREAM_RESET;
      case 'datagram': return PlayerErrorCode.DATAGRAM_DECODE_ERROR;
      case 'transport': return PlayerErrorCode.CONNECTION_LOST;
      default: return PlayerErrorCode.CONTROL_STREAM_LOST;
    }
  }

  // wireConnectionCallbacks → extracted to player-wiring.ts

  /**
   * Wire adapter callbacks by constructing handler closures
   * and delegating to wireConnectionCallbacks.
   *
   * @see draft-ietf-moq-transport-16 §3.2 (Control stream)
   * @see draft-ietf-moq-transport-16 §10.2 (Data streams)
   * @see draft-ietf-moq-transport-16 §10.3 (Datagrams)
   * @see draft-ietf-moq-transport-16 §10.4.4 (Fetch streams)
   * @see draft-ietf-moq-transport-16 §6.1 (Namespace discovery)
   */
  private wireConnection(conn: MoqtConnection): void {
    // Diagnostic witness for video group completion. A subgroup carrying
    // END_OF_GROUP completes its group only when the stream FINs, so the
    // terminal disposition is evidence the qlog cannot supply — it defines no
    // stream-terminal event. Kept connection-local so a migration's reused
    // stream IDs cannot collide with the previous connection's entries.
    const subgroupLifecycle = new Map<bigint, {
      groupId: bigint;
      endOfGroup: boolean;
      /**
       * Authoritative for ZERO and EXPLICIT modes from the header; undefined
       * for FIRST_OBJECT until an object supplies it (§10.4.2).
       */
      subgroupId: bigint | undefined;
    }>();
    this.subgroupWitness.set(conn, subgroupLifecycle);

    /**
     * One preformatted record per video subgroup terminal.
     *
     * Video only: LOC audio commonly uses one stream per group, so emitting
     * for every track would approach one line per audio packet and bury the
     * video boundary this exists to show. One record per video subgroup
     * terminal — MOQT does not require one subgroup per group, so this is not
     * a promise of one line per GOP. Emitted at info so an info-level capture
     * retains it, and self-contained so it needs no cross-artifact
     * correlation.
     */
    const emitSubgroupLifecycle = (
      entry: { groupId: bigint; endOfGroup: boolean },
      streamId: bigint,
      subgroupId: bigint | undefined,
      terminal: Record<string, unknown>,
    ): void => {
      // Serializing the record costs a JSON per video subgroup terminal, so
      // skip it entirely when nothing would receive the line.
      if (!this.infoLoggingEnabled) return;
      try {
        this.log.info(`[subgroup_lifecycle:v1] ${JSON.stringify({
          stream_id: streamId.toString(),
          group_id: entry.groupId.toString(),
          // Null rather than wrong: a FIRST_OBJECT subgroup id is unknown until
          // its first object is decoded, which may never happen on a reset.
          ...(subgroupId !== undefined
            ? { subgroup_id: subgroupId.toString() }
            : { subgroup_id: null }),
          contains_end_of_group: entry.endOfGroup,
          ...terminal,
        })}`);
      } catch {
        // A diagnostic must never turn a clean adapter FIN into a synthetic
        // read failure by throwing back through onSubgroupFin.
      }
    };

    // While `conn` is an unpromoted migration candidate, capture its application
    // events instead of dispatching them; they are drained in order after commit
    // ({@link drainStagedCandidate}). No-op for the current session and for the
    // old session during a migration (staging targets only THIS transaction's
    // candidate). The queue is bounded on count and retained bytes — overflow
    // aborts and closes the candidate rather than silently dropping a possibly
    // essential control event.
    // Bind this wiring to the transaction (if any) that owns `conn`. A candidate's
    // callbacks belong to their transaction for LIFE: once it is abandoned they
    // are permanently inert — even a reference captured before detachment must
    // not run live against the old session. `null` for the current session and
    // for the old session during a migration (both run live).
    const owningTxn = this.currentMigration?.conn === conn ? this.currentMigration : null;
    // `cost` receives the raw args array (typed `unknown[]` so it does not drive
    // A-inference — A is fixed by the wrapped callback's contextual signature).
    // `source` is the live-delivery error source used to classify a replay failure.
    const stageable = <A extends unknown[]>(
      fn: (...a: A) => void, source: MoqtConnectionErrorSource,
      cost?: (args: unknown[]) => number,
      /** Whether THIS event is payload to buffer rather than readiness
       *  evidence to act on. Defaults to buffering everything. Typed
       *  `unknown[]` for the same reason as `cost`: it must not drive
       *  A-inference, which is fixed by the wrapped callback's signature. */
      buffer?: (args: unknown[]) => boolean,
    ) => (...args: A): void => {
      if (owningTxn) {
        if (owningTxn.aborted) return; // abandoned candidate — permanently dead
        if (!owningTxn.committed && (buffer === undefined || buffer(args))) {
          // Every staged event carries a base cost (its closure) plus its actual
          // retained bytes, so the byte budget is enforced for ALL event kinds.
          const bytes = MoqtPlayer.STAGED_EVENT_BASE_BYTES + (cost ? cost(args) : 0);
          this.stageMigrationEvent(owningTxn, () => fn(...args), bytes, source);
          return;
        }
        // committed → the candidate is now the current session; run live.
      }
      fn(...args);
    };
    // ── Preparation: evidence dispatches, payload buffers ───────────────
    // A candidate must be EVALUATED before it is adopted, so the things that
    // decide readiness — its catalog retrieval, the acceptance of its
    // subscriptions, the initialization it delivers — have to be acted on
    // while it is still only a candidate. Its MEDIA, by contrast, is payload:
    // buffering it is what keeps a prepared-but-unadopted replacement from
    // emitting objects into playback the old session is still serving, and
    // replaying it once at adoption is what keeps every object delivered
    // exactly once (never processed now and replayed as new later).
    //
    // Classification is by the candidate's OWN bound aliases: a prepared media
    // alias, or a stream already seen carrying one. Anything else on the
    // candidate is evidence and runs against candidate-owned state.
    // Every candidate stream carrying EVIDENCE we have already identified:
    // its catalog retrieval's fetch/fill streams, and subgroup streams on an
    // alias the candidate itself has had bound. Lifecycle events are matched
    // by stream, since a FIN names no alias.
    const evidenceStreams = new Set<bigint>();
    const candidatePrep = (): CandidatePrep | undefined =>
      owningTxn !== null && !owningTxn.committed && !owningTxn.aborted ? owningTxn.prep : undefined;
    /** An alias the candidate has bound for its catalog or an init track. */
    const isCandidateEvidenceAlias = (alias: bigint): boolean => {
      const slots = owningTxn?.slots;
      if (slots !== undefined && slots.catalogTrackAlias === alias) return true;
      const prep = candidatePrep();
      if (prep === undefined) return false;
      for (const init of prep.initTracks.values()) if (init.alias === alias) return true;
      return false;
    };
    // The rule, and it is a rule about OWNERSHIP rather than about aliases: a
    // candidate's object may be acted on only when the candidate itself has
    // told us what that alias is. An alias it has not bound is UNKNOWN on this
    // connection — and must never be looked up in the live routing tables,
    // which hold the other session's registrations and would hand a
    // replacement's catalog, init or media to the pipelines that are still
    // playing the old session. Unknown data is therefore retained under the
    // transaction's existing count and byte bounds, in arrival order, and
    // taken back out when binding finally says what it was (16 §10.4.2,
    // 18 §11.4.2, 22 §3.1.3.1).
    const bufferObject = (args: unknown[]): boolean => {
      const streamId = args[0] as bigint;
      const obj = args[1] as MoqtObject;
      if (evidenceStreams.has(streamId)) return false;
      if (isCandidateEvidenceAlias(BigInt(obj.trackAlias))) {
        evidenceStreams.add(streamId);
        return false;
      }
      if (owningTxn?.slots?.bootstrapFetchStreams.has(streamId) === true
          || owningTxn?.slots?.candidateFetchStreams.has(streamId) === true) {
        evidenceStreams.add(streamId);
        return false;
      }
      // Retained either way — but a required track owing its initialization
      // in band has just supplied it, and readiness has to notice.
      if (owningTxn !== null) this.noteCandidateInbandInit(owningTxn, BigInt(obj.trackAlias), obj);
      return true;
    };
    const bufferStream = (args: unknown[]): boolean => !evidenceStreams.has(args[0] as bigint);
    const bufferDataStream = (args: unknown[]): boolean => {
      const streamId = args[0] as bigint;
      const header = args[1] as DataStreamHeader;
      if (evidenceStreams.has(streamId)) return false;
      if (header.type === 'subgroup' && isCandidateEvidenceAlias(BigInt(header.header.trackAlias))) {
        evidenceStreams.add(streamId);
        return false;
      }
      // A FETCH/FILL header names a request, not a track. On a candidate every
      // such request belongs to its own catalog retrieval — media is not
      // fetched during preparation — so its own bootstrap request is evidence
      // and anything else is not ours to route.
      // A candidate's FETCH/FILL header is always evidence: either it names
      // the bootstrap request, or it arrived before that request registered
      // and the holder parks it until it does.
      if (header.type === 'fetch' && owningTxn?.slots !== undefined) {
        evidenceStreams.add(streamId);
        return false;
      }
      return true;
    };
    const bufferDatagram = (args: unknown[]): boolean => {
      const dg = args[0] as ObjectDatagram;
      return !isCandidateEvidenceAlias(dg.trackAlias === undefined ? 0n : BigInt(dg.trackAlias));
    };
    /** As {@link stageable}, but records WHAT was retained so a later binding
     *  can take it back out as evidence instead of only replaying it. */
    const stageableObject = (
      fn: (streamId: bigint, obj: MoqtObject) => void,
      source: MoqtConnectionErrorSource,
      cost: (args: unknown[]) => number,
      buffer: (args: unknown[]) => boolean,
    ) => (streamId: bigint, obj: MoqtObject): void => {
      if (owningTxn) {
        if (owningTxn.aborted) return;
        if (!owningTxn.committed && buffer([streamId, obj])) {
          this.stageMigrationEvent(owningTxn, () => fn(streamId, obj),
            MoqtPlayer.STAGED_EVENT_BASE_BYTES + cost([streamId, obj]), source,
            { alias: BigInt(obj.trackAlias), streamId, obj });
          return;
        }
      }
      fn(streamId, obj);
    };
    const objBytes = (a: unknown[]): number => {
      const obj = a[1] as MoqtObject;
      return obj.kind === 'data' ? (obj.payload?.byteLength ?? 0) + (obj.extensions?.byteLength ?? 0) : 0;
    };
    const dgBytes = (a: unknown[]): number => {
      const d = a[0] as ObjectDatagram;
      return (d.payload?.byteLength ?? 0) + (d.extensions?.byteLength ?? 0);
    };
    const msgBytes = (a: unknown[]): number => estimateRetainedBytes(a);
    wireConnectionCallbacks(conn, {
      // Never buffered: a candidate's acceptances and refusals ARE its
      // readiness, and buffering them would make the attempt wait for an
      // answer it had already been given.
      onControlMessage: stageable((msg) => this.handleControlMessage(msg, conn), 'control', msgBytes,
        () => false),

      // Staged like any other candidate event: a GOAWAY the candidate
      // receives before promotion must not act on the still-current session,
      // and an abandoned candidate's notice stays permanently inert.
      //
      // The cost charges ONLY the notice. The callback also receives the
      // connection, and charging the whole argument list would walk the
      // adapter's own state — traversing its getters and billing unrelated
      // session state against this event budget. `conn` is already owned here,
      // so it is closed over rather than measured.
      onGoawayNotice: stageable(
        (notice: GoawayNotice) => this.handleGoawayNotice(notice, conn),
        'control', (args) => estimateRetainedBytes([args[0]]),
      ),

      onClose: (error, reason) => {
        this.retireInitWaiters(conn);
        this.log.info('[SESSION] closed: error=0x%s reason=%s',
          error?.toString(16) ?? 'none', reason ?? 'clean');
        // A candidate that closes BEFORE promotion must ABORT its migration — it
        // must never be committed as authoritative.
        if (this.currentMigration?.conn === conn && !this.currentMigration.committed) {
          this.abortMigration(this.currentMigration);
        } else if (this.currentMigration?.conn === conn && this.currentMigration.committed) {
          // The COMMITTED candidate closed while its migration is still draining:
          // terminate the transaction so the drain stops and the migration is not
          // reported successful. Its close still follows the current-session path.
          this.currentMigration.terminated = true;
        }
        // Reclaim any objects still buffered for this (now-dead) session — their
        // alias can never resolve on it, and holding them pins the adapter. This
        // is source-owned cleanup and is safe for any connection.
        this.purgePendingForConnection(conn);
        // Everything below tears down CURRENT-session operations. A SUPERSEDED
        // session closing (e.g. the old relay dropping during/after migration)
        // must not reject the replacement's fetchCatalog promises or report the
        // active session as closed. Only the current connection may do so.
        if (conn !== this.connection) {
          this.log.info('[SESSION] superseded session closed — not affecting the current session');
          return;
        }
        // A replacement is already being prepared for THIS session, so its
        // closure is not a playback failure yet: migration is meant to be
        // transparent to the application (§3.5 / 18 §3.6 / 22 §6.6.1), and a
        // relay that drops right after telling us to move must not abort a
        // healthy candidate. The event is held — announced only if the attempt
        // then fails, where it is the real outcome.
        const preparing = this.currentMigration;
        if (preparing !== null && !preparing.committed && !preparing.aborted) {
          this.log.info('[SESSION] replaced session closed while its replacement prepares — held');
          preparing.oldTerminal = { kind: 'close', ...defined({ error, reason }) };
          // NOT cancelCatalogBootstrap(): that bumps the shared generation,
          // which the preparing candidate's own coordinator captured.
          this.retireCatalogHolder(this.catalogSlots);
          this.rejectPendingCatalogFetches(reason !== undefined
            ? `Session closed: ${reason}` : 'Session closed');
          return;
        }
        this.cancelCatalogBootstrap();
        // Reject in-flight fetchCatalog promises — their stream IDs
        // belong to the closed session, so the FETCH response can't
        // arrive and the timeout would fire against a dead adapter.
        this.rejectPendingCatalogFetches(reason !== undefined
          ? `Session closed: ${reason}`
          : 'Session closed');
        this.emitter.emit('session_closed', defined({
          type: 'session_closed' as const,
          error,
          reason,
        }));
      },

      onError: (error) => {
        const classified = this.classifyMoqtConnectionError(error);
        // The migration candidate (not yet committed): only a FATAL error
        // (control/transport) aborts establishment. A degraded (data/datagram)
        // error — e.g. a subgroup reset — is transient and must not kill the
        // migration, but it IS relevant to the session that is about to become
        // current: STAGE the diagnostic so it is emitted after commit (and
        // discarded if establishment fails). Once committed the candidate is the
        // current session, so its errors fall through to the normal path below.
        const migTxn = this.currentMigration;
        if (migTxn?.conn === conn && !migTxn.committed) {
          if (classified.severity === 'fatal') {
            this.abortMigration(migTxn);
          } else {
            const deferred = createPlayerError(
              classified.severity, 'connection', classified.code, error.message,
              defined({ cause: error, context: classified.context }),
            );
            // Charge the diagnostic's real retained bytes (message/stack/cause/
            // context are mostly non-enumerable, so the generic estimator misses
            // them). Its replay source is the error's own source.
            const bytes = MoqtPlayer.STAGED_EVENT_BASE_BYTES + errorRetainedBytes(error, classified.context);
            const errSource: MoqtConnectionErrorSource = error instanceof MoqtConnectionError ? error.errorSource : 'control';
            this.stageMigrationEvent(migTxn, () => this.emitError(deferred), bytes, errSource);
          }
          return;
        }
        // The COMMITTED candidate fatally errors while its migration still drains:
        // terminate the transaction (stop the drain, do not report success).
        if (migTxn?.conn === conn && migTxn.committed && classified.severity === 'fatal') {
          migTxn.terminated = true;
        }
        // An error on a SUPERSEDED session is not a current-connection failure —
        // reporting it would surface the old relay's teardown as an active fault.
        if (conn !== this.connection) {
          this.log.info('[SESSION] error on a superseded session — ignored: %s', error.message);
          return;
        }
        // As in onClose: a fatal fault on the session we are already replacing
        // is held while its replacement is still being prepared, so a dying
        // old relay cannot fail playback that is about to be handed over.
        const preparingErr = this.currentMigration;
        if (classified.severity === 'fatal' && preparingErr !== null
            && !preparingErr.committed && !preparingErr.aborted) {
          this.log.info('[SESSION] replaced session errored while its replacement prepares — held: %s',
            error.message);
          preparingErr.oldTerminal = {
            kind: 'error', error, severity: classified.severity, code: classified.code,
            ...defined({ context: classified.context }),
          };
          this.retireCatalogHolder(this.catalogSlots);
          return;
        }
        if (classified.severity === 'fatal') this.cancelCatalogBootstrap();
        this.emitError(createPlayerError(
          classified.severity, 'connection', classified.code, error.message,
          defined({ cause: error, context: classified.context }),
        ));
      },

      onObject: stageableObject((streamId, obj) => {
        // The catalog retrieval that owns evidence on THIS connection, or null
        // when none does. Media evidence below is not catalog-owned, so this is
        // a value to test, never an early return.
        const slots = this.slotsFor(conn);
        if (this._destroyed || this.isTerminalState()) return;
        // A warm retrieval keeps its source/owner association across adoption.
        // Its wire alias 0 must never be interpreted through a successor map.
        const warmFetch = this.warmMediaFetchForStream(conn, streamId);
        if (warmFetch) {
          if (warmFetch.retired || warmFetch.streams.get(streamId)) return;
          if (warmFetch.trackAlias !== null) {
            this.routeFetchObject(streamId, warmFetch.trackAlias, obj, conn.draftVersion, conn, warmFetch);
            return;
          }
          if (conn !== this.connection) return;
        }
        // §10.4.2 FIRST_OBJECT: the subgroup id is the first object's id, known
        // only here. Record it so a later reset still reports a real value.
        const pendingSubgroup = subgroupLifecycle.get(streamId);
        if (pendingSubgroup !== undefined && pendingSubgroup.subgroupId === undefined) {
          pendingSubgroup.subgroupId = obj.subgroupId;
        }
        // Catalog-fetch dispatch: route by streamId → reqId. Catalog
        // FETCH objects don't carry a meaningful media alias, so we
        // resolve the pending fetchCatalog promise directly here
        // before the media-fetch routing below.
        // The legacy fetch registries (catalogFetchStreams, fetchStreamAliases,
        // droppedFetchStreams, pendingFetchStreams) are keyed by bare stream
        // ID and repopulated per session — they are AUTHORITATIVE only for the
        // current connection. A delayed old-session stream after migration
        // must not be read through a reused new-session ID; it falls through
        // to the connection-tagged pending buffer instead.
        const fetchMapsAuthoritative = conn === this.connection;

        // A stale session's fetch stream (tagged in onDataStream): its objects
        // carry wire alias 0 and must never enter a current route.
        if (this.staleFetchStreams.get(streamId) === conn) return;

        // A candidate's parked fetch stream: accumulate under its own holder
        // until the request it answers is registered.
        if (slots !== null && slots !== this.catalogSlots) {
          const parkedCandidate = slots.candidateFetchStreams.get(streamId);
          if (parkedCandidate !== undefined) {
            const bytes = obj.kind === 'data' ? obj.payload.byteLength : 0;
            if (parkedCandidate.objects.length >= MoqtPlayer.MAX_PENDING_PER_ALIAS
                || parkedCandidate.bytes + bytes > MoqtPlayer.MAX_PENDING_FETCH_BYTES) {
              slots.candidateFetchStreams.delete(streamId);
              this.failCandidateCatalog(conn, 'replacement catalog fetch exceeded its buffer limit');
              return;
            }
            parkedCandidate.objects.push(obj);
            parkedCandidate.bytes += bytes;
            return;
          }
        }

        // A PREPARING candidate's initialization track. Initialization is
        // readiness evidence, so it is routed here — before any live media
        // or catalog routing can see an alias that collides with one of
        // theirs — and held on the transaction instead of in the live init
        // cache, which a candidate that is never adopted must not populate.
        if (slots !== null && slots !== this.catalogSlots && obj.kind === 'data') {
          const prepTxn = this.candidateTxnFor(slots);
          if (prepTxn !== null
              && this.onCandidateInitBytes(prepTxn, BigInt(obj.trackAlias), obj.payload)) {
            return;
          }
        }

        const catalogReqId = fetchMapsAuthoritative ? this.catalogFetchStreams.get(streamId) : undefined;
        if (catalogReqId !== undefined) {
          this.handleCatalogFetchObject(catalogReqId, obj);
          return;
        }

        // Staged-recovery candidate fetch stream.
        const recoveryForFetch = slots?.catalogRecovery;
        if (recoveryForFetch && recoveryForFetch.conn === conn) {
          const rAttempt = recoveryForFetch.fetchStreams.get(streamId);
          if (rAttempt !== undefined) {
            if (!this.emitCatalogRaw(obj)) return;
            recoveryForFetch.coord.onFetchObject(rAttempt, this.toCatalogEvent(obj));
            return;
          }
        }

        // Catalog-bootstrap fetch stream: attempt-tagged, coordinator-owned,
        // and CONNECTION-scoped (stream IDs collide across sessions).
        const bootstrapEntry = slots?.bootstrapFetchStreams.get(streamId);
        if (bootstrapEntry !== undefined && bootstrapEntry.conn === conn) {
          if (!this.emitCatalogRaw(obj)) return;
          slots?.catalogBootstrapCoord?.onFetchObject(bootstrapEntry.attempt, this.toCatalogEvent(obj));
          return;
        }

        // §10.4.4: Fetch stream objects carry trackAlias=0 — remap to correct alias
        const fetchAlias = fetchMapsAuthoritative ? this.fetchStreamAliases.get(streamId) : undefined;
        if (fetchAlias !== undefined) {
          const fetchRequest = this.fetchStreamRequestIds.get(streamId);
          const info = fetchRequest === undefined ? undefined : this.activeFetches.get(fetchRequest);
          this.routeFetchObject(streamId, fetchAlias, obj, conn.draftVersion, conn, info);
          return;
        }

        // An OVERFLOWED fetch stream: still classified as fetch — swallow its
        // objects rather than letting wire alias 0 fall through to a real
        // alias-0 subscription.
        if (fetchMapsAuthoritative && this.droppedFetchStreams.has(streamId)) return;

        // A fetch stream whose request isn't registered yet (§9.16.3: data
        // may beat the fetch()/joiningFetch() continuation): buffer per
        // stream and replay on registration. Never route as wire alias 0.
        const pendingFetch = fetchMapsAuthoritative ? this.pendingFetchStreams.get(streamId) : undefined;
        if (pendingFetch) {
          const bytes = obj.kind === 'data' ? obj.payload.byteLength + (obj.extensions?.byteLength ?? 0) : 0;
          if (pendingFetch.objects.length < MoqtPlayer.MAX_PENDING_PER_ALIAS
              && pendingFetch.bytes + bytes <= MoqtPlayer.MAX_PENDING_FETCH_BYTES) {
            pendingFetch.objects.push(obj);
            pendingFetch.bytes += bytes;
          } else {
            this.quarantineFetchRequest(pendingFetch.requestId);
            this.log.warn('Pending FETCH %s exceeded its buffer limit; continuing live-only', pendingFetch.requestId);
          }
          return;
        }

        const alias = BigInt(obj.trackAlias);

        // A quarantined session's CATALOG alias is classified FIRST: even if
        // the replacement session reuses that alias for a MEDIA track, the old
        // session's late catalog bytes must never enter the media pipeline.
        if (this.quarantinedCatalogAliases.get(conn) === alias) return;

        // A PREPARING candidate's CATALOG alias is classified before the media
        // lookup below. Track aliases are per-session, so a replacement is free
        // to use for its catalog the very alias the live session uses for
        // video, and the subscription manager — which holds only the live
        // session's registrations and carries no connection authority — would
        // then route the replacement's catalog bytes straight into the running
        // video pipeline. Ownership decides first; the alias is only a key.
        if (slots !== null && slots !== this.catalogSlots && alias === slots.catalogTrackAlias
            && this.candidateTxnFor(slots) !== null) {
          this.dispatchCatalogObject(obj, streamId, conn, slots);
          return;
        }

        // Source identity for a route that is still shared between the
        // adopted session and the one being retired. The manager is keyed by
        // alias alone, so without this an alias means different things to the
        // two sessions and either one could deliver through the other's track.
        if (!this.mediaRouteBelongsTo(conn, alias)) return;

        // Route media objects first — SubscriptionManager is authoritative.
        // For track switches: data may arrive before SUBSCRIBE_OK (§10.4.2).
        // Unknown aliases get buffered in pendingObjectsByAlias, then replayed
        // when SUBSCRIBE_OK resolves the alias via onAliasResolved → replayPendingObjects.
        // At replay time, the new track is registered and onObject fires normally.
        if (this.subscriptionManager?.getMediaType(alias) !== undefined) {
          this.watchdog.fulfill('first_media_object');
          // Bind the LOC wire profile AND the malformed-recovery target to THIS
          // connection — a cross-draft migration must not decode a late
          // old-session object with the new profile, nor UNSUBSCRIBE on the new
          // session for an old-session object.
          void this.routeMediaObject(streamId, obj, conn.draftVersion, conn);
          return;
        }

        // Route catalog by track alias (set after SUBSCRIBE_OK §9.10).
        // Never guess the catalog alias — wait for SUBSCRIBE_OK to confirm it.
        // Data may arrive before SUBSCRIBE_OK (§10.4.2); unknown aliases are
        // buffered below and replayed when the alias is resolved.
        // Staged-recovery candidate: its alias routes into the CANDIDATE
        // coordinator only — the active catalog machinery never sees it.
        const recoveryForLive = slots?.catalogRecovery;
        if (recoveryForLive && recoveryForLive.conn === conn
            && recoveryForLive.alias !== null && alias === recoveryForLive.alias) {
          if (!this.emitCatalogRaw(obj)) return;
          slots?.catalogLiveStreams.set(streamId, { conn, coord: recoveryForLive.coord });
          recoveryForLive.coord.onLiveStreamEvent(streamId, 'header');
          recoveryForLive.coord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
          return;
        }

        // During staged recovery, the RETIRED catalog alias may be reused by
        // the candidate: its traffic parks in the transaction-local
        // fail-closed buffer (bounded objects/bytes/lifecycle; overflow aborts
        // the candidate) until the candidate SUBSCRIBE_OK binds or refutes it.
        const recoveryPark = slots?.catalogRecovery;
        if (recoveryPark && recoveryPark.conn === conn
            && recoveryPark.retiredAlias !== null && alias === recoveryPark.retiredAlias
            && recoveryPark.alias === null) {
          recoveryPark.parked.push({ streamId, obj });
          recoveryPark.parkedBytes += obj.kind === 'data' ? obj.payload.byteLength : 0;
          if (!this.catalogParkingWithinBounds(conn)) {
            this.onCatalogParkingOverflow(conn);
          }
          return;
        }

        if (slots !== null && slots.catalogTrackAlias !== null && alias === slots.catalogTrackAlias) {
          this.dispatchCatalogObject(obj, streamId, conn, slots);
          return;
        }

        // Unknown-alias data is OWNABLE only while a subscribe is awaiting its
        // SUBSCRIBE_OK on this session — pre-OK pre-roll belongs to an
        // unanswered request. With none outstanding, nothing can ever bind
        // this alias to the data legitimately (e.g. a drained catalog
        // subscription's stragglers): drop instead of parking bytes that a
        // FUTURE unrelated request would inherit.
        if (conn === this.connection && this.pendingAliasBinds.size === 0) return;

        // Buffer unrouted objects — data may arrive before SUBSCRIBE_OK
        // resolves the alias. Tag each with its SOURCE session (this connection)
        // so replay uses the delivering session's draft and only replays for an
        // alias resolved on that same session — never routing an old-session
        // object into a reused-alias track on the new one.
        const existingBucket = this.pendingObjectsByAlias.get(alias);
        // Cap the number of distinct unresolved aliases — a peer must not be able
        // to pin unbounded memory (and connection references) by emitting one
        // object per unique unknown alias.
        if (existingBucket === undefined && this.pendingObjectsByAlias.size >= MoqtPlayer.MAX_PENDING_ALIASES) {
          // GENERIC drop policy — but if the dropped entry would belong to
          // the active catalog transaction, that transaction fails closed (an
          // incomplete delta chain must never be blessed as converged state).
          if (this.wouldBeCatalogTransactionOwned(conn)) this.onCatalogParkingOverflow(conn);
          return; // drop — too many distinct unresolved aliases already buffered
        }
        const pending = existingBucket ?? [];
        if (pending.length < MoqtPlayer.MAX_PENDING_PER_ALIAS) {
          // During staged recovery, an unknown alias could be the CANDIDATE's
          // (pre-SUBSCRIBE_OK): flag the entry so a failed candidate purges it,
          // and account bytes fail-closed under the recovery bound.
          // Ownership snapshot: only a request that was ALREADY awaiting its
          // SUBSCRIBE_OK could own this pre-roll. When each of these resolves
          // to a different alias (or errors), the entry loses that owner —
          // and an ownerless entry is dropped, never inherited by a later
          // unrelated request that happens to receive this alias. Recovery
          // budgeting derives from the same ownership (no separate tag).
          const owners = conn === this.connection ? [...this.pendingAliasBinds] : undefined;
          let resetBefore: number | undefined;
          for (const entry of pending) {
            if (entry.sourceConnection !== conn || entry.obj.groupId !== obj.groupId || entry.locmafResetOrdinal === undefined) continue;
            resetBefore = Math.max(resetBefore ?? -1, entry.locmafResetOrdinal);
          }
          pending.push({ streamId, obj, sourceDraft: conn.draftVersion, sourceConnection: conn,
            ...(resetBefore !== undefined ? { locmafResetBeforeOrdinal: resetBefore, locmafResetOrdinal: resetBefore } : {}),
            ...(owners ? { owners } : {}) });
          this.pendingObjectsByAlias.set(alias, pending);
          if (!this.catalogParkingWithinBounds(conn)) {
            this.onCatalogParkingOverflow(conn);
            return;
          }
          // Silently buffer — will be replayed when SUBSCRIBE_OK resolves the alias
        } else if (this.wouldBeCatalogTransactionOwned(conn)) {
          // The per-alias cap dropped a TRANSACTION-owned entry: fail closed.
          // Unrelated media overflow follows the generic drop policy only.
          this.onCatalogParkingOverflow(conn);
        }
      }, 'data', objBytes, bufferObject),

      // §10.4: Stream reset vs FIN
      onStreamClosed: stageable((streamId, error, terminal) => {
        const slots = this.slotsFor(conn);
        const warmFetch = this.warmMediaFetchForStream(conn, streamId);
        if (warmFetch && !warmFetch.streams.get(streamId)) {
          warmFetch.streams.set(streamId, true);
          const pending = conn === this.connection ? this.pendingFetchStreams.get(streamId) : undefined;
          // FIN follows raw pre-alias admission, never async processing.
          if (terminal !== 'fin' || !pending) {
            this.finishWarmMediaPrefix(warmFetch, terminal === 'fin' ? 'fin' : terminal === 'reset' ? 'reset' : 'error');
          }
        }
        // A candidate's parked fetch stream ended before its request was
        // registered: remember HOW, since only a peer FIN completes a fetch.
        if (slots !== null && slots !== this.catalogSlots) {
          const parkedCandidate = slots.candidateFetchStreams.get(streamId);
          if (parkedCandidate !== undefined) {
            parkedCandidate.terminal = terminal;
            return;
          }
        }
        // If a pending catalog-fetch's stream closed without delivering
        // an object, reject — otherwise the promise hangs until timeout.
        // (If onObject already settled, the reqId is gone from
        // catalogFetchStreams — this is a no-op.)
        const recoveryClose = slots?.catalogRecovery;
        if (recoveryClose && recoveryClose.conn === conn) {
          const rAttempt = recoveryClose.fetchStreams.get(streamId);
          if (rAttempt !== undefined) {
            recoveryClose.fetchStreams.delete(streamId);
            recoveryClose.coord.onFetchStreamClosed(rAttempt, terminal === 'fin');
          }
          // Lifecycle evidence for PARKED retired-alias streams (fail-closed
          // bound: overflow aborts the candidate rather than dropping).
          if (recoveryClose.parked.some((e) => e.streamId === streamId)) {
            recoveryClose.parkedEvents.set(streamId, terminal);
            if (!this.catalogParkingWithinBounds(conn)) {
              this.onCatalogParkingOverflow(conn);
            }
          }
        }
        const bootstrapEntry2 = slots?.bootstrapFetchStreams.get(streamId);
        if (bootstrapEntry2 !== undefined && bootstrapEntry2.conn === conn) {
          slots?.bootstrapFetchStreams.delete(streamId);
          slots?.catalogBootstrapCoord?.onFetchStreamClosed(bootstrapEntry2.attempt, terminal === 'fin');
        }
        // Live catalog stream lifecycle → retained-chain clean-FIN tracking,
        // dispatched to the OWNING coordinator (main or candidate).
        const liveEntry = slots?.catalogLiveStreams.get(streamId);
        if (liveEntry !== undefined && liveEntry.conn === conn) {
          slots?.catalogLiveStreams.delete(streamId);
          liveEntry.coord.onLiveStreamEvent(streamId, terminal);
        }
        // The legacy fetch registries below are keyed by BARE stream ID and are
        // authoritative only for the current connection (see onObject) — a
        // delayed old-session close must not settle or delete current-session
        // state through a reused stream ID.
        const closeMapsAuthoritative = conn === this.connection;
        const catalogReqId = closeMapsAuthoritative ? this.catalogFetchStreams.get(streamId) : undefined;
        if (catalogReqId !== undefined) {
          this.settleCatalogFetch(catalogReqId, {
            ok: false,
            error: new Error(terminal === 'reset'
              ? `fetchCatalog: stream reset (code 0x${error!.toString(16)})`
              : 'fetchCatalog: stream closed without object'),
          });
        }
        if (this.staleFetchStreams.get(streamId) === conn) this.staleFetchStreams.delete(streamId);
        if (terminal === 'reset') {
          // Carry negative evidence on every retained object of the affected group.
          // Ownership filtering may remove all records of the reset stream; frozen
          // before-arrival snapshots preserve earlier boundaries across later resets.
          let resetOrdinal: number | undefined;
          const known = conn === this.connection ? this.subgroupStreams.get(streamId) : undefined;
          for (const [alias, bucket] of this.pendingObjectsByAlias) {
            const groups = new Set<bigint>();
            if (known?.trackAlias === alias) groups.add(known.groupId);
            for (const entry of bucket) {
              if (entry.streamId !== streamId || entry.sourceConnection !== conn) continue;
              groups.add(BigInt(entry.obj.groupId));
            }
            for (const entry of bucket) {
              if (entry.sourceConnection !== conn || !groups.has(BigInt(entry.obj.groupId))) continue;
              resetOrdinal ??= this.pendingResetOrdinal++;
              entry.locmafResetOrdinal = resetOrdinal;
            }
          }
        }
        // §10.4.3: RESET_STREAM is normal (UNSUBSCRIBE, timeout, track switch).
        // Log at debug level — not an application error. But a reset on a
        // DELIVERING track's subgroup stream is a liveness hint: shorten that
        // track's fuse so a dead delivery path (Safari WT stream death) is
        // detected in resetProbeMs instead of the full liveness timeout.
        // A healthy track re-stamps via its successor stream — benign resets
        // (group end, switch, unsubscribe) stay free.
        // Record the close for a stream whose objects are still parked
        // pre-alias, so the coordinator's clean-FIN evidence survives the
        // alias-resolution replay (bounded; eviction is fail-closed — it only
        // removes POSITIVE evidence).
        if (slots?.catalogBootstrapCoord || slots?.catalogRecovery) {
          // Close-to-object correlation matches BOTH stream id and the
          // delivering connection — a colliding stream id on another session
          // must not fabricate lifecycle evidence here.
          let hasParked = false;
          for (const bucket of this.pendingObjectsByAlias.values()) {
            if (bucket.some((e) => e.streamId === streamId && e.sourceConnection === conn)) { hasParked = true; break; }
          }
          if (hasParked) {
            const catalogOwned = this.streamOwnedByCatalogTransaction(conn, streamId);
            // The catalog TRANSACTION's lifecycle limit is one count across
            // BOTH stores (retired-alias parkedEvents + transaction-owned
            // generic records) — and it covers the MAIN bootstrap's pre-OK
            // evidence exactly like a candidate's: overflow is explicit
            // (fail-closed ladder / candidate abort), never silent eviction
            // of catalog evidence. Unrelated media records never charge it.
            if (catalogOwned
                && this.catalogOwnedStreamEventCount(conn) >= MoqtPlayer.MAX_RECOVERY_PARKED_EVENTS) {
              this.onCatalogParkingOverflow(conn);
              return;
            }
            if (this.pendingStreamEventCount() >= MoqtPlayer.MAX_PENDING_STREAM_EVENTS) {
              // Global pressure: evict UNRELATED evidence first (dropping
              // positive evidence is itself fail-closed for the chain
              // rules); candidate evidence is never evicted for it.
              if (!this.evictOldestUnownedStreamEvent()) {
                // Everything retained is transaction-owned; an unrelated
                // newcomer is dropped rather than displacing it.
                if (!catalogOwned) return;
              }
            }
            const perConn = this.pendingStreamEvents.get(conn)
              ?? new Map<bigint, { error: number | undefined; terminal: DataStreamTerminal }>();
            perConn.set(streamId, { error, terminal });
            this.pendingStreamEvents.set(conn, perConn);
          }
        }

        const subgroup = closeMapsAuthoritative ? this.subgroupStreams.get(streamId) : undefined;
        if (subgroup !== undefined) {
          this.subgroupStreams.delete(streamId); // map never outlives the stream
          if (terminal === 'reset') {
            this.livenessMonitor?.noteStreamReset(subgroup.trackAlias, performance.now());
            this.subscriptionManager?.invalidateLocmafGroup(subgroup.trackAlias, subgroup.groupId, conn);
            for (const subscription of this.activeSubscriptions.values()) {
              if (subscription.trackAlias === subgroup.trackAlias) {
                this.locmafDecoders.get(this.mediaKey(subscription.trackName, subscription.mediaType, subgroup.trackAlias))?.resetGroup(subgroup.groupId);
              }
            }
          }
        }
        // §9.16.3: a fetch's single data stream ending (however it ended) ends
        // the fetch — drop its routing maps and active-fetch bookkeeping. An
        // UNREGISTERED stream keeps its buffered objects and RECORDS ITS
        // TERMINAL: registration replays the pre-roll, and only a peer FIN
        // there counts as completion.
        if (closeMapsAuthoritative) {
          const pendingFetch = this.pendingFetchStreams.get(streamId);
          if (pendingFetch) pendingFetch.terminal = terminal;
          this.droppedFetchStreams.delete(streamId); // tombstone ends with the stream
          const fetchReqId = this.fetchStreamRequestIds.get(streamId);
          if (fetchReqId !== undefined) {
            this.fetchStreamRequestIds.delete(streamId);
            this.fetchStreamAliases.delete(streamId);
            this.activeFetches.delete(fetchReqId);
          }
        }
        if (terminal === 'reset') {
          this.log.debug('Data stream %s reset with code 0x%s', streamId, error!.toString(16));
        }
        // Consume the entry on every terminal so the map cannot grow. RESET is
        // claimed from the adapter's classification, never from a present code —
        // and FIN only from `onSubgroupFin`, which alone carries the resolved
        // header this record needs.
        const lifecycle = subgroupLifecycle.get(streamId);
        if (lifecycle !== undefined) {
          subgroupLifecycle.delete(streamId);
          if (terminal === 'reset') {
            emitSubgroupLifecycle(lifecycle, streamId, lifecycle.subgroupId, {
              terminal: 'reset',
              reset_code: `0x${error!.toString(16)}`,
            });
          }
        }
      }, 'data', undefined, bufferStream),

      // §10.4.4: Fetch data stream headers for object routing
      onSubgroupFin: stageable((streamId: bigint, header: SubgroupHeader) => {
        const lifecycle = subgroupLifecycle.get(streamId);
        if (lifecycle === undefined) return;
        subgroupLifecycle.delete(streamId);
        // The header handed back here has its FIRST_OBJECT subgroup id
        // resolved; the one captured at open may still be a placeholder.
        emitSubgroupLifecycle(lifecycle, streamId, header.subgroupId, { terminal: 'fin' });
      }, 'data', undefined, bufferStream),

      onDataStream: stageable((streamId, header) => {
        const slots = this.slotsFor(conn);
        // Liveness: remember which track each SUBGROUP stream belongs to so
        // a reset can shorten that track's liveness fuse. Subgroup streams
        // only — fetch streams have their own request lifecycle and must
        // never touch track liveness (datagrams have no stream at all).
        if (header.type === 'subgroup') {
          // Liveness bookkeeping is a CURRENT-session concern; a superseded
          // session's header must not overwrite a colliding current stream id.
          if (conn !== this.connection) return;
          const sub = header.header;
          this.subgroupStreams.set(streamId, { trackAlias: BigInt(sub.trackAlias), groupId: BigInt(sub.groupId) });
          const alias = BigInt(sub.trackAlias);
          // Only FIRST_OBJECT defers its subgroup id; ZERO and EXPLICIT are
          // authoritative from the header, so reporting them as unknown would
          // discard a fact we already have.
          const mode = getSubgroupIdMode(sub.typeByte);
          // Track a stream only when its alias is a CONFIRMED video track.
          //
          // Classification is made once and never revised: a stream opened
          // against an unconfirmed alias is simply never reported, which also
          // means no state is retained for it.
          const confirmed = this.subscriptionManager?.getMediaType(alias);
          if (confirmed !== 'video') return;
          subgroupLifecycle.set(streamId, {
            groupId: sub.groupId,
            endOfGroup: sub.isEndOfGroup,
            subgroupId: mode === SubgroupIdMode.FIRST_OBJECT ? undefined : sub.subgroupId,
          });
          return;
        }
        if (header.type === 'fetch') {
          const fetchReqId = BigInt(header.header.requestId);
          for (const owner of this.warmMediaOwners.values()) {
            const info = owner.prefixFetch;
            if (info?.connection === conn && info.requestId === fetchReqId) {
              this.bindWarmMediaFetch(info, streamId);
              if (info.retired) {
                if (conn === this.connection && this.quarantinedFetchRequests.has(fetchReqId)) this.droppedFetchStreams.add(streamId);
                else this.staleFetchStreams.set(streamId, conn);
                return;
              }
              break;
            }
          }
          // Catalog ownership is classified BEFORE the stale-session tag. A
          // PREPARING candidate is not stale — it is not current yet — and the
          // joining FETCH (or draft-22 fill) carrying its catalog IS the
          // evidence the handover is waiting for. Tagging it stale first would
          // discard the candidate's own catalog and hang its retrieval.
          if (slots !== null && slots !== this.catalogSlots && this.candidateTxnFor(slots) !== null) {
            const candidateFetch = slots.bootstrapFetch;
            if (candidateFetch !== null && candidateFetch.reqId === fetchReqId
                && candidateFetch.conn === conn && candidateFetch.gen === this.bootstrapGeneration) {
              slots.bootstrapFetchStreams.set(streamId, { attempt: candidateFetch.attempt, conn });
              return;
            }
            // The request this stream answers is registered a microtask after
            // the coordinator issues it, so the stream can legitimately
            // arrive first. Park it under the candidate's OWN holder — the
            // shared map is authoritative for the current connection only —
            // and let registration claim it.
            if (slots.candidateFetchStreams.size < MoqtPlayer.MAX_PENDING_FETCH_STREAMS) {
              slots.candidateFetchStreams.set(streamId, { requestId: fetchReqId, objects: [], bytes: 0 });
              return;
            }
            // Beyond the bound it is not evidence we can hold: tombstone it
            // rather than grow without limit.
            this.staleFetchStreams.set(streamId, conn);
            return;
          }
          // See onObject: the fetch registries are current-connection only. A
          // STALE session's fetch stream is tagged so its objects (which carry
          // wire alias 0) are discarded instead of falling through to a real
          // alias-0 route on the current session.
          if (conn !== this.connection) {
            this.staleFetchStreams.set(streamId, conn);
            return;
          }
          const reqId = fetchReqId;
          // Catalog-fetch dispatch: map streamId → reqId so the
          // matching object reaches the pending fetchCatalog promise.
          // Kept separate from fetchStreamAliases because catalog
          // doesn't have (and shouldn't synthesize) a media alias.
          if (this.pendingCatalogFetches.has(reqId)) {
            this.catalogFetchStreams.set(streamId, reqId);
            return;
          }
          // Staged-recovery candidate fetch.
          const recovery = slots?.catalogRecovery;
          if (recovery && recovery.conn === conn
              && recovery.fetch && recovery.fetch.reqId === reqId) {
            recovery.fetchStreams.set(streamId, recovery.fetch.attempt);
            return;
          }

          // Catalog-bootstrap fetch: connection-scoped ownership, attempt-tagged.
          const bootstrap = slots?.bootstrapFetch;
          if (bootstrap && bootstrap.reqId === reqId
              && bootstrap.conn === conn && bootstrap.gen === this.bootstrapGeneration) {
            slots?.bootstrapFetchStreams.set(streamId, { attempt: bootstrap.attempt, conn });
            return;
          }
          // A cancelled, refused, or discarded request's late streams are
          // tombstoned, never parked as
          // unowned pending streams awaiting an owner that will never come.
          if (this.quarantinedFetchRequests.has(reqId)) {
            this.droppedFetchStreams.add(streamId);
            return;
          }
          const fetchInfo = this.activeFetches.get(reqId);
          if (fetchInfo?.trackAlias != null) {
            this.fetchStreamAliases.set(streamId, fetchInfo.trackAlias);
            this.fetchStreamRequestIds.set(streamId, reqId);
          } else {
            // Data can beat request registration or its subscription's alias
            // binding. Keep it FETCH-owned until both are known.
            // BOUNDED: a peer cycling unknown fetch streams must not grow
            // this for the session lifetime — evict the oldest entry.
            if (this.pendingFetchStreams.size >= MoqtPlayer.MAX_PENDING_FETCH_STREAMS) {
              const oldest = this.pendingFetchStreams.values().next().value;
              if (oldest !== undefined) {
                this.quarantineFetchRequest(oldest.requestId);
              }
            }
            this.pendingFetchStreams.set(streamId, { requestId: reqId, sourceDraft: conn.draftVersion, sourceConnection: conn, objects: [], bytes: 0 });
          }
        }
      }, 'data', undefined, bufferDataStream),

      // §6.1: Namespace discovery messages (bidi-stream NAMESPACE / NAMESPACE_DONE)
      // §6.2: Control-stream PUBLISH_NAMESPACE / PUBLISH_NAMESPACE_DONE
      onNamespaceMessage: stageable((requestId, msg) => {
        switch (msg.type) {
          case 'NAMESPACE':
            this.emitter.emit('namespace_discovered', {
              type: 'namespace_discovered',
              requestId,
              namespaceSuffix: msg.trackNamespaceSuffix,
            });
            break;
          case 'NAMESPACE_DONE':
            this.emitter.emit('namespace_done', {
              type: 'namespace_done',
              requestId,
              namespaceSuffix: msg.trackNamespaceSuffix,
            });
            break;
          case 'PUBLISH_NAMESPACE': {
            const ns = msg.trackNamespace;
            this.announcedNamespaces.set(requestId, ns);
            this.emitter.emit('namespace_announced', {
              type: 'namespace_announced',
              requestId,
              trackNamespace: ns,
            });
            break;
          }
          case 'PUBLISH_NAMESPACE_DONE': {
            this.announcedNamespaces.delete(requestId);
            this.emitter.emit('namespace_announcement_done', {
              type: 'namespace_announcement_done',
              requestId,
              ...(msg.trackNamespace ? { trackNamespace: msg.trackNamespace } : {}),
            });
            break;
          }
        }
      }, 'control', msgBytes),

      // §10.3: Datagram objects — convert to MoqtObject for routing
      onDatagram: stageable((datagram) => {
        const alias = BigInt(datagram.trackAlias);
        if (this.subscriptionManager?.getMediaType(alias) === undefined) return;
        this.log.debug('Datagram alias=%s group=%s obj=%s', alias, datagram.groupId, datagram.objectId);

        const obj: MoqtObject = datagram.status !== undefined
          ? {
              kind: 'gap',
              trackAlias: datagram.trackAlias,
              groupId: datagram.groupId,
              subgroupId: varint(0n),
              objectId: datagram.objectId,
              status: datagram.status,
            }
          : {
              kind: 'data',
              trackAlias: datagram.trackAlias,
              groupId: datagram.groupId,
              subgroupId: varint(0n),
              objectId: datagram.objectId,
              publisherPriority: datagram.publisherPriority,
              extensions: datagram.extensions,
              payload: datagram.payload,
            };

        void this.routeMediaObject(0n, obj, conn.draftVersion, conn, datagram);
      }, 'datagram', dgBytes, bufferDatagram),

      // §draft-pardue-moq-qlog-moq-events-06: qlog tracing
      ...(this.config.onQlogEvent ? { onQlogEvent: this.config.onQlogEvent } : {}),
    });
    this.notifyConnectionObservation('available', conn);
  }

  // handleControlMessage → extracted to player-message.ts

  /**
   * An accepted GOAWAY, already validated by the session and carrying the scope
   * the wire cannot express.
   *
   * A control-stream GOAWAY drains the whole session; one on a single request
   * stream migrates only that request and "leaves the rest of the session in
   * place" (draft-22 §6.6.1, draft-18 §10.4). Routing both through one unscoped
   * path cancelled unrelated subscriptions, so the scopes are handled apart.
   *
   * Session scope establishes a replacement session when connection factories
   * are configured — our own policy, built on a behavior the drafts say an
   * endpoint MAY implement (16 §8.4.1, 18 §9.4.1, 22 §7.4.1), not on a MUST.
   * Request scope re-issues nothing; that remains application policy.
   */
  private handleGoawayNotice(notice: GoawayNotice, conn: MoqtConnection): void {
    // A delayed GOAWAY from a superseded session must not touch the replacement's
    // subscriptions, requests, or catalog state.
    if (conn !== this.connection) {
      this.log.info('Ignoring GOAWAY from a superseded session (scope=%s)', notice.scope);
      return;
    }
    if (notice.scope === 'request') {
      this.handleRequestGoaway(notice.requestId, notice.newSessionUri, conn);
      return;
    }
    this.handleSessionGoaway(notice.newSessionUri, conn);
  }

  /**
   * Settle the player-owned operations keyed by one request ID.
   *
   * `retireMediaSubscription` covers the subscription-general owners, but it
   * keys dependent fetches by their SUBSCRIPTION's request ID — it does not
   * reach an operation whose own request is the one being retired. Each of
   * these owns a promise, a timer, or late-data routing that would otherwise
   * stay live after the peer stopped serving the request: a FETCH left
   * unquarantined, a one-shot catalog FETCH pending until its own timeout, a
   * codec switch waiting forever for init data, or a TRACK_STATUS query that
   * never settles.
   *
   * Each is routed through its existing lifecycle rather than a generic helper,
   * and only the addressed request is touched. Re-issuing is application policy.
   */
  private retireOwnedRequest(requestId: bigint): void {
    const why = 'its request stream received GOAWAY; re-issue is application policy';

    // A media/warm-start FETCH this request owns: quarantine so its already-open
    // data streams are dropped rather than routed to a retired request.
    if (this.activeFetches.has(requestId)) this.quarantineFetchRequest(requestId);

    // A one-shot fetchCatalog() promise. settleCatalogFetch owns the timer and
    // stream-map cleanup, so it is used rather than repeated here.
    this.settleCatalogFetch(requestId, {
      ok: false,
      error: new Error(`Catalog FETCH ${requestId} retired: ${why}`),
    });

    // A TRACK_STATUS query awaiting its response.
    const trackStatus = this.pendingTrackStatuses.get(requestId);
    if (trackStatus) {
      trackStatus.reject(new Error(`TRACK_STATUS ${requestId} retired: ${why}`));
      this.pendingTrackStatuses.delete(requestId);
    }

    // An init-track subscription a codec switch is waiting on. These are keyed
    // by track name, with the request ID held separately, so both owners are
    // cleared together.
    for (const [name, initReqId] of this.initTrackRequestIds) {
      if (initReqId !== requestId) continue;
      this.initTrackRequestIds.delete(name);
      const pending = this.pendingInitTrackSubs.get(name);
      if (pending) {
        pending.reject(new Error(`Init track "${name}" retired: ${why}`));
        this.pendingInitTrackSubs.delete(name);
      }
    }
  }

  /**
   * Control-stream GOAWAY: the session is draining, so every subscription is
   * retired and a replacement session is established when factories allow it.
   *
   * @see draft-ietf-moq-transport-16 §9.4, §3.5
   */
  private handleSessionGoaway(newSessionUri: string, conn: MoqtConnection): void {
    this.log.info('GOAWAY received, uri=%s', newSessionUri || '(none)');
    // Established media is deliberately NOT cancelled here. Graceful switchover
    // orders the replacement's successful responses BEFORE cancellation:
    // "The new relay will send a response to the subscribes and if they are
    // successful, the subscriptions to the old relay can be cancelled"
    // (draft-16 §8.4.1, draft-18 §9.4.1, draft-22 §7.4.1). Cancelling on receipt
    // tore down playback while the replacement was still being established —
    // sometimes before its transport even existed. The session is already
    // refused new local requests by DRAINING, so retirement belongs to the
    // handover, not to the notice.
    this.emitter.emit('session_goaway', { type: 'session_goaway', newSessionUri });

    // A sealed, empty catalog offers no replacement media. Keep finishing the accepted terminal delivery
    // instead of dialing a session that can only refuse that completed presentation's subscriptions.
    if (this._catalogState?.isComplete === true && this._catalogState.tracks.length === 0
        && (!this.config.knownTracks
          || ![...this.activeSubscriptions.values()].some(sub => !this.terminalMediaSubscriptions.has(sub)))) return;

    if (!this.config.createConnection) return;
    // Catalog quarantine installs IMMEDIATELY at GOAWAY (not only on a
    // going-away PUBLISH_DONE): the old generation may stay authoritative
    // until the migration commits — and the migration may roll back — so
    // late old-session catalog data must never mutate state from here on.
    this.catalogQuarantinedConns.add(conn);
    if (this.catalogSlots.catalogTrackAlias !== null) {
      this.quarantinedCatalogAliases.set(conn, this.catalogSlots.catalogTrackAlias);
    }
    // §9.4 / §10.4 / §9.2: an empty New Session URI reuses the CURRENT session
    // URI — the endpoint we are actually on, not the configured origin.
    const uri = newSessionUri || this.activeEndpoint;
    if (this.currentMigration) {
      // A handoff is in flight (staged-event drain or old-session retirement
      // still holds the single-flight slot). Starting a migration now would be
      // rejected and the GOAWAY lost. QUEUE the target WITH its source session
      // (do NOT create the replacement adapter yet — it would leak); it is
      // acted on once the handoff finishes, only if `conn` is still current.
      this.pendingGoaway = { uri, sourceConnection: conn };
      return;
    }
    this.startGoawayMigration(uri);
  }

  /**
   * Request-stream GOAWAY: retire ONLY the addressed request and report it.
   *
   * No unrelated subscription is cancelled, the session is not drained, and
   * neither `session_goaway` nor `session_migrated` is emitted — a listener on
   * those may reconnect the whole player, which is the wrong response to one
   * request migrating. The subscription's own bookkeeping is retired so no
   * apparently-active track is left behind.
   *
   * @see draft-ietf-moq-transport-18 §10.4
   * @see draft-ietf-moq-transport-22 §9.2, §6.6.1
   */
  private handleRequestGoaway(requestId: bigint, newSessionUri: string, conn: MoqtConnection): void {
    const trackName = this.activeSubscriptions.get(requestId)?.trackName;
    this.log.info(
      'GOAWAY on request %s (track=%s), uri=%s — re-issue is application policy',
      String(requestId), trackName ?? '(unknown)', newSessionUri || '(current session)',
    );
    // The adapter has already settled its own request state. Retire the
    // player's bookkeeping for this one request only; the peer is migrating it,
    // so it is no longer being served on this session.
    //
    // `retireMediaSubscription` covers the subscription-general owners —
    // activeSubscriptions, pendingMediaSubs, the subscription manager, parked
    // alias ownership and fetches dependent on this request. The catalog and
    // the timeline track their own request identity SEPARATELY, so they are
    // cleared explicitly rather than assumed to be handled by it.
    this.retireMediaSubscription(requestId, conn);
    this.activeSubscriptions.delete(requestId);
    this.retireOwnedRequest(requestId);
    // The catalog's retrieval is addressed either through its SUBSCRIBE or
    // through the bootstrap FETCH/FILL that feeds it.
    const isCatalogSubscribe = this.catalogSlots.catalogRequestId === requestId;
    const isBootstrapFetch = this.catalogSlots.bootstrapFetch?.reqId === requestId;
    // A staged recovery candidate carries its OWN request identity, separate
    // from the active catalog's, and has its own retirement lifecycle.
    const recovery = this.catalogSlots.catalogRecovery;
    if (recovery && (recovery.reqId === requestId || recovery.fetch?.reqId === requestId)) {
      this.retireCatalogRecovery();
    }
    if (isCatalogSubscribe || isBootstrapFetch) {
      if (isCatalogSubscribe) {
        // The wire route is dead: nothing is served on this request any more,
        // and a retained alias would keep an authoritative routing identity for
        // a subscription the peer is migrating away.
        this.catalogSlots.catalogRequestId = null;
        this.catalogSlots.catalogTrackAlias = null;
      }
      // Retire the RETRIEVAL too, not just its identity. The coordinator owns an
      // inactivity timer and a legacy-resubscribe fallback: left running, it
      // reissues the catalog SUBSCRIBE on the OLD session, which is neither the
      // migration the peer asked for (§10.4 / §9.2 point it at the supplied URI)
      // nor the no-automatic-reissue policy this path promises.
      //
      // Deliberately NOT cancelCatalogBootstrap(): its generation bump is a
      // SHARED token, also observed by subscribeToMediaTracks and
      // subscribeAuxTrackOwned, so using it here would abort unrelated pending
      // media and init-track work. This signal is scoped to one request
      // (§10.4 / §9.2), so the retirement is scoped to the catalog's own owners.
      if (this.catalogSlots.catalogSubscribeRetryTimer !== null) {
        clearTimeout(this.catalogSlots.catalogSubscribeRetryTimer);
        this.catalogSlots.catalogSubscribeRetryTimer = null;
      }
      this.catalogSlots.catalogBootstrapCoord?.abort();
      this.catalogSlots.catalogBootstrapCoord = null;
      this.catalogSlots.bootstrapFetch = null;
      this.catalogSlots.bootstrapFetchStreams.clear();
      this.retireCatalogRecovery();
      // The PARSED catalog is left intact — tracks, codecs and selection stay
      // valid; only the dead route and its retrieval machinery go.
    }
    if (this.timelineRequestId === requestId) {
      this.timelineRequestId = null;
    }
    this.emitter.emit('request_goaway', {
      type: 'request_goaway',
      requestId,
      newSessionUri,
      ...(trackName !== undefined ? { trackName } : {}),
    });
  }

  /**
   * Handle control messages for player-level events. GOAWAY is handled by
   * {@link handleGoawayNotice} instead, which carries the scope this channel
   * cannot express.
   *
   * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK)
   * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
   * @see draft-ietf-moq-transport-16 §9.7 (REQUEST_OK)
   * @see draft-ietf-moq-transport-16 §9.8 (REQUEST_ERROR)
   */
  /**
   * Control evidence for a handover candidate's own catalog retrieval.
   *
   * Goes through the SAME dispatch as the live session so message parsing is
   * never duplicated, but with a candidate-owned context: its catalog identity
   * and coordinator, and empty media collaborators. A candidate is not current,
   * so nothing here may reach `activeSubscriptions`, `pendingMediaSubs`, the
   * track registrations, any live route, or the event channel. Media readiness
   * is a separate stage and deliberately inert at this point.
   *
   * @see draft-ietf-moq-transport-22 §7.4.1 (successful replacement responses
   *      precede cancelling the old subscriptions)
   */
  /**
   * Control messages from a PREPARING candidate.
   *
   * Two kinds of readiness evidence arrive here and nothing else may: the
   * candidate's own catalog retrieval, and the acceptance or refusal of the
   * media it prepared. Live media bookkeeping is deliberately out of reach —
   * request ids collide between sessions, so answering a candidate's request
   * against the live maps would settle a current track's subscription.
   */
  private handleCandidateControl(
    msg: ControlMessage, conn: MoqtConnection, slots: CatalogSlots,
  ): void {
    const txn = this.currentMigration;
    const prep = txn && txn.conn === conn && !txn.committed && !txn.aborted ? txn.prep : undefined;
    if (prep !== undefined && 'requestId' in msg) {
      const reqId = BigInt((msg as { requestId: bigint | number }).requestId);
      const sub = prep.media.get(reqId);
      let initName: string | null = null;
      for (const [name, init] of prep.initTracks) if (init.reqId === reqId) initName = name;
      if (sub !== undefined || initName !== null) {
        if (msg.type === 'SUBSCRIBE_OK' && 'trackAlias' in msg) {
          // ACCEPTANCE — the §7.4.1 precondition for retiring the old
          // subscriptions. Sending the request proved nothing.
          this.onCandidateSubscribeAccepted(txn!, reqId, BigInt((msg as { trackAlias: bigint | number }).trackAlias));
        } else if (msg.type === 'REQUEST_ERROR') {
          const what = sub !== undefined ? `track "${sub.trackName}"` : `init track "${initName!}"`;
          this.failCandidateMedia(conn, `replacement refused required ${what}: ${
            (msg as { errorReason?: string }).errorReason ?? ''}`);
        } else if (msg.type === 'PUBLISH_DONE') {
          // The replacement ended a required track before we could adopt it:
          // it cannot carry playback, and the old session still can.
          const what = sub !== undefined ? `track "${sub.trackName}"` : `init track "${initName!}"`;
          this.failCandidateMedia(conn, `replacement ended required ${what} before adoption`);
        }
        return;
      }
    }
    doControlMessage(msg, {
      adapter: conn,
      // Candidate-owned and empty: media acceptance is a later stage, and a
      // non-current session must not be able to touch the live maps.
      activeSubscriptions: new Map(),
      pendingMediaSubs: new Map(),
      removeSubscription: () => undefined,
      pendingTrackStatuses: new Map(),
      catalogRequestId: slots.catalogRequestId,
      catalogTrackAlias: slots.catalogTrackAlias,
      subscriptionManager: null,
      log: this.log,
      // A candidate publishes nothing: its catalog is not authoritative until
      // adoption, so no player event may be emitted from this path.
      emitEvent: () => { /* candidate state is not published */ },
      setCatalogTrackAlias: (alias) => {
        slots.catalogTrackAlias = alias;
        // Data may precede the message that establishes the track alias
        // (draft-16 §10.4.2, draft-18 §11.4.2, draft-22 §3.1.3.1), and for a
        // candidate that is not an edge case: a relay with the catalog in hand
        // sends it immediately. A catalog may also be a SINGLE object, so
        // dropping what arrived early, or leaving it retained until an
        // adoption that depends on it, both deadlock the handover. Released
        // here, where binding has finally said what that alias is.
        if (txn !== null) {
          this.releaseEarlyCandidateData(txn, alias,
            (streamId, obj) => { this.dispatchCatalogObject(obj, streamId, conn, slots); });
        }
        this.replayPendingObjects(alias, conn);
      },
      clearCatalogState: () => { slots.catalogTrackAlias = null; slots.catalogRequestId = null; },
      onCatalogSubscribeOk: (largest) => {
        // Acceptance of the catalog subscription — distinct from receiving an
        // early catalog object, and a precondition of readiness.
        slots.catalogBootstrapCoord?.onSubscribeOk(largest);
      },
      onCatalogSubscribeError: (errorCode, reason, retryInterval) => {
        // "Not published yet" is retriable, exactly as at startup; everything
        // else is a real refusal and the replacement is declined.
        if (txn !== null && errorCode === BigInt(RequestError.DOES_NOT_EXIST) && retryInterval !== 0n) {
          this.scheduleCandidateCatalogRetry(txn, conn, retryInterval ?? 0n);
          return;
        }
        this.failCandidateCatalog(conn, `candidate catalog subscribe refused: ${reason}`);
      },
      onCatalogBootstrapFetchOk: (requestId, endLocation, endOfTrack) => {
        const fetch = slots.bootstrapFetch;
        if (!fetch || fetch.conn !== conn || fetch.reqId !== requestId) return;
        slots.catalogBootstrapCoord?.onFetchOk(fetch.attempt, endLocation, endOfTrack);
      },
      onCatalogBootstrapFetchError: (requestId, errorCode) => {
        const fetch = slots.bootstrapFetch;
        if (!fetch || fetch.conn !== conn || fetch.reqId !== requestId) return;
        slots.bootstrapFetch = null;
        // invalid-range and refusal are distinguished per the DELIVERING draft.
        slots.catalogBootstrapCoord?.onFetchError(fetch.attempt,
          errorCode === this.invalidRangeCode(conn.draftVersion) ? 'invalid-range' : 'refused');
      },
      onCatalogPublishDone: (statusCode) => {
        // Classified by the DELIVERING draft, which a cross-draft replacement
        // does not share with the live session.
        const reason = this.normalizePublishDoneStatus(statusCode, conn.draftVersion);
        if (reason === 'going-away') {
          // A replacement that is itself going away cannot be adopted; the
          // old session is still playing, so this is the candidate's failure.
          this.failCandidateCatalog(conn, 'replacement session is going away');
          return;
        }
        // Coordinator modes take the status through the ladder, exactly as the
        // live retrieval does — its drain is what retires an ended feed's
        // route, and adoption carries that holder across.
        const coord = slots.catalogBootstrapCoord;
        if (coord) {
          coord.onPublishDone(reason);
          return;
        }
        // Legacy 'subscribe' mode has no coordinator: defer the status until
        // the drain completes, as the live retrieval does.
        slots.legacyCatalogTerminal = {
          gen: this.bootstrapGeneration,
          reqId: slots.catalogRequestId,
          reason,
        };
      },
    });
  }

  /** Fail a candidate's catalog retrieval WITHOUT failing live playback. */
  private failCandidateCatalog(conn: MoqtConnection, reason: string): void {
    const txn = this.currentMigration;
    if (!txn || txn.conn !== conn || txn.committed) return;
    this.log.info('[handover] candidate catalog failed: %s', reason);
    const err = new Error(reason);
    // Both faces are settled: whichever stage is being awaited rejects, and
    // the other can never strand the attempt. Settling twice is a no-op.
    txn.prep?.rejectCatalog(err);
    txn.prep?.rejectReady(err);
  }

  /**
   * Fail a candidate's MEDIA preparation without failing live playback.
   *
   * A refused or ended replacement track is the candidate's problem, not the
   * session's: the old relay may still be delivering perfectly well, and
   * §7.4.1 only permits cancelling its subscriptions once the replacement's
   * have succeeded. So this rejects the attempt and leaves playback alone.
   */
  private failCandidateMedia(conn: MoqtConnection, reason: string): void {
    const txn = this.currentMigration;
    if (!txn || txn.conn !== conn || txn.committed) return;
    this.log.info('[handover] candidate media failed: %s', reason);
    const err = new Error(reason);
    txn.prep?.rejectReady(err);
    txn.prep?.rejectCatalog(err);
  }

  private handleControlMessage(msg: ControlMessage, conn: MoqtConnection): void {
    const slots = this.slotsFor(conn);
    // Ignore control messages from a SUPERSEDED session. After a migration
    // `this.connection`, `activeSubscriptions`, `pendingMediaSubs`, the track
    // registrations, and the catalog alias all belong to the NEW session; a
    // delayed old-session SUBSCRIBE_OK / PUBLISH_DONE / REQUEST_ERROR / GOAWAY
    // processed against them would remap or unregister a current track, settle a
    // current request, or send UNSUBSCRIBE/GOAWAY on the replacement adapter. The
    // old session is closing — its control state is not retained per session.
    if (conn !== this.connection) {
      // A PREPARING candidate is not superseded — it is not current yet. Its
      // catalog and FETCH/FILL evidence belongs to its own retrieval, and is
      // the only thing a non-current session may be heard on. Live media
      // bookkeeping is deliberately out of reach here.
      if (slots !== null && slots !== this.catalogSlots) {
        this.handleCandidateControl(msg, conn, slots);
        return;
      }
      this.log.info('Ignoring control message from a superseded session: %s', msg.type);
      return;
    }
    if ((msg.type === 'SUBSCRIBE_OK' || msg.type === 'REQUEST_ERROR') && 'requestId' in msg) {
      const answeredReqId = BigInt((msg as { requestId: bigint | number }).requestId);
      const boundAlias = msg.type === 'SUBSCRIBE_OK' && 'trackAlias' in msg
        ? BigInt((msg as { trackAlias: bigint | number }).trackAlias) : null;
      this.settleParkedOwnership(answeredReqId, boundAlias, conn);
    }
    const completedSub = msg.type === 'PUBLISH_DONE'
      ? this.activeSubscriptions.get(BigInt(msg.requestId)) : undefined;
    const completedTrack = completedSub === undefined ? undefined : this.catalogTrackFor(
      completedSub.trackName, completedSub.namespace ?? namespaceFields(this.config.namespace), completedSub.mediaType);
    doControlMessage(msg, {
      adapter: this.connection,
      sourceConnection: conn,
      namespace: namespaceFields(this.config.namespace),
      activeSubscriptions: this.activeSubscriptions,
      pendingMediaSubs: this.pendingMediaSubs,
      removeSubscription: (requestId) => this.retireMediaSubscription(requestId, conn),
      pendingTrackStatuses: this.pendingTrackStatuses,
      catalogRequestId: slots?.catalogRequestId ?? null,
      catalogTrackAlias: slots?.catalogTrackAlias ?? null,
      subscriptionManager: this.subscriptionManager,
      log: this.log,
      emitEvent: (event) => this.emitter.emit(event.type as any, event as any),
      setCatalogTrackAlias: (alias) => {
        if (slots) slots.catalogTrackAlias = alias;
        this.replayPendingObjects(alias, conn);
      },
      clearCatalogState: () => { if (slots) { slots.catalogTrackAlias = null; slots.catalogRequestId = null; } },
      onAliasResolved: (alias) => { this.replayPendingObjects(alias, conn); },
      onMediaTerminalDrain: (id, _sub, status, reason) => {
        if (status !== 2n && (status !== 3n || isDraft22(conn.draftVersion))) return false;
        if ([...this.initTrackRequestIds.values()].includes(id)) return false;
        const sub = this.activeSubscriptions.get(id);
        if (!sub || sub.trackAlias === null) return false;
        let terminals = this.pendingMediaTerminals.get(conn);
        if (!terminals) { terminals = new Map(); this.pendingMediaTerminals.set(conn, terminals); }
        if (terminals.has(id)) return true;
        const pipeline = sub.mediaType === 'video' ? this.videoPipeline : sub.mediaType === 'audio' ? this.audioPipeline : null;
        const mediaSource = this.mediaSource;
        const mseType = sub.mediaType === 'video' || sub.mediaType === 'audio' ? sub.mediaType : null;
        const selection = mseType === null ? null : this.mseSelection(mseType);
        const trackKey = identityKey(sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName);
        const completeMse = () => {
          if (pipeline !== null || mediaSource === null || this.mediaSource !== mediaSource || mseType === null
              || this._destroyed || this.connection !== conn || selection === null) return;
          const current = this.mseSelection(mseType);
          if (status === 2n && selection.key === trackKey && current?.selection === selection.selection && current.key === selection.key
              && !this.mseCompletions?.has(mseType)) {
            (this.mseCompletions ??= new Map()).set(mseType, { conn, source: mediaSource, ...selection, emitted: false });
          }
          this.reconsiderMseTrackEnds();
        };
        terminals.set(id, { sub, reason, whenIdle: this.subscriptionManager?.captureTrackIdle(sub.trackAlias) ?? (() => undefined),
          releaseEnd: pipeline?.holdTrackEnd() ?? (() => {}), trackEnded: status === 2n, completeMse });
        this.terminalMediaSubscriptions.add(sub);
        const restart = this.livenessRestarts.get(`${sub.mediaType}:${sub.trackName}`);
        if (restart) restart.cancelled = true;
        this.livenessMonitor?.reconcile(this.collectLivenessTracks());
        return true;
      },
      onPublishDone: (_requestId, trackName, _trackAlias, statusCode, errorReason) => {
        // TOO_FAR_BEHIND means the subscriber fell behind the live edge —
        // resubscribe from the current position instead of giving up; the relay
        // sends fresh data from live. The wire value is VERSION-SPECIFIC: draft-18
        // uses 0x5 (§15.10.3), draft-14/16 use 0x6 (§13.4.3). On draft-18, 0x6 is
        // EXPIRED, so comparing against the wrong table would both miss real
        // TOO_FAR_BEHIND and mis-fire recovery on EXPIRED.
        const tooFarBehind = isRequestStreamDraft(this.connection?.draftVersion)
          ? PublishDoneCode18.TOO_FAR_BEHIND
          : PublishDoneCode.TOO_FAR_BEHIND;
        if (statusCode === BigInt(tooFarBehind)) {
          this.log.warn('PUBLISH_DONE(TOO_FAR_BEHIND) "%s": resubscribing from live edge', trackName);
          this.replaceSubscription(trackName, 'too_far_behind', completedTrack);
          return;
        }

        this.emitter.emit('track_unsubscribed', {
          type: 'track_unsubscribed',
          trackName,
          reason: errorReason,
        });
      },
      onMediaSubscribeOk: (requestId, _trackName, _mediaType, largest) => {
        if (this.mseCompletions?.get(_mediaType)?.emitted) this.mseCompletions.delete(_mediaType);
        this.reconsiderMseTrackEnds();
        this._mediaSubsOk++;
        const subscription = this.activeSubscriptions.get(requestId);
        const owner = subscription && this.warmMediaOwners.get(subscription);
        if (owner?.connection === conn && subscription?.trackAlias !== null && subscription?.trackAlias !== undefined) {
          owner.registration = this.subscriptionManager?.captureRoute(subscription.trackAlias) ?? null;
          owner.head?.acceptLargest(largest);
        }
      },
      onMediaSubscribeError: (requestId, trackName, mediaType, reason, errorCode) => {
        this._mediaSubsFailed++;
        this.emitter.emit('track_subscribe_failed', {
          type: 'track_subscribe_failed', trackName, mediaType, requestId, errorCode, reason,
        });
        this.emitError(createPlayerError(
          'degraded', 'subscription', PlayerErrorCode.SUBSCRIPTION_REFUSED,
          `Track "${trackName}" refused: ${reason} (code=0x${errorCode.toString(16)})`,
        ));
        if (this._mediaSubsFailed === this._mediaSubsExpected && this._mediaSubsOk === 0 && this._mediaSubsExpected > 0) {
          this.emitError(createPlayerError(
            'fatal', 'subscription', PlayerErrorCode.ALL_TRACKS_REFUSED,
            'All media track subscriptions refused — no playable content',
          ));
        }
      },
      onCatalogSubscribeOk: (largest) => {
        slots?.catalogBootstrapCoord?.onSubscribeOk(largest);
      },
      onCatalogSubscribeError: (errorCode, reason, retryInterval) => {
        if (conn !== this.connection) return;
        this.cancelCatalogBootstrap();
        // Only "not published yet" is retriable; other codes are real refusals.
        if (errorCode !== BigInt(RequestError.DOES_NOT_EXIST) || retryInterval === 0n) {
          this.failCatalogPlayback(createPlayerError(
            'fatal', 'catalog', PlayerErrorCode.SUBSCRIPTION_REFUSED,
            `Catalog subscription refused: ${reason} (code=0x${errorCode.toString(16)})`,
          ));
          return;
        }
        this.scheduleCatalogSubscribeRetry(conn, retryInterval);
      },
      onRecoveryCatalogSubscribeOk: (reqId, alias, largest) => {
        const r = slots?.catalogRecovery;
        if (!r || r.reqId !== reqId) return false;
        if (this._destroyed || this.isTerminalState() || r.gen !== this.bootstrapGeneration || r.conn !== conn) return true;
        r.alias = alias;
        r.coord.onSubscribeOk(largest);
        // Adoption is held for the WHOLE replay below: a valid head reaching
        // readiness mid-replay must not adopt before a later malformed parked
        // delta is examined (which fails the transaction instead).
        r.replaying = true;
        if (r.retiredAlias !== null && alias === r.retiredAlias) {
          // The publisher DID reuse the retired alias: replay the parked
          // traffic into the candidate ONLY — objects in arrival order, then
          // each stream's recorded lifecycle evidence.
          const parked = r.parked; r.parked = []; r.parkedBytes = 0;
          const events = r.parkedEvents; r.parkedEvents = new Map();
          for (const entry of parked) {
            if (!this.emitCatalogRaw(entry.obj)) return true;
            slots?.catalogLiveStreams.set(entry.streamId, { conn: r.conn, coord: r.coord });
            r.coord.onLiveStreamEvent(entry.streamId, 'header');
            r.coord.onLiveCatalogObject(this.toCatalogEvent(entry.obj), entry.streamId);
          }
          for (const [sid, kind] of events) {
            slots?.catalogLiveStreams.delete(sid);
            r.coord.onLiveStreamEvent(sid, kind);
          }
        } else {
          // Different alias: the parked retired-alias traffic was genuinely
          // late OLD-subscription data — discard it, and pull any
          // generic-parked objects for the candidate's NEW alias.
          r.parked = []; r.parkedBytes = 0; r.parkedEvents.clear();
          this.replayPendingObjects(alias, r.conn);
        }
        // Readiness may have been HELD on this bind (the joining fetch can
        // complete on a Pending subscription) — adopt now that the alias is
        // bound and the parked traffic has FULLY replayed. The recovery slot
        // may already be gone if the replay failed the transaction.
        if (slots?.catalogRecovery === r) {
          r.replaying = false;
          this.maybeAdoptCatalogRecovery();
        }
        return true;
      },
      onCatalogBootstrapFetchOk: (requestId, endLocation, endOfTrack) => {
        const r = slots?.catalogRecovery;
        if (r?.fetch && r.fetch.reqId === requestId) {
          r.coord.onFetchOk(r.fetch.attempt, endLocation, endOfTrack);
          return;
        }
        const fetch = slots?.bootstrapFetch;
        if (!fetch || fetch.reqId !== requestId || fetch.gen !== this.bootstrapGeneration) return;
        slots?.catalogBootstrapCoord?.onFetchOk(fetch.attempt, endLocation, endOfTrack);
      },
      onCatalogBootstrapFetchError: (requestId, errorCode) => {
        const r = slots?.catalogRecovery;
        if (r?.fetch && r.fetch.reqId === requestId) {
          const attempt = r.fetch.attempt;
          r.fetch = null;
          r.coord.onFetchError(attempt, errorCode === this.invalidRangeCode() ? 'invalid-range' : 'refused');
          return;
        }
        const fetch = slots?.bootstrapFetch;
        if (!fetch || fetch.reqId !== requestId || fetch.gen !== this.bootstrapGeneration) return;
        if (slots) slots.bootstrapFetch = null;
        // INVALID_RANGE (0x11) = track empty; anything else = refusal → ladder.
        slots?.catalogBootstrapCoord?.onFetchError(fetch.attempt,
          errorCode === this.invalidRangeCode() ? 'invalid-range' : 'refused');
      },
      onRecoveryCatalogRequestError: (reqId) => {
        const r = slots?.catalogRecovery;
        if (!r || r.reqId !== reqId) return false;
        this.failCatalogRecovery('candidate catalog subscription refused');
        return true;
      },
      onRecoveryCatalogPublishDone: (reqId, statusCode) => {
        const r = slots?.catalogRecovery;
        if (!r || r.reqId !== reqId) return false;
        const reason = this.normalizePublishDoneStatus(statusCode);
        if (reason === 'going-away') {
          // The CANDIDATE's session is going away: it must not remain
          // adoptable. Session-level GOAWAY drives migration; the active
          // snapshot stays retained.
          this.failCatalogRecovery('candidate session going away');
          return true;
        }
        r.coord.onPublishDone(reason);
        return true;
      },
      onCatalogPublishDone: (statusCode) => {
        const reason = this.normalizePublishDoneStatus(statusCode);
        if (reason === 'going-away') {
          // GOAWAY semantics: quarantine THIS connection's catalog delivery
          // immediately (not generation-gated — the old generation stays
          // authoritative until a migration commits and may roll back), and
          // never issue a new subscribe on the GOAWAY'd session. Migration is
          // driven by the session-level GOAWAY handling; on failure the
          // active snapshot remains, degraded, with no automatic recovery.
          if (this.connection) {
            this.catalogQuarantinedConns.add(this.connection);
            if (slots?.catalogTrackAlias !== null) {
              const quarantinedAlias = slots?.catalogTrackAlias;
              if (quarantinedAlias !== null && quarantinedAlias !== undefined) {
                this.quarantinedCatalogAliases.set(this.connection, quarantinedAlias);
              }
            }
          }
        }
        const coord = slots?.catalogBootstrapCoord;
        if (coord) {
          coord.onPublishDone(reason);
          return;
        }
        // LEGACY retrieval (explicit 'subscribe' mode): no
        // coordinator exists, so the status policy applies directly — the
        // same matrix, minus staged recovery (documented legacy limitation).
        if (reason === 'fatal-track') {
          // Untrusted catalog: quarantine application delivery immediately
          // (the adapter still drains for alias hygiene) and surface fatally.
          // The ALIAS is quarantined too — drained stragglers must not park
          // against a pending request and later replay into a media track
          // that reuses it.
          if (this.connection) {
            this.catalogQuarantinedConns.add(this.connection);
            if (slots?.catalogTrackAlias !== null) {
              const quarantinedAlias = slots?.catalogTrackAlias;
              if (quarantinedAlias !== null && quarantinedAlias !== undefined) {
                this.quarantinedCatalogAliases.set(this.connection, quarantinedAlias);
              }
            }
          }
          this.retireCatalogAliasRoute();
          this.failCatalogPlayback(createPlayerError(
            'fatal', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
            'catalog track terminated as untrusted (unauthorized/malformed)',
          ));
          return;
        }
        if (reason === 'retriable' || reason === 'ended') {
          // PUBLISH_DONE is NOT a delivery barrier: record the terminal and
          // keep applying drained objects (a base may still arrive during
          // the drain). The DECISION happens in deliverCatalogDrained():
          // retriable+base → staged recovery (legacy candidate = fresh
          // AbsoluteStart subscribe); no base after the drain → fatal;
          // ended+base → quiet one-shot completion.
          if (slots) slots.legacyCatalogTerminal = {
            gen: this.bootstrapGeneration,
            reqId: slots?.catalogRequestId,
            reason,
          };
        }
      },
      onCatalogFetchError: (requestId, errorReason, errorCode) => {
        this.settleCatalogFetch(requestId, {
          ok: false,
          error: new Error(
            `fetchCatalog failed: ${errorReason} (code=0x${errorCode.toString(16)})`,
          ),
        });
      },
      onMediaFetchError: (requestId, errorReason, errorCode) => {
        const fetchInfo = this.activeFetches.get(requestId);
        if (!fetchInfo) {
          // Refusal raced the fetch()/joiningFetch() continuation — remember
          // it (bounded) so registration honors the refusal, and drop any
          // already-buffered streams for the dead request.
          if (this.refusedFetchRequests.size >= MoqtPlayer.MAX_REFUSED_FETCHES) {
            const oldest = this.refusedFetchRequests.keys().next().value;
            if (oldest !== undefined) this.refusedFetchRequests.delete(oldest);
          }
          this.refusedFetchRequests.set(requestId, { reason: errorReason, code: errorCode });
          this.quarantineFetchRequest(requestId);
          return;
        }
        this.quarantineFetchRequest(requestId);
        // Non-fatal by design: a refused warm-start (or manual) media fetch
        // just means no pre-roll — the live subscription is untouched and
        // playback starts at the next group boundary.
        this.log.warn('[%s] media FETCH %s for "%s" refused: %s (code=0x%s) — continuing live-only',
          fetchInfo.warmStart ? 'warm-start' : 'fetch',
          requestId, fetchInfo.trackName, errorReason, errorCode.toString(16));
      },
      onMediaAliasBound: (requestId, alias) => {
        // The current session has bound this alias, so it is no longer a
        // retired session's route — whatever that session still sends on it
        // belongs to nobody.
        this.supersededRouting?.aliases.delete(alias);
        // FETCH ownership follows the associated subscription, never a
        // coincidentally equal Request ID or another track's numeric alias.
        for (const [fetchId, info] of this.activeFetches) {
          if (info.subscriptionRequestId !== requestId) continue;
          info.trackAlias = alias;
          this.drainMediaFetch(fetchId);
        }
      },
    });
  }

  /**
   * Handle a catalog object from the catalog subscription.
   *
   * First catalog triggers track selection and media subscription.
   * Subsequent catalogs (independent or delta) emit catalog_updated.
   *
   * @see draft-ietf-moq-msf-00 §5 (Catalog)
   * @see draft-ietf-moq-msf-00 §5.2 (Delta Updates)
   */
  /**
   * Replay buffered objects for a resolved alias.
   * Called when SUBSCRIBE_OK maps an alias to a track — any objects that
   * arrived before the mapping was known are replayed through the normal
   * routing path.
   *
   * @see draft-ietf-moq-transport-16 §9.10 (Track Alias assignment)
   */
  /**
   * Drop every buffered object delivered by `conn` (its session is closing, so
   * its aliases can never resolve). Empties the alias buckets it owned and, with
   * them, the strong references to the connection — letting a superseded adapter
   * be collected after migration.
   */
  private purgePendingForConnection(conn: MoqtConnection): void {
    for (const [alias, bucket] of this.pendingObjectsByAlias) {
      const kept = bucket.filter((e) => e.sourceConnection !== conn);
      if (kept.length === 0) this.pendingObjectsByAlias.delete(alias);
      else if (kept.length !== bucket.length) this.pendingObjectsByAlias.set(alias, kept);
    }
    // The session's pre-alias lifecycle evidence dies with its objects —
    // stale records must not collide with a later session's stream ids or
    // exhaust a later recovery's lifecycle budget.
    this.pendingStreamEvents.delete(conn);
  }

  private replayPendingObjects(alias: bigint, resolvingConnection: MoqtConnection): void {
    const pending = this.pendingObjectsByAlias.get(alias);
    if (!pending || pending.length === 0) return;

    // An alias resolution belongs to the session whose SUBSCRIBE_OK carried it.
    // Only entries delivered by THAT SAME session may be replayed now — entries
    // buffered by another (e.g. a new session buffering under a reused alias
    // while a delayed old-session SUBSCRIBE_OK arrives) must stay buffered until
    // their own session resolves them. So partition, never bulk-delete.
    const replay = pending.filter((e) => e.sourceConnection === resolvingConnection);
    const retain = pending.filter((e) => e.sourceConnection !== resolvingConnection);
    if (retain.length > 0) this.pendingObjectsByAlias.set(alias, retain);
    else this.pendingObjectsByAlias.delete(alias);

    // Catalog replay is two-phase: EVERY object is delivered first; each stream's
    // terminal event (fin/reset) is delivered exactly once AFTERWARDS. A
    // multi-object stream must never see its terminal replayed between its
    // own objects — that would corrupt the clean-chain evidence for an
    // otherwise valid independent-plus-delta sequence.
    // LOCMAF resets instead occur at their original position relative to ALL
    // parked objects, including full headers on a replacement stream.
    const latestResetByGroup = new Map<bigint, number>();
    for (const entry of replay) {
      if (entry.locmafResetOrdinal !== undefined) {
        const groupId = BigInt(entry.obj.groupId);
        latestResetByGroup.set(groupId, Math.max(latestResetByGroup.get(groupId) ?? -1, entry.locmafResetOrdinal));
      }
    }
    const appliedResetByGroup = new Map<bigint, number>();
    let mediaReplayed = false;
    const applyLocmafReset = (groupId: bigint, ordinal: number | undefined): void => {
      if (resolvingConnection !== this.connection || ordinal === undefined
          || ordinal <= (appliedResetByGroup.get(groupId) ?? -1)) return;
      this.subscriptionManager?.invalidateLocmafGroup(alias, groupId, resolvingConnection);
      for (const subscription of this.activeSubscriptions.values()) {
        if (subscription.trackAlias === alias) {
          this.locmafDecoders.get(this.mediaKey(subscription.trackName, subscription.mediaType, alias))?.resetGroup(groupId);
        }
      }
      appliedResetByGroup.set(groupId, ordinal);
    };
    const terminalTargets = new Map<bigint, CatalogBootstrap | null>();
    for (const { streamId, obj, sourceDraft, sourceConnection, locmafResetBeforeOrdinal } of replay) {
      // Re-route through the normal onObject path — alias is now resolved
      const resolvedAlias = BigInt(obj.trackAlias);

      if (sourceConnection !== undefined
          && this.quarantinedCatalogAliases.get(sourceConnection) === resolvedAlias) {
        continue; // a quarantined session's catalog alias — never re-attributed
      }
      // The retrieval that OWNS this entry, which for a preparing candidate is
      // its own holder. Classified BEFORE the media lookup for the same reason
      // as in onObject: the subscription manager holds only the live session's
      // registrations, so a replacement whose catalog reuses a live media alias
      // would otherwise have its catalog replayed into the running pipeline.
      const owner = sourceConnection !== undefined ? this.slotsFor(sourceConnection) : null;
      if (owner !== null && owner !== this.catalogSlots && sourceConnection !== undefined
          && resolvedAlias === owner.catalogTrackAlias && this.candidateTxnFor(owner) !== null) {
        this.dispatchCatalogObject(obj, streamId, sourceConnection, owner);
        terminalTargets.set(streamId, owner.catalogBootstrapCoord);
        continue;
      }
      if (this.subscriptionManager?.getMediaType(resolvedAlias) !== undefined) {
        mediaReplayed = true;
        applyLocmafReset(BigInt(obj.groupId), locmafResetBeforeOrdinal);
        // Route with the delivering session's own draft + connection.
        void this.routeMediaObject(streamId, obj, sourceDraft, sourceConnection);
        if (!terminalTargets.has(streamId)) terminalTargets.set(streamId, null);
      } else if (this.catalogSlots.catalogRecovery !== null
          && this.catalogSlots.catalogRecovery.alias !== null
          && resolvedAlias === this.catalogSlots.catalogRecovery.alias
          && this.catalogSlots.catalogRecovery.conn === sourceConnection) {
        const rec = this.catalogSlots.catalogRecovery;
        if (!this.emitCatalogRaw(obj)) return;
        this.catalogSlots.catalogLiveStreams.set(streamId, { conn: rec.conn, coord: rec.coord });
        rec.coord.onLiveStreamEvent(streamId, 'header');
        rec.coord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
        terminalTargets.set(streamId, rec.coord);
      } else if (this.catalogSlots.catalogTrackAlias !== null && resolvedAlias === this.catalogSlots.catalogTrackAlias) {
        if (sourceConnection !== undefined && this.catalogQuarantinedConns.has(sourceConnection)) continue;
        if (this.catalogSlots.catalogBootstrapCoord) {
          if (!this.emitCatalogRaw(obj)) return;
          if (sourceConnection !== undefined) this.catalogSlots.catalogLiveStreams.set(streamId, { conn: sourceConnection, coord: this.catalogSlots.catalogBootstrapCoord });
          this.catalogSlots.catalogBootstrapCoord.onLiveStreamEvent(streamId, 'header');
          this.catalogSlots.catalogBootstrapCoord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
          terminalTargets.set(streamId, this.catalogSlots.catalogBootstrapCoord);
        } else {
          this.handleCatalogObject(obj);
          if (!terminalTargets.has(streamId)) terminalTargets.set(streamId, null);
        }
      } else if (!terminalTargets.has(streamId)) {
        terminalTargets.set(streamId, null);
      }
    }
    // A reset after the last parked object must invalidate its newly replayed
    // full header before a post-binding live delta can use it.
    if (mediaReplayed) {
      for (const [groupId, ordinal] of latestResetByGroup) applyLocmafReset(groupId, ordinal);
    }
    // Phase 2 — deliver each stream's saved terminal exactly once, and
    // consume the record on every outcome (it must not outlive its objects).
    const perConn = this.pendingStreamEvents.get(resolvingConnection);
    if (perConn) {
      for (const [streamId, coord] of terminalTargets) {
        const closed = perConn.get(streamId);
        if (closed === undefined) continue;
        perConn.delete(streamId);
        if (coord) {
          this.catalogSlots.catalogLiveStreams.delete(streamId);
          coord.onLiveStreamEvent(streamId, closed.terminal);
        }
      }
      if (perConn.size === 0) this.pendingStreamEvents.delete(resolvingConnection);
    }
  }

  /**
   * Whether `conn` may deliver media on `alias` right now.
   *
   * Only ever false during the overlap between adopting a replacement and
   * closing the session it replaced, which is the one time two sessions share
   * the alias-keyed routing table:
   *
   * - the retiring session keeps the aliases the replacement did not take
   *   over, so its in-flight media still reaches playback — except for a
   *   media type whose buffer was retyped for the replacement, where its
   *   bytes are in the old format and no longer appendable;
   * - the current session may not deliver on one of those retained aliases,
   *   because it has not bound it: that data would otherwise be relabelled as
   *   whatever track the retiring session had there.
   */
  private mediaRouteBelongsTo(conn: MoqtConnection, alias: bigint): boolean {
    const retained = this.supersededRouting;
    if (conn === this.connection) {
      // The current session: a retained alias is not its to deliver on, since
      // it has not bound it.
      return retained === null || !retained.aliases.has(alias);
    }
    if (retained !== null && conn === retained.conn) {
      // The session being retired, during the overlap: its own aliases still
      // deliver, except where the replacement took the alias over or the
      // buffer was retyped and its bytes are the wrong format now.
      if (!retained.aliases.has(alias)) return false;
      const mediaType = this.subscriptionManager?.getMediaType(alias);
      return mediaType === undefined
        || !retained.reconfigured.has(mediaType as 'video' | 'audio');
    }
    // A session a handover has REPLACED has no route, however late its data
    // arrives: this is the part that has to outlive the overlap, since an
    // async object transform can begin before a handover and resolve long
    // after the session it came from is closed.
    return !this.supersededConns.has(conn);
  }

  /**
   * Deliver a catalog object to the retrieval that OWNS it — coordinator or
   * legacy manager. One path, shared by the ordinary alias route and by the
   * candidate classification that has to run before the live media lookup.
   */
  private dispatchCatalogObject(
    obj: MoqtObject, streamId: bigint, conn: MoqtConnection, slots: CatalogSlots,
  ): void {
    // GOAWAY quarantine: the old session's catalog delivery is dropped
    // unconditionally (the old generation may still be authoritative until
    // migration commits, so this cannot rely on generation checks).
    if (this.catalogQuarantinedConns.has(conn)) return;
    if (slots.catalogBootstrapCoord) {
      if (!this.emitCatalogRaw(obj)) return;
      slots.catalogLiveStreams.set(streamId, { conn, coord: slots.catalogBootstrapCoord });
      slots.catalogBootstrapCoord.onLiveStreamEvent(streamId, 'header');
      slots.catalogBootstrapCoord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
      return;
    }
    this.handleCatalogObject(obj, slots);
  }

  /** The transaction that owns `slots` while still PREPARING, else null. */
  private candidateTxnFor(slots: CatalogSlots): MigrationTxn | null {
    const txn = this.currentMigration;
    return txn !== null && txn.slots === slots && slots !== this.catalogSlots
      && !txn.committed && !txn.aborted ? txn : null;
  }

  /**
   * A preparing candidate's catalog object: parse it into the candidate's own
   * manager and let convergence decide readiness.
   *
   * Nothing is published — no `catalog_raw`, no `catalog_received`, no
   * `catalog_updated` — because this catalog describes a session that is not
   * authoritative and may never be. A malformed object fails the CANDIDATE,
   * never live playback: the old session's catalog is untouched and still good.
   */
  private handleCandidateCatalogObject(obj: MoqtObject, slots: CatalogSlots, txn: MigrationTxn): void {
    if (obj.kind === 'gap') return; // re-sent on the next group, as live
    try {
      const state = slots.catalogManager!.processCatalogObject(obj.payload);
      txn.prep!.state = state;
      if (!slots.catalogReceived) {
        slots.catalogReceived = true;
        this.log.info('[handover] replacement catalog converged: %d tracks', state.tracks.length);
        txn.prep!.resolveCatalog(state);
      }
    } catch (err) {
      // Even a late delta failure fails the candidate rather than degrading:
      // a replacement whose catalog feed is producing garbage must not be
      // adopted, and declining it costs nothing while the old session works.
      this.failCandidateCatalog(txn.conn, `replacement catalog rejected: ${
        err instanceof Error ? err.message : String(err)}`);
    }
  }

  private handleCatalogObject(obj: MoqtObject, slots: CatalogSlots = this.catalogSlots): void {
    if (this._destroyed || this.isTerminalState()) return;
    // A PREPARING candidate's catalog is evidence about a replacement, not the
    // catalog playback is running on: it converges its own retrieval and
    // publishes nothing until adoption.
    const candidate = this.candidateTxnFor(slots);
    if (candidate !== null) { this.handleCandidateCatalogObject(obj, slots, candidate); return; }
    const conn = this.connection;
    const gen = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState()
      && this.connection === conn && this.bootstrapGeneration === gen;
    // Gaps on the catalog track are ignored — the catalog will
    // be re-sent as a new independent object on the next group.
    if (obj.kind === 'gap') return;

    // Emit raw payload before parsing — for debugging catalog format issues
    if (obj.payload && obj.payload.byteLength > 0) {
      let text: string | null = null;
      try { text = new TextDecoder().decode(obj.payload); } catch { /* not UTF-8 */ }
      this.emitter.emit('catalog_raw', {
        type: 'catalog_raw',
        payload: obj.payload,
        text,
      });
      if (!live()) return;
    }

    try {
      const catalogState = this.catalogSlots.catalogManager!.processCatalogObject(obj.payload);

      if (!this.catalogSlots.catalogReceived) {
        this.catalogSlots.catalogReceived = true;
        this._catalogState = catalogState;
        this._stats.recordCatalogReceived();
        this.watchdog.fulfill('catalog_received');
        this.watchdog.expect('first_media_object', 20_000);
        this.log.info('Catalog received: %d tracks', catalogState.tracks.length);
        this.emitter.emit('catalog_received', {
          type: 'catalog_received',
          catalog: catalogState,
        });
        if (!live()) return;

        if (this.pipelinesCreated) {
          // knownTracks path — pipelines already exist, media already subscribed.
          // Initialize QualityController for future ABR switches and validate.
          this.qualityController = new QualityController({
            autoQuality: this.config.autoQuality!,
            startLevel: this.config.startLevel!,
            ...(this.config.capLevelToResolution ? { capLevelToResolution: this.config.capLevelToResolution } : {}),
            qualitySwitchCooldownMs: this.config.qualitySwitchCooldownMs!,
            clock: this.clock,
          });
          this.selectCatalogTracks(catalogState);
          this.validateKnownTracks(catalogState);
        } else {
          // Standard path — catalog-first: create pipelines and subscribe
          this.subscribeToMediaTracks(catalogState).catch((err) => {
            if (this.connection !== conn || this.bootstrapGeneration !== gen) return;
            this.log.error('subscribeToMediaTracks failed: %s', err?.message ?? err);
            this.failCatalogPlayback(createPlayerError(
              'fatal', 'player', PlayerErrorCode.LOAD_FAILED,
              `Media subscription failed: ${err?.message ?? err}`,
              err instanceof Error ? { cause: err } : {},
            ));
          });
        }
      } else {
        // A delta (or a re-sent independent catalog) changed the catalog —
        // refresh the cached state so track selection and initRef resolution see
        // delta-added tracks and the preserved root initDataList / protections.
        this._catalogState = catalogState;
        this.log.info('Catalog updated');
        this.emitter.emit('catalog_updated', {
          type: 'catalog_updated',
          catalog: catalogState,
        });
      }
    } catch (err) {
      // First catalog failure = fatal (can't proceed without catalog).
      // Subsequent catalog failures = degraded (delta update failed, old catalog still valid).
      const severity: ErrorSeverity = this.catalogSlots.catalogReceived ? 'degraded' : 'fatal';
      const code = this.catalogSlots.catalogReceived
        ? PlayerErrorCode.CATALOG_DELTA_ERROR
        : PlayerErrorCode.CATALOG_PARSE_ERROR;
      const cause = err instanceof Error ? err : new Error(String(err));
      const error = createPlayerError(severity, 'catalog', code, cause.message, { cause });
      if (severity === 'fatal') this.failCatalogPlayback(error);
      else this.emitError(error);
    }
  }

  // validateKnownTracks → extracted to player-message.ts

  /** @see DESIGN-production-readiness.md §2 (TTFF optimization) */
  private validateKnownTracks(catalog: CatalogState): void {
    if (!this.config.knownTracks) return;
    doValidateKnownTracks(this.config.knownTracks, catalog, this.log);
  }

  /**
   * Create pipelines, CommandDispatcher, and browser adapters from track info.
   *
   * Shared by both the catalog-first path (subscribeToMediaTracks) and the
   * knownTracks TTFF path (load). Sets `pipelinesCreated` flag to prevent
   * double-creation.
   *
   * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoderLike)
   * @see draft-ietf-moq-loc-01 §4.1 (audio → AudioDecoderLike)
   * @see DESIGN-production-readiness.md §2 (TTFF optimization)
   */
  private createPipelinesFromTrackInfo(trackInfo: TrackInfo): void {
    if (this.pipelinesCreated) return;

    const pipelines = createPipelines(this.config, this.clock, trackInfo, {
      onAttached: () => this.handleCmafMediaSourceAttached(),
      onFirstFrame: () => {
        this._stats.recordFirstFrameRendered();
        this.fulfillCmafBootstrapDeadline('cmaf_first_frame');
        this.log.info('First frame rendered');
        this.emitter.emit('first_frame', { type: 'first_frame' });
      },
      onStallRecovered: (durationMs) => {
        if (this.videoDeliveryEnding()) return;
        this._stats.recordStallRecovered(durationMs);
        this.emitter.emit('stall_recovered', { type: 'stall_recovered', durationMs });
      },
      onStall: (durationMs) => {
        if (this.videoDeliveryEnding()) return;
        this._stats.recordStall(durationMs);
        this.emitter.emit('stall', { type: 'stall', durationMs });
        this.lastLocStallUs = this.clock.now();
        this.locHealthyRenderCount = 0;

        this.consecutiveStallCount++;
        this.videoRecoveryActive = true;
        this.videoRecoveryHealthyRenders = 0;

        // Flush stale backlog AND reject in-flight objects from the old
        // subscription. Pass currentGroupId+1 as targetGroupId so the
        // pipeline's minAcceptGroupId gates out stale groups that arrive
        // after the REQUEST_UPDATE but before the relay switches.
        const minFreshGroup = (this.videoPipeline?.currentGroupId ?? -1n) + 1n;
        this.videoPipeline?.reset(minFreshGroup);
        this.syncController?.reset();

        // Jump to live: when stalls persist (3+ consecutive without a
        // rendered frame), the player has fallen behind the live edge.
        // Don't limp through the backlog — flush everything, resubscribe
        // from NOW, and resume from the next keyframe.
        if (this.consecutiveStallCount >= 3) {
          this.consecutiveStallCount = 0;
          this.log.warn('Jump to live: %d consecutive stalls — flushing and resubscribing', 3);

          // Tell relay to restart from live edge
          this.requestFreshSubscriptionStart('video');

          this.emitter.emit('recovery_action', {
            type: 'recovery_action',
            action: { type: 'jump_to_live' },
          });
          return;
        }

        // Relay signals overload via PUBLISH_DONE/TOO_FAR_BEHIND;
        // network bottlenecks produce no server signal, so the player
        // must self-detect via stall rate.
        if (this.recoveryController) {
          const action = this.recoveryController.evaluate({ type: 'stall' as any, durationMs } as any);
          this.emitter.emit('recovery_action', {
            type: 'recovery_action',
            action,
          });
          doRecoveryAction(action, 'video', this.qualityController, this.log, {
            onQualityReduced: (newTrack) => {
              // No stats here — deferred to completePendingVideoSwitch.
              this.selectVideoTrack(newTrack.name, 'recovery', 'downshift').catch((err) => {
                this.log.warn('Quality switch to "%s" failed: %s', newTrack.name, err);
              });
            },
            onResubscribe: (mt, sg) => this.requestFreshSubscriptionStart(mt, sg),
            onTerminate: (_reason) => {
              if (this.stateMachine.state !== PlayerState.ERROR) {
                this.transitionState(PlayerState.ERROR);
              }
              this.stopTicking();
            },
          });
        }
      },
      onDecodeError: (mediaType, error) => {
        if (this.stateMachine.state === PlayerState.ERROR) return;
        this._stats.recordDecodeError();

        // MSE playhead-wedge ladder exhausted (Safari frozen-element class):
        // the adapter already tried nudge/pulse/seek — the MediaSource must
        // be rebuilt, which only the application can do (fresh tune-in).
        // FATAL, unlike ordinary decode errors: this is the public signal
        // apps reconnect on.
        // MediaSource.isTypeSupported rejected the codec string — MSE can
        // never be configured on this UA. Fatal (adapter names the mime).
        if (error.name === 'CodecUnsupportedError') {
          this.emitError(createPlayerError(
            'fatal', 'decoder', PlayerErrorCode.CODEC_UNSUPPORTED, error.message,
            { cause: error, context: { mediaType } },
          ));
          if (!this.isTerminalState()) this.transitionState(PlayerState.ERROR);
          this.stopTicking();
          return;
        }

        if (error.name === 'MediaGapUnrecoverableError') {
          // Buffered-gap recovery was unrecoverable: either a hole exceeded
          // the bounded-skip policy, or a bounded skip's landing never
          // resumed playback. Only a MediaSource rebuild (fresh tune-in)
          // recovers.
          //
          // Terminal transaction FIRST, publications LAST: the adapter
          // spends its once-only fatal before calling onError, so no
          // externally supplied code (config.errorFilter, `error` or
          // `state_changed` listeners) may run until state AND ticking are
          // committed — a throwing listener must neither strand live
          // ticking behind a public ERROR state nor censor the other
          // publication. Same applyState/announceState split play()/pause()
          // use; first listener failure rethrows after both attempts.
          const doTransition = !this.isTerminalState();
          const from = this.state;
          if (doTransition) this.applyState(PlayerState.ERROR);
          this.stopTicking();
          let publishFailed = false;
          let publishError: unknown;
          try {
            this.emitError(createPlayerError(
              'fatal', 'decoder', PlayerErrorCode.MEDIA_GAP_UNRECOVERABLE, error.message,
              { cause: error, context: { mediaType } },
            ));
          } catch (publishErr) {
            // Boolean sentinel, payload verbatim: `throw undefined`/`null`
            // are legal and must neither be swallowed nor displaced.
            if (!publishFailed) { publishFailed = true; publishError = publishErr; }
          }
          if (doTransition) {
            try {
              this.announceState(from, PlayerState.ERROR);
            } catch (publishErr) {
              if (!publishFailed) { publishFailed = true; publishError = publishErr; }
            }
          }
          if (publishFailed) throw publishError;
          return;
        }

        if (error.name === 'PlayheadWedgeError') {
          this.emitError(createPlayerError(
            'fatal', 'decoder', PlayerErrorCode.MEDIA_ELEMENT_WEDGED, error.message,
            { cause: error, context: { mediaType } },
          ));
          // Re-check across a function boundary (defeats stale narrowing from
          // the handler's top guard): an emitError listener may have
          // transitioned re-entrantly (e.g. destroy() → ENDED).
          if (!this.isTerminalState()) {
            this.transitionState(PlayerState.ERROR);
          }
          this.stopTicking();
          return;
        }

        if (mediaType === 'video') {
          this.lastLocDecodeErrorUs = this.clock.now();
          this.locHealthyRenderCount = 0;
        }
        const code = mediaType === 'audio'
          ? PlayerErrorCode.AUDIO_DECODE_ERROR
          : PlayerErrorCode.VIDEO_DECODE_ERROR;
        this.emitError(createPlayerError(
          'degraded', 'decoder', code, error.message, { cause: error, context: { mediaType } },
        ));
        // After a WebCodecs decode error the browser-level decoder resets
        // itself and (for AVC) sets awaitingH264Idr = true. The pipeline's
        // DecoderStateMachine must be brought back to NEEDS_KEYFRAME so it
        // stops feeding delta frames that the decoder silently drops.
        // Without this, the two keyframe gates desync: the pipeline thinks
        // it's in DECODING state while the decoder is waiting for an IDR,
        // causing an indefinite stall.
        if (mediaType === 'video' && this.videoPipeline) {
          this.videoPipeline.reset();
          this.syncController?.reset();
        }
      },
      onFrameRendered: (_captureTimestampUs, _actualRenderUs) => {
        this._stats.recordFrameRendered();
        if (this.videoRecoveryActive) {
          // Pipeline reset(minFreshGroup) rejects stale in-flight objects,
          // so any frame reaching here is genuinely fresh relay data.
          this.videoRecoveryHealthyRenders++;
          if (this.videoRecoveryHealthyRenders >= MoqtPlayer.RECOVERY_HEALTHY_THRESHOLD) {
            this.videoRecoveryActive = false;
            this.videoRecoveryHealthyRenders = 0;
            this.recoveryController?.notifySuccess?.();
            this.consecutiveStallCount = 0;
          }
          return;
        }
        this.recoveryController?.notifySuccess?.();
        this.consecutiveStallCount = 0;
      },
      onFeedback: (fb) => this.handleFeedback(fb),
      onCommand: (cmd) => this.handlePipelineCommand(cmd),
      onEvent: (mediaType, evt) => this.handlePipelineEvent(mediaType, evt),
      // A/V skew observability (LOC): record every sample, emit ~1/s.
      onAvSkew: (skewUs) => {
        const skewMs = skewUs / 1000;
        this._stats.recordAvSkew(skewMs);
        const nowMs = performance.now();
        if (nowMs - this.lastSkewEmitMs >= 1000) {
          this.lastSkewEmitMs = nowMs;
          this.emitter.emit('sync_skew', {
            type: 'sync_skew',
            skewMs,
            ewmaMs: this.stats.avSkewEwmaMs ?? skewMs,
          });
        }
      },
    }, this._handshakeRttMs);

    // Store pipeline set in player fields — MUST happen before
    // configurePipelines() because configure() triggers onCommand
    // synchronously, which needs this.commandDispatcher.
    this.videoPipeline = pipelines.videoPipeline;
    this.audioPipeline = pipelines.audioPipeline;
    this.syncController = pipelines.syncController;
    this.recoveryController = pipelines.recoveryController;
    this.commandDispatcher = pipelines.commandDispatcher;
    this.mediaSource = pipelines.mediaSource;
    this.bindLocDiagnostics(this.mediaDiagnosticRuntime);
    try { this.mediaDiagnosticRuntime?.bindMediaSource(this.mediaSource); } catch { /* Diagnostics are optional. */ }
    // Re-state playback intent on the newly created adapter. play()/pause() can
    // both happen before the catalog exists, so the adapter that is created
    // afterwards must inherit the player's CURRENT intent rather than its own
    // default. `null` means the embedder has never declared one — leave the
    // adapter's default alone.
    if (this.playbackIntent !== null) {
      this.mediaSource?.setPlaybackIntent?.(this.playbackIntent);
    }
    this.getRenderCushionUs = pipelines.getRenderCushionUs ?? null;

    // Wire MSE stall detection to ABR emergency downshift.
    // CMAF has no pipeline-level stall handler — the MseMediaSource
    // detects stalls directly from the <video> element.
    if (this.mediaSource) {
      this.mediaSource.onStallRecovered = (durationMs) => {
        if (this.videoDeliveryEnding()) return;
        this._stats.recordStallRecovered(durationMs);
        this.emitter.emit('stall_recovered', { type: 'stall_recovered', durationMs });
      };
      this.mediaSource.onStall = (durationMs, cause) => {
        if (cause !== 'media-gap' && this.videoDeliveryEnding()) return;
        // A media-gap report is an already-elapsed interval, not a detection
        // latency, and nothing will later complete it.
        if (cause === 'media-gap') this._stats.recordResolvedStall(durationMs);
        else this._stats.recordStall(durationMs);
        this.emitter.emit('stall', { type: 'stall', durationMs, ...(cause ? { cause } : {}) });

        // A media-gap stall is missing SOURCE media the adapter already
        // skipped — not a bandwidth signal. Count it, never downshift on it.
        if (cause === 'media-gap') return;

        // Don't cascade downshifts while a switch is already in flight.
        // Each switch needs time for the relay to deliver the new track's
        // first keyframe. Rapid cascading (4 switches in <2s) means no
        // track ever gets a chance to deliver — changeType() keeps wiping
        // the decoder before data arrives.
        if (this.pendingVideoSwitch || this.switchInProgress) return;

        // Emergency downshift: non-mutating peek, deferred commit.
        if (this.qualityController && this.bufferAbrController) {
          const newTrack = this.qualityController.peekLowerVideoQuality(true);
          if (newTrack) {
            this.lastAbrDownshiftUs = this.clock.now();
            this.log.warn('MSE stall %dms → emergency downshift to %s', durationMs, newTrack.name);
            this.selectVideoTrack(newTrack.name, 'recovery', 'downshift').catch((err) => {
              this.log.warn('Stall downshift to "%s" failed: %s', newTrack.name, err);
            });
          }
        }
      };

      // Buffered-hole gap-jump: the adapter skipped missing source media.
      // Surface it as stats + a typed public event (apps subscribe to the
      // player event; the adapter slot has exactly one owner — this one).
      this.mediaSource.onGapJump = (info) => {
        this._stats.recordGapJump();
        this.log.warn(
          'MSE gap-jump: skipped %ss hole %ss -> %ss (waited %sms)',
          info.holeSec.toFixed(2), info.from.toFixed(2), info.to.toFixed(2), info.waitedMs.toFixed(0),
        );
        this.emitter.emit('gap_jump', {
          type: 'gap_jump',
          from: info.from, to: info.to, holeSec: info.holeSec, waitedMs: info.waitedMs,
        });
      };
    }

    // Configure pipelines (triggers decoder configure commands)
    // @see draft-ietf-moq-loc-01 §2.3.2.1 (Video Config)
    configurePipelines(pipelines, trackInfo);

    // CMAF init-source state machine: register each selected CMAF track.
    // Inline initData satisfies the entry immediately; initTrack deliveries
    // and in-band ftyp+moov objects satisfy on arrival. initialize() fires
    // exactly once, when every selected track has bytes — never with empty
    // init data. (initData on TrackInfo is base64, CatalogTrack §5.1.20;
    // selection-time validation already rejected undecodable/empty values.)
    if (this.mediaSource && !this.cmafInitialized) {
      const decodeBase64 = (b64: string): Uint8Array =>
        Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      this.cmafPendingInit = {};
      if (trackInfo.video && this.usesMse(trackInfo.video.packaging) && trackInfo.video.codec) {
        this.cmafPendingInit.video = {
          codec: trackInfo.video.codec,
          bytes: trackInfo.video.initData ? decodeBase64(trackInfo.video.initData) : null,
        };
      }
      if (trackInfo.audio && this.usesMse(trackInfo.audio.packaging) && trackInfo.audio.codec) {
        this.cmafPendingInit.audio = {
          codec: trackInfo.audio.codec,
          bytes: trackInfo.audio.initData ? decodeBase64(trackInfo.audio.initData) : null,
        };
      }
      this.maybeApplyCmafInit();
    }

    this.pipelinesCreated = true;
  }

  // ─── CMAF init-source state machine ─────────────────────────────────

  /**
   * Record init bytes for a selected CMAF track from any valid source
   * (initTrack delivery or in-band ftyp+moov). First source wins per
   * track; initialization happens when all selected tracks are satisfied.
   */
  private supplyCmafInitBytes(mediaType: 'video' | 'audio', bytes: Uint8Array): void {
    if (this.cmafInitialized) return;
    const entry = this.cmafPendingInit?.[mediaType];
    if (!entry || entry.bytes) return;
    entry.bytes = bytes;
    this.maybeApplyCmafInit();
  }

  /**
   * Initialize MSE + assembler once EVERY selected CMAF track has init
   * bytes. Called from pipeline creation (inline initData), initTrack
   * delivery, and in-band init detection. The single call site guarantees
   * the adapter's one-shot initialize() always receives the complete
   * config (split video/audio init sources initialize together).
   */
  private maybeApplyCmafInit(): void {
    if (this.cmafInitialized || !this.cmafPendingInit || !this.mediaSource) return;
    const kinds: Array<'video' | 'audio'> = ['video', 'audio'];
    const entries = kinds
      .map((mt) => [mt, this.cmafPendingInit![mt]] as const)
      .filter((pair): pair is readonly [('video' | 'audio'), { codec: string; bytes: Uint8Array | null }] => pair[1] !== undefined);
    if (entries.length === 0) return;
    if (entries.some(([, e]) => !e.bytes || e.bytes.byteLength === 0)) return; // still collecting

    const msConfig: {
      video?: { codec: string; initData: Uint8Array };
      audio?: { codec: string; initData: Uint8Array };
    } = {};
    for (const [mt, e] of entries) msConfig[mt] = { codec: e.codec, initData: e.bytes! };

    // ALL-OR-NOTHING contract: `false` means the adapter rejected the config
    // (unsupported codec / invalid init), surfaced reasons via onError
    // (which map to fatal player errors), and stayed un-latched. The player
    // must NOT mark CMAF initialized or build the assembler on failure —
    // the bootstrap deadline remains the backstop if no fatal fired.
    const source = this.mediaSource;
    const initialized = source.initialize(msConfig);
    if (this._destroyed || this.mediaSource !== source || this.isTerminalState()) return;
    if (initialized === false) {
      this.log.warn('CMAF initialize rejected by the media source adapter — not marking initialized');
      return;
    }
    this.cmafInitialized = true;
    for (const [mt, e] of entries) this.installedCmafInit.set(mt, { source, bytes: e.bytes!.slice() });
    this.cmafVideoSynced = false; // wait for a keyframe after init
    // Record the codec for change-type detection on future switches.
    // (Audio codec switches aren't currently exposed in the API.)
    if (this.cmafPendingInit.video?.codec) this.currentVideoCodec = this.cmafPendingInit.video.codec;

    this.buildCmafAssembler();
    // Hand init bytes to the assembler so its strip path can fall back to
    // trex defaults for streams without tfhd sample defaults.
    for (const [mt, e] of entries) this.cmafAssembler?.setInitSegment?.(mt, e.bytes!);

    this._stats.recordDecoderConfigured();
    this.fulfillCmafBootstrapDeadline('cmaf_init');
    if (this.config.cmafBootstrapTimeoutMs! > 0) {
      // Second bootstrap deadline: initialized but never rendered a frame
      // (codec/init mismatch class) must not be a silent black player.
      // Renewed on each video segment arrival in buildCmafAssembler's
      // onSegment (bounded by cmafFirstFrameMaxWaitMs) so a fixed 10s
      // deadline from here doesn't misfire while delivery is healthy but
      // startup buffering legitimately takes longer (e.g. long-haul RTT).
      this.cmafFirstFrameDeadlineStartedAt = Date.now();
      this.expectCmafBootstrapDeadline('cmaf_first_frame', this.config.cmafBootstrapTimeoutMs!);
    }
    this.log.info('CMAF MediaSource initialized (%s)',
      entries.map(([mt, e]) => `${mt}=${e.bytes!.byteLength}B`).join(' '));
  }

  /**
   * The CMAF MediaSource just attached (MSE `sourceopen` → SourceBuffers).
   * If media was held while unattached, everything the assembler had seen
   * was dropped before MSE: start its timeline over on what will actually be
   * appended (re-seeding the init segments it needs for timescales/trex) and
   * wait for the next group start so the first appended video sample is a
   * keyframe — i.e. resume at the live edge.
   */
  private handleCmafMediaSourceAttached(): void {
    if (!this.cmafHoldingForAttach) return;
    this.cmafHoldingForAttach = false;
    this.cmafAssembler?.reset();
    for (const mt of ['video', 'audio'] as const) {
      const bytes = this.runningInitBytes(mt);
      if (bytes) this.cmafAssembler?.setInitSegment?.(mt, bytes);
    }
    this.cmafVideoSynced = false;
    // Held LOCMAF objects never reached their decoders: restart each group reference.
    for (const decoder of this.locmafDecoders.values()) decoder.reset();
    this.log.info('[CMAF] MediaSource attached — resuming at the next group start (live edge)');
  }

  /** Whether a DOM document exists and is currently hidden (background tab). */
  private documentHidden(): boolean {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    return doc?.visibilityState === 'hidden';
  }

  /** Suspend a CMAF bootstrap deadline while the document is hidden. */
  private deferCmafFirstFrameDeadline(timeoutMs: number): void {
    if (this.cmafFirstFrameDeferredTimeoutMs === undefined) {
      this.log.warn(
        'CMAF bootstrap deferred: document is hidden (background tab) — the browser '
        + 'defers media loading until the tab is visible; waiting for cmaf_first_frame');
    }
    this.watchdog.fulfill('cmaf_first_frame');
    this.cmafFirstFrameDeferredTimeoutMs = timeoutMs;
    if (this.cmafFirstFrameDeadlineStartedAt !== undefined
        && this.cmafFirstFrameHiddenAt === undefined) {
      this.cmafFirstFrameHiddenAt = Date.now();
    }
    this.installVisibilityListener();
  }

  /** Arm a CMAF deadline, or park it immediately when the document is hidden. */
  private expectCmafBootstrapDeadline(event: string, timeoutMs: number): void {
    if (event === 'cmaf_first_frame') {
      this.installVisibilityListener();
      if (this.documentHidden()) {
        this.deferCmafFirstFrameDeadline(timeoutMs);
        return;
      }
    }
    this.watchdog.expect(event, timeoutMs);
  }

  /** Fulfill a CMAF deadline and release its visibility bookkeeping. */
  private fulfillCmafBootstrapDeadline(event: string): void {
    this.watchdog.fulfill(event);
    if (event === 'cmaf_first_frame') {
      this.cmafFirstFrameDeferredTimeoutMs = undefined;
      this.cmafFirstFrameDeadlineStartedAt = undefined;
      this.cmafFirstFrameHiddenAt = undefined;
    }
    this.removeVisibilityListenerIfIdle();
  }

  private installVisibilityListener(): void {
    if (this.visibilityListener) return;
    const doc = (globalThis as { document?: EventTarget }).document;
    if (!doc) return;
    this.visibilityListener = () => {
      if (this.documentHidden()) {
        if (this.watchdog.activeExpectations.includes('cmaf_first_frame')) {
          this.deferCmafFirstFrameDeadline(this.config.cmafBootstrapTimeoutMs!);
        }
        return;
      }
      if (this.cmafFirstFrameHiddenAt !== undefined
          && this.cmafFirstFrameDeadlineStartedAt !== undefined) {
        this.cmafFirstFrameDeadlineStartedAt += Date.now() - this.cmafFirstFrameHiddenAt;
        this.cmafFirstFrameHiddenAt = undefined;
      }
      const timeoutMs = this.cmafFirstFrameDeferredTimeoutMs;
      this.cmafFirstFrameDeferredTimeoutMs = undefined;
      if (timeoutMs !== undefined) {
        this.log.info('Document visible — re-arming CMAF bootstrap deadline cmaf_first_frame (%dms)', timeoutMs);
        this.watchdog.expect('cmaf_first_frame', timeoutMs);
      }
      this.removeVisibilityListenerIfIdle();
    };
    doc.addEventListener('visibilitychange', this.visibilityListener);
  }

  private removeVisibilityListenerIfIdle(): void {
    const active = this.watchdog.activeExpectations;
    if (this.cmafFirstFrameDeferredTimeoutMs === undefined
        && !active.includes('cmaf_first_frame')) {
      this.removeVisibilityListener();
    }
  }

  private removeVisibilityListener(): void {
    if (!this.visibilityListener) return;
    const doc = (globalThis as { document?: EventTarget }).document;
    doc?.removeEventListener('visibilitychange', this.visibilityListener);
    this.visibilityListener = null;
  }

  /** Create the moof+mdat assembler wired to the MediaSource (single site). */
  private buildCmafAssembler(): void {
    const ms = this.mediaSource!;
    const timestampOffsetSet = { video: false, audio: false };
    if (!this.config.createCmafAssembler) {
      throw new Error('CMAF tracks require createCmafAssembler in MoqtPlayerConfig');
    }
    this.cmafAssembler = this.config.createCmafAssembler({
      onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, segTrackName: string, groupId: bigint, inputs?: readonly (object | undefined)[]) => {
        if (this._destroyed || this.mediaSource !== ms) return;
        const runtime = this.mediaDiagnosticRuntime;
        let unit: object | undefined;
        if (runtime && inputs) try { unit = runtime.reconstruct(inputs); } catch { /* Optional evidence cannot fail media. */ }
        if (this._destroyed || this.mediaSource !== ms) return;
        if (!timestampOffsetSet[mediaType]) {
          timestampOffsetSet[mediaType] = true;
          if ('setTimestampOffset' in ms) {
            (ms as { setTimestampOffset: (t: string, o: number) => void }).setTimestampOffset(mediaType, 0);
          }
        }
        // A retype of this source buffer is in flight. Real MSE QUEUES appends
        // and drains them after the new initialization is installed, so an
        // old-session segment handed over now would be decoded against the
        // replacement's init — the one corruption the retype exists to avoid.
        // The old session is about to be replaced for this track anyway, so
        // the segment is dropped rather than queued.
        if (this.retypingMedia.has(mediaType)) {
          this.log.debug('[handover] dropped a %s segment arriving during the source-buffer retype', mediaType);
          if (unit) try { runtime?.discardUnit(unit, 'retype'); } catch { /* Optional evidence. */ }
          return;
        }
        let token: object | undefined;
        if (unit && runtime && runtime === this.mediaDiagnosticRuntime) try { token = runtime.appendToken(unit, ms); } catch { /* Optional evidence. */ }
        if (this._destroyed || this.mediaSource !== ms) return;
        try {
          if (token === undefined) ms.appendChunk(mediaType, segment, segTrackName, groupId);
          else ms.appendChunk(mediaType, segment, segTrackName, groupId, token);
        } catch (error) {
          if (unit) try { runtime?.discardUnit(unit, 'append error'); } catch { /* Optional evidence. */ }
          throw error;
        }
        this.renewCmafFirstFrameDeadline(mediaType);
      },
      onDiscard: (input, reason) => this.discardMediaInput(input, reason),
      onDiscontinuity: (mediaType, trackName) => {
        if ('clearTimeline' in ms) {
          (ms as { clearTimeline: (t: string, tn: string) => void }).clearTimeline(mediaType, trackName);
        }
      },
    });
  }

  /**
   * Renew the `cmaf_first_frame` watchdog deadline on a video segment
   * arrival, as long as media is still flowing.
   *
   * A fixed 10s deadline measured only from `cmaf_init` treats "delivery is
   * healthy but startup buffering needs more time" (observed on long-haul
   * RTT paths) the same as "nothing is arriving at all" — firing a fatal
   * `CMAF_INIT_TIMEOUT` and tearing the player down to `ERROR` even though
   * the underlying transport is fine and a frame would render moments later.
   *
   * Only renews while the expectation is still pending (a no-op after
   * `onFirstFrame` has already fulfilled it) and only within
   * `cmafFirstFrameMaxWaitMs` of the original `cmaf_init` — past that
   * ceiling, renewal stops so a genuinely broken decode path (segments
   * arriving, appendBuffer succeeding, but the browser never painting a
   * frame) still surfaces as fatal rather than buffering forever.
   */
  private renewCmafFirstFrameDeadline(mediaType: 'video' | 'audio'): void {
    if (mediaType !== 'video') return;
    if (!this.config.cmafBootstrapTimeoutMs || this.config.cmafBootstrapTimeoutMs <= 0) return;
    if (!this.watchdog.activeExpectations.includes('cmaf_first_frame')) return;

    const maxWaitMs = this.config.cmafFirstFrameMaxWaitMs!;
    const elapsed = Date.now() - (this.cmafFirstFrameDeadlineStartedAt ?? Date.now());
    if (elapsed >= maxWaitMs) return;

    this.expectCmafBootstrapDeadline('cmaf_first_frame', this.config.cmafBootstrapTimeoutMs);
  }

  /**
   * Whether a payload has the shape of an ISO-BMFF initialization segment:
   * a top-level `moov` box, optionally preceded by non-media boxes (ftyp,
   * styp, free, ...). Media payloads (moof/mdat before any moov), truncated
   * boxes, and garbage are rejected — a first-box-only sniff would classify
   * partial or malformed bytes as init and defer the real failure to the
   * "no first frame" deadline with a misleading message.
   */
  private static looksLikeCmafInitSegment(payload: Uint8Array): boolean {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 0;
    for (let i = 0; i < 16 && offset + 8 <= payload.byteLength; i++) {
      const type = String.fromCharCode(
        payload[offset + 4]!, payload[offset + 5]!, payload[offset + 6]!, payload[offset + 7]!);
      if (!/^[a-zA-Z0-9 ]{4}$/.test(type)) return false; // not a box structure
      if (type === 'moof' || type === 'mdat') return false; // media, not init
      let size = dv.getUint32(offset);
      if (size === 1) { // 64-bit largesize
        if (offset + 16 > payload.byteLength) return false;
        const big = dv.getBigUint64(offset + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        size = Number(big);
      }
      if (size < 8 || offset + size > payload.byteLength) return false; // truncated/malformed
      if (type === 'moov') return true; // a COMPLETE top-level moov: init segment
      offset += size;
    }
    return false; // no top-level moov found
  }

  /**
   * A CMAF media object arrived before initialization. An in-band init
   * segment (ftyp+moov) IS a valid init source (common fMP4-over-MoQ
   * publisher pattern); moof/mdat before init is dropped loudly (once per
   * track) and arms the bootstrap deadline so a missing init segment can
   * never present as a silent black player.
   */
  private handlePreInitCmafObject(
    mediaType: 'video' | 'audio',
    trackName: string,
    payload: Uint8Array,
    alias?: bigint,
  ): void {
    if (MoqtPlayer.looksLikeCmafInitSegment(payload)) {
      this.log.info('[CMAF] in-band init segment on "%s" (%s, %dB)',
        trackName, mediaType, payload.byteLength);
      // Cache for codec-changing switches, same as initTrack deliveries.
      this.initSegmentByTrack.set(this.mediaKey(trackName, mediaType, alias), payload);
      this.supplyCmafInitBytes(mediaType, payload);
      return;
    }
    const firstBox = payload.byteLength >= 8
      ? String.fromCharCode(payload[4]!, payload[5]!, payload[6]!, payload[7]!)
      : '(short)';
    const key = `${mediaType}:${trackName}`;
    if (!this.cmafPreInitDropWarned.has(key)) {
      this.cmafPreInitDropWarned.add(key);
      this.log.warn('[CMAF] dropping %s "%s" media before init (first box "%s") — '
        + 'waiting for initData/initTrack/in-band init segment',
        mediaType, trackName, firstBox);
    }
    if (!this.cmafInitDeadlineArmed && this.config.cmafBootstrapTimeoutMs! > 0) {
      this.cmafInitDeadlineArmed = true;
      this.expectCmafBootstrapDeadline('cmaf_init', this.config.cmafBootstrapTimeoutMs!);
    }
  }

  /**
   * The explicit selection this config asks for, as the model's intent.
   *
   * `undefined` when nothing is named, which is what keeps the documented
   * defaults in force. A selector for DISABLED media is dropped here rather
   * than resolved: disabling is the stronger statement.
   */
  private selectionIntent(): SelectionIntent | undefined {
    return selectionIntentFromConfig(this.config);
  }

  /** Select a catalog switching set, or adopt an already-active known track. */
  private selectCatalogTracks(catalog: CatalogState) {
    const activeSubscription = [...this.activeSubscriptions.values()].find(sub => sub.mediaType === 'video'
      && !(sub.trackAlias !== null && this.supersededRouting?.aliases.has(sub.trackAlias)));
    const activeVideo = activeSubscription && catalog.tracks.find(t => t.role === 'video'
      && t.name === activeSubscription.trackName && sameNamespaceFields(
        trackNamespaceFields(t, this.config.namespace),
        activeSubscription.namespace ?? namespaceFields(this.config.namespace)));
    const activeAudioSubscription = [...this.activeSubscriptions.values()].find(sub => sub.mediaType === 'audio'
      && !(sub.trackAlias !== null && this.supersededRouting?.aliases.has(sub.trackAlias)));
    const activeAudio = activeAudioSubscription && catalog.tracks.find(t => t.role === 'audio'
      && t.name === activeAudioSubscription.trackName && sameNamespaceFields(
        trackNamespaceFields(t, this.config.namespace),
        activeAudioSubscription.namespace ?? namespaceFields(this.config.namespace)));
    // Pre-known subscriptions are already active: catalog arrival must describe
    // their switching set, not choose another view behind their back.
    // ONE selection policy, shared with candidate preparation: scope first,
    // then the alternate set inside it, then the member inside that. An
    // explicit selector is honored or reported — never substituted.
    const configuredIntent = this.selectionIntent();
    let intent: SelectionIntent | undefined = activeVideo && configuredIntent?.videoTrack === undefined ? {
      ...configuredIntent,
      scope: configuredIntent?.scope ?? (activeVideo.renderGroup === undefined
        ? { kind: 'unassigned' } : { kind: 'render-group', renderGroup: activeVideo.renderGroup }),
      ...(activeVideo.altGroup !== undefined ? { videoAltGroup: activeVideo.altGroup }
        : { videoTrack: { name: activeVideo.name, namespaceFields: trackNamespaceFields(activeVideo, this.config.namespace) } }),
    } : configuredIntent;
    if (activeAudio && configuredIntent?.audioTrack === undefined) {
      intent = {
        ...intent,
        scope: intent?.scope ?? (activeAudio.renderGroup === undefined
          ? { kind: 'unassigned' } : { kind: 'render-group', renderGroup: activeAudio.renderGroup }),
        audioTrack: { name: activeAudio.name, namespaceFields: trackNamespaceFields(activeAudio, this.config.namespace) },
      };
    }
    const wasAuto = this.qualityController!.isAutoQuality;
    const composed = composeSelection(catalog, {
      catalogNamespace: this.config.namespace,
      ...(intent !== undefined ? { intent } : {}),
      controller: this.qualityController!,
      ...(this.config.videoConstraints !== undefined
        ? { videoConstraints: this.config.videoConstraints } : {}),
      ...(this.config.audioConstraints !== undefined
        ? { audioConstraints: this.config.audioConstraints } : {}),
    });
    if (!composed.ok) {
      // A named scope, set or track that the catalog cannot satisfy. Reported
      // rather than quietly replaced with something else to play.
      throw new Error(`selection cannot be satisfied: ${composed.reason}`);
    }
    const outcome = (side: 'video' | 'audio'): CatalogTrack | undefined => {
      const result = side === 'video' ? composed.video : composed.audio;
      if (result.state === 'selected') return result.track.track;
      if (result.state === 'unsatisfied') {
        // Tracks existed and a constraint or the resolution cap matched none.
        // Never widened to another scope, and never silently dropped.
        this.emitError(createPlayerError(
          'degraded', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
          `no ${side} track satisfies the selection: ${result.reason}`));
      }
      if (result.state === 'excluded') {
        this.emitError(createPlayerError(
          'degraded', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
          `${side} tracks were excluded from selection: ${result.excluded.map(track => track.reason).join(', ')}`));
      }
      return undefined;
    };
    const selected = { video: outcome('video'), audio: outcome('audio') };
    if (configuredIntent?.videoTrack === undefined && wasAuto) this.qualityController!.unlockAuto();
    if (activeVideo && this.qualityController!.allAlternatives.includes(activeVideo)) {
      this.qualityController!.commitVideoTrackRef(activeVideo);
      this.syncBufferAbrController();
      return { ...selected, video: activeVideo };
    }
    this.syncBufferAbrController();
    return selected;
  }

  /** Keep both ABR controllers on the committed track and codec family. */
  private syncBufferAbrController(): void {
    const alts = this.qualityController?.alternatives ?? [];
    this.bufferAbrController = alts.length > 1 ? new BufferBasedController({
      clock: this.clock,
      ladder: alts.map(t => ({ name: t.name, bitrateKbps: (t.bitrate ?? 0) / 1000 })),
      initialIndex: this.qualityController!.currentIndex,
      lowThresholdUs: 500_000,
      highThresholdUs: 4_000_000,
    }) : null;
  }

  /** Subscribe to selected media tracks in parallel through beforeSubscribe. */
  private async subscribeToMediaTracks(catalog: CatalogState): Promise<void> {
    const conn = this.connection;
    const gen = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState()
      && this.subscriptionManager !== null && this.connection === conn && this.bootstrapGeneration === gen;
    if (!conn || !live()) return;
    this._mediaSubsExpected = 0;
    this._mediaSubsOk = 0;
    this._mediaSubsFailed = 0;
    const selected = this.selectCatalogTracks(catalog);

    // ── CMAF bootstrap validation: fail BEFORE any media SUBSCRIBE ──
    // A selected CMAF track with no codec string, or inline initData that
    // is not valid base64 / decodes to zero bytes, can never configure
    // MSE — subscribing would produce media with nowhere to go (the old
    // "clean subscribe, silent black player" failure). Absent init is
    // FINE: initTrack or an in-band ftyp+moov may still provide it, under
    // the bootstrap deadline.
    const cmafSelections: Array<['video' | 'audio', CatalogTrack | undefined]> =
      [['video', selected.video], ['audio', selected.audio]];
    for (const [mediaType, track] of cmafSelections) {
      if (!track || !isMsePackaging(track.packaging)) continue;
      let reason: string | null = null;
      if (!track.codec) {
        reason = 'no codec string';
      } else {
        // Validate the RESOLVED inline init (track.initData or an initRef that
        // resolves to a root inline initDataList entry) — same CMAF_INIT_INVALID
        // class for bad base64 / empty bytes from either source.
        try {
          this.decodeResolvedInlineInitData(track);
        } catch (err) {
          reason = err instanceof Error ? err.message : String(err);
        }
      }
      if (reason) {
        this.failCatalogPlayback(createPlayerError(
          'fatal', 'catalog', PlayerErrorCode.CMAF_INIT_INVALID,
          `CMAF track "${track.name}" (${mediaType}): ${reason} — cannot configure MSE`,
          { context: { trackName: track.name, mediaType } },
        ));
        return;
      }
    }

    // Record initial quality info for stats
    this._stats.setTrackInfo(
      selected.video ? defined({
        codec: selected.video.codec,
        bitrate: selected.video.bitrate,
        width: selected.video.width,
        height: selected.video.height,
      }) : undefined,
      selected.audio ? defined({ codec: selected.audio.codec }) : undefined,
    );
    if (selected.video?.targetLatency !== undefined) {
      this._stats.setTargetLatency(selected.video.targetLatency);
    }

    // §9.2.2: Build subscription options from config
    const subscribeOptions = buildSubscribeOptions(this.config);

    // ── Create pipelines from SELECTED track info ─────────────────
    // Use the quality controller's selected tracks (not the first
    // catalog tracks) — codec / resolution / initData must match the
    // subscription or the decoder will be mis-configured.
    const videoPackaging: TrackPackaging = mediaTrackPackaging(selected.video?.packaging);
    const audioPackaging: TrackPackaging = mediaTrackPackaging(selected.audio?.packaging);

    this.createSelectedPipelines(selected);

    // ── Subscribe to selected tracks (parallel) ──────────────────
    // §9.5: Multiple SUBSCRIBEs can be in-flight simultaneously.

    const tracks: Array<{ name: string; mediaType: 'video' | 'audio'; packaging: TrackPackaging }> = [];
    if (selected.video) tracks.push({ name: selected.video.name, mediaType: 'video', packaging: videoPackaging });
    if (selected.audio) tracks.push({ name: selected.audio.name, mediaType: 'audio', packaging: audioPackaging });

    await Promise.all(tracks.map(async ({ name, mediaType, packaging }) => {
      // Guard: if destroyed during async subscription, bail out
      if (!live()) return;

      // The identity this request will carry: the track's own namespace when
      // the catalog declares one (msf-01 §5.2.2), the configured one
      // otherwise. Computed BEFORE the hook, because the hook may cancel and
      // must see what would actually be sent.
      const selectedTrack = mediaType === 'video' ? selected.video : selected.audio;
      const nsFields = trackNamespaceFields(selectedTrack, this.config.namespace);

      // §5.1: Run through beforeSubscribe hook — null cancels the subscription
      const intent = this.hooks.beforeSubscribe.run({ trackName: name, mediaType, namespace: nsFields });
      if (!intent || !live()) return;
      this._mediaSubsExpected++;

      const nsBytes = nsFields.map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(name);
      // Live media defaults to NextGroupStart (start at keyframe boundary).
      // Non-live/VOD defaults to AbsoluteStart {0,0} (start from beginning).
      const track = mediaType === 'video' ? selected.video : selected.audio;

      // Warm start (§5.1.3): a live media track subscribes with the Largest
      // Object filter so a relative Joining FETCH can prepend the current
      // group's head (issued below). Non-live tracks already start from
      // group 0. Config validation guarantees any
      // explicit subscriptionFilter is LargestObject when warm start is on.
      const warmStart = this.config.warmStartCurrentGroup === true
        && track?.isLive === true;
      // Warm start overrides ONLY the filter — configured subscribe options
      // (deliveryTimeout, subscriberPriority, groupOrder) are preserved.
      // draft 22: the SUBSCRIBE itself asks for the current group as a fill.
      const warmFill = warmStart && isDraft22(conn.draftVersion);
      const mediaOptions = warmStart
        ? {
          ...(subscribeOptions ?? {}),
          subscriptionFilter: { type: 'LargestObject' as const },
          ...(warmFill ? { fill: CURRENT_GROUP_FILL } : {}),
        }
        : (subscribeOptions ?? defaultMediaSubscriptionFilter(track?.isLive === true));
      // Pre-send ownership (§9.10): register inside onRequestId — a
      // zero-latency SUBSCRIBE_OK must find the pending entry already in place. Adapters
      // that don't invoke the callback fall back to post-await registration.
      const connAtSubscribe = conn;
      let subRegistered = false;
      let warmOwner: WarmMediaOwner | null = null;
      const registerMediaSub = (reqIdBigInt: bigint): void => {
        if (subRegistered) return;
        subRegistered = true;
        if (!live()) throw new Error('Media subscription retired before emission');
        this.pendingAliasBinds.add(reqIdBigInt);
        const subscription = {
          trackName: name, mediaType, trackAlias: null, namespace: nsFields,
        };
        this.activeSubscriptions.set(reqIdBigInt, subscription);
        this.pendingMediaSubs.set(reqIdBigInt, { trackName: name, mediaType, packaging });
        if (warmStart) warmOwner = this.armWarmMediaOwner(connAtSubscribe, reqIdBigInt);
        if (!live() || this.activeSubscriptions.get(reqIdBigInt) !== subscription) throw new Error('Media subscription retired before emission');
        if (warmFill) this.registerMediaFetch(reqIdBigInt, {
          trackName: name, mediaType, subscriptionRequestId: reqIdBigInt, trackAlias: null, warmStart: true,
          ...(warmOwner ? { warmOwner } : {}),
        }, connAtSubscribe);
      };
      let registeredId: bigint | null = null;
      let reqIdBigInt: bigint;
      try {
        const reqId = await conn.subscribe(nsBytes, nameBytes,
          { ...mediaOptions, ...this.mediaTerminalOptions(conn), onRequestId: (id: bigint) => { registeredId = id; registerMediaSub(id); } } as never);
        reqIdBigInt = BigInt(reqId);
        if (!live()) {
          if (registeredId === null) void conn.unsubscribe(varint(reqIdBigInt)).catch(() => { /* best effort */ });
          return;
        }
        registerMediaSub(reqIdBigInt);
      } catch (err) {
        // The send failed AFTER pre-send registration: undo the ownership so
        // no pending ownership survives a request the
        // peer never (usably) received.
        if (registeredId !== null) {
          this.retireMediaSubscription(registeredId, connAtSubscribe);
        }
        throw err;
      }

      // Re-check after await — destroy() may have been called
      if (!live()) return;

      if (warmFill) {
        // The fill stream carries the SUBSCRIBE's Request ID: route it under
        // that ID like a warm-start joining FETCH (parked until the alias binds).
        this.log.info('[warm-start] fill requested on subscribe %s for %s "%s"', reqIdBigInt, mediaType, name);
      } else if (warmStart) {
        // §9.16.2 / §10.12.2: a Joining Fetch may reference a PENDING
        // subscription, so this is issued immediately after SUBSCRIBE without
        // awaiting SUBSCRIBE_OK. Registering the fetch under the LIVE track's
        // alias routes its objects through the same pipeline as live delivery
        // (onDataStream → fetchStreamAliases → onObject remap). Failure here
        // is never fatal — playback continues live-only from the next group.
        try {
          const connAtCall = conn;
          // Pre-send ownership: register inside `onRequestId` (invoked by the
          // adapter between allocation and emission) so a zero-latency
          // response or data stream can never beat the registration. The
          // teardown/migration guard runs inside the callback too — it fires
          // synchronously within this call, but the guard keeps the ownership
          // rule uniform. Adapters that don't invoke the callback fall back
          // to post-await registration (the historical behavior).
          let registered = false;
          let warmFetchId: bigint | null = null;
          const registerWarmFetch = (id: bigint): void => {
            if (registered) return;
            if (!live() || this.connection !== connAtCall) {
              this.log.debug('[warm-start] joining FETCH %s completed after teardown/migration — ignored', id);
              registered = true; // suppress the post-await fallback too
              return;
            }
            registered = true;
            warmFetchId = id;
            this.registerMediaFetch(id, {
              trackName: name, mediaType, subscriptionRequestId: reqIdBigInt, trackAlias: null, warmStart: true,
              ...(warmOwner ? { warmOwner } : {}),
            }, connAtCall);
          };
          try {
            const fetchReqId = await conn.joiningFetch({
              joiningFetchType: 'relative',
              joiningRequestId: reqIdBigInt,
              joiningStart: 0n,
              onRequestId: registerWarmFetch,
            } as never);
            registerWarmFetch(BigInt(fetchReqId));
            this.log.info('[warm-start] joining FETCH requestId=%s for %s "%s" (subscribe %s)',
              fetchReqId, mediaType, name, reqIdBigInt);
          } catch (err) {
            // The send failed AFTER pre-send registration: reclaim the fetch
            // ownership, or a phantom activeFetches entry could alias-route
            // raced traffic for a request that was reported as failed.
            if (warmFetchId !== null && this.connection === connAtCall) {
              // Tombstone the request: late traffic quarantines (dropped, not
              // parked unowned) until the session boundary reclaims it.
              this.quarantineFetchRequest(warmFetchId);
            }
            throw err;
          }
        } catch (err) {
          // FIN may already have removed the fetch entry while admitted
          // transforms still wait. A failed send also abandons that attempt.
          this.finishWarmMediaPrefix({ connection: connAtSubscribe, warmStart: true,
            ...(warmOwner ? { warmOwner } : {}) }, 'error');
          this.log.warn('[warm-start] joining FETCH failed for "%s" — continuing live-only: %s',
            name, err instanceof Error ? err.message : String(err));
        }
      }

      if (!live()) return;
      this.log.info('Subscribe %s "%s" requestId=%s', mediaType, name, reqIdBigInt);
      this.emitter.emit('track_subscribed', {
        type: 'track_subscribed',
        trackName: name,
        mediaType,
        requestId: reqIdBigInt,
      });
    }));
    if (!live()) return;

    // ── Auto-subscribe to mediatimeline track (§7.2) ──────────────
    // §7: A mediatimeline track provides PTS→location mapping for seek.
    // §7.2: MUST have depends, mimeType "application/json".
    const selectedIdentities = new Set([selected.video, selected.audio]
      .filter((track): track is CatalogTrack => track !== undefined).map(track => this.initKey(track)));
    const dependsOnSelected = (track: CatalogTrack): boolean => track.depends?.some(name =>
      selectedIdentities.has(this.initKey(track, name))) === true;
    const timelineTrack = catalog.tracks.find(
      (t: CatalogTrack) => t.packaging === 'mediatimeline' && dependsOnSelected(t),
    );
    if (timelineTrack && this.connection && this.subscriptionManager) {
      this.timelineState = createTimelineState(timelineTrack);

      const nsBytes = trackNamespaceFields(timelineTrack, this.config.namespace).map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(timelineTrack.name);
      // §9.10 + pre-send ownership: registration (incl. pendingMediaSubs for
      // the SUBSCRIBE_OK alias remap) happens inside onRequestId.
      const reqIdBigInt = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, subscribeOptions, {
        trackName: timelineTrack.name, mediaType: 'mediatimeline', packaging: 'mediatimeline',
      }, (id) => { this.timelineRequestId = id; },
      (id) => { if (this.timelineRequestId === id) this.timelineRequestId = null; });
      this.log.info('Subscribe mediatimeline "%s" requestId=%s', timelineTrack.name, reqIdBigInt);
    }

    // ── Auto-subscribe to init tracks (CMSF §3.1) ──────────────
    // Init tracks deliver ftyp+moov initialization segments for CMAF-packaged media.
    // @see draft-ietf-moq-catalogformat-01 §3.2.16 (initTrack field)
    //
    // LIBRARY POLICY: an `initTrack` is resolved in the namespace of the
    // track that REFERENCES it. cf01 §3.2.18 states that resolution for
    // `depends`; §3.2.16 does not say, and a reference that silently crossed
    // namespaces would defeat the identity it belongs to. Keyed by identity,
    // so two same-name init tracks in different namespaces stay distinct.
    const initTracks = new Map<string, { name: string; namespace: readonly string[] }>();
    for (const track of [selected.video, selected.audio]) {
      if (!track?.initTrack) continue;
      const namespace = trackNamespaceFields(track, this.config.namespace);
      initTracks.set(JSON.stringify([namespace, track.initTrack]),
        { name: track.initTrack, namespace });
    }

    for (const { name: initName, namespace: initNamespace } of initTracks.values()) {
      if (!live()) break;

      const nsBytes = initNamespace.map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(initName);
      const initOptions = {
        subscriptionFilter: {
          type: 'AbsoluteStart' as const,
          startGroup: varint(0n),
          startObject: varint(0n),
        },
      };
      // mediaType 'video' is a placeholder — routing is driven by packaging.
      const key = identityKey(initNamespace, initName);
      const reqIdBigInt = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, initOptions, {
        trackName: initName, mediaType: 'video', packaging: 'init',
      }, (id) => { this.initTrackRequestIds.set(key, id); },
      (id) => { if (this.connection === conn && this.initTrackRequestIds.get(key) === id) this.initTrackRequestIds.delete(key); });
      this.log.info('Subscribe init track "%s" requestId=%s', initName, reqIdBigInt);
    }

    // ── Auto-subscribe to eventtimeline (SAP) tracks (§8.2) ────────
    // §8: Eventtimeline tracks provide event metadata for associated media tracks.
    // CMSF §3.6: SAP tracks (eventType "org.ietf.moq.cmsf.sap") provide
    // keyframe locations and earliest presentation times. The player MUST
    // subscribe to SAP tracks linked to subscribed media tracks so the relay
    // knows to begin delivery and so the player can receive SAP metadata.
    // @see draft-ietf-moq-msf-00 §8.2 (Event Timeline Catalog requirements)
    // @see draft-ietf-moq-cmsf-00 §3.6.1 (SAP Type Timeline)
    const eventTimelineTracks = catalog.tracks.filter(
      (t: CatalogTrack) =>
        t.packaging === 'eventtimeline' &&
        dependsOnSelected(t),
    );

    for (const evtTrack of eventTimelineTracks) {
      if (!live()) break;

      const nsBytes = trackNamespaceFields(evtTrack, this.config.namespace).map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(evtTrack.name);
      // Eventtimeline objects are typically small JSON payloads; LargestObject
      // ensures we get recent events without waiting for the next group start.
      const eventTimelineOptions = subscribeOptions ?? { subscriptionFilter: { type: 'LargestObject' as const } };
      const reqIdBigInt = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, eventTimelineOptions, {
        trackName: evtTrack.name, mediaType: 'eventtimeline', packaging: 'eventtimeline',
      });
      this.log.info('Subscribe eventtimeline "%s" (eventType=%s) requestId=%s',
        evtTrack.name, evtTrack.eventType ?? '(none)', reqIdBigInt);
    }

    // LOCMAF event-only tracks (draft-einarsson-moq-locmaf-01 §14): a locmaf track
    // of a non-media role whose chunks carry emsg genBoxes and no samples. Selected
    // like eventtimeline tracks -- by dependence on a selected media track -- and
    // delivered as `locmaf_event` player events rather than media.
    const locmafEventTracks = catalog.tracks.filter(
      (t: CatalogTrack) =>
        t.packaging === 'locmaf' &&
        t.role !== 'video' && t.role !== 'audio' &&
        isTrackPackagingSupported(t) &&
        dependsOnSelected(t),
    );
    for (const evtTrack of locmafEventTracks) {
      if (!live()) break;
      const nsBytes = trackNamespaceFields(evtTrack, this.config.namespace).map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(evtTrack.name);
      const eventOptions = subscribeOptions ?? { subscriptionFilter: { type: 'LargestObject' as const } };
      const reqIdBigInt = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, eventOptions, {
        trackName: evtTrack.name, mediaType: 'eventtimeline', packaging: 'locmaf',
      });
      this.log.info('Subscribe LOCMAF event-only track "%s" (role=%s) requestId=%s',
        evtTrack.name, evtTrack.role ?? '(none)', reqIdBigInt);
    }
  }

  /**
   * Subscribe an auxiliary track (mediatimeline / init / eventtimeline) with
   * PRE-SEND ownership: pending subscription registration happens inside `onRequestId`
   * (post-allocation, pre-emission), so a zero-latency SUBSCRIBE_OK can never
   * beat it (§9.10 alias remap included). Adapters that don't invoke the
   * callback fall back to post-await registration; a send failure AFTER
   * registration rolls the ownership back before the error propagates.
   */
  private async subscribeAuxTrackOwned(
    nsBytes: Uint8Array[],
    nameBytes: Uint8Array,
    options: unknown,
    info: { trackName: string; mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline'; packaging: TrackPackaging },
    onRegistered?: (reqId: bigint) => void,
    onRolledBack?: (reqId: bigint) => void,
  ): Promise<bigint | undefined> {
    const conn = this.connection;
    if (!conn) throw new Error('subscribeAuxTrackOwned: no connection');
    const gen = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState()
      && this.subscriptionManager !== null && this.connection === conn && this.bootstrapGeneration === gen;
    if (!live()) throw new Error('Auxiliary subscription retired before emission');
    if (this.hooks.beforeSubscribe.run({
      trackName: info.trackName, namespace: nsBytes.map(field => new TextDecoder().decode(field)),
      mediaType: info.packaging === 'init' ? 'init' : info.mediaType,
    }) === null) return undefined;
    if (!live()) throw new Error('Auxiliary subscription retired by beforeSubscribe');
    let registered: bigint | null = null;
    const register = (reqId: bigint): void => {
      if (registered !== null) return;
      registered = reqId;
      if (!live()) throw new Error('Auxiliary subscription retired before emission');
      this.pendingAliasBinds.add(reqId);
      this.activeSubscriptions.set(reqId, {
        trackName: info.trackName, mediaType: info.mediaType, trackAlias: null,
        namespace: nsBytes.map(field => new TextDecoder().decode(field)),
      });
      this.pendingMediaSubs.set(reqId, {
        trackName: info.trackName, mediaType: info.mediaType, packaging: info.packaging,
      });
      onRegistered?.(reqId);
    };
    try {
      const reqId = await conn.subscribe(nsBytes, nameBytes,
        { ...((options as object | undefined) ?? {}), ...(info.packaging !== 'init' ? this.mediaTerminalOptions(conn) : {}), onRequestId: (id: bigint) => register(BigInt(id)) } as never);
      if (!live()) {
        if (registered === null) void conn.unsubscribe(varint(BigInt(reqId))).catch(() => { /* best effort */ });
        throw new Error('Auxiliary subscription retired during emission');
      }
      register(BigInt(reqId));
      return BigInt(reqId);
    } catch (err) {
      if (registered !== null) {
        this.retireMediaSubscription(registered, conn);
        onRolledBack?.(registered);
      }
      throw err;
    }
  }

  // buildSubscribeOptions, buildConnectUrl, buildSetupOptions
  // → extracted to player-connect.ts as pure functions

  // ─── Pipeline methods ──────────────────────────────────────

  /**
   * Handle decoder feedback — routes to the correct pipeline.
   *
   * Flow: browser adapter → CommandDispatcher → here → pipeline.handleFeedback()
   *
   * @see draft-ietf-moq-transport-16 §7 (backpressure)
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (drift detection)
   */
  private handleFeedback(fb: DecoderFeedback): void {
    if (fb.mediaType === 'video') {
      if (fb.type === 'queue_pressure' && fb.depth >= fb.maxRecommended) {
        this.lastLocQueuePressureUs = this.clock.now();
        this.locHealthyRenderCount = 0;
      }
      if (fb.type === 'frame_rendered') {
        this.locHealthyRenderCount++;
      }
    }
    const pipeline = fb.mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
    pipeline?.handleFeedback(fb);
  }

  // handlePipelineCommand, handlePipelineEvent, handleRecoveryAction
  // → extracted to player-pipeline.ts as pure functions

  /** @see draft-ietf-moq-loc-01 §4.2 (decode order) */
  private handlePipelineCommand(cmd: DecoderCommand): void {
    const emitEvent = (event: Record<string, unknown>) => {
      // Stats: record decoder milestones
      if (event.command && (event.command as DecoderCommand).type === 'configure') {
        this._stats.recordDecoderConfigured();
      } else if (event.command && (event.command as DecoderCommand).type === 'decode_video') {
        this._stats.recordFrameDecoded();
      }
      this.emitter.emit(event.type as any, event as any);
    };
    doPipelineCommand(cmd, this.config.commandTransform, this.commandDispatcher, this.mediaSource, emitEvent);
  }

  /** @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps) */
  private handlePipelineEvent(mediaType: 'video' | 'audio', evt: PlaybackEvent): void {
    // Stats: record event-level metrics before delegating
    if (evt.type === 'gap_detected') this._stats.recordGapDetected();
    if (evt.type === 'recovery') this._stats.recordRecoveryAction();
    if (evt.type === 'catch_up_changed') this._stats.recordLatency(evt.state.latencyMs);
    if (evt.type === 'partial_group_abandoned' && mediaType === 'video') {
      this.lastLocPartialAbandonUs = this.clock.now();
      this.locHealthyRenderCount = 0;
    }

    doPipelineEvent(mediaType, evt, {
      emitEvent: (event) => this.emitter.emit(event.type as any, event as any),
      log: this.log,
      syncController: this.syncController,
      syncResetThisTick: this.syncResetThisTick,
      setSyncResetThisTick: (v) => { this.syncResetThisTick = v; },
      recordDiagnostic: (kind) => this._stats.recordLocDiagnostic(kind),
      recoveryHook: (action) => {
        const result = this.hooks.onRecovery.run(action);
        if (result) {
          doRecoveryAction(result, mediaType, this.qualityController, this.log, {
            onQualityReduced: (newTrack) => {
              this.selectVideoTrack(newTrack.name, 'recovery', 'downshift').catch((err) => {
                this.log.warn('Quality switch to "%s" failed: %s', newTrack.name, err);
              });
            },
            onResubscribe: (recoveryMediaType, startGroup) => {
              this.requestFreshSubscriptionStart(recoveryMediaType, startGroup);
            },
            onTerminate: (_reason) => {
              if (this.stateMachine.state !== PlayerState.ERROR) {
                this.transitionState(PlayerState.ERROR);
              }
              this.stopTicking();
            },
          });
        }
        return result;
      },
    });
  }

  private requestFreshSubscriptionStart(
    mediaType: 'video' | 'audio',
    startGroup?: bigint,
  ): void {
    if (!this.connection) return;

    const matching = [...this.activeSubscriptions.entries()]
      .filter(([requestId, sub]) => sub.mediaType === mediaType && requestId !== this.timelineRequestId
        && !this.terminalMediaSubscriptions.has(sub));

    for (const [requestId, sub] of matching) {
      this.connection.requestUpdate(varint(requestId), {
        subscriptionFilter: startGroup !== undefined
          ? {
            type: 'AbsoluteStart',
            startGroup: varint(startGroup),
            startObject: varint(0n),
          }
          : { type: 'NextGroupStart' },
      }).then(() => {
        this.log.info(
          'Recovery REQUEST_UPDATE %s "%s" reqId=%s filter=%s',
          mediaType,
          sub.trackName,
          requestId,
          startGroup !== undefined ? `AbsoluteStart(${startGroup})` : 'NextGroupStart',
        );
      }).catch((err: unknown) => {
        const cause = err instanceof Error ? err : new Error(String(err));
        this.log.warn(
          'Recovery REQUEST_UPDATE failed for %s reqId=%s: %s',
          mediaType,
          requestId,
          cause.message,
        );
        this.emitError(createPlayerError(
          'degraded',
          'connection',
          PlayerErrorCode.REQUEST_UPDATE_FAILED,
          `Recovery REQUEST_UPDATE failed: ${cause.message}`,
          { cause, context: { requestId, mediaType } },
        ));
      });
    }
  }

  // ─── Media liveness: starvation detection + restart ladder ──────────

  /**
   * Reconcile the liveness monitor with the live subscription map, then
   * evaluate starvation. Called from tick(); a handful of entries, so no
   * gating needed. Init/catalog/timeline subscriptions are excluded —
   * they deliver one object (or sparse objects) by design.
   */
  private syncAndCheckLiveness(): void {
    const monitor = this.livenessMonitor;
    if (!monitor) return;
    if (this.stateMachine.state !== PlayerState.PLAYING) return;
    monitor.reconcile(this.collectLivenessTracks());
    monitor.check(performance.now());
  }

  /**
   * Stamp a media-object arrival on the liveness monitor. An object can
   * race the first tick's reconcile (subscription registered, no tick yet) —
   * on an unknown alias, reconcile immediately and retry once, so a track
   * that delivers exactly one object before dying is still armed.
   */
  private stampMediaArrival(trackAlias: bigint): void {
    const monitor = this.livenessMonitor;
    if (!monitor) return;
    const nowMs = performance.now();
    if (!monitor.noteArrival(trackAlias, nowMs)) {
      monitor.reconcile(this.collectLivenessTracks());
      monitor.noteArrival(trackAlias, nowMs);
    }
  }

  /** Active video/audio media subscriptions eligible for liveness monitoring. */
  private collectLivenessTracks(): LivenessTrack[] {
    const initRequestIds = new Set(this.initTrackRequestIds.values());
    const out: LivenessTrack[] = [];
    for (const [requestId, sub] of this.activeSubscriptions) {
      if (this.terminalMediaSubscriptions.has(sub)) continue;
      if (sub.mediaType !== 'video' && sub.mediaType !== 'audio') continue;
      if (sub.trackAlias === null) continue;
      if (requestId === this.catalogSlots.catalogRequestId || requestId === this.timelineRequestId) continue;
      if (initRequestIds.has(requestId)) continue;
      out.push({
        requestId,
        trackAlias: sub.trackAlias,
        mediaType: sub.mediaType,
        trackName: sub.trackName,
      });
    }
    return out;
  }

  /**
   * Restart ladder for a starved track. One incident per track at a time.
   *
   * Attempt 1: REQUEST_UPDATE refresh (NextGroupStart) on the existing
   * subscription — but on draft-18 the request stream may have died WITH
   * the delivery path (requestUpdate throws), in which case escalate to a
   * full resubscribe within the same attempt. Attempts ≥2: full
   * resubscribe directly. Bounded by livenessMaxRestarts with exponential
   * backoff; the budget resets after livenessHealthyResetMs of health.
   * Exhausted → fatal MEDIA_STARVED (the application layer reconnects).
   */
  private async handleTrackStarvation(
    track: LivenessTrack,
    starvedForMs: number,
    healthyForMs: number,
  ): Promise<void> {
    const key = `${track.mediaType}:${track.trackName}`;
    let restart = this.livenessRestarts.get(key);
    if (!restart) {
      restart = { attempts: 0, active: false, cancelled: false };
      this.livenessRestarts.set(key, restart);
    }
    if (restart.active) return;

    // A pending video switch already implies a fresh subscription — let it
    // finish (it has its own staging timeout). If the track is still starved
    // afterwards, the monitor fires again.
    if (track.mediaType === 'video' && this.pendingVideoSwitch) return;

    // Budget reset on REAL health: the monitor reports the uninterrupted
    // arrival streak that preceded this starvation — not merely time since
    // the last incident (which would credit a stretch of repeated failures).
    if (restart.attempts > 0 && healthyForMs >= this.config.livenessHealthyResetMs!) {
      restart.attempts = 0;
    }

    restart.active = true;
    restart.cancelled = false;
    this.log.warn('Liveness: %s "%s" starved (%dms without objects) — restarting delivery',
      track.mediaType, track.trackName, Math.round(starvedForMs));
    try {
      const maxAttempts = this.config.livenessMaxRestarts!;
      while (restart.attempts < maxAttempts && this.livenessLadderMayContinue(restart)) {
        const attempt = restart.attempts + 1;
        // Backoff before retries (not before the first attempt — the
        // starvation timeout already waited).
        if (restart.attempts > 0) {
          const backoffMs = this.config.livenessRestartBackoffMs! * 2 ** (restart.attempts - 1);
          await this.livenessSleep(backoffMs, restart);
          if (!this.livenessLadderMayContinue(restart)) return;
        }
        const attemptStartMs = performance.now();
        restart.attempts++;
        this.emitter.emit('recovery_action', {
          type: 'recovery_action',
          action: {
            type: 'track_restart',
            mediaType: track.mediaType,
            trackName: track.trackName,
            attempt,
          },
        });

        this.flushForLivenessRestart(track);
        const refreshed = attempt === 1 && await this.tryRefreshSubscription(track);
        if (!this.livenessLadderMayContinue(restart)) return;
        if (refreshed) {
          this.log.info('Liveness: refreshed %s "%s" via REQUEST_UPDATE (attempt %d)',
            track.mediaType, track.trackName, attempt);
        } else {
          // Refresh unavailable/failed or a later attempt — full resubscribe.
          this.fullResubscribeForLiveness(track);
        }

        // Probe: did delivery resume? (A full resubscribe registers a new
        // requestId — the probe matches by track name, not identity.)
        if (await this.waitForTrackArrival(track, attemptStartMs, this.config.livenessTimeoutMs!, restart)) {
          this.log.info('Liveness: %s "%s" recovered on attempt %d',
            track.mediaType, track.trackName, attempt);
          return;
        }
      }

      if (this.livenessLadderMayContinue(restart)) {
        this.emitError(createPlayerError(
          'fatal', 'connection', PlayerErrorCode.MEDIA_STARVED,
          `Media delivery starved: ${track.mediaType} "${track.trackName}" — ` +
          `${this.config.livenessMaxRestarts} restart attempts failed`,
          { context: { mediaType: track.mediaType, trackName: track.trackName } },
        ));
        if (this.stateMachine.state !== PlayerState.ERROR) {
          this.transitionState(PlayerState.ERROR);
        }
        this.stopTicking();
      }
    } finally {
      restart.active = false;
    }
  }

  /** The ladder stops on cancel (stop/destroy), destroy, or leaving PLAYING. */
  private livenessLadderMayContinue(restart: { cancelled: boolean }): boolean {
    return !restart.cancelled && !this._destroyed
      && this.stateMachine.state === PlayerState.PLAYING;
  }

  /** Cancellation-aware sleep (checks every 250ms). */
  private async livenessSleep(ms: number, restart: { cancelled: boolean }): Promise<void> {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      if (!this.livenessLadderMayContinue(restart)) return;
      const remaining = deadline - performance.now();
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, remaining))));
    }
  }

  /** Poll for a post-restart arrival on the track (by name — identity may change). */
  private async waitForTrackArrival(
    track: LivenessTrack,
    sinceMs: number,
    timeoutMs: number,
    restart: { cancelled: boolean },
  ): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    const pollMs = Math.min(250, Math.max(10, timeoutMs / 5));
    // Arrival is checked AFTER each sleep too — an object landing between
    // the final poll and the deadline must count as recovery.
    for (;;) {
      if (!this.livenessLadderMayContinue(restart)) return false;
      const last = this.livenessMonitor?.lastArrivalForTrack(track.trackName, track.mediaType);
      if (last !== undefined && last > sinceMs) return true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
    }
  }

  /**
   * Flush stale per-path state before a delivery restart, so the restart
   * never resubscribes against a dirty decoder/assembler (the verified gap
   * where recovery only flushed if a stall happened to fire first).
   */
  private flushForLivenessRestart(track: LivenessTrack): void {
    const catalogTrack = this._catalogState?.tracks.find((t: CatalogTrack) => t.name === track.trackName);
    // LOCMAF on either path: drop the in-group reference; the restarted delivery begins at a full header.
    if (catalogTrack?.packaging === 'locmaf') {
      this.locmafDecoders.get(this.mediaKey(track.trackName, track.mediaType, track.trackAlias))?.reset();
      this.locmafFrameIds.delete(this.mediaKey(track.trackName, track.mediaType, track.trackAlias));
    }
    if (this.usesMse(catalogTrack?.packaging)) {
      // CMAF bypasses the LOC pipelines: re-arm the wait-for-keyframe gate
      // (post-restart mid-group deltas must be dropped, as on init) and drop
      // any stranded moof half-pair so it can't mispair after the restart.
      // The MSE buffer itself is NOT flushed — eviction/quota policy governs
      // it, and the live-edge chase follows the post-restart PTS jump.
      if (track.mediaType === 'video') this.cmafVideoSynced = false;
      this.cmafAssembler?.clearPending?.(track.mediaType);
      return;
    }
    // LOC: flush pipeline + sync. Video also gates out stale in-flight
    // groups (same idiom as the stall path) so pre-restart objects that
    // straggle in don't replay old content.
    if (track.mediaType === 'video') {
      const minFreshGroup = (this.videoPipeline?.currentGroupId ?? -1n) + 1n;
      this.videoPipeline?.reset(minFreshGroup);
    } else {
      this.audioPipeline?.reset();
    }
    this.syncController?.reset();
  }

  /**
   * Attempt a REQUEST_UPDATE refresh (NextGroupStart) on the track's
   * existing subscription(s). Returns false when there is nothing to
   * refresh or the update fails — e.g. draft-18 throws when the
   * subscription's request stream died with the delivery path (§9.11).
   */
  private async tryRefreshSubscription(track: LivenessTrack): Promise<boolean> {
    if (!this.connection) return false;
    const matching = [...this.activeSubscriptions.entries()].filter(([, sub]) =>
      sub.trackName === track.trackName && sub.mediaType === track.mediaType && !this.terminalMediaSubscriptions.has(sub));
    if (matching.length === 0) return false;
    try {
      for (const [requestId] of matching) {
        await this.connection.requestUpdate(varint(requestId), {
          subscriptionFilter: { type: 'NextGroupStart' },
        });
      }
      return true;
    } catch (err) {
      this.log.warn('Liveness: REQUEST_UPDATE refresh failed for %s "%s" (%s) — escalating to resubscribe',
        track.mediaType, track.trackName, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Tear down the (presumed dead) subscription and create a fresh one.
   * Reuses the PUBLISH_DONE resubscribe machinery for the new SUBSCRIBE +
   * pipeline reset; outcome is observed by the caller's arrival probe.
   */
  private fullResubscribeForLiveness(track: LivenessTrack): void {
    if (!this.connection || !this.subscriptionManager) return;
    const issued = this.activeSubscriptions.get(track.requestId);
    if (issued && this.terminalMediaSubscriptions.has(issued)) return;
    const catalogTrack = issued === undefined ? undefined : this.catalogTrackFor(track.trackName,
      issued.namespace ?? namespaceFields(this.config.namespace), track.mediaType);
    for (const [requestId, sub] of [...this.activeSubscriptions.entries()]) {
      if (sub.trackName !== track.trackName || sub.mediaType !== track.mediaType
        || (issued !== undefined && !sameNamespaceFields(
          sub.namespace ?? namespaceFields(this.config.namespace),
          issued.namespace ?? namespaceFields(this.config.namespace)))) continue;
      this.retireMediaSubscription(requestId, this.connection);
      // Async — a sync try/catch would let the rejection escape. Best-effort:
      // the request stream may have died with the delivery path.
      void this.connection.unsubscribe(varint(requestId)).catch(() => { /* gone */ });
    }
    this.replaceSubscription(track.trackName, 'liveness', catalogTrack);
  }

  /**
   * Replace a track's subscription with a fresh one.
   *
   * Shared by two unrelated causes, which must stay distinguishable to an
   * application: a publisher-signalled PUBLISH_DONE with a retriable status,
   * and a locally-detected liveness incident. Only the former publishes
   * `track_resubscribe`; the liveness ladder publishes its own
   * `track_restart`, and attributing a local incident to peer backpressure
   * would defeat the point of the event.
   *
   * @see draft-ietf-moq-transport-16 §9.15, §13.4.3
   */
  private replaceSubscription(
    trackName: string,
    cause: 'too_far_behind' | 'liveness',
    issuedTrack?: CatalogTrack,
  ): void {
    if (!this.connection || !this.subscriptionManager || !this._catalogState) return;
    const operationConn = this.connection;
    const generation = this.bootstrapGeneration;
    const live = (): boolean => this.connection === operationConn && this.bootstrapGeneration === generation
      && !this._destroyed && !this.isTerminalState() && this.subscriptionManager !== null;

    // Don't resurrect the OLD track during a make-before-break switch —
    // that would fight the switch by resubscribing to a track we're
    // intentionally abandoning.
    if (this.pendingVideoSwitch?.oldTrackName === trackName) {
      this.log.info('Ignoring %s replacement for "%s" — pending switch to "%s"',
        cause, trackName, this.pendingVideoSwitch.newTrackName);
      return;
    }

    const matches = this._catalogState.tracks.filter(t => t.name === trackName);
    const track = issuedTrack ?? (matches.length === 1 ? matches[0] : undefined);
    if (!track) {
      this.log.warn('Cannot resubscribe "%s": track not found in catalog', trackName);
      return;
    }

    const mediaType: 'video' | 'audio' = track.role === 'audio' ? 'audio' : 'video';
    const packaging = mediaTrackPackaging(track.packaging);
    const isLive = track.isLive === true;

    // Reset pipeline + sync to prepare for fresh data.
    // Audio resubscribe MUST reset sync — the new subscription will
    // deliver from a different live-edge position, so the old audio
    // reference (which anchors A/V sync) is stale.
    if (mediaType === 'video') {
      this.videoPipeline?.reset();
    } else {
      this.audioPipeline?.reset();
    }
    this.syncController?.reset();

    const ns = trackNamespaceFields(track, this.config.namespace);
    if (this.hooks.beforeSubscribe.run({ trackName, mediaType, namespace: ns }) === null) return;
    if (!live()) return;
    const nsBytes = ns.map(field => this.enc.encode(field));
    const nameBytes = this.enc.encode(trackName);
    const filter = defaultMediaSubscriptionFilter(isLive);

    // Pre-send ownership (§9.10): a same-tick SUBSCRIBE_OK must find the
    // pending entry; the EVENT still waits for the send to succeed.
    const resubConn = operationConn;
    let resubRegisteredId: bigint | null = null;
    const registerResub = (id: bigint): void => {
      if (resubRegisteredId !== null) return;
      resubRegisteredId = id;
      if (!live()) throw new Error('Recovery subscription retired before emission');
      this.pendingAliasBinds.add(id);
      this.activeSubscriptions.set(id, { trackName, mediaType, trackAlias: null, namespace: ns });
      this.pendingMediaSubs.set(id, { trackName, mediaType, packaging });
    };
    // Start through the CAPTURED connection and attach both observers before
    // publishing: a recovery listener may synchronously destroy or migrate the
    // player, and `this.connection` is mutable. Announcing afterwards also
    // makes the event's contract true — the replacement has really started.
    const pending = resubConn.subscribe(nsBytes, nameBytes,
      { ...(filter ?? {}), ...this.mediaTerminalOptions(resubConn), onRequestId: (id: bigint) => registerResub(BigInt(id)) } as never,
    ).then((reqId) => {
      const reqIdBigInt = BigInt(reqId);
      if (!live()) return;
      registerResub(reqIdBigInt);

      this.log.info('Resubscribed %s "%s" requestId=%s after %s',
        mediaType, trackName, reqIdBigInt, cause);
      this.emitter.emit('track_subscribed', {
        type: 'track_subscribed',
        trackName,
        mediaType,
        requestId: reqIdBigInt,
      });
    }).catch((err: unknown) => {
      if (resubRegisteredId !== null) {
        this.retireMediaSubscription(resubRegisteredId, resubConn);
      }
      const failure = err instanceof Error ? err : new Error(String(err));
      this.log.warn('Resubscribe "%s" failed: %s', trackName, failure.message);
      this.emitError(createPlayerError(
        'degraded', 'connection', PlayerErrorCode.CONNECTION_LOST,
        `Resubscribe after ${cause} failed: ${failure.message}`,
        { cause: failure, context: { trackName, mediaType, cause } },
      ));
      this.emitter.emit('track_unsubscribed', {
        type: 'track_unsubscribed',
        trackName,
        reason: `${cause} resubscribe failed: ${failure.message}`,
      });
    });

    // Now that the replacement exists and its outcome is observed, announce it.
    if (cause === 'too_far_behind') {
      this.emitter.emit('recovery_action', {
        type: 'recovery_action',
        action: { type: 'track_resubscribe', trigger: 'too_far_behind', trackName, mediaType },
      });
    }
    void pending;
  }

  /** Start pipeline tick interval (~60fps). */
  private startTicking(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), 16);
  }

  /** Stop pipeline tick interval. */
  private stopTicking(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * Handle malformed track detection.
   *
   * §2.4.2: "When a subscriber detects a Malformed Track, it MUST
   * UNSUBSCRIBE any subscription [...] for that Track from that publisher,
   * and SHOULD deliver an error to the application."
   *
   * @see draft-ietf-moq-transport-16 §2.4.2
   */
  private handleMalformedTrack(trackAlias: bigint, trackName: string, error: Error, sourceConnection?: MoqtConnection): void {
    this.log.warn('Malformed track "%s": %s', trackName, error.message);
    // A malformed object from a SUPERSEDED session (migration overlap: not the
    // current connection) must not drive recovery against the current session.
    // `this.connection`, `activeSubscriptions`, and the shared track
    // registrations all belong to the NEW session now — its requestId space is
    // unrelated, so UNSUBSCRIBE/unregister here would cancel a live new-session
    // request or drop a valid track. The superseded session is already closing;
    // let its bad track die with it. Log only.
    if (sourceConnection !== undefined && sourceConnection !== this.connection) {
      this.log.info('Ignoring malformed object from a superseded session for track "%s"', trackName);
      return;
    }

    // A malformed switch TARGET must abort the pending switch: otherwise its
    // staging timeout later "completes" the switch and unsubscribes the old,
    // working track, or the switch stays pending forever.
    const pendingSwitch = this.pendingVideoSwitch;
    if (pendingSwitch && pendingSwitch.newTrackName === trackName) {
      this.abortPendingVideoSwitch(pendingSwitch, error);
    }

    // Find the requestId for this track alias in activeSubscriptions
    let matchedRequestId: bigint | undefined;
    for (const [requestId, sub] of this.activeSubscriptions) {
      if (sub.trackAlias === trackAlias) {
        matchedRequestId = requestId;
        break;
      }
    }

    if (matchedRequestId !== undefined) {
      // §2.4.2 MUST: UNSUBSCRIBE
      if (this.connection) this.retireMediaSubscription(matchedRequestId, this.connection);
      this.connection?.unsubscribe(varint(matchedRequestId));

      // §2.4.2 SHOULD: deliver error to application
      this.emitter.emit('track_unsubscribed', {
        type: 'track_unsubscribed',
        trackName,
        reason: `Malformed track: ${error.message}`,
      });
    }
  }

  /** Create a default MoqtConnection. Placeholder for real WebTransport. */
  private createDefaultConnection(): MoqtConnection {
    // In production, this would create a real MoqtConnection with WebTransport.
    // For now, throw — users must provide createConnection in config.
    throw new Error(
      'No createConnection provided in config. ' +
      'Provide a factory function or use a default browser adapter.',
    );
  }
}
