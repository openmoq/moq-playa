import { expect, it } from 'vitest';
import type { MoqtObject } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(part => parseInt(part, 16)));

for (const draft of [18, 22] as const) {
  it(`draft${draft} preserves DNE/Unknown range meaning, later Objects, and actual group termination`, async () => {
    for (const [flag, status] of [['810c', 0n], ['808c', 1n]] as const) {
      const conn = new MoqtConnection(draft), transport = new TransportSim();
      const objects: MoqtObject[] = [], errors: Error[] = [];
      conn.onObject = (_stream, object) => objects.push(object);
      conn.onError = error => errors.push(error);
      transport.openIncomingUni().push(bytes('af000000'));
      await conn.connect(transport);
      try {
        await conn.fetch([], bytes('76'), { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n });
        // FETCH_OK: EndOfTrack 0, End Location 2/9, Parameter Count 0.
        transport.bidi[0]!.push(bytes('18000400020900')); await flush(512);
        // Absolute range endpoint 2/3; then implicit next Object 2/4.
        // Only draft18 carries Payload Length 0 on the range marker.
        transport.openIncomingUni().push(bytes('0500' + flag + '0203' + (draft === 18 ? '00' : '') + '13000701aa'));
        await flush(512);
        expect(objects).toEqual([
          expect.objectContaining({ kind: 'gap', groupId: 2n, objectId: 3n, status }),
          expect.objectContaining({ kind: 'data', groupId: 2n, objectId: 4n, payload: bytes('aa') }),
        ]);
        await conn.subscribe([], bytes('77'));
        transport.bidi[1]!.push(bytes('0400022a00')); await flush(512);
        transport.openIncomingUni().push(bytes('182a02070001bb')).closeReadable(); await flush(512);
        expect(objects.slice(-2)).toEqual([
          expect.objectContaining({ kind: 'data', groupId: 2n, objectId: 0n, payload: bytes('bb') }),
          expect.objectContaining({ kind: 'gap', groupId: 2n, objectId: 1n, status: 3n }),
        ]);
        expect(errors).toEqual([]); expect(transport.closeInfo).toBeUndefined();
      } finally { await conn.close(); }
    }
  });
}
