/**
 * Subgroup lifecycle witness — the diagnostic that records how a video
 * subgroup stream terminated.
 *
 * A subgroup carrying END_OF_GROUP completes its group only when the stream
 * FINs, and the MOQT qlog defines no stream-terminal event, so this line is
 * the only record of that fact. It is emitted at info so an info-level capture
 * retains it, and restricted to video — one record per video subgroup
 * terminal.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MoqtPlayer } from './player.js';
import { PlayerState } from './state.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@moqt/webtransport';
import type { ControlMessage, DataStreamHeader, MoqtObject } from '@moqt/transport';
import { varint } from '@moqt/transport';

const VIDEO_ALIAS = 50n;
const AUDIO_ALIAS = 51n;

const CATALOG_JSON = JSON.stringify({
  version: 1,
  tracks: [
    {
      name: 'video', packaging: 'loc', isLive: true, role: 'video',
      renderGroup: 1, codec: 'av01.0.08M.10', width: 1920, height: 1080, bitrate: 1_500_000,
    },
    {
      name: 'audio', packaging: 'loc', isLive: true, role: 'audio',
      renderGroup: 1, codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32000,
    },
  ],
});

function createMockAdapter() {
  let nextRequestId = 1n;
  const adapter: any = {
    session: { state: 'established', close: vi.fn(() => []) },
    onMessage: null, onClose: null, onError: null, onDataStream: null,
    onObject: null, onStreamClosed: null, onDatagram: null,
    onNamespaceMessage: null, onQlogEvent: null, onSubgroupFin: null,
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
    _triggerDataStream: (streamId: bigint, header: DataStreamHeader) =>
      adapter.onDataStream?.(streamId, header),
    _triggerStreamClosed: (streamId: bigint, error?: number) =>
      adapter.onStreamClosed?.(streamId, error),
    /** Graceful FIN — the adapter alone can distinguish this from a read failure. */
    _triggerSubgroupFin: (streamId: bigint, header: any) =>
      adapter.onSubgroupFin?.(streamId, header.header ?? header),
  };
  return adapter;
}

/** A subgroup data-stream header for `alias`. */
/** typeByte encodes the subgroup-id mode in bits 1-2: ZERO, FIRST_OBJECT, EXPLICIT. */
const MODE = { ZERO: 0x10, FIRST_OBJECT: 0x12, EXPLICIT: 0x14 } as const;

function subgroupHeader(
  alias: bigint, groupId: bigint, endOfGroup: boolean, subgroupId = 0n,
  typeByte: number = MODE.ZERO,
) {
  return {
    type: 'subgroup',
    header: {
      typeByte: typeByte | (endOfGroup ? 0x08 : 0),
      trackAlias: alias,
      groupId,
      subgroupId,
      publisherPriority: 128,
      hasExtensions: false,
      isEndOfGroup: endOfGroup,
    },
  } as unknown as DataStreamHeader;
}

/** Per level, so a change of log level is observable. */
let logs: Record<'error' | 'warn' | 'info' | 'debug', string[]>;

function createConfig(adapter: ReturnType<typeof createMockAdapter>): MoqtPlayerConfig {
  return {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => adapter as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe',
    logLevel: 'debug',
    logger: {
      error: (m: string) => logs.error.push(m),
      warn: (m: string) => logs.warn.push(m),
      info: (m: string) => logs.info.push(m),
      debug: (m: string) => logs.debug.push(m),
    },
  } as MoqtPlayerConfig;
}

async function startPlaying(adapter: ReturnType<typeof createMockAdapter>): Promise<MoqtPlayer> {
  const player = new MoqtPlayer(createConfig(adapter));
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
    objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
  } as MoqtObject);
  await new Promise((r) => setTimeout(r, 0));

  const videoReqId = await adapter.subscribe.mock.results[1]?.value;
  const audioReqId = await adapter.subscribe.mock.results[2]?.value;
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
    parameters: new Map(), trackExtensions: [],
  } as unknown as ControlMessage);
  adapter._triggerMessage({
    type: 'SUBSCRIBE_OK', requestId: audioReqId, trackAlias: varint(AUDIO_ALIAS),
    parameters: new Map(), trackExtensions: [],
  } as unknown as ControlMessage);

  player.play();
  expect(player.state).toBe(PlayerState.PLAYING);
  return player;
}

