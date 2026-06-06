/**
 * Deterministic fault-injection — draft-14 / draft-16 (legacy single-bidi-control
 * topology). Mirrors the draft-18 fault slice where the legacy topology makes
 * sense:
 *   - 1-byte write chunking over the full seeded scenario — semantically
 *     transparent (same trace hash as an unfaulted run) and deterministic;
 *   - a truncating FIN on the shared control stream — §3.2 says the control stream
 *     MUST NOT close mid-session, so the receiver closes with PROTOCOL_VIOLATION.
 *
 * Topology-aware: the draft-18-only "no post-SETUP uni-control leak" invariant does
 * NOT apply here (draft-14/16 multiplex requests on the bidi control stream), and
 * the runner already gates that invariant off for these versions.
 */
import { describe, it, expect } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { runScenario } from './testkit/scenario.js';
import { SessionState, SubscriptionState } from '@moqt/transport';

const CHUNK1 = { a: { chunkSize: 1 }, b: { chunkSize: 1 } } as const;

/** Pump the microtask queue until `pred()` holds (bounded). */
async function flushUntil(pred: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) await flush();
}

for (const version of [16, 14] as const) {
  describe(`draft-${version} faults — write chunking (semantically transparent)`, () => {
    it('seeded scenario under 1-byte chunking holds every invariant and is deterministic', async () => {
      // The full legacy op set runs over a transport delivering one byte per read.
      // Every runner invariant must still hold, and the trace hash must match a
      // re-run AND an unfaulted run of the same seed (chunking changes framing, not
      // semantics).
      const faulted1 = await runScenario({ seed: 3n, steps: 30, version, faults: CHUNK1 });
      const faulted2 = await runScenario({ seed: 3n, steps: 30, version, faults: CHUNK1 });
      const clean = await runScenario({ seed: 3n, steps: 30, version });
      expect(faulted2.hash).toBe(faulted1.hash);
      expect(faulted1.hash).toBe(clean.hash);
      expect(faulted1.log.length).toBe(clean.log.length);
    });
  });

  describe(`draft-${version} faults — control-stream truncating FIN`, () => {
    it('a FIN partway through the SUBSCRIBE_OK on the shared control stream closes the session with PROTOCOL_VIOLATION', async () => {
      const { client, server, a, errors } = await connectedPair(version);
      let closed: { code?: number; reason?: string } | undefined;
      client.onClose = (code, reason) => { closed = { code, reason }; };

      let rid = -1n;
      server.onSubscribe = (r) => { rid = r; };
      // Subscribe rides the shared control stream. The pending subscribeTrack
      // promise MUST reject when the session closes — a caller must never hang.
      let rejected = false;
      const subP = client
        .subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } })
        .then(() => { /* unexpected resolve */ }, () => { rejected = true; });
      await flushUntil(() => rid !== -1n);

      // Truncate the SUBSCRIBE_OK response with a FIN one byte in. The CLIENT reads
      // the shared control stream via the control read loop; a FIN there mid-session
      // is a PROTOCOL_VIOLATION (§3.2: the control stream MUST NOT be closed).
      const controlIn = a.bidiOut[0]!.in; // server → client direction of the control stream
      controlIn.faults.finAfterBytes = controlIn.writtenBytes().length + 1;
      await server.acceptSubscribe(rid, 9n);
      await flushUntil(() => closed !== undefined);
      await subP; // must settle (reject), not hang

      expect(rejected).toBe(true);                                     // pending subscribe rejected
      expect(closed?.code).toBe(0x3);                                  // PROTOCOL_VIOLATION
      expect(client.session.state).not.toBe(SessionState.ESTABLISHED); // session closed
      // No dangling session-level subscription state after the close.
      const cs = client.session.getSubscription(rid);
      expect(cs === undefined || cs.state !== SubscriptionState.ESTABLISHED).toBe(true);
      expect(errors.every((e) => e instanceof Error)).toBe(true);      // nothing threw out of band
    });
  });
}
