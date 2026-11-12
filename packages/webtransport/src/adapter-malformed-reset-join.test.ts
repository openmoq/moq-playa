import { expect, it, vi } from 'vitest';
import { SessionState, type ControlMessage } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22] as const) {
  for (const closeSession of [false, true]) {
    it(`draft ${draft} malformed termination joins the reserved subgroup reset, sessionClose=${closeSession}`, async () => {
      const f = await connectedPair(draft);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const messages: ControlMessage[] = [];
      f.client.onMessage = message => messages.push(message);
      f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 7n); };
      try {
        const sub = await f.client.subscribeTrack(ns('reset-join'), nm('video'));
        const sid = await f.server.openSubgroup(7n, 0n, 0n);
        const reset = vi.fn(async (actual: WritableStreamDefaultWriter<Uint8Array>, reason: unknown) => {
          await held;
          await actual.abort(reason);
        });
        Object.assign(f.b, {
          createStreamError: (code: number) => Object.assign(new Error('coded reset'), { streamErrorCode: code }),
          resetSendStream: reset,
        });
        const first = f.server.resetSubgroup(sid);
        expect(f.server.resetSubgroup(sid)).toBe(first);
        const terminal = f.server.terminateMalformedPublication(sub.requestId).then(value => ({ value }), error => ({ error }));
        const close = f.server.closeSubgroup(sid);
        await flush(64);
        expect(reset).toHaveBeenCalledTimes(1);
        expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(0);
        if (closeSession) await f.server.close();
        release();
        await Promise.allSettled([first, close]);
        const result = await terminal;
        await flush(64);
        expect(reset).toHaveBeenCalledTimes(1);
        if (closeSession) {
          expect(result).toHaveProperty('error');
          expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(0);
        } else {
          expect(result).toEqual({ value: { status: 'done-written' } });
          expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(1);
          expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
        }
      } finally { release(); await f.client.close(); await f.server.close(); }
    });
  }

}
