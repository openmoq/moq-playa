import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, fixture, flush, refusal } from './startup-lifecycle-support.js';

beforeEach(() => vi.useFakeTimers({
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
}));
afterEach(() => vi.useRealTimers());

describe('manual startup Play affordance', () => {
  it('restores visible Play after an early refusal at the actual initial-click hide boundary', async () => {
    const f = fixture((player, index) => {
      if (index === 1) player.load.mockImplementation(async () => { player.emit(refusal); });
    });
    try {
      expect(f.context.controls.style.display).toBe('none');
      f.clickStart();
      expect(f.context.centerPlay.style.display).toBe('none');
      await flush();
      expect(f.context.isPlaying).toBe(false);
      expect(f.context.player).toBeNull();
      expect(f.context.transitioning).toBe(false);
      expect(f.context.pauseBtn.disabled).toBe(false);
      expect(f.context.controls.style.display).toBe('none');
      expect(f.context.centerPlay.style.display).toBe('');
      expect(f.context.loadingSpinner.style.display).toBe('none');
      expect(f.consoleError).toHaveBeenCalledOnce();
      expect(f.instances).toHaveLength(1);

      // A deliberate click can start again; refusal did not create an automatic retune.
      f.clickStart();
      await flush();
      expect(f.instances).toHaveLength(2);
      expect(f.context.isPlaying).toBe(true);
      expect(f.context.centerPlay.style.display).toBe('none');
    } finally {
      await f.close();
    }
  });

  it('CONTROL: successful initial playback keeps the overlay hidden and enables controls', async () => {
    const f = fixture();
    try {
      f.clickStart();
      expect(f.context.centerPlay.style.display).toBe('none');
      await flush();
      expect(f.context.isPlaying).toBe(true);
      expect(f.context.controls.style.display).toBe('');
      expect(f.context.centerPlay.style.display).toBe('none');
      expect(f.context.pauseBtn.disabled).toBe(false);
      expect(f.consoleError).not.toHaveBeenCalled();
      await f.context.toggleStopPlay();
      expect(f.context.isPlaying).toBe(false);
      expect(f.context.transitioning).toBe(false);
      expect(f.context.pauseBtn.disabled).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('does not let an older failed click restore an overlay over a newer playing epoch', async () => {
    const destroy = deferred<void>();
    const f = fixture((player, index) => {
      if (index !== 1) return;
      player.load.mockImplementation(async () => { player.emit(refusal); });
      player.destroy.mockImplementation(() => destroy.promise);
    });
    try {
      f.clickStart();
      await flush();
      expect(f.context.player).toBeNull();
      expect(f.instances[0]!.destroy).toHaveBeenCalledOnce();
      const stopped = f.context.stopPlayback();
      const successor = f.context.startPlayback();
      destroy.resolve();
      await Promise.all([stopped, successor]);
      await flush();
      expect(f.instances).toHaveLength(2);
      expect(f.context.player).toBe(f.instances[1]);
      expect(f.context.isPlaying).toBe(true);
      expect(f.context.centerPlay.style.display).toBe('none');
      expect(f.instances[1]!.destroy).not.toHaveBeenCalled();
    } finally {
      destroy.resolve();
      await f.close();
    }
  });
});
