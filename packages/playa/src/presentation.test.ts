import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Player } from './player.js';
import { CommandDispatcher } from '@openmoq/player';
import type { MoqtPlayer, MoqtPlayerConfig } from '@openmoq/player';
import type { CanvasRenderer } from '@openmoq/browser';

beforeEach(() => {
  vi.stubGlobal('document', { hidden: false, removeEventListener: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('public video presentation', () => {
  it('retires draw evidence before waiting for audio teardown', async () => {
    const canvas = { width: 16, height: 16 };
    const player = new Player(null, {
      url: 'https://relay.example/moq', namespace: 'test',
      canvas: { ...canvas, getContext: () => ({ canvas, drawImage: vi.fn() }) } as unknown as HTMLCanvasElement,
      video: { volume: 1, muted: false } as HTMLVideoElement,
      moqtPlayerConfig: { logLevel: 'none' },
    });
    const engine = (player as unknown as { engine: MoqtPlayer }).engine;
    (engine as unknown as { commandDispatcher: CommandDispatcher }).commandDispatcher = new CommandDispatcher({
      renderer: {
        enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
        onFirstFrame: null, onFrameRendered: null, onStall: null,
        videoPresentation: { frameTimestampUs: 0n, timestampDomain: 'unknown', renderedAtUs: 123 },
      },
    });
    let release!: () => void;
    const closed = new Promise<void>((resolve) => { release = resolve; });
    (player as unknown as { audioCtx: unknown }).audioCtx = { state: 'running', close: () => closed };
    expect(player.videoPresentation?.frameTimestampUs).toBe(0n);
    const destroying = player.destroy();
    try {
      expect(player.videoPresentation).toBeNull();
    } finally {
      release();
      await destroying;
    }
  });

  it('reports the actual nonzero draw through both players while legacy elapsed time stays unchanged', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const canvas = { width: 16, height: 16 };
    const drawImage = vi.fn();
    const player = new Player(null, {
      url: 'https://relay.example/moq', namespace: 'test',
      canvas: { ...canvas, getContext: () => ({ canvas, drawImage }) } as unknown as HTMLCanvasElement,
      video: { volume: 1, muted: false } as HTMLVideoElement,
      moqtPlayerConfig: { logLevel: 'none' },
    });
    const engine = (player as unknown as { engine: MoqtPlayer }).engine;
    const internals = engine as unknown as {
      config: MoqtPlayerConfig;
      commandDispatcher: CommandDispatcher;
      _stats: { recordPlayStart(): void };
    };

    try {
      expect(player.videoPresentation).toBeNull();
      expect(engine.videoPresentation).toBeNull();
      const renderer = internals.config.createRenderer!() as CanvasRenderer;
      internals.commandDispatcher = new CommandDispatcher({ renderer });
      internals._stats.recordPlayStart();
      nowMs = 100;
      renderer.enqueue({ timestamp: 5_000_000, close: vi.fn() }, 100_000);
      renderer.renderTick(100_000);
      const tick = (player as unknown as { timeCtrl: { onTick(): void } }).timeCtrl;
      nowMs = 100;
      tick.onTick();
      expect(player.currentTime).toBe(100);
      expect(player.videoPresentation).toEqual({
        frameTimestampUs: 5_000_000n, timestampDomain: 'unknown', renderedAtUs: 100_000,
      });
      expect(engine.videoPresentation).toEqual(player.videoPresentation);
      expect(Object.isFrozen(player.videoPresentation)).toBe(true);

      nowMs = 1000;
      tick.onTick();
      expect(player.currentTime).toBe(1000);
      expect(player.videoPresentation?.frameTimestampUs).toBe(5_000_000n);
      expect(player.videoPresentation?.renderedAtUs).toBe(100_000);
    } finally {
      await player.destroy();
    }
    expect(player.videoPresentation).toBeNull();
    expect(engine.videoPresentation).toBeNull();
  });
});

describe('currentTime', () => {
  function videoPlayer() {
    const video = { volume: 1, muted: false, currentTime: 0 } as unknown as HTMLVideoElement & { currentTime: number };
    const player = new Player(null, {
      url: 'https://relay.example/moq', namespace: 'test', video,
      moqtPlayerConfig: { logLevel: 'none' },
    });
    const internals = player as unknown as { _state: string; _activeMediaType: string | null };
    internals._activeMediaType = 'video';
    return { player, video, internals };
  }

  it('tracks the video element while playing, with no timeupdate tick', async () => {
    // A hidden page pauses animation frames, so no tick runs while the video
    // keeps playing; the position must still advance.
    const { player, video, internals } = videoPlayer();
    try {
      internals._state = 'playing';
      video.currentTime = 4.5;
      expect(player.currentTime).toBe(4500);
      video.currentTime = 7.25;
      expect(player.currentTime).toBe(7250);
    } finally {
      await player.destroy();
    }
  });

  it('keeps the last committed position while not playing', async () => {
    const { player, video, internals } = videoPlayer();
    try {
      internals._state = 'playing';
      video.currentTime = 3;
      expect(player.currentTime).toBe(3000);
      internals._state = 'paused';
      video.currentTime = 9;
      expect(player.currentTime).toBe(3000);
    } finally {
      await player.destroy();
    }
  });
});
