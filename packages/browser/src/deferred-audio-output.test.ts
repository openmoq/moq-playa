/**
 * Tests for DeferredAudioOutput — drops audio until activated,
 * then forwards to a real AudioOutputLike.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { DeferredAudioOutput } from './deferred-audio-output.js';
import type { AudioOutputLike } from '@openmoq/player';

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

// Timing capability and ownership are local to the current activated target.
// These tests do not create an AudioContext or bypass gesture activation.
function timingOutput() {
  return { supportsOutputTiming: true as const, schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
    setPlaybackRate: vi.fn(), currentPlayoutTimeUs: 0,
    sampleSourcePosition: vi.fn((_epoch: object): import('@openmoq/player').AudioSourcePosition | null => null) };
}
function producingTiming(): import('@openmoq/player').AudioProducedTiming {
  return { context: { epoch: {}, sourceTimestampUs: 1n, presentFromSourceUs: 2n, recomputeRenderTimeUs: offset => 1000 + offset }, sourceOffsetUs: 0 };
}

describe('DeferredAudioOutput producing timing', () => {
  it('keeps legacy two-argument arity and forwards an optional diagnostic token as a third argument', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), first = { close: vi.fn() }, token = {};
    proxy.activate(real); proxy.schedule(first, 1000);
    expect(real.schedule.mock.calls[0]).toEqual([first, 1000]);
    proxy.schedule(first, 2000, token); expect(real.schedule.mock.calls[1]).toEqual([first, 2000, token]);
    proxy.schedule(first, 3000, undefined, undefined); expect(real.schedule.mock.calls[2]).toEqual([first, 3000]);
  });
  it('exposes no timing property until a capable real target is activated and deletes it for an unsupported target', () => {
    const proxy = new DeferredAudioOutput(); expect(Object.hasOwn(proxy, 'supportsOutputTiming')).toBe(false);
    proxy.activate(timingOutput()); expect(proxy.supportsOutputTiming).toBe(true);
    proxy.activate(createMockOutput()); expect(Object.hasOwn(proxy, 'supportsOutputTiming')).toBe(false);
  });
  it('forwards the exact producing witness and token, including an explicit undefined token slot', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), timing = producingTiming(), token = {}, pcm = { close: vi.fn() };
    proxy.activate(real); proxy.schedule(pcm, 1000, token, timing);
    expect(real.schedule.mock.calls[0]).toEqual([pcm, 1000, token, timing]);
    proxy.schedule(pcm, 2000, undefined, timing); expect(real.schedule.mock.calls[1]).toEqual([pcm, 2000, undefined, timing]);
    expect(pcm.close).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'unsupported', 'disabled'] as const)('closes armed direct scheduling while %s without a legacy fallback', state => {
    const proxy = new DeferredAudioOutput(), real = state === 'unsupported' ? createMockOutput() : timingOutput();
    if (state !== 'inactive') proxy.activate(real); if (state === 'disabled') proxy.enabled = false;
    const pcm = { close: vi.fn() }; proxy.schedule(pcm, 1000, {}, producingTiming());
    expect(pcm.close).toHaveBeenCalledOnce(); expect(real.schedule).not.toHaveBeenCalled();
  });
  it('keeps signed null timing explicit for a capable target that owns its discard', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), pcm = { close: vi.fn() };
    real.schedule.mockImplementation((data: { close(): void }, _time: number, _token: object | undefined, timing: unknown) => { if (timing === null) data.close(); });
    proxy.activate(real); proxy.schedule(pcm, 1000, undefined, null);
    expect(real.schedule.mock.calls[0]).toEqual([pcm, 1000, undefined, null]); expect(pcm.close).toHaveBeenCalledOnce();
  });
  it('forwards the current enabled head with exact epoch and sample identity', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), epoch = {}, sample = { epoch, sourceTimestampUs: 2n ** 70n, sourceOffsetUs: 1.5 };
    expect(proxy.sampleSourcePosition(epoch)).toBeNull(); proxy.activate(real); real.sampleSourcePosition.mockReturnValue(sample);
    expect(proxy.sampleSourcePosition(epoch)).toBe(sample); expect(real.sampleSourcePosition).toHaveBeenCalledExactlyOnceWith(epoch);
    proxy.enabled = false; expect(proxy.sampleSourcePosition(epoch)).toBeNull(); expect(real.sampleSourcePosition).toHaveBeenCalledOnce();
    proxy.enabled = true; expect(proxy.sampleSourcePosition(epoch)).toBe(sample);
  });
  it('does not sample an unsupported target even when it exposes a similarly named method', () => {
    const proxy = new DeferredAudioOutput(), read = vi.fn(() => ({ epoch: {}, sourceTimestampUs: 0n, sourceOffsetUs: 0 }));
    proxy.activate({ ...createMockOutput(), sampleSourcePosition: read }); expect(proxy.sampleSourcePosition({})).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
  it.each(['activate', 'reactivate', 'disable', 'flush', 'destroy'] as const)('refuses a head captured before reentrant %s', action => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), next = timingOutput(), epoch = {};
    const sample = { epoch, sourceTimestampUs: 7n, sourceOffsetUs: 0 }; proxy.activate(real);
    real.sampleSourcePosition.mockImplementationOnce(() => {
      if (action === 'activate') proxy.activate(next);
      if (action === 'reactivate') proxy.activate(real);
      if (action === 'disable') { proxy.enabled = false; proxy.enabled = true; }
      if (action === 'flush') proxy.flush();
      if (action === 'destroy') proxy.destroy();
      return sample;
    });
    expect(proxy.sampleSourcePosition(epoch)).toBeNull();
    if (action !== 'destroy') {
      const current = action === 'activate' ? next : real; current.sampleSourcePosition.mockReturnValue(sample);
      expect(proxy.sampleSourcePosition(epoch)).toBe(sample);
    }
  });
  it('does not invoke a sample function whose getter installs a successor', () => {
    const proxy = new DeferredAudioOutput(), next = timingOutput(), read = vi.fn(() => null);
    proxy.activate({ ...timingOutput(), get sampleSourcePosition() { proxy.activate(next); return read; } });
    expect(proxy.sampleSourcePosition({})).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
  it('keeps a failed native source read unavailable', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput();
    real.sampleSourcePosition.mockImplementation(() => { throw new Error('native unavailable'); }); proxy.activate(real);
    expect(proxy.sampleSourcePosition({})).toBeNull();
  });
  it('detaches before external destroy and preserves a successor installed by that callback', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), next = timingOutput(); proxy.activate(real);
    real.destroy.mockImplementationOnce(() => proxy.activate(next)); proxy.destroy();
    expect(proxy.isActive).toBe(true); expect(proxy.supportsOutputTiming).toBe(true);
    const pcm = { close: vi.fn() }, timing = producingTiming(); proxy.schedule(pcm, 1000, undefined, timing);
    expect(next.schedule.mock.calls[0]).toEqual([pcm, 1000, undefined, timing]); expect(next.destroy).not.toHaveBeenCalled();
  });
  it('destroy clears capability, drops later data and is idempotent, while explicit reactivation remains supported', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(); proxy.activate(real); proxy.destroy(); proxy.destroy();
    expect(real.destroy).toHaveBeenCalledOnce(); expect(proxy.isActive).toBe(false); expect(Object.hasOwn(proxy, 'supportsOutputTiming')).toBe(false);
    const pcm = { close: vi.fn() }; proxy.schedule(pcm, 1000, {}, producingTiming()); expect(pcm.close).toHaveBeenCalledOnce();
    expect(proxy.sampleSourcePosition({})).toBeNull(); proxy.activate(timingOutput()); expect(proxy.isActive).toBe(true);
  });
  it('cannot overwrite capability after a pending-rate callback activates an unsupported successor', () => {
    const proxy = new DeferredAudioOutput(), real = timingOutput(), next = createMockOutput(); proxy.setPlaybackRate(1.1);
    real.setPlaybackRate.mockImplementationOnce(() => proxy.activate(next)); proxy.activate(real);
    expect(Object.hasOwn(proxy, 'supportsOutputTiming')).toBe(false); const pcm = { close: vi.fn() };
    proxy.schedule(pcm, 1000, undefined, producingTiming()); expect(pcm.close).toHaveBeenCalledOnce(); expect(real.schedule).not.toHaveBeenCalled();
  });
  it('drops rather than forwarding to a target replaced while its timing capability is read', () => {
    const proxy = new DeferredAudioOutput(), base = timingOutput(), next = timingOutput(); let replace = false;
    const real = { ...base, get supportsOutputTiming(): true { if (replace) proxy.activate(next); return true; } };
    proxy.activate(real); replace = true; const pcm = { close: vi.fn() }; proxy.schedule(pcm, 1000, undefined, producingTiming());
    expect(pcm.close).toHaveBeenCalledOnce(); expect(base.schedule).not.toHaveBeenCalled(); expect(next.schedule).not.toHaveBeenCalled();
  });
});
