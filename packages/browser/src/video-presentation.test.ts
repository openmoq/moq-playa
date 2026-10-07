import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasRenderer } from './canvas-renderer.js';

function setup() {
  let nowUs = 100;
  const canvas = { width: 16, height: 16 };
  const drawImage = vi.fn();
  const context = { canvas, drawImage };
  const renderer = new CanvasRenderer({ ...canvas, getContext: () => context } as unknown as HTMLCanvasElement,
    { clock: { now: () => nowUs } });
  return { renderer, drawImage, setClock: (value: number) => { nowUs = value; } };
}

function frame(timestamp: number) {
  return { timestamp, close: vi.fn() };
}

beforeEach(() => vi.stubGlobal('document', { hidden: false, removeEventListener: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe('canvas video presentation', () => {
  it('does not expose old evidence while a draw is still in progress', () => {
    const { renderer, drawImage } = setup();
    renderer.enqueue(frame(1000), 100);
    renderer.renderTick(100);
    drawImage.mockImplementationOnce(() => expect(renderer.videoPresentation).toBeNull());
    renderer.enqueue(frame(2000), 200);
    renderer.renderTick(200);
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(2000n);
    renderer.destroy();
  });

  it.each(['outer', 'nested'] as const)('keeps overlapping draw evidence unavailable when the %s draw fails', (failure) => {
    const { renderer, drawImage } = setup();
    renderer.enqueue(frame(0), 0);
    renderer.renderTick(0);
    const a = frame(1000);
    const b = frame(2000);
    renderer.enqueue(a, 100);
    renderer.enqueue(b, 200);
    drawImage.mockImplementation((decoded: { timestamp: number }) => {
      if (decoded === a) {
        if (failure === 'nested') expect(() => renderer.renderTick(200)).toThrow('nested draw');
        else { renderer.renderTick(200); throw new Error('outer draw'); }
      } else if (decoded === b && failure === 'nested') throw new Error('nested draw');
    });
    if (failure === 'outer') expect(() => renderer.renderTick(100)).toThrow('outer draw');
    else renderer.renderTick(100);
    expect(renderer.videoPresentation).toBeNull();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    renderer.enqueue(frame(3000), 300);
    renderer.renderTick(300);
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(3000n);
    renderer.destroy();
  });

  it('keeps a newer completed draw when the diagnostic clock lookup reenters', () => {
    let first = true;
    const drawn: number[] = [];
    const canvas = { width: 16, height: 16 };
    const clock = { get now() {
      if (first) { first = false; renderer.renderTick(200); return () => 100; }
      return () => 200;
    } };
    const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: (decoded: { timestamp: number }) => drawn.push(decoded.timestamp) }) } as unknown as HTMLCanvasElement,
      { clock });
    renderer.enqueue(frame(1000), 100);
    renderer.enqueue(frame(2000), 200);
    renderer.renderTick(100);
    expect(drawn).toEqual([1000, 2000]);
    expect(renderer.videoPresentation).toEqual({ frameTimestampUs: 2000n, timestampDomain: 'unknown', renderedAtUs: 200 });
    renderer.destroy();
  });

  it('treats a nested drawing exception escaping the diagnostic clock query as unavailable', () => {
    let first = true;
    const canvas = { width: 16, height: 16 };
    const clock = { now: () => {
      if (first) { first = false; renderer.renderTick(200); }
      return 200;
    } };
    const a = frame(1000);
    const b = frame(2000);
    const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: (decoded: unknown) => {
      if (decoded === b) throw new Error('nested draw');
    } }) } as unknown as HTMLCanvasElement, { clock });
    const feedback = vi.fn();
    renderer.onFrameRendered = feedback;
    renderer.enqueue(a, 100);
    renderer.enqueue(b, 200);
    expect(() => renderer.renderTick(100)).not.toThrow();
    expect(renderer.videoPresentation).toBeNull();
    expect(feedback.mock.calls).toEqual([[1000n, 100, 100]]);
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    renderer.enqueue(frame(3000), 300);
    renderer.renderTick(300);
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(3000n);
    renderer.destroy();
  });

  it.each(['lookup', 'invoke'] as const)('does not let a diagnostic clock %s failure interrupt rendering', (phase) => {
    let fail = true;
    const canvas = { width: 16, height: 16 };
    const clock = { get now() {
      if (fail && phase === 'lookup') throw new Error('clock lookup');
      return () => { if (fail) throw new Error('clock query'); return 200; };
    } };
    const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: vi.fn() }) } as unknown as HTMLCanvasElement, { clock });
    const feedback = vi.fn();
    renderer.onFrameRendered = feedback;
    const decoded = frame(1000);
    renderer.enqueue(decoded, 100);
    expect(() => renderer.renderTick(100)).not.toThrow();
    expect(renderer.videoPresentation).toBeNull();
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(feedback).toHaveBeenCalledExactlyOnceWith(1000n, 100, 100);
    fail = false;
    renderer.enqueue(frame(2000), 200);
    renderer.renderTick(200);
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(2000n);
    renderer.destroy();
  });

  it('cannot restore evidence after the diagnostic clock destroys its owner', () => {
    const canvas = { width: 16, height: 16 };
    const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: vi.fn() }) } as unknown as HTMLCanvasElement,
      { clock: { now: () => { renderer.destroy(); return 100; } } });
    const decoded = frame(1000);
    renderer.enqueue(decoded, 100);
    renderer.renderTick(100);
    expect(renderer.videoPresentation).toBeNull();
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it.each(['before', 'after'] as const)('does not guess the final draw when a wrapper reenters %s its native draw', (order) => {
    const { renderer, drawImage } = setup();
    const drawn: number[] = [];
    const a = frame(1000);
    const b = frame(2000);
    renderer.enqueue(a, 100);
    renderer.enqueue(b, 200);
    drawImage.mockImplementation((decoded: { timestamp: number }) => {
      if (decoded === a && order === 'before') renderer.renderTick(200);
      drawn.push(decoded.timestamp);
      if (decoded === a && order === 'after') renderer.renderTick(200);
    });
    renderer.renderTick(100);
    expect(drawn).toEqual(order === 'before' ? [2000, 1000] : [1000, 2000]);
    expect(renderer.videoPresentation).toBeNull();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    renderer.enqueue(frame(3000), 300);
    renderer.renderTick(300);
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(3000n);
    renderer.destroy();
  });

  it('samples each successful draw independently of tick time and legacy feedback', () => {
    let nowUs = 100;
    const drawnAt: number[] = [];
    const canvas = { width: 16, height: 16 };
    const renderer = new CanvasRenderer({ getContext: () => ({ canvas, drawImage: () => drawnAt.push(nowUs) }) } as unknown as HTMLCanvasElement,
      { clock: { now: () => nowUs } });
    const feedback = vi.fn();
    renderer.onFrameRendered = feedback;
    renderer.onFirstFrame = () => { nowUs = 300100; };
    renderer.enqueue(frame(1000), 100);
    renderer.enqueue(frame(2000), 100);
    renderer.renderTick(100);
    expect(drawnAt).toEqual([100, 300100]);
    expect(renderer.videoPresentation).toEqual({ frameTimestampUs: 2000n, timestampDomain: 'unknown', renderedAtUs: 300100 });
    expect(feedback.mock.calls).toEqual([[1000n, 100, 100], [2000n, 100, 100]]);
    renderer.destroy();
  });

  it('is unavailable until a frame has actually been drawn', () => {
    const { renderer } = setup();
    expect(renderer.videoPresentation).toBeNull();
    const pending = frame(5_000_000);
    renderer.enqueue(pending, 100);
    renderer.renderTick(99);
    expect(renderer.videoPresentation).toBeNull();
    renderer.destroy();
    expect(pending.close).toHaveBeenCalledOnce();
  });

  it.each([0, -1000, 5_000_000])('records exact decoded timestamp %s without guessing its origin', (timestamp) => {
    const { renderer, drawImage } = setup();
    const decoded = frame(timestamp);
    renderer.enqueue(decoded, 100);
    renderer.renderTick(100);

    expect(drawImage).toHaveBeenCalledOnce();
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(renderer.videoPresentation).toEqual({
      frameTimestampUs: BigInt(timestamp), timestampDomain: 'unknown', renderedAtUs: 100,
    });
    expect(Object.isFrozen(renderer.videoPresentation)).toBe(true);
    renderer.destroy();
  });

  it('does not extrapolate a held picture as the client clock advances', () => {
    const { renderer } = setup();
    renderer.enqueue(frame(5_000_000), 100);
    renderer.renderTick(100);
    const observed = renderer.videoPresentation;
    renderer.renderTick(1_000_000);
    expect(renderer.videoPresentation).toBe(observed);
    expect(renderer.videoPresentation?.renderedAtUs).toBe(100);
    renderer.destroy();
  });

  it('reports the final actual draw, not the largest PTS or a future queued frame', () => {
    const { renderer, drawImage, setClock } = setup();
    renderer.enqueue(frame(5_000_000), 100);
    renderer.enqueue(frame(4_000_000), 200);
    const future = frame(6_000_000);
    renderer.enqueue(future, 1000);
    setClock(200);
    renderer.renderTick(200);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(4_000_000n);
    expect(renderer.videoPresentation?.renderedAtUs).toBe(200);
    renderer.destroy();
    expect(future.close).toHaveBeenCalledOnce();
  });

  it('keeps the historical draw on stop and queue flush but clears it on destruction', () => {
    const { renderer } = setup();
    renderer.enqueue(frame(5_000_000), 100);
    renderer.renderTick(100);
    const observed = renderer.videoPresentation;
    renderer.enqueue(frame(6_000_000), 1000);
    renderer.stop();
    renderer.flush();
    expect(renderer.videoPresentation).toBe(observed);
    renderer.destroy();
    expect(renderer.videoPresentation).toBeNull();
    renderer.enqueue(frame(7_000_000), 2000);
    renderer.renderTick(2000);
    expect(renderer.videoPresentation).toBeNull();
  });

  it('does not publish a failed draw and still releases its frame', () => {
    const { renderer, drawImage } = setup();
    renderer.enqueue(frame(5_000_000), 100);
    renderer.renderTick(100);
    const observed = renderer.videoPresentation;
    const failed = frame(6_000_000);
    drawImage.mockImplementationOnce(() => { throw new Error('draw failed'); });
    renderer.enqueue(failed, 200);
    expect(() => renderer.renderTick(200)).toThrow('draw failed');
    expect(renderer.videoPresentation).toBe(observed);
    expect(failed.close).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it('commits draw evidence before a fallible first-frame listener', () => {
    const { renderer } = setup();
    renderer.onFirstFrame = () => { throw new Error('listener failed'); };
    renderer.enqueue(frame(5_000_000), 100);
    expect(() => renderer.renderTick(100)).toThrow('listener failed');
    expect(renderer.videoPresentation?.frameTimestampUs).toBe(5_000_000n);
    renderer.destroy();
  });

  it('does not resurrect presentation after a listener destroys the renderer', () => {
    const { renderer } = setup();
    renderer.onFirstFrame = () => renderer.destroy();
    renderer.enqueue(frame(5_000_000), 100);
    renderer.renderTick(100);
    expect(renderer.videoPresentation).toBeNull();
  });

  it('does not pretend an unsafe native number is an exact source timestamp', () => {
    const { renderer, drawImage } = setup();
    renderer.enqueue(frame(2 ** 53), 100);
    renderer.renderTick(100);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(renderer.videoPresentation).toEqual({
      frameTimestampUs: null, timestampDomain: 'unknown', renderedAtUs: 100,
    });
    renderer.destroy();
  });

  it('does not resurrect draw evidence when the draw hook destroys the renderer', () => {
    const { renderer, drawImage } = setup();
    const decoded = frame(5_000_000);
    drawImage.mockImplementationOnce(() => renderer.destroy());
    renderer.enqueue(decoded, 100);
    renderer.renderTick(100);
    expect(renderer.videoPresentation).toBeNull();
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('reports unavailable evidence rather than a nonfinite render clock', () => {
    const { renderer, drawImage, setClock } = setup();
    renderer.enqueue(frame(5_000_000), 100);
    setClock(Infinity);
    renderer.renderTick(100);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(renderer.videoPresentation).toBeNull();
    renderer.destroy();
  });
});
