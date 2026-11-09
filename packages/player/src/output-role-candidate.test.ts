import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncController } from '@openmoq/playback';
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


it('cut reservation holds later decoder output and cancellation releases it without flushing old pictures',async()=>{
 const f=fixture();try {
  f.output.start();f.output.activate();f.emit(3_000_000n);f.renderer.renderTick(50_000);await f.flushMicrotasks();
  expect(f.output.holdCut).toBeTypeOf('function');const hold=f.output.holdCut(3500);
  expect(f.emit(3_400_000n).decision).toBe('enqueue');expect(f.emit(3_500_000n).decision).toBe('hold');
  expect(f.output.cutFrontierMs()).toBe(3400);
  f.now(450_000);f.renderer.renderTick(450_000);await f.flushMicrotasks();expect(f.output.readPositionMs()).toBe(3400);
  hold.release();f.now(550_000);f.renderer.renderTick(550_000);await f.flushMicrotasks();expect(f.output.readPositionMs()).toBe(3500);expect(f.error).not.toHaveBeenCalled();
 }finally{f.stop();}
});
it('cannot reserve a cut behind a frame already queued in the old renderer',async()=>{
 const f=fixture();try {
  f.output.start();f.output.activate();f.emit(3_000_000n);f.renderer.renderTick(50_000);await f.flushMicrotasks();f.emit(3_500_000n);
  expect(f.output.holdCut).toBeTypeOf('function');expect(f.output.cutFrontierMs()).toBe(3500);expect(()=>f.output.holdCut(3500)).toThrow(/queued output/);
  f.now(550_000);f.renderer.renderTick(550_000);expect(f.output.readPositionMs()).toBe(3500);
 }finally{f.stop();}
});
