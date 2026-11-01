import {
  encodeMessage, MAX_MESSAGE_BYTES, projectObservation, projectSource, PROTOCOL_VERSION,
} from '@openmoq/devtools-protocol';
import type {
  AttachmentTarget, Fact, Observation, SequencedObservation, Snapshot, SnapshotScope, SourceDescriptor,
} from '@openmoq/devtools-protocol';
import type { CaptureAttachment, CaptureLane, CaptureLimits, CaptureOptions } from './types.js';

const MAX_SEQUENCE = 0xffffffffffffffffn;
const TERMINAL_BYTES = 512;
const BATCH_ENVELOPE_BYTES = 2048;
const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

const defaults: CaptureLimits = {
  stateMaxEvents: 256, stateMaxBytes: 524288,
  historyMaxEvents: 2048, historyMaxBytes: 4194304, historyMaxAgeMs: 30000,
  pendingMaxEvents: 128, pendingMaxBytes: 65536, maxAttachments: 8,
};

interface Retained {
  readonly event: SequencedObservation;
  readonly observation: Observation;
  readonly lane: CaptureLane;
  /** Encoded event plus a comma. Conservative for snapshot observations without seq. */
  readonly bytes: number;
}

/** Insertion-ordered bounded storage with constant-time removal of its oldest entry. */
class Store<K> {
  readonly entries = new Map<K, Retained>();
  bytes = 0;
  add(key: K, value: Retained): void {
    this.entries.set(key, value);
    this.bytes += value.bytes;
  }
  remove(key: K): Retained | undefined {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.bytes -= value.bytes; }
    return value;
  }
  oldest(): [K, Retained] | undefined { return this.entries.entries().next().value; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}

interface LeaseState {
  readonly target: AttachmentTarget;
  readonly pending: Store<bigint>;
  ready: boolean;
  delivered: bigint;
  through: bigint;
  dense: bigint;
  sparse: bigint;
}

function stateKey(fact: Fact): string | undefined {
  switch (fact.kind) {
    case 'session': return JSON.stringify([fact.kind, fact.sessionId]);
    case 'track': return JSON.stringify([fact.kind, fact.trackId]);
    case 'request': return JSON.stringify([fact.kind, fact.sessionId, fact.requestId]);
    case 'stream': return JSON.stringify([fact.kind, fact.sessionId, fact.streamId]);
    case 'metric': return JSON.stringify([fact.kind, fact.sessionId, fact.trackId, fact.name]);
    case 'dial_attempt': return JSON.stringify([fact.kind, fact.attemptId]);
    case 'group_summary': return JSON.stringify([fact.kind, fact.sessionId, fact.trackAlias, fact.groupId]);
    case 'recording': return fact.kind;
    default: return undefined;
  }
}

function matches(fact: Fact, scope: SnapshotScope): boolean {
  switch (scope.kind) {
    case 'source': return true;
    case 'track': return 'trackId' in fact && fact.trackId === scope.trackId;
    case 'delivery': return 'deliveryId' in fact && fact.deliveryId === scope.deliveryId;
    case 'group': return 'sessionId' in fact && 'trackAlias' in fact && 'groupId' in fact
      && fact.sessionId === scope.sessionId && fact.trackAlias === scope.trackAlias && fact.groupId === scope.groupId;
  }
}

/**
 * One diagnostic source/run. No transport, DOM, media buffers, timers, or send callbacks.
 * Capture is active only while attached. All returned data is encoded through the shared codec.
 */
export class DiagnosticCapture {
  private readonly source: SourceDescriptor;
  private readonly clockId: string;
  private readonly now: () => number;
  private readonly activity: ((active: boolean) => void) | undefined;
  private readonly allowEndedAttachments: boolean;
  private readonly limits: CaptureLimits;
  private readonly state = new Store<string>();
  private readonly history = new Store<bigint>();
  private readonly leases = new Map<string, LeaseState>();
  private sequence = 0n;
  private nextAttachment = 0n;
  private evictedDense = 0n;
  private evictedSparse = 0n;
  private lastTime = 0;
  private terminal: Retained | undefined;
  private ended = false;
  private notifiedActive = false;
  private activation = {};
  private emitting: object | undefined;
  private sampling = false;

