import { expect, it, vi } from 'vitest';
import { createControlCodec } from '@openmoq/transport';
import { connect, object, streamHeader } from './testkit/object-reception.js';
import { ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22] as const) {
  for (const failure of ['acceptance-write', 'peer-reset', 'close', 'expire'] as const) {
    it(`draft${draft} ${failure} settles pending publication bytes`, async () => {
      const { connection: conn, transport } = await connect(draft);
      const codec = createControlCodec(draft);
      const delivered: bigint[] = [];
      conn.onPublish = pub => { pub.onObject = o => delivered.push(o.objectId); };
      if (failure === 'expire') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const data = transport.openIncomingUni();
        data.push(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
        data.push(object(draft, 2n, new Uint8Array([1, 2, 3]), null)); await flush(128);
        const request = transport.pushIncomingBidi();
        request.push(codec.encode({ type: 'PUBLISH', requestId: 1n, trackAlias: 41n,
          trackNamespace: ns('failure'), trackName: nm('video'), parameters: new Map(), trackProperties: new Map() }));
        await flush(128);
        data.push(object(draft, 3n, new Uint8Array([4]), 2n)); await flush(128);
        expect(delivered).toEqual([]);
        if (failure === 'acceptance-write') {
          request.failWrites = true;
          await expect(conn.acceptSubscribe(1n, 41n)).rejects.toThrow('simulated write failure');
        } else if (failure === 'peer-reset') request.resetReadableWithCode(0);
        else if (failure === 'close') await conn.close();
        else await vi.advanceTimersByTimeAsync(10001);
        await flush(128);
        if (failure === 'expire') await vi.advanceTimersByTimeAsync(0);
        else await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(delivered).toEqual(failure === 'expire' ? [2n, 3n] : []);
        expect(data.readCancelled).toBe(failure !== 'expire');
      } finally { vi.useRealTimers(); await conn.close(); }
    });
  }
}
