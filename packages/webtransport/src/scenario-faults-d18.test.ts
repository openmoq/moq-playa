/**
 * Deterministic fault-injection scenarios (draft-18).
 *
 * The first transport-chaos slice: seeded, validly-malformed transport behavior
 * over the real loopback, with precise oracles for the expected close/error and
 * cleanup. Faults are deterministic functions of the bytes written (no timers, no
 * randomness), so every case reproduces byte-for-byte. The op surface is NOT
 * expanded here — these are hand-authored fault cases, not new random ops.
 *
 * Oracles exercised (grounded in the adapter's documented behavior):
 *   - write chunking is semantically transparent (delivery + trace hash unchanged);
 *   - a peer RESET *or* a truncating FIN of a request stream mid-response fails
 *     THAT request (rejects the subscribe, one onError) but does NOT close the
 *     session;
 *   - a RESET of a uni data stream is a benign lifecycle event (no onError, the
 *     subscription stays active, the object is simply not delivered)…
 *   - …whereas a clean FIN that leaves an object incomplete is a truncated object
 *     → PROTOCOL_VIOLATION close (the meaningful RESET-vs-FIN distinction);
 *   - a protocol violation on a data stream closes the session with
 *     PROTOCOL_VIOLATION (onClose 0x3);
 *   - no unhandled rejections; no post-SETUP uni-control leakage.
 */
import { describe, it, expect } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { runScenario } from './testkit/scenario.js';
import { SessionState, SubscriptionState } from '@moqt/transport';
import type { MoqtObject } from '@moqt/transport';

const CHUNK1 = { a: { chunkSize: 1 }, b: { chunkSize: 1 } } as const;

/** Pump the microtask queue until `pred()` holds (bounded) — robust under chunking. */
async function flushUntil(pred: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) await flush();
}

describe('draft-18 faults — write chunking (semantically transparent)', () => {
  it('1-byte write chunking: subscribe → accept → object still delivers exactly; no onError, no control leak', async () => {
    const { client, server, a, b, errors } = await connectedPair(18, { faults: CHUNK1 });
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;

    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const recv: MoqtObject[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flushUntil(() => rid !== -1n); // chunked SUBSCRIBE needs many pumps to arrive
    await server.acceptSubscribe(rid, 9n);
    const sub = await subP;
    expect(sub.trackAlias).toBe(9n);

    const sid = await server.openSubgroup(9n, 7n, 0n, { publisherPriority: 3 });
    await server.sendObject(sid, 0n, new Uint8Array([0xaa, 0xbb]));
    await server.closeSubgroup(sid);
    await flushUntil(() => recv.length >= 1);

    expect(recv.length).toBe(1);
    if (recv[0]!.kind === 'data') expect(recv[0]!.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
    // No post-SETUP uni-control leak even when chunked.
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('seeded scenario under 1-byte chunking holds all invariants and is deterministic', async () => {
    // The full op set runs over a transport that delivers one byte per read. Every
    // scenario invariant (no onError, exact delivery, alias cleanup, no leak) must
    // still hold, and the trace hash must match a re-run (deterministic replay) and
    // an UNFAULTED run of the same seed (chunking changes framing, not semantics).
    const faulted1 = await runScenario({ seed: 7n, steps: 40, version: 18, faults: CHUNK1 });
    const faulted2 = await runScenario({ seed: 7n, steps: 40, version: 18, faults: CHUNK1 });
    const clean = await runScenario({ seed: 7n, steps: 40, version: 18 });
    expect(faulted2.hash).toBe(faulted1.hash);
    expect(faulted1.hash).toBe(clean.hash);
    expect(faulted1.log.length).toBe(clean.log.length);
  });
});

describe('draft-18 faults — request-stream RESET mid-response', () => {
  it('a peer RESET of the SUBSCRIBE response stream rejects the subscribe and surfaces onError ONCE; the session stays up and local state is cleaned', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    let rejected = false;
    const subP = client
      .subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } })
      .then(() => { /* unexpected resolve */ }, () => { rejected = true; });
    await flush();

    // Arm a RESET on the server→client response pipe after 1 byte, then let the
    // server write SUBSCRIBE_OK — the client sees a truncated, reset response.
    const responsePipe = a.bidiOut[0]!.in;
    responsePipe.faults.resetAfterBytes = 1;
    responsePipe.faults.resetCode = 7;
    await server.acceptSubscribe(rid, 9n);
    await flush();
    await subP;

    expect(rejected).toBe(true);                                  // the request failed
    expect(client.session.state).toBe(SessionState.ESTABLISHED);  // session NOT closed
    expect(client.session.getSubscription(rid)).toBeUndefined();  // local sub state cleaned
    expect(client.session.getTrackByAlias(9n)).toBeUndefined();   // no alias bound
    // The reset reaches the adapter via BOTH the response-consumer path and the
    // uniPair onStreamError hook (same Error instance) — de-duped to exactly ONE
    // onError. A per-request failure, never a session close.
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(Error);
    // No request/response leaked onto the uni control stream during the failure.
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);
  });

  it('a NO-WAITER stream failure (RESET after the response was consumed) still fires onError exactly once', async () => {
    // After the SUBSCRIBE_OK is consumed, the request stream resets with no pending
    // response — only the uniPair onStreamError path fires. The dedupe must NOT
    // suppress this lone report: onError fires exactly once, session stays up.
    const { client, server, a, errors } = await connectedPair();
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const sub = await (async () => {
      const p = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
      await flushUntil(() => rid !== -1n);
      await server.acceptSubscribe(rid, 4n);
      return p;
    })();
    expect(sub.trackAlias).toBe(4n);
    expect(errors).toEqual([]); // clean so far

    // Reset the request stream now — no response is pending (it was consumed).
    a.bidiOut[0]!.in.reset(3);
    await flush();

    expect(errors.length).toBe(1); // surfaced once via onStreamError, not suppressed
    expect(errors[0]).toBeInstanceOf(Error);
    expect(client.session.state).toBe(SessionState.ESTABLISHED); // session not closed
  });
});

