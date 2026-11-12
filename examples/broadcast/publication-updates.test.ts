import { describe, expect, it } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, readLocation, varint, type Parameters } from '@openmoq/transport';
import { createLoopback, flush } from '../../packages/webtransport/src/testkit/loopback.js';
import { BroadcastSession } from './broadcast-session.js';

function largest(parameters: Parameters) {
  const value = parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0];
  return value instanceof Uint8Array ? readLocation(value, 0).value : value;
}
const catalog = { videoCodec: 'avc1.42001f', width: 1280, height: 720, fps: 30, videoBitrate: 2_000_000,
  audio: { sampleRate: 48_000, channels: 1 } };
const text = (s: string) => new TextEncoder().encode(s);

describe.each([16, 18, 22] as const)('broadcast publication metadata draft %i', draft => {
  it('reports known empty then only actual emitted media, independently for audio and video', async () => {
    const { a, b } = createLoopback();
    const viewer = new MoqtConnection(draft), publisher = new MoqtConnection(draft, { role: 'server' });
    const errors: unknown[] = [];
    viewer.onError = publisher.onError = error => errors.push(error);
    const session = new BroadcastSession(publisher, { catalog, publisher: { draft, wrapInt: varint,
      onError: (_where, error) => errors.push(error) }, log: () => {} });
    publisher.onSubscribe = (id, _ns, name) => session.handleSubscribe(id, new TextDecoder().decode(name));
    publisher.onSubscribeClosed = id => session.handleSubscribeClosed(id);
    publisher.onMessage = message => { if (message.type === 'UNSUBSCRIBE') session.handleSubscribeClosed(message.requestId); };
    await Promise.all([viewer.connect(a), publisher.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
    try {
      const received = { video: [] as { group: bigint; object: bigint }[], audio: [] as { group: bigint; object: bigint }[] };
      const video = await viewer.subscribeTrack([text('live')], text('video'), { onObject: object => {
        if (object.kind === 'data') received.video.push({ group: object.groupId, object: object.objectId });
      } });
      const audio = await viewer.subscribeTrack([text('live')], text('audio'), { onObject: object => {
        if (object.kind === 'data') received.audio.push({ group: object.groupId, object: object.objectId });
      } });
      session.publisher.publishVideo(Uint8Array.of(9), { isKeyframe: false, timestampUs: 0 });
      await session.publisher.drain();
      const empty = await viewer.requestUpdateConfirmed(video.requestId, { subscriberPriority: varint(1n), timeoutMs: 1000 });
      expect(largest(empty.parameters)).toBeUndefined();
      expect(received.video).toEqual([]);
      session.publisher.publishVideo(Uint8Array.of(1), { isKeyframe: true, timestampUs: 1 });
      session.publisher.publishVideo(Uint8Array.of(2), { isKeyframe: false, timestampUs: 2 });
      session.publisher.publishAudio(Uint8Array.of(3), { timestampUs: 1 });
      await session.publisher.drain(); await flush(64);
      expect(received.video).toHaveLength(2); expect(received.audio).toHaveLength(1);
      for (const [request, kind] of [[video, 'video'], [audio, 'audio']] as const) {
        const result = await viewer.requestUpdateConfirmed(request.requestId, { subscriberPriority: varint(2n), timeoutMs: 1000 });
        expect(largest(result.parameters)).toEqual(received[kind].at(-1));
      }
      expect(errors).toEqual([]);
    } finally { await session.shutdown(); await viewer.close(); }
  });

  it('reports the actual catalog Object location rather than an empty placeholder', async () => {
    const { a, b } = createLoopback();
    const viewer = new MoqtConnection(draft), publisher = new MoqtConnection(draft, { role: 'server' });
    let published!: () => void;
    const sent = new Promise<void>(resolve => { published = resolve; });
    const session = new BroadcastSession(publisher, { catalog, publisher: { draft, wrapInt: varint }, log: () => {}, onCatalogPublished: published });
    publisher.onSubscribe = (id, _ns, name) => session.handleSubscribe(id, new TextDecoder().decode(name));
    publisher.onSubscribeClosed = id => session.handleSubscribeClosed(id);
    publisher.onMessage = message => { if (message.type === 'UNSUBSCRIBE') session.handleSubscribeClosed(message.requestId); };
    await Promise.all([viewer.connect(a), publisher.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
    try {
      const received: { group: bigint; object: bigint }[] = [];
      const request = await viewer.subscribeTrack([text('live')], text('catalog'), { onObject: object => {
        if (object.kind === 'data') received.push({ group: object.groupId, object: object.objectId });
      } });
      await sent; await flush(64); expect(received).toHaveLength(1);
      const result = await viewer.requestUpdateConfirmed(request.requestId, { subscriberPriority: varint(2n), timeoutMs: 1000 });
      expect(largest(result.parameters)).toEqual(received[0]);
    } finally { await session.shutdown(); await viewer.close(); }
  });
  it('does not advance the source head for a stale held open, and refuses a retired generation', async () => {
    const { a, b } = createLoopback();
    const viewer = new MoqtConnection(draft), publisher = new MoqtConnection(draft, { role: 'server' });
    const session = new BroadcastSession(publisher, { catalog, publisher: { draft, wrapInt: varint }, log: () => {} });
    publisher.onSubscribe = (id, _ns, name) => session.handleSubscribe(id, new TextDecoder().decode(name));
    publisher.onSubscribeClosed = id => session.handleSubscribeClosed(id);
    publisher.onMessage = message => { if (message.type === 'UNSUBSCRIBE') session.handleSubscribeClosed(message.requestId); };
    await Promise.all([viewer.connect(a), publisher.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let opened!: () => void;
    const atOpen = new Promise<void>(resolve => { opened = resolve; });
    const open = publisher.openSubgroup.bind(publisher);
    let first = true;
    publisher.openSubgroup = async (...args) => {
      const id = await open(...args);
      if (first) { first = false; opened(); await gate; }
      return id;
    };
    try {
      const oldObjects: unknown[] = [], newObjects: { group: bigint; object: bigint }[] = [];
      const previous = await viewer.subscribeTrack([text('live')], text('video'), { onObject: object => { if (object.kind === 'data') oldObjects.push(object); } });
      await flush(64);
      session.publisher.publishVideo(Uint8Array.of(1), { isKeyframe: true, timestampUs: 0 });
      await atOpen;
      await previous.unsubscribe(); await flush(64);
      const current = await viewer.subscribeTrack([text('live')], text('video'), { onObject: object => {
        if (object.kind === 'data') newObjects.push({ group: object.groupId, object: object.objectId });
      } });
      const empty = await viewer.requestUpdateConfirmed(current.requestId, { subscriberPriority: varint(1n), timeoutMs: 1000 });
      expect(largest(empty.parameters)).toBeUndefined();
      session.publisher.publishVideo(Uint8Array.of(2), { isKeyframe: true, timestampUs: 1 });
      release(); await session.publisher.drain(); await flush(64);
      expect(oldObjects).toEqual([]); expect(newObjects).toHaveLength(1);
      const head = await viewer.requestUpdateConfirmed(current.requestId, { subscriberPriority: varint(2n), timeoutMs: 1000 });
      expect(largest(head.parameters)).toEqual(newObjects[0]);
      session.handleClose();
      await expect(viewer.requestUpdateConfirmed(current.requestId, { subscriberPriority: varint(3n), timeoutMs: 1000 })).rejects.toMatchObject({ name: 'RequestUpdateError' });
      await flush(64);
      expect(publisher.session.getIncomingSubscription(current.requestId)?.isTerminated ?? true).toBe(true);
    } finally { release(); await session.shutdown(); await viewer.close(); }
  });

});
