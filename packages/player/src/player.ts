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

import type { ControlMessage, Parameters, DraftVersion } from '@moqt/transport';
import { varint, PublishDoneCode, PublishDoneCode18 } from '@moqt/transport';
import { CatalogBootstrap } from './catalog-bootstrap.js';
import type { CatalogObjectEvent, PublishDoneReason } from './catalog-bootstrap.js';
import { MoqtConnectionError } from '@moqt/webtransport';
import type { DataStreamTerminal, MoqtConnection, WebTransportLike, MoqtConnectionErrorSource } from '@moqt/webtransport';
import type { MoqtObject, ObjectDatagram, SubgroupHeader } from '@moqt/transport';
import { getSubgroupIdMode, SubgroupIdMode } from '@moqt/transport';
import { PlaybackPipeline, SyncController, BandwidthEstimator } from '@moqt/playback';
import { BufferBasedController } from '@moqt/playback';
import type { AbrTrack } from '@moqt/playback';
import type { ClockSource, DecoderCommand, PlaybackEvent, RecoveryAction, RecoveryController, DecoderFeedback } from '@moqt/playback';
import type { CatalogState, CatalogTrack } from '@moqt/msf';
import type { LocHeaders } from '@moqt/loc';
import { parseSapTimeline, parseEventTimeline, CMSF_SAP_EVENT_TYPE } from '@moqt/msf';

import { TypedEmitter } from './emitter.js';
import { HookChain } from './hooks.js';
import { WatchdogController } from './watchdog.js';
import { MediaLivenessMonitor, type LivenessTrack } from './media-liveness.js';
import { PlayerStateMachine, PlayerState, type PlayerStateValue } from './state.js';
import type { PlayerEventMap } from './events.js';
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
import { SubscriptionManager, type TrackPackaging } from './subscription-manager.js';
import type { MediaSourceLike } from './interfaces.js';
import { CommandDispatcher } from './command-dispatcher.js';
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

// ─── Constants ──────────────────────────────────────────────────────

/** Max objects to stage during make-before-break switch before force-completing. */
const SWITCH_STAGING_MAX_OBJECTS = 100;

/** Max time (ms) to wait for a keyframe during make-before-break switch. */
const SWITCH_STAGING_TIMEOUT_MS = 3_000;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Catalog track name per MSF §5.1.10. */
function catalogTrackName(): string {
  return 'catalog';
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
  const fields = typeof ns === 'string' ? ns.split('/') : Array.from(ns);
  return fields.map(segment => enc.encode(segment));
}

