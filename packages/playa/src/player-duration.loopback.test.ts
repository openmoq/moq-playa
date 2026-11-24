import { afterEach, expect, it, vi } from 'vitest';
import { MoqtPlayer } from '@openmoq/player';
import { fixture } from '../../player/test-support/player-timeline-lifecycle.fixture.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { Player } from './player.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([undefined, 9000])('delivers the first duration and subsequent changes with catalog duration %s', async trackDuration => {
  const f = await fixture(22, false, true, { skipInitialTimeline: true, ...(trackDuration === undefined ? {} : { trackDuration }) });
  // Attach the facade's real listeners to the loopback engine; browser output is a double.
  const on = f.player.on.bind(f.player);
  vi.spyOn(MoqtPlayer.prototype, 'on').mockImplementation(on);
  vi.stubGlobal('document', { hidden: true, removeEventListener: vi.fn() });
  vi.stubGlobal('MediaSource', class {});
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const facade = new Player(null, { url: 'https://seek.example/moq', namespace: 'live/show',
    audioActivation: 'gesture', canvas: {} as HTMLCanvasElement,
    video: { volume: 1, muted: false, hidden: true } as HTMLVideoElement,
    moqtPlayerConfig: { logLevel: 'none' },
  });
  const durations: number[] = [], changes: number[] = [], order: string[] = [];
  const loaded = vi.fn(), updated = vi.fn();
  on('duration_changed', event => { durations.push(event.durationMs); order.push('duration'); });
  on('timeline_loaded', event => { loaded(event); order.push('loaded'); });
  on('timeline_updated', event => { updated(event); order.push('updated'); });
  facade.on('durationchange', event => changes.push(event.duration));
  const stream = await f.server.openSubgroup(300n, 1n, 0n, { publisherPriority: 128 });
  try {
    for (const [index, duration] of [3000, 5000, 5000].entries()) {
      await f.server.sendObject(stream, BigInt(index), new TextEncoder().encode(JSON.stringify([
        [1000, [3, 0], 0], [duration, [4 + index, 0], 0],
      ])));
      await flush(128);
    }
    expect(durations).toEqual(trackDuration === undefined ? [3000, 5000] : [9000]);
    expect(changes).toEqual(durations);
    expect(facade.duration).toBe(trackDuration ?? 5000);
    expect(order).toEqual(trackDuration === undefined
      ? ['loaded', 'duration', 'updated', 'duration', 'updated'] : ['loaded', 'duration', 'updated', 'updated']);
    expect(loaded).toHaveBeenCalledOnce(); expect(updated).toHaveBeenCalledTimes(2);
  } finally {
    await f.server.closeSubgroup(stream); await facade.destroy(); await f.destroy();
  }
});
