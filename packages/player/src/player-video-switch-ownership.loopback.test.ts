/**
 * Public video-switch lifecycle over draft-18 request streams. The assembler
 * forwards bytes unchanged; the source records the initialization and offset
 * in force at each append. Neither witness filters wrong-owner delivery.
 * CMSF-00/01 §3.2/3.4 and MSF-00/01 §4.2 require aligned, decodable splices.
 * MSE §5.2/5.5.7: https://www.w3.org/TR/media-source-2/
 */
import { describe, expect, it, vi } from 'vitest';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { audioInit, buildChunk, buildInit, NON_SYNC_FLAGS, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '../../locmaf/src/index.js';
import { MoqtPlayer } from './player.js';
import type { MediaSourceLike } from './interfaces.js';
import type { PlayerError } from './errors.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
type Media = 'video' | 'audio';
type Ref = { name: string; namespace: string[] };
const catalogRef: Ref = { name: 'catalog', namespace: ['live', 'ownership'] };
const a: Ref = { name: 'a', namespace: ['encoding', 'a'] };
const b: Ref = { name: 'b', namespace: ['encoding', 'b'] };
const c: Ref = { name: 'c', namespace: ['encoding', 'c'] };
const audio: Ref = { name: 'audio', namespace: ['sound', 'main'] };
const key = (ref: Ref) => JSON.stringify([ref.namespace, ref.name]);
const oldCodec = 'avc1.640028';
const nextCodec = 'avc1.64001e';
const oldInit = videoInit();
const nextInit = buildInit({ trackId: 3, timescale: 90000, handler: 'vide' });
const avcC = Buffer.from(nextInit).indexOf('avcC');
nextInit[avcC + 7] = 30;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const chunk = (media: Media, group: bigint, trackId = media === 'audio' ? 2 : 1) => buildChunk({
  trackId, bmdt: group * 9000n,
  samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0),
});

function peer() {
  const { a: transport, b: remote } = createLoopback();
  const client = new MoqtConnection(18);
  const server = new MoqtConnection(18, { role: 'server' });
  const requests: Array<Ref & { id: bigint }> = [];
  const stopped: bigint[] = [];
  const errors: Error[] = [];
  const aliases = new Map<string, bigint>();
  const holds: Array<ReturnType<typeof deferred>> = [];
  let started: Promise<void> | undefined;
  server.onSubscribe = (id, namespace, name) => {
    requests.push({ id, namespace: namespace.map(field => dec.decode(field)), name: dec.decode(name) });
  };
  server.onSubscribeClosed = id => { stopped.push(id); };
  server.onError = error => { errors.push(error); };
  const request = (target: Ref) => {
    const matches = requests.filter(candidate => key(candidate) === key(target));
    expect(matches, `one wire request for ${key(target)}`).toHaveLength(1);
    return matches[0]!;
  };
  return {
    client, requests, stopped, errors, request,
    start() {
      started = server.connect(remote, {});
      void started.catch(error => { errors.push(error); });
      return transport;
    },
    // Only the returned promise is delayed: allocation, emission, response,
    // alias binding and object delivery still run in the real connection.
    holdSubscribe(target: Ref) {
      const gate = deferred();
      holds.push(gate);
      const returned: bigint[] = [];
      const subscribe = client.subscribe.bind(client);
      const spy = vi.spyOn(client, 'subscribe').mockImplementation(async (ns, name, options) => {
        const id = await subscribe(ns, name, options);
        if (key({ namespace: ns.map(field => dec.decode(field)), name: dec.decode(name) }) === key(target)) {
          returned.push(id);
          await gate.promise;
        }
        return id;
      });
      return { returned, release: gate.resolve, restore: () => spy.mockRestore() };
    },
    async accept(target: Ref, alias: bigint) {
      await flush(256);
      await server.acceptSubscribe(request(target).id, alias);
      aliases.set(key(target), alias);
      await flush(256);
    },
    async acceptRequest(id: bigint, target: Ref, alias: bigint) {
      expect(requests.find(request => request.id === id)).toMatchObject(target);
      await server.acceptSubscribe(id, alias);
      aliases.set(key(target), alias);
      await flush(256);
    },
    async send(target: Ref, payload: Uint8Array, group: bigint, objectId = 0n) {
      const alias = aliases.get(key(target));
      expect(alias, `accepted alias for ${key(target)}`).toBeDefined();
      const stream = await server.openSubgroup(alias!, group, objectId, { publisherPriority: 128 });
      await server.sendObject(stream, objectId, payload);
      await server.closeSubgroup(stream);
      await flush(256);
    },
    release() { for (const gate of holds) gate.resolve(); },
    async destroy() {
      await client.close();
      await server.close();
      await started?.catch(() => {});
    },
  };
}

