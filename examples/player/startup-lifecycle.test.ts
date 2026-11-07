import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, refusal, connectionFailure, wedged, deferred, flush } from './startup-lifecycle-support.js';

beforeEach(() => vi.useFakeTimers({ toFake: [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'performance',
  'Date'
  ] }));
afterEach(() => vi.useRealTimers());
describe('owned example startup failure', () => {
  it('fatal catalog before load continuation rejects without playing or reporting successful startup', async () => {
    const f = fixture(p => {
      p.load.mockImplementation(async () => {
        p.emit(refusal);
      });
    });
    try {
      await expect(f.context.startPlayback()).rejects.toThrow('unroutable');
      expect(f.context.isPlaying).toBe(false);
      expect(f.instances[0]!.play).not.toHaveBeenCalled();
      expect(f.renderers[0]!.start).not.toHaveBeenCalled();
      expect(f.instances[0]!.destroy).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it('fatal event releases startup even when load never settles; its late completion cannot play', async () => {
    const load = deferred<void>(), f = fixture(p => p.load.mockImplementation(() => load.promise));
    let outcome = 'pending';
    const startup = f.context.startPlayback().then(() => {
      outcome = 'resolved';
    }, () => {
      outcome = 'rejected';
    });
    try {
      await flush();
      f.instances[0]!.emit(refusal);
      await flush();
      expect(outcome).toBe('rejected');
      expect(f.context.isPlaying).toBe(false);
      expect(f.instances[0]!.destroy).toHaveBeenCalledOnce();
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

  it('a catalog refusal during reconnect/transitioning ends that attempt without blind retune', async () => {
    const f = fixture((p, i) => {
      if (i === 2)
        p.load.mockImplementation(async () => {
          p.emit(refusal);
          throw new Error('load rejected after refusal');
        });
    });
    try {
      await f.context.startPlayback();
      const reconnect = f.context.reconnect('test incident');
      await flush();
      await vi.advanceTimersByTimeAsync(25000);
      await reconnect;
      expect(f.instances).toHaveLength(2);
      expect(f.context.isPlaying).toBe(false);
      expect(f.context.reconnecting).toBe(false);
      expect(f.logs.filter(x => x === 'Reconnected.')).toEqual([]);
      expect(f.instances[1]!.play).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('a fatal connection during reconnect startup still retries and commits the next healthy attempt', async () => {
    const f = fixture((p, i) => {
      if (i === 2)
        p.load.mockImplementation(async () => {
          p.emit(connectionFailure);
        });
    });
    try {
      await f.context.startPlayback();
      const reconnect = f.context.reconnect('test incident');
      await flush();
      await vi.advanceTimersByTimeAsync(3001);
      await reconnect;
      expect(f.instances).toHaveLength(3);
      expect(f.instances[1]!.play).not.toHaveBeenCalled();
      expect(f.instances[2]!.play).toHaveBeenCalledOnce();
      expect(f.context.isPlaying).toBe(true);
      expect(f.logs.filter(x => x === 'Reconnected.')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('CONTROL: a wedged active media element retains automatic connection-style recovery', async () => {
    const f = fixture();
    try {
      await f.context.startPlayback();
      f.instances[0]!.emit(wedged);
      await flush();
      await vi.advanceTimersByTimeAsync(1001);
      await flush();
      expect(f.instances).toHaveLength(2);
      expect(f.context.isPlaying).toBe(true);
      expect(f.logs).toContain('Reconnected.');
    } finally {
      await f.close();
    }
  });

  it('Stop and a successor own late load completion and late fatal events from the old epoch', async () => {
    const load = deferred<void>(), f = fixture((p, i) => {
      if (i === 1)
        p.load.mockImplementation(() => load.promise);
    });
    const old = f.context.startPlayback();
    try {
      await flush();
      await f.context.stopPlayback();
      await f.context.startPlayback();
      expect(f.instances).toHaveLength(2);
      const current = f.instances[1]!;
      const epoch = f.context.playEpoch;
      f.instances[0]!.emit(refusal);
      load.resolve();
      await old;
      await flush();
      expect(f.context.player).toBe(current);
      expect(f.context.playEpoch).toBe(epoch);
      expect(f.context.isPlaying).toBe(true);
      expect(current.destroy).not.toHaveBeenCalled();
      expect(f.instances[0]!.play).not.toHaveBeenCalled();
    } finally {
      load.resolve();
      await old;
      await f.close();
    }
  });

  it('Stop settles an owned startup locally without waiting for its ignored load promise', async () => {
    const load = deferred<void>(), f = fixture(p => p.load.mockImplementation(() => load.promise));
    let outcome = 'pending';
    const startup = f.context.startPlayback().then(() => {
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

  it('CONTROL: the actual Stop action cancels reconnect backoff without a successor attempt', async () => {
    const f = fixture();
    try {
      await f.context.startPlayback();
      const reconnect = f.context.reconnect('test incident');
      await flush();
      await f.context.toggleStopPlay();
      await vi.advanceTimersByTimeAsync(2000);
      await reconnect;
      expect(f.instances).toHaveLength(1);
      expect(f.context.isPlaying).toBe(false);
      expect(f.context.reconnecting).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('bounded teardown failure cannot convert catalog refusal into automatic retries', async () => {
    const destroy = deferred<void>(), f = fixture((p, i) => {
      if (i === 2) {
        p.load.mockImplementation(async () => {
          p.emit(refusal);
          throw new Error('load rejected');
        });
        p.destroy.mockImplementation(() => destroy.promise);
      }
    });
    try {
      await f.context.startPlayback();
      const reconnect = f.context.reconnect('test incident');
      await flush();
      await vi.advanceTimersByTimeAsync(45000);
      await reconnect;
      expect(f.instances).toHaveLength(2);
      expect(f.context.isPlaying).toBe(false);
      expect(f.context.reconnecting).toBe(false);
      expect(f.instances[1]!.destroy).toHaveBeenCalledOnce();
    } finally {
      destroy.resolve();
      await flush();
      await f.close();
    }
  });

  it('CONTROL: degraded catalog observations preserve an active session without retry or teardown', async () => {
    const f = fixture();
    try {
      await f.context.startPlayback();
      f.instances[0]!.emit({ ...refusal, severity: 'degraded' });
      await flush();
      expect(f.context.isPlaying).toBe(true);
      expect(f.instances).toHaveLength(1);
      expect(f.instances[0]!.destroy).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
