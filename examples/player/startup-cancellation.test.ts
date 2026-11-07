import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture, deferred, flush } from './startup-lifecycle-support.js';

beforeEach(() => vi.useFakeTimers({ toFake: [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'performance',
  'Date'
  ] }));
afterEach(() => vi.useRealTimers());
it('settles same-epoch output cancellation without awaiting an ignored load and never plays late', async () => {
  const load = deferred<void>(), f = fixture(p => p.load.mockImplementation(() => load.promise));
  const controller = new AbortController();
  let outcome = 'pending';
  const startup = f.context.startPlayback(controller.signal).then(() => {
    outcome = 'resolved';
  }, () => {
    outcome = 'rejected';
  });
  try {
    await flush();
    controller.abort(new Error('view cancelled'));
    await flush();
    expect(outcome).toBe('rejected');
    expect(f.instances[0]!.play).not.toHaveBeenCalled();
    load.resolve();
    await startup;
    await flush();
    expect(f.instances[0]!.play).not.toHaveBeenCalled();
  } finally {
    load.resolve();
    await startup;
    await f.close();
  }
});
it('does not construct or load a player for an already-aborted output owner', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('view cancelled before startup'));
  try {
    await f.context.startPlayback(controller.signal);
    expect(f.instances).toEqual([]);
    expect(f.context.isPlaying).toBe(false);
  } finally {
    await f.close();
  }
});
it('rechecks output cancellation after load before calling play', async () => {
  const controller = new AbortController();
  const f = fixture(p => p.load.mockImplementation(async () => {
    controller.abort(new Error('view cancelled as load completed'));
  }));
  try {
    await expect(f.context.startPlayback(controller.signal)).rejects.toThrow('cancel');
    expect(f.instances[0]!.play).not.toHaveBeenCalled();
    expect(f.context.isPlaying).toBe(false);
    expect(f.instances[0]!.destroy).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it('CONTROL: an active output owner can finish load and first-frame readiness', async () => {
  const load = deferred<void>();
  const f = fixture(p => p.load.mockImplementation(() => load.promise));
  const controller = new AbortController();
  let outcome = 'pending';
  const startup = f.context.startPlayback(controller.signal).then(() => {
    outcome = 'resolved';
  }, () => {
    outcome = 'rejected';
  });
  try {
    await flush();
    expect(outcome).toBe('pending');
    load.resolve();
    await flush();
    for (const listener of f.instances[0]!.listeners.get('first_frame') ?? []) {
      listener({ type: 'first_frame' });
    }
    await startup;
    expect(outcome).toBe('resolved');
    expect(f.instances[0]!.play).toHaveBeenCalledOnce();
    expect(f.context.isPlaying).toBe(true);
    expect(f.instances[0]!.destroy).not.toHaveBeenCalled();
  } finally {
    load.resolve();
    await startup;
    await f.close();
  }
});
it('CONTROL: Stop resolves the retired output owner while its load ignores abort', async () => {
  const load = deferred<void>();
  const f = fixture(p => p.load.mockImplementation(() => load.promise));
  const controller = new AbortController();
  let outcome = 'pending';
  const startup = f.context.startPlayback(controller.signal).then(() => {
    outcome = 'resolved';
  }, () => {
    outcome = 'rejected';
  });
  try {
    await flush();
    await f.context.stopPlayback();
    await flush();
    expect(outcome).toBe('resolved');
    expect(f.context.isPlaying).toBe(false);
    expect(f.instances[0]!.play).not.toHaveBeenCalled();
  } finally {
    load.resolve();
    await startup;
    await f.close();
  }
});