/** Parse the lifecycle lines out of the captured log. */
function lifecycleLines(level: 'error' | 'warn' | 'info' | 'debug' = 'info'):
Array<Record<string, unknown>> {
  return logs[level]
    .filter(l => l.startsWith('[subgroup_lifecycle:v1] '))
    .map(l => JSON.parse(l.slice('[subgroup_lifecycle:v1] '.length)) as Record<string, unknown>);
}

describe('subgroup lifecycle witness', () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let player: MoqtPlayer;

  beforeEach(async () => {
    logs = { error: [], warn: [], info: [], debug: [] };
    adapter = createMockAdapter();
    player = await startPlaying(adapter);
  });

  afterEach(async () => { await player.destroy(); });

  it('records a video EOG+FIN terminal, at info level', () => {
    const header = subgroupHeader(VIDEO_ALIAS, 332n, true);
    adapter._triggerDataStream(17n, header);
    adapter._triggerSubgroupFin(17n, header);
    expect(lifecycleLines()).toEqual([{
      stream_id: '17', group_id: '332', subgroup_id: '0',
      contains_end_of_group: true, terminal: 'fin',
    }]);
    // The level is the contract: Gaston's capture is info, not debug.
    expect(lifecycleLines('debug')).toEqual([]);
  });

  it('records a video RESET with its exact code', () => {
    adapter._triggerDataStream(19n, subgroupHeader(VIDEO_ALIAS, 333n, true));
    adapter._triggerStreamClosed(19n, 0x2a);
    expect(lifecycleLines()).toEqual([{
      stream_id: '19', group_id: '333', subgroup_id: '0',
      contains_end_of_group: true, terminal: 'reset', reset_code: '0x2a',
    }]);
  });

  it('does NOT claim FIN for a close with no error code', () => {
    // `onStreamClosed(id, undefined)` covers a generic read failure as well as
    // a clean FIN. Only the adapter's graceful-FIN hook proves the difference,
    // and a false FIN would send the investigation the wrong way.
    adapter._triggerDataStream(35n, subgroupHeader(VIDEO_ALIAS, 400n, true));
    adapter._triggerStreamClosed(35n);
    expect(lifecycleLines()).toEqual([]);
  });

  it('distinguishes a header without END_OF_GROUP', () => {
    const header = subgroupHeader(VIDEO_ALIAS, 334n, false);
    adapter._triggerDataStream(21n, header);
    adapter._triggerSubgroupFin(21n, header);
    expect(lifecycleLines()[0]!.contains_end_of_group).toBe(false);
  });

  it('reports the resolved FIRST_OBJECT subgroup id, not the placeholder', () => {
    // The decoder reports subgroupId 0 at header time for FIRST_OBJECT mode and
    // resolves it to the first object id afterwards. The FIN hook carries the
    // resolved header.
    const opened = subgroupHeader(VIDEO_ALIAS, 338n, true, 0n);
    adapter._triggerDataStream(37n, opened);
    adapter._triggerSubgroupFin(37n, subgroupHeader(VIDEO_ALIAS, 338n, true, 7n));
    expect(lifecycleLines()[0]!.subgroup_id).toBe('7');
  });

  it('reports authoritative subgroup ids on reset for ZERO and EXPLICIT modes', () => {
    // Only FIRST_OBJECT is unresolved before its first object; treating every
    // reset as unknown would discard an id the header already gave us.
    adapter._triggerDataStream(39n, subgroupHeader(VIDEO_ALIAS, 339n, true, 0n, MODE.ZERO));
    adapter._triggerStreamClosed(39n, 0x1);
    expect(lifecycleLines()[0]!.subgroup_id).toBe('0');

    adapter._triggerDataStream(45n, subgroupHeader(VIDEO_ALIAS, 340n, true, 5n, MODE.EXPLICIT));
    adapter._triggerStreamClosed(45n, 0x1);
    expect(lifecycleLines()[1]!.subgroup_id).toBe('5');
  });

  it('marks FIRST_OBJECT unresolved when reset before its first object', () => {
    adapter._triggerDataStream(47n, subgroupHeader(VIDEO_ALIAS, 342n, true, 0n, MODE.FIRST_OBJECT));
    adapter._triggerStreamClosed(47n, 0x1);
    expect(lifecycleLines()[0]!.subgroup_id).toBeNull();
  });

  it('resolves FIRST_OBJECT from the first object, then reports it on reset', () => {
    adapter._triggerDataStream(49n, subgroupHeader(VIDEO_ALIAS, 343n, true, 0n, MODE.FIRST_OBJECT));
    adapter._triggerObject(49n, {
      kind: 'data', trackAlias: varint(VIDEO_ALIAS), groupId: varint(343),
      subgroupId: varint(7), objectId: varint(7), payload: new Uint8Array([1]),
    } as MoqtObject);
    adapter._triggerStreamClosed(49n, 0x1);
    expect(lifecycleLines()[0]!.subgroup_id).toBe('7');
  });

  it('emits nothing for an audio subgroup — one stream per group would flood', () => {
    const header = subgroupHeader(AUDIO_ALIAS, 100n, true);
    adapter._triggerDataStream(23n, header);
    adapter._triggerSubgroupFin(23n, header);
    expect(lifecycleLines()).toEqual([]);
  });

  it('emits nothing for a fetch stream', () => {
    adapter._triggerDataStream(25n, {
      type: 'fetch', header: { requestId: varint(7) },
    } as unknown as DataStreamHeader);
    adapter._triggerStreamClosed(25n);
    expect(lifecycleLines()).toEqual([]);
  });

  it('emits nothing for a stream that never carried a subgroup header', () => {
    adapter._triggerStreamClosed(27n, 0x1);
    expect(lifecycleLines()).toEqual([]);
  });

  it('still classifies as video after the alias is unregistered', () => {
    // PUBLISH_DONE, a track switch, or a liveness resubscribe can unregister
    // the alias before an open stream FINs. Classification is snapshotted at
    // header time so the witness cannot silently vanish.
    const header = subgroupHeader(VIDEO_ALIAS, 341n, true);
    adapter._triggerDataStream(43n, header);
    (player as any).subscriptionManager?.unregisterTrack(VIDEO_ALIAS);
    adapter._triggerSubgroupFin(43n, header);
    expect(lifecycleLines()[0]!.group_id).toBe('341');
  });

  it('consumes the entry on FIN so a repeated close cannot re-emit', () => {
    const header = subgroupHeader(VIDEO_ALIAS, 335n, true);
    adapter._triggerDataStream(29n, header);
    adapter._triggerSubgroupFin(29n, header);
    adapter._triggerSubgroupFin(29n, header);
    adapter._triggerStreamClosed(29n, 0x1);
    expect(lifecycleLines()).toHaveLength(1);
  });

  it('consumes the entry on RESET too', () => {
    adapter._triggerDataStream(31n, subgroupHeader(VIDEO_ALIAS, 336n, true));
    adapter._triggerStreamClosed(31n, 0x5);
    adapter._triggerStreamClosed(31n, 0x5);
    expect(lifecycleLines()).toHaveLength(1);
  });

  it('keeps per-connection identity for a stream id reused across a migration', () => {
    // Witness state is partitioned per connection. A migration reuses QUIC
    // stream ids, so a single shared map — whether module-level or one player
    // field covering all connections — would let the second connection
    // overwrite the first's group identity.
    const other = createMockAdapter();
    adapter._triggerDataStream(41n, subgroupHeader(VIDEO_ALIAS, 500n, true));

    (player as any).connection = other;
    (player as any).wireConnection(other);
    other._triggerDataStream(41n, subgroupHeader(VIDEO_ALIAS, 900n, false));

    adapter._triggerSubgroupFin(41n, subgroupHeader(VIDEO_ALIAS, 500n, true));
    other._triggerSubgroupFin(41n, subgroupHeader(VIDEO_ALIAS, 900n, false));

    expect(lifecycleLines().map(l => [l.group_id, l.contains_end_of_group])).toEqual([
      ['500', true],
      ['900', false],
    ]);
  });

  it('detaches the FIN hook on destroy', async () => {
    // An externally owned adapter must not retain a destroyed player: a late
    // graceful FIN would otherwise call into it and its custom logger.
    expect(adapter.onSubgroupFin).toBeTypeOf('function');
    await player.destroy();
    expect(adapter.onSubgroupFin).toBeUndefined();
    // Re-created in afterEach's destroy; make that call harmless.
    player = await startPlaying(createMockAdapter());
  });

  it('contains a throwing logger rather than failing the adapter FIN', async () => {
    // A diagnostic must never turn a clean adapter FIN into a synthetic read
    // failure by throwing back out of onSubgroupFin.
    const boom = createMockAdapter();
    const p = await startPlaying(boom);
    const original = (p as any).log;
    try {
      const header = subgroupHeader(VIDEO_ALIAS, 350n, true);
      boom._triggerDataStream(51n, header);
      (p as any).log = {
        error() {}, warn() {}, debug() {},
        info() { throw new Error('sink down'); },
      };
      expect(() => boom._triggerSubgroupFin(51n, header)).not.toThrow();
    } finally {
      (p as any).log = original;
      await p.destroy();
    }
  });

  it('purges the witness deterministically on detach', async () => {
    adapter._triggerDataStream(69n, subgroupHeader(VIDEO_ALIAS, 800n, true));
    expect((player as any).subgroupWitness.get(adapter)?.size).toBe(1);
    await player.destroy();
    expect((player as any).subgroupWitness.get(adapter)).toBeUndefined();
    player = await startPlaying(createMockAdapter()); // afterEach destroys this
  });

  it('emits concrete JSON with no printf placeholders', () => {
    const header = subgroupHeader(VIDEO_ALIAS, 337n, true, 2n);
    adapter._triggerDataStream(33n, header);
    adapter._triggerSubgroupFin(33n, header);
    const raw = logs.info.find(l => l.startsWith('[subgroup_lifecycle:v1] '))!;
    expect(raw).not.toContain('%s');
    expect(raw).not.toContain('%d');
    expect(raw).toContain('"subgroup_id":"2"');
    expect(() => JSON.parse(raw.slice('[subgroup_lifecycle:v1] '.length))).not.toThrow();
  });
});

