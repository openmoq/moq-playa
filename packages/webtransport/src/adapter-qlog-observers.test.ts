import { describe, expect, it, vi } from 'vitest';
import { createControlCodec } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';

const namespace = [new TextEncoder().encode('live')];
const name = new TextEncoder().encode('video');
async function establish(conn: MoqtConnection, transport: TransportSim) {
  const pending = conn.connect(transport); await flush(100);
  transport.bidi[0]!.push(createControlCodec(16).encode({ type: 'SERVER_SETUP', parameters: new Map([[2n, [100n]]]) }));
  await pending;
}

describe('additive qlog observers', () => {
  it('observes real protocol events alongside the app and stops after unsubscribe', async () => {
    const conn = new MoqtConnection(16);
    const transport = new TransportSim(), app = vi.fn(), observer = vi.fn();
    conn.onQlogEvent = app;
    const remove = conn.observeQlogEvents(observer);
    try {
      await establish(conn, transport);
      expect(observer.mock.calls.some(([e]) => e.type === 'control_message_parsed' && e.message.type === 'SERVER_SETUP')).toBe(true);
      expect(app.mock.calls.some(([e]) => e.type === 'control_message_parsed' && e.message.type === 'SERVER_SETUP')).toBe(true);
      observer.mockClear(); app.mockClear(); remove(); remove();
      await conn.subscribe(namespace, name);
      expect(observer).not.toHaveBeenCalled();
      expect(app.mock.calls.some(([e]) => e.type === 'control_message_created' && e.message.type === 'SUBSCRIBE')).toBe(true);
    } finally { remove(); await conn.close(); }
  });

  it('keeps assignment and deletion of the app callback independent from observers', async () => {
    const conn = new MoqtConnection(16);
    const transport = new TransportSim(), first = vi.fn(), second = vi.fn(), observer = vi.fn();
    conn.onQlogEvent = first;
    const remove = conn.observeQlogEvents(observer);
    conn.onQlogEvent = second;
    try {
      await establish(conn, transport);
      expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalled(); expect(observer).toHaveBeenCalled();
      second.mockClear(); observer.mockClear(); delete conn.onQlogEvent;
      await conn.subscribe(namespace, name);
      expect(second).not.toHaveBeenCalled(); expect(observer).toHaveBeenCalled();
      observer.mockClear(); remove();
      const clone = vi.spyOn(globalThis, 'structuredClone');
      try { await conn.subscribe(namespace, name); expect(clone).not.toHaveBeenCalled(); }
      finally { clone.mockRestore(); }
      expect(observer).not.toHaveBeenCalled();
    } finally { remove(); await conn.close(); }
  });

  it('isolates mutations from protocol validation, app callbacks and other observers', async () => {
    const conn = new MoqtConnection(16);
    const transport = new TransportSim(), app = vi.fn(), peer = vi.fn();
    conn.onQlogEvent = app;
    const remove = conn.observeQlogEvents(event => {
      if (event.type === 'control_message_parsed' && event.message.type === 'SERVER_SETUP') event.message.parameters.clear();
    });
    const removePeer = conn.observeQlogEvents(peer);
    try {
      await establish(conn, transport);
      for (const calls of [app.mock.calls, peer.mock.calls]) {
        const setup = calls.map(([e]) => e).find(e => e.type === 'control_message_parsed' && e.message.type === 'SERVER_SETUP');
        expect(setup.message.parameters.get(2n)).toEqual([100n]);
      }
      await conn.subscribe(namespace, name);
      await expect(conn.subscribe(namespace, name)).resolves.toBeDefined();
    } finally { remove(); removePeer(); await conn.close(); }
  });

  it('contains synchronous and asynchronous observer failures without censoring the app', async () => {
    const conn = new MoqtConnection(16);
    const transport = new TransportSim(), app = vi.fn(), seen = vi.fn();
    conn.onQlogEvent = app;
    const removers = [conn.observeQlogEvents(() => { seen(); throw new Error('sync observer'); }),
      conn.observeQlogEvents(async () => { throw new Error('async observer'); })];
    try { await establish(conn, transport); await flush(100); expect(seen).toHaveBeenCalled(); expect(app).toHaveBeenCalled(); expect(transport.closeInfo).toBeUndefined(); }
    finally { removers.forEach(remove => remove()); await conn.close(); }
  });

  it('does not call an observer removed reentrantly earlier in the dispatch', async () => {
    const conn = new MoqtConnection(16);
    const transport = new TransportSim(), removed = vi.fn();
    let removePeer = () => {};
    const removeFirst = conn.observeQlogEvents(() => removePeer());
    removePeer = conn.observeQlogEvents(removed);
    try { await establish(conn, transport); expect(removed).not.toHaveBeenCalled(); }
    finally { removeFirst(); removePeer(); await conn.close(); }
  });
});
