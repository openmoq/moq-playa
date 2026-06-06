/**
 * InboundRequestStreamContext — draft-18 inbound request stream (the receiver of
 * a PUBLISH / SUBSCRIBE_NAMESPACE / … opener). Exercised with the deterministic
 * stream simulator.
 */
import { describe, it, expect } from 'vitest';
import { InboundRequestStreamContext, type InboundRequestHandlers } from './inbound-request.js';
import { SimStream, flush } from '../testkit/stream-sim.js';
import { createControlCodec } from '@moqt/transport';
import type { ControlMessage, RequestOk } from '@moqt/transport';

const codec18 = createControlCodec(18);
const reqOkBytes = (): Uint8Array =>
  codec18.encode({ type: 'REQUEST_OK', requestId: 0n, parameters: new Map() } as RequestOk);

function setup() {
  const stream = new SimStream();
  const failures: Error[] = [];
  const closed: boolean[] = [];
  const handlers: InboundRequestHandlers = {
    onMessage: () => { /* peer message — not used here */ },
    onFailure: (e) => { failures.push(e); },
    onClosed: () => { closed.push(true); },
  };
  const ctx = new InboundRequestStreamContext(stream, codec18, handlers);
  ctx.start();
  ctx.bind(1n, 'publish');
  return { ctx, stream, failures, closed };
}

describe('InboundRequestStreamContext.sendUpdate write-failure cleanup', () => {
  it('removes the pending deferred when the write fails, so a later REQUEST_OK is unsolicited (not mis-correlated)', async () => {
    const { ctx, stream, failures } = setup();

    stream.failWrites = true;
    const update = {
      type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n, parameters: new Map(),
    } as unknown as ControlMessage;
    await expect(ctx.sendUpdate(update)).rejects.toThrow(/write failure/i);

    // The failed update left NO pending deferred, so an arriving REQUEST_OK has
    // nothing to match and is treated as a protocol violation (surfaced via
    // onFailure). Were the deferred stale, it would be silently resolved instead.
    stream.push(reqOkBytes());
    await flush();
    expect(failures.map((e) => e.message).join(' ')).toMatch(/unsolicited REQUEST_OK/i);
  });
});
