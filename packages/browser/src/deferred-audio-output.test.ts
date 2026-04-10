/**
 * Tests for DeferredAudioOutput — drops audio until activated,
 * then forwards to a real AudioOutputLike.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { DeferredAudioOutput } from './deferred-audio-output.js';
import type { AudioOutputLike } from '@moqt/player';

function createMockOutput(): AudioOutputLike & {
  scheduled: Array<{ data: unknown; renderTimeUs: number }>;
} {
  const mock: any = {
    scheduled: [],
    schedule: vi.fn((data: unknown, renderTimeUs: number) => {
      mock.scheduled.push({ data, renderTimeUs });
    }),
    flush: vi.fn(),
    currentPlayoutTimeUs: 0,
    setPlaybackRate: vi.fn(),
    destroy: vi.fn(),
  };
  return mock;
}

describe('DeferredAudioOutput', () => {
  it('drops schedule() calls before activation', () => {
    const deferred = new DeferredAudioOutput();
    // Should not throw — silently drops
    deferred.schedule({ type: 'audio' }, 1_000_000);
    deferred.schedule({ type: 'audio' }, 2_000_000);
    expect(deferred.currentPlayoutTimeUs).toBe(0);
  });

  it('forwards schedule() calls after activation', () => {
    const deferred = new DeferredAudioOutput();
    const real = createMockOutput();

    deferred.activate(real);

    deferred.schedule({ type: 'audio' }, 1_000_000);
    deferred.schedule({ type: 'audio' }, 2_000_000);

    expect(real.scheduled).toHaveLength(2);
    expect(real.scheduled[0]!.renderTimeUs).toBe(1_000_000);
    expect(real.scheduled[1]!.renderTimeUs).toBe(2_000_000);
  });

  it('forwards flush() after activation', () => {
    const deferred = new DeferredAudioOutput();
    const real = createMockOutput();

    deferred.activate(real);
    deferred.flush();

    expect(real.flush).toHaveBeenCalled();
  });

  it('flush() is a no-op before activation', () => {
    const deferred = new DeferredAudioOutput();
    // Should not throw
    deferred.flush();
  });

  it('forwards currentPlayoutTimeUs after activation', () => {
    const deferred = new DeferredAudioOutput();
    expect(deferred.currentPlayoutTimeUs).toBe(0);

    const real = createMockOutput();
    (real as any).currentPlayoutTimeUs = 5_000_000;

    deferred.activate(real);
    expect(deferred.currentPlayoutTimeUs).toBe(5_000_000);
  });

  it('forwards setPlaybackRate() after activation', () => {
    const deferred = new DeferredAudioOutput();
    const real = createMockOutput();

    // Set rate before activation — should be applied on activate
    deferred.setPlaybackRate!(1.05);

    deferred.activate(real);
    expect(real.setPlaybackRate).toHaveBeenCalledWith(1.05);

    // Set rate after activation — forwarded immediately
    deferred.setPlaybackRate!(1.1);
    expect(real.setPlaybackRate).toHaveBeenCalledWith(1.1);
  });

  it('forwards destroy() after activation', () => {
    const deferred = new DeferredAudioOutput();
    const real = createMockOutput();

    deferred.activate(real);
    deferred.destroy();

    expect(real.destroy).toHaveBeenCalled();
  });

  it('destroy() is a no-op before activation', () => {
    const deferred = new DeferredAudioOutput();
    // Should not throw
    deferred.destroy();
  });

  it('isActive reports activation state', () => {
    const deferred = new DeferredAudioOutput();
    expect(deferred.isActive).toBe(false);

    deferred.activate(createMockOutput());
    expect(deferred.isActive).toBe(true);
  });

  it('drops audio when enabled=false after activation (mute)', () => {
    const deferred = new DeferredAudioOutput();
    const real = createMockOutput();
    deferred.activate(real);

    // Enabled — audio forwards
    deferred.schedule({ type: 'a' }, 1_000_000);
    expect(real.scheduled).toHaveLength(1);

    // Disabled — audio dropped
    deferred.enabled = false;
    const closeFn = vi.fn();
    deferred.schedule({ close: closeFn }, 2_000_000);
    expect(real.scheduled).toHaveLength(1); // no new
    expect(closeFn).toHaveBeenCalled(); // AudioData closed

    // Re-enabled — audio forwards again
    deferred.enabled = true;
    deferred.schedule({ type: 'b' }, 3_000_000);
    expect(real.scheduled).toHaveLength(2);
  });

  it('closes AudioData on drop (GPU memory)', () => {
    const deferred = new DeferredAudioOutput();
    const closeFn = vi.fn();
    const data = { close: closeFn };

    deferred.schedule(data, 1_000_000);
    expect(closeFn).toHaveBeenCalled();
  });
});
