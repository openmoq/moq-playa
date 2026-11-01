// Protocol → ViewModel.
//
// A ProtocolSource consumes DECODED diagnostic messages — hello, snapshot,
// batch — and maintains the panel's view model. It never sees raw JSON: the
// host decodes with `decodeMessage` and binds the port to its own DevTools
// context before anything reaches this class. The shared cursor rules decide
// what a snapshot or batch means for the stream; this class applies accepted
// facts, records loss, and keeps everything it retains inside explicit,
// validated budgets so a peer can never make the panel allocate on its
// behalf.
//
// MOQT integers (group, object, alias, request, stream ids) stay decimal
// STRINGS. They are keys and grid coordinates, never Numbers; BigInt is used
// where ordering is needed, and a value above 2^53 keeps its exact digits.
import { advanceCursor, cursorFromSnapshot, refreshCursor, sameTarget } from '@openmoq/devtools-protocol';
import type {
  Batch, CursorResult, Fact, KnownFact, Message, Observation, Snapshot, SnapshotScope,
  SourceDescriptor, StreamCursor,
} from '@openmoq/devtools-protocol';

type Hello = Extract<Message, { kind: 'hello' }>;
type F<K extends KnownFact['kind']> = Extract<KnownFact, { kind: K }>;

/**
 * What the panel may retain, in total. Every budget is a finite positive
 * safe integer, validated before anything is painted; a peer-chosen
 * identifier never sizes anything.
 */
export interface Budgets {
  readonly groups: number;              // TOTAL retained groups, across sessions, aliases and tracks
  readonly objectsPerGroup: number;     // retained object detail per group
  readonly cells: number;               // grid columns: a WINDOW over sparse object ids
  readonly sessions: number;
  readonly tracks: number;
  readonly requests: number;
  readonly aliases: number;             // proven (session, alias) → track bindings
  readonly streams: number;
  readonly stages: number;              // delivery ids with stage detail
  readonly discardsPerDelivery: number; // discard reasons kept per delivery id
  readonly failures: number;
  readonly dialAttempts: number;
  readonly metrics: number;
  /** Retained samples per metric series for the sparklines (observation order; a bounded ring). */
  readonly sparkSamples: number;
  readonly controlKinds: number;
}
export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  groups: 8, objectsPerGroup: 2048, cells: 256, sessions: 8, tracks: 64, requests: 256, aliases: 256,
  streams: 512, stages: 4096, discardsPerDelivery: 8, failures: 64, dialAttempts: 64, metrics: 128, controlKinds: 64,
  sparkSamples: 60,
});

/** Panel-side eviction, disclosed separately from anything the source lost. */
export interface PanelEvictions {
  groups: number; objects: number; sessions: number; tracks: number; requests: number; aliases: number;
  streams: number; stages: number; discards: number; failures: number; dialAttempts: number; metrics: number;
}
const freshEvictions = (): PanelEvictions => ({
  groups: 0, objects: 0, sessions: 0, tracks: 0, requests: 0, aliases: 0,
  streams: 0, stages: 0, discards: 0, failures: 0, dialAttempts: 0, metrics: 0,
});

export interface Cell { readonly cls: string; readonly sel: boolean; readonly g: string; readonly o: string; readonly present: boolean }
export interface Row {
  readonly label: string; readonly head: boolean; readonly meta: string; readonly metaClass: string;
  /** Ownership context shown when the selected track's groups span more than one session or alias: `session … · alias …`; null when unambiguous. */
  readonly context: string | null;
  readonly cells: readonly Cell[];
  /** Exact window boundaries within the uint64 domain, so sparse ids are never truncated to fit. */
  readonly window: { readonly from: string; readonly to: string; readonly beyond: number };
}
/** Bars are the retained sample history of ONE series (same session, track and name), oldest first, scaled to the series' own maximum; `range` states that scale. */
export interface Spark { readonly name: string; readonly now: string; readonly na?: string; readonly definition?: string; readonly range?: string; readonly bars: readonly { h: number; color: string; op: number }[] }
export interface ViewModel {
  readonly synthetic: boolean;
  readonly mode: 'attach' | 'probe';
  readonly exposed: boolean;
  readonly paused: boolean;
  readonly needsResnapshot: string | null;
  /** The source's own `source_state: ended` (protocol minor 1). Diagnostic capture ended; no transport close is implied. */
  readonly sourceEnded: { readonly reason: 'disposed' | 'sequence-exhausted' | 'clock-error'; readonly timeMs: number; readonly clockId: string } | null;
  /** Which header controls this source can honour. Unsupported ones are disabled, never faked. */
  readonly actions: { readonly pause: boolean; readonly mode: boolean; readonly record: boolean; readonly detach: boolean };
  /** Elapsed time is shown only when an observation supplies it. */
  readonly recording: { readonly active: boolean; readonly owner: 'me' | 'other' | null; readonly elapsedMs: number | null };
  readonly hookStats: string;
  /** Legend wording for append-stage coverage (null when the source declares no `cmaf-append-stages`). */
  readonly legendNote: string | null;
  readonly picker: { readonly name: string; readonly meta: string };
  readonly instances: readonly { id: string; name: string; sub: string; on: boolean }[];
  readonly session: readonly (readonly [string, string, ('na' | undefined)?])[];
  readonly requests: readonly { id: string; track: string; state: 'active' | 'gone'; label: string; chain: number; caption?: string; context: string | null }[];
  readonly decoder: readonly (readonly [string, string])[];
  readonly tracks: readonly { id: string; name: string; on: boolean }[];
  readonly ring: string;
  readonly colHeader: string;
  readonly columns: number;
  readonly rows: readonly Row[];
  readonly selected: readonly (readonly [string, string, string?])[];
  readonly sparks: readonly Spark[];
  readonly events: readonly { name: string; count: string; color: string }[];
  /** Scoped detail replies, kept apart from live state. */
  readonly detail: { readonly scope: SnapshotScope; readonly facts: number } | null;
  /** The attached source's declared capabilities, verbatim; `canRecord` is `recording` among them. */
  readonly sourceCapabilities: readonly string[];
  readonly canRecord: boolean;
}

