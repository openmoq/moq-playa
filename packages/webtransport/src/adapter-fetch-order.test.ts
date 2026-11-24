import { expect, it } from 'vitest';
import { createControlCodec } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';

// Deterministic stream simulation through the connection and wire codecs.
for (const draft of [14, 16, 18, 22, 23] as const) {
  for (const outcome of ['invalid', 'equal', 'later', 'whole-group', 'cancelled'] as const) {
    if (outcome === 'whole-group' && draft > 18) continue;
    it(`draft ${draft} validates ${outcome} FETCH_OK before application cancellation`, async () => {
      const connection = new MoqtConnection(draft), transport = new TransportSim();
      const codec = createControlCodec(draft), seen: string[] = [];
      let parsed = 0;
      connection.onQlogEvent = event => {
        if (event.type === 'control_message_parsed' && event.message.type === 'FETCH_OK') parsed++;
      };
      let releaseCancel = () => {}, cancellingRead = false;
      if (outcome === 'cancelled' && draft >= 18) {
        // Hold STOP_SENDING while already-in-flight response bytes reach the reader.
        const stopped = new Promise<void>(resolve => { releaseCancel = resolve; });
        const open = transport.createBidirectionalStream.bind(transport);
        transport.createBidirectionalStream = async () => {
          const stream = await open(), getReader = stream.readable.getReader.bind(stream.readable);
          Object.defineProperty(stream.readable, 'getReader', { value: () => {
            const reader = getReader(), cancel = reader.cancel.bind(reader);
            reader.cancel = async reason => { cancellingRead = true; await stopped; await cancel(reason); };
            return reader;
          } });
          return stream;
        };
      }
      if (draft >= 18) transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
      const connecting = connection.connect(transport);
      if (draft < 18) {
        await flush(64);
        transport.bidi[0]!.push(codec.encode({ type: 'SERVER_SETUP',
          parameters: new Map([[2n, [100n]]]) }));
      }
      await connecting;
      try {
        const id = await connection.fetch([new Uint8Array([97])], new Uint8Array([118]), {
          startGroup: 5n, startObject: 2n, endGroup: 9n, endObject: 0n,
        });
        connection.onMessage = message => {
          if (message.type === 'FETCH_OK') { seen.push(message.type); void connection.fetchCancel(id); }
        };
        const cancellation = outcome === 'cancelled' ? connection.fetchCancel(id) : undefined;
        if (cancellation) {
          await flush(64);
          expect(connection.session.isCancelledRequest(id)).toBe(true);
          if (draft >= 18) expect(cancellingRead).toBe(true);
        }
        const endLocation = { group: outcome === 'invalid' || outcome === 'cancelled' ? 4n : outcome === 'later' ? 6n : 5n,
          object: outcome === 'whole-group' ? 0n : 2n };
        transport.bidi[0]!.push(codec.encode({
          type: draft === 23 ? 'REQUEST_OK' : 'FETCH_OK', requestId: id,
          endOfTrack: 0, endLocation, parameters: draft === 23 ? new Map([[9n, [endLocation]]]) : new Map(),
          trackProperties: new Map(), trackExtensions: new Map(),
        }));
        await flush(512);
        if (outcome === 'cancelled') expect(parsed).toBe(1);
        releaseCancel(); await cancellation;
        expect(seen).toEqual(outcome === 'invalid' || outcome === 'cancelled' ? [] : ['FETCH_OK']);
        if (outcome === 'invalid') expect(transport.closeInfo?.closeCode).toBe(0x03);
        else expect(transport.closeInfo).toBeUndefined();
      } finally { releaseCancel(); await connection.close(); }
    });
  }
}
