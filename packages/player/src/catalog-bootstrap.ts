/**
 * CatalogBootstrap — the MSF-01 §5 catalog-access coordinator.
 *
 * MSF-01 §5: "Subscribers accessing the catalog MUST use SUBSCRIBE with a
 * Joining FETCH (offset = 0) in order to obtain the latest complete catalog
 * along with all subsequent catalog objects, including delta updates, that
 * follow." The fetch delivers the current group's independent head plus its
 * deltas (the prefix); the LargestObject subscription delivers strictly after
 * (the suffix) — contiguous and non-overlapping by publisher construction
 * (draft-16 §9.16.2.1 / draft-18 §10.12.2.1).
 *
 * This coordinator owns convergence: ordering without density assumptions,
 * exactly-once application, profile-specific base rules, the fallback ladder,
 * and readiness. It is a pure state machine — all transport I/O is injected —
 * so interleavings are unit-testable.
 *
 * Key rules (each was a review finding; see the design plan):
 * - Prefix completion requires FETCH_OK AND a clean data-stream FIN. There is
 *   no "short FIN" detection: Object IDs may be sparse, so shortness is
 *   undetectable from locations, and QUIC reliability means truncation
 *   manifests as RESET, never a clean FIN.
 * - Fetch objects apply in ascending delivery order (verified, never
 *   reordered); markers are non-decreasing and a payload at a prior marker's
 *   location is accepted (a d18 End-of-Range marker sits at the NEXT location,
 *   which a later real object may fill).
 * - The live suffix buffers until the prefix concludes, then releases in
 *   ascending order through exact-location dedup. Overflow fails the bootstrap
 *   (never silently drops — deltas are non-skippable).
 * - Profile-specific base rules: MSF-01/CMSF-01 (string version) require the
 *   independent at object 0 — a delta or misplaced independent at the head
 *   means the group's base is missing and an OLDER group's independent cannot
 *   substitute → wait for a newer head (never full-history). MSF-00 (numeric
 *   version) accepts the first EXISTING object of the group as the
 *   independent. CF-01 patches chain across groups → only full history can
 *   reconstruct → rung-1 full-history fetch.
 * - PUBLISH_DONE is status-aware and NOT a delivery barrier: the player's
 *   terminal drain delivers late objects first; DONE state rules apply at
 *   `onSubscriptionDrained()`.
 *
 * @see draft-ietf-moq-msf-01 §5
 * @see draft-ietf-moq-transport-16 §9.16.2
 * @see draft-ietf-moq-transport-18 §10.12.2
 * @module
 */

import type { DataStreamTerminal } from '@moqt/webtransport';
import type { CatalogState } from '@moqt/msf';

/** Inactivity/progress deadline for an ACTIVE attempt (ms). Re-armed on every
 *  fetch object / FETCH_OK, and — in the waiting states — on live catalog
 *  activity. Deliberately below the player's 10 s catalog watchdog so a failed
 *  attempt still has fallback budget. NOT a total-duration limit: a slow but
 *  progressing full-history CF-01 fetch survives indefinitely. */
export const CATALOG_BOOTSTRAP_INACTIVITY_MS = 5_000;

/** Suffix hold-buffer bounds. Overflow FAILS the bootstrap (fallback ladder) —
 *  evicting a delta would bless incomplete state. */
const MAX_SUFFIX_OBJECTS = 256;
const MAX_SUFFIX_BYTES = 4 * 1024 * 1024;

export type BootstrapPhase =
  | 'idle' | 'joining' | 'fetching' | 'ready' | 'live'
  | 'empty-wait' | 'await-first-payload' | 'await-newer-head'
  | 'fallback-legacy' | 'aborted' | 'fatal';

/** Normalized PUBLISH_DONE terminal reason (mapped per-draft by the player). */
export type PublishDoneReason = 'ended' | 'retriable' | 'fatal-track' | 'going-away';

export interface CatalogObjectEvent {
  readonly location: { readonly group: bigint; readonly object: bigint };
  readonly kind: 'payload' | 'gap';
  readonly payload?: Uint8Array;
  /** Status-aware gap classification: Object-Does-Not-Exist vs EOR/EOG/EOT
   *  terminators. Only a MISSING status can mean "missing base"; a terminator
   *  is range accounting and never blocks anything. */
  readonly gapKind?: 'missing' | 'terminator';
}

