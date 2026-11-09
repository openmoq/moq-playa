import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoqtPlayerConfig, VideoRendererLike } from '@openmoq/player';
import { CanvasRenderer } from '@openmoq/browser';

// Actual facade and CanvasRenderer bodies; only the engine lifecycle and DOM /
// AudioContext primitives are unit fakes. No browser-close failure is claimed.
const owned = vi.hoisted(() => ({ renderer: undefined as VideoRendererLike | undefined,
  engineDestroy: vi.fn(), rejectClose: false, failure: Error('AudioContext close rejected') }));
vi.mock('@openmoq/player', async importOriginal => {
  const actual = await importOriginal<typeof import('@openmoq/player')>();
  return { ...actual, MoqtPlayer: class {
    constructor(config: MoqtPlayerConfig) { owned.renderer = config.createRenderer?.(); }
    on = vi.fn(() => () => {});
    async destroy() { owned.engineDestroy(); owned.renderer?.destroy(); }
  } };
});

function element() {
  return { style: {}, appendChild: vi.fn(), removeChild: vi.fn(), hidden: false,
    getContext: () => ({ drawImage: vi.fn(), canvas: { width: 10, height: 10 } }),
    width: 10, height: 10, volume: 1, muted: false, playsInline: true, parentNode: null };
}
class AudioContextFake {
  state = 'suspended'; currentTime = 0; destination = {};
  async resume() { this.state = 'running'; }
  async close() { if (owned.rejectClose) throw owned.failure; this.state = 'closed'; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  getOutputTimestamp() { return { contextTime: 0, performanceTime: 0 }; }
}
beforeEach(() => {
  owned.renderer = undefined; owned.engineDestroy.mockClear(); owned.rejectClose = false;
  vi.stubGlobal('AudioContext', AudioContextFake);
  vi.stubGlobal('document', { hidden: false, createElement: element, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { owned.renderer?.destroy(); vi.unstubAllGlobals(); });
const { Player } = await import('./player.js');

describe('facade sole native destruction owner', () => {
  it('still releases a queued native frame if facade-owned AudioContext closure rejects', async () => {
    const player = new Player(element() as unknown as HTMLElement, {
      url: 'https://unused.invalid', namespace: 'review', audioActivation: 'gesture',
    });
    await player.prepareAudio();
    const renderer = owned.renderer as CanvasRenderer, frame = { timestamp: 0, close: vi.fn() };
    renderer.enqueue(frame, 1_000_000);
    owned.rejectClose = true;
    await expect(player.destroy()).rejects.toBe(owned.failure);
    expect(frame.close).toHaveBeenCalledOnce();
  });

  it('releases that same frame through the engine when AudioContext closure succeeds', async () => {
    const player = new Player(element() as unknown as HTMLElement, {
      url: 'https://unused.invalid', namespace: 'review', audioActivation: 'gesture',
    });
    await player.prepareAudio();
    const renderer = owned.renderer as CanvasRenderer, frame = { timestamp: 0, close: vi.fn() };
    renderer.enqueue(frame, 1_000_000);
    await player.destroy();
    expect(owned.engineDestroy).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce();
  });

  it('keeps one cleanup owner when stopping the embedding reenters and throws', async () => {
    const player = new Player(element() as unknown as HTMLElement, {
      url: 'https://unused.invalid', namespace: 'review', audioActivation: 'gesture',
    });
    const renderer = owned.renderer as CanvasRenderer, frame = { timestamp: 0, close: vi.fn() };
    renderer.enqueue(frame, 1_000_000);
    const failure = new Error('embedding stop failed');
    let nested: Promise<void> | undefined;
    vi.spyOn(renderer, 'stop').mockImplementationOnce(() => { nested = player.destroy(); throw failure; });
    const destruction = player.destroy();
    // Observe both promises even when the ownership assertion fails on baseline.
    void destruction.catch(() => {}); void nested?.catch(() => {});
    expect(nested).toBe(destruction);
    await expect(destruction).rejects.toBe(failure);
    expect(player.destroy()).toBe(destruction);
    expect(owned.engineDestroy).toHaveBeenCalledOnce(); expect(frame.close).toHaveBeenCalledOnce();
  });

  it('removes owned DOM after an audio close failure and preserves supplied elements', async () => {
    const container = element();
    container.appendChild.mockImplementation((child: { parentNode: unknown }) => { child.parentNode = container; });
    const player = new Player(container as unknown as HTMLElement, {
      url: 'https://unused.invalid', namespace: 'review', audioActivation: 'gesture',
    });
    await player.prepareAudio(); owned.rejectClose = true;
    await expect(player.destroy()).rejects.toBe(owned.failure);
    expect(container.removeChild).toHaveBeenCalledTimes(2);
    expect(owned.engineDestroy).toHaveBeenCalledOnce();
  });
});
