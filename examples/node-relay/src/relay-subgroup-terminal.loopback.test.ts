/** A truncated subgroup must reset; complete delivery may omit Objects below the initial Start Location. */
import { expect, it, vi } from 'vitest';
import { MoqtConnection, type WebTransportLike } from '@openmoq/webtransport';
import type { SubgroupHeader } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';

it.each(([18, 22] as const).flatMap(draft => (['pause', 'narrow', 'complete', 'initial-start'] as const).map(mode => ({ draft, mode }))))(
  'draft$draft / $mode: only a complete subgroup may report FIN/EOG', async ({ draft, mode }) => {
    const up = createLoopback(), down = createLoopback();
    // The in-memory binding supplies its own coded reset reason; no native brand is claimed.
    const binding: WebTransportLike = down.b;
    const createStreamError = vi.fn((code: number, cause?: unknown) =>
      Object.assign(new Error('loopback subgroup reset', { cause }), { streamErrorCode: code }));
    binding.createStreamError = createStreamError;
    const origin = new MoqtConnection(draft), ingress = new MoqtConnection(draft, { role: 'server' });
    const viewer = new MoqtConnection(draft), egress = new MoqtConnection(draft, { role: 'server' });
    const relay = new Relay(), errors: string[] = [], received: bigint[] = [], closed: SubgroupHeader[] = [];
    const terminals: string[] = [], headers: SubgroupHeader[] = [];
    const outgoing = vi.spyOn(egress, 'sendObject');
    for (const connection of [origin, ingress, viewer, egress]) connection.onError = error => errors.push(error.message);
    ingress.onPublish = publish => { void relay.handlePublish(ingress, publish); };
    egress.onSubscribe = (id, namespace, name) => { void relay.handleSubscribe(egress, id, namespace, name); };
    egress.onSubscribeClosed = id => relay.removeSubscription(egress, id);
    egress.setLargestLocationProvider(id => relay.currentLargestFor(egress, id));
    viewer.onDataStream = (_id, message) => { if (message.type === 'subgroup') headers.push(message.header); };
    viewer.onStreamClosed = (_id, _error, terminal) => terminals.push(terminal);
    try {
      await Promise.all([origin.connect(up.a), ingress.connect(up.b), viewer.connect(down.a), egress.connect(down.b)]);
      const published = await origin.publish(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), 41n);
      await flush(128);
      expect(origin.session.getOutgoingPublish(published)?.state).toBe('established');
      const sub = await viewer.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), mode === 'initial-start'
        ? { filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 1n } } : undefined);
      sub.onObject = object => { if (object.kind === 'data') received.push(object.objectId); };
      sub.onSubgroupClosed = header => closed.push(header);
      await flush(128);
      const stream = await origin.openSubgroup(41n, 5n, 0n, { firstObject: true, endOfGroup: true });
      await origin.sendObject(stream, 0n, Uint8Array.of(10)); await flush(128);
      expect(received).toEqual(mode === 'initial-start' ? [] : [0n]);
      if (mode !== 'initial-start') { expect(headers).toHaveLength(1); expect(headers[0]!.isEndOfGroup).toBe(true); }
      if (mode === 'pause' || mode === 'narrow') {
        await viewer.requestUpdate(sub.requestId, mode === 'pause' ? { forward: 0 }
          : { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 6n, startObject: 0n } });
        await flush(128);
        const incoming = egress.session.getIncomingSubscription(sub.requestId)!;
        if (mode === 'pause') expect(incoming.isActive).toBe(false);
        else expect(incoming.locationWindow?.start).toEqual({ group: 6n, object: 0n });
      }
      // These real upstream objects exist in the EOG-bearing subgroup, even when the viewer omits them.
      await origin.sendObject(stream, 1n, Uint8Array.of(11));
      await origin.sendObject(stream, 2n, Uint8Array.of(12));
      await origin.closeSubgroup(stream); await flush(256);
      expect(egress.session.state, 'subgroup truncation must preserve its serving session').toBe('established');
      expect(down.b.closeInfo, 'valid subgroup reset must not escalate to session close').toBeUndefined();
      expect(createStreamError).toHaveBeenCalledTimes(mode === 'pause' || mode === 'narrow' ? 1 : 0);
      if (mode === 'pause' || mode === 'narrow') expect(createStreamError.mock.calls[0]?.[0]).toBe(1);
      expect(errors).toEqual([]);
      const sent = await Promise.allSettled(outgoing.mock.results.map(result => result.type === 'return' ? result.value : Promise.reject(result.value)));
      const committed = outgoing.mock.calls.filter((_args, i) => sent[i]?.status === 'fulfilled').map(args => args[1]);
      expect(committed, 'only admitted Objects may actually complete downstream send').toEqual(mode === 'complete' ? [0n, 1n, 2n] : mode === 'initial-start' ? [1n, 2n] : [0n]);
      expect(received).toEqual(mode === 'complete' ? [0n, 1n, 2n] : mode === 'initial-start' ? [1n, 2n] : [0n]);
      if (mode === 'complete' || mode === 'initial-start') {
        expect(headers).toHaveLength(1); expect(headers[0]!.isEndOfGroup).toBe(true);
        expect(closed).toHaveLength(1); expect(terminals).toEqual(['fin']);
      } else {
        expect(closed, 'omitted subgroup objects must not be certified complete by FIN/EOG').toEqual([]);
        expect(terminals).not.toContain('fin');
      }
    } finally { await Promise.all([origin.close(), ingress.close(), viewer.close(), egress.close()]); await flush(32); }
  },
);

