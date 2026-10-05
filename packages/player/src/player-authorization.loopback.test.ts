import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection, catToken, type AuthorizationContext } from '@openmoq/webtransport';
import { MessageParam, parseAuthorizationToken18, varint } from '@openmoq/transport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import { validateConfig } from './config.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const cat = new Uint8Array([0x84, 0x40, 0xa0, 0x40, 0x40]);

describe('player credential integration', () => {
  it.each(([
    ['main', 'joining', 1], ['candidate', 'joining', 1],
    ['main', 'standalone', 2], ['candidate', 'standalone', 2],
  ] as const).flatMap(row => ([14, 16, 18] as const).map(version => [...row, version] as const)))
  ('%s catalog ignores credentials from a retired %s attempt (%i, draft %i)', async (role, _kind, heldAttempt, version) => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(version);
    const server = new MoqtConnection(version, { role: 'server' });
    const observed = vi.spyOn(server.session, 'handleControlMessage');
    let release!: () => void;
    let fetches = 0;
    await Promise.all([
      client.connect(a, { authorization: { relayUrl: 'https://relay.example/moq', getTokens: context =>
        context.operation === 'FETCH' && ++fetches === heldAttempt
          ? new Promise(resolve => { release = () => resolve([catToken(cat)]); }) : [catToken(cat)],
      } }), server.connect(b, version === 18 ? {} : { maxRequestId: varint(1000n) }),
    ]);
    let alias = 9n;
    server.onSubscribe = rid => { void server.acceptSubscribe(rid, alias++); };
    server.onFetch = () => {};
    const sub = await client.subscribeTrack([encoder.encode('live')], encoder.encode('catalog'));
    const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: 'live', connection: client });
    const internal = player as any;
    internal.connection = client;
    internal.catalogRequestId = sub.requestId;
    try {
      if (role === 'candidate') {
        await client.unsubscribe(sub.requestId);
        await flush();
        internal.beginCatalogRecovery(client);
      }
      const coord = role === 'main' ? internal.createCatalogBootstrap(client) : internal.catalogRecovery.coord;
      await flush();
      coord.start();
      coord.onSubscribeOk({ group: 0n, object: 0n });
      await flush();
      expect(fetches).toBe(1);
      expect((coord as any).attempt?.id).toBe(1);
      coord.onFetchError(1, 'timeout');
      await flush();
      if (heldAttempt === 2) {
        expect(fetches).toBe(2);
        expect((coord as any).attempt?.id).toBe(2);
        coord.onFetchError(2, 'timeout');
        await flush();
      }
      const owner = () => role === 'main' ? internal.bootstrapFetch : internal.catalogRecovery?.fetch ?? null;
      const current = owner();
      if (heldAttempt === 1) expect(current?.attempt).toBe(2);
      else {
        expect(coord.phase).toBe(role === 'main' ? 'fallback-legacy' : 'aborted');
        expect(current).toBeNull();
      }
      const sent = observed.mock.calls.filter(([message]) => message.type === 'FETCH').length;
      expect(sent).toBe(1);
      release();
      await flush();
      expect(owner()).toBe(current);
      expect(observed.mock.calls.filter(([message]) => message.type === 'FETCH')).toHaveLength(sent);
    } finally { release?.(); await player.destroy(); await client.close(); await server.close(); }
  });

  it('the owned connection authorizes catalog, init, media and ordered pause/resume updates', async () => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(18);
    const server = new MoqtConnection(18, { role: 'server' });
    server.setLargestLocationProvider(() => null);
    const observed = vi.spyOn(server.session, 'handleControlMessage');
    const releases: Array<() => void> = [];
    const contexts: AuthorizationContext[] = [];
    const received: string[] = [];
    const errors: unknown[] = [];
    const tasks: Promise<void>[] = [];
    server.onError = error => errors.push(error);
    let nextAlias = 40n;
    const serve = (task: Promise<void>) => { tasks.push(task.catch(error => { errors.push(error); })); };
    server.onSubscribe = (rid, _namespace, track, parameters) => {
      const name = decoder.decode(track);
      received.push(name);
      expect(parseAuthorizationToken18(parameters.get(MessageParam.AUTHORIZATION_TOKEN)![0])).toMatchObject({ tokenType: 1n, tokenValue: cat });
      const alias = nextAlias++;
      serve((async () => {
        await server.acceptSubscribe(rid, alias, name === 'catalog'
          ? { parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 0n, object: 0n }]]]) } : {});
        if (name === 'init') {
          const sid = await server.openSubgroup(alias, 0n, 0n);
          await server.sendObject(sid, 0n, new Uint8Array([1, 2, 3]));
          await server.closeSubgroup(sid);
        }
      })());
    };
    server.onFetch = rid => serve((async () => {
      const range = server.resolveJoiningFetch(rid);
      await server.acceptFetch(rid, { endLocation: range.endLocation });
      const sid = await server.openFetchStream(rid);
      await server.sendFetchObject(sid, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 0,
        payload: encoder.encode(JSON.stringify({ version: 'draft-01', tracks: [{
          name: 'video', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1,
          codec: 'avc1.42c01e', width: 640, height: 480, bitrate: 300000, initTrack: 'init',
        }] })) });
      await server.closeFetchStream(sid);
    })());
    const mediaSource = { initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(),
      reset: vi.fn(), mediaElement: null, destroy: vi.fn(), changeType: vi.fn(async () => {}),
      onFirstFrame: null, onError: null, onStall: null };
    const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: 'live/test', draftVersion: 18,
      createConnection: () => client, createTransport: async () => a,
      createMediaSource: () => mediaSource,
      createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(), setInitSegment: vi.fn(), clearPending: vi.fn() }),
      authorization: { getTokens: ctx => {
        contexts.push(ctx);
        return ctx.operation === 'REQUEST_UPDATE'
          ? new Promise(resolve => releases.push(() => resolve([catToken(cat)]))) : [catToken(cat)];
      } },
    });
    const connectingServer = server.connect(b);
    try {
      await player.load();
      await connectingServer;
      await vi.waitFor(() => expect(received).toEqual(expect.arrayContaining(['catalog', 'init', 'video'])));
      expect(contexts[0]).toMatchObject({ operation: 'SETUP', relayUrl: 'https://relay.example/moq' });
      expect(contexts.filter(ctx => ctx.operation === 'FETCH')).toHaveLength(1);
      expect(contexts.find(ctx => ctx.operation === 'FETCH')?.trackName).toEqual(encoder.encode('catalog'));
      player.play();
      player.pause();
      player.play();
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      expect(contexts.filter(ctx => ctx.operation === 'REQUEST_UPDATE').every(ctx => decoder.decode(ctx.trackName) === 'video')).toBe(true);
      releases[1]!();
      await flush();
      expect(observed.mock.calls.some(([message]) => message.type === 'REQUEST_UPDATE')).toBe(false);
      releases[0]!();
      await vi.waitFor(() => {
        const updates = observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE');
        expect(updates.map(message => message.parameters.get(MessageParam.FORWARD)?.[0])).toEqual([0n, 1n]);
        expect(errors).toEqual([]);
      });
      await Promise.all(tasks);
      expect(errors).toEqual([]);
    } finally { releases.forEach(release => release()); await player.destroy(); await server.close(); }
  });

  it('destroy cancels a pending SETUP provider without emitting any MoQ bytes', async () => {
    const { a } = createLoopback();
    const client = new MoqtConnection(18);
    let signal!: AbortSignal;
    const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: 'live/test', draftVersion: 18,
      createConnection: () => client, createTransport: async () => a,
      authorization: { getTokens: ctx => { signal = ctx.signal; return new Promise(() => {}); } },
    });
    const loading = player.load();
    const failed = expect(loading).rejects.toThrow('closed');
    await flush();
    await player.destroy();
    await failed;
    expect(signal.aborted).toBe(true);
    expect(a.uniOut).toHaveLength(0);
    expect(a.bidiOut).toHaveLength(0);
  });

  it('refuses to silently ignore credentials on an externally owned connection', () => {
    expect(() => validateConfig({ url: 'https://relay.example/moq', namespace: 'live/test', connection: new MoqtConnection(18),
      authorization: { getTokens: () => [catToken(cat)] },
    })).toThrow('externally owned');
  });

  it('rejects a null player authorization configuration instead of ignoring it', () => {
    expect(() => validateConfig({ url: 'https://relay.example/moq', namespace: 'live/test',
      authorization: null as unknown as import('./config.js').PlayerAuthorization,
    })).toThrow('authorization');
  });
});