export interface CatalogBootstrapCallbacks {
  /** Apply via CatalogManager.processCatalogObjectAt — throws on parse errors.
   *  `pruneBeforeOnSuccess` (independent heads only) atomically retires the
   *  provably obsolete dedup entries AFTER a successful apply — a failed
   *  replacement must leave the old catalog's replay protection intact. */
  applyAt(
    location: { group: bigint; object: bigint },
    payload: Uint8Array,
    opts?: { pruneBeforeOnSuccess?: bigint },
  ): { outcome: 'applied'; state: CatalogState } | { outcome: 'duplicate' };
  /** Full CatalogManager reset (rung transaction / clean base). */
  resetManager(): void;
  currentState(): CatalogState | null;
  /** Issue the relative Joining FETCH (offset 0) for `attempt`. */
  issueJoiningFetch(attempt: number): void;
  /** Issue a standalone FETCH for `attempt`. End is the whole-group
   *  `End.Object = 0` encoding of `endGroupWholeOf` — no successor arithmetic,
   *  no uint64 overflow. */
  issueStandaloneFetch(
    range: { startGroup: bigint; startObject: bigint; endGroupWholeOf: bigint },
    attempt: number,
  ): void;
  /** Cancel the current attempt's fetch (fetchCancel — per-draft in the adapter). */
  cancelFetch(): void;
  /** Readiness: run the first-catalog block (catalog_received, media subscribe). */
  onReady(state: CatalogState): void;
  /** Readiness SETTLED: the retained suffix/chain has been fully examined
   *  after onReady. Staged-recovery adoption anchors here so a malformed
   *  retained delta aborts the transaction instead of degrading an
   *  already-adopted snapshot. */
  onReadySettled?(): void;
  /** Post-readiness application (catalog_updated). */
  onUpdated(state: CatalogState): void;
  /** Rung 2: unsubscribe + fresh AbsoluteStart{0,0} subscribe. */
  requestLegacyResubscribe(): void;
  /** Terminal failure (pre-first-catalog severity model: fatal). */
  onFatal(reason: string): void;
  /** Post-readiness catalog fault (degraded, matching the legacy model). */
  onDegraded(reason: string): void;
  /**
   * Post-base retriable PUBLISH_DONE (drained): the live catalog feed ended
   * recoverably. The player runs the staged-recovery transaction — candidate
   * coordinator + manager, atomic adoption, active catalog untouched on
   * failure, no recursion.
   */
  requestStagedRecovery(): void;
  log(message: string, ...args: unknown[]): void;
}

/** Payload classification (peek — no state mutation). */
type Classified =
  | { kind: 'cf01-patch' }
  | { kind: 'msf-delta' }
  | { kind: 'independent'; profile: 'msf01' | 'msf00' | 'cf01' | 'unknown' };

function classify(payload: Uint8Array): Classified {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { kind: 'independent', profile: 'unknown' }; // let applyAt surface the parse error
  }
  if (Array.isArray(raw)) return { kind: 'cf01-patch' };
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj['deltaUpdate'] !== undefined) return { kind: 'msf-delta' };
    if ('streamingFormat' in obj) return { kind: 'independent', profile: 'cf01' };
    if (typeof obj['version'] === 'number') return { kind: 'independent', profile: 'msf00' };
    if (typeof obj['version'] === 'string') return { kind: 'independent', profile: 'msf01' };
  }
  return { kind: 'independent', profile: 'unknown' };
}

const locKey = (l: { group: bigint; object: bigint }) => `${l.group}:${l.object}`;
const locCmp = (a: { group: bigint; object: bigint }, b: { group: bigint; object: bigint }): number =>
  a.group !== b.group ? (a.group < b.group ? -1 : 1) : (a.object === b.object ? 0 : (a.object < b.object ? -1 : 1));

interface SuffixEntry {
  location: { group: bigint; object: bigint };
  payload: Uint8Array;
  streamId: bigint;
}

/** Per-fetch-attempt state; retired wholesale on every rung transition. */
interface Attempt {
  readonly id: number;
  readonly kind: 'joining' | 'emulation' | 'cf01-history';
  /** Last observed location on the fetch stream (payloads AND markers), for
   *  the ascending check. Markers are non-decreasing; payload at a marker's
   *  exact location is accepted. */
  lastLoc: { group: bigint; object: bigint } | null;
  lastWasMarker: boolean;
  anyPayloadApplied: boolean;
  sawStatusOnly: boolean;
  fetchOk: boolean;
  finClean: boolean | null;   // null = stream still open
  cancelled: boolean;
}

export class CatalogBootstrap {
  private readonly cb: CatalogBootstrapCallbacks;
  private readonly draft: 14 | 16 | 18;

  private _phase: BootstrapPhase = 'idle';
  private attemptSeq = 0;
  private attempt: Attempt | null = null;
  private aborted = false;

  /** SUBSCRIBE_OK largest location; null = explicitly none (empty track);
   *  undefined = not yet known. */
  private largest: { group: bigint; object: bigint } | null | undefined = undefined;

  /** The group whose independent base is currently applied, and per-group
   *  applied-head bookkeeping for the group-aware delta rule. */
  private baseGroup: bigint | null = null;
  private readonly appliedHeadGroups = new Set<string>();
  /** Base profile — CF-01 deltas chain across groups (no group-aware drop). */
  private baseProfile: 'msf01' | 'msf00' | 'cf01' | 'unknown' | null = null;
  /** A delta/patch application FAILED: every dependent update is built on
   *  state missing that update, so the whole chain is blocked until a fresh
   *  independent base arrives (which replaces the document wholesale). */
  private deltaChainPoisoned = false;

  /** Live-suffix hold buffer (coordinator-scoped: survives every rung). */
  private suffix: SuffixEntry[] = [];
  private suffixBytes = 0;
  /** Streams that contributed suffix objects, with their terminal cleanliness.
   *  `undefined` = still open; true = clean FIN; false = reset/dirty. */
  private readonly suffixStreams = new Map<bigint, boolean | undefined>();

