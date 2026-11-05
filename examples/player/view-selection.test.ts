import { describe, expect, it, vi } from 'vitest';
import { PlayerErrorCode } from '@openmoq/player';
import type { MediaSelectionSnapshot, MoqtPlayer, PlayerEventMap } from '@openmoq/player';
import { TeardownBarrier, ViewRetuner, parseVideoAltGroup, waitForOutput } from './view-selection.js';

const groups = [1, 0, -1];
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
    await expect(retuner.change(8, groups, 1)).rejects.toThrow('Unknown presentation choice');
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


it('registers teardown before invoking destruction that can reenter the barrier', async () => {
  const barrier = new TeardownBarrier();
  const destruction = deferred();
  let reentrantWait: Promise<void> | undefined;
  let escaped = false;
  const retirement = barrier.run(() => {
    reentrantWait = barrier.wait();
    void reentrantWait.then(() => { escaped = true; });
    return destruction.promise;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(reentrantWait).toBeDefined();
  expect(escaped).toBe(false);
  destruction.resolve();
  await retirement;
  await reentrantWait;
  expect(escaped).toBe(true);
});

function outputPlayer() {
  const listeners = new Map<keyof PlayerEventMap, Set<(event: unknown) => void>>();
  const p = {
    state: 'playing' as MoqtPlayer['state'],
    selection: { revision: 0, scope: null, video: null, audio: null,
      videoAlternatives: [], audioChoices: [], autoQuality: true } as MediaSelectionSnapshot,
    on<K extends keyof PlayerEventMap>(type: K, listener: (event: PlayerEventMap[K]) => void) {
      const members = listeners.get(type) ?? new Set<(event: unknown) => void>();
      listeners.set(type, members);
      members.add(listener as (event: unknown) => void);
      return () => { members.delete(listener as (event: unknown) => void); };
    },
  };
  return { p, count: () => [...listeners.values()].reduce((sum, members) => sum + members.size, 0),
    emit<K extends keyof PlayerEventMap>(type: K, event: PlayerEventMap[K]) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    } };
}
const acceptedAudio: MediaSelectionSnapshot = { revision: 1, scope: { kind: 'render-group', renderGroup: 0 },
  video: null, audio: { name: 'audio', namespaceFields: ['live'] }, videoAlternatives: [], audioChoices: [], autoQuality: true };

describe('fresh presentation startup witness', () => {
  it('requires a real first_frame for video even when playing and audio has already been accepted', async () => {
    const { p, emit, count } = outputPlayer();
    const controller = new AbortController();
    const waiter = waitForOutput(p, controller.signal, () => true, () => true);
    const settled = vi.fn();
    void waiter.promise.then(settled);
    p.selection = acceptedAudio;
    emit('selection_changed', { type: 'selection_changed', selection: p.selection, catalog: null });
    emit('state_changed', { type: 'state_changed', from: 'loading', to: 'playing' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    emit('first_frame', { type: 'first_frame' });
    expect(await waiter.promise).toBe('first-frame');
    waiter.dispose();
    expect(count()).toBe(0);
  });
  it('does not treat an unknown catalog scope as audio-only', async () => {
    const { p, emit } = outputPlayer();
    p.selection = acceptedAudio;
    const controller = new AbortController();
    const waiter = waitForOutput(p, controller.signal, () => undefined, () => true);
    const settled = vi.fn();
    const rejected = expect(waiter.promise).rejects.toThrow('cancelled');
    void waiter.promise.then(settled, () => {});
    emit('state_changed', { type: 'state_changed', from: 'loading', to: 'playing' });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    controller.abort(new Error('cancelled'));
    await rejected;
    waiter.dispose();
  });
  it('labels proven audio-only accepted startup separately from output', async () => {
    const { p, emit, count } = outputPlayer();
    const controller = new AbortController();
    const waiter = waitForOutput(p, controller.signal, () => false, () => true);
    p.selection = acceptedAudio;
    emit('selection_changed', { type: 'selection_changed', selection: p.selection, catalog: null });
    expect(await waiter.promise).toBe('audio-accepted');
    waiter.dispose();
    expect(count()).toBe(0);
  });
  it('rejects fatal startup errors and an already cancelled attempt', async () => {
    const { p, emit, count } = outputPlayer();
    const controller = new AbortController();
    const waiter = waitForOutput(p, controller.signal, () => true, () => true);
    const failed = expect(waiter.promise).rejects.toThrow('decoder failed');
    emit('error', { type: 'error', error: { severity: 'fatal', source: 'decoder', code: PlayerErrorCode.VIDEO_DECODE_ERROR, timestampMs: 0, message: 'decoder failed' } });
    await failed;
    waiter.dispose();
    controller.abort(new Error('cancelled'));
    const cancelled = waitForOutput(p, controller.signal, () => false, () => true);
    await expect(cancelled.promise).rejects.toThrow('cancelled');
    cancelled.dispose();
    expect(count()).toBe(0);
  });
  it('ignores retired async events and removes all listeners on cancellation', async () => {
    const { p, emit, count } = outputPlayer();
    let current = true;
    const controller = new AbortController();
    const waiter = waitForOutput(p, controller.signal, () => false, () => current);
    current = false;
    p.selection = acceptedAudio;
    const settled = vi.fn();
    void waiter.promise.then(settled, () => {});
    const cancelled = expect(waiter.promise).rejects.toThrow('cancelled');
    emit('first_frame', { type: 'first_frame' });
    emit('selection_changed', { type: 'selection_changed', selection: p.selection, catalog: null });
    emit('error', { type: 'error', error: { severity: 'fatal', source: 'decoder', code: PlayerErrorCode.VIDEO_DECODE_ERROR, timestampMs: 0, message: 'stale error' } });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    controller.abort(new Error('cancelled'));
    await cancelled;
    waiter.dispose();
    expect(count()).toBe(0);
  });
  it('retains the 15 second video deadline, cleans up, and permits a fresh retry', async () => {
    vi.useFakeTimers();
    try {
      const { p, emit, count } = outputPlayer();
      p.selection = acceptedAudio;
      const stop = vi.fn(async () => {});
      const start = vi.fn(async (_view: number, signal: AbortSignal) => {
        const waiter = waitForOutput(p, signal, () => true, () => true);
        try { await waiter.promise; } finally { waiter.dispose(); }
      });
      const retuner = new ViewRetuner({ stop, start });
      const failed = expect(retuner.change(0, groups, 1)).rejects.toThrow('startup timed out after 15000ms');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(retuner.busy).toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      expect(stop).toHaveBeenCalledTimes(2);
      expect(retuner.busy).toBe(false);
      expect(count()).toBe(0);
      const retry = retuner.change(0, groups, 1);
      await vi.advanceTimersByTimeAsync(0);
      emit('first_frame', { type: 'first_frame' });
      expect(await retry).toBe(true);
      expect(count()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('carries exact singleton configuration through the same serialized retuner', async () => {
    const stopped = deferred();
    const first = { key: 'one-field', selection: { renderGroup: null, videoTrack: { name: 'main', namespace: ['a/b'] } } };
    const second = { key: 'two-fields', selection: { renderGroup: null, videoTrack: { name: 'main', namespace: ['a', 'b'] } } };
    const start = vi.fn(async (_target: typeof first, _signal: AbortSignal) => {});
    const retuner = new ViewRetuner({ stop: () => stopped.promise, start }, 15_000, (a, b) => a.key === b.key);
    const pending = retuner.change(first, [first, second], second);
    expect(start).not.toHaveBeenCalled();
    expect(await retuner.change(second, [first, second], first)).toBe(false);
    stopped.resolve();
    expect(await pending).toBe(true);
    expect(start.mock.calls[0]![0].selection).toEqual(first.selection);
  });
});
