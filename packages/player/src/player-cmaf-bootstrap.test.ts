/**
 * CMAF bootstrap tests — init-source state machine, in-band init, loud failure.
 *
 * The failure class under test: a publisher whose catalog lacks init
 * metadata (or ships ftyp+moov in-band) must never produce a clean
 * subscribe followed by a silent black player. Init sources: inline
 * catalog initData, initTrack delivery, in-band ftyp+moov — collected per
 * track, MSE initialized exactly ONCE with the complete config.
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerErrorCode } from './errors.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@moqt/locmaf';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, videoInit } from '../../locmaf/test-support/cmaf.js';
import { concat, vi as vi64 } from '../../locmaf/test-support/bytes.js';

// ─── Mock adapter (thin copy of the player.test.ts harness) ──────────

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

function cmafCatalog(tracks: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, tracks });
}

const VIDEO_BASE = {
  name: 'video', packaging: 'cmaf', isLive: true, role: 'video',
  renderGroup: 1, codec: 'avc1.4D4028', width: 1280, height: 720, bitrate: 2_500_000,
};
const AUDIO_BASE = {
  name: 'audio', packaging: 'cmaf', isLive: true, role: 'audio',
  renderGroup: 1, codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128_000,
};

/** Compose a payload of well-formed top-level boxes: [type, size][]. */
function boxPayload(...specs: Array<[string, number]>): Uint8Array {
  const total = specs.reduce((n, [, s]) => n + s, 0);
  const p = new Uint8Array(total);
  const dv = new DataView(p.buffer);
  let o = 0;
  for (const [type, size] of specs) {
    dv.setUint32(o, size);
    for (let i = 0; i < 4; i++) p[o + 4 + i] = type.charCodeAt(i);
    o += size;
  }
  return p;
}
/** A realistic in-band init segment shape: ftyp then moov. */
const initSegmentPayload = (moovSize = 32) => boxPayload(['ftyp', 16], ['moov', moovSize]);

function makeMockMs() {
  return {
    initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(),
    reset: vi.fn(), mediaElement: null, destroy: vi.fn(),
    changeType: vi.fn(async () => {}),
    onFirstFrame: null as (() => void) | null, onError: null, onStall: null,
  };
}

async function bootPlayer(catalogJson: string, cfg?: Partial<MoqtPlayerConfig>) {
  const adapter = createMockAdapter();
  const mockMs = makeMockMs();
  const assembler = { push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(), setInitSegment: vi.fn(), clearPending: vi.fn() };
  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    createMediaSource: () => mockMs,
    createCmafAssembler: () => assembler,
    // Pin pre-bootstrap catalog behavior (legacy escape hatch).
    catalogBootstrap: 'subscribe',
    ...cfg,
  });
  const errors: any[] = [];
  player.on('error', (e) => errors.push(e.error));

  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;
  const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map(),
  } as unknown as ControlMessage);
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
    objectId: varint(0), payload: new TextEncoder().encode(catalogJson),
  } as MoqtObject);
  await new Promise((r) => setTimeout(r, 30)); // async subscribe fan-out

  for (const result of adapter.subscribe.mock.results.slice(1)) {
    const requestId = await result.value;
    adapter._triggerMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: requestId, parameters: new Map() } as ControlMessage);
  }

  /** Subscribed track names, decoded from the subscribe() calls. */
  const subscribedNames = () => adapter.subscribe.mock.calls
    .map((c: any[]) => { try { return new TextDecoder().decode(c[1]); } catch { return '?'; } });
  /** reqId (varint) for a subscribed track name, or undefined. */
  const reqIdFor = async (name: string) => {
    const idx = subscribedNames().indexOf(name);
    return idx >= 0 ? await adapter.subscribe.mock.results[idx]?.value : undefined;
  };
  return { player, adapter, mockMs, assembler, errors, subscribedNames, reqIdFor };
}

