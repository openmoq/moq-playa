import { describe, it, expect, vi } from 'vitest';
import { BroadcastSession } from './broadcast-session.js';
import type { BroadcastSessionConnection } from './broadcast-session.js';
import type { BroadcastCatalogParams } from './catalog-publisher.js';

const wrapInt = (n: bigint) => n;

const CATALOG: BroadcastCatalogParams = {
  videoCodec: 'avc1.42001f',
  width: 1280,
  height: 720,
  fps: 30,
  videoBitrate: 2_000_000,
  audio: { sampleRate: 48_000, channels: 1 },
};

function recordingConnection() {
  const calls: string[] = [];
  const accepted: bigint[] = [];
  const sends: Uint8Array[] = [];
  let nextStream = 100n;
  const conn: BroadcastSessionConnection & { calls: typeof calls; accepted: typeof accepted; sends: typeof sends } = {
    calls, accepted, sends,
    acceptSubscribe: async (_requestId, alias) => { calls.push('acceptSubscribe'); accepted.push(alias as bigint); },
    rejectSubscribe: async () => { calls.push('rejectSubscribe'); },
    openSubgroup: async () => { calls.push('openSubgroup'); return nextStream++; },
    sendObject: async (_sid, _oid, payload) => { calls.push('sendObject'); sends.push(payload); },
    closeSubgroup: async () => { calls.push('closeSubgroup'); },
    publishDone: async () => { calls.push('publishDone'); },
    close: async () => { calls.push('close'); },
  };
  return conn;
}

function makeSession(conn: BroadcastSessionConnection, hooks: {
  onCatalogPublished?: (bytes: number) => void;
  onSessionClosed?: (error?: number, reason?: string) => void;
  catalog?: BroadcastCatalogParams;
  shutdownGraceMs?: number;
} = {}) {
  const { catalog, shutdownGraceMs, ...rest } = hooks;
  return new BroadcastSession(conn, {
    catalog: catalog ?? CATALOG,
    publisher: { wrapInt, draft: 16 },
    log: () => {},
    ...(shutdownGraceMs !== undefined ? { shutdownGraceMs } : {}),
    ...rest,
  });
}

async function settle() { await new Promise((r) => setTimeout(r, 0)); }

describe('BroadcastSession — subscription routing', () => {
  it('serves catalog/video/audio on ITS connection with a per-generation alias space, rejects unknown tracks', async () => {
    const conn = recordingConnection();
    const published: number[] = [];
    const session = makeSession(conn, { onCatalogPublished: (b) => published.push(b) });

    session.handleSubscribe(1n, 'catalog');
    session.handleSubscribe(3n, 'video');
    session.handleSubscribe(5n, 'audio');
    session.handleSubscribe(7n, 'bogus');
    await settle();

    expect(conn.accepted).toEqual([1n, 2n, 3n]); // fresh allocator: 1, 2, 3
    expect(conn.calls.filter((c) => c === 'rejectSubscribe')).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(conn.sends).toHaveLength(1); // the catalog object

    // The media aliases actually bound: publication reaches the connection.
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    session.publisher.publishAudio(new Uint8Array([2]), { timestampUs: 2 });
    await settle();
    expect(conn.sends.length).toBeGreaterThanOrEqual(3);
  });
});