describe('subgroup lifecycle witness — alias unbound at header time', () => {
  // Data may legally precede its SUBSCRIBE_OK (§10.4.2), so a stream can open,
  // and even finish, while its alias is unbound. Such a stream is deliberately
  // never reported: classifying it later, when some subscription binds that
  // alias, would attribute its terminal to a track that never owned it. This
  // record exists to settle a dispute, so omission beats fabrication.
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    logs = { error: [], warn: [], info: [], debug: [] };
    adapter = createMockAdapter();
  });

  /** Bring a player up to catalog, leaving the media SUBSCRIBE_OKs unsent. */
  async function startAwaitingSubscribeOk(): Promise<MoqtPlayer> {
    const player = new MoqtPlayer(createConfig(adapter));
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
      objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 0));
    return player;
  }

  async function bindVideoAlias(): Promise<void> {
    const videoReqId = await adapter.subscribe.mock.results[1]?.value;
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
      parameters: new Map(), trackExtensions: [],
    } as unknown as ControlMessage);
  }

  it('never reports a terminal for a stream opened before its alias bound', async () => {
    const player = await startAwaitingSubscribeOk();
    try {
      const header = subgroupHeader(VIDEO_ALIAS, 600n, true);
      adapter._triggerDataStream(61n, header);
      await bindVideoAlias();
      adapter._triggerSubgroupFin(61n, header);
      // The alias later binds to this very track, and it is still omitted:
      // the rule is header-time classification, not eventual plausibility.
      expect(lifecycleLines()).toEqual([]);
    } finally { await player.destroy(); }
  });

  it('retains no state for an unknown-alias stream that opens and FINs', async () => {
    const player = await startAwaitingSubscribeOk();
    try {
      const header = subgroupHeader(999n, 601n, true);
      adapter._triggerDataStream(63n, header);
      adapter._triggerSubgroupFin(63n, header);
      expect(lifecycleLines()).toEqual([]);
      // Nothing is held for a later bind to pick up.
      const witness = (player as any).subgroupWitness.get(adapter);
      expect(witness?.size ?? 0).toBe(0);
    } finally { await player.destroy(); }
  });

  it('cannot attribute a stale terminal to later alias reuse', async () => {
    const player = await startAwaitingSubscribeOk();
    try {
      // A stream on an alias nobody owns yet, opened and finished.
      const stale = subgroupHeader(VIDEO_ALIAS, 602n, true);
      adapter._triggerDataStream(65n, stale);
      adapter._triggerSubgroupFin(65n, stale);
      // That alias is now bound by the real video subscription.
      await bindVideoAlias();
      // A genuine, correctly classified stream follows.
      const live = subgroupHeader(VIDEO_ALIAS, 700n, true);
      adapter._triggerDataStream(67n, live);
      adapter._triggerSubgroupFin(67n, live);
      // Only the live one appears; the stale group never surfaces as evidence.
      expect(lifecycleLines().map(l => l.group_id)).toEqual(['700']);
    } finally { await player.destroy(); }
  });

  it('does not grow retained state across many fresh unknown aliases', async () => {
    const player = await startAwaitingSubscribeOk();
    try {
      for (let i = 0; i < 500; i++) {
        const alias = BigInt(10_000 + i);
        const header = subgroupHeader(alias, BigInt(i), true);
        adapter._triggerDataStream(BigInt(1000 + i), header);
        adapter._triggerSubgroupFin(BigInt(1000 + i), header);
      }
      const witness = (player as any).subgroupWitness.get(adapter);
      expect(witness?.size ?? 0).toBe(0);
      expect(lifecycleLines()).toEqual([]);
    } finally { await player.destroy(); }
  });

});

