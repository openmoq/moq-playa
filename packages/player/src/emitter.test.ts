/**
 * TypedEmitter tests — red/green TDD.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { TypedEmitter } from './emitter.js';

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
});
