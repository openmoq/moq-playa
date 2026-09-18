/**
 * LOCMAF beyond the MSE chunk path (draft-einarsson-moq-locmaf-01):
 *
 *  - §16 frame interface: with `locmafDecoding: 'frame'` a LOCMAF track is
 *    sliced into coded samples and played through the LOC WebCodecs pipeline,
 *    configured from the CMAF Header's codec description, never through MSE.
 *  - §13/§16: a protected track is dropped on the frame path (no decryption).
 *  - §14 event-only tracks: a locmaf track of a non-media role that depends on a
 *    selected track is subscribed and its emsg boxes surface as `locmaf_event`.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject } from '@moqt/transport';
import { ObjectStatus, varint } from '@moqt/transport';
import type { ClockSource } from '@moqt/playback';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject, ticksToMicros } from '@moqt/locmaf';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, cencVideoInit, videoInit } from '../../locmaf/test-support/cmaf.js';
import { concat, isoBox } from '../../locmaf/test-support/bytes.js';

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, '..', '..', '..', 'conformance', 'media', 'vectors', 'locmaf');

// ─── Harness ────────────────────────────────────────────────────────

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []) },
    onMessage: null, onClose: null, onError: null, onDataStream: null,
    onObject: null, onStreamClosed: null, onDatagram: null,
    onNamespaceMessage: null, onQlogEvent: null,
    _connectResolve: null as (() => void) | null,
    connect: vi.fn(() => new Promise<void>((resolve) => { adapter._connectResolve = resolve; })),
    subscribe: vi.fn(async () => varint(nextRequestId++)),
    requestUpdate: vi.fn(async () => varint(nextRequestId++)),
    unsubscribe: vi.fn(async () => {}),
    fetch: vi.fn(async () => varint(nextRequestId++)),
    fetchCancel: vi.fn(async () => {}),
    trackStatus: vi.fn(async () => varint(nextRequestId++)),
    subscribeNamespace: vi.fn(async () => varint(nextRequestId++)),
    cancelNamespace: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    _triggerMessage: (msg: ControlMessage) => adapter.onMessage?.(msg),
    _triggerObject: (streamId: bigint, obj: MoqtObject) => adapter.onObject?.(streamId, obj),
  };
  return adapter;
}

function mockVideoDecoder() {
  return {
    configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()), reset: vi.fn(), close: vi.fn(),
    destroy: vi.fn(), state: 'configured', decodeQueueSize: 0, queueDepth: 0, ondequeue: null, onFrame: null, onError: null,
  };
}

function mockRenderer() {
  return { enqueue: vi.fn(), clear: vi.fn(), destroy: vi.fn(), onFrameRendered: null, onFirstFrame: null, queueDepth: 0 };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const cmsfCatalog = (tracks: Array<Record<string, unknown>>, initDataList?: unknown[]) =>
  JSON.stringify({ version: 'draft-01', tracks, ...(initDataList ? { initDataList } : {}) });
const LOCMAF_VIDEO = {
  name: 'video', packaging: 'locmaf', locmafVersion: '0.3', isLive: true, role: 'video',
  renderGroup: 1, codec: 'avc1.640028', width: 640, height: 360, bitrate: 2_500_000,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootPlayer(catalogJson: string, cfg: Partial<MoqtPlayerConfig> = {}) {
  const adapter = createMockAdapter();
  const videoDecoder = mockVideoDecoder();
  const renderer = mockRenderer();
  const mockMs = { initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), mediaElement: null, destroy: vi.fn(), changeType: vi.fn(async () => {}), onFirstFrame: null, onError: null, onStall: null };
  let clockTime = 1_000_000;
  const clock: ClockSource = { now: () => clockTime };
  const warnings: string[] = [];
  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    createVideoDecoder: () => videoDecoder as any,
    createRenderer: () => renderer as any,
    createMediaSource: () => mockMs as any,
    createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(), setInitSegment: vi.fn(), clearPending: vi.fn() }) as any,
    catalogBootstrap: 'subscribe',
    clock,
    logger: { debug: () => {}, info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} } as any,
    ...cfg,
  });
  const errors: any[] = [];
  player.on('error', (e) => errors.push(e.error));

  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;
  const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
  adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map() } as unknown as ControlMessage);
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
    objectId: varint(0), payload: new TextEncoder().encode(catalogJson),
  } as MoqtObject);
  await sleep(30);

  const subscribedNames = () => adapter.subscribe.mock.calls
    .map((c: any[]) => { try { return new TextDecoder().decode(c[1]); } catch { return '?'; } });
  const reqIdFor = async (name: string) => {
    const idx = subscribedNames().indexOf(name);
    return idx >= 0 ? await adapter.subscribe.mock.results[idx]?.value : undefined;
  };
  const advance = (ms: number) => { clockTime += ms * 1000; };
  return { player, adapter, videoDecoder, renderer, mockMs, errors, warnings, subscribedNames, reqIdFor, advance };
}

function sendLocmaf(adapter: any, alias: unknown, groupId: number, objectId: number, payload: Uint8Array): void {
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: alias, groupId: varint(groupId), subgroupId: varint(0),
    objectId: varint(objectId), payload, publisherPriority: 128,
  } as MoqtObject);
}

/** A length-prefixed (avcC-style) access unit with one NAL of the given type. */
const nal = (type: number, ...body: number[]) => Uint8Array.of(0, 0, 0, 1 + body.length, type, ...body);
const IDR = nal(5, 0x88, 0x84);
const P_SLICE = nal(1, 0x9a, 0x10);