describe('BroadcastSession — generation isolation', () => {
  it('a delayed old-generation onSubscribe is inert after shutdown: no accept, no alias consumed, new session untouched', async () => {
    const connA = recordingConnection();
    const sessionA = makeSession(connA);
    sessionA.handleSubscribe(1n, 'video');
    await settle();
    expect(connA.accepted).toEqual([1n]);
    await sessionA.shutdown();

    const connB = recordingConnection();
    const sessionB = makeSession(connB);

    // The OLD session's relay delivers a late SUBSCRIBE — its handler is
    // bound to session A and must do nothing anywhere.
    const callsABefore = connA.calls.length;
    sessionA.handleSubscribe(3n, 'audio');
    await settle();
    expect(connA.calls.length).toBe(callsABefore); // nothing on the old connection
    expect(connB.calls).toHaveLength(0);           // nothing on the new one either

    // The new generation's allocator was not consumed by the old callback.
    sessionB.handleSubscribe(1n, 'video');
    await settle();
    expect(connB.accepted).toEqual([1n]); // still starts at 1
  });

  it('a delayed old-generation onClose cannot stop the replacement broadcast', async () => {
    const connA = recordingConnection();
    const closedA = vi.fn();
    const sessionA = makeSession(connA, { onSessionClosed: closedA });
    await sessionA.shutdown(); // replaced/stopped

    // The old transport dies afterwards — its onClose fires late.
    sessionA.handleClose(0x3, 'stale close');
    expect(closedA).not.toHaveBeenCalled(); // must not trigger UI/broadcast teardown
  });

  it('a CURRENT generation onClose fires the hook exactly once and retires the publisher', async () => {
    const conn = recordingConnection();
    const closed = vi.fn();
    const session = makeSession(conn, { onSessionClosed: closed });
    session.handleSubscribe(1n, 'video');
    await settle();

    session.handleClose(0x3, 'network gone');
    session.handleClose(0x3, 'network gone'); // duplicate delivery
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(0x3, 'network gone');

    // Publication after the close is inert.
    const sendsBefore = conn.sends.length;
    session.publisher.publishVideo(new Uint8Array([9]), { isKeyframe: true, timestampUs: 9 });
    await settle();
    expect(conn.sends.length).toBe(sendsBefore);
  });

  it('an alias accept resolving AFTER retirement never arms the retired publisher', async () => {
    const conn = recordingConnection();
    let releaseAccept!: () => void;
    conn.acceptSubscribe = () => new Promise((resolve) => { releaseAccept = () => resolve(); });
    const session = makeSession(conn);

    session.handleSubscribe(1n, 'video'); // accept in flight
    await session.shutdown();             // generation retired meanwhile
    releaseAccept();
    await settle();

    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle();
    expect(conn.sends).toHaveLength(0); // nothing published on the retired generation
    // The guard itself is pinned white-box: the publisher's stopped latch
    // already drops publishes, so the alias slot staying UNBOUND is the only
    // observable proof the retired continuation did not run.
    expect((session.publisher as unknown as { videoAlias: bigint | null }).videoAlias).toBeNull();
  });

  it('shutdown closes the connection BEFORE draining, so a stalled send cannot wedge it', async () => {
    const conn = recordingConnection();
    let rejectSend!: (e: Error) => void;
    conn.sendObject = (_sid, _oid, _payload) => new Promise((_res, rej) => { rejectSend = rej; });
    // Closing the connection rejects the in-flight write — like a real session.
    const realClose = conn.close.bind(conn);
    conn.close = async () => { await realClose(); rejectSend(new Error('connection closed')); };

    const session = makeSession(conn);
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle(); // the send is now stalled

    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(conn.calls).toContain('close');
  });
});

describe('BroadcastSession — audio-less capture', () => {
  it('rejects an audio subscription when the capture has no audio track', async () => {
    const conn = recordingConnection();
    const { audio: _audio, ...noAudio } = CATALOG;
    const session = makeSession(conn, { catalog: noAudio });
    session.handleSubscribe(1n, 'audio');
    await settle();
    expect(conn.calls).toEqual(['rejectSubscribe']); // never accepted
  });
});

describe('BroadcastSession — shutdown transaction', () => {
  it('is single-flight: concurrent shutdowns share one teardown and one connection close', async () => {
    const conn = recordingConnection();
    const session = makeSession(conn);
    const s1 = session.shutdown();
    const s2 = session.shutdown();
    expect(s2).toBe(s1);
    await s1;
    expect(conn.calls.filter((c) => c === 'close')).toHaveLength(1);
  });

  it('a normal stop FINs the active video subgroup BEFORE closing the connection', async () => {
    const conn = recordingConnection();
    const session = makeSession(conn);
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle(); // a subgroup is now open

    await session.shutdown();
    const finIndex = conn.calls.indexOf('closeSubgroup');
    const closeIndex = conn.calls.indexOf('close');
    expect(finIndex).toBeGreaterThanOrEqual(0);   // the subgroup got its FIN
    expect(closeIndex).toBeGreaterThan(finIndex); // graceful: FIN precedes close
  });

  it('a permanently stalled send still terminates within the grace bound (hard-close unblocks it)', async () => {
    const conn = recordingConnection();
    let rejectSend!: (e: Error) => void;
    conn.sendObject = () => new Promise((_res, rej) => { rejectSend = rej; });
    const realClose = conn.close.bind(conn);
    conn.close = async () => { await realClose(); rejectSend(new Error('connection closed')); };

    const session = makeSession(conn, { shutdownGraceMs: 30 });
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle(); // the send is stalled forever

    const start = Date.now();
    await session.shutdown();
    expect(Date.now() - start).toBeLessThan(1000); // bounded, not wedged
    expect(conn.calls).toContain('close');
  });

  it('shutdown accounts for in-flight catalog publication (session-owned work)', async () => {
    const conn = recordingConnection();
    let releaseCatalogSend!: () => void;
    conn.sendObject = (_sid, _oid, _payload) =>
      new Promise((resolve) => { releaseCatalogSend = () => resolve(); });

    const session = makeSession(conn, { shutdownGraceMs: 5000 });
    session.handleSubscribe(1n, 'catalog'); // catalog send now in flight
    await settle();

    let done = false;
    const shutdownPromise = session.shutdown().then(() => { done = true; });
    await settle();
    expect(done).toBe(false); // waits for the tracked catalog work

    releaseCatalogSend();
    await shutdownPromise;
    expect(conn.calls).toContain('closeSubgroup'); // catalog stream closed
  });

  it('a catalog completion landing after retirement cannot touch a replacement (stale hook suppressed)', async () => {
    const conn = recordingConnection();
    let releaseCatalogSend!: () => void;
    conn.sendObject = (_sid, _oid, _payload) =>
      new Promise((resolve) => { releaseCatalogSend = () => resolve(); });
    const published = vi.fn();
    const session = makeSession(conn, { onCatalogPublished: published, shutdownGraceMs: 5000 });
    session.handleSubscribe(1n, 'catalog');
    await settle();

    const shutdownPromise = session.shutdown();
    releaseCatalogSend();
    await shutdownPromise;
    expect(published).not.toHaveBeenCalled(); // retired: no stale UI mutation
  });
});

