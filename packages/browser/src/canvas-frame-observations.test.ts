import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasRenderer } from './canvas-renderer.js';
import type { VideoFrameObservation } from '../../player/src/interfaces.js';
function fixture() {
  const draw = vi.fn(); const canvas = { width: 10, height: 10, getContext: () => ({ drawImage: draw, canvas }) };
  const renderer = new CanvasRenderer(canvas as unknown as HTMLCanvasElement, { clock: { now: () => 1_000_000 } });
  const events: VideoFrameObservation[] = []; const off = renderer.observeFrames(event => { events.push(event); });
  const frame = (timestamp = 0) => ({ timestamp, close: vi.fn() });
  return { renderer, frame, events, draw, off };
}
beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
describe('actual canvas unit outcomes', () => {
  it('reports scheduled then presented only after the successful draw witness', () => {
    const f = fixture(), token = {}, frame = f.frame(); f.renderer.enqueue(frame, 0, token);
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }]); expect(f.draw).not.toHaveBeenCalled();
    f.renderer.renderTick(0); expect(f.events.at(-1)).toEqual({ token, state: 'presented', reason: null });
    expect(f.renderer.videoPresentation).not.toBeNull(); expect(frame.close).toHaveBeenCalledOnce(); f.off(); f.renderer.destroy();
  });
  it('drops only the superseded late entry and renders the last late frame', () => {
    const f = fixture(), a = {}, b = {}, first = f.frame(), last = f.frame(1);
    f.renderer.enqueue(first, 0, a); f.renderer.enqueue(last, 1, b); f.renderer.renderTick(1_000_000);
    expect(f.events.filter(event => event.state !== 'scheduled')).toEqual([
      { token: a, state: 'discarded', reason: 'late frame' }, { token: b, state: 'presented', reason: null }]);
    expect(f.draw).toHaveBeenCalledOnce(); expect(first.close).toHaveBeenCalledOnce(); expect(last.close).toHaveBeenCalledOnce(); f.off(); f.renderer.destroy();
  });
  it('terminates failed draws without claiming presentation and still closes the frame', () => {
    const f = fixture(), token = {}, frame = f.frame(); f.draw.mockImplementation(() => { throw Error('draw'); });
    f.renderer.enqueue(frame, 0, token); expect(() => f.renderer.renderTick(0)).toThrow('draw');
    expect(f.events.at(-1)).toEqual({ token, state: 'discarded', reason: 'draw failed' });
    expect(frame.close).toHaveBeenCalledOnce(); expect(f.renderer.videoPresentation).toBeNull(); f.off(); f.renderer.destroy();
  });
  it('reports unavailable instead of presented for a reentrant ambiguous draw', () => {
    const f = fixture(), outer = {}, inner = {}; let nested = false;
    f.draw.mockImplementation(() => { if (!nested) { nested = true; f.renderer.enqueue(f.frame(1), 0, inner); f.renderer.renderTick(0); } });
    f.renderer.enqueue(f.frame(), 0, outer); f.renderer.renderTick(0);
    expect(f.events.filter(event => event.state === 'presented')).toEqual([]);
    expect(f.events.filter(event => event.state === 'unavailable').map(event => event.token)).toEqual([inner, outer]);
    expect(f.renderer.videoPresentation).toBeNull(); f.off(); f.renderer.destroy();
  });
  it.each(['flush', 'destroy'] as const)('resolves %s once with its actual removal reason', method => {
    const f = fixture(), token = {}, frame = f.frame(); f.renderer.enqueue(frame, 20_000, token); f.renderer[method](); f.renderer.flush();
    expect(f.events.filter(event => event.state !== 'scheduled')).toEqual([{ token, state: 'discarded', reason: method === 'destroy' ? 'destroyed' : 'flushed' }]);
    expect(frame.close).toHaveBeenCalledOnce(); f.off(); f.renderer.destroy();
  });
  it('reports immediate rejection on a destroyed renderer', () => {
    const f = fixture(), token = {}, frame = f.frame(); f.renderer.destroy(); f.renderer.enqueue(frame, 0, token);
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'destroyed' }]); expect(frame.close).toHaveBeenCalledOnce(); f.off();
  });
  it('does not invent history for frames queued without an observer', () => {
    const f = fixture(); f.off(); f.renderer.enqueue(f.frame(), 0, {});
    const later: VideoFrameObservation[] = [], off = f.renderer.observeFrames(event => { later.push(event); });
    f.renderer.renderTick(0); expect(later).toEqual([]); off(); f.renderer.destroy();
  });
  it('contains observer faults and copies events without stopping presentation', async () => {
    const f = fixture(), token = {};
    const off = f.renderer.observeFrames(async event => { Reflect.set(event, 'state', 'changed'); throw Error('observer'); });
    f.renderer.enqueue(f.frame(), 0, token); f.renderer.renderTick(0); await Promise.resolve();
    expect(f.events.map(event => event.state)).toEqual(['scheduled', 'presented']); off(); f.off(); f.renderer.destroy();
  });
  it('does not resume old tick state after an observer flushes and enqueues a new frame', () => {
    const f = fixture(), token = {}, future = f.frame(1); let entered = false;
    const off = f.renderer.observeFrames(event => { if (event.state === 'presented' && !entered) {
      entered = true; f.renderer.flush(); f.renderer.enqueue(future, 0);
    } });
    f.renderer.enqueue(f.frame(), 0, token); f.renderer.renderTick(0);
    expect(f.draw).toHaveBeenCalledOnce(); expect(future.close).not.toHaveBeenCalled();
    off(); f.off(); f.renderer.destroy(); expect(future.close).toHaveBeenCalledOnce();
  });
});