describe('LOCMAF frame-path regressions', () => {
  it.each([false, true])('decodes rawBoxes media with a pre-moof uuid (uuid=%s)', async (withUuid) => {
    const init = videoInit();
    const h = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(init) }]),
      { locmafDecoding: 'frame' },
    );
    try {
      const chunk = buildChunk({
        bmdt: 90000,
        samples: [
          { duration: 3000, size: IDR.length, flags: SYNC_FLAGS },
          { duration: 3000, size: P_SLICE.length, flags: NON_SYNC_FLAGS },
        ],
        mdat: concat(IDR, P_SLICE),
        preMoof: withUuid ? [isoBox('uuid', new Uint8Array(16), Uint8Array.of(42))] : [],
      });
      if (withUuid) {
        // §8: a pre-moof uuid is a genBox (usertype first in the payload), not a
        // reason to fall back to rawBoxes. The chunk is still sent as rawBoxes
        // below, which §9 permits for any chunk.
        const encoded = new LocmafEncoder().encode(chunk, new LocmafGroupState(), parseLocmafTrackContext(init), false, 0n);
        expect(encoded.kind).toBe('moof');
        if (encoded.kind !== 'moof') return;
        expect(encoded.genBoxes.map((b) => b.type)).toEqual(['uuid']);
        expect(encoded.genBoxes[0]!.payload).toEqual(concat(new Uint8Array(16), Uint8Array.of(42)));
      }
      const alias = await h.reqIdFor('video');
      sendLocmaf(h.adapter, alias, 5, 0, serializeLocmafObject({ kind: 'rawBoxes', boxes: chunk }));
      for (let i = 0; i < 20; i++) {
        h.advance(40);
        h.player.tick();
        await sleep(0);
      }
      expect(h.videoDecoder.decode).toHaveBeenCalledTimes(2);
    } finally {
      await h.player.destroy();
    }
  });

  it('decodes when the CMAF header comes from the subscribed init track', async () => {
    const init = videoInit();
    const h = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initTrack: 'video-init' }]),
      { locmafDecoding: 'frame' },
    );
    try {
      const initAlias = await h.reqIdFor('video-init');
      expect(initAlias).toBeDefined();
      sendLocmaf(h.adapter, initAlias, 0, 0, init);
      const alias = await h.reqIdFor('video');
      sendLocmaf(h.adapter, alias, 5, 0, locmafGroup(init, 90000, 1).objects[0]!);
      for (let i = 0; i < 20; i++) {
        h.advance(40);
        h.player.tick();
        await sleep(0);
      }
      expect(h.videoDecoder.decode).toHaveBeenCalledTimes(2);
    } finally {
      await h.player.destroy();
    }
  });

  it('decodes a valid rawBoxes media chunk on the frame path', async () => {
    const init = videoInit();
    const h = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(init) }]),
      { locmafDecoding: 'frame' },
    );
    try {
      const chunk = buildChunk({
        bmdt: 90000,
        samples: [
          { duration: 3000, size: IDR.length, flags: SYNC_FLAGS },
          { duration: 3000, size: P_SLICE.length, flags: NON_SYNC_FLAGS },
        ],
        mdat: concat(IDR, P_SLICE),
      });
      const alias = await h.reqIdFor('video');
      sendLocmaf(h.adapter, alias, 5, 0, serializeLocmafObject({ kind: 'rawBoxes', boxes: chunk }));
      for (let i = 0; i < 20; i++) {
        h.advance(40);
        h.player.tick();
        await sleep(0);
      }
      expect(h.videoDecoder.decode).toHaveBeenCalledTimes(2);
    } finally {
      await h.player.destroy();
    }
  });

  it.each([false, true])('advances immediately after END_OF_GROUP (pipeline control=%s)', async (directControl) => {
    const init = videoInit();
    const h = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(init) }]),
      { locmafDecoding: 'frame' },
    );
    try {
      const alias = await h.reqIdFor('video');
      sendLocmaf(h.adapter, alias, 5, 0, locmafGroup(init, 90000, 1).objects[0]!);
      for (let i = 0; i < 20 && h.videoDecoder.decode.mock.calls.length < 2; i++) {
        h.advance(40);
        h.player.tick();
        await sleep(0);
      }
      expect(h.videoDecoder.decode).toHaveBeenCalledTimes(2);
      const end = {
        kind: 'gap', trackAlias: alias, groupId: varint(5), subgroupId: varint(0),
        objectId: varint(1), status: ObjectStatus.END_OF_GROUP,
      } as MoqtObject;
      // Control: the same terminal marker lets the pipeline advance when it reaches it.
      if (directControl) (h.player as any).videoPipeline.pushObject(end);
      else h.adapter._triggerObject(0n, end);
      sendLocmaf(h.adapter, alias, 6, 0, locmafGroup(init, 96000, 1).objects[0]!);
      for (let i = 0; i < 3; i++) {
        h.advance(1);
        h.player.tick();
        await sleep(0);
      }
      expect(h.videoDecoder.decode).toHaveBeenCalledTimes(4);
    } finally {
      await h.player.destroy();
    }
  });
});