/** Boot a player while exposing the assembler's emitted-segment callback. */
async function bootPlayerCapturingAssembler(catalogJson: string, cfg?: Partial<MoqtPlayerConfig>) {
  let onSegment: ((mediaType: 'video' | 'audio', segment: Uint8Array, trackName: string, groupId: bigint) => void) | null = null;
  const adapter = createMockAdapter();
  const mockMs = makeMockMs();
  const assembler = { push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(), setInitSegment: vi.fn(), clearPending: vi.fn() };
  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    createMediaSource: () => mockMs,
    createCmafAssembler: (callbacks: any) => { onSegment = callbacks.onSegment; return assembler; },
    catalogBootstrap: 'subscribe',
    ...cfg,
  });
  const errors: any[] = [];
  player.on('error', (e) => errors.push(e.error));

  const loadPromise = player.load();
  await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());
  adapter._connectResolve?.();
  await loadPromise;
  const catalogReqId = await adapter.subscribe.mock.results[0]?.value;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: catalogReqId, trackAlias: catalogReqId, parameters: new Map(),
  } as unknown as ControlMessage);
  adapter._triggerObject(0n, {
    kind: 'data', trackAlias: catalogReqId, groupId: varint(0), subgroupId: varint(0),
    objectId: varint(0), payload: new TextEncoder().encode(catalogJson),
  } as MoqtObject);
  await new Promise((r) => setTimeout(r, 30));

  return {
    player, adapter, mockMs, assembler, errors,
    sendVideoSegment: () => onSegment?.('video', new Uint8Array([0]), 'video', 0n),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Tests ───────────────────────────────────────────────────────────

describe('CMAF bootstrap validation (fail before SUBSCRIBE)', () => {
  it('codec missing on a selected CMAF track → fatal CMAF_INIT_INVALID, zero media subscribes', async () => {
    const { player, errors, subscribedNames } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, codec: undefined }]));

    const err = errors.find((e) => e.code === PlayerErrorCode.CMAF_INIT_INVALID);
    expect(err).toBeDefined();
    expect(err.severity).toBe('fatal');
    expect(err.message).toContain('video');
    expect(subscribedNames()).toEqual(['catalog']); // nothing else hit the wire
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('initData decoding to zero bytes → fatal CMAF_INIT_INVALID before subscribe', async () => {
    const { player, errors, subscribedNames } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: '' /* btoa('') */ }]));
    expect(errors.some((e) => e.code === PlayerErrorCode.CMAF_INIT_INVALID)).toBe(true);
    expect(subscribedNames()).toEqual(['catalog']);
    await player.destroy();
  });

  it('initData that is not valid base64 is rejected at the MSF parse layer — still zero media subscribes', async () => {
    // §5.1.20: the MSF catalog parser validates base64 syntax, so a
    // published catalog with malformed initData never reaches track
    // selection (the player-level base64 check remains as defense-in-depth
    // for injected catalog configs that bypass MSF parsing).
    const { player, errors, subscribedNames } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: '!!!not-base64!!!' }]));
    expect(errors.some((e) =>
      e.code === PlayerErrorCode.CATALOG_PARSE_ERROR || e.code === PlayerErrorCode.CMAF_INIT_INVALID,
    )).toBe(true);
    expect(subscribedNames()).toEqual(['catalog']); // nothing else hit the wire
    await player.destroy();
  });
});