function sourceWitness() {
  const current = new Map<Media, { codec: string; init: Uint8Array }>();
  const offsets = new Map<Media, number>();
  const appends: Array<{ media: Media; track: string; group: bigint | undefined;
    bytes: Uint8Array; init: Uint8Array | undefined; offset: number | undefined }> = [];
  const retypes: Array<{ media: Media; codec: string; init: Uint8Array }> = [];
  const gates: Array<ReturnType<typeof deferred>> = [];
  let retype: (() => Promise<void>) | undefined;
  let destroyed = false;
  const source: MediaSourceLike = {
    initialize(config) {
      for (const media of ['video', 'audio'] as const) {
        const entry = config[media];
        if (entry) current.set(media, { codec: entry.codec, init: entry.initData.slice() });
      }
      return true;
    },
    appendChunk(media, bytes, track, group) {
      appends.push({ media, track, group, bytes: bytes.slice(), init: current.get(media)?.init.slice(), offset: offsets.get(media) });
    },
    async changeType(media, codec, init) {
      retypes.push({ media, codec, init: init.slice() });
      // MSE may change type/offset before parsing the new init fails.
      current.set(media, { codec, init: init.slice() });
      offsets.set(media, 99);
      await retype?.();
    },
    getTimestampOffset: media => offsets.get(media),
    setTimestampOffset: (media, value) => { offsets.set(media, value); },
    reset: () => {}, endOfStream: () => {}, destroy: () => { destroyed = true; },
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
  };
  return {
    source, appends, retypes, current, offsets,
    get destroyed() { return destroyed; },
    holdRetype() {
      const gate = deferred();
      gates.push(gate);
      retype = () => gate.promise;
      return gate.resolve;
    },
    setRetype(callback: () => Promise<void>) { retype = callback; },
    release() { for (const gate of gates) gate.resolve(); },
  };
}

function catalog(withAudio: boolean, rootInit?: Uint8Array, declaredOld = oldInit) {
  const video = (ref: Ref, codec: string, init: Uint8Array, bitrate: number) => ({
    name: ref.name, namespace: ref.namespace.join('/'), role: 'video', packaging: 'cmaf', isLive: true,
    renderGroup: 1, altGroup: 1, codec, width: 640, height: 360, bitrate,
    ...(ref.name === b.name && rootInit !== undefined
      ? { initRef: 'b-init' } : { initData: Buffer.from(init).toString('base64') }),
  });
  return enc.encode(JSON.stringify({ version: rootInit === undefined ? 1 : '1',
    ...(rootInit === undefined ? {} : { initDataList: [{ id: 'b-init', type: 'inline', data: Buffer.from(rootInit).toString('base64') }] }),
    tracks: [
    video(a, oldCodec, declaredOld, 800_000), video(b, nextCodec, nextInit, 600_000), video(c, oldCodec, oldInit, 400_000),
    ...(withAudio ? [{ name: audio.name, namespace: audio.namespace.join('/'), role: 'audio',
      packaging: 'cmaf', isLive: true, renderGroup: 1, altGroup: 2, codec: 'mp4a.40.2',
      samplerate: 48000, channelConfig: '2', initData: Buffer.from(audioInit()).toString('base64') }] : []),
  ] }));
}

