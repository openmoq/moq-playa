import type { SourceTimestamp } from '@openmoq/loc';
import type { SyncController, VideoRenderTiming, VideoTimingSource } from '@openmoq/playback';
import type { VideoFrameObservation, VideoProducedTiming, VideoRendererLike } from './interfaces.js';
import type { DispatcherOutputReason, VideoOutputAdmission } from './command-dispatcher.js';
import { locIndexedPositionMs, snapshotLocIndexedPlacement, type LocIndexedPlacement } from './loc-seek-input.js';

interface AdmissionLease { readonly current: boolean; release(): void; }
interface AdmissionHost {
  installVideoOutputAdmission(owner: VideoOutputAdmission): AdmissionLease;
  refreshVideoOutputs(): void;
}
interface Options {
  readonly dispatcher: AdmissionHost;
  /** Exclusive renderer of this output graph, never the old playing graph. */
  readonly renderer: VideoRendererLike;
  readonly sync: SyncController;
  readonly selected: SourceTimestamp;
  /** Host-validated relative source/content relation; omission keeps exact media PTS. */
  readonly placement?: LocIndexedPlacement;
  readonly mode: 'preview' | 'playing';
  readonly reference: 'video' | 'external';
  readonly maxQueuedFrames: number;
  readonly isCurrent: () => boolean;
  readonly onPresented: (positionMs: number) => void;
  readonly onProgress: () => void;
  /** Deferred until the dispatcher has retained the exact inactive target. */
  readonly onPrepared?: () => void;
  readonly onError: (error: Error) => void;
}