describe('subgroup lifecycle witness — optimistic alias registrations', () => {
  // A subscription is registered under its request ID before SUBSCRIBE_OK,
  // because many relays echo the request ID as the track alias. The two are
  // separate spaces, so that registration is a guess. Classifying from it can
  // label an audio subgroup as video.
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    logs = { error: [], warn: [], info: [], debug: [] };
    adapter = createMockAdapter();
  });

  async function startAwaitingSubscribeOk(): Promise<MoqtPlayer> {
    const player = new MoqtPlayer(createConfig(adapter));
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
      objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 0));
    return player;
  }

  it('never classifies from an unconfirmed request-id-as-alias guess', async () => {
    const player = await startAwaitingSubscribeOk();
    try {
      const videoReqId = await adapter.subscribe.mock.results[1]?.value;
      const audioReqId = await adapter.subscribe.mock.results[2]?.value;
      const optimistic = BigInt(videoReqId.valueOf() as bigint);

      // An audio subgroup whose real alias collides with the optimistic video
      // request id, arriving before either SUBSCRIBE_OK.
      const early = subgroupHeader(optimistic, 900n, true);
      adapter._triggerDataStream(71n, early);
      adapter._triggerSubgroupFin(71n, early);
      expect(lifecycleLines()).toEqual([]);

      // The real mappings land: video elsewhere, audio on the colliding value.
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
        parameters: new Map(), trackExtensions: [],
      } as unknown as ControlMessage);
      adapter._triggerMessage({
        type: 'SUBSCRIBE_OK', requestId: audioReqId, trackAlias: varint(optimistic),
        parameters: new Map(), trackExtensions: [],
      } as unknown as ControlMessage);

      // The early audio group must never have been recorded as video.
      expect(lifecycleLines()).toEqual([]);

      // A genuine stream on the confirmed video alias is the only record.
      const genuine = subgroupHeader(VIDEO_ALIAS, 901n, true);
      adapter._triggerDataStream(73n, genuine);
      adapter._triggerSubgroupFin(73n, genuine);
      expect(lifecycleLines().map(l => l.group_id)).toEqual(['901']);
    } finally { await player.destroy(); }
  });
});

