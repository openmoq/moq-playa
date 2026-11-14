/**
 * GOAWAY delivery: validated first, then scoped.
 *
 * A control-stream GOAWAY drains the whole session; one on a request stream
 * migrates only that request and leaves the rest of the session in place
 * (draft-18 §10.4, draft-22 §9.2 and §6.6.1). The wire cannot express that
 * difference — draft-18's control-stream Request ID is a processing boundary and
 * draft-22 removed the field — so scope comes from the carrying stream.
 *
 * A GOAWAY the session rejects must reach no application callback at all, or an
 * invalid message could drive a migration decision.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionError, SessionState, type DraftVersion, type SessionStateValue } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import type { GoawayNotice, MoqtConnection } from './index.js';

/** Observed notices plus the session state seen at delivery time. */
function observe(conn: MoqtConnection) {
  const notices: Array<{ notice: GoawayNotice; stateAtDelivery: SessionStateValue }> = [];
  const order: string[] = [];
  conn.onMessage = (msg) => { if (msg.type === 'GOAWAY') order.push('onMessage'); };
  conn.onGoawayNotice = (notice) => {
    order.push('notice');
    notices.push({ notice, stateAtDelivery: conn.session.state });
  };
  return { notices, order };
}

/**
 * Write a raw control message onto the request stream the peer opened for
 * `requestId`. There is no public publisher API for a request-stream GOAWAY, and
 * going through one would apply sender-side validation that these receiver tests
 * exist to exercise.
 */
function peerRequestStream(conn: MoqtConnection, requestId: bigint): { writeMessage(m: unknown): Promise<void> } {
  const contexts = (conn as unknown as { inboundRequestContexts?: Map<bigint, unknown> }).inboundRequestContexts;
  expect(contexts, 'inboundRequestContexts should be reachable').toBeInstanceOf(Map);
  const ctx = contexts!.get(requestId);
  expect(ctx, `an inbound request stream should exist for request ${requestId}`).toBeDefined();
  return ctx as { writeMessage(m: unknown): Promise<void> };
}

// The client's own request IDs are even, so a server's control-stream GOAWAY
// carries an even Request ID on draft-18 (absent on draft-22, §9.2).
const controlGoaway = (version: DraftVersion, uri: string, timeout?: bigint) => ({
  ...(uri ? { newSessionUri: uri } : {}),
  ...(timeout !== undefined ? { timeout } : {}),
  ...(version === 18 ? { requestId: 0n } : {}),
});

