// Real connection over stream doubles: the publisher's own cancellation after a failed ordinary FETCH FIN.
import { expect, it } from 'vitest';
import { createControlCodec } from '@openmoq/transport';
import { connect } from './testkit/object-reception.js';
import { flush } from './testkit/stream-sim.js';
import type { WebTransportLike } from './types.js';
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(part => parseInt(part, 16)));

for (const draft of [18, 22] as const) it(`draft${draft} failed FETCH FIN remains owned until cancellation`, async () => {
  const { connection: conn, transport } = await connect(draft);
  conn.onError = () => {};
  (transport as WebTransportLike).resetSendStream = async writer => { await writer.abort(); };
  (transport as WebTransportLike).createStreamError = (code, cause) => Object.assign(new Error('cancel', { cause }), { streamErrorCode: code });
  try {
    const request = transport.pushIncomingBidi();
    request.push(createControlCodec(draft).encode({ type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 1, trackNamespace: [bytes('74')], trackName: bytes('76'), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } }, parameters: new Map() }));
    await flush(512);
    await conn.acceptFetch(1n, { endLocation: { group: 9n, object: 0n } });
    const stream = await conn.openFetchStream(1n), pipe = transport.uniOut.at(-1)!;
    pipe.failWrites = true;
    await expect(conn.sendFetchObject(stream, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') })).rejects.toThrow();
    const fin = await conn.closeFetchStream(stream).then(() => 'resolved', () => 'rejected');
    const owned = conn.session.getIncomingFetch(1n) !== undefined;
    await expect(conn.closeFetchStream(stream)).rejects.toBeDefined();
    const abort = (await conn.abortIncomingFetch(1n)).status;
    await flush(512);
    expect({ fin, owned, abort, after: conn.session.getIncomingFetch(1n) === undefined, closed: transport.closeInfo })
      .toEqual({ fin: 'rejected', owned: true, abort: 'aborted', after: true, closed: undefined });
  } finally { await conn.close(); }
});
