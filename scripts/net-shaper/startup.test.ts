import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShaper } from './shaper.mjs';

interface SocketRecord {
  closeCalls: number;
  emit(event: string, ...args: unknown[]): boolean;
}
const state = vi.hoisted(() => ({
  sockets: [] as SocketRecord[],
  failCreate: false,
  failBind: 'none' as 'none' | 'throw' | 'event',
  failClose: false,
}));

vi.mock('node:dgram', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    closeCalls = 0;
    bind(_port: number, _host: string, ready: () => void) {
      if (state.failBind === 'throw') throw new Error('bind threw');
      queueMicrotask(() => state.failBind === 'event'
        ? this.emit('error', new Error('bind refused')) : ready());
    }
    close(done: () => void) {
      this.closeCalls++;
      if (state.failClose) throw new Error('socket close refused');
      done();
    }
    address() { return { address: '127.0.0.1', port: 45000 }; }
    setRecvBufferSize() {}
    setSendBufferSize() {}
  }
  return { default: { createSocket() {
    if (state.failCreate) throw new Error('socket creation refused');
    const socket = new Socket();
    state.sockets.push(socket);
    return socket;
  } } };
});

describe('shaper startup resource ownership', () => {
  beforeEach(() => {
    state.sockets = [];
    state.failCreate = false;
    state.failBind = 'none';
    state.failClose = false;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('unwinds the first link when the second direction is invalid', async () => {
    await expect(createShaper({ upstream: '127.0.0.1:9', up: { rateBps: -1 } }))
      .rejects.toThrow('rateBps must be positive');
    expect(state.sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unwinds both links when socket creation throws', async () => {
    state.failCreate = true;
    await expect(createShaper({ upstream: '127.0.0.1:9' })).rejects.toThrow('socket creation refused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['throw', 'event'] as const)('unwinds the socket and both links on bind %s', async mode => {
    state.failBind = mode;
    await expect(createShaper({ upstream: '127.0.0.1:9' })).rejects.toThrow(/bind/);
    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transfers successful acquisition to one idempotent close owner', async () => {
    const shaper = await createShaper({ upstream: '127.0.0.1:9' });
    try {
      expect(vi.getTimerCount()).toBe(2);
      const first = shaper.close();
      expect(shaper.close()).toBe(first);
      await first;
      expect(state.sockets[0]?.closeCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await shaper.close(); }
  });

  it('preserves the acquisition error and cleanup error while releasing both links', async () => {
    state.failBind = 'event';
    state.failClose = true;
    const error: unknown = await createShaper({ upstream: '127.0.0.1:9' }).catch(failure => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected aggregate failure');
    expect(error.cause).toMatchObject({ message: 'bind refused' });
    expect(error.errors).toMatchObject([{ message: 'bind refused' }, { message: 'socket close refused' }]);
    expect(state.sockets[0]?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an invalid first direction before acquiring resources', async () => {
    await expect(createShaper({ upstream: '127.0.0.1:9', down: { delayMs: -1 } }))
      .rejects.toThrow('delayMs');
    expect(state.sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