describe('LOCMAF bootstrap (draft-einarsson-moq-locmaf-01 §5, §6) — same CMAF init path', () => {
  const LOCMAF_VIDEO = { ...VIDEO_BASE, packaging: 'locmaf', locmafVersion: '0.3' };
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const cmsfCatalog = (tracks: Array<Record<string, unknown>>, initDataList?: unknown[]) =>
    JSON.stringify({ version: 'draft-01', tracks, ...(initDataList ? { initDataList } : {}) });

  it('initRef → root inline initDataList resolves for a locmaf track: subscribes, initializes MSE once with those bytes', async () => {
    const init = initSegmentPayload(48);
    const { player, mockMs, errors, subscribedNames } = await bootPlayer(cmsfCatalog(
      [{ ...LOCMAF_VIDEO, initRef: 'v' }],
      [{ id: 'v', type: 'inline', data: b64(init) }],
    ));

    expect(subscribedNames()).toEqual(['catalog', 'video']);
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    const cfg = mockMs.initialize.mock.calls[0]![0];
    expect(cfg.video.codec).toBe('avc1.4D4028');
    expect(cfg.video.initData).toEqual(init);
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('codec missing on a selected locmaf track → fatal CMAF_INIT_INVALID, zero media subscribes', async () => {
    const { player, errors, subscribedNames } = await bootPlayer(
      cmsfCatalog([{ ...LOCMAF_VIDEO, codec: undefined }]));
    expect(errors.some((e) => e.code === PlayerErrorCode.CMAF_INIT_INVALID)).toBe(true);
    expect(subscribedNames()).toEqual(['catalog']);
    await player.destroy();
  });

  it('an unsupported locmafVersion is never subscribed; the cmaf alternative of the same source is selected', async () => {
    const init = initSegmentPayload(48);
    const { player, subscribedNames } = await bootPlayer(cmsfCatalog(
      [
        { ...LOCMAF_VIDEO, name: 'video-locmaf', locmafVersion: '9.9', altGroup: 1, bitrate: 3_000_000, initRef: 'v' },
        { ...VIDEO_BASE, altGroup: 1, initRef: 'v' },
      ],
      [{ id: 'v', type: 'inline', data: b64(init) }],
    ));

    expect(subscribedNames()).toEqual(['catalog', 'video']);
    await expect(player.selectVideoTrack('video-locmaf')).rejects.toThrow(/locmafVersion/);
    expect(subscribedNames()).not.toContain('video-locmaf');
    await player.destroy();
  });

  // ─── LOCMAF media: reconstruction into the CMAF assembler (§15, §16) ───

  const locmafInit = videoInit();
  const locmafContext = parseLocmafTrackContext(locmafInit);

  /** One MOQT group of single-sample LOCMAF video objects (full header first, deltas after). */
  function locmafGroup(bmdt: number, count: number, firstFlags = SYNC_FLAGS): Uint8Array[] {
    const encoder = new LocmafEncoder();
    const state = new LocmafGroupState();
    return Array.from({ length: count }, (_, i) => serializeLocmafObject(encoder.encode(
      buildChunk({ bmdt: bmdt + i * 3000, samples: [{ duration: 3000, size: 10 + i, flags: i === 0 ? firstFlags : NON_SYNC_FLAGS }] }),
      state, locmafContext, false, BigInt(i))));
  }

  /** The canonical chunks an independent decoder reconstructs from the same objects. */
  function canonical(groupId: bigint, objects: Uint8Array[]): Uint8Array[] {
    const decoder = new LocmafTrackDecoder(locmafInit);
    return objects.map((payload, i) => {
      const r = decoder.push(groupId, BigInt(i), payload);
      if (r.kind !== 'chunk') throw new Error(`expected a chunk, got ${r.kind}`);
      return r.bytes;
    });
  }

  function sendLocmaf(adapter: any, alias: unknown, groupId: number, objectId: number, payload: Uint8Array): void {
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: alias, groupId: varint(groupId), subgroupId: varint(0),
      objectId: varint(objectId), payload,
    } as MoqtObject);
  }

  async function bootLocmaf(withInit = true) {
    const booted = await bootPlayer(withInit
      ? cmsfCatalog([{ ...LOCMAF_VIDEO, initRef: 'v' }], [{ id: 'v', type: 'inline', data: b64(locmafInit) }])
      : cmsfCatalog([{ ...LOCMAF_VIDEO }]));
    return { ...booted, alias: await booted.reqIdFor('video') };
  }

  it('locmaf objects are reconstructed into canonical CMAF chunks and fed to the assembler in order', async () => {
    const { player, adapter, assembler, alias, errors } = await bootLocmaf();
    const objects = locmafGroup(90000, 3);
    objects.forEach((payload, i) => sendLocmaf(adapter, alias, 4, i, payload));
    await sleep(10);

    const expected = canonical(4n, objects);
    expect(assembler.push).toHaveBeenCalledTimes(3);
    assembler.push.mock.calls.forEach((call: any[], i: number) => {
      expect(call.slice(0, 3)).toEqual(['video', 'video', 4n]);
      expect(call[3]).toEqual(expected[i]);
      expect(String.fromCharCode(...(call[3] as Uint8Array).subarray(4, 8))).toBe('moof');
    });
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('a mid-group join is held: deltas without a reference are rejected until the next group\'s sync chunk', async () => {
    const { player, adapter, assembler, alias } = await bootLocmaf();
    const g0 = locmafGroup(0, 3);
    sendLocmaf(adapter, alias, 0, 1, g0[1]!);
    sendLocmaf(adapter, alias, 0, 2, g0[2]!);
    await sleep(10);
    expect(assembler.push).not.toHaveBeenCalled();
    expect((player as any)._stats.snapshot().locmafObjectsRejected).toBe(2);

    const g1 = locmafGroup(9000, 2);
    g1.forEach((payload, i) => sendLocmaf(adapter, alias, 1, i, payload));
    await sleep(10);
    expect(assembler.push).toHaveBeenCalledTimes(2);
    expect(assembler.push.mock.calls[0]![2]).toBe(1n);
    await player.destroy();
  });

  it('the video keyframe gate reads sample flags, not object ids: a non-sync group start is not a splice point', async () => {
    const { player, adapter, assembler, alias } = await bootLocmaf();
    locmafGroup(0, 2, NON_SYNC_FLAGS).forEach((payload, i) => sendLocmaf(adapter, alias, 0, i, payload));
    await sleep(10);
    expect(assembler.push).not.toHaveBeenCalled();

    locmafGroup(6000, 2).forEach((payload, i) => sendLocmaf(adapter, alias, 1, i, payload));
    await sleep(10);
    expect(assembler.push).toHaveBeenCalledTimes(2);
    await player.destroy();
  });

  it('an in-band CMAF Header carried as a rawBoxes object (§9) initializes MSE, then media flows', async () => {
    const { player, adapter, mockMs, assembler, alias, errors } = await bootLocmaf(false);
    expect(mockMs.initialize).not.toHaveBeenCalled();

    sendLocmaf(adapter, alias, 0, 0, concat(vi64(4), locmafInit));
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    expect(mockMs.initialize.mock.calls[0]![0].video.initData).toEqual(locmafInit);

    locmafGroup(0, 2).forEach((payload, i) => sendLocmaf(adapter, alias, 1, i, payload));
    await sleep(10);
    expect(assembler.push).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('interleaved groups (the tail of one group overlapping the head of the next) all reach the assembler, no malformed teardown', async () => {
    const { player, adapter, assembler, alias } = await bootLocmaf();
    const g7 = locmafGroup(0, 4);
    const g8 = locmafGroup(12000, 3);
    const arrival: Array<[number, number, Uint8Array]> = [
      [7, 0, g7[0]!], [7, 1, g7[1]!], [8, 0, g8[0]!], [7, 2, g7[2]!], [8, 1, g8[1]!], [7, 3, g7[3]!], [8, 2, g8[2]!],
    ];
    for (const [g, o, payload] of arrival) sendLocmaf(adapter, alias, g, o, payload);
    await sleep(10);

    expect(assembler.push).toHaveBeenCalledTimes(arrival.length);
    expect((player as any)._stats.snapshot().locmafObjectsRejected).toBe(0);
    expect(adapter.unsubscribe).not.toHaveBeenCalled();
    await player.destroy();
  });

  it('a same-codec switch to a locmaf rendition with only an initTrack prefetches that CMAF Header first', async () => {
    const { player, subscribedNames } = await bootPlayer(cmsfCatalog(
      [
        { ...LOCMAF_VIDEO, name: 'video', altGroup: 1, bitrate: 800_000, initRef: 'v' },
        { ...LOCMAF_VIDEO, name: 'video-hi', altGroup: 1, bitrate: 2_500_000, initTrack: 'init-hi' },
      ],
      [{ id: 'v', type: 'inline', data: b64(locmafInit) }],
    ));
    expect(subscribedNames()).toEqual(['catalog', 'video']);

    const switching = player.selectVideoTrack('video-hi').catch(() => undefined);
    await sleep(30);
    const names = subscribedNames();
    expect(names).toContain('init-hi');
    const targetIndex = names.indexOf('video-hi');
    if (targetIndex >= 0) expect(names.indexOf('init-hi')).toBeLessThan(targetIndex);
    await player.destroy();
    await switching;
  });

  it('a switch target torn down as malformed aborts the pending switch; the old track stays subscribed', async () => {
    const { player, adapter, reqIdFor, subscribedNames } = await bootPlayer(cmsfCatalog(
      [
        { ...LOCMAF_VIDEO, name: 'video', altGroup: 1, bitrate: 800_000, initRef: 'v' },
        { ...LOCMAF_VIDEO, name: 'video-hi', altGroup: 1, bitrate: 2_500_000, initRef: 'v' },
      ],
      [{ id: 'v', type: 'inline', data: b64(locmafInit) }],
    ));
    const failed: unknown[] = [];
    player.on('quality_switch_failed', (e) => failed.push(e));
    expect(subscribedNames()).toEqual(['catalog', 'video']);
    const oldAlias = await reqIdFor('video');

    void player.selectVideoTrack('video-hi').catch(() => undefined);
    await sleep(30);
    expect(subscribedNames()).toContain('video-hi');
    const newReqId = await reqIdFor('video-hi');
    // A switch target is not registered optimistically: its objects route once
    // SUBSCRIBE_OK binds the relay-assigned alias.
    const newAlias = varint(BigInt(newReqId) + 100n);
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: newReqId, trackAlias: newAlias, parameters: new Map(),
    } as unknown as ControlMessage);
    await sleep(10);
    const garbage = Uint8Array.of(0x3f, 0x00);
    for (let g = 0; g < 3; g++) sendLocmaf(adapter, newAlias, g, 0, garbage);
    await sleep(10);

    expect(failed).toHaveLength(1);
    expect((player as any).pendingVideoSwitch).toBeNull();
    const unsubscribed = adapter.unsubscribe.mock.calls.map((c: any[]) => c[0]);
    expect(unsubscribed).not.toContainEqual(oldAlias);
    await player.destroy();
  });

  it('one undecodable group is tolerated; consecutive undecodable groups make the track malformed (unsubscribe)', async () => {
    const { player, adapter, alias } = await bootLocmaf();
    const garbage = Uint8Array.of(0x3f, 0x00);
    sendLocmaf(adapter, alias, 0, 0, garbage);
    locmafGroup(3000, 1).forEach((payload) => sendLocmaf(adapter, alias, 1, 0, payload));
    await sleep(10);
    expect(adapter.unsubscribe).not.toHaveBeenCalled();

    for (let g = 2; g < 5; g++) sendLocmaf(adapter, alias, g, 0, garbage);
    await sleep(10);
    expect(adapter.unsubscribe).toHaveBeenCalled();
    await player.destroy();
  });
});

describe('CMAF in-band init (collect-then-initialize-once)', () => {
  it('no initData/initTrack: subscribes media, defers MSE, then initializes ONCE from in-band ftyp+moov', async () => {
    const { player, adapter, mockMs, assembler, errors, subscribedNames, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE, AUDIO_BASE]));

    // Media subscribed despite absent init (bootstrap may complete in-band).
    expect(subscribedNames()).toEqual(['catalog', 'video', 'audio']);
    expect(mockMs.initialize).not.toHaveBeenCalled(); // never with empty bytes

    // In-band init arrives on each track (the openmoq-publisher pattern).
    const videoInit = initSegmentPayload(48); // ftyp+moov
    const audioInit = boxPayload(['moov', 40]); // moov-only is a valid init shape
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: videoInit,
    } as MoqtObject);
    expect(mockMs.initialize).not.toHaveBeenCalled(); // still collecting (audio pending)

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('audio'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: audioInit,
    } as MoqtObject);

    // Exactly one initialize, complete config, exact bytes.
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    const cfg = mockMs.initialize.mock.calls[0]![0];
    expect(cfg.video.codec).toBe('avc1.4D4028');
    expect(cfg.audio.codec).toBe('mp4a.40.2');
    expect(cfg.video.initData).toEqual(videoInit);
    expect(cfg.audio.initData).toEqual(audioInit);
    // Assembler received both init segments too.
    expect(assembler.setInitSegment).toHaveBeenCalledWith('video', videoInit);
    expect(assembler.setInitSegment).toHaveBeenCalledWith('audio', audioInit);
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('moof before init is dropped (not appended) and bootstrap still completes on later init', async () => {
    const { player, adapter, mockMs, errors, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 5_000 });

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(1), payload: boxPayload(['moof', 32]),
    } as MoqtObject);
    expect(mockMs.initialize).not.toHaveBeenCalled();
    expect(mockMs.appendChunk).not.toHaveBeenCalled(); // nothing reached MSE

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: initSegmentPayload(),
    } as MoqtObject);
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]); // recovered before the deadline — no fatal
    await player.destroy();
  });

  it('split initTracks: video and audio init tracks initialize TOGETHER, once (only-first-wins regression)', async () => {
    const { player, adapter, mockMs, reqIdFor } = await bootPlayer(cmafCatalog([
      { ...VIDEO_BASE, initTrack: 'init-v' },
      { ...AUDIO_BASE, initTrack: 'init-a' },
    ]));

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('init-v'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: initSegmentPayload(28), // 44B ftyp+moov
    } as MoqtObject);
    expect(mockMs.initialize).not.toHaveBeenCalled(); // audio init still pending

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('init-a'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: initSegmentPayload(20), // 36B ftyp+moov
    } as MoqtObject);
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    const cfg = mockMs.initialize.mock.calls[0]![0];
    expect(cfg.video).toBeDefined();
    expect(cfg.audio).toBeDefined();
    await player.destroy();
  });
});

