/**
 * Internal, owner-local initial-prefix gate; no transport or format decoding.
 *
 * API: construct once per (connection, subscription owner / warm attempt), call
 * acceptLargest(saved SUBSCRIBE Largest Location | null) before alias replay,
 * push raw envelopes, finishPrefix(fin | reset | error), and retire on teardown.
 * Largest is UNKNOWN until accepted; null explicitly means an empty prefix.
 * One instance covers one initial retrieval, not all fills on a subscription.
 *
 * deliver receives value plus { backfill, isLive }, and must compose isLive
 * with its route guard before/after application callbacks and transform awaits,
 * including rejection/recovery paths. The admission boundary owns provenance;
 * this helper never captures it again. Once deliver starts, that route owns the
 * item's terminal outcome: this helper calls discard ONLY for unstarted items.
 * A fulfilled delivery promise proves settlement, not append/decode success.
 *
 * Only [Largest.group:0, Largest] is made contiguous. Afterwards a bounded live
 * handoff selects held items in location order, then ordinary live delivery
 * passes directly through. An arrival cannot reorder already dispatched live
 * data; repairs outside the prefix remain the caller's normal gap policy.
 * A compact prefix fence remains; steady-state gap policy stays in LOC
 * and MSE. Expiry/failure abandons the head group and waits for a future live
 * group at object 0 classified as group-start by its caller. Group-start means
 * nonempty DATA at object 0; the format pipeline still validates independence.
 * EOG and other gaps are ordinary, never a restart. Unknown-Largest failure
 * discards data until a cutoff or empty is supplied.
 *
 * Mandatory continuation classifies each raw envelope without inspecting T.
 * Terminal means ONLY EndOfTrack status 4, bytes=0. The first terminal owns one
 * separate slot; every later terminal is discarded as duplicate, including
 * after delivery. It survives data fences and cannot establish a restart floor
 * or make the phase live. Within the saved prefix it advances its own location
 * only after lower locations settle. Otherwise it waits for prefix completion,
 * abandonment, and prior queued/in-flight warm work (even fenced transforms).
 * Arrival of a terminal alone never abandons a missing prefix. The caller's
 * terminal route guard follows owner lifetime, not abandoned data generations;
 * a warm timeout must not erase an EOT whose delivery has already started.
 * The caller's finite-delivery barrier still owns settlement of ordinary
 * direct live work.
 *
 * Data bounds include queued and in-flight warm/handoff items, including fenced
 * old transforms until they settle. One zero-byte terminal is outside the data
 * budget: retainedObjects may reach maxObjects+1, retainedBytes stays bounded
 * by maxBytes. Direct steady-state deliveries belong to the
 * caller and are outside those warm retention counters. The injected clock is
 * monotonic microseconds; host timers independently wake the deadline.
 */
import type { ClockSource } from '@openmoq/playback';

export interface WarmStartLocation {
  readonly group: bigint;
  readonly object: bigint;
}

export interface WarmStartItem<T> extends WarmStartLocation {
  readonly bytes: number;
  readonly source: 'prefix' | 'live';
  readonly continuation: 'group-start' | 'terminal' | 'ordinary';
  readonly value: T;
}

export type WarmStartAbandonReason = 'timeout' | 'reset' | 'error' | 'overflow' | 'incomplete prefix';
export type WarmStartDiscardReason = WarmStartAbandonReason | 'retired' | 'duplicate'
  | 'stale prefix' | 'outside prefix' | 'awaiting largest' | 'awaiting group start';
export type WarmStartPhase = 'prefix' | 'handoff' | 'fallback' | 'live' | 'retired';

export interface WarmStartDelivery {
  readonly backfill: boolean;
  readonly isLive: () => boolean;
}

export interface WarmStartHeadOptions<T> {
  readonly clock: ClockSource;
  /** Pure ownership predicate, independent of diagnostic attachment. */
  readonly isCurrent: () => boolean;
  readonly deliver: (value: T, delivery: WarmStartDelivery) => void | Promise<void>;
  readonly discard: (value: T, reason: WarmStartDiscardReason) => void;
  readonly onAbandon?: (reason: WarmStartAbandonReason) => void;
  readonly onError?: (error: unknown) => void;
  readonly maxWaitUs?: number;
  readonly maxObjects?: number;
  readonly maxBytes?: number;
}

interface Delivery<T> {
  readonly item: WarmStartItem<T>;
  readonly generation: number;
  readonly prefix: boolean;
}