describe('draft-18 faults — uni data-stream RESET mid-object (benign)', () => {
  it('a RESET of a data stream after the header drops the object without onError; the subscription stays active', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const recv: MoqtObject[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();
    await server.acceptSubscribe(rid, 5n);
    await subP;

    // A first object delivers normally.
    let sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([0x01]));
    await server.closeSubgroup(sid);
    await flush();
    expect(recv.length).toBe(1);

    // Second subgroup: arm a RESET one byte into the OBJECT (header already written),
    // then send — the object is truncated and the stream reset.
    sid = await server.openSubgroup(5n, 2n, 0n, { publisherPriority: 1 });
    const dataPipe = b.uniOut[b.uniOut.length - 1]!;
    dataPipe.faults.resetAfterBytes = dataPipe.writtenBytes().length + 1; // header + 1 object byte
    dataPipe.faults.resetCode = 1;
    await server.sendObject(sid, 0n, new Uint8Array([0xde, 0xad]));
    await server.closeSubgroup(sid);
    await flush();

    expect(recv.length).toBe(1);                                  // truncated object NOT delivered
    expect(errors).toEqual([]);                                   // RESET is a benign lifecycle event
    expect(client.session.state).toBe(SessionState.ESTABLISHED);  // session unaffected
    expect(client.session.getSubscription(rid)?.state).toBe(SubscriptionState.ESTABLISHED); // sub still active
    expect(client.session.getTrackByAlias(5n)).toBeDefined();     // alias still registered
    // No control-stream leak from a data-plane reset.
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);
  });
});

