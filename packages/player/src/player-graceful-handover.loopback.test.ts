/** Subscriber switchover ordering: transport drafts 16/18/22, sections 8.4.1/9.4.1/7.4.1. */
import { describe, expect, it, vi } from 'vitest';
import { encodeFetchHeader, encodeFetchObject, encodeSubgroupHeader, encodeSubgroupHeader18,
  encodeSubgroupObject, encodeSubgroupObject18, locationEncodingLength, MessageParam,
  SubgroupFlags, SubgroupIdMode, varint, writeLocation } from '@openmoq/transport';
import type { Fetch, Parameters as MessageParameters } from '@openmoq/transport';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { audioInit, buildChunk, buildInit, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

const OLD_URL = 'https://old.example/moq';
const NEW_URL = 'https://new.example/moq';
const enc = new TextEncoder();
const dec = new TextDecoder();
type Draft = 16 | 18 | 22;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function peer(draft: Draft, catalogName = 'catalog') {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft);
  const server = new MoqtConnection(draft, { role: 'server' });
  const requests: Array<{ id: bigint; name: string; parameters?: MessageParameters }> = [];
  const fetches: Array<{ id: bigint; message: Fetch }> = [];
  const stopped: bigint[] = [];
  const errors: Error[] = [];
  server.onError = error => { errors.push(error); };
  server.onSubscribe = (id, _ns, name, parameters) => {
    requests.push({ id, name: dec.decode(name), ...(parameters ? { parameters } : {}) });
  };
  server.onFetch = (id, message) => { fetches.push({ id, message }); };
  server.onSubscribeClosed = id => { stopped.push(id); };
  const aliases = new Map<string, bigint>();
  let started: Promise<void> | null = null;
  const close = vi.spyOn(client, 'close');
  return {
    client, server, requests, fetches, stopped, errors, close, transport: a,
    start() {
      // A factory resolved after destroy: return its transport for orphan
      // cleanup, without starting a peer handshake nobody can answer.
      if (client.session.state === 'closed') return a;
      started ??= server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {});
      void started.catch(error => { errors.push(error); });
      return a;
    },
    async holdAcceptance(name: string) {
      await flush(256);
      const index = requests.findIndex(r => r.name === name);
      expect(index, `${name} has a request stream`).toBeGreaterThanOrEqual(0);
      const pipe = a.bidiOut[draft === 16 ? 0 : index]!.in;
      pipe.faults.hold = true;
      return async () => { pipe.releaseHeld(); await flush(256); };
    },
    async accept(name: string, alias: bigint, largest?: { group: bigint; object: bigint }) {
      await flush(256);
      const request = requests.find(r => r.name === name);
      expect(request, `replacement requested ${name}`).toBeDefined();
      let options;
      if (largest) {
        const location = { group: varint(largest.group), object: varint(largest.object) };
        const bytes = new Uint8Array(locationEncodingLength(location));
        writeLocation(location, bytes, 0);
        options = { parameters: new Map([[MessageParam.LARGEST_OBJECT, [draft === 16 ? bytes : location]]]) as MessageParameters };
      }
      await server.acceptSubscribe(request!.id, alias, options);
      aliases.set(name, alias);
      await flush(128);
    },
    async bootstrap(payload: Uint8Array, finish = true) {
      await this.accept(catalogName, 100n, { group: 5n, object: 0n });
      const request = requests.find(r => r.name === catalogName)!;
      let complete: () => Promise<void>;
      if (draft === 22) {
        expect(request.parameters?.get(0x23n)?.[0]).toEqual(Uint8Array.of(1, 0x21, 1, 1));
        expect(fetches).toEqual([]);
        const stream = await server.openFillStream(request.id);
        await server.sendFetchObject(stream, { groupId: 5n, subgroupId: 0n, objectId: 0n,
          publisherPriority: 128, payload });
        complete = () => server.closeFetchStream(stream);
      } else {
        expect(fetches).toHaveLength(1);
        expect(fetches[0]!.message.fetch).toMatchObject({ fetchType: 2, joiningRequestId: request.id });
        await server.acceptFetch(fetches[0]!.id, { endLocation: { group: 5n, object: 1n } });
        if (draft === 16) {
          // The adapter's serving API is draft-18+, but its legacy decoder is
          // exercised with the actual draft-16 encoder on a real uni stream.
          const writer = (await b.createUnidirectionalStream()).getWriter();
          await writer.write(encodeFetchHeader({ requestId: varint(fetches[0]!.id) }));
          await writer.write(encodeFetchObject({ flags: varint(0x1c), groupId: varint(5), subgroupId: varint(0),
            objectId: varint(0), publisherPriority: 128, isDatagram: false, extensions: undefined, payload }));
          complete = () => writer.close();
        } else {
          const stream = await server.openFetchStream(fetches[0]!.id);
          await server.sendFetchObject(stream, { groupId: 5n, subgroupId: 0n, objectId: 0n,
            publisherPriority: 128, payload });
          complete = () => server.closeFetchStream(stream);
        }
      }
      if (finish) await complete();
      await flush(256);
      return complete;
    },
    async reject(name: string) {
      const request = requests.find(r => r.name === name);
      expect(request, `replacement requested ${name}`).toBeDefined();
      await server.rejectSubscribe(request!.id, 0x10n, 'track unavailable');
      await flush(128);
    },
    async send(name: string, payload: Uint8Array, group = 1n) {
      const alias = aliases.get(name);
      expect(alias, `${name} has an accepted alias`).toBeDefined();
      const stream = await server.openSubgroup(alias!, group, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, payload);
      await server.closeSubgroup(stream);
      await flush(128);
    },
    async sendUnbound(alias: bigint, payload: Uint8Array, group: bigint) {
      const header = {
        typeByte: SubgroupFlags.SUBGROUP_MARKER | (SubgroupIdMode.EXPLICIT << 1),
        trackAlias: varint(alias), groupId: varint(group), subgroupId: varint(0),
        publisherPriority: 128, hasExtensions: false, isEndOfGroup: false,
        isFirstObjectInSubgroup: false,
      };
      const object = { objectId: varint(0), extensions: undefined, payload, status: undefined };
      const writer = (await b.createUnidirectionalStream()).getWriter();
      await writer.write(draft === 16 ? encodeSubgroupHeader(header) : encodeSubgroupHeader18(header));
      await writer.write(draft === 16
        ? encodeSubgroupObject(object, false, varint(0), true)
        : encodeSubgroupObject18(object, false, 0n, true));
      await writer.close();
      await flush(256);
    },
    async goaway(uri = NEW_URL) {
      const nextId = requests.reduce((max, r) => r.id > max ? r.id : max, 0n) + 2n;
      await server.sendGoaway({ newSessionUri: uri, ...(draft === 18 ? { requestId: nextId, timeout: 0n } : {}) });
      await flush(128);
    },
    async destroy() {
      await client.close();
      await server.close();
      await started?.catch(() => {});
    },
  };
}

function catalog(separateInit = false, version: 1 | 'draft-01' = 1) {
  return enc.encode(JSON.stringify({ version, tracks: [
    { name: 'video', role: 'video', packaging: 'cmaf', isLive: true, renderGroup: 1,
      codec: 'avc1.640028', width: 640, height: 360, bitrate: 800_000,
      ...(separateInit ? { initTrack: 'init-video' } : { initData: Buffer.from(videoInit()).toString('base64') }) },
    { name: 'audio', role: 'audio', packaging: 'cmaf', isLive: true, renderGroup: 1,
      codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128_000,
      initData: Buffer.from(audioInit()).toString('base64') },
  ] }));
}

function catalogWithVideoInitRef(data: string) {
  const replacement = JSON.parse(dec.decode(catalog(false, 'draft-01'))) as {
    version: string; tracks: Array<Record<string, unknown>>;
  };
  const video = replacement.tracks.find(track => track['role'] === 'video')!;
  delete video['initData'];
  video['initRef'] = 'replacement-video';
  return enc.encode(JSON.stringify({ ...replacement, initDataList: [
    { id: 'replacement-video', type: 'inline', data },
  ] }));
}