describe('CMAF bootstrap deadlines', () => {
  it('media flowing but no init within cmafBootstrapTimeoutMs → fatal CMAF_INIT_TIMEOUT', async () => {
    const { player, adapter, errors, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 60 });

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(1), payload: boxPayload(['moof', 32]),
    } as MoqtObject);
    await sleep(150);

    const err = errors.find((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT);
    expect(err).toBeDefined();
    expect(err.severity).toBe('fatal');
    expect(err.message).toMatch(/no init segment/i);
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('initialized but no first frame within the deadline → fatal CMAF_INIT_TIMEOUT (frame variant)', async () => {
    const { player, errors } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60 });
    // Inline init → initialized immediately; mock MS never fires onFirstFrame.
    await sleep(150);
    const err = errors.find((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/no frame rendered/i);
    await player.destroy();
  });

  it('a rendered first frame fulfills the deadline — no fatal', async () => {
    const { player, mockMs, errors } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60 });
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    mockMs.onFirstFrame?.(); // MSE reports a rendered frame
    await sleep(150);
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    await player.destroy();
  });

  it('cmafBootstrapTimeoutMs: 0 disables both deadlines', async () => {
    const { player, adapter, errors, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 0 });
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(1), payload: boxPayload(['moof', 32]),
    } as MoqtObject);
    await sleep(150);
    expect(errors).toEqual([]);
    expect(player.state).not.toBe(PlayerState.ERROR);
    await player.destroy();
  });
});

