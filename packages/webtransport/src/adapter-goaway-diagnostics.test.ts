/**
 * GOAWAY diagnostics must not be able to change protocol outcomes.
 *
 * The qlog channel carries every parsed GOAWAY, including ones the session
 * rejects, because `onMessage` withholds those. That makes a diagnostic
 * observer the first code to see the message, so it must not be able to abort
 * mandatory validation, change an error code, suppress the resulting notice, or
 * rewrite the migration target the notice carries.
 *
 * Also covers the request-stream close classification: a GOAWAY cancellation is
 * clean but LOCAL, so an accepted FETCH must be reclaimed rather than retained
 * the way a genuine peer FIN retains it while its data stream finishes
 * (draft-18 §3.3.2 and §5.2; draft-22 §6.4.2.3 and §3.2.4).
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */
import { describe, expect, it } from 'vitest';
import { SessionError, SessionState } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import type { GoawayNotice, MoqtConnection } from './index.js';

function requestStream(conn: MoqtConnection, id: bigint) {
  const contexts = (conn as unknown as {
    inboundRequestContexts: Map<bigint, { writeMessage(message: unknown): Promise<void> }>;
  }).inboundRequestContexts;
  const ctx = contexts.get(id);
  expect(ctx).toBeDefined();
  return ctx!;
}