function compare(a: SourceTimestamp, b: SourceTimestamp): bigint {
  return a.ticks * b.ticksPerSecond - b.ticks * a.ticksPerSecond;
}
function milliseconds(point: SourceTimestamp): number | null {
  const scaled = point.ticks * 1000n, whole = scaled / point.ticksPerSecond;
  if (whole < 0n || whole > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(whole) + Number(scaled % point.ticksPerSecond) / Number(point.ticksPerSecond);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** One fresh output graph's video timing and draw authority, not a seek/request owner. */
export class LocSeekVideoOutput implements VideoOutputAdmission {
  readonly timingSource: VideoTimingSource;
  private readonly options: Options;
  private readonly selected: SourceTimestamp;
  private readonly placement: LocIndexedPlacement | undefined;
  private readonly contexts = new WeakMap<VideoRenderTiming, bigint>();
  private readonly pending = new Set<VideoProducedTiming>();
  private readonly outstanding = new Set<VideoProducedTiming>();
  private targetProof: VideoProducedTiming | undefined;
  private lease: AdmissionLease | undefined;
  private off: (() => void) | undefined;
  private started = false;
  private active = false;
  private stopped = false;
  private positioned = false;
  private progressQueued = false;
  private last: SourceTimestamp | null = null;
  private mode: Options['mode'];

  constructor(options: Options) {
    const requestedPlacement = options.placement;
    const placement = requestedPlacement === undefined ? undefined : snapshotLocIndexedPlacement(requestedPlacement);
    const { ticks, ticksPerSecond, domain } = options.selected;
    if (typeof ticks !== 'bigint' || typeof ticksPerSecond !== 'bigint' || ticksPerSecond <= 0n
        || (domain !== 'media' && !(placement && domain === 'unix'))
        || (placement && domain !== placement.sourceAnchor.domain)) {
      throw new Error('LOC seek output needs declared media time');
    }
    const selected = Object.freeze({ ticks, ticksPerSecond, domain });
    this.placement = placement;
    if (this.positionMs(selected) === null) throw new Error('LOC seek position is not representable');
    if (!Number.isSafeInteger(options.maxQueuedFrames) || options.maxQueuedFrames <= 0) throw new RangeError('Invalid video output budget');
    if (options.mode !== 'preview' && options.mode !== 'playing') throw new Error('Unknown LOC output mode');
    if (options.reference !== 'video' && options.reference !== 'external') throw new Error('Unknown LOC output reference');
    this.selected = selected;
    this.mode = options.mode;
    this.options = { ...options, selected, ...(placement === undefined ? {} : { placement }) };
    this.timingSource = Object.freeze({
      captureVideoOutputTiming: (raw: bigint): VideoRenderTiming | null => {
        if (!this.live()) return null;
        const context = Object.freeze({ recomputeRenderTimeUs: () => this.schedule(raw) });
        this.contexts.set(context, raw); return context;
      },
      // Coded preroll must reach the decoder even before an output reference exists.
      computeVideoRenderTime: (raw: bigint) => {
        if (!this.live()) return null;
        const timing = this.options.sync.hasReference ? this.options.sync.computeVideoRenderTime(raw) : null;
        return this.live() ? { renderTimeUs: timing?.renderTimeUs ?? 0, offsetUs: timing?.offsetUs ?? 0, shouldDrop: false } : null;
      },
    });
  }

  get current(): boolean { return this.live(); }
  get firstPresented(): boolean { return this.positioned; }
  /** Inactive candidates inherit the latest intent before any output is adopted. */
  setMode(mode: Options['mode']): void {
    if (this.active) throw new Error('Active LOC output needs fresh preparation to change mode');
    this.mode = mode;
  }
  /** Current native frames held by this admission or queued in its renderer. */
  get pendingOutputCount(): number { return this.outstanding.size; }
  /** Exact selected output held during inactive admission, not a clock or draw. */
  get hasTargetOutput(): boolean {
    const proof = this.targetProof, lease = this.lease;
    return proof !== undefined && lease !== undefined && this.live()
      && this.targetProof === proof && this.lease === lease;
  }
  /**
   * Last actual picture, never a wall-clock projection or admitted target.
   * Indexed mode reports nominal = index-ms + exact source delta.
   * Under the declared mapping, actual PTS - nominal is [0,1)ms for floor
   * (nominal underestimates actual) or [-.5,.5]ms for nearest, before Number
   * conversion. New seeks use the conservative lower bound; resume retains
   * the already observed source point and its existing placement.
   */
  readPositionMs(): number | null {
    const point = this.last;
    if (!point || !this.live()) return null;
    const value = this.positionMs(point);
    return this.live() && this.last === point ? value : null;
  }

  /** Source identity of the actual last draw, for a same-selection resume. */
  captureSourcePosition(): SourceTimestamp | null {
    const point = this.last;
    if (!point || !this.live()) return null;
    return Object.freeze({ ticks: point.ticks, ticksPerSecond: point.ticksPerSecond, domain: point.domain });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      if (!this.live()) { this.stop(); return; }
      const observe = this.options.renderer.observeFrames;
      if (this.options.renderer.supportsOutputTiming !== true || typeof observe !== 'function') throw new Error('Renderer cannot prove producing draws');
      if (!this.live()) { this.stop(); return; }
      const off = observe.call(this.options.renderer, event => this.observed(event));
      if (typeof off !== 'function') throw new Error('Renderer observation did not return cleanup');
      if (!this.live()) { off(); this.stop(); return; }
      this.off = off;
      const lease = this.options.dispatcher.installVideoOutputAdmission(this);
      if (this.stopped || !this.ownerCurrent()) { lease.release(); this.stop(); return; }
      this.lease = lease;
      if (!lease.current) throw new Error('Video output registration was superseded');
    } catch (error) { this.fail(error); }
  }

  activate(): void {
    if (!this.started) this.start();
    if (!this.live()) return;
    this.active = true;
    try { this.options.dispatcher.refreshVideoOutputs(); }
    catch (error) { this.fail(error); }
  }

  decide(proof: VideoProducedTiming): 'enqueue' | 'hold' | 'discard' {
    if (!this.live()) return 'discard';
    const raw = this.contexts.get(proof.context), point = proof.sourceTimestamp;
    const domain = this.placement?.sourceAnchor.domain ?? 'media';
    if (raw === undefined || point.domain !== domain || typeof point.ticks !== 'bigint'
        || typeof point.ticksPerSecond !== 'bigint' || point.ticksPerSecond <= 0n) {
      this.fail(new Error('Decoded video has no current media-time context')); return 'discard';
    }
    const relative = compare(point, this.selected);
    if (relative < 0n) return 'discard';
    this.outstanding.add(proof);
    if (!this.active) {
      // The dispatcher retains this exact proof after admission returns. Losing
      // that held output must retire readiness even before it reserves a slot.
      if (relative === 0n && this.started && this.targetProof === undefined) {
        this.targetProof = proof;
        if (this.options.onPrepared) queueMicrotask(() => {
          if (!this.hasTargetOutput || this.active) return;
          try { this.options.onPrepared?.(); }
          catch (error) { this.fail(error); }
        });
      }
      return 'hold';
    }
    if ((!this.positioned || this.mode === 'preview') && relative > 0n) return 'hold';
    if (this.positioned && this.mode === 'preview') return 'discard';
    if (this.pending.has(proof)) return 'enqueue';
    if (this.pending.size >= this.options.maxQueuedFrames) return 'hold';
    // Reference establishment reads the injected clock and may reenter output.
    // Own this exact slot before calling it, just as for renderer admission.
    if (!this.options.sync.hasReference && this.options.reference === 'external') return 'hold';
    this.pending.add(proof);
    if (!this.options.sync.hasReference) {
      try { this.options.sync.setVideoReference(raw); }
      catch (error) { this.fail(error); return 'discard'; }
      if (!this.live()) return 'discard';
      if (!this.options.sync.hasReference) { this.fail(new Error('Video reference was not established')); return 'discard'; }
    }
    return 'enqueue';
  }

  discarded(proof: VideoProducedTiming, reason: DispatcherOutputReason): void {
    this.outstanding.delete(proof);
    const target = this.targetProof === proof;
    if (target) this.targetProof = undefined;
    const reserved = this.pending.delete(proof);
    if (!this.live()) return;
    if (target || reserved || reason === 'hold queue overflow' || reason === 'output failed') {
      this.fail(new Error(`Prepared video output was lost: ${reason}`)); return;
    }
    this.progress();
  }

  /** The graph owner separately destroys its decoder/audio adapters. */
  stop(): void {
    const result = this.retire();
    if (result.failed) throw result.error;
  }

  private schedule(raw: bigint): number | null {
    if (!this.live() || !this.active || !this.options.sync.hasReference) return null;
    const timing = this.options.sync.computeVideoRenderTime(raw);
    return this.live() ? timing?.renderTimeUs ?? null : null;
  }
  private positionMs(point: SourceTimestamp): number | null {
    if (!this.placement) return milliseconds(point);
    return locIndexedPositionMs(this.placement, point);
  }
  private observed(event: VideoFrameObservation): void {
    const proof = event.outputTiming;
    if (event.state === 'scheduled' || !proof || !this.pending.delete(proof) || !this.live()) return;
    this.outstanding.delete(proof);
    if (event.state !== 'presented') {
      if (!this.positioned || event.reason === 'draw failed') this.fail(new Error(`Video presentation was not proved: ${event.reason}`));
      else this.progress();
      return;
    }
    if (this.last && compare(proof.sourceTimestamp, this.last) < 0n) { this.fail(new Error('Video output regressed in presentation order')); return; }
    this.last = proof.sourceTimestamp;
    if (!this.positioned) {
      const raw = this.contexts.get(proof.context)!;
      try {
        if (this.options.reference === 'video') {
          // Rebase future pacing to this actual first draw, not codec latency.
          this.options.sync.reset(); this.options.sync.setVideoReference(raw);
        }
      } catch (error) { this.fail(error); return; }
      if (!this.live()) return;
      this.positioned = true;
      // The draw is committed before application callbacks. Observer failure
      // cannot turn a successfully presented frame into a media failure.
      try { this.options.onPresented(this.positionMs(proof.sourceTimestamp)!); }
      finally { this.progress(); }
    } else this.progress();
  }
  private progress(): void {
    if (this.progressQueued || this.stopped) return;
    this.progressQueued = true;
    queueMicrotask(() => {
      this.progressQueued = false;
      if (!this.live() || !this.active) return;
      try { this.options.dispatcher.refreshVideoOutputs(); }
      catch (error) { this.fail(error); return; }
      // Notifications cannot undo a committed picture or escape this task.
      if (this.live()) { try { this.options.onProgress(); } catch {} }
    });
  }
  private ownerCurrent(): boolean { try { return this.options.isCurrent(); } catch { return false; } }
  private live(): boolean {
    if (this.stopped || !this.ownerCurrent() || this.stopped) return false;
    const lease = this.lease, current = lease === undefined || lease.current;
    return current && !this.stopped && this.lease === lease;
  }
  private retire(): { failed: boolean; error?: unknown } {
    if (this.stopped) return { failed: false };
    this.stopped = true; this.active = false; this.targetProof = undefined; this.pending.clear(); this.outstanding.clear();
    const off = this.off, lease = this.lease; this.off = undefined; this.lease = undefined;
    let failed = false, failure: unknown;
    // Flush only while this exact registration still owns the fresh graph.
    // Release last: discard observers may install a successor on this host.
    for (const close of [off, () => { if (lease?.current) this.options.renderer.flush(); }, lease && (() => lease.release())]) {
      try { close?.(); } catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    return failed ? { failed: true, error: failure } : { failed: false };
  }
  private fail(error: unknown): void {
    if (this.stopped) return;
    const current = this.ownerCurrent(), cleanup = this.retire();
    if (!current || !this.ownerCurrent()) return;
    const cause = cleanup.failed ? new AggregateError([error, cleanup.error], 'Video output and cleanup failed') : error;
    try { this.options.onError(cause instanceof Error ? cause : new Error('Video output failed', { cause })); }
    catch { /* Cleanup and retirement precede application notification. */ }
  }
}