/**
 * One MOQT group of LOCMAF video objects, two samples per chunk: chunk 0 opens
 * on a sync sample. Returns the objects and the samples each carries.
 */
function locmafGroup(init: Uint8Array, bmdt: number, chunks: number) {
  const context = parseLocmafTrackContext(init);
  const encoder = new LocmafEncoder();
  const state = new LocmafGroupState();
  const objects: Uint8Array[] = [];
  const samples: Array<{ data: Uint8Array; sync: boolean; decodeTime: number }> = [];
  for (let c = 0; c < chunks; c++) {
    const first = c === 0 ? IDR : P_SLICE;
    const second = P_SLICE;
    const mdat = concat(first, second);
    const chunk = buildChunk({
      bmdt: bmdt + c * 6000,
      samples: [
        { duration: 3000, size: first.length, flags: c === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS },
        { duration: 3000, size: second.length, flags: NON_SYNC_FLAGS },
      ],
      mdat,
    });
    objects.push(serializeLocmafObject(encoder.encode(chunk, state, context, false, BigInt(c))));
    samples.push({ data: first, sync: c === 0, decodeTime: bmdt + c * 6000 });
    samples.push({ data: second, sync: false, decodeTime: bmdt + c * 6000 + 3000 });
  }
  return { objects, samples };
}

