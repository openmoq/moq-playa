import { describe, it, expect } from 'vitest';
import { MediaPublisher } from './media-publisher.js';
import type { MediaPublishConnection, MediaPublisherOptions } from './media-publisher.js';
import { parseLocHeaders, locWireProfileForDraft } from '@moqt/loc';

const wrapInt = (n: bigint) => n;

interface SendRecord { streamId: bigint; objectId: bigint; payload: Uint8Array; extensions?: Uint8Array }

/**
 * Records every publication call. `holdSends` makes sendObject return
 * promises that resolve only when the test releases them — the WebCodecs
 * backpressure scenario where chunk callbacks outpace the network.
 */
function recordingConnection(opts: { holdSends?: boolean; holdCloses?: boolean } = {}) {
  const opened: Array<{ alias: bigint; groupId: bigint; streamId: bigint; options: Record<string, unknown> }> = [];
  const sends: SendRecord[] = [];
  const closed: bigint[] = [];
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const pendingCloses: Array<() => void> = [];
  let nextStream = 100n;
  const conn: MediaPublishConnection & {
    opened: typeof opened; sends: typeof sends; closed: typeof closed;
    pendingCount: () => number;
    rejectAllPending: (e: Error) => Promise<void>;
    releaseCloses: () => Promise<void>;
    releaseLastClose: () => Promise<void>;
    releaseAll: () => Promise<void>;
  } = {
    opened, sends, closed,
    openSubgroup: async (alias, groupId, _subgroupId, options) => {
      const streamId = nextStream++;
      opened.push({ alias: alias as bigint, groupId: groupId as bigint, streamId, options });
      return streamId;
    },
    sendObject: (streamId, objectId, payload, extensions) => {
      sends.push({ streamId, objectId: objectId as bigint, payload, ...(extensions ? { extensions } : {}) });
      if (!opts.holdSends) return Promise.resolve();
      return new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
    closeSubgroup: (streamId) => {
      closed.push(streamId);
      if (!opts.holdCloses) return Promise.resolve();
      return new Promise<void>((resolve) => { pendingCloses.push(resolve); });
    },
    pendingCount: () => pending.length,
    rejectAllPending: async (e) => {
      while (pending.length > 0) pending.shift()!.reject(e);
      await new Promise((r) => setTimeout(r, 0));
    },
    releaseCloses: async () => {
      while (pendingCloses.length > 0) pendingCloses.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    },
    releaseLastClose: async () => {
      pendingCloses.pop()?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    releaseAll: async () => {
      // Chained sends only become pending after the previous one resolves —
      // keep releasing until a full macrotask passes with nothing pending.
      for (let quiet = 0; quiet < 2;) {
        while (pending.length > 0) pending.shift()!.resolve();
        while (pendingCloses.length > 0) pendingCloses.shift()!();
        await new Promise((r) => setTimeout(r, 0));
        quiet = pending.length === 0 && pendingCloses.length === 0 ? quiet + 1 : 0;
      }
    },
  };
  return conn;
}

const chunk = (tag: number) => new Uint8Array([tag]);
const kf = (timestampUs = 1_000) => ({ isKeyframe: true, timestampUs });
const delta = (timestampUs = 2_000) => ({ isKeyframe: false, timestampUs });
const makePublisher = (conn: MediaPublishConnection, opts: Partial<MediaPublisherOptions> = {}) =>
  new MediaPublisher(conn, { wrapInt, draft: 16, ...opts });

async function settle() { await new Promise((r) => setTimeout(r, 0)); }

describe('MediaPublisher — serialized video publication', () => {
  it('back-to-back chunks with deferred sends get UNIQUE, ORDERED object IDs on one subgroup', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);

    // WebCodecs delivers three chunks synchronously while the first send is
    // still in flight — the exact interleaving that made unserialized
    // handlers reuse an object ID.
    pub.publishVideo(chunk(0), kf());
    pub.publishVideo(chunk(1), delta());
    pub.publishVideo(chunk(2), delta());

    await conn.releaseAll();

    expect(conn.opened).toHaveLength(1); // one keyframe → one subgroup
    expect(conn.sends.map((s) => s.objectId)).toEqual([0n, 1n, 2n]);
    expect(conn.sends.map((s) => s.payload[0])).toEqual([0, 1, 2]); // enqueue order preserved
    expect(new Set(conn.sends.map((s) => s.streamId)).size).toBe(1);
  });

  it('a keyframe queued behind in-flight deltas rotates the group AFTER they complete — no premature close', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // group A, object 0
    pub.publishVideo(chunk(1), delta());  // group A, object 1
    pub.publishVideo(chunk(2), kf());   // rotates to group B
    await conn.releaseAll();

    expect(conn.opened).toHaveLength(2);
    const [groupA, groupB] = conn.opened;
    expect(groupB!.groupId).toBe(groupA!.groupId + 1n);
    // Group A's stream closed only at rotation — after BOTH its sends landed.
    expect(conn.closed).toEqual([groupA!.streamId]);
    const bySend = conn.sends.map((s) => [s.streamId, s.objectId]);
    expect(bySend).toEqual([
      [groupA!.streamId, 0n],
      [groupA!.streamId, 1n],
      [groupB!.streamId, 0n], // object ID reset for the new group
    ]);
  });

  it('chunks before the first keyframe are skipped without opening a stream', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), delta());
    await settle();
    expect(conn.opened).toHaveLength(0);
    expect(conn.sends).toHaveLength(0);
  });

  it('a FAILED keyframe send retires the subgroup: deltas are dropped until the next keyframe opens a fresh group at Object 0', async () => {
    // LOC: Object 0 of a subgroup must be the independent frame. Publishing a
    // dependent frame as Object 0 after a failed keyframe send would produce
    // a malformed group — the subgroup must be retired instead.
    const conn = recordingConnection();
    let failNext = true;
    const realSend = conn.sendObject.bind(conn);
    conn.sendObject = (sid, oid, payload) => {
      const p = realSend(sid, oid, payload);
      if (failNext) { failNext = false; return Promise.reject(new Error('write blew up')); }
      return p;
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // keyframe — send FAILS
    pub.publishVideo(chunk(1), delta());  // dependent frame — must be DROPPED
    pub.publishVideo(chunk(2), kf());   // next keyframe — fresh group recovers
    pub.publishVideo(chunk(3), delta());  // dependent frame in the NEW group
    await settle();

    expect(errors).toEqual(['video publish: write blew up']);
    const brokenStream = conn.opened[0]!.streamId;
    // The broken subgroup was retired (closed) and never carried another send.
    expect(conn.closed).toContain(brokenStream);
    const successful = conn.sends.slice(1); // index 0 is the failed attempt
    expect(successful.every((x) => x.streamId !== brokenStream)).toBe(true);
    // The delta between the failure and the next keyframe never went out.
    expect(successful.map((x) => x.payload[0])).toEqual([2, 3]);
    // The fresh group starts at Object 0 with the INDEPENDENT frame.
    expect(successful.map((x) => x.objectId)).toEqual([0n, 1n]);
    expect(conn.opened).toHaveLength(2);
    expect(conn.opened[1]!.groupId).toBe(conn.opened[0]!.groupId + 1n);
  });

  it('a failed ROTATION open cannot revive the previous stream: deltas drop until a keyframe opens successfully', async () => {
    const conn = recordingConnection();
    let failOpen = false;
    const realOpen = conn.openSubgroup.bind(conn);
    conn.openSubgroup = (alias, groupId, subgroupId, options) => {
      if (failOpen) { failOpen = false; return Promise.reject(new Error('open refused')); }
      return realOpen(alias, groupId, subgroupId, options);
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // group A opens, object 0
    await settle();                     // group A is established before the flag flips
    failOpen = true;
    pub.publishVideo(chunk(1), kf());   // rotation: A closed, NEW open FAILS
    pub.publishVideo(chunk(2), delta());  // must be dropped — NOT sent on A
    pub.publishVideo(chunk(3), kf());   // next keyframe recovers on group C
    await settle();

    expect(errors).toEqual(['video publish: open refused']);
    const streamA = conn.opened[0]!.streamId;
    expect(conn.closed).toContain(streamA);
    // Nothing was ever sent on A after its rotation close — the slot was
    // cleared BEFORE the open, so the failure could not revive it.
    const afterRotation = conn.sends.slice(1);
    expect(afterRotation.every((x) => x.streamId !== streamA)).toBe(true);
    expect(afterRotation.map((x) => [x.payload[0], x.objectId])).toEqual([[3, 0n]]);
  });

  it('a throwing onError sink is contained: later chunks publish and stop() resolves', async () => {
    const conn = recordingConnection();
    let failNext = true;
    const realSend = conn.sendObject.bind(conn);
    conn.sendObject = (sid, oid, payload) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('write blew up')); }
      return realSend(sid, oid, payload);
    };
    const pub = makePublisher(conn, {
      onError: () => { throw new Error('error sink itself blew up'); },
    });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());   // fails → onError throws → must not poison the chain
    pub.publishVideo(chunk(1), kf());   // fresh keyframe must still publish
    await settle();
    expect(conn.sends.filter((x) => x.payload[0] === 1)).toHaveLength(1);
    await expect(pub.stop()).resolves.toBeUndefined();
  });
});