interface RetainedObject extends F<'object'> { readonly offsetMs: number | null }
interface Group {
  readonly key: string; readonly sessionId: string; readonly trackAlias: string; readonly groupId: string;
  trackId: string | null;
  readonly objects: Map<string, RetainedObject>;
  /** Reference for arrival offsets: the FIRST OBJECT observed, never a bound or summary. */
  firstMs: number | null; clockId: string | null;
  bound: F<'group_bound'> | null; summary: F<'group_summary'> | null;
  evictedObjects: number;
}
interface StageState { stages: Set<string>; discards: (string | null)[]; droppedDiscards: number }

const U64_MAX = 18446744073709551615n;
const big = (s: string): bigint => BigInt(s);
const hexText = (hex: string): string => {
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map(h => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
};
/** Bands of ARRIVAL OFFSET from the group's first observed object. Not lateness. */
const bandOf = (ms: number | null): string => ms === null ? '' : ms < 35 ? 'fast' : ms <= 120 ? 'mid' : 'slow';
const RED = 'oklch(0.86 0.09 25)', GREY = '#b7c0c9';
/** Collision-free key for nullable identity tuples: a literal '-' id stays distinct from null. */
const tupleKey = (...parts: (string | null)[]): string => JSON.stringify(parts);

function validateBudgets(budgets: Budgets): void {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`budget ${name} must be a positive safe integer, got ${String(value)}`);
    }
  }
}

/**
 * Evict the oldest entries of an insertion-ordered map down to `max`. The
 * entry is removed BEFORE `onEvict` runs, so a callback that asks "is this
 * still proven by something retained?" cannot be answered by the very entry
 * being evicted.
 */
function trimMap<K, V>(map: Map<K, V>, max: number, onEvict?: (key: K, value: V) => void): number {
  let evicted = 0;
  while (map.size > max) {
    const first = map.keys().next();
    if (first.done) break;
    const value = map.get(first.value)!;
    map.delete(first.value);
    onEvict?.(first.value, value);
    evicted++;
  }
  return evicted;
}
/** Re-insert so the entry becomes the most recently retained. */
function touch<K, V>(map: Map<K, V>, key: K, value: V): void { map.delete(key); map.set(key, value); }

export class ProtocolSource {
  readonly budgets: Budgets;
  cursor: StreamCursor | null = null;
  source: SourceDescriptor | null = null;
  hello: Hello | null = null;
  sessions = new Map<string, F<'session'>>();
  tracks = new Map<string, F<'track'>>();
  requests = new Map<string, F<'request'>>();
  /** `${sessionId}/${alias}` → trackId, PROVEN by a retained request fact in that session. */
  aliasBindings = new Map<string, string>();
  streams = new Map<string, F<'stream'>>();
  /** Insertion order = retention order; total eviction never compares group numbers across tracks. */
  groups = new Map<string, Group>();
  stages = new Map<string, StageState>();
  metrics = new Map<string, F<'metric'>>();
  /** Per-series sample history (same key as `metrics`), bounded by `budgets.sparkSamples`; a panel-side record of this run. */
  metricHistory = new Map<string, { t: number; v: number }[]>();
  failures: F<'failure'>[] = [];
  dialAttempts = new Map<string, F<'dial_attempt'>>();
  recording: F<'recording'> | null = null;
  controlCounts = new Map<string, number>();
  loss = { dense: '0', sparse: '0', batches: 0 };
  retention: Snapshot['retention'] | null = null;
  omittedFacts = 0;
  unknownFacts = 0;
  sourceEnded: ViewModel['sourceEnded'] = null;
  needsResnapshot: string | null = null;
  detail: { scope: SnapshotScope; facts: Observation[] } | null = null;
  evictions: PanelEvictions = freshEvictions();
  /** View state. Survives refreshes; only `destroy` ends it. */
  view: { mode: 'attach' | 'probe'; paused: boolean; selectedTrack: string | null; selected: { groupKey: string; objectId: string } | null } =
    { mode: 'attach', paused: false, selectedTrack: null, selected: null };
  frozen: ViewModel | null = null;
  disposed = false;

