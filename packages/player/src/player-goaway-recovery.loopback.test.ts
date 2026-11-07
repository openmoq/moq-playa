import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlCodec, varint } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import type { PlayerError } from './errors.js';
import { MoqtPlayer } from './player.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
// Inspect retained recovery ownership; protocol behavior is judged on the loopback too.
const recoveryRecords = (player: MoqtPlayer) => (player as unknown as {
  livenessRestarts: ReadonlyMap<string, { connection: MoqtConnection }>;
}).livenessRestarts;

function peer(draft: 18 | 22 = 18) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string }> = [];
  server.onSubscribe = (id, _namespace, name) => { requests.push({ id, name: decoder.decode(name) }); };
  let connected: Promise<void> | undefined;
  return {
    a, client, server, requests,
    start() { connected ??= server.connect(b); void connected.catch(() => {}); return a; },
    async close() { await client.close(); await server.close(); await connected?.catch(() => {}); },
  };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] }));
afterEach(() => vi.useRealTimers());

async function playing(draft: 18 | 22 = 18, external = false) {
  const old = peer(draft), candidate = peer(draft);
  let connects = 0, release!: (transport: ReturnType<typeof createLoopback>['a']) => void;
  const heldTransport = new Promise<ReturnType<typeof createLoopback>['a']>(resolve => { release = resolve; });
  const calls: Array<{ name: string; state: string }> = [];
  const subscribe = old.client.subscribe.bind(old.client);
  vi.spyOn(old.client, 'subscribe').mockImplementation((namespace, name, ...rest) => {
    calls.push({ name: decoder.decode(name), state: old.client.session.state });
    return subscribe(namespace, name, ...rest);
  });
  const errors: PlayerError[] = [], arrivals: unknown[] = [], recovery: unknown[] = [];
  if (external) await old.client.connect(old.start());
  const player = new MoqtPlayer({
    url: 'https://relay.invalid/moq', namespace: 'live', draftVersion: draft, catalogBootstrap: 'subscribe',
    ...(external ? { connection: old.client } : {
      createConnection: () => ++connects === 1 ? old.client : candidate.client,
      createTransport: async () => connects === 1 ? old.start() : heldTransport,
    }),
    catalog: { version: 1, tracks: [{ name: 'video', role: 'video', packaging: 'loc', isLive: true,
      codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1 }] },
    disableAudio: true, autoQuality: false, livenessTimeoutMs: 50, livenessResetProbeMs: 40,
    livenessRestartBackoffMs: 5, livenessMaxRestarts: 2, connectionTimeoutMs: 5000,
  });
  player.on('error', event => { errors.push(event.error); });
  player.on('media_object', event => { arrivals.push(event); });
  player.on('recovery_action', event => { recovery.push(event); });
  try {
    await player.load(); await flush(128);
    const request = old.requests.find(item => item.name === 'video');
    expect(request).toBeDefined();
    await old.server.acceptSubscribe(request!.id, 50n); await flush(128); player.play();
    const stream = await old.server.openSubgroup(50n, 0n, 0n);
    await old.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128); player.tick();
    expect(arrivals).toHaveLength(1); expect(player.state).toBe('playing');
    old.server.setLargestLocationProvider(() => ({ group: 0n, object: 0n }));
    return { old, candidate, player, calls, errors, arrivals, recovery, stream,
      connections: () => connects,
      async goaway() {
        await old.server.sendGoaway({ newSessionUri: '', requestId: 100n, timeout: 0n }); await flush(128);
        expect(old.client.session.state).toBe('draining');
      },
      async close() {
        const destroyed = player.destroy(); release(candidate.start()); await destroyed;
        await old.close(); await candidate.close();
      },
    };
  } catch (error) {
    const destroyed = player.destroy(); release(candidate.start()); await destroyed;
    await old.close(); await candidate.close(); throw error;
  }
}

