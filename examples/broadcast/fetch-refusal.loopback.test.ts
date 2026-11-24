import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RequestError, RequestError18, RequestError22, RequestError23, varint, type ControlMessage } from '@openmoq/transport';
import { connectedPair, ns, nm } from '../../packages/webtransport/src/testkit/pair.js';
import { flush } from '../../packages/webtransport/src/testkit/loopback.js';
import { BroadcastSession } from './broadcast-session.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Real connections and codecs over deterministic in-memory streams.
it.each([14, 16, 18, 22, 23] as const)('draft %i refuses FETCH without interrupting subscriptions', async draft => {
  const { client, server, errors } = await connectedPair(draft);
  const session = new BroadcastSession(server, {
    catalog: { videoCodec: 'avc1.42001f', width: 640, height: 360, fps: 30, videoBitrate: 500_000 },
    publisher: { draft, wrapInt: varint }, log: () => {},
  });
  server.onFetch = session.handleFetch?.bind(session);
  server.onSubscribe = (id, _namespace, name) => session.handleSubscribe(id, new TextDecoder().decode(name));
  const responses: ControlMessage[] = [], received: number[] = [];
  client.onMessage = message => { if (message.type === 'REQUEST_ERROR') responses.push(message); };
  try {
    const video = await client.subscribeTrack(ns('live'), nm('video'), { onObject: object => {
      if (object.kind === 'data') received.push(object.payload[0]!);
    } });
    await flush(128);
    session.publisher.publishVideo(Uint8Array.of(1), { isKeyframe: true, timestampUs: 1 });
    await session.publisher.drain(); await flush(128);
    expect(received).toEqual([1]);
    for (const name of ['video', 'missing']) {
      const id = await client.fetch(ns('live'), nm(name), { startGroup: 0n, startObject: 0n, endGroup: 1n, endObject: 0n });
      await flush(256);
      const code = ({ 14: RequestError, 16: RequestError, 18: RequestError18, 22: RequestError22, 23: RequestError23 })[draft].NOT_SUPPORTED;
      expect(responses.at(-1)).toMatchObject({ type: 'REQUEST_ERROR', requestId: id, errorCode: code });
      expect(server.session.getIncomingFetch(id)).toBeUndefined();
    }
    expect(responses).toHaveLength(2);
    session.publisher.publishVideo(Uint8Array.of(2), { isKeyframe: true, timestampUs: 2 });
    await session.publisher.drain(); await flush(128);
    expect(received).toEqual([1, 2]);
    expect(client.session.getSubscription(video.requestId)).toBeDefined();
    expect(client.session.state).toBe('established');
    expect(errors).toEqual([]);
  } finally { await session.shutdown(); await client.close(); }
});