describe('CMAF first-frame deadline renewal (false-positive fix)', () => {
  it('video segments arriving keep renewing the deadline — no false-positive fatal past cmafBootstrapTimeoutMs', async () => {
    const { player, errors, mockMs, sendVideoSegment } = await bootPlayerCapturingAssembler(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 100, cmafFirstFrameMaxWaitMs: 2_000 });
    expect(mockMs.initialize).toHaveBeenCalledTimes(1); // cmaf_init armed cmaf_first_frame

    // Renew immediately (the bootPlayer harness's own async fan-out wait
    // already consumes part of the very first deadline window), then keep
    // renewing well inside the 100ms deadline on every pass. Total span
    // (≈320ms) exceeds cmafBootstrapTimeoutMs several times over but stays
    // under the 2000ms ceiling.
    sendVideoSegment();
    for (let i = 0; i < 8; i++) {
      await sleep(40);
      sendVideoSegment();
    }
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);

    mockMs.onFirstFrame?.(); // frame finally renders — clean shutdown
    await sleep(150);
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    await player.destroy();
  });

  it('delivery genuinely stalling (no more segments) still fires the fatal after a renewed deadline', async () => {
    const { player, errors, mockMs, sendVideoSegment } = await bootPlayerCapturingAssembler(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60, cmafFirstFrameMaxWaitMs: 1_000 });
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);

    sendVideoSegment(); // one renewal, then delivery stops entirely
    await sleep(150); // > cmafBootstrapTimeoutMs since the last renewal

    const err = errors.find((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/no frame rendered/i);
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('renewal stops past cmafFirstFrameMaxWaitMs — a stream that never renders still surfaces fatal eventually', async () => {
    const { player, errors, mockMs, sendVideoSegment } = await bootPlayerCapturingAssembler(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60, cmafFirstFrameMaxWaitMs: 120 });
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);

    // Keep renewing past the 120ms ceiling — segments never stop arriving,
    // but no frame ever renders (a genuine codec/init-mismatch class bug).
    for (let i = 0; i < 10; i++) {
      await sleep(30);
      sendVideoSegment();
    }

    const err = errors.find((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/no frame rendered/i);
    await player.destroy();
  });
});

