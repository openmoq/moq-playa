import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceTimestamp } from '@openmoq/loc';
import type { VideoRenderTiming } from '@openmoq/playback';
import type { VideoDecoderLike, VideoFrameObservation } from '../../player/src/interfaces.js';
import { CommandDispatcher } from '../../player/src/command-dispatcher.js';
import { CanvasRenderer } from './canvas-renderer.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
const source: SourceTimestamp = Object.freeze({ ticks: (1n << 63n) + 31n, ticksPerSecond: 90_000n, domain: 'media' });
const context: VideoRenderTiming = Object.freeze({ recomputeRenderTimeUs: () => 0 });
function fixture() {
  const draw = vi.fn();
  const canvas = { width: 10, height: 10 };
  const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: draw }) } as unknown as HTMLCanvasElement,
    { clock: { now: () => 100 } });
  const decoder: VideoDecoderLike = { supportsOutputTiming: true, configure() {}, decode() {}, reset() {}, destroy() {},
    flush: async () => {}, queueDepth: 0, onFrame: null, onError: null };
  let ready = true;
  const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer, hasSyncReference: () => ready });
  const events: VideoFrameObservation[] = [];
  const off = renderer.observeFrames(event => { events.push(event); });
  function output(time: SourceTimestamp = source, timing: VideoRenderTiming = context, stamp = 17) {
    const frame = { timestamp: stamp, close: vi.fn() };
    decoder.onFrame!(frame, 0, time, undefined, timing);
    return frame;
  }
  return { draw, renderer, dispatcher, decoder, events, output, ready(value: boolean) { ready = value; },
    cleanup() { off(); dispatcher.destroy(); renderer.destroy(); } };
}

describe('callback boundaries in producing video observations', () => {
  it('keeps held functional association while withdrawing the old diagnostic identity', () => {
    const f = fixture(), oldUnit = {}, nextUnit = {};
    const old = { decoded: vi.fn(() => oldUnit), discarded: vi.fn() };
    const next = { decoded: vi.fn(() => nextUnit), discarded: vi.fn() };
    try {
      f.dispatcher.outputObserver = old;
      f.ready(false); const held = f.output();
      f.dispatcher.outputObserver = next;
      f.ready(true); const current = f.output(source, context, 18);
      f.renderer.renderTick(0);
      expect(f.events.map(event => event.token)).toEqual([context, nextUnit, context, nextUnit]);
      expect(f.events.every(event => event.outputTiming?.context === context)).toBe(true);
      expect(f.events.filter(event => event.state === 'presented')).toHaveLength(2);
      expect(held.close).toHaveBeenCalledOnce(); expect(current.close).toHaveBeenCalledOnce();
      expect(old.discarded).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });

  it('source snapshot getter retirement cannot enqueue a stale proof or leak its frame', () => {
    const f = fixture(), unit = {}, discarded = vi.fn();
    try {
      f.dispatcher.outputObserver = { decoded: () => unit, discarded };
      const input: SourceTimestamp = { get ticks() { f.dispatcher.flush(); return source.ticks; },
        ticksPerSecond: source.ticksPerSecond, domain: 'media' };
      const frame = f.output(input);
      f.renderer.renderTick(0);
      expect(f.draw).not.toHaveBeenCalled(); expect(f.events).toEqual([]);
      expect(frame.close).toHaveBeenCalledOnce();
      expect(discarded).toHaveBeenCalledExactlyOnceWith(unit, 'flushed');
    } finally { f.cleanup(); }
  });

  it('source snapshot does not borrow the unrelated numeric frame timestamp', () => {
    const f = fixture();
    try {
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.events.at(-1)?.outputTiming?.sourceTimestamp).toEqual(source);
      expect(f.renderer.videoPresentation?.frameTimestampUs).toBe(17n);
      expect(Object.isFrozen(f.events.at(-1)?.outputTiming)).toBe(true);
      expect(frame.close).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });

  it('a synchronous scheduled observer flush produces one discard, no presented proof', () => {
    const f = fixture();
    const off = f.renderer.observeFrames(event => { if (event.state === 'scheduled') f.renderer.flush(); });
    try {
      const frame = f.output(); f.renderer.renderTick(0);
      expect(f.events.map(event => event.state)).toEqual(['scheduled', 'discarded']);
      expect(f.events.at(-1)?.outputTiming?.context).toBe(context);
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.draw).not.toHaveBeenCalled();
    } finally { off(); f.cleanup(); }
  });

  it('draw failure cannot turn the source association into presented evidence', () => {
    const f = fixture();
    try {
      const frame = f.output(); f.draw.mockImplementationOnce(() => { throw new Error('draw failed'); });
      expect(() => f.renderer.renderTick(0)).toThrow('draw failed');
      expect(f.events.map(event => [event.state, event.reason])).toEqual([['scheduled', null], ['discarded', 'draw failed']]);
      expect(f.events.at(-1)?.outputTiming?.context).toBe(context);
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.renderer.videoPresentation).toBeNull();
    } finally { f.cleanup(); }
  });

  it('nested canvas draw order remains unproven for both producing associations', () => {
    const f = fixture(), other: VideoRenderTiming = Object.freeze({ recomputeRenderTimeUs: () => 10 });
    try {
      const first = f.output(), second = f.output(source, other, 18);
      f.draw.mockImplementationOnce(() => f.renderer.renderTick(10));
      f.renderer.renderTick(0);
      const terminal = f.events.filter(event => event.state !== 'scheduled');
      expect(terminal.map(event => event.state)).toEqual(['unavailable', 'unavailable']);
      expect(terminal.map(event => event.outputTiming?.context)).toEqual([other, context]);
      expect(f.renderer.videoPresentation).toBeNull();
      expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce();
    } finally { f.cleanup(); }
  });
});