describe('BroadcastSession — shutdown is genuinely bounded', () => {
  it('a close() that resolves WITHOUT settling a held write still terminates shutdown', async () => {
    // An earlier version of this test made close() reject the stalled send,
    // which proved that assumption rather than the bound. Here close()
    // resolves cleanly and the write NEVER settles — shutdown must still
    // finish.
    const conn = recordingConnection();
    conn.sendObject = () => new Promise<void>(() => { /* never settles, ever */ });
    const session = makeSession(conn, { shutdownGraceMs: 30 });
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle();

    const start = Date.now();
    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(conn.calls).toContain('close'); // close still guaranteed
  });

  it('a close() that never settles is itself bounded — shutdown still resolves', async () => {
    const conn = recordingConnection();
    conn.close = () => new Promise<void>(() => { /* hangs forever */ });
    const session = makeSession(conn, { shutdownGraceMs: 20 });
    const start = Date.now();
    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('a throwing logger cannot reject shutdown or skip the connection close', async () => {
    const conn = recordingConnection();
    conn.sendObject = () => new Promise<void>(() => {});
    const session = new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 16 },
      log: () => { throw new Error('logger blew up'); },
      shutdownGraceMs: 20,
    });
    session.handleSubscribe(1n, 'video');
    await settle();
    session.publisher.publishVideo(new Uint8Array([1]), { isKeyframe: true, timestampUs: 1 });
    await settle();
    await expect(session.shutdown()).resolves.toBeUndefined();
    expect(conn.calls).toContain('close');
  });

  it('a REJECTING tracked work item cannot reject shutdown', async () => {
    const conn = recordingConnection();
    // The catalog publication transaction rejects (its terminal path runs).
    conn.openSubgroup = async () => { throw new Error('no streams'); };
    const session = makeSession(conn, { shutdownGraceMs: 200 });
    session.handleSubscribe(1n, 'catalog');
    await settle();
    await expect(session.shutdown()).resolves.toBeUndefined();
  });
});

describe('BroadcastSession — option validation', () => {
  it.each([
    ['videoQueueMax', NaN],
    ['videoQueueMax', Infinity],
    ['videoQueueMax', 0],
    ['videoQueueMax', -1],
    ['videoQueueMax', 1.5],
    ['audioQueueMax', NaN],
    ['audioQueueMax', Infinity],
    ['audioQueueMax', 0],
  ])('rejects a non-positive-integer %s of %s at construction', (key, value) => {
    const conn = recordingConnection();
    expect(() => new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 16, [key]: value } as never,
      log: () => {},
    })).toThrow(/must be a positive integer/i);
  });

  it.each([NaN, Infinity, 0, -5])('rejects an invalid shutdownGraceMs of %s', (value) => {
    const conn = recordingConnection();
    expect(() => new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 16 },
      log: () => {},
      shutdownGraceMs: value,
    })).toThrow(/must be a positive/i);
  });

  it('rejects an unsupported draft rather than silently using draft-16 LOC behavior', () => {
    const conn = recordingConnection();
    expect(() => new BroadcastSession(conn, {
      catalog: CATALOG,
      publisher: { wrapInt, draft: 15 as never },
      log: () => {},
    })).toThrow(/draft/i);
  });
});
