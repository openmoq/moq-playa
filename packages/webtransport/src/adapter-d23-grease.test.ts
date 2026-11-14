import { expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createControlCodec } from '@openmoq/transport';

// Deterministic stream simulation through the real adapter and codecs.
for (const draft of [18, 22, 23] as const) {
  for (const context of ['fetch', 'subscribe', 'status', 'publish'] as const) {
    it(`draft ${draft} ${context} classifies grease by draft`, async () => {
      const conn = new MoqtConnection(draft), transport = new TransportSim();
      const codec = createControlCodec(draft), messages: string[] = [], errors: Error[] = [];
      let publishes = 0;
      conn.onPublish = () => { publishes++; };
      conn.onMessage = message => { messages.push(message.type); };
      conn.onError = error => { errors.push(error); };
      transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
      await conn.connect(transport);
      const props = new Map([[0x401dn, [new Uint8Array()]]]);
      const name = new Uint8Array([0x76]);
      try {
        if (context === 'publish') {
          transport.pushIncomingBidi().push(codec.encode({ type: 'PUBLISH', requestId: 1n,
            trackNamespace: [], trackName: name, trackAlias: 16n, parameters: new Map(), trackProperties: props }));
        } else {
          if (context === 'fetch') await conn.fetch([], name, { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n });
          else if (context === 'subscribe') await conn.subscribe([], name);
          else await conn.trackStatus([], name);
          transport.bidi[0]!.push(codec.encode(context === 'fetch'
            ? { type: draft === 23 ? 'REQUEST_OK' : 'FETCH_OK', requestId: 0n, parameters: new Map([[0x09n, [{ group: 9n, object: 0n }]]]),
                endLocation: { group: 9n, object: 0n }, endOfTrack: 0, trackProperties: props }
            : context === 'subscribe'
              ? { type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 16n, parameters: new Map(), trackProperties: props }
              : { type: 'REQUEST_OK', requestId: 0n, parameters: new Map(), trackProperties: props }));
        }
        await flush(512);
        expect(transport.closeInfo).toBeUndefined();
        if (context === 'publish') expect(publishes).toBe(draft === 23 ? 1 : 0);
        else if (draft === 23) {
          expect(messages).toContain(context === 'fetch' ? 'FETCH_OK' : context === 'subscribe' ? 'SUBSCRIBE_OK' : 'REQUEST_OK');
          expect(transport.bidi[0]!.writeAborted).toBe(false);
          expect(errors).toEqual([]);
        } else {
          expect(messages).toEqual([]);
          if (context === 'status') expect(transport.bidi[0]!.readCancelled).toBe(true);
          else expect(transport.bidi[0]!.writeAborted).toBe(true);
        }
      } finally { await conn.close(); }
    });
  }
}
