/**
 * draft-14 / draft-16 deterministic scenario suite (clean schedules).
 *
 * Runs the same version-parametric {@link runScenario} oracle as the draft-18
 * suite, but over the legacy single-bidi-control topology. The draft-18-only
 * "no post-SETUP control-stream leakage" invariant is gated off inside the runner
 * (draft-14/16 legitimately carry requests on the bidi control stream).
 *
 * Default counts are smaller than the draft-18 suite to keep `pnpm test` fast;
 * the same SCENARIO_SEEDS / SCENARIO_SEED_START / SCENARIO_STEPS env vars apply.
 */
import { describe, it, expect } from 'vitest';
import { SessionState, SubscriptionState } from '@moqt/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { runScenario } from './testkit/scenario.js';

const SEEDS = Number(process.env.SCENARIO_SEEDS ?? 4);
const SEED_START = BigInt(process.env.SCENARIO_SEED_START ?? 1);
const STEPS = Number(process.env.SCENARIO_STEPS ?? 30);

for (const version of [16, 14] as const) {
  describe(`draft-${version} scenario runner — clean schedules`, () => {
    it(`connectedPair(${version}) establishes over the real loopback`, async () => {
      const { client, server, errors } = await connectedPair(version);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
      expect(server.session.state).toBe(SessionState.ESTABLISHED);
      expect(client.draftVersion).toBe(version);
      expect(server.draftVersion).toBe(version);
      expect(errors).toEqual([]);
    });

    for (let i = 0; i < SEEDS; i++) {
      const seed = SEED_START + BigInt(i);
      it(`seed ${seed} holds all invariants over ${STEPS} steps`, async () => {
        const r = await runScenario({ seed, steps: STEPS, version }); // throws on violation
        expect(typeof r.hash).toBe('bigint');
        expect(r.log.length).toBeGreaterThan(0);
      });
    }

    it('the same seed produces the same trace hash (deterministic replay)', async () => {
      const r1 = await runScenario({ seed: SEED_START, steps: STEPS, version });
      const r2 = await runScenario({ seed: SEED_START, steps: STEPS, version });
      expect(r2.hash).toBe(r1.hash);
      expect(r2.log.length).toBe(r1.log.length);
    });
  });

  describe(`draft-${version} scenario preludes (hand-authored invariants)`, () => {
    it('subscribe → accept → object delivery', async () => {
      const { client, server, errors } = await connectedPair(version);
      let rid = -1n;
      server.onSubscribe = (r) => { rid = r; };
      const delivered: string[] = [];
      const subP = client.subscribeTrack(ns('live'), nm('vid'), {
        onObject: (o) => delivered.push(`${o.groupId}:${o.objectId}`),
      });
      await flush();
      await server.acceptSubscribe(rid, 5n);
      await subP;

      const sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
      await server.sendObject(sid, 0n, new Uint8Array([1]));
      await server.closeSubgroup(sid);
      await flush();
      expect(delivered).toEqual(['1:0']);
      expect(client.session.getSubscription(rid)!.state).toBe(SubscriptionState.ESTABLISHED);
      expect(errors).toEqual([]);
    });

    it('unsubscribe → in-flight bytes may arrive, publisher streams reset, later sends reject (§5.1.1)', async () => {
      const { client, server, errors } = await connectedPair(version);
      let rid = -1n;
      server.onSubscribe = (r) => { rid = r; };
      const delivered: string[] = [];
      const subP = client.subscribeTrack(ns('live'), nm('vid'), {
        onObject: (o) => delivered.push(`${o.groupId}:${o.objectId}`),
      });
      await flush();
      await server.acceptSubscribe(rid, 6n);
      const sub = await subP;

      let sid = await server.openSubgroup(6n, 1n, 0n, { publisherPriority: 1 });
      await server.sendObject(sid, 0n, new Uint8Array([1]));
      await server.closeSubgroup(sid);
      await flush();
      expect(delivered).toEqual(['1:0']);

      // Written BEFORE cancellation — in flight, may arrive.
      sid = await server.openSubgroup(6n, 2n, 0n, { publisherPriority: 1 });
      await server.sendObject(sid, 0n, new Uint8Array([2]));
      await flush();
      expect(delivered).toEqual(['1:0', '2:0']);

      await sub.unsubscribe(); // draft-14/16: sends UNSUBSCRIBE on the control stream
      await flush();
      expect(client.session.getTrackByAlias(6n)).toBeUndefined(); // alias freed
      // §5.1.1: the publisher's open stream was RESET; a later send rejects, and
      // NEW data streams for the terminated subscription are refused.
      await expect(server.sendObject(sid, 1n, new Uint8Array([3]))).rejects.toThrow(/Unknown outgoing stream/);
      await expect(server.openSubgroup(6n, 3n, 0n, { publisherPriority: 1 })).rejects.toThrow(/terminated/);
      expect(delivered).toEqual(['1:0', '2:0']); // nothing after cancel
      expect(errors).toEqual([]);
    });

    it('reject leaves no ESTABLISHED state', async () => {
      const { client, server, errors } = await connectedPair(version);
      let rid = -1n;
      server.onSubscribe = (r) => { rid = r; };
      const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } })
        .catch(() => undefined);
      await flush();
      await server.rejectSubscribe(rid, 1n, 'no');
      await flush();
      await subP;
      const cs = client.session.getSubscription(rid);
      expect(cs === undefined || cs.state !== SubscriptionState.ESTABLISHED).toBe(true);
      expect(errors).toEqual([]);
    });
  });
}