describe('draft-18 faults — protocol violation on a data stream', () => {
  it('a malformed subgroup header (reserved subgroup-ID mode 0b11) closes the session with PROTOCOL_VIOLATION', async () => {
    const { client, b, errors } = await connectedPair();
    let closed: { code?: number; reason?: string } | undefined;
    client.onClose = (code, reason) => { closed = { code, reason }; };

    // Inject a malformed data stream from the peer: a subgroup-form type byte (bit4
    // set) whose subgroup-ID mode bits are the reserved 0b11 (0x16) →
    // decodeSubgroupHeader18 throws ProtocolViolationError → the receiver MUST close
    // the session with PROTOCOL_VIOLATION (§11.4.2).
    const writable = await b.createUnidirectionalStream();
    const writer = writable.getWriter();
    await writer.write(Uint8Array.from([0x16, 0x00, 0x00, 0x00]));
    await writer.close();
    await flush();

    expect(closed?.code).toBe(0x3);                              // PROTOCOL_VIOLATION
    expect(client.session.state).not.toBe(SessionState.ESTABLISHED); // session closed
    // The violation is reported via onClose; any onError is incidental — assert no THROW escaped.
    expect(errors.every((e) => e instanceof Error)).toBe(true);
  });
});

describe('draft-18 faults — request-stream truncating FIN mid-response', () => {
  it('a truncated SUBSCRIBE_OK (FIN mid-frame) fails the request, not the session; state cleaned, one onError', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    let rejected = false;
    const subP = client
      .subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } })
      .then(() => { /* unexpected resolve */ }, () => { rejected = true; });
    await flush();

    // Deliver 1 byte of the SUBSCRIBE_OK then cleanly FIN — a truncated control
    // message. The request stream ends before its response completes.
    a.bidiOut[0]!.in.faults.finAfterBytes = 1;
    await server.acceptSubscribe(rid, 9n);
    await flush();
    await subP;

    expect(rejected).toBe(true);                                  // request failed
    expect(client.session.state).toBe(SessionState.ESTABLISHED);  // session NOT closed (per-request failure)
    expect(client.session.getSubscription(rid)).toBeUndefined();  // local sub state cleaned
    expect(client.session.getTrackByAlias(9n)).toBeUndefined();   // no alias bound
    expect(errors.length).toBe(1);                                // surfaced once (de-duped)
    expect(errors[0]).toBeInstanceOf(Error);
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);    // no uni-control leak
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);
  });
});

describe('draft-18 faults — uni data-stream truncating FIN mid-object', () => {
  it('a FIN partway through an object is a truncated object → PROTOCOL_VIOLATION close (distinct from a benign RESET)', async () => {
    const { client, server, b, errors } = await connectedPair();
    let closed: { code?: number; reason?: string } | undefined;
    client.onClose = (code, reason) => { closed = { code, reason }; };
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const recv: MoqtObject[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();
    await server.acceptSubscribe(rid, 5n);
    await subP;

    // First object delivers normally.
    let sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([0x01]));
    await server.closeSubgroup(sid);
    await flush();
    expect(recv.length).toBe(1);

    // Second subgroup: cleanly FIN one byte into the OBJECT (header already written).
    // Unlike a RESET (a publisher abandoning a stream — benign), a clean FIN that
    // leaves an object incomplete is a malformed data stream, so the receiver MUST
    // close the session with PROTOCOL_VIOLATION (§10.4 / §11.4.2).
    sid = await server.openSubgroup(5n, 2n, 0n, { publisherPriority: 1 });
    const dataPipe = b.uniOut[b.uniOut.length - 1]!;
    dataPipe.faults.finAfterBytes = dataPipe.writtenBytes().length + 1; // header + 1 object byte
    await server.sendObject(sid, 0n, new Uint8Array([0xde, 0xad]));
    await server.closeSubgroup(sid);
    await flush();

    expect(recv.length).toBe(1);                                  // truncated object NOT delivered
    expect(closed?.code).toBe(0x3);                              // PROTOCOL_VIOLATION close
    expect(client.session.state).not.toBe(SessionState.ESTABLISHED); // session closed
    expect(errors.every((e) => e instanceof Error)).toBe(true);  // nothing threw out of band
  });
});
