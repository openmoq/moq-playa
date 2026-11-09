import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncController } from '@openmoq/playback';
import type { VideoRenderTiming } from '@openmoq/playback';
import type { SourceTimestamp } from '@openmoq/loc';
import type { VideoOutputAdmission } from './command-dispatcher.js';
import type { VideoFrameObservation, VideoProducedTiming } from './interfaces.js';
import { CanvasRenderer } from '../../browser/src/canvas-renderer.js';
import { LocSeekVideoOutput } from './loc-seek-video-output.js';
import type { LocIndexedPlacement } from './loc-seek-input.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
const point = (us: bigint): SourceTimestamp => Object.freeze({ ticks: us, ticksPerSecond: 1_000_000n, domain: 'media' });
function fixture(mode: 'preview' | 'playing' = 'playing', reference: 'video' | 'external' = 'video', maxQueuedFrames = 3,
  options: { selected?: SourceTimestamp; placement?: LocIndexedPlacement } = {}) {
  let now = 50_000, current = true;
  const clock = { now: () => now }, sync = new SyncController({ clock, driftThresholdUs: 500_000 });
  const canvas = { width: 10, height: 10 }, draw = vi.fn();
  const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: draw }) } as unknown as HTMLCanvasElement, { clock });
  let binding: { owner: VideoOutputAdmission } | undefined;
  const held: Array<{ proof: VideoProducedTiming; frame: { timestamp: number; close: ReturnType<typeof vi.fn> } }> = [];
  const events: VideoFrameObservation[] = []; const off = renderer.observeFrames(event => { events.push(event); });
  const host = {
    installVideoOutputAdmission(owner: VideoOutputAdmission) {
      const installed = { owner }; binding = installed;
      return { get current() { return binding === installed; }, release() { if (binding === installed) binding = undefined; } };
    },
    refreshVideoOutputs() {
      while (binding && held.length) {
        const entry = held[0]!, decision = binding.owner.decide(entry.proof);
        if (decision === 'hold') break;
        held.shift();
        if (decision === 'discard') { entry.frame.close(); binding?.owner.discarded(entry.proof, 'output refused'); }
        else renderer.enqueue(entry.frame, entry.proof.context.recomputeRenderTimeUs()!, entry.proof.context, entry.proof);
      }
    },
  };
  const presented = vi.fn(), progress = vi.fn(), error = vi.fn();
  const output = new LocSeekVideoOutput({ dispatcher: host, renderer, sync, selected: options.selected ?? point(3_000_000n),
    ...(options.placement === undefined ? {} : { placement: options.placement }),
    mode, reference, maxQueuedFrames, isCurrent: () => current, onPresented: presented, onProgress: progress, onError: error });
  function emit(raw: bigint, sourceTimestamp: SourceTimestamp = point(raw)) {
    const context = output.timingSource.captureVideoOutputTiming!(raw)!;
    const proof = Object.freeze({ context, sourceTimestamp });
    const frame = { timestamp: Number(raw), close: vi.fn() };
    const decision = output.decide(proof);
    if (decision === 'hold') held.push({ proof, frame });
    else if (decision === 'discard') { frame.close(); output.discarded(proof, 'output refused'); }
    else renderer.enqueue(frame, context.recomputeRenderTimeUs()!, context, proof);
    return { proof, frame, decision };
  }
  return { output, renderer, sync, clock, host, held, events, presented, progress, error, draw, emit,
    now(value: number) { now = value; }, current(value: boolean) { current = value; },
    stop() { output.stop(); for (const item of held.splice(0)) item.frame.close(); off(); renderer.destroy(); },
    flushMicrotasks: async () => { await Promise.resolve(); await Promise.resolve(); } };
}