// ─── §16 frame interface ────────────────────────────────────────────

describe('LOCMAF frame path (draft-einarsson-moq-locmaf-01 §16) — locmafDecoding: "frame"', () => {
  const init = videoInit();
  const AVCC = [1, 100, 0, 40, 0xff, 0xe1, 0, 0, 1, 0];

  it('plays a locmaf track through the LOC WebCodecs pipeline: no MediaSource, decoder configured from the CMAF Header, one decode per sample', async () => {
    const { player, adapter, videoDecoder, mockMs, errors, reqIdFor, advance } = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(init) }]),
      { locmafDecoding: 'frame' },
    );
    const alias = await reqIdFor('video');
    expect(alias).toBeDefined();
    // The chunk interface is never engaged.
    expect(mockMs.initialize).not.toHaveBeenCalled();

    const { objects, samples } = locmafGroup(init, 90000, 2);
    objects.forEach((payload, i) => sendLocmaf(adapter, alias, 5, i, payload));
    for (let i = 0; i < 20 && videoDecoder.decode.mock.calls.length < samples.length; i++) {
      advance(40);
      player.tick();
      await sleep(0);
    }

    // The decoder was configured with the avcC record, not the ftyp+moov.
    expect(videoDecoder.configure).toHaveBeenCalled();
    const configured = videoDecoder.configure.mock.calls.find((c: any[]) => (c[0] as Uint8Array).byteLength > 0);
    expect(configured).toBeDefined();
    expect(Array.from(configured![0] as Uint8Array)).toEqual(AVCC);
    expect(configured![1]).toBe('avc1.640028');

    // One decode per coded sample, in decode order, key first, with presentation
    // times derived from the chunk timeline (90 kHz ticks to microseconds).
    expect(videoDecoder.decode).toHaveBeenCalledTimes(samples.length);
    const chunks = videoDecoder.decode.mock.calls.map((c: any[]) => c[0]);
    expect(chunks.map((c: any) => c.type)).toEqual(['key', 'delta', 'delta', 'delta']);
    expect(chunks.map((c: any) => c.timestamp)).toEqual(samples.map((s) => Number(ticksToMicros(BigInt(s.decodeTime), 90000))));
    chunks.forEach((c: any, i: number) => expect(new Uint8Array(c.data)).toEqual(samples[i]!.data));
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('a mid-group join waits for the next group that opens on a sync sample (rejections counted, nothing decoded)', async () => {
    const { player, adapter, videoDecoder, reqIdFor, advance } = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(init) }]),
      { locmafDecoding: 'frame' },
    );
    const alias = await reqIdFor('video');
    const g0 = locmafGroup(init, 0, 3).objects;
    sendLocmaf(adapter, alias, 0, 1, g0[1]!);
    sendLocmaf(adapter, alias, 0, 2, g0[2]!);
    advance(40); player.tick(); await sleep(0);
    expect(videoDecoder.decode).not.toHaveBeenCalled();
    expect((player as any)._stats.snapshot().locmafObjectsRejected).toBe(2);

    const g1 = locmafGroup(init, 18000, 1);
    sendLocmaf(adapter, alias, 1, 0, g1.objects[0]!);
    for (let i = 0; i < 10 && videoDecoder.decode.mock.calls.length < 2; i++) { advance(40); player.tick(); await sleep(0); }
    expect(videoDecoder.decode).toHaveBeenCalledTimes(2);
    expect(videoDecoder.decode.mock.calls[0]![0].type).toBe('key');
    await player.destroy();
  });

  it('a protected (CENC) track is dropped on the frame path with one warning, never decoded', async () => {
    const protectedInit = cencVideoInit(8);
    const { player, adapter, videoDecoder, warnings, reqIdFor, advance } = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(protectedInit) }]),
      { locmafDecoding: 'frame' },
    );
    const alias = await reqIdFor('video');
    const context = parseLocmafTrackContext(protectedInit);
    const encoder = new LocmafEncoder();
    const state = new LocmafGroupState();
    const chunk = buildChunk({
      bmdt: 0,
      samples: [{ duration: 3000, size: IDR.length, flags: SYNC_FLAGS }],
      mdat: IDR,
      senc: { ivSize: 8, useSubsamples: false, samples: [{ iv: new Uint8Array(8), subsamples: [] }] },
    });
    for (let o = 0; o < 2; o++) {
      sendLocmaf(adapter, alias, 0, o, serializeLocmafObject(encoder.encode(chunk, state, context, false, BigInt(o))));
    }
    advance(40); player.tick(); await sleep(0);
    expect(videoDecoder.decode).not.toHaveBeenCalled();
    expect(warnings.filter((w) => w.includes('cannot be decrypted on the frame path'))).toHaveLength(1);
    await player.destroy();
  });

  it('the default consumption path is unchanged: without the option a locmaf track initializes MSE', async () => {
    const { player, mockMs, videoDecoder, reqIdFor } = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(init) }]),
    );
    expect(await reqIdFor('video')).toBeDefined();
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    expect(videoDecoder.configure).not.toHaveBeenCalled();
    await player.destroy();
  });
});