describe('MediaPublisher — audio publication', () => {
  it('a failed audio send still closes its stream (best-effort terminal cleanup) and the next chunk recovers', async () => {
    const conn = recordingConnection();
    let failNext = true;
    const realSend = conn.sendObject.bind(conn);
    conn.sendObject = (sid, oid, payload) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('audio write blew up')); }
      return realSend(sid, oid, payload);
    };
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(0), { timestampUs: 500 });
    pub.publishAudio(chunk(1), { timestampUs: 500 });
    await settle();
    expect(errors).toEqual(['audio publish: audio write blew up']);
    // BOTH streams were closed — the failed one via best-effort cleanup.
    expect(conn.closed.sort()).toEqual([conn.opened[0]!.streamId, conn.opened[1]!.streamId].sort());
    expect(conn.sends.filter((x) => x.payload[0] === 1)).toHaveLength(1);
  });

  it('publishes one object per group on sequential group IDs', async () => {
    const conn = recordingConnection();
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);
    pub.publishAudio(chunk(0), { timestampUs: 500 });
    pub.publishAudio(chunk(1), { timestampUs: 500 });
    await settle();
    expect(conn.opened).toHaveLength(2);
    expect(conn.opened[1]!.groupId).toBe(conn.opened[0]!.groupId + 1n);
    expect(conn.sends.map((s) => s.objectId)).toEqual([0n, 0n]);
    expect(conn.closed).toEqual([conn.opened[0]!.streamId, conn.opened[1]!.streamId]);
  });
});

