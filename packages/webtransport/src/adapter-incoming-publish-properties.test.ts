import { expect, it } from 'vitest';
import type { TrackProperties } from '@openmoq/transport';
import type { IncomingPublish } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [14, 16, 18, 22] as const) {
  it(`draft${draft} IncomingPublish exposes independent initial property snapshots through retirement`, async () => {
    const f = await connectedPair(draft);
    let incoming: IncomingPublish | undefined;
    f.server.onPublish = pub => { incoming = pub; };
    const properties: TrackProperties = draft >= 18
      ? new Map([[0x0en, [7n]], [0x35n, [Uint8Array.of(1, 2)]]]) : new Map();
    try {
      await f.client.publish(ns('properties'), nm('video'), 41n,
        draft >= 18 ? { trackProperties: properties } : {});
      await flush(128);
      expect(incoming).toBeDefined();
      expect(incoming!.initialTrackProperties).toEqual(properties);
      const copy = incoming!.initialTrackProperties as TrackProperties;
      if (draft >= 18) {
        (copy.get(0x35n)![0] as Uint8Array)[0] = 99;
        copy.get(0x0en)!.push(9n);
      }
      copy.clear();
      expect(incoming!.initialTrackProperties).toEqual(properties);
      await f.server.close();
      expect(incoming!.initialTrackProperties).toEqual(properties);
    } finally { await f.client.close(); await f.server.close(); }
  });
}

for (const draft of [18, 22] as const) it(`draft${draft} snapshots PUBLISH properties before semantic observers run`, async () => {
  const f = await connectedPair(draft);
  let incoming: IncomingPublish | undefined;
  f.server.onMessage = message => { if (message.type === 'PUBLISH') message.trackProperties?.clear(); };
  f.server.onPublish = pub => { incoming = pub; };
  try {
    await f.client.publish(ns('snapshot'), nm('video'), 41n, { trackProperties: new Map([[0x04n, [1000n]]]) });
    await flush(128);
    expect(incoming?.initialTrackProperties?.get(0x04n)).toEqual([1000n]);
  } finally { await f.client.close(); await f.server.close(); }
});