async function fixture(withAudio = false, catalogPayload = catalog(withAudio)) {
  const wire = peer();
  const mse = sourceWitness();
  const received: Array<{ track: string; group: bigint }> = [];
  const switched: string[] = [];
  const failed: string[] = [];
  const errors: PlayerError[] = [];
  const selected: string[] = [];
  const player = new MoqtPlayer({
    url: 'https://loopback.invalid/moq', namespace: catalogRef.namespace, draftVersion: 18,
    createConnection: () => wire.client as unknown as PlayerConnection,
    createTransport: () => Promise.resolve(wire.start()), catalogBootstrap: 'subscribe',
    disableAudio: !withAudio, autoQuality: false, cmafBootstrapTimeoutMs: 0,
    selection: { videoTrack: { name: a.name, namespace: a.namespace.join('/') } },
    createMediaSource: () => mse.source,
    createCmafAssembler: callbacks => ({
      push(media, track, group, payload) {
        callbacks.onSegment(media, payload, track, group);
      },
      selectTrack: (_media, track) => { selected.push(track); },
      setInitSegment: () => {}, getEpoch: () => null, reset: () => {}, destroy: () => {},
    }),
  });
  player.on('media_object', event => { received.push({ track: event.trackName, group: event.groupId }); });
  player.on('quality_switched', event => { switched.push(event.toTrackName); });
  player.on('quality_switch_failed', event => { failed.push(event.toTrackName); });
  player.on('error', event => { errors.push(event.error); });
  async function destroy() {
    wire.release();
    mse.release();
    await flush(256);
    await player.destroy();
    await wire.destroy();
    vi.restoreAllMocks();
  }
  try {
    await player.load();
    await wire.accept(catalogRef, 100n);
    await wire.send(catalogRef, catalogPayload, 1n);
    await wire.accept(a, 200n);
    if (withAudio) await wire.accept(audio, 201n);
    await wire.send(a, chunk('video', 1n), 1n);
    if (withAudio) await wire.send(audio, chunk('audio', 1n), 1n);
    expect(mse.appends.filter(entry => entry.track === a.name)).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(wire.errors).toEqual([]);
  } catch (error) {
    await destroy();
    throw error;
  }
  return { player, wire, mse, received, switched, failed, errors, selected, destroy };
}