describe('CMAF first-frame deadline while the document is hidden (browser defers media load)', () => {
  /**
   * Minimal `document` stand-in: browsers defer a media element's resource
   * load (for MSE, the attachment that fires `sourceopen`) while the tab is
   * hidden, so a bootstrap deadline expiring in that state is not a
   * codec/init failure. These tests run in Node, where no `document` exists.
   */
  function stubDocument(state: 'hidden' | 'visible') {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: state,
      addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.add(fn); },
      removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn); },
      hide() { this.visibilityState = 'hidden'; for (const fn of [...listeners]) fn(); },
      show() { this.visibilityState = 'visible'; for (const fn of [...listeners]) fn(); },
      listenerCount: () => listeners.size,
    };
    (globalThis as any).document = doc;
    return doc;
  }
  afterEach(() => { delete (globalThis as any).document; });

  it('hidden: the first-frame deadline is suspended (no fatal); visible again → re-armed and escalates normally', async () => {
    const doc = stubDocument('hidden');
    const { player, errors } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60 });
    await sleep(200); // several deadlines' worth, all while hidden
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    expect(player.state).not.toBe(PlayerState.ERROR);
    expect(doc.listenerCount()).toBe(1); // waiting on visibilitychange

    doc.show();
    expect(doc.listenerCount()).toBe(1); // remains while the re-armed deadline is active
    await sleep(150); // > cmafBootstrapTimeoutMs after becoming visible, still no frame
    const err = errors.find((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/no frame rendered/i);
    expect(doc.listenerCount()).toBe(0);
    await player.destroy();
  });

  it('hidden → visible → frame renders inside the re-armed deadline: no fatal', async () => {
    const doc = stubDocument('hidden');
    const { player, errors, mockMs } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60 });
    await sleep(150);
    doc.show();
    mockMs.onFirstFrame?.(); // sourceopen → init → first paint, as a foregrounded tab does
    await sleep(150);
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    expect(player.state).not.toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('foregrounding just before the original deadline grants a fresh visible deadline', async () => {
    const doc = stubDocument('hidden');
    const { player, errors } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 500 });

    await sleep(200);
    doc.show();
    await sleep(350);

    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    expect(player.state).not.toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('suspends an active deadline when a visible document becomes hidden', async () => {
    const doc = stubDocument('visible');
    const { player, errors } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 120 });

    await sleep(40);
    doc.hide();
    await sleep(40);
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);

    doc.show();
    await sleep(50);
    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    await player.destroy();
  });

  it('does not charge hidden time against the first-frame renewal ceiling', async () => {
    const doc = stubDocument('hidden');
    const { player, errors, sendVideoSegment } = await bootPlayerCapturingAssembler(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60, cmafFirstFrameMaxWaitMs: 120 });

    await sleep(180);
    doc.show();
    await sleep(35);
    sendVideoSegment();
    await sleep(40);

    expect(errors.filter((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toEqual([]);
    await player.destroy();
  });

  it('hidden: missing CMAF init still reaches its bounded fatal deadline', async () => {
    stubDocument('hidden');
    const { player, adapter, errors, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 60 });
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(1), payload: boxPayload(['moof', 32]),
    } as MoqtObject);
    await sleep(200);
    expect(errors.some((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toBe(true);
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('destroy() while deferred removes the visibilitychange listener', async () => {
    const doc = stubDocument('hidden');
    const { player } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60 });
    await sleep(150);
    expect(doc.listenerCount()).toBe(1);
    await player.destroy();
    expect(doc.listenerCount()).toBe(0);
  });

  it('a visible document keeps the historical escalation (regression guard)', async () => {
    stubDocument('visible');
    const { player, errors } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]),
      { cmafBootstrapTimeoutMs: 60 });
    await sleep(150);
    expect(errors.some((e) => e.code === PlayerErrorCode.CMAF_INIT_TIMEOUT)).toBe(true);
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });
});

describe('CMAF media is held until the MediaSource attaches (resume at the live edge)', () => {
  const videoObj = (alias: unknown, groupId: number, objectId: number): MoqtObject => ({
    kind: 'data', trackAlias: alias, groupId: varint(groupId), subgroupId: varint(0),
    objectId: varint(objectId), payload: boxPayload(['moof', 24], ['mdat', 32]),
  } as MoqtObject);

  it('an adapter that does not report attachment is treated as attached (back-compat)', async () => {
    const { player, adapter, assembler, reqIdFor } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]));
    const vid = await reqIdFor('video');
    adapter._triggerObject(0n, videoObj(vid, 7, 0)); // group start → synced → pushed
    expect(assembler.push).toHaveBeenCalledTimes(1);
    await player.destroy();
  });

  it('attached=false: media is held (not fed to the assembler); on attach the assembler is reset, ' +
     're-seeded with init, and video re-syncs to the next group start', async () => {
    const { player, adapter, mockMs, assembler, reqIdFor } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]));
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    const vid = await reqIdFor('video');
    assembler.setInitSegment.mockClear();

    // Browser has deferred the attachment (hidden tab): nothing may reach MSE.
    (mockMs as { attached?: boolean }).attached = false;
    adapter._triggerObject(0n, videoObj(vid, 7, 0));
    adapter._triggerObject(0n, videoObj(vid, 7, 1));
    adapter._triggerObject(0n, videoObj(vid, 8, 0));
    expect(assembler.push).not.toHaveBeenCalled();
    expect(assembler.reset).not.toHaveBeenCalled();

    // Tab foregrounded → sourceopen → SourceBuffers → attached.
    (mockMs as { attached?: boolean }).attached = true;
    (mockMs as { onAttached?: () => void }).onAttached?.();
    expect(assembler.reset).toHaveBeenCalledTimes(1);
    expect(assembler.setInitSegment).toHaveBeenCalledWith('video', expect.any(Uint8Array)); // re-seeded

    // Mid-group objects after attach are skipped until the next group start…
    adapter._triggerObject(0n, videoObj(vid, 8, 3));
    adapter._triggerObject(0n, videoObj(vid, 8, 4));
    expect(assembler.push).not.toHaveBeenCalled();
    // …then the keyframe-led group at the live edge is the first thing fed.
    adapter._triggerObject(0n, videoObj(vid, 9, 0));
    adapter._triggerObject(0n, videoObj(vid, 9, 1));
    expect(assembler.push).toHaveBeenCalledTimes(2);
    expect(assembler.push.mock.calls[0]![2]).toBe(9n);
    await player.destroy();
  });

  it('onAttached without a preceding hold is a no-op (normal visible startup)', async () => {
    const { player, mockMs, assembler } = await bootPlayer(
      cmafCatalog([{ ...VIDEO_BASE, initData: btoa('\x01\x02\x03\x04') }]));
    (mockMs as { onAttached?: () => void }).onAttached?.();
    expect(assembler.reset).not.toHaveBeenCalled();
    await player.destroy();
  });
});

