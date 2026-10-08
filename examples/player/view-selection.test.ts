import { describe, expect, it, vi } from 'vitest';
import { TeardownBarrier, ViewRetuner, parseVideoAltGroup } from './view-selection.js';

const groups = [{ altGroup: 1 }, { altGroup: 0 }, { altGroup: -1 }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('retained player teardown', () => {
  it('blocks later play after a view teardown timeout until physical destruction finishes', async () => {
    vi.useFakeTimers();
    try {
      const destruction = deferred();
      const barrier = new TeardownBarrier(100);
      const start = vi.fn(async () => { await barrier.wait(); });
      const retuner = new ViewRetuner({ stop: () => barrier.run(() => destruction.promise), start }, 100);
      const changed = expect(retuner.change(0, groups, 1)).rejects.toThrow('teardown timed out');
      await vi.advanceTimersByTimeAsync(100);
      await changed;
      const play = vi.fn(async () => {});
      const retry = expect(barrier.wait().then(play)).rejects.toThrow('teardown timed out');
      await vi.advanceTimersByTimeAsync(100);
      await retry;
      expect(play).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      destruction.resolve();
      await barrier.wait().then(play);
      expect(play).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('keeps a failed destruction fail-closed for later starts', async () => {
    const barrier = new TeardownBarrier();
    await expect(barrier.run(async () => { throw new Error('destroy failed'); })).rejects.toThrow('destroy failed');
    await expect(barrier.wait()).rejects.toThrow('destroy failed');
  });
});

describe('video view query', () => {
  it('preserves omission and signed integer labels', () => {
    expect(parseVideoAltGroup(null)).toBeUndefined();
    expect(parseVideoAltGroup('0')).toBe(0);
    expect(parseVideoAltGroup('-1')).toBe(-1);
  });
  it.each(['', '0.5', 'NaN', 'Infinity', '9007199254740992'])('rejects invalid label %s', value => {
    expect(() => parseVideoAltGroup(value)).toThrow('altGroup');
  });
});

describe('fresh video view tune-in', () => {
  it('finishes teardown before starting the requested view', async () => {
    const stopped = deferred();
    const stop = vi.fn(() => stopped.promise);
    const start = vi.fn(async () => {});
    const retuner = new ViewRetuner({ stop, start });
    const pending = retuner.change(0, groups, 1);
    expect(retuner.busy).toBe(true);
    expect(start).not.toHaveBeenCalled();
    stopped.resolve();
    expect(await pending).toBe(true);
    expect(start).toHaveBeenCalledWith(0, expect.any(AbortSignal));
    expect(retuner.busy).toBe(false);
  });
  it('does nothing for the active view and rejects unknown views without teardown', async () => {
    const stop = vi.fn(async () => {});
    const retuner = new ViewRetuner({ stop, start: vi.fn(async () => {}) });
    expect(await retuner.change(1, groups, 1)).toBe(false);
    await expect(retuner.change(8, groups, 1)).rejects.toThrow('Unknown video altGroup');
    expect(stop).not.toHaveBeenCalled();
  });
  it('does not create overlapping changes', async () => {
    const stopped = deferred();
    const start = vi.fn(async () => {});
    const retuner = new ViewRetuner({ stop: () => stopped.promise, start });
    const pending = retuner.change(0, groups, 1);
    expect(await retuner.change(-1, groups, 1)).toBe(false);
    stopped.resolve();
    await pending;
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('cancels during teardown without starting a replacement', async () => {
    const stopped = deferred();
    const start = vi.fn(async () => {});
    const retuner = new ViewRetuner({ stop: () => stopped.promise, start });
    const pending = retuner.change(0, groups, 1);
    retuner.cancel();
    stopped.resolve();
    expect(await pending).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it('cancels a pending startup, retires it, and ignores its late completion', async () => {
    const started = deferred();
    const stop = vi.fn(async () => {});
    const start = vi.fn((_group: number, _signal: AbortSignal) => started.promise);
    const retuner = new ViewRetuner({ stop, start });
    const pending = retuner.change(0, groups, 1);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const signal = start.mock.calls[0]?.[1] as AbortSignal | undefined;
    retuner.cancel();
    expect(await pending).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    started.resolve();
    expect(retuner.busy).toBe(false);
  });
  it('does not start if teardown fails', async () => {
    const start = vi.fn(async () => {});
    const retuner = new ViewRetuner({ stop: vi.fn(async () => { throw new Error('teardown failed'); }), start });
    await expect(retuner.change(0, groups, 1)).rejects.toThrow('teardown failed');
    expect(start).not.toHaveBeenCalled();
    expect(retuner.busy).toBe(false);
  });
  it('retires a failed startup and permits a later retry', async () => {
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => {}).mockRejectedValueOnce(new Error('startup failed'));
    const retuner = new ViewRetuner({ stop, start });
    await expect(retuner.change(0, groups, 1)).rejects.toThrow('startup failed');
    expect(stop).toHaveBeenCalledTimes(2);
    expect(await retuner.change(0, groups, 1)).toBe(true);
  });
  it('bounds an unsettled teardown and leaves no timer', async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(async () => {});
      const retuner = new ViewRetuner({ stop: () => new Promise(() => {}), start }, 100);
      const pending = expect(retuner.change(0, groups, 1)).rejects.toThrow('teardown timed out');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(start).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('bounds startup, aborts it, and cleans up', async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async () => {});
      let signal: AbortSignal | undefined;
      const retuner = new ViewRetuner({ stop, start: async (_group, s) => {
        signal = s;
        await new Promise(() => {});
      } }, 100);
      const pending = expect(retuner.change(0, groups, 1)).rejects.toThrow('startup timed out');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(stop).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