// draft-14 is deliberately absent: our Draft14Codec has no GOAWAY ENCODER
// ("Draft14Codec cannot encode message type GOAWAY"), so no draft-14 peer can
// be driven to send one from this harness. Legacy delivery is covered on 16,
// which shares the legacy control read loop.
describe.each([16, 18, 22, 23] as const)('draft-%i session-scope GOAWAY notice', (version) => {
  it('delivers one session notice after the state transition, onMessage first', async () => {
    const { client, server, errors } = await connectedPair(version);
    const seen = observe(client);
    try {
      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq', 5_000n));
      await flush();

      expect(seen.notices).toHaveLength(1);
      expect(seen.notices[0]!.notice.scope).toBe('session');
      expect(seen.notices[0]!.notice.newSessionUri).toBe('https://new.example/moq');
      // The transition is applied BEFORE delivery, so an observer that starts a
      // request synchronously is refused by the draining session.
      expect(seen.notices[0]!.stateAtDelivery).toBe(SessionState.DRAINING);
      expect(seen.order).toEqual(['onMessage', 'notice']);
      expect(errors).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('carries the peer Timeout exactly on 18/22/23 and omits it on 14/16', async () => {
    const huge = (1n << 62n) - 1n; // a vi64 value no Number can hold
    for (const timeout of [0n, 5_000n, huge]) {
      const { client, server } = await connectedPair(version);
      const seen = observe(client);
      try {
        await server.sendGoaway(controlGoaway(version, '', timeout));
        await flush();
        expect(seen.notices).toHaveLength(1);
        const got = seen.notices[0]!.notice.timeoutMs;
        if (version >= 18) {
          expect(got).toBe(timeout); // exact bigint, never through Number
        } else {
          expect(got).toBeUndefined(); // no Timeout field exists on 14/16
        }
      } finally { await client.close(); await server.close(); }
    }
  });

  it('an empty New Session URI is delivered as empty, not as a substituted URL', async () => {
    const { client, server } = await connectedPair(version);
    const seen = observe(client);
    try {
      await server.sendGoaway(controlGoaway(version, ''));
      await flush();
      expect(seen.notices[0]!.notice.newSessionUri).toBe('');
    } finally { await client.close(); await server.close(); }
  });

  it('records every parsed GOAWAY on the qlog channel, including the rejected one', async () => {
    // `onMessage` withholds a rejected GOAWAY, so qlog is the only place a
    // consumer can see that one arrived. Exactly one record per parsed message —
    // never two for the same frame.
    const { client, server } = await connectedPair(version);
    const seen = observe(client);
    const parsed: unknown[] = [];
    client.onQlogEvent = (event) => {
      if (event.type === 'control_message_parsed' && event.message.type === 'GOAWAY') parsed.push(event);
    };
    try {
      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq'));
      await flush();
      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq')).catch(() => {});
      await flush();

      expect(parsed).toHaveLength(2); // both the accepted and the rejected one
      expect(seen.order).toEqual(['onMessage', 'notice']); // only the accepted one
    } finally { await client.close(); await server.close(); }
  });

  it('a duplicate GOAWAY closes with PROTOCOL_VIOLATION and yields no second notice', async () => {
    const { client, server } = await connectedPair(version);
    const seen = observe(client);
    const closed: Array<{ error?: number }> = [];
    client.onClose = (error) => { closed.push({ ...(error !== undefined ? { error } : {}) }); };
    try {
      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq'));
      await flush();
      expect(seen.notices).toHaveLength(1); // the first is valid and accepted

      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq')).catch(() => {});
      await flush();

      // The second is a violation: it reaches NEITHER application callback, so
      // the observed order still holds exactly one onMessage and one notice.
      // A rejected GOAWAY that still reached onMessage would let an application
      // act on a message the session refused.
      expect(seen.notices).toHaveLength(1);
      expect(seen.order).toEqual(['onMessage', 'notice']);
      expect(closed[0]?.error).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    } finally { await client.close(); await server.close(); }
  });
});

describe.each([18, 22, 23] as const)('draft-%i request-scope GOAWAY notice', (version) => {
  it('scopes the notice to the addressed request and leaves the session established', async () => {
    const { client, server, errors } = await connectedPair(version);
    const seen = observe(client);
    server.onSubscribe = (requestId, _n, _t) => { void server.acceptSubscribe(requestId, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      await flush();
      await peerRequestStream(server, sub.requestId)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();

      expect(seen.notices).toHaveLength(1);
      const notice = seen.notices[0]!.notice;
      expect(notice.scope).toBe('request');
      expect(notice.scope === 'request' && notice.requestId).toBe(sub.requestId);
      // Request migration must not drain the session.
      expect(seen.notices[0]!.stateAtDelivery).toBe(SessionState.ESTABLISHED);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
      expect(errors).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('rejects a second GOAWAY on one request stream, even coalesced into one read', async () => {
    // §10.4 / §9.2: at most one GOAWAY per request stream. The first tears the
    // stream down, so a duplicate already decoded from the same receive must
    // still be caught — and it is SESSION-fatal, not a per-stream error.
    const { client, server, a } = await connectedPair(version);
    const seen = observe(client);
    server.onSubscribe = (requestId) => { void server.acceptSubscribe(requestId, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      const stream = peerRequestStream(server, sub.requestId);
      const pipe = a.bidiOut[0]!.in;
      pipe.faults.hold = true; // coalesce both frames into one receive
      await stream.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await stream.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      pipe.releaseHeld();
      await flush(32);

      expect(a.closeInfo?.closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
      expect(seen.notices.length).toBeLessThanOrEqual(1);
    } finally { await client.close(); await server.close(); }
  });

  it('records a request-stream GOAWAY on the qlog channel', async () => {
    const { client, server } = await connectedPair(version);
    const parsed: unknown[] = [];
    client.onQlogEvent = (event) => {
      if (event.type === 'control_message_parsed' && event.message.type === 'GOAWAY') parsed.push(event);
    };
    server.onSubscribe = (requestId) => { void server.acceptSubscribe(requestId, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      await flush();
      await peerRequestStream(server, sub.requestId)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();
      expect(parsed).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it('delivers on a PENDING request too, and rejects its waiter', async () => {
    // An established request has an empty response FIFO; a pending one does
    // not, and only the pending case proves the waiter is settled rather than
    // left hanging.
    const { client, server } = await connectedPair(version);
    const seen = observe(client);
    let pendingReqId: bigint | null = null;
    server.onSubscribe = (requestId) => { pendingReqId = requestId; }; // never accepted
    try {
      const pending = client.subscribeTrack(ns('live'), nm('video'));
      const settled = pending.then(() => 'resolved' as const, () => 'rejected' as const);
      await vi.waitFor(() => expect(pendingReqId).not.toBeNull());
      await peerRequestStream(server, pendingReqId!)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();

      expect(await settled).toBe('rejected');
      expect(seen.notices).toHaveLength(1);
      const notice = seen.notices[0]!.notice;
      expect(notice.scope === 'request' && notice.requestId).toBe(pendingReqId);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await client.close(); await server.close(); }
  });

  it('handles a Request ID on a request stream per the draft\'s wire shape', async () => {
    // §10.4: "Request ID: Present only when sent on the control stream." On
    // draft-18 the field exists, so a peer CAN put it on a request stream and
    // the receiver must reject it. draft-22 (§9.2) removed the field outright:
    // the encoder drops it, nothing reaches the wire, and the message is a
    // perfectly ordinary request GOAWAY. Asserting a rejection there would be
    // asserting against our own encoder rather than the peer.
    const { client, server } = await connectedPair(version);
    const seen = observe(client);
    const closed: number[] = [];
    client.onClose = (error) => { if (error !== undefined) closed.push(error); };
    server.onSubscribe = (requestId) => { void server.acceptSubscribe(requestId, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      await flush();
      await peerRequestStream(server, sub.requestId)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n, requestId: 4n });
      await flush();

      if (version === 18) {
        expect(seen.notices).toEqual([]);
        expect(closed[0]).toBe(Number(SessionError.PROTOCOL_VIOLATION));
      } else {
        // No Request ID is encodable, so this is an accepted request notice and
        // the session stays up — the draft-22 no-ID wire shape is preserved.
        expect(seen.notices).toHaveLength(1);
        expect(seen.notices[0]!.notice.scope).toBe('request');
        expect(closed).toEqual([]);
        expect(client.session.state).toBe(SessionState.ESTABLISHED);
      }
    } finally { await client.close(); await server.close(); }
  });

  it('a SERVER rejects a non-empty New Session URI on a request stream', async () => {
    // A client cannot direct a server's connections anywhere: "If a server
    // receives a GOAWAY with a non-zero New Session URI Length it MUST close the
    // session with a PROTOCOL_VIOLATION." Not limited to the control stream, so
    // the server subscribes here and the client answers on that request stream.
    const { client, server } = await connectedPair(version);
    const seen = observe(server);
    const closed: number[] = [];
    server.onClose = (error) => { if (error !== undefined) closed.push(error); };
    client.onSubscribe = (requestId) => { void client.acceptSubscribe(requestId, 88n); };
    try {
      const sub = await server.subscribeTrack(ns('live'), nm('video'));
      await flush();
      await peerRequestStream(client, sub.requestId)
        .writeMessage({ type: 'GOAWAY', newSessionUri: 'https://elsewhere.example/moq', timeout: 0n });
      await flush();

      expect(seen.notices).toEqual([]);
      expect(closed[0]).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    } finally { await client.close(); await server.close(); }
  });

  it('a throwing onMessage observer neither suppresses the notice nor strands the request', async () => {
    const { client, server, errors } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    client.onMessage = () => { throw new Error('observer exploded'); };
    client.onGoawayNotice = (notice) => { notices.push(notice); };
    let pendingReqId: bigint | null = null;
    server.onSubscribe = (requestId) => { pendingReqId = requestId; };
    try {
      const pending = client.subscribeTrack(ns('live'), nm('video'));
      const settled = pending.then(() => 'resolved' as const, () => 'rejected' as const);
      await vi.waitFor(() => expect(pendingReqId).not.toBeNull());
      await peerRequestStream(server, pendingReqId!)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();

      // The waiter is settled and the notice still delivered; the observer's
      // failure is reported rather than silently swallowing protocol work.
      expect(await settled).toBe('rejected');
      expect(notices).toHaveLength(1);
      expect(errors.map((e) => e.message)).toContain('observer exploded');
    } finally { await client.close(); await server.close(); }
  });
});

describe('draft-14 GOAWAY receive', () => {
  it('accepts a raw-wire GOAWAY and rejects its duplicate', async () => {
    // Draft-14 has no GOAWAY ENCODER in this implementation, so no peer can be
    // driven to send one through the public API. That is a sender-side gap; the
    // RECEIVE path still runs through the notifier and needs coverage, so the
    // frame is injected as raw wire bytes.
    //
    // §9.4: Type 0x10, uint16 body length 1, zero-length New Session URI. Note
    // the draft-14 GOAWAY has no Timeout field, so the notice carries none.
    const { client, server, a } = await connectedPair(14);
    const seen = observe(client);
    try {
      const wire = Uint8Array.of(0x10, 0, 1, 0);
      a.bidiOut[0]!.in.injectRead(wire);
      await flush(32);

      expect(seen.notices).toHaveLength(1);
      expect(seen.notices[0]!.notice).toEqual({ scope: 'session', newSessionUri: '' });
      expect(seen.notices[0]!.notice.timeoutMs).toBeUndefined();
      expect(seen.notices[0]!.stateAtDelivery).toBe(SessionState.DRAINING);

      a.bidiOut[0]!.in.injectRead(wire);
      await flush(32);
      expect(a.closeInfo?.closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
      expect(seen.notices).toHaveLength(1);
      expect(seen.order).toEqual(['onMessage', 'notice']);
    } finally { await client.close(); await server.close(); }
  });
});

describe.each([16, 18, 22, 23] as const)('draft-%i GOAWAY delivery contract', (version) => {
  it('snapshots the notice before calling out, so a mutating observer cannot retarget it', async () => {
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    client.onMessage = (msg) => {
      // A hostile or careless observer mutating the message it was handed must
      // not change where the migration is pointed.
      (msg as { newSessionUri: string }).newSessionUri = 'https://attacker.example/moq';
      (msg as { timeout?: bigint }).timeout = 999n;
    };
    client.onGoawayNotice = (notice) => { notices.push(notice); };
    try {
      await server.sendGoaway(controlGoaway(version, 'https://real.example/moq', 7n));
      await flush();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.newSessionUri).toBe('https://real.example/moq');
      if (version !== 16) expect(notices[0]!.timeoutMs).toBe(7n);
    } finally { await client.close(); await server.close(); }
  });

  it('reports DRAINING to onMessage as well, not only to the notice', async () => {
    const { client, server } = await connectedPair(version);
    const statesAtOnMessage: SessionStateValue[] = [];
    client.onMessage = () => { statesAtOnMessage.push(client.session.state); };
    try {
      await server.sendGoaway(controlGoaway(version, ''));
      await flush();
      // The transition precedes BOTH callbacks, so even the raw observer cannot
      // see an ESTABLISHED session for a GOAWAY that has been accepted.
      expect(statesAtOnMessage).toEqual([SessionState.DRAINING]);
    } finally { await client.close(); await server.close(); }
  });

  it('delivers no notice when onMessage closes the connection reentrantly', async () => {
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    client.onMessage = () => { void client.close(); };
    client.onGoawayNotice = (notice) => { notices.push(notice); };
    try {
      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq'));
      await flush();
      expect(notices).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('contains a throwing qlog observer on the control path too', async () => {
    // The raw record is emitted before validation on every draft, including the
    // legacy read loop. A throwing diagnostic observer must not abort the
    // session transition or suppress the notice that follows it.
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    client.onQlogEvent = () => { throw new Error('qlog observer exploded'); };
    client.onGoawayNotice = (notice) => { notices.push(notice); };
    try {
      await server.sendGoaway(controlGoaway(version, 'https://new.example/moq', 3n));
      await flush();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.newSessionUri).toBe('https://new.example/moq');
      expect(client.session.state).toBe(SessionState.DRAINING);
    } finally { await client.close(); await server.close(); }
  });

  it('keeps the exact protocol error when a qlog observer throws on a rejected GOAWAY', async () => {
    // A diagnostic failure must not change which error the peer gets.
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    const closed: number[] = [];
    client.onGoawayNotice = (notice) => { notices.push(notice); };
    client.onClose = (error) => { if (error !== undefined) closed.push(error); };
    try {
      await server.sendGoaway(controlGoaway(version, ''));
      await flush();
      client.onQlogEvent = () => { throw new Error('qlog observer exploded'); };
      await server.sendGoaway(controlGoaway(version, '')).catch(() => {});
      await flush();

      expect(notices).toHaveLength(1); // only the accepted one
      expect(closed[0]).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    } finally { await client.close(); await server.close(); }
  });

  it('contains a throwing notice observer and a throwing error observer', async () => {
    const { client, server, errors } = await connectedPair(version);
    client.onGoawayNotice = () => { throw new Error('notice observer exploded'); };
    client.onError = () => { throw new Error('error observer exploded too'); };
    try {
      // Neither throw may escape into protocol processing: the session has
      // already transitioned, and nothing further is required of it here.
      await server.sendGoaway(controlGoaway(version, ''));
      await flush();
      expect(client.session.state).toBe(SessionState.DRAINING);
      // The onError throw is swallowed rather than recorded, by design.
      expect(errors.map((e) => e.message)).not.toContain('error observer exploded too');
    } finally { await client.close(); await server.close(); }
  });
});

describe('draft-18 control GOAWAY Request ID parity', () => {
  it('rejects the wrong parity with INVALID_REQUEST_ID and no application callback', async () => {
    // §10.4: the control-stream Request ID is the smallest PEER request that may
    // not have been processed, so its parity must match the RECEIVER's. The
    // sender API validates this, so the frame is injected as raw wire bytes:
    // type 0x10, uint16 body length 3, URI length 0, Timeout 0, Request ID 1 —
    // odd, while this client's own request IDs are even.
    const { client, server, b } = await connectedPair(18);
    const seen = observe(client);
    const closed: number[] = [];
    client.onClose = (error) => { if (error !== undefined) closed.push(error); };
    try {
      // The server's outbound uni stream 0 is its control stream, which the
      // client reads (draft-18 §3.3 control-stream pair).
      b.uniOut[0]!.injectRead(Uint8Array.of(0x10, 0x00, 0x03, 0x00, 0x00, 0x01));
      await flush(32);

      expect(seen.notices).toEqual([]);
      expect(seen.order).toEqual([]);
      expect(closed[0]).toBe(Number(SessionError.INVALID_REQUEST_ID));
    } finally { await client.close(); await server.close(); }
  });
});

describe('GoawayNotice type', () => {
  it('requires a request ID on request scope and forbids one on session scope', () => {
    const session: GoawayNotice = { scope: 'session', newSessionUri: '' };
    const request: GoawayNotice = { scope: 'request', requestId: 7n, newSessionUri: '' };
    expect(session.requestId).toBeUndefined();
    expect(request.scope === 'request' && request.requestId).toBe(7n);

    // @ts-expect-error request scope requires a requestId
    const missing: GoawayNotice = { scope: 'request', newSessionUri: '' };
    // @ts-expect-error session scope forbids a requestId
    const extra: GoawayNotice = { scope: 'session', requestId: 7n, newSessionUri: '' };
    expect([missing, extra]).toHaveLength(2);
  });
});