describe('CMAF in-band init detection strictness', () => {
  it('ftyp-only, moof, and garbage payloads are NOT accepted as init', async () => {
    const { player, adapter, mockMs, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 0 });
    const vid = await reqIdFor('video');
    const send = (payload: Uint8Array, objectId: number) => adapter._triggerObject(0n, {
      kind: 'data', trackAlias: vid, groupId: varint(0), subgroupId: varint(0),
      objectId: varint(objectId), payload,
    } as MoqtObject);

    send(boxPayload(['ftyp', 16]), 0);                 // ftyp with no moov: not an init
    send(boxPayload(['moof', 24], ['mdat', 32]), 1);   // media
    send(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 2); // garbage
    send(boxPayload(['ftyp', 16], ['moof', 24]), 3);   // media after ftyp: not init
    expect(mockMs.initialize).not.toHaveBeenCalled();

    // A real ftyp+moov init IS accepted.
    send(initSegmentPayload(), 4);
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    await player.destroy();
  });

  it('a truncated moov (size beyond payload) is rejected', async () => {
    const { player, adapter, mockMs, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 0 });
    const truncated = initSegmentPayload().slice(0, 24); // moov size runs past end
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: truncated,
    } as MoqtObject);
    expect(mockMs.initialize).not.toHaveBeenCalled();
    await player.destroy();
  });
});

describe('CMAF adapter rejection (initialize() === false)', () => {
  it('does not mark initialized or build the assembler when the adapter rejects the config', async () => {
    const { player, adapter, mockMs, assembler, reqIdFor } =
      await bootPlayer(cmafCatalog([VIDEO_BASE]), { cmafBootstrapTimeoutMs: 0 });
    mockMs.initialize.mockReturnValue(false); // adapter: all-or-nothing rejection

    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(0), payload: initSegmentPayload(),
    } as MoqtObject);
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    expect(assembler.setInitSegment).not.toHaveBeenCalled(); // no assembler on failure

    // Media after the rejected init must STILL be treated as pre-init (dropped).
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: await reqIdFor('video'), groupId: varint(0), subgroupId: varint(0),
      objectId: varint(1), payload: boxPayload(['moof', 24], ['mdat', 32]),
    } as MoqtObject);
    expect(mockMs.appendChunk).not.toHaveBeenCalled();
    await player.destroy();
  });
});

// ─── MSF-01 / CMSF-01 init-by-reference (initRef → root initDataList) ──

/** A CMSF-01 catalog: string version "1", plus optional root fields. */
function cmsfCatalog(tracks: Array<Record<string, unknown>>, root: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: '1', ...root, tracks });
}
/** base64-encode raw bytes the way a publisher ships inline init data. */
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe('CMSF-01 init-by-reference (initRef → root initDataList)', () => {
  it('[red-first] a clear CMAF track with initRef resolves root inline initDataList and initializes MSE', async () => {
    const initSeg = initSegmentPayload(48); // ftyp+moov
    const { player, mockMs, assembler, errors, subscribedNames } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: b64(initSeg) }] },
      ));

    // Inline init resolved from the root list satisfies bootstrap immediately —
    // MSE initializes ONCE with the DECODED reference bytes, no injected initData.
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    const cfg = mockMs.initialize.mock.calls[0]![0];
    expect(cfg.video.codec).toBe('avc1.4D4028');
    expect(cfg.video.initData).toEqual(initSeg);
    expect(assembler.setInitSegment).toHaveBeenCalledWith('video', initSeg);
    expect(subscribedNames()).toContain('video');
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('initRef to a NON-inline entry is not treated as inline bytes (defers, no bootstrap init)', async () => {
    const { player, mockMs, errors, subscribedNames } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'external', data: 'https://cdn.example/init.mp4' }] },
      ),
      { cmafBootstrapTimeoutMs: 0 });
    // No inline bytes → nothing to initialize with at bootstrap; the track is
    // still subscribed (in-band init / timeout is the backstop), no fatal.
    expect(mockMs.initialize).not.toHaveBeenCalled();
    expect(subscribedNames()).toContain('video');
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('resolved inline init that is invalid base64 → fatal CMAF_INIT_INVALID before any media subscribe', async () => {
    const { player, errors, subscribedNames } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: '!!!not-base64!!!' }] },
      ));
    expect(errors.some((e) => e.code === PlayerErrorCode.CMAF_INIT_INVALID)).toBe(true);
    expect(subscribedNames()).toEqual(['catalog']); // failed before media hit the wire
    expect(player.state).toBe(PlayerState.ERROR);
    await player.destroy();
  });

  it('resolved inline init that decodes to zero bytes → fatal CMAF_INIT_INVALID before subscribe', async () => {
    const { player, errors, subscribedNames } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: '' }] },
      ));
    expect(errors.some((e) => e.code === PlayerErrorCode.CMAF_INIT_INVALID)).toBe(true);
    expect(subscribedNames()).toEqual(['catalog']);
    await player.destroy();
  });

  it('legacy inline initData WINS over initRef when both are present', async () => {
    const winning = initSegmentPayload(48);
    const losing = boxPayload(['moov', 60]);
    const { player, mockMs, errors } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initData: b64(winning), initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: b64(losing) }] },
      ));
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    expect(mockMs.initialize.mock.calls[0]![0].video.initData).toEqual(winning);
    expect(errors).toEqual([]);
    await player.destroy();
  });

  it('legacy MSF-00 initTrack auto-subscribe still works (no initRef)', async () => {
    const { player, subscribedNames, mockMs } = await bootPlayer(
      cmsfCatalog([{ ...VIDEO_BASE, initTrack: 'init-v' }]));
    // The init track is lazily subscribed; MSE waits for its delivery.
    expect(subscribedNames()).toContain('init-v');
    expect(mockMs.initialize).not.toHaveBeenCalled();
    await player.destroy();
  });

  it('dangling initRef is rejected at the MSF parse layer (fatal, zero media subscribes)', async () => {
    const { player, errors, subscribedNames } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initRef: 'missing' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: b64(initSegmentPayload()) }] },
      ));
    expect(errors.some((e) => e.code === PlayerErrorCode.CATALOG_PARSE_ERROR)).toBe(true);
    expect(subscribedNames()).toEqual(['catalog']);
    await player.destroy();
  });

  it('a contentProtectionRefIDs track is metadata-preserved, NOT rejected: clear init still plays', async () => {
    // Repo policy: content protection is INERT catalog metadata — the player
    // neither claims protected playback nor blocks on it. A CMSF track carrying
    // contentProtectionRefIDs + a resolvable clear inline init initializes MSE.
    const initSeg = initSegmentPayload(48);
    const { player, mockMs, errors } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, initRef: 'i1', contentProtectionRefIDs: ['1'] }],
        {
          initDataList: [{ id: 'i1', type: 'inline', data: b64(initSeg) }],
          contentProtections: [{
            refID: '1', defaultKID: ['01234567-89ab-cdef-0123-456789abcdef'], scheme: 'cbcs',
            drmSystem: { systemID: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', pssh: 'AAAB' },
          }],
        }));
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    expect(mockMs.initialize.mock.calls[0]![0].video.initData).toEqual(initSeg);
    // No protected-playback / unsupported error was raised.
    expect(errors).toEqual([]);
    await player.destroy();
  });
});

