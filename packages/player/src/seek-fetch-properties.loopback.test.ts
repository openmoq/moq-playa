import { describe, expect, it } from 'vitest';
import type { TrackProperties } from '@openmoq/transport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/stream-sim.js';
import { SeekFetchRequests, type SeekFetchResponse } from './seek-fetch-requests.js';

describe.each([18, 22] as const)('draft-%i historical response defaults', draft => {
  it('retains this FETCH response property values without sharing their mutable wire containers', async () => {
    const p = await connectedPair(draft), failures: Error[] = [];
    let request: bigint | undefined, response: SeekFetchResponse | undefined, wire: TrackProperties | undefined;
    const owner = new SeekFetchRequests(p.client, { isCurrent: () => true, onError: error => { failures.push(error); } });
    p.client.onMessage = message => {
      if (message.type === 'FETCH_OK') wire = message.trackProperties;
      owner.handleControl(message);
    };
    p.server.onFetch = id => { request = id; };
    try {
      owner.open({ namespace: ['vod'], name: 'video' }, { groupId: 0n, objectId: 0n }, { onObject() {} }, value => { response = value; });
      await flush(128); expect(request).toBeDefined();
      await p.server.acceptFetch(request!, { endLocation: { group: 0n, object: 1n }, trackProperties: new Map([
        [0x12n, [90_000n]], [0x0dn, [Uint8Array.of(1, 2)]],
      ]) });
      await flush(128);
      expect(response?.trackProperties).toBeInstanceOf(Map);
      expect(response!.trackProperties!.get(0x12n)).toEqual([90_000n]);
      expect(response!.trackProperties!.get(0x0dn)).toEqual([Uint8Array.of(1, 2)]);
      expect(response!.trackProperties).not.toBe(wire);
      const sourceScale = wire!.get(0x12n)!;
      sourceScale[0] = 48_000n;
      const sourceBytes = wire!.get(0x0dn)![0];
      if (!(sourceBytes instanceof Uint8Array)) throw new Error('Expected response bytes');
      sourceBytes.fill(9);
      expect(response!.trackProperties!.get(0x12n)).toEqual([90_000n]);
      expect(response!.trackProperties!.get(0x0dn)).toEqual([Uint8Array.of(1, 2)]);
      expect(failures).toEqual([]); expect(p.errors).toEqual([]);
    } finally { owner.dispose(); await p.client.close(); await p.server.close(); }
  });

  it('keeps an empty property block empty without adding unrelated defaults', async () => {
    const p = await connectedPair(draft), responses: SeekFetchResponse[] = [];
    let request: bigint | undefined;
    const owner = new SeekFetchRequests(p.client, { isCurrent: () => true, onError: error => { throw error; } });
    p.client.onMessage = message => { owner.handleControl(message); };
    p.server.onFetch = id => { request = id; };
    try {
      owner.open({ namespace: ['vod'], name: 'video' }, { groupId: 0n, objectId: 0n }, { onObject() {} }, value => { responses.push(value); });
      await flush(128); await p.server.acceptFetch(request!, { endLocation: { group: 0n, object: 1n } }); await flush(128);
      expect(responses).toEqual([{ endOfTrack: false, endLocation: { group: 0n, object: 1n } }]);
      expect(p.errors).toEqual([]);
    } finally { owner.dispose(); await p.client.close(); await p.server.close(); }
  });
});
