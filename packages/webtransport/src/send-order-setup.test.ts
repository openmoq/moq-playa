import {expect,it} from 'vitest';
import {createControlCodec} from '@openmoq/transport';
import {MoqtConnection} from './adapter.js';
import {TransportSim,flush} from './testkit/stream-sim.js';
it.each(['supported', 'warning'] as const)('draft16 healthy accepted control reader remains usable with %s hint', async mode => {
  const conn = new MoqtConnection(16, {role: 'server'}), transport = new TransportSim();
  const incoming = transport.pushIncomingBidi();
  const ranks: number[] = [], errors: Error[] = [];
  Object.defineProperty(incoming.writable, 'sendOrder', {
    set(rank: number) { ranks.push(rank); if (mode === 'warning') throw new Error('unsupported setter'); },
  });
  conn.onError = error => errors.push(error);
  incoming.push(createControlCodec(16).encode({type: 'CLIENT_SETUP', parameters: new Map()}));
  try {
    await conn.connect(transport);
    expect(incoming.written.length).toBeGreaterThan(0);
    expect(incoming.readCancelled).toBe(false);
    expect(incoming.readable.locked).toBe(true); // Live background control reader owns it.
    expect(ranks).toEqual([1024]);
    expect(errors).toEqual([]);
  } finally { await conn.close(); transport.closeIncomingSources(); await flush(128); }
});
