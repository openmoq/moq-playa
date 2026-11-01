import { describe, expect, it, vi } from 'vitest';
import { createControlCodec } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createLoopback } from './testkit/loopback.js';

describe('legacy setup qlog observations', () => {
  it.each([14, 16] as const)('observes both peer setup messages exactly once in draft %i', async draft => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft);
    const server = new MoqtConnection(draft, { role: 'server' });
    const clientParsed: string[] = [], serverParsed: string[] = [];
    client.onQlogEvent = event => { if (event.type === 'control_message_parsed') clientParsed.push(event.message.type); };
    server.onQlogEvent = event => { if (event.type === 'control_message_parsed') serverParsed.push(event.message.type); };
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      expect(clientParsed).toEqual(['SERVER_SETUP']);
      expect(serverParsed).toEqual(['CLIENT_SETUP']);
    } finally { await client.close(); await server.close(); }
  });

  it('emits the actually parsed SERVER_SETUP exactly once', async () => {
    const conn = new MoqtConnection(16); const transport = new TransportSim();
    const parsed: string[] = [];
    conn.onQlogEvent = event => { if (event.type === 'control_message_parsed') parsed.push(event.message.type); };
    const connecting = conn.connect(transport); await flush(100);
    transport.bidi[0]!.push(createControlCodec(16).encode({ type: 'SERVER_SETUP', parameters: new Map() }));
    await connecting; expect(parsed).toEqual(['SERVER_SETUP']); await conn.close();
  });

  it('keeps a throwing setup observer from breaking protocol setup', async () => {
    const conn = new MoqtConnection(16); const transport = new TransportSim();
    const observed = vi.fn();
    conn.onQlogEvent = event => { if (event.type === 'control_message_parsed') { observed(); throw new Error('Observer failed'); } };
    const connecting = conn.connect(transport); await flush(100);
    transport.bidi[0]!.push(createControlCodec(16).encode({ type: 'SERVER_SETUP', parameters: new Map() }));
    await connecting; expect(observed).toHaveBeenCalledOnce(); expect(transport.closeInfo).toBeUndefined(); await conn.close();
  });

  it('does not let an observer mutate the parameters used for setup validation', async () => {
    const conn = new MoqtConnection(16); const transport = new TransportSim();
    conn.onQlogEvent = event => { if (event.type === 'control_message_parsed' && event.message.type === 'SERVER_SETUP') event.message.parameters.clear(); };
    const connecting = conn.connect(transport); await flush(100);
    transport.bidi[0]!.push(createControlCodec(16).encode({ type: 'SERVER_SETUP', parameters: new Map([[2n, [100n]]]) }));
    await connecting;
    const ns = [new TextEncoder().encode('live')];
    await conn.subscribe(ns, new TextEncoder().encode('one'));
    await expect(conn.subscribe(ns, new TextEncoder().encode('two'))).resolves.toBeDefined();
    await conn.close();
  });

  it('honors an observer closing the connection without processing setup on the retired session', async () => {
    const conn = new MoqtConnection(16); const transport = new TransportSim();
    conn.onQlogEvent = event => { if (event.type === 'control_message_parsed') void conn.close().catch(() => {}); };
    const connecting = conn.connect(transport); await flush(100);
    transport.bidi[0]!.push(createControlCodec(16).encode({ type: 'SERVER_SETUP', parameters: new Map() }));
    await expect(connecting).rejects.toThrow(/closed during setup observation/);
    expect(transport.closeInfo).toBeDefined();
  });
});
