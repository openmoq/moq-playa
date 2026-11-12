import { expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, type PipeFaults } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} denied PUBLISH clears queued bytes without replay`, async () => {
    const faults: PipeFaults = {};
    const f = await connectedPair(draft, { faults: { a: faults } });
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const received: bigint[] = [];
    f.server.onPublish = pub => { pub.onObject = o => received.push(o.groupId); };
    try {
      faults.hold = true;
      if (draft === 16) f.a.bidiOut[0]!.out.faults.hold = true;
      const id = await f.client.publish(ns('denial'), nm('video'), 41n); faults.hold = false;
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      await writer.write(object(draft, 2n, new Uint8Array([1, 2, 3]), null)); await flush(128);
      f.a.bidiOut[0]!.out.releaseHeld(); await flush(128);
      await writer.write(object(draft, 3n, new Uint8Array([4]), 2n)); await flush(128);
      expect(received).toEqual([]);
      await f.server.rejectSubscribe(id, 1n, 'declined'); await flush(128);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(received).toEqual([]);
      expect(f.server.session.state).toBe('established');
    } finally {
      faults.hold = false;
      if (writer) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
