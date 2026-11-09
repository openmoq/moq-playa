import { parseLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import type { MediaSeekResource, MediaSeekSample } from './interfaces.js';
import { nativeTimeUs, nativeRangeMayReachBoundary } from './presentation-placement.js';
import { PlaybackPosition } from './playback-position.js';
import { MseSeekPlayback, type SeekTrack, type SeekRoleCandidate, type SeekRoleCutHold, type MseSeekAdoption, type CmafAppendObservation } from './mse-seek-playback.js';
import { selectSeekQualityCut, selectFrameQualityCut } from './seek-fetch-pages.js';
import type { SeekFetchRequests } from './seek-fetch-requests.js';
import type { SeekLiveBridge } from './seek-live-bridge.js';
import type { SeekCmafTimingObservation } from './seek-cmaf-input.js';
import { SeekRoleRetrieval, type SeekRoleBridgeOwner, type SeekRetrievalTrack } from './seek-role-retrieval.js';
import { LocSeekPlayback, locSeekTrackContext, type LocSeekTrack, type LocSeekResume, type LocVideoRoleCandidate, type LocVideoRoleTrack } from './loc-seek-playback.js';
import type { PreparedFramePipelines } from './player-frame-output.js';
import { locmafPlaybackSamples } from './locmaf-playback-samples.js';
import { LocGroupCadence } from './loc-group-cadence.js';
import { ReceivedPayloadRate } from './received-payload-rate.js';
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
import { varint, PublishDoneCode, PublishDoneCode18, RequestError, ObjectStatus, SessionState } from '@openmoq/transport';
import { CatalogBootstrap } from './catalog-bootstrap.js';
import type { CatalogObjectEvent, PublishDoneReason } from './catalog-bootstrap.js';
import { MoqtConnectionError } from '@openmoq/webtransport';
import type { DataStreamTerminal, ObjectReceipt, GoawayNotice, MoqtConnection, WebTransportLike, MoqtConnectionErrorSource } from '@openmoq/webtransport';
import type { DataStreamHeader, MoqtObject, ObjectDatagram, SubgroupHeader } from '@openmoq/transport';
import { getSubgroupIdMode, SubgroupIdMode } from '@openmoq/transport';
import { PlaybackPipeline, SyncController, DeliveryLagDetector, isKeyframePayload } from '@openmoq/playback';
import { BufferBasedController } from '@openmoq/playback';
import type { ClockSource, DecoderCommand, PlaybackEvent, RecoveryAction, RecoveryController, DecoderFeedback, PlaybackInputObserver, AudioTimingSource, VideoTimingSource, PlaybackSample } from '@openmoq/playback';
import type { AltGroup, CatalogState, CatalogTrack, ResolvedTrackNamespace } from '@openmoq/msf';
import type { SelectionIntent, TrackIdentity } from './catalog-selection.js';
import { buildCatalogSelection, resolveSelection } from './catalog-selection.js';
import { composeSelection } from './selection-composition.js';
import { selectionIntentFromConfig } from './configured-selection.js';
import type { LocHeaders } from '@openmoq/loc';
import { LocmafFormatError, LocmafTrackDecoder, deserializeLocmafObject, readVi64, LocmafFrameReader, LocmafFrameReadError, LocmafReadLimitError, codecDescriptionFromInit, isCmafHeader, isSyncSampleFlags, readCmafChunkSamples, parseLocmafTrackContext, parseEmsgBoxes } from '@openmoq/locmaf';
import type { LocmafFrameHeader, EmsgEvent, LocmafEffectiveSamples, GenBox, LocmafTrackContext } from '@openmoq/locmaf';
import { groupByAlt, parseSapTimeline, parseEventTimeline, parseMediaTimeline, CMSF_SAP_EVENT_TYPE, isTrackPackagingSupported,
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
  type TrackRefConfig,
  type SelectionConfig,
} from './config.js';
import { createPlayerError, PlayerErrorCode, type PlayerError, type ErrorSeverity, type PlayerErrorCodeValue } from './errors.js';
import { createLogger, LOG_LEVELS, type LoggerLike } from './logger.js';
import { checkSupport as detectSupport } from './support.js';
import type { SupportReport } from './support.js';
import { CatalogManager } from './catalog-manager.js';
import { QualityController } from './quality-controller.js';
import { prepareHandoverSelection, type HandoverIntent } from './player-handover-selection.js';
import { acceptPreparedMedia, checkPreparedMediaReady, createPreparedMediaSelection, type PreparedMediaSelection } from './prepared-media-selection.js';
import type { InstalledDecoderConfiguration, PreparedDecoderConfiguration } from './prepared-decoder-configuration.js';
import { PreparedAudioEvidence } from './prepared-audio-evidence.js';
import { PreparedOutputEvidence } from './prepared-output-evidence.js';
import { prepareRuntimeSelection, type RuntimeSelection } from './player-runtime-selection.js';
import { placePresentationAnchor, type FractionUs, type PresentationPlacement } from './presentation-placement.js';
import { preflightMseOutputs, type PreparedMseOutput } from './prepared-mse-output.js';
import { copyMediaSelection, emptyMediaSelection, type MediaSelectionSnapshot, type AudioSelectionOptions, type AudioTimelineReference, type MediaSelectionOptions, type MediaTimelineReference } from './player-selection-state.js';
import { MediaStageObservers } from './media-stage-observers.js';
import type { MediaDiagnosticRuntime, MediaDiagnosticsFactory, MediaStageObserver, MediaDiscardReason } from './media-diagnostic-types.js';
import type { ObjectRoutingContext, ObjectRoutingDiscardReason, ObjectDeliveryAdmission, ObjectDeliveryOptions } from './subscription-manager.js';
import { SubscriptionManager, type TrackPackaging } from './subscription-manager.js';
import { WarmStartHead } from './warm-start-head.js';

interface LivenessRestart {
  attempts: number;
  active: boolean;
  cancelled: boolean;
  readonly connection: MoqtConnection;
  readonly namespace: readonly string[];
  readonly mediaType: 'video' | 'audio';
  readonly trackName: string;
  readonly ownsOutput: () => boolean;
  requestId: bigint;
  refusal: { retryInterval: bigint | null; atMs: number } | null;
  failure: string | null;
}

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
  readonly prefixStart?: { readonly group: bigint; readonly object: bigint };
  prefixCancelled?: boolean;
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
import type { MediaSourceLike, MediaAppendQueueLease, MediaSwitchRecovery, VideoPresentation, AudioOutputLike } from './interfaces.js';
import { CommandDispatcher, type DispatcherOutputObserver } from './command-dispatcher.js';
import { StatsAccumulator } from './stats.js';
import type { PlayerStats, VideoEncodeObservation } from './stats.js';
import type { CmafAssemblerLike, CmafSourceReceipt } from './interfaces.js';
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
  findEncodeAnchor,
  mergeTimelineEntries,
  findSeekTarget,
  getTimelineDuration,
  type TimelineState,
} from './timeline-manager.js';
import { isDraft22, isRequestStreamDraft } from '@openmoq/transport';

// ─── Constants ──────────────────────────────────────────────────────

/** Object limit for a make-before-break video's retained input. */
const SWITCH_STAGING_MAX_OBJECTS = 100;

/** Subscriber priority a SUBSCRIBE without the parameter is treated as (the transport codecs' default). */
const DEFAULT_SUBSCRIBER_PRIORITY = 128;

/** draft-22 FILL_PARAMETERS for joining the current group: a LOCATION_FILTER
 *  of [1] (the current group: Largest.Group + 1 - 1), the
 *  counterpart of a relative Joining FETCH at offset 0. */
const CURRENT_GROUP_FILL = { filter: { type: 'RelativeStart' as const, groups: 1n } };
const CATALOG_FILL = CURRENT_GROUP_FILL;

/** Max time (ms) to wait for a keyframe during make-before-break switch. */
const SWITCH_STAGING_TIMEOUT_MS = 3_000;
/** Leave a wall-clock reserve before prepared historical video exhausts its native coast. */
const HISTORICAL_SWITCH_RESERVE_MS = 100;

/** One current route's receiving admission; no payload or group history. */
interface ReceivingVideoOwner {
  readonly token: object;
  readonly alias: bigint;
  readonly trackName: string;
  readonly sourceKey?: string;
  readonly manager: SubscriptionManager;
  readonly source: MediaSourceLike;
  readonly connection: MoqtConnection;
  readonly retain: NonNullable<MediaSourceLike['retainReceivingGroup']>;
  readonly isCurrent: () => boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

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

/** Keep deferred stream release handles independent of their route's closure. */
function streamRelease(release: () => void): () => void {
  return () => { try { release(); } catch { /* Stream retirement must still finish. */ } };
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
  closing?: Promise<void>;
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

/** A source-bound handover intent also owns terminal evidence while media settles. */
type PendingGoaway = Pick<MigrationTxn, 'oldTerminal'> & {
  readonly uri: string;
  readonly sourceConnection: MoqtConnection;
};

/** Media preparation is shared by session replacement and same-session selection. */
type PreparedMediaAttempt = Pick<MigrationTxn, 'conn' | 'aborted' | 'committed'> & { prep?: PreparedMediaSelection };

interface AudioPresentationMapper { setAudioPresentationOffsetUs(offsetUs: bigint | null): void }
interface AudioTimingSink { setAudioTimingSource(source: AudioTimingSource | undefined): void }

interface SourceTimelineRecord {
  reference: Omit<MediaTimelineReference, 'observedSourceTimeUs'>;
  observedSourceTimeUs: bigint;
  configuration: readonly unknown[];
  connection: MoqtConnection;
  authority: object | null;
  epoch: bigint | null;
  mappingWitness: object | null;
  placementToken: object | null;
  source: MediaSourceLike | null;
  nativeOffset: number | undefined;
  clockAnchorUs: bigint;
  clockScheduleUs: number | null;
}

interface PreparedMsePlacement {
  readonly assembler: CmafAssemblerLike;
  readonly referenceRole: 'video' | 'audio';
  readonly reference: PresentationPlacement;
  readonly oldPlacementToken: object;
  readonly referenceOffset: number;
  readonly targetOffset: number;
  readonly sourceKey: string;
  readonly anchor: { readonly sourceTimeUs: bigint; readonly rebasedTimeUs: FractionUs };
}

interface PreparedMediaOutput {
  readonly role: 'video' | 'audio';
  readonly target: CatalogTrack;
  readonly oldRequestId: bigint | null;
  readonly oldSubscription: object | null;
  readonly oldIdentity: TrackIdentity;
  /** Adopted output ownership survives normal wire drain, without recreating a route. */
  readonly oldIsCurrent: () => boolean;
  readonly mse?: PreparedMsePlacement;
  readonly timing: {
    presentationOffsetUs: bigint;
    readonly liveOutput: AudioOutputLike | null;
    readonly mappedTiming: boolean;
    readonly presentationMapper: AudioPresentationMapper | null;
    readonly timingSink: AudioTimingSink | null;
    timingSource: AudioTimingSource | undefined;
    videoTimingSource?: VideoTimingSource;
  };
  readonly evidence: PreparedAudioEvidence;
  init?: Uint8Array;
  readonly staged: Array<{ obj: MoqtObject; headers?: LocHeaders; input?: ObjectRoutingContext; sourceTimeUs?: bigint; run(): void }>;
  serial: Promise<void>;
  checked: number;
}

interface MediaSelectionTxn extends PreparedMediaAttempt {
  readonly prep: PreparedMediaSelection;
  readonly manager: SubscriptionManager;
  readonly source: MediaSourceLike | null;
  readonly generation: number;
  readonly catalog: CatalogState;
  readonly outputs: Map<'video' | 'audio', PreparedMediaOutput>;
  readonly referenceToken: object | null;
  readonly selection?: Extract<RuntimeSelection, { ok: true }>;
  readonly audioPin?: boolean;
  readonly audioLanguage?: string | null;
  readonly referenceRole?: 'video' | 'audio';
  readonly registrations: Map<bigint, () => boolean>;
  mutation?: Promise<void>;
  readonly rawInputs: WeakSet<object>;
  readonly releasedRequests: Set<bigint>;
  readonly terminalRequests: Set<bigint>;
  retainedBytes: number;
  inputCount: number;
  failure?: Error;
  cancel(): void;
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
interface CandidatePrep extends PreparedMediaSelection {
  /** Resolves when the candidate's catalog CONVERGED through its own
   *  configured retrieval policy (legacy subscribe, joining FETCH, or a
   *  draft-22 fill), rejects when that retrieval failed. */
  readonly catalog: Promise<CatalogState>;
  resolveCatalog(state: CatalogState): void;
  rejectCatalog(err: Error): void;
  /** The converged catalog, and any pre-adoption delta applied to it. */
  state: CatalogState | null;
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


type SeekRole = 'video' | 'audio';
type CadenceObject = Pick<MoqtObject, 'kind' | 'trackAlias' | 'groupId' | 'objectId'> & { readonly payloadBytes?: number };

type SeekRoleConsumer = Pick<SeekRoleCandidate, 'beginPage' | 'acceptPage' | 'beginLive'>;

type SeekRoleFailure = ConstructorParameters<typeof SeekRoleRetrieval>[0]['onFailure'];

interface MseSeekAttempt {
  readonly epoch: object;
  readonly connection: MoqtConnection;
  readonly source: MediaSourceLike;
  readonly playback: MseSeekPlayback;
  readonly retrievals: Map<SeekRole, SeekRoleRetrieval>;
  readonly tracks: Map<SeekRole, SeekTrack>;
  readonly preparingRetrievals: Set<SeekRoleRetrieval>;
  readonly retiringRoles: Set<SeekRole>;
  readonly createRetrieval: (track: SeekTrack, location: { groupId: bigint; objectId: bigint }, consumer: SeekRoleConsumer,
    isCurrent: () => boolean, onFailure: SeekRoleFailure, getPreparingGroup?: () => bigint | null) => SeekRoleRetrieval;
  readonly bridges: Set<SeekRoleBridgeOwner>;
  readonly roles: readonly ('video' | 'audio')[];
  videoSelection: { readonly selection: object; readonly key: string } | null;
  readonly ended: Set<'video' | 'audio'>;
  readonly pump: () => void;
  /** Ended input leaves its adopted media graph available for a later selection. */
  completion: object | null;
  committed: boolean;
  positioned: boolean;
  retired: boolean;
}


interface LocSeekAttempt {
  readonly epoch: object;
  readonly reason: 'seek' | 'resume' | 'quality';
  readonly quality?: LocSeekQuality;
  readonly tracks: SeekRetrievalTrack[];
  readonly preparingRetrievals: Set<SeekRoleRetrieval>;
  initialDispatcher: CommandDispatcher | null;
  readonly connection: MoqtConnection;
  readonly timelineSource: object;
  readonly playback: LocSeekPlayback;
  readonly retrievals: Map<'video' | 'audio', SeekRoleRetrieval>;
  readonly bridges: Set<SeekRoleBridgeOwner>;
  output: PreparedFramePipelines | null;
  videoOutput: PreparedFramePipelines | null;
  positioned: boolean;
  retired: boolean;
}


interface LocSeekQuality {
  readonly pending: boolean;
  preparation: { readonly previous: LocSeekAttempt; readonly track: CatalogTrack; readonly validate: () => void } | null;
  readonly fromTrackName: string;
  readonly toTrackName: string;
  readonly reason: string;
  readonly settle: (error?: Error) => boolean;
}

type LocSeekOperation = { readonly admission: object; readonly reason: 'resume'; readonly resume?: LocSeekResume }
  | { readonly admission: object; readonly reason: 'quality'; readonly quality: LocSeekQuality };


function createLocSeekQuality(fromTrackName: string, toTrackName: string, reason: string) {
  let pending = true, resolve: (() => void) | undefined, reject: ((error: Error) => void) | undefined;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void done.catch(() => {});
  const quality: LocSeekQuality = { preparation: null, fromTrackName, toTrackName, reason,
    get pending() { return pending; },
    settle(error) {
      if (!pending) return false;
      pending = false;
      const yes = resolve, no = reject; resolve = undefined; reject = undefined;
      if (error) no!(error); else yes!();
      return true;
    } };
  return { quality, done };
}
export class MoqtPlayer {
  /** Player version (set at build time). */
  static readonly version = '0.6.1';

  private readonly config: MoqtPlayerConfig & { readonly catalogTrackName: string };
  private readonly emitter = new TypedEmitter<PlayerEventMap>();
  private _selection: MediaSelectionSnapshot = emptyMediaSelection();
  private readonly selectedOutputOwners = new Map<'video' | 'audio', { selection: object; key: string }>();
  private mediaStageObservers: MediaStageObservers | undefined;
  private mediaDiagnosticRuntime: MediaDiagnosticRuntime | undefined;
  private mediaDiagnosticEpoch: object | undefined;
  private retiringLocDiagnosticGraphs: Set<PreparedFramePipelines> | undefined;
  private locDiagnosticBindings: {
    readonly runtime: MediaDiagnosticRuntime;
    pipelines: PlaybackPipeline[];
    dispatchers: CommandDispatcher[];
    readonly input: PlaybackInputObserver;
    readonly output: DispatcherOutputObserver;
    refused: number;
  } | undefined;
  private destroyObservers: Set<() => void> | undefined;
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
  private videoMeasurementMode: object = {};
  private videoPayloadMeasurement: {
    owner: ({ readonly kind: 'ordinary' } | {
      readonly kind: 'seek-live'; readonly attempt: LocSeekAttempt | MseSeekAttempt;
      readonly bridgeOwner: SeekRoleBridgeOwner; readonly track: SeekRetrievalTrack;
      readonly epoch: object; readonly selection: object; readonly configuration: object | undefined;
    }) & {
      connection: MoqtConnection; manager: SubscriptionManager; generation: object;
      requestId: bigint; alias: bigint; subscription: object; sourceKey: string;
      output: object | undefined; pipeline: PlaybackPipeline | null;
      source: MediaSourceLike | null; assembler: CmafAssemblerLike | null;
      automatic: boolean; mode: object; frameReader: object | undefined; decoder: object | undefined; header: Uint8Array | undefined; route: () => boolean;
    };
    rate: ReceivedPayloadRate;
  } | null = null;
  private videoEncodeRecord: {
    readonly observation: VideoEncodeObservation;
    readonly current: () => boolean;
    readonly captured?: () => boolean;
  } | null = null;
  private videoDeliveryLag: {
    readonly owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'];
    readonly timescale: bigint | null;
    readonly placementToken?: object;
    readonly sourceOriginUs: bigint;
    readonly arrivalOriginUs: number;
    readonly detector: DeliveryLagDetector;
    lastAttemptUs: number | null;
  } | null = null;
  private evaluatingBandwidth = false;
  private bufferAbrController: BufferBasedController | null = null;
  private readonly cadenceInputOwners = new WeakMap<object, NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner']>();
  private readonly seekCmafInputs = new WeakMap<ObjectReceipt, {
    readonly owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner']; readonly authority: object;
  }>();
  private readonly seekCmafObservations = new WeakMap<MoqtObject, {
    readonly owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner']; readonly authority: object;
  }>();
  private readonly seekCadenceInputs = new WeakMap<ObjectReceipt, {
    readonly object: CadenceObject;
    readonly owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'];
    readonly headers: LocHeaders;
  }>();
  private videoGroupCadence: {
    owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'];
    cadence: LocGroupCadence;
  } | null = null;
  /** Group-count buffer depth remains an approximation, with a two-second fallback. */
  private get estimatedGopDurationUs(): number {
    const current = this.videoGroupCadence;
    if (current && this.sameVideoMeasurementOwner(current.owner, this.captureVideoMeasurementOwner())) {
      return current.cadence.durationUs ?? 2_000_000;
    }
    this.videoGroupCadence = null;
    return 2_000_000;
  }
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
   * Bounded live frame readers own reconstruction by resolved track. Each
   * carrier keeps its original wire Location and admits one typed sample batch;
   * the Header belongs to that reader's current reconstruction lifetime.
   */
  private locmafFrameReaders = new Map<string, { reader: LocmafFrameReader; header: LocmafFrameHeader | null }>();
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
  private keyedCmafIdentity = false;

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
  private mediaSelection: MediaSelectionTxn | null = null;
  private runtimeAudioIntent: TrackIdentity | null = null;
  private runtimeAudioLanguage: string | null = null;
  private runtimeSelectionIntent: SelectionIntent | null = null;
  private readonly preparedMediaDeliveries = new WeakMap<object, { preparation: MediaSelectionTxn; output: PreparedMediaOutput; alias: bigint }>();
  private audioPresentationOffsetUs = 0n;
  private audioTimingMapped = false;
  private audioTimingSource: AudioTimingSource | undefined;
  private videoPresentationOffsetUs = 0n;
  private videoTimingMapped = false;
  private videoTimingSource: VideoTimingSource | undefined;
  private mappedClockOwner: object | null = null;
  private audioOutput: AudioOutputLike | null = null;
  private lastAudioDomainOwner: object | null = null;
  private lastAudioDomain: AudioTimelineReference['domain'] | null = null;
  private readonly installedDecoderConfigurations = new Map<'video' | 'audio', InstalledDecoderConfiguration>();
  private readonly decoderConfigurationCommands = new Map<'video' | 'audio', object>();
  private readonly preparedDecoderConfigurations = new Map<'video' | 'audio', PreparedDecoderConfiguration>();
  private audioTimelineRecord: SourceTimelineRecord | null = null;
  private videoTimelineRecord: SourceTimelineRecord | null = null;
  private collectAudioTimeline = false;
  private collectVideoTimeline = false;

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
  private pendingGoaway: PendingGoaway | null = null;
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

  /** The media source's permission to cross the hole a live restart leaves, held for one switch. */
  private videoSwitchRecovery: { readonly owner: object; readonly handle: MediaSwitchRecovery } | null = null;

  /**
   * Pending track switch — defers old subscription teardown until the
   * new track's keyframe is ready (make-before-break switching).
   * @see draft-ietf-moq-msf-00 §4.2 (clean switch at group boundaries)
   */
  private pendingVideoSwitch: {
    connection: MoqtConnection;
    generation: number;
    mediaSource: MediaSourceLike | null;
    oldRequestId: bigint | null;
    historical?: { readonly attempt: MseSeekAttempt; readonly cancel: () => void; readonly checkCoast: () => void };
    frame?: { readonly attempt: LocSeekAttempt; readonly cancel: () => void; readonly cancelPending: () => void };
    deadlineMs?: number | undefined;
    oldTrackName: string;
    oldSourceKey?: string;
    newTrackName: string;
    newSourceKey?: string;
    /** History retrieval failed; the target restarts on its next independent live Object. */
    liveRestart?: boolean;
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
    stagedSamples: number;
    done: Promise<void>;
    settle(): void;
    /** Carried from `selectVideoTrack` so commit/abort events report it. */
    reason: string;
    /** ABR direction — set by ABR/recovery paths for deferred commit. */
    abrAction?: 'downshift' | 'upshift';
  } | null = null;

  /**
   * Staging buffer for new-track objects during make-before-break switch.
   * Objects accumulate here until an independent frame carrier arrives,
   * then are fed to the pipeline in order on switch completion. Typed LOCMAF
   * batches retain their original Object rather than renumbering samples.
   * LOC pipeline path.
   */
  private switchStagingBuffer: Array<{ obj: MoqtObject; headers: LocHeaders | undefined; samples?: readonly PlaybackSample[]; input?: ObjectRoutingContext }> = [];

  /**
   * Staging buffer for new-track CMAF objects during make-before-break.
   * Without this, both old- and new-track segments hit MSE during the
   * overlap window — the resulting splice churn evicts decoder reference
   * frames and only keyframes from the new track decode.
   */
  private cmafSwitchStagingBuffer: Array<{
    trackName: string;
    sourceKey?: string;
    mediaType: 'video' | 'audio';
    groupId: bigint;
    objectId?: bigint;
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
  private readonly subgroupStreams = new Map<bigint, {
    connection: MoqtConnection; trackAlias: bigint; groupId: bigint;
    receivingRegistration?: { manager: SubscriptionManager; isCurrent: () => boolean };
    receivingOwner?: object;
    releaseReceiving?: () => void;
    whenIdle?: () => Promise<void> | undefined;
  }>();
  private readonly receivingVideoOwners = new Map<bigint, ReceivingVideoOwner>();

  /**
   * Restart state keyed by namespace fields, name and media type. A replacement
   * keeps that identity while its request ID changes; the connection is owned.
   */
  private readonly livenessRestarts = new Map<string, LivenessRestart>();

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
      this.cancelWarmRange(owner);
    }
  }

  private armWarmMediaOwner(connection: MoqtConnection, requestId: bigint, prefixStart?: { group: bigint; object: bigint }): WarmMediaOwner | null {
    const subscription = this.activeSubscriptions.get(requestId);
    if (!subscription) return null;
    const owner: WarmMediaOwner = { connection, requestId, subscription, registration: null, head: null, prefixFetch: null,
      ...(prefixStart ? { prefixStart: { ...prefixStart } } : {}) };
    this.warmMediaOwners.set(subscription, owner);
    const head = new WarmStartHead<WarmMediaRoute>({
      clock: this.clock,
      ...(prefixStart ? { prefixStart, maxObjects: 400,
        onPrefixReady: () => {
          const sw = this.pendingVideoSwitch;
          if (sw?.connection === owner.connection && sw.newRequestId === owner.requestId
              && this.usesMse(sw.newTrackPackaging) && this.cmafSwitchStagingBuffer.some(entry => entry.sync)) {
            this.completePendingVideoSwitch();
          }
        },
        onAbandon: () => {
          const sw = this.pendingVideoSwitch;
          if (sw?.connection === owner.connection && sw.newRequestId === owner.requestId
              && this.usesMse(sw.newTrackPackaging) && !this.switchInProgress) {
            // A partial history cannot become the fallback's independent head.
            this.discardCmafStaging('warm start incomplete');
            sw.liveRestart = true;
          }
          this.cancelWarmRange(owner);
        } } : {}),
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

  /** Retire only the bounded history request; its live subscription stays usable. */
  private cancelWarmRange(owner: WarmMediaOwner): void {
    if (!owner.prefixStart || owner.prefixCancelled) return;
    owner.prefixCancelled = true;
    const info = owner.prefixFetch;
    owner.prefixFetch = null;
    if (info && this.activeFetches.get(info.requestId) === info) this.quarantineFetchRequest(info.requestId);
    try {
      const work = owner.connection.draftVersion === 22 ? owner.connection.cancelFill(owner.requestId)
        : info ? owner.connection.fetchCancel(info.requestId) : undefined;
      void work?.catch(() => {});
    } catch { /* A retired prefix cannot revoke the retained live subscription. */ }
  }

  private requestWarmRange(owner: WarmMediaOwner, trackName: string): void {
    const start = owner.prefixStart;
    if (!start || owner.prefixCancelled || !this.warmMediaOwnerCurrent(owner)) return;
    let registered = false;
    const register = (id: bigint): void => {
      if (registered) return;
      if (owner.prefixCancelled || !this.warmMediaOwnerCurrent(owner)) throw new Error('Switch history retired before emission');
      registered = true;
      this.registerMediaFetch(id, { trackName, mediaType: 'video', subscriptionRequestId: owner.requestId,
        trackAlias: null, warmStart: true, warmOwner: owner }, owner.connection);
    };
    const failed = (): void => {
      owner.head?.finishPrefix('error');
      this.cancelWarmRange(owner);
    };
    try {
      void owner.connection.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: owner.requestId,
        joiningStart: start.group, groupOrder: 'ascending', onRequestId: register,
      }).then(id => register(BigInt(id))).catch(failed);
    } catch { failed(); }
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

  private retainCurrentVideoStreams(manager: SubscriptionManager, streamId: bigint, obj: MoqtObject,
    sourceConnection: MoqtConnection | undefined): void {
    const source = this.mediaSource;
    const retain = source?.retainReceivingGroup;
    // LOC/unsupported sources do no stream scan, subscription scan or capture.
    if (!source || !retain || !sourceConnection || sourceConnection !== this.connection) return;
    const inputGeneration = manager.mediaInputGeneration;
    const alias = BigInt(obj.trackAlias);
    if (manager.getMediaType(alias) !== 'video') return;
    const stream = this.subgroupStreams.get(streamId);
    // Capture at actual object receipt, including preparation. A header alone
    // establishes neither a Group's existence nor a later alias owner's data.
    if (stream?.connection === sourceConnection && stream.trackAlias === alias
        && stream.groupId === BigInt(obj.groupId) && !stream.receivingRegistration) {
      const registration = manager.captureRoute(alias);
      if (registration) stream.receivingRegistration = { manager, isCurrent: registration };
    }
    const cached = this.receivingVideoOwners.get(alias);
    if (cached?.isCurrent()) {
      this.retainVideoStream(cached, streamId); // O(1) for every subsequent stream/object.
      return;
    }
    const sub = [...this.activeSubscriptions.values()].find(s => s.trackAlias === alias && s.mediaType === 'video');
    const registration = manager.captureRoute(alias);
    const selection = this.mseSelection('video');
    const key = sub && identityKey(sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName);
    if (!sub || !registration || !selection || selection.key !== key) return;
    const keyed = this.keyedCmafIdentity;
    const sourceKey = keyed ? manager.getSourceKey(alias) : undefined;
    if (keyed && sourceKey === undefined) return;
    // Prune retired routes only at an ownership transition. The cache contains
    // current registrations, not a history of aliases or observed groups.
    for (const [oldAlias, owner] of this.receivingVideoOwners) {
      if (!owner.isCurrent()) this.receivingVideoOwners.delete(oldAlias);
    }
    const owner: ReceivingVideoOwner = {
      token: {}, alias, trackName: sub.trackName, manager, source, connection: sourceConnection, retain,
      ...(sourceKey === undefined ? {} : { sourceKey }),
      isCurrent: () => !this._destroyed && this.receivingVideoOwners.get(alias) === owner
        && this.subscriptionManager === manager && this.mediaSource === source
        && manager.mediaInputGeneration === inputGeneration && this.keyedCmafIdentity === keyed
        && sourceConnection === this.connection
        && registration() && this.mediaRouteBelongsTo(sourceConnection, alias)
        && this.mseSelection('video')?.selection === selection.selection,
    };
    this.receivingVideoOwners.set(alias, owner); // Reserve before capability callbacks.
    // A preparation's SAP can adopt the track, followed immediately by a
    // successor stream. Acquire its ALREADY observed open streams before that
    // successor queues. Scan once per route owner, never once per new stream.
    const observed = [...this.subgroupStreams.keys()];
    for (const id of observed) {
      if (!owner.isCurrent()) break;
      this.retainVideoStream(owner, id);
    }
  }

  private retainVideoStream(owner: ReceivingVideoOwner, streamId: bigint): void {
    if (!owner.isCurrent()) return;
    const stream = this.subgroupStreams.get(streamId);
    if (stream?.connection !== owner.connection || stream.trackAlias !== owner.alias
        || stream.receivingRegistration?.manager !== owner.manager || !stream.receivingRegistration.isCurrent()
        || (stream.receivingOwner === owner.token && stream.releaseReceiving)) return;
    const previous = stream.releaseReceiving;
    stream.receivingOwner = owner.token;
    stream.releaseReceiving = () => {}; // Reserve each stream before either callback.
    stream.whenIdle = owner.manager.captureTrackIdle(owner.alias, streamId);
    previous?.();
    if (!owner.isCurrent() || this.subgroupStreams.get(streamId) !== stream) return;
    const release = streamRelease(owner.sourceKey === undefined
      ? owner.retain.call(owner.source, 'video', owner.trackName, stream.groupId, owner.isCurrent)
      : owner.retain.call(owner.source, 'video', owner.trackName, stream.groupId, owner.isCurrent, owner.sourceKey));
    if (!owner.isCurrent() || this.subgroupStreams.get(streamId) !== stream) release();
    else stream.releaseReceiving = release;
  }

  /** Capture manager work/provenance now; only its admission waits for prefix order. */
  private routeMediaObject(streamId: bigint, obj: MoqtObject, sourceDraft?: DraftVersion, sourceConnection?: MoqtConnection,
    receiptInput: MoqtObject | ObjectDatagram = obj,
    fetchInfo?: Pick<MediaFetchInfo, 'subscriptionRequestId' | 'warmStart' | 'warmOwner'>): Promise<void> {
    const manager = this.subscriptionManager;
    if (!manager) return Promise.resolve();
    const inputGeneration = manager.mediaInputGeneration;
    // Measurement ownership travels through transforms independently of playback validity.
    const cadenceOwner = fetchInfo === undefined && obj.kind === 'data'
      ? this.captureVideoMeasurementOwner() : null;
    const selected = this._selection.video;
    const cadenceIdentity = cadenceOwner && cadenceOwner.connection === sourceConnection
      && cadenceOwner.alias === BigInt(obj.trackAlias) && selected
      && (() => { const track = this.catalogTrackFor(selected.name, selected.namespaceFields, 'video');
        return track?.packaging === 'loc' || track !== null && track !== undefined && this.usesMse(track.packaging); })() ? {} : undefined;
    if (cadenceIdentity && cadenceOwner) this.cadenceInputOwners.set(cadenceIdentity, cadenceOwner);
    // Datagram routing IDs are not stream identities. Only a real subgroup
    // receipt may establish receiving evidence; FETCH has its own ownership.
    if ('kind' in receiptInput && fetchInfo === undefined && sourceConnection !== undefined
        && this.subgroupStreams.get(streamId)?.connection === sourceConnection) {
      this.retainCurrentVideoStreams(manager, streamId, obj, sourceConnection);
    }
    // Receiving capabilities are external callbacks too. Preserve the input
    // generation boundary before continuing into generic preparation/routing.
    if (this._destroyed || this.subscriptionManager !== manager || manager.mediaInputGeneration !== inputGeneration) {
      if (!this._destroyed && this.mediaDiagnosticRuntime) {
        try { this.discardMediaInput(this.mediaDiagnosticRuntime.capture(sourceConnection, receiptInput), 'route retired'); }
        catch { /* Optional receipt observations must not interrupt cancellation. */ }
      }
      return Promise.resolve();
    }
    const operation = this.mediaSelection;
    const prepared = operation && !operation.committed && operation.conn === sourceConnection
      ? [...operation.prep.media.values()].find(sub => sub.alias === BigInt(obj.trackAlias)) : undefined;
    const output = prepared && operation?.outputs.get(prepared.mediaType);
    if (operation && output) {
      if (!this.reservePreparedMediaInput(operation, obj)) return Promise.resolve();
      const registration = manager.captureRoute(BigInt(obj.trackAlias));
      const isLive = () => manager.mediaInputGeneration === inputGeneration && registration?.() === true && this.mediaSelectionRouteCurrent(operation);
      const admission = output.serial.then((): ObjectDeliveryAdmission => isLive()
        ? { kind: 'deliver', isLive, backfill: false } : { kind: 'discard', reason: 'route retired' });
      const identity = cadenceIdentity ?? {};
      this.preparedMediaDeliveries.set(identity, { preparation: operation, output, alias: BigInt(obj.trackAlias) });
      const work = manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput, { admission, isLive, identity, fetched: fetchInfo !== undefined });
      output.serial = work;
      return work;
    }
    if (this.warmMediaOwners.size === 0) {
      return manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput,
        fetchInfo ? { fetched: true, ...(fetchInfo.warmStart ? { isLive: () => false } : {}) }
          : cadenceIdentity ? { identity: cadenceIdentity } : undefined);
    }
    const alias = BigInt(obj.trackAlias);
    const owner = fetchInfo ? (fetchInfo.warmStart ? fetchInfo.warmOwner : undefined)
      : [...this.warmMediaOwners.values()].find(candidate => candidate.connection === sourceConnection && candidate.subscription.trackAlias === alias);
    if (!owner || owner.connection !== sourceConnection || owner.subscription.trackAlias !== alias
        || this.warmMediaOwners.get(owner.subscription) !== owner) return manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput,
      fetchInfo ? { fetched: true, ...(fetchInfo.warmStart ? { isLive: () => false } : {}) }
          : cadenceIdentity ? { identity: cadenceIdentity } : undefined);
    const registration = manager.captureRoute(alias);
    const isLive = () => this.subscriptionManager === manager && manager.mediaInputGeneration === inputGeneration
      && registration?.() === true && this.warmMediaOwnerCurrent(owner);
    let permit!: WarmMediaRoute['permit'];
    const admission = new Promise<ObjectDeliveryAdmission>(resolve => { permit = resolve; });
    const work = manager.routeObject(streamId, obj, sourceDraft, sourceConnection, receiptInput, { isLive, admission, fetched: fetchInfo !== undefined, ...(cadenceIdentity ? { identity: cadenceIdentity } : {}) });
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
    if (info) info.retired = true;
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
    // Finishing an admission can synchronously cancel its transport and let
    // application code replace the session. Complete all old map/tombstone
    // mutations first; no bare request/stream IDs are used after this callback.
    if (info) this.finishWarmMediaPrefix(info, 'error');
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
    // A backend cancellation callback can reenter. Finish local retirement
    // before invoking it, so it cannot remove a successor's registration.
    if (warmOwner?.connection === conn) this.cancelWarmRange(warmOwner);
    return sub;
  }

  private readonly pendingMediaTerminals = new WeakMap<MoqtConnection, Map<bigint, {
    sub: object; reason: string; whenIdle: () => Promise<void> | undefined; releaseEnd: (completeTrack?: boolean) => void;
    trackEnded: boolean; completeMse: () => void;
    preparing?: boolean; drained?: boolean; attach?: () => void;
  }>>();
  private readonly terminalMediaSubscriptions = new WeakSet<object>();
  private videoDeliveryEnding(): boolean {
    if (this.videoPipeline?.isEnding) return true;
    const loc = this.activeLocSeek;
    if (loc && !loc.retired && loc.connection === this.connection
        && (loc.playback.isEnding('video') || [...loc.bridges].some(owner => owner.role === 'video' && owner.ending))) return true;
    const attempt = this.activeMseSeek, output = this.ownedSeekOutput;
    const selected = this.mseSelection('video');
    if (attempt && !attempt.retired && output && attempt.connection === this.connection && attempt.source === this.mediaSource
        && attempt.epoch === this.mseOutputEpoch && output.resource.epoch === attempt.epoch
        && attempt.videoSelection !== null && attempt.videoSelection.selection === selected?.selection
        && attempt.videoSelection.key === selected.key
        && (attempt.ended.has('video') || [...attempt.bridges].some(owner => owner.role === 'video' && owner.ending))
        && !this._destroyed && this.activeMseSeek === attempt && !attempt.retired && this.ownedSeekOutput === output
        && attempt.connection === this.connection && attempt.source === this.mediaSource && attempt.epoch === this.mseOutputEpoch) return true;
    const video = [...this.activeSubscriptions.values()].filter(sub => sub.mediaType === 'video');
    if (video.length > 0 && video.every(sub => this.terminalMediaSubscriptions.has(sub))) return true;
    const completion = this.mseCompletions?.get('video');
    return completion?.emitted === true && completion.conn === this.connection && completion.source === this.mediaSource && completion.outputEpoch === this.mseOutputEpoch
      && completion.selection === selected?.selection && completion.key === selected.key;
  }
  private mseCompletions: Map<'video' | 'audio', {
    conn: MoqtConnection; source: MediaSourceLike; outputEpoch: object | null; selection: object; key: string; emitted: boolean;
  }> | null = null;

  private mseSelection(mediaType: 'video' | 'audio'): { selection: object; key: string } | null {
    // Video's existing controller owns committed quality generations. An
    // auxiliary acceptance is not a replacement for that output authority.
    const video = mediaType === 'video' ? this.qualityController?.currentVideoTrack : undefined;
    if (video) return { selection: video, key: identityKey(trackNamespaceFields(video, this.config.namespace), video.name) };
    const adopted = this.selectedOutputOwners.get(mediaType);
    if (adopted) return adopted;
    const track = mediaType === 'audio' ? this.qualityController?.currentAudioTrack : undefined;
    if (track) return { selection: track, key: identityKey(trackNamespaceFields(track, this.config.namespace), track.name) };
    const known = this.config.knownTracks?.[mediaType];
    return known ? { selection: known, key: identityKey(namespaceFields(this.config.namespace), known.name) } : null;
  }

  private reconsiderMseTrackEnds(): void {
    if (!this.mseCompletions) return;
    const initIds = new Set(this.initTrackRequestIds.values());
    for (const [mediaType, completion] of this.mseCompletions) {
      const selected = this.mseSelection(mediaType);
      if (this._destroyed || this.connection !== completion.conn || this.mediaSource !== completion.source || completion.outputEpoch !== this.mseOutputEpoch
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
  /**
   * Subscriber priority for a media subscription. Audio goes ahead of video by
   * default: on a congested link a relay that schedules by priority sends the
   * small audio objects first, and audio is what listeners notice. Video keeps
   * whatever the configured parameters say (or none: the relay's default).
   */
  private subscriberPriorityFor(mediaType: string): { subscriberPriority?: ReturnType<typeof varint> } {
    if (mediaType !== 'audio') return {};
    const base = this.config.subscriberPriority ?? DEFAULT_SUBSCRIBER_PRIORITY;
    return { subscriberPriority: varint(BigInt(this.config.audioSubscriberPriority ?? Math.max(0, base - 1))) };
  }

  private mediaTerminalOptions(conn: MoqtConnection) {
    return {
      terminalDelivery: 'drain' as const,
      terminalDeliveryCompletion: 'streams' as const,
      terminalDeliveryStatuses: isDraft22(conn.draftVersion) ? [2n] : [2n, 3n],
      onDrained: (id: bigint) => this.finishMediaTerminal(conn, id),
    };
  }

  private registerMediaTerminal(conn: MoqtConnection, id: bigint,
    sub: { trackName: string; mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline'; trackAlias: bigint | null; namespace?: readonly string[] } | undefined,
    status: bigint, reason: string, preparing = false): boolean {
        if (status !== 2n && (status !== 3n || isDraft22(conn.draftVersion))) return false;
        if ([...this.initTrackRequestIds.values()].includes(id)) return false;
        if (!sub || sub.trackAlias === null) return false;
        let terminals = this.pendingMediaTerminals.get(conn);
        if (!terminals) { terminals = new Map(); this.pendingMediaTerminals.set(conn, terminals); }
        if (terminals.has(id)) return true;
        const pipeline = sub.mediaType === 'video' ? this.videoPipeline : sub.mediaType === 'audio' ? this.audioPipeline : null;
        const mediaSource = this.mediaSource;
        const mseType = sub.mediaType === 'video' || sub.mediaType === 'audio' ? sub.mediaType : null;
        let selection = preparing || mseType === null ? null : this.mseSelection(mseType);
        const outputEpoch = this.mseOutputEpoch;
        const trackKey = identityKey(sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName);
        const completeMse = () => {
          if (pipeline !== null || mediaSource === null || this.mediaSource !== mediaSource || mseType === null
              || this._destroyed || this.connection !== conn || this.mseOutputEpoch !== outputEpoch || selection === null) return;
          const current = this.mseSelection(mseType);
          if (status === 2n && selection.key === trackKey && current?.selection === selection.selection && current.key === selection.key
              && !this.mseCompletions?.has(mseType)) {
            (this.mseCompletions ??= new Map()).set(mseType, { conn, source: mediaSource, outputEpoch, ...selection, emitted: false });
          }
          this.reconsiderMseTrackEnds();
        };
        const terminal: NonNullable<ReturnType<typeof this.pendingMediaTerminals.get>> extends Map<bigint, infer T> ? T : never = {
          sub, reason, whenIdle: this.subscriptionManager?.captureTrackIdle(sub.trackAlias) ?? (() => undefined),
          releaseEnd: preparing ? () => {} : pipeline?.holdTrackEnd() ?? (() => {}), trackEnded: status === 2n, completeMse,
          ...(preparing ? { preparing: true, attach: () => {
            selection = mseType === null ? null : this.mseSelection(mseType);
            terminal.releaseEnd = pipeline?.holdTrackEnd() ?? (() => {});
            terminal.preparing = false;
          } } : {}),
        };
        terminals.set(id, terminal);
        this.terminalMediaSubscriptions.add(sub);
        const restart = this.livenessRestarts.get(JSON.stringify([
          sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName, sub.mediaType,
        ]));
        if (restart?.connection === conn && restart.requestId === id) restart.cancelled = true;
        this.livenessMonitor?.reconcile(this.collectLivenessTracks());
        return true;

  }

  private finishMediaTerminal(conn: MoqtConnection, id: bigint): void {
        const terminals = this.pendingMediaTerminals.get(conn);
        const terminal = terminals?.get(id);
        if (!terminal) return;
        if (terminal.preparing) { terminal.drained = true; return; }
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
    const merged = { ...DEFAULT_PLAYER_CONFIG, ...config,
      ...(Array.isArray(config.audioLanguages) ? { audioLanguages: Object.freeze([...config.audioLanguages]) } : {}) };
    // An explicit undefined from JavaScript must not erase the default. Keep
    // caller-owned empty strings intact as compatibility track identities.
    if (merged.catalogTrackName === undefined) merged.catalogTrackName = DEFAULT_PLAYER_CONFIG.catalogTrackName;
    this.config = merged;
    this._selection = emptyMediaSelection(0, this.config.autoQuality !== false);
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

  /** Accepted/adopted output identities, independent of startup selectors. */
  get selection(): MediaSelectionSnapshot { return this._selection; }

  /** Canonical raw reference; audio is preferred while it is established. */
  get mediaTimelineReference(): MediaTimelineReference | null {
    if (this._selection.audio !== null) return this.audioTimelineReference;
    if (!this._destroyed) this.collectVideoTimeline = true;
    return this.readTimelineReference('video');
  }

  /** Arms source observation for this load. First read may be null until the next accepted audio. */
  get audioTimelineReference(): AudioTimelineReference | null {
    if (!this._destroyed) this.collectAudioTimeline = true;
    return this.readAudioTimelineReference();
  }

  private readAudioTimelineReference(): AudioTimelineReference | null { return this.readTimelineReference('audio'); }

  private readTimelineReference(role: 'video' | 'audio'): MediaTimelineReference | null {
    const inputGeneration = this.subscriptionManager?.mediaInputGeneration;
    const record = role === 'audio' ? this.audioTimelineRecord : this.videoTimelineRecord;
    const selected = this._selection[role];
    if (!record || this._destroyed || !selected || this.connection !== record.connection
        || identityKey(selected.namespaceFields, selected.name) !== identityKey(record.reference.track.namespaceFields, record.reference.track.name)) return null;
    const current = () => !this._destroyed && this.connection === record.connection && this._selection[role] === selected
      && this.subscriptionManager?.mediaInputGeneration === inputGeneration
      && (role === 'audio' ? this.audioTimelineRecord : this.videoTimelineRecord) === record;
    const track = this.catalogTrackFor(selected.name, selected.namespaceFields, role);
    if (!track || !this.timelineConfiguration(track, role).every((value, index) => value === record.configuration[index])) return null;
    if (this.usesMse(track.packaging)) {
      const assembler = this.cmafAssembler, source = this.mediaSource;
      if (record.authority !== assembler || record.source !== source) return null;
      try {
        if (record.epoch !== assembler?.getEpoch(role)) return null;
        if (assembler?.capturePresentationPlacement) {
          if (record.placementToken === null || assembler.capturePresentationPlacement(role)?.token !== record.placementToken) return null;
        } else if (role === 'audio' && this.audioTimingMapped && (record.mappingWitness === null
            || record.mappingWitness !== assembler?.getAudioPresentationMappingWitness?.())) return null;
        if (!Object.is(source?.getTimestampOffset?.(role), record.nativeOffset)) return null;
        // A native accessor may reenter an assembler reconfiguration while
        // returning the same offset. Recheck its actual placement afterwards.
        if (assembler?.capturePresentationPlacement
            && assembler.capturePresentationPlacement(role)?.token !== record.placementToken) return null;
      } catch { return null; }
    } else {
      if (record.authority !== this.syncController) return null;
      const raw = record.clockAnchorUs + (role === 'audio' ? this.audioPresentationOffsetUs : this.videoPresentationOffsetUs);
      let timing: ReturnType<SyncController['computeAudioRenderTime']> | undefined;
      try {
        timing = role === 'audio' ? this.syncController?.computeAudioRenderTime(raw) : this.syncController?.computeVideoRenderTime(raw);
      } catch {
        // This optional read is not playback. A clock callback may reset its
        // baselines while being read; unavailable evidence must not become a
        // stale token or an exception from a supposedly read-only snapshot.
        return null;
      }
      if (!timing || !Number.isFinite(timing.renderTimeUs) || !current() || record.authority !== this.syncController) return null;
      if (record.clockScheduleUs !== null && record.clockScheduleUs !== timing.renderTimeUs) return null;
      record.clockScheduleUs = timing.renderTimeUs;
    }
    if (!current()) return null;
    return Object.freeze({ ...record.reference, observedSourceTimeUs: record.observedSourceTimeUs });
  }

  private timelineConfiguration(track: CatalogTrack, role: 'video' | 'audio'): readonly unknown[] {
    return [this.initKey(track), track.packaging, track.codec, track.samplerate, track.channelConfig,
      track.initTrack, this.resolveInlineInitData(track), role === 'audio' ? this.audioPresentationOffsetUs : this.videoPresentationOffsetUs,
      ...(role === 'video' ? [track.width, track.height] : [])];
  }

  private noteAudioTimeline(sourceTimeUs: bigint, domain: AudioTimelineReference['domain']): void {
    if (this.collectAudioTimeline) this.noteMediaTimeline('audio', sourceTimeUs, domain);
  }

  private noteMediaTimeline(role: 'video' | 'audio', sourceTimeUs: bigint, domain: MediaTimelineReference['domain']): void {
    const inputGeneration = this.subscriptionManager?.mediaInputGeneration;
    const selected = this._selection[role], connection = this.connection;
    if (!selected || !connection || this._destroyed) return;
    const track = this.catalogTrackFor(selected.name, selected.namespaceFields, role);
    if (!track) return;
    const prior = this.readTimelineReference(role);
    if (prior && prior.domain === domain) {
      const record = role === 'audio' ? this.audioTimelineRecord : this.videoTimelineRecord;
      record!.observedSourceTimeUs = sourceTimeUs; return;
    }
    // Clock/configuration/epoch changes require new evidence; observing a later
    // input cannot renew a token the getter already refused.
    const identity = Object.freeze({ name: selected.name, namespaceFields: Object.freeze([...selected.namespaceFields]) });
    const mse = this.usesMse(track.packaging), assembler = this.cmafAssembler, source = this.mediaSource;
    const authority = mse ? assembler : this.syncController;
    let epoch: bigint | null = null, mappingWitness: object | null = null, placementToken: object | null = null;
    let nativeOffset: number | undefined;
    try {
      if (mse) {
        epoch = assembler?.getEpoch(role) ?? null;
        placementToken = assembler?.capturePresentationPlacement?.(role)?.token ?? null;
        mappingWitness = role === 'audio' && this.audioTimingMapped ? assembler?.getAudioPresentationMappingWitness?.() ?? null : null;
        nativeOffset = source?.getTimestampOffset?.(role);
        if (nativeOffset !== undefined && !Number.isFinite(nativeOffset)) return;
        if (assembler?.capturePresentationPlacement
            && assembler.capturePresentationPlacement(role)?.token !== placementToken) return;
      }
    } catch { return; }
    const configuration = this.timelineConfiguration(track, role);
    // Optional adapter reads may reenter playback. Evidence cannot revive the
    // connection, source or selected output that those callbacks retired.
    if (this._destroyed || this.connection !== connection || this._selection[role] !== selected
        || this.subscriptionManager?.mediaInputGeneration !== inputGeneration
        || this.mediaSource !== source || (mse ? this.cmafAssembler : this.syncController) !== authority) return;
    const record: SourceTimelineRecord = {
      reference: Object.freeze({ token: Object.freeze({}), track: identity, domain }), observedSourceTimeUs: sourceTimeUs,
      configuration, connection, authority, epoch, mappingWitness, placementToken, source, nativeOffset,
      clockAnchorUs: sourceTimeUs, clockScheduleUs: null,
    };
    if (role === 'audio') this.audioTimelineRecord = record;
    else this.videoTimelineRecord = record;
  }

  private refreshMediaSelection(outputs: Partial<Pick<MediaSelectionSnapshot, 'video' | 'audio'>> = {}, force = false): void {
    if (this._destroyed || (this.currentMigration?.adopting && !force)) return;
    for (const type of ['video', 'audio'] as const) {
      const value = outputs[type];
      if (value === null) this.selectedOutputOwners.delete(type);
      else if (value !== undefined) {
        const key = identityKey(value.namespaceFields, value.name);
        if (force || this.selectedOutputOwners.get(type)?.key !== key) this.selectedOutputOwners.set(type, { selection: {}, key });
      }
    }
    const previous = this._selection;
    const video = outputs.video === undefined ? previous.video : outputs.video;
    const audio = outputs.audio === undefined ? previous.audio : outputs.audio;
    const model = this._catalogState ? buildCatalogSelection(this._catalogState, { catalogNamespace: this.config.namespace }) : null;
    const selectedTrack = (id: TrackIdentity | null) => id === null ? undefined : this._catalogState?.tracks.find(track =>
      track.name === id.name && sameNamespaceFields(trackNamespaceFields(track, this.config.namespace), id.namespaceFields));
    const selected = selectedTrack(video) ?? selectedTrack(audio);
    const resolved = model ? resolveSelection(model, this.selectionIntent() ?? {}) : null;
    const scope = selected ? (selected.renderGroup === undefined ? { kind: 'unassigned' as const }
      : { kind: 'render-group' as const, renderGroup: selected.renderGroup }) : previous.scope ?? (resolved?.ok ? resolved.scope.id : null);
    const available = model?.scopes.find(item => JSON.stringify(item.id) === JSON.stringify(scope));
    const videoTrack = selectedTrack(video) ?? this.qualityController?.currentVideoTrack
      ?? (resolved?.ok ? resolved.video?.track.track : undefined);
    const videoSet = videoTrack === undefined ? undefined : available?.video.find(set => videoTrack.altGroup === undefined
      ? set.tracks.some(item => item.id.name === videoTrack.name && sameNamespaceFields(item.id.namespaceFields,
        trackNamespaceFields(videoTrack, this.config.namespace)))
      : set.id.kind === 'declared' && set.id.altGroup === videoTrack.altGroup);
    const eligibleVideos = this.config.disableVideo ? [] : this.qualityController?.eligibleLadder(
      videoSet?.tracks.map(item => item.track) ?? []) ?? [];
    const next = copyMediaSelection({ revision: previous.revision, scope, video, audio,
      videoAlternatives: eligibleVideos.map(track => ({ name: track.name, namespaceFields: trackNamespaceFields(track, this.config.namespace) })),
      audioChoices: this.config.disableAudio ? [] : available?.audio.flatMap(set => set.tracks).sort((a, b) => a.catalogIndex - b.catalogIndex).map(item => item.id) ?? [],
      autoQuality: this.qualityController?.isAutoQuality ?? this.config.autoQuality !== false });
    if (!force && JSON.stringify(previous) === JSON.stringify(next)) return;
    this._selection = copyMediaSelection({ ...next, revision: previous.revision + 1 });
    // Readback is authoritative before callbacks; listener failures cannot undo adoption.
    try {
      this.emitter.emitIsolated('selection_changed', { type: 'selection_changed', selection: this._selection,
        catalog: this._catalogState === null ? null : structuredClone(this._catalogState) });
    } catch (error) { try { this.log.warn('Selection observer failed: %s', String(error)); } catch { /* observer failure */ } }
  }

  private acceptedSelection(mediaType: 'video' | 'audio'): TrackIdentity | null {
    for (const sub of this.activeSubscriptions.values()) {
      if (sub.mediaType === mediaType && sub.trackAlias !== null
          && !this.supersededRouting?.aliases.has(sub.trackAlias)) return {
        name: sub.trackName, namespaceFields: sub.namespace ?? namespaceFields(this.config.namespace),
      };
    }
    return null;
  }

  /**
   * Historical video draw evidence, not an advancing content playhead.
   * Null after destruction or without renderer support (including MSE).
   */
  get videoPresentation(): VideoPresentation | null {
    if (this._destroyed) return null;
    const observation = this.videoCommandDispatcher()?.videoPresentation ?? null;
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
      videoEncodeObservation: this.readVideoEncodeObservation(),
      ...(this.audioTimingMapped ? { avSkewMs: null, avSkewEwmaMs: null } : {}),
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
    return 'timeline' in this.getSeekContext();
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
   * Disabling prevents new automatic requests; already-issued switches may finish.
   * Manual selections remain available.
   */
  setAutoQuality(enabled: boolean): void {
    if (!this.qualityController) return;
    if (this.qualityController.isAutoQuality !== enabled) this.retireVideoMeasurement();
    if (enabled) {
      this.qualityController.unlockAuto();
    } else {
      this.qualityController.lockManual();
    }
    this.refreshMediaSelection();
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
    const lagOwner = this.captureCmafLagOwner(mediaType, obj, delivery);
    const inputGeneration = this.subscriptionManager?.mediaInputGeneration;
    const sourceKey = this.keyedCmafIdentity ? this.subscriptionManager?.getSourceKey(BigInt(obj.trackAlias)) : undefined;
    if (mediaType === 'eventtimeline') {
      this.onLocmafEventObject(trackName, obj, input, delivery);
      return;
    }
    // Liveness: stamp before every early return (gates, staging, drops).
    this.stampMediaArrival(BigInt(obj.trackAlias));

    this._stats.recordFirstObjectReceived();
    if (obj.kind === 'data') {
      const bytes = obj.payload ? obj.payload.byteLength : 0;
      this._stats.recordMediaObject(bytes);

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

    if (delivery?.isLive?.() === false || this.subscriptionManager?.mediaInputGeneration !== inputGeneration) {
      this.discardMediaInput(input, this.stateMachine.state === PlayerState.PAUSED ? 'paused' : 'route retired'); return;
    }
    if (this.stateMachine.state === PlayerState.PAUSED) { this.discardMediaInput(input, 'paused'); return; }
    if (obj.kind === 'gap') {
      // §16: END_OF_GROUP / END_OF_TRACK markers let the LOC pipeline advance
      // to the next group at once instead of waiting out the gap timeout.
      if (this.locmafFramePath) this.routeLocmafFrame(mediaType, trackName, obj, {}, input, delivery);
      return;
    }
    if (!obj.payload) return;
    const groupId = BigInt(obj.groupId);
    if (this.locmafFramePath) {
      const selected = this._selection[mediaType];
      const pipeline = mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
      const floor = pipeline ? (pipeline.minimumAcceptedGroupId > pipeline.currentGroupId
        ? pipeline.minimumAcceptedGroupId : pipeline.currentGroupId) : undefined;
      if (selected && identityKey(selected.namespaceFields, selected.name) === this.mediaKey(trackName, mediaType, BigInt(obj.trackAlias))
          && floor !== undefined && groupId < floor) { this.discardMediaInput(input, 'stale group'); return; }
    } else if (!(this.pendingVideoSwitch && mediaType === 'video' && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'new'))) {
      const floor = sourceKey === undefined ? this.mediaSource?.getCommittedGroupFloor?.(mediaType, trackName)
        : this.mediaSource?.getCommittedGroupFloor?.(mediaType, trackName, sourceKey);
      if (floor !== undefined && groupId < floor) { this.discardMediaInput(input, 'stale group'); return; }
    }
    // Frame reader owns bounded parsing and its own per-carrier input frontier.
    if (this.locmafFramePath) {
      this.onLocmafFrameObject(mediaType, trackName, obj, input, delivery);
      return;
    }
    if (!this.admitLocmafConsumerInput(mediaType, trackName, obj, input)) return;
    const rawBoxes = this.locmafRawBoxes(mediaType, trackName, obj, delivery);
    if (rawBoxes === undefined) { this.discardMediaInput(input, 'invalid media'); return; }

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
        && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'old')) {
      this.discardMediaInput(input, 'track superseded');
      return;
    }

    // A later in-band CMAF Header re-seeds this track's reconstruction (§6, §9.3).
    if (rawBoxes && MoqtPlayer.looksLikeCmafInitSegment(rawBoxes)) {
      this.noteLocmafInBandHeader(trackName, rawBoxes, BigInt(obj.trackAlias), delivery);
      return;
    }

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
        && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'new')) {
      if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, decoded.bytes.byteLength)) {
        this.discardMediaInput(input, 'track superseded'); return;
      }
      this.cmafSwitchStagingBuffer.push({ trackName, ...(sourceKey === undefined ? {} : { sourceKey }), mediaType, groupId, payload: decoded.bytes, sync: decoded.sync, ...(input ? { input } : {}) });
      this.armVideoSwitchTimeout(this.pendingVideoSwitch);
      if (decoded.sync) {
        this.completePendingVideoSwitch();
      }
      return;
    }

    // Early stale-group drop, as for CMAF.
    if (this.mediaSource && 'getCommittedGroupFloor' in this.mediaSource) {
      const floor = sourceKey === undefined ? this.mediaSource.getCommittedGroupFloor?.(mediaType, trackName)
        : this.mediaSource.getCommittedGroupFloor?.(mediaType, trackName, sourceKey);
      if (floor !== undefined && groupId < floor) { this.discardMediaInput(input, 'stale group'); return; }
    }

    this.pushCmafInput(mediaType, trackName, groupId, decoded.bytes, input, sourceKey, undefined, lagOwner);
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
          this.clearLocmafFrameReader(key);
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

  private clearLocmafFrameReader(key: string): void {
    this.locmafFrameReaders.get(key)?.reader.retire();
    this.locmafFrameReaders.delete(key);
  }

  private clearLocmafFrameReaders(): void {
    for (const { reader } of this.locmafFrameReaders.values()) reader.retire();
    this.locmafFrameReaders.clear();
  }

  /** Resolve switch cleanup while the retiring request still owns its identity. */
  private clearLocmafDecoderForRequest(requestId: bigint): void {
    const sub = this.activeSubscriptions.get(requestId);
    if (!sub) return;
    const key = this.mediaKey(sub.trackName, sub.mediaType, sub.trackAlias ?? undefined);
    this.locmafDecoders.delete(key);
    this.locmafDecoderInit.delete(key);
    this.locmafHealth.delete(key);
    this.clearLocmafFrameReader(key);
  }

  /**
   * An in-band CMAF Header on a LOCMAF track (rawBoxes, §9): remember it and
   * re-seed the decoder if it changed. A different header re-seeds
   * reconstruction; repeating the same one must not discard the in-flight
   * groups' references.
   */
  private noteLocmafInBandHeader(trackName: string, header: Uint8Array, alias?: bigint, preserveDelivery?: ObjectDeliveryOptions): void {
    const key = this.mediaKey(trackName, undefined, alias);
    this.initSegmentByTrack.set(key, header);
    const current = this.locmafDecoderInit.get(key) ?? this.locmafFrameReaders.get(key)?.header?.bytes;
    if (!current || !MoqtPlayer.sameBytes(current, header)) {
      if ((this.locmafDecoders.has(key) || this.locmafFrameReaders.has(key)) && alias !== undefined) {
        const mediaType = this.subscriptionManager?.getMediaType(alias);
        if (mediaType) this.retireLocmafConsumerInputs(trackName, mediaType, alias, undefined, preserveDelivery);
      }
      this.locmafDecoders.delete(key);
      this.locmafDecoderInit.delete(key);
      this.locmafBadInit.delete(key);
      this.clearLocmafFrameReader(key);
    }
  }

  /** Read complete frame carriers without changing their wire Location (§§3,9,16). */
  private onLocmafFrameObject(
    mediaType: 'video' | 'audio', trackName: string, obj: MoqtObject & { kind: 'data' },
    input?: ObjectRoutingContext, delivery?: ObjectDeliveryOptions,
  ): void {
    const manager = this.subscriptionManager, generation = manager?.mediaInputGeneration;
    const key = this.mediaKey(trackName, mediaType, BigInt(obj.trackAlias));
    const current = () => {
      const live = delivery?.isLive?.() !== false;
      return live && !this._destroyed && this.subscriptionManager === manager
        && manager?.mediaInputGeneration === generation;
    };
    let state = this.locmafFrameReaders.get(key);
    let samples: readonly PlaybackSample[];
    try {
      if (!state) {
        const reader = new LocmafFrameReader(this.locmafInitBytes(trackName, BigInt(obj.trackAlias), mediaType), {
          maxGroups: MoqtPlayer.LOCMAF_TRACKED_GROUPS, maxSamples: 512, maxEntries: 65536,
          maxBytes: MoqtPlayer.MAX_STAGED_BYTES,
        }, 'committed');
        state = { reader, header: reader.snapshotInitialization() };
        this.locmafFrameReaders.set(key, state);
      }
      const raw = readVi64(obj.payload, 0).value === 4n;
      let result = state.reader.push(BigInt(obj.groupId), BigInt(obj.objectId), obj.payload);
      if (result.kind === 'reconfigure') {
        const reader = new LocmafFrameReader(result.header.bytes, {
          maxGroups: MoqtPlayer.LOCMAF_TRACKED_GROUPS, maxSamples: 512, maxEntries: 65536,
          maxBytes: MoqtPlayer.MAX_STAGED_BYTES,
        }, 'committed');
        state = { reader, header: result.header };
        this.locmafFrameReaders.set(key, state);
        this.initSegmentByTrack.set(key, result.header.bytes);
        // The validated Header owns the new epoch even if later media in the
        // carrier is invalid. Retire old accepted work before replaying it.
        this.retireLocmafConsumerInputs(trackName, mediaType, BigInt(obj.trackAlias), undefined, delivery);
        if (!current() || this.locmafFrameReaders.get(key) !== state) {
          this.discardMediaInput(input, 'route retired'); return;
        }
        // A changed Header cannot retain encoded inputs from the previous epoch.
        // A staged target owns a different reader and must not reset live video.
        if (!(mediaType === 'video' && this.pendingVideoSwitch
            && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'new'))) {
          (mediaType === 'video' ? this.videoPipeline : this.audioPipeline)?.resetForTrackSwitch(BigInt(obj.groupId));
        }
        if (!current() || this.locmafFrameReaders.get(key) !== state) {
          this.discardMediaInput(input, 'route retired'); return;
        }
        result = reader.push(result.location.groupId, result.location.objectId, result.replay);
        if (result.kind !== 'batch') throw new Error('LOCMAF Header replay changed its epoch');
      }
      if (raw) this.retireLocmafConsumerInputs(trackName, mediaType, BigInt(obj.trackAlias), BigInt(obj.groupId), delivery);
      if (!current() || this.locmafFrameReaders.get(key) !== state) {
        this.discardMediaInput(input, 'route retired'); return;
      }
      if (result.header) state.header = result.header;
      if (state.header) this.initSegmentByTrack.set(key, state.header.bytes);
      if (!current() || this.locmafFrameReaders.get(key) !== state) {
        this.discardMediaInput(input, 'route retired'); return;
      }
      samples = locmafPlaybackSamples(mediaType, result.units, state.header?.description ?? null, 'nearest');
      // The existing AVC validator understands four-byte NAL lengths only.
      // Other valid configurations retain the container's declared sync flags.
      if (mediaType === 'video' && state.header?.context.codecFourcc === 'avc1'
          && state.header.description && (state.header.description[4]! & 3) === 3
          && samples.some(sample => sample.chunk.type === 'key'
            && isKeyframePayload('avc1', sample.chunk.data) === false)) {
        throw new Error('LOCMAF sync sample contradicts its AVC payload');
      }
      this.recordLocmafObjectResult(mediaType, trackName, BigInt(obj.trackAlias), BigInt(obj.groupId), BigInt(obj.objectId), null);
      if (!current() || this.locmafFrameReaders.get(key) !== state) {
        this.discardMediaInput(input, 'route retired'); return;
      }
    } catch (error) {
      if (!current()) { this.discardMediaInput(input, 'route retired'); return; }
      if (error instanceof LocmafFormatError) {
        this.recordLocmafObjectResult(mediaType, trackName, BigInt(obj.trackAlias), BigInt(obj.groupId), BigInt(obj.objectId), error);
      } else if (!(error instanceof LocmafFrameReadError && error.reason === 'replay')) {
        this._stats.recordLocmafObjectRejected();
        if (!this.locmafWarned.has(`frames:${key}`)) {
          this.locmafWarned.add(`frames:${key}`);
          if (error instanceof LocmafFrameReadError && error.reason === 'protected') {
            this.log.warn('[LOCMAF] "%s" (%s): protected track cannot be decrypted on the frame path; use locmafDecoding "mse"', trackName, mediaType);
          } else this.log.warn('[LOCMAF] "%s" (%s): frame input unavailable: %s', trackName, mediaType,
            error instanceof Error ? error.message : String(error));
        }
      }
      this.discardMediaInput(input, error instanceof LocmafReadLimitError ? 'buffer full'
        : error instanceof LocmafFrameReadError
          ? error.reason === 'replay' ? 'treated as a replay' : 'decoder policy'
          : 'invalid media');
      return;
    }
    // Decoder/renderer failures are not malformed container input.
    this.routeLocmafFrame(mediaType, trackName, obj, {}, input, delivery, samples);
  }

  /** Route one frame-path object like a LOC object: switch staging, old-track drop, pipeline push. */
  private routeLocmafFrame(mediaType: 'video' | 'audio', _trackName: string, frame: MoqtObject, headers: LocHeaders, input?: ObjectRoutingContext, delivery?: ObjectDeliveryOptions, samples?: readonly PlaybackSample[]): void {

    if (this.pendingVideoSwitch && mediaType === 'video'
        && this.isVideoSwitchAlias(BigInt(frame.trackAlias), 'new')) {
      if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, this.frameBatchBytes(frame, samples), samples?.length ?? 0)) {
        this.discardMediaInput(input, 'track superseded'); return;
      }
      const entry = { obj: frame, headers, ...(samples ? { samples } : {}), ...(input ? { input } : {}) };
      this.switchStagingBuffer.push(entry);
      this.armVideoSwitchTimeout(this.pendingVideoSwitch);
      if (this.independentFrameEntry(entry)) {
        this.completePendingVideoSwitch();
      }
      return;
    }
    if (this.switchInProgress && this.pendingVideoSwitch
        && mediaType === 'video'
        && this.isVideoSwitchAlias(BigInt(frame.trackAlias), 'old')) {
      this.discardMediaInput(input, 'track superseded'); return;
    }
    const pipeline = mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
    if (!pipeline) this.discardMediaInput(input, 'not attached');
    else if (samples && frame.kind === 'data') pipeline.pushSampleObject(frame, samples, input, {
      ...(delivery?.backfill ? { backfill: true } : {}), allowIndependentGap: samples[0]?.chunk.type === 'key',
    });
    else if (delivery?.backfill) pipeline.pushObject(frame, headers, input, { backfill: true });
    else if (input) pipeline.pushObject(frame, headers, input);
    else pipeline.pushObject(frame, headers);
  }

  private independentFrameEntry(entry: { obj: MoqtObject; headers: LocHeaders | undefined; samples?: readonly PlaybackSample[] }): boolean {
    if (entry.obj.kind !== 'data') return false;
    return entry.samples !== undefined ? entry.samples.some(sample => sample.chunk.type === 'key')
      : (entry.headers?.videoFrameMarking?.independent ?? BigInt(entry.obj.objectId) === 0n);
  }

  /** Conservative per-carrier backing charge, including the original wire bytes. */
  private frameBatchBytes(obj: MoqtObject, samples?: readonly PlaybackSample[]): number {
    if (obj.kind !== 'data') return 0;
    const buffers = new Set<ArrayBufferLike>([obj.payload.buffer]);
    if (obj.extensions) buffers.add(obj.extensions.buffer);
    for (const sample of samples ?? []) {
      buffers.add(sample.chunk.data.buffer);
      if (sample.headers.videoConfig) buffers.add(sample.headers.videoConfig.buffer);
      if (sample.headers.audioConfig) buffers.add(sample.headers.audioConfig.buffer);
    }
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    return bytes;
  }

  /**
   * A chunk of a LOCMAF event-only track (§14): reconstruct it for its genBoxes
   * and emit the parsed emsg boxes. The chunk carries no samples, so nothing
   * reaches a media sink; a version-0 emsg's presentation time is relative to
   * the chunk's base media decode time, which the event carries.
   */
  private onLocmafEventObject(trackName: string, obj: MoqtObject, input?: ObjectRoutingContext, delivery?: ObjectDeliveryOptions): void {
    if (obj.kind !== 'data' || !obj.payload) return;
    if (!this.admitLocmafConsumerInput('eventtimeline', trackName, obj, input)) return;
    const rawBoxes = this.locmafRawBoxes('eventtimeline', trackName, obj, delivery);
    if (rawBoxes === undefined) return;
    if (rawBoxes && isCmafHeader(rawBoxes)) {
      this.noteLocmafInBandHeader(trackName, rawBoxes, BigInt(obj.trackAlias), delivery);
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

  /**
   * LOCMAF is an ordered consumer (§3). Its actual decoder, shared by aliases
   * of one resolved track, already owns the bounded per-group input frontier.
   * Older input is locally stale, not proof that every earlier ID was seen.
   * Failed attempts never advance it; a native consumer reset removes it.
   */
  private admitLocmafConsumerInput(mediaType: 'video' | 'audio' | 'eventtimeline', trackName: string,
    obj: MoqtObject, input?: ObjectRoutingContext): boolean {
    const last = this.locmafDecoders.get(this.mediaKey(trackName, mediaType, BigInt(obj.trackAlias)))
      ?.getLastObjectId(BigInt(obj.groupId));
    if (last === undefined || obj.objectId > last) return true;
    this.discardMediaInput(input, obj.objectId === last ? 'treated as a replay' : 'object processing failed');
    return false;
  }

  /** Cancel accepted inputs for the aliases that feed this same decoder. */
  private retireLocmafConsumerInputs(trackName: string, mediaType: string, alias: bigint, groupId?: bigint, preserveDelivery?: ObjectDeliveryOptions): void {
    const key = this.mediaKey(trackName, mediaType, alias);
    const track = this._catalogState?.tracks.find(track => this.initKey(track) === key);
    if (track ? track.packaging !== 'locmaf' : !this.locmafDecoders.has(key) && !this.locmafFrameReaders.has(key)) return;
    this.subscriptionManager?.resetMediaConsumer(alias, groupId, preserveDelivery);
    for (const sub of this.activeSubscriptions.values()) {
      if (sub.trackAlias !== null && sub.trackAlias !== alias && sub.mediaType === mediaType
          && this.mediaKey(sub.trackName, sub.mediaType, sub.trackAlias) === key) {
        this.subscriptionManager?.resetMediaConsumer(sub.trackAlias, groupId, preserveDelivery);
      }
    }
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
    preserveDelivery?: ObjectDeliveryOptions,
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
    this.retireLocmafConsumerInputs(trackName, mediaType, BigInt(obj.trackAlias), groupId, preserveDelivery);
    const decoder = this.locmafDecoders.get(this.mediaKey(trackName, mediaType, BigInt(obj.trackAlias)));
    if (decoder) {
      const result = decoder.push(groupId, BigInt(obj.objectId), payload);
      if (result.kind === 'rejected') {
        this.recordLocmafObjectResult(mediaType, trackName, BigInt(obj.trackAlias), groupId, BigInt(obj.objectId), result.error);
        return undefined;
      }
      return result.kind === 'raw' ? result.bytes : null;
    }
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

  private activeVideoSet(active = this.subscribedTrack('video') ?? this.historicalOutputTrack('video')): readonly CatalogTrack[] {
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
    reference: string | TrackRefConfig,
    reason: string = 'manual',
    abrAction?: 'downshift' | 'upshift',
  ): Promise<void> {
    if (!this._catalogState || !this.connection || !this.subscriptionManager) {
      throw new Error('Cannot switch track: player not loaded');
    }
    const automatic = reason === 'bandwidth' && abrAction !== undefined;
    const automaticController = this.qualityController, automaticSelection = this._selection;
    const automaticManager = this.subscriptionManager, automaticPipeline = this.videoPipeline;
    const automaticGeneration = automaticManager.mediaInputGeneration;
    const automaticAllowed = (): boolean => !automatic || (automaticController !== null
      && this.qualityController === automaticController && automaticController.isAutoQuality
      && this.state === PlayerState.PLAYING && this.playbackIntent === true && this._selection === automaticSelection
      && this.subscriptionManager === automaticManager && automaticManager.mediaInputGeneration === automaticGeneration
      && this.videoPipeline === automaticPipeline);
    if (!automaticAllowed()) return;
    let automaticWithdrawal: Error | undefined;
    if (this.activeLocSeek || this.preparingLocSeek) {
      if (this.activeLocSeek && !this.preparingLocSeek && this.state === PlayerState.PLAYING && this.playbackIntent === true) {
        return this.selectPlayingLocVideoTrack(reference, reason, abrAction, automaticAllowed);
      }
      return this.selectPausedLocVideoTrack(reference, reason);
    }
    if (this._destroyed || this.isTerminalState() || this.currentMigration || this.mediaSelection || this.seekIsPreparing()) {
      throw new Error('Cannot switch track: playback is not accepting selections');
    }
    const switchConn = this.connection;
    const seekOutput = this.ownedSeekOutput;
    const generation = this.bootstrapGeneration;
    const live = (): boolean => !this._destroyed && !this.isTerminalState()
      && this.connection === switchConn && this.bootstrapGeneration === generation
      && !this.seekIsPreparing() && this.ownedSeekOutput === seekOutput;

    const trackName = typeof reference === 'string' ? reference : reference.name;
    const namespace = typeof reference === 'string' ? undefined : namespaceFields(reference.namespace ?? this.config.namespace);
    const matches = (track: CatalogTrack) => track.name === trackName && (namespace === undefined
      || sameNamespaceFields(trackNamespaceFields(track, this.config.namespace), namespace));
    const eligible = this.qualityController?.eligibleLadder(this.activeVideoSet()) ?? [];
    const candidates = eligible.filter(matches);
    if (candidates.length > 1) throw new Error(`Ambiguous video track: "${trackName}"`);
    const catalogMatches = this._catalogState.tracks.filter(t => t.role === 'video' && matches(t));
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

    const historical = this.historicalMseOutput();
    const currentTrack = this.subscribedTrack('video') ?? this.historicalOutputTrack('video');
    if (!currentTrack) throw new Error('Cannot switch track: video selection not ready');
    const currentKey = this.initKey(currentTrack), targetKey = this.initKey(targetTrack);
    // A preparing or retiring video request is not the current output owner.
    let currentVideoRequestId: bigint | null = null;
    let currentVideoTrackName: string | null = null;
    for (const [requestId, sub] of this.activeSubscriptions) {
      if (sub.mediaType === 'video' && identityKey(sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName) === currentKey
          && (sub.trackAlias === null || !this.supersededRouting?.aliases.has(sub.trackAlias))) {
        currentVideoRequestId = requestId;
        currentVideoTrackName = sub.trackName;
        break;
      }
    }

    if (!candidates.includes(targetTrack)) {
      throw new Error(`Cannot switch to "${trackName}": different video altGroup; use selectMedia to change views`);
    }
    if (this.usesMse(targetTrack.packaging) && !this.keyedCmafIdentity && currentTrack.name === targetTrack.name && currentKey !== targetKey) {
      throw new Error('Media adapters cannot distinguish same-name video tracks across namespaces');
    }

    const pending = this.pendingVideoSwitch;
    if (pending && this.initKey(pending.targetTrack) === targetKey && pending.phase !== 'restoring') {
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
    if (currentKey === targetKey) return;
    if (currentVideoRequestId === null && !historical) throw new Error('Cannot switch track: current video subscription is not ready');

    const targetNamespace = trackNamespaceFields(targetTrack, this.config.namespace);
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const sw: NonNullable<MoqtPlayer['pendingVideoSwitch']> = {
      connection: switchConn, generation, mediaSource: this.mediaSource,
      oldRequestId: currentVideoRequestId, oldTrackName: currentVideoTrackName ?? currentTrack.name,
      newTrackName: trackName, newRequestId: null, newTrackPackaging: mediaTrackPackaging(targetTrack.packaging),
      targetTrack, catalog: this._catalogState, initData: undefined, cmafContext: undefined,
      ...(this.keyedCmafIdentity ? {
        oldSourceKey: identityKey(trackNamespaceFields(currentTrack, this.config.namespace), currentTrack.name),
        newSourceKey: identityKey(targetNamespace, trackName),
      } : {}),
      phase: 'preparing', requestReleased: false, failure: undefined, stagedBytes: 0, stagedObjects: 0, stagedSamples: 0, done, settle, reason,
      ...(abrAction ? { abrAction } : {}),
    };
    this.revokeVideoSwitchRecovery();
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
      if (!automaticAllowed()) {
        this.discardPendingVideoSwitch(sw, new Error('Automatic quality request withdrawn before emission'));
        return;
      }
      if (historical && currentVideoRequestId === null) {
        await this.prepareHistoricalVideoSwitch(sw, historical);
        return;
      }
      const nsBytes = targetNamespace.map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(trackName);
      const currentGroup = this.videoPipeline?.currentGroupId ?? -1n;
      const nextGroup = currentGroup >= 0n ? currentGroup + 1n : undefined;
      // One committed fragment proves only part of its Group. Retrieve that
      // whole independent Group on the replacement, preserving its missing tail
      // (CMSF §3.2/§3.4 align Group starts, not fragment completion).
      const mseFloor = this.usesMse(currentTrack.packaging) && this.usesMse(targetTrack.packaging)
        ? sw.oldSourceKey === undefined
          ? sw.mediaSource?.getCommittedGroupFloor?.('video', sw.oldTrackName)
          : sw.mediaSource?.getCommittedGroupFloor?.('video', sw.oldTrackName, sw.oldSourceKey)
        : undefined;
      if (!this.switchIsCurrent(sw)) return;
      const startGroup = mseFloor ?? nextGroup;
      // A subscription filter does not retrieve previously published media.
      // Join the saved head (d18 §10.12.2), or request the initial fill (d22 §3.4).
      const explicitFilter = this.config.subscriptionFilter !== undefined;
      // An explicit caller filter owns the range; automatic gap repair must
      // neither replace it nor add a historical request outside that intent.
      const prefixStart = !explicitFilter && startGroup !== undefined && targetTrack.isLive === true
        ? { group: startGroup, object: 0n } : undefined;
      const fill = prefixStart !== undefined && isDraft22(switchConn.draftVersion);
      let rangeOwner: WarmMediaOwner | null = null;
      // Drafts 14/16 §9.16.2 require LargestObject for Joining FETCH.
      // The FETCH still starts at the required group; the local prefix gate
      // rejects live Objects below that floor when the publisher is behind it.
      const legacyJoin = prefixStart !== undefined
        && (switchConn.draftVersion === 14 || switchConn.draftVersion === 16);
      const subscribeOptions = explicitFilter ? buildSubscribeOptions(this.config) : startGroup !== undefined
        ? { subscriptionFilter: legacyJoin ? { type: 'LargestObject' as const }
          : { type: 'AbsoluteStart' as const, startGroup: varint(startGroup), startObject: varint(0n) },
          ...(fill ? { fill: { filter: { type: 'AbsoluteStart' as const, startGroup, startObject: 0n }, groupOrder: 'ascending' as const } } : {}) }
        : (buildSubscribeOptions(this.config) ?? defaultMediaSubscriptionFilter(targetTrack.isLive === true));
      const register = (id: bigint): void => {
        if (sw.newRequestId !== null) return;
        if (!this.switchIsCurrent(sw) || !this.subscriptionManager) throw new Error('Video switch retired before emission');
        if (!automaticAllowed()) {
          automaticWithdrawal = new Error('Automatic quality request withdrawn before emission');
          throw automaticWithdrawal;
        }
        sw.newRequestId = id;
        sw.phase = 'staging';
        this.armVideoSwitchTimeout(sw, SWITCH_STAGING_TIMEOUT_MS, true);
        this.pendingAliasBinds.add(id);
        this.activeSubscriptions.set(id, { trackName, mediaType: 'video', trackAlias: null, namespace: targetNamespace });
        this.pendingMediaSubs.set(id, { trackName, mediaType: 'video', packaging: sw.newTrackPackaging });
        if (prefixStart) rangeOwner = this.armWarmMediaOwner(switchConn, id, prefixStart);
        if (!this.switchIsCurrent(sw)) throw new Error('Switch retired during history preparation');
        if (fill && rangeOwner) this.registerMediaFetch(id, { trackName, mediaType: 'video',
          subscriptionRequestId: id, trackAlias: null, warmStart: true, warmOwner: rangeOwner }, switchConn);
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
      if (automaticWithdrawal !== undefined && error === automaticWithdrawal) {
        this.discardPendingVideoSwitch(sw, automaticWithdrawal);
        return;
      }
      if (this.switchIsCurrent(sw)) this.abortPendingVideoSwitch(sw, error instanceof Error ? error : new Error(String(error)));
      if (sw.phase !== 'committed') throw error;
    }
  }

  private isVideoSwitchAlias(alias: bigint, side: 'old' | 'new'): boolean {
    const sw = this.pendingVideoSwitch;
    const id = sw && (side === 'old' ? sw.oldRequestId : sw.newRequestId);
    return id !== null && id !== undefined && this.activeSubscriptions.get(id)?.trackAlias === alias;
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
    const delayMs = Math.min(ms, 0x7fffffff);
    // A historical attempt retains its absolute preparation budget as coast tightens it.
    if (sw.oldRequestId === null) {
      sw.deadlineMs = performance.now() + delayMs;
      if (this.pendingVideoSwitch !== sw) return;
    }
    const timer = setTimeout(() => {
      if (this.switchStagingTimeout !== timer) return;
      this.switchStagingTimeout = null;
      if (this.pendingVideoSwitch !== sw) return;
      if (this.pendingRetypes.get('video')?.owner === sw) {
        this.failCatalogPlayback(createPlayerError('fatal', 'player', PlayerErrorCode.CMAF_INIT_INVALID,
          'Video reconfiguration did not settle before its deadline'));
      } else this.abortPendingVideoSwitch(sw, new Error('Video switch deadline elapsed without a usable target'));
    }, delayMs);
    this.switchStagingTimeout = timer;
  }

  private admitVideoSwitchObject(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, bytes: number, samples = 0): boolean {
    if (!this.switchIsCurrent(sw)) return false;
    if (sw.stagedObjects >= SWITCH_STAGING_MAX_OBJECTS || bytes > MoqtPlayer.MAX_STAGED_BYTES - sw.stagedBytes || samples > 1024 - sw.stagedSamples) {
      this.abortPendingVideoSwitch(sw, new Error('Video switch staging capacity exhausted'));
      return false;
    }
    sw.stagedObjects++;
    sw.stagedSamples += samples;
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
    sw.historical?.cancel();
    sw.frame?.cancel();
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
    if (this.usesMse(sw.newTrackPackaging)) {
      const subscription = this.activeSubscriptions.get(sw.newRequestId);
      const owner = subscription ? this.warmMediaOwners.get(subscription) : undefined;
      // FIN only closes reception. The head settles each async transform before
      // reporting preparation complete, while the old output remains owned.
      if (owner?.prefixStart && owner.head?.state === 'prefix') return;
    }
    sw.phase = 'committing';
    this.switchInProgress = true;

    this.armVideoSwitchTimeout(sw, this.config.connectionTimeoutMs || SWITCH_STAGING_TIMEOUT_MS, true);

    if (!this.connection || !this.subscriptionManager) {
      this.pendingVideoSwitch = null;
      this.switchInProgress = false;
      this.videoSwitchSettled();
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

    if (!this.switchStagingBuffer.some(entry => this.independentFrameEntry(entry))) {
      this.abortPendingVideoSwitch(sw, new Error('No independently decodable target frame arrived'));
      return;
    }
    this.unsubscribeOldVideoTrack(sw);

    // Reset from the independent carrier's Group, not a preceding partial
    // tail. Typed batches identify independence through their sample metadata.
    const keyframeEntry = this.switchStagingBuffer.find(
      s => this.independentFrameEntry(s),
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
    const keyframeIdx = staged.findIndex(s => this.independentFrameEntry(s));
    const toFlush = keyframeIdx >= 0 ? staged.slice(keyframeIdx) : staged;
    for (const entry of keyframeIdx > 0 ? staged.slice(0, keyframeIdx) : []) this.discardMediaInput(entry.input, 'awaiting keyframe');
    for (const { obj: stagedObj, headers: stagedHeaders, samples, input } of toFlush) {
      if (!this.videoPipeline) this.discardMediaInput(input, 'not attached');
      else if (samples && stagedObj.kind === 'data') this.videoPipeline.pushSampleObject(stagedObj, samples, input, { allowIndependentGap: samples[0]?.chunk.type === 'key' });
      else if (input) this.videoPipeline.pushObject(stagedObj, stagedHeaders, input);
      else this.videoPipeline.pushObject(stagedObj, stagedHeaders);
    }

    this.flushCmafStagedBuffer(sw);

    // Re-anchor A/V sync from the new track's first frame. Without this,
    // the sync controller keeps the old track's timing reference, and the
    // keyframe wait gap (decoder in NEEDS_KEYFRAME, audio keeps playing)
    // becomes a permanent A/V offset.
    const targetSubscription = sw.newRequestId === null ? undefined : this.activeSubscriptions.get(sw.newRequestId);
    const retainedPrefix = targetSubscription !== undefined && this.warmMediaOwners.get(targetSubscription)?.prefixStart !== undefined;
    if (!this.audioTimingMapped && !this.videoTimingMapped) {
      // Keep the switch's existing sync policy, but do not revoke target
      // inputs already retained by this owner-local history retrieval.
      this.resetMediaClock(retainedPrefix);
    }

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
      if (sw.liveRestart) {
        // The restart may begin well past the outgoing media. Unless the media source can own
        // that crossing, decline now, while the outgoing rendition is still the output.
        const handle = source?.reserveSwitchRecovery?.({ mediaType: 'video', trackName: sw.newTrackName,
          ...(sw.newSourceKey !== undefined ? { sourceKey: sw.newSourceKey } : {}) }) ?? null;
        // The media source ran: this switch may have been cancelled or replaced meanwhile.
        if (!this.switchIsCurrent(sw)) {
          try { handle?.revoke(); } catch { /* Never installed; nothing else to undo. */ }
          return;
        }
        if (!handle) throw new Error('Media source cannot recover a live restart of this video switch');
        // Installing a pending switch already released its predecessor's handle, so none is normally held here.
        // Releasing one calls the media source again, so this switch is rechecked before its own handle is kept.
        this.revokeVideoSwitchRecovery();
        if (!this.switchIsCurrent(sw)) {
          try { handle.revoke(); } catch { /* Never installed; nothing else to undo. */ }
          return;
        }
        this.videoSwitchRecovery = { owner: sw, handle };
      }
      if (initData !== undefined) {
        if (source?.changeType) {
          if (previous === undefined) throw new Error('Cannot reconfigure video without its running initialization');
          const offset = source.getTimestampOffset?.('video');
          if (!this.switchIsCurrent(sw)) { this.revokeVideoSwitchRecovery(sw); return; }
          await this.applyMediaRetype(sw, { source, mediaType: 'video', codec: track.codec ?? '', next: initData,
            previousCodec, previous, offset });
        } else if (previous === undefined || !bytesEqual(previous, initData)
            || !codecsCompatible(previousCodec, track.codec ?? '')) {
          throw new Error('Media source cannot reconfigure the video initialization');
        }
      }
      if (!this.switchIsCurrent(sw)) {
        this.revokeVideoSwitchRecovery(sw);
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
      this.selectCmafTrack(assembler, 'video', sw.newTrackName, sw.newSourceKey);
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
      if (this.videoSwitchRecovery?.owner === sw) this.videoSwitchRecovery.handle.activate();
      this.flushCmafStagedBuffer(sw);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.revokeVideoSwitchRecovery(sw);
      if (committed) {
        this.failCatalogPlayback(createPlayerError('fatal', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
          'Video switch failed after retiring the previous rendition', { cause }));
        return;
      }
      if (assemblerChanged && !this._destroyed && assembler === this.cmafAssembler) {
        try {
          this.selectCmafTrack(assembler, 'video', sw.oldTrackName, sw.oldSourceKey);
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
        this.videoSwitchSettled();
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
    if (!this.switchIsCurrent(sw) || !this.subscriptionManager || sw.oldRequestId === null) return;
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
    this.selectCmafTrack(this.cmafAssembler, 'video', sw.newTrackName, sw.newSourceKey);
    if (!this.switchIsCurrent(sw)) return;
    const staged = this.cmafSwitchStagingBuffer;
    this.cmafSwitchStagingBuffer = [];
    const firstSync = staged.findIndex(entry => entry.sync);
    const cmafStaged = firstSync < 0 ? [] : staged.slice(firstSync);
    for (const entry of firstSync < 0 ? staged : staged.slice(0, firstSync)) this.discardMediaInput(entry.input, 'awaiting keyframe');
    let replayed = 0;
    try {
      for (const { trackName: stagedTrack, sourceKey, mediaType: stagedMt, groupId, objectId, payload, input } of cmafStaged) {
        if (!this.switchIsCurrent(sw)) break;
        this.pushCmafInput(stagedMt, stagedTrack, groupId, payload, input, sourceKey, objectId);
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
    this.commitVideoSwitch(sw);
  }

  private commitVideoSwitch(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>,
    adopted?: { readonly track: CatalogTrack; readonly identity: TrackIdentity }): void {
    sw.phase = 'committed';
    sw.settle();
    if (this.switchStagingTimeout !== null) {
      clearTimeout(this.switchStagingTimeout);
      this.switchStagingTimeout = null;
    }
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;
    this.videoSwitchSettled();

    // Switch is now committed — commit controllers, record stat, fire event.
    // All mutation is deferred to this point. ABR/recovery initiation paths
    // use non-mutating peeks so abort leaves state unchanged.
    const issued = sw.newRequestId === null ? undefined : this.activeSubscriptions.get(sw.newRequestId);
    const newTrack = adopted?.track ?? (issued === undefined ? undefined : this.catalogTrackFor(sw.newTrackName,
      issued.namespace ?? namespaceFields(this.config.namespace), 'video'));
    this.commitVideoQuality(newTrack);
    if (adopted && sw.historical) sw.historical.attempt.videoSelection = this.mseSelection('video');
    this.refreshMediaSelection({ video: adopted?.identity ?? this.acceptedSelection('video') });
    this.emitQualityEvent('quality_switched', {
      type: 'quality_switched',
      fromTrackName: sw.oldTrackName,
      toTrackName: sw.newTrackName,
      reason: sw.reason,
    });
  }

  /** End the held recovery; with `owner`, only if that switch holds it. Cleared before the media source is called. */
  private revokeVideoSwitchRecovery(owner?: object): void {
    const held = this.videoSwitchRecovery;
    if (!held || (owner !== undefined && held.owner !== owner)) return;
    this.videoSwitchRecovery = null;
    try { held.handle.revoke(); } catch { /* A media source fault here must not interrupt teardown. */ }
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
    this.revokeVideoSwitchRecovery(sw);
    sw.phase = 'retired';
    sw.failure = cause;
    sw.settle();
    this.retireVideoSwitchTarget(sw);
    if (this.pendingVideoSwitch !== sw) return false;
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;
    this.videoSwitchSettled();
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
    this.revokeVideoSwitchRecovery(sw);
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
        this.mediaDiagnosticEpoch = runtime ? {} : undefined;
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
      for (const dispatcher of binding.dispatchers) dispatcher.outputObserver = undefined;
      binding = undefined;
    }
    if (!runtime) return;
    if (!binding) {
      binding = { runtime, pipelines: [], dispatchers: [], refused: 0,
        input: (input, reason) => runtime.discarded(input, reason),
        output: { decoded: (kind, input, target) => runtime.decoded(kind, input, target),
          discarded: (unit, reason) => runtime.discardUnit(unit, reason) },
      };
      this.locDiagnosticBindings = binding;
    }
    const graphs = [...this.retiringLocDiagnosticGraphs ?? [], ...[this.preparingLocSeek, this.activeLocSeek].flatMap(attempt => {
      return attempt ? [...attempt.playback.videoDiagnosticGraphs, ...(attempt.output ? [attempt.output] : []),
        ...(attempt.videoOutput ? [attempt.videoOutput] : [])] : [];
    })];
    const pipelines = [...new Set([this.videoPipeline, this.audioPipeline,
      ...graphs.flatMap(graph => [graph.pipelines.videoPipeline, graph.pipelines.audioPipeline])]
      .filter((pipeline): pipeline is PlaybackPipeline => pipeline !== null))];
    const dispatchers = [...new Set([this.commandDispatcher, this.videoCommandDispatcher(), ...graphs.map(graph => graph.pipelines.commandDispatcher)]
      .filter((dispatcher): dispatcher is CommandDispatcher => dispatcher !== null))];
    for (const previous of binding.pipelines) if (!pipelines.includes(previous)) {
      binding.refused += previous.inputEvidenceLossCount;
      if (previous.inputObserver === binding.input) previous.inputObserver = undefined;
    }
    for (const pipeline of pipelines) if (!binding.pipelines.includes(pipeline)) pipeline.inputObserver = binding.input;
    binding.pipelines = pipelines;
    // Prepared graphs decode before adoption. Keep both owners observed and
    // preserve unchanged bindings, including units already held for output.
    for (const previous of binding.dispatchers) if (!dispatchers.includes(previous)) previous.outputObserver = undefined;
    for (const dispatcher of dispatchers) if (!binding.dispatchers.includes(dispatcher)) dispatcher.outputObserver = binding.output;
    binding.dispatchers = dispatchers;
  }

  private discardMediaInput(input: ObjectRoutingContext | undefined, reason: MediaDiscardReason): void {
    if (!input) return;
    try { const pending = this.mediaDiagnosticRuntime?.discarded(input, reason); if (pending) void Promise.resolve(pending).catch(() => {}); }
    catch { /* Optional outcomes must not affect playback. */ }
  }

  private selectCmafTrack(assembler: CmafAssemblerLike | null, role: 'video' | 'audio', name: string, sourceKey?: string): void {
    if (this.keyedCmafIdentity && sourceKey === undefined) throw new Error('CMAF selection is missing its source identity');
    if (sourceKey === undefined) assembler?.selectTrack?.(role, name);
    else assembler?.selectTrack?.(role, name, sourceKey);
  }

  private pushCmafInput(mediaType: 'video' | 'audio', trackName: string, groupId: bigint, payload: Uint8Array,
    input?: ObjectRoutingContext, sourceKey?: string, objectId?: bigint,
    lagOwner?: NonNullable<MoqtPlayer['videoDeliveryLag']>['owner']): void {
    const assembler = this.cmafAssembler;
    if (this.keyedCmafIdentity && sourceKey === undefined) {
      this.discardMediaInput(input, 'route retired'); return;
    }
    const collectTimeline = mediaType === 'audio' ? this.collectAudioTimeline : this.collectVideoTimeline;
    if (!collectTimeline && lagOwner === undefined) {
      if (objectId !== undefined) assembler?.push(mediaType, trackName, groupId, payload, input, undefined, sourceKey, objectId);
      else if (sourceKey !== undefined) assembler?.push(mediaType, trackName, groupId, payload, input, undefined, sourceKey);
      else if (input === undefined) assembler?.push(mediaType, trackName, groupId, payload);
      else assembler?.push(mediaType, trackName, groupId, payload, input);
      return;
    }
    const conn = this.connection;
    const source = this.mediaSource;
    const selected = this._selection[mediaType];
    const owned = [...this.activeSubscriptions.values()].find(sub => sub.mediaType === mediaType && sub.trackAlias !== null
      && sub.trackName === selected?.name && sameNamespaceFields(sub.namespace ?? namespaceFields(this.config.namespace), selected.namespaceFields));
    const route = owned?.trackAlias === null || owned?.trackAlias === undefined ? null : this.subscriptionManager?.captureRoute(owned.trackAlias);
    const receipt = objectId !== undefined ? assembler?.push(mediaType, trackName, groupId, payload, input, true, sourceKey, objectId)
      : sourceKey === undefined ? assembler?.push(mediaType, trackName, groupId, payload, input, true)
      : assembler?.push(mediaType, trackName, groupId, payload, input, true, sourceKey);
    if (collectTimeline && receipt?.state === 'emitted' && !this._destroyed && this.connection === conn && this.mediaSource === source
        && this.cmafAssembler === assembler && route?.() && [...this.activeSubscriptions.values()].includes(owned!)
        && (sourceKey === undefined || selected !== null && sourceKey === identityKey(selected.namespaceFields, selected.name))) {
      this.noteMediaTimeline(mediaType, receipt.sourcePresentationTimeUs, 'media-time');
    }
    if (lagOwner) this.recordCmafDeliveryReceipt(lagOwner, receipt);
  }

  private recordCmafDeliveryReceipt(lagOwner: NonNullable<MoqtPlayer['videoDeliveryLag']>['owner'], receipt: CmafSourceReceipt | void): void {
    const decode = receipt?.state === 'emitted' ? receipt.sourceDecodeTime : undefined;
    if (decode && typeof decode.timeUs === 'bigint'
        && Number.isSafeInteger(decode.timescale) && decode.timescale > 0
        && typeof decode.placementToken === 'object' && decode.placementToken !== null
        && this.cmafLagPlacementIsCurrent(lagOwner, decode.placementToken)) {
      this.recordVideoDeliveryPoint(lagOwner, decode.timeUs, BigInt(decode.timescale), decode.placementToken);
    }
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
      decodedVideoCount: this.videoCommandDispatcher()?.canObserveDecodedOutputs('video') ? runtime.decodedVideoCount : null,
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
   * Run `listener` once when destroy() tears this player down. Unlike a
   * state_changed for ENDED, this fires even when destroy() is re-entered
   * from a state listener and the queued ENDED is never announced.
   */
  observeDestroy(listener: () => void): () => void {
    if (this._destroyed) return () => {};
    (this.destroyObservers ??= new Set()).add(listener);
    return () => { this.destroyObservers?.delete(listener); };
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
    this.audioTimelineRecord = null; this.videoTimelineRecord = null; this.collectAudioTimeline = false; this.collectVideoTimeline = false; this.selectedOutputOwners.clear(); this.runtimeAudioIntent = null; this.runtimeAudioLanguage = null; this.runtimeSelectionIntent = null; this.mappedClockOwner = null; this.videoPresentationOffsetUs = 0n; this.videoTimingMapped = false; this.videoTimingSource = undefined; this.audioPresentationOffsetUs = 0n; this.audioTimingMapped = false; this.audioTimingSource = undefined;
    this._selection = emptyMediaSelection(this._selection.revision + 1, this.config.autoQuality !== false);
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
    this.retireVideoMeasurement();

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
      const cadenceOwner = mediaType === 'video' && !delivery?.backfill && !delivery?.fetched && delivery?.identity
        ? this.cadenceInputOwners.get(delivery.identity) ?? null : null;
      const inputManager = this.subscriptionManager;
      const inputGeneration = inputManager?.mediaInputGeneration;
      if ((mediaType === 'audio' || mediaType === 'video') && this.stagePreparedMediaInput(obj, headers, input, () =>
        this.subscriptionManager?.onObject?.(mediaType, trackName, obj, headers, input, delivery), delivery)) return;
      // Liveness: ANY object on this track (data, gap, or staged-for-switch)
      // proves the delivery path is alive — stamp before every early return.
      this.stampMediaArrival(BigInt(obj.trackAlias));

      // Make-before-break track switch: stage new-track objects until a
      // keyframe arrives, keeping the old track playing the entire time.
      // @see draft-ietf-moq-msf-00 §4.2 (seamless switch at group boundaries)
      if (this.pendingVideoSwitch && mediaType === 'video'
          && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'new')) {
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

      if (delivery?.isLive?.() === false || this.subscriptionManager?.mediaInputGeneration !== inputGeneration) {
        this.discardMediaInput(input, this.stateMachine.state === PlayerState.PAUSED ? 'paused' : 'route retired'); return;
      }

      // After switch commit starts (switchInProgress), drop old-track
      // objects. During the overlap window BEFORE commit, old-track
      // objects must keep flowing to sustain playback until the new
      // track's keyframe arrives.
      if (this.switchInProgress && this.pendingVideoSwitch
          && mediaType === 'video'
          && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'old')) {
        this.discardMediaInput(input, 'track superseded'); return;
      }

      // Route through pipeline for decode processing (LOC §4.2)
      // Drop objects while paused — the pipeline isn't ticking (not draining),
      // so buffering them just fills the jitter buffer and triggers
      // buffer_overflow recovery spam. On resume, pipeline.reset() clears
      // stale state and fresh objects arrive via REQUEST_UPDATE forward:1.
      if (this.stateMachine.state === PlayerState.PAUSED) { this.discardMediaInput(input, 'paused'); return; }
      const pipeline = mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
      if (pipeline && mediaType === 'video' && !delivery?.backfill && !delivery?.fetched) {
        this.recordLocGroupCadence(obj, headers, cadenceOwner);
        this.recordVideoDeliveryLag(obj, headers, cadenceOwner, obj.kind === 'data' ? obj.payload.byteLength : 0);
        // Observation clocks may reenter the player. Measurement refusal alone
        // does not revoke the media work captured before that callback.
        const deliveryCurrent = delivery?.isLive?.() !== false;
        const deliveryState = this.state;
        if (!deliveryCurrent || this._destroyed || this.subscriptionManager !== inputManager
            || inputManager?.mediaInputGeneration !== inputGeneration
            || pipeline !== (mediaType === 'video' ? this.videoPipeline : this.audioPipeline)
            || deliveryState === PlayerState.PAUSED
            || deliveryState === PlayerState.ENDED || deliveryState === PlayerState.ERROR) {
          this.discardMediaInput(input, deliveryState === PlayerState.PAUSED ? 'paused' : 'route retired'); return;
        }
      }
      if (!pipeline) this.discardMediaInput(input, 'not attached');
      else if (delivery?.backfill) pipeline.pushObject(obj, headers, input, { backfill: true });
      else if (input) pipeline.pushObject(obj, headers, input);
      else pipeline.pushObject(obj, headers);
    };

    // Wire LOCMAF object delivery → reconstruction into CMAF chunks → assembler.
    // @see draft-einarsson-moq-locmaf-01 §15, §16
    this.subscriptionManager.onLocmafObject = (mediaType, trackName, obj, input, delivery?: ObjectDeliveryOptions) => {
      if ((mediaType === 'audio' || mediaType === 'video') && this.stagePreparedMediaInput(obj, undefined, input, () =>
        this.subscriptionManager?.onLocmafObject?.(mediaType, trackName, obj, input, delivery), delivery)) return;
      this.onLocmafMediaObject(mediaType, trackName, obj, input, delivery);
    };

    // Wire CMAF object delivery → MediaSource adapter (pipeline bypass)
    // §3.3: CMAF objects are moof or mdat — concatenate then feed to MSE
    this.subscriptionManager.onCmafObject = (mediaType, trackName, obj, input, delivery?: ObjectDeliveryOptions) => {
      const lagOwner = this.captureCmafLagOwner(mediaType, obj, delivery);
      const inputGeneration = this.subscriptionManager?.mediaInputGeneration;
      const sourceKey = this.keyedCmafIdentity ? this.subscriptionManager?.getSourceKey(BigInt(obj.trackAlias)) : undefined;
      if ((mediaType === 'audio' || mediaType === 'video') && this.stagePreparedMediaInput(obj, undefined, input, () =>
        this.subscriptionManager?.onCmafObject?.(mediaType, trackName, obj, input, delivery), delivery)) return;
      // Liveness: stamp before every early return (gates, staging, drops).
      this.stampMediaArrival(BigInt(obj.trackAlias));

      // CMAF switch completion handled at raw onObject level (above)

      // Stats
      this._stats.recordFirstObjectReceived();
      if (obj.kind === 'data') {
        const bytes = obj.payload ? obj.payload.byteLength : 0;
        this._stats.recordMediaObject(bytes);

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

      if (delivery?.isLive?.() === false || this.subscriptionManager?.mediaInputGeneration !== inputGeneration) {
        this.discardMediaInput(input, this.stateMachine.state === PlayerState.PAUSED ? 'paused' : 'route retired'); return;
      }
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
          && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'old')) {
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
          && this.isVideoSwitchAlias(BigInt(obj.trackAlias), 'new')) {
        if (!this.admitVideoSwitchObject(this.pendingVideoSwitch, obj.payload.byteLength)) {
          this.discardMediaInput(input, 'track superseded'); return;
        }
        // CMSF §3.4 requires a group-start SAP. Retain that fallback for
        // unreadable/legacy split chunks, but never override a known non-sync sample.
        const sync = this.cmafSwitchSync(this.pendingVideoSwitch, obj.payload)
          ?? BigInt(obj.objectId) === 0n;
        this.cmafSwitchStagingBuffer.push({
          trackName, ...(sourceKey === undefined ? {} : { sourceKey }), mediaType, groupId: BigInt(obj.groupId), objectId: BigInt(obj.objectId), payload: obj.payload, sync,
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
        const floor = sourceKey === undefined ? this.mediaSource.getCommittedGroupFloor?.(mediaType, trackName)
          : this.mediaSource.getCommittedGroupFloor?.(mediaType, trackName, sourceKey);
        if (floor !== undefined && groupId < floor) { this.discardMediaInput(input, 'stale group'); return; }
      }

      // Feed through assembler: pairs moof+mdat per group, patches tfdt, emits segments.
      this.pushCmafInput(mediaType, trackName, groupId, obj.payload, input, sourceKey, BigInt(obj.objectId), lagOwner);
    };

    // §2.4.2: Malformed Track — MUST UNSUBSCRIBE, SHOULD deliver error
    this.subscriptionManager.onMalformedTrack = (trackAlias, _mediaType, trackName, error, sourceConnection) => {
      const audio = this.mediaSelection;
      if (audio && !audio.committed && sourceConnection === audio.conn
          && [...audio.prep.media.values()].some(sub => sub.alias === trackAlias)) {
        this.failMediaSelection(audio, error); return;
      }
      this.handleMalformedTrack(trackAlias, trackName, error, sourceConnection as MoqtConnection | undefined);
    };

    // §7: Media timeline object delivery → update timeline state
    this.subscriptionManager.onTimelineObject = (trackName, obj) => {
      if (obj.kind !== 'data' || !obj.payload) return;
      if (!this.timelineState) return;
      const source = this.timelineSource;
      const subscription = this.timelineRequestId === null ? undefined : this.activeSubscriptions.get(this.timelineRequestId);
      if (!source || source.connection !== this.connection || source.trackName !== trackName
          || !subscription || subscription.trackAlias === null || subscription.trackAlias !== BigInt(obj.trackAlias)
          || subscription.namespace === undefined || !sameNamespaceFields(subscription.namespace, source.namespace)) return;

      const timeline = this.timelineState;
      const prevEntryCount = timeline.entries.length;
      const entries = parseMediaTimeline(obj.payload);
      for (const attempt of [this.preparingLocSeek, this.activeLocSeek]) {
        if (attempt?.connection === source.connection && attempt.timelineSource === source) attempt.playback.observeTimeline(entries);
      }
      // A failed mapping may retire playback and synchronously invoke public
      // hooks. Do not publish metadata into a replacement source or lifetime.
      if (this._destroyed || this.isTerminalState() || this.timelineSource !== source || this.timelineState !== timeline
          || this.connection !== source.connection || this.activeSubscriptions.get(this.timelineRequestId!) !== subscription) return;
      const merged = mergeTimelineEntries(timeline, entries);
      this.timelineState = merged;
      const current = () => !this._destroyed && !this.isTerminalState()
        && this.timelineSource === source && this.timelineState === merged && this.connection === source.connection
        && this.timelineRequestId !== null && this.activeSubscriptions.get(this.timelineRequestId) === subscription;
      for (const attempt of [this.preparingMseSeek, this.activeMseSeek]) {
        if (!current()) return;
        attempt?.pump();
      }
      for (const attempt of [this.preparingLocSeek, this.activeLocSeek]) {
        for (const owner of attempt?.retrievals.values() ?? []) {
          if (!current()) return;
          owner.pump();
        }
      }
      if (!current()) return;

      const duration = getTimelineDuration(merged);
      if (prevEntryCount === 0) {
        // First timeline payload — emit timeline_loaded
        this.emitter.emit('timeline_loaded', {
          type: 'timeline_loaded',
          trackName,
          entryCount: this.timelineState.entries.length,
          ...(duration !== undefined ? { duration } : {}),
        });
        if (duration !== undefined && current()) {
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
      if (this.receivePreparedMediaInit(obj, source)) return;
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
        nsTuple, this.config.catalogTrackName);
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
      this.refreshMediaSelection();
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
              { ...(knownTrackOptions ?? {}), ...this.subscriberPriorityFor(mediaType), ...this.mediaTerminalOptions(conn), onRequestId: (id: bigint) => { knownRegisteredId = id; registerKnownSub(id); } } as never,
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
    const nameBytes = this.enc.encode(this.config.catalogTrackName);
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
    if (this.state === PlayerState.PAUSED && this.preparingLocSeek?.quality) this.retireLocSeek(this.preparingLocSeek);
    const fromState = this.applyState(PlayerState.PLAYING);
    const activeQuality = this.activeLocSeek?.quality;
    activeQuality?.settle(new Error('Frame quality cancelled by play before its preview'));
    if (activeQuality) activeQuality.preparation = null;
    const locActive = this.activeLocSeek, locPreparing = this.preparingLocSeek;
    const locHistory = fromState === PlayerState.PAUSED && (locActive !== null || locPreparing !== null);
    const locResumeMs = locHistory && locPreparing === null ? this.playbackPositionMs : null;
    const locConnection = this.connection, locSelection = this._selection;

    // Playback intent is the player's to declare. The media source may buffer
    // whenever data arrives, but must not start playing on its own. Recorded so
    // an adapter created LATER inherits it (see createPipelines wiring).
    this.playbackIntent = true;
    this.seekPosition?.setPlaying(true);
    this.activeMseSeek?.playback.setPlaying(true);
    this.preparingMseSeek?.playback.setPlaying(true);
    this.preparingLocSeek?.playback.setPlaying(true);
    if (!this.ownedSeekOutput) this.mediaSource?.setPlaybackIntent?.(true);
    else if (this.ownedSeekOutput.resource.current && this.ownedSeekOutput.resource.sample()) this.ownedSeekOutput.resource.setPlaybackIntent(true);
    this._stats.recordPlayStart();

    // Resuming from pause on a live stream: the media position has moved on.
    // Reset pipeline state so the first arriving group is accepted cleanly
    // without cascading gap-recovery escalation from the stale pre-pause position.
    if (fromState === PlayerState.PAUSED && !locHistory) {
      this.videoPipeline?.reset();
      this.audioPipeline?.reset();
      this.resetMediaClock();
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

    // Publish the completed play intent before historical preparation can
    // publish seeking. A listener's newer pause, seek or selection wins.
    this.announceState(fromState, PlayerState.PLAYING);
    if (locResumeMs !== null && !this._destroyed && this.playbackIntent === true
        && this.state === PlayerState.PLAYING && this.connection === locConnection
        && this._selection === locSelection && this.activeLocSeek === locActive && this.preparingLocSeek === locPreparing) {
      this.resumeLocPlayback(locResumeMs);
    }
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
    this.subscriptionManager?.invalidateMediaInputs();
    this.playbackIntent = false;
    this.pendingVideoSwitch?.frame?.cancelPending();
    this.seekPosition?.setPlaying(false);
    this.activeMseSeek?.playback.setPlaying(false);
    this.preparingMseSeek?.playback.setPlaying(false);
    const failures: unknown[] = [];
    const preparingLoc = this.preparingLocSeek, priorLoc = this.activeLocSeek;
    if (preparingLoc?.reason === 'resume') {
      // A new pause cancels internal work started by play(), unlike an
      // explicit user seek whose paused preview is still wanted.
      try { this.retireLocSeek(preparingLoc); } catch (error) { failures.push(error); }
      if (priorLoc && this.activeLocSeek === priorLoc && this.preparingLocSeek === null
          && this.locSeekAdmission === preparingLoc.epoch && this.playbackIntent === false
          && this.state === PlayerState.PAUSED && !this._destroyed) {
        const position = priorLoc.playback.readPositionMs();
        if (position !== null && this.seekPosition) {
          this.seekPosition.begin(priorLoc.epoch, position);
          this.seekPosition.activate(priorLoc.epoch, () => priorLoc.playback.readPositionMs());
        }
      }
    } else preparingLoc?.playback.setPlaying(false);
    const pausedLoc = this.activeLocSeek;
    try { pausedLoc?.playback.setPlaying(false, this.playbackPositionMs); } catch (error) { failures.push(error); }
    for (const owner of pausedLoc?.retrievals.values() ?? []) {
      try { owner.cancel(); } catch (error) { failures.push(error); }
    }
    this.mediaSource?.setPlaybackIntent?.(false);
    this._stats.recordPlayStop();
    this.stopTicking();
    this.cancelLivenessRestarts();

    // Flush pre-scheduled audio and queued video frames immediately
    try { this.commandDispatcher?.flush(); } catch (error) { failures.push(error); }

    // §9.11: REQUEST_UPDATE with forward:0 pauses delivery at source
    // §9.2.2.8: FORWARD=0 means "don't forward" — pause at source
    if (this.connection) {
      this.sendForwardUpdate(0);
    }

    try { this.announceState(fromState, PlayerState.PAUSED); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Playback pause failed');
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
   * Resolves the target through the selected tracks' media timeline. MSE and
   * frame outputs prepare bounded historical FETCH delivery under a new output
   * owner; current playback remains authoritative until adoption. Custom adapters
   * must provide the required seek/output capabilities or the request is refused.
   *
   * Resolving this method acknowledges preparation, not rendered completion.
   * Observe `seeked` for the adopted output's position. The legacy fallback for
   * other output configurations updates subscription filters in place.
   *
   * @param timeMs Target media presentation timestamp in milliseconds.
   * @throws If the target, timeline coverage, state, or output capabilities are unavailable.
   *
   * @see draft-ietf-moq-msf-00 §7 (Media Timeline for PTS→location lookup)
   * @see draft-ietf-moq-msf-01 §7.2 (Timeline dependency coverage)
   */
  async seek(timeMs: number): Promise<void> {
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new RangeError('Seek target must be finite and nonnegative');
    }
    // Guard: player must be in a seekable state
    const s = this.stateMachine.state;
    if (s !== PlayerState.PLAYING && s !== PlayerState.PAUSED) {
      throw new Error(`Cannot seek in state ${s}; expected playing or paused`);
    }

    const context = this.getSeekContext();
    if ('error' in context) throw new Error(context.error);
    const { timeline, mediaSubscriptions } = context;

    // §7: Look up the MOQT location for the target PTS
    const target = findSeekTarget(timeline, timeMs);
    if (!target) {
      throw new RangeError(`Seek target ${timeMs}ms is before the first timeline sample`);
    }

    if (this.mediaSource && this.cmafAssembler && this.cmafInitialized) {
      this.startMseSeek(timeMs, target, context);
      return;
    }
    const selectedTracks = (['video', 'audio'] as const).flatMap(role => {
      const selected = this._selection[role];
      return selected ? [this.subscribedTrack(role) ?? this.catalogTrackFor(selected.name, selected.namespaceFields, role)] : [];
    });
    if (selectedTracks.length && selectedTracks.every(track => track?.packaging === 'loc'
        || track?.packaging === 'locmaf' && this.locmafFramePath)) {
      this.startLocSeek(timeMs, target, context);
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
    for (const sub of this.activeSubscriptions.values()) {
      if (sub.trackAlias !== null) this.subscriptionManager?.setMinimumMediaLocation(sub.trackAlias, undefined);
    }
    this.subscriptionManager?.resetMediaConsumer();
    for (const decoder of this.locmafDecoders.values()) decoder.reset();
    this.clearLocmafFrameReaders();
    this.videoPipeline?.reset(targetGroupBigInt);
    this.audioPipeline?.reset(targetGroupBigInt);
    this.resetMediaClock();
    this.commandDispatcher?.flush();

    // §9.2.2.5: Send REQUEST_UPDATE with AbsoluteStart filter for each
    // active MEDIA subscription (not timeline subscription).
    if (this.connection) {
      for (const [requestId] of mediaSubscriptions) {
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
    pending?: PendingGoaway,
  ): Promise<void> {
    if (this._destroyed) throw new Error('Cannot migrate: player is destroyed');
    if (this.isTerminalState()) throw new Error('Cannot migrate: playback has terminated');
    if (this.currentMigration) throw new Error('Cannot migrate: a migration is already in progress');
    if (this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.seekIsPreparing()) {
      throw new Error('Cannot migrate: media selection is busy');
    }
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
      oldTerminal: pending?.sourceConnection === oldConnection ? pending.oldTerminal : undefined,
    };
    if (pending) pending.oldTerminal = undefined; // Evidence now belongs to the attempt.
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
    // commitMigration CAN throw part-way (an application listener it emits to,
    // a media adapter it calls). Adoption is then half-applied and cannot be
    // trusted either way, so the handover fails fatally instead.
    let commitFault: { error: unknown } | undefined;
    try {
      try {
        this.commitMigration(txn, newConnection);
      } catch (error) {
        commitFault = { error };
        this.failMigrationCommit(txn, newConnection, error);
      }
      if (commitFault === undefined) this.drainStagedCandidate(txn);
    } finally {
      try {
        // Never retire a session the player is still holding: a commit that
        // threw before switching left `this.connection` on the old one.
        if (this.connection !== oldConnection) await this.retireMigratedSession(oldConnection);
        this.pruneSupersededSubscriptions(txn);
      } finally {
        if (this.currentMigration === txn) this.currentMigration = null;
        this.processPendingGoaway();
      }
    }
    if (commitFault !== undefined) throw commitFault.error;
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
    // Readiness has two faces and the attempt awaits them in sequence, so a
    // failure settles BOTH — whichever one is currently awaited must reject,
    // and the other must not be left unsettled to strand the attempt. Each
    // therefore carries its own handler: without it the face nobody is waiting
    // on rejects into no owner, which surfaces as an unhandled rejection even
    // though the attempt itself was failed correctly.
    void catalog.catch(() => { /* owned by whichever stage awaits it */ });
    return {
      catalog, resolveCatalog, rejectCatalog, state: null,
      ...createPreparedMediaSelection(),
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
    const nameBytes = this.enc.encode(this.config.catalogTrackName);
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
    const audioLanguages = this.effectiveAudioLanguages();
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
      ...(this.runtimeSelectionIntent?.scope !== undefined
        ? { scope: this.runtimeSelectionIntent.scope.kind === 'render-group' ? this.runtimeSelectionIntent.scope.renderGroup : null }
        : this.config.selection?.renderGroup !== undefined
        ? { scope: this.config.selection.renderGroup }
        : activeScope !== undefined ? { scope: activeScope.renderGroup ?? null } : {}),
      activeVideoTrack, activeAudioTrack,
      videoAlternates: alternates(activeVideo), audioAlternates: alternates(activeAudio),
      // A pin is an EXPLICIT choice: configured here, or made at runtime by
      // `selectVideoTrack()`, which is what leaving automatic mode records.
      pinnedVideo: establishedVideo && this.qualityController !== null
        ? !this.qualityController.isAutoQuality : configured?.videoTrack !== undefined,
      pinnedAudio: this.runtimeSelectionIntent === null
        ? this.runtimeAudioIntent !== null || this.config.selection?.audioTrack !== undefined
        : this.runtimeAudioIntent !== null,
      disableVideo: this.config.disableVideo === true,
      disableAudio: this.config.disableAudio === true,
      ...(altGroup !== undefined ? { videoAltGroup: altGroup } : {}),
      ...(activeAudio?.altGroup !== undefined ? { audioAltGroup: activeAudio.altGroup }
        : this.config.selection?.audioAltGroup !== undefined
          ? { audioAltGroup: this.config.selection.audioAltGroup } : {}),
      ...(this.config.videoConstraints !== undefined ? { videoConstraints: this.config.videoConstraints } : {}),
      ...(this.runtimeAudioIntent === null && this.runtimeAudioLanguage === null && this.config.audioConstraints !== undefined ? { audioConstraints: this.config.audioConstraints } : {}),
      ...(audioLanguages !== undefined ? { audioLanguages } : {}),
    };
  }

  /** Prepare a presentation on this session and publish its outputs in one adoption. */
  async selectMedia(selection: SelectionConfig, options?: MediaSelectionOptions): Promise<void> {
    if (this._destroyed || this.isTerminalState() || !this.connection || !this.subscriptionManager || !this._catalogState) {
      throw new Error('Cannot select media: playback is not accepting selections');
    }
    if (this.currentMigration || this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.pendingRetypes.size || this.seekIsPreparing()) {
      throw new Error('Cannot select media: media selection is busy');
    }
    const seekOutput = this.ownedSeekOutput;
    const requested = structuredClone(selection);
    const validation = { ...this.config, selection: requested };
    Reflect.deleteProperty(validation, 'videoAltGroup'); // tune-in shorthand does not constrain a runtime view
    validateConfig(validation);
    const signal = options?.signal;
    if (signal?.aborted) throw new Error('Media selection cancelled');
    const timeline = options?.timeline;
    const anchors = timeline === undefined ? undefined : {
      kind: timeline.kind, token: timeline.referenceToken,
      video: timeline.video === undefined ? undefined : { ...timeline.video },
      audio: timeline.audio === undefined ? undefined : { ...timeline.audio },
    };
    if (anchors && anchors.kind !== 'reference-map') throw new Error('Unknown media timeline policy');
    const originalCatalog = this._catalogState;
    const catalog = structuredClone(originalCatalog);
    const current = this._selection, controller = this.qualityController;
    const conn = this.connection, manager = this.subscriptionManager, source = this.mediaSource;
    const generation = this.bootstrapGeneration, sync = this.syncController;
    const languages = this.effectiveAudioLanguages();
    const choice = prepareRuntimeSelection(catalog, { selection: requested, current, catalogNamespace: this.config.namespace,
      disableVideo: this.config.disableVideo === true, disableAudio: this.config.disableAudio === true,
      quality: { startLevel: this.config.startLevel ?? 'auto', qualitySwitchCooldownMs: this.config.qualitySwitchCooldownMs ?? 0,
        ...(this.config.capLevelToResolution ? { capLevelToResolution: this.config.capLevelToResolution } : {}) }, clock: this.clock,
      ...(this.config.videoConstraints ? { videoConstraints: this.config.videoConstraints } : {}),
      ...(this.runtimeAudioIntent === null && this.runtimeAudioLanguage === null && this.config.audioConstraints ? { audioConstraints: this.config.audioConstraints } : {}),
      ...(languages !== undefined ? { audioLanguages: languages } : {}),
    });
    if (!choice.ok) throw new Error(`Cannot select media: ${choice.reason}`);
    const prep = createPreparedMediaSelection();
    prep.selection = {
      video: choice.selected.video.state === 'selected' ? choice.selected.video.track.track : null,
      audio: choice.selected.audio.state === 'selected' ? choice.selected.audio.track.track : null,
    };
    prep.controller = choice.controller;
    let txn: MediaSelectionTxn | null = null;
    const live = () => !this._destroyed && !this.isTerminalState() && this.connection === conn
      && this.subscriptionManager === manager && this.mediaSource === source && this.bootstrapGeneration === generation
      && this.syncController === sync && this.qualityController === controller && this._selection === current
      && !this.seekIsPreparing() && this.ownedSeekOutput === seekOutput
      && (txn === null ? this.mediaSelection === null : this.mediaSelection === txn);
    const outputs = new Map<'video' | 'audio', PreparedMediaOutput>();
    let referenceToken: object | null = null;
    if (anchors) {
      const reference = this.mediaTimelineReference;
      if (!reference || reference.token !== anchors.token) throw new Error('Media timeline reference is stale or unavailable');
      referenceToken = reference.token;
    }
    for (const role of ['video', 'audio'] as const) {
      const target = prep.selection[role], selected = current[role];
      if (target === null && selected === null) continue;
      // Adding/removing native output graphs needs a separately supported
      // resource operation. Refuse before disturbing an established output.
      if (target === null || selected === null) throw new Error('Media adapter cannot change the enabled output types');
      const targetKey = this.initKey(target), oldKey = identityKey(selected.namespaceFields, selected.name);
      if (targetKey === oldKey) {
        if (anchors?.[role]) throw new Error('Cannot remap an unchanged media output');
        continue;
      }
      const running = this.catalogTrackFor(selected.name, selected.namespaceFields, role);
      const owner = this.selectedOutputOwners.get(role);
      if (!running || owner?.key !== oldKey) throw new Error(`Current ${role} output is no longer available`);
      const mse = this.usesMse(running.packaging) && this.usesMse(target.packaging);
      if (!mse && (running.packaging !== 'loc' || target.packaging !== 'loc')) {
        throw new Error('Media adapter does not support this presentation transition');
      }
      const referenceRole = current.audio === null ? 'video' : 'audio';
      const referenceId = current[referenceRole];
      const referenceTrack = referenceId && this.catalogTrackFor(referenceId.name, referenceId.namespaceFields, referenceRole);
      if (!referenceTrack || this.usesMse(referenceTrack.packaging) !== mse) {
        throw new Error('Media adapter cannot map between different output clocks');
      }
      if (!target.codec || target.codec !== running.codec || (role === 'video'
          ? target.width !== running.width || target.height !== running.height
          : target.samplerate !== running.samplerate || target.channelConfig !== running.channelConfig)) {
        throw new Error(`Cannot prepare changed ${role} decoder metadata on this adapter`);
      }
      const pipeline = role === 'video' ? this.videoPipeline : this.audioPipeline;
      const assembler = this.cmafAssembler;
      if (!mse && (!pipeline || !sync?.hasReference)) throw new Error(`Current ${role} pipeline has no continuing timeline`);
      if (mse && (!source || !this.keyedCmafIdentity || !source.holdQueuedAppends || !source.getTimestampOffset
          || !assembler?.setPresentationPlacement || !assembler.capturePresentationPlacement || !this.config.createCmafAssembler)) {
        throw new Error('Media adapter cannot prepare independent MSE output identities and presentation placement');
      }
      const previous = [...this.activeSubscriptions.entries()].find(([, sub]) => sub.mediaType === role
        && sub.trackAlias !== null && !this.supersededRouting?.aliases.has(sub.trackAlias)
        && identityKey(sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName) === oldKey);
      const route = previous ? manager.captureRoute(previous[1].trackAlias!) : null;
      if (previous && !route) throw new Error(`Current ${role} route was retired`);
      const oldIsCurrent = () => live() && this.selectedOutputOwners.get(role) === owner
        && (!mse || this.cmafAssembler === assembler)
        && (role === 'video' ? this.videoPipeline : this.audioPipeline) === pipeline
        && (previous ? this.activeSubscriptions.get(previous[0]) === previous[1] && route!()
          || this.terminalMediaSubscriptions.has(previous[1]) : true);
      let offset = role === 'audio' ? this.audioPresentationOffsetUs : this.videoPresentationOffsetUs;
      const anchor = anchors?.[role];
      if (anchor) {
        if (typeof anchor.sourceTimeUs !== 'bigint' || typeof anchor.referenceTimeUs !== 'bigint') {
          throw new TypeError('Media reference-map anchors must be bigint microseconds');
        }
        offset = (current.audio === null ? this.videoPresentationOffsetUs : this.audioPresentationOffsetUs)
          + anchor.referenceTimeUs - anchor.sourceTimeUs;
      } else if (choice.scopeChanged || running.altGroup === undefined || target.altGroup !== running.altGroup) {
        throw new Error(`The target ${role} timeline requires an explicit reference mapping`);
      }
      let msePlacement: PreparedMsePlacement | undefined;
      if (mse) {
        if (!anchor) throw new Error('MSE media selection requires an explicit presentation reference mapping');
        const reference = assembler!.capturePresentationPlacement!(referenceRole);
        const oldPlacement = assembler!.capturePresentationPlacement!(role);
        const referenceOffset = source!.getTimestampOffset!(referenceRole), targetOffset = source!.getTimestampOffset!(role);
        if (!reference || !oldPlacement || referenceOffset === undefined || !Number.isFinite(referenceOffset)
            || targetOffset === undefined || !Number.isFinite(targetOffset)) throw new Error('MSE presentation evidence is unavailable');
        const placed = placePresentationAnchor(reference, anchor.sourceTimeUs, anchor.referenceTimeUs, referenceOffset, targetOffset);
        if (placed === null) throw new Error('MSE presentation anchor is not representable');
        msePlacement = { assembler: assembler!, referenceRole, reference, oldPlacementToken: oldPlacement.token,
          referenceOffset, targetOffset, sourceKey: targetKey, anchor: placed };
      } else if (role === 'video' && !this.videoCommandDispatcher()?.supportsVideoOutputTiming) {
        throw new Error('Video decoder cannot preserve producing output timing');
      }
      const capturedOffset = offset;
      const output: PreparedMediaOutput = { role, target, ...(msePlacement ? { mse: msePlacement } : {}),
        oldRequestId: previous?.[0] ?? null, oldSubscription: previous?.[1] ?? null, oldIdentity: selected, oldIsCurrent,
        timing: { presentationOffsetUs: offset, liveOutput: null, mappedTiming: true, presentationMapper: null,
          timingSink: role === 'audio' ? this.audioPipeline : null,
          timingSource: role === 'audio' ? this.createMappedAudioTiming(sync, capturedOffset) : undefined,
          ...(role === 'video' ? { videoTimingSource: this.createMappedVideoTiming(sync, capturedOffset) } : {}) },
        evidence: new PreparedOutputEvidence(mediaTrackPackaging(target.packaging), role, target.codec),
        staged: [], serial: Promise.resolve(), checked: 0 };
      outputs.set(role, output); prep.awaiting.add(`usable-${role}`);
    }
    if (referenceToken !== null && this.mediaTimelineReference?.token !== referenceToken) throw new Error('Media timeline reference changed during preparation');
    if (!live()) throw new Error('Playback ownership changed during media selection');
    const audioPin = requested.audioTrack !== undefined || !choice.scopeChanged && requested.audioAltGroup === undefined
      && (this.runtimeAudioIntent !== null || this.runtimeSelectionIntent === null && this.config.selection?.audioTrack !== undefined);
    const explicitAudio = !this.config.disableAudio && requested.audioTrack !== undefined
      && choice.selected.audio.state === 'selected' ? choice.selected.audio.track.track : null;
    const audioLanguage = explicitAudio === null ? undefined : explicitAudio.lang || null;
    if (!outputs.size) {
      if (signal?.aborted) throw new Error('Media selection cancelled');
      if (this._catalogState !== originalCatalog) throw new Error('Catalog changed while selecting the current media');
      this.adoptRuntimeSelectionPolicy(choice, audioPin, audioLanguage, false);
      this.refreshMediaSelection();
      return;
    }
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    txn = { conn, prep, manager, source, generation, catalog, outputs, referenceToken, referenceRole: current.audio === null ? 'video' : 'audio', selection: choice, audioPin,
      ...(audioLanguage !== undefined ? { audioLanguage } : {}),
      rawInputs: new WeakSet(), registrations: new Map(), releasedRequests: new Set(), terminalRequests: new Set(),
      retainedBytes: 0, inputCount: 0, aborted: false, committed: false, cancel };
    this.mediaSelection = txn;
    const operation = txn;
    const abort = () => this.failMediaSelection(operation, new Error('Media selection cancelled'));
    try {
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      await this.runPreparedMediaSelection(operation, cancelled);
    } catch (error) {
      if (!operation.committed) this.failMediaSelection(operation, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      try { signal?.removeEventListener('abort', abort); } catch { /* Cleanup cannot leave the selection reserved. */ }
    }
  }

  /** Select an exact audio identity without recreating the player or its session. */
  async selectAudioTrack(reference: TrackRefConfig, options?: AudioSelectionOptions): Promise<void> {
    if (this._destroyed || this.isTerminalState() || !this.connection || !this.subscriptionManager || !this._catalogState) {
      throw new Error('Cannot select audio: playback is not accepting selections');
    }
    if (this.currentMigration || this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.pendingRetypes.size || this.seekIsPreparing()) {
      throw new Error('Cannot select audio: media selection is busy');
    }
    const seekOutput = this.ownedSeekOutput;
    const namespace = namespaceFields(reference.namespace ?? this.config.namespace);
    const matches = this._catalogState.tracks.filter(track => track.role === 'audio' && track.name === reference.name
      && sameNamespaceFields(trackNamespaceFields(track, this.config.namespace), namespace));
    const target = matches.length === 1 ? matches[0] : undefined;
    if (!target || this.config.disableAudio || !isTrackPackagingSupported(target)) throw new Error('Audio identity is not playable');
    const selected = this._selection.audio;
    const outputOwner = this.selectedOutputOwners.get('audio');
    const running = selected && this.catalogTrackFor(selected.name, selected.namespaceFields, 'audio');
    if (!selected || !outputOwner || !running
        || outputOwner.key !== identityKey(selected.namespaceFields, selected.name)) {
      throw new Error('Cannot select audio before the current audio is accepted');
    }
    const conn = this.connection, manager = this.subscriptionManager, source = this.mediaSource;
    const generation = this.bootstrapGeneration, pipeline = this.audioPipeline, output = this.audioOutput, sync = this.syncController;
    const previous = [...this.activeSubscriptions.entries()].find(([, sub]) => sub.mediaType === 'audio'
      && sub.trackAlias !== null && !this.supersededRouting?.aliases.has(sub.trackAlias)
      && identityKey(sub.namespace ?? namespaceFields(this.config.namespace), sub.trackName) === outputOwner.key);
    const oldRegistration = previous ? manager.captureRoute(previous[1].trackAlias!) : null;
    if (previous && !oldRegistration) throw new Error('Current audio route is no longer registered');
    let reservedAttempt: MediaSelectionTxn | null = null;
    const outputCurrent = () => !this._destroyed && !this.isTerminalState() && this.connection === conn
      && this.subscriptionManager === manager && this.mediaSource === source && this.bootstrapGeneration === generation
      && this.audioPipeline === pipeline && this.audioOutput === output && this.syncController === sync
      && !this.seekIsPreparing() && this.ownedSeekOutput === seekOutput
      && this.mediaSelection === reservedAttempt
      && this.selectedOutputOwners.get('audio') === outputOwner && this._selection.audio !== null
      && identityKey(this._selection.audio.namespaceFields, this._selection.audio.name) === outputOwner.key;
    const oldIsCurrent = () => {
      if (!outputCurrent()) return false;
      if (previous) {
        const current = this.activeSubscriptions.get(previous[0]);
        if (current !== undefined) return current === previous[1] && oldRegistration!();
        if (!this.terminalMediaSubscriptions.has(previous[1])) return false;
      }
      // Normal wire completion does not retire already-scheduled output. With
      // no route left, require actual current audio and its continuing clock.
      if (!pipeline || !output || !sync?.hasReference) return false;
      try {
        const head = this.liveAudioHead(output);
        const timing = sync.computeAudioRenderTime(head + this.audioPresentationOffsetUs);
        return outputCurrent() && timing !== null && Number.isFinite(timing.renderTimeUs);
      } catch { return false; }
    };
    if (!oldIsCurrent()) throw new Error('Current audio output is no longer available');
    if (target.renderGroup !== running.renderGroup) throw new Error('Audio selection must remain in the active render scope');
    // Snapshot anchors as scalar values, retaining the opaque token's identity.
    const timeline = options?.timeline;
    let presentationOffsetUs = this.audioPresentationOffsetUs;
    let referenceToken: object | null = null;
    let liveOutput: AudioOutputLike | null = null;
    if (timeline?.kind === 'reference-map') {
      if (typeof timeline.sourceTimeUs !== 'bigint' || typeof timeline.referenceTimeUs !== 'bigint') {
        throw new Error('Audio reference-map anchors must be bigint microseconds');
      }
      const current = this.audioTimelineReference;
      if (!current || current.token !== timeline.referenceToken) throw new Error('Audio timeline reference is stale or unavailable');
      referenceToken = current.token;
      presentationOffsetUs += timeline.referenceTimeUs - timeline.sourceTimeUs;
    } else if (timeline?.kind === 'live-resync') {
      if (!running.isLive || !target.isLive) throw new Error('Audio live-resync requires live tracks');
      if (this.usesMse(running.packaging) || this.usesMse(target.packaging) || !this.audioOutput) {
        throw new Error('Audio live-resync requires an inverse-rebase output witness');
      }
      liveOutput = this.audioOutput;
      const owner = outputOwner.selection;
      const head = this.liveAudioHead(liveOutput);
      if (!oldIsCurrent() || this.mediaSelection || this.currentMigration) {
        throw new Error('Audio ownership changed while reading the output witness');
      }
      // The current graph head itself is an observed source point. No elapsed
      // clock or decoder submission is substituted for a silent output.
      this.collectAudioTimeline = true;
      if (!this.readAudioTimelineReference() && owner && owner === this.lastAudioDomainOwner && this.lastAudioDomain !== null) {
        this.noteAudioTimeline(head, this.lastAudioDomain);
      }
      const current = this.readAudioTimelineReference();
      if (!current) throw new Error('Audio live-resync has no current source-domain reference');
      referenceToken = current.token;
    } else if (timeline !== undefined) throw new Error('Unknown audio timeline policy');
    else if (this.initKey(target) !== this.initKey(running)
        && (target.altGroup === undefined || running.altGroup === undefined || target.altGroup !== running.altGroup)) {
      throw new Error('Audio timelines have no proven relationship; an explicit timeline mapping is required');
    }
    if (this.initKey(target) === this.initKey(running)) {
      if (!oldIsCurrent() || this.mediaSelection || this.currentMigration || this.pendingVideoSwitch
          || this.switchInProgress || this.pendingRetypes.size) throw new Error('Audio ownership changed during selection');
      if (presentationOffsetUs !== this.audioPresentationOffsetUs) throw new Error('Cannot remap the already selected audio');
      this.runtimeAudioIntent = Object.freeze({ name: target.name, namespaceFields: Object.freeze([...namespace]) });
      this.runtimeAudioLanguage = target.lang || null;
      return;
    }
    const mse = this.usesMse(target.packaging);
    const mappedTiming = referenceToken !== null || this.audioTimingMapped;
    const timingAdapter = mse ? this.cmafAssembler : this.audioPipeline;
    const presentationMapper = mse && timingAdapter && 'setAudioPresentationOffsetUs' in timingAdapter
      && typeof timingAdapter.setAudioPresentationOffsetUs === 'function' ? timingAdapter as AudioPresentationMapper : null;
    const timingSink = !mse && timingAdapter && 'setAudioTimingSource' in timingAdapter
      && typeof timingAdapter.setAudioTimingSource === 'function' ? timingAdapter as AudioTimingSink : null;
    if (mse ? mappedTiming && !presentationMapper : mappedTiming && !timingSink) {
      throw new Error('Audio adapter cannot map presentation timestamps without changing the shared video timeline');
    }
    const timingSource: AudioTimingSource | undefined = !mse && mappedTiming && !liveOutput
      ? timeline === undefined && this.audioTimingSource ? this.audioTimingSource
        : this.createMappedAudioTiming(sync, presentationOffsetUs) : undefined;
    const transition = this.unadoptableTransition(target, 'audio', running);
    if (transition !== null) throw new Error(`Cannot select audio: ${transition}`);
    if (!target.codec) throw new Error('Target audio has no codec');
    if (!this.usesMse(target.packaging) && (target.codec !== running.codec || target.samplerate !== running.samplerate
        || target.channelConfig !== running.channelConfig)) {
      throw new Error('Audio decoder metadata cannot change on this decoder');
    }
    const catalog = structuredClone(this._catalogState);
    const track = structuredClone(target);
    const prep = createPreparedMediaSelection();
    prep.selection = { video: null, audio: track };
    prep.awaiting.add('usable-audio');
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const preparedOutput: PreparedMediaOutput = {
      role: 'audio', target: track,
      oldRequestId: previous?.[0] ?? null, oldSubscription: previous?.[1] ?? null, oldIdentity: selected, oldIsCurrent,
      timing: { presentationOffsetUs, liveOutput, mappedTiming, presentationMapper, timingSink, timingSource },
      evidence: new PreparedAudioEvidence(mediaTrackPackaging(track.packaging)),
      staged: [], serial: Promise.resolve(), checked: 0,
    };
    const txn: MediaSelectionTxn = {
      conn, prep, manager, source, generation, catalog, outputs: new Map([['audio', preparedOutput]]), referenceToken,
      rawInputs: new WeakSet(), registrations: new Map(), releasedRequests: new Set(), terminalRequests: new Set(),
      retainedBytes: 0, inputCount: 0, aborted: false, committed: false, cancel,
    };
    if (!oldIsCurrent() || this.mediaSelection || this.currentMigration || this.pendingVideoSwitch
        || this.switchInProgress || this.pendingRetypes.size) throw new Error('Audio ownership changed during selection');
    reservedAttempt = txn;
    this.mediaSelection = txn; // final guard and reservation are synchronous
    await this.runPreparedMediaSelection(txn, cancelled);
  }

  private async runPreparedMediaSelection(txn: MediaSelectionTxn, cancelled: Promise<void>): Promise<void> {
    const required = [...txn.outputs.values()];
    const budget = this.config.connectionTimeoutMs && this.config.connectionTimeoutMs > 0
      ? Math.min(this.config.connectionTimeoutMs, SWITCH_STAGING_TIMEOUT_MS) : SWITCH_STAGING_TIMEOUT_MS;
    const timer = setTimeout(() => this.failMediaSelection(txn, new Error('Audio selection timed out')), budget);
    const guard = async <T>(work: Promise<T>): Promise<T> => {
      const result = await Promise.race([work.then(value => ({ value })), cancelled.then(() => null)]);
      if (result === null) throw txn.failure ?? new Error('Audio selection cancelled');
      this.assertMediaSelection(txn);
      return result.value;
    };
    try {
      for (const output of required) {
        const track = output.target;
        const inline = this.decodeResolvedInlineInitData(track, txn.catalog);
        if (inline) { output.evidence.setInit(inline); output.init = inline; }
        if (isMsePackaging(track.packaging) && track.initRef !== undefined
            && !txn.catalog.initDataList?.some(item => item.id === track.initRef)) throw new Error('Target initRef is missing');
        const allowed = this.hooks.beforeSubscribe.run({ trackName: track.name,
          namespace: trackNamespaceFields(track, this.config.namespace), mediaType: output.role });
        this.assertMediaSelection(txn);
        if (allowed === null) throw new Error('Media subscription cancelled by beforeSubscribe');
      }
      await guard(this.issuePreparedMedia(txn, required.map(output => ({ track: output.target, mediaType: output.role })), txn.catalog,
        () => this.assertMediaSelection(txn), id => this.pendingAliasBinds.add(id)));
      this.validatePreparedMediaOutputs(txn);
      for (const output of required) {
        const track = output.target;
        const running = this.catalogTrackFor(output.oldIdentity.name, output.oldIdentity.namespaceFields, output.role)!;
        const init = this.preparedInitBytes(txn.prep, track, txn.catalog);
        if (this.usesMse(track.packaging) && init) {
          const previousInit = this.runningInitBytes(output.role);
          if (previousInit === undefined) throw new Error('Cannot replace audio without its running initialization');
          if (!bytesEqual(previousInit, init)) {
            if (txn.selection) throw new Error('MSE media preparation requires the running initialization');
            const source = txn.source;
            if (!source?.changeType) throw new Error('Media source cannot reconfigure the audio initialization');
            const offset = source.getTimestampOffset?.(output.role);
            this.assertMediaSelection(txn);
            const mutation = (async () => {
              try {
                await this.applyMediaRetype(txn, { source, mediaType: output.role, codec: track.codec!, next: init,
                  previousCodec: running.codec ?? '', previous: previousInit, offset });
                this.assertMediaSelection(txn);
                txn.prep.reconfigured.set(output.role, init);
              } catch (error) { await this.restorePendingRetypes(txn); throw error; }
            })();
            txn.mutation = mutation;
            void mutation.finally(() => {
              if (txn.mutation === mutation) delete txn.mutation;
              if (this.mediaSelection === txn && txn.aborted && !this.pendingRetypes.size) this.mediaSelection = null;
              this.processPendingGoaway();
            }).catch(() => {});
            await guard(mutation);
          }
        }
      }
      this.validatePreparedMediaOutputs(txn);
      if (txn.selection) this.adoptPreparedOutputs(txn);
      else this.adoptPreparedAudioOutput(txn, txn.outputs.get('audio')!);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (!txn.committed) {
        this.failMediaSelection(txn, cause);
        if (!txn.mutation) await this.restorePendingRetypes(txn);
      } else if (!this._destroyed) {
        this.failCatalogPlayback(createPlayerError('fatal', 'decoder', txn.selection && txn.outputs.has('video')
          ? PlayerErrorCode.VIDEO_DECODE_ERROR : PlayerErrorCode.AUDIO_DECODE_ERROR,
          `${txn.selection ? 'Media' : 'Audio'} selection failed after adoption`, { cause }));
      }
      throw cause;
    } finally {
      clearTimeout(timer);
      if (this.mediaSelection === txn) this.mediaSelection = null;
      if (!txn.committed) this.releasePreparedMediaRequests(txn);
      for (const output of txn.outputs.values()) {
        for (const item of output.staged.splice(0)) this.discardMediaInput(item.input, 'route retired');
      }
      this.processPendingGoaway();
    }
  }

  private resetMediaClock(preserveMediaInputs = false): void {
    if (!preserveMediaInputs) this.subscriptionManager?.invalidateMediaInputs();
    this.audioTimelineRecord = null;
    this.videoTimelineRecord = null;
    this.syncController?.reset();
    this.mappedClockOwner = this._selection.audio === null
      ? this.videoTimingSource ?? null : this.audioTimingSource ?? null;
  }

  private establishMappedClock(owner: object, sync: SyncController | null, role: 'video' | 'audio', referenceUs: bigint): void {
    if (this._destroyed || this.syncController !== sync || !sync || sync.hasReference || this.mappedClockOwner !== owner) return;
    const active = role === 'audio' ? this.audioTimingSource : this.videoTimingSource;
    if (active !== owner || role === 'video' && this._selection.audio !== null) return;
    // Consume before the injected clock callback. Only an adopted input source
    // can consume this clock-reset intent; readiness/output queries remain pure.
    this.mappedClockOwner = null;
    if (role === 'audio') sync.setAudioReference(referenceUs);
    else sync.setVideoReference(referenceUs);
  }

  private createMappedAudioTiming(sync: SyncController | null, offset: bigint): AudioTimingSource {
    const source: AudioTimingSource = {
      computeAudioRenderTime: raw => this.mappedAudioTiming(sync, raw + offset),
      establishReference: raw => this.establishMappedClock(source, sync, 'audio', raw + offset),
    };
    return source;
  }

  private createMappedVideoTiming(sync: SyncController | null, offset: bigint): VideoTimingSource {
    const source: VideoTimingSource = {
      computeVideoRenderTime: raw => this.mappedVideoTiming(sync, raw + offset),
      establishReference: raw => this.establishMappedClock(source, sync, 'video', raw + offset),
    };
    return source;
  }

  private mappedAudioTiming(sync: SyncController | null, referenceUs: bigint) {
    if (this._destroyed || this.syncController !== sync) return null;
    const timing = sync?.computeAudioRenderTime(referenceUs);
    if (!timing) return null;
    // The dispatcher schedules at this nominal time PLUS the shared output
    // cushion. Keep the nominal time, but test lateness at that actual output
    // boundary; a currently playing graph head is not 200ms late merely because
    // the receiver deliberately buffered it for 200ms.
    const cushion = this.getRenderCushionUs?.() ?? computePlaybackDelayUs(this.videoPipeline?.effectiveGapTimeoutUs, this._handshakeRttMs);
    return { ...timing, shouldDrop: timing.offsetUs + cushion < -this.config.lateFrameThresholdMs! * 1000 };
  }

  private mappedVideoTiming(sync: SyncController | null, referenceUs: bigint) {
    if (this._destroyed || this.syncController !== sync) return null;
    const timing = sync?.computeVideoRenderTime(referenceUs);
    if (!timing) return null;
    const cushion = this.getRenderCushionUs?.() ?? computePlaybackDelayUs(this.videoPipeline?.effectiveGapTimeoutUs, this._handshakeRttMs);
    return { ...timing, shouldDrop: timing.offsetUs + cushion < -this.config.lateFrameThresholdMs! * 1000 };
  }

  private liveAudioHead(output: AudioOutputLike): bigint {
    if (this.audioOutput !== output || this._destroyed) throw new Error('Audio output witness is no longer current');
    const value = output.playheadCaptureUs?.();
    if (value === null || value === undefined || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value))) {
      throw new Error('Audio output has no safe currently playing source point');
    }
    if (this.audioOutput !== output || this._destroyed) throw new Error('Audio output changed while observing its graph head');
    return BigInt(Math.round(value));
  }

  private mediaSelectionRouteCurrent(txn: MediaSelectionTxn): boolean {
    if (txn.aborted || this._destroyed || this.isTerminalState() || this.connection !== txn.conn
        || this.subscriptionManager !== txn.manager || this.bootstrapGeneration !== txn.generation || this.mediaSource !== txn.source) return false;
    if (txn.committed) return true;
    if (this.mediaSelection !== txn) return false;
    for (const output of txn.outputs.values()) if (!output.oldIsCurrent()) return false;
    return this.mediaSelection === txn && !txn.aborted;
  }

  private assertMediaSelection(txn: MediaSelectionTxn): void {
    if (!this.mediaSelectionRouteCurrent(txn) || txn.committed) throw txn.failure ?? new Error('Audio selection is no longer current');
    if (txn.referenceToken !== null && (txn.referenceRole === 'video' ? this.videoTimelineRecord : this.audioTimelineRecord)?.reference.token !== txn.referenceToken) {
      throw new Error('Audio timeline reference was retired during preparation');
    }
  }

  private validatePreparedMediaOutputs(txn: MediaSelectionTxn): void {
    this.assertMediaSelection(txn);
    if (txn.referenceToken !== null && (txn.selection ? this.mediaTimelineReference : this.audioTimelineReference)?.token !== txn.referenceToken) {
      throw new Error('Audio timeline reference changed during preparation');
    }
    for (const output of txn.outputs.values()) {
      if (output.mse) {
        const geometry = output.mse, assembler = geometry.assembler, source = txn.source;
        if (this.cmafAssembler !== assembler
            || !Object.is(source?.getTimestampOffset?.(geometry.referenceRole), geometry.referenceOffset)
            || !Object.is(source?.getTimestampOffset?.(output.role), geometry.targetOffset)
            || assembler.capturePresentationPlacement?.(geometry.referenceRole)?.token !== geometry.reference.token
            || assembler.capturePresentationPlacement?.(output.role)?.token !== geometry.oldPlacementToken) {
          throw new Error('MSE presentation placement changed during preparation');
        }
        this.assertMediaSelection(txn);
      }
      const current = this.catalogTrackFor(output.target.name, trackNamespaceFields(output.target, this.config.namespace), output.role);
      const fields = ['packaging', 'codec', 'width', 'height', 'samplerate', 'channelConfig', 'renderGroup', 'altGroup', 'initData', 'initRef', 'initTrack'] as const;
      if (!current || fields.some(key => current[key] !== output.target[key])) throw new Error('Audio target changed during preparation');
      const before = this.decodeResolvedInlineInitData(output.target, txn.catalog);
      const now = this.decodeResolvedInlineInitData(current);
      if ((before === undefined) !== (now === undefined) || before && now && !bytesEqual(before, now)) {
        throw new Error('Audio target initialization changed during preparation');
      }
    }
  }

  private reservePreparedMediaInput(txn: MediaSelectionTxn, obj: MoqtObject): boolean {
    if (!this.mediaSelectionRouteCurrent(txn)) return false;
    if (txn.rawInputs.has(obj)) return true;
    const bytes = MoqtPlayer.STAGED_EVENT_BASE_BYTES + (obj.kind === 'data' ? obj.payload.byteLength + (obj.extensions?.byteLength ?? 0) : 0);
    if (txn.inputCount >= SWITCH_STAGING_MAX_OBJECTS || bytes > MoqtPlayer.MAX_STAGED_BYTES - txn.retainedBytes) {
      this.failMediaSelection(txn, new Error('Audio selection input retention limit exceeded')); return false;
    }
    txn.rawInputs.add(obj); txn.inputCount++; txn.retainedBytes += bytes;
    return true;
  }

  /** Retain the manager's already-transformed input; adoption never transforms it twice. */
  private stagePreparedMediaInput(obj: MoqtObject, headers: LocHeaders | undefined, input: ObjectRoutingContext | undefined,
    run: () => void, delivery?: ObjectDeliveryOptions): boolean {
    // The owner was captured before transformation; a returned alias is not routing authority.
    const captured = delivery?.identity ? this.preparedMediaDeliveries.get(delivery.identity) : undefined;
    const txn = captured?.preparation;
    if (!txn) return false;
    const output = captured.output;
    if (BigInt(obj.trackAlias) !== captured.alias) {
      const error = new Error('Audio transform changed the issued routing identity');
      this.discardMediaInput(input, 'route retired');
      if (!txn.committed) this.failMediaSelection(txn, error);
      else this.handleMalformedTrack(captured.alias, output.target.name, error, txn.conn);
      return true;
    }
    if (txn.committed) return false;
    if (!this.mediaSelectionRouteCurrent(txn)) { this.discardMediaInput(input, 'route retired'); return true; }
    const bytes = obj.kind === 'data' ? obj.payload.byteLength : 0;
    if (bytes > MoqtPlayer.MAX_STAGED_BYTES - txn.retainedBytes) {
      this.discardMediaInput(input, 'buffer full'); this.failMediaSelection(txn, new Error('Transformed audio retention limit exceeded')); return true;
    }
    txn.retainedBytes += bytes;
    output.staged.push({ obj, ...(headers ? { headers } : {}), ...(input ? { input } : {}), run });
    try {
      if (obj.kind === 'data' && isMsePackaging(output.target.packaging)) {
        let bytes = obj.payload;
        if (output.target.packaging === 'locmaf') {
          const parsed = deserializeLocmafObject(bytes);
          if (parsed.kind === 'rawBoxes') bytes = parsed.boxes;
        }
        if (isCmafHeader(bytes)) {
          txn.prep.inbandBytes.set(output.role, bytes);
          txn.prep.inbandInit.delete(this.initKey(output.target));
          txn.prep.awaiting.delete(`in-band:${this.initKey(output.target)}`);
        }
      }
      this.checkPreparedMediaOutput(txn, output);
    } catch (error) { this.failMediaSelection(txn, error instanceof Error ? error : new Error(String(error))); }
    return true;
  }

  private checkPreparedMediaOutput(txn: MediaSelectionTxn, output: PreparedMediaOutput): void {
    this.assertMediaSelection(txn);
    const init = this.preparedInitBytes(txn.prep, output.target, txn.catalog);
    if (isMsePackaging(output.target.packaging) && !init) return;
    if (init && (!output.init || !bytesEqual(output.init, init))) { output.evidence.setInit(init); output.init = init; }
    while (output.checked < output.staged.length) {
      const item = output.staged[output.checked++]!;
      if (output.evidence.inspect(item.obj, item.headers) && output.evidence.sourcePresentationTimeUs !== null) {
        item.sourceTimeUs = output.evidence.sourcePresentationTimeUs;
      }
    }
    if (this.preparedOutputScheduleUsable(txn, output)) txn.prep.awaiting.delete(`usable-${output.role}`);
    else txn.prep.awaiting.add(`usable-${output.role}`);
    checkPreparedMediaReady(txn.prep);
  }

  private preparedOutputScheduleUsable(txn: MediaSelectionTxn, output: PreparedMediaOutput): boolean {
    return output.staged.some(item => {
      if (item.sourceTimeUs === undefined) return false;
      // MSE owns buffered-media admission. Live resync establishes its target
      // mapping from a fresh graph-head witness immediately before adoption.
      if (this.usesMse(output.target.packaging) || output.timing.liveOutput && !output.timing.timingSource) return true;
      const timing = output.timing.mappedTiming
        ? output.role === 'video' ? this.mappedVideoTiming(this.syncController, item.sourceTimeUs + output.timing.presentationOffsetUs)
          : this.mappedAudioTiming(this.syncController, item.sourceTimeUs + output.timing.presentationOffsetUs)
        : output.role === 'video' ? this.syncController?.computeVideoRenderTime(item.sourceTimeUs)
          : this.syncController?.computeAudioRenderTime(item.sourceTimeUs);
      this.assertMediaSelection(txn);
      // Match the consumer's timing source: ordinary audio uses the shared
      // uncushioned drop decision; mapped audio uses its mapped timing provider.
      // A placeholder or the ordinary five-second "play now" fallback is not
      // evidence that this packet fits the continuing presentation schedule.
      return timing != null && Number.isFinite(timing.renderTimeUs) && Number.isFinite(timing.offsetUs)
        && !timing.shouldDrop && (output.timing.mappedTiming || timing.offsetUs <= 5_000_000);
    });
  }

  private receivePreparedMediaInit(obj: MoqtObject, source?: unknown): boolean {
    const txn = this.mediaSelection;
    if (!txn || txn.committed || source !== txn.conn) return false;
    for (const [key, init] of txn.prep.initTracks) {
      if (init.alias !== BigInt(obj.trackAlias)) continue;
      try {
        this.assertMediaSelection(txn);
        if (obj.kind !== 'data' || !obj.payload.byteLength) throw new Error('Target initialization has no bytes');
        for (const output of txn.outputs.values()) {
          if (output.target.initTrack === init.name && this.initKey(output.target, init.name) === key) {
            output.evidence.setInit(obj.payload); output.init = obj.payload;
          }
        }
        init.bytes = obj.payload; txn.prep.awaiting.delete(key);
        for (const output of txn.outputs.values()) this.checkPreparedMediaOutput(txn, output);
      } catch (error) { this.failMediaSelection(txn, error instanceof Error ? error : new Error(String(error))); }
      return true;
    }
    return false;
  }

  private handleMediaSelectionControl(msg: ControlMessage, conn: MoqtConnection): boolean {
    const txn = this.mediaSelection;
    if (!txn || txn.committed || conn !== txn.conn || !('requestId' in msg)) return false;
    const id = BigInt(msg.requestId);
    const sub = txn.prep.media.get(id);
    const init = [...txn.prep.initTracks.values()].find(item => item.reqId === id);
    if (!sub && !init) return false;
    if (txn.aborted) return true;
    try {
      this.assertMediaSelection(txn);
      if (msg.type === 'SUBSCRIBE_OK' && 'trackAlias' in msg) {
        const alias = BigInt(msg.trackAlias);
        if (txn.manager.getMediaType(alias) !== undefined || alias === this.catalogSlots.catalogTrackAlias) {
          throw new Error('Target audio alias collides with an existing route');
        }
        this.settleParkedOwnership(id, alias, conn);
        acceptPreparedMedia(txn.prep, id, alias);
        txn.manager.registerTrack(alias, sub?.trackName ?? init!.name, sub?.mediaType ?? 'audio', sub?.packaging ?? 'init',
          { sourceConnection: conn, namespace: sub?.namespace ?? init!.namespace });
        txn.registrations.set(alias, txn.manager.captureRoute(alias)!);
        this.assertMediaSelection(txn);
        this.replayPendingObjects(alias, conn);
        for (const output of txn.outputs.values()) this.checkPreparedMediaOutput(txn, output);
      } else if (msg.type === 'REQUEST_ERROR' || msg.type === 'PUBLISH_DONE') {
        txn.terminalRequests.add(id);
        if (msg.type === 'PUBLISH_DONE' && sub?.subscription && sub.alias !== null
            && this.registerMediaTerminal(conn, id, sub.subscription, BigInt(msg.statusCode), msg.errorReason ?? '', true)) return true;
        throw new Error(`Target audio request ${msg.type === 'REQUEST_ERROR' ? 'was refused' : 'ended'} before adoption`);
      }
    } catch (error) { this.failMediaSelection(txn, error instanceof Error ? error : new Error(String(error))); }
    return true;
  }

  private releasePreparedMediaRequests(txn: MediaSelectionTxn, initOnly = false): void {
    const requests = [
      ...(!initOnly ? [...txn.prep.media].map(([id, sub]) => ({ id, alias: sub.alias })) : []),
      ...[...txn.prep.initTracks.values()].flatMap(init => init.reqId === null ? [] : [{ id: init.reqId, alias: init.alias }]),
    ];
    for (const { id, alias } of requests) {
      if (txn.releasedRequests.has(id)) continue;
      txn.releasedRequests.add(id);
      this.settleParkedOwnership(id, null, txn.conn);
      const terminal = this.pendingMediaTerminals.get(txn.conn)?.get(id);
      if (!initOnly && terminal?.preparing) {
        this.pendingMediaTerminals.get(txn.conn)?.delete(id); terminal.releaseEnd();
      }
      if (alias !== null && txn.registrations.get(alias)?.()) txn.manager.unregisterTrack(alias);
      if (!txn.terminalRequests.has(id)) void txn.conn.unsubscribe(varint(id)).catch(() => {});
    }
  }

  private failMediaSelection(txn: MediaSelectionTxn, error: Error): void {
    if (txn.aborted || txn.committed) return;
    txn.aborted = true; txn.failure = error;
    txn.prep.rejectReady(error); txn.cancel();
    this.releasePreparedMediaRequests(txn);
    for (const output of txn.outputs.values()) {
      for (const item of output.staged.splice(0)) this.discardMediaInput(item.input, 'route retired');
    }
    if (this.mediaSelection === txn && !txn.mutation && ![...this.pendingRetypes.values()].some(record => record.owner === txn)) {
      this.mediaSelection = null;
    }
  }

  private prepareDecoderConfiguration(owner: object, mediaType: 'video' | 'audio', requested: Uint8Array): PreparedDecoderConfiguration | null {
    const previous = this.installedDecoderConfigurations.get(mediaType);
    if (!previous || previous.dispatcher !== this.commandDispatcher) throw new Error(`No running ${mediaType} decoder configuration to restore`);
    if (this.preparedDecoderConfigurations.has(mediaType)) throw new Error('Decoder configuration is already owned');
    const record: PreparedDecoderConfiguration = { owner, previous, requested: requested.slice(), applied: false };
    this.preparedDecoderConfigurations.set(mediaType, record);
    this.handlePipelineCommand({ type: 'configure', mediaType, config: record.requested });
    if (this.installedDecoderConfigurations.get(mediaType) === previous) throw new Error('Target decoder configuration was not applied');
    record.applied = true;
    return record;
  }

  private restoreDecoderConfiguration(owner: object, mediaType: 'video' | 'audio'): void {
    const record = this.preparedDecoderConfigurations.get(mediaType);
    if (record?.owner !== owner) return;
    try {
      if (!this._destroyed && this.commandDispatcher === record.previous.dispatcher) {
        // A throwing native configure may already have closed its old decoder.
        // Undo the exact successful bytes; commandTransform must not cancel undo.
        record.previous.dispatcher.dispatch({ type: 'configure', mediaType, config: record.previous.configured });
        this.installedDecoderConfigurations.set(mediaType, record.previous);
      }
    } finally { if (this.preparedDecoderConfigurations.get(mediaType) === record) this.preparedDecoderConfigurations.delete(mediaType); }
  }

  private adoptPreparedSubscriptions(prep: PreparedMediaSelection, conn: MoqtConnection): void {
    for (const [reqId, sub] of prep.media) {
      // Exactly what SUBSCRIBE_OK installs for a live subscription — the
      // alias the replacement itself assigned, bound to the pipeline owner
      // that is already running. A colliding old request id or alias is
      // overwritten here: the replacement is authoritative for it now.
      this.pendingMediaSubs.delete(reqId);
      sub.subscription ??= { trackName: sub.trackName, mediaType: sub.mediaType, trackAlias: sub.alias, namespace: sub.namespace };
      this.activeSubscriptions.set(reqId, sub.subscription);
      if (sub.alias !== null) {
        this.subscriptionManager?.registerTrack(sub.alias, sub.trackName, sub.mediaType, sub.packaging,
          { sourceConnection: conn, namespace: sub.namespace });
      }
    }
  }

  private adoptRuntimeSelectionPolicy(chosen: Extract<RuntimeSelection, { ok: true }>, audioPin: boolean, audioLanguage?: string | null, replaceController = true): void {
    if (replaceController) {
      if (!chosen.selected.manualVideo && this.qualityController?.isAutoQuality) chosen.controller.unlockAuto();
      else chosen.controller.lockManual();
      this.qualityController = chosen.controller;
      this.syncBufferAbrController();
    } else if (chosen.selected.manualVideo) this.qualityController?.lockManual();
    const video = chosen.selected.video.state === 'selected' ? chosen.selected.video.track : null;
    const audio = chosen.selected.audio.state === 'selected' ? chosen.selected.audio.track : null;
    this.runtimeSelectionIntent = {
      scope: chosen.selected.scope.id,
      ...(video === null ? {} : video.track.altGroup === undefined || chosen.selected.manualVideo
        ? { videoTrack: video.id } : { videoAltGroup: video.track.altGroup }),
      ...(audio?.track.altGroup === undefined ? {} : { audioAltGroup: audio.track.altGroup }),
    };
    this.runtimeAudioIntent = audio !== null && audioPin ? audio.id : null;
    if (audioLanguage !== undefined) this.runtimeAudioLanguage = audioLanguage;
  }

  private adoptPreparedOutputs(txn: MediaSelectionTxn): void {
    this.validatePreparedMediaOutputs(txn);
    const chosen = txn.selection!;
    const configurations = new Map<'video' | 'audio', Uint8Array>();
    const mseOutputs: PreparedMseOutput[] = [];
    // All outputs must be usable before ANY native reset/configure. A changed
    // video description is refused here, while both old outputs still run.
    for (const output of txn.outputs.values()) {
      const first = output.staged.find(item => item.sourceTimeUs !== undefined);
      if (!first) throw new Error(`Target ${output.role} lost its usable input`);
      if (output.mse) {
        const init = this.preparedInitBytes(txn.prep, output.target, txn.catalog), running = this.runningInitBytes(output.role);
        if (!init || !running || !bytesEqual(init, running)) throw new Error('MSE media preparation requires the running initialization');
        // Order only one source at a time. Group numbers do not align outputs.
        output.staged.sort((a, b) => {
          const ag = BigInt(a.obj.groupId), bg = BigInt(b.obj.groupId);
          if (ag !== bg) return ag < bg ? -1 : 1;
          const ao = BigInt(a.obj.objectId), bo = BigInt(b.obj.objectId);
          return ao === bo ? 0 : ao < bo ? -1 : 1;
        });
        const start = output.evidence.firstUsableLocation;
        if (!start) throw new Error('Prepared MSE output has no access-point Location');
        // LOCMAF may need earlier objects in this group for its format state.
        // Retain those only for decoder priming; CMAF has no such dependency.
        const keep = output.staged.findIndex(item => BigInt(item.obj.groupId) > start.groupId
          || BigInt(item.obj.groupId) === start.groupId
            && (output.target.packaging === 'locmaf' || BigInt(item.obj.objectId) >= start.objectId));
        if (keep < 0) throw new Error('Prepared MSE access point was not retained');
        for (const item of output.staged.splice(0, keep)) this.discardMediaInput(item.input, 'awaiting keyframe');
        this.validatePreparedMediaOutputs(txn);
        const packaging = output.target.packaging;
        if (packaging !== 'cmaf' && packaging !== 'locmaf') throw new Error('Unsupported MSE object packaging');
        mseOutputs.push({ role: output.role, trackName: output.target.name, sourceKey: output.mse.sourceKey, packaging, init,
          anchor: output.mse.anchor, objects: output.staged.map(item => item.obj), startLocation: start });
        continue;
      }
      const config = output.role === 'video' ? first.headers?.videoConfig ?? output.init ?? new Uint8Array()
        : first.headers?.audioConfig ?? output.init ?? new Uint8Array();
      const running = this.installedDecoderConfigurations.get(output.role);
      if (!running || !bytesEqual(running.requested, config)) throw new Error(`${output.role} decoder configuration cannot be prepared safely`);
      // A dependent frame preceding the usable access point may carry a
      // configuration too. Every retained input will be replayed, so checking
      // just the readiness witness could apply an unprepared configuration
      // after the old outputs have already been retired.
      for (const item of output.staged) {
        const carried = output.role === 'video' ? item.headers?.videoConfig : item.headers?.audioConfig;
        if (carried && !bytesEqual(running.requested, carried)) {
          throw new Error(`${output.role} decoder configuration cannot be prepared safely`);
        }
      }
      configurations.set(output.role, config);
      if (!this.preparedOutputScheduleUsable(txn, output)) throw new Error(`Target ${output.role} no longer fits the continuing schedule`);
    }
    this.validatePreparedMediaOutputs(txn);
    let lease: MediaAppendQueueLease | undefined;
    if (mseOutputs.length) {
      const factory = this.config.createCmafAssembler, assembler = this.cmafAssembler, source = txn.source;
      if (!factory || !assembler || !source?.holdQueuedAppends) throw new Error('MSE preparation capability was retired');
      preflightMseOutputs(factory, assembler, mseOutputs, () => this.validatePreparedMediaOutputs(txn));
      this.validatePreparedMediaOutputs(txn);
      lease = source.holdQueuedAppends(mseOutputs.map(output => output.role));
    }
    try {
      this.validatePreparedMediaOutputs(txn);
      if (lease && !lease.current) throw new Error('MSE append ownership changed during preparation');
      this.validatePreparedMediaOutputs(txn);
      // From here an unexpected native failure is fatal, not a claimed rollback
      // of decoded output. No candidate media was submitted before this point.
      txn.committed = true;
      this.mappedClockOwner = null;
      const assertAdopted = () => {
        if (!this.mediaSelectionRouteCurrent(txn)) throw new Error('Media selection retired during adoption');
      };
      this.adoptRuntimeSelectionPolicy(chosen, txn.audioPin === true, txn.audioLanguage);
      const video = chosen.selected.video.state === 'selected' ? chosen.selected.video.track : null;
      const audio = chosen.selected.audio.state === 'selected' ? chosen.selected.audio.track : null;
      this.adoptPreparedSubscriptions(txn.prep, txn.conn);
      assertAdopted();
      for (const output of txn.outputs.values()) {
        assertAdopted();
        const pipeline = output.role === 'video' ? this.videoPipeline : this.audioPipeline;
        const first = output.staged.find(item => item.sourceTimeUs !== undefined)!;
        if (output.mse) {
          const assembler = output.mse.assembler, init = this.preparedInitBytes(txn.prep, output.target, txn.catalog)!;
          const firstInput = output.staged.find(item => item.obj.kind === 'data')?.obj;
          const start = output.evidence.firstUsableLocation;
          if (!firstInput || !start || !txn.manager.setMinimumMediaLocation(BigInt(firstInput.trackAlias), start)) {
            throw new Error('Prepared MSE route was retired before adoption');
          }
          this.selectCmafTrack(assembler, output.role, output.target.name, output.mse.sourceKey);
          assertAdopted(); assembler.setInitSegment?.(output.role, init);
          assertAdopted(); assembler.setPresentationPlacement!(output.role, output.mse.anchor);
          assertAdopted();
          this.initSegmentByTrack.set(this.initKey(output.target, output.target.initTrack ?? output.target.name), init.slice());
          if (output.role === 'video') {
            this.videoPresentationOffsetUs = output.timing.presentationOffsetUs;
            this.videoTimingMapped = true; this.videoTimingSource = undefined;
            this.cmafVideoSynced = true; // the first ordered emission was proven independent in isolated assembly
          } else {
            this.audioPresentationOffsetUs = output.timing.presentationOffsetUs;
            this.audioTimingMapped = true; this.audioTimingSource = undefined;
          }
        } else {
          if (output.role === 'video') {
            this.videoPresentationOffsetUs = output.timing.presentationOffsetUs;
            this.videoTimingMapped = true; this.videoTimingSource = output.timing.videoTimingSource;
            pipeline?.setVideoTimingSource(this.videoTimingSource);
          } else {
            this.audioPresentationOffsetUs = output.timing.presentationOffsetUs;
            this.audioTimingMapped = true; this.audioTimingSource = output.timing.timingSource;
            pipeline?.setAudioTimingSource(this.audioTimingSource);
          }
          assertAdopted();
          pipeline?.resetForTrackSwitch(BigInt(first.obj.groupId));
          assertAdopted();
          pipeline?.configure(configurations.get(output.role)!);
        }
        assertAdopted();
        this.mseCompletions?.delete(output.role);
        if (output.oldRequestId !== null && this.activeSubscriptions.get(output.oldRequestId) === output.oldSubscription) {
          this.clearLocmafDecoderForRequest(output.oldRequestId);
          this.retireMediaSubscription(output.oldRequestId, txn.conn);
          void txn.conn.unsubscribe(varint(output.oldRequestId)).catch(() => {});
        }
      }
      if (lease) {
        const held = lease; lease = undefined; held.discard();
        assertAdopted();
      }
      this.releasePreparedMediaRequests(txn, true);
      assertAdopted();
      this.refreshMediaSelection({ video: video?.id ?? null, audio: audio?.id ?? null });
      assertAdopted();
      for (const [id] of txn.prep.media) this.pendingMediaTerminals.get(txn.conn)?.get(id)?.attach?.();
      for (const output of txn.outputs.values()) {
        const staged = output.staged.splice(0);
        let index = 0;
        try { for (; index < staged.length && this.mediaSelectionRouteCurrent(txn); index++) {
          const item = staged[index]!, start = output.evidence.firstUsableLocation;
          if (output.mse && output.target.packaging === 'locmaf' && start && item.obj.kind === 'data'
              && BigInt(item.obj.groupId) === start.groupId && BigInt(item.obj.objectId) < start.objectId) {
            if (this.stateMachine.state !== PlayerState.PAUSED && !this.decodeLocmafObject(output.role, output.target.name,
              BigInt(item.obj.trackAlias), BigInt(item.obj.groupId), BigInt(item.obj.objectId), item.obj.payload)) {
              throw new Error('Prepared LOCMAF prefix state was refused');
            }
            this.discardMediaInput(item.input, this.stateMachine.state === PlayerState.PAUSED ? 'paused' : 'awaiting keyframe');
          } else item.run();
        } }
        finally { for (const item of staged.slice(index)) this.discardMediaInput(item.input, 'route retired'); }
      }
      for (const [id] of txn.prep.media) {
        if (this.pendingMediaTerminals.get(txn.conn)?.get(id)?.drained) this.finishMediaTerminal(txn.conn, id);
      }
    } finally {
      if (lease) {
        try { if (txn.committed) lease.discard(); else lease.resume(); }
        catch (error) {
          if (!this._destroyed) this.failCatalogPlayback(createPlayerError('fatal', 'player', PlayerErrorCode.CMAF_INIT_INVALID,
            'Could not release MSE append ownership after media preparation', error instanceof Error ? { cause: error } : {}));
          throw error;
        }
      }
    }
  }

  private adoptPreparedAudioOutput(txn: MediaSelectionTxn, output: PreparedMediaOutput): void {
    this.validatePreparedMediaOutputs(txn);
    const subEntry = [...txn.prep.media.entries()][0];
    if (!subEntry || subEntry[1].alias === null) throw new Error('Audio target has no accepted subscription');
    const [, sub] = subEntry;
    const init = this.preparedInitBytes(txn.prep, output.target, txn.catalog);
    // Synchronous format/timing changes are one precommit unit. The asynchronous
    // source-buffer mutation uses the same pendingRetypes owner/undo as handover.
    const assembler = this.cmafAssembler;
    const previousInit = this.runningInitBytes('audio');
    const previousName = output.oldIdentity.name;
    const previousMapped = this.audioTimingMapped;
    const previousOffset = this.audioPresentationOffsetUs;
    const previousTimingSource = this.audioTimingSource;
    const first = output.staged.find(item => item.obj.kind === 'data');
    const decoderConfig = output.target.packaging === 'locmaf' && init ? codecDescriptionFromInit(init) ?? new Uint8Array()
      : first?.headers?.audioConfig ?? init ?? new Uint8Array();
    let assemblerChanged = false, mappingChanged = false, timingChanged = false;
    try {
      if (init && this.usesMse(output.target.packaging)) {
        assemblerChanged = true;
        this.selectCmafTrack(assembler, 'audio', sub.trackName, this.keyedCmafIdentity ? identityKey(sub.namespace, sub.trackName) : undefined);
        this.assertMediaSelection(txn);
        assembler?.setInitSegment?.('audio', init);
        this.assertMediaSelection(txn);
      }
      if (output.timing.presentationMapper && output.timing.mappedTiming) {
        mappingChanged = true; // zero activates explicit-map semantics too
        output.timing.presentationMapper.setAudioPresentationOffsetUs(output.timing.presentationOffsetUs);
        this.assertMediaSelection(txn);
      }
      if (!this.usesMse(output.target.packaging)) {
        this.prepareDecoderConfiguration(txn, 'audio', decoderConfig);
        this.assertMediaSelection(txn);
      }
      if (output.timing.liveOutput) {
        const sourceTimeUs = output.evidence.firstPresentationTimeUs;
        if (sourceTimeUs === null) throw new Error('Live audio target has no usable source presentation time');
        const graphHead = this.liveAudioHead(output.timing.liveOutput);
        this.validatePreparedMediaOutputs(txn); // the public adapter callback can reenter
        output.timing.presentationOffsetUs = previousOffset + graphHead - sourceTimeUs;
        const offset = output.timing.presentationOffsetUs, sync = this.syncController;
        output.timing.timingSource = this.createMappedAudioTiming(sync, offset);
      }
      if (output.timing.timingSink && output.timing.timingSource !== previousTimingSource) {
        timingChanged = true;
        output.timing.timingSink.setAudioTimingSource(output.timing.timingSource);
        this.assertMediaSelection(txn);
      }
      if (!this.preparedOutputScheduleUsable(txn, output)) throw new Error('Target audio no longer fits the continuing schedule');
    } catch (error) {
      if (!this._destroyed) {
        let restoreFailed = false;
        let restoreFailure: unknown;
        const restore = (run: () => void) => {
          try { run(); }
          catch (failure) { if (!restoreFailed) { restoreFailed = true; restoreFailure = failure; } }
        };
        restore(() => this.restoreDecoderConfiguration(txn, 'audio'));
        if (timingChanged) restore(() => output.timing.timingSink!.setAudioTimingSource(previousTimingSource));
        if (mappingChanged) restore(() => output.timing.presentationMapper!.setAudioPresentationOffsetUs(previousMapped ? previousOffset : null));
        if (assemblerChanged && assembler === this.cmafAssembler) restore(() => {
          this.selectCmafTrack(assembler, 'audio', previousName, this.keyedCmafIdentity
            ? identityKey(output.oldIdentity.namespaceFields, previousName) : undefined);
          if (previousInit) assembler?.setInitSegment?.('audio', previousInit);
        });
        if (restoreFailed) this.failCatalogPlayback(createPlayerError('fatal', 'player', PlayerErrorCode.CMAF_INIT_INVALID,
          'Could not restore audio media state after preparation', restoreFailure instanceof Error ? { cause: restoreFailure } : {}));
      }
      throw error;
    }
    txn.committed = true;
    this.mappedClockOwner = null;
    this.runtimeAudioIntent = Object.freeze({ name: sub.trackName, namespaceFields: Object.freeze([...sub.namespace]) });
    this.runtimeAudioLanguage = output.target.lang || null;
    this.audioPresentationOffsetUs = output.timing.presentationOffsetUs;
    this.audioTimingMapped = output.timing.mappedTiming;
    this.audioTimingSource = output.timing.timingSource;
    this.adoptPreparedSubscriptions(txn.prep, txn.conn);
    if (init) this.initSegmentByTrack.set(this.initKey(output.target), init);
    if (init && txn.source) this.installedCmafInit.set('audio', { source: txn.source, bytes: init.slice() });
    if (this.pendingRetypes.get('audio')?.owner === txn) this.pendingRetypes.delete('audio');
    this.retypingMedia.delete('audio');
    this.mseCompletions?.delete('audio');
    if (output.oldRequestId !== null) {
      this.clearLocmafDecoderForRequest(output.oldRequestId);
      if (this.activeSubscriptions.get(output.oldRequestId) === output.oldSubscription) {
        this.retireMediaSubscription(output.oldRequestId, txn.conn);
        void txn.conn.unsubscribe(varint(output.oldRequestId)).catch(() => {});
      }
    }
    if (!this.usesMse(output.target.packaging)) {
      if (!first) throw new Error('Audio target lost its usable input');
      this.audioPipeline?.resetForTrackSwitch(BigInt(first.obj.groupId));
      try { this.audioPipeline?.configure(decoderConfig); }
      finally { if (this.preparedDecoderConfigurations.get('audio')?.owner === txn) this.preparedDecoderConfigurations.delete('audio'); }
    }
    this.releasePreparedMediaRequests(txn, true);
    this.refreshMediaSelection({ audio: { name: sub.trackName, namespaceFields: sub.namespace } });
    const terminal = this.pendingMediaTerminals.get(txn.conn)?.get(subEntry[0]);
    terminal?.attach?.();
    const staged = output.staged.splice(0);
    let index = 0;
    try {
      for (; index < staged.length && this.mediaSelectionRouteCurrent(txn); index++) staged[index]!.run();
    } finally { for (const item of staged.slice(index)) this.discardMediaInput(item.input, 'route retired'); }
    if (terminal?.drained) this.finishMediaTerminal(txn.conn, subEntry[0]);
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
    txn: MigrationTxn, _conn: MoqtConnection, catalog: CatalogState,
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

    await this.issuePreparedMedia(txn, required, catalog, () => this.assertMigrationLive(txn));
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

  /** The same request, initialization and readiness authority for either preparation. */
  private async issuePreparedMedia(txn: PreparedMediaAttempt,
    required: ReadonlyArray<{ track: CatalogTrack; mediaType: 'video' | 'audio' }>, catalog: CatalogState,
    assertLive: () => void, onClaim?: (id: bigint) => void): Promise<void> {
    const prep = txn.prep!;
    const conn = txn.conn;
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
        assertLive();
        if (txn.aborted || txn.committed) throw new Error('Handover media subscribe retired before emission');
        allocated = id;
        // Candidate-owned: request ids collide across sessions, so this never
        // reaches activeSubscriptions / pendingMediaSubs before adoption.
        if (initKey !== null) prep.initTracks.get(initKey)!.reqId = id;
        else prep.media.set(id, { trackName: name, namespace, mediaType, packaging, alias: null });
        onClaim?.(id);
      };
      const reqId = await conn.subscribe(namespace.map(field => this.enc.encode(field)), this.enc.encode(name),
        { ...options, ...(initKey === null ? { ...this.subscriberPriorityFor(mediaType), ...this.mediaTerminalOptions(conn) } : {}),
          onRequestId: claim } as never);
      if (allocated === null) claim(BigInt(reqId));
      assertLive();
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
    prep: PreparedMediaSelection, track: CatalogTrack, catalog: CatalogState,
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
  private unadoptableTransition(track: CatalogTrack, mediaType: 'video' | 'audio', running = this.subscribedTrack(mediaType)): string | null {
    if (!this.pipelinesCreated) return null; // nothing configured yet
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
      acceptPreparedMedia(prep, reqId, alias);
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
      acceptPreparedMedia(prep, reqId, alias);
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
    checkPreparedMediaReady(prep);
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

  /** Reserve shutdown before calling the adapter, which may re-enter destroy. */
  private closeMigrationCandidate(txn: MigrationTxn): Promise<void> {
    if (txn.closing) return txn.closing;
    let settled!: () => void;
    txn.closing = new Promise<void>(resolve => { settled = resolve; });
    try { void txn.conn.close().then(settled, settled); }
    catch { settled(); }
    return txn.closing;
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
    void this.closeMigrationCandidate(txn);
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
    void this.closeMigrationCandidate(txn);
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
   * A commit that threw part-way is terminal, including after connection adoption.
   * Dispose its candidate and retained evidence; no rollback of partly installed
   * media is promised. The still-current old session is never retired underneath it.
   */
  private failMigrationCommit(txn: MigrationTxn, newConnection: MoqtConnection, error: unknown): void {
    txn.terminated = true;
    txn.aborted = true; // Captured callbacks are inert before request cancellation.
    const requests = new Set<bigint>([
      ...(txn.prep?.media.keys() ?? []),
      ...[...(txn.prep?.initTracks.values() ?? [])].flatMap(init => init.reqId === null ? [] : [init.reqId]),
      ...(txn.slots?.catalogRequestId == null ? [] : [txn.slots.catalogRequestId]),
    ]);
    // These ids belong to the candidate, including init requests absent from the
    // half-installed live maps. Retire them before close makes stream I/O inert.
    for (const id of requests) void newConnection.unsubscribe(varint(id)).catch(() => {});
    this.abandonCandidate(txn);
    // Commit runs only after preparation's mutations have settled. Release our
    // records without undoing the partially adopted initialization.
    for (const [type, record] of this.pendingRetypes) {
      if (record.owner !== txn) continue;
      this.pendingRetypes.delete(type);
      this.retypingMedia.delete(type);
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    try {
      this.failCatalogPlayback(createPlayerError('fatal', 'connection', PlayerErrorCode.CONNECTION_LOST,
        `Session handover failed while committing the replacement: ${cause.message}`, { cause }));
    } catch (reportErr) {
      // A listener threw while the failure was published; the state is committed.
      try {
        this.log.warn('Reporting a handover commit failure threw (ignored): %s',
          reportErr instanceof Error ? reportErr.message : String(reportErr));
      } catch { /* logger itself threw */ }
    } finally {
      // A failed, owned candidate must not look current or be closed again by
      // a later destroy. Fatal reporting above still sees its live registrations.
      if (this.connection === newConnection) {
        this.releaseMediaTerminals(newConnection);
        this.retireInitWaiters(newConnection);
        this.connection = null;
      }
      delete txn.prep;
      delete txn.slots;
      txn.oldTerminal = undefined;
    }
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
    if (retiring) this.cancelLivenessRestarts(retiring);
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
        this.refreshMediaSelection();
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
      if (this.keyedCmafIdentity) for (const mediaType of ['video', 'audio'] as const) {
        const track = prep.selection?.[mediaType];
        if (!track || !this.usesMse(track.packaging)) continue;
        // The replacement can select a different member of the same set.
        // Retain placement, but move the assembler's source fence with it.
        this.selectCmafTrack(this.cmafAssembler, mediaType, track.name, this.initKey(track));
        if (this._destroyed || this.connection !== newConnection || this.isTerminalState()) {
          txn.terminated = true;
          return;
        }
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
      this.adoptPreparedSubscriptions(prep, txn.conn);
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

    this.refreshMediaSelection({ video: this.acceptedSelection('video'), audio: this.acceptedSelection('audio') }, true);

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
  private reportHeldOldTerminal(txn: Pick<MigrationTxn, 'oldTerminal'>): void {
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
  private startGoawayMigration(uri: string, pending?: PendingGoaway): void {
    if (this._destroyed || this.isTerminalState() || !this.config.createConnection) return;
    // The URI is peer-controlled text — validate BEFORE creating any candidate
    // connection or transport. A non-empty invalid URI must not silently fall
    // back to the current URL (that would reconnect to a relay that just
    // declared itself unusable while hiding the peer's defect); the GOAWAY
    // quarantine installed at receipt stays in place.
    const invalidReason = invalidGoawayUriReason(uri);
    if (invalidReason !== null) {
      if (pending) this.reportHeldOldTerminal(pending);
      this.emitError(createPlayerError(
        'degraded', 'connection', PlayerErrorCode.CONNECTION_LOST,
        `Automatic GOAWAY migration rejected: ${invalidReason}`,
      ));
      return;
    }
    // The factory can throw too, including from a deferred settlement microtask.
    void (async () => {
      const newConnection = this.config.createConnection!();
      await this.migrateToUrl(newConnection, uri, pending);
    })().catch((err) => {
      // Entry/factory failures never acquired a transaction to report this evidence.
      if (pending) this.reportHeldOldTerminal(pending);
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
    if (this.handoverBlocked()) return;
    const pending = this.pendingGoaway;
    this.pendingGoaway = null;
    if (pending !== null && !this._destroyed && !this.currentMigration && pending.sourceConnection === this.connection) {
      this.startGoawayMigration(pending.uri, pending);
    }
  }

  /** Media state a handover cannot start under: it would capture a selection about to change. */
  private handoverBlocked(): boolean {
    return this.currentMigration !== null || this.mediaSelection !== null || this.pendingRetypes.size > 0
      || this.pendingVideoSwitch !== null || this.switchInProgress;
  }

  /** A video switch released its slot; act on a GOAWAY it deferred once its settlement finishes. */
  private videoSwitchSettled(): void {
    if (this.pendingGoaway !== null) queueMicrotask(() => this.processPendingGoaway());
  }

  private async migrateToUrl(newConnection: MoqtConnection, url: string, pending?: PendingGoaway): Promise<void> {
    const createTransport = this.config.createTransport!;
    const setupOptions = buildSetupOptions(this.config, url);
    await this.runMigrationTransaction(
      newConnection, () => createTransport(buildConnectUrl(this.config, url)), setupOptions, url, pending,
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
      this.refusedFetchRequests.delete(fetchReqId);
      this.quarantineFetchRequest(fetchReqId);
      this.finishWarmMediaPrefix(info, 'error');
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
      info.retired = true;
      this.quarantineFetchRequest(fetchReqId);
      this.finishWarmMediaPrefix(info, 'error');
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
        // Retire request bookkeeping before admission/cancellation callbacks.
        // The retained owner still carries this FIN's admitted work to completion.
        this.activeFetches.delete(fetchReqId);
        this.finishWarmMediaPrefix(info, pending.terminal === 'fin' ? 'fin' : pending.terminal === 'reset' ? 'reset' : 'error');
        if (this.connection !== conn) return;
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
    const nameBytes = this.enc.encode(this.config.catalogTrackName);
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
    const nameBytes = this.enc.encode(this.config.catalogTrackName);
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
        this.refreshMediaSelection();
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
    this.refreshMediaSelection();
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
    const nameBytes = this.enc.encode(this.config.catalogTrackName);
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
        this.refreshMediaSelection();
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
  private failCatalogPlayback(error: PlayerError, retireMedia?: () => void): void {
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
    if (this.mediaSelection) this.failMediaSelection(this.mediaSelection, new Error('Playback failed during audio selection'));
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

    if (retireMedia) attempt(retireMedia);

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
    this.refreshMediaSelection();
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
    this.pendingVideoSwitch?.historical?.checkCoast();
    if (this.activeMseSeek?.completion === null) this.activeMseSeek.playback.tick();
    this.preparingMseSeek?.playback.tick();
    this.preparingLocSeek?.playback.tick();
    this.activeLocSeek?.playback.tick();

    // Audio ticks first: its first sample establishes the sync reference
    // (LOC §2.3.1.1 CaptureTimestamp). Video needs this reference to compute
    // render times — without it, all frames render at clock.now() in a burst.
    // Adopted LOC history owns both pipeline ticks, including its paused epoch.
    if (this.commandDispatcher !== this.activeLocSeek?.output?.pipelines.commandDispatcher) {
      if (!this.preparedDecoderConfigurations.has('audio') || this.mediaSelection?.committed) this.audioPipeline?.tick();
      this.videoPipeline?.tick();
    }

    // Observation continues during silence even when a pending operation suppresses ABR decisions.
    this.readVideoReceivedRate();

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

  private videoLagOwner(): ReturnType<MoqtPlayer['captureVideoMeasurementOwner']> {
    const owner = this.captureVideoMeasurementOwner();
    if (!owner?.automatic) return null;
    const selected = this._selection.video;
    const track = selected && this.catalogTrackFor(selected.name, selected.namespaceFields, 'video');
    const supported = track && (track.packaging === 'loc' ? owner.pipeline !== null
      : this.usesMse(track.packaging) && owner.source !== null && owner.assembler !== null);
    return track?.isLive === true && supported && owner.route() ? owner : null;
  }

  private recordVideoDeliveryLag(object: CadenceObject, headers: LocHeaders,
    owner: ReturnType<MoqtPlayer['captureVideoMeasurementOwner']>, payloadBytes: number): void {
    if (payloadBytes <= 0 || !owner || object.kind !== 'data' || BigInt(object.trackAlias) !== owner.alias
        || !this.sameVideoMeasurementOwner(owner, this.videoLagOwner()) || headers.captureTimestamp === undefined) return;
    const timescale = headers.timescale ?? null;
    if (timescale === null ? headers.timestampIsWallClock === false
      : timescale <= 0n || headers.timestampIsWallClock === true) {
      this.videoDeliveryLag = null; return;
    }
    this.recordVideoDeliveryPoint(owner, headers.captureTimestamp, timescale);
  }

  private captureCmafLagOwner(mediaType: string, obj: MoqtObject, delivery?: ObjectDeliveryOptions):
    NonNullable<MoqtPlayer['videoDeliveryLag']>['owner'] | undefined {
    if (mediaType !== 'video' || obj.kind !== 'data' || delivery?.backfill || delivery?.fetched || !delivery?.identity) return undefined;
    const owner = this.cadenceInputOwners.get(delivery.identity);
    const selected = this._selection.video;
    const track = selected && this.catalogTrackFor(selected.name, selected.namespaceFields, 'video');
    return owner && track && this.usesMse(track.packaging) && owner.alias === BigInt(obj.trackAlias)
      && this.sameVideoMeasurementOwner(owner, this.videoLagOwner()) ? owner : undefined;
  }

  private cmafLagPlacementIsCurrent(owner: NonNullable<MoqtPlayer['videoDeliveryLag']>['owner'], token: object): boolean {
    try { return owner.assembler?.capturePresentationPlacement?.('video')?.token === token; }
    catch { return false; } // Optional custom timing must not become a playback failure.
  }

  private recordVideoDeliveryPoint(owner: NonNullable<MoqtPlayer['videoDeliveryLag']>['owner'],
    sourceTimeUs: bigint, timescale: bigint | null, placementToken?: object): void {
    if (!this.sameVideoMeasurementOwner(owner, this.videoLagOwner())) return;
    // Local consumer admission follows transforms, assembly and public callbacks.
    // The trend can include application work; it is not isolated wire delay.
    const now = this.clock.now();
    if (!this.sameVideoMeasurementOwner(owner, this.videoLagOwner())
        || placementToken !== undefined && !this.cmafLagPlacementIsCurrent(owner, placementToken)
        || !this.sameVideoMeasurementOwner(owner, this.videoLagOwner())) return;
    if (!Number.isFinite(now)) { this.videoDeliveryLag = null; return; }
    let state = this.videoDeliveryLag;
    if (!state || !this.sameVideoMeasurementOwner(state.owner, owner) || state.timescale !== timescale || state.placementToken !== placementToken) {
      state = { owner, timescale, ...(placementToken === undefined ? {} : {placementToken}), sourceOriginUs: sourceTimeUs, arrivalOriginUs: now,
        detector: new DeliveryLagDetector(), lastAttemptUs: null };
      this.videoDeliveryLag = state;
    }
    // Rebase integer-microsecond source time before Number conversion. A whole
    // Unix epoch or large media tfdt need not itself be exactly representable.
    const source = sourceTimeUs - state.sourceOriginUs;
    const arrival = now - state.arrivalOriginUs;
    if (source < BigInt(Number.MIN_SAFE_INTEGER) || source > BigInt(Number.MAX_SAFE_INTEGER)
        || !Number.isFinite(arrival) || arrival < 0) { this.videoDeliveryLag = null; return; }
    try { state.detector.record(Number(source), arrival); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (this.videoDeliveryLag === state) this.videoDeliveryLag = null;
    }
  }

  private risingVideoDeliveryLag(): { state: NonNullable<MoqtPlayer['videoDeliveryLag']>; nowUs: number; excessUs: number } | null {
    const state = this.videoDeliveryLag;
    if (!state) return null;
    if (!this.sameVideoMeasurementOwner(state.owner, this.videoLagOwner())
        || state.placementToken !== undefined && !this.cmafLagPlacementIsCurrent(state.owner, state.placementToken)) {
      if (this.videoDeliveryLag === state) this.videoDeliveryLag = null;
      return null;
    }
    const nowUs = this.clock.now() - state.arrivalOriginUs;
    if (this.videoDeliveryLag !== state || !this.sameVideoMeasurementOwner(state.owner, this.videoLagOwner())
        || state.placementToken !== undefined && !this.cmafLagPlacementIsCurrent(state.owner, state.placementToken)
        || this.videoDeliveryLag !== state || !this.sameVideoMeasurementOwner(state.owner, this.videoLagOwner())) return null;
    if (!Number.isFinite(nowUs) || nowUs < 0) { this.videoDeliveryLag = null; return null; }
    try {
      if (!state.detector.isCongested(nowUs)) return null;
      if (state.lastAttemptUs !== null && nowUs - state.lastAttemptUs < this.config.qualitySwitchCooldownMs! * 1000) return null;
      const excessUs = state.detector.excessLagUs(nowUs);
      return excessUs === null ? null : { state, nowUs, excessUs };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      if (this.videoDeliveryLag === state) this.videoDeliveryLag = null;
      return null;
    }
  }

  private checkBandwidthAdaptation(): void {
    if (this.evaluatingBandwidth) return;
    this.evaluatingBandwidth = true;
    try { this.evaluateBandwidthAdaptation(); }
    finally { this.evaluatingBandwidth = false; }
  }

  private evaluateBandwidthAdaptation(): void {
    if (!this.bufferAbrController || !this.qualityController || !this.connection
        || this.state !== PlayerState.PLAYING || this.playbackIntent !== true) return;
    const connection = this.connection, controller = this.qualityController, selection = this._selection;
    const abr = this.bufferAbrController, pipeline = this.videoPipeline, source = this.mediaSource;
    const manager = this.subscriptionManager, generation = manager?.mediaInputGeneration;
    const track = controller.currentVideoTrack, mode = this.videoMeasurementMode;
    const live = () => !this._destroyed && this.state === PlayerState.PLAYING && this.playbackIntent === true
      && this.connection === connection && connection.session?.state === SessionState.ESTABLISHED
      && this.qualityController === controller && controller.isAutoQuality && controller.currentVideoTrack === track
      && this._selection === selection && this.videoPipeline === pipeline && this.mediaSource === source
      && this.bufferAbrController === abr && this.subscriptionManager === manager
      && manager?.mediaInputGeneration === generation && this.videoMeasurementMode === mode
      && !this.pendingVideoSwitch && !this.switchInProgress && !this.mediaSelection && !this.currentMigration && (!this.seekIsPreparing() || this.playingLocQualityAvailable());
    if (!live()) return;
    const lag = this.risingVideoDeliveryLag();
    if (!live()) return;
    // Don't trigger ABR while a switch is in flight — give the current
    // switch time to deliver data before deciding to switch again.
    if (this.pendingVideoSwitch || this.switchInProgress || this.mediaSelection || this.seekIsPreparing() && !this.playingLocQualityAvailable()) return;

    let effectiveBufferUs: number;

    if (pipeline) {
      // LOC path: health gates all upshift decisions. When unhealthy,
      // cap to hold zone regardless of buffer depth — prevents upshift
      // after stalls, decode errors, or partial group abandonment.
      const bufferedGroups = pipeline.bufferedGroupCount;
      const healthy = this.isLocDeliveryHealthy();
      if (!healthy) {
        effectiveBufferUs = abr.lowThresholdUs;
      } else if (bufferedGroups === 0) {
        effectiveBufferUs = abr.highThresholdUs;
      } else {
        effectiveBufferUs = bufferedGroups * this.estimatedGopDurationUs;
      }
    } else if (source?.getBufferAheadUs) {
      // CMAF path: read buffer depth from MSE.
      // MSE buffers are naturally thin on fast networks — data arrives
      // and is consumed almost simultaneously, keeping buffered.end near
      // currentTime. A thin buffer with high bandwidth is healthy (data
      // arrives on demand), not starving. Only report low buffer when
      // bandwidth can't sustain the current track.
      const bufferUs = source.getBufferAheadUs();
      if (bufferUs === null || !Number.isFinite(bufferUs) || bufferUs < 0) return;
      if (bufferUs === 0) {
        // Truly empty — always report emergency, don't let stale
        // bandwidth estimates suppress the downshift.
        effectiveBufferUs = 0;
      } else if (bufferUs < abr.lowThresholdUs) {
        // Thin but not empty — check if bandwidth sustains.
        // On fast networks MSE buffers are naturally thin; a thin
        // buffer with high bandwidth is healthy, not starving.
        const bwKbps = this.readVideoReceivedRate() ?? 0;
        const currentTrack = abr.currentTrack;
        const currentBitrateKbps = currentTrack ? currentTrack.bitrateKbps : 0;
        const owner = this.videoLagOwner();
        // Thin positive coverage is normal for source-paced live media.
        // It does not prove congestion or spare capacity; a rising delivery
        // trend and genuinely empty coverage remain independently actionable.
        effectiveBufferUs = (owner?.source === source && track?.isLive === true)
          || bwKbps > currentBitrateKbps * 1.5 ? abr.lowThresholdUs : bufferUs;
      } else {
        effectiveBufferUs = bufferUs;
      }
    } else {
      effectiveBufferUs = abr.lowThresholdUs;
    }

    const bandwidthKbps = this.readVideoReceivedRate() ?? 0;

    if (!live()) return;
    const decision = lag ? { action: 'downshift' as const } : abr.evaluate({
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

    if (!live()) return;
    const isDown = decision.action === 'downshift';
    const isEmergency = !lag && isDown && effectiveBufferUs < abr.lowThresholdUs;
    // Non-mutating peek — state only changes on commit.
    const newTrack = isDown
      ? controller.peekLowerVideoQuality(isEmergency)
      : controller.peekHigherVideoQuality();

    if (newTrack) {
      const nowUs = this.clock.now();
      if (!live()) return;
      const verb = isDown ? 'downshift' : 'upshift';
      if (lag) this.log.warn('Video delivery trend +%.0fms and rising → downshift to %s', lag.excessUs / 1000, newTrack.name);
      else this.log.warn('Buffer %.1fs, BW %.0fkbps → %s to %s',
        effectiveBufferUs / 1_000_000, bandwidthKbps, verb, newTrack.name);
      const freshLag = lag ? this.risingVideoDeliveryLag() : null;
      if (!live() || lag && freshLag?.state !== lag.state) return;
      if (isDown) this.lastAbrDownshiftUs = nowUs;
      if (freshLag) freshLag.state.lastAttemptUs = freshLag.nowUs;
      // No stats or controller mutation here — deferred to completePendingVideoSwitch.
      this.selectVideoTrack({ name: newTrack.name, namespace: trackNamespaceFields(newTrack, this.config.namespace) }, 'bandwidth', isDown ? 'downshift' : 'upshift')
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
    const retirementFailures: unknown[] = [];
    for (const retire of [() => this.retireMseSeek(this.preparingMseSeek), () => this.retireMseSeek(this.activeMseSeek),
      () => this.retireLocSeek(this.preparingLocSeek), () => this.retireLocSeek(this.activeLocSeek)]) {
      try { retire(); } catch (error) { retirementFailures.push(error); }
    }
    this.seekPosition?.retire();
    this.mseOutputEpoch = null;
    const seekOutput = this.ownedSeekOutput; this.ownedSeekOutput = null; this.ownedSeekTransformAliases = null;
    try { seekOutput?.resource.cancel(); } catch (error) { retirementFailures.push(error); }
    let closedCandidate: MoqtConnection | null = null;
    try {
      this.receivingVideoOwners.clear();
      this.audioOutput = null; this.lastAudioDomainOwner = null; this.lastAudioDomain = null;
      this.installedDecoderConfigurations.clear(); this.preparedDecoderConfigurations.clear(); this.decoderConfigurationCommands.clear();
      this.audioTimelineRecord = null; this.videoTimelineRecord = null; this.collectAudioTimeline = false; this.collectVideoTimeline = false; this.selectedOutputOwners.clear(); this.runtimeAudioIntent = null; this.runtimeAudioLanguage = null; this.runtimeSelectionIntent = null; this.mappedClockOwner = null; this.videoPresentationOffsetUs = 0n; this.videoTimingMapped = false; this.videoTimingSource = undefined; this.audioPresentationOffsetUs = 0n; this.audioTimingMapped = false; this.audioTimingSource = undefined;
      this._selection = emptyMediaSelection(this._selection.revision + 1, this.config.autoQuality !== false);
      if (this.mediaSelection) this.failMediaSelection(this.mediaSelection, new Error('Player destroyed during audio selection'));
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
        closedCandidate = txn.conn;
        await this.closeMigrationCandidate(txn);
      }
      this._stats.recordPlayStop();
      this.stopTicking();
      // Liveness: quiet destroy — cancel any in-flight restart ladder (it must
      // never emit MEDIA_STARVED for an intentional teardown) and disarm.
      this.cancelLivenessRestarts();
      this.livenessMonitor?.clear();
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
      this.clearLocmafFrameReaders();
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
      this.keyedCmafIdentity = false;
      this.revokeVideoSwitchRecovery();
      this.mediaSource?.destroy();
      this.mediaSource = null;
      // Retire the buffers before releases can re-drain accepted appends. The
      // adapter also severs guards held by already-closed async stream work.
      for (const stream of this.subgroupStreams.values()) stream.releaseReceiving?.();
      this.subgroupStreams.clear();
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
      this.retireVideoMeasurement();
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
          if (this.connection !== closedCandidate) {
            try { await this.connection.close(); } catch { /* transport already failed/closed */ }
          }
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
      this.timelineSource = null;
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
    } catch (error) {
      retirementFailures.push(error);
    } finally {
      const destroyObservers = this.destroyObservers;
      this.destroyObservers = undefined;
      for (const listener of destroyObservers ?? []) {
        try { listener(); } catch (error) { try { this.log.warn('Destroy observer failed: %s', String(error)); } catch { /* observer failure */ } }
      }
      this.emitter.removeAllListeners();
    }
    if (retirementFailures.length === 1) throw retirementFailures[0];
    if (retirementFailures.length > 1) throw new AggregateError(retirementFailures, 'Player retirement failed');
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
      fn: (streamId: bigint, obj: MoqtObject, receipt?: ReturnType<MoqtPlayer['captureVideoPayload']>) => void,
      source: MoqtConnectionErrorSource,
      cost: (args: unknown[]) => number,
      buffer: (args: unknown[]) => boolean,
    ) => (streamId: bigint, obj: MoqtObject): void => {
      // Capture before parking, callbacks or transforms. Replayed data is not
      // a new receipt, and data received before ownership is never re-attributed.
      const receipt = obj.kind === 'data'
        ? this.captureVideoPayload(BigInt(obj.trackAlias), obj.payload.byteLength, conn,
          { groupId: BigInt(obj.groupId), objectId: BigInt(obj.objectId) }) : undefined;
      if (owningTxn) {
        if (owningTxn.aborted) return;
        if (!owningTxn.committed && buffer([streamId, obj])) {
          this.stageMigrationEvent(owningTxn, () => fn(streamId, obj),
            MoqtPlayer.STAGED_EVENT_BASE_BYTES + cost([streamId, obj]), source,
            { alias: BigInt(obj.trackAlias), streamId, obj });
          return;
        }
      }
      fn(streamId, obj, receipt);
    };
    const stageableDatagram = (
      fn: (datagram: ObjectDatagram, receipt?: ReturnType<MoqtPlayer['captureVideoPayload']>) => void,
      source: MoqtConnectionErrorSource, cost: (args: unknown[]) => number, buffer: (args: unknown[]) => boolean,
    ) => {
      const deliver = stageable(fn, source, cost, buffer);
      return (datagram: ObjectDatagram): void => {
        const receipt = datagram.status === undefined
          ? this.captureVideoPayload(BigInt(datagram.trackAlias), datagram.payload.byteLength, conn,
            { groupId: BigInt(datagram.groupId), objectId: BigInt(datagram.objectId) }) : undefined;
        deliver(datagram, receipt);
      };
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
        // Withdraw timeline authority before cancellation invokes application code.
        if (this.timelineSource?.connection === conn) this.timelineSource = null;
        let seekCleanupFailed = false;
        const retire = (run: () => void) => {
          try { run(); } catch { seekCleanupFailed = true; }
        };
        if (this.preparingMseSeek?.connection === conn) retire(() => this.retireMseSeek(this.preparingMseSeek));
        if (this.activeMseSeek?.connection === conn) retire(() => this.retireMseSeek(this.activeMseSeek));
        if (this.preparingLocSeek?.connection === conn) retire(() => this.retireLocSeek(this.preparingLocSeek));
        if (this.activeLocSeek?.connection === conn) retire(() => this.retireLocSeek(this.activeLocSeek));
        if (seekCleanupFailed) {
          try { this.log.warn('Seek cleanup failed while closing the session'); } catch { /* Cleanup must continue. */ }
        }
        if (this.mediaSelection?.conn === conn) this.failMediaSelection(this.mediaSelection, new Error('Audio selection session closed'));
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
        const handover = preparing !== null && !preparing.committed && !preparing.aborted ? preparing
          : this.pendingGoaway?.sourceConnection === conn ? this.pendingGoaway : null;
        if (handover !== null) {
          this.log.info('[SESSION] replaced session closed while its replacement prepares — held');
          handover.oldTerminal ??= { kind: 'close', ...defined({ error, reason }) };
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
        const handover = preparingErr !== null && !preparingErr.committed && !preparingErr.aborted ? preparingErr
          : this.pendingGoaway?.sourceConnection === conn ? this.pendingGoaway : null;
        if (classified.severity === 'fatal' && handover !== null) {
          this.log.info('[SESSION] replaced session errored while its replacement prepares — held: %s',
            error.message);
          handover.oldTerminal = {
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

      onObject: stageableObject((streamId, obj, receipt) => {
        if (this.seekFillStreams.get(conn)?.get(streamId)?.handleObject(streamId, obj)) return;
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
          this.recordVideoPayload(receipt);
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
        const audio = this.mediaSelection;
        if (audio && !audio.committed && audio.conn === conn && [...audio.prep.media.keys()].some(id => this.pendingAliasBinds.has(id))) {
          if (!this.reservePreparedMediaInput(audio, obj)) return;
        }
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
        const fills = this.seekFillStreams.get(conn), bridge = fills?.get(streamId);
        if (bridge && fills) {
          fills.delete(streamId);
          if (fills.size === 0) this.seekFillStreams.delete(conn);
          bridge.handleStreamClose(streamId, terminal); return;
        }
        if (this.seekRequestsFor(conn).some(owner => owner.handleStreamClose(streamId))) return;
        if (this.seekBridgesFor(conn).some(owner => owner.handleStreamClose(streamId, terminal))) return;
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
          const observed = this.subgroupStreams.get(streamId);
          const known = observed?.connection === conn ? observed : undefined;
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

        const observedSubgroup = this.subgroupStreams.get(streamId);
        const subgroup = observedSubgroup?.connection === conn ? observedSubgroup : undefined;
        if (subgroup !== undefined) {
          this.subgroupStreams.delete(streamId); // map never outlives the stream
          // FIN/reset ends byte reception, not previously accepted transforms.
          // Capture the ORIGINAL registration's stream-specific work now; a
          // reused alias cannot add work to it. Reset invalidates LOCMAF below,
          // while complete CMAF objects already accepted may still be delivered.
          const idle = subgroup.whenIdle?.();
          if (idle) void idle.then(subgroup.releaseReceiving, subgroup.releaseReceiving);
          else subgroup.releaseReceiving?.();
          if (terminal === 'reset' && conn === this.connection) {
            this.livenessMonitor?.noteStreamReset(subgroup.trackAlias, performance.now());
            this.subscriptionManager?.invalidateLocmafGroup(subgroup.trackAlias, subgroup.groupId, conn);
            for (const subscription of this.activeSubscriptions.values()) {
              if (subscription.trackAlias === subgroup.trackAlias) {
                this.retireLocmafConsumerInputs(subscription.trackName, subscription.mediaType, subgroup.trackAlias, subgroup.groupId);
                this.locmafDecoders.get(this.mediaKey(subscription.trackName, subscription.mediaType, subgroup.trackAlias))?.resetGroup(subgroup.groupId);
                this.locmafFrameReaders.get(this.mediaKey(subscription.trackName, subscription.mediaType, subgroup.trackAlias))?.reader.resetGroup(subgroup.groupId);
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
        if (this.seekRequestsFor(conn).some(owner => owner.handleStreamOpen(streamId, header))) return;
        const bridge = this.seekBridgesFor(conn).find(owner => owner.handleStreamOpen(streamId, header));
        if (bridge) {
          if (header.type === 'fetch' && header.fill) {
            let streams = this.seekFillStreams.get(conn);
            if (!streams) { streams = new Map(); this.seekFillStreams.set(conn, streams); }
            streams.set(streamId, bridge);
          }
          return;
        }
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
          this.subgroupStreams.get(streamId)?.releaseReceiving?.();
          this.subgroupStreams.set(streamId, { connection: conn, trackAlias: BigInt(sub.trackAlias), groupId: BigInt(sub.groupId) });
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
      onDatagram: stageableDatagram((datagram, receipt) => {
        if (this.seekBridgesFor(conn).some(owner => owner.handleDatagram(datagram))) return;
        const alias = BigInt(datagram.trackAlias);
        if (!this.mediaRouteBelongsTo(conn, alias)) return;
        if (this.subscriptionManager?.getMediaType(alias) === undefined) return;
        this.recordVideoPayload(receipt);
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
    this.cancelLivenessRestarts(conn);
    this.log.info('GOAWAY received, uri=%s', newSessionUri || '(none)');
    if (this.mediaSelection && !this.mediaSelection.committed) {
      this.failMediaSelection(this.mediaSelection, new Error('Audio selection cancelled by session GOAWAY'));
    }
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
    if (this.handoverBlocked()) {
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
    const audio = this.mediaSelection;
    if (audio && audio.conn === conn && ([...audio.outputs.values()].some(output => output.oldRequestId === requestId) || audio.prep.media.has(requestId)
        || [...audio.prep.initTracks.values()].some(init => init.reqId === requestId))) {
      audio.terminalRequests.add(requestId);
      this.failMediaSelection(audio, new Error('Audio selection request migrated'));
    }
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
    if (this.seekRequestsFor(conn).some(owner => owner.handleControl(msg))) return;
    if (this.handleSeekBridgeControl(msg, conn)) return;
    const slots = this.slotsFor(conn);
    if (this.handleMediaSelectionControl(msg, conn)) return;
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
      onMediaTerminalDrain: (id, _sub, status, reason) => this.registerMediaTerminal(conn, id, this.activeSubscriptions.get(id), status, reason),
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
        const accepted = this.activeSubscriptions.get(requestId);
        const planned = _mediaType === 'video' ? this.qualityController?.currentVideoTrack : this.qualityController?.currentAudioTrack;
        const known = this.config.knownTracks?.[_mediaType];
        const intended = planned ? { name: planned.name, namespaceFields: trackNamespaceFields(planned, this.config.namespace) }
          : known ? { name: known.name, namespaceFields: namespaceFields(this.config.namespace) } : null;
        // Only the intended startup output is adopted by acceptance. Runtime
        // candidates, quality changes and auxiliary overlaps commit elsewhere.
        if (accepted?.trackAlias !== null && accepted !== undefined && this._selection[_mediaType] === null
            && this.pendingVideoSwitch?.newRequestId !== requestId && intended
            && accepted.trackName === intended.name && sameNamespaceFields(accepted.namespace ?? namespaceFields(this.config.namespace), intended.namespaceFields)) {
          this.refreshMediaSelection({ [_mediaType]: intended });
        }
        if (this._destroyed || this.connection !== conn || this.isTerminalState()) return;
        if (this.mseCompletions?.get(_mediaType)?.emitted) this.mseCompletions.delete(_mediaType);
        this.reconsiderMseTrackEnds();
        this._mediaSubsOk++;
        const subscription = this.activeSubscriptions.get(requestId);
        const owner = subscription && this.warmMediaOwners.get(subscription);
        if (owner?.connection === conn && subscription?.trackAlias !== null && subscription?.trackAlias !== undefined) {
          owner.registration = this.subscriptionManager?.captureRoute(subscription.trackAlias) ?? null;
          owner.head?.acceptLargest(largest);
          if (owner.prefixStart && !isDraft22(conn.draftVersion) && largest
              && largest.group >= owner.prefixStart.group) this.requestWarmRange(owner, _trackName);
        }
      },
      onMediaSubscribeError: (requestId, trackName, mediaType, reason, errorCode, retryInterval) => {
        // Latch the owning response before application callbacks can replace or
        // cancel recovery. Errors for another request/session cannot end its probe.
        for (const restart of this.livenessRestarts.values()) {
          if (restart.connection === conn && restart.requestId === requestId
              && restart.active && this.livenessLadderMayContinue(restart)) {
            // Draft14 SUBSCRIBE_ERROR has no Retry Interval; its codec's zero
            // placeholder is not a peer instruction against retry (draft14 §9.9).
            restart.refusal = { retryInterval: conn.session.draftVersion === 14 ? null : retryInterval,
              atMs: performance.now() };
          }
        }
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
        const warmOwner = fetchInfo?.warmOwner;
        if (warmOwner?.connection === conn && warmOwner.prefixFetch === fetchInfo) {
          // REQUEST_ERROR ends the FETCH (draft16 §5.2). Legacy callbacks can
          // precede local session reclamation: abandonment must not send a
          // FETCH_CANCEL after the peer has already refused this request.
          warmOwner.prefixCancelled = true;
          warmOwner.prefixFetch = null;
        }
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
          this.retireLocmafConsumerInputs(subscription.trackName, subscription.mediaType, alias, groupId);
          this.locmafDecoders.get(this.mediaKey(subscription.trackName, subscription.mediaType, alias))?.resetGroup(groupId);
          this.locmafFrameReaders.get(this.mediaKey(subscription.trackName, subscription.mediaType, alias))?.reader.resetGroup(groupId);
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
        this.refreshMediaSelection();
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
        this.refreshMediaSelection();
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
    let owningDispatcher: CommandDispatcher | null | undefined;
    const ownsCommands = () => owningDispatcher === undefined || this.commandDispatcher === owningDispatcher;

    const config = this.config.createAudioOutput ? { ...this.config, createAudioOutput: () => {
      const output = this.config.createAudioOutput!(); this.audioOutput = output; return output;
    } } : this.config;
    const pipelines = createPipelines(config, this.clock, trackInfo, {
      onAttached: () => this.handleCmafMediaSourceAttached(),
      onFirstFrame: () => {
        if (!ownsCommands()) return;
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
        this.resetMediaClock();

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
              this.selectVideoTrack({ name: newTrack.name, namespace: trackNamespaceFields(newTrack, this.config.namespace) }, 'recovery', 'downshift').catch((err) => {
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
        if (!ownsCommands()) return;
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
          if (!this.audioTimingMapped && !this.videoTimingMapped) {
            this.resetMediaClock();
          }
        }
      },
      onFrameRendered: (_captureTimestampUs, _actualRenderUs) => {
        if (!ownsCommands()) return;
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
      onFeedback: (fb) => { if (ownsCommands()) this.handleFeedback(fb); },
      onCommand: (cmd) => { if (ownsCommands()) this.handlePipelineCommand(cmd); },
      onEvent: (mediaType, evt) => { if (ownsCommands()) this.handlePipelineEvent(mediaType, evt); },
      // A/V skew observability (LOC): record every sample, emit ~1/s.
      onAvSkew: (skewUs) => {
        if (this.audioTimingMapped || this.videoTimingMapped) return; // raw output clocks cannot be compared across a mapped source change
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
    owningDispatcher = pipelines.commandDispatcher;
    this.revokeVideoSwitchRecovery();
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
        if (this.pendingVideoSwitch || this.switchInProgress || this.mediaSelection || this.seekIsPreparing()) return;

        // Emergency downshift: non-mutating peek, deferred commit.
        if (this.qualityController && this.bufferAbrController) {
          const newTrack = this.qualityController.peekLowerVideoQuality(true);
          if (newTrack) {
            this.lastAbrDownshiftUs = this.clock.now();
            this.log.warn('MSE stall %dms → emergency downshift to %s', durationMs, newTrack.name);
            this.selectVideoTrack({ name: newTrack.name, namespace: trackNamespaceFields(newTrack, this.config.namespace) }, 'recovery', 'downshift').catch((err) => {
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
    this.retireVideoMeasurement();
    this.cmafAssembler?.reset();
    for (const mt of ['video', 'audio'] as const) {
      const bytes = this.runningInitBytes(mt);
      if (bytes) this.cmafAssembler?.setInitSegment?.(mt, bytes);
    }
    this.cmafVideoSynced = false;
    // Held LOCMAF objects never reached their decoders: restart each group reference.
    this.subscriptionManager?.resetMediaConsumer();
    for (const decoder of this.locmafDecoders.values()) decoder.reset();
    this.clearLocmafFrameReaders();
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
    if (!this.config.createCmafAssembler) throw new Error('CMAF tracks require createCmafAssembler in MoqtPlayerConfig');
    const epoch = this.mseOutputEpoch;
    let assembler: CmafAssemblerLike | null = null;
    assembler = this.config.createCmafAssembler(this.cmafOutputCallbacks(ms,
      () => assembler !== null && this.cmafAssembler === assembler && this.mseOutputEpoch === epoch));
    this.cmafAssembler = assembler;
    this.keyedCmafIdentity = ms.supportsTrackIdentity === true && assembler.supportsTrackIdentity === true;
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

  /** A viewer's language choice survives automatic selections in other programs. */
  private effectiveAudioLanguages(): readonly string[] | undefined {
    return this.runtimeAudioLanguage === null ? this.config.audioLanguages
      : [this.runtimeAudioLanguage, ...(this.config.audioLanguages ?? [])];
  }

  /**
   * The explicit selection this config asks for, as the model's intent.
   *
   * `undefined` when nothing is named, which is what keeps the documented
   * defaults in force. A selector for DISABLED media is dropped here rather
   * than resolved: disabling is the stronger statement.
   */
  private selectionIntent(): SelectionIntent | undefined {
    const configured = this.runtimeSelectionIntent ?? selectionIntentFromConfig(this.config);
    return this.runtimeAudioIntent === null ? configured : { ...configured, audioTrack: this.runtimeAudioIntent };
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
    const audioLanguages = this.effectiveAudioLanguages();
    const composed = composeSelection(catalog, {
      catalogNamespace: this.config.namespace,
      ...(intent !== undefined ? { intent } : {}),
      controller: this.qualityController!,
      ...(audioLanguages !== undefined ? { audioLanguages } : {}),
      ...(this.config.videoConstraints !== undefined
        ? { videoConstraints: this.config.videoConstraints } : {}),
      ...(this.runtimeAudioIntent === null && this.runtimeAudioLanguage === null && this.config.audioConstraints !== undefined
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
          { ...mediaOptions, ...this.subscriberPriorityFor(mediaType), ...this.mediaTerminalOptions(conn),
            onRequestId: (id: bigint) => { registeredId = id; registerMediaSub(id); } } as never);
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
      this.timelineSource = null;
      const timelineConnection = this.connection;
      const timelineWireFormat = this.catalogSlots.catalogManager?.wireFormat ?? null;
      let registration: NonNullable<MoqtPlayer['timelineSource']> | null = null;

      const nsBytes = trackNamespaceFields(timelineTrack, this.config.namespace).map(field => this.enc.encode(field));
      const nameBytes = this.enc.encode(timelineTrack.name);
      // §9.10 + pre-send ownership: registration (incl. pendingMediaSubs for
      // the SUBSCRIBE_OK alias remap) happens inside onRequestId.
      const reqIdBigInt = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, subscribeOptions, {
        trackName: timelineTrack.name, mediaType: 'mediatimeline', packaging: 'mediatimeline',
      }, (id) => {
        const issued = this.activeSubscriptions.get(id);
        if (issued?.namespace === undefined) throw new Error('Timeline request has no issued namespace');
        this.timelineRequestId = id;
        registration = { connection: timelineConnection, trackName: issued.trackName, namespace: [...issued.namespace],
          wireFormat: timelineWireFormat };
        this.timelineSource = registration;
      }, (id) => {
        if (this.timelineRequestId === id && this.timelineSource === registration) {
          this.timelineRequestId = null; this.timelineSource = null;
        }
      });
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
        { ...((options as object | undefined) ?? {}),
          ...(info.packaging !== 'init' ? { ...this.subscriberPriorityFor(info.mediaType), ...this.mediaTerminalOptions(conn) } : {}), onRequestId: (id: bigint) => register(BigInt(id)) } as never);
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
    const prepared = cmd.type === 'configure' || cmd.type === 'reset' ? this.preparedDecoderConfigurations.get(cmd.mediaType) : undefined;
    if (cmd.type === 'configure' && prepared?.applied && prepared.previous.dispatcher === this.commandDispatcher
        && bytesEqual(prepared.requested, cmd.config)) {
      return; // native configuration already succeeded in this media preparation
    }
    let dispatched: DecoderCommand | undefined;
    const dispatcher = this.commandDispatcher;
    const configurationCommand = cmd.type === 'configure' ? {} : undefined;
    if (configurationCommand && cmd.type === 'configure') this.decoderConfigurationCommands.set(cmd.mediaType, configurationCommand);
    const configurationRole = cmd.type === 'configure' ? cmd.mediaType : undefined;
    const requestedConfiguration = cmd.type === 'configure' ? new Uint8Array(cmd.config) : undefined;
    const conn = this.connection, generation = this.bootstrapGeneration, source = this.mediaSource;
    const isLive = () => !this._destroyed && this.commandDispatcher === dispatcher && this.connection === conn
      && this.bootstrapGeneration === generation && this.mediaSource === source
      && (cmd.type !== 'configure' || this.decoderConfigurationCommands.get(cmd.mediaType) === configurationCommand);
    const emitEvent = (event: Record<string, unknown>) => {
      if (event.command) dispatched = event.command as DecoderCommand;
      // Stats: record decoder milestones
      if (event.command && (event.command as DecoderCommand).type === 'configure') {
        this._stats.recordDecoderConfigured();
      } else if (event.command && (event.command as DecoderCommand).type === 'decode_video') {
        this._stats.recordFrameDecoded();
      }
      this.emitter.emit(event.type as any, event as any);
    };
    const preparedReset = cmd.type === 'reset' && prepared?.applied && prepared.previous.dispatcher === dispatcher
      ? cmd.mediaType : undefined;
    const configured = doPipelineCommand(cmd, this.config.commandTransform, dispatcher, this.mediaSource, emitEvent, preparedReset, isLive);
    if (!isLive()) return;
    const actual = dispatched as DecoderCommand | undefined;
    if (actual?.type === 'decode_audio' && dispatcher !== null && this.commandDispatcher === dispatcher && !this._destroyed) {
      const source = actual.chunk.sourceTimestamp;
      if (source && source.ticksPerSecond > 0n) {
        const domain = source.domain === 'unix' ? 'wall-clock' : source.domain === 'media' ? 'media-time' : 'unknown';
        this.lastAudioDomainOwner = this.selectedOutputOwners.get('audio')?.selection ?? null;
        this.lastAudioDomain = domain;
        this.noteAudioTimeline(source.ticks * 1_000_000n / source.ticksPerSecond, domain);
      }
    }
    if (this.collectVideoTimeline && actual?.type === 'decode_video' && dispatcher !== null
        && this.commandDispatcher === dispatcher && !this._destroyed) {
      const source = actual.chunk.sourceTimestamp;
      if (source && source.ticksPerSecond > 0n) {
        const domain = source.domain === 'unix' ? 'wall-clock' : source.domain === 'media' ? 'media-time' : 'unknown';
        this.noteMediaTimeline('video', source.ticks * 1_000_000n / source.ticksPerSecond, domain);
      }
    }
    if (cmd.type === 'configure' && actual?.type === 'configure' && actual.mediaType === cmd.mediaType
        && configured?.mediaType === cmd.mediaType
        && configurationRole !== undefined && requestedConfiguration !== undefined && dispatcher !== null) {
      const record: InstalledDecoderConfiguration = { dispatcher, requested: requestedConfiguration,
        configured: configured.config, format: configured };
      // Snapshot every callback-bearing value before this last ownership check.
      if (isLive()) this.installedDecoderConfigurations.set(configurationRole, record);
    }
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
      syncController: this.audioTimingMapped ? null : this.syncController,
      resetSync: () => this.resetMediaClock(),
      syncResetThisTick: this.syncResetThisTick,
      setSyncResetThisTick: (v) => { this.syncResetThisTick = v; },
      recordDiagnostic: (kind) => this._stats.recordLocDiagnostic(kind),
      recoveryHook: (action) => {
        const result = this.hooks.onRecovery.run(action);
        if (result) {
          doRecoveryAction(result, mediaType, this.qualityController, this.log, {
            onQualityReduced: (newTrack) => {
              this.selectVideoTrack({ name: newTrack.name, namespace: trackNamespaceFields(newTrack, this.config.namespace) }, 'recovery', 'downshift').catch((err) => {
                this.log.warn('Quality switch to "%s" failed: %s', newTrack.name, err);
              });
            },
            onResubscribe: (recoveryMediaType, startGroup) => {
              // A pipeline gap skip has already moved to a group it holds, so
              // playback continues locally. Resubscribing from the live edge
              // jumped this one track over the link's whole backlog — under
              // congestion, audio landed seconds ahead of video. (A stall,
              // which flushes the pipeline first, still resubscribes.)
              if (result.type === 'skip_forward') return;
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
    if (!this.mediaRecoveryOwnsConnection(this.connection)) return;
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
    const connection = this.connection;
    if (!this.mediaRecoveryOwnsConnection(connection)) return;
    const issued = this.activeSubscriptions.get(track.requestId);
    if (!issued || this.terminalMediaSubscriptions.has(issued)) return;
    const namespace = [...(issued.namespace ?? namespaceFields(this.config.namespace))];
    const key = JSON.stringify([namespace, track.trackName, track.mediaType]);
    let restart = this.livenessRestarts.get(key);
    if (!restart || restart.connection !== connection || !restart.ownsOutput()) {
      if (restart) restart.cancelled = true;
      const output = this.selectedOutputOwners.get(track.mediaType);
      const generation = this.bootstrapGeneration;
      restart = { attempts: 0, active: false, cancelled: false, connection,
        namespace, mediaType: track.mediaType, trackName: track.trackName,
        requestId: track.requestId, refusal: null, failure: null,
        ownsOutput: () => this.bootstrapGeneration === generation
          && this.selectedOutputOwners.get(track.mediaType) === output,
      };
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
        restart.refusal = null;
        restart.failure = null;
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

        if (!this.livenessLadderMayContinue(restart)) return;
        this.flushForLivenessRestart(track);
        if (!this.livenessLadderMayContinue(restart)) return;
        const refreshed = attempt === 1 && await this.tryRefreshSubscription(track, restart);
        if (!this.livenessLadderMayContinue(restart)) return;
        if (refreshed) {
          this.log.info('Liveness: refreshed %s "%s" via REQUEST_UPDATE (attempt %d)',
            track.mediaType, track.trackName, attempt);
        } else {
          // Refresh unavailable/failed or a later attempt — full resubscribe.
          await this.fullResubscribeForLiveness(track, restart);
        }

        // A replacement updates the owned request ID before it reaches the wire.
        if (await this.waitForTrackArrival(attemptStartMs, this.config.livenessTimeoutMs!, restart)) {
          this.log.info('Liveness: %s "%s" recovered on attempt %d',
            track.mediaType, track.trackName, attempt);
          return;
        }
        // REQUEST_ERROR Retry Interval 0 advises against retrying as sent
        // (draft18 §10.6, draft22 §9.4). Do not turn it into a fresh incident.
        if (restart.failure || this.livenessRetryRefused(restart)) break;
      }

      if (this.livenessLadderMayContinue(restart)) {
        const detail = restart.failure ?? (this.livenessRetryRefused(restart)
          ? 'publisher refused automatic retry'
          : `${restart.attempts} restart attempts failed`);
        this.emitError(createPlayerError(
          'fatal', 'connection', PlayerErrorCode.MEDIA_STARVED,
          `Media delivery starved: ${track.mediaType} "${track.trackName}" — ${detail}`,
          { context: { mediaType: track.mediaType, trackName: track.trackName } },
        ));
        if (!this.livenessLadderMayContinue(restart)) return;
        if (this.stateMachine.state !== PlayerState.ERROR) {
          this.transitionState(PlayerState.ERROR);
        }
        this.stopTicking();
      }
    } finally {
      restart.active = false;
    }
  }

  /** One selected accepted route, including finite media and frame-mode carriers. */
  private captureVideoMeasurementOwner(): NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'] | null {
    const connection = this.connection, manager = this.subscriptionManager, selected = this._selection.video;
    if (this._destroyed || this.state !== PlayerState.PLAYING || this.playbackIntent !== true
        || !connection || connection.session?.state !== SessionState.ESTABLISHED
        || !manager || !selected) return null;
    const seekOwner = this.captureSeekVideoMeasurementOwner(connection, manager);
    if (seekOwner) return seekOwner;
    if (this.videoDeliveryEnding()) return null;
    let requestId: bigint | null = null, alias: bigint | null = null, subscription: object | null = null;
    for (const [id, sub] of this.activeSubscriptions) {
      if (sub.mediaType !== 'video' || sub.trackAlias === null || sub.trackName !== selected.name
          || this.terminalMediaSubscriptions.has(sub) || this.supersededRouting?.aliases.has(sub.trackAlias)
          || !sameNamespaceFields(sub.namespace ?? namespaceFields(this.config.namespace), selected.namespaceFields)) continue;
      if (requestId !== null) return null;
      requestId = id; alias = sub.trackAlias; subscription = sub;
    }
    if (requestId === null || alias === null || subscription === null) return null;
    const sourceKey = manager.getSourceKey(alias);
    if (sourceKey !== identityKey(selected.namespaceFields, selected.name)) return null;
    const generation = manager.mediaInputGeneration, output = this.selectedOutputOwners.get('video');
    const pipeline = this.videoPipeline, source = this.mediaSource, assembler = this.cmafAssembler;
    const automatic = this.qualityController?.isAutoQuality ?? false;
    const mode = this.videoMeasurementMode;
    const key = this.mediaKey(selected.name, 'video', alias);
    const decoder = this.locmafDecoders.get(key);
    const header = this.locmafDecoderInit.get(key);
    const frameReader = this.locmafFrameReaders.get(key);
    const old = this.videoPayloadMeasurement?.owner;
    if (old?.kind === 'ordinary' && old.connection === connection && old.manager === manager && old.generation === generation
        && old.subscription === subscription && old.requestId === requestId && old.alias === alias && old.sourceKey === sourceKey
        && old.output === output && old.pipeline === pipeline && old.source === source && old.assembler === assembler
        && old.automatic === automatic && old.mode === mode && old.frameReader === frameReader && old.decoder === decoder && old.header === header && old.route()) return old;
    const route = manager.captureRoute(alias);
    return route ? { kind: 'ordinary', connection, manager, generation, requestId, alias, subscription, sourceKey,
      output, pipeline, source, assembler, automatic, mode, frameReader, decoder, header, route } : null;
  }

  /** Accepted live bridge identity is independent of its not-yet-installed input lease. */
  private captureSeekVideoMeasurementOwner(connection: MoqtConnection, manager: SubscriptionManager):
    NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'] | null {
    const selected = this._selection.video;
    if (!selected) return null;
    const loc = this.activeLocSeek, mse = this.activeMseSeek;
    const attempt = loc && !loc.retired && loc.output ? loc : mse;
    if (!attempt || attempt.retired || attempt.connection !== connection) return null;
    const frameOutput = attempt === loc ? loc.output : null;
    const frameVideo = frameOutput ? loc!.videoOutput ?? loc!.playback.videoDiagnosticGraph : null;
    const videoOwner = frameOutput ? loc!.playback.videoRoleOwner() : null;
    const mseOutput = frameOutput ? null : this.ownedSeekOutput;
    const output = frameVideo ?? mseOutput;
    if (!output) return null;
    const sourceKey = identityKey(selected.namespaceFields, selected.name);
    const owners = [...attempt.bridges].filter(owner => owner.role === 'video' && !owner.ending
      && owner.track.name === selected.name && sameNamespaceFields(owner.track.namespace, selected.namespaceFields)
      && (attempt === loc ? loc.tracks.includes(owner.track) : mse?.tracks.get('video') === owner.track)
      && owner.bridge?.acceptedLiveSubscription !== null && owner.bridge !== null);
    if (owners.length !== 1) return null;
    const bridgeOwner = owners[0]!, bridge = bridgeOwner.bridge!;
    const subscription = bridge.acceptedLiveSubscription;
    if (!subscription) return null;
    const track = bridgeOwner.track, epoch = attempt.epoch;
    const generation = manager.mediaInputGeneration, mode = this.videoMeasurementMode;
    const automatic = this.qualityController?.isAutoQuality ?? false;
    const configuration = this.installedDecoderConfigurations.get('video');
    const pipeline = this.videoPipeline, source = this.mediaSource, assembler = this.cmafAssembler;
    const mseSelection = frameOutput ? null : this.mseSelection('video');
    const route = (): boolean => {
      try {
        // Resolve callback-bearing evidence before comparing engine-owned identities.
        const accepted = bridge.acceptedLiveSubscription === subscription;
        const available = frameOutput !== null
          ? !loc!.playback.isEnding('video')
          : mseOutput !== null && mseOutput.resource.epoch === epoch && mseOutput.resource.current;
        const selectionCurrent = frameOutput !== null
          || this.mseSelection('video')?.selection === mseSelection?.selection;
        return accepted && available && selectionCurrent && !this._destroyed && !attempt.retired
          && this.state === PlayerState.PLAYING && this.playbackIntent === true && this.connection === connection
          && this.subscriptionManager === manager && manager.mediaInputGeneration === generation
          && this.videoMeasurementMode === mode && this._selection.video === selected
          && attempt.bridges.has(bridgeOwner) && bridgeOwner.track === track && !bridgeOwner.ending
          && bridgeOwner.bridge === bridge
          && this.installedDecoderConfigurations.get('video') === configuration
          && (frameOutput !== null
            ? this.activeLocSeek === attempt && loc?.output === frameOutput
              && this.commandDispatcher === frameOutput.pipelines.commandDispatcher
              && (loc.videoOutput ?? loc.playback.videoDiagnosticGraph) === frameVideo && loc.playback.videoRoleOwner() === videoOwner
              && this.videoPipeline === frameVideo?.pipelines.videoPipeline
              && loc.tracks.includes(track)
            : this.activeMseSeek === attempt && this.ownedSeekOutput === mseOutput
              && this.mediaSource === mse?.source && this.mseOutputEpoch === epoch
              && mse?.tracks.get('video') === track && !mse.ended.has('video')
              && !mse.retiringRoles.has('video') && mse.videoSelection?.selection === mseSelection?.selection
              && mse.videoSelection?.key === sourceKey
              && this.cmafAssembler === mseOutput?.assembler);
      } catch { return false; }
    };
    if (!route()) return null;
    return { kind: 'seek-live', attempt, bridgeOwner, track, epoch, selection: selected, configuration,
      connection, manager, generation, requestId: subscription.requestId, alias: subscription.trackAlias,
      subscription, sourceKey, output, pipeline, source, assembler, automatic, mode,
      frameReader: undefined, decoder: frameVideo?.output.videoDecoder, header: undefined, route };
  }

  private seekLiveObservation(bridgeOwner: SeekRoleBridgeOwner):
    NonNullable<ConstructorParameters<typeof SeekLiveBridge>[1]['liveObservation']> {
    // Only tokens issued by this observer can be delivered back into the engine.
    const captures = new WeakMap<object, NonNullable<ReturnType<MoqtPlayer['captureVideoPayload']>> & { receipt: ObjectReceipt }>();
    let cmafAuthority: { owner: NonNullable<MoqtPlayer['videoDeliveryLag']>['owner']; authority: object } | undefined;
    return {
      capture: event => {
        const owner = this.captureVideoMeasurementOwner();
        if (owner?.kind !== 'seek-live' || owner.bridgeOwner !== bridgeOwner) return;
        const nowUs = this.clock.now();
        if (!this.sameVideoMeasurementOwner(owner, this.captureVideoMeasurementOwner())) return;
        const token = {};
        captures.set(token, { owner, bytes: event.payloadBytes, nowUs, receipt: event.receipt });
        return token;
      },
      deliver: (object, token) => {
        const receipt = captures.get(token); captures.delete(token);
        if (!receipt || !this.sameVideoMeasurementOwner(receipt.owner, this.captureVideoMeasurementOwner())) return;
        this.recordVideoPayload(receipt);
        if (object.kind !== 'data') return;
        const packaging = this.catalogTrackFor(bridgeOwner.track.name, bridgeOwner.track.namespace, 'video')?.packaging;
        if (packaging && this.usesMse(packaging)) {
          if (!this.sameVideoMeasurementOwner(receipt.owner, this.videoLagOwner())) return;
          if (!cmafAuthority || !this.sameVideoMeasurementOwner(cmafAuthority.owner, receipt.owner)) {
            cmafAuthority = { owner: receipt.owner, authority: {} };
          }
          this.seekCmafInputs.set(receipt.receipt, cmafAuthority);
          return;
        }
        if (packaging !== 'loc') return;
        const subscription = bridgeOwner.bridge?.acceptedLiveSubscription;
        if (!subscription) return;
        const headers = parseLocHeaders(object.properties ?? object.extensions, {
          wireProfile: locWireProfileForDraft(receipt.owner.connection.draftVersion),
          track: locSeekTrackContext(subscription.initialTrackProperties),
        });
        if (this.sameVideoMeasurementOwner(receipt.owner, this.captureVideoMeasurementOwner())) {
          this.seekCadenceInputs.set(receipt.receipt, {
            object: { kind: object.kind, trackAlias: object.trackAlias, groupId: object.groupId, objectId: object.objectId, payloadBytes: receipt.bytes },
            owner: receipt.owner, headers,
          });
        }
      },
    };
  }

  private sameVideoMeasurementOwner(a: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'],
    b: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'] | null): boolean {
    return b !== null && a.kind === b.kind
      && (a.kind !== 'seek-live' || (b.kind === 'seek-live' && a.attempt === b.attempt
        && a.bridgeOwner === b.bridgeOwner && a.track === b.track && a.epoch === b.epoch
        && a.selection === b.selection && a.configuration === b.configuration))
      && a.connection === b.connection && a.manager === b.manager && a.generation === b.generation
      && a.subscription === b.subscription && a.requestId === b.requestId && a.alias === b.alias && a.sourceKey === b.sourceKey
      && a.output === b.output && a.pipeline === b.pipeline && a.source === b.source && a.assembler === b.assembler
      && a.automatic === b.automatic && a.mode === b.mode && a.frameReader === b.frameReader && a.decoder === b.decoder && a.header === b.header && a.route() && b.route();
  }

  private captureVideoPayload(alias: bigint, bytes: number, connection: MoqtConnection,
    location?: { groupId: bigint; objectId: bigint }): {
    readonly owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'];
    readonly bytes: number; readonly nowUs: number;
    readonly encode?: NonNullable<MoqtPlayer['videoEncodeRecord']>;
  } | undefined {
    const owner = this.captureVideoMeasurementOwner();
    if (!owner) { this.videoPayloadMeasurement = null; return; }
    if (owner.kind !== 'ordinary' || owner.connection !== connection || owner.alias !== alias) return;
    // Bind the already-known entry before either callback-bearing clock runs.
    const encode = location ? this.captureVideoEncodeObservation(owner, location) : undefined;
    const nowUs = this.clock.now();
    // An application clock may synchronously replace the selected output.
    if (!this.sameVideoMeasurementOwner(owner, this.captureVideoMeasurementOwner())) return;
    return { owner, bytes, nowUs, ...(encode && encode.captured?.() && encode.current() ? { encode } : {}) };
  }

  private recordVideoPayload(receipt: ReturnType<MoqtPlayer['captureVideoPayload']>): void {
    if (!receipt) return;
    const { owner, bytes, nowUs } = receipt;
    if (!this.sameVideoMeasurementOwner(owner, this.captureVideoMeasurementOwner())) return;
    let measurement = this.videoPayloadMeasurement;
    if (!measurement || !this.sameVideoMeasurementOwner(measurement.owner, owner)) {
      measurement = { owner, rate: new ReceivedPayloadRate() };
      this.videoPayloadMeasurement = measurement;
    }
    measurement.rate.observe(bytes, nowUs);
    // Only the direct live branches call this with a captured receipt; FETCH
    // routing and parked/candidate replay never forward that token here.
    if (receipt.encode?.captured?.() && receipt.encode.current()) {
      this.videoEncodeRecord = { observation: receipt.encode.observation, current: receipt.encode.current };
    }
  }

  /** Reuse the original selected receipt boundary; never date transformed/replayed input. */
  private captureVideoEncodeObservation(owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner'],
    location: { groupId: bigint; objectId: bigint }): NonNullable<MoqtPlayer['videoEncodeRecord']> | undefined {
    const selected = this._selection.video, source = this.timelineSource, timeline = this.timelineState;
    const request = this.timelineRequestId, catalog = this._catalogState;
    const configuration = this.installedCmafInit.get('video');
    const epoch = this.mseOutputEpoch;
    if (owner.kind !== 'ordinary' || !selected || !source || !timeline || request === null || !catalog
        || !configuration || configuration.source !== owner.source || !owner.output || !owner.assembler
        || source.connection !== owner.connection || !timeline.isLive
        || (source.wireFormat !== 'msf-00' && source.wireFormat !== 'msf-01')) return;
    const track = this.catalogTrackFor(selected.name, selected.namespaceFields, 'video');
    const applicable = () => this._catalogState?.tracks.filter(t => t.packaging === 'mediatimeline'
      && t.depends?.includes(selected.name) && sameNamespaceFields(trackNamespaceFields(t, this.config.namespace), selected.namespaceFields));
    const candidates = applicable();
    if (!track?.isLive || track.packaging !== 'cmaf' || candidates?.length !== 1
        || candidates[0]!.name !== source.trackName || !sameNamespaceFields(source.namespace, selected.namespaceFields)
        || !timeline.depends.includes(selected.name)) return;
    const subscription = this.activeSubscriptions.get(request);
    if (!subscription || subscription.trackAlias === null || subscription.trackName !== source.trackName
        || !sameNamespaceFields(subscription.namespace ?? [], source.namespace)) return;
    const route = owner.manager.captureRoute(subscription.trackAlias);
    if (!route) return;
    const entry = findEncodeAnchor(timeline, location.groupId, location.objectId);
    if (!entry) return;
    const applicableNow = () => {
      const tracks = applicable(), video = this.catalogTrackFor(selected.name, selected.namespaceFields, 'video');
      return video?.isLive === true && video.packaging === 'cmaf' && tracks?.length === 1
        && tracks[0]!.name === source.trackName && tracks[0]!.isLive;
    };
    const current = () => this.timelineSource === source && this.timelineRequestId === request
      && this.activeSubscriptions.get(request) === subscription && !this.terminalMediaSubscriptions.has(subscription)
      && applicableNow() && this.installedCmafInit.get('video') === configuration
      && this.mseOutputEpoch === epoch && !this.retypingMedia.has('video')
      && !this.preparingMseSeek && !this.activeMseSeek && !this.preparingLocSeek && !this.activeLocSeek
      && route() && this.sameVideoMeasurementOwner(owner, this.captureVideoMeasurementOwner());
    if (!current()) return;
    const receivedWallclockMs = Date.now();
    const encodeToReceiptMs = receivedWallclockMs - entry.wallclockTime;
    if (!Number.isFinite(receivedWallclockMs) || !Number.isFinite(encodeToReceiptMs)
        || this.timelineState !== timeline || !current()) return;
    const observation: VideoEncodeObservation = Object.freeze({
      source: Object.freeze({ name: selected.name, namespaceFields: Object.freeze([...selected.namespaceFields]) }),
      timeline: Object.freeze({ name: source.trackName, namespaceFields: Object.freeze([...source.namespace]) }),
      location: Object.freeze({ groupId: location.groupId.toString(), objectId: location.objectId.toString() }),
      mediaPtsMs: entry.mediaPts,
      encodedWallclockMs: entry.wallclockTime, receivedWallclockMs, encodeToReceiptMs,
    });
    // State replacement during the second (monotonic) clock also cancels capture.
    // Once committed, ordinary incremental timeline updates do not refresh it.
    return { observation, current, captured: () => this.timelineState === timeline };
  }

  private readVideoEncodeObservation(): VideoEncodeObservation | null {
    const record = this.videoEncodeRecord;
    if (!record) return null;
    if (!record.current()) {
      if (this.videoEncodeRecord === record) this.videoEncodeRecord = null;
      return null;
    }
    return record.observation;
  }

  private readVideoReceivedRate(): number | null {
    const measurement = this.videoPayloadMeasurement;
    if (!measurement) return null;
    if (!this.sameVideoMeasurementOwner(measurement.owner, this.captureVideoMeasurementOwner())) {
      if (this.videoPayloadMeasurement === measurement) this.videoPayloadMeasurement = null;
      return null;
    }
    const nowUs = this.clock.now();
    if (this.videoPayloadMeasurement !== measurement
        || !this.sameVideoMeasurementOwner(measurement.owner, this.captureVideoMeasurementOwner())) return null;
    return measurement.rate.read(nowUs);
  }

  private recordLocGroupCadence(obj: CadenceObject, headers: LocHeaders, owner: ReturnType<MoqtPlayer['captureVideoMeasurementOwner']>): void {
    if (obj.kind !== 'data' || BigInt(obj.objectId) !== 0n) return;
    if (!owner || !this.sameVideoMeasurementOwner(owner, this.captureVideoMeasurementOwner())) return;
    if (BigInt(obj.trackAlias) !== owner.alias) return;
    const selected = this._selection.video;
    if (!selected || this.catalogTrackFor(selected.name, selected.namespaceFields, 'video')?.packaging !== 'loc') return;
    let current = this.videoGroupCadence;
    if (!current || !this.sameVideoMeasurementOwner(current.owner, owner)) {
      current = { owner, cadence: new LocGroupCadence() };
      this.videoGroupCadence = current;
    }
    // An explicitly dependent start cannot establish an independently playable Group.
    current.cadence.observe(BigInt(obj.groupId), headers.videoFrameMarking?.independent === false ? {} : headers);
  }

  /** Retire receipts captured before a whole-output reset without changing media policy. */
  private retireVideoMeasurement(): void {
    this.videoMeasurementMode = {};
    this.videoEncodeRecord = null;
    this.videoPayloadMeasurement = null;
    this.videoGroupCadence = null;
    this.videoDeliveryLag = null;
  }

  /** Cancel waiting recovery and release its cached session reference before retirement. */
  private cancelLivenessRestarts(connection?: MoqtConnection): void {
    for (const [key, restart] of this.livenessRestarts) {
      if (connection !== undefined && restart.connection !== connection) continue;
      restart.cancelled = true;
      this.livenessRestarts.delete(key);
    }
  }

  /** Established media keeps delivering during GOAWAY; migration owns its replacement. */
  private mediaRecoveryOwnsConnection(connection: MoqtConnection | null): connection is MoqtConnection {
    return connection !== null && this.connection === connection
      && connection.session?.state !== SessionState.DRAINING
      && connection.session?.state !== SessionState.CLOSED
      && (!this.currentMigration || this.currentMigration.committed || this.currentMigration.aborted);
  }

  /** A waiting ladder must not resume against a replacement connection. */
  private livenessLadderMayContinue(restart: LivenessRestart): boolean {
    return !restart.cancelled && !this._destroyed && restart.ownsOutput()
      && this.stateMachine.state === PlayerState.PLAYING
      && this.mediaRecoveryOwnsConnection(restart.connection);
  }

  private livenessRetryRefused(restart: LivenessRestart): boolean {
    return restart.refusal?.retryInterval === 0n;
  }

  /** Cancellation-aware sleep (checks every 250ms). */
  private async livenessSleep(ms: number, restart: LivenessRestart): Promise<void> {
    const deadline = performance.now() + ms;
    for (;;) {
      if (!this.livenessLadderMayContinue(restart)) return;
      const now = performance.now();
      const remaining = deadline - now;
      const refusal = restart.refusal;
      // Keep the wire integer exact, including values beyond Number.MAX_SAFE_INTEGER.
      const retryRemaining = refusal?.retryInterval == null ? 0n : refusal.retryInterval - 1n
        - BigInt(Math.max(0, Math.floor(now - refusal.atMs)));
      if (remaining <= 0 && retryRemaining <= 0n) return;
      const wait = Math.max(0, remaining, Number(retryRemaining > 250n ? 250n : retryRemaining));
      await new Promise((r) => setTimeout(r, Math.min(250, wait)));
    }
  }

  /** Poll only the current recovery request; another same-name track cannot satisfy it. */
  private async waitForTrackArrival(
    sinceMs: number,
    timeoutMs: number,
    restart: LivenessRestart,
  ): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    const pollMs = Math.min(250, Math.max(10, timeoutMs / 5));
    // Arrival is checked AFTER each sleep too — an object landing between
    // the final poll and the deadline must count as recovery.
    for (;;) {
      if (!this.livenessLadderMayContinue(restart) || restart.refusal || restart.failure) return false;
      const last = this.livenessMonitor?.lastArrivalForRequest(restart.requestId);
      if (last !== undefined && last >= sinceMs) return true;
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
    const measured = this.captureVideoMeasurementOwner();
    if (track.mediaType === 'video' && measured?.alias === track.trackAlias) this.retireVideoMeasurement();
    this.subscriptionManager?.resetMediaConsumer(track.trackAlias);
    const key = this.mediaKey(track.trackName, track.mediaType, track.trackAlias);
    const catalogTrack = this._catalogState?.tracks.find(t => this.initKey(t) === key);
    // LOCMAF on either path: drop the in-group reference; the restarted delivery begins at a full header.
    if (catalogTrack?.packaging === 'locmaf') {
      this.retireLocmafConsumerInputs(track.trackName, track.mediaType, track.trackAlias);
      this.locmafDecoders.get(this.mediaKey(track.trackName, track.mediaType, track.trackAlias))?.reset();
      this.clearLocmafFrameReader(this.mediaKey(track.trackName, track.mediaType, track.trackAlias));
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
    if (!this.audioTimingMapped && !this.videoTimingMapped) {
      this.resetMediaClock();
    }
  }

  /**
   * Attempt a REQUEST_UPDATE refresh (NextGroupStart) on the track's
   * existing subscription(s). Returns false when there is nothing to
   * refresh or the update fails — e.g. draft-18 throws when the
   * subscription's request stream died with the delivery path (§9.11).
   */
  private async tryRefreshSubscription(track: LivenessTrack, restart: LivenessRestart): Promise<boolean> {
    const connection = restart.connection;
    if (!this.livenessLadderMayContinue(restart)) return false;
    const sub = this.activeSubscriptions.get(restart.requestId);
    if (!sub || sub.trackName !== track.trackName || sub.mediaType !== track.mediaType
        || !sameNamespaceFields(sub.namespace ?? namespaceFields(this.config.namespace), restart.namespace)
        || this.terminalMediaSubscriptions.has(sub)) return false;
    try {
      await connection.requestUpdate(varint(restart.requestId), {
        subscriptionFilter: { type: 'NextGroupStart' },
      });
      return this.livenessLadderMayContinue(restart);
    } catch (err) {
      if (!this.livenessLadderMayContinue(restart)) return false;
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
  private async fullResubscribeForLiveness(track: LivenessTrack, restart: LivenessRestart): Promise<void> {
    const connection = restart.connection;
    if (!this.livenessLadderMayContinue(restart) || !this.subscriptionManager) return;
    const issued = this.activeSubscriptions.get(restart.requestId);
    if (issued && this.terminalMediaSubscriptions.has(issued)) { restart.cancelled = true; return; }
    const catalogTrack = this.catalogTrackFor(track.trackName, restart.namespace, track.mediaType);
    if (!catalogTrack) { restart.failure = 'track is no longer in the catalog'; return; }
    const cancellations: Promise<void>[] = [];
    for (const [requestId, sub] of [...this.activeSubscriptions.entries()]) {
      if (sub.trackName !== track.trackName || sub.mediaType !== track.mediaType
          || !sameNamespaceFields(sub.namespace ?? namespaceFields(this.config.namespace), restart.namespace)) continue;
      if (!this.livenessLadderMayContinue(restart)) return;
      this.retireMediaSubscription(requestId, connection);
      if (!this.livenessLadderMayContinue(restart)) return;
      // A peer-terminated request may already be absent from the SDK while
      // its last player route is still armed. There is nothing left to cancel.
      if (connection.session.getSubscription(requestId) !== undefined) {
        cancellations.push(connection.unsubscribe(varint(requestId)));
      }
    }
    // This orders local cancellation before new emission, not peer processing:
    // cancellation and the new request can still arrive on different streams.
    const outcome: { value: 'pending' | 'done' | 'failed' } = { value: 'pending' };
    let wake: (() => void) | undefined;
    void Promise.all(cancellations).then(() => { outcome.value = 'done'; wake?.(); },
      () => { outcome.value = 'failed'; wake?.(); });
    // Zero disables starvation monitoring; it is not a zero-duration
    // budget for retiring an already-issued request.
    const retirementTimeoutMs = this.config.livenessTimeoutMs! > 0
      ? this.config.livenessTimeoutMs!
      : (this.config.connectionTimeoutMs! > 0 ? this.config.connectionTimeoutMs! : 10_000);
    const deadline = performance.now() + retirementTimeoutMs;
    while (outcome.value === 'pending' && this.livenessLadderMayContinue(restart)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, Math.min(250, remaining)); });
      if (timer !== undefined) clearTimeout(timer);
      wake = undefined;
    }
    if (!this.livenessLadderMayContinue(restart)) return;
    if (outcome.value !== 'done') { restart.failure = 'local subscription retirement did not complete'; return; }
    this.replaceSubscription(track.trackName, 'liveness', catalogTrack, restart);
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
    restart?: LivenessRestart,
  ): void {
    if (!this.mediaRecoveryOwnsConnection(this.connection) || !this.subscriptionManager || !this._catalogState) return;
    const operationConn = this.connection;
    const generation = this.bootstrapGeneration;
    const attempt = restart?.attempts;
    const live = (): boolean => this.connection === operationConn && this.bootstrapGeneration === generation
      && !this._destroyed && !this.isTerminalState() && this.subscriptionManager !== null
      && this.mediaRecoveryOwnsConnection(operationConn)
      && (restart === undefined || (restart.active && restart.attempts === attempt && this.livenessLadderMayContinue(restart)));

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
    this.resetMediaClock();

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
      if (restart) restart.requestId = id;
    };
    // Start through the CAPTURED connection and attach both observers before
    // publishing: a recovery listener may synchronously destroy or migrate the
    // player, and `this.connection` is mutable. Announcing afterwards also
    // makes the event's contract true — the replacement has really started.
    const pending = resubConn.subscribe(nsBytes, nameBytes,
      { ...(filter ?? {}), ...this.subscriberPriorityFor(mediaType), ...this.mediaTerminalOptions(resubConn),
        onRequestId: (id: bigint) => registerResub(BigInt(id)) } as never,
    ).then((reqId) => {
      const reqIdBigInt = BigInt(reqId);
      if (!live()) return;
      registerResub(reqIdBigInt);
      // A same-turn REQUEST_ERROR can retire the entry before the write settles.
      if (!this.activeSubscriptions.has(reqIdBigInt)) return;

      this.log.info('Resubscribed %s "%s" requestId=%s after %s',
        mediaType, trackName, reqIdBigInt, cause);
      this.emitter.emit('track_subscribed', {
        type: 'track_subscribed',
        trackName,
        mediaType,
        requestId: reqIdBigInt,
      });
    }).catch((err: unknown) => {
      if (!live()) return;
      if (resubRegisteredId !== null) {
        this.retireMediaSubscription(resubRegisteredId, resubConn);
      }
      if (restart) restart.failure = 'replacement subscription could not be sent';
      const failure = err instanceof Error ? err : new Error('Subscription send failed');
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
    if (pendingSwitch && this.isVideoSwitchAlias(trackAlias, 'new')) {
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

  private seekPosition: PlaybackPosition | null = null;

  private mseOutputEpoch: object | null = null;

  private ownedSeekOutput: MseSeekAdoption | null = null;

  /** Application transform compatibility only; these are not wire alias bindings. */
  private ownedSeekTransformAliases: { readonly source: MediaSourceLike; readonly output: MseSeekAdoption;
    readonly aliases: ReadonlyMap<string, bigint> } | null = null;

  private preparingMseSeek: MseSeekAttempt | null = null;

  private activeMseSeek: MseSeekAttempt | null = null;

  private locSeekAdmission: object | null = null;

  private preparingLocSeek: LocSeekAttempt | null = null;

  private activeLocSeek: LocSeekAttempt | null = null;

  private frameOutputResources: readonly object[] = [];

  /** Announced FILL bodies stay claimed through physical close after cancellation. */
  private readonly seekFillStreams = new WeakMap<MoqtConnection, Map<bigint, SeekLiveBridge>>();


  /** Declaring identity captured from the timeline's issued auxiliary request. */
  private timelineSource: { connection: MoqtConnection; trackName: string; namespace: readonly string[];
    wireFormat: CatalogManager['wireFormat'] } | null = null;


  /**
   * Content position owned by a seek; null before admission. Holds the target
   * until output is observed, then follows that output without extrapolation.
   * LOC uses its indexed sample and source-time deltas under a unit-rate
   * mapping, checked against later observed anchors. Its quantized MSF anchor
   * limits precision to about 1 ms; original capture phase is not inferred.
   */
  get playbackPositionMs(): number | null {
    return this.seekPosition?.read(this.stateMachine.state === PlayerState.PLAYING) ?? null;
  }


  private historicalMseOutput(): MseSeekAttempt | null {
    const attempt = this.activeMseSeek, output = this.ownedSeekOutput;
    if (!attempt || !output) return null;
    const current = () => !this._destroyed && !this.isTerminalState() && !attempt.retired && attempt.positioned
      && this.activeMseSeek === attempt && this.ownedSeekOutput === output && this.connection === attempt.connection
      && this.mediaSource === attempt.source && this.cmafAssembler === output.assembler
      && this.mseOutputEpoch === attempt.epoch && output.resource.epoch === attempt.epoch;
    if (!current()) return null;
    try { return output.resource.current && current() ? attempt : null; }
    catch { return null; }
  }


  private historicalOutputTrack(role: SeekRole): CatalogTrack | undefined {
    const attempt = this.historicalMseOutput(), track = attempt?.tracks.get(role), selected = this._selection[role];
    if (!track || !selected || identityKey(selected.namespaceFields, selected.name) !== track.sourceKey
        || !attempt!.playback.roleOwner(role) || this.historicalMseOutput() !== attempt) return undefined;
    return this.catalogTrackFor(track.name, track.namespace, role);
  }


  /** A role replacement never borrows the composite dispatcher's audio authority. */
  private videoCommandDispatcher(): CommandDispatcher | null {
    const attempt = this.activeLocSeek;
    if (attempt && !attempt.retired && attempt.output
        && this.commandDispatcher === attempt.output.pipelines.commandDispatcher) {
      return (attempt.videoOutput ?? attempt.playback.videoDiagnosticGraph)?.pipelines.commandDispatcher ?? null;
    }
    return this.commandDispatcher;
  }

  private refreshLocFrameResources(attempt: LocSeekAttempt): void {
    if (this.activeLocSeek !== attempt || attempt.retired) return;
    this.frameOutputResources = [...new Set([...(attempt.output?.resources ?? []), ...(attempt.videoOutput?.resources ?? []),
      ...attempt.playback.videoDiagnosticGraphs.flatMap(graph => graph.resources)])];
  }

  private playingLocQualityAvailable(): boolean {
    const attempt = this.activeLocSeek, selected = this._selection.video;
    if (!attempt || attempt.retired || !attempt.positioned || !attempt.output || this.preparingLocSeek
        || this.state !== PlayerState.PLAYING || this.playbackIntent !== true || !selected
        || !attempt.playback.videoRoleOwner()) return false;
    const owner = this.captureVideoMeasurementOwner();
    return owner?.kind === 'seek-live' && owner.attempt === attempt
      && this.catalogTrackFor(selected.name, selected.namespaceFields, 'video')?.isLive === true;
  }

  private async selectPlayingLocVideoTrack(reference: string | TrackRefConfig, reason: string,
    abrAction: 'downshift' | 'upshift' | undefined, automaticAllowed: () => boolean): Promise<void> {
    const attempt = this.activeLocSeek, output = attempt?.output, selection = this._selection;
    const connection = this.connection, manager = this.subscriptionManager, sync = this.syncController;
    const source = this.timelineSource, generation = this.bootstrapGeneration;
    if (!attempt || !output || attempt.retired || !attempt.positioned || !connection || !manager || !sync
        || this.preparingLocSeek || this.currentMigration || this.mediaSelection || this.pendingVideoSwitch
        || this.switchInProgress || this.pendingRetypes.size || this.state !== PlayerState.PLAYING
        || this.playbackIntent !== true || this.commandDispatcher !== output.pipelines.commandDispatcher) {
      throw new Error('Playing frame video output is not accepting a rendition');
    }
    if (connection.draftVersion !== 18 && connection.draftVersion !== 22) {
      throw new Error('Playing frame rendition requires draft18 or22');
    }
    const selected = selection.video;
    const old = selected && this.catalogTrackFor(selected.name, selected.namespaceFields, 'video');
    const oldTrack = attempt.tracks.find(track => track.role === 'video');
    const previous = attempt.retrievals.get('video'), oldOwner = attempt.playback.videoRoleOwner();
    if (!selected || !old || !oldTrack || !previous || !oldOwner || oldTrack.name !== selected.name
        || !sameNamespaceFields(oldTrack.namespace, selected.namespaceFields)) throw new Error('Playing frame video owner is unavailable');
    const name = typeof reference === 'string' ? reference : reference.name;
    const namespace = typeof reference === 'string' ? undefined : namespaceFields(reference.namespace ?? this.config.namespace);
    const matches = this.qualityController?.eligibleLadder(this.activeVideoSet(old)).filter(track => track.name === name
      && (namespace === undefined || sameNamespaceFields(trackNamespaceFields(track, this.config.namespace), namespace))) ?? [];
    if (matches.length > 1) throw new Error(`Ambiguous video track: "${name}"`);
    const declared = matches[0];
    if (!declared || old.altGroup === undefined || declared.altGroup !== old.altGroup
        || !isTrackPackagingSupported(declared) || declared.packaging !== 'loc' && !(declared.packaging === 'locmaf' && this.locmafFramePath)) {
      throw new Error('Playing frame rendition requires a supported member of the same declared alternate set');
    }
    if (this.initKey(old) === this.initKey(declared)) return;
    const target = structuredClone(declared), targetNs = [...trackNamespaceFields(target, this.config.namespace)];
    const timeline = this.timelineState;
    const common = () => source !== null && this.timelineSource === source && this.timelineState !== null
      && sameNamespaceFields(source.namespace, oldTrack.namespace) && sameNamespaceFields(source.namespace, targetNs)
      && (source.wireFormat === 'msf-00' || source.wireFormat === 'msf-01')
      && this.timelineState.depends.includes(oldTrack.name) && this.timelineState.depends.includes(target.name);
    const selectionCurrent = () => (['video', 'audio'] as const).every(role => {
      const before = selection[role], now = this._selection[role];
      return before === null ? now === null : now !== null
        && identityKey(before.namespaceFields, before.name) === identityKey(now.namespaceFields, now.name);
    });
    const baseCurrent = () => !this._destroyed && !this.isTerminalState() && this.activeLocSeek === attempt && !attempt.retired
      && attempt.output === output && this.connection === connection && this.bootstrapGeneration === generation
      && this.subscriptionManager === manager && this.commandDispatcher === output.pipelines.commandDispatcher
      && this.syncController === sync && this.timelineSource === source;
    const observed = this.playbackPositionMs, frontier = attempt.playback.videoCutFrontier();
    if (!timeline || !common() || !baseCurrent() || observed === null || !frontier || frontier.owner !== oldOwner) {
      throw new Error('Playing frame rendition has no current common indexed frontier');
    }
    const plan = selectFrameQualityCut({ draftVersion: connection.draftVersion, trackName: target.name, timeline,
      afterContentMs: Math.max(observed, frontier.positionMs) });
    if (plan.kind !== 'candidate') throw new Error(`No declared future frame boundary: ${plan.reason}`);
    if (!baseCurrent() || !selectionCurrent() || attempt.playback.videoRoleOwner() !== oldOwner) throw new Error('Playing frame rendition was superseded');
    if (!automaticAllowed()) return;
    if (reason === 'manual') this.qualityController?.lockManual();
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const sw: NonNullable<MoqtPlayer['pendingVideoSwitch']> = {
      connection, generation, mediaSource: this.mediaSource, oldRequestId: null, oldTrackName: old.name,
      newTrackName: target.name, newRequestId: null, newTrackPackaging: mediaTrackPackaging(target.packaging),
      targetTrack: target, catalog: this._catalogState!, initData: undefined, cmafContext: undefined,
      phase: 'preparing', requestReleased: false, failure: undefined, stagedBytes: 0, stagedObjects: 0, stagedSamples: 0,
      done, settle, reason, ...(abrAction ? { abrAction } : {}),
    };
    let phase: 'preparing' | 'committing' | 'adopted' | 'retired' = 'preparing';
    let candidate: LocVideoRoleCandidate | null = null, retrieval: SeekRoleRetrieval | null = null;
    let issued = false, withdrawn = false, published = false, presented = false, suspended = false;
    let automaticWithdrawal: Error | undefined;
    const current = () => baseCurrent() && phase !== 'retired'
      && (phase === 'adopted' || this.state === PlayerState.PLAYING && this.playbackIntent === true && this.switchIsCurrent(sw));
    const promoted = () => candidate?.promoted === true;
    const causeOf = (error: unknown): Error => error instanceof Error ? error : new Error('Playing frame rendition failed', { cause: error });
    const failOwned = (cause: Error) => {
      if (!baseCurrent()) return;
      this.failCatalogPlayback(createPlayerError('fatal', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
        `Playing frame rendition failed after video adoption: ${cause.message}`, { cause }), () => this.retireLocSeek(attempt, cause));
    };
    const cancel = () => {
      if (phase === 'retired') return;
      // The actor publishes ownership before fallible factory/adoption callbacks.
      // A throwing commit may already have consumed the old video cut.
      if (promoted()) { failOwned(sw.failure ?? new Error('Playing frame rendition retired after adoption')); return; }
      phase = 'retired';
      const failures: unknown[] = [];
      if (retrieval) attempt.preparingRetrievals.delete(retrieval);
      for (const release of [() => retrieval?.cancel(), () => candidate?.cancel()]) {
        try { release(); } catch (error) { failures.push(error); }
      }
      this.refreshLocFrameResources(attempt); this.bindLocDiagnostics(this.mediaDiagnosticRuntime);
      if (failures.length) throw new AggregateError(failures, 'Playing frame rendition cancellation failed');
    };
    const releaseSlot = (status: 'committed' | 'retired' = 'committed') => {
      if (this.pendingVideoSwitch !== sw) return;
      sw.phase = status; sw.settle();
      if (this.switchStagingTimeout !== null) { clearTimeout(this.switchStagingTimeout); this.switchStagingTimeout = null; }
      this.pendingVideoSwitch = null; this.switchInProgress = false;
      this.videoSwitchSettled();
    };
    const suspendPublished = () => {
      if (!published || !promoted() || !baseCurrent() || this.pendingVideoSwitch !== sw) return;
      sw.failure = Object.assign(new Error('Video role was adopted but presentation was suspended by pause'), { name: 'AbortError' });
      // The accepted role stays adopted. Do not report rollback or cancel it.
      releaseSlot();
    };
    sw.frame = { attempt, cancel, cancelPending: () => {
      if (this.pendingVideoSwitch !== sw) return;
      if (promoted()) { suspended = true; suspendPublished(); return; }
      const cause = Object.assign(new Error('Playing frame rendition cancelled by pause'), { name: 'AbortError' });
      this.discardPendingVideoSwitch(sw, cause);
    } };
    const fail = (error: unknown) => {
      if (automaticWithdrawal !== undefined && error === automaticWithdrawal && this.switchIsCurrent(sw)) {
        withdrawn = true; this.discardPendingVideoSwitch(sw, automaticWithdrawal); return;
      }
      const cause = causeOf(error);
      if (phase === 'adopted' || promoted()) { failOwned(cause); return; }
      if (this.switchIsCurrent(sw)) this.abortPendingVideoSwitch(sw, cause);
    };
    const profile = ['packaging', 'codec', 'width', 'height', 'altGroup', 'renderGroup', 'locmafVersion', 'initData', 'initRef', 'initTrack'] as const;
    const validate = (): CatalogTrack => {
      const actual = this.catalogTrackFor(target.name, targetNs, 'video');
      const indexed = this.timelineState?.entries.some(entry => entry.mediaPts === plan.indexedPts
        && BigInt(entry.location[0]) === plan.location.groupId && BigInt(entry.location[1]) === plan.location.objectId);
      const nowMs = performance.now();
      if (!Number.isFinite(nowMs) || sw.deadlineMs === undefined || nowMs >= sw.deadlineMs
          || !current() || !common() || !indexed || !actual || profile.some(field => actual[field] !== target[field])
          || !this.qualityController?.eligibleLadder(this.activeVideoSet(old)).includes(actual)) {
        throw new Error('Playing frame rendition declaration or index changed');
      }
      const nowInit = target.packaging === 'locmaf' ? this.locSeekFrameInit(actual) : this.decodeResolvedInlineInitData(actual);
      if (sw.initData === undefined ? nowInit !== undefined : nowInit === undefined || !MoqtPlayer.sameBytes(sw.initData, nowInit)) {
        throw new Error('Playing frame rendition initialization changed');
      }
      if (!current()) throw new Error('Playing frame rendition validation retired');
      return actual;
    };
    const finish = () => {
      if (!published || !presented || phase !== 'adopted' || !baseCurrent() || !candidate?.current
          || attempt.playback.videoRoleOwner() !== candidate.owner || this.pendingVideoSwitch !== sw) return;
      releaseSlot();
      if (baseCurrent()) this.emitQualityEvent('quality_switched', { type: 'quality_switched',
        fromTrackName: old.name, toTrackName: target.name, reason });
    };
    const targetTrack: SeekRetrievalTrack = { role: 'video', name: target.name, namespace: targetNs };
    const onFirstRequest = () => {
      if (issued) return;
      if (!current()) throw new Error('Playing frame request retired before emission');
      if (!automaticAllowed()) {
        automaticWithdrawal = new Error('Automatic quality request withdrawn before emission');
        withdrawn = true;
        // Retire this page before SDK rollback terminal delivery can report a
        // secondary stream error through the prepared actor's receiver.
        try { this.discardPendingVideoSwitch(sw, automaticWithdrawal); }
        catch (error) {
          withdrawn = false; sw.failure = causeOf(error); releaseSlot('retired'); throw error;
        }
        throw automaticWithdrawal;
      }
      issued = true;
    };
    const commit = () => {
      if (!candidate?.ready || phase !== 'preparing') return;
      try {
        const actual = validate(), retained = candidate;
        if (!selectionCurrent() || attempt.playback.videoRoleOwner() !== oldOwner || !retained.current) throw new Error('Playing frame video cut owner changed');
        const configuration = retained.configuration, graph = retained.graph;
        if (!graph?.pipelines.videoPipeline || !configuration || configuration.dispatcher !== graph.pipelines.commandDispatcher
            || configuration.format.mediaType !== 'video' || configuration.format.codec !== target.codec
            || target.width !== undefined && configuration.format.width !== target.width
            || target.height !== undefined && configuration.format.height !== target.height) {
          throw new Error('Playing frame target configuration is not proved');
        }
        if (!current()) throw new Error('Playing frame rendition retired before adoption');
        phase = 'committing'; sw.phase = 'committing'; this.switchInProgress = true;
        retained.commit();
        if (!baseCurrent()) return;
        if (!promoted() || !retained.current && this.state !== PlayerState.PAUSED) throw new Error('Promoted frame video authority is unavailable');
        if (!retrieval) throw new Error('Promoted frame video retrieval is unavailable');
        const index = attempt.tracks.findIndex(track => track.role === 'video');
        if (index < 0) throw new Error('Playing frame video track map retired');
        // Publish only video. The original dispatcher/sync/audio graph stay owned.
        attempt.tracks.splice(index, 1, targetTrack);
        attempt.retrievals.set('video', retrieval); attempt.preparingRetrievals.delete(retrieval);
        attempt.preparingRetrievals.add(previous); attempt.videoOutput = graph;
        this.videoPipeline = graph.pipelines.videoPipeline;
        this.installedDecoderConfigurations.set('video', configuration);
        this.currentVideoCodec = target.codec ?? null;
        phase = 'adopted'; published = true;
        this.retireVideoMeasurement(); this.refreshLocFrameResources(attempt);
        try {
          // Match the paused-quality contract: controller/configuration follow
          // adopted output; public success still waits for the actual picture.
          this.commitVideoQuality(actual);
          if (!baseCurrent()) return;
          this.refreshMediaSelection({ video: { name: actual.name, namespaceFields: targetNs } });
        } finally {
          try { previous.cancel(); } finally { attempt.preparingRetrievals.delete(previous); }
        }
        if (!baseCurrent()) return;
        this.bindLocDiagnostics(this.mediaDiagnosticRuntime);
        if (suspended || this.state === PlayerState.PAUSED) suspendPublished();
        else finish();
      } catch (error) { fail(error); }
    };
    this.revokeVideoSwitchRecovery();
    this.pendingVideoSwitch = sw;
    this.armVideoSwitchTimeout(sw, this.config.connectionTimeoutMs || SWITCH_STAGING_TIMEOUT_MS, true);
    try {
      this.emitQualityEvent('quality_switching', { type: 'quality_switching', fromTrackName: old.name, toTrackName: target.name, reason });
      if (!current()) return;
      let init = target.packaging === 'locmaf' ? this.locSeekFrameInit(target) : this.decodeResolvedInlineInitData(target);
      if (target.packaging === 'locmaf' && !init && target.initTrack) {
        await this.awaitVideoSwitch(sw, this.ensureInitTrack(target.initTrack, targetNs));
        if (!current()) return;
        init = this.locSeekFrameInit(target);
      }
      sw.initData = init?.slice();
      if (this.hooks.beforeSubscribe.run({ trackName: target.name, namespace: targetNs, mediaType: 'video' }) === null) {
        withdrawn = true; this.discardPendingVideoSwitch(sw, new Error('Switch retrieval declined by beforeSubscribe'));
      } else if (current()) {
        if (!automaticAllowed()) {
          withdrawn = true; this.discardPendingVideoSwitch(sw, new Error('Automatic quality request withdrawn before emission'));
        } else {
          validate();
          const config = target.packaging === 'locmaf' && init ? codecDescriptionFromInit(init) : init;
          if (config === null) throw new Error('Target frame initialization has no video codec description');
          const track: LocVideoRoleTrack = { role: 'video', info: { packaging: target.packaging,
            ...(target.codec === undefined ? {} : { codec: target.codec }), ...(target.width === undefined ? {} : { width: target.width }),
            ...(target.height === undefined ? {} : { height: target.height }),
            ...(config === undefined ? {} : { initData: btoa(String.fromCharCode(...config)) }) },
            ...(target.packaging === 'locmaf' && init ? { frameInit: init } : {}) };
          candidate = attempt.playback.prepareVideoRole({ expectedOwner: oldOwner, track, location: plan.location,
            mediaPts: plan.indexedPts, cutMs: plan.indexedPts,
            getTimelineEntries: () => this.timelineSource === source ? this.timelineState?.entries ?? null : null,
            isCurrent: current, onReady: commit,
            onPresented: () => { presented = true; finish(); },
            onGraphCreated: () => { this.refreshLocFrameResources(attempt); this.bindLocDiagnostics(this.mediaDiagnosticRuntime); },
            onGraphRetiring: graph => { (this.retiringLocDiagnosticGraphs ??= new Set()).add(graph); },
            onGraphRetired: graph => { this.retiringLocDiagnosticGraphs?.delete(graph); this.refreshLocFrameResources(attempt); this.bindLocDiagnostics(this.mediaDiagnosticRuntime); },
            onCommand: command => {
              if (!current()) return;
              if (command.type === 'configure') this._stats.recordDecoderConfigured();
              if (command.type === 'decode_video') this._stats.recordFrameDecoded();
              this.emitter.emit('decoder_command', { type: 'decoder_command', command });
            },
            onConfiguration: configured => {
              if (phase === 'adopted' && current() && configured.dispatcher === this.videoCommandDispatcher()) this.installedDecoderConfigurations.set('video', configured);
            },
            onPageDrained: identity => retrieval?.onPageDrained(identity),
            onPageError: (identity, error) => { retrieval?.onPageError(identity, error); fail(error); }, onError: fail,
          });
          const retained = candidate;
          retrieval = new SeekRoleRetrieval({ connection, track: targetTrack, location: plan.location,
            timeoutMs: this.config.connectionTimeoutMs!, maxObjects: 512, maxBytes: 8 * 1024 * 1024,
            isCurrent: () => current() && (phase !== 'adopted' || retained.current),
            getTimeline: () => this.timelineSource === source ? this.timelineState : null,
            getPreparingGroup: () => retained.preparingGroup(), canProbeLive: () => phase === 'adopted', admitHead: () => current(),
            beforeSubscribe: () => this.hooks.beforeSubscribe.run({ trackName: target.name, namespace: targetNs, mediaType: 'video' }) !== null,
            beginPage: identity => retained.beginPage(identity), acceptPage: (identity, end, receipt) => retained.acceptPage(identity, end, receipt),
            beginLive: (owner, properties) => retained.beginLive(owner, properties),
            liveObservation: owner => this.seekLiveObservation(owner),
            capture: object => this.captureSeekObject(connection, object), discard: captured => this.discardSeekObject(captured, 'route retired'),
            consume: (object, captured, live, deliver) => this.consumeSeekObject(targetTrack, object, captured, live, deliver),
            onBridgeAdded: owner => { attempt.bridges.add(owner); }, onBridgeRemoved: owner => { attempt.bridges.delete(owner); },
            onEnded: () => retained.endInput(), onProgress() {}, onFailure: error => fail(error),
            onFirstRequest,
          });
          attempt.preparingRetrievals.add(retrieval);
          if (!current() || !retained.current) throw new Error('Playing frame preparation retired before retrieval');
          retrieval.pump();
          void retrieval.firstIssued.catch(fail);
        }
      }
    } catch (error) { fail(error); }
    await done;
    if (sw.failure && !withdrawn) throw sw.failure;
  }

  private async selectPausedLocVideoTrack(reference: string | TrackRefConfig, reason: string): Promise<void> {
    const previous = this.activeLocSeek, output = previous?.output, selection = this._selection;
    const connection = this.connection, dispatcher = this.videoCommandDispatcher(), source = this.timelineSource;
    if (this._destroyed || this.isTerminalState() || this.preparingLocSeek || !previous?.positioned || !output
        || previous.retired || this.currentMigration || this.mediaSelection || this.pendingVideoSwitch
        || this.switchInProgress || this.pendingRetypes.size) throw new Error('Cannot switch track: frame output is busy');
    if (this.state !== PlayerState.PAUSED || this.playbackIntent !== false) throw new Error('Frame quality requires paused video-only playback');
    if (!selection.video || selection.audio || previous.tracks.length !== 1 || previous.tracks[0]?.role !== 'video'
        || output.pipelines.audioPipeline) throw new Error('Frame quality requires video-only output');
    if (!connection || connection !== previous.connection || connection.draftVersion !== 18 && connection.draftVersion !== 22) {
      throw new Error('Frame quality requires the current draft 18 or 22 session');
    }
    const old = this.catalogTrackFor(selection.video.name, selection.video.namespaceFields, 'video');
    const owned = previous.tracks[0]!;
    if (!old || owned.name !== old.name || !sameNamespaceFields(owned.namespace, selection.video.namespaceFields)) {
      throw new Error('Owned frame video identity is unavailable');
    }
    const name = typeof reference === 'string' ? reference : reference.name;
    const ns = typeof reference === 'string' ? undefined : namespaceFields(reference.namespace ?? this.config.namespace);
    const matches = (track: CatalogTrack) => track.name === name
      && (ns === undefined || sameNamespaceFields(trackNamespaceFields(track, this.config.namespace), ns));
    const ladder = this.qualityController?.eligibleLadder(this.activeVideoSet(old)) ?? [];
    const candidates = ladder.filter(matches);
    if (candidates.length > 1) throw new Error(`Ambiguous video track: "${name}"`);
    const target = candidates[0];
    if (!target || old.altGroup === undefined || target.altGroup !== old.altGroup) throw new Error('Frame quality requires the same declared video alternate set');
    const seed = this.installedDecoderConfigurations.get('video');
    const fields = ['packaging', 'codec', 'width', 'height'] as const;
    if (!isTrackPackagingSupported(target) || target.packaging !== 'loc' && !(target.packaging === 'locmaf' && this.locmafFramePath)
        || fields.some(field => target[field] !== old[field]) || !seed || seed.dispatcher !== dispatcher
        || seed.format.mediaType !== 'video' || seed.format.codec !== old.codec
        || seed.format.width !== old.width || seed.format.height !== old.height) {
      throw new Error('Frame quality requires the same decoder configuration and output shape');
    }
    const timeMs = this.playbackPositionMs;
    if (timeMs === null || previous.playback.readPositionMs() !== timeMs) throw new Error('Paused frame position is unavailable');
    const context = this.getSeekContext();
    if ('error' in context) throw new Error(context.error);
    const location = findSeekTarget(context.timeline, timeMs);
    const entry = location && context.timeline.entries.find(item => item.location[0] === location.groupId && item.location[1] === location.objectId);
    if (!location || !entry) throw new Error('Owned frame index position is unavailable');
    const snapshot = structuredClone(target), init = this.locSeekFrameInit(snapshot)?.slice();
    const description = init && codecDescriptionFromInit(init);
    if (target.packaging === 'locmaf' && (!description || !MoqtPlayer.sameBytes(description, seed.requested))) {
      throw new Error('Frame quality target initialization differs from the decoder configuration');
    }
    const profileFields = ['packaging', 'codec', 'width', 'height', 'altGroup', 'renderGroup', 'locmafVersion', 'initData', 'initRef', 'initTrack'] as const;
    const validate = () => {
      if (this._destroyed || this.isTerminalState() || this.activeLocSeek !== previous || previous.retired
          || previous.output !== output || this.connection !== connection || this._selection !== selection
          || this.videoCommandDispatcher() !== dispatcher || this.videoPipeline !== output.pipelines.videoPipeline
          || this.frameOutputResources !== output.resources || this.installedDecoderConfigurations.get('video') !== seed
          || this.state !== PlayerState.PAUSED || this.playbackIntent !== false
          || this.currentMigration || this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.pendingRetypes.size) {
        throw new Error('Frame quality admission was superseded');
      }
      const timeline = this.timelineState;
      const declaring = source && this.catalogTrackFor(source.trackName, source.namespace);
      const targetNs = trackNamespaceFields(snapshot, this.config.namespace);
      if (!source || this.timelineSource !== source || source !== previous.timelineSource || context.source !== source
          || source.connection !== connection || !timeline || timeline.trackName !== source.trackName
          || !sameNamespaceFields(source.namespace, owned.namespace) || !sameNamespaceFields(source.namespace, targetNs)
          || !timeline.depends.includes(old.name) || !timeline.depends.includes(snapshot.name)
          || declaring?.packaging !== 'mediatimeline' || !declaring.depends?.includes(old.name) || !declaring.depends.includes(snapshot.name)
          || !timeline.entries.some(item => item.mediaPts === entry.mediaPts
            && item.location[0] === location.groupId && item.location[1] === location.objectId)) {
        throw new Error('Frame quality requires a common media timeline with a current owned index');
      }
      const current = this.catalogTrackFor(snapshot.name, targetNs, 'video');
      const currentInit = current && this.locSeekFrameInit(current);
      if (!current || profileFields.some(field => current[field] !== snapshot[field])
          || !this.qualityController?.eligibleLadder(this.activeVideoSet(old)).includes(current)
          || (init === undefined) !== (currentInit === undefined) || init && currentInit && !MoqtPlayer.sameBytes(init, currentInit)) {
        throw new Error('Frame quality target configuration changed during preparation');
      }
    };
    validate();
    if (this.initKey(old) === this.initKey(target)) return;
    const { quality, done } = createLocSeekQuality(old.name, snapshot.name, reason);
    quality.preparation = { previous, track: snapshot, validate };
    try { this.startLocSeek(timeMs, location, context, { admission: {}, reason: 'quality', quality }); }
    catch (error) {
      quality.settle(error instanceof Error ? error : new Error('Frame quality admission failed', { cause: error }));
      quality.preparation = null;
    }
    return done;
  }


  private locSeekFrameInit(track: CatalogTrack): Uint8Array | undefined {
    return track.packaging !== 'locmaf' ? undefined : this.locmafDecoderInit.get(this.initKey(track))
      ?? this.initSegmentByTrack.get(this.initKey(track)) ?? this.decodeResolvedInlineInitData(track)
      ?? (track.initTrack ? this.initSegmentByTrack.get(this.initKey(track, track.initTrack)) : undefined);
  }


  private async prepareHistoricalVideoSwitch(
    sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>, attempt: MseSeekAttempt,
  ): Promise<void> {
    const output = this.ownedSeekOutput, old = attempt.tracks.get('video'), previous = attempt.retrievals.get('video');
    const timelineSource = this.timelineSource, timeline = this.timelineState, target = sw.targetTrack;
    const namespace = trackNamespaceFields(target, this.config.namespace);
    const current = () => !this._destroyed && !this.isTerminalState() && !attempt.retired
      && this.activeMseSeek === attempt && this.ownedSeekOutput === output
      && this.connection === attempt.connection && this.mediaSource === attempt.source
      && this.cmafAssembler === output?.assembler && this.mseOutputEpoch === attempt.epoch;
    if (!output || !old || !previous || !current() || !this.switchIsCurrent(sw)
        || !this.usesMse(target.packaging) || !sw.initData || !target.codec
        || !attempt.source.holdQueuedAppends) throw new Error('Historical video output is not ready for rendition preparation');
    if (!timelineSource || !timeline || timelineSource.connection !== attempt.connection
        || !sameNamespaceFields(timelineSource.namespace, old.namespace)
        || !sameNamespaceFields(timelineSource.namespace, namespace)
        || !timeline.depends.includes(old.name) || !timeline.depends.includes(target.name)
        || (timelineSource.wireFormat !== 'msf-00' && timelineSource.wireFormat !== 'msf-01')) {
      throw new Error('Historical video renditions need a common media timeline');
    }
    const draft = attempt.connection.draftVersion;
    if (draft !== 14 && draft !== 16 && draft !== 18 && draft !== 22) throw new Error('Historical rendition addressing is unavailable');
    const assembler = output.assembler, resource = output.resource, oldOwner = attempt.playback.roleOwner('video');
    const reference = assembler.capturePresentationPlacement?.('video');
    const offset = resource.getTimestampOffset('video'), sample = resource.sample();
    if (!oldOwner || !reference || typeof offset !== 'number' || !Number.isFinite(offset) || !sample
        || sample.epoch !== attempt.epoch || sample.resource !== resource.resource || !resource.current
        || !current() || !this.switchIsCurrent(sw)) throw new Error('Historical video presentation is unavailable');
    const nativeAnchor = placePresentationAnchor(reference, 0n, 0n, offset, 0);
    if (!nativeAnchor || !current() || !this.switchIsCurrent(sw)) throw new Error('Historical video placement is unavailable');
    const rounding = timelineSource.wireFormat === 'msf-00' ? 'nearest' : 'floor';
    const submitted = attempt.playback.submissionFrontier('video', oldOwner);
    if (!submitted || submitted.highestSubmittedGroup === null || submitted.resource !== resource.resource
        || submitted.epoch !== attempt.epoch || submitted.sourceKey !== old.sourceKey
        || !current() || !this.switchIsCurrent(sw)) throw new Error('Historical video submission frontier is unavailable');
    const plan = selectSeekQualityCut({ draftVersion: draft, trackName: target.name, timeline,
      timestampRounding: rounding, placement: nativeAnchor,
      headSeconds: sample.currentTime, afterSubmittedGroup: submitted.highestSubmittedGroup });
    if (plan.kind !== 'candidate') throw new Error(`No safe indexed rendition boundary: ${plan.reason}`);
    const indexUs = BigInt(plan.indexedPts) * 1000n;
    const placement = placePresentationAnchor(reference, indexUs, indexUs, offset, offset);
    if (!placement || !current() || !this.switchIsCurrent(sw)) throw new Error('Historical video placement changed');
    const track: SeekTrack = { role: 'video', name: target.name, namespace: [...namespace],
      sourceKey: identityKey(namespace, target.name), codec: target.codec, init: sw.initData.slice(),
      packaging: target.packaging === 'locmaf' ? 'locmaf' : 'cmaf' };
    let phase: 'preparing' | 'committing' | 'adopted' | 'retired' = 'preparing';
    let candidate: SeekRoleCandidate | null = null, retrieval: SeekRoleRetrieval | null = null;
    let hold: SeekRoleCutHold | null = null;
    let queue: ReturnType<NonNullable<MediaSourceLike['holdQueuedAppends']>> | null = null;
    const admitted = () => current() && (phase === 'adopted'
      ? attempt.retrievals.get('video') === retrieval && attempt.tracks.get('video') === track
      : phase !== 'retired' && this.switchIsCurrent(sw) && sw.historical === owner);
    const failReplacement = (cause: Error) => this.failOwnedSeekOutput(attempt, output, createPlayerError(
      'fatal', 'decoder', PlayerErrorCode.VIDEO_DECODE_ERROR,
      'Historical video continuation requires a native reset', { cause },
    ));
    const failure = (error: unknown): Error => {
      if (error instanceof Error) return error;
      try { return new Error(String(error)); }
      catch { return new Error('Historical video operation failed'); }
    };
    const resumeHolds = () => {
      // A returned lease still needs disposition when cancellation happened
      // inside its acquisition. Clear ownership before invoking either adapter.
      const nativeQueue = queue, actorHold = hold; queue = null; hold = null;
      let cause: Error | null = null;
      try { nativeQueue?.resume(); } catch (error) { cause = failure(error); }
      try { actorHold?.resume(); } catch (error) { cause ??= failure(error); }
      if (cause && current()) this.failCatalogPlayback(createPlayerError('fatal', 'decoder',
        PlayerErrorCode.VIDEO_DECODE_ERROR, 'Historical video queue could not be resumed', { cause }));
    };
    const cancel = () => {
      if (phase === 'adopted' || phase === 'retired') return;
      phase = 'retired';
      if (retrieval) attempt.preparingRetrievals.delete(retrieval);
      try { retrieval?.cancel(); }
      finally {
        try { candidate?.cancel(); }
        finally { attempt.retiringRoles.delete('video'); resumeHolds(); }
      }
    };
    let preparationDeadlineMs = sw.deadlineMs;
    let coastDeadlineMs: number | null = null, coastEnd: number | null = null;
    let coastRate: number | null = null, suspendedCoastMs: number | null = null;
    const checkCoast = () => {
      if (!admitted() || phase !== 'preparing') return;
      let observed: MediaSeekSample | null;
      try { observed = resource.sample(); }
      catch (cause) {
        if (admitted()) this.abortPendingVideoSwitch(sw, new Error('Historical video coast observation failed', { cause }));
        return;
      }
      const nowMs = performance.now();
      const paused = observed?.paused, rate = observed?.playbackRate;
      if (!admitted()) return;
      let error: string | null = null;
      let deadlineMs = preparationDeadlineMs;
      if (!observed || observed.epoch !== attempt.epoch || observed.resource !== resource.resource
          || !Number.isFinite(observed.currentTime) || observed.currentTime < 0
          || !Number.isFinite(observed.buffered.start) || !Number.isFinite(observed.buffered.end)
          || observed.buffered.start > observed.currentTime || observed.buffered.end < observed.currentTime
          || !Number.isFinite(nowMs) || deadlineMs === undefined || !Number.isFinite(deadlineMs)) error = 'Historical video coast observation is unavailable';
      else if (typeof rate === 'number' && rate < 0) error = 'Historical video coast requires forward playback';
      // Expired capacity cannot be rescued by late coverage, a rate change,
      // or a newly observed pause. The hard deadline also keeps running.
      else if (deadlineMs! <= nowMs || coastDeadlineMs !== null && coastDeadlineMs <= nowMs) {
        deadlineMs = Math.min(deadlineMs!, coastDeadlineMs ?? deadlineMs!);
      } else if (paused !== true && rate !== 0 && (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0)) {
        error = 'Historical video coast rate is unavailable';
      } else {
        const observedMs = (observed.buffered.end - observed.currentTime) * 1000;
        const newTailMs = coastEnd === null ? 0 : Math.max(0, observed.buffered.end - coastEnd) * 1000;
        // This is preparation capacity, not a wall-projected native head.
        // Retain the reserve in media units so changing rate rescales only
        // unspent capacity and still leaves the same 100 ms wall reserve.
        const unspentMs = coastDeadlineMs !== null
          ? (coastDeadlineMs - nowMs + HISTORICAL_SWITCH_RESERVE_MS) * coastRate!
          : suspendedCoastMs ?? observedMs;
        const capacityMs = Math.min(observedMs, unspentMs + newTailMs);
        coastEnd = coastEnd === null ? observed.buffered.end : Math.max(coastEnd, observed.buffered.end);
        if (!Number.isFinite(capacityMs)) error = 'Historical video coast observation is unavailable';
        else if (paused === true || rate === 0) {
          suspendedCoastMs = capacityMs; coastDeadlineMs = null; coastRate = null;
        } else {
          const next = nowMs + capacityMs / rate! - HISTORICAL_SWITCH_RESERVE_MS;
          // Repeated unchanged observations may tighten, never renew, the
          // absolute deadline through floating-point recomputation.
          coastDeadlineMs = coastDeadlineMs !== null && coastRate === rate && newTailMs === 0
            ? Math.min(coastDeadlineMs, next) : next;
          coastRate = rate!; suspendedCoastMs = null;
          if (!Number.isFinite(coastDeadlineMs)) error = 'Historical video coast observation is unavailable';
          else deadlineMs = Math.min(deadlineMs!, coastDeadlineMs);
        }
      }
      if (!admitted()) return;
      if (error || deadlineMs! <= nowMs) {
        this.abortPendingVideoSwitch(sw, new Error(error ?? (preparationDeadlineMs! <= nowMs
          ? 'Historical video preparation deadline elapsed' : 'Historical video preparation exceeded its playable buffer coast'))); return;
      }
      const delay = Math.max(1, Math.floor(deadlineMs! - nowMs));
      this.armVideoSwitchTimeout(sw, delay, true);
    };
    const owner = { attempt, cancel, checkCoast };
    sw.historical = owner;
    checkCoast();
    if (!admitted()) throw sw.failure ?? new Error('Historical video coast preparation retired');
    const acquiredCut = attempt.playback.holdRole('video', oldOwner, { beforeGroup: plan.location.groupId, readCredit: 'bounded-preparation' });
    hold = acquiredCut;
    if (!acquiredCut.current || !admitted()) { resumeHolds(); throw sw.failure ?? new Error('Historical video cut is unavailable'); }
    candidate = attempt.playback.prepareRole({ track, location: plan.location, mediaPts: plan.indexedPts,
      timestampRounding: rounding, readiness: 'indexed-group', placement, isCurrent: admitted,
      onPageDrained: identity => retrieval?.onPageDrained(identity),
      onPageError: (identity, error) => retrieval?.onPageError(identity, error),
      onError: error => {
        if (!admitted()) return;
        if (phase === 'adopted' || attempt.playback.roleOwner('video') !== oldOwner) failReplacement(error);
        else this.abortPendingVideoSwitch(sw, error);
      },
    });
    retrieval = attempt.createRetrieval(track, plan.location, candidate, admitted, (error, _kind, stillAdmitted) => {
      if (!stillAdmitted() || !admitted()) return;
      // Actor publication is irreversible before the engine's adoption maps
      // catch up. A synchronous SDK terminal here must not promise rollback.
      const published = phase === 'adopted' || attempt.playback.roleOwner('video') !== oldOwner;
      if (!stillAdmitted() || !admitted()) return;
      if (!published) { this.abortPendingVideoSwitch(sw, error); return; }
      // A lawful cache refusal does not invalidate already accepted media.
      // The retained consumer owns knowledge of any parsed/native work lost.
      const retained = candidate, requiresReset = retained?.requiresReset ?? true;
      if (!stillAdmitted() || !admitted() || candidate !== retained) return;
      if (requiresReset) failReplacement(error);
      else this.emitError(createPlayerError('degraded', 'player', PlayerErrorCode.SEEK_FAILED,
        `Historical video retrieval stopped: ${error.message}`, { cause: error }));
    }, () => phase === 'preparing' ? plan.location.groupId : null);
    attempt.preparingRetrievals.add(retrieval);
    const retainedCandidate = candidate, retainedRetrieval = retrieval;
    const before = (a: FractionUs, b: FractionUs) => a.numerator * b.denominator < b.numerator * a.denominator;
    const equal = (a: FractionUs, b: FractionUs) => a.numerator * b.denominator === b.numerator * a.denominator;
    const validate = (): CatalogTrack => {
      if (!admitted() || !resource.current) throw new Error('Historical rendition preparation retired');
      const actual = resource.sample(), nativeOffset = resource.getTimestampOffset('video');
      const map = assembler.capturePresentationPlacement?.('video'), proof = retainedCandidate.groupProof;
      const frontier = acquiredCut.frontier, floor = frontier?.maxSubmittedEndUs;
      const head = actual ? nativeTimeUs(actual.currentTime) : null;
      const offsetUs = nativeTimeUs(nativeOffset), interval = proof?.coverage.length === 1 ? proof.coverage[0] : undefined;
      const indexed = this.timelineState?.entries.some(entry => entry.mediaPts === plan.indexedPts
        && BigInt(entry.location[0]) === plan.location.groupId && BigInt(entry.location[1]) === plan.location.objectId);
      const declared = this.catalogTrackFor(track.name, track.namespace, 'video');
      if (!admitted() || !actual || actual.epoch !== attempt.epoch || actual.resource !== resource.resource
          || actual.buffered.start > actual.currentTime || !head || !proof || !frontier || !floor || !interval || !offsetUs
          || frontier.owner !== oldOwner || frontier.sourceKey !== old.sourceKey
          || frontier.resource !== resource.resource || frontier.epoch !== attempt.epoch
          || proof.resource !== resource.resource || proof.epoch !== attempt.epoch
          || proof.location.groupId !== plan.location.groupId || proof.location.objectId !== plan.location.objectId
          || proof.source.name !== track.name || proof.source.sourceKey !== track.sourceKey
          || !sameNamespaceFields(proof.source.namespace, track.namespace)
          || proof.placement.sourceTimeUs !== placement.sourceTimeUs
          || !equal(proof.placement.rebasedTimeUs, placement.rebasedTimeUs) || !equal(proof.nativeOffsetUs, offsetUs)
          || !Object.is(nativeOffset, offset) || map?.token !== reference.token
          || this.timelineSource !== timelineSource || !indexed || !declared
          || declared.codec !== target.codec || mediaTrackPackaging(declared.packaging) !== sw.newTrackPackaging
          || !this.qualityController?.eligibleLadder(this.activeVideoSet()).includes(declared)
          || !equal(interval.startUs, floor) || !before(interval.startUs, interval.endUs)
          || before(proof.nativeSample.startUs, interval.startUs) || before(interval.endUs, proof.nativeSample.endUs)
          || !before(head, floor) || !nativeRangeMayReachBoundary(actual.buffered.end, floor)) throw new Error('Historical rendition no longer has a covered future group join');
      this.validateVideoSwitchInit(sw, declared);
      if (!admitted() || attempt.playback.roleOwner('video') !== oldOwner) throw new Error('Historical video owner changed');
      return declared;
    };
    const commit = async () => {
      const acquiredHold = acquiredCut;
      await this.awaitVideoSwitch(sw, Promise.all([retainedCandidate.ready, acquiredHold.nativeSettled]));
      if (!admitted()) return;
      checkCoast();
      if (!admitted()) return;
      validate();
      const acquiredQueue = attempt.source.holdQueuedAppends!(['video']); queue = acquiredQueue;
      if (!admitted()) { resumeHolds(); return; }
      if (!acquiredQueue.current || !acquiredHold.current || !admitted()) throw new Error('Historical video queue ownership changed');
      const declared = validate();
      phase = 'committing'; sw.phase = 'committing'; this.switchInProgress = true;
      attempt.retiringRoles.add('video');
      try { acquiredHold.commit(retainedCandidate); hold = null; }
      catch (error) { attempt.retiringRoles.delete('video'); throw error; }
      attempt.retrievals.set('video', retainedRetrieval); attempt.tracks.set('video', track);
      attempt.preparingRetrievals.delete(retainedRetrieval); attempt.ended.delete('video'); attempt.completion = null;
      this.mseCompletions?.delete('video'); phase = 'adopted'; attempt.retiringRoles.delete('video');
      previous.cancel();
      if (!admitted()) return;
      queue = null; acquiredQueue.discard();
      if (!admitted()) return;
      this.currentVideoCodec = track.codec;
      this.commitVideoSwitch(sw, { track: declared, identity: { name: track.name, namespaceFields: track.namespace } });
    };
    const retired = () => phase === 'retired';
    void commit().catch(error => {
      if (!current() || retired()) return;
      const cause = failure(error);
      if (!current() || retired()) return;
      if (phase === 'adopted' || attempt.playback.roleOwner('video') !== oldOwner) {
        failReplacement(cause);
      } else if (this.switchIsCurrent(sw)) this.abortPendingVideoSwitch(sw, cause);
    });
    retainedRetrieval.pump();
    await this.awaitVideoSwitch(sw, retainedRetrieval.firstIssued);
    if (this.switchIsCurrent(sw)) {
      sw.phase = 'staging';
      preparationDeadlineMs = Math.min(preparationDeadlineMs!, performance.now() + SWITCH_STAGING_TIMEOUT_MS);
      checkCoast();
    }
  }


  /** Shared availability policy; cached metadata alone does not admit a seek. */
  private getSeekContext() {
    const timeline = this.timelineState;
    if (!timeline || timeline.entries.length === 0) {
      return { error: 'Cannot seek: no media timeline loaded' };
    }
    const source = this.timelineSource;
    // Library safety policy: a replacement connection must revalidate the
    // cached timeline's declaring context before using it to move media.
    if (!source || source.connection !== this.connection || source.trackName !== timeline.trackName) {
      return { error: 'Cannot seek: media timeline declaring identity is unavailable' };
    }
    const initIds = new Set(this.initTrackRequestIds.values());
    const mediaSubscriptions = [...this.activeSubscriptions].filter(([id, sub]) =>
      (sub.mediaType === 'video' || sub.mediaType === 'audio') && !initIds.has(id));
    // MSF §7.2 depends names resolve within the declaring track's namespace.
    // Validate issued identities, including pending media requests; an
    // auxiliary init's placeholder media type does not make it seekable.
    const coverageError = (role: string, name: string, namespace: readonly string[] | undefined): string | null =>
      !timeline.depends.includes(name) || namespace === undefined || !sameNamespaceFields(source.namespace, namespace)
        ? `Cannot seek: ${role} track "${name}" is not covered by the media timeline` : null;
    // Adopted outputs survive finite subscription completion. Their coverage
    // requirement does not disappear when their request leaves the live map.
    for (const role of ['video', 'audio'] as const) {
      const selected = this._selection[role];
      const error = selected && coverageError(role, selected.name, selected.namespaceFields);
      if (error) return { error };
    }
    for (const [, sub] of mediaSubscriptions) {
      const error = coverageError(sub.mediaType, sub.trackName, sub.namespace);
      if (error) return { error };
    }
    return { timeline, mediaSubscriptions, source };
  }


  private seekRequestsFor(conn: MoqtConnection): SeekFetchRequests[] {
    const owners: SeekFetchRequests[] = [];
    for (const attempt of [this.preparingMseSeek, this.activeMseSeek]) {
      if (attempt?.connection === conn && !attempt.retired) {
        for (const owner of attempt.retrievals.values()) owners.push(owner.requests);
        for (const owner of attempt.preparingRetrievals) owners.push(owner.requests);
      }
    }
    for (const attempt of [this.preparingLocSeek, this.activeLocSeek]) {
      if (attempt?.connection === conn && !attempt.retired) {
        for (const owner of [...attempt.retrievals.values(), ...attempt.preparingRetrievals]) owners.push(owner.requests);
      }
    }
    return owners;
  }


  /** Native positioning must settle before another operation changes its selected outputs. */
  private seekIsPreparing(): boolean {
    return this.preparingMseSeek !== null || this.activeMseSeek !== null && !this.activeMseSeek.positioned
      || this.preparingLocSeek !== null || this.activeLocSeek !== null;
  }


  private seekBridgesFor(conn: MoqtConnection): SeekLiveBridge[] {
    const bridges: SeekLiveBridge[] = [];
    for (const attempt of [this.preparingMseSeek, this.activeMseSeek, this.preparingLocSeek, this.activeLocSeek]) {
      if (attempt?.connection !== conn || attempt.retired) continue;
      for (const owner of attempt.bridges) if (owner.bridge) bridges.push(owner.bridge);
    }
    return bridges;
  }


  private handleSeekBridgeControl(message: ControlMessage, conn: MoqtConnection): boolean {
    for (const attempt of [this.preparingMseSeek, this.activeMseSeek, this.preparingLocSeek, this.activeLocSeek]) {
      if (attempt?.connection !== conn || attempt.retired) continue;
      for (const owner of attempt.bridges) {
        if (!owner.bridge?.handleControl(message)) continue;
        // Ending intent precedes late delivery. Completion still belongs to
        // the SDK grace plus accepted application/native work barrier.
        if (message.type === 'PUBLISH_DONE' && message.statusCode === 2n
            && !attempt.retired && attempt.bridges.has(owner)) owner.ending = true;
        return true;
      }
    }
    return false;
  }


  private retireMseSeek(attempt: MseSeekAttempt | null): void {
    if (!attempt || attempt.retired) return;
    attempt.retired = true;
    if (this.preparingMseSeek === attempt) this.preparingMseSeek = null;
    if (this.activeMseSeek === attempt) this.activeMseSeek = null;
    const failures: unknown[] = [];
    const retire = (run: () => void) => { try { run(); } catch (error) { failures.push(error); } };
    for (const owner of [...attempt.retrievals.values(), ...attempt.preparingRetrievals]) retire(() => owner.cancel());
    // Retrieval owns its waits and requests. Adopted native output and its
    // assembler belong to the player, including after FETCH reaches FIN.
    retire(() => attempt.playback.cancel());
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'MSE seek retirement failed');
  }


  private failOwnedSeekOutput(attempt: MseSeekAttempt, output: MseSeekAdoption, error: PlayerError): void {
    if (attempt.retired || this.activeMseSeek !== attempt || this.ownedSeekOutput !== output
        || this.mseOutputEpoch !== attempt.epoch || this.connection !== attempt.connection
        || this.mediaSource !== attempt.source) return;
    this.failCatalogPlayback(error, () => {
      // Detach identities before native cancellation can call application code.
      const ownsOutput = this.ownedSeekOutput === output;
      const ownsAssembler = this.cmafAssembler === output.assembler;
      if (ownsOutput) { this.ownedSeekOutput = null; this.ownedSeekTransformAliases = null; }
      if (ownsAssembler) { this.cmafAssembler = null; this.cmafInitialized = false; }
      if (this.mseOutputEpoch === attempt.epoch) this.mseOutputEpoch = null;
      this.seekPosition?.retire(attempt.epoch);
      for (const [role, completion] of this.mseCompletions ?? []) {
        if (completion.outputEpoch === attempt.epoch) this.mseCompletions?.delete(role);
      }
      let failed = false, cause: unknown;
      const dispose = (run: () => void) => {
        try { run(); } catch (failure) { if (!failed) { failed = true; cause = failure; } }
      };
      dispose(() => this.retireMseSeek(attempt));
      if (ownsOutput) dispose(() => { if (output.resource.current) output.resource.cancel(); });
      if (ownsAssembler) dispose(() => output.assembler.destroy());
      if (failed) throw cause;
    });
  }


  /** The output clock outlives the retrieval that filled it. */
  private seekPositionReader(resource: MediaSeekResource): () => number | null {
    return () => {
      if (this._destroyed || this.isTerminalState() || this.ownedSeekOutput?.resource !== resource) return null;
      const sample = resource.current ? resource.sample() : null;
      const current = resource.current;
      return current && !this._destroyed && !this.isTerminalState() && this.ownedSeekOutput?.resource === resource && sample
        ? sample.currentTime * 1000 : null;
    };
  }


  private retireLocSeek(attempt: LocSeekAttempt | null, cause = new Error('LOC seek output retired')): void {
    if (!attempt || attempt.retired) return;
    attempt.retired = true;
    const prior = attempt.quality?.preparation?.previous;
    attempt.quality?.settle(cause);
    if (attempt.quality) attempt.quality.preparation = null;
    attempt.initialDispatcher = null;
    if (this.preparingLocSeek === attempt) this.preparingLocSeek = null;
    if (this.activeLocSeek === attempt) this.activeLocSeek = null;
    if (attempt.output && this.commandDispatcher === attempt.output.pipelines.commandDispatcher) {
      this.commandDispatcher = null; this.videoPipeline = null; this.audioPipeline = null;
      this.frameOutputResources = [];
    }
    const failures: unknown[] = [];
    // Finish native terminal observations before retrieval cancellation can
    // publish discarded queued inputs and reenter a replacement graph.
    try { attempt.playback.cancel(); } catch (error) { failures.push(error); }
    for (const owner of [...attempt.retrievals.values(), ...attempt.preparingRetrievals]) { try { owner.cancel(); } catch (error) { failures.push(error); } }
    if (prior && !attempt.output && !prior.retired && this.activeLocSeek === prior && !this._destroyed
        && this.connection === prior.connection && this.seekPosition?.owns(attempt.epoch)) {
      const position = prior.playback.readPositionMs();
      if (position !== null && this.activeLocSeek === prior && !prior.retired && this.seekPosition?.owns(attempt.epoch)) {
        this.seekPosition.begin(prior.epoch, position);
        this.seekPosition.activate(prior.epoch, () => prior.playback.readPositionMs());
      }
    }
    // Native cleanup owns outstanding terminal observations. Prune only after
    // it has had a chance to report them through the previous binding.
    this.bindLocDiagnostics(this.mediaDiagnosticRuntime);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'LOC seek retirement failed');
  }


  /** Resume flushed frame output through the same owned historical preparation as seek. */
  private resumeLocPlayback(timeMs: number): void {
    const connection = this.connection, selection = this._selection, dispatcher = this.commandDispatcher;
    const previous = this.locSeekAdmission, admission = {};
    const ownsFailure = () => !this._destroyed && this.connection === connection && this._selection === selection
      && this.commandDispatcher === dispatcher && (this.locSeekAdmission === previous || this.locSeekAdmission === admission)
      && !this.currentMigration && !this.mediaSelection && !this.pendingVideoSwitch && !this.switchInProgress;
    const ownsPausedFailure = () => ownsFailure() && this.state === PlayerState.PAUSED && this.playbackIntent === false;
    try {
      const context = this.getSeekContext();
      if ('error' in context) throw new Error(context.error);
      const target = findSeekTarget(context.timeline, timeMs);
      if (!target) throw new RangeError('Resume position precedes the available media timeline');
      const resume = this.activeLocSeek?.playback.resumePoint ?? undefined;
      this.startLocSeek(timeMs, target, context, { admission, reason: 'resume', ...(resume ? { resume } : {}) });
    } catch (error) {
      if (!ownsFailure() || this.state !== PlayerState.PLAYING || this.playbackIntent !== true) return;
      let cause = error instanceof Error ? error : new Error('LOC resume failed', { cause: error });
      try { this.pause(); } catch (cleanup) { cause = new AggregateError([error, cleanup], 'LOC resume and pause failed'); }
      if (ownsPausedFailure()) {
        this.emitError(createPlayerError('degraded', 'player', PlayerErrorCode.SEEK_FAILED,
          'LOC playback could not resume at its paused position', { cause }));
      }
    }
  }


  private startLocSeek(timeMs: number, target: { groupId: number; objectId: number },
    context: Extract<ReturnType<MoqtPlayer['getSeekContext']>, { timeline: TimelineState }>,
    continuation?: LocSeekOperation): void {
    const connection = this.connection!, selection = this._selection;
    let oldDispatcher = this.commandDispatcher;
    const quality = continuation?.reason === 'quality' ? continuation.quality : undefined;
    const resume = continuation?.reason === 'resume' ? continuation.resume : undefined;
    quality?.preparation?.validate();
    if (!this.config.createFrameOutput) throw new Error('Frame-mode seek requires createFrameOutput');
    const tracks: SeekRetrievalTrack[] = [], outputs: LocSeekTrack[] = [];
    for (const role of ['video', 'audio'] as const) {
      const selected = selection[role];
      if (!selected) continue;
      const track = quality && role === 'video' ? quality.preparation!.track
        : this.subscribedTrack(role) ?? this.catalogTrackFor(selected.name, selected.namespaceFields, role);
      if (!track || track.packaging !== 'loc' && !(track.packaging === 'locmaf' && this.locmafFramePath)) throw new Error('Cannot prepare this frame output combination');
      const seed = this.installedDecoderConfigurations.get(role);
      if (!seed || seed.dispatcher !== (role === 'video' ? this.videoCommandDispatcher() : oldDispatcher)
          || seed.format.mediaType !== role || !seed.format.codec) {
        throw new Error(`Cannot seek: installed ${role} decoder configuration is unavailable`);
      }
      tracks.push({ role, name: track.name, namespace: [...trackNamespaceFields(track, this.config.namespace)] });
      const frameInit = this.locSeekFrameInit(track);
      const source = frameInit === undefined ? {} : { frameInit };
      const format = seed.format;
      const values = { requested: seed.requested, configured: seed.configured, format };
      if (format.mediaType === 'video') outputs.push({ role: 'video', seed: values, ...source, info: { codec: format.codec, packaging: track.packaging,
        ...(format.width === undefined ? {} : { width: format.width }), ...(format.height === undefined ? {} : { height: format.height }) } });
      else outputs.push({ role: 'audio', seed: values, ...source, info: { codec: format.codec, packaging: track.packaging,
        ...(format.sampleRate === undefined ? {} : { samplerate: format.sampleRate }), ...(format.channels === undefined ? {} : { channels: format.channels }) } });
    }
    if (!tracks.length) throw new Error('LOC seek has no selected track');
    if (this.currentMigration || this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.pendingRetypes.size) {
      throw new Error('Cannot seek while another media change is preparing');
    }
    const wireFormat = context.source.wireFormat;
    if (wireFormat !== 'msf-00' && wireFormat !== 'msf-01') throw new Error('Cannot seek: media timeline representation is unavailable');
    const entry = context.timeline.entries.find(item => item.location[0] === target.groupId && item.location[1] === target.objectId);
    if (!entry) throw new Error('Cannot seek: indexed media timestamp is unavailable');
    const epoch = continuation?.admission ?? {};
    this.locSeekAdmission = epoch;
    const activeQuality = this.activeLocSeek?.quality;
    activeQuality?.settle(new Error('Frame quality superseded by a newer preparation'));
    if (activeQuality) activeQuality.preparation = null;
    for (const track of tracks) {
      quality?.preparation?.validate();
      if (this.hooks.beforeSubscribe.run({ trackName: track.name, namespace: track.namespace, mediaType: track.role }) === null) {
        throw new Error(`Seek ${track.role} retrieval declined by beforeSubscribe`);
      }
    }
    if (this._destroyed || this.connection !== connection || this.commandDispatcher !== oldDispatcher
        || this._selection !== selection || this.locSeekAdmission !== epoch
        || continuation?.reason === 'resume' && (this.state !== PlayerState.PLAYING || this.playbackIntent !== true)) {
      throw new Error('LOC seek admission was superseded');
    }
    quality?.preparation?.validate();
    // Public hooks may synchronously reserve a media change without replacing
    // any of the current session, selection, or output identities yet.
    if (this.currentMigration || this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.pendingRetypes.size) {
      throw new Error('Cannot seek while another media change is preparing');
    }
    const location = { groupId: BigInt(target.groupId), objectId: BigInt(target.objectId) };
    let attempt!: LocSeekAttempt;
    const live = () => !this._destroyed && !this.isTerminalState() && !attempt.retired && this.connection === connection
      && (!quality || attempt.positioned || quality.pending)
      && (this.preparingLocSeek === attempt || this.activeLocSeek === attempt);
    const failed = (error: Error) => {
      const current = live();
      quality?.settle(error);
      if (!current) return;
      const committed = attempt.output !== null;
      let cause = error;
      try { this.retireLocSeek(attempt, error); }
      catch (cleanup) { cause = new AggregateError([error, cleanup], 'LOC seek and retirement failed'); }
      this.seekPosition?.retire(epoch);
      const prior = this.activeLocSeek;
      if (!committed && prior && !prior.retired && this.seekPosition?.read() === null) {
        const position = prior.playback.readPositionMs();
        if (position !== null) {
          this.seekPosition.begin(prior.epoch, position);
          this.seekPosition.activate(prior.epoch, () => prior.playback.readPositionMs());
        }
      }
      if (!committed && prior?.playback.suspended && this.locSeekAdmission === epoch && this.connection === connection
          && this._selection === selection && !this._destroyed && this.state === PlayerState.PLAYING && this.playbackIntent === true) {
        try { this.pause(); } catch (cleanup) { cause = new AggregateError([cause, cleanup], 'LOC preparation and pause failed'); }
      }
      if (!committed && this.locSeekAdmission !== epoch) return;
      if (quality && !committed) {
        this.emitQualityEvent('quality_switch_failed', { type: 'quality_switch_failed', fromTrackName: quality.fromTrackName,
          toTrackName: quality.toTrackName, reason: quality.reason, error: cause });
        return;
      }
      const report = createPlayerError(committed ? 'fatal' : 'degraded', 'player', PlayerErrorCode.SEEK_FAILED,
        `LOC seek media preparation failed: ${cause.message}`, { cause });
      if (committed) this.failCatalogPlayback(report); else this.emitError(report);
    };
    const playback = new LocSeekPlayback({ config: this.config, wireProfile: locWireProfileForDraft(connection.draftVersion),
      clock: this.clock, borrowed: this.frameOutputResources,
      tracks: outputs,
      onGraphCreated: () => { if (live()) { this.refreshLocFrameResources(attempt); this.bindLocDiagnostics(this.mediaDiagnosticRuntime); } },
      onGraphRetiring: graph => {
        const dispatcher = graph.pipelines.commandDispatcher;
        if (dispatcher && this.locDiagnosticBindings?.dispatchers.includes(dispatcher)) {
          (this.retiringLocDiagnosticGraphs ??= new Set()).add(graph);
        }
      },
      onGraphRetired: graph => {
        this.retiringLocDiagnosticGraphs?.delete(graph);
        if (this.retiringLocDiagnosticGraphs?.size === 0) this.retiringLocDiagnosticGraphs = undefined;
        this.refreshLocFrameResources(attempt);
        this.bindLocDiagnostics(this.mediaDiagnosticRuntime);
      },
      getTimelineEntries: () => this.timelineSource === context.source ? this.timelineState?.entries ?? null : null,
      location, mediaPts: entry.mediaPts, targetMs: timeMs, timestampRounding: wireFormat === 'msf-00' ? 'nearest' : 'floor',
      ...(resume ? { resume } : {}),
      ...(quality ? { requiredPositionMs: timeMs } : {}),
      playing: this.playbackIntent === true, isCurrent: live,
      adopt: output => {
        if (quality) {
          if (!quality.preparation || !quality.pending) throw new Error('Frame quality preparation was retired');
          quality.preparation.validate();
          const actual = playback.installedConfiguration('video'), seed = outputs[0]!.seed;
          if (!actual || actual.format.mediaType !== 'video' || seed.format.mediaType !== 'video'
              || actual.format.codec !== seed.format.codec || actual.format.width !== seed.format.width || actual.format.height !== seed.format.height
              || !MoqtPlayer.sameBytes(actual.requested, seed.requested) || !MoqtPlayer.sameBytes(actual.configured, seed.configured)) {
            throw new Error('Frame quality target decoder configuration changed');
          }
        }
        const previous = this.activeLocSeek, oldVideo = this.videoPipeline, oldAudio = this.audioPipeline;
        const initialDispatcher = attempt.initialDispatcher; attempt.initialDispatcher = null;
        attempt.output = output; attempt.videoOutput = output; this.activeLocSeek = attempt;
        if (this.preparingLocSeek === attempt) this.preparingLocSeek = null;
        this.videoPipeline = output.pipelines.videoPipeline; this.audioPipeline = output.pipelines.audioPipeline;
        this.commandDispatcher = output.pipelines.commandDispatcher; this.syncController = output.pipelines.syncController;
        this.recoveryController = output.pipelines.recoveryController; this.frameOutputResources = output.resources;
        this.getRenderCushionUs = output.pipelines.getRenderCushionUs ?? null;
        this.videoTimingMapped = true;
        this.audioOutput = output.output.audioOutput ?? null;
        this.audioTimingMapped = outputs.some(item => item.role === 'audio');
        for (const role of ['video', 'audio'] as const) {
          const configured = playback.installedConfiguration(role);
          if (configured) this.installedDecoderConfigurations.set(role, configured);
        }
        try {
          if (quality) {
            const target = quality.preparation!.track;
            if (quality.reason === 'manual') this.qualityController?.lockManual();
            this.commitVideoQuality(target);
            if (!live()) return;
            this.refreshMediaSelection({ video: { name: target.name, namespaceFields: trackNamespaceFields(target, this.config.namespace) } });
          }
          if (!live()) return;
          this.subscriptionManager?.invalidateMediaInputs();
          for (const [id, issued] of context.mediaSubscriptions) {
            if (!live()) return;
            if (this.activeSubscriptions.get(id) !== issued) continue;
            this.retireMediaSubscription(id, connection); void connection.unsubscribe(varint(id)).catch(() => {});
          }
        } finally {
          // Publication may retire the new owner; the displaced graph is still ours to release.
          if (previous) this.retireLocSeek(previous);
          else {
            const failures: unknown[] = [];
            for (const release of [() => oldVideo?.reset(), () => oldAudio?.reset(), () => initialDispatcher?.destroy()]) {
              try { release(); } catch (error) { failures.push(error); }
            }
            if (failures.length) throw new AggregateError(failures, 'Previous frame output retirement failed');
          }
        }
        if (!live()) return;
        this.bindLocDiagnostics(this.mediaDiagnosticRuntime);
      },
      onPosition: (actualTimeMs, actualLocation) => {
        if (!live() || this.activeLocSeek !== attempt || !this.seekPosition?.owns(epoch)) return;
        if (!this.seekPosition.activate(epoch, () => playback.readPositionMs())) return;
        attempt.positioned = true;
        if (quality && quality.settle()) {
          quality.preparation = null;
          this.emitQualityEvent('quality_switched', { type: 'quality_switched',
            fromTrackName: quality.fromTrackName, toTrackName: quality.toTrackName, reason: quality.reason });
        }
        if (!continuation) this.emitter.emit('seeked', { type: 'seeked', actualTimeMs,
          groupId: Number(actualLocation.groupId), objectId: Number(actualLocation.objectId) });
      },
      onFirstFrame: () => { if (live()) this.handleFirstFrameRendered(); },
      onFrameRendered: () => { if (live()) this.handleFrameRendered(); },
      onConfiguration: (role, configured) => { if (live() && this.commandDispatcher === configured.dispatcher) this.installedDecoderConfigurations.set(role, configured); },
      onCommand: command => {
        if (!live()) return;
        if (command.type === 'configure') this._stats.recordDecoderConfigured();
        if (command.type === 'decode_video') this._stats.recordFrameDecoded();
        this.emitter.emit('decoder_command', { type: 'decoder_command', command });
      },
      onEvent: (role, event) => { if (live()) this.handlePipelineEvent(role, event); },
      onDiscard: (input, reason) => this.discardMediaInput(input, reason),
      onPageDrained: (role, identity) => attempt.retrievals.get(role)?.onPageDrained(identity),
      onPageError: (role, identity, error) => attempt.retrievals.get(role)?.onPageError(identity, error), onError: failed,
    });
    const retrievals = new Map<'video' | 'audio', SeekRoleRetrieval>();
    for (const track of tracks) {
      let firstPage = true;
      const alias = context.mediaSubscriptions.find(([, sub]) => sub.mediaType === track.role && sub.trackName === track.name
        && sub.namespace !== undefined && sameNamespaceFields(sub.namespace, track.namespace))?.[1].trackAlias;
      const retrieval = new SeekRoleRetrieval({ connection, track, location, timeoutMs: this.config.connectionTimeoutMs!,
      maxObjects: 512, maxBytes: 8 * 1024 * 1024, isCurrent: live,
      getTimeline: () => this.timelineSource === context.source ? this.timelineState : null,
      // A finite index's last entry is a start anchor, not its final Object.
      // Let the shared service take its initial published snapshot; subsequent
      // requests retain the consumer's complete-group preparation boundary.
      getPreparingGroup: () => firstPage && !context.timeline.isLive ? null : playback.preparingGroup(track.role),
      canProbeLive: () => attempt.output !== null, admitHead: () => this.timelineSource === context.source,
      beforeSubscribe: () => this.hooks.beforeSubscribe.run({ trackName: track.name, namespace: track.namespace, mediaType: track.role }) !== null,
      beginPage: identity => { const receiver = playback.beginPage(track.role, identity); firstPage = false; return receiver; }, acceptPage: (identity, end, receipt) => playback.acceptPage(track.role, identity, end, receipt),
      beginLive: (owner, properties) => playback.beginLive(track.role, owner, properties),
      ...(track.role === 'video' ? { liveObservation: (owner: SeekRoleBridgeOwner) => this.seekLiveObservation(owner) } : {}),
      capture: object => this.captureSeekObject(connection, object),
      discard: captured => this.discardSeekObject(captured, 'route retired'),
      consume: (object, captured, current, deliver) => this.consumeSeekObject(track, object, captured, current, deliver, alias ?? undefined),
      onBridgeAdded: owner => { attempt.bridges.add(owner); }, onBridgeRemoved: owner => { attempt.bridges.delete(owner); },
      onEnded: () => playback.endInput(track.role), onProgress() {},
      onFailure: (error, kind, current) => {
        if (!current()) return;
        if (kind !== 'live') { failed(error); return; }
        this.emitError(createPlayerError('degraded', 'player', PlayerErrorCode.SEEK_FAILED,
          `Live ${track.role} continuation unavailable: ${error.message}`, { cause: error }));
      },
    });
      retrievals.set(track.role, retrieval);
    }
    attempt = { epoch, reason: continuation?.reason ?? 'seek', ...(quality ? { quality } : {}), tracks, initialDispatcher: oldDispatcher,
      connection, timelineSource: context.source,
      playback, retrievals, preparingRetrievals: new Set(), bridges: new Set(), output: null, videoOutput: null, positioned: false, retired: false };
    oldDispatcher = null;
    this.retireLocSeek(this.preparingLocSeek); this.preparingLocSeek = attempt;
    (this.seekPosition ??= new PlaybackPosition(() => !this._destroyed
      && (this.state === PlayerState.PLAYING || this.state === PlayerState.PAUSED))).setPlaying(this.playbackIntent === true);
    this.seekPosition.begin(epoch, timeMs);
    try {
      if (!continuation) this.emitter.emit('seeking', { type: 'seeking', targetTimeMs: timeMs });
      if (quality) this.emitQualityEvent('quality_switching', { type: 'quality_switching', fromTrackName: quality.fromTrackName,
        toTrackName: quality.toTrackName, reason: quality.reason });
      if (live()) { playback.start(); for (const owner of retrievals.values()) if (live()) owner.pump(); }
    } catch (error) { this.retireLocSeek(attempt); this.seekPosition.retire(epoch); throw error; }
  }


  /** Historical delivery is observable but does not measure network capacity. */
  private recordSeekObject(mediaType: 'video' | 'audio', trackName: string, obj: MoqtObject): void {
    this._stats.recordFirstObjectReceived();
    if (obj.kind === 'data') this._stats.recordMediaObject(obj.payload.byteLength);
    else this._stats.recordGapObject();
    this.emitter.emit('media_object', {
      type: 'media_object', mediaType, trackName,
      groupId: BigInt(obj.groupId), objectId: BigInt(obj.objectId), kind: obj.kind,
      ...(obj.kind === 'data' ? { payload: obj.payload } : {}),
      ...(obj.kind === 'gap' ? { status: BigInt(obj.status ?? 0n) } : {}),
    });
  }

  private captureSeekObject(connection: MoqtConnection, object: MoqtObject | ObjectDatagram): {
    readonly input?: ObjectRoutingContext; readonly epoch: object | undefined;
    readonly cmaf?: { readonly owner: NonNullable<MoqtPlayer['videoDeliveryLag']>['owner']; readonly authority: object };
    readonly cadence?: { readonly object: CadenceObject;
      readonly owner: NonNullable<MoqtPlayer['videoPayloadMeasurement']>['owner']; readonly headers: LocHeaders };
  } | undefined {
    const receipt = connection.objectReceiptFor(object);
    const cadence = receipt ? this.seekCadenceInputs.get(receipt) : undefined;
    const cmaf = receipt ? this.seekCmafInputs.get(receipt) : undefined;
    if (receipt) { this.seekCadenceInputs.delete(receipt); this.seekCmafInputs.delete(receipt); }
    this.watchdog.fulfill('first_media_object');
    const runtime = this.mediaDiagnosticRuntime, diagnosticEpoch = this.mediaDiagnosticEpoch;
    const evidence = cadence || cmaf ? { ...(cadence ? { cadence } : {}), ...(cmaf ? { cmaf } : {}), epoch: diagnosticEpoch } : undefined;
    if (!runtime) return evidence;
    try {
      const input = runtime.capture(connection, object);
      if (input && typeof Reflect.get(input, 'then') === 'function') { void Promise.resolve(input).catch(() => {}); return evidence; }
      if (input && diagnosticEpoch === this.mediaDiagnosticEpoch) return { input, epoch: diagnosticEpoch, ...(cadence ? { cadence } : {}), ...(cmaf ? { cmaf } : {}) };
    } catch { /* Optional receipt evidence cannot affect media. */ }
    return evidence;
  }


  private discardSeekObject(captured: object | undefined, reason: ObjectRoutingDiscardReason): void {
    const token = captured as ReturnType<MoqtPlayer['captureSeekObject']>;
    if (token?.input && token.epoch === this.mediaDiagnosticEpoch) this.discardMediaInput(token.input, reason);
  }


  private async consumeSeekObject(track: { readonly role: 'video' | 'audio'; readonly name: string },
    object: MoqtObject, captured: object | undefined, current: () => boolean,
    deliver: (object: MoqtObject, input?: object) => Promise<void>, alias?: bigint): Promise<void> {
    const token = captured as ReturnType<MoqtPlayer['captureSeekObject']>;
    let input = token?.epoch === this.mediaDiagnosticEpoch ? token?.input : undefined;
    if (!current()) { this.discardSeekObject(captured, 'route retired'); return; }
    const cadence = token?.cadence;
    // Logical transform compatibility does not create a wire alias binding.
    const logical = alias === undefined ? object : { ...object, trackAlias: varint(alias) };
    let transformed: MoqtObject | null;
    try { transformed = this.config.objectTransform ? await this.config.objectTransform(logical) : logical; }
    catch (error) { this.discardSeekObject(captured, 'object processing failed'); throw error; }
    if (token?.epoch !== this.mediaDiagnosticEpoch) input = undefined;
    if (!current()) { this.discardSeekObject(captured, 'route retired'); return; }
    if (transformed === null) { this.discardSeekObject(captured, 'dropped by transform'); return; }
    // Native credit paces catch-up; its elapsed time is not network capacity.
    try { this.recordSeekObject(track.role, track.name, transformed); }
    catch (error) { this.discardSeekObject(captured, 'object processing failed'); throw error; }
    if (token?.epoch !== this.mediaDiagnosticEpoch) input = undefined;
    if (!current()) { this.discardSeekObject(captured, 'route retired'); return; }
    if (cadence) {
      this.recordLocGroupCadence(cadence.object, cadence.headers, cadence.owner);
      this.recordVideoDeliveryLag(cadence.object, cadence.headers, cadence.owner, cadence.object.payloadBytes ?? 0);
    }
    if (!current()) { this.discardSeekObject(captured, 'route retired'); return; }
    if (token?.cmaf) this.seekCmafObservations.set(transformed, token.cmaf);
    try { await deliver(transformed, input); }
    finally { this.seekCmafObservations.delete(transformed); }
  }

  private captureSeekCmafTiming(role: SeekRole, bridgeOwner: object, object: MoqtObject): SeekCmafTimingObservation | undefined {
    const captured = this.seekCmafObservations.get(object);
    this.seekCmafObservations.delete(object);
    if (role !== 'video' || object.kind !== 'data' || !captured || captured.owner.kind !== 'seek-live'
        || captured.owner.bridgeOwner !== bridgeOwner || !this.sameVideoMeasurementOwner(captured.owner, this.videoLagOwner())) return;
    return { authority: captured.authority, report: receipt => this.recordCmafDeliveryReceipt(captured.owner, receipt) };
  }


  private startMseSeek(timeMs: number, target: { groupId: number; objectId: number },
    context: Extract<ReturnType<MoqtPlayer['getSeekContext']>, { timeline: TimelineState }>): void {
    const connection = this.connection!, source = this.mediaSource!, oldAssembler = this.cmafAssembler!;
    const previousPreparation = this.preparingMseSeek, previousRetrieval = this.activeMseSeek;
    const previousOutput = this.ownedSeekOutput, previousAliases = this.ownedSeekTransformAliases;
    const selection = this._selection;
    if (!source.beginSeek || !this.config.createCmafAssembler) throw new Error('Cannot seek: media adapter lacks owned seek output');
    if (this.currentMigration || this.mediaSelection || this.pendingVideoSwitch || this.switchInProgress || this.pendingRetypes.size) {
      throw new Error('Cannot seek while another media change is preparing');
    }
    const wireFormat = context.source.wireFormat;
    if (wireFormat !== 'msf-00' && wireFormat !== 'msf-01') {
      throw new Error('Cannot seek: media timeline catalog representation is unavailable');
    }
    const entry = context.timeline.entries.find(item => item.location[0] === target.groupId && item.location[1] === target.objectId);
    if (!entry) throw new Error('Cannot seek: indexed media timestamp is unavailable');
    const tracks: SeekTrack[] = [];
    const aliases = new Map<'video' | 'audio', bigint>();
    for (const role of ['video', 'audio'] as const) {
      const selected = this._selection[role];
      const track = this.subscribedTrack(role) ?? (selected
        ? this.catalogTrackFor(selected.name, selected.namespaceFields, role) : undefined);
      if (!track) continue;
      const init = this.runningInitBytes(role);
      if (!this.usesMse(track.packaging) || !init || !track.codec) throw new Error(`Cannot seek: ${role} media initialization is unavailable`);
      const namespace = [...trackNamespaceFields(track, this.config.namespace)];
      if (this.hooks.beforeSubscribe.run({ trackName: track.name, mediaType: role, namespace }) === null) {
        throw new Error(`Seek ${role} retrieval declined by beforeSubscribe`);
      }
      if (this._destroyed || this.connection !== connection || this.mediaSource !== source || this.cmafAssembler !== oldAssembler) {
        throw new Error('Seek admission was superseded');
      }
      tracks.push({ role, name: track.name, namespace, sourceKey: identityKey(namespace, track.name),
        init: init.slice(), codec: track.codec, packaging: track.packaging === 'locmaf' ? 'locmaf' : 'cmaf' });
      const issued = context.mediaSubscriptions.find(([, sub]) => sub.mediaType === role
        && sub.trackName === track.name && sameNamespaceFields(sub.namespace ?? namespaceFields(this.config.namespace), namespace));
      if (issued?.[1].trackAlias !== null && issued?.[1].trackAlias !== undefined) aliases.set(role, issued[1].trackAlias);
      else if (previousOutput && previousAliases && previousAliases.source === source && previousAliases.output === previousOutput
          && previousOutput.assembler === oldAssembler
          && previousOutput.resource.epoch === this.mseOutputEpoch && previousOutput.resource.current
          && this.ownedSeekOutput === previousOutput && this.ownedSeekTransformAliases === previousAliases) {
        const alias = previousAliases.aliases.get(identityKey(namespace, track.name));
        if (alias !== undefined) aliases.set(role, alias);
      }
    }
    if (this._destroyed || this.connection !== connection || this.mediaSource !== source || this.cmafAssembler !== oldAssembler
        || this.preparingMseSeek !== previousPreparation || this.activeMseSeek !== previousRetrieval
        || this._selection !== selection || this.currentMigration || this.mediaSelection || this.pendingVideoSwitch
        || this.switchInProgress || this.pendingRetypes.size) throw new Error('Seek admission was superseded');
    const epoch = {}, location = { groupId: BigInt(target.groupId), objectId: BigInt(target.objectId) };
    let attempt!: MseSeekAttempt;
    let adopted: MseSeekAdoption | null = null;
    const live = (): boolean => !this._destroyed && !this.isTerminalState() && !attempt.retired && this.connection === connection
      && this.mediaSource === source && (this.preparingMseSeek === attempt || this.activeMseSeek === attempt);
    const failed = (error: Error): void => {
      if (!live()) return;
      const committed = attempt.committed;
      const report = createPlayerError(committed ? 'fatal' : 'degraded', 'player', PlayerErrorCode.SEEK_FAILED,
        `Seek media preparation failed: ${error.message}`, { cause: error });
      if (committed && adopted !== null && this.ownedSeekOutput === adopted && this.mseOutputEpoch === epoch
          && this.activeMseSeek === attempt) {
        this.failOwnedSeekOutput(attempt, adopted, report);
        return;
      }
      this.retireMseSeek(attempt);
      if (this.seekPosition?.owns(epoch)) {
        const position = this.seekPosition;
        position.retire(epoch);
        const prior = this.ownedSeekOutput?.resource;
        try {
          const sample = !committed && prior?.current ? prior.sample() : null;
          const current = prior?.current;
          // Native adapter access can admit another seek. Restore only into
          // the still-empty clock slot; never overwrite that successor.
          if (prior && sample && current && !this._destroyed && !this.isTerminalState() && this.ownedSeekOutput?.resource === prior
              && this.seekPosition === position && position.read() === null) {
            position.begin(prior.epoch, sample.currentTime * 1000);
            position.activate(prior.epoch, this.seekPositionReader(prior));
          }
        } catch { /* Unavailable fallback cannot suppress the failed attempt's report. */ }
      }
      if (committed) this.failCatalogPlayback(report); else this.emitError(report);
    };
    const draft = connection.draftVersion;
    if (draft !== 14 && draft !== 16 && draft !== 18 && draft !== 22) throw new Error('Cannot seek: historical page semantics are unavailable for this draft');
    const outputs = new Map<SeekRole, SeekRoleRetrieval>();
    const captureObject = (object: MoqtObject | ObjectDatagram) => this.captureSeekObject(connection, object);
    const discardCaptured = (captured: object | undefined, reason: ObjectRoutingDiscardReason) => this.discardSeekObject(captured, reason);
    const consumeObject = (track: SeekTrack, object: MoqtObject, captured: object | undefined,
      current: () => boolean, deliver: (object: MoqtObject, input?: object) => Promise<void>) =>
      this.consumeSeekObject(track, object, captured, current, deliver,
        tracks.some(selected => selected.sourceKey === track.sourceKey) ? aliases.get(track.role) : undefined);
    const createRetrieval: MseSeekAttempt['createRetrieval'] = (track, location, consumer, admitted, onFailure, getPreparingGroup) => {
      const role = track.role;
      const current = () => live() && admitted();
      const retrieval = new SeekRoleRetrieval({ connection, track, location,
        timeoutMs: this.config.connectionTimeoutMs!, maxObjects: 512, maxBytes: 8 * 1024 * 1024,
        isCurrent: current,
        getTimeline: () => {
          const timeline = this.timelineState;
          return this.timelineSource === context.source && timeline && timeline.trackName === context.source.trackName
            && timeline.depends.includes(track.name) && sameNamespaceFields(context.source.namespace, track.namespace) ? timeline : null;
        },
        canProbeLive: () => adopted !== null,
        admitHead: () => this.timelineSource === context.source,
        beforeSubscribe: () => this.hooks.beforeSubscribe.run({ trackName: track.name, mediaType: role, namespace: track.namespace }) !== null,
        beginPage: identity => consumer.beginPage(identity),
        acceptPage: (identity, endOfTrack, receipt) => receipt
          ? consumer.acceptPage(identity, endOfTrack, receipt) : consumer.acceptPage(identity, endOfTrack),
        ...(getPreparingGroup ? { getPreparingGroup } : {}),
        beginLive: owner => consumer.beginLive(owner),
        ...(role === 'video' ? { liveObservation: (owner: SeekRoleBridgeOwner) => this.seekLiveObservation(owner) } : {}),
        capture: captureObject, discard: captured => discardCaptured(captured, 'route retired'),
        consume: (object, captured, admitted, deliver) => consumeObject(track, object, captured, admitted, deliver),
        onBridgeAdded: owner => { attempt.bridges.add(owner); },
        onBridgeRemoved: owner => { attempt.bridges.delete(owner); },
        onEnded: () => { if (current() && outputs.get(role) === retrieval) attempt.ended.add(role); },
        onProgress: () => { if (current() && outputs.get(role) === retrieval) this.finishMseSeekInput(attempt); },
        onFailure,
      });
      return retrieval;
    };
    for (const track of tracks) {
      const role = track.role;
      const retrieval = createRetrieval(track, location, {
        beginPage: identity => playback.beginPage(role, identity),
        acceptPage: (identity, endOfTrack) => playback.acceptPage(role, identity, endOfTrack),
        beginLive: owner => playback.beginLive(role, owner),
      }, () => outputs.get(role) === retrieval && !attempt.retiringRoles.has(role), (error, kind, admitted) => {
        if (!admitted()) return;
        if (kind === 'page') {
          // Already accepted native output survives a later cache refusal,
          // including while its asynchronous position witness is pending.
          const accepted = adopted;
          const owned = accepted !== null && accepted === this.ownedSeekOutput && accepted.resource.current;
          if (!admitted()) return;
          if (!owned || accepted !== this.ownedSeekOutput) { failed(error); return; }
        } else if (kind === 'planning' && !attempt.positioned) { failed(error); return; }
        this.emitError(createPlayerError('degraded', 'player', PlayerErrorCode.SEEK_FAILED,
          kind === 'live' ? `Live ${role} continuation unavailable: ${error.message}`
            : `Historical ${role} retrieval stopped: ${error.message}`, { cause: error }));
      });
      outputs.set(role, retrieval);
    }
    const pump = (): void => {
      for (const output of outputs.values()) {
        if (!live()) break;
        output.pump();
      }
    };
    const sink = this.cmafOutputCallbacks(source, () => adopted !== null && adopted === this.ownedSeekOutput
      && adopted.resource.current && this.cmafAssembler === adopted.assembler, false);
    const playback = new MseSeekPlayback({ epoch, source, liveAssembler: oldAssembler,
      captureLiveTiming: (role, owner, object) => this.captureSeekCmafTiming(role, owner, object),
      createAssembler: this.config.createCmafAssembler, tracks, location, mediaPts: entry.mediaPts,
      timestampRounding: wireFormat === 'msf-00' ? 'nearest' : 'floor', targetMs: timeMs,
      maxObjects: 512, maxBytes: 8 * 1024 * 1024, preparationTimeoutMs: this.config.connectionTimeoutMs!,
      playing: this.playbackIntent === true, isCurrent: live,
      observeAppend: inputs => this.observeCmafAppend(source, inputs),
      onSubmitted: role => { if (live()) this.renewCmafFirstFrameDeadline(role); },
      beforeResourceChange: () => {
        if (!live()) return;
        attempt.committed = true;
        this.mseOutputEpoch = epoch;
        this.mseCompletions = null;
        this.retireMseSeek(this.activeMseSeek);
        this.subscriptionManager?.invalidateMediaInputs();
        for (const [id, issued] of context.mediaSubscriptions) {
          if (this.activeSubscriptions.get(id) !== issued) continue;
          this.retireMediaSubscription(id, connection);
          void connection.unsubscribe(varint(id)).catch(() => {});
        }
        source.cancelStallEpisode?.();
        // The seek now replaces the output; a refused or still-preparing seek leaves playback, and this, as they were.
        this.revokeVideoSwitchRecovery();
      },
      adopt: owned => {
        // Transfer first: cleanup, observers and injected adapters may reenter.
        adopted = owned;
        const previous = this.cmafAssembler;
        this.ownedSeekOutput = owned; this.cmafAssembler = owned.assembler;
        this.ownedSeekTransformAliases = { source, output: owned, aliases: new Map(tracks.flatMap(track => {
          const alias = aliases.get(track.role);
          return alias === undefined ? [] : [[track.sourceKey, alias] as const];
        })) };
        this.keyedCmafIdentity = true; this.cmafVideoSynced = true;
        this.activeMseSeek = attempt;
        if (this.preparingMseSeek === attempt) this.preparingMseSeek = null;
        previous?.destroy();
      },
      ...sink,
      onPosition: sample => {
        if (!live() || this.ownedSeekOutput !== adopted || !this.seekPosition?.owns(epoch)) return;
        const resource = adopted!.resource;
        if (!this.seekPosition.activate(epoch, this.seekPositionReader(resource))) return;
        if (!live()) return;
        attempt.positioned = true;
        this.emitter.emit('seeked', { type: 'seeked', actualTimeMs: sample.currentTime * 1000, ...target });
        this.finishMseSeekInput(attempt);
      },
      onPageDrained: (role, identity) => { outputs.get(role)?.onPageDrained(identity); },
      onPageError: (role, identity, error) => { outputs.get(role)?.onPageError(identity, error); },
      onError: failed,
    });
    const videoSelection = this.mseSelection('video');
    attempt = { epoch, connection, source, playback, retrievals: outputs, tracks: new Map(tracks.map(track => [track.role, track])),
      preparingRetrievals: new Set(), retiringRoles: new Set(),
      createRetrieval, bridges: new Set(), roles: tracks.map(track => track.role),
      videoSelection: videoSelection?.key === tracks.find(track => track.role === 'video')?.sourceKey ? videoSelection : null,
      ended: new Set(), pump, completion: null, committed: false, positioned: false, retired: false };
    this.retireMseSeek(this.preparingMseSeek);
    this.preparingMseSeek = attempt;
    (this.seekPosition ??= new PlaybackPosition(() => {
      const state = this.stateMachine.state;
      return !this._destroyed && (state === PlayerState.PLAYING || state === PlayerState.PAUSED);
    })).setPlaying(this.playbackIntent === true);
    this.seekPosition.begin(epoch, timeMs);
    try {
      this.emitter.emit('seeking', { type: 'seeking', targetTimeMs: timeMs });
      if (live()) { playback.start(); pump(); } else this.retireMseSeek(attempt);
    } catch (error) { this.retireMseSeek(attempt); this.seekPosition.retire(epoch); throw error; }
  }


  private finishMseSeekInput(attempt: MseSeekAttempt): void {
    if (attempt.retired || attempt.completion !== null || !attempt.positioned || !attempt.roles.every(role => attempt.ended.has(role))) return;
    // Only accepted End Of Track plus drained media completes an output.
    const completed = attempt.roles;
    const completion = {};
    attempt.completion = completion;
    // Finish outside a native-position callback: its owner must first finish
    // applying the current playback intent to the adopted resource.
    queueMicrotask(() => {
      if (attempt.retired || this.activeMseSeek !== attempt || attempt.completion !== completion) return;
      for (const retrieval of attempt.retrievals.values()) retrieval.cancel();
      for (const mediaType of completed) {
        if (this._destroyed || this.mseOutputEpoch !== attempt.epoch) break;
        const selection = this.mseSelection(mediaType);
        if (selection) (this.mseCompletions ??= new Map()).set(mediaType, {
          conn: attempt.connection, source: attempt.source, outputEpoch: attempt.epoch, ...selection, emitted: false,
        });
      }
      this.reconsiderMseTrackEnds();
    });
  }


  private commitVideoQuality(newTrack: CatalogTrack | undefined): void {
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
        ...(this.config.audioLanguages !== undefined ? { audioLanguages: this.config.audioLanguages } : {}),
        intent: { videoTrack: { name: newTrack.name,
          namespaceFields: trackNamespaceFields(newTrack, this.config.namespace) }, disableAudio: true },
      });
      if (wasAuto) this.qualityController.unlockAuto();
      this.qualityController.commitVideoTrackRef(newTrack);
    }
    this.syncBufferAbrController();
  }


  /** Renderer lifecycle for both initial and adopted frame output. */
  private handleFirstFrameRendered(): void {
    this._stats.recordFirstFrameRendered();
    this.fulfillCmafBootstrapDeadline('cmaf_first_frame');
    this.log.info('First frame rendered');
    this.emitter.emitReported('first_frame', { type: 'first_frame' });
  }


  private handleFrameRendered(): void {
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
  }


  private observeCmafAppend(source: MediaSourceLike, inputs: readonly (object | undefined)[] | undefined): CmafAppendObservation | undefined {
    const runtime = this.mediaDiagnosticRuntime;
    if (!runtime || !inputs) return;
    const epoch = this.mediaDiagnosticEpoch;
    let unit: object | undefined;
    try { unit = runtime.reconstruct(inputs); } catch { /* Optional evidence cannot fail media. */ }
    if (!unit) return;
    const identity = unit;
    const discard: CmafAppendObservation['discard'] = reason => {
      try { runtime.discardUnit(identity, reason); } catch { /* Optional evidence. */ }
    };
    if (runtime !== this.mediaDiagnosticRuntime || epoch !== this.mediaDiagnosticEpoch) { discard('decoder reset'); return; }
    let token: object | undefined;
    try { token = runtime.appendToken(identity, source); }
    catch { discard('append error'); return; }
    if (runtime !== this.mediaDiagnosticRuntime || epoch !== this.mediaDiagnosticEpoch) { discard('decoder reset'); return; }
    return { token, discard };
  }


  /** Create the moof+mdat assembler wired to the MediaSource (single site). */
  private cmafOutputCallbacks(ms: MediaSourceLike, isCurrent: () => boolean, resetOffsets = true):
      NonNullable<MoqtPlayerConfig['createCmafAssembler']> extends (options: infer O) => CmafAssemblerLike ? O : never {
    const timestampOffsetSet = { video: false, audio: false };
    return {
      onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, segTrackName: string, groupId: bigint, inputs?: readonly (object | undefined)[], sourceKey?: string) => {
        if (this._destroyed || this.mediaSource !== ms || !isCurrent()) return;
        const observation = this.observeCmafAppend(ms, inputs);
        if (this._destroyed || this.mediaSource !== ms || !isCurrent()) { observation?.discard('decoder reset'); return; }
        if (resetOffsets && !timestampOffsetSet[mediaType]) {
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
          observation?.discard('retype');
          return;
        }
        const token = observation?.token;
        if (this._destroyed || this.mediaSource !== ms || !isCurrent()) { observation?.discard('decoder reset'); return; }
        try {
          if (this.keyedCmafIdentity && sourceKey === undefined) throw new Error('CMAF assembler omitted the source identity');
          if (sourceKey !== undefined) ms.appendChunk(mediaType, segment, segTrackName, groupId, token, sourceKey);
          else if (token === undefined) ms.appendChunk(mediaType, segment, segTrackName, groupId);
          else ms.appendChunk(mediaType, segment, segTrackName, groupId, token);
        } catch (error) {
          observation?.discard('append error');
          throw error;
        }
        this.renewCmafFirstFrameDeadline(mediaType);
      },
      onDiscard: (input, reason) => this.discardMediaInput(input, reason),
      onDiscontinuity: (mediaType, trackName, sourceKey) => {
        if (this._destroyed || this.mediaSource !== ms || !isCurrent()) return;
        this.audioTimelineRecord = null;
        if (sourceKey === undefined) ms.clearTimeline?.(mediaType, trackName);
        else ms.clearTimeline?.(mediaType, trackName, sourceKey);
      },
    };
  }




}