function compare(a: WarmStartLocation, b: WarmStartLocation): number {
  return a.group < b.group ? -1 : a.group > b.group ? 1
    : a.object < b.object ? -1 : a.object > b.object ? 1 : 0;
}

function checkLocation(location: WarmStartLocation): void {
  if (typeof location.group !== 'bigint' || location.group < 0n
      || typeof location.object !== 'bigint' || location.object < 0n) {
    throw new TypeError('Warm-start locations must be non-negative bigints');
  }
}

export class WarmStartHead<T> {
  private phase: WarmStartPhase = 'prefix';
  private largest: WarmStartLocation | null | undefined;
  private nextObject = 0n;
  private prefixFin = false;
  private abandoned = false;
  private minimumGroup: bigint | null = null;
  private generation = 0;
  private readonly queued = new Map<string, WarmStartItem<T>>();
  private readonly deliveries = new Set<Delivery<T>>();
  private queuedBytes = 0;
  private deliveryBytes = 0;
  private active: Delivery<T> | null = null;
  private terminal: WarmStartItem<T> | null = null;
  private terminalSeen = false;
  private pumping = false;
  private callbackDepth = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly deadlineUs: number;
  private readonly maxObjects: number;
  private readonly maxBytes: number;

  constructor(private readonly options: WarmStartHeadOptions<T>) {
    const integer = (name: string, value: number, minimum: number) => {
      if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
      return value;
    };
    const wait = integer('maxWaitUs', options.maxWaitUs ?? 1_000_000, 0);
    if (wait > 0x7fffffff * 1000) throw new TypeError('maxWaitUs exceeds the host timer range');
    this.maxObjects = integer('maxObjects', options.maxObjects ?? 100, 1);
    this.maxBytes = integer('maxBytes', options.maxBytes ?? 4 * 1024 * 1024, 1);
    const now = options.clock.now();
    this.deadlineUs = now + wait;
    if (!Number.isFinite(now) || Math.abs(now) > Number.MAX_SAFE_INTEGER
        || !Number.isFinite(this.deadlineUs) || Math.abs(this.deadlineUs) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError('Warm-start clock/deadline exceeds the safe numeric range');
    }
    this.armTimer();
  }

  get state(): WarmStartPhase { return this.phase; }
  get retainedObjects(): number { return this.queued.size + this.deliveries.size + (this.terminal ? 1 : 0); }
  get retainedBytes(): number { return this.queuedBytes + this.deliveryBytes; }

  /** Immutable snapshot; repeating the same answer is harmless. */
  acceptLargest(location: WarmStartLocation | null): void {
    if (location !== null) checkLocation(location);
    if (!this.current()) return;
    if (this.largest !== undefined) {
      if (location === null ? this.largest === null
        : this.largest !== null && compare(location, this.largest) === 0) return;
      throw new Error('Warm-start Largest Location was already accepted');
    }
    this.largest = location === null ? null : { ...location };
    if (location === null) {
      this.phase = 'handoff';
      this.clearTimer();
    }
    this.expire();
    this.removeRejected();
    this.pump();
  }

  push(item: WarmStartItem<T>): void {
    checkLocation(item);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new TypeError('Warm-start bytes must be a non-negative safe integer');
    if (item.source !== 'prefix' && item.source !== 'live') throw new TypeError('Unknown warm-start item source');
    if (item.continuation !== 'ordinary' && item.continuation !== 'group-start' && item.continuation !== 'terminal') {
      throw new TypeError('Warm-start continuation classification is required');
    }
    if (item.continuation === 'group-start' && (item.object !== 0n || item.bytes === 0)) {
      throw new TypeError('Warm-start group-start must be nonempty DATA at object zero');
    }
    if (item.continuation === 'terminal' && item.bytes !== 0) throw new TypeError('Warm-start terminal must have zero payload bytes');
    if (!this.current()) { this.discard(item, 'retired'); return; }
    this.expire();
    if (this.phase === 'retired') { this.discard(item, 'retired'); return; }
    if (item.continuation === 'terminal') {
      // Claim the only control slot before callbacks. A terminal is not data
      // and must survive missing-head fences and saturated in-flight budgets.
      if (this.terminalSeen) { this.discard(item, 'duplicate'); this.pump(); return; }
      this.terminalSeen = true;
      this.terminal = { ...item };
      this.pump();
      return;
    }
    const reason = this.rejection(item);
    if (reason) { this.discard(item, reason); this.pump(); return; }
    if (this.phase === 'live') { this.direct(item); return; }
    const key = this.key(item);
    if (this.queued.has(key) || [...this.deliveries].some(op => compare(op.item, item) === 0)) {
      this.discard(item, 'duplicate'); this.pump(); return;
    }
    const dataObjects = this.queued.size + [...this.deliveries].filter(op => op.item.continuation !== 'terminal').length;
    if (dataObjects >= this.maxObjects || item.bytes > this.maxBytes - this.retainedBytes) {
      this.abandon('overflow', item);
      return;
    }
    // Capture coordinates/accounting even if the caller later reuses its wrapper.
    this.queued.set(key, { ...item });
    this.queuedBytes += item.bytes;
    this.pump();
  }

