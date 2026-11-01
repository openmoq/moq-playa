/**
 * Selected-track namespace ownership through public player methods and
 * real MoqtConnection peers. MSF-01 §5.2.14 / cf01 §3.2.18 resolve depends in
 * the DECLARING track's namespace; a matching bare name elsewhere is unrelated.
 *
 * MSE and the assembler are explicit stubs. Accepted aliases and media_object /
 * quality_switched events establish routing and switch adoption, NOT rendering.
 * Catalog discovery stays in config.namespace; no joining-FETCH rewrite is
 * implied (joining FETCH identifies its subscription by request ID).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { isTrackPackagingSupported, parseCatalogAuto } from '@openmoq/msf';
import { PublishDoneCode18, varint } from '@openmoq/transport';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildChunk, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const CATALOG_NS = ['live', 'show'];
const MEDIA_NS = ['camera', 'main'];
interface Ref { name: string; namespace: readonly string[] }
interface Request extends Ref { id: bigint }
type Track = Record<string, unknown> & { name: string };
const ref = (name: string, namespace: readonly string[] = MEDIA_NS): Ref => ({ name, namespace });
const key = (r: Ref) => JSON.stringify([r.namespace, r.name]);
const video = (name: string, extra: Record<string, unknown> = {}): Track => ({
  name, namespace: MEDIA_NS.join('/'), role: 'video', packaging: 'cmaf',
  isLive: true, codec: 'avc1.640028', width: 640, height: 360,
  bitrate: 500_000, renderGroup: 1, altGroup: 1, initRef: 'video-init', ...extra,
});
const catalog = (tracks: Track[]) => enc.encode(JSON.stringify({
  version: '1',
  initDataList: [
    { id: 'video-init', type: 'inline', data: Buffer.from(videoInit()).toString('base64') },
    ...(tracks.some(t => t.packaging === 'locmaf') ? [{
      id: 'event-init', type: 'inline',
      data: readFileSync(new URL('../../../conformance/media/vectors/locmaf/event-only/init.mp4', import.meta.url)).toString('base64'),
    }] : []),
  ],
  tracks,
}));
const chunk = (group: bigint) => buildChunk({
  trackId: 1, bmdt: group * 9000n,
  samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0),
});

async function fixture(tracks: Track[], config: Partial<MoqtPlayerConfig> = {}) {
  const bytes = catalog(tracks);
  // Fail fixture validation before any expected-failure assertion can mask it.
  const parsed = parseCatalogAuto(bytes, CATALOG_NS);
  expect(parsed.tracks).toHaveLength(tracks.length);
  expect(parsed.tracks.every(isTrackPackagingSupported), 'all fixture packaging versions are supported').toBe(true);
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18);
  const server = new MoqtConnection(18, { role: 'server' });
  const requests: Request[] = [];
  const aliases = new Map<bigint, bigint>();
  const errors: string[] = [];
  const received: Array<{ name: string; group: bigint }> = [];
  const switched = vi.fn();
  server.onError = error => { errors.push(error.message); };
  server.onSubscribe = (id, namespace, name) => {
    requests.push({ id, namespace: namespace.map(f => dec.decode(f)), name: dec.decode(name) });
  };
  server.onFetch = () => {};
  let started: Promise<void> | undefined;
  const player = new MoqtPlayer({
    url: 'https://namespace.example/moq', namespace: CATALOG_NS, draftVersion: 18,
    catalogBootstrap: 'subscribe', disableAudio: true, startLevel: 'lowest',
    selection: { renderGroup: 1 },
    createConnection: () => client as unknown as PlayerConnection,
    createTransport: () => {
      started = server.connect(b, {});
      void started.catch(error => { errors.push(String(error)); });
      return Promise.resolve(a);
    },
    // No DOM, MSE, decoder or rendering claim: only assembly callback routing.
    createMediaSource: () => ({
      initialize: () => true, appendChunk: () => {}, reset: () => {},
      endOfStream: () => {}, destroy: () => {}, mediaElement: null,
      onFirstFrame: null, onError: null, onStall: null,
    }),
    createCmafAssembler: callbacks => ({
      push: (mediaType, track, group, payload) => callbacks.onSegment(mediaType, payload, track, group),
      getEpoch: () => null, reset: () => {}, destroy: () => {},
    }),
    ...config,
  } as MoqtPlayerConfig);
  player.on('error', event => { errors.push(event.error.message); });
  player.on('media_object', event => { received.push({ name: event.trackName, group: event.groupId }); });
  player.on('quality_switched', switched);
  const media = () => requests.filter(r => r.name !== 'catalog')
    .map(({ name, namespace }) => ({ name, namespace }));
  const exactly = (target: Ref, occurrence = 0) => {
    const matches = requests.filter(r => key(r) === key(target));
    expect(matches, `request ${occurrence + 1} for ${key(target)}; wire=${JSON.stringify(media())}`)
      .toHaveLength(occurrence + 1);
    return matches[occurrence]!;
  };
  const accept = async (target: Ref, alias: bigint, occurrence = 0) => {
    await flush(256);
    const request = exactly(target, occurrence);
    await server.acceptSubscribe(request.id, alias);
    aliases.set(request.id, alias);
    await flush(128);
    return request;
  };
  const send = async (request: Request, payload: Uint8Array, group = 1n) => {
    const alias = aliases.get(request.id);
    expect(alias, 'only serve the alias accepted for this exact request').toBeDefined();
    const stream = await server.openSubgroup(alias!, group, 0n, { publisherPriority: 128 });
    await server.sendObject(stream, 0n, payload);
    await server.closeSubgroup(stream);
    await flush(256);
  };
  const destroy = async () => {
    await player.destroy();
    await flush(256);
    await client.close();
    await server.close();
    await started?.catch(() => {});
  };
  try {
    await player.load();
    await flush(256);
    expect(requests.map(({ name, namespace }) => ({ name, namespace })))
      .toEqual([ref('catalog', CATALOG_NS)]);
    const discovery = await accept(ref('catalog', CATALOG_NS), 100n);
    await send(discovery, bytes);
    expect(errors, 'supported catalog must load without fixture errors').toEqual([]);
  } catch (error) {
    await destroy();
    throw error;
  }
  return { player, server, requests, media, exactly, accept, send, received, switched, errors, destroy };
}

describe('selected-track namespace public loopback regressions', () => {
  it('resolves eventtimeline and LOCMAF depends in each DECLARING auxiliary namespace', async () => {
    for (const packaging of ['eventtimeline', 'locmaf'] as const) {
      const event = (namespace: string, name: string): Track => ({
        name, namespace, packaging, isLive: true, depends: ['video'],
        ...(packaging === 'eventtimeline'
          ? { mimeType: 'application/json', eventType: 'org.ietf.moq.cmsf.sap' }
          : { locmafVersion: '0.3', role: 'metadata', initRef: 'event-init' }),
      });
      const h = await fixture([
        video('video'),
        video('video', { namespace: 'live/show', renderGroup: 2 }),
        event('camera/main', 'selected-events'),
        event('live/show', 'unselected-events'),
      ]);
      try {
        // A same-name video really exists in each namespace. Only camera/main
        // was selected, so the live/show auxiliary must not be requested.
        expect(h.media().filter(r => r.name === 'video')).toEqual([ref('video')]);
        const selected = await h.accept(ref('video'), 200n);
        await h.send(selected, chunk(1n));
        expect(h.received).toContainEqual({ name: 'video', group: 1n });
        // Soft only to collect both packaging regressions in this one case.
        expect.soft(h.media(), packaging).toEqual([ref('video'), ref('selected-events')]);
      } finally { await h.destroy(); }
    }
  });

  it('subscribes an associated mediatimeline in its own declared namespace', async () => {
    const h = await fixture([
      video('video'),
      { name: 'timeline', namespace: 'camera/main', packaging: 'mediatimeline',
        isLive: true, mimeType: 'application/json', depends: ['video'] },
    ]);
    try {
      expect(h.media()).toEqual([ref('video'), ref('timeline')]);
      // The timeline's dependency names the selected video in the SAME
      // namespace. This case does not impose a new cross-namespace seek policy.
      const timeline = await h.accept(ref('timeline'), 201n);
      await h.send(timeline, enc.encode(JSON.stringify([[0, [1, 0], 0]])));
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('resolves public manual and bandwidth switches inside the eligible set and keeps target namespace', async () => {
    const h = await fixture([
      // First name match is outside the selected render scope, despite the
      // same altGroup number. Public name resolution must skip it.
      video('high', { namespace: 'other/view', renderGroup: 2, bitrate: 2_000_000 }),
      video('low'),
      video('high', { namespace: 'camera/hd', bitrate: 2_000_000 }),
      video('outside', { namespace: 'other/view', renderGroup: 2 }),
    ]);
    try {
      expect(h.media()).toEqual([ref('low')]);
      const low = await h.accept(ref('low'), 200n);
      await h.send(low, chunk(1n));
      expect(h.received).toContainEqual({ name: 'low', group: 1n });
      await h.player.selectVideoTrack('high');
      await flush(256);
      expect(h.media().slice(1)).toEqual([ref('high', ['camera', 'hd'])]);
      const high = await h.accept(ref('high', ['camera', 'hd']), 201n);
      await h.send(high, chunk(2n), 2n);
      await vi.waitFor(() => expect(h.switched).toHaveBeenCalledWith(
        expect.objectContaining({ toTrackName: 'high', reason: 'manual' })));
      expect(h.received).toContainEqual({ name: 'high', group: 2n });

      // Exercise the same public entry used by ABR, without claiming the
      // bandwidth estimator itself is driven by these synthetic payloads.
      const afterHigh = h.requests.length;
      await h.player.selectVideoTrack('low', 'bandwidth', 'downshift');
      await flush(256);
      expect(h.requests.slice(afterHigh).map(({ name, namespace }) => ({ name, namespace })))
        .toEqual([ref('low')]);
      const downshift = await h.accept(ref('low'), 202n, 1);
      await h.send(downshift, chunk(3n), 3n);
      await vi.waitFor(() => expect(h.switched).toHaveBeenCalledWith(
        expect.objectContaining({ toTrackName: 'low', reason: 'bandwidth' })));
      expect(h.received).toContainEqual({ name: 'low', group: 3n });

      const before = h.requests.length;
      const refusal = await h.player.selectVideoTrack('outside').then(() => null, error => error);
      expect.soft(refusal, 'same altGroup must not permit a different render scope').toBeInstanceOf(Error);
      await flush(256);
      expect(h.requests).toHaveLength(before);
    } finally { await h.destroy(); }
  });

  it('refuses an ambiguous public name within the eligible set without requesting either identity', async () => {
    const h = await fixture([
      video('low'),
      video('high', { namespace: 'camera/hd-a', bitrate: 2_000_000 }),
      video('high', { namespace: 'camera/hd-b', bitrate: 2_000_000 }),
    ]);
    try {
      expect(h.media()).toEqual([ref('low')]);
      const low = await h.accept(ref('low'), 200n);
      await h.send(low, chunk(1n));
      const before = h.requests.length;
      const refusal = await h.player.selectVideoTrack('high').then(() => null, error => error);
      expect.soft(refusal, 'name-only API must refuse two eligible full identities').toBeInstanceOf(Error);
      await flush(256);
      expect(h.requests).toHaveLength(before);
      expect(h.switched).not.toHaveBeenCalled();
      await h.send(low, chunk(2n), 2n);
      expect(h.received).toContainEqual({ name: 'low', group: 2n });
    } finally { await h.destroy(); }
  });

  it('retains established namespace on peer-triggered TOO_FAR_BEHIND resubscription', async () => {
    const h = await fixture([
      video('video', { namespace: 'other/view', renderGroup: 2 }),
      video('video'),
    ]);
    try {
      expect(h.media()).toEqual([ref('video')]);
      const established = await h.accept(ref('video'), 200n);
      await h.send(established, chunk(1n));
      expect(h.received).toContainEqual({ name: 'video', group: 1n });
      await h.server.publishDone(established.id, varint(PublishDoneCode18.TOO_FAR_BEHIND), 'loopback behind');
      await flush(256);
      expect(h.media()).toEqual([ref('video'), ref('video')]);
      const recovered = await h.accept(ref('video'), 201n, 1);
      await h.send(recovered, chunk(2n), 2n);
      expect(h.received).toContainEqual({ name: 'video', group: 2n });
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });
});
