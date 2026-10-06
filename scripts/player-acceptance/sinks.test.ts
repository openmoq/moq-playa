import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeAudio, observeCanvas } from '../../examples/_tests/player-acceptance/sinks.js';

afterEach(() => vi.unstubAllGlobals());

describe('native output observers', () => {
  it('counts only successful VideoFrame draws and preserves native draw arguments', () => {
    class Frame { timestamp = 125000; displayWidth = 640; displayHeight = 360; }
    vi.stubGlobal('VideoFrame', Frame);
    let refresh!: () => void;
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { refresh = callback; return 7; });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const drawImage = vi.fn(function (this: unknown, ...args: unknown[]) { if (args[0] === null) throw new Error('bad source'); });
    const context = { drawImage };
    const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
    const state = observeCanvas(canvas);
    const frame = new Frame();
    context.drawImage(frame, 0, 0, 640, 360);
    expect(drawImage.mock.calls).toEqual([[frame, 0, 0, 640, 360]]);
    expect(drawImage.mock.instances).toEqual([context]);
    expect(state.frames).toBe(0);
    refresh();
    expect(state).toMatchObject({ frames: 1, timestampUs: 125000, width: 640, height: 360 });
    context.drawImage(frame);
    context.drawImage(frame);
    refresh();
    expect(state.frames).toBe(2);
    expect(state.draws).toBe(3);
    refresh();
    expect(state.frames).toBe(2);
    context.drawImage(canvas);
    expect(() => context.drawImage(null)).toThrow('bad source');
    expect(state.frames).toBe(2);
    state.restore();
    expect(context.drawImage).toBe(drawImage);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('tees only the existing post-gain speaker connection without replacing it', () => {
    const calls: { source: unknown; args: unknown[] }[] = [];
    class Node {
      constructor(readonly context: unknown) {}
      connect(...args: unknown[]) { calls.push({ source: this, args }); if (args[0] === null) throw new Error('bad node'); return args[0]; }
      disconnect = vi.fn();
    }
    class Gain extends Node {}
    class Destination extends Node {}
    class Context {
      createAnalyser = vi.fn(() => ({ fftSize: 0, smoothingTimeConstant: 1 }));
    }
    vi.stubGlobal('AudioNode', Node);
    vi.stubGlobal('GainNode', Gain);
    vi.stubGlobal('AudioDestinationNode', Destination);
    vi.stubGlobal('AudioContext', Context);
    const original = Node.prototype.connect;
    const context = new Context();
    const gain = new Gain(context);
    const destination = new Destination(context);
    const state = observeAudio();
    expect(gain.connect(destination, 0, 0)).toBe(destination);
    expect(calls[0]).toEqual({ source: gain, args: [destination, 0, 0] });
    expect(state.taps).toHaveLength(1);
    expect(state.taps[0]!.context).toBe(context);
    expect(calls[1]).toEqual({ source: gain, args: [state.taps[0]!.analyser] });
    expect(state.taps[0]!.analyser).toMatchObject({ fftSize: 4096, smoothingTimeConstant: 0 });
    expect(gain.connect(destination)).toBe(destination);
    expect(context.createAnalyser).toHaveBeenCalledTimes(1);
    const unrelated = new Node(context);
    unrelated.connect(destination);
    gain.connect({ value: 1 });
    expect(() => gain.connect(null)).toThrow('bad node');
    expect(state.taps).toHaveLength(1);
    state.restore();
    expect(Node.prototype.connect).toBe(original);
    expect(gain.disconnect).toHaveBeenCalledExactlyOnceWith(state.taps[0]!.analyser);
  });
});