function chunk(media: 'video' | 'audio', group: bigint) {
  return buildChunk({ trackId: media === 'video' ? 1 : 2, bmdt: group * 9000n,
    samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0) });
}

async function fixture(draft: Draft, options: {
  holdTransport?: boolean;
  silentCandidate?: boolean;
  defaultBootstrap?: boolean;
  oldSeparateInit?: boolean;
  oldCatalog?: Uint8Array;
  replacementFactoryError?: Error;
  config?: Partial<MoqtPlayerConfig>;
} = {}) {
  const catalogName = options.config?.catalogTrackName ?? 'catalog';
  const old = peer(draft, catalogName);
  const next = peer(draft, catalogName);
  const third = peer(draft, catalogName);
  const transportGate = deferred<typeof next.transport>();
  const transportCalls: string[] = [];
  const received: Array<{ name: string; group: bigint }> = [];
  const errors: string[] = [];
  const fatalErrors: string[] = [];
  const migrated = vi.fn();
  const closed = vi.fn();
  const updated = vi.fn();
  const media = (['video', 'audio'] as const).filter(type => type === 'video'
    ? !options.config?.disableVideo : !options.config?.disableAudio);
  let connections = 0;
  const player = new MoqtPlayer({
    url: OLD_URL, namespace: 'live/handover', draftVersion: draft,
    createConnection: () => {
      const connection = [old, next, third][connections++]!.client as unknown as PlayerConnection;
      if (connections > 1 && options.replacementFactoryError) throw options.replacementFactoryError;
      return connection;
    },
    createTransport: url => {
      transportCalls.push(url);
      if (transportCalls.length === 1) return Promise.resolve(old.start());
      if (transportCalls.length === 3) return Promise.resolve(third.start());
      if (options.holdTransport) return transportGate.promise;
      if (options.silentCandidate) return Promise.resolve(next.transport);
      return Promise.resolve(next.start());
    },
    // These cases isolate handover from catalog retrieval policy. Default
    // joining-FETCH/FILL bootstrap is verified separately, not bypassed in production.
    ...(options.defaultBootstrap ? {} : { catalogBootstrap: 'subscribe' as const }),
    createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
      endOfStream: () => {}, destroy: () => {}, mediaElement: null,
      onFirstFrame: null, onError: null, onStall: null }),
    createCmafAssembler: callbacks => ({
      push: (mediaType, track, group, payload) => callbacks.onSegment(mediaType, payload, track, group),
      getEpoch: () => null, reset: () => {}, destroy: () => {},
    }),
    ...options.config,
  });
  player.on('media_object', event => { received.push({ name: event.trackName, group: event.groupId }); });
  player.on('error', event => {
    errors.push(event.error.message);
    if (event.error.severity === 'fatal') fatalErrors.push(event.error.message);
  });
  player.on('session_migrated', migrated);
  player.on('session_closed', closed);
  player.on('catalog_updated', updated);
  const destroy = async () => {
    await player.destroy();
    transportGate.resolve(next.transport);
    await flush(256);
    await old.destroy();
    await next.destroy();
    await third.destroy();
  };
  try {
    await player.load();
    if (options.defaultBootstrap) await old.bootstrap(catalog(options.oldSeparateInit, 'draft-01'));
    else {
      await old.accept(catalogName, 100n);
      await old.send(catalogName, options.oldCatalog ?? catalog(options.oldSeparateInit));
    }
    if (options.oldSeparateInit) {
      await old.accept('init-video', 202n);
      await old.send('init-video', videoInit());
    }
    for (const type of media) {
      await old.accept(type, type === 'video' ? 200n : 201n);
      await old.send(type, chunk(type, 1n));
      expect(received).toContainEqual({ name: type, group: 1n });
    }
    expect(errors).toEqual([]);
  } catch (error) {
    await destroy();
    throw error;
  }
  const stoppedBeforeHandover = [...old.stopped];
  for (const request of old.requests.filter(r => media.some(type => r.name === type))) {
    expect(stoppedBeforeHandover).not.toContain(request.id);
  }
  return {
    old, next, third, player, received, errors, fatalErrors, migrated, closed, updated, transportCalls,
    transportGate: { resolve: () => transportGate.resolve(next.transport) },
    async oldStillDelivers(group: bigint) {
      expect(old.close).not.toHaveBeenCalled();
      expect(old.stopped).toEqual(stoppedBeforeHandover);
      for (const type of media) {
        await old.send(type, chunk(type, group), group);
        expect(received).toContainEqual({ name: type, group });
      }
    },
    destroy,
  };
}