describe('MediaPublisher — broadcast generations', () => {
  it('stop() drains deterministically: in-flight work completes, queued work is dropped, late enqueues are ignored', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);

    pub.publishVideo(chunk(0), kf());   // becomes in flight (held)
    pub.publishVideo(chunk(1), delta());  // queued, not started
    await settle();                     // let the first send actually start

    let stopResolved = false;
    const stopPromise = pub.stop().then(() => { stopResolved = true; });
    await settle();
    expect(stopResolved).toBe(false);   // waits for the in-flight send

    await conn.releaseAll();
    await stopPromise;

    // The held send completed; the queued chunk was dropped at drain.
    expect(conn.sends.map((s) => s.payload[0])).toEqual([0]);
    // The open subgroup was closed by stop().
    expect(conn.closed).toEqual([conn.opened[0]!.streamId]);

    pub.publishVideo(chunk(9), kf());   // late enqueue after stop
    await settle();
    expect(conn.sends).toHaveLength(1);
  });

  it('a deferred rotation close is TRACKED: drain does not resolve until it settles', async () => {
    const conn = recordingConnection({ holdCloses: true });
    const pub = makePublisher(conn);
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());   // group A
    pub.publishVideo(chunk(1), kf());   // rotation: close(A) HELD, group B opens
    await settle();
    expect(conn.closed).toHaveLength(1); // close(A) initiated, still pending

    pub.retire();
    let drained = false;
    const drainPromise = pub.drain().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false);

    // Drain also closes the still-open group B — settle THAT close first, so
    // the ONLY thing left outstanding is the rotation close of A. A drain
    // that fired-and-forgot the rotation close would resolve right here.
    await conn.releaseLastClose();
    await settle();
    expect(drained).toBe(false);        // the rotation close is part of the drain

    await conn.releaseCloses();         // settles close(A)
    await drainPromise;
    expect(conn.closed).toEqual(expect.arrayContaining([conn.opened[0]!.streamId, conn.opened[1]!.streamId]));
  });

  it('a never-settling send does not wedge shutdown: retirement is synchronous and connection closure unblocks the drain', async () => {
    const conn = recordingConnection({ holdSends: true });
    const errors: string[] = [];
    const pub = makePublisher(conn, { onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`) });
    pub.setVideoAlias(2n);
    pub.publishVideo(chunk(0), kf());
    await settle();
    expect(conn.pendingCount()).toBe(1); // the send is stalled

    // The main.ts shutdown order: retire synchronously, close the connection
    // (which rejects in-flight writes), THEN drain — never the reverse.
    pub.retire();
    const drainPromise = pub.drain();
    await conn.rejectAllPending(new Error('connection closed'));
    await expect(drainPromise).resolves.toBeUndefined();
    expect(errors).toEqual(['video publish: connection closed']);
  });

  it('two-cycle restart: the new generation never publishes through a stale alias, the old one never touches the new session', async () => {
    // Cycle 1: broadcast on connection A with aliases bound.
    const connA = recordingConnection();
    const pubA = makePublisher(connA);
    pubA.setVideoAlias(2n);
    pubA.setAudioAlias(3n);
    pubA.publishVideo(chunk(0), kf());
    pubA.publishAudio(chunk(1), { timestampUs: 500 });
    await settle();
    expect(connA.sends).toHaveLength(2);
    await pubA.stop();

    // Cycle 2: a FRESH publisher on connection B — aliases start unset.
    const connB = recordingConnection();
    const pubB = makePublisher(connB);

    // Encoders can fire before the relay subscribes on the new session; a
    // stale-alias publication here was the reported defect.
    pubB.publishVideo(chunk(2), kf());
    pubB.publishAudio(chunk(3), { timestampUs: 500 });
    await settle();
    expect(connB.opened).toHaveLength(0);
    expect(connB.sends).toHaveLength(0);

    // Once the new session's aliases bind, publication resumes — on B only.
    pubB.setVideoAlias(7n);
    pubB.publishVideo(chunk(4), kf());
    await settle();
    expect(connB.opened).toHaveLength(1);
    expect(connB.opened[0]!.alias).toBe(7n);
    expect(connB.sends).toHaveLength(1);

    // The old generation stays inert even if something still holds it.
    pubA.publishVideo(chunk(5), kf());
    await settle();
    expect(connA.sends).toHaveLength(2); // unchanged — nothing new on the old session
  });
});

describe('MediaPublisher — negotiated-draft wire binding', () => {
  it('draft-18 subgroup opens set FIRST_OBJECT on video AND audio; 16/14 do not', async () => {
    for (const draft of [14, 16, 18] as const) {
      const conn = recordingConnection();
      const pub = makePublisher(conn, { draft });
      pub.setVideoAlias(2n);
      pub.setAudioAlias(3n);
      pub.publishVideo(chunk(0), kf());
      pub.publishAudio(chunk(1), { timestampUs: 500 });
      await settle();
      expect(conn.opened).toHaveLength(2);
      for (const o of conn.opened) {
        if (draft === 18) {
          expect(o.options['firstObject']).toBe(true); // §2.2 MUST for the original publisher
        } else {
          expect('firstObject' in o.options).toBe(false); // d14/16 bytes preserved
        }
      }
    }
  });

  it('draft-18 LOC extensions use the vi64 profile: they parse as d18 and are NOT d16 bytes', async () => {
    const timestampUs = Date.now() * 1000; // a current capture timestamp
    const conn18 = recordingConnection();
    const pub18 = makePublisher(conn18, { draft: 18 });
    pub18.setVideoAlias(2n);
    pub18.publishVideo(chunk(7), { isKeyframe: true, timestampUs });
    await settle();

    const ext = conn18.sends[0]!.extensions;
    expect(ext).toBeDefined();
    const parsed = parseLocHeaders(ext, { wireProfile: locWireProfileForDraft(18) });
    expect(parsed.captureTimestamp).toBe(BigInt(Math.round(timestampUs)));
    expect(parsed.videoFrameMarking?.independent).toBe(true);

    // The same publisher under draft 16 emits DIFFERENT bytes (QUIC-varint
    // profile) — proving the profile is draft-bound, not fixed.
    const conn16 = recordingConnection();
    const pub16 = makePublisher(conn16, { draft: 16 });
    pub16.setVideoAlias(2n);
    pub16.publishVideo(chunk(7), { isKeyframe: true, timestampUs });
    await settle();
    const ext16 = conn16.sends[0]!.extensions;
    expect(Buffer.from(ext16!).equals(Buffer.from(ext!))).toBe(false);
    const parsed16 = parseLocHeaders(ext16, { wireProfile: locWireProfileForDraft(16) });
    expect(parsed16.captureTimestamp).toBe(BigInt(Math.round(timestampUs)));
  });
});

describe('MediaPublisher — bounded backpressure', () => {
  it('video: sustained chunks far beyond the cap stay bounded; recovery is a keyframe at Object 0', async () => {
    const conn = recordingConnection({ holdSends: true });
    const errors: string[] = [];
    const pub = makePublisher(conn, {
      videoQueueMax: 10,
      onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`),
    });
    pub.setVideoAlias(2n);

    // One keyframe starts a group; its send is held. 500 deltas pour in.
    pub.publishVideo(chunk(0), kf());
    await settle();
    for (let i = 0; i < 500; i++) pub.publishVideo(chunk(1), delta());

    // Enqueued state is BOUNDED: nothing beyond the cap is retained.
    expect((pub as unknown as { videoQueue: unknown[] }).videoQueue.length).toBeLessThanOrEqual(10);
    expect(errors.filter((e) => /overflow/.test(e)).length).toBeGreaterThanOrEqual(1);

    // A post-overflow delta is dropped; the next keyframe recovers.
    pub.publishVideo(chunk(2), delta());
    pub.publishVideo(chunk(3), kf());
    pub.publishVideo(chunk(4), delta());
    await conn.releaseAll();

    // Continuity: after the overflow, publication resumes at a keyframe with
    // Object 0 on a fresh group — never a dependent as Object 0.
    const groups = new Map<bigint, bigint[]>();
    for (const s of conn.sends) {
      const arr = groups.get(s.streamId) ?? [];
      arr.push(s.objectId);
      groups.set(s.streamId, arr);
    }
    for (const objectIds of groups.values()) {
      expect(objectIds[0]).toBe(0n); // every subgroup starts at Object 0
      for (let i = 1; i < objectIds.length; i++) expect(objectIds[i]).toBe(objectIds[i - 1]! + 1n);
    }
    // The dropped post-overflow delta (payload 2) never went out.
    expect(conn.sends.some((s) => s.payload[0] === 2)).toBe(false);
    // Total sends stayed bounded (cap + recovery frames, not 500).
    expect(conn.sends.length).toBeLessThanOrEqual(15);
  });

  it('audio: sustained chunks far beyond the cap stay bounded, dropping the OLDEST', async () => {
    const conn = recordingConnection({ holdSends: true });
    const errors: string[] = [];
    const QUEUE_MAX = 8;
    const MAX_IN_FLIGHT = 4;
    const pub = makePublisher(conn, {
      audioQueueMax: QUEUE_MAX,
      audioMaxInFlight: MAX_IN_FLIGHT,
      onError: (ctx, err) => errors.push(`${ctx}: ${(err as Error).message}`),
    });
    pub.setAudioAlias(3n);

    pub.publishAudio(chunk(0), { timestampUs: 0 }); // held in flight
    await settle();
    for (let i = 1; i <= 300; i++) pub.publishAudio(new Uint8Array([i % 250]), { timestampUs: i });

    expect((pub as unknown as { audioQueue: unknown[] }).audioQueue.length).toBeLessThanOrEqual(QUEUE_MAX);
    expect(errors.some((e) => /audio queue overflow/.test(e))).toBe(true);

    await conn.releaseAll();
    // Bounded delivery: at most the concurrency cap plus one queue's worth
    // ever reaches the wire from a 300-chunk burst.
    expect(conn.sends.length).toBeLessThanOrEqual(QUEUE_MAX + MAX_IN_FLIGHT);
    // Recency policy: the LAST enqueued chunk survived the drops.
    expect(conn.sends[conn.sends.length - 1]!.payload[0]).toBe(300 % 250);
  });
});