describe.each([18, 22, 23] as const)('draft-%i diagnostic isolation', (version) => {
  it('rejects a forbidden client URI even when qlog throws', async () => {
    const { client, server, b } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    client.onSubscribe = (id) => { void client.acceptSubscribe(id, 88n); };
    try {
      const sub = await server.subscribeTrack(ns('live'), nm('video'));
      server.onGoawayNotice = (notice) => notices.push(notice);
      server.onQlogEvent = (event) => {
        if (event.type === 'control_message_parsed' && event.message.type === 'GOAWAY') {
          throw new Error('diagnostic observer failed');
        }
      };
      await requestStream(client, sub.requestId).writeMessage({
        type: 'GOAWAY', newSessionUri: 'https://other.example/moq', timeout: 0n,
      });
      await flush(32);
      expect(notices).toEqual([]);
      expect(b.closeInfo?.closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    } finally { await client.close(); await server.close(); }
  });

  it('delivers a valid request notice even when qlog throws', async () => {
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    server.onSubscribe = (id) => { void server.acceptSubscribe(id, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      client.onGoawayNotice = (notice) => notices.push(notice);
      client.onQlogEvent = (event) => {
        if (event.type === 'control_message_parsed' && event.message.type === 'GOAWAY') {
          throw new Error('diagnostic observer failed');
        }
      };
      await requestStream(server, sub.requestId).writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush(32);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
      expect(notices).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it('does not let qlog rewrite the accepted migration target', async () => {
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    client.onGoawayNotice = (notice) => notices.push(notice);
    client.onQlogEvent = (event) => {
      if (event.type === 'control_message_parsed' && event.message.type === 'GOAWAY') {
        (event.message as { newSessionUri: string }).newSessionUri = 'https://changed.example/moq';
      }
    };
    try {
      await server.sendGoaway({ newSessionUri: 'https://real.example/moq', timeout: 0n,
        ...(version === 18 ? { requestId: 0n } : {}) });
      await flush(32);
      expect(notices[0]?.newSessionUri).toBe('https://real.example/moq');
    } finally { await client.close(); await server.close(); }
  });

  it('does not let qlog rewrite what VALIDATION sees', async () => {
    // The notice is snapshotted before any observer runs, so the migration
    // target is already safe. Validation is the other half: it runs AFTER the
    // raw record, on the message itself. Handing a diagnostic observer the live
    // message would let it turn a legal GOAWAY into a rejected one — or the
    // reverse — so the record carries a copy.
    //
    // A client MUST send a zero-length New Session URI, and a server receiving a
    // non-empty one MUST close with PROTOCOL_VIOLATION (§10.4 / §9.2). Here the
    // client sends a legal empty URI and the SERVER's qlog observer rewrites it.
    const { client, server } = await connectedPair(version);
    const notices: GoawayNotice[] = [];
    const closed: number[] = [];
    server.onGoawayNotice = (notice) => { notices.push(notice); };
    server.onClose = (error) => { if (error !== undefined) closed.push(error); };
    server.onQlogEvent = (event) => {
      if (event.type !== 'control_message_parsed' || event.message.type !== 'GOAWAY') return;
      (event.message as { newSessionUri: string }).newSessionUri = 'https://injected.example/moq';
    };
    try {
      await client.sendGoaway(version === 18 ? { requestId: 1n } : {});
      await flush(32);

      // Accepted on its real contents, not the observer's rewrite.
      expect(closed).toEqual([]);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.newSessionUri).toBe('');
      expect(server.session.state).toBe(SessionState.DRAINING);
    } finally { await client.close(); await server.close(); }
  });

  it('observes both coalesced request GOAWAY frames on qlog', async () => {
    const { client, server, a } = await connectedPair(version);
    const parsed: unknown[] = [];
    server.onSubscribe = (id) => { void server.acceptSubscribe(id, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      client.onQlogEvent = (event) => {
        if (event.type === 'control_message_parsed' && event.message.type === 'GOAWAY') parsed.push(event);
      };
      const stream = requestStream(server, sub.requestId);
      const pipe = a.bidiOut[0]!.in;
      pipe.faults.hold = true;
      await stream.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await stream.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      pipe.releaseHeld();
      await flush(32);
      expect(a.closeInfo?.closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
      expect(parsed).toHaveLength(2);
    } finally { await client.close(); await server.close(); }
  });

  it('does not lose an observed duplicate behind a trailing response', async () => {
    const { client, server, a } = await connectedPair(version);
    server.onSubscribe = (id) => { void server.acceptSubscribe(id, 77n); };
    try {
      const sub = await client.subscribeTrack(ns('live'), nm('video'));
      const stream = requestStream(server, sub.requestId);
      const pipe = a.bidiOut[0]!.in;
      pipe.faults.hold = true;
      await stream.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await stream.writeMessage({ type: 'REQUEST_OK', parameters: new Map() });
      await stream.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      pipe.releaseHeld();
      await flush(32);
      expect(a.closeInfo?.closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    } finally { await client.close(); await server.close(); }
  });

  it('reclaims an accepted FETCH when GOAWAY resets its request stream', async () => {
    const { client, server } = await connectedPair(version);
    server.onFetch = () => {};
    try {
      const id = await client.fetch(ns('live'), nm('video'), {
        startGroup: 0n, startObject: 0n, endGroup: 1n, endObject: 0n,
      } as never);
      await flush(32);
      await server.acceptFetch(id, { endLocation: { group: 1n, object: 0n } });
      await flush(32);
      expect(client.session.getFetch(id)?.responseReceived).toBe(true);
      await requestStream(server, id).writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush(32);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
      expect(client.session.getFetch(id)).toBeUndefined();
    } finally { await client.close(); await server.close(); }
  });

  it('preserves an accepted FETCH after a genuine request-stream FIN', async () => {
    const { client, server } = await connectedPair(version);
    server.onFetch = () => {};
    try {
      const id = await client.fetch(ns('live'), nm('video'), {
        startGroup: 0n, startObject: 0n, endGroup: 1n, endObject: 0n,
      } as never);
      await flush(32);
      await server.acceptFetch(id, { endLocation: { group: 1n, object: 0n } });
      await flush(32);
      expect(client.session.getFetch(id)?.responseReceived).toBe(true);
      await (requestStream(server, id) as unknown as { finish(): Promise<void> }).finish();
      await flush(32);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
      expect(client.session.getFetch(id)?.responseReceived).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
