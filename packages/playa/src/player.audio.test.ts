/**
 * Player audio lifecycle tests.
 *
 * Scoped to the audio activation surface: audioActivation, prepareAudio(),
 * unmute(), mute(), toggleMute(), and their interaction with the deferred
 * audio output.
 *
 * Not using jsdom — the interesting logic here is the AudioContext lifecycle
 * and the deferred output wiring, neither of which jsdom implements. Pulling
 * jsdom in just to satisfy `document.createElement` for the canvas/video is
 * bloat for what we actually need to verify. We mock the DOM primitives and
 * the engine directly — the tests stay fast and focused on the contract
 * that matters: "no AudioContext until user gesture, no dropped audio after".
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FrameOutput, MoqtPlayerConfig } from '@openmoq/player';
import { CanvasRenderer, DeferredAudioOutput } from '@openmoq/browser';

// ─── Mocks ────────────────────────────────────────────────────────────

// Controllable resume() behavior — test can override before creating player
let resumeBehavior: () => Promise<void> = async () => {};

class MockAudioContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  outputLatency = 0.005;
  destination = { maxChannelCount: 2 } as unknown as AudioDestinationNode;
  resume = vi.fn(async () => {
    await resumeBehavior();
    this.state = 'running';
  });
  close = vi.fn(async () => { this.state = 'closed'; });
  createGain = vi.fn(() => ({
    gain: { value: 1, setTargetAtTime: vi.fn() },
    connect: vi.fn(),
  }));
  getOutputTimestamp = vi.fn(() => ({ contextTime: 0, performanceTime: 0 }));
}

// Capture constructor count so we can assert NO AudioContext is created before user gesture
let audioContextConstructorCalls = 0;
(globalThis as any).AudioContext = class extends MockAudioContext {
  constructor() {
    super();
    audioContextConstructorCalls++;
  }
};

// Minimal DOM shims — just enough to let the Player constructor run
function mockElement(): any {
  const style: Record<string, string> = {};
  return {
    style: new Proxy(style, { set: (t, k, v) => { t[k as string] = v; return true; } }),
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    addEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    width: 0, height: 0,
    hidden: false, muted: false, volume: 1, playsInline: false,
    parentNode: null as any,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  };
}

(globalThis as any).document = {
  createElement: (_tag: string) => mockElement(),
  hidden: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

(globalThis as any).HTMLElement = class {};
(globalThis as any).HTMLCanvasElement = class {};
(globalThis as any).HTMLVideoElement = class {};
(globalThis as any).requestAnimationFrame = vi.fn(() => 0);
(globalThis as any).cancelAnimationFrame = vi.fn();

// Engine stub — captures the audioOutput factory so we can assert what was passed
let capturedAudioOutputFactory: (() => unknown) | undefined;
let capturedCatalogTrackName: string | undefined;
let capturedFrameOutputFactory: MoqtPlayerConfig['createFrameOutput'];
let capturedRendererFactory: MoqtPlayerConfig['createRenderer'];

vi.mock('@openmoq/player', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmoq/player')>();
  class MockEngine {
    constructor(config: any) {
      capturedAudioOutputFactory = config.createAudioOutput;
      capturedCatalogTrackName = config.catalogTrackName;
      capturedFrameOutputFactory = config.createFrameOutput;
      capturedRendererFactory = config.createRenderer;
    }
    async load(): Promise<void> {}
    play(): void {}
    pause(): void {}
    async destroy(): Promise<void> {}
    seekable = false;
    duration = undefined;
    currentTime = 0;
    stats = {};
    on = vi.fn(() => () => {});
    off = vi.fn();
    emit = vi.fn();
  }
  return { ...actual, MoqtPlayer: MockEngine };
});

// ─── Tests ────────────────────────────────────────────────────────────

// Import AFTER mocks are set up
const { Player } = await import('./player.js');

describe('Player catalog track name', () => {
  it.each([undefined, '.catalog'])('passes the optional name %s to the engine', async catalogTrackName => {
    const player = new Player(mockElement() as HTMLElement, {
      url: 'x', namespace: 'y', ...(catalogTrackName === undefined ? {} : { catalogTrackName }),
    });
    expect(capturedCatalogTrackName).toBe(catalogTrackName ?? 'catalog');
    await player.destroy();
  });
});

describe('Player — audio activation', () => {
  beforeEach(() => {
    audioContextConstructorCalls = 0;
    capturedAudioOutputFactory = undefined;
  });

  describe("audioActivation: 'gesture'", () => {
    it('does not create AudioContext on construction', () => {
      new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      expect(audioContextConstructorCalls).toBe(0);
    });

    it('does not create AudioContext on play()', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      await p.load();
      p.play();
      expect(audioContextConstructorCalls).toBe(0);
    });

    it('does not create AudioContext on setVolume()', () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      p.setVolume(0.5);
      expect(audioContextConstructorCalls).toBe(0);
    });

    it('does not create AudioContext on mute()', () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      p.mute();
      expect(audioContextConstructorCalls).toBe(0);
    });

    it('prepareAudio() creates AudioContext and resumes it', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      await p.prepareAudio();
      expect(audioContextConstructorCalls).toBe(1);
    });

    it('concurrent prepareAudio() calls share the same promise', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      await Promise.all([
        p.prepareAudio(),
        p.prepareAudio(),
        p.prepareAudio(),
      ]);
      expect(audioContextConstructorCalls).toBe(1);
    });

    it('prepareAudio() retries after rejection', async () => {
      // First resume() rejects, second succeeds
      let resumeCalls = 0;
      resumeBehavior = async () => {
        resumeCalls++;
        if (resumeCalls === 1) throw new Error('nope');
      };

      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });

      await expect(p.prepareAudio()).rejects.toThrow('nope');
      // Second call should retry — not stuck with the rejected promise
      await p.prepareAudio();
      expect(resumeCalls).toBe(2);

      resumeBehavior = async () => {}; // restore
    });

    it('createAudioOutput factory returns DeferredAudioOutput', () => {
      new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      const output = capturedAudioOutputFactory?.() as any;
      expect(output).toBeDefined();
      expect(output.isActive).toBe(false); // deferred, not yet activated
      expect(typeof output.activate).toBe('function');
    });

    it('unmute() activates the deferred output', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture', muted: true,
      });
      const output = capturedAudioOutputFactory?.() as any;
      expect(output.isActive).toBe(false);

      await p.unmute();
      expect(output.isActive).toBe(true);
      expect(p.muted).toBe(false);
    });
  });

  describe('CMAF/MSE path (video element owns audio)', () => {
    it('prepareAudio() is a no-op when active sink is video element', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture',
      });
      // Simulate CMAF catalog: player wires video sink via catalog_received
      (p as any)._activeMediaType = 'video';

      await p.prepareAudio();
      expect(audioContextConstructorCalls).toBe(0);
    });

    it('unmute() does not create AudioContext on CMAF path', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture', muted: true,
      });
      (p as any)._activeMediaType = 'video';

      await p.unmute();
      expect(audioContextConstructorCalls).toBe(0);
      expect(p.muted).toBe(false);
    });
  });

  describe("audioActivation: 'auto' (default)", () => {
    it('creates AudioContext eagerly on play()', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y',
      });
      await p.load();
      p.play();
      expect(audioContextConstructorCalls).toBe(1);
    });
  });

  describe('toggleMute()', () => {
    it('returns a promise (may be async on first unmute in gesture mode)', async () => {
      const p = new Player(mockElement() as HTMLElement, {
        url: 'x', namespace: 'y', audioActivation: 'gesture', muted: true,
      });
      const result = p.toggleMute();
      expect(result).toBeInstanceOf(Promise);
      await result;
      expect(p.muted).toBe(false);
    });
  });
});

describe('Player — play()', () => {
  it('is a no-op while already playing', async () => {
    const p = new Player(mockElement() as HTMLElement, { url: 'x', namespace: 'y' });
    await p.load();
    const plays: unknown[] = [];
    p.on('play', (e) => plays.push(e));
    p.play();
    p.play();
    expect(plays).toHaveLength(1);
    expect(p.state).toBe('playing');
  });
});


describe('Player stats measurement mapping', () => {
  it.each([250, 0, -5])('forwards legacy age and nullable observations without changing frame semantics: %s', age => {
    const player = new Player(mockElement() as HTMLElement, { url: 'x', namespace: 'y' });
    const quality = { totalVideoFrames: 300, droppedVideoFrames: 3, displayedVideoFrames: 297, creationTimeMs: 10 };
    (player as unknown as { engine: { stats: object } }).engine.stats = {
      currentLatencyMs: age, captureTimestampAgeMs: age, videoPlaybackQuality: quality,
      framesDecoded: 7, framesRendered: 4, framesDropped: 1,
    };
    expect(player.stats).toMatchObject({ latencyMs: age, captureTimestampAgeMs: age, videoPlaybackQuality: quality,
      framesDecoded: 7, framesRendered: 4, framesDropped: 1 });
  });

  it('maps absent optional observations to null rather than measured zero', () => {
    const player = new Player(mockElement() as HTMLElement, { url: 'x', namespace: 'y' });
    (player as unknown as { engine: { stats: object } }).engine.stats = { currentLatencyMs: 0 };
    expect(player.stats).toMatchObject({ latencyMs: 0, captureTimestampAgeMs: null, videoPlaybackQuality: null });
  });
});

describe('Player fresh frame output ownership', () => {
  const clock = { now: () => 1_000_000 };
  function createPlayer() {
    return new Player(mockElement() as HTMLElement, {
      url: 'x', namespace: 'y', audioActivation: 'gesture',
    });
  }
  function acquire(video = true, audio = true): FrameOutput {
    expect(capturedFrameOutputFactory).toBeTypeOf('function');
    return capturedFrameOutputFactory!({ video, audio, clock });
  }
  function retire(output: FrameOutput): void {
    output.videoDecoder?.destroy(); output.renderer?.destroy(); output.audioDecoder?.destroy(); output.audioOutput?.destroy();
    output.onRetire?.();
  }
  it('prepares independent inactive adapters without allocating an AudioContext or changing current output', async () => {
    const player = createPlayer(), before = audioContextConstructorCalls;
    const current = capturedRendererFactory!();
    const first = acquire(), next = acquire();
    expect(first.renderer).not.toBe(current); expect(next.renderer).not.toBe(first.renderer);
    expect(next.videoDecoder).not.toBe(first.videoDecoder); expect(next.audioDecoder).not.toBe(first.audioDecoder);
    expect(first.audioOutput).toBeInstanceOf(DeferredAudioOutput);
    expect((first.audioOutput as DeferredAudioOutput).isActive).toBe(false);
    expect(audioContextConstructorCalls).toBe(before);
    expect((player as unknown as { renderer: unknown }).renderer).toBe(current);
    retire(first); retire(next); await player.destroy(); current.destroy();
  });
  it('adopts a fresh deferred output and activates that current graph on the later user gesture', async () => {
    const player = createPlayer(), before = audioContextConstructorCalls, output = acquire();
    output.onAdopt?.({ playing: false });
    expect(audioContextConstructorCalls).toBe(before);
    expect((player as unknown as { deferredAudio: unknown }).deferredAudio).toBe(output.audioOutput);
    player.setVolume(0.25); player.mute();
    await player.unmute();
    expect(audioContextConstructorCalls).toBe(before + 1); expect(player.volume).toBe(0.25); expect(player.muted).toBe(false);
    expect((output.audioOutput as DeferredAudioOutput).isActive).toBe(true);
    retire(output); await player.destroy();
  });
  it('does not let retiring a displaced graph clear its adopted successor', async () => {
    const player = createPlayer(), first = acquire(), next = acquire();
    first.onAdopt?.({ playing: false }); next.onAdopt?.({ playing: false }); retire(first);
    expect((player as unknown as { renderer: unknown }).renderer).toBe(next.renderer);
    expect((player as unknown as { deferredAudio: unknown }).deferredAudio).toBe(next.audioOutput);
    retire(next); await player.destroy();
  });
  it('keeps a paused graph stopped and leaves its explicit preview tick to the engine', async () => {
    const player = createPlayer(); player.pause();
    const output = acquire(true, false), renderer = output.renderer as CanvasRenderer;
    const tick = vi.spyOn(renderer, 'renderTick');
    const start = vi.spyOn(renderer, 'start');
    output.onAdopt?.({ playing: false }); await Promise.resolve();
    expect(tick).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(output.renderer?.renderTick).toBeTypeOf('function');
    retire(output);
    const abandoned = acquire(true, false), abandonedRenderer = abandoned.renderer as CanvasRenderer;
    const lateTick = vi.spyOn(abandonedRenderer, 'renderTick'); abandoned.onAdopt?.({ playing: false });
    await player.destroy(); await Promise.resolve(); expect(lateTick).not.toHaveBeenCalled(); retire(abandoned);
  });
  it('stops rendering immediately but leaves native destruction to the engine owner', async () => {
    const player = createPlayer(), renderer = capturedRendererFactory!() as CanvasRenderer;
    const stop = vi.spyOn(renderer, 'stop'), destroy = vi.spyOn(renderer, 'destroy');
    await player.destroy(); expect(stop).toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
    // The engine is a stub in this suite; discharge its native ownership here.
    renderer.destroy();
  });
  it('does not silently use browser preparation when startup adapters were replaced', async () => {
    const player = new Player(mockElement() as HTMLElement, {
      url: 'x', namespace: 'y', audioActivation: 'gesture',
      moqtPlayerConfig: { createRenderer: () => new CanvasRenderer(mockElement() as HTMLCanvasElement) },
    });
    expect(capturedFrameOutputFactory).toBeUndefined(); await player.destroy();
  });
  it('preserves an explicit custom preparation factory alongside startup overrides', async () => {
    const createFrameOutput = vi.fn(() => ({}));
    const player = new Player(mockElement() as HTMLElement, {
      url: 'x', namespace: 'y', audioActivation: 'gesture',
      moqtPlayerConfig: { createRenderer: () => new CanvasRenderer(mockElement() as HTMLCanvasElement), createFrameOutput },
    });
    expect(capturedFrameOutputFactory).toBe(createFrameOutput); await player.destroy();
  });
  it('does not restart a renderer when volume application destroys the embedding during adoption', async () => {
    const video = mockElement(); let armed = false, destroying: Promise<void> | undefined;
    const player = new Player(mockElement() as HTMLElement, {
      url: 'x', namespace: 'y', video: video as HTMLVideoElement, audioActivation: 'gesture',
    });
    Object.defineProperty(video, 'volume', { get: () => 1, set() {
      if (armed) { armed = false; destroying = player.destroy(); }
    } });
    const output = acquire(true, false), start = vi.spyOn(output.renderer as CanvasRenderer, 'start');
    armed = true;
    expect(() => output.onAdopt?.({ playing: true })).toThrow(/retired/);
    expect(start).not.toHaveBeenCalled(); await destroying; retire(output);
  });
});