describe('video switch request and source ownership', () => {
  it('healthy control: commits the accepted target after init and preserves its wire identity', async () => {
    const h = await fixture();
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      expect(h.switched).toEqual([]);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      const payload = chunk('video', 2n, 3);
      await h.wire.send(b, payload, 2n);
      expect(h.mse.retypes).toEqual([{ media: 'video', codec: nextCodec, init: nextInit }]);
      expect(h.switched).toEqual([b.name]);
      expect(h.mse.appends.at(-1)).toMatchObject({ track: b.name, group: 2n, bytes: payload, init: nextInit });
      expect(h.wire.stopped).toContain(h.wire.request(a).id);
      expect(h.wire.stopped).not.toContain(h.wire.request(b).id);
      expect(h.errors).toEqual([]);
      expect(h.wire.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('stages accepted target data delivered before the subscribe promise returns', async () => {
    const h = await fixture();
    const hold = h.wire.holdSubscribe(b);
    const switching = h.player.selectVideoTrack(b.name);
    void switching.catch(() => {});
    try {
      await h.wire.accept(b, 300n);
      expect(hold.returned).toEqual([h.wire.request(b).id]);
      const payload = chunk('video', 2n, 3);
      await h.wire.send(b, payload, 2n);
      expect(h.received).toContainEqual({ track: b.name, group: 2n });
      const wrongInit = h.mse.appends.filter(entry => entry.track === b.name && Buffer.from(entry.init ?? []).equals(oldInit));
      expect.soft(wrongInit.map(entry => entry.group),
        'target bytes must never reach the running source under the old initialization').toEqual([]);
      hold.release();
      await switching;
      await flush(256);
      expect(h.mse.appends.filter(entry => entry.track === b.name)).toEqual([
        expect.objectContaining({ group: 2n, bytes: payload, init: nextInit }),
      ]);
      expect(h.switched).toEqual([b.name]);
      expect(h.wire.stopped).not.toContain(h.wire.request(b).id);
    } finally {
      hold.release();
      await switching.catch(() => {});
      await h.destroy();
    }
  });

  it('a late subscribe completion cannot overwrite or cancel a newer prepared target', async () => {
    const h = await fixture();
    const hold = h.wire.holdSubscribe(b);
    const first = h.player.selectVideoTrack(b.name);
    void first.catch(() => {});
    try {
      await h.wire.accept(b, 300n);
      expect(hold.returned).toEqual([h.wire.request(b).id]);
      await h.player.selectVideoTrack(c.name);
      await h.wire.accept(c, 400n);
      hold.release();
      await first.catch(() => {});
      await flush(256);
      expect.soft(h.wire.stopped, 'only the superseded target is cancelled').toContain(h.wire.request(b).id);
      expect.soft(h.wire.stopped).not.toContain(h.wire.request(c).id);
      expect.soft(h.wire.stopped).not.toContain(h.wire.request(a).id);
      expect.soft(h.switched).toEqual([]);
      expect.soft(h.mse.appends.filter(entry => entry.track === b.name)).toHaveLength(0);
      await h.wire.send(c, chunk('video', 3n), 3n);
      expect(h.switched).toEqual([c.name]);
      expect(h.mse.appends.at(-1)).toMatchObject({ track: c.name, group: 3n, init: oldInit });
      expect(h.wire.stopped).not.toContain(h.wire.request(c).id);
      expect(h.wire.errors).toEqual([]);
    } finally {
      hold.release();
      await first.catch(() => {});
      await h.destroy();
    }
  });

  it.each([false, true])('restores mutated initialization and offset after rejected retype (restore fails: %s)', async restoreFails => {
    const h = await fixture();
    // This is the adapter's live public offset, after the initial append.
    h.mse.source.setTimestampOffset!('video', 7.25);
    const restore = deferred();
    let calls = 0;
    h.mse.setRetype(async () => {
      calls++;
      if (calls === 1) throw new Error('target init rejected after changeType');
      await restore.promise;
      if (restoreFails) throw new Error('old init restoration rejected');
    });
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      expect.soft(h.mse.retypes.map(entry => entry.codec), 'a rejected retype may already have mutated the source')
        .toEqual([nextCodec, oldCodec]);
      expect(h.switched).toEqual([]);
      await h.wire.send(a, chunk('video', 3n), 3n);
      expect.soft(h.mse.appends.filter(entry => entry.track === a.name && entry.group === 3n),
        'old bytes stay fenced until initialization and offset restoration have settled').toHaveLength(0);
      expect.soft(h.failed, 'rollback is not complete while restoring the source').toEqual([]);
      restore.resolve();
      await flush(512);
      if (restoreFails) {
        expect.soft(h.errors.map(error => error.severity), 'unrestored source is fatal').toContain('fatal');
        expect.soft(h.failed, 'do not report successful rollback when restoring the old source failed').toEqual([]);
        if (h.wire.client.session.state !== 'closed' && !h.wire.stopped.includes(h.wire.request(a).id)) {
          await h.wire.send(a, chunk('video', 4n), 4n);
        }
        expect(h.mse.appends.filter(entry => entry.track === a.name && entry.group === 4n)).toHaveLength(0);
      } else {
        expect.soft(h.mse.retypes[1]?.init).toEqual(oldInit);
        expect.soft(h.mse.offsets.get('video')).toBe(7.25);
        expect(h.failed).toEqual([b.name]);
        expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
        expect(h.wire.stopped).toContain(h.wire.request(b).id);
        await h.wire.send(a, chunk('video', 4n), 4n);
        const resumed = h.mse.appends.filter(entry => entry.track === a.name && entry.group === 4n);
        expect(resumed).toHaveLength(1);
        expect(resumed[0]?.init).toEqual(oldInit);
        expect(resumed[0]?.offset).toBe(7.25);
        expect(h.errors.some(error => error.severity === 'fatal')).toBe(false);
      }
    } finally { restore.resolve(); await h.destroy(); }
  });

  it('destroy during a held retype prevents late commit and quality_switched', async () => {
    const h = await fixture();
    const release = h.mse.holdRetype();
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      expect(h.mse.retypes).toHaveLength(1);
      expect(h.switched).toEqual([]);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      await h.player.destroy();
      expect(h.mse.destroyed).toBe(true);
      const appends = h.mse.appends.length;
      const commits = h.selected.length;
      const switches = h.player.stats.qualitySwitchCount;
      release();
      await flush(512);
      expect.soft(h.switched).toEqual([]);
      expect(h.selected).toHaveLength(commits);
      expect(h.mse.appends).toHaveLength(appends);
      expect(h.player.stats.qualitySwitchCount).toBe(switches);
    } finally { release(); await h.destroy(); }
  });

  it('continues established audio while video reconfiguration is held', async () => {
    const h = await fixture(true);
    const release = h.mse.holdRetype();
    try {
      expect(h.mse.appends.filter(entry => entry.track === audio.name)).toHaveLength(1);
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      expect(h.mse.retypes).toHaveLength(1);
      await h.wire.send(audio, chunk('audio', 2n), 2n);
      expect(h.mse.appends.filter(entry => entry.track === audio.name)).toEqual([
        expect.objectContaining({ group: 1n, init: audioInit(), offset: 0 }),
        expect.objectContaining({ group: 2n, init: audioInit(), offset: 0 }),
      ]);
      expect(h.wire.stopped).not.toContain(h.wire.request(audio).id);
      expect(h.wire.requests.filter(request => key(request) === key(audio))).toHaveLength(1);
      expect(h.switched).toEqual([]);
      release();
      await flush(256);
      expect(h.switched).toEqual([b.name]);
      await h.wire.send(audio, chunk('audio', 3n), 3n);
      expect(h.mse.appends.at(-1)).toMatchObject({ track: audio.name, group: 3n, init: audioInit(), offset: 0 });
      expect(h.errors).toEqual([]);
      expect(h.wire.errors).toEqual([]);
    } finally { release(); await h.destroy(); }
  });

  it.each(['100-object', '8-MiB byte'] as const)('refuses target exceeding the %s staging budget during native retype', async budget => {
    const h = await fixture();
    const release = h.mse.holdRetype();
    h.mse.source.setTimestampOffset!('video', 7.25);
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      expect(h.mse.retypes.map(entry => entry.codec)).toEqual([nextCodec]);
      if (budget === '100-object') {
        for (let i = 0; i < 101 && !h.wire.stopped.includes(h.wire.request(b).id); i++) {
          const group = 3n + BigInt(i);
          await h.wire.send(b, chunk('video', group, 3), group);
        }
      } else {
        const mdat = new Uint8Array(8 * 1024 * 1024 + 1);
        const payload = buildChunk({ trackId: 3, bmdt: 27000n,
          samples: [{ duration: 3000, size: mdat.byteLength, flags: SYNC_FLAGS }], mdat });
        await h.wire.send(b, payload, 3n);
        expect(h.received).toContainEqual({ track: b.name, group: 3n });
      }
      expect.soft(h.wire.stopped, 'overflow cancels the accepted target request').toContain(h.wire.request(b).id);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      await h.wire.send(a, chunk('video', 200n), 200n);
      expect.soft(h.mse.appends.filter(entry => entry.group === 200n),
        'old source remains fenced while the native retype is unsettled').toHaveLength(0);
      expect(h.switched).toEqual([]);
      expect(h.failed, 'rollback cannot be reported before the native operation settles and is undone').toEqual([]);
      expect(h.mse.retypes.map(entry => entry.codec)).toEqual([nextCodec]);
      // Resolving this gate also makes the subsequent restore immediate.
      release();
      await flush(512);
      expect.soft(h.mse.retypes.map(entry => entry.codec), 'cancelled native retype must be undone').toEqual([nextCodec, oldCodec]);
      expect.soft(h.mse.current.get('video')?.init && Buffer.from(h.mse.current.get('video')!.init).equals(oldInit)).toBe(true);
      expect.soft(h.mse.offsets.get('video')).toBe(7.25);
      expect.soft(h.switched).toEqual([]);
      expect.soft(h.failed).toEqual([b.name]);
      expect.soft(h.mse.appends.filter(entry => entry.track === b.name).map(entry => entry.group)).toEqual([]);
      expect.soft(h.wire.stopped).not.toContain(h.wire.request(a).id);
      if (!h.wire.stopped.includes(h.wire.request(a).id)) await h.wire.send(a, chunk('video', 201n), 201n);
      const resumed = h.mse.appends.filter(entry => entry.track === a.name && entry.group === 201n);
      expect.soft(resumed).toHaveLength(1);
      expect.soft(resumed[0]?.init && Buffer.from(resumed[0].init).equals(oldInit)).toBe(true);
      expect.soft(resumed[0]?.offset).toBe(7.25);
      expect(h.errors.some(error => error.severity === 'fatal')).toBe(false);
      expect(h.wire.errors).toEqual([]);
    } finally { release(); await h.destroy(); }
  });

  it('destroy rejects a held subscription caller before late return and leaves no new requests', async () => {
    const h = await fixture();
    const hold = h.wire.holdSubscribe(b);
    const outcome: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } = { status: 'pending' };
    const selection = h.player.selectVideoTrack(b.name).then(
      () => { outcome.status = 'resolved'; },
      error => { outcome.status = 'rejected'; outcome.error = error; },
    );
    try {
      await h.wire.accept(b, 300n);
      expect(hold.returned).toEqual([h.wire.request(b).id]);
      expect(outcome.status).toBe('pending');
      await h.player.destroy();
      await flush(512);
      expect.soft(outcome.status, 'destroy settles selection without releasing the held subscribe return').not.toBe('pending');
      expect.soft(outcome.status, 'a destroyed selection rejects rather than reporting success').toBe('rejected');
      expect.soft(outcome.error).toBeInstanceOf(Error);
      const requests = h.wire.requests.slice();
      const appends = h.mse.appends.length;
      const commits = h.selected.length;
      const state = h.player.state;
      hold.release();
      await selection;
      await flush(512);
      expect(h.wire.requests).toEqual(requests);
      expect(h.mse.appends).toHaveLength(appends);
      expect(h.selected).toHaveLength(commits);
      expect(h.player.state).toBe(state);
      expect(h.player.stats.qualitySwitchCount).toBe(0);
      expect(h.switched).toEqual([]);
      expect(h.failed).toEqual([]);
    } finally {
      hold.release();
      await selection;
      await h.destroy();
    }
  });

  it('a native retype held past the default connection timeout is fatal and cannot commit after late settlement', async () => {
    const h = await fixture();
    const release = h.mse.holdRetype();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      expect(h.mse.retypes.map(entry => entry.codec)).toEqual([nextCodec]);
      expect(h.switched).toEqual([]);
      expect(h.failed).toEqual([]);
      expect(h.errors).toEqual([]);
      // connectionTimeoutMs defaults to 10 seconds; native mutation is
      // already in flight, so its timeout cannot promise healthy rollback.
      await vi.advanceTimersByTimeAsync(10_001);
      await flush(256);
      expect.soft(h.errors.map(error => error.severity)).toContain('fatal');
      expect.soft(h.switched).toEqual([]);
      expect.soft(h.failed).toEqual([]);
      expect.soft(h.mse.appends.filter(entry => entry.track === b.name)).toHaveLength(0);
      release();
      await flush(512);
      expect(h.switched).toEqual([]);
      expect(h.failed).toEqual([]);
      expect(h.mse.appends.filter(entry => entry.track === b.name)).toHaveLength(0);
      expect(h.selected).toEqual([]);
      expect(h.player.stats.qualitySwitchCount).toBe(0);
    } finally {
      release();
      try { await h.destroy(); } finally { vi.useRealTimers(); }
    }
  });

  it('refuses a known non-sync sample at object zero after the staging deadline without force-splicing', async () => {
    const h = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      const delta = buildChunk({ trackId: 3, bmdt: 18000n,
        samples: [{ duration: 3000, size: 4, flags: NON_SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0) });
      await h.wire.send(b, delta, 2n);
      expect(h.received).toContainEqual({ track: b.name, group: 2n });
      expect(h.mse.retypes).toHaveLength(0);
      expect(h.switched).toEqual([]);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      await vi.advanceTimersByTimeAsync(3_001);
      await flush(256);
      expect(h.switched).toEqual([]);
      expect(h.mse.appends.filter(entry => entry.track === b.name)).toHaveLength(0);
      expect(h.mse.retypes).toHaveLength(0);
      expect(h.wire.stopped).toContain(h.wire.request(b).id);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      expect(h.failed).toEqual([b.name]);
      await h.wire.send(a, chunk('video', 3n), 3n);
      expect(h.mse.appends.at(-1)?.track).toBe(a.name);
      expect(h.mse.appends.at(-1)?.group).toBe(3n);
      expect(h.mse.appends.at(-1)?.init).toEqual(oldInit);
      expect(h.errors.some(error => error.severity === 'fatal')).toBe(false);
      expect(h.wire.errors).toEqual([]);
    } finally {
      await h.destroy();
      vi.useRealTimers();
    }
  });

  it.each([1, 2])('target replay append %i throwing after old-track retirement is fatal without claiming rollback', async failedAppend => {
    const h = await fixture();
    const release = h.mse.holdRetype();
    let attempts = 0;
    const cause = new Error('target replay append refused');
    const append = h.mse.source.appendChunk.bind(h.mse.source);
    vi.spyOn(h.mse.source, 'appendChunk').mockImplementation((media, bytes, track, group) => {
      if (track === b.name && ++attempts === failedAppend) throw cause;
      append(media, bytes, track, group);
    });
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      await h.wire.send(b, chunk('video', 3n, 3), 3n);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      release();
      await flush(512);
      expect(attempts).toBe(failedAppend);
      expect(h.mse.appends.filter(entry => entry.track === b.name).map(entry => entry.group))
        .toEqual(failedAppend === 1 ? [] : [2n]);
      expect(h.wire.stopped).toContain(h.wire.request(a).id);
      expect.soft(h.errors.filter(error => error.severity === 'fatal').map(error => error.cause),
        'accepted target appends and old-request retirement cannot be rolled back').toContain(cause);
      expect.soft(h.failed).toEqual([]);
      expect(h.switched).toEqual([]);
      expect(h.player.stats.qualitySwitchCount).toBe(0);
      expect(h.wire.errors).toEqual([]);
    } finally { release(); await h.destroy(); }
  });

  it('destroy reentered from the first target append stops replay and prevents quality commit', async () => {
    const h = await fixture();
    const release = h.mse.holdRetype();
    let destroying: Promise<void> | undefined;
    const append = h.mse.source.appendChunk.bind(h.mse.source);
    vi.spyOn(h.mse.source, 'appendChunk').mockImplementation((media, bytes, track, group) => {
      append(media, bytes, track, group);
      if (track === b.name && destroying === undefined) destroying = h.player.destroy();
    });
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      await h.wire.send(b, chunk('video', 3n, 3), 3n);
      release();
      await flush(512);
      expect(destroying).toBeDefined();
      await destroying;
      expect(h.mse.destroyed).toBe(true);
      expect(h.mse.appends.filter(entry => entry.track === b.name).map(entry => entry.group)).toEqual([2n]);
      expect.soft(h.switched).toEqual([]);
      expect(h.failed).toEqual([]);
      expect(h.player.stats.qualitySwitchCount).toBe(0);
    } finally { release(); await destroying; await h.destroy(); }
  });

  it.each([true, false])('catalog root refresh keeps readiness tied to installed init (header changed: %s)', async changed => {
    const h = await fixture(false, catalog(false, nextInit));
    const refreshedInit = nextInit.slice();
    if (changed) {
      const trex = Buffer.from(refreshedInit).indexOf('trex');
      new DataView(refreshedInit.buffer).setUint32(trex + 24, NON_SYNC_FLAGS);
    }
    const delta = buildChunk({ trackId: 3, bmdt: 18000n,
      samples: [{ duration: 3000, size: 4, flags: NON_SYNC_FLAGS }],
      trun: { duration: true, size: true, flags: false }, mdat: Uint8Array.of(0, 0, 0, 0) });
    try {
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(catalogRef, catalog(false, refreshedInit), 2n);
      expect(readCmafChunkSamples(delta, parseLocmafTrackContext(refreshedInit)).effective.flags)
        .toEqual([changed ? NON_SYNC_FLAGS : 0]);
      // Object 1 arrives before its group's explicit-sync object 0, on a
      // separate subgroup. Its flags come only from the effective header.
      await h.wire.send(b, delta, 2n, 1n);
      for (const entry of h.mse.appends.filter(entry => entry.track === b.name)) {
        expect.soft(readCmafChunkSamples(entry.bytes, parseLocmafTrackContext(entry.init!)).effective.flags,
          'the installed header must never classify the splice as non-sync').not.toContain(NON_SYNC_FLAGS);
      }
      if (changed) {
        expect.soft(h.switched, 'a changed header invalidates the prepared attempt').toEqual([]);
        expect.soft(h.mse.appends.filter(entry => entry.track === b.name)).toHaveLength(0);
        expect.soft(h.mse.retypes).toHaveLength(0);
        expect(h.wire.stopped).toContain(h.wire.request(b).id);
        expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
        expect(h.failed).toEqual([b.name]);
        await h.wire.send(a, chunk('video', 3n), 3n);
        expect(h.mse.appends.at(-1)?.init).toEqual(oldInit);
        await h.player.selectVideoTrack(b.name);
        await flush(256);
        const requests = h.wire.requests.filter(request => key(request) === key(b));
        expect(requests).toHaveLength(2);
        // The replacement request has the same full identity, a new request
        // ID, and a separate accepted alias; the old one remains retired.
        await h.wire.acceptRequest(requests[1]!.id, b, 301n);
        await h.wire.send(b, delta, 2n, 1n);
        expect(h.switched).toEqual([]);
        expect(h.mse.retypes).toHaveLength(0);
        expect(h.mse.appends.filter(entry => entry.track === b.name)).toHaveLength(0);
        await h.wire.send(b, chunk('video', 2n, 3), 2n);
      }
      expect(h.switched).toEqual([b.name]);
      expect(h.mse.retypes).toHaveLength(1);
      const installed = h.mse.retypes[0]!.init;
      expect(installed).toEqual(refreshedInit);
      const delivered = h.mse.appends.filter(entry => entry.track === b.name);
      // Changed header: object 1 (the delta) was staged before its group's
      // object 0, on another subgroup. Staging replays in location order, so
      // the keyframe is appended first and the delta follows it — rather than
      // the delta reaching MSE first and being discarded ahead of a keyframe.
      expect(delivered).toHaveLength(changed ? 2 : 1);
      expect(readCmafChunkSamples(delivered[0]!.bytes, parseLocmafTrackContext(installed)).effective.flags)
        .toEqual([changed ? SYNC_FLAGS : 0]);
      if (changed) {
        expect(readCmafChunkSamples(delivered[1]!.bytes, parseLocmafTrackContext(installed)).effective.flags)
          .toEqual([NON_SYNC_FLAGS]);
      }
      expect(h.errors.some(error => error.severity === 'fatal')).toBe(false);
      expect(h.wire.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it.each([false, true])('restores installed initialization after rejected target retype (old catalog header changed: %s)', async changed => {
    const h = await fixture();
    try {
      const declaredOld = changed ? buildInit({ trackId: 9, timescale: 90000, handler: 'vide' }) : oldInit;
      await h.wire.send(catalogRef, catalog(false, undefined, declaredOld), 2n);
      expect(h.mse.current.get('video')?.init).toEqual(oldInit);
      let calls = 0;
      h.mse.setRetype(async () => {
        if (++calls === 1) throw new Error('target init rejected after mutation');
      });
      await h.player.selectVideoTrack(b.name);
      await h.wire.accept(b, 300n);
      await h.wire.send(b, chunk('video', 2n, 3), 2n);
      expect(h.mse.retypes.map(entry => entry.codec)).toEqual([nextCodec, oldCodec]);
      expect(h.failed).toEqual([b.name]);
      expect(h.switched).toEqual([]);
      expect(h.wire.stopped).not.toContain(h.wire.request(a).id);
      expect(h.wire.stopped).toContain(h.wire.request(b).id);
      // A catalog refresh advertises bytes; it does not install them. Undo
      // must use the header that was active before the failed mutation.
      expect.soft(Buffer.from(h.mse.retypes[1]?.init ?? []).equals(oldInit),
        'restore receives the installed header, not a later catalog declaration').toBe(true);
      expect.soft(Buffer.from(h.mse.current.get('video')?.init ?? []).equals(oldInit)).toBe(true);
      await h.wire.send(a, chunk('video', 3n), 3n);
      const resumed = h.mse.appends.filter(entry => entry.track === a.name && entry.group === 3n);
      expect(resumed).toHaveLength(1);
      expect(Buffer.from(resumed[0]?.init ?? []).equals(oldInit),
        'resumed old bytes must use the initialization that was installed before the switch').toBe(true);
      expect(h.errors.some(error => error.severity === 'fatal')).toBe(false);
      expect(h.wire.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
});