describe('KNOWN DEFECT — object routing trusts optimistic aliases', () => {
  // Reported separately (handoff 0145). The witness now refuses to classify
  // from an unconfirmed alias, but the ordinary object-routing path still
  // routes as soon as SubscriptionManager has any entry, including the
  // optimistic request-id registration. The same schedule can therefore feed
  // an audio object into the video pipeline, bypassing pendingObjectsByAlias.
  //
  // Marked `fails` deliberately: it asserts the CORRECT behaviour, so it will
  // start failing — and must then be un-marked — the moment the routing fix
  // lands. The production change is broader than this slice (warm-start FETCH
  // objects, alias remapping, owner-set settlement), so it is not folded in
  // here.
  it.fails('does not route an object from an unconfirmed alias', async () => {
    const adapter = createMockAdapter();
    logs = { error: [], warn: [], info: [], debug: [] };
    const player = new MoqtPlayer(createConfig(adapter));
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
      objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 0));

    try {
      const videoReqId = await adapter.subscribe.mock.results[1]?.value;
      const optimistic = BigInt(videoReqId.valueOf() as bigint);
      // An object on the optimistic alias, before any SUBSCRIBE_OK confirms it.
      adapter._triggerObject(75n, {
        kind: 'data', trackAlias: varint(optimistic), groupId: varint(900),
        subgroupId: varint(0), objectId: varint(0), payload: new Uint8Array([1, 2, 3]),
      } as MoqtObject);
      // Correct behaviour: park it. Actual behaviour: routed as video.
      const parked = (player as any).pendingObjectsByAlias.get(optimistic);
      expect(parked?.length ?? 0).toBeGreaterThan(0);
    } finally { await player.destroy(); }
  });
});

