import { describe, expect, it, vi } from 'vitest';
import { createControlCodec, encodeSubgroupHeader18, encodeSubgroupObject18, varint } from '@openmoq/transport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import type { DecoderCommand } from '@openmoq/playback';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import type { LoopPipe } from '../../webtransport/src/testkit/loopback.js';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import { videoInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import type { QualityController } from './quality-controller.js';
import type { MoqtConnection as PublicConnection } from '@openmoq/webtransport';
import { identityKey } from '@openmoq/msf';
import type { VideoRendererLike, VideoDecoderLike } from './interfaces.js';

// Vitest resolves the public export to workspace source; tsc sees the built class's separate private declarations.
const playerConnection = (connection: MoqtConnection) => connection as unknown as PublicConnection;

// Sender-side FIN precedes DONE in both schedules (§10.11); only receiver delivery is reordered.
async function finiteVideo(options: { transform?: MoqtPlayerConfig['objectTransform']; terminalMarker?: boolean;
  replacementTransport?: MoqtPlayerConfig['createTransport']; packaging?: 'loc' | 'cmaf'; connectionTimeoutMs?: number;
  defaultDrain?: boolean; outputs?: boolean } = {}) {
  const pair = await connectedPair(18, options.defaultDrain ? {} : { clientOptions: { terminatedAliasTtlMs: 80 } });
  const ids = new Map<string, bigint>();
  const commands: DecoderCommand[] = [];
  const assemblerPush = vi.fn();
  const createConnection = vi.fn(() => { throw new Error('unexpected replacement dial'); });
  const ended: unknown[] = [], unsubscribed: unknown[] = [];
  const stalls: unknown[] = [], recoveries: unknown[] = [];
  const warnings = vi.fn();
  const renderer: VideoRendererLike = { enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
    onFirstFrame: null, onFrameRendered: null, onStall: null };
  const decoder: VideoDecoderLike = { configure: vi.fn(), decode: vi.fn(), flush: async () => {}, reset: vi.fn(),
    queueDepth: 0, onFrame: null, onError: null, destroy: vi.fn() };
  pair.server.onSubscribe = (id, _ns, name) => { ids.set(new TextDecoder().decode(name), id); };
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq', namespace: 'finite', connection: playerConnection(pair.client),
    createConnection,
    createTransport: options.replacementTransport ?? (async () => ({}) as never), draftVersion: 18, catalogBootstrap: 'subscribe',
    disableAudio: true, clock: { now: () => 1_000_000 }, livenessTimeoutMs: 0, livenessMaxRestarts: 1,
    logger: { error: vi.fn(), warn: warnings, info: vi.fn(), debug: vi.fn() },
    ...(options.outputs ? { createRenderer: () => renderer, createVideoDecoder: () => decoder } : {}),
    ...(options.transform ? { objectTransform: options.transform } : {}),
    ...(options.connectionTimeoutMs !== undefined ? { connectionTimeoutMs: options.connectionTimeoutMs } : {}),
    createMediaSource: () => ({ initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
      mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null }),
    createCmafAssembler: () => ({ push: assemblerPush, getEpoch: () => null, setInitSegment: vi.fn(), reset: vi.fn(), destroy: vi.fn() }),
    commandTransform: cmd => { commands.push(cmd); return null; },
  });
  player.on('track_ended', event => ended.push(event));
  player.on('track_unsubscribed', event => unsubscribed.push(event));
  player.on('stall', event => stalls.push(event));
  player.on('recovery_action', event => recoveries.push(event));
  const data = async (alias: bigint, payload: Uint8Array, extensions?: Uint8Array, group = 0n) => {
    const sid = await pair.server.openSubgroup(alias, group, 0n, { publisherPriority: 128, hasExtensions: extensions !== undefined });
    await pair.server.sendObject(sid, 0n, payload, extensions);
    await pair.server.closeSubgroup(sid);
    await flush(256);
  };
  await player.load(); await flush(256);
  const catalogId = ids.get('catalog')!;
  expect(catalogId).toBeDefined();
  await pair.server.acceptSubscribe(catalogId, 100n);
  await data(100n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
    { name: 'video', role: 'video', packaging: options.packaging ?? 'loc', isLive: false, codec: 'avc1.640029', width: 640, height: 360, bitrate: 100000,
      ...(options.packaging === 'cmaf' ? { initData: Buffer.from(videoInit()).toString('base64') } : {}) },
  ] })));
  const requestId = ids.get('video')!; expect(requestId).toBeDefined();
  await pair.server.acceptSubscribe(requestId, 101n);
  await data(101n, options.packaging === 'cmaf'
    ? buildChunk({ trackId: 1, bmdt: 0n, samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0) })
    : Uint8Array.of(0x65), options.packaging === 'cmaf' ? undefined : encodeLocHeaders({ captureTimestamp: 0n,
    videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: true,
      discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(18) }));
  player.tick();
  if (options.packaging === 'cmaf') expect(assemblerPush).toHaveBeenCalledOnce();
  else expect(commands.filter(c => c.type === 'decode_video')).toHaveLength(1);
  let terminalPipe: LoopPipe | null = null;
  if (options.terminalMarker !== false) {
    const uni = await pair.b.createUnidirectionalStream();
    terminalPipe = pair.b.uniOut.at(-1)!;
    terminalPipe.faults.hold = true;
    const writer = uni.getWriter();
    await writer.write(encodeSubgroupHeader18({ typeByte: 0x10, trackAlias: 101n, groupId: 1n,
      subgroupId: 0n, publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
    await writer.write(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array(), status: 4n, extensions: undefined }, false, 0n, true));
    await writer.close();
    expect(terminalPipe.writeClosed).toBe(true);
  }
  const codec = createControlCodec(18);
  const done = async (status = 2n, streamCount = options.terminalMarker === false ? 1n : 2n) => {
    pair.a.bidiOut[1]!.in.injectRead(codec.encode({ type: 'PUBLISH_DONE', requestId: varint(requestId),
      statusCode: varint(status), streamCount: varint(streamCount), errorReason: 'finite' }));
    await flush(256);
  };
  return { ...pair, player, commands, ended, unsubscribed, terminalPipe, done, requestId, createConnection,
    renderer, stalls, recoveries, warnings,
    async prepareLateTail() {
      const stream = await pair.b.createUnidirectionalStream();
      const pipe = pair.b.uniOut.at(-1)!; pipe.faults.hold = true;
      const output = stream.getWriter();
      await output.write(encodeSubgroupHeader18({ typeByte: 0x15, trackAlias: 101n, groupId: 0n,
        subgroupId: 1n, publisherPriority: 128, hasExtensions: true, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
      await output.write(encodeSubgroupObject18({ objectId: 1n, payload: Uint8Array.of(0x41), status: undefined,
        extensions: encodeLocHeaders({ captureTimestamp: 0n }, { wireProfile: locWireProfileForDraft(18) }) }, true, 0n, true));
      await output.close(); expect(pipe.writeClosed).toBe(true);
      return pipe;
    },
    async completeCatalog() {
      let complete = false;
      player.on('catalog_updated', event => { complete = event.catalog.isComplete === true && event.catalog.tracks.length === 0; });
      await data(100n, new TextEncoder().encode(JSON.stringify({ version: 1, isComplete: true, tracks: [] })), undefined, 1n);
      expect(complete).toBe(true);
    },
    async release() { if (!terminalPipe) throw new Error('fixture has no terminal marker'); terminalPipe.releaseHeld(); await flush(256); player.tick(); },
    async destroy() { await player.destroy(); await pair.client.close(); await pair.server.close(); } };
}

describe('finite media terminal delivery through the real player', () => {
  it('completes exact processed streams within the terminal grace, without stall recovery', async () => {
    const h = await finiteVideo({ defaultDrain: true, outputs: true });
    const publicEot = vi.fn();
    h.player.on('media_object', event => { if (event.kind === 'gap' && event.status === 4n) publicEot(event); });
    vi.useFakeTimers();
    try {
      await h.done(); await h.completeCatalog(); await h.release();
      await h.server.sendGoaway({ newSessionUri: '', requestId: 4n, timeout: 0n }); await flush(256);
      // The renderer still runs after the final picture. Its lack of a new frame is not a live stall.
      setTimeout(() => h.renderer.onStall?.(517), 517);
      setTimeout(() => h.renderer.onStall?.(1017), 1017);
      const tick = setInterval(() => h.player.tick(), 16);
      await vi.advanceTimersByTimeAsync(1500); clearInterval(tick);
      expect(h.ended).toEqual([{ type: 'track_ended', mediaType: 'video' }]);
      expect(publicEot).toHaveBeenCalledOnce();
      expect(h.stalls).toEqual([]); expect(h.recoveries).toEqual([]);
      expect(h.warnings).not.toHaveBeenCalled();
      expect(h.commands.filter(command => command.type === 'flush')).toHaveLength(1);
      expect(h.unsubscribed).toHaveLength(1); expect(h.errors).toEqual([]);
      expect(h.createConnection).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await h.destroy(); }
  });

  it('keeps a terminal hold and late tail intact when the renderer reports a stall', async () => {
    const h = await finiteVideo({ defaultDrain: true, outputs: true });
    try {
      const tail = await h.prepareLateTail();
      await h.done(2n, 3n); await h.release();
      h.renderer.onStall?.(517);
      expect(h.stalls).toEqual([]); expect(h.recoveries).toEqual([]); expect(h.ended).toEqual([]);
      tail.releaseHeld(); await flush(256); h.player.tick();
      await vi.waitFor(() => { h.player.tick(); expect(h.ended).toHaveLength(1); }, { timeout: 1500 });
      expect(h.commands.filter(command => command.type === 'decode_video')).toHaveLength(2);
      expect(h.commands.filter(command => command.type === 'flush')).toHaveLength(1);
    } finally { await h.destroy(); }
  });

  it('still reports renderer stalls for an ordinary live subscription', async () => {
    const h = await finiteVideo({ outputs: true });
    try {
      h.renderer.onStall?.(517);
      expect(h.stalls).toHaveLength(1); expect(h.recoveries).toHaveLength(1);
    } finally { await h.destroy(); }
  });

  it.each(['eot-first', 'done-first'] as const)('delivers EOT and flushes once: %s', async order => {
    const h = await finiteVideo();
    try {
      if (order === 'eot-first') { await h.release(); await h.done(); }
      else { await h.done(); await h.release(); }
      expect(h.errors).toEqual([]);
      expect(h.terminalPipe?.readCancelled).toBe(false);
      await vi.waitFor(() => { h.player.tick(); expect(h.ended).toEqual([{ type: 'track_ended', mediaType: 'video' }]); });
      expect(h.commands.filter(c => c.type === 'flush')).toHaveLength(1);
      h.player.tick(); expect(h.ended).toHaveLength(1);
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1));
      await flush(256); expect(h.unsubscribed).toHaveLength(1);
    } finally { await h.destroy(); }
  });

  it('finishes accepted async processing before retiring its player route', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await finiteVideo({ transform: object => object.kind === 'gap' && object.status === 4n
      ? gate.then(() => object) : object });
    try {
      await h.done(); await h.release();
      const drains = (h.client as unknown as { drainingAliases: Map<bigint, unknown> }).drainingAliases;
      // Transport processing is complete already; the application transform still owns its route.
      expect(drains.size).toBe(0);
      expect(h.ended).toEqual([]); expect(h.unsubscribed).toEqual([]);
      release(); await flush(256); h.player.tick();
      await vi.waitFor(() => { h.player.tick(); expect(h.ended).toHaveLength(1); });
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1));
    } finally { release(); await h.destroy(); }
  });

  it('does not complete on EOT while an earlier data stream is still draining', async () => {
    const h = await finiteVideo();
    try {
      const tail = await h.prepareLateTail();
      await h.done(2n, 3n); await h.release();
      expect(h.ended).toEqual([]);
      tail.releaseHeld(); await flush(256); h.player.tick();
      expect(h.commands.filter(command => command.type === 'decode_video')).toHaveLength(2);
      await vi.waitFor(() => { h.player.tick(); expect(h.ended).toHaveLength(1); });
      expect(h.commands.filter(command => command.type === 'flush')).toHaveLength(1);
    } finally { await h.destroy(); }
  });

  it.each([2n, 3n])('without an EOT object, only TRACK_ENDED signals whole-track completion: status=%s', async code => {
    const h = await finiteVideo({ terminalMarker: false });
    try {
      await h.done(code);
      expect(h.ended).toEqual([]);
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1));
      h.player.tick();
      expect(h.ended).toEqual(code === 2n ? [{ type: 'track_ended', mediaType: 'video' }] : []);
      expect(h.commands.filter(command => command.type === 'flush')).toHaveLength(code === 2n ? 1 : 0);
    } finally { await h.destroy(); }
  });

  it.each([2n, 3n])('CMAF delivery reports drained TRACK_ENDED, not filter completion: status=%s', async code => {
    const h = await finiteVideo({ terminalMarker: false, packaging: 'cmaf' });
    try {
      await h.done(code);
      expect(h.unsubscribed).toHaveLength(1); // exact stream evidence, not the timeout
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1));
      expect(h.ended).toEqual(code === 2n ? [{ type: 'track_ended', mediaType: 'video' }] : []);
      expect(h.commands.filter(command => command.type === 'decode_video')).toEqual([]);
    } finally { await h.destroy(); }
  });

  // Exercise the same owned-subscribe helper used by auxiliary/overlap delivery; this is not a full ABR test.
  it.each(['track-first', 'filter-first'] as const)('CMAF track completion survives the other rendition retiring: %s', async order => {
    const h = await finiteVideo({ terminalMarker: false, packaging: 'cmaf' });
    const internal = h.player as unknown as {
      subscribeAuxTrackOwned(ns: Uint8Array[], name: Uint8Array, options: object,
        info: { trackName: string; mediaType: 'video'; packaging: 'cmaf' }): Promise<bigint | undefined>;
      mediaSource: { endOfStream: () => void };
    };
    const failures: unknown[] = [];
    h.server.onSubscribe = id => { void h.server.acceptSubscribe(id, 202n).catch(error => { failures.push(error); }); };
    try {
      const selected = h.player.selection.video;
      const other = await internal.subscribeAuxTrackOwned([new TextEncoder().encode('finite')], new TextEncoder().encode('other-rendition'), {},
        { trackName: 'other-rendition', mediaType: 'video', packaging: 'cmaf' });
      expect(other).toBeDefined(); await flush(256);
      expect(h.player.selection.video).toEqual(selected);
      if (order === 'track-first') await h.done();
      else await h.server.publishDone(other!, varint(3n), 'filter');
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1)); expect(h.ended).toEqual([]);
      if (order === 'track-first') await h.server.publishDone(other!, varint(3n), 'filter');
      else await h.done();
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(2));
      expect(h.ended).toEqual([{ type: 'track_ended', mediaType: 'video' }]);
      expect(internal.mediaSource.endOfStream).not.toHaveBeenCalled(); expect(failures).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each(['identity', 'generation', 'source'] as const)('a retained CMAF completion cannot end a changed output: %s', async change => {
    const h = await finiteVideo({ terminalMarker: false, packaging: 'cmaf' });
    const internal = h.player as unknown as {
      subscribeAuxTrackOwned(ns: Uint8Array[], name: Uint8Array, options: object,
        info: { trackName: string; mediaType: 'video'; packaging: 'cmaf' }): Promise<bigint | undefined>;
      qualityController: QualityController;
      mediaSource: { endOfStream: () => void };
    };
    const failures: unknown[] = [];
    h.server.onSubscribe = id => { void h.server.acceptSubscribe(id, 202n).catch(error => { failures.push(error); }); };
    try {
      const other = await internal.subscribeAuxTrackOwned([new TextEncoder().encode('finite')], new TextEncoder().encode('other-rendition'), {},
        { trackName: 'other-rendition', mediaType: 'video', packaging: 'cmaf' });
      expect(other).toBeDefined(); await flush(256);
      await h.done(); await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1)); expect(h.ended).toEqual([]);
      if (change === 'source') {
        const original = internal.mediaSource; internal.mediaSource = { ...original };
        expect(internal.mediaSource).not.toBe(original);
      } else {
        const old = internal.qualityController.currentVideoTrack!;
        const next = { ...old, ...(change === 'identity' ? { name: 'replacement' } : {}) };
        internal.qualityController.selectEligibleMembers({ videoLadder: [next], audioCandidates: [] });
        expect(internal.qualityController.currentVideoTrack).toBe(next);
      }
      await h.server.publishDone(other!, varint(3n), 'filter');
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(2));
      expect(h.ended).toEqual([]); expect(failures).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each([0n, 1n, 6n, 8n, 9n, 18n])('does not turn error/expired status %s into normal draining', async status => {
    const h = await finiteVideo();
    try {
      await h.done(status);
      expect(h.unsubscribed).toHaveLength(1);
      await h.release(); expect(h.ended).toEqual([]);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('destroy during terminal drain neither replays late EOT nor publishes a late retirement', async () => {
    const h = await finiteVideo();
    try {
      await h.done(); await h.player.destroy();
      await h.release(); await new Promise(resolve => setTimeout(resolve, 120));
      expect(h.ended).toEqual([]); expect(h.unsubscribed).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each(['done-catalog-goaway', 'catalog-done-goaway', 'catalog-goaway-done'] as const)(
    'a complete catalog avoids an unnecessary replacement while completion controls reorder: %s', async order => {
    const h = await finiteVideo();
    try {
      for (const step of order.split('-')) {
        if (step === 'done') await h.done();
        else if (step === 'catalog') await h.completeCatalog();
        else { await h.server.sendGoaway({ newSessionUri: '', requestId: 4n, timeout: 0n }); await flush(256); }
      }
      expect(h.createConnection).not.toHaveBeenCalled();
      await h.release(); await vi.waitFor(() => { h.player.tick(); expect(h.ended).toHaveLength(1); });
      await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1));
    } finally { await h.destroy(); }
  });

  it('GOAWAY without completed-catalog evidence still attempts replacement', async () => {
    const h = await finiteVideo();
    try {
      await h.server.sendGoaway({ newSessionUri: '', requestId: 4n, timeout: 0n }); await flush(256);
      expect(h.createConnection).toHaveBeenCalledOnce();
    } finally { await h.destroy(); }
  });

  it('retiring an old session releases only its terminal hold on the preserved pipeline', async () => {
    const transport = createLoopback();
    const h = await finiteVideo({ replacementTransport: async () => transport.a });
    const next = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
    const errors: unknown[] = [];
    server.onSubscribe = (id, _ns, name) => {
      void (async () => {
        const catalog = new TextDecoder().decode(name) === 'catalog';
        await server.acceptSubscribe(id, catalog ? 100n : 101n);
        if (catalog) {
          const sid = await server.openSubgroup(100n, 0n, 0n, { publisherPriority: 128 });
          await server.sendObject(sid, 0n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
            { name: 'video', role: 'video', packaging: 'loc', isLive: false, codec: 'avc1.640029', width: 640, height: 360, bitrate: 100000 },
          ] })));
          await server.closeSubgroup(sid);
        }
      })().catch(error => { errors.push(error); });
    };
    let connecting: Promise<void> | undefined;
    try {
      await h.done();
      connecting = server.connect(transport.b);
      await h.player.migrate(playerConnection(next)); await connecting;
      expect(errors).toEqual([]);
      const output = (await transport.b.createUnidirectionalStream()).getWriter();
      await output.write(encodeSubgroupHeader18({ typeByte: 0x10, trackAlias: 101n, groupId: 1n,
        subgroupId: 0n, publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
      await output.write(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array(), extensions: undefined, status: 4n }, false, 0n, true));
      await output.close(); await flush(256); h.player.tick();
      expect(h.ended).toHaveLength(1);
    } finally { await h.destroy(); await next.close(); await server.close(); await connecting?.catch(() => {}); }
  });

  it.each(['during', 'after', 'timeout'] as const)('replacement CMAF completion survives overlap pruning: %s', async timing => {
    const transport = createLoopback();
    const h = await finiteVideo({ packaging: 'cmaf', terminalMarker: false, replacementTransport: async () => transport.a, connectionTimeoutMs: 300 });
    const internal = h.player as unknown as {
      subscribeAuxTrackOwned(ns: Uint8Array[], name: Uint8Array, options: object,
        info: { trackName: string; mediaType: 'video'; packaging: 'cmaf' }): Promise<bigint | undefined>;
    };
    const next = new MoqtConnection(18, { terminatedAliasTtlMs: 20 }), server = new MoqtConnection(18, { role: 'server' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const close = h.client.close.bind(h.client);
    const closing = vi.spyOn(h.client, 'close').mockImplementationOnce(async () => { await gate; await close(); });
    const failures: unknown[] = []; let videoId: bigint | undefined;
    h.server.onSubscribe = id => { void h.server.acceptSubscribe(id, 202n).catch(error => { failures.push(error); }); };
    server.onSubscribe = (id, _ns, name) => { void (async () => {
      const catalog = new TextDecoder().decode(name) === 'catalog';
      await server.acceptSubscribe(id, catalog ? 100n : 101n);
      if (catalog) {
        const stream = await server.openSubgroup(100n, 0n, 0n, { publisherPriority: 128 });
        await server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
          { name: 'video', role: 'video', packaging: 'cmaf', isLive: false, codec: 'avc1.640029', width: 640, height: 360,
            bitrate: 100000, initData: Buffer.from(videoInit()).toString('base64') },
        ] })));
        await server.closeSubgroup(stream);
      } else videoId = id;
    })().catch(error => { failures.push(error); }); };
    let migration: Promise<void> | undefined, connecting: Promise<void> | undefined;
    try {
      const extra = await internal.subscribeAuxTrackOwned([new TextEncoder().encode('finite')], new TextEncoder().encode('old-extra'), {},
        { trackName: 'old-extra', mediaType: 'video', packaging: 'cmaf' });
      await flush(256);
      connecting = server.connect(transport.b); migration = h.player.migrate(playerConnection(next));
      await vi.waitFor(() => expect(closing).toHaveBeenCalledOnce()); await connecting;
      expect(videoId).toBeDefined(); expect(extra).not.toBe(videoId);
      if (timing !== 'after') {
        await server.publishDone(videoId!, varint(2n), 'finished');
        await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1)); expect(h.ended).toEqual([]);
      }
      if (timing !== 'timeout') release();
      await migration;
      if (timing === 'after') {
        await server.publishDone(videoId!, varint(2n), 'finished');
        await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1));
      }
      expect(h.ended).toEqual([{ type: 'track_ended', mediaType: 'video' }]); expect(failures).toEqual([]);
    } finally { release(); await migration?.catch(() => {}); await h.destroy(); await next.close(); await server.close(); await connecting?.catch(() => {}); }
  });

  it('batch completion still notifies both media types when a listener and logger throw', async () => {
    const known = { video: { name: 'video', codec: 'avc1.640029' }, audio: { name: 'audio', codec: 'opus' } };
    const player = new MoqtPlayer({ url: 'https://unused.example/moq', namespace: 'finite', knownTracks: known,
      logger: { error() {}, info() {}, debug() {}, warn() { throw new Error('logger refused'); } } });
    const conn = new MoqtConnection(18);
    const source = { initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), mediaElement: null,
      destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null };
    const internal = player as unknown as {
      connection: MoqtConnection; mediaSource: typeof source; mseOutputEpoch: object | null;
      mseCompletions: Map<'video' | 'audio', { conn: MoqtConnection; source: typeof source; outputEpoch: object | null; selection: object; key: string; emitted: boolean }>;
      reconsiderMseTrackEnds(): void;
    };
    internal.connection = conn; internal.mediaSource = source;
    // Completion is scoped to the native output epoch: the deliberately injected records carry the current one.
    internal.mseCompletions = new Map((['video', 'audio'] as const).map(type => [type,
      { conn, source, outputEpoch: internal.mseOutputEpoch, selection: known[type], key: identityKey(['finite'], known[type].name), emitted: false }]));
    const seen: string[] = [];
    player.on('track_ended', () => { throw new Error('listener refused'); });
    player.on('track_ended', event => { seen.push(event.mediaType); });
    try {
      expect(() => internal.reconsiderMseTrackEnds()).not.toThrow();
      expect(seen).toEqual(['video', 'audio']);
      internal.reconsiderMseTrackEnds(); expect(seen).toEqual(['video', 'audio']);
    } finally { await player.destroy(); await conn.close(); }
  });

  it('control — a completion recorded under a stale native output epoch is dropped, never notified', async () => {
    const known = { video: { name: 'video', codec: 'avc1.640029' }, audio: { name: 'audio', codec: 'opus' } };
    const player = new MoqtPlayer({ url: 'https://unused.example/moq', namespace: 'finite', knownTracks: known });
    const conn = new MoqtConnection(18);
    const source = { initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), mediaElement: null,
      destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null };
    const internal = player as unknown as {
      connection: MoqtConnection; mediaSource: typeof source; mseOutputEpoch: object | null;
      mseCompletions: Map<'video' | 'audio', { conn: MoqtConnection; source: typeof source; outputEpoch: object | null; selection: object; key: string; emitted: boolean }>;
      reconsiderMseTrackEnds(): void;
    };
    internal.connection = conn; internal.mediaSource = source;
    const stale = {};   // an output lifetime that has since been replaced
    internal.mseCompletions = new Map([
      ['video', { conn, source, outputEpoch: stale, selection: known.video, key: identityKey(['finite'], 'video'), emitted: false }],
      ['audio', { conn, source, outputEpoch: internal.mseOutputEpoch, selection: known.audio, key: identityKey(['finite'], 'audio'), emitted: false }],
    ]);
    const seen: string[] = [];
    player.on('track_ended', event => { seen.push(event.mediaType); });
    try {
      internal.reconsiderMseTrackEnds();
      expect(seen, 'only the current-epoch completion is notified').toEqual(['audio']);
      expect(internal.mseCompletions.has('video'), 'the stale record is dropped').toBe(false);
    } finally { await player.destroy(); await conn.close(); }
  });

  it.each([false, true])('a held liveness refresh falls back only if completion has not cancelled it: ended=%s', async completed => {
    const h = await finiteVideo();
    h.player.play();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.spyOn(h.client, 'requestUpdate').mockImplementation(async () => { await gate; throw new Error('refresh refused'); });
    const subscribe = vi.spyOn(h.client, 'subscribe');
    const internals = h.player as unknown as { handleTrackStarvation(track: {
      requestId: bigint; trackAlias: bigint; mediaType: 'video'; trackName: string;
    }, starvedForMs: number, healthyForMs: number): Promise<void> };
    const task = internals.handleTrackStarvation({ requestId: h.requestId, trackAlias: 101n, mediaType: 'video', trackName: 'video' }, 100, 0);
    try {
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      if (completed) { await h.done(); await vi.waitFor(() => expect(h.unsubscribed).toHaveLength(1)); }
      release(); await task; await flush(256);
      expect(subscribe).toHaveBeenCalledTimes(completed ? 0 : 1);
    } finally { release(); await task; await h.destroy(); }
  });
});
