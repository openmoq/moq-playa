// Evaluation probes (scratch only). Real loopback transport, in-memory; not network evidence.
import { it, expect } from 'vitest';
import { varint } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { Relay, type RelayOptions } from './relay.js';

const ns = [new TextEncoder().encode('demo')], name = new TextEncoder().encode('objects');
const opts = { maxRequestId: varint(1000n) };

async function rig(draft: 14 | 16 | 18 | 22, options: RelayOptions = {}, holdAccept = false) {
  const up = createLoopback(), down = createLoopback();
  for (const b of [up.b, down.b, up.a, down.a]) Object.assign(b, { createStreamError: (code: number) => Object.assign(new Error('reset'), { streamErrorCode: code }) });
  const origin = new MoqtConnection(draft), ingress = new MoqtConnection(draft, { role: 'server' });
  const viewer = new MoqtConnection(draft), egress = new MoqtConnection(draft, { role: 'server' });
  const relay = new Relay(options);
  const log: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  if (holdAccept) {
    const accept = egress.acceptSubscribe.bind(egress);
    egress.acceptSubscribe = (async (...args: Parameters<typeof accept>) => { log.push('accept-held'); await gate; return accept(...args); }) as typeof egress.acceptSubscribe;
  }
  ingress.onPublish = p => { void relay.handlePublish(ingress, p); };
  egress.onSubscribe = (id, n, t) => { void relay.handleSubscribe(egress, id, n, t); };
  egress.onSubscribeClosed = id => relay.removeSubscription(egress, id);
  egress.onFetch = (id, f) => { void relay.handleFetch(egress, id, f); };
  egress.setLargestLocationProvider?.(id => relay.currentLargestFor(egress, id));
  viewer.onMessage = m => { log.push(`msg ${m.type}${(m as { statusCode?: bigint }).statusCode !== undefined ? ' status=0x' + (m as { statusCode: bigint }).statusCode.toString(16) : ''}${(m as { errorCode?: bigint }).errorCode !== undefined ? ' code=0x' + (m as { errorCode: bigint }).errorCode.toString(16) : ''}`); };
  viewer.onStreamClosed = (_id, _e, terminal) => { log.push(`stream ${terminal}`); };
  origin.onMessage = m => { log.push(`origin-msg ${m.type}${(m as { errorCode?: bigint }).errorCode !== undefined ? ' code=0x' + (m as { errorCode: bigint }).errorCode.toString(16) : ''}`); };
  await Promise.all([origin.connect(up.a, opts), ingress.connect(up.b, opts), viewer.connect(down.a, opts), egress.connect(down.b, opts)]);
  const close = () => Promise.all([origin.close(), ingress.close(), viewer.close(), egress.close()]);
  return { origin, ingress, viewer, egress, relay, log, release, close };
}

const txt = (p: Uint8Array) => new TextDecoder().decode(p);

for (const draft of [14, 16, 18] as const) {
  it(`PROBE malformed duplicate payload d${draft}`, async () => {
    const r = await rig(draft);
    try {
      const pubId = await r.origin.publish(ns, name, 9n); await flush(128);
      void r.viewer.subscribeTrack(ns, name, { onObject: o => { if (o.kind === 'data') r.log.push(`obj ${o.groupId}/${o.objectId} ${txt(o.payload)}`); }, filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n } }).catch(e => r.log.push('sub-rejected ' + e));
      await flush(128);
      for (const [g, p] of [[5n, 'A'], [5n, 'B'], [6n, 'C']] as const) {
        try {
          const sid = await r.origin.openSubgroup(9n, g, 0n, {});
          await r.origin.sendObject(sid, 0n, new TextEncoder().encode(p)); await r.origin.closeSubgroup(sid);
        } catch (e) { r.log.push('origin-send-failed ' + String(e).slice(0, 60)); }
        await flush(256);
      }
      await flush(512);
      r.log.push(`viewer-session ${r.viewer.session.state} egress-session ${r.egress.session.state} ingress-sub ${r.ingress.session.getIncomingSubscription(pubId as bigint)?.state ?? 'gone'}`);
      expect(r.log.filter(x => x.startsWith('obj '))).toEqual(draft === 18 ? ['obj 5/0 A'] : ['obj 5/0 A', 'obj 6/0 C']);
      expect(r.log.filter(x => x.startsWith('msg PUBLISH_DONE'))).toEqual(draft === 18 ? ['msg PUBLISH_DONE status=0x12'] : []);
      expect(r.viewer.session.state).toBe('established');
      if (draft !== 18) expect(r.ingress.session.getIncomingSubscription(pubId as bigint)?.isTerminated).toBe(false);
    } finally { await r.close(); }
  });
}