  /** Only this attempt's single initial retrieval may call this method. */
  finishPrefix(terminal: 'fin' | 'reset' | 'error'): void {
    if (!this.current() || this.phase !== 'prefix') return;
    this.expire();
    if (terminal === 'fin') { this.prefixFin = true; this.pump(); }
    else this.abandon(terminal);
  }

  retire(): void {
    if (this.phase === 'retired') return;
    this.phase = 'retired';
    this.generation++;
    this.active = null;
    this.clearTimer();
    const dropped = this.takeAll();
    const terminal = this.terminal;
    this.terminal = null;
    for (const item of dropped) this.discard(item, 'retired');
    if (terminal) this.discard(terminal, 'retired');
  }

  private key(item: WarmStartLocation): string { return `${item.group}:${item.object}`; }

  private current(): boolean {
    if (this.phase === 'retired') return false;
    try {
      if (this.options.isCurrent()) return this.state !== 'retired';
    } catch (error) { this.retire(); this.error(error); return false; }
    this.retire();
    return false;
  }

  private rejection(item: WarmStartItem<T>): WarmStartDiscardReason | null {
    const largest = this.largest;
    if (this.phase === 'retired') return 'retired';
    if (this.abandoned && largest === undefined) return 'awaiting largest';
    if (this.minimumGroup !== null && item.group < this.minimumGroup) return 'stale prefix';
    if (largest && this.abandoned && item.group <= largest.group) return 'stale prefix';
    if (largest && this.phase !== 'prefix' && compare(item, largest) <= 0) return 'stale prefix';
    if (this.phase === 'prefix' && largest && item.group === largest.group && item.object < this.nextObject) return 'duplicate';
    if (item.source === 'prefix' && (this.phase !== 'prefix' || largest === null
        || largest !== undefined && (item.group !== largest.group || item.object > largest.object))) return 'outside prefix';
    if (this.phase === 'prefix' && largest && item.group < largest.group) return 'stale prefix';
    return null;
  }

