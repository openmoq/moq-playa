/**
 * TypedEmitter tests — red/green TDD.
 *
 * @module
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { TypedEmitter } from './emitter.js';

afterEach(() => vi.unstubAllGlobals());

/** Test event map. */
interface TestEvents {
  ping: { value: number };
  pong: { message: string };
  empty: undefined;
}

describe('TypedEmitter', () => {
  it('calls registered listener on emit', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn = vi.fn();
    emitter.on('ping', fn);
    emitter.emit('ping', { value: 42 });
    expect(fn).toHaveBeenCalledWith({ value: 42 });
  });

  it('supports multiple listeners on the same event', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('ping', fn1);
    emitter.on('ping', fn2);
    emitter.emit('ping', { value: 1 });
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('does not call listeners for other events', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn = vi.fn();
    emitter.on('ping', fn);
    emitter.emit('pong', { message: 'hello' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('off() removes a specific listener', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn = vi.fn();
    emitter.on('ping', fn);
    emitter.off('ping', fn);
    emitter.emit('ping', { value: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('on() returns an unsubscribe function', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn = vi.fn();
    const unsub = emitter.on('ping', fn);
    unsub();
    emitter.emit('ping', { value: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('removeAllListeners() clears all events', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    emitter.on('ping', fn1);
    emitter.on('pong', fn2);
    emitter.removeAllListeners();
    emitter.emit('ping', { value: 1 });
    emitter.emit('pong', { message: 'hi' });
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('emit with no listeners does not throw', () => {
    const emitter = new TypedEmitter<TestEvents>();
    expect(() => emitter.emit('ping', { value: 1 })).not.toThrow();
  });

  it('handles undefined event data', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const fn = vi.fn();
    emitter.on('empty', fn);
    emitter.emit('empty', undefined);
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  describe('emitIsolated', () => {
    it('delivers to every listener even when one throws, then rethrows the first', () => {
      const emitter = new TypedEmitter<{ evt: number }>();
      const seen: string[] = [];
      emitter.on('evt', () => { seen.push('a'); });
      emitter.on('evt', () => { seen.push('b'); throw new Error('b exploded'); });
      emitter.on('evt', () => { seen.push('c'); throw new Error('c exploded'); });
      emitter.on('evt', () => { seen.push('d'); });

      let thrown: unknown;
      try { emitter.emitIsolated('evt', 1); } catch (err) { thrown = err; }

      expect(seen).toEqual(['a', 'b', 'c', 'd']); // nobody was censored
      expect((thrown as Error).message).toBe('b exploded'); // FIRST failure wins
    });

    it('does not throw when no listener fails', () => {
      const emitter = new TypedEmitter<{ evt: number }>();
      const fn = vi.fn();
      emitter.on('evt', fn);
      expect(() => emitter.emitIsolated('evt', 7)).not.toThrow();
      expect(fn).toHaveBeenCalledWith(7);
    });

    it('is a no-op with no listeners', () => {
      const emitter = new TypedEmitter<{ evt: number }>();
      expect(() => emitter.emitIsolated('evt', 1)).not.toThrow();
    });
  });

  describe('emitReported', () => {
  it('delivers listeners synchronously while reporting the exact original value', () => {
    const emitter = new TypedEmitter<{ notice: number }>(), seen: string[] = [], failure = {};
    const report = vi.fn(() => { seen.push('reported'); }); vi.stubGlobal('reportError', report);
    emitter.on('notice', () => { seen.push('first'); throw failure; });
    emitter.on('notice', () => { seen.push('second'); });
    emitter.emitReported('notice', 1); seen.push('returned');
    expect(seen).toEqual(['first', 'reported', 'second', 'returned']);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('fences the old event if acquiring the host reporter replaces its event set', () => {
    const emitter = new TypedEmitter<{ notice: number }>(), stale = vi.fn(), fresh = vi.fn(), report = vi.fn();
    const failure = Error('application');
    vi.stubGlobal('reportError', undefined);
    Object.defineProperty(globalThis, 'reportError', { configurable: true, get() {
      emitter.removeAllListeners(); emitter.on('notice', fresh); return report;
    } });
    emitter.on('notice', () => { throw failure; }); emitter.on('notice', stale);
    emitter.emitReported('notice', 1);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(stale).not.toHaveBeenCalled(); expect(fresh).not.toHaveBeenCalled();
    emitter.emitReported('notice', 2); expect(fresh).toHaveBeenCalledExactlyOnceWith(2);
  });


    it.each([new Error('listener failed'), null, undefined])('reports the original failure and continues current listeners: %s', failure => {
      const emitter = new TypedEmitter<TestEvents>(), report = vi.fn(), healthy = vi.fn();
      vi.stubGlobal('reportError', report);
      emitter.on('ping', () => { throw failure; }); emitter.on('ping', healthy);
      expect(() => emitter.emitReported('ping', { value: 7 })).not.toThrow();
      expect(report).toHaveBeenCalledExactlyOnceWith(failure); expect(healthy).toHaveBeenCalledExactlyOnceWith({ value: 7 });
    });

    it.each(['missing', 'throws'] as const)('surfaces the original failure in a microtask when the host reporter %s', mode => {
      const emitter = new TypedEmitter<TestEvents>(), tasks: Array<() => void> = [], failure = new Error('original listener failure'), healthy = vi.fn();
      vi.stubGlobal('reportError', mode === 'missing' ? undefined : () => { throw new Error('replaced reporter failed'); });
      vi.stubGlobal('queueMicrotask', (task: () => void) => { tasks.push(task); });
      emitter.on('ping', () => { throw failure; }); emitter.on('ping', healthy);
      expect(() => emitter.emitReported('ping', { value: 1 })).not.toThrow();
      expect(healthy).toHaveBeenCalledOnce(); expect(tasks).toHaveLength(1);
      let surfaced: unknown; try { tasks[0]!(); } catch (error) { surfaced = error; }
      expect(surfaced).toBe(failure);
    });

    it('does not deliver the old event to removed or replacement listeners after error reporting reenters', () => {
      const emitter = new TypedEmitter<TestEvents>(), old = vi.fn(), fresh = vi.fn();
      vi.stubGlobal('reportError', () => { emitter.removeAllListeners(); emitter.on('ping', fresh); });
      emitter.on('ping', () => { throw new Error('listener failed'); }); emitter.on('ping', old);
      emitter.emitReported('ping', { value: 1 });
      expect(old).not.toHaveBeenCalled(); expect(fresh).not.toHaveBeenCalled();
      emitter.emitReported('ping', { value: 2 }); expect(fresh).toHaveBeenCalledExactlyOnceWith({ value: 2 });
    });

    it('uses current membership and snapshots additions for this notification', () => {
      const emitter = new TypedEmitter<TestEvents>(), removed = vi.fn(), added = vi.fn();
      emitter.on('ping', () => { emitter.off('ping', removed); emitter.on('ping', added); }); emitter.on('ping', removed);
      emitter.emitReported('ping', { value: 1 });
      expect(removed).not.toHaveBeenCalled(); expect(added).not.toHaveBeenCalled();
      emitter.emitReported('ping', { value: 2 }); expect(added).toHaveBeenCalledExactlyOnceWith({ value: 2 });
    });
  });
});