  /** Deferred PUBLISH_DONE (recorded on the status, applied at drained). */
  private doneReason: PublishDoneReason | null = null;
  private drained = false;

  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  /** 'legacy': subscription-only retrieval — start() enters fallback-legacy
   *  directly (no fetch), readiness on the first acceptable independent base.
   *  Used for staged recovery in the legacy catalog mode (explicit
   *  'subscribe'), where the candidate is a fresh AbsoluteStart
   *  subscribe, never a Joining FETCH. */
  private readonly startMode: 'joining' | 'legacy';
  /** STRICT standards mode: MSF-01 §5 mandates SUBSCRIBE + Joining FETCH —
   *  every fallback off the joining path (rung-1 emulation, rung-2
   *  subscription-only) is a FATAL failure instead of a compatibility
   *  degradation. */
  private readonly strict: boolean;

  constructor(callbacks: CatalogBootstrapCallbacks, options: { draft: 14 | 16 | 18; startMode?: 'joining' | 'legacy'; strict?: boolean }) {
    this.cb = callbacks;
    this.draft = options.draft;
    this.startMode = options.startMode ?? 'joining';
    this.strict = options.strict ?? false;
  }

  get phase(): BootstrapPhase {
    return this._phase;
  }

  /** True once the subscription drained on a terminal 'ended' DONE — the
   *  feed is over and the player retires the catalog alias route. */
  get feedEnded(): boolean {
    return this.drained && this.doneReason === 'ended';
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  start(): void {
    if (this._phase !== 'idle') return;
    if (this.startMode === 'legacy') {
      // Legacy retrieval: no fetch — group-aware application over the
      // subscription's delivery, ready on the first acceptable base. The
      // status/drain machinery (PUBLISH_DONE rules, feedEnded) is shared.
      this._phase = 'fallback-legacy';
      return;
    }
    this._phase = 'joining';
    // draft-14 §9.16.2 references an "existing" (active) subscription — the
    // fetch may only follow SUBSCRIBE_OK there. 16/18 allow the Pending
    // association (18 additionally buffers publisher-side), so fire now.
    if (this.draft !== 14) this.beginAttempt('joining');
    this.armInactivity();
  }

  abort(): void {
    this.aborted = true;
    this._phase = 'aborted';
    this.disarmInactivity();
    if (this.attempt && !this.attempt.cancelled) {
      this.attempt.cancelled = true;
      this.cb.cancelFetch();
    }
    this.attempt = null;
    this.suffix = [];
    this.suffixBytes = 0;
  }

  // ─── SUBSCRIBE side ───────────────────────────────────────────────

  onSubscribeOk(largest: { group: bigint; object: bigint } | null): void {
    if (this.inert()) return;
    this.largest = largest;
    if (this.draft === 14 && this._phase === 'joining' && !this.attempt) {
      this.beginAttempt('joining');
    }
  }

  // ─── FETCH side (attempt-token-guarded) ───────────────────────────

  onFetchObject(attemptId: number, event: CatalogObjectEvent): void {
    if (this.inert()) return;
    const attempt = this.attempt;
    if (!attempt || attempt.id !== attemptId || attempt.cancelled) return; // retired attempt
    this.bumpInactivity();

    // Ordering: ascending over payloads, non-decreasing at marker→payload
    // equality (markers do not consume payload positions).
    if (attempt.lastLoc !== null) {
      const cmp = locCmp(event.location, attempt.lastLoc);
      const equalityAllowed = attempt.lastWasMarker && event.kind === 'payload' && cmp === 0;
      if (cmp < 0 || (cmp === 0 && !equalityAllowed)) {
        this.cb.log('[catalog-bootstrap] fetch delivered out of order (%s after %s) — failed prefix',
          locKey(event.location), locKey(attempt.lastLoc));
        this.failAttempt('ordering violation');
        return;
      }
    }
    attempt.lastLoc = event.location;
    attempt.lastWasMarker = event.kind === 'gap';

    if (event.kind === 'gap') {
      // Status-aware: terminators and missing objects are accounting only —
      // never parsed. A missing head does not decide anything by itself; the
      // FIRST PAYLOAD's classification carries the profile rules (a preceding
      // gap must not erase the MSF-00 / MSF-01 distinction).
      return;
    }

    this.ingestPayload(event.location, event.payload!, /* fromFetch */ true);
  }

  onFetchOk(attemptId: number, _endLocation: { group: bigint; object: bigint }, _endOfTrack: boolean): void {
    if (this.inert()) return;
    const attempt = this.attempt;
    if (!attempt || attempt.id !== attemptId || attempt.cancelled) return;
    this.bumpInactivity();
    attempt.fetchOk = true;
    this.checkPrefixComplete();
  }

  onFetchStreamClosed(attemptId: number, clean: boolean): void {
    if (this.inert()) return;
    const attempt = this.attempt;
    if (!attempt || attempt.id !== attemptId || attempt.cancelled) return;
    if (!clean) {
      // Only cleanliness is propagated here — a reset, our own discard, and a
      // read failure all arrive as the same `false`, so the diagnostic must
      // not name a cause it was not told.
      this.failAttempt('fetch stream did not finish cleanly');
      return;
    }
    attempt.finClean = true;
    this.checkPrefixComplete();
  }

  onFetchError(attemptId: number, kind: 'invalid-range' | 'refused' | 'timeout'): void {
    if (this.inert()) return;
    const attempt = this.attempt;
    if (!attempt || attempt.id !== attemptId || attempt.cancelled) return;
    if (kind === 'invalid-range') {
      // Track empty: the FETCH ATTEMPT IS RESOLVED (there is no prefix to
      // fetch) but the catalog is NOT ready. Hold the LargestObject
      // subscription and wait — intentionally INDEFINITE (a viewer joining
      // before the publisher starts is legitimate and open-ended; the player's
      // catalog watchdog provides diagnostics, not recovery). The first live
      // object resolves it via first-payload classification.
      // Exception: with the subscription already DONE+drained, nothing can
      // ever arrive — fatal.
      this.attempt = null;
      if (this.doneReason !== null && this.drained) {
        this.fatal('catalog track empty and its subscription ended — nothing to play');
        return;
      }
      this._phase = 'empty-wait';
      this.disarmInactivity();
      return;
    }
    this.failAttempt(`fetch ${kind}`);
  }

  // ─── LIVE side ────────────────────────────────────────────────────

  onLiveCatalogObject(event: CatalogObjectEvent, streamId: bigint): void {
    if (this.inert()) return;
    this.bumpInactivity();
    if (event.kind === 'gap') return; // accounting only on the live side too

    switch (this._phase) {
      case 'ready':
      case 'live':
        this.applyLive(event.location, event.payload!);
        return;
      case 'empty-wait':
      case 'await-first-payload':
      case 'await-newer-head':
        this.resolveWaitingWithPayload(event.location, event.payload!);
        return;
      case 'fallback-legacy':
        this.applyLegacy(event.location, event.payload!);
        return;
      default: {
        // Prefix in flight. A newer independent head supersedes the whole
        // prefix (MSF-01: updates preceding the first object of the latest
        // group MUST be ignored). Everything else buffers until completion.
        const c = classify(event.payload!);
        if (c.kind === 'independent'
            && (this.largest == null || event.location.group > this.largest.group)
            && (this.baseGroup === null || event.location.group > this.baseGroup)) {
          this.supersedeWith(event.location, event.payload!, c.profile);
          return;
        }
        this.bufferSuffix(event.location, event.payload!, streamId);
        return;
      }
    }
  }

  /**
   * The player's pre-alias parking overflowed: an object that COULD have been
   * a catalog delta was dropped. Fail closed — pre-readiness this fails the
   * bootstrap into the ladder; post-readiness the retained-chain evidence is
   * already positive-only, so the chain (if any) is dirtied by dropping the
   * suffix snapshot with a diagnostic.
   */
  onParkingOverflow(): void {
    if (this.inert()) return;
    switch (this._phase) {
      case 'joining':
      case 'fetching':
        this.failAttempt('pre-alias parking overflow');
        return;
      case 'fallback-legacy':
        // FINAL rung, still pre-ready: a dropped pre-alias object could be a
        // load-bearing delta and no further fallback exists — accepting a
        // truncated catalog is worse than failing. Terminal.
        this.fatal('pre-alias parking overflow during the final fallback retrieval');
        return;
      case 'ready':
      case 'live':
        if (this.suffix.length > 0) {
          this.cb.log('[catalog-bootstrap] parking overflow — retained suffix dropped (%d objects)', this.suffix.length);
          this.suffix = [];
          this.suffixBytes = 0;
        }
        return;
      default:
        return;
    }
  }

  onLiveStreamEvent(streamId: bigint, kind: 'header' | DataStreamTerminal): void {
    if (this.inert()) return;
    // Clean-FIN evidence exists for the retained chain, i.e. for streams that
    // contributed SUFFIX entries. In the live steady state nothing is buffered,
    // so tracking every stream would grow the map for the session's lifetime —
    // record headers only pre-live, and terminals only for tracked streams.
    if (kind === 'header') {
      if (this._phase === 'live') return;
      if (!this.suffixStreams.has(streamId)) this.suffixStreams.set(streamId, undefined);
      return;
    }
    // Only a peer FIN is positive evidence. A reset and our OWN discard are
    // both non-clean, and they are kept distinct so a local teardown is never
    // reported as a peer action.
    if (!this.suffixStreams.has(streamId)) return;
    this.suffixStreams.set(streamId, kind === 'fin');
  }

  // ─── PUBLISH_DONE (status-aware; drain finalizes) ─────────────────

  onPublishDone(reason: PublishDoneReason): void {
    if (this.inert()) return;
    this.doneReason = reason;
    if (reason === 'fatal-track') {
      // Immediate quarantine — never remain (or become) ready on an
      // unauthorized/malformed catalog track. The player also stops routing.
      this.fatal('catalog track terminated as untrusted (unauthorized/malformed)');
      return;
    }
    if (reason === 'going-away') {
      // Handled by the player's migration machinery; this coordinator's
      // session is superseded there. Nothing to do here.
      return;
    }
    // 'ended' / 'retriable': defer — the terminal drain delivers late objects
    // first; state rules apply at onSubscriptionDrained().
  }

  onSubscriptionDrained(): void {
    if (this.inert()) return;
    this.drained = true;
    if (this.doneReason === null) return;
    switch (this._phase) {
      case 'ready':
      case 'live':
        // Post-base 'ended': not a failure — the catalog is complete.
        // 'retriable' (TOO_FAR_BEHIND / EXPIRED / INTERNAL_ERROR / …): the
        // feed ended recoverably — without recovery, catalog updates would
        // permanently stop. The player owns the staged transaction.
        if (this.doneReason === 'retriable') this.cb.requestStagedRecovery();
        return;
      case 'empty-wait':
        // No history (INVALID_RANGE proved it), no future (DONE proved it).
        this.fatal('catalog track empty and its subscription ended');
        return;
      case 'await-first-payload':
      case 'await-newer-head':
        // The awaited live object can never arrive; relay cache may still
        // hold history → rung 2.
        this.toLegacy('subscription ended while awaiting a catalog base');
        return;
      case 'fallback-legacy':
        // Subscription-only retrieval ended before the first acceptable base
        // arrived: nothing further can come — the rung has failed. (For a
        // legacy-mode recovery CANDIDATE, onFatal fails the transaction and
        // the active snapshot is retained.)
        this.fatal('catalog subscription ended before a base was received');
        return;
      case 'joining':
      case 'fetching':
        // Deferred: the active fetch may still complete with a base
        // (one-shot catalog). checkPrefixComplete / failure paths consult
        // doneReason+drained.
        return;
      default:
        return;
    }
  }

  // ─── Internals ────────────────────────────────────────────────────

  private inert(): boolean {
    return this.aborted || this._phase === 'fatal';
  }

  private beginAttempt(kind: Attempt['kind']): void {
    this.attemptSeq += 1;
    this.attempt = {
      id: this.attemptSeq, kind, lastLoc: null, lastWasMarker: false,
      anyPayloadApplied: false, sawStatusOnly: false,
      fetchOk: false, finClean: null, cancelled: false,
    };
    this._phase = 'fetching';
    if (kind === 'joining') this.cb.issueJoiningFetch(this.attempt.id);
    this.armInactivity();
  }

  /** First-payload / prefix ingestion with the profile-specific base rules. */
  private ingestPayload(location: { group: bigint; object: bigint }, payload: Uint8Array, fromFetch: boolean): void {
    const attempt = this.attempt;
    if (this.baseGroup === null) {
      const c = classify(payload);
      if (c.kind === 'cf01-patch') {
        // CF-01 patches chain from the immediately preceding object, possibly
        // across groups — the joined-group snapshot has no base. Cancel the
        // original fetch FIRST, then retrieve full history, live sub retained.
        this.cb.log('[catalog-bootstrap] first object is a CF-01 patch — full-history retrieval');
        this.rungTransaction();
        const endGroup = this.largest?.group ?? location.group;
        this.beginStandaloneAttempt('cf01-history', { startGroup: 0n, startObject: 0n, endGroupWholeOf: endGroup });
        return;
      }
      if (c.kind === 'msf-delta'
          || (c.kind === 'independent' && c.profile === 'msf01' && location.object !== 0n)) {
        // MSF: the group's required independent base is missing (delta at the
        // head, or an MSF-01 independent off object 0 — "objects ≥ 1 MUST be
        // deltas"). An OLDER group's independent cannot base this group's
        // deltas: never full-history, never apply over prior-group state.
        // Wait for the next live independent head (§5.3 periodic
        // independents), bounded by the inactivity deadline → rung 2.
        this.cb.log('[catalog-bootstrap] MSF base missing at the group head — awaiting a newer independent');
        if (fromFetch && attempt && !attempt.cancelled) {
          attempt.cancelled = true;
          this.cb.cancelFetch();
        }
        this.attempt = null;
        this._phase = 'await-newer-head';
        this.armInactivity();
        return;
      }
      // Independent, acceptable as the base (MSF-01 at object 0; MSF-00 first
      // existing object at any ID; CF-01 independent at any ID; unknown —
      // let the parser decide).
      this.applyBase(location, payload, c.kind === 'independent' ? c.profile : 'unknown');
      if (attempt && fromFetch) attempt.anyPayloadApplied = true;
      this.checkPrefixComplete();
      return;
    }
    // Base exists: in-order application (dedup inside the manager).
    this.applyInternal(location, payload, /* emitUpdated */ this._phase === 'ready' || this._phase === 'live');
    if (attempt && fromFetch) attempt.anyPayloadApplied = true;
  }

  private applyBase(location: { group: bigint; object: bigint }, payload: Uint8Array, profile: 'msf01' | 'msf00' | 'cf01' | 'unknown'): void {
    // MSF-01 §5 is UNCONDITIONAL: "Subscribers accessing the catalog MUST use
    // SUBSCRIBE with a Joining FETCH". A base that classifies as
    // MSF-01/CMSF-01 but was acquired through a fallback rung (standalone
    // emulation or subscription-only retrieval) is a nonconforming path —
    // REJECTED by default. The explicitly named compatibility option
    // (catalogBootstrap: 'subscribe', which is what startMode 'legacy'
    // reflects) is the only way to accept it.
    const fallbackAcquired = (this.attempt !== null && this.attempt.kind !== 'joining')
      || this._phase === 'fallback-legacy';
    if (profile === 'msf01' && fallbackAcquired && this.startMode !== 'legacy') {
      this.fatal('catalog is MSF-01 but was not retrievable via the mandated SUBSCRIBE + Joining FETCH — nonconforming relay/publisher path (set catalogBootstrap: "subscribe" to accept it in compatibility mode)');
      return;
    }
    const result = this.applySafely(location, payload);
    if (result === null) return; // parse failure handled
    this.baseGroup = location.group;
    this.baseProfile = profile;
    this.appliedHeadGroups.add(location.group.toString());
  }

  /** applyAt with pre-first-catalog fatality semantics preserved. */
  private applySafely(location: { group: bigint; object: bigint }, payload: Uint8Array): CatalogState | null {
    try {
      const r = this.cb.applyAt(location, payload);
      return r.outcome === 'applied' ? r.state : this.cb.currentState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this._phase === 'ready' || this._phase === 'live') {
        // Post-readiness parse failures are degraded, matching today's model —
        // surfaced, never merely debug-logged.
        this.cb.onDegraded(msg);
        return null;
      }
      this.fatal(`catalog parse failed: ${msg}`);
      return null;
    }
  }

