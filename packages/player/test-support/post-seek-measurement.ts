import { expect, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { MessageParam, decodeFillParameters, decodeSubscriptionFilter } from '@openmoq/transport';
import type { ObjectReceipt, ObjectReceiptObservation } from '@openmoq/webtransport';
import { locSeekFixture } from './loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { ReceivedPayloadRate } from '../src/received-payload-rate.js';
import type { MoqtPlayer } from '../src/player.js';

// Diagnostic observations; input and owner setup use SDK traffic.
interface Measurements {
  readVideoReceivedRate(): number | null;
  readonly estimatedGopDurationUs: number;
}
export const measurements = (player: MoqtPlayer) => player as unknown as Measurements;
type Receipt = { readonly event: ObjectReceiptObservation; readonly nowUs: number };
export const PAYLOAD_BYTES = 1000;



export function coded(independent: boolean, bytes = PAYLOAD_BYTES) {
  // One valid length-prefixed AVC NAL, retaining the actual wire byte count.
  const payload = new Uint8Array(bytes);
  new DataView(payload.buffer).setUint32(0, bytes - 4);
  payload[4] = independent ? 0x65 : 0x41;
  payload[5] = 0x88;
  return payload;
}
export function properties(draft: 18 | 22, object: bigint, timestamp: bigint) {
  return encodeLocHeaders({ timestamp, timescale: 1000n,
    videoFrameMarking: { independent: object === 0n, startOfFrame: true, endOfFrame: true,
      discardable: false, baseLayerSync: false, temporalId: 0 } },
  { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
}

export async function setup(draft: 18 | 22, options: { inherited?: boolean; objectTransform?: import('../src/config.js').MoqtPlayerConfig['objectTransform'] } = {}, historyStartMs = 3000n) {
  const f = await locSeekFixture(draft, false, true, { producingOutput: true, isLive: true, catalogVersion: '1', ...(options.objectTransform ? { objectTransform: options.objectTransform } : {}),
    timeline: [[1000, [3, 0], 0], [Number(historyStartMs), [4, 0], 0], [Number(historyStartMs + 100n), [4, 1], 0]] });
  let nowUs = 100_000;
  const receipts: Receipt[] = [], streams: bigint[] = [];
  const rawDeliveries: Array<{ kind: 'data' | 'gap'; group: bigint; object: bigint; nowUs: number; receipt: ObjectReceipt | undefined }> = [];
  const subscribeTrack = f.client.subscribeTrack.bind(f.client);
  // Observe the SDK's real per-subscription delivery callback, preserving its
  // options and original callback. It is deliberately NOT an arrival clock.
  const rawObserver = vi.spyOn(f.client, 'subscribeTrack').mockImplementation((namespace, name, options) =>
    subscribeTrack(namespace, name, { ...options, onObject: object => {
      rawDeliveries.push({ kind: object.kind, group: BigInt(object.groupId), object: BigInt(object.objectId), nowUs,
        receipt: f.client.objectReceiptFor(object) });
      options?.onObject?.(object);
    } }));
  const stop = f.client.observeObjectReceipts(event => { if (event.payloadBytes > 0) receipts.push({ event, nowUs }); });
  const observed = vi.spyOn(ReceivedPayloadRate.prototype, 'observe');
  const decodeTimes: Array<{ timestamp: number; nowUs: number }> = [];
  const stopCommands = f.player.on('decoder_command', event => {
    if (event.command.type === 'decode_video') decodeTimes.push({ timestamp: event.command.chunk.timestamp, nowUs });
  });
  const advance = (time: number) => { expect(time).toBeGreaterThanOrEqual(nowUs); nowUs = time; f.setNow(time); };
  const sendHistoryObject = async (stream: bigint, group: bigint, object: bigint, timestamp: bigint) => {
    await f.server.sendFetchObject(stream, { groupId: group, subgroupId: 0n, objectId: object, publisherPriority: 128,
      extensions: properties(draft, object, timestamp), payload: coded(object === 0n) });
    await flush(256);
  };
  const sendLive = async (alias: bigint, group: bigint, object: bigint, timestamp: bigint) => {
    const stream = await f.server.openSubgroup(alias, group, object, { publisherPriority: 128, hasExtensions: true, endOfGroup: true });
    streams.push(stream);
    await f.server.sendObject(stream, object, coded(object === 0n), options.inherited ? encodeLocHeaders({ timestamp, videoFrameMarking: { independent: object === 0n, startOfFrame: true, endOfFrame: true, discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 }) : properties(draft, object, timestamp));
    await f.server.closeSubgroup(stream); await flush(512); f.advance(nowUs); await flush(512);
  };
  async function landHistory(delayed = false) {
    await f.player.seek(2000); await flush(256);
    expect(f.fetches).toEqual([{ namespace: ['live', 'show'], name: 'video', group: 3n, object: 0n }]);
    const requestId = f.fetchIds[0]!;
    await f.server.acceptFetch(requestId, { endOfTrack: 0, endLocation: { group: 4n, object: draft === 22 ? 0n : 1n } });
    const stream = await f.server.openFetchStream(requestId);
    await sendHistoryObject(stream, 3n, 0n, 1000n);
    if (delayed) advance(400_000);
    await sendHistoryObject(stream, 3n, 1n, 2100n);
    await sendHistoryObject(stream, 4n, 0n, historyStartMs);
    if (delayed) advance(800_000);
    await f.server.closeFetchStream(stream); await flush(512);
    expect(f.errors).toEqual([]);
    expect(f.seeked).toHaveBeenCalledOnce(); expect(f.outputs).toHaveLength(1);
    expect(f.outputs[0]!.decoder.configure).toHaveBeenCalledOnce();
    expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
    expect(f.player.playbackPositionMs).toBe(2100);
    const historical = receipts.filter(({ event }) => event.origin === 'fetch' && event.requestId === requestId);
    expect(historical.map(({ event }) => [event.groupId, event.objectId])).toEqual([[3n, 0n], [3n, 1n], [4n, 0n]]);
    const subscriptions = f.requests.filter(request => request.name === 'video');
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.id).not.toBe(subscriptions[0]!.id);
    return subscriptions[1]!;
  }
  async function beginBridge(beforeAck?: () => Promise<void>) {
    const sub = await landHistory();
    const message = f.wire.mock.calls.map(([message]) => message)
      .find(message => message.type === 'SUBSCRIBE' && message.requestId === sub.id);
    if (!message || message.type !== 'SUBSCRIBE') throw new Error('No real continuation SUBSCRIBE');
    const filter = message.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0];
    if (!(filter instanceof Uint8Array)) throw new Error('No encoded live subscription filter');
    expect(decodeSubscriptionFilter(filter, draft)).toEqual({ type: 'LargestObject' });
    expect(sub.namespace).toEqual(['live', 'show']);
    const response = f.a.bidiOut.at(-1)!.in;
    if (beforeAck) response.faults.hold = true;
    const head = { group: 4n, object: 2n }; f.publishHead('video', head);
    await f.server.acceptSubscribe(sub.id, 201n, { parameters: new Map([[MessageParam.LARGEST_OBJECT, [head]]]), ...(options.inherited ? { trackProperties: new Map([[8n, [1000n]]]) } : {}) });
    await flush(512);
    if (beforeAck) {
      expect(f.client.session.getSubscription(sub.id)?.state).toBe('pending');
      await beforeAck();
      advance(800_000); response.releaseHeld(); await flush(512);
      // SDK replay is a host task after its subscribe promise continuation.
      await vi.waitFor(() => expect(rawDeliveries.some(row => row.group === 4n && row.object === 3n)).toBe(true),
        { timeout: 1000, interval: 5 });
    }
    expect(f.client.session.getSubscription(sub.id)?.state).toBe('established');
    let prefix: bigint, prefixRequest: bigint;
    if (draft === 22) {
      expect(f.joins).toEqual([]);
      const raw = message.parameters.get(0x23n)?.[0];
      if (!(raw instanceof Uint8Array)) throw new Error('No real FILL_PARAMETERS');
      expect(decodeFillParameters(raw)).toMatchObject({ filter: { type: 'AbsoluteStart', startGroup: 4n, startObject: 1n } });
      prefixRequest = sub.id; prefix = await f.server.openFillStream(sub.id);
    } else {
      expect(f.joins).toHaveLength(1);
      const join = f.joins[0]!;
      expect(join.message.fetch).toEqual({ fetchType: 3, joiningRequestId: sub.id, joiningStart: 4n });
      const range = f.server.resolveJoiningFetch(join.id);
      expect(range.endLocation).toEqual({ group: 4n, object: 3n });
      await f.server.acceptFetch(join.id, { endOfTrack: 0, endLocation: range.endLocation });
      prefixRequest = join.id; prefix = await f.server.openFetchStream(join.id);
      await sendHistoryObject(prefix, 4n, 0n, 3000n);
    }
    await sendHistoryObject(prefix, 4n, 1n, 3100n);
    await sendHistoryObject(prefix, 4n, 2n, 3200n);
    const prefixReceipts = receipts.filter(({ event }) => event.origin === 'fetch' && event.requestId === prefixRequest);
    expect(prefixReceipts.map(({ event }) => event.objectId)).toEqual(draft === 22 ? [1n, 2n] : [0n, 1n, 2n]);
    let finished = false;
    const finish = async () => {
      if (finished) return; finished = true;
      await f.server.closeFetchStream(prefix); await flush(512);
    };
    return { sub, prefix, prefixRequest, finish };
  }
  async function readyLive() {
    const bridge = await beginBridge();
    await bridge.finish();
    await sendLive(201n, 4n, 3n, 3300n);
    expect(decodeTimes.some(row => row.timestamp === 3_300_000), 'real suffix reached the same decoder').toBe(true);
    expect(f.outputs).toHaveLength(1); expect(f.seeked).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
    return bridge;
  }
  return { f, receipts, rawDeliveries, observed, decodeTimes, advance, sendLive, landHistory, beginBridge, readyLive,
    now: () => nowUs,
    samples: () => observed.mock.calls.map(([bytes, now]) => [bytes, now]),
    close: async () => { stop(); stopCommands(); observed.mockRestore(); rawObserver.mockRestore();
      for (const stream of streams) await f.server.closeSubgroup(stream); await f.destroy(); },
  };
}