describe.each([16, 18, 22] as const)('draft-%i graceful session handover', draft => {
  it.each([undefined, '.catalog'])('keeps catalog name %s through default-bootstrap handover', async name => {
    const h = await fixture(draft, { defaultBootstrap: true,
      config: name === undefined ? {} : { catalogTrackName: name } });
    try {
      await h.old.goaway();
      await h.next.bootstrap(catalog(false, 'draft-01'));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.requests[0]!.name).toBe(name ?? 'catalog');
      expect(h.next.requests[0]!.name).toBe(name ?? 'catalog');
      expect(h.errors).toEqual([]);
      await h.next.send('video', chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally { await h.destroy(); }
  });

  it('continues established media while the replacement transport is pending', async () => {
    const h = await fixture(draft, { holdTransport: true });
    try {
      await h.old.goaway();
      expect(h.transportCalls).toEqual([OLD_URL, NEW_URL]);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('does not commit an unanswered catalog subscription', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await flush(256);
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('keeps old media through catalog rejection', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.reject('catalog');
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('keeps old media through a required audio-track rejection', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      await h.next.accept('video', 200n);
      await h.next.reject('audio');
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('waits for required initialization before retiring old playback', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog(true));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await h.next.accept('init-video', 202n);
      await h.next.send('video', chunk('video', 101n), 101n);
      await h.next.send('audio', chunk('audio', 101n), 101n);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.received).not.toContainEqual({ name: 'video', group: 101n });
      expect(h.received).not.toContainEqual({ name: 'audio', group: 101n });
      await h.oldStillDelivers(2n);

      await h.next.send('init-video', videoInit());
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      expect(h.received.filter(event => event.name === 'video' && event.group === 101n)).toHaveLength(1);
      expect(h.received.filter(event => event.name === 'audio' && event.group === 101n)).toHaveLength(1);
      await h.next.send('video', chunk('video', 102n), 102n);
      await h.next.send('audio', chunk('audio', 102n), 102n);
      expect(h.received).toContainEqual({ name: 'video', group: 102n });
      expect(h.received).toContainEqual({ name: 'audio', group: 102n });
      expect(h.errors).toEqual([]);
      expect(h.next.requests.filter(r => r.name === 'video')).toHaveLength(1);
      expect(h.next.requests.filter(r => r.name === 'audio')).toHaveLength(1);
    } finally { await h.destroy(); }
  });

  it('promotes accepted, initialized tracks without subscribing twice', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      await h.next.accept('video', 200n);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
      await h.next.accept('audio', 201n);
      await h.next.send('video', chunk('video', 3n), 3n);
      await h.next.send('audio', chunk('audio', 3n), 3n);
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      expect(h.errors).toEqual([]);
      expect(h.next.requests.map(r => r.name).sort()).toEqual(['audio', 'catalog', 'video']);
      await h.next.send('video', chunk('video', 4n), 4n);
      await h.next.send('audio', chunk('audio', 4n), 4n);
      expect(h.received).toContainEqual({ name: 'video', group: 4n });
      expect(h.received).toContainEqual({ name: 'audio', group: 4n });
    } finally { await h.destroy(); }
  });

  it.each(['video', 'audio'] as const)('does not subscribe to or wait for disabled %s during handover', async disabled => {
    const enabled = disabled === 'video' ? 'audio' : 'video';
    const h = await fixture(draft, { config: disabled === 'video' ? { disableVideo: true } : { disableAudio: true } });
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      expect(h.next.requests.map(r => r.name).sort()).toEqual(['catalog', enabled].sort());
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
      await h.next.accept(enabled, 200n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      await h.next.send(enabled, chunk(enabled, 3n), 3n);
      expect(h.received).toContainEqual({ name: enabled, group: 3n });
      expect(h.received.some(event => event.name === disabled)).toBe(false);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each(['!', ''] as const)('rejects invalid replacement initData %j without changing live playback', async initData => {
    const h = await fixture(draft);
    try {
      const replacement = JSON.parse(dec.decode(catalog()));
      replacement.tracks[0].initData = initData;
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/init|base64/i);
      expect(h.next.close).toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('classifies a replacement catalog before an old media alias with the same number', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 200n);
      await h.next.send('catalog', catalog(), 61n);
      expect(h.received).not.toContainEqual({ name: 'video', group: 61n });
      expect(h.next.requests.map(r => r.name).sort()).toEqual(['audio', 'catalog', 'video']);
      await h.oldStillDelivers(2n);
      await h.next.accept('video', 100n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      await h.next.send('video', chunk('video', 62n), 62n);
      expect(h.received).toContainEqual({ name: 'video', group: 62n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each([100n, 200n])('holds early replacement catalog alias %s until its acceptance', async alias => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      const release = await h.next.holdAcceptance('catalog');
      await h.next.accept('catalog', alias);
      await h.next.send('catalog', catalog(), 61n);
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      expect(h.received).not.toContainEqual({ name: 'video', group: 61n });
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
      await release();
      expect(h.next.requests.map(r => r.name).sort()).toEqual(['audio', 'catalog', 'video']);
      await h.next.accept('video', 300n);
      await h.next.accept('audio', 301n);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      await h.next.send('video', chunk('video', 62n), 62n);
      expect(h.received).toContainEqual({ name: 'video', group: 62n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('stages early replacement media instead of routing through an old alias', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      const release = await h.next.holdAcceptance('video');
      await h.next.accept('video', 200n);
      await h.next.send('video', chunk('video', 61n), 61n);
      expect(h.received).not.toContainEqual({ name: 'video', group: 61n });
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
      await release();
      expect(h.received).not.toContainEqual({ name: 'video', group: 61n });
      await h.next.accept('audio', 201n);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.received.filter(e => e.name === 'video' && e.group === 61n)).toHaveLength(1);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each([200n, 202n])('retains early replacement initialization on alias %s until acceptance', async alias => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog(true));
      await h.next.accept('video', 300n);
      await h.next.accept('audio', 301n);
      const release = await h.next.holdAcceptance('init-video');
      await h.next.accept('init-video', alias);
      await h.next.send('init-video', videoInit(), 61n);
      expect(h.received).not.toContainEqual({ name: 'video', group: 61n });
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
      await release();
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      await h.next.send('video', chunk('video', 62n), 62n);
      expect(h.received).toContainEqual({ name: 'video', group: 62n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('validates an initRef against the replacement catalog rather than the live catalog', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef('!'));
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/init|base64/i);
      expect(h.next.close).toHaveBeenCalled();
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('accepts a valid initRef carried only in the replacement catalog', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(videoInit()).toString('base64')));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      await h.next.send('video', chunk('video', 3n), 3n);
      await h.next.send('audio', chunk('audio', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
      expect(h.received).toContainEqual({ name: 'audio', group: 3n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('rejects invalid separate initialization instead of adopting nonempty bytes', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog(true));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await h.next.accept('init-video', 202n);
      await h.next.send('init-video', Uint8Array.of(1, 2, 3));
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/init/i);
      expect(h.next.close).toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('does not use the old session init cache to satisfy replacement initialization', async () => {
    const h = await fixture(draft, { oldSeparateInit: true });
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog(true));
      expect(h.next.requests.map(r => r.name)).toContain('init-video');
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
      await h.next.accept('init-video', 202n);
      await h.next.send('init-video', videoInit());
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each(['video', 'audio'] as const)('waits for the replacement in-band %s initialization', async mediaType => {
    const h = await fixture(draft);
    try {
      const replacement = JSON.parse(dec.decode(catalog()));
      const track = replacement.tracks.find((value: { role: string }) => value.role === mediaType)!;
      delete track.initData;
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toEqual([]);
      await h.oldStillDelivers(2n);

      await h.next.send(mediaType, mediaType === 'video' ? videoInit() : audioInit(), 0n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      await h.next.send('video', chunk('video', 3n), 3n);
      await h.next.send('audio', chunk('audio', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
      expect(h.received).toContainEqual({ name: 'audio', group: 3n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('declines changed initRef content when the media adapter cannot reconfigure', async () => {
    const replacementInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(replacementInit).toString('base64')));
      // Complete any issued media requests so a premature-adoption bug cannot
      // hide behind an unanswered subscription.
      for (const name of ['video', 'audio'] as const) {
        if (h.next.requests.some(r => r.name === name)) {
          await h.next.accept(name, name === 'video' ? 200n : 201n);
        }
      }
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/init|reconfig/i);
      expect(h.next.close).toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it.each(['inline', 'initRef', 'initTrack'] as const)(
    'reconfigures supported replacement %s initialization before retiring old playback', async mode => {
      const replacementInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
      const reconfigured = deferred<void>();
      const changeType = vi.fn(() => reconfigured.promise);
      const append = vi.fn();
      const setInitSegment = vi.fn();
      const h = await fixture(draft, { config: {
        createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
        createCmafAssembler: callbacks => ({
          push: (mediaType, track, group, payload) => callbacks.onSegment(mediaType, payload, track, group),
          setInitSegment, getEpoch: () => null, reset: () => {}, destroy: () => {},
        }),
      } });
      try {
        append.mockClear();
        setInitSegment.mockClear();
        let replacement = catalog(mode === 'initTrack');
        if (mode === 'initRef') {
          replacement = catalogWithVideoInitRef(Buffer.from(replacementInit).toString('base64'));
        } else if (mode === 'inline') {
          const parsed = JSON.parse(dec.decode(replacement));
          parsed.tracks[0].initData = Buffer.from(replacementInit).toString('base64');
          replacement = enc.encode(JSON.stringify(parsed));
        }
        await h.old.goaway();
        await h.next.accept('catalog', 100n);
        await h.next.send('catalog', replacement);
        await h.next.accept('video', 200n);
        await h.next.send('video', chunk('video', 61n), 61n);
        expect(append).not.toHaveBeenCalled();
        expect(changeType).not.toHaveBeenCalled();
        await h.next.accept('audio', 201n);
        if (mode === 'initTrack') {
          await h.next.accept('init-video', 202n);
          await h.next.send('init-video', replacementInit);
        }
        expect(changeType).toHaveBeenCalledExactlyOnceWith('video', 'avc1.640028', replacementInit);
        expect(h.migrated).not.toHaveBeenCalled();
        expect(h.old.close).not.toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
        // SourceBuffer.changeType queues concurrent appends behind the new
        // init. Old media must not enter that queue with the old timescale.
        await h.old.send('video', chunk('video', 2n), 2n);
        expect(append).not.toHaveBeenCalled();
        reconfigured.resolve();
        await flush(512);
        expect(h.migrated).toHaveBeenCalledTimes(1);
        expect(h.old.close).toHaveBeenCalledTimes(1);
        expect(setInitSegment).toHaveBeenCalledWith('video', replacementInit);
        expect(append).toHaveBeenCalledTimes(1);
        expect(h.received.filter(e => e.name === 'video' && e.group === 61n)).toHaveLength(1);
        expect(h.errors).toEqual([]);
      } finally {
        reconfigured.resolve();
        await h.destroy();
      }
    },
  );

  it('restores video initialization if audio reconfiguration rejects the replacement', async () => {
    const oldVideoInit = videoInit();
    const nextVideoInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const nextAudioInit = buildInit({ trackId: 2, timescale: 44100, handler: 'soun' });
    let configuredVideo = oldVideoInit;
    const changeType = vi.fn(async (type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
      if (type === 'audio') {
        if (Buffer.from(bytes).equals(nextAudioInit)) throw new Error('replacement audio init rejected');
        return;
      }
      configuredVideo = bytes;
    });
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      const replacement = JSON.parse(dec.decode(catalog()));
      replacement.tracks[0].initData = Buffer.from(nextVideoInit).toString('base64');
      replacement.tracks[1].initData = Buffer.from(nextAudioInit).toString('base64');
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(512);
      expect(changeType).toHaveBeenCalledWith('video', 'avc1.640028', nextVideoInit);
      expect(changeType).toHaveBeenCalledWith('audio', 'mp4a.40.2', nextAudioInit);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      expect(configuredVideo).toEqual(oldVideoInit);
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('restores old initialization after a timed-out reconfiguration completes late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const oldVideoInit = videoInit();
    const nextVideoInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const gate = deferred<void>();
    const append = vi.fn();
    let configuredVideo = oldVideoInit;
    const changeType = vi.fn(async (_type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
      if (Buffer.from(bytes).equals(nextVideoInit)) await gate.promise;
      configuredVideo = bytes;
    });
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(draft, { config: {
        connectionTimeoutMs: 50,
        createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
      } });
      const replacement = JSON.parse(dec.decode(catalog()));
      replacement.tracks[0].initData = Buffer.from(nextVideoInit).toString('base64');
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      expect(changeType).toHaveBeenCalledExactlyOnceWith('video', 'avc1.640028', nextVideoInit);
      await vi.advanceTimersByTimeAsync(51);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/timeout/i);
      expect(h.migrated).not.toHaveBeenCalled();
      append.mockClear();
      await h.old.send('video', chunk('video', 2n), 2n);
      expect(append).not.toHaveBeenCalled();
      gate.resolve();
      await flush(512);
      expect(configuredVideo).toEqual(oldVideoInit);
      expect(h.migrated).not.toHaveBeenCalled();
      append.mockClear();
      await h.oldStillDelivers(3n);
      expect(append).toHaveBeenCalledWith('video', expect.any(Uint8Array), 'video', 3n);
    } finally {
      gate.resolve();
      await h?.destroy();
      vi.useRealTimers();
    }
  });

  it('restores a source buffer when the rejected retype already changed its init', async () => {
    const oldAudioInit = audioInit();
    const nextAudioInit = buildInit({ trackId: 2, timescale: 44100, handler: 'soun' });
    let configuredAudio = oldAudioInit;
    const changeType = vi.fn(async (_type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
      configuredAudio = bytes;
      if (Buffer.from(bytes).equals(nextAudioInit)) throw new Error('init append failed after changeType');
    });
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      const replacement = JSON.parse(dec.decode(catalog()));
      replacement.tracks[1].initData = Buffer.from(nextAudioInit).toString('base64');
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(512);
      expect(h.errors).toHaveLength(1);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(configuredAudio).toEqual(oldAudioInit);
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('reports a fatal fault when a partially rejected retype cannot be restored', async () => {
    const oldAudioInit = audioInit();
    const nextAudioInit = buildInit({ trackId: 2, timescale: 44100, handler: 'soun' });
    let configuredAudio = oldAudioInit;
    const changeType = vi.fn(async (_type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
      if (Buffer.from(bytes).equals(nextAudioInit)) {
        configuredAudio = bytes;
        throw new Error('init append failed after changeType');
      }
      throw new Error('old initialization could not be restored');
    });
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      const replacement = JSON.parse(dec.decode(catalog()));
      replacement.tracks[1].initData = Buffer.from(nextAudioInit).toString('base64');
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(512);
      expect(changeType).toHaveBeenCalledTimes(2);
      expect(configuredAudio).toEqual(nextAudioInit);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.fatalErrors).toHaveLength(1);
      expect(h.fatalErrors[0]).toMatch(/restore.*audio|audio.*restore/i);
    } finally { await h.destroy(); }
  });

  it('does not reconfigure a destroyed media source after a late completion', async () => {
    const nextVideoInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const gate = deferred<void>();
    const changeType = vi.fn(async () => { await gate.promise; });
    const sourceDestroyed = vi.fn();
    const setTimestampOffset = vi.fn();
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
        getTimestampOffset: () => 0, setTimestampOffset,
        reset: () => {}, endOfStream: () => {}, destroy: sourceDestroyed, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      setTimestampOffset.mockClear();
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextVideoInit).toString('base64')));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      expect(changeType).toHaveBeenCalledTimes(1);
      await h.player.destroy();
      expect(sourceDestroyed).toHaveBeenCalledTimes(1);
      gate.resolve();
      await flush(512);
      expect(changeType).toHaveBeenCalledTimes(1);
      expect(setTimestampOffset).not.toHaveBeenCalled();
      expect(h.migrated).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await h.destroy();
    }
  });

  it('retains the running timestamp offset when replacement initialization changes', async () => {
    const nextInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    let offset = 0;
    const append = vi.fn();
    const changeType = vi.fn(async () => { offset = 8; });
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
        getTimestampOffset: () => offset,
        setTimestampOffset: (_type, value) => { offset = value; },
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      offset = 1.25;
      append.mockClear();
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextInit).toString('base64')));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(offset).toBe(1.25);
      await h.next.send('video', chunk('video', 3n), 3n);
      expect(append).toHaveBeenCalledWith('video', expect.any(Uint8Array), 'video', 3n);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('does not relabel old media through replacement aliases during retirement', async () => {
    const h = await fixture(draft);
    const retired = deferred<void>();
    h.old.close.mockImplementation(async () => {
      await retired.promise;
      await MoqtConnection.prototype.close.call(h.old.client);
    });
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      await h.next.accept('video', 201n);
      await h.next.accept('audio', 200n);
      await flush(512);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      await h.old.send('video', chunk('video', 71n), 71n);
      expect(h.received).not.toContainEqual({ name: 'audio', group: 71n });
      await h.old.send('audio', chunk('audio', 72n), 72n);
      expect(h.received).not.toContainEqual({ name: 'video', group: 72n });
      await h.next.send('video', chunk('video', 73n), 73n);
      await h.next.send('audio', chunk('audio', 74n), 74n);
      expect(h.received).toContainEqual({ name: 'video', group: 73n });
      expect(h.received).toContainEqual({ name: 'audio', group: 74n });
    } finally {
      retired.resolve();
      await flush(512);
      await h.destroy();
    }
  });

  it('keeps old-format media out of a reconfigured buffer during retirement', async () => {
    const nextInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const append = vi.fn();
    const changeType = vi.fn(async () => {});
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    const retired = deferred<void>();
    h.old.close.mockImplementation(async () => {
      await retired.promise;
      await MoqtConnection.prototype.close.call(h.old.client);
    });
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextInit).toString('base64')));
      await h.next.accept('video', 300n);
      await h.next.accept('audio', 301n);
      await flush(512);
      expect(changeType).toHaveBeenCalledExactlyOnceWith('video', 'avc1.640028', nextInit);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      append.mockClear();
      await h.old.send('video', chunk('video', 71n), 71n);
      expect(append).not.toHaveBeenCalled();
      await h.next.send('video', chunk('video', 72n), 72n);
      expect(append).toHaveBeenCalledWith('video', expect.any(Uint8Array), 'video', 72n);
    } finally {
      retired.resolve();
      await flush(512);
      await h.destroy();
    }
  });

  it('does not retain old aliases when replacement requests reuse the same ids', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      await h.next.accept('video', 300n);
      await h.next.accept('audio', 301n);
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      const oldVideoRequest = h.old.requests.find(r => r.name === 'video')!;
      const nextVideoRequest = h.next.requests.find(r => r.name === 'video')!;
      expect(nextVideoRequest.id).toBe(oldVideoRequest.id);

      // An unbound alias on this session must not inherit a retired session's
      // mapping, even if their request ids happened to match.
      await h.next.sendUnbound(200n, chunk('video', 71n), 71n);
      expect(h.received.some(event => event.group === 71n)).toBe(false);
      await h.next.send('video', chunk('video', 72n), 72n);
      expect(h.received).toContainEqual({ name: 'video', group: 72n });
    } finally { await h.destroy(); }
  });

  it('does not append an old-format transform that completes after adoption', async () => {
    const nextInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const transformed = deferred<void>();
    const append = vi.fn();
    const changeType = vi.fn(async () => {});
    let held = false;
    const h = await fixture(draft, { config: {
      objectTransform: async object => {
        if (object.groupId === 71n) {
          held = true;
          await transformed.promise;
        }
        return object;
      },
      createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      append.mockClear();
      await h.old.send('video', chunk('video', 71n), 71n);
      expect(held).toBe(true);
      expect(append).not.toHaveBeenCalled();
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextInit).toString('base64')));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(changeType).toHaveBeenCalledExactlyOnceWith('video', 'avc1.640028', nextInit);
      transformed.resolve();
      await flush(512);
      expect(append).not.toHaveBeenCalled();
      await h.next.send('video', chunk('video', 72n), 72n);
      expect(append).toHaveBeenCalledWith('video', expect.any(Uint8Array), 'video', 72n);
    } finally {
      transformed.resolve();
      await flush(256);
      await h.destroy();
    }
  });

  it.each(['throw', 'ignore'] as const)(
    'declines a replacement when restoring its timestamp offset fails by %s', async mode => {
      const oldInit = videoInit();
      const nextInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
      let configured = oldInit;
      let offset = 0;
      let failNextRestore = false;
      const append = vi.fn();
      const changeType = vi.fn(async (_type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
        configured = bytes;
        offset = 8;
      });
      const h = await fixture(draft, { config: {
        createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
          getTimestampOffset: () => offset,
          setTimestampOffset: (_type, value) => {
            if (failNextRestore) {
              failNextRestore = false;
              if (mode === 'throw') throw new Error('timestamp offset write refused');
              return;
            }
            offset = value;
          },
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
      } });
      try {
        offset = 1.25;
        failNextRestore = true;
        await h.old.goaway();
        await h.next.accept('catalog', 100n);
        await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextInit).toString('base64')));
        await h.next.accept('video', 200n);
        await h.next.accept('audio', 201n);
        await flush(512);
        expect(h.migrated).not.toHaveBeenCalled();
        expect(h.errors).toHaveLength(1);
        expect(h.fatalErrors).toEqual([]);
        expect(configured).toEqual(oldInit);
        expect(offset).toBe(1.25);
        append.mockClear();
        await h.oldStillDelivers(3n);
        expect(append).toHaveBeenCalledWith('video', expect.any(Uint8Array), 'video', 3n);
      } finally { await h.destroy(); }
    },
  );

  it.each(['throw', 'ignore'] as const)(
    'reports a fatal fault when rollback timestamp restoration fails by %s', async mode => {
      const nextInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
      let offset = 0;
      let failRestores = false;
      const changeType = vi.fn(async (_type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
        offset = 8;
        if (Buffer.from(bytes).equals(nextInit)) throw new Error('replacement init append failed');
      });
      const h = await fixture(draft, { config: {
        createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
          getTimestampOffset: () => offset,
          setTimestampOffset: (_type, value) => {
            if (failRestores) {
              if (mode === 'throw') throw new Error('timestamp offset restore refused');
              return;
            }
            offset = value;
          },
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
      } });
      try {
        offset = 1.25;
        failRestores = true;
        await h.old.goaway();
        await h.next.accept('catalog', 100n);
        await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextInit).toString('base64')));
        await h.next.accept('video', 200n);
        await h.next.accept('audio', 201n);
        await flush(512);
        expect(h.migrated).not.toHaveBeenCalled();
        expect(changeType).toHaveBeenCalledTimes(2);
        expect(offset).toBe(8);
        expect(h.fatalErrors).toHaveLength(1);
        expect(h.fatalErrors[0]).toMatch(/restore|offset/i);
      } finally { await h.destroy(); }
    },
  );

  it('restores earlier retypes when a later timestamp accessor throws', async () => {
    const oldInit = videoInit();
    const nextVideoInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const nextAudioInit = buildInit({ trackId: 2, timescale: 44100, handler: 'soun' });
    let configuredVideo = oldInit;
    let failAudioRead = false;
    const append = vi.fn();
    const changeType = vi.fn(async (type: 'video' | 'audio', _codec: string, bytes: Uint8Array) => {
      if (type === 'video') configuredVideo = bytes;
    });
    const h = await fixture(draft, { config: {
      createMediaSource: () => ({ initialize: () => true, appendChunk: append, changeType,
        getTimestampOffset: type => {
          if (type === 'audio' && failAudioRead) throw new Error('audio offset unavailable');
          return 0;
        },
        setTimestampOffset: () => {},
        reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      failAudioRead = true;
      const replacement = JSON.parse(dec.decode(catalog()));
      replacement.tracks[0].initData = Buffer.from(nextVideoInit).toString('base64');
      replacement.tracks[1].initData = Buffer.from(nextAudioInit).toString('base64');
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', enc.encode(JSON.stringify(replacement)));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(512);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors).toHaveLength(1);
      expect(h.fatalErrors).toEqual([]);
      expect(configuredVideo).toEqual(oldInit);
      append.mockClear();
      await h.oldStillDelivers(3n);
      expect(append).toHaveBeenCalledWith('video', expect.any(Uint8Array), 'video', 3n);
    } finally { await h.destroy(); }
  });

  it.each(['apply', 'restore'] as const)('does not adopt a successor during the %s of an abandoned retype', async phase => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const nextVideoInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const gate = deferred<void>();
    const restore = deferred<void>();
    let calls = 0;
    const changeType = vi.fn(async () => { await (calls++ === 0 ? gate.promise : restore.promise); });
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    let successor: Promise<void> | undefined;
    let successorFailure: unknown;
    try {
      h = await fixture(draft, { config: {
        connectionTimeoutMs: 50,
        createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
      } });
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextVideoInit).toString('base64')));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      expect(changeType).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(51);
      expect(h.errors).toHaveLength(1);
      expect(h.migrated).not.toHaveBeenCalled();
      if (phase === 'restore') {
        gate.resolve();
        await flush(256);
        expect(changeType).toHaveBeenCalledTimes(2);
      }
      // Either reject this attempt as busy or let it prepare without adoption.
      // Neither policy may let it use a buffer another attempt can still mutate.
      successor = h.player.migrate(h.third.client as unknown as PlayerConnection)
        .catch(error => { successorFailure = error; });
      await flush(256);
      if (h.third.requests.some(r => r.name === 'catalog')) {
        await h.third.accept('catalog', 100n);
        await h.third.send('catalog', catalog());
        for (const name of ['video', 'audio'] as const) {
          if (h.third.requests.some(r => r.name === name)) {
            await h.third.accept(name, name === 'video' ? 200n : 201n);
          }
        }
      }
      await flush(256);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.old.close).not.toHaveBeenCalled();
      if (successorFailure !== undefined) {
        expect(String(successorFailure)).toMatch(/already in progress|reconfigur.*(?:pending|progress|busy)/i);
      }
    } finally {
      gate.resolve();
      restore.resolve();
      await h?.destroy();
      await successor;
      vi.useRealTimers();
    }
  });

  it('allows a fresh migration once an abandoned retype has been restored', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const nextVideoInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
    const gate = deferred<void>();
    const changeType = vi.fn(async () => { await gate.promise; });
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(draft, { config: {
        connectionTimeoutMs: 50,
        createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType,
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
      } });
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalogWithVideoInitRef(Buffer.from(nextVideoInit).toString('base64')));
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      expect(changeType).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(51);
      expect(h.errors).toHaveLength(1);
      gate.resolve();
      await flush(512);
      expect(changeType).toHaveBeenCalledTimes(2);
      await h.oldStillDelivers(3n);

      const successor = h.player.migrate(h.third.client as unknown as PlayerConnection)
        .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      await flush(256);
      await h.third.accept('catalog', 100n);
      await h.third.send('catalog', catalog());
      await h.third.accept('video', 200n);
      await h.third.accept('audio', 201n);
      expect(await successor).toEqual({ ok: true });
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      expect(h.errors).toHaveLength(1);
      await h.third.send('video', chunk('video', 101n), 101n);
      expect(h.received).toContainEqual({ name: 'video', group: 101n });
    } finally {
      gate.resolve();
      await h?.destroy();
      vi.useRealTimers();
    }
  });

  it('has a positive control for old-session delivery without a GOAWAY', async () => {
    const h = await fixture(draft);
    try {
      await h.oldStillDelivers(2n);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.transportCalls).toEqual([OLD_URL]);
      expect(h.next.requests).toEqual([]);
      expect(h.old.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('bounds a hung transport factory and closes its late transport without attaching it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(draft, { holdTransport: true, config: { connectionTimeoutMs: 50 } });
      const closeTransport = vi.spyOn(h.next.transport, 'close');
      const connectCandidate = vi.spyOn(h.next.client, 'connect');
      await h.old.goaway();
      await vi.advanceTimersByTimeAsync(51);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/timeout/i);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(closeTransport).not.toHaveBeenCalled();
      h.transportGate.resolve();
      await flush(256);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(connectCandidate).not.toHaveBeenCalled();
      expect(h.next.requests).toEqual([]);
      await h.oldStillDelivers(2n);
    } finally {
      try { await h?.destroy(); } finally { vi.useRealTimers(); }
    }
  });

  it.each(['close', 'error'] as const)('finishes a healthy replacement after an early old-transport %s', async terminal => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      if (terminal === 'close') h.old.transport.close({ closeCode: 0, reason: 'relay drained' });
      else h.old.transport.failClosed(new Error('old relay network lost'));
      await flush(256);
      expect(h.fatalErrors).toEqual([]);
      expect(h.closed).not.toHaveBeenCalled();
      expect(h.next.close).not.toHaveBeenCalled();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await h.next.send('video', chunk('video', 3n), 3n);
      await h.next.send('audio', chunk('audio', 3n), 3n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.fatalErrors).toEqual([]);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
      expect(h.received).toContainEqual({ name: 'audio', group: 3n });
    } finally { await h.destroy(); }
  });

  it('closes an orphan exactly once when factory settlement races the deadline microtasks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(draft, { holdTransport: true, config: { connectionTimeoutMs: 50 } });
      const closeTransport = vi.spyOn(h.next.transport, 'close');
      const connectCandidate = vi.spyOn(h.next.client, 'connect');
      await h.old.goaway();
      // Reject the timer and resolve the factory before either promise reaction
      // runs. The cleanup owner must be the actual race winner, not a side flag
      // whose reaction may run first but whose derived promise settles later.
      vi.advanceTimersByTime(50);
      h.transportGate.resolve();
      await flush(256);
      expect(h.errors).toHaveLength(1);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(connectCandidate).not.toHaveBeenCalled();
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally {
      try { await h?.destroy(); } finally { vi.useRealTimers(); }
    }
  });

  it('closes a resolved factory transport when destroy wins before adapter ownership', async () => {
    const h = await fixture(draft, { holdTransport: true });
    try {
      const closeTransport = vi.spyOn(h.next.transport, 'close');
      const connectCandidate = vi.spyOn(h.next.client, 'connect');
      await h.old.goaway();
      h.transportGate.resolve();
      // The factory's result wins Promise.race, but destroy runs before the
      // awaiting operation resumes and hands that result to the adapter.
      await Promise.resolve().then(() => h.player.destroy());
      await flush(256);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(connectCandidate).not.toHaveBeenCalled();
      expect(h.migrated).not.toHaveBeenCalled();
    } finally { await h.destroy(); }
  });

  it('clears the attempt timer on destroy even if the transport factory has not settled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    let restoreSpies: (() => void) | undefined;
    try {
      h = await fixture(draft, { holdTransport: true, config: { connectionTimeoutMs: 50 } });
      const closeTransport = vi.spyOn(h.next.transport, 'close');
      const schedule = vi.spyOn(globalThis, 'setTimeout');
      const cancel = vi.spyOn(globalThis, 'clearTimeout');
      restoreSpies = () => { schedule.mockRestore(); cancel.mockRestore(); };
      await h.old.goaway();
      const index = schedule.mock.calls.findIndex(([, delay]) => delay === 50);
      expect(index).toBeGreaterThanOrEqual(0);
      const attemptTimer = schedule.mock.results[index]!.value;
      await h.player.destroy();
      await flush(256);
      expect(cancel).toHaveBeenCalledWith(attemptTimer);
      expect(h.migrated).not.toHaveBeenCalled();
      h.transportGate.resolve();
      await flush(256);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(h.next.requests).toEqual([]);
    } finally {
      try { await h?.destroy(); } finally { restoreSpies?.(); vi.useRealTimers(); }
    }
  });

  it.each(['timeout', 'destroy'] as const)('closes an attached candidate once after %s during SETUP authorization', async terminal => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tokens = [{ tokenType: 1n, value: Uint8Array.of(0xab) }];
    const credentials = deferred<typeof tokens>();
    const signals: AbortSignal[] = [];
    let h: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      h = await fixture(draft, { silentCandidate: true, config: {
        connectionTimeoutMs: 50,
        authorization: {
          allowedRelayOrigins: ['https://new.example'],
          timeoutMs: 5000,
          getTokens: context => {
            if (context.relayUrl === NEW_URL && context.operation === 'SETUP') {
              signals.push(context.signal);
              return credentials.promise;
            }
            return tokens;
          },
        },
      } });
      const closeTransport = vi.spyOn(h.next.transport, 'close');
      await h.old.goaway();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      expect(h.next.transport.uniOut).toHaveLength(0);
      expect(h.next.transport.bidiOut).toHaveLength(0);

      if (terminal === 'timeout') await vi.advanceTimersByTimeAsync(51);
      else await h.player.destroy();
      await flush(256);
      expect(signals[0]!.aborted).toBe(true);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      expect(h.migrated).not.toHaveBeenCalled();
      credentials.resolve(tokens);
      await flush(256);
      expect(h.next.transport.uniOut).toHaveLength(0);
      expect(h.next.transport.bidiOut).toHaveLength(0);
      expect(closeTransport).toHaveBeenCalledTimes(1);
      if (terminal === 'timeout') await h.oldStillDelivers(2n);
    } finally {
      credentials.resolve(tokens);
      try { await h?.destroy(); } finally { vi.useRealTimers(); }
    }
  });

  it('waits for default catalog bootstrap completion and adopts its live delta feed', async () => {
    const h = await fixture(draft, { defaultBootstrap: true });
    try {
      await h.old.goaway();
      const complete = await h.next.bootstrap(catalog(false, 'draft-01'), false);
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      await h.oldStillDelivers(2n);
      await complete();
      await flush(256);
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.next.requests.map(r => r.name).sort()).toEqual(['audio', 'catalog', 'video']);
      expect(h.next.fetches).toHaveLength(draft === 22 ? 0 : 1);
      await h.next.send('video', chunk('video', 3n), 3n);
      await h.next.send('audio', chunk('audio', 3n), 3n);
      const live = await h.next.server.openSubgroup(100n, 5n, 0n, { publisherPriority: 128 });
      await h.next.server.sendObject(live, 1n, enc.encode(JSON.stringify({ deltaUpdate: [{ op: 'add', tracks: [
        { name: 'captions', role: 'caption', packaging: 'loc', codec: 'wvtt', renderGroup: 1 },
      ] }] })));
      await h.next.server.closeSubgroup(live);
      await flush(256);
      expect(h.updated).toHaveBeenCalledTimes(1);
      expect(h.updated.mock.calls[0]![0].catalog.tracks.map((t: { name: string }) => t.name)).toContain('captions');
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
      expect(h.received).toContainEqual({ name: 'audio', group: 3n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('uses the adopted endpoint for an empty GOAWAY received during old-session retirement', async () => {
    const h = await fixture(draft);
    const retirement = deferred<void>();
    h.old.close.mockImplementationOnce(() => retirement.promise);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n);
      await h.next.send('catalog', catalog());
      await h.next.accept('video', 200n);
      await h.next.accept('audio', 201n);
      await flush(256);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      await h.next.goaway('');
      retirement.resolve();
      await flush(512);
      expect(h.transportCalls).toEqual([OLD_URL, NEW_URL, NEW_URL]);
    } finally {
      retirement.resolve();
      await h.destroy();
    }
  });

  it('does not send legacy SETUP credentials to a different origin', async () => {
    const h = await fixture(draft, { config: { authTokens: [Uint8Array.of(3, 1, 0xab)] } });
    try {
      await h.old.goaway();
      await flush(256);
      expect(h.transportCalls).toEqual([OLD_URL]);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/credential|origin|authoriz/i);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.oldStillDelivers(2n);
    } finally { await h.destroy(); }
  });

  it('allows a same-origin replacement when legacy SETUP credentials are configured', async () => {
    const h = await fixture(draft, { config: { authTokens: [Uint8Array.of(3, 1, 0xab)] } });
    try {
      const target = 'https://old.example/replacement';
      await h.old.goaway(target);
      await flush(256);
      expect(h.transportCalls).toEqual([OLD_URL, target]);
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('allows an anonymous cross-origin replacement with an empty legacy token list', async () => {
    const h = await fixture(draft, { config: { authTokens: [] } });
    try {
      await h.old.goaway();
      await flush(256);
      expect(h.transportCalls).toEqual([OLD_URL, NEW_URL]);
      expect(h.next.requests.map(r => r.name)).toEqual(['catalog']);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
});

type RetainedAttempt = {
  events: Array<{ obj?: { groupId: bigint } }>;
  retainedBytes: number;
  prep?: unknown;
  slots?: unknown;
};

describe('root public-assembler partial-adoption cleanup', () => {
  it.each(['healthy', 'fault', 'fault-reentrant-destroy'] as const)(
    'owns prepared requests and candidate close after adoption: %s', async mode => {
      const nextInit = buildInit({ trackId: 1, timescale: 60000, handler: 'vide' });
      let armed = false;
      let h!: Awaited<ReturnType<typeof fixture>>;
      let destroyed: Promise<void> | undefined;
      let retained: RetainedAttempt | undefined;
      const pushed: bigint[] = [];
      const faultPremises: Array<{ currentIsCandidate: boolean; activeRequests: string[] }> = [];
      const initializations: Array<{ role: string; bytes: Uint8Array }> = [];
      h = await fixture(18, { config: {
        createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, changeType: async () => {},
          reset: () => {}, endOfStream: () => {}, destroy: () => {}, mediaElement: null,
          onFirstFrame: null, onError: null, onStall: null }),
        createCmafAssembler: callbacks => ({
          push: (mediaType, track, group, payload) => {
            pushed.push(group); callbacks.onSegment(mediaType, payload, track, group);
          },
          getEpoch: () => null, reset() {}, destroy() {},
          setInitSegment: (role, bytes) => {
            initializations.push({ role, bytes: bytes.slice() });
            if (!armed || mode === 'healthy') return;
            const connection = Reflect.get(h.player, 'connection') as unknown;
            const activeRequests = h.next.requests.filter(request =>
              h.next.client.session.getSubscription(varint(request.id))?.isActive === true).map(request => request.name).sort();
            faultPremises.push({ currentIsCandidate: connection === h.next.client, activeRequests });
            if (mode === 'fault-reentrant-destroy') destroyed = h.player.destroy();
            throw new Error('public assembler init fault');
          },
        }),
      } });
      const internal = h.player as unknown as {
        commitMigration(txn: RetainedAttempt, connection: PlayerConnection): void;
        currentMigration: unknown;
      };
      const original = internal.commitMigration.bind(h.player);
      const commitPremises: Array<{ events: number; bytes: number; video61: boolean }> = [];
      const capture = vi.spyOn(internal, 'commitMigration').mockImplementation((txn, connection) => {
        retained = txn;
        commitPremises.push({ events: txn.events.length, bytes: txn.retainedBytes,
          video61: txn.events.some(event => event.obj?.groupId === 61n) });
        original(txn, connection); // Observation only; the public assembler throws.
      });
      try {
        await h.old.goaway();
        await h.next.accept('catalog', 100n);
        await h.next.send('catalog', catalog(true));
        await h.next.accept('video', 200n);
        await h.next.send('video', chunk('video', 61n), 61n);
        await h.next.accept('audio', 201n);
        expect(h.migrated).not.toHaveBeenCalled();
        expect(h.received).not.toContainEqual({ name: 'video', group: 61n });
        expect(h.next.close).not.toHaveBeenCalled();
        armed = true;
        await h.next.accept('init-video', 202n);
        await h.next.send('init-video', nextInit);
        await flush(512);
        await destroyed;
        expect(commitPremises).toHaveLength(1);
        expect(commitPremises[0]!.events).toBeGreaterThan(0);
        expect(commitPremises[0]!.bytes).toBeGreaterThan(0);
        expect(commitPremises[0]!.video61).toBe(true);
        expect(initializations.some(item => item.role === 'video'
          && Buffer.from(item.bytes).equals(Buffer.from(nextInit)))).toBe(true);
        expect(h.next.requests.map(request => request.name).sort()).toEqual(['audio', 'catalog', 'init-video', 'video']);
        if (mode === 'healthy') {
          expect(faultPremises).toEqual([]);
          expect(h.fatalErrors).toEqual([]);
          expect(h.errors).toEqual([]);
          expect(h.migrated).toHaveBeenCalledOnce();
          expect(h.received).toContainEqual({ name: 'video', group: 61n });
          expect(pushed).toContain(61n);
          expect(h.next.close).not.toHaveBeenCalled();
          await h.player.destroy();
          expect(h.next.close).toHaveBeenCalledTimes(1);
          return;
        }
        expect(faultPremises).toEqual([{ currentIsCandidate: true,
          activeRequests: ['audio', 'catalog', 'init-video', 'video'] }]);
        expect.soft(h.player.state).toBe(mode === 'fault-reentrant-destroy' ? 'ended' : 'error');
        if (mode === 'fault') {
          expect.soft(h.fatalErrors).toEqual(['Session handover failed while committing the replacement: public assembler init fault']);
        }
        expect.soft(h.migrated).not.toHaveBeenCalled();
        expect.soft(h.received).not.toContainEqual({ name: 'video', group: 61n });
        expect.soft(pushed).not.toContain(61n);
        expect.soft(h.next.close, 'the adopted failed candidate has one close owner').toHaveBeenCalledTimes(1);
        for (const request of h.next.requests) {
          expect.soft(h.next.client.session.getSubscription(varint(request.id)), `retire prepared ${request.name}`).toBeUndefined();
        }
        expect.soft(retained?.events).toEqual([]);
        expect.soft(retained?.retainedBytes).toBe(0);
        expect.soft(retained?.prep).toBeUndefined();
        expect.soft(retained?.slots).toBeUndefined();
        expect.soft(internal.currentMigration).toBeNull();
        await h.player.destroy();
        expect(h.next.close, 'later destroy cannot close the same candidate again').toHaveBeenCalledTimes(1);
      } finally { capture.mockRestore(); await h.destroy(); }
    });
});

/** SDK lifecycle evidence through controlled media interfaces; no native playback claim. */
function selectionHandoverCatalog() {
  const base = JSON.parse(dec.decode(catalog())) as { version: number; tracks: Array<Record<string, unknown>> };
  const video = { ...base.tracks.find(track => track['role'] === 'video')!, altGroup: 1 };
  return enc.encode(JSON.stringify({ ...base, tracks: [video,
    { ...video, name: 'video-lo', width: 320, height: 180, bitrate: 300_000 },
    ...base.tracks.filter(track => track['role'] !== 'video'),
  ] }));
}

describe.each([16, 18, 22] as const)('draft-%i GOAWAY during rendition selection', draft => {
  it('prerequisite: defers GOAWAY while an accepted video target still awaits media', async () => {
    const h = await fixture(draft, { oldCatalog: selectionHandoverCatalog(),
      config: { autoQuality: false, selection: { videoTrack: { name: 'video' } } } });
    try {
      await h.player.selectVideoTrack('video-lo');
      await h.old.accept('video-lo', 210n);
      expect(h.player.selection.video?.name).toBe('video');
      expect(h.transportCalls).toEqual([OLD_URL]);
      await h.old.goaway();
      expect(h.transportCalls, 'target acceptance alone must not start a competing session handover').toEqual([OLD_URL]);
      expect(h.next.requests).toEqual([]);
      await h.old.send('video-lo', chunk('video', 2n), 2n);
      await flush(512);
      expect(h.player.selection.video?.name).toBe('video-lo');
      expect(h.next.requests.map(row => row.name)).toEqual(['catalog']);
    } finally { await h.destroy(); }
  });

  it('control: GOAWAY without a selection owner completes a usable replacement', async () => {
    const h = await fixture(draft);
    try {
      await h.old.goaway();
      await h.next.accept('catalog', 100n); await h.next.send('catalog', catalog());
      await h.next.accept('video', 200n); await h.next.accept('audio', 201n);
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.old.close).toHaveBeenCalledTimes(1);
      expect(h.fatalErrors).toEqual([]); expect(h.closed).not.toHaveBeenCalled();
      await h.next.send('video', chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally { await h.destroy(); }
  });

  it('control: the held public retype settles the accepted rendition without GOAWAY', async () => {
    const gate = deferred<void>(); let changes = 0;
    const h = await fixture(draft, { oldCatalog: selectionHandoverCatalog(), config: {
      autoQuality: false, selection: { videoTrack: { name: 'video' } },
      createMediaSource: () => ({ initialize: () => true, appendChunk() {}, reset() {}, endOfStream() {}, destroy() {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
        changeType: () => { changes++; return gate.promise; },
      }),
    } });
    try {
      await h.player.selectVideoTrack('video-lo'); await h.old.accept('video-lo', 210n);
      await h.old.send('video-lo', chunk('video', 2n), 2n);
      expect(changes).toBe(1);
      expect(h.player.selection.video?.name).toBe('video');
      gate.resolve(); await flush(512);
      expect(h.player.selection.video?.name).toBe('video-lo');
      expect(h.fatalErrors).toEqual([]);
      await h.old.send('video-lo', chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video-lo', group: 3n });
    } finally { gate.resolve(); await flush(256); await h.destroy(); }
  });

  it.each([
    { terminal: 'close', outcome: 'success' },
    { terminal: 'error', outcome: 'success' },
    { terminal: 'error', outcome: 'refusal' },
  ] as const)('queued $terminal is held until replacement $outcome', async ({ terminal, outcome }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gate = deferred<void>(); let changes = 0;
    const h = await fixture(draft, { oldCatalog: selectionHandoverCatalog(), config: {
      autoQuality: false, selection: { videoTrack: { name: 'video' } },
      createMediaSource: () => ({ initialize: () => true, appendChunk() {}, reset() {}, endOfStream() {}, destroy() {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
        changeType: () => { changes++; return gate.promise; },
      }),
    } });
    const observed = h.player as unknown as {
      pendingGoaway: { sourceConnection: PlayerConnection; uri: string } | null;
      currentMigration: unknown;
    };
    try {
      await h.player.selectVideoTrack('video-lo'); await h.old.accept('video-lo', 210n);
      await h.old.send('video-lo', chunk('video', 2n), 2n);
      expect(changes, 'actual target input entered the public retype gate').toBe(1);
      expect(h.player.selection.video?.name).toBe('video');
      await h.old.goaway();
      expect(observed.pendingGoaway?.sourceConnection, 'premise: real GOAWAY owns the current old connection').toBe(h.old.client);
      expect(observed.pendingGoaway?.uri).toBe(NEW_URL);
      expect(observed.currentMigration, 'premise: queued, not an already preparing candidate').toBeNull();
      expect(h.transportCalls).toEqual([OLD_URL]); expect(h.next.requests).toEqual([]);

      if (terminal === 'close') h.old.transport.close({ closeCode: 0, reason: 'relay drained' });
      else h.old.transport.failClosed(new Error('old relay network lost'));
      await flush(256);
      expect(h.fatalErrors, 'owned queued error is not yet the replacement outcome').toEqual([]);
      expect(h.closed, 'owned queued closure is not yet a public session loss').not.toHaveBeenCalled();

      gate.resolve(); await flush(512);
      expect(h.transportCalls).toEqual([OLD_URL, NEW_URL]);
      expect(h.player.selection.video?.name, 'handover must preserve the rendition selected by settled retype').toBe('video-lo');
      if (outcome === 'refusal') {
        await h.next.reject('catalog'); await flush(512);
        expect(h.fatalErrors).toEqual(['old relay network lost']);
        expect(h.migrated).not.toHaveBeenCalled();
        expect(h.next.close).toHaveBeenCalledTimes(1);
      } else {
        await h.next.accept('catalog', 100n); await h.next.send('catalog', selectionHandoverCatalog());
        expect(h.next.requests.filter(row => row.name.startsWith('video')).map(row => row.name)).toEqual(['video-lo']);
        await h.next.accept('video-lo', 210n); await h.next.accept('audio', 201n);
        await flush(512);
        expect(h.migrated).toHaveBeenCalledTimes(1);
        expect(h.fatalErrors).toEqual([]); expect(h.closed).not.toHaveBeenCalled();
        await h.next.send('video-lo', chunk('video', 3n), 3n);
        expect(h.received).toContainEqual({ name: 'video-lo', group: 3n });
      }
    } finally {
      gate.resolve(); await flush(256); vi.useRealTimers(); await h.destroy();
    }
  });
});

describe('queued GOAWAY entry rejection', () => {
  it.each(['invalid URI', 'factory throws'] as const)('reports the held terminal once when %s rejects entry', async failure => {
    const gate = deferred<void>(); let changes = 0;
    const h = await fixture(18, { oldCatalog: selectionHandoverCatalog(),
      ...(failure === 'factory throws' ? { replacementFactoryError: new Error('replacement factory fault') } : {}),
      config: {
        autoQuality: false, selection: { videoTrack: { name: 'video' } },
        createMediaSource: () => ({ initialize: () => true, appendChunk() {}, reset() {}, endOfStream() {}, destroy() {},
          mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
          changeType: () => { changes++; return gate.promise; },
        }),
      },
    });
    const owner = h.player as unknown as {
      pendingGoaway: { sourceConnection: PlayerConnection; uri: string } | null;
      currentMigration: unknown;
    };
    try {
      await h.player.selectVideoTrack('video-lo'); await h.old.accept('video-lo', 210n);
      await h.old.send('video-lo', chunk('video', 2n), 2n);
      expect(changes).toBe(1);
      const uri = failure === 'invalid URI' ? 'http://invalid-replacement.example/moq' : NEW_URL;
      await h.old.goaway(uri);
      expect(owner.pendingGoaway?.sourceConnection).toBe(h.old.client);
      expect(owner.pendingGoaway?.uri).toBe(uri);
      expect(owner.currentMigration).toBeNull();
      expect(h.transportCalls).toEqual([OLD_URL]); expect(h.next.requests).toEqual([]);
      h.old.transport.failClosed(new Error('old relay network lost'));
      await flush(256);
      expect(h.fatalErrors).toEqual([]); expect(h.closed).not.toHaveBeenCalled();

      gate.resolve(); await flush(512);
      expect(h.fatalErrors).toEqual(['old relay network lost']);
      expect(h.errors.filter(message => message.startsWith('Automatic GOAWAY migration '))).toHaveLength(1);
      expect(h.errors.some(message => failure === 'invalid URI'
        ? message.startsWith('Automatic GOAWAY migration rejected:')
        : message.includes('replacement factory fault'))).toBe(true);
      expect(owner.pendingGoaway).toBeNull(); expect(owner.currentMigration).toBeNull();
      expect(h.transportCalls).toEqual([OLD_URL]); expect(h.next.requests).toEqual([]);
      expect(h.migrated).not.toHaveBeenCalled();
      await flush(512);
      expect(h.fatalErrors).toEqual(['old relay network lost']);
    } finally { gate.resolve(); await flush(256); await h.destroy(); }
  });
});