  constructor(options: CaptureOptions) {
    this.source = projectSource(options.source);
    const clock = options.clock;
    this.clockId = clock.id;
    this.now = clock.now.bind(clock);
    this.activity = options.onActiveChange;
    if (options.allowEndedAttachments !== undefined && typeof options.allowEndedAttachments !== 'boolean') throw new Error('Invalid ended capture policy');
    this.allowEndedAttachments = options.allowEndedAttachments ?? false;
    this.limits = { ...defaults, ...options.limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Capture limits must be positive safe integers');
    }
    const l = this.limits;
    if (l.pendingMaxBytes < TERMINAL_BYTES || l.pendingMaxBytes > MAX_MESSAGE_BYTES - BATCH_ENVELOPE_BYTES
      || l.pendingMaxEvents > 2048 || l.maxAttachments > 64
      || !Number.isSafeInteger(l.stateMaxBytes + l.historyMaxBytes + TERMINAL_BYTES)
      || !Number.isSafeInteger(l.stateMaxEvents + l.historyMaxEvents + 1)) {
      throw new Error('Capture limits exceed storage or wire bounds');
    }
    // Validate the clock and worst-sized envelope without reading the clock or activating observers.
    const target = { ownerId: 'x'.repeat(128), sourceId: this.source.sourceId,
      runId: this.source.runId, attachmentId: 'x'.repeat(128) };
    encodeMessage({ ...this.snapshotBase(target, 'x'.repeat(128), {
      kind: 'group', sessionId: 'x'.repeat(128), trackAlias: String(MAX_SEQUENCE), groupId: String(MAX_SEQUENCE),
    }), watermark: String(MAX_SEQUENCE), omittedFacts: Number.MAX_SAFE_INTEGER,
      facts: [{ clockId: this.clockId, timeMs: Number.MAX_VALUE,
        fact: { kind: 'source_state', state: 'ended', reason: 'sequence-exhausted' } }] });
  }

  get active(): boolean { return !this.ended && this.leases.size > 0; }

  /** Discovery copies metadata without activating observers or reading the clock. */
  get descriptor(): SourceDescriptor { return projectSource(this.source); }

  /**
   * Producers must redact known text fields. Projection removes unknown data, not secrets in labels.
   * Invalid observations are accounted drops. source_state is reserved for this source's lifecycle.
   */
  emit(fact: Fact, lane: CaptureLane): boolean {
    if (!this.active || this.emitting === this.activation || (lane !== 'dense' && lane !== 'sparse')) return false;
    const activation = this.activation;
    this.emitting = activation;
    try {
      if (!this.readClock() || !this.active || this.activation !== activation) return false;
      if (this.sequence === MAX_SEQUENCE - 1n) { this.end('sequence-exhausted'); return false; }
      let observation: Observation;
      try {
        observation = projectObservation({ clockId: this.clockId, timeMs: this.lastTime, fact });
        if (observation.fact.kind === 'source_state') throw new Error('Reserved source lifecycle');
      } catch {
        if (this.active && this.activation === activation) {
          this.sequence++;
          this.evicted(lane);
          this.deliver(undefined, lane);
        }
        return false;
      }
      // Getters in producer input may have ended capture or detached its last observer.
      if (!this.active || this.activation !== activation) return false;
      this.sequence++;
      const value = this.retained(observation, lane);
      this.expireHistory();
      const key = stateKey(observation.fact);
      if (key === undefined) this.retain(this.history, this.sequence, value, this.limits.historyMaxEvents, this.limits.historyMaxBytes);
      else this.retain(this.state, key, value, this.limits.stateMaxEvents, this.limits.stateMaxBytes);
      this.deliver(value, lane);
      return true;
    } finally { if (this.emitting === activation) this.emitting = undefined; }
  }