it.each(([18, 22] as const).flatMap(draft => (['open', 'queued-send'] as const).map(held => ({ draft, held }))))(
  'draft$draft narrowing during $held resets only the truncated subgroup', async ({ draft, held }) => {
    const up = createLoopback(), down = createLoopback();
    // The in-memory binding supplies its own coded reset reason; no native brand is claimed.
    const binding: WebTransportLike = down.b;
    const createStreamError = vi.fn((code: number, cause?: unknown) =>
      Object.assign(new Error('loopback subgroup reset', { cause }), { streamErrorCode: code }));
    binding.createStreamError = createStreamError;
    const origin = new MoqtConnection(draft), ingress = new MoqtConnection(draft, { role: 'server' });
    const viewer = new MoqtConnection(draft), egress = new MoqtConnection(draft, { role: 'server' });
    const relay = new Relay(), errors: string[] = [];
    const received: Array<readonly [bigint, bigint]> = [];
    const headers = new Map<bigint, SubgroupHeader>();
    const terminals: Array<readonly [bigint, string]> = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    for (const c of [origin, ingress, viewer, egress]) c.onError = error => errors.push(error.message);
    ingress.onPublish = publish => { void relay.handlePublish(ingress, publish); };
    egress.onSubscribe = (id, namespace, name) => { void relay.handleSubscribe(egress, id, namespace, name); };
    egress.onSubscribeClosed = id => relay.removeSubscription(egress, id);
    egress.setLargestLocationProvider(id => relay.currentLargestFor(egress, id));
    viewer.onDataStream = (id, message) => { if (message.type === 'subgroup') headers.set(id, message.header); };
    viewer.onStreamClosed = (id, _error, terminal) => { const h = headers.get(id); if (h) terminals.push([h.groupId, terminal]); };
    try {
      await Promise.all([origin.connect(up.a), ingress.connect(up.b), viewer.connect(down.a), egress.connect(down.b)]);
      await origin.publish(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), 41n); await flush(128);
      const sub = await viewer.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK));
      sub.onObject = o => { if (o.kind === 'data') received.push([o.groupId, o.objectId]); };
      await flush(64);
      if (held === 'open') {
        const open = egress.openSubgroup.bind(egress);
        vi.spyOn(egress, 'openSubgroup').mockImplementation(async (...args) => {
          const id = await open(...args); if (args[1] === 5n) await gate; return id;
        });
      }
      if (held === 'queued-send') {
        const send = egress.sendObject.bind(egress);
        vi.spyOn(egress, 'sendObject').mockImplementation(async (...args) => {
          await send(...args);
          if (args[1] === 0n) await gate;
        });
      }
      const stream = await origin.openSubgroup(41n, 5n, 0n, { firstObject: true, endOfGroup: true });
      await origin.sendObject(stream, 0n, Uint8Array.of(0)); await flush(128);
      expect([...headers.values()].some(h => h.groupId === 5n && h.isEndOfGroup)).toBe(true);
      expect(received).toEqual(held === 'open' ? [] : [[5n, 0n]]);
      if (held === 'queued-send') {
        await origin.sendObject(stream, 1n, Uint8Array.of(1));
        await origin.sendObject(stream, 2n, Uint8Array.of(2)); await flush(64);
      }
      await viewer.requestUpdate(sub.requestId, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 6n, startObject: 0n } });
      await flush(64);
      expect(egress.session.getIncomingSubscription(sub.requestId)?.locationWindow?.start).toEqual({ group: 6n, object: 0n });
      release(); await origin.closeSubgroup(stream); await flush(128);
      const next = await origin.openSubgroup(41n, 6n, 0n, { firstObject: true, endOfGroup: true });
      await origin.sendObject(next, 0n, Uint8Array.of(6)); await origin.closeSubgroup(next); await flush(128);
      expect(egress.session.state, 'the sibling must retain its serving session').toBe('established');
      expect(down.b.closeInfo).toBeUndefined();
      expect(received).toEqual(held === 'open' ? [[6n, 0n]] : [[5n, 0n], [6n, 0n]]);
      expect(terminals).toContainEqual([5n, 'reset']); expect(terminals).not.toContainEqual([5n, 'fin']);
      expect(terminals).toContainEqual([6n, 'fin']);
      expect(createStreamError).toHaveBeenCalledTimes(1);
      expect(createStreamError.mock.calls[0]?.[0]).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      release(); await Promise.all([origin.close(), ingress.close(), viewer.close(), egress.close()]); await flush(32);
    }
  },
);
