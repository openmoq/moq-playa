import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceTimestamp } from '@openmoq/loc';
import type { VideoRenderTiming } from '@openmoq/playback';
import type { VideoDecoderLike, VideoFrameObservation, VideoProducedTiming, VideoRendererLike } from '../../player/src/interfaces.js';
import { CommandDispatcher } from '../../player/src/command-dispatcher.js';
import { CanvasRenderer } from './canvas-renderer.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const draw = vi.fn();
  const canvas = { width: 10, height: 10, getContext: () => ({ drawImage: draw, canvas }) };
  const renderer = new CanvasRenderer(canvas as unknown as HTMLCanvasElement, { clock: { now: () => 1_000_000 } });
  const target: VideoRendererLike = renderer;
  const decoder: VideoDecoderLike = { supportsOutputTiming: true, configure() {}, decode() {}, reset() {}, destroy() {},
    flush: async () => {}, queueDepth: 0, onFrame: null, onError: null };
  let ready = true;
  const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer,
    hasSyncReference: () => ready, getPlaybackDelayUs: () => 0 });
  const events: VideoFrameObservation[] = [];
  const off = renderer.observeFrames(event => { events.push(event); });
  const context: VideoRenderTiming = Object.freeze({ recomputeRenderTimeUs: () => 0 });
  const source: SourceTimestamp = Object.freeze({ ticks: (1n << 60n) + 7n, ticksPerSecond: (1n << 60n) + 7n, domain: 'media' });
  const produced: VideoProducedTiming = Object.freeze({ context, sourceTimestamp: source });
  const frame = () => ({ timestamp: 1_000_000, close: vi.fn() });
  function output(sourceTime: SourceTimestamp | null | undefined = source, timing: VideoRenderTiming | undefined = context) {
    const value = frame(); decoder.onFrame!(value, 0, sourceTime, undefined, timing); return value;
  }
  return { renderer, target, decoder, dispatcher, events, off, draw, context, source, produced, frame, output,
    setReady(value: boolean) { ready = value; }, destroy() { off(); dispatcher.destroy(); renderer.destroy(); } };
}