  constructor(private readonly onChange: (vm: ViewModel) => void, options: { groupsRetained?: number; budgets?: Partial<Budgets> } = {}) {
    this.budgets = { ...DEFAULT_BUDGETS, ...(options.groupsRetained !== undefined ? { groups: options.groupsRetained } : {}), ...options.budgets };
    validateBudgets(this.budgets);
    // Paint the empty state at once: "no exposed sources" is a real state.
    this.emit();
  }

  /** Release everything. Further input is ignored and nothing is emitted. */
  destroy(): void {
    this.disposed = true;
    this.resetData(true);
    this.hello = null;
    this.frozen = null;
  }

  private resetData(newRun: boolean): void {
    this.cursor = null; this.source = null;
    this.sessions.clear(); this.tracks.clear(); this.requests.clear(); this.aliasBindings.clear();
    this.streams.clear(); this.groups.clear(); this.stages.clear(); this.metrics.clear();
    if (newRun) this.metricHistory.clear();   // a same-run refresh re-delivers current metrics; the history stays
    this.failures = []; this.dialAttempts.clear(); this.recording = null; this.controlCounts.clear();
    this.retention = null; this.omittedFacts = 0; this.unknownFacts = 0; this.sourceEnded = null; this.needsResnapshot = null; this.detail = null;
    // Loss belongs to a run of one source: a refresh keeps it, a new run or
    // another source starts clean.
    if (newRun) {
      this.loss = { dense: '0', sparse: '0', batches: 0 };
      this.evictions = freshEvictions();
      this.view.selectedTrack = null; this.view.selected = null;
    }
  }

  // ── Host-facing input ──────────────────────────────────────────────

  applyHello(message: Hello): void {
    if (this.disposed) return;
    this.hello = message;
    this.emit();
  }

  /**
   * A decoded snapshot. A source-scoped snapshot for the bound target goes
   * through the shared `refreshCursor` rule (current or newer accepted, stale
   * ignored so a late reply cannot rewind); one for another target is an
   * explicit, host-bound replacement. Scoped replies go to the detail store
   * and never touch live state, counters or the cursor.
   */
  applySnapshot(snapshot: Snapshot): { applied: boolean; reason?: 'stale' | 'disposed' | 'detail' } {
    if (this.disposed) return { applied: false, reason: 'disposed' };
    if (snapshot.scope.kind !== 'source') {
      this.detail = { scope: snapshot.scope, facts: [...snapshot.facts] };
      this.emit();
      return { applied: true, reason: 'detail' };
    }
    let next: StreamCursor;
    if (this.cursor !== null && sameTarget(this.cursor.target, snapshot.target)) {
      const decision = refreshCursor(this.cursor, snapshot);
      if (decision.kind === 'ignore') return { applied: false, reason: 'stale' };
      next = decision.cursor;
    } else {
      next = cursorFromSnapshot(snapshot);
    }
    // Run identity is source-scoped: the same runId under another source is a different run.
    const newRun = this.source === null
      || this.source.sourceId !== snapshot.source.sourceId || this.source.runId !== snapshot.source.runId;
    this.resetData(newRun);
    this.cursor = next;
    this.source = snapshot.source;
    this.retention = snapshot.retention;
    this.omittedFacts = snapshot.omittedFacts;
    for (const fact of snapshot.facts) this.applyFact(fact.fact, fact.timeMs, fact.clockId);
    if (this.view.selectedTrack !== null && !this.tracks.has(this.view.selectedTrack)) this.view.selectedTrack = null;
    this.emit();
    return { applied: true };
  }

  /** A decoded batch. Returns the cursor decision so the host can resnapshot when told to. */
  applyBatch(batch: Batch): CursorResult | { kind: 'ignore'; reason: 'no-cursor' | 'disposed' } {
    if (this.disposed) return { kind: 'ignore', reason: 'disposed' };
    if (this.cursor === null) return { kind: 'ignore', reason: 'no-cursor' };
    const result = advanceCursor(this.cursor, batch);
    if (result.kind === 'accept') {
      this.cursor = result.cursor;
      if (result.lost) {
        this.loss = {
          dense: (big(this.loss.dense) + big(batch.dropped.dense)).toString(),
          sparse: (big(this.loss.sparse) + big(batch.dropped.sparse)).toString(),
          batches: this.loss.batches + 1,
        };
      }
      for (const event of batch.events) this.applyFact(event.fact, event.timeMs, event.clockId);
      this.emit();
    } else if (result.kind === 'resnapshot') {
      this.needsResnapshot = result.reason;
      this.emit();
    }
    return result;
  }

  // ── Panel-local controls (never reach the source) ─────────────────

