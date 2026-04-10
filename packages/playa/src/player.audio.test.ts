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

vi.mock('@moqt/player', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moqt/player')>();
  class MockEngine {
    constructor(config: any) {
      capturedAudioOutputFactory = config.createAudioOutput;
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
      const [a, b, c] = await Promise.all([
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