describe('subgroup lifecycle witness — cost when logging is off', () => {
  // logLevel defaults to 'none', which createLogger maps to NULL_LOGGER. The
  // record must not be serialized only to be discarded: that is a JSON per
  // video subgroup terminal, on every default build.
  it('still emits for a custom logger that sets no level', async () => {
    // An app-supplied logger does its own filtering, so level gating must not
    // suppress the witness. The demo player supplies one this way.
    const adapter = createMockAdapter();
    const seen: string[] = [];
    const player = new MoqtPlayer({
      url: 'https://relay.example.com/moq',
      namespace: 'live/broadcast',
      createTransport: vi.fn(async () => ({}) as any),
      createConnection: () => adapter as unknown as MoqtConnection,
      catalogBootstrap: 'subscribe',
      // A logger, but deliberately no logLevel.
      logger: {
        error: () => {}, warn: () => {}, debug: () => {},
        info: (m: string) => seen.push(m),
      },
    } as MoqtPlayerConfig);
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
      objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 0));
    const videoReqId = await adapter.subscribe.mock.results[1]?.value;
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
      parameters: new Map(), trackExtensions: [],
    } as unknown as ControlMessage);

    try {
      expect((player as any).infoLoggingEnabled).toBe(true);
      const header = subgroupHeader(VIDEO_ALIAS, 960n, true);
      adapter._triggerDataStream(83n, header);
      adapter._triggerSubgroupFin(83n, header);
      expect(seen.filter(m => m.startsWith('[subgroup_lifecycle:v1] '))).toHaveLength(1);
    } finally { await player.destroy(); }
  });

  it('serializes nothing when no sink can receive an info line', async () => {
    const adapter = createMockAdapter();
    const player = new MoqtPlayer({
      url: 'https://relay.example.com/moq',
      namespace: 'live/broadcast',
      createTransport: vi.fn(async () => ({}) as any),
      createConnection: () => adapter as unknown as MoqtConnection,
      catalogBootstrap: 'subscribe',
      // No `logger`, no `logLevel`: the shipping default.
    } as MoqtPlayerConfig);
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
      objectId: varint(0), payload: new TextEncoder().encode(CATALOG_JSON),
    } as MoqtObject);
    await new Promise((r) => setTimeout(r, 0));
    const videoReqId = await adapter.subscribe.mock.results[1]?.value;
    adapter._triggerMessage({
      type: 'SUBSCRIBE_OK', requestId: videoReqId, trackAlias: varint(VIDEO_ALIAS),
      parameters: new Map(), trackExtensions: [],
    } as unknown as ControlMessage);

    try {
      expect((player as any).infoLoggingEnabled).toBe(false);
      const header = subgroupHeader(VIDEO_ALIAS, 950n, true);
      adapter._triggerDataStream(81n, header);

      const stringify = vi.spyOn(JSON, 'stringify');
      try {
        adapter._triggerSubgroupFin(81n, header);
        const built = stringify.mock.calls.some(
          ([v]) => typeof v === 'object' && v !== null
            && 'contains_end_of_group' in (v as Record<string, unknown>),
        );
        expect(built).toBe(false);
      } finally {
        stringify.mockRestore();
      }
    } finally { await player.destroy(); }
  });
});
