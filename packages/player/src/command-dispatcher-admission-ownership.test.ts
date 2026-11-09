import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoRenderTiming } from '@openmoq/playback';
import type { VideoDecoderLike, VideoFrameObservation } from './interfaces.js';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoOutputAdmission } from './command-dispatcher.js';
import { CanvasRenderer } from '../../browser/src/canvas-renderer.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const draw = vi.fn(), canvas = { width: 10, height: 10 };
  const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: draw }) } as unknown as HTMLCanvasElement,
    { clock: { now: () => 100 } });
  const video: VideoDecoderLike = { supportsOutputTiming: true, configure() {}, decode() {}, flush: async () => {},
    reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null };
  let sync = true;
  let syncHook: (() => void) | undefined;
  const dispatcher = new CommandDispatcher({ videoDecoder: video, renderer, hasSyncReference: () => { syncHook?.(); return sync; } });
  const events: VideoFrameObservation[] = [];
  const off = renderer.observeFrames(event => { events.push(event); });
  const timing: VideoRenderTiming = Object.freeze({ recomputeRenderTimeUs: () => 0 });
  function output(context: VideoRenderTiming | undefined = timing, legacy = false) {
    const frame = { timestamp: 1_000_000, close: vi.fn() };
    if (legacy) video.onFrame!(frame, 0);
    else video.onFrame!(frame, 0, { ticks: 1_000_000n, ticksPerSecond: 1_000_000n, domain: 'media' }, undefined, context);
    return frame;
  }
  return { dispatcher, renderer, video, draw, events, timing, output, sync(value: boolean) { sync = value; },
    syncHook(hook: () => void) { syncHook = hook; }, cleanup() { off(); dispatcher.destroy(); } };
}
function refusingOwner() {
  return { decide: vi.fn(() => 'discard' as const), discarded: vi.fn() };
}

describe('video admission ownership boundaries', () => {
  it.each(['mapped-proof', 'legacy-unproven'] as const)('arming prevents prior unowned held output from bypassing the current admission: %s', kind => {
    const f = fixture(), owner = refusingOwner();
    try {
      f.sync(false); const frame = f.output(f.timing, kind === 'legacy-unproven');
      expect(f.draw).not.toHaveBeenCalled();
      f.dispatcher.installVideoOutputAdmission(owner);
      f.sync(true); f.dispatcher.refreshVideoOutputs(); f.renderer.renderTick(0);
      expect(f.draw).not.toHaveBeenCalled();
      expect(f.events.some(event => event.state === 'presented')).toBe(false);
      expect(frame.close).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });

  it('the unarmed sync hold still renders when no functional owner is introduced', () => {
    const f = fixture();
    try {
      f.sync(false); const frame = f.output();
      f.sync(true); f.dispatcher.refreshVideoOutputs(); f.renderer.renderTick(0);
      expect(f.draw).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce();
      expect(f.events.at(-1)?.state).toBe('presented');
    } finally { f.cleanup(); }
  });

  it.each(['decoded-observer', 'sync-query', 'schedule-query'] as const)('new owner installed during %s cannot be bypassed by the in-flight unarmed output', point => {
    const f = fixture(), owner = refusingOwner();
    let once = true;
    const install = () => { if (once) { once = false; f.dispatcher.installVideoOutputAdmission(owner); } };
    let timing = f.timing;
    if (point === 'decoded-observer') f.dispatcher.outputObserver = { decoded() { install(); return {}; }, discarded() {} };
    if (point === 'sync-query') f.syncHook(install);
    if (point === 'schedule-query') timing = Object.freeze({ recomputeRenderTimeUs() { install(); return 0; } });
    try {
      const frame = f.output(timing); f.renderer.renderTick(0);
      expect(f.draw).not.toHaveBeenCalled();
      expect(f.events.some(event => event.state === 'presented')).toBe(false);
      expect(frame.close).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });

  it('replacing an already installed owner during decide fences its in-flight output', () => {
    const f = fixture(), next = refusingOwner(), discarded = vi.fn();
    try {
      f.dispatcher.installVideoOutputAdmission({ decide() { f.dispatcher.installVideoOutputAdmission(next); return 'enqueue'; }, discarded });
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.draw).not.toHaveBeenCalled(); expect(frame.close).toHaveBeenCalledOnce();
      expect(discarded).toHaveBeenCalledOnce(); expect(next.decide).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });

  it('registration cannot publish an owner after a callback getter destroys the dispatcher', () => {
    const f = fixture();
    const owner: VideoOutputAdmission = { get decide() {
      f.dispatcher.destroy(); return () => 'enqueue' as const;
    }, discarded() {} };
    try {
      expect(() => f.dispatcher.installVideoOutputAdmission(owner)).toThrow(/destroy/i);
    } finally { f.cleanup(); }
  });

  it('a normal getter-backed owner registers and ordinary destroyed registration refuses', () => {
    const f = fixture(), discarded = vi.fn();
    const owner: VideoOutputAdmission = { get decide() { return () => 'enqueue' as const; }, discarded };
    try {
      f.dispatcher.installVideoOutputAdmission(owner); const frame = f.output(); f.renderer.renderTick(0);
      expect(f.draw).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce();
      f.dispatcher.destroy();
      expect(() => f.dispatcher.installVideoOutputAdmission({ decide: () => 'enqueue', discarded })).toThrow(/destroy/i);
    } finally { f.cleanup(); }
  });
});