/**
 * Walk a draft-14 control byte stream and return each frame's type code.
 * Frame = Type (i), Length (uint16, big-endian), Payload. Every draft-14
 * control type code in play here is < 0x40, i.e. a single-byte QUIC varint.
 */
function d14FrameTypes(bytes: Uint8Array): number[] {
  const types: number[] = [];
  let pos = 0;
  while (pos + 3 <= bytes.length) {
    const type = bytes[pos]!; // single-byte varint for all control types used here
    const len = (bytes[pos + 1]! << 8) | bytes[pos + 2]!;
    types.push(type);
    pos += 3 + len;
  }
  return types;
}

describe('draft-14 outbound subscribe rejection — wire-level', () => {
  // Draft-14 has no generic REQUEST_ERROR on the wire; a subscribe rejection is
  // a distinct SUBSCRIBE_ERROR (0x05) message. This proves the server actually
  // writes that wire type (not a generic error the draft-14 codec would refuse),
  // and that the rejection still terminates the client subscription cleanly.
  it('writes SUBSCRIBE_ERROR (0x05), rejects the subscribe, no onError / no close', async () => {
    const { client, server, a, errors } = await connectedPair(14);
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    let rejected = false;
    const subP = client
      .subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } })
      .then(() => { /* unexpected resolve */ }, () => { rejected = true; });
    await flush();
    await server.rejectSubscribe(rid, 1n, 'denied');
    await flush();
    await subP;

    // The client opened the bidi control stream, so the server's outbound
    // control bytes are what the client reads on bidiOut[0].in.
    const serverControl = a.bidiOut[0]!.in.writtenBytes();
    const SUBSCRIBE_ERROR = 0x05;
    const SERVER_SETUP = 0x21;
    const frames = d14FrameTypes(serverControl);
    expect(frames).toContain(SERVER_SETUP);     // handshake happened
    expect(frames).toContain(SUBSCRIBE_ERROR);  // specific error wire type, not generic

    expect(rejected).toBe(true);
    const cs = client.session.getSubscription(rid);
    expect(cs === undefined || cs.state !== SubscriptionState.ESTABLISHED).toBe(true);
    expect(errors).toEqual([]); // no onError on either endpoint
    expect(client.session.state).toBe(SessionState.ESTABLISHED); // session not closed
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
  });
});