describe.each([18, 22] as const)('graceful recovery ownership draft%i', draft => {
  it('keeps established media while a replacement prepares without issuing draining-session recovery', async () => {
    const f = await playing(draft);
    try {
      await f.goaway(); expect(f.connections()).toBe(2);
      await vi.advanceTimersByTimeAsync(180); await flush(256);
      expect(f.calls.filter(call => call.state === 'draining')).toEqual([]);
      expect(f.recovery).toEqual([]); expect(f.errors).toEqual([]);
      expect(f.old.requests.filter(request => request.name === 'video')).toHaveLength(1);
      expect(f.candidate.requests).toEqual([]);
      await f.old.server.sendObject(f.stream, 1n, Uint8Array.of(2)); await flush(128);
      expect(f.arrivals).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('stops an already-waiting restart before it can replace a draining subscription', async () => {
    const f = await playing(draft);
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const update = f.old.client.requestUpdate.bind(f.old.client);
    vi.spyOn(f.old.client, 'requestUpdate').mockImplementation(async (...args) => {
      const result = await update(...args); entered = true; await held; return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(70); await flush(128);
      expect(entered).toBe(true); expect(f.recovery).toHaveLength(1);
      expect(f.old.server.session.getIncomingSubscription(0n)?.state, 'publisher state before GOAWAY').toBe('established');
      await f.goaway();
      expect([...recoveryRecords(f.player).values()].some(record => record.connection === f.old.client)).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(180); await flush(256);
      expect(f.calls.filter(call => call.state === 'draining')).toEqual([]);
      expect(f.recovery).toHaveLength(1); expect(f.errors).toEqual([]);
      expect(f.old.requests.filter(request => request.name === 'video')).toHaveLength(1);
      const nextStream = await f.old.server.openSubgroup(50n, 1n, 0n);
      await f.old.server.sendObject(nextStream, 0n, Uint8Array.of(2)); await flush(128);
      expect(f.arrivals).toHaveLength(2);
    } finally { release(); await f.close(); }
  });

  it('retires a waiting restart when pause and resume happen before its continuation', async () => {
    const f = await playing(draft);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const update = f.old.client.requestUpdate.bind(f.old.client);
    vi.spyOn(f.old.client, 'requestUpdate').mockImplementation(async (...args) => {
      const result = await update(...args); await held; return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(70); await flush(128);
      expect(f.recovery).toHaveLength(1); expect(recoveryRecords(f.player).size).toBe(1);
      f.player.pause(); expect(recoveryRecords(f.player).size).toBe(0);
      f.player.play(); release();
      await vi.advanceTimersByTimeAsync(180); await flush(256);
      expect(f.recovery).toHaveLength(1); expect(f.errors).toEqual([]);
      expect(f.old.requests.filter(request => request.name === 'video')).toHaveLength(1);
    } finally { release(); await f.close(); }
  });

  it('releases cached recovery ownership on destroy', async () => {
    const f = await playing(draft);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const update = f.old.client.requestUpdate.bind(f.old.client);
    vi.spyOn(f.old.client, 'requestUpdate').mockImplementation(async (...args) => {
      const result = await update(...args); await held; return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(70); await flush(128);
      expect(recoveryRecords(f.player).size).toBe(1);
      await f.player.destroy(); expect(recoveryRecords(f.player).size).toBe(0);
      release(); await vi.advanceTimersByTimeAsync(180); await flush(128);
      expect(f.recovery).toHaveLength(1);
    } finally { release(); await f.close(); }
  });

  it('keeps accepted media after GOAWAY even without automatic migration factories', async () => {
    const f = await playing(draft, true);
    try {
      await f.goaway(); await vi.advanceTimersByTimeAsync(180); await flush(256);
      expect(f.calls.filter(call => call.state === 'draining')).toEqual([]);
      expect(f.recovery).toEqual([]); expect(f.errors).toEqual([]);
      await f.old.server.sendObject(f.stream, 1n, Uint8Array.of(2)); await flush(128);
      expect(f.arrivals).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('still refreshes a starved subscription on an established session', async () => {
    const f = await playing(draft);
    const update = vi.spyOn(f.old.client, 'requestUpdate');
    try {
      await vi.advanceTimersByTimeAsync(70); await flush(128);
      expect(update).toHaveBeenCalled(); expect(f.recovery).toHaveLength(1);
      expect(f.calls.every(call => call.state === 'established')).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});

it('refuses a new draining-session SDK subscription locally while a fresh session can subscribe', async () => {
  const old = peer(), next = peer();
  try {
    await old.client.connect(old.start()); await flush(128);
    await old.server.sendGoaway({ newSessionUri: '', requestId: 0n, timeout: 0n }); await flush(128);
    const streams = old.a.bidiOut.length;
    await expect(old.client.subscribe([encoder.encode('live')], encoder.encode('video'))).rejects.toThrow(/DRAINING/);
    await flush(128); expect(old.a.bidiOut).toHaveLength(streams); expect(old.requests).toEqual([]);
    await next.client.connect(next.start()); await next.client.subscribe([encoder.encode('live')], encoder.encode('video'));
    await flush(128); expect(next.requests.map(request => request.name)).toEqual(['video']);
  } finally { await old.close(); await next.close(); }
});

it('honors the peer catalog Retry Interval before first media', async () => {
  const h = peer(), errors: PlayerError[] = [];
  const player = new MoqtPlayer({ url: 'https://relay.invalid/moq', namespace: 'live', catalogBootstrap: 'subscribe',
    createConnection: () => h.client, createTransport: async () => h.start() });
  player.on('error', event => { errors.push(event.error); });
  try {
    await player.load(); await flush(128); expect(h.requests).toHaveLength(1);
    h.a.bidiOut[0]!.in.injectRead(createControlCodec(18).encode({ type: 'REQUEST_ERROR',
      requestId: varint(h.requests[0]!.id), errorCode: varint(0x10n), retryInterval: varint(1101n), errorReason: 'not published yet' }));
    await flush(256); expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1099); await flush(128); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await flush(256); expect(h.requests).toHaveLength(2);
  } finally { await player.destroy(); await h.close(); }
});