describe('owned LOC video output', () => {
  it('decodes preroll but has no content position until an actual target draw', async () => {
    const f = fixture();
    try {
      f.output.start(); f.output.activate();
      const preroll = f.emit(2_900_000n); expect(preroll.decision).toBe('discard'); expect(preroll.frame.close).toHaveBeenCalledOnce();
      const target = f.emit(3_000_000n); expect(target.decision).toBe('enqueue');
      expect(f.output.readPositionMs()).toBeNull(); expect(f.presented).not.toHaveBeenCalled();
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.output.firstPresented).toBe(true); expect(f.output.readPositionMs()).toBe(3000);
      expect(f.presented).toHaveBeenCalledExactlyOnceWith(3000); expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it('holds all successors until the first target was actually shown', async () => {
    const f = fixture();
    try {
      f.output.start(); f.output.activate(); f.emit(3_000_000n);
      const later = f.emit(3_100_000n); expect(later.decision).toBe('hold'); expect(f.held).toHaveLength(1);
      f.now(1_000_000); f.renderer.renderTick(1_000_000); await f.flushMicrotasks();
      expect(f.events.filter(event => event.state === 'presented')).toHaveLength(1);
      expect(f.held).toEqual([]); expect(f.output.readPositionMs()).toBe(3000);
      f.renderer.renderTick(1_000_000); expect(f.events.filter(event => event.state === 'presented')).toHaveLength(1);
      f.now(1_100_000); f.renderer.renderTick(1_100_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(3100); expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it('keeps a preview at its target while future decoded frames remain held', async () => {
    const f = fixture('preview');
    try {
      f.output.start(); f.output.activate(); f.emit(3_000_000n); f.emit(3_100_000n);
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      f.now(10_000_000); f.renderer.renderTick(10_000_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(3000); expect(f.held).toHaveLength(1);
      expect(f.events.filter(event => event.state === 'presented')).toHaveLength(1);
    } finally { f.stop(); }
  });
  it('retains preparation without establishing a reference before activation', async () => {
    const f = fixture();
    try {
      f.output.start(); const target = f.emit(3_000_000n); expect(target.decision).toBe('hold');
      expect(f.sync.hasReference).toBe(false); expect(target.proof.context.recomputeRenderTimeUs()).toBeNull();
      f.output.activate(); f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(3000);
    } finally { f.stop(); }
  });
  it('does not establish or reset an external audio-master reference', async () => {
    const f = fixture('playing', 'external'), reset = vi.spyOn(f.sync, 'reset');
    try {
      f.output.start(); f.output.activate(); expect(f.emit(3_000_000n).decision).toBe('hold');
      expect(f.sync.hasReference).toBe(false);
      f.sync.setAudioReference(3_000_000n); f.host.refreshVideoOutputs(); f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(reset).not.toHaveBeenCalled(); expect(f.output.readPositionMs()).toBe(3000);
    } finally { f.stop(); }
  });
  it('bounds enqueued frames and resumes admission from actual presentation', async () => {
    const f = fixture('playing', 'video', 1);
    try {
      f.output.start(); f.output.activate(); f.emit(3_000_000n); f.emit(3_100_000n); f.emit(3_200_000n);
      f.renderer.renderTick(50_000); await f.flushMicrotasks(); expect(f.held).toHaveLength(1);
      f.now(150_000); f.renderer.renderTick(150_000); await f.flushMicrotasks(); expect(f.held).toHaveLength(0);
      f.now(250_000); f.renderer.renderTick(250_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(3200); expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it('refuses a foreign producing context without inventing a playhead', () => {
    const f = fixture();
    try {
      f.output.start(); f.output.activate();
      const foreign: VideoRenderTiming = { recomputeRenderTimeUs: () => 0 };
      expect(f.output.decide({ context: foreign, sourceTimestamp: point(3_000_000n) })).toBe('discard');
      expect(f.error).toHaveBeenCalledOnce(); expect(f.output.readPositionMs()).toBeNull(); expect(f.presented).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it('ends old source timing and queued progress when its owner retires', async () => {
    const f = fixture();
    try {
      f.output.start(); f.output.activate(); const frame = f.emit(3_000_000n);
      f.renderer.renderTick(50_000); f.current(false); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBeNull(); expect(frame.proof.context.recomputeRenderTimeUs()).toBeNull();
      expect(f.progress).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
  it('keeps an accepted draw and future pacing when a position callback throws', async () => {
    const f = fixture();
    try {
      f.presented.mockImplementationOnce(() => { throw new Error('application callback'); });
      f.output.start(); f.output.activate(); f.emit(3_000_000n); f.emit(3_100_000n);
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.error).not.toHaveBeenCalled(); expect(f.output.readPositionMs()).toBe(3000);
      f.now(150_000); f.renderer.renderTick(150_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(3100);
    } finally { f.stop(); }
  });
});

describe('indexed-relative video positions', () => {
  const epoch = 1_800_000_000_000_000n;
  const unix = (raw: bigint): SourceTimestamp => Object.freeze({ ticks: raw, ticksPerSecond: 1_000_000n, domain: 'unix' });
  it.each(['unix', 'media'] as const)('reports an actual nominal content point from a retained %s source without rewriting it', async domain => {
    const anchor = domain === 'unix' ? unix(epoch) : point(90_000_000n);
    const selected = Object.freeze({ ...anchor, ticks: anchor.ticks + 600n });
    const f = fixture('playing', 'video', 3, { selected,
      placement: { sourceAnchor: anchor, mediaPts: 4000, timestampRounding: 'floor' } });
    const reads = vi.spyOn(f.clock, 'now');
    try {
      f.output.start(); const target = f.emit(selected.ticks, selected);
      expect(target.frame.timestamp).toBe(Number(selected.ticks));
      expect(target.proof.sourceTimestamp).toBe(selected);
      expect(f.output.hasTargetOutput).toBe(true); expect(f.output.readPositionMs()).toBeNull();
      expect(f.sync.hasReference).toBe(false); expect(reads).not.toHaveBeenCalled();
      f.output.activate(); f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.presented).toHaveBeenCalledExactlyOnceWith(4000.6); expect(f.output.readPositionMs()).toBe(4000.6);
      f.emit(selected.ticks + 100_000n, Object.freeze({ ...selected, ticks: selected.ticks + 100_000n }));
      f.now(150_000); f.renderer.renderTick(150_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(4100.6); expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it('reports the nearest nominal point rather than its conservative admission edge', async () => {
    const selected = unix(epoch + 600n);
    const f = fixture('preview', 'video', 3, { selected,
      placement: { sourceAnchor: unix(epoch), mediaPts: 4000, timestampRounding: 'nearest' } });
    try {
      f.output.start(); f.output.activate(); f.emit(selected.ticks, selected);
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(4000.6);
      expect(f.presented).toHaveBeenCalledExactlyOnceWith(4000.6);
      const future = unix(selected.ticks + 1000n); f.emit(future.ticks, future);
      f.now(1_000_000); f.renderer.renderTick(1_000_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(4000.6); expect(f.held).toHaveLength(1);
    } finally { f.stop(); }
  });

  it('subtracts exact high-scale source points before converting the nominal clock to Number', async () => {
    const anchor: SourceTimestamp = { ticks: epoch * 1000n, ticksPerSecond: 1_000_000_000n, domain: 'media' };
    const selected = { ...anchor, ticks: anchor.ticks + 1n };
    const f = fixture('preview', 'video', 3, { selected,
      placement: { sourceAnchor: anchor, mediaPts: 4000, timestampRounding: 'floor' } });
    try {
      f.output.start(); f.output.activate(); f.emit(epoch, selected);
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(4000.000001); expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it('keeps position getters pure and bound to the last actual draw, then retires the mapping', async () => {
    const selected = unix(epoch);
    const f = fixture('preview', 'video', 3, { selected,
      placement: { sourceAnchor: selected, mediaPts: 4000, timestampRounding: 'floor' } });
    try {
      f.output.start(); f.output.activate(); f.emit(epoch, selected); f.renderer.renderTick(50_000); await f.flushMicrotasks();
      const reads = vi.spyOn(f.clock, 'now'), reset = vi.spyOn(f.sync, 'reset'), establish = vi.spyOn(f.sync, 'setVideoReference');
      f.now(10_000_000);
      for (let i = 0; i < 5; i++) expect(f.output.readPositionMs()).toBe(4000);
      expect(reads).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled(); expect(establish).not.toHaveBeenCalled();
      f.current(false); expect(f.output.readPositionMs()).toBeNull(); expect(f.output.hasTargetOutput).toBe(false);
    } finally { f.stop(); }
  });

  it('snapshots the placement so caller mutation cannot move an established output', async () => {
    const anchor = { ticks: epoch, ticksPerSecond: 1_000_000n, domain: 'unix' as const };
    const placement: LocIndexedPlacement = { sourceAnchor: anchor, mediaPts: 4000, timestampRounding: 'floor' };
    const f = fixture('preview', 'video', 3, { selected: unix(epoch), placement });
    try {
      anchor.ticks += 10_000_000n; Reflect.set(placement, 'mediaPts', 9000);
      f.output.start(); f.output.activate(); f.emit(epoch, unix(epoch));
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(f.output.readPositionMs()).toBe(4000);
    } finally { f.stop(); }
  });

  it('refuses a producing source domain change instead of keeping a stale nominal clock', () => {
    const selected = unix(epoch);
    const f = fixture('preview', 'video', 3, { selected,
      placement: { sourceAnchor: selected, mediaPts: 4000, timestampRounding: 'floor' } });
    try {
      f.output.start(); f.output.activate();
      const raw = f.output.timingSource.captureVideoOutputTiming!(epoch);
      if (!raw) throw new Error('No producing context');
      expect(f.output.decide({ context: raw, sourceTimestamp: point(epoch) })).toBe('discard');
      expect(f.error).toHaveBeenCalledOnce(); expect(f.output.readPositionMs()).toBeNull();
    } finally { f.stop(); }
  });

  it.each(['unknown', 'zero scale', 'fractional index', 'rounding', 'domain mismatch'] as const)('refuses invalid placement before acquiring output ownership: %s', fault => {
    const selected = unix(epoch), placement: LocIndexedPlacement = { sourceAnchor: selected, mediaPts: 4000, timestampRounding: 'floor' };
    if (fault === 'unknown') Reflect.set(placement, 'sourceAnchor', { ...selected, domain: 'unknown' });
    if (fault === 'zero scale') Reflect.set(placement, 'sourceAnchor', { ...selected, ticksPerSecond: 0n });
    if (fault === 'fractional index') Reflect.set(placement, 'mediaPts', 4000.5);
    if (fault === 'rounding') Reflect.set(placement, 'timestampRounding', 'guess');
    if (fault === 'domain mismatch') Reflect.set(placement, 'sourceAnchor', point(epoch));
    expect(() => fixture('preview', 'video', 3, { selected, placement })).toThrow();
  });
});

// Exercise scheduling reentry through the real dispatcher and renderer.
async function nativeFixture(maxQueuedFrames = 1) {
  const { CommandDispatcher } = await import('./command-dispatcher.js');
  const f = fixture('playing', 'video', maxQueuedFrames);
  const decoder: import('./interfaces.js').VideoDecoderLike = {
    supportsOutputTiming: true, configure() {}, decode() {}, reset() {}, destroy() {}, flush: async () => {},
    queueDepth: 0, onFrame: null, onError: null,
  };
  const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer: f.renderer,
    hasSyncReference: () => f.sync.hasReference });
  let current = true;
  const output = new LocSeekVideoOutput({ dispatcher, renderer: f.renderer, sync: f.sync, selected: point(3_000_000n),
    mode: 'playing', reference: 'video', maxQueuedFrames, isCurrent: () => current,
    onPresented: f.presented, onProgress: f.progress, onError: f.error });
  const emit = (raw: bigint, sourceTimestamp: SourceTimestamp = point(raw)) => {
    const context = output.timingSource.captureVideoOutputTiming!(raw);
    if (!context) throw new Error('Decoded output has no producing context');
    const frame = { timestamp: Number(raw), close: vi.fn() };
    decoder.onFrame!(frame, 0, sourceTimestamp, undefined, context);
    return frame;
  };
  return { ...f, output, emit, dispatcher,
    current(value: boolean) { current = value; },
    stop() { output.stop(); dispatcher.destroy(); f.stop(); } };
}

describe('video output ownership boundaries', () => {
  it.each([false, true])('native pending capacity remains one while establishing the reference; clock reentry=%s', async reenter => {
    const f = await nativeFixture(1);
    try {
      f.output.start(); f.output.activate();
      const frames: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
      if (reenter) {
        const now = f.clock.now;
        let once = true;
        f.clock.now = () => {
          if (once) { once = false; frames.push(f.emit(3_000_000n)); }
          return now();
        };
      }
      frames.push(f.emit(3_000_000n));
      if (!reenter) frames.push(f.emit(3_000_000n));
      // Equal presentation points are distinct proven native outputs. There
      // is no source-order regression and no uniqueness assumption in the API.
      expect(f.events.filter(event => event.state === 'scheduled')).toHaveLength(1);
      expect(frames.every(frame => frame.close.mock.calls.length === 0)).toBe(true);
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      f.renderer.renderTick(50_000); await f.flushMicrotasks();
      expect(frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
      expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it.each([false, true])('an application progress callback cannot escape the owned microtask; observer throws=%s', async throws => {
    const jobs: Array<() => void> = [];
    vi.stubGlobal('queueMicrotask', (job: () => void) => { jobs.push(job); });
    const f = await nativeFixture(1);
    try {
      f.output.start(); f.output.activate(); f.emit(3_000_000n); const later = f.emit(3_100_000n);
      f.renderer.renderTick(50_000);
      expect(f.output.readPositionMs()).toBe(3000); expect(f.presented).toHaveBeenCalledExactlyOnceWith(3000);
      expect(jobs).toHaveLength(1);
      if (throws) f.progress.mockImplementation(() => { throw new Error('application progress callback'); });
      const run = jobs.shift(); if (!run) throw new Error('No owned progress microtask');
      expect(run).not.toThrow();
      expect(f.error).not.toHaveBeenCalled(); expect(f.output.current).toBe(true);
      f.now(150_000); f.renderer.renderTick(150_000);
      expect(later.close).toHaveBeenCalledOnce(); expect(f.output.readPositionMs()).toBe(3100);
    } finally { f.stop(); }
  });

  it.each([false, true])('refresh failure is owned rather than escaping its microtask; schedule clock throws=%s', async throws => {
    const jobs: Array<() => void> = [];
    vi.stubGlobal('queueMicrotask', (job: () => void) => { jobs.push(job); });
    const f = await nativeFixture(1);
    try {
      f.output.start(); f.output.activate(); f.emit(3_000_000n); const later = f.emit(3_100_000n);
      f.renderer.renderTick(50_000);
      expect(f.output.firstPresented).toBe(true); expect(jobs).toHaveLength(1);
      if (throws) {
        const now = f.clock.now; let once = true;
        f.clock.now = () => { if (once) { once = false; throw new Error('schedule clock unavailable'); } return now(); };
      }
      const run = jobs.shift(); if (!run) throw new Error('No owned progress microtask');
      expect(run).not.toThrow();
      if (throws) {
        expect(f.error).toHaveBeenCalledOnce(); expect(f.output.current).toBe(false);
        expect(later.close).toHaveBeenCalledOnce();
      } else {
        f.now(150_000); f.renderer.renderTick(150_000);
        expect(f.error).not.toHaveBeenCalled(); expect(f.output.readPositionMs()).toBe(3100);
      }
    } finally { f.stop(); }
  });
});

it('finishes native and held-frame cleanup before a reentrant throwing error notification', async () => {
  const jobs: Array<() => void> = [];
  vi.stubGlobal('queueMicrotask', (job: () => void) => { jobs.push(job); });
  const f = await nativeFixture(2);
  const seen: { current?: boolean; closed?: number[]; retiredSchedule?: number | null; stopReturned?: boolean } = {};
  try {
    f.output.start(); f.output.activate();
    const target = f.emit(3_000_000n);
    const future = [f.emit(3_100_000n), f.emit(3_200_000n), f.emit(3_300_000n)];
    const oldContext = f.output.timingSource.captureVideoOutputTiming!(3_400_000n);
    if (!oldContext) throw new Error('No original producing context');
    f.renderer.renderTick(50_000);
    expect(target.close).toHaveBeenCalledOnce(); expect(f.output.readPositionMs()).toBe(3000);
    expect(jobs).toHaveLength(1);
    const now = f.clock.now; let reads = 0;
    f.clock.now = () => {
      if (++reads === 2) throw new Error('second successor schedule unavailable');
      return now();
    };
    f.error.mockImplementation(() => {
      // Capture evidence, rather than placing assertions inside a contained
      // notification: the assertions below must see any cleanup discrepancy.
      seen.current = f.output.current;
      seen.closed = future.map(frame => frame.close.mock.calls.length);
      seen.retiredSchedule = oldContext.recomputeRenderTimeUs();
      f.output.stop(); seen.stopReturned = true;
      throw new Error('error notification failed');
    });
    const run = jobs.shift(); if (!run) throw new Error('No owned refresh microtask');
    expect(run).not.toThrow();
    expect(reads).toBe(2);
    // Target + first successor reached the real renderer. The second failed
    // after leaving the dispatcher queue; the third was still dispatcher-held.
    expect(f.events.filter(event => event.state === 'scheduled')).toHaveLength(2);
    expect(seen).toEqual({ current: false, closed: [1, 1, 1], retiredSchedule: null, stopReturned: true });
    expect(f.error).toHaveBeenCalledOnce(); expect(f.progress).not.toHaveBeenCalled();
    expect(f.output.current).toBe(false); expect(f.output.readPositionMs()).toBeNull();
    f.output.stop();
    expect(future.map(frame => frame.close.mock.calls.length)).toEqual([1, 1, 1]);
  } finally { f.stop(); }
});

describe('inactive decoded-target readiness', () => {
  it('records an exact held target without establishing a clock, enqueueing, or claiming presentation', async () => {
    const f = await nativeFixture();
    const reads = vi.spyOn(f.clock, 'now');
    const establish = vi.spyOn(f.sync, 'setVideoReference');
    const schedule = vi.spyOn(f.sync, 'computeVideoRenderTime');
    const enqueue = vi.spyOn(f.renderer, 'enqueue');
    try {
      expect(f.output.hasTargetOutput).toBe(false);
      f.output.start();
      expect(f.output.hasTargetOutput).toBe(false);
      const target = f.emit(3_000_000n);
      // Poll only after the synchronous dispatcher callback has retained its frame.
      expect(f.output.hasTargetOutput).toBe(true);
      expect(target.close).not.toHaveBeenCalled();
      for (let i = 0; i < 10; i++) expect(f.output.hasTargetOutput).toBe(true);
      expect(f.sync.hasReference).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(establish).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
      expect(f.output.firstPresented).toBe(false);
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.presented).not.toHaveBeenCalled();
      expect(f.error).not.toHaveBeenCalled();

      f.output.activate();
      expect(f.output.hasTargetOutput).toBe(true);
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.presented).not.toHaveBeenCalled();
      f.renderer.renderTick(50_000);
      expect(f.output.readPositionMs()).toBe(3000);
      expect(f.presented).toHaveBeenCalledExactlyOnceWith(3000);
    } finally { f.stop(); }
  });

  it('does not use preroll or a future-only output as the selected target', async () => {
    const f = await nativeFixture();
    try {
      f.output.start();
      const preroll = f.emit(2_900_000n);
      expect(preroll.close).toHaveBeenCalledOnce();
      expect(f.output.hasTargetOutput).toBe(false);
      const future = f.emit(3_100_000n);
      expect(f.output.hasTargetOutput).toBe(false);
      expect(future.close).not.toHaveBeenCalled();
      expect(f.sync.hasReference).toBe(false);
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.events).toEqual([]);
      expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it.each([
    { source: { ticks: 9n, ticksPerSecond: 3n, domain: 'media' as const }, ready: true },
    { source: { ticks: 3_000_000_001n, ticksPerSecond: 1_000_000_000n, domain: 'media' as const }, ready: false },
  ])('uses exact source fractions rather than the normalized decoder timestamp: $ready', async ({ source, ready }) => {
    const f = await nativeFixture();
    try {
      f.output.start();
      f.emit(3_000_000n, source);
      expect(f.output.hasTargetOutput).toBe(ready);
      expect(f.sync.hasReference).toBe(false);
      expect(f.events).toEqual([]);
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it.each(['flush', 'reset'] as const)('fails loss of an unreserved target before activation: %s', async action => {
    const f = await nativeFixture();
    const atError: boolean[] = [];
    f.error.mockImplementation(() => { atError.push(f.output.hasTargetOutput); });
    try {
      f.output.start();
      const target = f.emit(3_000_000n);
      expect(f.sync.hasReference).toBe(false);
      expect(f.events).toEqual([]);
      if (action === 'flush') f.dispatcher.flush();
      else f.dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'target cancelled' });
      expect(f.error).toHaveBeenCalledOnce();
      expect(atError).toEqual([false]);
      expect(f.output.hasTargetOutput).toBe(false);
      expect(f.output.current).toBe(false);
      expect(target.close).toHaveBeenCalledOnce();
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.presented).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it('invalidates the target when the actual dispatcher hold bound evicts it', async () => {
    const f = await nativeFixture();
    try {
      f.output.start();
      const frames = [f.emit(3_000_000n)];
      expect(f.output.hasTargetOutput).toBe(true);
      // The existing dispatcher holds thirty outputs, including the target.
      for (let i = 1; i <= 30; i++) frames.push(f.emit(3_000_000n + BigInt(i)));
      expect(f.output.hasTargetOutput).toBe(false);
      expect(f.output.current).toBe(false);
      expect(f.error).toHaveBeenCalledOnce();
      expect(frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
      expect(f.events).toEqual([]);
      expect(f.presented).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });

  it.each(['stop', 'owner', 'lease'] as const)('does not retain readiness after %s retirement', async action => {
    const f = await nativeFixture();
    let release: (() => void) | undefined;
    try {
      f.output.start();
      f.emit(3_000_000n);
      expect(f.output.hasTargetOutput).toBe(true);
      if (action === 'stop') f.output.stop();
      else if (action === 'owner') f.current(false);
      else {
        const successor = f.dispatcher.installVideoOutputAdmission({ decide: () => 'hold', discarded() {} });
        release = successor.release;
        f.output.stop();
        expect(successor.current).toBe(true);
      }
      expect(f.output.hasTargetOutput).toBe(false);
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.error).not.toHaveBeenCalled();
      expect(f.presented).not.toHaveBeenCalled();
    } finally { release?.(); f.stop(); }
  });

  it('clears readiness before reporting loss of current producing context', async () => {
    const f = await nativeFixture();
    try {
      f.output.start();
      f.emit(3_000_000n);
      expect(f.output.hasTargetOutput).toBe(true);
      const foreign: VideoRenderTiming = { recomputeRenderTimeUs: () => 0 };
      expect(f.output.decide({ context: foreign, sourceTimestamp: point(3_000_000n) })).toBe('discard');
      expect(f.output.hasTargetOutput).toBe(false);
      expect(f.error).toHaveBeenCalledOnce();
      expect(f.output.readPositionMs()).toBeNull();
    } finally { f.stop(); }
  });

  it('does not turn the already-active path into an inactive preparation witness', async () => {
    const f = await nativeFixture();
    try {
      f.output.start();
      f.output.activate();
      f.emit(3_000_000n);
      expect(f.output.hasTargetOutput).toBe(false);
      expect(f.output.firstPresented).toBe(false);
      expect(f.output.readPositionMs()).toBeNull();
      expect(f.error).not.toHaveBeenCalled();
    } finally { f.stop(); }
  });
});
