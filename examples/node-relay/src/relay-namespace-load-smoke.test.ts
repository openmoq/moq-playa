import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  createObservation,
  closeClient,
  shutdownTopology,
  stopChild,
  observeUnexpectedChildTermination,
  recordObject,
  recordSubgroupClosed,
  RuntimeFailureMonitor,
  sourcePayload,
  withAbortDeadline,
  withDeadline,
} from './relay-namespace-load-smoke.js';

describe('multi-namespace relay load measurements', () => {
  it('rejects an object carrying another namespace publisher source marker', () => {
    const obs = createObservation(['load', 'stream-1'], 1, 1, 16);

    recordObject(obs, 1, {
      kind: 'data',
      groupId: 0n,
      subgroupId: 1n,
      objectId: 0n,
      payload: sourcePayload(0, 16),
    });

    expect(obs.seen.size).toBe(0);
    expect(obs.malformed).toBe(1);
  });

  it('waits for subgroup FIN after receiving every object', async () => {
    const obs = createObservation(['load', 'stream-0'], 1, 0, 16);
    let completed = false;
    void obs.done.then(() => { completed = true; });

    recordObject(obs, 1, {
      kind: 'data',
      groupId: 0n,
      subgroupId: 0n,
      objectId: 0n,
      payload: sourcePayload(0, 16),
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    recordSubgroupClosed(obs, 1, { groupId: 0n, subgroupId: 0n });
    await obs.done;
    expect(completed).toBe(true);
  });

  it('continues counting a duplicate after the completion barrier', async () => {
    const obs = createObservation(['load', 'stream-0'], 1, 0, 16);
    const value = {
      kind: 'data',
      groupId: 0n,
      subgroupId: 0n,
      objectId: 0n,
      payload: sourcePayload(0, 16),
    } as const;
    recordObject(obs, 1, value);
    recordSubgroupClosed(obs, 1, { groupId: 0n, subgroupId: 0n });
    await obs.done;

    recordObject(obs, 1, value);

    expect(obs.duplicates).toBe(1);
  });

  it('rejects a subgroup FIN carrying another publisher source marker', async () => {
    const obs = createObservation(['load', 'stream-1'], 1, 1, 16);
    obs.sentAt[0] = performance.now();
    recordObject(obs, 1, {
      kind: 'data',
      groupId: 0n,
      subgroupId: 1n,
      objectId: 0n,
      payload: sourcePayload(1, 16),
    });

    recordSubgroupClosed(obs, 1, { groupId: 0n, subgroupId: 0n });
    expect(obs.closedGroups.size).toBe(0);
    expect(obs.malformed).toBe(1);

    recordSubgroupClosed(obs, 1, { groupId: 0n, subgroupId: 1n });
    await obs.done;
  });

  it('bounds a phase that never settles', async () => {
    await expect(withDeadline(new Promise<void>(() => undefined), 5, 'test phase'))
      .rejects.toThrow('timeout: test phase (5ms)');
  });

  it('fails a load run when the exact transport closed promise never settles', async () => {
    const close = vi.fn(async () => undefined);
    await expect(closeClient({ close, transport: { closed: new Promise(() => undefined) } }, 5))
      .rejects.toThrow('shutdown');
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts complete shutdown with one close per client and a clean relay exit', async () => {
    const close = vi.fn(async () => undefined);
    const unsubscribe = vi.fn(async () => undefined);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => { child.emit('exit', 0, null); return true; }),
    });
    await shutdownTopology(
      [{ subscription: { unsubscribe } }],
      [{ close, transport: { closed: Promise.resolve() } }],
      () => stopChild(child as unknown as ChildProcess),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('still closes every client and stops the relay when unsubscribe and close fail', async () => {
    const unsubscribe = vi.fn(async () => { throw new Error('unsubscribe failed'); });
    const first = vi.fn(async () => { throw new Error('close failed'); });
    const second = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    await expect(shutdownTopology(
      [{ subscription: { unsubscribe } }],
      [first, second].map((close) => ({ close, transport: { closed: Promise.resolve() } })),
      stop,
    )).rejects.toThrow('shutdown');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rejects an abnormal relay exit during intentional shutdown', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => { child.emit('exit', 17, null); return true; }),
    });
    await expect(stopChild(child as unknown as ChildProcess)).rejects.toThrow('code=17');
  });

  it('rejects an unexpected clean relay exit during client cleanup', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    let stopping = false;
    const monitor = new RuntimeFailureMonitor();
    monitor.watch(observeUnexpectedChildTermination(child as unknown as ChildProcess, () => stopping),
      'relay process failed');
    const close = vi.fn(async () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });

    await expect(shutdownTopology([], [{ close, transport: { closed: Promise.resolve() } }], async () => {
      stopping = true;
      await stopChild(child as unknown as ChildProcess);
    }, monitor)).rejects.toThrow('relay child exited unexpectedly (code=0, signal=null)');
    expect(close).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('bounds forced relay shutdown and reports that graceful shutdown failed', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal: string) => {
        if (signal === 'SIGKILL') child.emit('exit', null, 'SIGKILL');
        return true;
      }),
    });
    await expect(stopChild(child as unknown as ChildProcess, 5)).rejects.toThrow('timeout');
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('aborts the adopted connection attempt when its deadline expires', async () => {
    let signal: AbortSignal | undefined;

    await expect(withAbortDeadline((value) => {
      signal = value;
      return new Promise<void>(() => undefined);
    }, 5, 'connection setup')).rejects.toThrow('timeout: connection setup (5ms)');

    expect(signal?.aborted).toBe(true);
  });

  it('fails when a watched client terminates after delivery completes', async () => {
    const monitor = new RuntimeFailureMonitor();
    let rejectClient!: (error: Error) => void;
    const clientFailure = new Promise<never>((_, reject) => { rejectClient = reject; });
    monitor.watch(clientFailure, 'load/stream-0 subscriber failed');
    const activePhase = monitor.race(new Promise<void>(() => undefined));

    rejectClient(new Error('protocol error after final FIN'));

    await expect(activePhase).rejects.toThrow(
      'load/stream-0 subscriber failed: protocol error after final FIN',
    );
    expect(monitor.reason?.message).toContain('protocol error after final FIN');
  });

  it('fails when the relay child exits after reporting ready', async () => {
    const child = new EventEmitter() as unknown as Pick<ChildProcess, 'once'>;
    const failure = observeUnexpectedChildTermination(child, () => false);

    (child as unknown as EventEmitter).emit('exit', 17, null);

    await expect(failure).rejects.toThrow(
      'relay child exited unexpectedly (code=17, signal=null)',
    );
  });
});