  setMode(mode: 'attach' | 'probe'): void { this.view.mode = mode; this.emit(); }
  togglePause(): void {
    this.view.paused = !this.view.paused;
    this.frozen = this.view.paused ? this.build() : null;
    this.emit();
  }
  selectTrack(trackId: string): void { this.view.selectedTrack = trackId; this.view.selected = null; this.emit(); }
  selectCell(groupKey: string, objectId: string): void { this.view.selected = { groupKey, objectId }; this.emit(); }

  // ── Facts ─────────────────────────────────────────────────────────

  /** Find or create a group and mark it most recently retained; total bound applies. */
  private group(sessionId: string, trackAlias: string, groupId: string): Group {
    const key = `${sessionId}/${trackAlias}/${groupId}`;
    const existing = this.groups.get(key);
    if (existing) { touch(this.groups, key, existing); return existing; }
    const group: Group = { key, sessionId, trackAlias, groupId, trackId: null, objects: new Map(), firstMs: null, clockId: null, bound: null, summary: null, evictedObjects: 0 };
    this.groups.set(key, group);
    this.evictions.groups += trimMap(this.groups, this.budgets.groups, (_k, g) => {
      for (const o of g.objects.values()) this.stages.delete(o.deliveryId);
    });
    return group;
  }

  private applyFact(fact: Fact, timeMs: number, clockId: string): void {
    switch (fact.kind) {
      case 'session':
        touch(this.sessions, fact.sessionId, fact);
        this.evictions.sessions += trimMap(this.sessions, this.budgets.sessions);
        break;
      case 'track':
        touch(this.tracks, fact.trackId, fact);
        this.evictions.tracks += trimMap(this.tracks, this.budgets.tracks);
        this.view.selectedTrack ??= fact.trackId;
        break;
      case 'request': {
        const key = `${fact.sessionId}/${fact.requestId}`;
        touch(this.requests, key, fact);
        this.evictions.requests += trimMap(this.requests, this.budgets.requests, (_k, gone) => {
          // A binding is only as good as a retained request that proves it.
          if (gone.trackAlias !== null && !this.stillProven(gone.sessionId, gone.trackAlias)) {
            if (this.aliasBindings.delete(`${gone.sessionId}/${gone.trackAlias}`)) this.evictions.aliases++;
          }
        });
        if (fact.trackId !== null && fact.trackAlias !== null) {
          touch(this.aliasBindings, `${fact.sessionId}/${fact.trackAlias}`, fact.trackId);
          this.evictions.aliases += trimMap(this.aliasBindings, this.budgets.aliases);
        }
        break;
      }
      case 'stream':
        touch(this.streams, `${fact.sessionId}/${fact.streamId}`, fact);
        this.evictions.streams += trimMap(this.streams, this.budgets.streams);
        break;
      case 'object': {
        const group = this.group(fact.sessionId, fact.trackAlias, fact.groupId);
        if (!this.groups.has(group.key)) break;   // evicted on creation
        // Explicit identity wins; a group learns its track from its first attributed object.
        if (fact.trackId !== null) group.trackId ??= fact.trackId;
        // Only an OBJECT can start the offset clock.
        if (group.firstMs === null) { group.firstMs = timeMs; group.clockId = clockId; }
        const offsetMs = clockId === group.clockId ? Math.max(0, timeMs - group.firstMs) : null;
        group.objects.set(fact.objectId, { ...fact, offsetMs });
        if (group.objects.size > this.budgets.objectsPerGroup) {
          const lowest = [...group.objects.keys()].reduce((a, b) => (big(a) < big(b) ? a : b));
          const gone = group.objects.get(lowest)!;
          group.objects.delete(lowest);
          this.stages.delete(gone.deliveryId);
          group.evictedObjects++; this.evictions.objects++;
        }
        break;
      }
      case 'stage': {
        const prior = this.stages.get(fact.deliveryId) ?? { stages: new Set<string>(), discards: [], droppedDiscards: 0 };
        prior.stages.add(fact.stage);
        if (fact.stage === 'discarded') {
          prior.discards.push(fact.reason);
          while (prior.discards.length > this.budgets.discardsPerDelivery) { prior.discards.shift(); prior.droppedDiscards++; this.evictions.discards++; }
        }
        touch(this.stages, fact.deliveryId, prior);
        this.evictions.stages += trimMap(this.stages, this.budgets.stages);
        break;
      }
      case 'group_bound': {
        const group = this.group(fact.sessionId, fact.trackAlias, fact.groupId);
        if (this.groups.has(group.key)) group.bound = fact;
        break;
      }
      case 'group_summary': {
        const group = this.group(fact.sessionId, fact.trackAlias, fact.groupId);
        if (this.groups.has(group.key)) group.summary = fact;
        break;
      }
      case 'control': {
        // The kind table is bounded INCLUDING the overflow bucket, and the
        // event total is preserved: a kind that will not fit folds into
        // `other`, and if `other` itself does not fit, the least recently
        // counted kind is folded into it first.
        const counts = this.controlCounts;
        let key = fact.messageType;
        if (!counts.has(key) && counts.size >= this.budgets.controlKinds) {
          if (!counts.has('other')) {
            const oldest = counts.keys().next().value!;
            const folded = counts.get(oldest)!;
            counts.delete(oldest);
            counts.set('other', folded);
          }
          key = 'other';
        }
        const n = (counts.get(key) ?? 0) + 1;
        counts.delete(key); counts.set(key, n);   // most recently counted last
        break;
      }
      case 'metric':
        // Scoped by (session, track, name) with a collision-free key: an audio
        // track's metric never stands in for the video's, and a literal '-'
        // id is not null.
        {
          const key = tupleKey(fact.sessionId, fact.trackId, fact.name);
          touch(this.metrics, key, fact);
          if (fact.value !== null) {
            // One sample per observation time: a refresh snapshot re-delivering the current value adds nothing.
            const series = this.metricHistory.get(key) ?? [];
            const last = series.at(-1);
            if (!last || timeMs > last.t) {
              series.push({ t: timeMs, v: fact.value });
              while (series.length > this.budgets.sparkSamples) series.shift();
              this.metricHistory.set(key, series);
            }
          }
          this.evictions.metrics += trimMap(this.metrics, this.budgets.metrics, k => this.metricHistory.delete(k));
        }
        break;
      case 'failure':
        this.failures.push(fact);
        while (this.failures.length > this.budgets.failures) { this.failures.shift(); this.evictions.failures++; }
        break;
      case 'dial_attempt':
        touch(this.dialAttempts, fact.attemptId, fact);
        this.evictions.dialAttempts += trimMap(this.dialAttempts, this.budgets.dialAttempts);
        break;
      case 'recording': this.recording = fact; break;
      // Capture ended, not the session: session facts keep their last observed state.
      case 'source_state': this.sourceEnded = { reason: fact.reason, timeMs, clockId }; break;
      case 'unknown': this.unknownFacts++; break;   // sequence consumed; nothing drawn
    }
  }