  /**
   * Throws on invalid identities, attachment/identity exhaustion, reentrant clock access,
   * or an ended source unless retained read-only inspection was explicitly enabled.
   * Historical inspection never activates observers or reads the ended source's clock.
   */
  attach(ownerId: string, requestId: string): CaptureAttachment {
    if (this.ended && (!this.allowEndedAttachments || !this.terminal)) throw new Error('Capture source ended');
    if (this.sampling) throw new Error('Reentrant clock access');
    encodeMessage({ ...common, kind: 'attach', requestId,
      target: { ownerId, sourceId: this.source.sourceId, runId: this.source.runId } });
    if (this.leases.size >= this.limits.maxAttachments) throw new Error('Capture attachment limit reached');
    if (this.nextAttachment === MAX_SEQUENCE) throw new Error('Capture attachment identity exhausted');
    if (!this.ended && !this.readClock()) throw new Error('Capture source ended');
    const target = { ownerId, sourceId: this.source.sourceId, runId: this.source.runId,
      attachmentId: `attachment-${++this.nextAttachment}` };
    const state: LeaseState = { target, pending: new Store(), ready: false,
      delivered: this.sequence, through: this.sequence, dense: 0n, sparse: 0n };
    if (this.leases.size === 0) this.activation = {};
    this.leases.set(target.attachmentId, state);
    this.notifyActivity();
    if (this.ended && (!this.allowEndedAttachments || !this.terminal)) { this.close(state); throw new Error('Capture source ended'); }
    const initial = this.makeSnapshot(target, requestId, { kind: 'source' });
    state.delivered = state.through = this.sequence;
    state.ready = true;
    return { snapshot: initial, lease: {
      get target() { return { ...target }; },
      pull: () => this.pull(state),
      refresh: (id, scope = { kind: 'source' }) => this.refresh(state, id, scope),
      close: () => this.close(state),
    } };
  }

  /** End diagnostics, not the observed transport. Open leases can drain their terminal batch. */
  dispose(): void {
    if (this.ended) return;
    if (this.active && !this.sampling && !this.readClock()) return;
    this.end('disposed');
  }

  private readClock(): boolean {
    if (this.ended) return false;
    if (this.sampling) { this.end('clock-error'); return false; }
    this.sampling = true;
    try {
      const time = this.now();
      if (!Number.isFinite(time) || time < this.lastTime) throw new Error('Invalid monotonic clock');
      if (this.ended) return false;
      this.lastTime = time;
      return true;
    } catch { this.end('clock-error'); return false; }
    finally { this.sampling = false; }
  }

  private retained(observation: Observation, lane: CaptureLane): Retained {
    const event = { seq: String(this.sequence), ...observation };
    return { event, observation, lane, bytes: bytes(event) + 1 };
  }

  private end(reason: 'disposed' | 'sequence-exhausted' | 'clock-error'): void {
    if (this.ended) return;
    this.ended = true;
    this.sequence++;
    this.terminal = this.retained({ clockId: this.clockId, timeMs: this.lastTime,
      fact: { kind: 'source_state', state: 'ended', reason } }, 'sparse');
    this.deliver(this.terminal, 'sparse');
    this.notifyActivity();
    if (this.leases.size === 0) this.clearRetention();
  }

  private notifyActivity(): void {
    const active = this.active;
    if (active === this.notifiedActive) return;
    this.notifiedActive = active;
    try {
      const result: unknown = this.activity?.(active);
      // A void callback can still return a rejected Promise in TypeScript. Own it without awaiting it.
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostics must not throw into the application. */ }
  }

  private evicted(lane: CaptureLane): void {
    if (lane === 'dense') this.evictedDense++; else this.evictedSparse++;
  }

  private retain<K>(store: Store<K>, key: K, value: Retained, maxEvents: number, maxBytes: number): void {
    const replaced = store.remove(key);
    if (replaced) this.evicted(replaced.lane);
    if (value.bytes > maxBytes) { this.evicted(value.lane); return; }
    store.add(key, value);
    while (store.entries.size > maxEvents || store.bytes > maxBytes) {
      const oldest = store.oldest()!;
      store.remove(oldest[0]); this.evicted(oldest[1].lane);
    }
  }

  private expireHistory(): void {
    for (let oldest = this.history.oldest(); oldest; oldest = this.history.oldest()) {
      if (oldest[1].observation.timeMs >= this.lastTime - this.limits.historyMaxAgeMs) break;
      this.history.remove(oldest[0]); this.evicted(oldest[1].lane);
    }
  }

  private deliver(value: Retained | undefined, lane: CaptureLane): void {
    for (const lease of this.leases.values()) {
      if (!lease.ready) continue;
      lease.through = this.sequence;
      if (!value || value.bytes > this.limits.pendingMaxBytes) { lease[lane]++; continue; }
      lease.pending.add(this.sequence, value);
      while (lease.pending.entries.size > this.limits.pendingMaxEvents || lease.pending.bytes > this.limits.pendingMaxBytes) {
        const oldest = lease.pending.oldest()!;
        lease.pending.remove(oldest[0]); lease[oldest[1].lane]++;
      }
    }
  }