describe('MediaPublisher — audio publication concurrency', () => {
  it('publishes independent audio chunks CONCURRENTLY (serializing them starves the live edge)', async () => {
    // Each audio chunk is its own group on its own stream, so there is no
    // ordering dependency forcing one in-flight operation. Serializing them
    // caps throughput at ~1/(open+send+close latency) per chunk, which is
    // far below the ~50 chunks/sec a 20ms opus encoder produces — observed
    // live as ~3x audio decimation against a real relay.
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);

    for (let i = 0; i < 5; i++) pub.publishAudio(chunk(i), { timestampUs: i * 20_000 });
    await settle();

    // All five reached the wire concurrently rather than queueing behind one.
    expect(conn.sends).toHaveLength(5);
    expect(conn.opened).toHaveLength(5);
    // Group IDs stay unique and monotonic despite the concurrency.
    const groups = conn.opened.map((o) => o.groupId);
    expect(new Set(groups).size).toBe(5);
    for (let i = 1; i < groups.length; i++) expect(groups[i]).toBe(groups[i - 1]! + 1n);

    await conn.releaseAll();
    expect(conn.closed).toHaveLength(5); // every stream FINed
  });

  it('bounds audio concurrency: a sustained burst never exceeds the in-flight cap', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn, { audioMaxInFlight: 4, audioQueueMax: 100 });
    pub.setAudioAlias(3n);

    for (let i = 0; i < 50; i++) pub.publishAudio(chunk(i), { timestampUs: i * 20_000 });
    await settle();

    // Concurrency is capped — this is backpressure, not an unbounded fan-out
    // of simultaneous streams.
    expect(conn.sends).toHaveLength(4);
    await conn.releaseAll();
    // The rest drained through as slots freed.
    expect(conn.sends.length).toBeGreaterThan(4);
  });

  it('drain() awaits every concurrent audio send in flight', async () => {
    const conn = recordingConnection({ holdSends: true });
    const pub = makePublisher(conn);
    pub.setAudioAlias(3n);
    for (let i = 0; i < 3; i++) pub.publishAudio(chunk(i), { timestampUs: i });
    await settle();

    pub.retire();
    let drained = false;
    const drainPromise = pub.drain().then(() => { drained = true; });
    await settle();
    expect(drained).toBe(false); // three sends still in flight

    await conn.releaseAll();
    await drainPromise;
    expect(drained).toBe(true);
  });
});