  private expire(): void {
    if (this.phase === 'prefix' && this.options.clock.now() >= this.deadlineUs) this.abandon('timeout');
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.current() || this.phase !== 'prefix') return;
      this.expire();
      if (this.phase === 'prefix') this.armTimer(); // Early wake: use the same monotonic deadline.
    }, Math.min(0x7fffffff, Math.max(0, Math.ceil((this.deadlineUs - this.options.clock.now()) / 1000))));
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private takeAll(): WarmStartItem<T>[] {
    const items = [...this.queued.values()];
    this.queued.clear(); this.queuedBytes = 0;
    return items;
  }

  private removeRejected(): void {
    const dropped: Array<[WarmStartItem<T>, WarmStartDiscardReason]> = [];
    for (const [key, item] of this.queued) {
      const reason = this.rejection(item);
      if (!reason) continue;
      this.queued.delete(key); this.queuedBytes -= item.bytes;
      dropped.push([item, reason]);
    }
    for (const [item, reason] of dropped) this.discard(item, reason);
  }

  private abandon(reason: WarmStartAbandonReason, refused?: WarmStartItem<T>): void {
    if (this.phase === 'retired' || this.abandoned) {
      if (refused) this.discard(refused, reason);
      this.pump();
      return;
    }
    this.abandoned = true;
    this.phase = 'fallback';
    this.generation++;
    this.active = null; // Fenced deliveries retain accounting, not pump ownership.
    this.clearTimer();
    const dropped = this.takeAll();
    const keep: WarmStartItem<T>[] = [];
    for (const item of dropped) {
      if (this.largest && item.source === 'live' && item.group > this.largest.group) keep.push(item);
    }
    const kept = new Set(keep);
    for (const item of keep) { this.queued.set(this.key(item), item); this.queuedBytes += item.bytes; }
    this.notify(() => this.options.onAbandon?.(reason));
    for (const item of dropped) if (!kept.has(item)) this.discard(item, reason);
    if (refused) this.discard(refused, reason);
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.callbackDepth > 0) return;
    this.pumping = true;
    try {
      while (this.current()) {
        this.expire();
        if (this.active || this.phase === 'retired') return;
        if (this.phase === 'live') { this.startTerminal(); return; }
        if (this.phase === 'prefix') {
          const largest = this.largest;
          if (largest === undefined || largest === null) return;
          if (this.nextObject > largest.object) {
            this.phase = 'handoff'; this.clearTimer(); this.removeRejected(); continue;
          }
          const location = { group: largest.group, object: this.nextObject };
          const item = this.queued.get(this.key(location))
            ?? (this.terminal && compare(this.terminal, location) === 0 ? this.terminal : undefined);
          if (!item) { if (this.prefixFin) { this.abandon('incomplete prefix'); continue; } return; }
          this.start(item, true);
        } else {
          if (this.phase === 'fallback') {
            if (!this.largest) { this.startTerminal(); return; }
            const start = [...this.queued.values()].filter(item => item.source === 'live' && item.continuation === 'group-start')
              .sort(compare)[0];
            if (!start) {
              const dropped = this.takeAll();
              for (const item of dropped) this.discard(item, 'awaiting group start');
              if (this.queued.size) continue; // A discard callback may have supplied a new start.
              this.startTerminal();
              return;
            }
            this.minimumGroup = start.group;
            this.phase = 'handoff'; this.removeRejected();
            continue;
          }
          const item = [...this.queued.values()].sort(compare)[0];
          if (!item) {
            if (this.terminalSeen) this.startTerminal();
            else this.phase = 'live';
            return;
          }
          this.start(item, false);
        }
      }
    } finally { this.pumping = false; }
  }

  private valid(generation: number): boolean {
    if (!this.current()) return false;
    this.expire();
    return this.phase !== 'retired' && generation === this.generation;
  }

  private start(item: WarmStartItem<T>, prefix: boolean): void {
    if (item.continuation === 'terminal') this.terminal = null;
    else { this.queued.delete(this.key(item)); this.queuedBytes -= item.bytes; }
    const op: Delivery<T> = { item, generation: this.generation, prefix };
    this.deliveries.add(op); this.deliveryBytes += item.bytes;
    this.active = op;
    try {
      const result = this.options.deliver(item.value, { backfill: item.source === 'prefix',
        isLive: item.continuation === 'terminal' ? () => this.current() : () => this.valid(op.generation) });
      if (result) {
        void Promise.resolve(result).then(() => this.settled(op), error => this.settled(op, { error }));
      } else this.settled(op);
    } catch (error) { this.settled(op, { error }); }
  }

  private startTerminal(): void {
    // Abandonment releases pump ownership, not the accepted route's processing
    // lifetime. EOT must wait for those fenced operations to actually settle.
    if (this.terminal && this.deliveries.size === 0) this.start(this.terminal, false);
  }

  private settled(op: Delivery<T>, failure?: { error: unknown }): void {
    this.deliveries.delete(op); this.deliveryBytes -= op.item.bytes;
    if (this.active === op) this.active = null;
    const current = this.valid(op.generation);
    if (current) {
      if (failure) this.abandon('error');
      else if (op.prefix) this.nextObject++;
    }
    if (failure && current) this.error(failure.error);
    this.pump();
  }

  private direct(item: WarmStartItem<T>): void {
    const generation = this.generation;
    try {
      const result = this.options.deliver(item.value, { backfill: false, isLive: () => this.valid(generation) });
      if (result) void Promise.resolve(result).catch(error => this.error(error));
    } catch (error) { this.error(error); }
  }

  private discard(item: WarmStartItem<T>, reason: WarmStartDiscardReason): void {
    this.notify(() => this.options.discard(item.value, reason));
  }

  private notify(callback: () => void): void {
    this.callbackDepth++;
    try { callback(); } catch (error) { this.error(error); }
    finally { this.callbackDepth--; }
  }

  private error(error: unknown): void {
    this.callbackDepth++;
    try { this.options.onError?.(error); } catch { /* An error observer cannot break routing. */ }
    finally { this.callbackDepth--; }
  }
}
