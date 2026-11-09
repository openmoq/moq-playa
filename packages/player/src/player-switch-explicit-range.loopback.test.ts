/** Public selection and real SDK wire identity only; no native playback claim. */
import { describe, expect, it } from 'vitest';
import { MessageParam, decodeSubscriptionFilter, locationEncodingLength, varint, writeLocation } from '@openmoq/transport';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { liveLocFixture } from '../test-support/live-loc.js';

describe.each([14, 16, 18, 22] as const)('explicit switch range, draft %s', draft => {
  it('preserves the caller range and does not add automatic history retrieval', async () => {
    const f = await liveLocFixture({
      subscriptionFilter: { type: 'AbsoluteRange', startGroup: 4, startObject: 0, endGroup: 5 },
    }, draft);
    const fetches: Array<{ requestId: bigint; joiningRequestId: bigint | undefined }> = [];
    f.server.onFetch = (requestId, message) => {
      const request = message.fetch;
      fetches.push({ requestId, joiningRequestId: request.fetchType === 1 ? undefined : request.joiningRequestId });
    };
    const readFilter = (request: typeof f.requests[number]) => {
      const bytes = request.parameters?.get(MessageParam.SUBSCRIPTION_FILTER)?.[0];
      if (!(bytes instanceof Uint8Array)) throw new Error('Expected encoded subscription filter');
      return decodeSubscriptionFilter(bytes, draft);
    };
    const expected = { type: 'AbsoluteRange', startGroup: 4n, startObject: 0n, endGroup: 5n };
    try {
      // Establish the ordinary pipeline within the caller's admitted range.
      expect(readFilter(f.requestOf('v')!)).toEqual(expected);
      f.player.play();
      await f.send('v', 4n, 0n);
      await f.send('v', 4n, 1n);
      f.tick(2);
      await flush(256);
      expect(f.currentVideoGroup()).toBe(4n);

      const selecting = f.player.selectVideoTrack('v2');
      void selecting.catch(() => {});
      await flush(256);
      const target = f.requestOf('v2');
      expect(target, 'target request was emitted through the SDK').toBeDefined();
      expect.soft(readFilter(target!), 'wire filter retains the caller AbsoluteRange').toEqual(expected);
      expect.soft(target!.parameters?.has(0x23n), 'explicit range does not opt into fill retrieval').not.toBe(true);

      // A later publisher head must not turn caller-bounded subscription intent
      // into an implicit historical request. No history response is fabricated.
      const largest = { group: varint(7n), object: varint(1n) };
      const legacyLargest = draft === 14 || draft === 16 ? new Uint8Array(locationEncodingLength(largest)) : undefined;
      if (legacyLargest) writeLocation(largest, legacyLargest, 0);
      await f.server.acceptSubscribe(target!.id, 79n, {
        parameters: new Map([[MessageParam.LARGEST_OBJECT, [legacyLargest ?? largest]]]),
      });
      await flush(256);
      expect.soft(fetches.filter(request => request.joiningRequestId === target!.id),
        'explicit range does not opt into Joining FETCH').toEqual([]);
      expect.soft(fetches, 'selection emits no automatic FETCH').toEqual([]);
    } finally {
      await f.close();
    }
  });
});