  private stillProven(sessionId: string, trackAlias: string): boolean {
    for (const r of this.requests.values()) if (r.sessionId === sessionId && r.trackAlias === trackAlias && r.trackId !== null) return true;
    return false;
  }

  /** The track an object group belongs to: explicit, else a proven session-scoped alias binding. */
  private groupTrack(g: Group): string | null {
    return g.trackId ?? this.aliasBindings.get(`${g.sessionId}/${g.trackAlias}`) ?? null;
  }

  // ── View model ────────────────────────────────────────────────────

  private emit(): void { if (!this.disposed) this.onChange(this.frozen ?? this.build()); }

  build(): ViewModel {
    const source = this.source;
    const exposed = source !== null;
    const session = [...this.sessions.values()].at(-1) ?? null;
    const selectedTrack = this.view.selectedTrack;
    const track = selectedTrack !== null ? this.tracks.get(selectedTrack) ?? null : null;

    const na = (reason: 'not-applicable' | 'not-observed' | 'unsupported' | null): string =>
      ({ 'not-applicable': 'not applicable', 'not-observed': 'not observed', unsupported: 'unsupported' })[reason ?? 'not-observed'];
    // Several sessions may be retained (reconnects, overlapping connections). The header describes ONE — the latest —
    // and names it, so negotiated details are paired with a displayed identity rather than implied for every row.
    const multiSession = this.sessions.size > 1;
    // Request ownership comes from the RETAINED REQUESTS themselves: session metadata has its own budget and may be
    // evicted while requests from two sessions are still shown, so the request rows must not depend on it.
    const requestOwners = new Set([...this.requests.values()].map(r => r.sessionId));
    const sessionRows: (readonly [string, string, ('na' | undefined)?])[] = session ? [
      ['session', multiSession ? `${session.sessionId} (latest of ${this.sessions.size} retained)` : session.sessionId],
      ...(source ? [['source', source.modules.map(m => `${m.name} ${m.version}`).join(', ') || '—'] as const] : []),
      ['exposure', source?.exposure ?? 'undeclared'],
      [session.transport === 'webtransport' ? 'subprotocol' : 'alpn',
        session.negotiatedProtocol ?? 'not observed', session.negotiatedProtocol === null ? 'na' : undefined],
      ['offered', session.offeredProtocols.join(', ') || '—'],
      ['draft', session.draft === null ? 'unknown' : `d${session.draft} (${session.draftEvidence})`],
      ['transport', session.transport === 'webtransport' ? 'WebTransport' : 'QUIC'],
      ['path', session.endpoint?.path ?? 'not exposed'],
      ['max_req_id',
        session.maxRequestId.value ?? na(session.maxRequestId.unavailable)
          + (session.maxRequestId.unavailable === 'not-applicable' && session.draft ? ` (d${session.draft})` : ''),
        session.maxRequestId.value === null ? 'na' : undefined],
      // Displayed to a tenth of a millisecond; the fact keeps the source's full value.
      ['setup duration', session.setupDurationMs === null ? 'not observed' : `${Math.round(session.setupDurationMs * 10) / 10} ms`, session.setupDurationMs === null ? 'na' : undefined],
    ] : [];

    const requests = [...this.requests.values()].map(r => {
      const t = r.trackId ? this.tracks.get(r.trackId) : null;
      const active = r.state === 'accepted' || r.state === 'receiving' || r.state === 'pending';
      const chain = ({ pending: 1, accepted: 2, receiving: 3, done: 3, cancelled: 2, refused: 1, reset: 2, failed: 1 } as Record<string, number>)[r.state] ?? 1;
      return { id: `req ${r.requestId}`, track: t?.displayName ?? (t?.identity ? hexText(t.identity.name) : (r.trackId ?? '—')),
        state: active ? 'active' as const : 'gone' as const, label: active ? `● ${r.state}` : r.state, chain,
        // Request ids are session-scoped: with several sessions retained, the owning session is part of the row.
        context: requestOwners.size > 1 ? `session ${r.sessionId}` : null,
        ...(r.state === 'receiving' ? { caption: `${r.requestType.toUpperCase()} → OK → objects` } : {}) };
    });

    // Grid: groups attributed to the selected track. Group numbers are only
    // ordered WITHIN that track; total retention is by observation order.
    const groups = [...this.groups.values()]
      .filter(g => track !== null && this.groupTrack(g) === track.trackId)
      .sort((a, b) => (big(a.groupId) > big(b.groupId) ? -1 : 1));
    const sel = this.view.selected;
    const budget = BigInt(this.budgets.cells);
    // Group numbers repeat across sessions and across aliases of the same track (legal same-track ownership). When the
    // rows of this track come from more than one (session, alias), each row names its own; otherwise nothing is added.
    const ambiguousOwnership = new Set(groups.map(g => `${g.sessionId}/${g.trackAlias}`)).size > 1;
    const ownership = (g: Group) => (ambiguousOwnership ? `session ${g.sessionId} · alias ${g.trackAlias}` : null);
    // Each row shows a WINDOW of up to `budget` object ids anchored at the
    // lowest retained id and clamped to the uint64 domain. Ids beyond it are
    // counted, not drawn; a terminal bound only labels.
    const rows: Row[] = groups.map((g, r) => {
      const ids = [...g.objects.keys()];
      const from = ids.length ? ids.reduce((a, b) => (big(a) < big(b) ? a : b)) : '0';
      const toBig = big(from) + budget - 1n;
      const to = (toBig > U64_MAX ? U64_MAX : toBig).toString();
      const beyond = ids.filter(id => big(id) > big(to)).length;
      const offsets = [...g.objects.values()].map(o => o.offsetMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
      const p50 = offsets.length >= 2 ? Math.round(offsets[Math.floor(offsets.length / 2)]!) : null;
      const highestInWindow = ids.filter(id => big(id) <= big(to)).reduce((a, b) => (big(a) > big(b) ? a : b), from);
      const width = Number(big(highestInWindow) - big(from) + 1n);   // ≤ cells by construction
      const cells: Cell[] = Array.from({ length: width }, (_, i) => {
        const objectId = (big(from) + BigInt(i)).toString();
        const o = g.objects.get(objectId);
        const st = o ? this.stages.get(o.deliveryId) : undefined;
        const cls = !o ? '' : o.independence === 'independent' ? 'key' : o.independence === 'expected-independent' ? 'key expected' : bandOf(o.offsetMs);
        return { cls: cls + (st?.discards.length ? ' discarded' : ''), sel: sel?.groupKey === g.key && sel.objectId === objectId, g: g.key, o: objectId, present: !!o };
      });
      const observed = g.summary ? `${g.summary.observedObjects} obs (source)${g.objects.size !== Number(g.summary.observedObjects) ? ` · ${g.objects.size} retained` : ''}` : `${g.objects.size} obs`;
      const parts = [observed,
        g.bound ? `ends o${g.bound.objectId}${g.bound.bound === 'exclusive' ? ' (excl.)' : ''}` : null,
        g.summary && !g.summary.completeCapture ? 'partial capture' : null,
        beyond ? `+${beyond} beyond window` : null,
        g.evictedObjects ? `${g.evictedObjects} evicted here` : null,
        p50 !== null ? `${p50}ms` : null].filter((p): p is string => p !== null);
      return { label: `g ${g.groupId}`, head: r === 0, meta: parts.join(' · '), context: ownership(g),
        metaClass: g.summary && !g.summary.completeCapture ? 'loss' : r === 0 ? 'live' : '', cells, window: { from, to, beyond } };
    });
    const columns = rows.length ? Math.max(...rows.map(r => r.cells.length)) : 1;

    let selected: (readonly [string, string, string?])[] = [];
    if (sel) {
      const g = this.groups.get(sel.groupKey);
      const o = g?.objects.get(sel.objectId);
      const st = o ? this.stages.get(o.deliveryId) : undefined;
      const discardText = st?.discards.length
        ? ` · discarded (${st.discards.filter(Boolean).join(', ') || 'no reason'}${st.droppedDiscards ? `, +${st.droppedDiscards} earlier` : ''})` : '';
      const stageText = !o ? 'not observed' : st ? [...st.stages].join(' · ') + discardText : 'received';
      selected = [
        ['selected', g ? `g${g.groupId} / o${sel.objectId}` : '—'],
        ['arrival offset', !o ? 'pending' : o.offsetMs === null ? 'other clock' : `+${Math.round(o.offsetMs)} ms`],
        ['size', o ? `${o.payloadBytes.toLocaleString()} B` : '—'],
        ['stream', o && o.streamId !== null ? `${o.subgroupId !== null ? 'subgroup ' : ''}stream ${o.streamId}` : '—'],
        ['status', stageText, st?.discards.length ? 'lost' : o ? 'ok' : ''],
        // Ownership is spelled out only when this track's rows come from more than one (session, alias).
        ...(g && ownership(g) ? [['session', g.sessionId] as const, ['alias', g.trackAlias] as const] : []),
      ];
    }

    // A metric for the selected track in the current session, else a
    // session-wide one for THAT session, else a true source-wide metric.
    // Never another session's or another track's.
    const metricFor = (name: string): Spark => {
      const sessionId = session?.sessionId ?? null;
      const m = (track && sessionId !== null ? this.metrics.get(tupleKey(sessionId, track.trackId, name)) : undefined)
        ?? (sessionId !== null ? this.metrics.get(tupleKey(sessionId, null, name)) : undefined)
        ?? this.metrics.get(tupleKey(null, null, name)) ?? null;
      const label = name.replaceAll('_', ' ');
      if (!m) return { name: label, now: 'unavailable', na: 'not reported by this source', bars: [] };
      // History of THIS series only, scaled to its own maximum; the newest sample is the most opaque.
      const key = tupleKey(m.sessionId, m.trackId, m.name);
      const series = this.metricHistory.get(key) ?? [];
      const peak = series.reduce((a, s) => Math.max(a, s.v), 0);
      const bars = series.map((s, i) => ({ h: peak > 0 ? Math.max(1, Math.round((s.v / peak) * 34)) : 1, color: GREY, op: 0.35 + 0.65 * ((i + 1) / series.length) }));
      const range = series.length ? { range: `${series.length} sample${series.length === 1 ? '' : 's'} · peak ${peak} ${m.unit}` } : {};
      if (m.value === null) return { name: label, now: 'unavailable', na: `${na(m.unavailable)}: ${m.definition}`, ...range, bars };
      // Point samples as the source defined them — no median or interpolation implied.
      return { name: label, now: `${m.value} ${m.unit}`, definition: m.definition + (m.windowMs !== null ? ` (${m.windowMs} ms window)` : ''), ...range, bars };
    };
    // The three canonical charts are always shown (unavailable when not reported); any further metric the
    // source actually reports for this scope is shown too, in this fixed order, so new names from a live
    // player appear without a panel change and nothing is drawn for a name nobody reported.
    const extra = ['av_skew', 'video_buffer_ahead', 'video_playhead', 'video_decode_submissions', 'frames_decoded', 'audio_outputs_decoded', 'frames_rendered', 'objects_received', 'payload_bytes_received',
      'video_presented_frames', 'video_frame_media_time', 'video_frame_age', 'video_paused', 'video_seeking', 'document_hidden', 'diagnostic_limit_events',
      'diagnostic_unattributed_stages', 'diagnostic_unattributed_inputs', 'diagnostic_evidence_loss', 'diagnostic_unobservable_appends',
      'diagnostic_unobservable_video_outputs', 'diagnostic_unobservable_audio_outputs', 'diagnostic_refused_reconstructed_units',
      'diagnostic_refused_video_units', 'diagnostic_refused_audio_units', 'diagnostic_input_admission_refusals', 'diagnostic_unattributed_deliveries'];
    const sparks = [metricFor('end_to_end_latency'), metricFor('arrival_jitter'), metricFor('receive_bitrate'),
      ...extra.map(metricFor).filter(s => s.na !== 'not reported by this source')];

    const events = [
      ...[...this.controlCounts].map(([type, n]) => ({ name: type, count: `×${n}`, color: GREY })),
      ...[...this.streams.values()].filter(s => s.state === 'reset').map(s => ({ name: `stream ${s.streamId} reset${s.code !== null ? ' · code ' + s.code : ''}`, count: '', color: RED })),
      ...this.failures.map(f => ({ name: `${f.stage} ${f.outcome} · ${f.attribution === 'unknown' ? 'cause unknown' : f.attribution}`, count: '', color: RED })),
    ];

    // Append-stage coverage, said in words next to the legend: the `cmaf-append-stages` capability is the ENGINE's
    // static support, not a promise for this media source. A non-zero `diagnostic_unobservable_appends` means the
    // bound media adapter cannot report append completion, so "received" cells are not evidence of a missing append.
    const metricValue = (name: string): number | null => {
      const sessionId = session?.sessionId ?? null;
      const m = (sessionId !== null ? this.metrics.get(tupleKey(sessionId, null, name)) : undefined) ?? this.metrics.get(tupleKey(null, null, name)) ?? null;
      return m && typeof m.value === 'number' ? m.value : null;
    };
    // Each stage capability is the ENGINE's static support for one packaging and is explained in words; the
    // matching "unobservable" counter says when the bound media component cannot report completion. Audio has no
    // presentation stage by design (Web Audio offers no audible witness), so its note says so.
    const legendParts: string[] = [];
    if (source?.capabilities.includes('cmaf-append-stages')) {
      const n = metricValue('diagnostic_unobservable_appends');
      legendParts.push(n !== null && n > 0
        ? `appends unobservable (${n}) — this media adapter cannot report append completion; no stage is inferred`
        : 'append stages reported when the media source supports append observation');
    }
    if (source?.capabilities.includes('loc-video-stages')) {
      const n = metricValue('diagnostic_unobservable_video_outputs');
      legendParts.push(n !== null && n > 0
        ? `video presentation unobservable (${n}) — this renderer cannot report frame outcomes; no stage is inferred`
        : 'video: decoded · scheduled · presented reported from the renderer\'s own draw witness');
    }
    if (source?.capabilities.includes('loc-audio-stages')) {
      const n = metricValue('diagnostic_unobservable_audio_outputs');
      legendParts.push(n !== null && n > 0
        ? `audio scheduling unobservable (${n}) — this output cannot report schedule outcomes; no stage is inferred`
        : 'audio: decoded · scheduled reported; presentation is not observable (no audible witness) and is never inferred');
    }
    const legendNote = legendParts.length ? legendParts.join(' · ') : null;
    const panelEvicted = Object.values(this.evictions).reduce((a, b) => a + b, 0);
    const notes = [
      exposed ? 'protocol 1.x' : null,
      this.sourceEnded ? `capture ended · ${this.sourceEnded.reason}` : null,
      this.loss.batches ? `delivery drops: ${this.loss.dense} dense · ${this.loss.sparse} sparse over ${this.loss.batches} batch${this.loss.batches === 1 ? '' : 'es'}` : null,
      this.retention ? `source evicted ${this.retention.evictedDense} dense · ${this.retention.evictedSparse} sparse${this.omittedFacts ? ` · snapshot omitted ${this.omittedFacts}` : ''}` : null,
      panelEvicted ? `panel evicted ${panelEvicted}` : null,
      this.unknownFacts ? `${this.unknownFacts} unknown facts` : null,
    ].filter((p): p is string => p !== null);

    return {
      synthetic: source?.synthetic ?? false,
      mode: this.view.mode, exposed, paused: this.view.paused,
      needsResnapshot: this.needsResnapshot,
      sourceEnded: this.sourceEnded,
      // No host is wired to record or detach yet; the panel disables those.
      actions: { pause: true, mode: true, record: false, detach: false },
      recording: { active: this.recording?.state === 'recording',
        owner: this.recording?.ownerAttachmentId ? (this.recording.ownerAttachmentId === this.cursor?.target.attachmentId ? 'me' : 'other') : null,
        elapsedMs: null },
      hookStats: exposed ? notes.join(' · ') : 'no exposed sources',
      picker: { name: source?.label ?? 'no source', meta: session ? `${session.endpoint?.origin ?? ''}${session.draft ? ' · d' + session.draft : ''}` : '' },
      instances: (this.hello?.sources ?? (source ? [source] : [])).map(s => ({ id: s.sourceId, name: s.label ?? s.sourceId,
        sub: `${s.kind}${s.exposure ? ' · ' + s.exposure : ''}${s.synthetic ? ' · SYNTHETIC' : ''}`, on: s.sourceId === source?.sourceId })),
      session: sessionRows, requests,
      decoder: [['capabilities', source ? source.capabilities.join(', ') : '—'], ...(legendNote ? [['append stages', legendNote] as [string, string]] : [])],
      legendNote,
      tracks: [...this.tracks.values()].map(t => ({ id: t.trackId, name: t.displayName ?? (t.identity ? hexText(t.identity.name) : t.trackId), on: t.trackId === selectedTrack })),
      ring: `ring buffer: ${this.budgets.groups} groups · ${this.budgets.cells}-object window`,
      colHeader: track ? `${track.displayName ?? track.trackId}${track.codec ? ' · ' + track.codec : ''}${track.packaging ? ' · ' + track.packaging : ''}` : '—',
      columns, rows, selected, sparks, events,
      detail: this.detail ? { scope: this.detail.scope, facts: this.detail.facts.length } : null,
      sourceCapabilities: source ? source.capabilities : [],
      canRecord: source?.capabilities.includes('recording') ?? false,
    };
  }
}
