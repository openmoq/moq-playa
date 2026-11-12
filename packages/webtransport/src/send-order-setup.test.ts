import {expect,it,vi} from 'vitest';
import {createControlCodec,varint} from '@openmoq/transport';
import {MoqtConnection} from './adapter.js';
import {TransportSim,flush} from './testkit/stream-sim.js';
it.each(['supported', 'warning'] as const)('draft16 healthy accepted control reader remains usable with %s hint', async mode => {
  const conn = new MoqtConnection(16, {role: 'server'}), transport = new TransportSim();
  const incoming = transport.pushIncomingBidi();
  const ranks: number[] = [], errors: Error[] = [];
  Object.defineProperty(incoming.writable, 'sendOrder', {
    set(rank: number) { ranks.push(rank); if (mode === 'warning') throw new Error('unsupported setter'); },
  });
  const warnings: unknown[] = [];
  conn.onSchedulingWarning = warning => { warnings.push(warning); throw new Error('observer failure'); };
  conn.onError = error => errors.push(error);
  incoming.push(createControlCodec(16).encode({type: 'CLIENT_SETUP', parameters: new Map()}));
  try {
    await conn.connect(transport);
    expect(incoming.written.length).toBeGreaterThan(0);
    expect(incoming.readCancelled).toBe(false);
    expect(incoming.readable.locked).toBe(true); // Live background control reader owns it.
    expect(ranks).toEqual([1024]);
    expect(warnings).toHaveLength(mode === 'warning' ? 1 : 0);
    if (mode === 'warning') {
      const warning = warnings[0] as {stream: WritableStream<Uint8Array>; requestId: bigint | undefined; error: unknown};
      expect(warning.stream).toBe(incoming.writable);
      expect(warning.requestId).toBeUndefined();
      expect(warning.error).toEqual(new Error('unsupported setter'));
    }
    expect(errors).toEqual([]);
  } finally { await conn.close(); transport.closeIncomingSources(); await flush(128); }
});

it.each(['clean','error'] as const)('draft16 warning-triggered %s close releases accepted control reader', async mode => {
 const conn = new MoqtConnection(16,{role:'server'}), transport = new TransportSim();
 const incoming = transport.pushIncomingBidi();
 Object.defineProperty(incoming.writable,'sendOrder',{set(){throw new Error('unsupported setter');}});
 const close = vi.spyOn(transport,'close').mockImplementation(()=>{});
 let shutdown:Promise<void>|undefined;
 conn.onSchedulingWarning=()=>{shutdown=conn.close(mode==='error'?varint(1n):undefined);};
 incoming.push(createControlCodec(16).encode({type:'CLIENT_SETUP',parameters:new Map()}));
 try {
  await expect(conn.connect(transport)).rejects.toThrow('Control stream retired during scheduling hint');
  await shutdown;await flush(128);
  expect(incoming.readCancelled).toBe(mode==='error');
  expect(incoming.readable.locked).toBe(false);
  expect(incoming.written).toEqual([]);
 } finally {close.mockRestore();transport.close();transport.closeIncomingSources();}
});