  private owns(lease: LeaseState): boolean { return this.leases.get(lease.target.attachmentId) === lease; }

  private pull(lease: LeaseState): string | null {
    if (!this.owns(lease) || lease.through === lease.delivered) return null;
    const frame = encodeMessage({ ...common, kind: 'batch', target: lease.target,
      fromSeq: String(lease.delivered + 1n), toSeq: String(lease.through),
      dropped: { dense: String(lease.dense), sparse: String(lease.sparse) },
      events: Array.from(lease.pending.entries.values(), value => value.event) });
    lease.delivered = lease.through;
    lease.pending.clear(); lease.dense = lease.sparse = 0n;
    return frame;
  }

  private refresh(lease: LeaseState, requestId: string, scope: SnapshotScope): readonly string[] {
    if (!this.owns(lease)) return [];
    if (this.sampling) throw new Error('Reentrant clock access');
    // Validate and copy the caller's scope before consuming any pending delivery.
    const request = encodeMessage({ ...common, kind: 'snapshot.request', requestId, target: lease.target, scope });
    const safeScope = (JSON.parse(request) as { scope: SnapshotScope }).scope;
    if (!this.ended) this.readClock();
    if (!this.owns(lease)) return [];
    const frame = this.makeSnapshot(lease.target, requestId, safeScope);
    const pending = safeScope.kind === 'source' ? this.pull(lease) : null;
    return pending === null ? [frame] : [pending, frame];
  }

  private snapshotBase(target: AttachmentTarget, requestId: string, scope: SnapshotScope): Snapshot {
    return { ...common, kind: 'snapshot', requestId, target, source: this.source, scope,
      watermark: String(this.sequence), clocks: [{ id: this.clockId, unit: 'ms', kind: 'monotonic' }],
      facts: [], omittedFacts: 0, retention: {
        maxEvents: this.limits.stateMaxEvents + this.limits.historyMaxEvents + 1,
        maxBytes: this.limits.stateMaxBytes + this.limits.historyMaxBytes + TERMINAL_BYTES,
        maxAgeMs: this.limits.historyMaxAgeMs,
        retainedEvents: this.state.entries.size + this.history.entries.size + (this.terminal ? 1 : 0),
        retainedBytes: this.state.bytes + this.history.bytes + (this.terminal?.bytes ?? 0),
        evictedDense: String(this.evictedDense), evictedSparse: String(this.evictedSparse),
      } };
  }

  private makeSnapshot(target: AttachmentTarget, requestId: string, scope: SnapshotScope): string {
    this.expireHistory();
    const base = this.snapshotBase(target, requestId, scope);
    // Terminal and current state take priority, then recent history. Return chosen facts in observation order.
    const candidates = [ ...(this.terminal ? [this.terminal] : []),
      ...Array.from(this.state.entries.values()).reverse(), ...Array.from(this.history.entries.values()).reverse(),
    ].filter(value => matches(value.observation.fact, scope));
    let remaining = MAX_MESSAGE_BYTES - bytes({ ...base, omittedFacts: candidates.length });
    const chosen: Retained[] = [];
    for (const value of candidates) {
      const cost = bytes(value.observation) + 1;
      if (chosen.length === 2048 || cost > remaining) continue;
      chosen.push(value); remaining -= cost;
    }
    chosen.sort((a, b) => BigInt(a.event.seq) < BigInt(b.event.seq) ? -1 : 1);
    return encodeMessage({ ...base, omittedFacts: candidates.length - chosen.length,
      facts: chosen.map(value => value.observation) });
  }

  private close(lease: LeaseState): void {
    if (!this.owns(lease)) return;
    this.leases.delete(lease.target.attachmentId);
    lease.pending.clear();
    if (this.leases.size === 0) this.clearRetention();
    this.notifyActivity();
  }

  private clearRetention(): void {
    for (const store of [this.state, this.history]) {
      for (const value of store.entries.values()) this.evicted(value.lane);
      store.clear();
    }
    this.terminal = undefined;
  }
}