/** Display form of a config namespace, joining tuple fields with `/`. */
function namespaceDisplay(ns: string | readonly string[]): string {
  return typeof ns === 'string' ? ns : ns.join('/');
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

/** Intent to subscribe to a track — passed through beforeSubscribe hook. */
export interface SubscribeIntent {
  readonly trackName: string;
  readonly mediaType: 'video' | 'audio';
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
  /** Staged events, each tagged with the live-delivery error source used to
   *  classify a replay failure the same way live delivery would. */
  readonly events: Array<{ readonly run: () => void; readonly source: MoqtConnectionErrorSource }>;
  retainedBytes: number;
  /** Candidate reached a terminal state (closed/errored) or overflowed staging. */
  aborted: boolean;
  /** Candidate has been promoted — staging is closed; further events run live. */
  committed: boolean;
  /** The committed session closed/fatally-errored DURING drain — stop replaying
   *  its events and do not report a successful migration. */
  terminated: boolean;
  /** The candidate catalog subscription's terminal drain completed BEFORE
   *  commit: replayed after the staged events flush (never lost). */
  catalogDrainPending?: boolean;
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
  static readonly version = '0.5.7';

  private readonly config: MoqtPlayerConfig;
  private readonly emitter = new TypedEmitter<PlayerEventMap>();
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
  private catalogManager: CatalogManager | null = null;
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

  /** Assembles moof+mdat pairs, patches tfdt, emits complete segments. */
  private cmafAssembler: CmafAssemblerLike | null = null;

  /**
   * Init segment bytes received from each subscribed init track, keyed
   * by init track name. Populated as `onInitObject` fires; consulted on
   * track switch when the new track's codec differs from the SourceBuffer's
   * current codec, so we can call `mediaSource.changeType()` immediately
   * instead of re-subscribing.
   */
  private readonly initSegmentByTrack = new Map<string, Uint8Array>();

  /**
   * Pending lazy init-track subscriptions, keyed by init track name.
   * Resolved when the first init object for that track arrives.
   * Used by `selectVideoTrack` to await init bytes before initiating a
   * codec-changing switch.
   */
  private readonly pendingInitTrackSubs = new Map<
    string,
    { promise: Promise<Uint8Array>; resolve: (data: Uint8Array) => void; reject: (err: Error) => void }
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

  private readonly pendingObjectsByAlias = new Map<bigint, { streamId: bigint; obj: MoqtObject; sourceDraft: DraftVersion | undefined; sourceConnection: MoqtConnection; owners?: bigint[] }[]>();
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

  /**
   * Request ID returned by the catalog SUBSCRIBE.
   * Used to match SUBSCRIBE_OK and identify catalog subscription.
   * @see draft-ietf-moq-msf-00 §5.1.10 (catalog track)
   */
  private catalogRequestId: bigint | null = null;

  /**
   * Catalog bootstrap (MSF-01 §5 SUBSCRIBE + Joining FETCH) — one coordinator
   * per bootstrap generation; null in legacy 'subscribe' mode or with an
   * injected catalog. All async continuations capture {generation, conn} and
   * are inert on mismatch.
   */
  private catalogBootstrapCoord: CatalogBootstrap | null = null;
  private bootstrapGeneration = 0;
  /** The coordinator's CURRENT fetch: connection-scoped ownership. */
  private bootstrapFetch: { conn: MoqtConnection; reqId: bigint; attempt: number; gen: number } | null = null;
  /** Fetch data streams belonging to the bootstrap — CONNECTION-SCOPED: an
   *  old session's stream 0 must never be read as the new session's stream 0
   *  during migration. */
  private readonly bootstrapFetchStreams = new Map<bigint, { attempt: number; conn: MoqtConnection }>();
  /** Live data streams observed carrying catalog objects (clean-FIN tracking),
   *  connection-scoped and tagged with the OWNING coordinator (main vs a
   *  staged-recovery candidate) so lifecycle events reach the right one. */
  private readonly catalogLiveStreams = new Map<bigint, { conn: MoqtConnection; coord: CatalogBootstrap }>();
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

  /**
   * Staged recovery after a post-ready retriable PUBLISH_DONE: a CANDIDATE
   * coordinator + manager re-acquire the catalog on a fresh subscription while
   * the ACTIVE catalog stays ready and untouched. Adopted atomically at
   * candidate readiness; discarded wholesale on failure; one attempt per
   * bootstrap generation (no recursion). Ownership is transaction-local: the
   * active `catalogRequestId`/`catalogTrackAlias` are not touched pre-adoption.
   */
  private catalogRecovery: {
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
  } | null = null;
  /** Fail-closed recovery-parking bounds (objects / bytes / lifecycle). */
  private static readonly MAX_RECOVERY_PARKED_OBJECTS = 256;
  private static readonly MAX_RECOVERY_PARKED_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_RECOVERY_PARKED_EVENTS = 64;
  private static readonly MAX_RECOVERY_PARKED_ALIASES = 64;
  private recoveryAttempted = false;

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

  /**
   * Server-assigned Track Alias for the catalog subscription.
   * Set when SUBSCRIBE_OK arrives for the catalog request ID.
   * Data objects carry trackAlias (not requestId), so this is
   * what we match against in onObject routing.
   * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK assigns Track Alias)
   */
  private catalogTrackAlias: bigint | null = null;

  /** Whether the first catalog object has been received. */
  private catalogReceived = false;

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
    oldRequestId: bigint;
    oldTrackName: string;
    newTrackName: string;
    newTrackAlias: bigint;
    newTrackPackaging: TrackPackaging;
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
  private switchStagingBuffer: Array<{ obj: MoqtObject; headers: LocHeaders | undefined }> = [];

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
  private readonly activeSubscriptions = new Map<
    bigint,
    { trackName: string; mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline'; trackAlias: bigint }
  >();

  /**
   * Media-liveness: per-track starvation detection + restart ladder.
   * The gap detector handles gaps BETWEEN arrivals; this handles NO
   * arrivals (transport stream death, relay restart). null when disabled
   * (livenessTimeoutMs: 0).
   */
  private livenessMonitor: MediaLivenessMonitor | null = null;

  /**
   * streamId → trackAlias for SUBGROUP data streams only. Lets a stream
   * reset shorten the owning track's liveness fuse (§10.4.3 resets are
   * otherwise normal). Fetch streams and datagrams never enter this map.
   */
  private readonly subgroupStreamAliases = new Map<bigint, bigint>();

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

  /**
   * Active fetches: requestId → track info for routing fetch objects.
   * @see draft-ietf-moq-transport-16 §9.16 (FETCH)
   */
  private readonly activeFetches = new Map<
    bigint,
    { trackName: string; mediaType: 'video' | 'audio'; trackAlias: bigint; warmStart?: boolean }
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
   * Fetch stream → track alias mapping for object routing.
   * When a FETCH data stream arrives (§10.4.4), we map the stream ID
   * to the correct track alias so fetch objects can be routed through
   * the subscription manager.
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
   * FETCH data streams whose request ID is not (yet) registered in
   * {@link activeFetches}. §9.16.3 allows fetch data at any time relative to
   * FETCH_OK — which can beat the joiningFetch()/fetch() promise continuation
   * that registers the fetch. Objects buffer here (bounded) and replay
   * through the normal alias remap once the fetch is registered; they are
   * NEVER routed under their wire trackAlias 0.
   */
  private readonly pendingFetchStreams = new Map<
    bigint,
    { requestId: bigint; objects: MoqtObject[]; terminal?: DataStreamTerminal }
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

  /**
   * Tombstones for OVERFLOWED unregistered fetch streams: their later objects
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
        // CMAF bootstrap deadlines ESCALATE (fatal); all other
        // expectations keep the historical diagnostic-only behavior.
        if (e.event === 'cmaf_init' || e.event === 'cmaf_first_frame') {
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
    if (this.catalogReceived) return 1; // HAVE_CATALOG
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
    return Object.freeze(this._stats.snapshot(locGauges));
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
  private resolveInlineInitData(track: CatalogTrack): string | undefined {
    if (track.initData !== undefined) return track.initData;
    if (track.initRef !== undefined) {
      const entry = this._catalogState?.initDataList?.find((e) => e.id === track.initRef);
      if (entry?.type === 'inline') return entry.data;
    }
    return undefined;
  }

  private decodeResolvedInlineInitData(track: CatalogTrack): Uint8Array | undefined {
    const initB64 = this.resolveInlineInitData(track);
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
  private async ensureInitTrack(initTrackName: string): Promise<Uint8Array> {
    const cached = this.initSegmentByTrack.get(initTrackName);
    if (cached) return cached;

    // Coalesce concurrent waiters for the same init track.
    const existing = this.pendingInitTrackSubs.get(initTrackName);
    if (existing) return existing.promise;

    let resolveInit!: (data: Uint8Array) => void;
    let rejectInit!: (err: Error) => void;
    const promise = new Promise<Uint8Array>((res, rej) => { resolveInit = res; rejectInit = rej; });
    // ONE shared operation: every caller (including the first) receives THIS
    // promise, and any failure settles it exactly once — so a single caller
    // cannot leave an internal rejection unobserved, and an unsettled entry
    // cannot strand later waiters. Failure also removes the entry (retry ok);
    // destroy() rejects whatever is still pending.
    this.pendingInitTrackSubs.set(initTrackName, { promise, resolve: resolveInit, reject: rejectInit });
    const failInitTrack = (err: Error): void => {
      if (this.pendingInitTrackSubs.get(initTrackName)?.promise === promise) {
        this.pendingInitTrackSubs.delete(initTrackName);
      }
      rejectInit(err);
    };

    void (async () => {
      try {
        if (!this.connection || !this.subscriptionManager) {
          throw new Error('ensureInitTrack: player not loaded');
        }
        const nsBytes = encodeNamespace(this.config.namespace, this.enc);
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
        await this.subscribeAuxTrackOwned(nsBytes, nameBytes, subscribeOptions, {
          trackName: initTrackName, mediaType: 'video', packaging: 'init',
        }, (id) => { this.initTrackRequestIds.set(initTrackName, id); },
        (id) => { if (this.initTrackRequestIds.get(initTrackName) === id) this.initTrackRequestIds.delete(initTrackName); });
      } catch (err) {
        failInitTrack(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return promise;
  }

  /**
   * Switch to a different video track from the altGroup.
   *
   * Subscribes to the new track, waits for SUBSCRIBE_OK, then
   * unsubscribes from the old track. The decoder will reconfigure
   * on the next keyframe from the new track.
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

    // Manual selection locks quality — disables bandwidth estimator
    // and recovery-driven auto-switching until the user re-enables auto.
    if (reason === 'manual' && this.qualityController) {
      this.qualityController.lockManual();
    }

    // Find the target track in the catalog
    const targetTrack = this._catalogState.tracks.find(
      (t: CatalogTrack) => t.name === trackName && t.role === 'video',
    );
    if (!targetTrack) {
      throw new Error(`Unknown video track: "${trackName}"`);
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

    // No-op if already on the target track
    if (currentVideoTrackName === trackName) return;

    // For CMAF: if the switch crosses codec families, the SourceBuffer
    // needs to be retyped via changeType() with the new init segment.
    // Resolve the init source up-front so the actual switch — fired in
    // completePendingVideoSwitch when the new keyframe arrives — has
    // bytes in hand and stays atomic.
    //
    // Source priority:
    //   1. inline `targetTrack.initData` (catalog ships it)
    //   2. inline `targetTrack.initRef` → root initDataList
    //   3. cached `initSegmentByTrack[targetTrack.initTrack]` (already subscribed)
    //   4. lazy-subscribe to `targetTrack.initTrack` and await first delivery
    //
    // Validate UP-FRONT (before mutating any state): if the catalog
    // provides neither initData nor initTrack for a codec change, the
    // switch can't proceed. Reject now so the existing subscription
    // stays intact — better than racing the rejection mid-async, where
    // the abort path would have to undo a partial commit.
    const needsCodecChange = targetTrack.packaging === 'cmaf'
        && targetTrack.codec !== undefined
        && (this.currentVideoCodec === null
            || !codecsCompatible(targetTrack.codec, this.currentVideoCodec));
    if (needsCodecChange) {
      // Resolve the inline init once (track.initData or an initRef → root inline
      // initDataList entry); fall back to an initTrack subscription otherwise.
      let inlineInit: Uint8Array | undefined;
      try {
        inlineInit = this.decodeResolvedInlineInitData(targetTrack);
      } catch (err) {
        throw new Error(
          `Cannot switch to "${trackName}": ${err instanceof Error ? err.message : String(err)} for codec "${targetTrack.codec}"`,
        );
      }
      if (!inlineInit && !targetTrack.initTrack) {
        throw new Error(
          `Cannot switch to "${trackName}": catalog provides no inline init (initData/initRef) or initTrack for codec "${targetTrack.codec}"`,
        );
      }
      this.log.info('[SWITCH] codec change "%s" → "%s" (codec "%s" → "%s"): prefetching init',
        currentVideoTrackName, trackName,
        this.currentVideoCodec ?? '(unknown)', targetTrack.codec);
      if (!inlineInit && targetTrack.initTrack) {
        try {
          await this.ensureInitTrack(targetTrack.initTrack);
        } catch (err) {
          this.log.warn('[SWITCH] init prefetch failed: %s',
            err instanceof Error ? err.message : String(err));
          throw err;
        }
      }
      // Inline init bytes — nothing to await.
    }

    // Subscribe to new track starting from the NEXT group boundary.
    // §4.2: altGroup tracks are time-aligned at group boundaries.
    // Using AbsoluteStart at currentGroup+1 avoids replaying the current
    // group (which was already rendered in the old resolution), preventing
    // visual backtrack and A/V desync from past-timestamp bursts.
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(trackName);
    const currentGroup = this.videoPipeline?.currentGroupId ?? -1n;
    const nextGroup = currentGroup >= 0n ? currentGroup + 1n : undefined;
    const isLive = targetTrack?.isLive === true;
    const subscribeOptions = nextGroup !== undefined
      ? {
          subscriptionFilter: {
            type: 'AbsoluteStart' as const,
            startGroup: varint(nextGroup),
            startObject: varint(0n),
          },
        }
      : (buildSubscribeOptions(this.config) ?? defaultMediaSubscriptionFilter(isLive));
    this.log.info('[SWITCH] subscribing at group=%s (current=%s)', nextGroup ?? 'latest', currentGroup);
    // Determine packaging from catalog
    const packaging: TrackPackaging = (targetTrack.packaging === 'cmaf') ? 'cmaf' : 'loc';
    // Pre-send ownership (§9.10): the pending entry (alias remap) and the
    // activeSubscriptions record are installed inside onRequestId so a
    // same-tick SUBSCRIBE_OK cannot miss them. DON'T register with the
    // subscription manager yet — new-track objects would feed the pipeline
    // while the old track is still playing; they buffer in
    // pendingObjectsByAlias until the switch completes.
    const switchConn = this.connection;
    let switchRegisteredId: bigint | null = null;
    const registerSwitchSub = (id: bigint): void => {
      if (switchRegisteredId !== null) return;
      switchRegisteredId = id;
      if (!this.subscriptionManager || this.connection !== switchConn) return;
      this.pendingAliasBinds.add(id);
      this.activeSubscriptions.set(id, { trackName, mediaType: 'video', trackAlias: id });
      this.pendingMediaSubs.set(id, { trackName, mediaType: 'video', packaging });
    };
    let reqIdBigInt: bigint;
    try {
      const reqId = await this.connection.subscribe(nsBytes, nameBytes,
        { ...subscribeOptions, onRequestId: (id: bigint) => registerSwitchSub(BigInt(id)) } as never);
      reqIdBigInt = BigInt(reqId);
      registerSwitchSub(reqIdBigInt);
    } catch (err) {
      if (switchRegisteredId !== null) {
        this.settleParkedOwnership(switchRegisteredId, null, switchConn);
        this.activeSubscriptions.delete(switchRegisteredId);
        this.pendingMediaSubs.delete(switchRegisteredId);
      }
      throw err;
    }

    if (!this.subscriptionManager) return; // destroyed during await

    this.log.info('[SWITCH] start: "%s" → "%s" (newReqId=%s, oldReqId=%s)',
      currentVideoTrackName, trackName, reqIdBigInt, currentVideoRequestId);

    // Defer old subscription teardown until the new track delivers its
    // first object — both tracks run concurrently during the overlap.
    // §4.2: "an MSF receiver SHOULD be able to cleanly switch between
    // time-aligned media tracks at group boundaries."
    if (currentVideoRequestId !== null) {
      this.pendingVideoSwitch = {
        oldRequestId: currentVideoRequestId,
        oldTrackName: currentVideoTrackName ?? '',
        newTrackName: trackName,
        newTrackAlias: reqIdBigInt,
        newTrackPackaging: packaging,
        reason,
        ...(abrAction ? { abrAction } : {}),
      };
    }

    // Emit "intent" event up-front so the UI can render a transitional
    // state. The "committed" event (`quality_switched`) and the stats
    // record fire only once `completePendingVideoSwitch` succeeds; on
    // rollback `quality_switch_failed` fires instead.
    this.emitter.emit('quality_switching', {
      type: 'quality_switching',
      fromTrackName: currentVideoTrackName ?? '',
      toTrackName: trackName,
      reason,
    });
  }

  /**
   * Complete a pending make-before-break video track switch.
   *
   * Called when a keyframe (objectId === 0n) arrives from the new track,
   * or by the safety timeout/overflow. Flushes old decoder (pending frames
   * drain to renderer), reconfigures for the new codec, then feeds all
   * staged objects to the pipeline.
   *
   * The renderer's FIFO queue ensures old frames play out before new frames.
   */
  private completePendingVideoSwitch(): void {
    // Re-entry guard: the keyframe-detect path in onCmafObject fires
    // for every object with objectId===0n, but only the first one
    // should drive the switch. Subsequent staged objects pile up in
    // the buffer and get flushed by the in-flight .then().
    if (this.switchInProgress) return;
    const sw = this.pendingVideoSwitch;
    if (!sw) return;
    this.switchInProgress = true;

    // Clear safety timeout
    if (this.switchStagingTimeout !== null) {
      clearTimeout(this.switchStagingTimeout);
      this.switchStagingTimeout = null;
    }

    if (!this.connection || !this.subscriptionManager) {
      this.pendingVideoSwitch = null;
      this.switchInProgress = false;
      this.switchStagingBuffer = [];
      this.cmafSwitchStagingBuffer = [];
      return;
    }

    const newTrack = this._catalogState?.tracks.find(
      (t: CatalogTrack) => t.name === sw.newTrackName && t.role === 'video',
    );

    // CMAF path: if the new track has a different codec than the
    // SourceBuffer was created with, ask the adapter to retype it
    // BEFORE the old track is unsubscribed. If the retype fails (or
    // the init bytes are missing), the switch is aborted cleanly
    // — old track keeps playing, new track is unsubscribed, staged
    // bytes are dropped — and the user sees an error event. Without
    // this, a failed pivot tears down the only known-good subscription
    // and strands playback in an unrecoverable state.
    const needsChangeType = newTrack?.packaging === 'cmaf'
      && newTrack.codec !== undefined
      && (this.currentVideoCodec === null
          || !codecsCompatible(newTrack.codec, this.currentVideoCodec));

    if (needsChangeType && newTrack && this.mediaSource?.changeType) {
      // Inline init (`initData` or an `initRef` → root inline entry) is Base64
      // (CatalogTrack §5.1.20 / MSF-01 §5.1.7); decode it. initTrack-delivered
      // cache holds raw Uint8Array.
      let initData: Uint8Array | undefined;
      try {
        initData = this.decodeResolvedInlineInitData(newTrack)
          ?? (newTrack.initTrack ? this.initSegmentByTrack.get(newTrack.initTrack) : undefined);
      } catch (err) {
        this.abortPendingVideoSwitch(sw, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!initData) {
        // selectVideoTrack should have pre-fetched this. Hitting here
        // means the catalog has neither inline initData nor an
        // initTrack for the target codec — abort, don't touch old.
        this.log.warn(
          '[SWITCH] init bytes missing for codec change → "%s" — aborting switch, old track stays active',
          newTrack.codec,
        );
        this.abortPendingVideoSwitch(sw, new Error(
          `Cannot switch to "${sw.newTrackName}": init bytes missing for codec "${newTrack.codec ?? ''}"`,
        ));
        return;
      }
      this.log.info('[SWITCH] codec change → calling MSE changeType: "%s" → "%s"',
        this.currentVideoCodec ?? '(unknown)', newTrack.codec);
      this.mediaSource.changeType('video', newTrack.codec ?? '', initData)
        .then(() => {
          // Pivot succeeded. NOW it's safe to tear down the old track
          // and flush the staged new-track segments into the retyped
          // SourceBuffer.
          this.unsubscribeOldVideoTrack(sw);
          this.currentVideoCodec = newTrack.codec ?? null;
          this.flushCmafStagedBuffer(sw);
        })
        .catch((err) => {
          // Pivot failed. The old SourceBuffer is still good for the
          // old codec — keep that subscription running, drop new.
          this.log.warn('[SWITCH] changeType failed: %s — aborting switch, old track stays active',
            err instanceof Error ? err.message : String(err));
          this.abortPendingVideoSwitch(sw,
            err instanceof Error ? err : new Error(String(err)));
        });
      return;
    }

    // ── Same-codec / LOC paths: tear down old, then commit new ──
    this.unsubscribeOldVideoTrack(sw);

    // Find the keyframe group ID for resetForTrackSwitch — use the
    // group that contains objectId=0, not the first staged object
    // (which might be a partial group from a mid-stream subscription).
    const keyframeEntry = this.switchStagingBuffer.find(
      s => BigInt(s.obj.objectId) === 0n,
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
          initData: this.resolveInlineInitData(newTrack),
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
    const keyframeIdx = staged.findIndex(s => BigInt(s.obj.objectId) === 0n);
    const toFlush = keyframeIdx >= 0 ? staged.slice(keyframeIdx) : staged;
    for (const { obj: stagedObj, headers: stagedHeaders } of toFlush) {
      this.videoPipeline?.pushObject(stagedObj, stagedHeaders);
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

  /**
   * Tear down the OLD track from a pending switch. Used by the
   * success paths (sync LOC/CMAF-same-codec, async CMAF-change after
   * `mediaSource.changeType` resolves).
   */
  private unsubscribeOldVideoTrack(sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>): void {
    if (!this.connection || !this.subscriptionManager) return;
    const oldAlias =
      this.activeSubscriptions.get(sw.oldRequestId)?.trackAlias ?? sw.oldRequestId;
    this.subscriptionManager.unregisterTrack(oldAlias);
    this.settleParkedOwnership(sw.oldRequestId, null, this.connection);
    this.connection.unsubscribe(varint(sw.oldRequestId));
    this.activeSubscriptions.delete(sw.oldRequestId);
    this.pendingMediaSubs.delete(sw.oldRequestId);
    this.pendingObjectsByAlias.delete(oldAlias);
  }

  /**
   * Flush the CMAF staging buffer through the assembler in arrival
   * order — keyframe first, then any P-frames that piled up while
   * `changeType` was in flight. Releases the switch gate at the end.
   */
  private flushCmafStagedBuffer(
    sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>,
  ): void {
    const cmafStaged = this.cmafSwitchStagingBuffer;
    this.cmafSwitchStagingBuffer = [];
    for (const { trackName: stagedTrack, mediaType: stagedMt, groupId, payload } of cmafStaged) {
      this.cmafAssembler?.push(stagedMt, stagedTrack, groupId, payload);
    }
    if (cmafStaged.length > 0) {
      this.log.info('[SWITCH] CMAF flush: "%s" → "%s" (staged=%d)',
        sw.oldTrackName, sw.newTrackName, cmafStaged.length);
    }
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;

    // Switch is now committed — commit controllers, record stat, fire event.
    // All mutation is deferred to this point. ABR/recovery initiation paths
    // use non-mutating peeks so abort leaves state unchanged.
    const newTrack = this._catalogState?.tracks.find(
      (t: CatalogTrack) => t.name === sw.newTrackName && t.role === 'video',
    );
    if (newTrack) {
      this._stats.recordQualitySwitch(defined({
        codec: newTrack.codec,
        bitrate: newTrack.bitrate,
        width: newTrack.width,
        height: newTrack.height,
      }));
    }
    // Commit QualityController to the new track index.
    this.qualityController?.commitVideoTrack(sw.newTrackName);
    // Commit BufferBasedController if this was an ABR-driven switch.
    if (sw.abrAction === 'downshift') {
      this.bufferAbrController?.commitDownshift();
    } else if (sw.abrAction === 'upshift') {
      this.bufferAbrController?.commitUpshift();
    }
    this.emitter.emit('quality_switched', {
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
  private abortPendingVideoSwitch(
    sw: NonNullable<MoqtPlayer['pendingVideoSwitch']>,
    cause: Error,
  ): void {
    if (this.connection && this.subscriptionManager) {
      const newAlias =
        this.activeSubscriptions.get(sw.newTrackAlias)?.trackAlias ?? sw.newTrackAlias;
      this.subscriptionManager.unregisterTrack(newAlias);
      this.settleParkedOwnership(sw.newTrackAlias, null, this.connection);
      try { this.connection.unsubscribe(varint(sw.newTrackAlias)); } catch { /* ignore */ }
      this.activeSubscriptions.delete(sw.newTrackAlias);
      this.pendingMediaSubs.delete(sw.newTrackAlias);
      this.pendingObjectsByAlias.delete(newAlias);
    }
    this.cmafSwitchStagingBuffer = [];
    this.switchStagingBuffer = [];
    this.pendingVideoSwitch = null;
    this.switchInProgress = false;
    this.emitter.emit('quality_switch_failed', {
      type: 'quality_switch_failed',
      fromTrackName: sw.oldTrackName,
      toTrackName: sw.newTrackName,
      reason: sw.reason,
      error: cause,
    });
    this.emitError(createPlayerError(
      'degraded',
      'decoder',
      PlayerErrorCode.VIDEO_DECODE_ERROR,
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

    // Initialize managers
    this.catalogManager = new CatalogManager(namespaceDisplay(this.config.namespace));
    this.qualityController = new QualityController({
      autoQuality: this.config.autoQuality!,
      startLevel: this.config.startLevel!,
      ...(this.config.capLevelToResolution ? { capLevelToResolution: this.config.capLevelToResolution } : {}),
      qualitySwitchCooldownMs: this.config.qualitySwitchCooldownMs!,
      clock: this.clock,
    });
    this.subscriptionManager = new SubscriptionManager();
    this.bandwidthEstimator = new BandwidthEstimator();

    // Set draft version for version-aware KVP encoding
    // Draft-14 §1.4.2: absolute type IDs
    // Draft-16 §1.4.2: delta-encoded type IDs
    if (this.config.draftVersion) {
      this.subscriptionManager.draftVersion = this.config.draftVersion;
    }

    // Apply object transform from config
    if (this.config.objectTransform) {
      this.subscriptionManager.objectTransform = this.config.objectTransform;
    }

    // Apply custom extension parser from config (e.g., non-LOC relay interop)
    if (this.config.extensionParser) {
      this.subscriptionManager.extensionParser = this.config.extensionParser;
    }

    // Wire object delivery → media_object events + pipeline routing
    this.subscriptionManager.onObject = (mediaType, trackName, obj, headers) => {
      // Liveness: ANY object on this track (data, gap, or staged-for-switch)
      // proves the delivery path is alive — stamp before every early return.
      this.stampMediaArrival(BigInt(obj.trackAlias));

      // Make-before-break track switch: stage new-track objects until a
      // keyframe arrives, keeping the old track playing the entire time.
      // @see draft-ietf-moq-msf-00 §4.2 (seamless switch at group boundaries)
      if (this.pendingVideoSwitch && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.newTrackName) {
        this.switchStagingBuffer.push({ obj, headers });

        // Start safety timeout on first staged object
        if (this.switchStagingBuffer.length === 1) {
          this.switchStagingTimeout = setTimeout(() => {
            this.log.warn('[SWITCH] keyframe timeout — force-completing after %dms', SWITCH_STAGING_TIMEOUT_MS);
            this.completePendingVideoSwitch();
          }, SWITCH_STAGING_TIMEOUT_MS);
        }

        // Complete when keyframe arrives (LOC: objectId 0 = keyframe)
        if (obj.objectId === 0n) {
          this.completePendingVideoSwitch();
        } else if (this.switchStagingBuffer.length >= SWITCH_STAGING_MAX_OBJECTS) {
          this.log.warn('[SWITCH] staging overflow (%d objects) — force-completing', SWITCH_STAGING_MAX_OBJECTS);
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

      // After switch commit starts (switchInProgress), drop old-track
      // objects. During the overlap window BEFORE commit, old-track
      // objects must keep flowing to sustain playback until the new
      // track's keyframe arrives.
      if (this.switchInProgress && this.pendingVideoSwitch
          && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.oldTrackName) {
        return;
      }

      // Route through pipeline for decode processing (LOC §4.2)
      // Drop objects while paused — the pipeline isn't ticking (not draining),
      // so buffering them just fills the jitter buffer and triggers
      // buffer_overflow recovery spam. On resume, pipeline.reset() clears
      // stale state and fresh objects arrive via REQUEST_UPDATE forward:1.
      if (this.stateMachine.state === PlayerState.PAUSED) return;
      const pipeline = mediaType === 'video' ? this.videoPipeline : this.audioPipeline;
      pipeline?.pushObject(obj, headers);
    };

    // Wire CMAF object delivery → MediaSource adapter (pipeline bypass)
    // §3.3: CMAF objects are moof or mdat — concatenate then feed to MSE
    this.subscriptionManager.onCmafObject = (mediaType, trackName, obj) => {
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

      if (obj.kind !== 'data' || !obj.payload) return;
      if (this.stateMachine.state === PlayerState.PAUSED) return;

      // Gate: media cannot reach MSE before initialization. While init is
      // pending, an in-band ftyp+moov object is accepted as the init
      // source; moof/mdat is dropped loudly and arms the bootstrap
      // deadline (no more silent pre-init drops).
      if (!this.cmafInitialized) {
        this.handlePreInitCmafObject(mediaType, trackName, obj.payload);
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
          return;
        }
      }

      // Make-before-break (CMAF): hold new-track segments until a
      // keyframe arrives, keeping the old track playing until then. On
      // keyframe, completePendingVideoSwitch unsubscribes the old track
      // and flushes the staged new-track segments to the assembler in
      // one shot. Without this both tracks would dump overlapping
      // ranges into MSE simultaneously, splicing repeatedly and
      // evicting decoder reference frames.
      if (this.pendingVideoSwitch && mediaType === 'video'
          && trackName === this.pendingVideoSwitch.newTrackName) {
        this.cmafSwitchStagingBuffer.push({
          trackName,
          mediaType,
          groupId: BigInt(obj.groupId),
          payload: obj.payload,
        });

        if (this.switchStagingTimeout === null) {
          this.switchStagingTimeout = setTimeout(() => {
            this.log.warn('[SWITCH] CMAF keyframe timeout — force-completing after %dms', SWITCH_STAGING_TIMEOUT_MS);
            this.completePendingVideoSwitch();
          }, SWITCH_STAGING_TIMEOUT_MS);
        }

        // CMAF: groupId boundary = keyframe. objectId 0 of a new group
        // is the moof of a fresh GOP, suitable as a splice point.
        if (BigInt(obj.objectId) === 0n) {
          this.completePendingVideoSwitch();
        } else if (this.cmafSwitchStagingBuffer.length >= SWITCH_STAGING_MAX_OBJECTS) {
          this.log.warn('[SWITCH] CMAF staging overflow (%d objects) — force-completing',
            SWITCH_STAGING_MAX_OBJECTS);
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
        if (floor !== undefined && groupId < floor) return;
      }

      // Feed through assembler: pairs moof+mdat per group, patches tfdt, emits segments.
      this.cmafAssembler?.push(mediaType, trackName, groupId, obj.payload);
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
      const catalog = this.catalogManager?.currentState;
      const catalogTrack = catalog?.tracks.find((t: CatalogTrack) => t.name === trackName);
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
    this.subscriptionManager.onInitObject = (trackName, obj) => {
      this.log.debug('[INIT] onInitObject: track=%s kind=%s payloadLen=%d mediaSource=%s',
        trackName, obj.kind, obj.kind === 'data' && obj.payload ? obj.payload.byteLength : 0,
        this.mediaSource ? 'exists' : 'null');
      if (obj.kind !== 'data' || !obj.payload) return;
      if (!this.mediaSource) return;

      // Find which catalog tracks reference this initTrack
      const catalog = this.catalogManager?.currentState;
      if (!catalog) return;

      const videoTrack = catalog.tracks.find(
        (t: CatalogTrack) => t.role === 'video' && t.initTrack === trackName,
      );
      const audioTrack = catalog.tracks.find(
        (t: CatalogTrack) => t.role === 'audio' && t.initTrack === trackName,
      );

      // Cache the init bytes so future codec-changing track switches
      // can call mediaSource.changeType() immediately instead of
      // re-fetching. Resolves any pending lazy-subscribe waiter.
      this.initSegmentByTrack.set(trackName, obj.payload);
      const pending = this.pendingInitTrackSubs.get(trackName);
      if (pending) {
        this.pendingInitTrackSubs.delete(trackName);
        pending.resolve(obj.payload);
      }

      // Unsubscribe and clean all bookkeeping — init track only needs one object.
      // Without cleanup, seek/recovery paths can send REQUEST_UPDATE to
      // a subscription that was already unsubscribed.
      const initReqId = this.initTrackRequestIds.get(trackName);
      if (initReqId !== undefined) {
        this.initTrackRequestIds.delete(trackName);
        const active = this.activeSubscriptions.get(initReqId);
        const alias = active?.trackAlias ?? initReqId;
        this.activeSubscriptions.delete(initReqId);
        this.pendingMediaSubs.delete(initReqId);
        this.subscriptionManager?.unregisterTrack(alias);
        if (this.connection) this.settleParkedOwnership(initReqId, null, this.connection);
        this.connection?.unsubscribe(varint(initReqId)).catch(() => {});
      }

      // Already initialized → this delivery is cache-warming for a future
      // codec switch only (the cache write above did the work).
      if (this.cmafInitialized) return;

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
        nsTuple, catalogTrackName());
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
      this.catalogReceived = true;
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

      // Catalog subscription (always required — MSF §9.1). Under the
      // bootstrap mode the filter is LargestObject and a relative Joining
      // FETCH (offset 0) supplies the prefix (MSF-01 §5); the legacy mode
      // keeps AbsoluteStart{0,0} byte-identical.
      const catalogFilter = this.catalogSubscribeOptions(conn);
      const bootstrapMode = this.resolvedCatalogMode(conn) === 'joining-fetch';
      // Coordinator installed BEFORE the subscribe: a fast SUBSCRIBE_OK or
      // first object must reach it, not the legacy path.
      const knownTracksCoord = bootstrapMode ? this.createCatalogBootstrap(conn) : null;
      promises.push((async () => {
        let reqId: Awaited<ReturnType<MoqtConnection['subscribe']>>;
        try {
          reqId = await conn.subscribe(nsBytes, this.enc.encode(catalogTrackName()), catalogFilter as never);
        } catch (err) {
          // The pre-send callback may have registered the bind — settle it.
          if (this.catalogRequestId !== null) this.settleParkedOwnership(this.catalogRequestId, null, conn);
          throw err;
        }
        this.catalogRequestId = BigInt(reqId);
        // catalogTrackAlias set by SUBSCRIBE_OK — never assume alias=requestId.
        // Callback-less adapter fallback: the subscribe is awaiting its OK.
        if (this.catalogTrackAlias === null) this.pendingAliasBinds.add(BigInt(reqId));
        knownTracksCoord?.start();
      })());

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
          const intent = this.hooks.beforeSubscribe.run({ trackName: track.name, mediaType });
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
            if (!this.subscriptionManager || this.connection !== conn) return;
            this.pendingAliasBinds.add(reqIdBigInt);
            this.activeSubscriptions.set(reqIdBigInt, {
              trackName: track.name, mediaType, trackAlias: reqIdBigInt,
            });
            this.subscriptionManager.registerTrack(reqIdBigInt, track.name, mediaType);
            this.pendingMediaSubs.set(reqIdBigInt, { trackName: track.name, mediaType });
            this.log.info('Subscribe %s "%s" requestId=%s (pre-known)', mediaType, track.name, reqIdBigInt);
          };
          let knownRegisteredId: bigint | null = null;
          try {
            const reqId = await conn.subscribe(
              nsBytes, this.enc.encode(track.name),
              { ...(knownTrackOptions ?? {}), onRequestId: (id: bigint) => { knownRegisteredId = id; registerKnownSub(id); } } as never,
            );
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
              this.settleParkedOwnership(knownRegisteredId, null, conn);
              this.activeSubscriptions.delete(knownRegisteredId);
              this.subscriptionManager?.unregisterTrack(knownRegisteredId);
              this.pendingMediaSubs.delete(knownRegisteredId);
            }
            throw err;
          }
        })());
      }

      await Promise.all(promises);
    } else {
      // ── Standard path: catalog-first ───────────────────────────────
      // Subscribe to the catalog track (MSF §9.1, §5.1.10; name is always
      // "catalog" on every draft). Bootstrap mode pairs a LargestObject
      // filter with a relative Joining FETCH (MSF-01 §5); legacy mode keeps
      // AbsoluteStart{0,0} byte-identical.
      const nameBytes = this.enc.encode(catalogTrackName());
      const standardCoord = this.resolvedCatalogMode(conn) === 'joining-fetch'
        ? this.createCatalogBootstrap(conn) : null;
      let reqId: Awaited<ReturnType<MoqtConnection['subscribe']>>;
      try {
        reqId = await conn.subscribe(nsBytes, nameBytes, this.catalogSubscribeOptions(conn) as never);
      } catch (err) {
        // The pre-send callback may have registered the bind — settle it.
        if (this.catalogRequestId !== null) this.settleParkedOwnership(this.catalogRequestId, null, conn);
        throw err;
      }
      this.catalogRequestId = BigInt(reqId);
      // catalogTrackAlias set by SUBSCRIBE_OK — never assume alias=requestId.
      // Callback-less adapter fallback: the subscribe is awaiting its OK.
      if (this.catalogTrackAlias === null) this.pendingAliasBinds.add(BigInt(reqId));
      standardCoord?.start();
    }
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
  ): Promise<void> {
    if (this._destroyed) throw new Error('Cannot migrate: player is destroyed');
    if (this.currentMigration) throw new Error('Cannot migrate: a migration is already in progress');

    const oldConnection = this.connection;
    const txn: MigrationTxn = { conn: newConnection, events: [], retainedBytes: 0, aborted: false, committed: false, terminated: false };
    this.currentMigration = txn; // reserve single-flight BEFORE creating the transport
    this.wireConnection(newConnection);

    let catalogReqId: bigint;
    let transport: WebTransportLike | undefined;
    try {
      transport = await makeTransport();
      this.assertMigrationLive(txn); // destroyed/aborted during transport creation?
      await newConnection.connect(transport, setupOptions);
      this.assertMigrationLive(txn);
      const nsBytes = encodeNamespace(this.config.namespace, this.enc);
      const nameBytes = this.enc.encode(catalogTrackName());
      // Candidate ownership is TRANSACTION-LOCAL: the active session's
      // catalogRequestId must not be touched until commit. Bootstrap mode
      // needs the LargestObject filter chosen here, atomically with the
      // joining fetch that commitMigration's coordinator will issue —
      // pairing it with AbsoluteStart would be session-fatal on d16 (§9.16.2).
      const candidateMode = this.resolvedCatalogMode(newConnection);
      let candidateReqId: bigint | null = null;
      // Unified terminal lifecycle for the candidate catalog subscription on
      // BOTH modes: a drain completing BEFORE commit is buffered on the
      // transaction and replayed after the staged events flush (never lost);
      // after commit it dispatches normally, including feedEnded retirement.
      const candidateDrained = (id: bigint): void => {
        if (this.connection !== newConnection) {
          if (!txn.aborted) txn.catalogDrainPending = true;
          return;
        }
        if (id !== this.catalogRequestId) return;
        this.deliverCatalogDrained();
      };
      const candidateOptions = candidateMode === 'joining-fetch'
        ? {
            subscriptionFilter: { type: 'LargestObject' as const },
            onRequestId: (id: bigint) => { candidateReqId = id; },
            terminalDelivery: 'drain' as const,
            onDrained: candidateDrained,
          }
        : {
            subscriptionFilter: { type: 'AbsoluteStart' as const, startGroup: varint(0n), startObject: varint(0n) },
            onRequestId: (id: bigint) => { candidateReqId = id; },
            terminalDelivery: 'drain' as const,
            onDrained: candidateDrained,
          };
      const reqId = await newConnection.subscribe(nsBytes, nameBytes, candidateOptions as never);
      this.assertMigrationLive(txn); // validate immediately before the atomic commit
      catalogReqId = candidateReqId ?? BigInt(reqId);
    } catch (err) {
      // ESTABLISHMENT rollback — nothing committed, old session untouched. Discard
      // the candidate and close any orphaned transport (idempotent with the
      // candidate close, which closes an attached transport).
      if (this.currentMigration === txn) this.currentMigration = null;
      this.abandonCandidate(txn);
      if (transport) { try { transport.close(); } catch { /* already closing/closed */ } }
      // The old session was never disturbed and is still current — a GOAWAY it
      // sent while this (failed) handoff held the slot can now be acted on.
      this.processPendingGoaway();
      throw err;
    }

    // ── Point of no return: the candidate is validated. Commit atomically. ──
    this.commitMigration(txn, newConnection, catalogReqId);
    // POST-commit: drain staged events, THEN retire the old session — with the
    // transaction kept REGISTERED (currentMigration === txn) through BOTH, so a
    // new-session close/fatal-error while the old close() is pending can still
    // mark txn.terminated. Cleanup runs in `finally` even if something throws — a
    // stranded transaction would leave a permanent "migration in progress" lock.
    // (drainStagedCandidate never throws; retireMigratedSession never throws.)
    try {
      this.drainStagedCandidate(txn);
      // A catalog drain that completed pre-commit replays now — AFTER the
      // staged PUBLISH_DONE reached the (new) coordinator, so the stored
      // reason is in place when drained finalizes it.
      if (txn.catalogDrainPending) {
        txn.catalogDrainPending = false;
        this.deliverCatalogDrained();
      }
      await this.retireMigratedSession(oldConnection);
    } finally {
      if (this.currentMigration === txn) this.currentMigration = null;
    }
    // The single-flight slot is now released — a GOAWAY queued during drain or
    // retirement can be acted on (a fresh migration to its target). Done before
    // the termination check so a GOAWAY that raced a dying session still drives
    // recovery to the new relay.
    this.processPendingGoaway();
    // The replacement may have died during drain OR during old-session
    // retirement, or the player was destroyed. In any of these the handoff did
    // not yield a usable session (session_closed/error was already surfaced), so
    // do NOT report a successful migration.
    if (txn.terminated || this._destroyed) throw new Error('Migration session closed during handoff');
  }

  /**
   * Throw if the in-flight transaction may no longer commit: the player was
   * destroyed, the candidate reached a terminal/overflow state, or it was
   * superseded by another transaction. Called right after each establishment
   * await, so a deferred candidate cannot resurrect a destroyed player or commit
   * a dead session.
   */
  private assertMigrationLive(txn: MigrationTxn): void {
    if (this._destroyed) throw new Error('Migration aborted: player destroyed during establishment');
    if (this.currentMigration !== txn || txn.aborted) throw new Error('Migration aborted: candidate no longer valid');
  }

  /**
   * Append a bounded event to a transaction's staged queue. Overflow (event or
   * byte cap) aborts and closes the candidate rather than silently dropping a
   * possibly-essential event. Shared by the callback staging wrapper and the
   * deferred degraded-error diagnostic.
   */
  private stageMigrationEvent(txn: MigrationTxn, run: () => void, bytes: number, source: MoqtConnectionErrorSource): void {
    if (txn.events.length >= MoqtPlayer.MAX_STAGED_EVENTS || txn.retainedBytes + bytes > MoqtPlayer.MAX_STAGED_BYTES) {
      this.abortMigration(txn);
      return;
    }
    txn.retainedBytes += bytes;
    txn.events.push({ run, source });
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
    // Mark the transaction terminal so any callback reference captured before
    // detachment is permanently inert (see the owning-txn check in stageable).
    txn.aborted = true;
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
  private commitMigration(txn: MigrationTxn, newConnection: MoqtConnection, catalogReqId: bigint): void {
    txn.committed = true; // staging closed — further candidate events run live on the now-current session
    // The superseded session's catalog delivery is quarantined for BOTH
    // migration flavors (GOAWAY installs it earlier; manual migration only
    // here): if old and new sessions reuse an alias, late old-session catalog
    // data must never reach the new coordinator through the global alias route.
    if (this.connection) {
      this.catalogQuarantinedConns.add(this.connection);
      // F6: remember the OLD session's catalog alias so a cross-role reuse of
      // that alias on the NEW session can never route late old catalog bytes
      // into the media pipeline.
      if (this.catalogTrackAlias !== null) {
        this.quarantinedCatalogAliases.set(this.connection, this.catalogTrackAlias);
      }
    }
    // Old-session request ids are dead; the candidate's catalog subscribe may
    // still be awaiting SUBSCRIBE_OK (its staged response replays after this).
    this.pendingAliasBinds.clear();
    this.pendingAliasBinds.add(catalogReqId);
    this.connection = newConnection;
    if (this.subscriptionManager) this.subscriptionManager.draftVersion = newConnection.draftVersion;

    // Reset catalog state for the new session
    this.catalogReceived = false;
    this.catalogTrackAlias = null;
    this.catalogRequestId = catalogReqId;
    this.legacyCatalogTerminal = null;
    // Catalog bootstrap: the old coordinator is superseded wholesale; a fresh
    // one (new generation) binds to the committed session. Its joining fetch
    // fires immediately (Pending/Established association both legal on 16/18).
    this.catalogBootstrapCoord?.abort();
    this.catalogBootstrapCoord = null;
    this.catalogRecovery?.coord.abort();
    this.catalogRecovery = null;
    this.recoveryAttempted = false; // new session, fresh recovery budget
    this.bootstrapGeneration += 1;
    this.bootstrapFetch = null;
    this.bootstrapFetchStreams.clear();
    this.catalogManager?.reset();

    // Clear fetch state (fetches are per-session) and reject any in-flight
    // fetchCatalog promises — their request IDs/stream IDs belong to the old
    // adapter and won't match new-session traffic.
    this.activeFetches.clear();
    this.fetchStreamAliases.clear();
    this.fetchStreamRequestIds.clear();
    this.pendingFetchStreams.clear();
    this.refusedFetchRequests.clear();
    this.quarantinedFetchRequests.clear();
    this.droppedFetchStreams.clear();
    this.rejectPendingCatalogFetches('Session migrated — fetchCatalog cancelled');

    // Re-bootstrap on the committed session. (The candidate's catalog
    // subscribe already used this mode's options — see runMigrationTransaction.)
    if (this.resolvedCatalogMode(newConnection) === 'joining-fetch') {
      this.createCatalogBootstrap(newConnection).start();
    }
  }

  /**
   * Close the superseded session (§3.5) and reclaim its buffered objects. A LOCAL
   * close does not emit onClose, so the onClose reclamation never runs for a
   * migration — purge here so the old entries (and the strong adapter reference)
   * are released instead of consuming the alias cap until player destruction.
   */
  private async retireMigratedSession(oldConnection: MoqtConnection | null): Promise<void> {
    if (!oldConnection) return;
    try {
      await oldConnection.close();
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
      this.purgePendingForConnection(oldConnection);
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
    if (this._destroyed || !this.config.createConnection) return;
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
    const setupOptions = buildSetupOptions(this.config);
    await this.runMigrationTransaction(newConnection, () => createTransport(buildConnectUrl(this.config, url)), setupOptions);

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

    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(trackName);

    const fetchOptions = {
      startGroup: varint(BigInt(options.startGroup)),
      startObject: varint(BigInt(options.startObject)),
      endGroup: varint(BigInt(options.endGroup)),
      endObject: varint(BigInt(options.endObject)),
    };

    // Find the media type and track alias for this track name from the
    // active subscriptions (catalog-selected tracks) BEFORE issuing the
    // request, so pre-send ownership can register inside onRequestId — a
    // zero-latency data stream or response never beats the registration.
    // (registerMediaFetch re-resolves the alias against the CURRENT
    // subscription state anyway, covering a remap during the await.)
    let mediaType: 'video' | 'audio' = 'video';
    let knownAlias: bigint | null = null;
    for (const [, sub] of this.activeSubscriptions) {
      if (sub.trackName === trackName &&
          sub.mediaType !== 'mediatimeline' &&
          sub.mediaType !== 'eventtimeline') {
        mediaType = sub.mediaType;
        knownAlias = sub.trackAlias;
        break;
      }
    }
    let fetchRegisteredId: bigint | null = null;
    const registerPublicFetch = (id: bigint): void => {
      if (fetchRegisteredId !== null) return;
      fetchRegisteredId = id;
      if (!this.subscriptionManager || this.connection !== connAtCall) return;
      this.registerMediaFetch(id, { trackName, mediaType, trackAlias: knownAlias ?? id });
    };
    let reqId: Awaited<ReturnType<MoqtConnection['fetch']>>;
    try {
      reqId = await connAtCall.fetch(nsBytes, nameBytes,
        { ...fetchOptions, onRequestId: (id: bigint) => registerPublicFetch(BigInt(id)) } as never);
    } catch (err) {
      if (fetchRegisteredId !== null) {
        this.activeFetches.delete(fetchRegisteredId);
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
      if (fetchRegisteredId !== null) this.activeFetches.delete(fetchRegisteredId);
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
    info: { trackName: string; mediaType: 'video' | 'audio'; trackAlias: bigint; warmStart?: boolean },
  ): void {
    // A REQUEST_ERROR that raced the fetch()/joiningFetch() continuation
    // already refused this request — honor it instead of resurrecting a
    // dead fetch (its buffered streams are dropped with it).
    const refused = this.refusedFetchRequests.get(fetchReqId);
    if (refused) {
      this.refusedFetchRequests.delete(fetchReqId);
      for (const [streamId, pending] of this.pendingFetchStreams) {
        if (pending.requestId === fetchReqId) this.pendingFetchStreams.delete(streamId);
      }
      this.log.warn('[%s] media FETCH %s for "%s" was refused before registration: %s (code=0x%s) — continuing live-only',
        info.warmStart ? 'warm-start' : 'fetch',
        fetchReqId, info.trackName, refused.reason, refused.code.toString(16));
      return;
    }

    // An alias remap (SUBSCRIBE_OK with a server-assigned alias) may have
    // landed during the same await window — always register against the
    // track's CURRENT alias, not the one captured before the await.
    for (const sub of this.activeSubscriptions.values()) {
      if (sub.trackName === info.trackName && sub.mediaType === info.mediaType) {
        info = { ...info, trackAlias: sub.trackAlias };
        break;
      }
    }

    this.activeFetches.set(fetchReqId, info);
    for (const [streamId, pending] of this.pendingFetchStreams) {
      if (pending.requestId !== fetchReqId) continue;
      this.pendingFetchStreams.delete(streamId);
      for (const obj of pending.objects) {
        // Fetch state is per-session (cleared on migrate), so the current
        // connection is the source session here.
        this.routeFetchObject(streamId, info.trackAlias, obj, this.connection?.draftVersion, this.connection ?? undefined);
      }
      if (pending.terminal !== undefined) {
        // The stream already ended — however it ended, no live routing maps
        // are needed and the fetch bookkeeping ends with it. Only the
        // BOOTSTRAP path below needs the terminal to be a peer FIN.
        this.activeFetches.delete(fetchReqId);
      } else {
        this.fetchStreamAliases.set(streamId, info.trackAlias);
        this.fetchStreamRequestIds.set(streamId, fetchReqId);
      }
    }
  }

  /**
   * Route one FETCH data-stream object: remap the wire trackAlias (0 on a
   * fetch stream, §10.4.4) to the live track's alias and hand it to the
   * same SubscriptionManager path live objects use.
   */
  private routeFetchObject(streamId: bigint, alias: bigint, obj: MoqtObject, sourceDraft?: DraftVersion, sourceConnection?: MoqtConnection): void {
    if (this.subscriptionManager?.getMediaType(alias) === undefined) return;
    const remapped: MoqtObject = { ...obj, trackAlias: varint(alias) };
    this.subscriptionManager.routeObject(streamId, remapped, sourceDraft, sourceConnection);
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
    await this.connection.fetchCancel(varint(requestId));
    this.activeFetches.delete(BigInt(requestId));
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
    const nameBytes = this.enc.encode(catalogTrackName());
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
      // Fresh per-call manager — doesn't read or mutate this.catalogManager.
      const oneShot = new CatalogManager(namespaceDisplay(this.config.namespace));
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
  private invalidRangeCode(): bigint {
    return (this.connection?.draftVersion ?? this.config.draftVersion ?? 16) === 14 ? 0x5n : 0x11n;
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
  private catalogSubscribeOptions(conn: MoqtConnection): Record<string, unknown> {
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
          this.catalogRequestId = id;
          this.pendingAliasBinds.add(id);
        },
        // Terminal-drain semantics apply on EVERY draft, including 14 and the
        // legacy retrieval mode: the adapter retains routing for the drain
        // window (late objects still deliver), then the player retires the
        // catalog route. Adapter-local options — wire bytes are unchanged.
        terminalDelivery: 'drain' as const,
        onDrained: (id: bigint) => {
          if (legacyGen !== this.bootstrapGeneration) return;
          if (id !== this.catalogRequestId) return;
          this.deliverCatalogDrained();
        },
      };
    }
    const gen = this.bootstrapGeneration;
    return {
      subscriptionFilter: { type: 'LargestObject' as const },
      onRequestId: (id: bigint) => {
        if (gen !== this.bootstrapGeneration) return;
        this.catalogRequestId = id;
        this.pendingAliasBinds.add(id);
      },
      terminalDelivery: 'drain' as const,
      onDrained: (id: bigint) => {
        if (gen !== this.bootstrapGeneration) return;
        if (id !== this.catalogRequestId) return;
        const coord = this.catalogBootstrapCoord;
        coord?.onSubscriptionDrained();
        // A drained 'ended' feed is OVER: retire the route so late objects
        // stop applying (retriable retirement happens in staged recovery).
        if (coord?.feedEnded) this.retireCatalogAliasRoute();
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
  private createCatalogBootstrap(conn: MoqtConnection): CatalogBootstrap {
    const gen = this.bootstrapGeneration;
    const live = (): boolean => gen === this.bootstrapGeneration && this.connection === conn;
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName());

    const coord = new CatalogBootstrap({
      applyAt: (loc, payload, opts) => this.catalogManager!.processCatalogObjectAt(loc, payload, opts),
      resetManager: () => this.catalogManager?.reset(),
      currentState: () => this.catalogManager?.currentState ?? null,
      issueJoiningFetch: (attempt) => {
        void (async () => {
          let myFetchReqId: bigint | null = null;
          try {
            if (!live() || this.catalogRequestId === null) throw new Error('no catalog subscription');
            await conn.joiningFetch({
              joiningFetchType: 'relative',
              joiningRequestId: this.catalogRequestId,
              joiningStart: 0n,
              groupOrder: varint(0x1n), // ascending — explicit on every bootstrap fetch
              onRequestId: (id: bigint) => { myFetchReqId = id; this.registerBootstrapFetch(conn, id, attempt, gen); },
            } as never);
          } catch (err) {
            if (!live()) return;
            this.log.debug('[catalog-bootstrap] joining fetch failed locally: %s',
              err instanceof Error ? err.message : String(err));
            // RETIRE only THIS call's allocation — a rejection settling late
            // must never cancel a newer ladder attempt's request/streams.
            if (myFetchReqId !== null) {
              this.retireBootstrapFetch(conn, myFetchReqId, { attempt });
              if (this.bootstrapFetch?.reqId === myFetchReqId && this.bootstrapFetch.conn === conn) {
                this.bootstrapFetch = null;
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      issueStandaloneFetch: (range, attempt) => {
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
              onRequestId: (id: bigint) => { myFetchReqId = id; this.registerBootstrapFetch(conn, id, attempt, gen); },
            } as never);
          } catch (err) {
            if (!live()) return;
            this.log.debug('[catalog-bootstrap] standalone fetch failed locally: %s',
              err instanceof Error ? err.message : String(err));
            // RETIRE only THIS call's allocation — never a newer attempt's.
            if (myFetchReqId !== null) {
              this.retireBootstrapFetch(conn, myFetchReqId, { attempt });
              if (this.bootstrapFetch?.reqId === myFetchReqId && this.bootstrapFetch.conn === conn) {
                this.bootstrapFetch = null;
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      cancelFetch: () => {
        const fetch = this.bootstrapFetch;
        this.bootstrapFetch = null;
        if (fetch) this.retireBootstrapFetch(fetch.conn, fetch.reqId, { attempt: fetch.attempt });
      },
      onReady: (state) => {
        if (!live()) return;
        this.onCatalogBootstrapReady(state);
      },
      onUpdated: (state) => {
        if (!live()) return;
        this._catalogState = state;
        this.emitter.emit('catalog_updated', { type: 'catalog_updated', catalog: state });
      },
      requestLegacyResubscribe: () => {
        void (async () => {
          if (!live()) return;
          const oldReqId = this.catalogRequestId;
          this.catalogRequestId = null;
          this.catalogTrackAlias = null;
          if (oldReqId !== null) {
            // Cancellation settles like a response: the dead request stops
            // owning parked data and stops enabling parking.
            this.settleParkedOwnership(oldReqId, null, conn);
            await conn.unsubscribe(varint(oldReqId)).catch(() => { /* best effort */ });
          }
          if (!live()) return;
          try {
            // Pre-send ownership + terminal drain, exactly as the primary
            // catalog subscribe: a fast response must not beat registration,
            // and late objects after a PUBLISH_DONE must still drain.
            const reqId = await conn.subscribe(nsBytes, nameBytes, {
              subscriptionFilter: {
                type: 'AbsoluteStart', startGroup: varint(0n), startObject: varint(0n),
              },
              onRequestId: (id: bigint) => {
                if (!live()) return;
                this.catalogRequestId = id;
                this.pendingAliasBinds.add(id);
              },
              terminalDelivery: 'drain',
              onDrained: (id: bigint) => {
                if (!live()) return;
                if (id !== this.catalogRequestId) return;
                const drainCoord = this.catalogBootstrapCoord;
                drainCoord?.onSubscriptionDrained();
                if (drainCoord?.feedEnded) this.retireCatalogAliasRoute();
              },
            } as never);
            if (!live()) return;
            if (this.catalogRequestId === null) {
              this.catalogRequestId = BigInt(reqId); // callback-less adapter fallback
              this.pendingAliasBinds.add(BigInt(reqId));
            }
          } catch (err) {
            if (this.catalogRequestId !== null) this.settleParkedOwnership(this.catalogRequestId, null, conn);
            if (!live()) return;
            this.emitError(createPlayerError(
              'fatal', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
              `catalog bootstrap fallback resubscribe failed: ${err instanceof Error ? err.message : String(err)}`,
            ));
          }
        })();
      },
      onFatal: (reason) => {
        if (!live()) return;
        this.emitError(createPlayerError(
          'fatal', 'catalog', PlayerErrorCode.CATALOG_PARSE_ERROR,
          `catalog bootstrap failed: ${reason}`,
        ));
      },
      onDegraded: (reason) => {
        if (!live()) return;
        // Post-readiness catalog faults match the legacy severity model:
        // degraded, never silent.
        this.emitError(createPlayerError(
          'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
          `catalog update rejected: ${reason}`,
        ));
      },
      requestStagedRecovery: () => {
        if (!live()) return;
        this.beginCatalogRecovery(conn);
      },
      log: (msg, ...args) => this.log.debug(msg, ...args),
    }, {
      draft: (conn.draftVersion ?? this.config.draftVersion ?? 16) as 14 | 16 | 18,
      strict: this.strictCatalogMode(),
    });

    this.catalogBootstrapCoord = coord;
    return coord;
  }

  /** Pre-send bootstrap fetch ownership; claims any parked streams. */
  private registerBootstrapFetch(conn: MoqtConnection, reqId: bigint, attempt: number, gen: number): void {
    if (gen !== this.bootstrapGeneration) return;
    this.bootstrapFetch = { conn, reqId, attempt, gen };
    // Claim any stream parked by the defensive fallback at the onDataStream
    // site — a FETCH header whose request had no owner yet. Registration is
    // pre-send and synchronous, so this should find nothing.
    for (const [streamId, parked] of [...this.pendingFetchStreams]) {
      if (parked.requestId === reqId) {
        this.pendingFetchStreams.delete(streamId);
        this.bootstrapFetchStreams.set(streamId, { attempt, conn });
        for (const obj of parked.objects) {
          this.emitCatalogRaw(obj);
          this.catalogBootstrapCoord?.onFetchObject(attempt, this.toCatalogEvent(obj));
        }
        if (parked.terminal !== undefined) {
          // The stream ended before registration. Only a peer FIN completes the
          // attempt — a reset, our own discard, and a read failure are all
          // recorded here too, and none of them finished the fetch.
          this.catalogBootstrapCoord?.onFetchStreamClosed(attempt, parked.terminal === 'fin');
        }
      }
    }
  }

  /** Emit the raw-catalog diagnostic exactly as the legacy path does. */
  private emitCatalogRaw(obj: MoqtObject): void {
    if (obj.kind !== 'data') return;
    let text: string | undefined;
    try { text = new TextDecoder().decode(obj.payload); } catch { /* binary */ }
    this.emitter.emit('catalog_raw', { type: 'catalog_raw', payload: obj.payload, text: text ?? '' });
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
    if (this.catalogReceived) return;
    this.catalogReceived = true;
    this._catalogState = catalogState;
    this._stats.recordCatalogReceived();
    this.watchdog.fulfill('catalog_received');
    this.watchdog.expect('first_media_object', 20_000);
    this.emitter.emit('catalog_received', { type: 'catalog_received', catalog: catalogState });
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
      this.qualityController.selectInitialTracks(catalogState, defined({
        videoConstraints: this.config.videoConstraints,
        audioConstraints: this.config.audioConstraints,
        ...(this.config.disableVideo ? { disableVideo: true } : {}),
        ...(this.config.disableAudio ? { disableAudio: true } : {}),
      }));
      this.validateKnownTracks(catalogState);
    } else {
      this.subscribeToMediaTracks(catalogState).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('subscribeToMediaTracks failed: %s', msg);
        this.emitError(createPlayerError(
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
  /** Deferred terminal record for the LEGACY (coordinator-less) catalog
   *  subscription — the DECISION (recovery / fatal-no-base / quiet end) is
   *  made only at drain completion, honoring the terminal-drain barrier: a
   *  base may still arrive during the drain. Generation-stamped so a stale
   *  record can never affect a later legacy subscription (cleared at
   *  migration commit and destroy). */
  private legacyCatalogTerminal: { gen: number; reqId: bigint | null; reason: PublishDoneReason } | null = null;

  /** Dispatch a completed catalog terminal drain against the CURRENT catalog
   *  machinery: coordinator mode finalizes the deferred DONE (and retires the
   *  route for an ended feed); legacy mode retires the route and THEN applies
   *  the deferred status policy (retriable → staged recovery). */
  private deliverCatalogDrained(): void {
    const coord = this.catalogBootstrapCoord;
    if (coord) {
      coord.onSubscriptionDrained();
      if (coord.feedEnded) this.retireCatalogAliasRoute();
      return;
    }
    const t = this.legacyCatalogTerminal;
    this.legacyCatalogTerminal = null;
    this.retireCatalogAliasRoute();
    if (!t || t.gen !== this.bootstrapGeneration) return;
    if (!this.catalogReceived) {
      // Ended OR retriable and still no base after the whole drain window:
      // nothing further can arrive.
      this.emitError(createPlayerError(
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
  private retireBootstrapFetch(conn: MoqtConnection, reqId: bigint, opts?: { attempt?: number; extraStreams?: Iterable<bigint> }): void {
    void conn.fetchCancel(varint(reqId)).catch(() => { /* gone */ });
    this.quarantineFetchRequest(reqId);
    for (const [sid, entry] of this.bootstrapFetchStreams) {
      // Attempt-scoped: retiring attempt A must never sweep streams that a
      // NEWER attempt B (started while A's rejection was still settling)
      // already owns on the same connection.
      if (entry.conn === conn && (opts?.attempt === undefined || entry.attempt === opts.attempt)) {
        this.bootstrapFetchStreams.delete(sid);
        this.droppedFetchStreams.add(sid);
      }
    }
    if (opts?.extraStreams) {
      for (const sid of opts.extraStreams) this.droppedFetchStreams.add(sid);
    }
  }

  /** Retire the live catalog alias route: a drained terminal subscription
   *  must not keep applying late objects through the global alias match.
   *  Post-drain traffic on the alias parks in the ordinary pre-SUBSCRIBE_OK
   *  buffer and belongs to whichever request next binds it. */
  private retireCatalogAliasRoute(): void {
    this.catalogTrackAlias = null;
  }

  private beginCatalogRecovery(conn: MoqtConnection): void {
    if (this.recoveryAttempted || this.catalogRecovery !== null) {
      // Recovery declined: the feed is over for good — retire the route so a
      // late post-drain object cannot keep mutating the frozen catalog.
      this.retireCatalogAliasRoute();
      this.emitError(createPlayerError(
        'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
        'catalog feed ended (retriable) and recovery was already attempted — updates stopped',
      ));
      return;
    }
    this.recoveryAttempted = true;
    const gen = this.bootstrapGeneration;
    // Role-aware ownership: pre-adoption this coordinator lives in the
    // catalogRecovery slot; ADOPTION moves it into the main slot, after which
    // its callbacks keep working (deltas, DONE, further recovery requests) —
    // ownership follows the coordinator, not the transaction slot.
    const ownedAsCandidate = (): boolean =>
      gen === this.bootstrapGeneration && this.connection === conn && this.catalogRecovery?.coord === coord;
    const ownedAsMain = (): boolean =>
      gen === this.bootstrapGeneration && this.connection === conn && this.catalogBootstrapCoord === coord;
    const live = (): boolean => ownedAsCandidate() || ownedAsMain();
    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(catalogTrackName());
    const manager = new CatalogManager(namespaceDisplay(this.config.namespace));

    const failCandidate = (reason: string): void => {
      if (!ownedAsCandidate()) return; // post-adoption failures follow main-role paths
      this.failCatalogRecovery(reason);
    };

    const coord = new CatalogBootstrap({
      applyAt: (loc, payload, opts) => manager.processCatalogObjectAt(loc, payload, opts),
      resetManager: () => manager.reset(),
      currentState: () => manager.currentState,
      issueJoiningFetch: (attempt) => {
        void (async () => {
          let myFetchReqId: bigint | null = null;
          try {
            const subReqId = ownedAsCandidate() ? this.catalogRecovery!.reqId : this.catalogRequestId;
            if (!live() || subReqId == null) throw new Error('no candidate subscription');
            await conn.joiningFetch({
              joiningFetchType: 'relative',
              joiningRequestId: subReqId,
              joiningStart: 0n,
              groupOrder: varint(0x1n),
              onRequestId: (id: bigint) => {
                myFetchReqId = id;
                if (ownedAsCandidate()) {
                  this.catalogRecovery!.fetch = { reqId: id, attempt };
                } else if (ownedAsMain()) {
                  this.registerBootstrapFetch(conn, id, attempt, this.bootstrapGeneration);
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
                const r = this.catalogRecovery!;
                const mine: bigint[] = [];
                for (const [sid, a] of r.fetchStreams) {
                  if (a === attempt) { mine.push(sid); r.fetchStreams.delete(sid); }
                }
                this.retireBootstrapFetch(conn, myFetchReqId, { attempt, extraStreams: mine });
                if (r.fetch?.reqId === myFetchReqId) r.fetch = null;
              } else {
                this.retireBootstrapFetch(conn, myFetchReqId, { attempt });
                if (this.bootstrapFetch?.reqId === myFetchReqId && this.bootstrapFetch.conn === conn) {
                  this.bootstrapFetch = null;
                }
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      issueStandaloneFetch: (range, attempt) => {
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
                myFetchReqId = id;
                if (ownedAsCandidate()) {
                  this.catalogRecovery!.fetch = { reqId: id, attempt };
                } else if (ownedAsMain()) {
                  this.registerBootstrapFetch(conn, id, attempt, this.bootstrapGeneration);
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
                const r = this.catalogRecovery!;
                const mine: bigint[] = [];
                for (const [sid, a] of r.fetchStreams) {
                  if (a === attempt) { mine.push(sid); r.fetchStreams.delete(sid); }
                }
                this.retireBootstrapFetch(conn, myFetchReqId, { attempt, extraStreams: mine });
                if (r.fetch?.reqId === myFetchReqId) r.fetch = null;
              } else {
                this.retireBootstrapFetch(conn, myFetchReqId, { attempt });
                if (this.bootstrapFetch?.reqId === myFetchReqId && this.bootstrapFetch.conn === conn) {
                  this.bootstrapFetch = null;
                }
              }
            }
            coord.onFetchError(attempt, 'refused');
          }
        })();
      },
      cancelFetch: () => {
        if (ownedAsCandidate()) {
          const r = this.catalogRecovery!;
          if (r.fetch) {
            const cancelled = r.fetch;
            r.fetch = null;
            const mine: bigint[] = [];
            for (const [sid, a] of r.fetchStreams) {
              if (a === cancelled.attempt) { mine.push(sid); r.fetchStreams.delete(sid); }
            }
            this.retireBootstrapFetch(conn, cancelled.reqId, { attempt: cancelled.attempt, extraStreams: mine });
          }
          return;
        }
        const fetch = this.bootstrapFetch;
        if (fetch?.conn === conn) {
          this.bootstrapFetch = null;
          this.retireBootstrapFetch(conn, fetch.reqId, { attempt: fetch.attempt });
        }
      },
      onReady: (state) => {
        if (!ownedAsCandidate()) return;
        // Adoption barrier: ready AND alias bound AND readiness SETTLED
        // (onReadySettled) — the retained suffix is examined before adoption
        // so a malformed entry aborts the transaction, never the adopted
        // state. The joining fetch can complete while the subscription is
        // still Pending, so the alias half of the barrier matters too.
        this.catalogRecovery!.readyState = state;
      },
      onReadySettled: () => {
        if (ownedAsCandidate()) this.maybeAdoptCatalogRecovery();
      },
      onUpdated: (state) => {
        if (ownedAsCandidate()) {
          // Pre-adoption candidate updates (replayed parked objects after the
          // held readiness) refresh the pending snapshot — the ACTIVE catalog
          // is never mutated by a candidate.
          const r = this.catalogRecovery!;
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
        this.emitError(createPlayerError(
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
      draft: (conn.draftVersion ?? this.config.draftVersion ?? 16) as 14 | 16 | 18,
      // Legacy catalog mode (the explicit 'subscribe' compatibility option):
      // the candidate is a fresh AbsoluteStart subscribe — subscription-only
      // retrieval, ready on the first acceptable base; NEVER a Joining FETCH.
      startMode: this.resolvedCatalogMode(conn) === 'subscribe' ? 'legacy' : 'joining',
      strict: this.strictCatalogMode(),
    });

    this.catalogRecovery = {
      coord, manager, conn, gen, reqId: null, alias: null, fetch: null,
      fetchStreams: new Map(),
      retiredAlias: this.catalogTrackAlias,
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
      try {
        const candidateFilter = this.resolvedCatalogMode(conn) === 'subscribe'
          ? { type: 'AbsoluteStart' as const, startGroup: varint(0n), startObject: varint(0n) }
          : { type: 'LargestObject' as const };
        const reqId = await conn.subscribe(nsBytes, nameBytes, {
          subscriptionFilter: candidateFilter,
          onRequestId: (id: bigint) => {
            const r = this.catalogRecovery;
            if (!live() || !r) return;
            r.reqId = id;
            this.pendingAliasBinds.add(id);
          },
          terminalDelivery: 'drain',
          onDrained: (id: bigint) => {
            const matches = ownedAsCandidate()
              ? this.catalogRecovery!.reqId === id
              : (ownedAsMain() && this.catalogRequestId === id);
            if (!matches) return;
            coord.onSubscriptionDrained();
            if (ownedAsMain() && coord.feedEnded) this.retireCatalogAliasRoute();
          },
        } as never);
        const r = this.catalogRecovery;
        if (!ownedAsCandidate() || !r) return;
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
    const recovery = this.catalogRecovery;
    if (!recovery) return;
    this.catalogRecovery = null;
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
      this.retireBootstrapFetch(recovery.conn, recovery.fetch.reqId,
        { attempt: recovery.fetch.attempt, extraStreams: recovery.fetchStreams.keys() });
    } else {
      for (const sid of recovery.fetchStreams.keys()) this.droppedFetchStreams.add(sid);
    }
    if (recovery.reqId !== null) {
      void recovery.conn.unsubscribe(varint(recovery.reqId)).catch(() => { /* best effort */ });
    }
    this.emitError(createPlayerError(
      'degraded', 'catalog', PlayerErrorCode.CATALOG_DELTA_ERROR,
      `catalog recovery failed (${reason}) — active catalog retained, updates stopped`,
    ));
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
    const r = this.catalogRecovery;
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
    const r = this.catalogRecovery;
    if (r && r.conn === conn && r.reqId !== null) return r.reqId;
    // EVERY unanswered catalog SUBSCRIBE is a live transaction — the
    // coordinator modes AND the coordinator-less legacy retrieval (explicit
    // 'subscribe' mode) and the rung-2 AbsoluteStart resubscribe alike.
    if (conn === this.connection
        && this.catalogRequestId !== null && this.catalogTrackAlias === null) {
      return this.catalogRequestId;
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
    const r = this.catalogRecovery;
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
    const recovery = this.catalogRecovery;
    if (!recovery || recovery.readyState === null || recovery.alias === null) return;
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
    const r = this.catalogRecovery;
    if (r && r.conn === conn) {
      this.failCatalogRecovery('pre-alias parking overflow');
      return;
    }
    const coord = this.catalogBootstrapCoord;
    if (coord && this.connection === conn) {
      if (coord.phase === 'fallback-legacy') {
        // FINAL rung, pre-ready: no further fallback exists — a truncated
        // catalog is never accepted. CLEANUP BEFORE PUBLICATION: the
        // terminating identity is captured and retired first, so a throwing
        // application error listener/filter (invoked synchronously by the
        // coordinator's fatal below, preserving the listener exception
        // contract) can never leave the terminal request or its parking
        // ownership live.
        this.terminateCatalogRetrieval(conn, this.catalogRequestId, null);
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
    if (this.connection === conn && this.catalogRequestId !== null && !this.catalogReceived) {
      this.terminateCatalogRetrieval(conn, this.catalogRequestId,
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
    if (terminatingReqId !== null && this.catalogRequestId === terminatingReqId) {
      this.catalogRequestId = null;
      this.retireCatalogAliasRoute();
      this.legacyCatalogTerminal = null;
    }
    if (terminatingReqId !== null) {
      this.settleParkedOwnership(terminatingReqId, null, conn);
      void conn.unsubscribe(varint(terminatingReqId)).catch(() => { /* best effort */ });
    }
    if (fatalReason !== null) {
      this.emitError(createPlayerError(
        'fatal', 'player', PlayerErrorCode.LOAD_FAILED, fatalReason,
      ));
    }
  }

  /** Atomic adoption: the candidate becomes the active catalog machinery. */
  private adoptCatalogRecovery(state: CatalogState): void {
    const recovery = this.catalogRecovery;
    if (!recovery) return;
    this.catalogRecovery = null;
    // Retire the OLD catalog machinery (its subscription already ended).
    this.catalogBootstrapCoord?.abort();
    this.catalogBootstrapCoord = recovery.coord;
    this.catalogManager = recovery.manager;
    this.catalogRequestId = recovery.reqId;
    // A candidate whose feed already ENDED (drained while awaiting the
    // SUBSCRIBE_OK barrier) is adopted for its CONTENT — the dead alias must
    // not become routable again.
    this.catalogTrackAlias = recovery.coord.feedEnded ? null : recovery.alias;
    // Migrate any live bootstrap fetch-stream tagging.
    for (const [sid, attempt] of recovery.fetchStreams) {
      this.bootstrapFetchStreams.set(sid, { attempt, conn: recovery.conn });
    }
    if (recovery.fetch) {
      this.bootstrapFetch = { conn: recovery.conn, reqId: recovery.fetch.reqId, attempt: recovery.fetch.attempt, gen: this.bootstrapGeneration };
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
  private normalizePublishDoneStatus(code: bigint): PublishDoneReason {
    // NEGOTIATED draft: the status tables differ per draft, and the session's
    // actual draft can diverge from configuration under auto-negotiation.
    const draft = this.connection?.draftVersion ?? this.config.draftVersion ?? 16;
    if (code === 0x2n || code === 0x3n) return 'ended';          // TRACK_ENDED / SUBSCRIPTION_ENDED
    if (code === 0x4n) return 'going-away';                       // GOING_AWAY
    if (code === 0x1n) return 'fatal-track';                      // UNAUTHORIZED
    if (draft === 14 && code === 0x7n) return 'fatal-track';      // d14 MALFORMED_TRACK
    if (draft !== 14 && code === 0x12n) return 'fatal-track';     // d16/18 MALFORMED_TRACK
    // INTERNAL_ERROR(0x0), EXPIRED/TOO_FAR_BEHIND (0x5/0x6, either draft
    // orientation), UPDATE_FAILED(0x8), d18 EXCESSIVE_LOAD(0x9), unknown.
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

    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(trackName);

    const reqId = await this.connection.trackStatus(nsBytes, nameBytes);
    const reqIdBigInt = BigInt(reqId);

    return new Promise<TrackStatusResult>((resolve, reject) => {
      this.pendingTrackStatuses.set(reqIdBigInt, { resolve, reject });
    });
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
    this.log.info('destroy()');
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
    this.subgroupStreamAliases.clear();
    this.pendingMediaSubs.clear();
    this.activeFetches.clear();
    this.fetchStreamAliases.clear();
    this.fetchStreamRequestIds.clear();
    this.pendingFetchStreams.clear();
    this.refusedFetchRequests.clear();
    this.quarantinedFetchRequests.clear();
    this.droppedFetchStreams.clear();
    this.pendingAliasBinds.clear();
    this.pendingObjectsByAlias.clear();
    this.pendingStreamEvents.clear();
    // Clear make-before-break switch state
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
    this.catalogBootstrapCoord?.abort();
    this.catalogBootstrapCoord = null;
    this.catalogRecovery?.coord.abort();
    this.catalogRecovery = null;
    this.bootstrapGeneration += 1;
    this.bootstrapFetch = null;
    this.bootstrapFetchStreams.clear();
    this.rejectPendingCatalogFetches('Player destroyed');
    for (const [name, pending] of this.pendingInitTrackSubs) {
      pending.reject(new Error(`Player destroyed while awaiting init track "${name}"`));
    }
    this.pendingInitTrackSubs.clear();
    this.announcedNamespaces.clear();
    this.commandDispatcher?.destroy();
    this.commandDispatcher = null;
    this.cmafPendingInit = null;
    this.cmafPreInitDropWarned.clear();
    this.cmafInitDeadlineArmed = false;
    this.watchdog.destroy();
    this.cmafAssembler?.destroy();
    this.cmafAssembler = null;
    this.mediaSource?.destroy();
    this.mediaSource = null;
    this.videoPipeline = null;
    this.audioPipeline = null;
    this.syncController = null;
    this.recoveryController = null;
    this.pipelinesCreated = false;
    this.subscriptionManager = null;
    this.catalogManager = null;
    this.qualityController = null;
    this.bandwidthEstimator = null;
    if (this.connection) {
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
        if (this.catalogRequestId !== null) {
          try { await this.connection.unsubscribe(varint(this.catalogRequestId)); } catch { /* ignore */ }
        }
        this.detachConnectionCallbacks(this.connection);
      }
      this.connection = null;
    }
    this.activeSubscriptions.clear();
    if (this.stateMachine.state !== PlayerState.ENDED) {
      this.transitionState(PlayerState.ENDED);
    }
    this.emitter.removeAllListeners();
  }

  /**
   * Detach all player-installed callbacks from a connection so no further
   * adapter activity is surfaced into this (destroyed/destroying) player.
   * Use delete because exactOptionalPropertyTypes forbids assigning undefined.
   */
  private detachConnectionCallbacks(conn: MoqtConnection): void {
    delete conn.onMessage;
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
  ): SubscribeIntent | null {
    const intent: SubscribeIntent = { trackName, mediaType };
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
    const stageable = <A extends unknown[]>(fn: (...a: A) => void, source: MoqtConnectionErrorSource, cost?: (args: unknown[]) => number) => (...args: A): void => {
      if (owningTxn) {
        if (owningTxn.aborted) return; // abandoned candidate — permanently dead
        if (!owningTxn.committed) {
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
      onControlMessage: stageable((msg) => this.handleControlMessage(msg, conn), 'control', msgBytes),

      onClose: (error, reason) => {
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
        this.emitError(createPlayerError(
          classified.severity, 'connection', classified.code, error.message,
          defined({ cause: error, context: classified.context }),
        ));
      },

      onObject: stageable((streamId, obj) => {
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

        const catalogReqId = fetchMapsAuthoritative ? this.catalogFetchStreams.get(streamId) : undefined;
        if (catalogReqId !== undefined) {
          this.handleCatalogFetchObject(catalogReqId, obj);
          return;
        }

        // Staged-recovery candidate fetch stream.
        const recoveryForFetch = this.catalogRecovery;
        if (recoveryForFetch && recoveryForFetch.conn === conn) {
          const rAttempt = recoveryForFetch.fetchStreams.get(streamId);
          if (rAttempt !== undefined) {
            this.emitCatalogRaw(obj);
            recoveryForFetch.coord.onFetchObject(rAttempt, this.toCatalogEvent(obj));
            return;
          }
        }

        // Catalog-bootstrap fetch stream: attempt-tagged, coordinator-owned,
        // and CONNECTION-scoped (stream IDs collide across sessions).
        const bootstrapEntry = this.bootstrapFetchStreams.get(streamId);
        if (bootstrapEntry !== undefined && bootstrapEntry.conn === conn) {
          this.emitCatalogRaw(obj);
          this.catalogBootstrapCoord?.onFetchObject(bootstrapEntry.attempt, this.toCatalogEvent(obj));
          return;
        }

        // §10.4.4: Fetch stream objects carry trackAlias=0 — remap to correct alias
        const fetchAlias = fetchMapsAuthoritative ? this.fetchStreamAliases.get(streamId) : undefined;
        if (fetchAlias !== undefined) {
          this.routeFetchObject(streamId, fetchAlias, obj, conn.draftVersion, conn);
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
          if (pendingFetch.objects.length < MoqtPlayer.MAX_PENDING_PER_ALIAS) {
            pendingFetch.objects.push(obj);
          }
          return;
        }

        const alias = BigInt(obj.trackAlias);

        // A quarantined session's CATALOG alias is classified FIRST: even if
        // the replacement session reuses that alias for a MEDIA track, the old
        // session's late catalog bytes must never enter the media pipeline.
        if (this.quarantinedCatalogAliases.get(conn) === alias) return;

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
          this.subscriptionManager.routeObject(streamId, obj, conn.draftVersion, conn);
          return;
        }

        // Route catalog by track alias (set after SUBSCRIBE_OK §9.10).
        // Never guess the catalog alias — wait for SUBSCRIBE_OK to confirm it.
        // Data may arrive before SUBSCRIBE_OK (§10.4.2); unknown aliases are
        // buffered below and replayed when the alias is resolved.
        // Staged-recovery candidate: its alias routes into the CANDIDATE
        // coordinator only — the active catalog machinery never sees it.
        const recoveryForLive = this.catalogRecovery;
        if (recoveryForLive && recoveryForLive.conn === conn
            && recoveryForLive.alias !== null && alias === recoveryForLive.alias) {
          this.emitCatalogRaw(obj);
          this.catalogLiveStreams.set(streamId, { conn, coord: recoveryForLive.coord });
          recoveryForLive.coord.onLiveStreamEvent(streamId, 'header');
          recoveryForLive.coord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
          return;
        }

        // During staged recovery, the RETIRED catalog alias may be reused by
        // the candidate: its traffic parks in the transaction-local
        // fail-closed buffer (bounded objects/bytes/lifecycle; overflow aborts
        // the candidate) until the candidate SUBSCRIBE_OK binds or refutes it.
        const recoveryPark = this.catalogRecovery;
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

        if (this.catalogTrackAlias !== null && alias === this.catalogTrackAlias) {
          // GOAWAY quarantine: the old session's catalog delivery is dropped
          // unconditionally (the old generation may still be authoritative
          // until migration commits, so this cannot rely on generation checks).
          if (this.catalogQuarantinedConns.has(conn)) return;
          if (this.catalogBootstrapCoord) {
            this.emitCatalogRaw(obj);
            this.catalogLiveStreams.set(streamId, { conn, coord: this.catalogBootstrapCoord });
            this.catalogBootstrapCoord.onLiveStreamEvent(streamId, 'header');
            this.catalogBootstrapCoord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
            return;
          }
          this.handleCatalogObject(obj);
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
          pending.push({ streamId, obj, sourceDraft: conn.draftVersion, sourceConnection: conn, ...(owners ? { owners } : {}) });
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
      }, 'data', objBytes),

      // §10.4: Stream reset vs FIN
      onStreamClosed: stageable((streamId, error, terminal) => {
        // If a pending catalog-fetch's stream closed without delivering
        // an object, reject — otherwise the promise hangs until timeout.
        // (If onObject already settled, the reqId is gone from
        // catalogFetchStreams — this is a no-op.)
        const recoveryClose = this.catalogRecovery;
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
        const bootstrapEntry2 = this.bootstrapFetchStreams.get(streamId);
        if (bootstrapEntry2 !== undefined && bootstrapEntry2.conn === conn) {
          this.bootstrapFetchStreams.delete(streamId);
          this.catalogBootstrapCoord?.onFetchStreamClosed(bootstrapEntry2.attempt, terminal === 'fin');
        }
        // Live catalog stream lifecycle → retained-chain clean-FIN tracking,
        // dispatched to the OWNING coordinator (main or candidate).
        const liveEntry = this.catalogLiveStreams.get(streamId);
        if (liveEntry !== undefined && liveEntry.conn === conn) {
          this.catalogLiveStreams.delete(streamId);
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
        if (this.catalogBootstrapCoord || this.catalogRecovery) {
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

        const subgroupAlias = closeMapsAuthoritative ? this.subgroupStreamAliases.get(streamId) : undefined;
        if (subgroupAlias !== undefined) {
          this.subgroupStreamAliases.delete(streamId); // map never outlives the stream
          if (terminal === 'reset') {
            this.livenessMonitor?.noteStreamReset(subgroupAlias, performance.now());
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
      }, 'data'),

      // §10.4.4: Fetch data stream headers for object routing
      onSubgroupFin: stageable((streamId: bigint, header: SubgroupHeader) => {
        const lifecycle = subgroupLifecycle.get(streamId);
        if (lifecycle === undefined) return;
        subgroupLifecycle.delete(streamId);
        // The header handed back here has its FIRST_OBJECT subgroup id
        // resolved; the one captured at open may still be a placeholder.
        emitSubgroupLifecycle(lifecycle, streamId, header.subgroupId, { terminal: 'fin' });
      }, 'data'),

      onDataStream: stageable((streamId, header) => {
        // Liveness: remember which track each SUBGROUP stream belongs to so
        // a reset can shorten that track's liveness fuse. Subgroup streams
        // only — fetch streams have their own request lifecycle and must
        // never touch track liveness (datagrams have no stream at all).
        if (header.type === 'subgroup') {
          // Liveness bookkeeping is a CURRENT-session concern; a superseded
          // session's header must not overwrite a colliding current stream id.
          if (conn !== this.connection) return;
          const sub = header.header;
          this.subgroupStreamAliases.set(streamId, BigInt(sub.trackAlias));
          const alias = BigInt(sub.trackAlias);
          // Only FIRST_OBJECT defers its subgroup id; ZERO and EXPLICIT are
          // authoritative from the header, so reporting them as unknown would
          // discard a fact we already have.
          const mode = getSubgroupIdMode(sub.typeByte);
          // Track a stream only when its alias is a CONFIRMED video track.
          //
          // A subscription is registered optimistically under its request ID
          // before SUBSCRIBE_OK, because many relays echo the request ID as the
          // track alias — but the two are separate spaces. Trusting that guess
          // could label an audio subgroup, whose real alias happens to equal a
          // pending video request ID, as video. This record exists to settle a
          // root-cause dispute, so it must never classify from a guess.
          //
          // Classification is made once and never revised: a stream opened
          // against an unconfirmed alias is simply never reported, which also
          // means no state is retained for it.
          const confirmed = this.pendingMediaSubs.has(alias)
            ? undefined
            : this.subscriptionManager?.getMediaType(alias);
          if (confirmed !== 'video') return;
          subgroupLifecycle.set(streamId, {
            groupId: sub.groupId,
            endOfGroup: sub.isEndOfGroup,
            subgroupId: mode === SubgroupIdMode.FIRST_OBJECT ? undefined : sub.subgroupId,
          });
          return;
        }
        if (header.type === 'fetch') {
          // See onObject: the fetch registries are current-connection only. A
          // STALE session's fetch stream is tagged so its objects (which carry
          // wire alias 0) are discarded instead of falling through to a real
          // alias-0 route on the current session.
          if (conn !== this.connection) {
            this.staleFetchStreams.set(streamId, conn);
            return;
          }
          const reqId = BigInt(header.header.requestId);
          // Catalog-fetch dispatch: map streamId → reqId so the
          // matching object reaches the pending fetchCatalog promise.
          // Kept separate from fetchStreamAliases because catalog
          // doesn't have (and shouldn't synthesize) a media alias.
          if (this.pendingCatalogFetches.has(reqId)) {
            this.catalogFetchStreams.set(streamId, reqId);
            return;
          }
          // Staged-recovery candidate fetch.
          const recovery = this.catalogRecovery;
          if (recovery && recovery.conn === conn
              && recovery.fetch && recovery.fetch.reqId === reqId) {
            recovery.fetchStreams.set(streamId, recovery.fetch.attempt);
            return;
          }

          // Catalog-bootstrap fetch: connection-scoped ownership, attempt-tagged.
          const bootstrap = this.bootstrapFetch;
          if (bootstrap && bootstrap.reqId === reqId
              && bootstrap.conn === conn && bootstrap.gen === this.bootstrapGeneration) {
            this.bootstrapFetchStreams.set(streamId, { attempt: bootstrap.attempt, conn });
            return;
          }
          // A QUARANTINED request (ownership rolled back after an ambiguous
          // send failure): its late streams are tombstoned, never parked as
          // unowned pending streams awaiting an owner that will never come.
          if (this.quarantinedFetchRequests.has(reqId)) {
            this.droppedFetchStreams.add(streamId);
            return;
          }
          const fetchInfo = this.activeFetches.get(reqId);
          if (fetchInfo) {
            this.fetchStreamAliases.set(streamId, fetchInfo.trackAlias);
            this.fetchStreamRequestIds.set(streamId, reqId);
          } else {
            // §9.16.3 defensive fallback: a stream whose request has no owner
            // yet. Registration is pre-send and synchronous today, so this
            // should not happen — park the stream rather than drop it, and
            // registerMediaFetch() replays the buffered objects if it does.
            // BOUNDED: a peer cycling unknown fetch streams must not grow
            // this for the session lifetime — evict the oldest entry.
            if (this.pendingFetchStreams.size >= MoqtPlayer.MAX_PENDING_FETCH_STREAMS) {
              const oldest = this.pendingFetchStreams.keys().next().value;
              if (oldest !== undefined) {
                const evicted = this.pendingFetchStreams.get(oldest);
                this.pendingFetchStreams.delete(oldest);
                // Keep the CLASSIFICATION for a still-open stream: its later
                // objects are dropped, never alias-routed. A stream that has
                // ALREADY ENDED gets NO tombstone — no close event will ever
                // clear it, and repeated header→terminal→overflow cycles
                // would grow the set forever.
                if (evicted?.terminal === undefined) this.droppedFetchStreams.add(oldest);
              }
            }
            this.pendingFetchStreams.set(streamId, { requestId: reqId, objects: [] });
          }
        }
      }, 'data'),

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

        this.subscriptionManager.routeObject(0n, obj, conn.draftVersion, conn);
      }, 'datagram', dgBytes),

      // §draft-pardue-moq-qlog-moq-events-06: qlog tracing
      ...(this.config.onQlogEvent ? { onQlogEvent: this.config.onQlogEvent } : {}),
    });
  }

  // handleControlMessage → extracted to player-message.ts

  /**
   * Handle control messages for player-level events.
   *
   * @see draft-ietf-moq-transport-16 §9.4 (GOAWAY)
   * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK)
   * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
   * @see draft-ietf-moq-transport-16 §9.7 (REQUEST_OK)
   * @see draft-ietf-moq-transport-16 §9.8 (REQUEST_ERROR)
   */
  private handleControlMessage(msg: ControlMessage, conn: MoqtConnection): void {
    // Ignore control messages from a SUPERSEDED session. After a migration
    // `this.connection`, `activeSubscriptions`, `pendingMediaSubs`, the track
    // registrations, and the catalog alias all belong to the NEW session; a
    // delayed old-session SUBSCRIBE_OK / PUBLISH_DONE / REQUEST_ERROR / GOAWAY
    // processed against them would remap or unregister a current track, settle a
    // current request, or send UNSUBSCRIBE/GOAWAY on the replacement adapter. The
    // old session is closing — its control state is not retained per session.
    if (conn !== this.connection) {
      this.log.info('Ignoring control message from a superseded session: %s', msg.type);
      return;
    }
    if ((msg.type === 'SUBSCRIBE_OK' || msg.type === 'REQUEST_ERROR') && 'requestId' in msg) {
      const answeredReqId = BigInt((msg as { requestId: bigint | number }).requestId);
      const boundAlias = msg.type === 'SUBSCRIBE_OK' && 'trackAlias' in msg
        ? BigInt((msg as { trackAlias: bigint | number }).trackAlias) : null;
      this.settleParkedOwnership(answeredReqId, boundAlias, conn);
    }
    doControlMessage(msg, {
      adapter: this.connection,
      activeSubscriptions: this.activeSubscriptions,
      pendingMediaSubs: this.pendingMediaSubs,
      pendingTrackStatuses: this.pendingTrackStatuses,
      catalogRequestId: this.catalogRequestId,
      catalogTrackAlias: this.catalogTrackAlias,
      subscriptionManager: this.subscriptionManager,
      log: this.log,
      emitEvent: (event) => this.emitter.emit(event.type as any, event as any),
      setCatalogTrackAlias: (alias) => {
        this.catalogTrackAlias = alias;
        this.replayPendingObjects(alias, conn);
      },
      clearCatalogState: () => { this.catalogTrackAlias = null; this.catalogRequestId = null; },
      onAliasResolved: (alias) => { this.replayPendingObjects(alias, conn); },
      onGoaway: (newSessionUri) => {
        // Ignore a GOAWAY from a superseded session (migration overlap).
        if (conn !== this.connection) return;
        if (!this.config.createConnection) return;
        // Catalog quarantine installs IMMEDIATELY at GOAWAY (not only on a
        // going-away PUBLISH_DONE): the old generation may stay authoritative
        // until the migration commits — and the migration may roll back — so
        // late old-session catalog data must never mutate state from here on.
        this.catalogQuarantinedConns.add(conn);
        if (this.catalogTrackAlias !== null) {
          this.quarantinedCatalogAliases.set(conn, this.catalogTrackAlias);
        }
        const uri = newSessionUri || this.config.url;
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
      },
      onPublishDone: (_requestId, trackName, _trackAlias, statusCode, errorReason) => {
        // TOO_FAR_BEHIND means the subscriber fell behind the live edge —
        // resubscribe from the current position instead of giving up; the relay
        // sends fresh data from live. The wire value is VERSION-SPECIFIC: draft-18
        // uses 0x5 (§15.10.3), draft-14/16 use 0x6 (§13.4.3). On draft-18, 0x6 is
        // EXPIRED, so comparing against the wrong table would both miss real
        // TOO_FAR_BEHIND and mis-fire recovery on EXPIRED.
        const tooFarBehind = this.connection?.draftVersion === 18
          ? PublishDoneCode18.TOO_FAR_BEHIND
          : PublishDoneCode.TOO_FAR_BEHIND;
        if (statusCode === BigInt(tooFarBehind)) {
          this.log.warn('PUBLISH_DONE(TOO_FAR_BEHIND) "%s": resubscribing from live edge', trackName);
          this.replaceSubscription(trackName, 'too_far_behind');
          return;
        }

        this.emitter.emit('track_unsubscribed', {
          type: 'track_unsubscribed',
          trackName,
          reason: errorReason,
        });
      },
      onMediaSubscribeOk: (_requestId, _trackName, _mediaType) => {
        this._mediaSubsOk++;
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
        this.catalogBootstrapCoord?.onSubscribeOk(largest);
      },
      onRecoveryCatalogSubscribeOk: (reqId, alias, largest) => {
        const r = this.catalogRecovery;
        if (!r || r.reqId !== reqId) return false;
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
            this.emitCatalogRaw(entry.obj);
            this.catalogLiveStreams.set(entry.streamId, { conn: r.conn, coord: r.coord });
            r.coord.onLiveStreamEvent(entry.streamId, 'header');
            r.coord.onLiveCatalogObject(this.toCatalogEvent(entry.obj), entry.streamId);
          }
          for (const [sid, kind] of events) {
            this.catalogLiveStreams.delete(sid);
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
        if (this.catalogRecovery === r) {
          r.replaying = false;
          this.maybeAdoptCatalogRecovery();
        }
        return true;
      },
      onCatalogBootstrapFetchOk: (requestId, endLocation, endOfTrack) => {
        const r = this.catalogRecovery;
        if (r?.fetch && r.fetch.reqId === requestId) {
          r.coord.onFetchOk(r.fetch.attempt, endLocation, endOfTrack);
          return;
        }
        const fetch = this.bootstrapFetch;
        if (!fetch || fetch.reqId !== requestId || fetch.gen !== this.bootstrapGeneration) return;
        this.catalogBootstrapCoord?.onFetchOk(fetch.attempt, endLocation, endOfTrack);
      },
      onCatalogBootstrapFetchError: (requestId, errorCode) => {
        const r = this.catalogRecovery;
        if (r?.fetch && r.fetch.reqId === requestId) {
          const attempt = r.fetch.attempt;
          r.fetch = null;
          r.coord.onFetchError(attempt, errorCode === this.invalidRangeCode() ? 'invalid-range' : 'refused');
          return;
        }
        const fetch = this.bootstrapFetch;
        if (!fetch || fetch.reqId !== requestId || fetch.gen !== this.bootstrapGeneration) return;
        this.bootstrapFetch = null;
        // INVALID_RANGE (0x11) = track empty; anything else = refusal → ladder.
        this.catalogBootstrapCoord?.onFetchError(fetch.attempt,
          errorCode === this.invalidRangeCode() ? 'invalid-range' : 'refused');
      },
      onRecoveryCatalogRequestError: (reqId) => {
        const r = this.catalogRecovery;
        if (!r || r.reqId !== reqId) return false;
        this.failCatalogRecovery('candidate catalog subscription refused');
        return true;
      },
      onRecoveryCatalogPublishDone: (reqId, statusCode) => {
        const r = this.catalogRecovery;
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
            if (this.catalogTrackAlias !== null) {
              this.quarantinedCatalogAliases.set(this.connection, this.catalogTrackAlias);
            }
          }
        }
        const coord = this.catalogBootstrapCoord;
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
            if (this.catalogTrackAlias !== null) {
              this.quarantinedCatalogAliases.set(this.connection, this.catalogTrackAlias);
            }
          }
          this.retireCatalogAliasRoute();
          this.emitError(createPlayerError(
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
          this.legacyCatalogTerminal = {
            gen: this.bootstrapGeneration,
            reqId: this.catalogRequestId,
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
          for (const [streamId, pending] of this.pendingFetchStreams) {
            if (pending.requestId === requestId) this.pendingFetchStreams.delete(streamId);
          }
          return;
        }
        this.activeFetches.delete(requestId);
        // Non-fatal by design: a refused warm-start (or manual) media fetch
        // just means no pre-roll — the live subscription is untouched and
        // playback starts at the next group boundary.
        this.log.warn('[%s] media FETCH %s for "%s" refused: %s (code=0x%s) — continuing live-only',
          fetchInfo.warmStart ? 'warm-start' : 'fetch',
          requestId, fetchInfo.trackName, errorReason, errorCode.toString(16));
      },
      onMediaAliasRemapped: (_requestId, oldAlias, newAlias) => {
        // §9.10: the server assigned a different track alias — fetch
        // bookkeeping registered under the optimistic alias must follow, or
        // a warm-start fetch's objects orphan on relays that don't echo the
        // request ID as the alias.
        for (const info of this.activeFetches.values()) {
          if (info.trackAlias === oldAlias) info.trackAlias = newAlias;
        }
        for (const [streamId, alias] of this.fetchStreamAliases) {
          if (alias === oldAlias) this.fetchStreamAliases.set(streamId, newAlias);
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

    // Two-phase replay: EVERY object is delivered first; each stream's
    // terminal event (fin/reset) is delivered exactly once AFTERWARDS. A
    // multi-object stream must never see its terminal replayed between its
    // own objects — that would corrupt the clean-chain evidence for an
    // otherwise valid independent-plus-delta sequence.
    const terminalTargets = new Map<bigint, CatalogBootstrap | null>();
    for (const { streamId, obj, sourceDraft, sourceConnection } of replay) {
      // Re-route through the normal onObject path — alias is now resolved
      const resolvedAlias = BigInt(obj.trackAlias);

      if (sourceConnection !== undefined
          && this.quarantinedCatalogAliases.get(sourceConnection) === resolvedAlias) {
        continue; // a quarantined session's catalog alias — never re-attributed
      }
      if (this.subscriptionManager?.getMediaType(resolvedAlias) !== undefined) {
        // Route with the delivering session's own draft + connection.
        this.subscriptionManager.routeObject(streamId, obj, sourceDraft, sourceConnection);
        if (!terminalTargets.has(streamId)) terminalTargets.set(streamId, null);
      } else if (this.catalogRecovery !== null
          && this.catalogRecovery.alias !== null
          && resolvedAlias === this.catalogRecovery.alias
          && this.catalogRecovery.conn === sourceConnection) {
        const rec = this.catalogRecovery;
        this.emitCatalogRaw(obj);
        this.catalogLiveStreams.set(streamId, { conn: rec.conn, coord: rec.coord });
        rec.coord.onLiveStreamEvent(streamId, 'header');
        rec.coord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
        terminalTargets.set(streamId, rec.coord);
      } else if (this.catalogTrackAlias !== null && resolvedAlias === this.catalogTrackAlias) {
        if (sourceConnection !== undefined && this.catalogQuarantinedConns.has(sourceConnection)) continue;
        if (this.catalogBootstrapCoord) {
          this.emitCatalogRaw(obj);
          if (sourceConnection !== undefined) this.catalogLiveStreams.set(streamId, { conn: sourceConnection, coord: this.catalogBootstrapCoord });
          this.catalogBootstrapCoord.onLiveStreamEvent(streamId, 'header');
          this.catalogBootstrapCoord.onLiveCatalogObject(this.toCatalogEvent(obj), streamId);
          terminalTargets.set(streamId, this.catalogBootstrapCoord);
        } else {
          this.handleCatalogObject(obj);
          if (!terminalTargets.has(streamId)) terminalTargets.set(streamId, null);
        }
      } else if (!terminalTargets.has(streamId)) {
        terminalTargets.set(streamId, null);
      }
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
          this.catalogLiveStreams.delete(streamId);
          coord.onLiveStreamEvent(streamId, closed.terminal);
        }
      }
      if (perConn.size === 0) this.pendingStreamEvents.delete(resolvingConnection);
    }
  }

  private handleCatalogObject(obj: MoqtObject): void {
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
    }

    try {
      const catalogState = this.catalogManager!.processCatalogObject(obj.payload);

      if (!this.catalogReceived) {
        this.catalogReceived = true;
        this._catalogState = catalogState;
        this._stats.recordCatalogReceived();
        this.watchdog.fulfill('catalog_received');
        this.watchdog.expect('first_media_object', 20_000);
        this.log.info('Catalog received: %d tracks', catalogState.tracks.length);
        this.emitter.emit('catalog_received', {
          type: 'catalog_received',
          catalog: catalogState,
        });

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
          this.qualityController.selectInitialTracks(catalogState, defined({
            videoConstraints: this.config.videoConstraints,
            audioConstraints: this.config.audioConstraints,
            ...(this.config.disableVideo ? { disableVideo: true } : {}),
            ...(this.config.disableAudio ? { disableAudio: true } : {}),
          }));
          this.validateKnownTracks(catalogState);
        } else {
          // Standard path — catalog-first: create pipelines and subscribe
          this.subscribeToMediaTracks(catalogState).catch((err) => {
            this.log.error('subscribeToMediaTracks failed: %s', err?.message ?? err);
            this.emitError(createPlayerError(
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
      const severity: ErrorSeverity = this.catalogReceived ? 'degraded' : 'fatal';
      const code = this.catalogReceived
        ? PlayerErrorCode.CATALOG_DELTA_ERROR
        : PlayerErrorCode.CATALOG_PARSE_ERROR;
      const cause = err instanceof Error ? err : new Error(String(err));
      this.emitError(createPlayerError(severity, 'catalog', code, cause.message, { cause }));
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
      onFirstFrame: () => {
        this._stats.recordFirstFrameRendered();
        this.watchdog.fulfill('cmaf_first_frame'); // bootstrap deadline met
        this.log.info('First frame rendered');
        this.emitter.emit('first_frame', { type: 'first_frame' });
      },
      onStallRecovered: (durationMs) => {
        this._stats.recordStallRecovered(durationMs);
        this.emitter.emit('stall_recovered', { type: 'stall_recovered', durationMs });
      },
      onStall: (durationMs) => {
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
        this._stats.recordStallRecovered(durationMs);
        this.emitter.emit('stall_recovered', { type: 'stall_recovered', durationMs });
      };
      this.mediaSource.onStall = (durationMs, cause) => {
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
      if (trackInfo.video?.packaging === 'cmaf' && trackInfo.video.codec) {
        this.cmafPendingInit.video = {
          codec: trackInfo.video.codec,
          bytes: trackInfo.video.initData ? decodeBase64(trackInfo.video.initData) : null,
        };
      }
      if (trackInfo.audio?.packaging === 'cmaf' && trackInfo.audio.codec) {
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
    if (this.mediaSource.initialize(msConfig) === false) {
      this.log.warn('CMAF initialize rejected by the media source adapter — not marking initialized');
      return;
    }
    this.cmafInitialized = true;
    this.cmafVideoSynced = false; // wait for a keyframe after init
    // Record the codec for change-type detection on future switches.
    // (Audio codec switches aren't currently exposed in the API.)
    if (this.cmafPendingInit.video?.codec) this.currentVideoCodec = this.cmafPendingInit.video.codec;

    this.buildCmafAssembler();
    // Hand init bytes to the assembler so its strip path can fall back to
    // trex defaults for streams without tfhd sample defaults.
    for (const [mt, e] of entries) this.cmafAssembler?.setInitSegment?.(mt, e.bytes!);

    this._stats.recordDecoderConfigured();
    this.watchdog.fulfill('cmaf_init');
    if (this.config.cmafBootstrapTimeoutMs! > 0) {
      // Second bootstrap deadline: initialized but never rendered a frame
      // (codec/init mismatch class) must not be a silent black player.
      this.watchdog.expect('cmaf_first_frame', this.config.cmafBootstrapTimeoutMs!);
    }
    this.log.info('CMAF MediaSource initialized (%s)',
      entries.map(([mt, e]) => `${mt}=${e.bytes!.byteLength}B`).join(' '));
  }

  /** Create the moof+mdat assembler wired to the MediaSource (single site). */
  private buildCmafAssembler(): void {
    const ms = this.mediaSource!;
    const timestampOffsetSet = { video: false, audio: false };
    if (!this.config.createCmafAssembler) {
      throw new Error('CMAF tracks require createCmafAssembler in MoqtPlayerConfig');
    }
    this.cmafAssembler = this.config.createCmafAssembler({
      onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, segTrackName: string, groupId: bigint) => {
        if (!timestampOffsetSet[mediaType]) {
          timestampOffsetSet[mediaType] = true;
          if ('setTimestampOffset' in ms) {
            (ms as { setTimestampOffset: (t: string, o: number) => void }).setTimestampOffset(mediaType, 0);
          }
        }
        ms.appendChunk(mediaType, segment, segTrackName, groupId);
      },
      onDiscontinuity: (mediaType, trackName) => {
        if ('clearTimeline' in ms) {
          (ms as { clearTimeline: (t: string, tn: string) => void }).clearTimeline(mediaType, trackName);
        }
      },
    });
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
  ): void {
    if (MoqtPlayer.looksLikeCmafInitSegment(payload)) {
      this.log.info('[CMAF] in-band init segment on "%s" (%s, %dB)',
        trackName, mediaType, payload.byteLength);
      // Cache for codec-changing switches, same as initTrack deliveries.
      this.initSegmentByTrack.set(trackName, payload);
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
      this.watchdog.expect('cmaf_init', this.config.cmafBootstrapTimeoutMs!);
    }
  }

  /**
   * Subscribe to video and audio tracks selected by the QualityController.
   *
   * Each subscription passes through the beforeSubscribe hook.
   * Tracks are registered in SubscriptionManager for object routing.
   * Subscriptions are fired in parallel via Promise.all.
   *
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup for ABR selection)
   * @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
   * @see draft-ietf-moq-transport-16 §9.5 (MAX_REQUEST_ID — parallel subscriptions)
   */
  private async subscribeToMediaTracks(catalog: CatalogState): Promise<void> {
    this._mediaSubsExpected = 0;
    this._mediaSubsOk = 0;
    this._mediaSubsFailed = 0;
    const selected = this.qualityController!.selectInitialTracks(catalog, defined({
      videoConstraints: this.config.videoConstraints,
      audioConstraints: this.config.audioConstraints,
      ...(this.config.disableVideo ? { disableVideo: true } : {}),
      ...(this.config.disableAudio ? { disableAudio: true } : {}),
    }));

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
      if (!track || track.packaging !== 'cmaf') continue;
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
        this.emitError(createPlayerError(
          'fatal', 'catalog', PlayerErrorCode.CMAF_INIT_INVALID,
          `CMAF track "${track.name}" (${mediaType}): ${reason} — cannot configure MSE`,
          { context: { trackName: track.name, mediaType } },
        ));
        if (!this.isTerminalState()) this.transitionState(PlayerState.ERROR);
        return;
      }
    }

    // Build buffer-based ABR controller from the quality ladder
    const alts = this.qualityController!.alternatives;
    if (alts.length > 1) {
      const ladder: AbrTrack[] = alts.map(t => ({
        name: t.name,
        bitrateKbps: (t.bitrate ?? 0) / 1000,
      }));
      this.bufferAbrController = new BufferBasedController({
        clock: this.clock,
        ladder,
        initialIndex: this.qualityController!.currentIndex,
        lowThresholdUs: 500_000,      // 0.5s → emergency downshift
        highThresholdUs: 4_000_000,   // 4s → consider upshift
      });
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
    const videoPackaging: TrackPackaging = (selected.video?.packaging === 'cmaf') ? 'cmaf' : 'loc';
    const audioPackaging: TrackPackaging = (selected.audio?.packaging === 'cmaf') ? 'cmaf' : 'loc';

    this.createPipelinesFromTrackInfo({
      video: selected.video ? defined({
        codec: selected.video.codec,
        width: selected.video.width,
        height: selected.video.height,
        initData: this.resolveInlineInitData(selected.video),
        initTrack: selected.video.initTrack,
        packaging: videoPackaging,
      }) : undefined,
      audio: selected.audio ? defined({
        codec: selected.audio.codec,
        samplerate: selected.audio.samplerate,
        channels: selected.audio.channelConfig ? Number(selected.audio.channelConfig) : undefined,
        initData: this.resolveInlineInitData(selected.audio),
        initTrack: selected.audio.initTrack,
        packaging: audioPackaging,
      }) : undefined,
      isLive: selected.video?.isLive === true || selected.audio?.isLive === true,
    });

    // ── Subscribe to selected tracks (parallel) ──────────────────
    // §9.5: Multiple SUBSCRIBEs can be in-flight simultaneously.

    const tracks: Array<{ name: string; mediaType: 'video' | 'audio'; packaging: TrackPackaging }> = [];
    if (selected.video) tracks.push({ name: selected.video.name, mediaType: 'video', packaging: videoPackaging });
    if (selected.audio) tracks.push({ name: selected.audio.name, mediaType: 'audio', packaging: audioPackaging });

    await Promise.all(tracks.map(async ({ name, mediaType, packaging }) => {
      // Guard: if destroyed during async subscription, bail out
      if (!this.subscriptionManager || !this.connection) return;

      // §5.1: Run through beforeSubscribe hook — null cancels the subscription
      const intent = this.hooks.beforeSubscribe.run({ trackName: name, mediaType });
      if (!intent) return;
      this._mediaSubsExpected++;

      const nsBytes = encodeNamespace(this.config.namespace, this.enc);
      const nameBytes = this.enc.encode(name);
      // Live media defaults to NextGroupStart (start at keyframe boundary).
      // Non-live/VOD defaults to AbsoluteStart {0,0} (start from beginning).
      const track = mediaType === 'video' ? selected.video : selected.audio;

      // Warm start (§5.1.3): a live LOC track subscribes with the Largest
      // Object filter so a relative Joining FETCH can prepend the current
      // group's head (issued below). CMAF is excluded — its MSE append path
      // is not warm-start safe (see cmafBootstrap notes) — and non-live
      // tracks already start from group 0. Config validation guarantees any
      // explicit subscriptionFilter is LargestObject when warm start is on.
      const warmStart = this.config.warmStartCurrentGroup === true
        && track?.isLive === true
        && packaging !== 'cmaf';
      if (this.config.warmStartCurrentGroup === true && packaging === 'cmaf') {
        this.log.warn('[warm-start] CMAF track "%s" skipped — LOC only in this slice', name);
      }
      // Warm start overrides ONLY the filter — configured subscribe options
      // (deliveryTimeout, subscriberPriority, groupOrder) are preserved.
      const mediaOptions = warmStart
        ? { ...(subscribeOptions ?? {}), subscriptionFilter: { type: 'LargestObject' as const } }
        : (subscribeOptions ?? defaultMediaSubscriptionFilter(track?.isLive === true));
      // Pre-send ownership (§9.10): register inside onRequestId — a
      // zero-latency SUBSCRIBE_OK must find the pending entry (and the
      // requestId-as-alias optimistic registration) already in place. Adapters
      // that don't invoke the callback fall back to post-await registration.
      const connAtSubscribe = this.connection;
      let subRegistered = false;
      const registerMediaSub = (reqIdBigInt: bigint): void => {
        if (subRegistered) return;
        subRegistered = true;
        if (!this.subscriptionManager || this.connection !== connAtSubscribe) return;
        this.pendingAliasBinds.add(reqIdBigInt);
        this.activeSubscriptions.set(reqIdBigInt, { trackName: name, mediaType, trackAlias: reqIdBigInt });
        // Register immediately using requestId as alias — many relays
        // echo requestId as trackAlias. If SUBSCRIBE_OK provides a
        // different alias, the registration is updated in handleControlMessage.
        this.subscriptionManager.registerTrack(reqIdBigInt, name, mediaType, packaging);
        this.pendingMediaSubs.set(reqIdBigInt, { trackName: name, mediaType, packaging });
      };
      let registeredId: bigint | null = null;
      let reqIdBigInt: bigint;
      try {
        const reqId = await this.connection.subscribe(nsBytes, nameBytes,
          { ...mediaOptions, onRequestId: (id: bigint) => { registeredId = id; registerMediaSub(id); } } as never);
        reqIdBigInt = BigInt(reqId);
        registerMediaSub(reqIdBigInt);
      } catch (err) {
        // The send failed AFTER pre-send registration: undo the ownership so
        // no phantom pending/optimistic-alias entry survives a request the
        // peer never (usably) received.
        if (registeredId !== null) {
          this.settleParkedOwnership(registeredId, null, connAtSubscribe);
          this.activeSubscriptions.delete(registeredId);
          this.subscriptionManager?.unregisterTrack(registeredId);
          this.pendingMediaSubs.delete(registeredId);
        }
        throw err;
      }

      // Re-check after await — destroy() may have been called
      if (!this.subscriptionManager) return;

      if (warmStart) {
        // §9.16.2 / §10.12.2: a Joining Fetch may reference a PENDING
        // subscription, so this is issued immediately after SUBSCRIBE without
        // awaiting SUBSCRIBE_OK. Registering the fetch under the LIVE track's
        // alias routes its objects through the same pipeline as live delivery
        // (onDataStream → fetchStreamAliases → onObject remap). Failure here
        // is never fatal — playback continues live-only from the next group.
        try {
          const connAtCall = this.connection;
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
            if (!this.subscriptionManager || this.connection !== connAtCall) {
              this.log.debug('[warm-start] joining FETCH %s completed after teardown/migration — ignored', id);
              registered = true; // suppress the post-await fallback too
              return;
            }
            registered = true;
            warmFetchId = id;
            this.registerMediaFetch(id, {
              trackName: name, mediaType, trackAlias: reqIdBigInt, warmStart: true,
            });
          };
          try {
            const fetchReqId = await this.connection.joiningFetch({
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
            if (warmFetchId !== null) {
              this.activeFetches.delete(warmFetchId);
              for (const [sid, mappedReq] of this.fetchStreamRequestIds) {
                if (mappedReq === warmFetchId) {
                  this.fetchStreamRequestIds.delete(sid);
                  this.fetchStreamAliases.delete(sid);
                  this.droppedFetchStreams.add(sid);
                }
              }
              // Tombstone the request: late traffic quarantines (dropped, not
              // parked unowned) until the session boundary reclaims it.
              this.quarantineFetchRequest(warmFetchId);
            }
            throw err;
          }
        } catch (err) {
          this.log.warn('[warm-start] joining FETCH failed for "%s" — continuing live-only: %s',
            name, err instanceof Error ? err.message : String(err));
        }
      }

      this.log.info('Subscribe %s "%s" requestId=%s', mediaType, name, reqIdBigInt);
      this.emitter.emit('track_subscribed', {
        type: 'track_subscribed',
        trackName: name,
        mediaType,
        requestId: reqIdBigInt,
      });
    }));

    // ── Auto-subscribe to mediatimeline track (§7.2) ──────────────
    // §7: A mediatimeline track provides PTS→location mapping for seek.
    // §7.2: MUST have depends, mimeType "application/json".
    const timelineTrack = catalog.tracks.find(
      (t: CatalogTrack) => t.packaging === 'mediatimeline',
    );
    if (timelineTrack && this.connection && this.subscriptionManager) {
      this.timelineState = createTimelineState(timelineTrack);

      const nsBytes = encodeNamespace(this.config.namespace, this.enc);
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
    const initTrackNames = new Set<string>();
    if (selected.video?.initTrack) initTrackNames.add(selected.video.initTrack);
    if (selected.audio?.initTrack) initTrackNames.add(selected.audio.initTrack);

    for (const initName of initTrackNames) {
      if (!this.connection || !this.subscriptionManager) break;

      const nsBytes = encodeNamespace(this.config.namespace, this.enc);
      const nameBytes = this.enc.encode(initName);
      const initOptions = {
        subscriptionFilter: {
          type: 'AbsoluteStart' as const,
          startGroup: varint(0n),
          startObject: varint(0n),
        },
      };
      // mediaType 'video' is a placeholder — routing is driven by packaging.
      const reqIdBigInt = await this.subscribeAuxTrackOwned(nsBytes, nameBytes, initOptions, {
        trackName: initName, mediaType: 'video', packaging: 'init',
      }, (id) => { this.initTrackRequestIds.set(initName, id); },
      (id) => { if (this.initTrackRequestIds.get(initName) === id) this.initTrackRequestIds.delete(initName); });
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
    const selectedNames = new Set<string>();
    if (selected.video) selectedNames.add(selected.video.name);
    if (selected.audio) selectedNames.add(selected.audio.name);

    const eventTimelineTracks = catalog.tracks.filter(
      (t: CatalogTrack) =>
        t.packaging === 'eventtimeline' &&
        Array.isArray(t.depends) &&
        t.depends.some((dep: string) => selectedNames.has(dep)),
    );

    for (const evtTrack of eventTimelineTracks) {
      if (!this.connection || !this.subscriptionManager) break;

      const nsBytes = encodeNamespace(this.config.namespace, this.enc);
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
  }

  /**
   * Subscribe an auxiliary track (mediatimeline / init / eventtimeline) with
   * PRE-SEND ownership: registration in activeSubscriptions / the
   * SubscriptionManager / pendingMediaSubs happens inside `onRequestId`
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
  ): Promise<bigint> {
    const conn = this.connection;
    if (!conn) throw new Error('subscribeAuxTrackOwned: no connection');
    let registered: bigint | null = null;
    const register = (reqId: bigint): void => {
      if (registered !== null) return;
      registered = reqId;
      if (!this.subscriptionManager || this.connection !== conn) return;
      this.pendingAliasBinds.add(reqId);
      this.activeSubscriptions.set(reqId, {
        trackName: info.trackName, mediaType: info.mediaType, trackAlias: reqId,
      });
      this.subscriptionManager.registerTrack(reqId, info.trackName, info.mediaType, info.packaging);
      this.pendingMediaSubs.set(reqId, {
        trackName: info.trackName, mediaType: info.mediaType, packaging: info.packaging,
      });
      onRegistered?.(reqId);
    };
    try {
      const reqId = await conn.subscribe(nsBytes, nameBytes,
        { ...((options as object | undefined) ?? {}), onRequestId: (id: bigint) => register(BigInt(id)) } as never);
      register(BigInt(reqId));
      return BigInt(reqId);
    } catch (err) {
      if (registered !== null) {
        this.settleParkedOwnership(registered, null, conn);
        this.activeSubscriptions.delete(registered);
        this.subscriptionManager?.unregisterTrack(registered);
        this.pendingMediaSubs.delete(registered);
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
      .filter(([requestId, sub]) => sub.mediaType === mediaType && requestId !== this.timelineRequestId);

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
      if (sub.mediaType !== 'video' && sub.mediaType !== 'audio') continue;
      if (requestId === this.catalogRequestId || requestId === this.timelineRequestId) continue;
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
        if (attempt === 1 && await this.tryRefreshSubscription(track)) {
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
    if (catalogTrack?.packaging === 'cmaf') {
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
      sub.trackName === track.trackName && sub.mediaType === track.mediaType);
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
    for (const [requestId, sub] of [...this.activeSubscriptions.entries()]) {
      if (sub.trackName !== track.trackName || sub.mediaType !== track.mediaType) continue;
      this.subscriptionManager.unregisterTrack(sub.trackAlias);
      this.settleParkedOwnership(requestId, null, this.connection);
      // Async — a sync try/catch would let the rejection escape. Best-effort:
      // the request stream may have died with the delivery path.
      void this.connection.unsubscribe(varint(requestId)).catch(() => { /* gone */ });
      this.activeSubscriptions.delete(requestId);
      this.pendingMediaSubs.delete(requestId);
      this.pendingObjectsByAlias.delete(sub.trackAlias);
    }
    this.replaceSubscription(track.trackName, 'liveness');
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
  ): void {
    if (!this.connection || !this.subscriptionManager || !this._catalogState) return;

    // Don't resurrect the OLD track during a make-before-break switch —
    // that would fight the switch by resubscribing to a track we're
    // intentionally abandoning.
    if (this.pendingVideoSwitch?.oldTrackName === trackName) {
      this.log.info('Ignoring %s replacement for "%s" — pending switch to "%s"',
        cause, trackName, this.pendingVideoSwitch.newTrackName);
      return;
    }

    const track = this._catalogState.tracks.find((t: CatalogTrack) => t.name === trackName);
    if (!track) {
      this.log.warn('Cannot resubscribe "%s": track not found in catalog', trackName);
      return;
    }

    const mediaType: 'video' | 'audio' = track.role === 'audio' ? 'audio' : 'video';
    const packaging = (track.packaging === 'cmaf') ? 'cmaf' : 'loc';
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

    const nsBytes = encodeNamespace(this.config.namespace, this.enc);
    const nameBytes = this.enc.encode(trackName);
    const filter = defaultMediaSubscriptionFilter(isLive);

    // Pre-send ownership (§9.10): a same-tick SUBSCRIBE_OK must find the
    // pending entry; the EVENT still waits for the send to succeed.
    const resubConn = this.connection;
    let resubRegisteredId: bigint | null = null;
    const registerResub = (id: bigint): void => {
      if (resubRegisteredId !== null) return;
      resubRegisteredId = id;
      if (!this.subscriptionManager || this.connection !== resubConn) return;
      this.pendingAliasBinds.add(id);
      this.activeSubscriptions.set(id, { trackName, mediaType, trackAlias: id });
      this.subscriptionManager.registerTrack(id, trackName, mediaType, packaging);
      this.pendingMediaSubs.set(id, { trackName, mediaType, packaging });
    };
    // Start through the CAPTURED connection and attach both observers before
    // publishing: a recovery listener may synchronously destroy or migrate the
    // player, and `this.connection` is mutable. Announcing afterwards also
    // makes the event's contract true — the replacement has really started.
    const pending = resubConn.subscribe(nsBytes, nameBytes,
      { ...(filter ?? {}), onRequestId: (id: bigint) => registerResub(BigInt(id)) } as never,
    ).then((reqId) => {
      const reqIdBigInt = BigInt(reqId);
      if (!this.subscriptionManager) return;
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
        this.settleParkedOwnership(resubRegisteredId, null, resubConn);
        this.activeSubscriptions.delete(resubRegisteredId);
        this.subscriptionManager?.unregisterTrack(resubRegisteredId);
        this.pendingMediaSubs.delete(resubRegisteredId);
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
      if (this.connection) this.settleParkedOwnership(matchedRequestId, null, this.connection);
      this.connection?.unsubscribe(varint(matchedRequestId));

      // Clean up local state
      this.activeSubscriptions.delete(matchedRequestId);
      this.subscriptionManager?.unregisterTrack(trackAlias);

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