// ─── MSF-01 op-array delta applied by the player ──────────────────────

describe('MSF-01 op-array delta reaches the player (delta-added track usable)', () => {
  it('a delta-added CMAF track with initRef resolves against the preserved root list', async () => {
    const initSeg = initSegmentPayload(48);
    const { player, adapter, mockMs, errors, subscribedNames, reqIdFor } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, name: 'v-avc', altGroup: 1, initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: b64(initSeg) }] },
      ));
    // Base track bootstrapped MSE from its initRef.
    expect(mockMs.initialize).toHaveBeenCalledTimes(1);
    const catalogReqId = await reqIdFor('catalog');

    // A later op-array delta ADDS an HEVC alternate that reuses the same root
    // init entry (deltas carry no initDataList of their own).
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: catalogReqId, groupId: varint(1), subgroupId: varint(0), objectId: varint(0),
      payload: new TextEncoder().encode(JSON.stringify({
        deltaUpdate: [{ op: 'add', tracks: [{ name: 'v-hevc', packaging: 'cmaf', isLive: true, role: 'video', altGroup: 1, codec: 'hvc1.1.6.L93.90', initRef: 'i1' }] }],
      })),
    } as MoqtObject);
    await sleep(10);
    expect(errors).toEqual([]); // delta applied cleanly (reference resolved)

    // Switching to the delta-added HEVC track resolves its initRef through the
    // player (a codec change): it must get PAST init validation and SUBSCRIBE,
    // proving the delta-added track + preserved initDataList are wired in.
    await player.selectVideoTrack('v-hevc');
    expect(subscribedNames()).toContain('v-hevc');
    await player.destroy();
  });

  it('a delta introducing a dangling initRef surfaces a degraded CATALOG_DELTA_ERROR, base stays', async () => {
    const initSeg = initSegmentPayload(48);
    const { player, adapter, errors, reqIdFor } = await bootPlayer(
      cmsfCatalog(
        [{ ...VIDEO_BASE, name: 'v-avc', initRef: 'i1' }],
        { initDataList: [{ id: 'i1', type: 'inline', data: b64(initSeg) }] },
      ));
    const catalogReqId = await reqIdFor('catalog');
    adapter._triggerObject(0n, {
      kind: 'data', trackAlias: catalogReqId, groupId: varint(1), subgroupId: varint(0), objectId: varint(0),
      payload: new TextEncoder().encode(JSON.stringify({
        deltaUpdate: [{ op: 'add', tracks: [{ name: 'bad', packaging: 'cmaf', isLive: true, initRef: 'missing' }] }],
      })),
    } as MoqtObject);
    await sleep(10);
    // Delta rejected → degraded (not fatal); the base catalog keeps playing.
    expect(errors.some((e) => e.code === PlayerErrorCode.CATALOG_DELTA_ERROR && e.severity === 'degraded')).toBe(true);
    expect(player.state).not.toBe(PlayerState.ERROR);
    await player.destroy();
  });
});