  private applyInternal(location: { group: bigint; object: bigint }, payload: Uint8Array, emitUpdated: boolean): void {
    try {
      const r = this.cb.applyAt(location, payload);
      if (r.outcome === 'applied') {
        if (location.object === 0n) {
          this.appliedHeadGroups.add(location.group.toString());
          if (this.baseGroup === null || location.group > this.baseGroup) this.baseGroup = location.group;
        }
        if (emitUpdated) this.cb.onUpdated(r.state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (emitUpdated) {
        // The rejected update poisons its dependents: later deltas of this
        // group (MSF) — and for CF-01 the whole positional chain — would
        // apply against state missing this update. Block them until a fresh
        // independent base replaces the document.
        this.appliedHeadGroups.delete(location.group.toString());
        this.deltaChainPoisoned = true;
        this.cb.onDegraded(msg);
      } else {
        this.fatal(`catalog parse failed: ${msg}`);
      }
    }
  }

  /** Group-aware live application (READY/LIVE steady state, MSF rules). */
  private applyLive(location: { group: bigint; object: bigint }, payload: Uint8Array): void {
    const c = classify(payload);
    if (c.kind === 'independent') {
      // Stale-group independents are ignorable (MSF latest-group rule).
      if (this.baseGroup !== null && location.group < this.baseGroup) return;
      // MSF-01/CMSF-01: objects ≥1 MUST be deltas — an independent at a
      // nonzero object is a producer violation and never becomes a base.
      if (c.profile === 'msf01' && location.object !== 0n) {
        this.cb.log('[catalog-bootstrap] MSF-01 independent at nonzero object %s:%s — ignored (§5)', location.group, location.object);
        return;
      }
      // Exact-location DUPLICATES are silent no-ops — a re-delivered
      // independent (fetch/suffix overlap defense) must not emit a spurious
      // catalog_updated. Locations below this head are provably obsolete on
      // EVERY profile (MSF latest-group rule; CF-01 because the independent
      // replaces the document wholesale and pre-base patches drop above), so
      // the apply atomically prunes them ON SUCCESS — a failed replacement
      // leaves the old catalog's replay protection intact.
      let applied: CatalogState | null = null;
      try {
        const r = this.cb.applyAt(location, payload, { pruneBeforeOnSuccess: location.group });
        if (r.outcome !== 'applied') return; // duplicate — no event
        applied = r.state;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.cb.onDegraded(msg);
        return;
      }
      this.baseGroup = location.group;
      // The independent REPLACES the catalog: the base profile follows it (a
      // CF-01 → MSF supersession must not leave deltas on the cross-group
      // chain path), older groups' head bookkeeping is dead weight, and a
      // previously poisoned delta chain is healed — the new document does not
      // depend on any rejected update.
      this.baseProfile = c.profile;
      this.deltaChainPoisoned = false;
      this.appliedHeadGroups.clear();
      this.appliedHeadGroups.add(location.group.toString());
      this.cb.onUpdated(applied);
      return;
    }
    // A poisoned chain blocks EVERY dependent update until a new base.
    if (this.deltaChainPoisoned) {
      this.cb.log('[catalog-bootstrap] delta at %s:%s dropped — chain poisoned by an earlier rejected update', location.group, location.object);
      return;
    }
    if (c.kind === 'cf01-patch' || this.baseProfile === 'cf01') {
      // CF-01 chains across groups — but a patch from BEFORE the current base
      // is superseded by that independent and must never re-apply.
      if (this.baseGroup !== null && location.group < this.baseGroup) return;
      this.applyInternal(location, payload, true);
      return;
    }
    // MSF delta: never applied without its OWN group's base; stale groups drop.
    if (this.baseGroup !== null && location.group < this.baseGroup) return;
    if (!this.appliedHeadGroups.has(location.group.toString())) {
      this.cb.log('[catalog-bootstrap] delta for group %s has no applied base — dropped', location.group);
      return;
    }
    this.applyInternal(location, payload, true);
  }

  /** Legacy (rung 2) application: arrival order + the group-aware rules,
   *  readiness on the first acceptable independent base. */
  private applyLegacy(location: { group: bigint; object: bigint }, payload: Uint8Array): void {
    if (this.baseGroup === null) {
      const c = classify(payload);
      if (c.kind !== 'independent') return;         // never a delta base
      if (c.profile === 'msf01' && location.object !== 0n) return;
      this.applyBase(location, payload, c.kind === 'independent' ? c.profile : 'unknown');
      const state = this.cb.currentState();
      if (state) {
        this._phase = 'live';
        this.disarmInactivity();
        this.cb.onReady(state);
        this.releaseRetainedChain();
        if (!this.aborted) this.cb.onReadySettled?.();
      }
      return;
    }
    this.applyLive(location, payload);
  }

  /** Waiting states: the first live payload gets full classification. */
  private resolveWaitingWithPayload(location: { group: bigint; object: bigint }, payload: Uint8Array): void {
    const c = classify(payload);
    if (c.kind === 'cf01-patch') {
      // Baseless CF-01 → full-history retrieval, live sub retained.
      this.rungTransaction();
      const endGroup = this.largest?.group ?? location.group;
      this.beginStandaloneAttempt('cf01-history', { startGroup: 0n, startObject: 0n, endGroupWholeOf: endGroup });
      return;
    }
    if (c.kind === 'msf-delta' || (c.kind === 'independent' && c.profile === 'msf01' && location.object !== 0n)) {
      if (this._phase !== 'await-newer-head') {
        this._phase = 'await-newer-head';
      }
      this.armInactivity();
      return;
    }
    // Independent — this IS the awaited head.
    this.applyBase(location, payload, c.kind === 'independent' ? c.profile : 'unknown');
    const state = this.cb.currentState();
    if (state) this.reachReady(state);
  }

  /** Supersession: a newer independent obsoletes the in-flight prefix. */
  private supersedeWith(location: { group: bigint; object: bigint }, payload: Uint8Array, profile: 'msf01' | 'msf00' | 'cf01' | 'unknown'): void {
    if (this.attempt && !this.attempt.cancelled) {
      this.attempt.cancelled = true;
      this.cb.cancelFetch();
    }
    this.attempt = null;
    // Drop stale suffix entries from older groups — MSF ignore rule.
    this.suffix = this.suffix.filter((e) => e.location.group >= location.group);
    this.suffixBytes = this.suffix.reduce((n, e) => n + e.payload.byteLength, 0);
    this.cb.resetManager();
    this.baseGroup = null;
    this.deltaChainPoisoned = false;
    this.appliedHeadGroups.clear();
    this.applyBase(location, payload, profile);
    const state = this.cb.currentState();
    if (state) this.reachReady(state);
  }

  private checkPrefixComplete(): void {
    const attempt = this.attempt;
    if (!attempt || attempt.cancelled) return;
    if (!attempt.fetchOk || attempt.finClean !== true) return; // BOTH required

    this.attempt = null;
    if (this.baseGroup !== null) {
      const state = this.cb.currentState();
      if (state) this.reachReady(state);
      return;
    }
    // Clean completion with nothing applied: only markers/status gaps.
    if (this.doneReason !== null && this.drained) {
      // The live subscription already ended — the awaited payload can never
      // arrive; relay cache may still hold history → rung 2.
      this.toLegacy('fetch returned no payload and the subscription ended');
      return;
    }
    this._phase = 'await-first-payload';
    this.armInactivity();
  }

  private reachReady(state: CatalogState): void {
    // A terminal DONE that was deferred while the prefix finished must not be
    // lost: the live feed already ended, and 'retriable' needs recovery BEFORE
    // readiness is announced — a staged-recovery CANDIDATE whose own feed died
    // must be failed here (the callback aborts this coordinator), never adopted
    // over the healthy active snapshot. For the main coordinator the callback
    // starts recovery and readiness proceeds (the content itself is valid).
    if (this.drained && this.doneReason === 'retriable') {
      this.cb.requestStagedRecovery();
      if (this.aborted) return;
    }
    this._phase = 'ready';
    this.disarmInactivity();
    this.cb.onReady(state);
    this._phase = 'live';
    // Release the held suffix in ascending location order through the dedup.
    const held = this.suffix.sort((a, b) => locCmp(a.location, b.location));
    this.suffix = [];
    this.suffixBytes = 0;
    for (const entry of held) {
      if (this.aborted) return; // a consumer failed the transaction mid-release
      this.applyLive(entry.location, entry.payload);
    }
    // The suffix is fully released: its per-stream FIN evidence has served its
    // purpose. Dropping it here bounds the map — live-phase streams are not
    // tracked (see onLiveStreamEvent).
    this.suffixStreams.clear();
    // Readiness is SETTLED only now — after the retained suffix has been fully
    // examined. A staged-recovery candidate must adopt here, not at onReady: a
    // malformed suffix delta between the two must abort the transaction, never
    // degrade an already-adopted snapshot.
    this.cb.onReadySettled?.();
  }

  private bufferSuffix(location: { group: bigint; object: bigint }, payload: Uint8Array, streamId: bigint): void {
    this.suffix.push({ location, payload, streamId });
    this.suffixBytes += payload.byteLength;
    if (!this.suffixStreams.has(streamId)) this.suffixStreams.set(streamId, undefined);
    if (this.suffix.length > MAX_SUFFIX_OBJECTS || this.suffixBytes > MAX_SUFFIX_BYTES) {
      // Fail closed: an evicted delta would make the group unreconstructible,
      // so a full buffer means convergence already failed.
      this.failAttempt('suffix buffer overflow');
    }
  }

  /** The rung-transition transaction (same on every rung):
   *  retire+cancel the old fetch, reset the manager and applied state,
   *  RETAIN the buffered suffix. */
  private rungTransaction(): void {
    if (this.attempt && !this.attempt.cancelled) {
      this.attempt.cancelled = true;
      this.cb.cancelFetch();
    }
    this.attempt = null;
    this.cb.resetManager();
    this.baseGroup = null;
    this.baseProfile = null;
    this.deltaChainPoisoned = false;
    this.appliedHeadGroups.clear();
    // this.suffix RETAINED (coordinator-scoped, survives every rung).
  }

  private beginStandaloneAttempt(kind: 'emulation' | 'cf01-history', range: { startGroup: bigint; startObject: bigint; endGroupWholeOf: bigint }): void {
    this.attemptSeq += 1;
    this.attempt = {
      id: this.attemptSeq, kind, lastLoc: null, lastWasMarker: false,
      anyPayloadApplied: false, sawStatusOnly: false,
      fetchOk: false, finClean: null, cancelled: false,
    };
    this._phase = 'fetching';
    this.cb.issueStandaloneFetch(range, this.attempt.id);
    this.armInactivity();
  }

  /** Failure ladder: joining → rung 1 (standalone emulation) → rung 2 (legacy). */
  private failAttempt(reason: string): void {
    const kind = this.attempt?.kind ?? 'joining';
    this.cb.log('[catalog-bootstrap] attempt failed (%s): %s', kind, reason);
    if (this.strict) {
      // MSF-01 §5 MUST: strict mode never falls off the joining path.
      this.fatal(`catalog joining fetch failed (${reason}) — strict standards mode forbids fallback retrieval`);
      return;
    }
    this.rungTransaction();
    if (kind === 'joining' && this.largest != null) {
      // Rung 1: emulate the join with a standalone FETCH bounded by the
      // SUBSCRIBE_OK Largest — the live subscription is RETAINED (no churn).
      // Whole-group End.Object=0 encoding: no successor arithmetic.
      this.beginStandaloneAttempt('emulation', {
        startGroup: this.largest.group, startObject: 0n, endGroupWholeOf: this.largest.group,
      });
      return;
    }
    this.toLegacy(reason);
  }

  private toLegacy(reason: string): void {
    if (this.strict) {
      this.fatal(`catalog retrieval failed (${reason}) — strict standards mode forbids subscription-only fallback`);
      return;
    }
    this.cb.log('[catalog-bootstrap] falling back to legacy retrieval: %s', reason);
    this.rungTransaction();
    this._phase = 'fallback-legacy';
    this.disarmInactivity();
    this.cb.requestLegacyResubscribe();
  }

  /**
   * Rung-2 retained chain — best-effort base-anchored snapshot, applied only
   * when it is self-contained (contains its own independent head) AND every
   * contributing stream ended with a clean FIN. Headless retained deltas are
   * NEVER spliced onto replayed history (no completion signal exists on an
   * open-ended subscription, so no splice boundary can be proven).
   */
  private releaseRetainedChain(): void {
    if (this.suffix.length === 0) return;
    const held = this.suffix.sort((a, b) => locCmp(a.location, b.location));
    this.suffix = [];
    this.suffixBytes = 0;
    const head = held.find((e) => {
      const c = classify(e.payload);
      return c.kind === 'independent' && (c.profile !== 'msf01' || e.location.object === 0n);
    });
    if (!head) {
      this.cb.log('[catalog-bootstrap] retained suffix has no independent head — dropped (%d objects)', held.length);
      return;
    }
    if (this.baseGroup !== null && head.location.group <= this.baseGroup) {
      this.cb.log('[catalog-bootstrap] retained head is not newer than the replayed base — dropped');
      return;
    }
    const chain = held.filter((e) => e.location.group === head.location.group && locCmp(e.location, head.location) >= 0);
    const clean = chain.every((e) => this.suffixStreams.get(e.streamId) === true);
    if (!clean) {
      this.cb.log('[catalog-bootstrap] retained chain contributing stream not cleanly finished — dropped');
      return;
    }
    for (const entry of chain) {
      this.applyLive(entry.location, entry.payload);
    }
  }

  private fatal(reason: string): void {
    if (this._phase === 'fatal') return;
    this._phase = 'fatal';
    this.disarmInactivity();
    if (this.attempt && !this.attempt.cancelled) {
      this.attempt.cancelled = true;
      this.cb.cancelFetch();
    }
    this.attempt = null;
    this.cb.onFatal(reason);
  }

  // ─── Inactivity (progress) timer ──────────────────────────────────

  private armInactivity(): void {
    this.disarmInactivity();
    // Armed only for states that are WAITING ON REMOTE PROGRESS. EMPTY_WAIT
    // is deliberately excluded (intentionally indefinite); READY/LIVE need none.
    if (!['joining', 'fetching', 'await-first-payload', 'await-newer-head'].includes(this._phase)) return;
    this.inactivityTimer = setTimeout(() => this.onInactivity(), CATALOG_BOOTSTRAP_INACTIVITY_MS);
  }

  private bumpInactivity(): void {
    if (this.inactivityTimer !== null) this.armInactivity();
  }

  private disarmInactivity(): void {
    if (this.inactivityTimer !== null) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private onInactivity(): void {
    this.inactivityTimer = null;
    if (this.inert()) return;
    switch (this._phase) {
      case 'joining':
      case 'fetching':
        this.failAttempt('inactivity timeout');
        return;
      case 'await-first-payload':
      case 'await-newer-head':
        // The fetch already concluded — rung 1 adds nothing; history/live may
        // exist → rung 2.
        this.toLegacy('no catalog base arrived within the inactivity deadline');
        return;
      default:
        return;
    }
  }
}