describe('decoded producing identity through an actual canvas draw', () => {
  it.each([new Error('render callback failed'), null, undefined])('finishes current notifications and rethrows the first callback value: %s', failure => {
    const f = fixture(), first = vi.fn(() => { throw new Error('later first-frame callback'); }), rendered = vi.fn(() => { throw failure; });
    f.renderer.onFrameRendered = rendered; f.renderer.onFirstFrame = first;
    try {
      const frame = f.output(); let caught: unknown, threw = false;
      try { f.renderer.renderTick(0); } catch (error) { threw = true; caught = error; }
      expect(threw).toBe(true); expect(caught).toBe(failure); expect(frame.close).toHaveBeenCalledOnce();
      expect(first).toHaveBeenCalledOnce(); expect(rendered).toHaveBeenCalledOnce();
      expect(f.renderer.videoPresentation).not.toBeNull();
      f.renderer.onFrameRendered = vi.fn(); f.output(); f.renderer.renderTick(20_000);
      expect(f.draw).toHaveBeenCalledTimes(2); expect(first).toHaveBeenCalledOnce();
    } finally { f.destroy(); }
  });

  it('does not publish first-frame to an output retired by its frame callback', () => {
    const f = fixture(), first = vi.fn();
    f.renderer.onFirstFrame = first; f.renderer.onFrameRendered = () => f.renderer.destroy();
    try {
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.draw).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    } finally { f.destroy(); }
  });

  it.each([false, true])('commits draw bookkeeping and count callback before first-frame publication; throwing=%s', throwing => {
    const f = fixture(), failure = new Error('first frame publication failed'), seen: string[] = [];
    const first = vi.fn(() => { seen.push('first'); if (throwing) throw failure; });
    const rendered = vi.fn(() => seen.push('rendered'));
    f.renderer.onFirstFrame = first; f.renderer.onFrameRendered = rendered;
    try {
      const frame = f.output(); let caught: unknown;
      try { f.renderer.renderTick(0); } catch (error) { caught = error; }
      expect(f.draw).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce();
      expect(f.renderer.videoPresentation).not.toBeNull(); expect(caught).toBe(throwing ? failure : undefined);
      expect.soft(rendered).toHaveBeenCalledOnce(); expect.soft(seen).toEqual(['rendered', 'first']);
      const next = f.output(); f.renderer.renderTick(20_000);
      expect(f.draw).toHaveBeenCalledTimes(2); expect(next.close).toHaveBeenCalledOnce();
      expect.soft(rendered).toHaveBeenCalledTimes(2); expect(first).toHaveBeenCalledOnce();
    } finally { f.destroy(); }
  });

  it('declares the renderer capability explicitly', () => {
    const f = fixture(); try { expect(f.target.supportsOutputTiming).toBe(true); } finally { f.destroy(); }
  });
  it('preserves exact source fields and context until the successful draw, without diagnostics', () => {
    const f = fixture();
    try {
      const frame = f.output(); expect(f.draw).not.toHaveBeenCalled();
      expect(f.events).toHaveLength(1); expect(f.events[0]!.state).toBe('scheduled');
      expect(f.events[0]!.outputTiming?.context).toBe(f.context);
      expect(f.events[0]!.outputTiming?.sourceTimestamp).toEqual(f.source);
      expect(f.events[0]!.token).toBe(f.context);
      f.renderer.renderTick(0);
      expect(f.draw).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce();
      expect(f.events.at(-1)!.state).toBe('presented');
      expect(f.events.at(-1)!.outputTiming?.context).toBe(f.context);
      expect(f.events.at(-1)!.outputTiming?.sourceTimestamp.ticks).toBe((1n << 60n) + 7n);
    } finally { f.destroy(); }
  });
  it('retains the diagnostic unit token when a separate observer owns it', () => {
    const f = fixture(), unit = {}, decoded = vi.fn(() => unit), discarded = vi.fn();
    try {
      f.dispatcher.outputObserver = { decoded, discarded }; f.output(); f.renderer.renderTick(0);
      expect(decoded).toHaveBeenCalledOnce(); expect(discarded).not.toHaveBeenCalled();
      expect(f.events.map(event => event.token)).toEqual([unit, unit]);
      expect(f.events.at(-1)!.outputTiming?.context).toBe(f.context);
    } finally { f.destroy(); }
  });
  it.each([null, undefined])('does not infer an absent decoded source from the frame timestamp: %s', source => {
    const f = fixture(), unit = {};
    try {
      f.dispatcher.outputObserver = { decoded: () => unit, discarded() {} };
      const frame = f.frame(); f.decoder.onFrame!(frame, 0, source, undefined, f.context); f.renderer.renderTick(0);
      expect(f.events.at(-1)!.state).toBe('presented');
      expect(f.events.every(event => event.outputTiming === undefined)).toBe(true);
    } finally { f.destroy(); }
  });
  it('keeps the ordinary enqueue arguments and observation shape unchanged', () => {
    const f = fixture(), enqueue = vi.spyOn(f.renderer, 'enqueue');
    try {
      const frame = f.frame(); f.decoder.onFrame!(frame, 0); f.renderer.renderTick(0);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(frame, 0);
      expect(f.events).toEqual([]);
    } finally { f.destroy(); }
  });
  it('preserves the producing association through the existing sync hold queue', () => {
    const f = fixture();
    try {
      f.setReady(false); const first = f.output(); expect(f.events).toEqual([]);
      f.setReady(true); const second = f.output(); f.renderer.renderTick(0);
      expect(f.events.filter(event => event.state === 'presented')).toHaveLength(2);
      expect(f.events.every(event => event.outputTiming?.context === f.context)).toBe(true);
      expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce();
    } finally { f.destroy(); }
  });
  it('does not let one observer change the source proof seen by another', () => {
    const f = fixture(); let changed: boolean | undefined;
    const off = f.renderer.observeFrames(event => {
      if (event.outputTiming) changed = Reflect.set(event.outputTiming.sourceTimestamp, 'ticks', 0n);
    });
    try {
      f.output(); f.renderer.renderTick(0);
      expect(changed).toBe(false); expect(f.events.at(-1)!.outputTiming?.sourceTimestamp).toEqual(f.source);
    } finally { off(); f.destroy(); }
  });
  it.each(['flush', 'destroy'] as const)('reports %s as a terminal discard with the same proof', action => {
    const f = fixture();
    try {
      const frame = f.frame(); f.target.enqueue(frame, 1_000_000, {}, f.produced);
      f.renderer[action](); f.renderer.flush();
      const terminal = f.events.filter(event => event.state !== 'scheduled');
      expect(terminal).toHaveLength(1); expect(terminal[0]!.state).toBe('discarded');
      expect(terminal[0]!.outputTiming).toBe(f.produced); expect(frame.close).toHaveBeenCalledOnce();
    } finally { f.destroy(); }
  });
  it('does not create producing history for a frame queued before observation', () => {
    const f = fixture(); f.off();
    const events: VideoFrameObservation[] = [];
    try {
      f.target.enqueue(f.frame(), 0, {}, f.produced);
      const off = f.renderer.observeFrames(event => { events.push(event); });
      f.renderer.renderTick(0); expect(events).toEqual([]); off();
    } finally { f.destroy(); }
  });
});
