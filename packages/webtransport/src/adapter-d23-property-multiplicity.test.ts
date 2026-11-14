import { expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createControlCodec } from '@openmoq/transport';

// Inject peer bytes: the local sender also refuses malformed supported properties.
for (const draft of [18, 22, 23] as const) for (const type of [0x0en, 0x42n]) {
  it(`draft ${draft} repeated ${type.toString(16)} respects supported multiplicity`, async () => {
    const conn = new MoqtConnection(draft), transport = new TransportSim(), codec = createControlCodec(draft);
    const messages: string[] = [];
    conn.onMessage = message => { messages.push(message.type); };
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    await conn.connect(transport);
    try {
      await conn.subscribe([], new Uint8Array([1]));
      transport.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 7n,
        parameters: new Map(), trackProperties: new Map([[type, [1n, 2n]]]) }));
      await flush(512);
      const malformed = draft === 23 && type === 0x0en;
      expect(transport.bidi[0]!.writeAborted).toBe(malformed);
      expect(messages).toEqual(malformed ? [] : ['SUBSCRIBE_OK']);
      // A malformed track leaves an unrelated request usable.
      const id = await conn.subscribe([], new Uint8Array([2]));
      transport.bidi[1]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: 8n, parameters: new Map() }));
      await flush(512);
      expect(messages.at(-1)).toBe('SUBSCRIBE_OK');
      expect(transport.bidi[1]!.writeAborted).toBe(false);
      expect(transport.closeInfo).toBeUndefined();
    } finally { await conn.close(); }
  });
}
