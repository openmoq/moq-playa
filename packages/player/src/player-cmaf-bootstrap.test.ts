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

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerErrorCode } from './errors.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';

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