// ─── §14 event-only tracks ──────────────────────────────────────────

describe('LOCMAF event-only tracks (draft-einarsson-moq-locmaf-01 §14)', () => {
  const vector = (file: string) => new Uint8Array(readFileSync(join(VECTORS, 'event-only', file)));
  const videoInitBytes = videoInit();

  async function bootWithEvents(role = 'metadata', depends: string[] = ['video']) {
    return bootPlayer(cmsfCatalog(
      [
        { ...LOCMAF_VIDEO, initRef: 'v' },
        { name: 'events', packaging: 'locmaf', locmafVersion: '0.3', isLive: true, role, depends, initRef: 'e' },
      ],
      [
        { id: 'v', type: 'inline', data: b64(videoInitBytes) },
        { id: 'e', type: 'inline', data: b64(vector('init.mp4')) },
      ],
    ));
  }

  it('subscribes a non-media locmaf track that depends on the selected video and emits its emsg boxes as locmaf_event', async () => {
    const { player, adapter, errors, subscribedNames, reqIdFor } = await bootWithEvents();
    expect(subscribedNames()).toContain('events');
    const alias = await reqIdFor('events');
    const received: any[] = [];
    player.on('locmaf_event', (e) => received.push(e));

    sendLocmaf(adapter, alias, 0, 0, vector('objects/g000_o000.locmafobj'));
    sendLocmaf(adapter, alias, 0, 1, vector('objects/g000_o001.locmafobj'));
    await sleep(0);

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ type: 'locmaf_event', trackName: 'events', groupId: 0n, objectId: 0n, timescale: 90000 });
    expect(received[0].events).toHaveLength(1);
    expect(received[0].events[0]).toMatchObject({ version: 1, schemeIdUri: 'urn:y', value: 'e', presentationTime: 24464n, eventDuration: 3000, id: 1 });
    expect(received[1].objectId).toBe(1n);
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('an event-only track that depends on nothing selected is not subscribed', async () => {
    const { player, subscribedNames } = await bootWithEvents('metadata', ['audio-es']);
    expect(subscribedNames()).not.toContain('events');
    await player.destroy();
  });

  it('an event-only track with an unsupported locmafVersion is not subscribed', async () => {
    const { player, subscribedNames } = await bootPlayer(cmsfCatalog(
      [
        { ...LOCMAF_VIDEO, initRef: 'v' },
        { name: 'events', packaging: 'locmaf', locmafVersion: '9.9', isLive: true, role: 'metadata', depends: ['video'], initRef: 'e' },
      ],
      [{ id: 'v', type: 'inline', data: b64(videoInitBytes) }, { id: 'e', type: 'inline', data: b64(vector('init.mp4')) }],
    ));
    expect(subscribedNames()).not.toContain('events');
    await player.destroy();
  });
});
