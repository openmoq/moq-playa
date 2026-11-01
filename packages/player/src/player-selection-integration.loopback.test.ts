/**
 * Selection integration, against the real player path.
 *
 * Every case drives `MoqtPlayer` over a real `MoqtConnection` on a loopback
 * transport and judges it by what reaches the WIRE: the namespace FIELDS and
 * track name of each SUBSCRIBE, and the media delivered on the alias accepted
 * for that exact identity. Helpers are keyed by namespace fields + name, so a
 * catalog holding two same-name tracks is served as two distinct identities
 * rather than collapsing onto the first match.
 *
 * A track namespace is an ordered field set compared by exact bytes
 * (transport §2.4.1), a track MAY override the inherited catalog namespace
 * (msf-01 §5.2.2), and names are unique only per namespace (§5.2.3). A
 * cross-namespace track is therefore ordinary valid catalog content: the
 * requirement is to request it under ITS namespace, never to refuse it. The
 * relay stays the authority on whether that request is allowed.
 *
 * Separate-init cases use a cf01 catalog, because `initTrack` is cf01 §3.2.16
 * and neither MSF-00 (§5.1.20, inline `initData`) nor MSF-01 (§5.1.7/§5.2.13,
 * `initDataList` + `initRef`) defines it.
 *
 * The fixture's assembler and media source are stubs: these establish wire
 * selection and owned delivery, not decoder output or the use of init bytes.
 * The real-browser handover gates cover that.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MoqtConnection as PlayerConnection } from '@openmoq/webtransport';
import { catToken } from '@openmoq/webtransport';
import { MessageParam, parseAuthorizationToken18 } from '@openmoq/transport';
import type { Parameters as MessageParameters } from '@openmoq/transport';
import { MoqtConnection } from '../../webtransport/src/adapter.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { audioInit, buildChunk, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import type { QualityController } from './quality-controller.js';
import type { MediaSourceLike } from './interfaces.js';

const URL_OLD = 'https://old.example/moq';
const URL_NEW = 'https://new.example/moq';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A wire identity: ordered namespace fields plus a track name. */
interface Ref {
  readonly name: string;
  readonly namespace: readonly string[];
}
const keyOf = (ref: Ref) => JSON.stringify([ref.namespace, ref.name]);
const show = (ref: Ref) => `${JSON.stringify(ref.namespace)}/${ref.name}`;
const OURS = ['live', 'show'] as const;
const ref = (name: string, namespace: readonly string[] = OURS): Ref => ({ name, namespace });

/** One peer. Requests are recorded, matched and served BY FULL IDENTITY. */
function peer() {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18);
  const server = new MoqtConnection(18, { role: 'server' });
  const requests: Array<{ id: bigint; parameters?: MessageParameters } & Ref> = [];
  const errors: Error[] = [];
  const aliases = new Map<string, bigint>();
  let started: Promise<void> | null = null;
  server.onError = error => { errors.push(error); };
  server.onSubscribe = (id, namespace, trackName, parameters) => {
    requests.push({
      id, name: dec.decode(trackName), namespace: namespace.map(f => dec.decode(f)),
      ...(parameters ? { parameters } : {}),
    });
  };
  server.onFetch = () => {};
  const self = {
    client, server, requests, errors, transport: a,
    /** Media requests as full identities, catalog excluded. */
    media: (): Ref[] => requests.filter(r => r.name !== 'catalog')
      .map(({ name, namespace }) => ({ name, namespace })),
    names: () => requests.filter(r => r.name !== 'catalog').map(r => r.name),
    /** The credential the server actually received for this identity. */
    tokenFor(target: Ref) {
      const parameters = self.exactly(target).parameters;
      const encoded = parameters?.get(MessageParam.AUTHORIZATION_TOKEN)?.[0];
      return encoded === undefined ? null : parseAuthorizationToken18(encoded as Uint8Array);
    },
    /** The one request matching this exact identity. Ambiguity is a failure. */
    exactly(target: Ref) {
      const matched = requests.filter(r => keyOf(r) === keyOf(target));
      expect(matched, `exactly one request for ${show(target)}; saw `
        + `${requests.map(show).join(' | ') || 'nothing'}`).toHaveLength(1);
      return matched[0]!;
    },
    start() {
      if (client.session.state === 'closed') return a;
      started ??= server.connect(b, {});
      void started.catch(error => { errors.push(error); });
      return a;
    },
    async accept(target: Ref, alias: bigint) {
      await flush(256);
      const request = self.exactly(target);
      await server.acceptSubscribe(request.id, alias);
      aliases.set(keyOf(target), alias);
      await flush(128);
    },
    async send(target: Ref, payload: Uint8Array, group = 1n) {
      const alias = aliases.get(keyOf(target));
      expect(alias, `${show(target)} has an accepted alias`).toBeDefined();
      const stream = await server.openSubgroup(alias!, group, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, payload);
      await server.closeSubgroup(stream);
      await flush(128);
    },
    async goaway() {
      const next = requests.reduce((max, r) => r.id > max ? r.id : max, 0n) + 2n;
      await server.sendGoaway({ newSessionUri: URL_NEW, requestId: next, timeout: 0n });
      await flush(128);
    },
    async destroy() {
      await client.close();
      await server.close();
      await started?.catch(() => {});
    },
  };
  return self;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
type TrackSpec = Record<string, unknown>;

/** MSF-00/MSF-01 track with its own inline init (§5.1.20). */
const videoTrack = (name: string, extra: TrackSpec = {}): TrackSpec => ({
  name, role: 'video', packaging: 'cmaf', isLive: true,
  codec: 'avc1.640028', width: 640, height: 360, bitrate: 800_000,
  initData: b64(videoInit()), ...extra,
});
const audioTrack = (name: string, extra: TrackSpec = {}): TrackSpec => ({
  name, role: 'audio', packaging: 'cmaf', isLive: true,
  codec: 'mp4a.40.2', samplerate: 48000, channelConfig: '2', bitrate: 128_000,
  initData: b64(audioInit()), ...extra,
});

/** MSF-00 (§5.1.1 numeric version, inline initData only). */
const msf00 = (tracks: readonly TrackSpec[]) =>
  enc.encode(JSON.stringify({ version: 1, tracks }));

/** MSF-01 (§5.1.1 string version) with root initDataList + per-track initRef
 *  (§5.1.7 / §5.2.13) — this format's own separate-init form. */
const msf01 = (tracks: readonly TrackSpec[], init = videoInit()) => enc.encode(JSON.stringify({
  version: '1',
  initDataList: [{ id: 'root-init', type: 'inline', data: b64(init) }],
  tracks: tracks.map(t => ({ ...t, initRef: 'root-init' })),
}));
const msf01Video = (name: string, extra: TrackSpec = {}): TrackSpec => {
  const { initData: _inline, ...rest } = videoTrack(name, extra) as Record<string, unknown>;
  return rest;
};

/** cf01 (§3.2) — the format that defines `initTrack` (§3.2.16). */
const cf01 = (tracks: readonly TrackSpec[]) => enc.encode(JSON.stringify({
  version: 1, streamingFormat: 1, streamingFormatVersion: '0.2',
  tracks: tracks.map(t => ({ packaging: 'cmaf', ...t })),
}));
const cf01Video = (name: string, initTrack: string, extra: TrackSpec = {}): TrackSpec => ({
  name, initTrack,
  selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4', width: 640, height: 360 },
  ...extra,
});

const chunk = (media: 'video' | 'audio', group: bigint) => buildChunk({
  trackId: media === 'video' ? 1 : 2, bmdt: group * 9000n,
  samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(0, 0, 0, 0),
});

async function fixture(options: {
  readonly catalog: Uint8Array;
  readonly skipInitialCatalog?: boolean;
  readonly config?: Partial<MoqtPlayerConfig>;
  readonly namespace?: string | readonly string[];
  readonly beforeLoad?: (player: MoqtPlayer) => void;
}) {
  const old = peer();
  const next = peer();
  const received: Array<{ name: string; group: bigint }> = [];
  const errors: string[] = [];
  const migrated = vi.fn();
  const ns = options.namespace ?? 'live/show';
  const nsFields = typeof ns === 'string' ? ns.split('/') : [...ns];
  const catalogRef = ref('catalog', nsFields);
  let connections = 0;
  const player = new MoqtPlayer({
    url: URL_OLD, namespace: ns, draftVersion: 18,
    createConnection: () => [old, next][connections++]!.client as unknown as PlayerConnection,
    createTransport: url => Promise.resolve(url === URL_OLD ? old.start() : next.start()),
    catalogBootstrap: 'subscribe',
    createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
      endOfStream: () => {}, destroy: () => {}, mediaElement: null,
      onFirstFrame: null, onError: null, onStall: null }),
    createCmafAssembler: callbacks => ({
      push: (mediaType, track, group, payload) => callbacks.onSegment(mediaType, payload, track, group),
      getEpoch: () => null, reset: () => {}, destroy: () => {},
    }),
    ...options.config,
  } as MoqtPlayerConfig);
  player.on('media_object', event => { received.push({ name: event.trackName, group: event.groupId }); });
  player.on('error', event => { errors.push(event.error.message); });
  player.on('session_migrated', migrated);
  options.beforeLoad?.(player);
  const destroy = async () => {
    await player.destroy();
    await flush(256);
    await old.destroy();
    await next.destroy();
  };
  try {
    await player.load();
    await old.accept(catalogRef, 100n);
    if (!options.skipInitialCatalog) await old.send(catalogRef, options.catalog);
    await flush(256);
  } catch (error) {
    await destroy();
    throw error;
  }
  return {
    old, next, player, received, errors, migrated, destroy,
    /** Hand over, delivering `catalog` on the replacement. */
    async migrate(catalog: Uint8Array) {
      await old.goaway();
      await flush(256);
      await next.accept(catalogRef, 300n);
      await next.send(catalogRef, catalog);
      await flush(256);
    },
  };
}

describe('adoption callback ownership', () => {
  it('does not report usable migration when the media adapter refuses initialization', async () => {
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({ catalog: cat, skipInitialCatalog: true, config: {
      disableAudio: true, createMediaSource: () => ({ initialize: () => false,
        appendChunk: () => {}, reset: () => {}, endOfStream: () => {}, destroy: () => {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null }),
    } });
    try {
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors.join(' ')).toMatch(/initialization.*reject/i);
      expect(migrationState(h.player).currentMigration).toBe(null);
    } finally { await h.destroy(); }
  });

  it('honors a configured identity when handover delivers the first catalog', async () => {
    const cat = cf01([
      cf01Video('a', 'init-a', { namespace: 'other/space', renderGroup: 1, altGroup: 1 }),
      cf01Video('b', 'init-b', { renderGroup: 1, altGroup: 1 }),
    ]);
    const h = await fixture({ catalog: cat, skipInitialCatalog: true, config: {
      disableAudio: true, selection: { videoTrack: { name: 'a', namespace: 'other/space' } },
    } });
    try {
      await h.migrate(cat);
      expect(h.next.media()).toEqual([ref('a', ['other', 'space']), ref('init-a', ['other', 'space'])]);
      await h.next.accept(ref('a', ['other', 'space']), 400n);
      await h.next.accept(ref('init-a', ['other', 'space']), 401n);
      await h.next.send(ref('init-a', ['other', 'space']), videoInit());
      await vi.waitFor(() => expect(h.migrated).toHaveBeenCalledTimes(1));
    } finally { await h.destroy(); }
  });

  it('does not create pipelines after a first-catalog listener destroys the player', async () => {
    const createMediaSource = vi.fn(() => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
      endOfStream: () => {}, destroy: () => {}, mediaElement: null,
      onFirstFrame: null, onError: null, onStall: null }));
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({ catalog: cat, skipInitialCatalog: true,
      config: { disableAudio: true, createMediaSource },
      beforeLoad: player => player.on('catalog_received', () => { void player.destroy(); }),
    });
    try {
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      expect(createMediaSource).not.toHaveBeenCalled();
      expect(h.migrated).not.toHaveBeenCalled();
    } finally { await h.destroy(); }
  });

  it('does not create an assembler after initialization destroys the player', async () => {
    let player!: MoqtPlayer;
    const createAssembler = vi.fn<NonNullable<MoqtPlayerConfig['createCmafAssembler']>>(() => ({
      push: () => {}, getEpoch: () => null, reset: () => {}, destroy: () => {},
    }));
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({ catalog: cat, skipInitialCatalog: true,
      config: { disableAudio: true, createCmafAssembler: createAssembler,
        createMediaSource: () => ({ initialize: () => { void player.destroy(); return true; },
          appendChunk: () => {}, reset: () => {}, endOfStream: () => {}, destroy: () => {},
          mediaElement: null, onFirstFrame: null, onError: null, onStall: null }),
      }, beforeLoad: value => { player = value; },
    });
    try {
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      expect(createAssembler).not.toHaveBeenCalled();
      expect(h.migrated).not.toHaveBeenCalled();
    } finally { await h.destroy(); }
  });
});

describe('namespace identity reaches the wire', () => {
  it('emits the configured TUPLE as the subscription namespace', async () => {
    const h = await fixture({ namespace: ['live/show'], catalog: msf00([videoTrack('video')]) });
    try {
      expect(h.old.requests[0]!.namespace).toEqual(['live/show']);
    } finally { await h.destroy(); }
  });

  it('emits an ordinary string namespace as its two fields', async () => {
    const h = await fixture({ catalog: msf00([videoTrack('video')]) });
    try {
      expect(h.old.requests[0]!.namespace).toEqual(['live', 'show']);
    } finally { await h.destroy(); }
  });

  /**
   * A one-field context and text that prints the same are DIFFERENT wire
   * namespaces (§2.4.1). Both rows use the same catalog; only the pinned
   * target differs, so neither can pass by the wire carrying the configured
   * namespace regardless.
   */
  const tupleCase = (target: 'inheriting' | 'declaring') => async () => {
    const wanted = target === 'inheriting'
      ? ref('video', ['live/show']) : ref('video', ['live', 'show']);
    const h = await fixture({
      namespace: ['live/show'],
      catalog: msf00([videoTrack('video'), videoTrack('video', { namespace: 'live/show' })]),
      config: {
        disableAudio: true,
        // The ARRAY form is the wire tuple, used verbatim — the only way to
        // name the inheriting track, whose text is identical to the other's.
        selection: {
          videoTrack: {
            name: 'video',
            namespace: target === 'inheriting' ? ['live/show'] : ['live', 'show'],
          },
        },
      },
    });
    try {
      expect(h.errors).toEqual([]);
      expect(h.old.media()).toEqual([wanted]);
      await h.old.accept(wanted, 200n);
      await h.old.send(wanted, chunk('video', 1n));
      expect(h.received).toContainEqual({ name: 'video', group: 1n });
    } finally { await h.destroy(); }
  };

  // The wire now carries each track's own fields, so what remains is WHICH
  // of the two is addressed — the pin. Without it document order decides, so
  // the declaring row passes by coincidence and the inheriting row cannot.
  it('keeps the inheriting track of a one-field context addressable', tupleCase('inheriting'));
  it('addresses the DECLARING track by its own two fields', tupleCase('declaring'));

  it('requests a DECLARED cross-namespace track under its own namespace', async () => {
    // msf-01 §5.2.2 lets a track override the inherited namespace, so this is
    // valid content and is requested in ['other','space']. Whether that
    // request is allowed is the relay's judgment, not the player's.
    const h = await fixture({
      catalog: msf00([videoTrack('video', { namespace: 'other/space' })]),
      config: { disableAudio: true },
    });
    try {
      expect(h.old.media()).toEqual([ref('video', ['other', 'space'])]);
    } finally { await h.destroy(); }
  });

  it('shows beforeSubscribe the TARGET namespace, not just a name', async () => {
    // A hook that may CANCEL a subscription sees the identity actually being
    // requested: `SubscribeIntent` carries the wire tuple, so a
    // cross-namespace `video` is distinguishable from one of ours.
    const seen: unknown[] = [];
    const old = peer();
    const player = new MoqtPlayer({
      url: URL_OLD, namespace: 'live/show', draftVersion: 18,
      createConnection: () => old.client as unknown as PlayerConnection,
      createTransport: () => Promise.resolve(old.start()),
      catalogBootstrap: 'subscribe', disableAudio: true,
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
      createCmafAssembler: callbacks => ({
        push: (mediaType, track, group, payload) => callbacks.onSegment(mediaType, payload, track, group),
        getEpoch: () => null, reset: () => {}, destroy: () => {},
      }),
    } as MoqtPlayerConfig);
    player.hooks.beforeSubscribe.add(intent => { seen.push(intent); return intent; });
    try {
      await player.load();
      await old.accept(ref('catalog'), 100n);
      await old.send(ref('catalog'), msf00([videoTrack('video', { namespace: 'other/space' })]));
      await flush(256);
      expect(seen).toEqual([expect.objectContaining({
        trackName: 'video', namespace: ['other', 'space'],
      })]);
    } finally {
      await player.destroy();
      await flush(256);
      await old.destroy();
    }
  });

  it('gives the authorization provider the TARGET namespace', async () => {
    // Credentials are acquired for the identity actually requested, and
    // `AuthorizationContext.namespace` preserves its field boundaries. The
    // provider returns a VALID
    // fixture credential, so the case reaches selection and the media
    // SUBSCRIBE instead of failing on an empty provider — empty-provider
    // refusal is its own contract, covered in the authorization suite.
    const cat = Uint8Array.of(0x84, 0x40, 0xa0, 0x40, 0x40);
    const asked: Array<{ operation: string; track: string; namespace: string[] }> = [];
    const h = await fixture({
      catalog: msf00([videoTrack('video', { namespace: 'other/space' })]),
      config: {
        disableAudio: true,
        authorization: {
          getTokens: (context: {
            operation: string; namespace?: readonly Uint8Array[]; trackName?: Uint8Array;
          }) => {
            if (context.trackName) {
              asked.push({
                operation: context.operation,
                track: dec.decode(context.trackName),
                namespace: (context.namespace ?? []).map(f => dec.decode(f)),
              });
            }
            return [catToken(cat)];
          },
        },
      },
    });
    try {
      // Precondition, true today: selection ran and ONE credentialed media
      // SUBSCRIBE reached the server. Asserted before the identity claims so
      // the red below cannot be mistaken for the case failing early.
      const media = h.old.media();
      expect(media).toHaveLength(1);
      expect(h.old.tokenFor(media[0]!)).toMatchObject({ tokenType: 1n, tokenValue: cat });
      // The defect this case owns: the provider is asked for the configured
      // namespace instead of the one the track declares.
      expect(asked.filter(a => a.track === 'video'))
        .toEqual([{ operation: 'SUBSCRIBE', track: 'video', namespace: ['other', 'space'] }]);
      expect(media).toEqual([ref('video', ['other', 'space'])]);
    } finally { await h.destroy(); }
  });
});

describe('same-name tracks in different namespaces', () => {
  it('shows the actual namespace of a separate init request to beforeSubscribe', async () => {
    const seen: Array<{ name: string; namespace: readonly string[] }> = [];
    const h = await fixture({
      catalog: cf01([cf01Video('video', 'init', { namespace: 'other/space' })]),
      config: { disableAudio: true },
      beforeLoad: player => player.hooks.beforeSubscribe.add(intent => {
        seen.push({ name: intent.trackName, namespace: intent.namespace });
        return intent;
      }),
    });
    try {
      expect(seen).toEqual([
        { name: 'video', namespace: ['other', 'space'] },
        { name: 'init', namespace: ['other', 'space'] },
      ]);
    } finally { await h.destroy(); }
  });

  it('does not send an init request cancelled by beforeSubscribe', async () => {
    const h = await fixture({
      catalog: cf01([cf01Video('video', 'init', { namespace: 'other/space' })]),
      config: { disableAudio: true },
      beforeLoad: player => player.hooks.beforeSubscribe.add(intent => intent.trackName === 'init' ? null : intent),
    });
    try { expect(h.old.media()).toEqual([ref('video', ['other', 'space'])]); }
    finally { await h.destroy(); }
  });

  const ours = (extra: TrackSpec = {}) => videoTrack('video', { namespace: 'live/show', ...extra });
  const theirs = (extra: TrackSpec = {}) => videoTrack('video', { namespace: 'other/space', ...extra });

  it('serves whichever identity default order selects, with correct fields', async () => {
    // CONTROL: with NO selector, default order is free to choose either
    // track — this player has no implicit preference for the configured
    // namespace. What is not free is the identity on the wire.
    const h = await fixture({ catalog: msf00([ours(), theirs()]), config: { disableAudio: true } });
    try {
      const media = h.old.media();
      expect(media).toHaveLength(1);
      expect([keyOf(ref('video')), keyOf(ref('video', ['other', 'space']))])
        .toContain(keyOf(media[0]!));
    } finally { await h.destroy(); }
  });

  /**
   * The SAME full-identity pin under both declaration orders, for BOTH
   * targets, on a cf01 catalog where each track names its own `initTrack`
   * (§3.2.16).
   *
   * The init request NAME is what distinguishes the two same-name tracks:
   * the namespace a media SUBSCRIBE carries is the configured one today, so
   * an implementation that merely corrected that namespace on whichever
   * track a bare-name map had already selected would still fetch the wrong
   * init. Asserting both, in all four rows, leaves only honoring the pin.
   *
   * LIBRARY POLICY, not a normative rule: an `initTrack` is resolved in the
   * namespace of the track that REFERENCES it. cf01 §3.2.18 states that
   * resolution for `depends`; §3.2.16 does not say, and a reference that
   * silently crossed namespaces would defeat the identity it belongs to.
   */
  const pinCase = (first: 'ours' | 'theirs', target: 'ours' | 'theirs') => async () => {
    const mine = cf01Video('video', 'init-live', { namespace: 'live/show' });
    const other = cf01Video('video', 'init-other', { namespace: 'other/space' });
    const wantedNs = target === 'ours' ? [...OURS] : ['other', 'space'];
    const media = ref('video', wantedNs);
    const init = ref(target === 'ours' ? 'init-live' : 'init-other', wantedNs);
    const h = await fixture({
      catalog: cf01(first === 'ours' ? [mine, other] : [other, mine]),
      config: {
        disableAudio: true,
        selection: {
          videoTrack: { name: 'video', namespace: target === 'ours' ? 'live/show' : 'other/space' },
        },
      },
    });
    try {
      expect(h.old.media()).toEqual([media, init]);
      // And the pinned identity is the one actually served and used.
      await h.old.accept(init, 201n);
      await h.old.send(init, videoInit());
      await h.old.accept(media, 200n);
      await h.old.send(media, chunk('video', 1n));
      expect(h.received).toContainEqual({ name: 'video', group: 1n });
    } finally { await h.destroy(); }
  };

  it('pins ours when ours is declared first', pinCase('ours', 'ours'));
  it('pins theirs when ours is declared first', pinCase('ours', 'theirs'));
  it('pins ours when theirs is declared first', pinCase('theirs', 'ours'));
  it('pins theirs when theirs is declared first', pinCase('theirs', 'theirs'));

});

describe('MSF-01 init-by-reference keeps the declaring namespace', () => {
  it('requests an MSF-01 cross-namespace track under its own namespace', async () => {
    // MSF-01's separate-init form is a ROOT `initDataList` entry named by
    // a per-track `initRef` (§5.1.7, §5.2.13) — no second subscription — so
    // this case is about the media identity alone. The track declares
    // `other/space` (§5.2.2) and must be requested there, with its root init
    // still resolving and the media reaching output.
    const target = ref('video', ['other', 'space']);
    const h = await fixture({
      catalog: msf01([msf01Video('video', { namespace: 'other/space' })]),
      config: { disableAudio: true },
    });
    try {
      expect(h.errors).toEqual([]);
      expect(h.old.media()).toEqual([target]);
      await h.old.accept(target, 200n);
      await h.old.send(target, chunk('video', 1n));
      expect(h.received).toContainEqual({ name: 'video', group: 1n });
    } finally { await h.destroy(); }
  });

  it('resolves a root initRef for a track that inherits the catalog namespace', async () => {
    // CONTROL: the same format with no namespace override. MSF-01 init by
    // reference must keep working unchanged through the cutover.
    const target = ref('video');
    const h = await fixture({
      catalog: msf01([msf01Video('video')]),
      config: { disableAudio: true },
    });
    try {
      expect(h.old.media()).toEqual([target]);
      await h.old.accept(target, 200n);
      await h.old.send(target, chunk('video', 1n));
      expect(h.received).toContainEqual({ name: 'video', group: 1n });
    } finally { await h.destroy(); }
  });
});

describe('issue #24 — scopes, singletons and who chooses what', () => {
  it('reports declared but unsupported audio instead of treating it as absent', async () => {
    const h = await fixture({ catalog: msf00([
      videoTrack('video', { renderGroup: 1 }),
      audioTrack('audio', { renderGroup: 1, packaging: 'locmaf', locmafVersion: '9.9' }),
    ]) });
    try {
      expect(h.old.media()).toEqual([ref('video')]);
      expect(h.errors.join(' ')).toMatch(/audio.*(?:excluded|unsupported|packaging)/i);
    } finally { await h.destroy(); }
  });

  it('offers a video track that declares no altGroup', async () => {
    // `selectVideoAltGroup` returns `groups[0].tracks`, so an ungrouped
    // video beside a grouped one is unreachable.
    const h = await fixture({
      catalog: msf00([
        videoTrack('ladder-720', { altGroup: 1, renderGroup: 1 }),
        videoTrack('singleton', { renderGroup: 1 }),
        audioTrack('audio', { renderGroup: 1 }),
      ]),
      config: { selection: { videoTrack: { name: 'singleton' } } },
    });
    try {
      expect(h.old.names().sort()).toEqual(['audio', 'singleton']);
    } finally { await h.destroy(); }
  });

  it('selects the audio DECLARED WITH the chosen render group', async () => {
    // audio selection is `audioTracks[0]` across the whole catalog, so
    // the second camera plays the first camera's audio.
    const h = await fixture({
      catalog: msf00([
        videoTrack('cam-main', { renderGroup: 1 }), audioTrack('audio-main', { renderGroup: 1 }),
        videoTrack('cam-side', { renderGroup: 2 }), audioTrack('audio-side', { renderGroup: 2 }),
      ]),
      config: { selection: { renderGroup: 2 } },
    });
    try {
      expect(h.old.names().sort()).toEqual(['audio-side', 'cam-side']);
    } finally { await h.destroy(); }
  });

  it('plays a genuinely video-only render group without borrowing audio', async () => {
    // a scope declaring no audio reaches into another render group.
    // msf-01 §5.6.15 declares audio in render group 1 only; video-only is a
    // legitimate outcome.
    const h = await fixture({
      catalog: msf00([
        videoTrack('cam-main', { renderGroup: 1 }), audioTrack('audio-main', { renderGroup: 1 }),
        videoTrack('cam-side', { renderGroup: 2 }),
      ]),
      config: { selection: { renderGroup: 2 } },
    });
    try {
      expect(h.errors).toEqual([]);
      expect(h.old.names()).toEqual(['cam-side']);
    } finally { await h.destroy(); }
  });

  it('keeps a cap inside the chosen scope when one member satisfies it', async () => {
    // COINCIDENCE CONTROL — passes today only because `selection` is ignored
    // and the default alternate set happens to be scope 2's. It becomes
    // discriminating once `selection` exists. It states the policy either
    // way: `capLevelToResolution` is a MAXIMUM (config.ts) applied inside the
    // chosen scope, so scope 2's 360p member plays even though scope 1 offers
    // a cheaper rendition the cap would also allow. A cap is not a reason to
    // change camera.
    const h = await fixture({
      catalog: msf00([
        videoTrack('cam-main-180', { renderGroup: 1, width: 320, height: 180, bitrate: 200_000 }),
        videoTrack('cam-side-1080', { renderGroup: 2, altGroup: 2, width: 1920, height: 1080, bitrate: 4_000_000 }),
        videoTrack('cam-side-360', { renderGroup: 2, altGroup: 2, width: 640, height: 360, bitrate: 500_000 }),
      ]),
      config: {
        selection: { renderGroup: 2 },
        capLevelToResolution: { width: 640, height: 360 },
        disableAudio: true,
      },
    });
    try {
      expect(h.old.names()).toEqual(['cam-side-360']);
    } finally { await h.destroy(); }
  });

  it('reports an unsatisfiable cap instead of moving to a cheaper scope', async () => {
    // with no member of the chosen scope under the cap, the accepted
    // composition policy is `unsatisfied` — no video request, no
    // substitution, and a DIAGNOSTIC. Requiring the diagnostic is what stops
    // this passing merely because the pipeline did nothing.
    const h = await fixture({
      catalog: msf00([
        videoTrack('cam-main-180', { renderGroup: 1, width: 320, height: 180, bitrate: 200_000 }),
        videoTrack('cam-side-1080', { renderGroup: 2, width: 1920, height: 1080, bitrate: 4_000_000 }),
      ]),
      config: {
        selection: { renderGroup: 2 },
        capLevelToResolution: { width: 320, height: 180 },
        disableAudio: true,
      },
    });
    try {
      expect(h.old.names()).toEqual([]);
      expect(h.errors.join(' ')).toMatch(/320x180|cap/i);
    } finally { await h.destroy(); }
  });

  it('lets catalog order choose the set and quality choose the member', async () => {
    // The first DECLARED set in
    // catalog order is the default, and `startLevel: 'lowest'` chooses WITHIN
    // it. `b-144` is the lowest bitrate in the document and is not selected.
    const h = await fixture({
      catalog: msf00([
        videoTrack('a-1080', { altGroup: 1, width: 1920, height: 1080, bitrate: 4_000_000 }),
        videoTrack('a-360', { altGroup: 1, width: 640, height: 360, bitrate: 500_000 }),
        videoTrack('b-144', { altGroup: 2, width: 256, height: 144, bitrate: 80_000 }),
      ]),
      config: { startLevel: 'lowest', disableAudio: true },
    });
    try {
      expect(h.old.names()).toEqual(['a-360']);
    } finally { await h.destroy(); }
  });
});

describe('handover carries identity and intent, not position', () => {
  it.each([true, false])('keeps a quality-mode request made during preparation (auto=%s)', async autoQuality => {
    const cat = msf00([videoTrack('video', { altGroup: 1, bitrate: 800_000 }),
      videoTrack('video-low', { altGroup: 1, bitrate: 400_000 })]);
    const h = await fixture({ catalog: cat, config: {
      disableAudio: true, startLevel: 0, autoQuality: !autoQuality,
    } });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      await h.migrate(cat);
      h.player.setAutoQuality(autoQuality);
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(autoQuality);
      await h.next.accept(ref('video'), 400n);
      await vi.waitFor(() => expect(h.migrated).toHaveBeenCalledTimes(1));
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(autoQuality);
    } finally { await h.destroy(); }
  });

  it('keeps automatic quality enabled after an initial pin has been unlocked', async () => {
    const tracks = [videoTrack('a', { altGroup: 1 }), videoTrack('b', { altGroup: 1 })];
    const h = await fixture({ catalog: msf00(tracks), config: {
      disableAudio: true, selection: { videoTrack: { name: 'a' } },
    } });
    try {
      await h.old.accept(ref('a'), 200n);
      await h.old.send(ref('a'), chunk('video', 1n));
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(false);
      h.player.setAutoQuality(true);
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(true);
      await h.migrate(msf00(tracks));
      expect(h.next.media()).toEqual([ref('a')]);
      await h.next.accept(ref('a'), 400n);
      await vi.waitFor(() => expect(h.migrated).toHaveBeenCalledTimes(1));
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(true);
    } finally { await h.destroy(); }
  });

  const main = videoTrack('cam-main', { renderGroup: 1, bitrate: 500_000 });
  const side = videoTrack('cam-side', { renderGroup: 2, bitrate: 4_000_000 });

  it('honors a cross-scope pin at startup over the quality default', async () => {
    // the pin names the camera the quality default would not choose.
    const h = await fixture({
      catalog: msf00([main, side]),
      config: {
        selection: { renderGroup: 2, videoTrack: { name: 'cam-side' } },
        disableAudio: true,
      },
    });
    try {
      expect(h.old.names()).toEqual(['cam-side']);
    } finally { await h.destroy(); }
  });

  it('honors a WITHIN-SET pin opposed by startLevel, in manual mode', async () => {
    // a pin inside ONE alternate set is a decision about which member
    // plays, so it must beat `startLevel: 'lowest'` AND put quality control
    // in manual mode — not be mistaken for a member ABR happened to settle
    // on. This is the priority-within-a-set case the cross-scope pin cannot
    // establish.
    const h = await fixture({
      catalog: msf00([
        videoTrack('ladder-1080', { renderGroup: 1, altGroup: 1, width: 1920, height: 1080, bitrate: 4_000_000 }),
        videoTrack('ladder-360', { renderGroup: 1, altGroup: 1, width: 640, height: 360, bitrate: 500_000 }),
      ]),
      config: {
        startLevel: 'lowest',
        selection: { videoTrack: { name: 'ladder-1080' } },
        disableAudio: true,
      },
    });
    try {
      expect(h.old.names()).toEqual(['ladder-1080']);
      // A pin decides WHICH track plays, so automatic quality must not move
      // off it on the next evaluation. There is no public accessor for the
      // mode, so the controller's own flag is read.
      expect((h.player as unknown as { qualityController: { isAutoQuality: boolean } })
        .qualityController.isAutoQuality).toBe(false);
    } finally { await h.destroy(); }
  });

  it('re-subscribes the PINNED identity after the replacement reorders', async () => {
    // expressed now rather than postponed. The first assertion is the
    // startup pin, which is where it currently stops — handover intent still
    // records `activeVideoTrack` as a bare NAME, so the downstream claim is
    // untested until the pin exists. At green the whole chain must hold:
    // pinned at startup, pinned again on a reordered replacement, delivered
    // on the replacement's own alias.
    const pinned = ref('cam-side');
    const h = await fixture({
      catalog: msf00([main, side]),
      config: {
        selection: { renderGroup: 2, videoTrack: { name: 'cam-side', namespace: 'live/show' } },
        disableAudio: true,
      },
    });
    try {
      expect(h.old.media()).toEqual([pinned]);
      await h.old.accept(pinned, 200n);
      await h.old.send(pinned, chunk('video', 1n));
      await h.migrate(msf00([side, main]));
      expect(h.next.media()).toEqual([pinned]);
      await h.next.accept(pinned, 400n);
      await h.next.send(pinned, chunk('video', 7n), 7n);
      expect(h.migrated).toHaveBeenCalled();
      expect(h.received).toContainEqual({ name: 'cam-side', group: 7n });
    } finally { await h.destroy(); }
  });

  it('keeps the ESTABLISHED identity after the replacement reorders its catalog', async () => {
    // CONTROL — correct today for an unpinned selection, and it must survive.
    // It is NOT evidence that a pin is carried: handover intent still records
    // `activeVideoTrack` as a bare NAME, and the pinned variant of this case
    // can only be written once `config.selection` exists.
    const h = await fixture({
      catalog: msf00([main, side]),
      config: {
        selection: { renderGroup: 2, videoTrack: { name: 'cam-side' } },
        disableAudio: true,
      },
    });
    try {
      // The pin cannot take effect yet, so the ESTABLISHED identity is read
      // from the wire. The claim under test is that the replacement keeps it.
      const established = h.old.media()[0]!;
      await h.old.accept(established, 200n);
      await h.old.send(established, chunk('video', 1n));
      await h.migrate(msf00([side, main]));
      expect(h.next.media()).toEqual([established]);
    } finally { await h.destroy(); }
  });

  it('keeps the established identity when the replacement declares the same name elsewhere', async () => {
    // CONTROL — correct today, in BOTH declaration orders (checked): the
    // replacement offers `cam-side` in two namespaces and the one that is
    // ours is adopted. It must keep passing, and it is not evidence that a
    // PIN is carried — that is the reordering case above.
    const h = await fixture({
      catalog: msf00([side]),
      config: {
        selection: { renderGroup: 2, videoTrack: { name: 'cam-side', namespace: 'live/show' } },
        disableAudio: true,
      },
    });
    try {
      const established = h.old.media()[0]!;
      await h.old.accept(established, 200n);
      await h.old.send(established, chunk('video', 1n));
      await h.migrate(msf00([
        videoTrack('cam-side', { renderGroup: 2, namespace: 'other/space' }),
        videoTrack('cam-side', { renderGroup: 2, namespace: 'live/show' }),
      ]));
      expect(h.next.media()).toEqual([established]);
    } finally { await h.destroy(); }
  });

  it('declines a candidate that no longer offers the pinned track', async () => {
    // losing an explicit pin is a changed presentation, not a quality
    // step. Today the migration proceeds with no diagnostic at all.
    const h = await fixture({
      catalog: msf00([main, side]),
      config: {
        selection: { renderGroup: 2, videoTrack: { name: 'cam-side' } },
        disableAudio: true,
      },
    });
    try {
      const established = h.old.media()[0]!;
      await h.old.accept(established, 200n);
      await h.old.send(established, chunk('video', 1n));
      // The replacement drops exactly the track that was playing.
      await h.migrate(msf00([established.name === 'cam-side' ? main : side]));
      expect(h.errors.join(' ')).toMatch(new RegExp(established.name));
      expect(h.next.media()).toEqual([]);
      await h.old.send(established, chunk('video', 2n), 2n);
      expect(h.received).toContainEqual({ name: established.name, group: 2n });
    } finally { await h.destroy(); }
  });

  it('treats a reused altGroup number as no evidence for a PINNED view', async () => {
    // the replacement reuses altGroup 2 for a different camera. A group
    // ID that coincides across catalogs is not continuity — this case is the
    // explicit pin being lost, and says nothing about automatic members.
    const h = await fixture({
      catalog: msf00([videoTrack('cam-side', { renderGroup: 2, altGroup: 2 })]),
      config: {
        selection: { renderGroup: 2, videoTrack: { name: 'cam-side' } },
        disableAudio: true,
      },
    });
    try {
      const established = h.old.media()[0]!;
      await h.old.accept(established, 200n);
      await h.old.send(established, chunk('video', 1n));
      await h.migrate(msf00([videoTrack('cam-rear', { renderGroup: 2, altGroup: 2 })]));
      expect(h.next.names()).not.toContain('cam-rear');
    } finally { await h.destroy(); }
  });

  it('reselects inside the established set when the old rendition disappears', async () => {
    // CONTROL: with no pin, losing the exact rendition that was playing is a
    // quality event, not a changed presentation — another member of the SAME
    // alternate set may take over. Set continuity is established by removing
    // the old member while a sibling survives, then proving adoption: the
    // replacement's own alias delivers and `session_migrated` fires.
    const ladder = [
      videoTrack('ladder-1080', { renderGroup: 1, altGroup: 1, width: 1920, height: 1080, bitrate: 4_000_000 }),
      videoTrack('ladder-360', { renderGroup: 1, altGroup: 1, width: 640, height: 360, bitrate: 500_000 }),
      videoTrack('other-720', { renderGroup: 1, altGroup: 2, width: 1280, height: 720, bitrate: 2_000_000 }),
    ];
    const h = await fixture({ catalog: msf00(ladder), config: { disableAudio: true } });
    try {
      const started = h.old.media();
      expect(started).toHaveLength(1);
      expect(started[0]!.name).toMatch(/^ladder-/);
      await h.old.accept(started[0]!, 200n);
      await h.old.send(started[0]!, chunk('video', 1n));
      expect(h.received).toContainEqual({ name: started[0]!.name, group: 1n });
      // The replacement drops exactly the rendition that was playing.
      const survivor = ladder.find(t => t['name'] !== started[0]!.name && String(t['name']).startsWith('ladder-'))!;
      await h.migrate(msf00([survivor, ladder[2]!]));
      const adopted = h.next.media();
      expect(adopted).toHaveLength(1);
      expect(adopted[0]!.name).toBe(survivor['name']);
      await h.next.accept(adopted[0]!, 400n);
      await h.next.send(adopted[0]!, chunk('video', 7n), 7n);
      expect(h.migrated).toHaveBeenCalled();
      expect(h.received).toContainEqual({ name: adopted[0]!.name, group: 7n });
    } finally { await h.destroy(); }
  });
});

describe('required outputs come from the operation that happened', () => {
  it('adopts a video-only replacement when audio was never selected', async () => {
    // audio is ENABLED and the catalog simply declares none, so
    // requiredness comes from what was actually SELECTED rather than from the
    // enabled defaults: audio is enabled and the catalog simply declares
    // none, so there is no audio output to lose.
    // Adoption is proven by `session_migrated` AND by media delivered on the
    // REPLACEMENT's accepted alias — a SUBSCRIBE alone establishes nothing.
    const h = await fixture({ catalog: msf00([videoTrack('video')]) });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      expect(h.received).toContainEqual({ name: 'video', group: 1n });
      await h.migrate(msf00([videoTrack('video')]));
      // Asserted BEFORE accepting, so the failure is about the wire rather
      // than about a helper not finding a request to answer.
      expect(h.next.media()).toEqual([ref('video')]);
      await h.next.accept(ref('video'), 400n);
      await h.next.send(ref('video'), chunk('video', 7n), 7n);
      expect(h.migrated).toHaveBeenCalled();
      expect(h.received).toContainEqual({ name: 'video', group: 7n });
    } finally { await h.destroy(); }
  });

  it('does not call a move that drops ESTABLISHED audio a success', async () => {
    // CONTROL — correct today. Audio is not merely subscribed: an object is
    // delivered first, so the lost output is an established one. The move is
    // reported, and the old session keeps delivering.
    const h = await fixture({ catalog: msf00([videoTrack('video'), audioTrack('audio')]) });
    try {
      for (const [name, alias] of [['video', 200n], ['audio', 201n]] as const) {
        await h.old.accept(ref(name), alias);
        await h.old.send(ref(name), chunk(name as 'video' | 'audio', 1n));
        expect(h.received).toContainEqual({ name, group: 1n });
      }
      await h.migrate(msf00([videoTrack('video')]));
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors.join(' ')).toMatch(/audio/i);
      await h.old.send(ref('video'), chunk('video', 2n), 2n);
      expect(h.received).toContainEqual({ name: 'video', group: 2n });
    } finally { await h.destroy(); }
  });
});

describe('the catalog-free fast path keeps its documented meaning', () => {
  it('keeps the accepted known audio identity when its catalog arrives', async () => {
    const h = await fixture({ namespace: ['live/show'],
      catalog: msf00([
        audioTrack('audio', { namespace: 'live/show', renderGroup: 1 }),
        audioTrack('audio', { renderGroup: 2 }),
      ]),
      config: { disableVideo: true, knownTracks: { audio: { name: 'audio', codec: 'mp4a.40.2' } } },
    });
    try {
      await h.old.accept(ref('audio', ['live/show']), 101n);
      expect(h.old.media()).toEqual([ref('audio', ['live/show'])]);
      const selected = migrationState(h.player).qualityController?.currentAudioTrack;
      expect(selected?.renderGroup).toBe(2);
      expect(selected?.resolvedNamespace?.fields).toEqual(['live/show']);
    } finally { await h.destroy(); }
  });

  it('refuses an explicit catalog selection it cannot express, before requesting', async () => {
    // `knownTracks` subscribes without a catalog, so it has nothing to
    // resolve a render group or an identity against. The contradiction is
    // refused when the config is validated — before a connection exists, so
    // necessarily before any request.
    const old = peer();
    const build = () => new MoqtPlayer({
      url: URL_OLD, namespace: 'live/show', draftVersion: 18,
      createConnection: () => old.client as unknown as PlayerConnection,
      createTransport: () => Promise.resolve(old.start()),
      knownTracks: { video: { name: 'video', codec: 'avc1.640028' } },
      selection: { renderGroup: 2 },
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } as MoqtPlayerConfig);
    try {
      expect(build).toThrow(/knownTracks/);
      await flush(256);
      expect(old.requests).toEqual([]);
    } finally { await old.destroy(); }
  });

  it('leaves the catalog-free fast path alone when nothing is selected', async () => {
    // CONTROL: the documented catalog-free behavior is unchanged by the new
    // field — a `knownTracks` player with no `selection` still builds.
    const old = peer();
    const player = new MoqtPlayer({
      url: URL_OLD, namespace: 'live/show', draftVersion: 18,
      createConnection: () => old.client as unknown as PlayerConnection,
      createTransport: () => Promise.resolve(old.start()),
      knownTracks: { video: { name: 'video', codec: 'avc1.640028' } },
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } as MoqtPlayerConfig);
    try {
      expect(player.state).toBeDefined();
    } finally { await player.destroy(); await flush(256); await old.destroy(); }
  });

  it('ignores a selector for media that is disabled', async () => {
    // CONTROL (reviewed ignored-selector rule): disabling is the stronger
    // statement, so a selector for disabled media is not a contradiction.
    const old = peer();
    const player = new MoqtPlayer({
      url: URL_OLD, namespace: 'live/show', draftVersion: 18,
      createConnection: () => old.client as unknown as PlayerConnection,
      createTransport: () => Promise.resolve(old.start()),
      knownTracks: { video: { name: 'video', codec: 'avc1.640028' } },
      disableAudio: true,
      selection: { audioTrack: { name: 'whatever' } },
      createMediaSource: () => ({ initialize: () => true, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }),
    } as MoqtPlayerConfig);
    try {
      expect(player.state).toBeDefined();
    } finally { await player.destroy(); await flush(256); await old.destroy(); }
  });
});

describe('identity survives the whole candidate path, not just issuance', () => {
  it('retains the ACTUALLY pinned namespace across handover', async () => {
    // The established identity must come from the subscription that owned the
    // request, not from a later `catalog.tracks.find` by role and bare name —
    // which takes the FIRST declaration regardless of what is playing.
    const mine = videoTrack('video', { namespace: 'live/show' });
    const other = videoTrack('video', { namespace: 'other/space' });
    const target = ref('video', ['other', 'space']);
    const h = await fixture({
      catalog: msf00([mine, other]),
      config: { disableAudio: true, selection: { videoTrack: { name: 'video', namespace: 'other/space' } } },
    });
    try {
      expect(h.old.media()).toEqual([target]);
      await h.old.accept(target, 200n);
      await h.old.send(target, chunk('video', 1n));
      await h.migrate(msf00([other]));
      expect(h.next.media()).toEqual([target]);
      await h.next.accept(target, 400n);
      await h.next.send(target, chunk('video', 7n), 7n);
      expect(h.migrated).toHaveBeenCalled();
      expect(h.received).toContainEqual({ name: 'video', group: 7n });
    } finally { await h.destroy(); }
  });

  it('requests a cross-namespace replacement under its actual namespace', async () => {
    // The candidate path computes its namespace once from config, so the
    // request, its credentials and its hook context all disagree with the
    // selection the candidate actually made.
    const other = videoTrack('video', { namespace: 'other/space' });
    const target = ref('video', ['other', 'space']);
    /** Identities reported for the MEDIA track, to hook and provider alike.
     *  The catalog legitimately lives in the configured namespace. */
    const seen: Array<readonly string[]> = [];
    const cat = Uint8Array.of(0x84, 0x40, 0xa0, 0x40, 0x40);
    const h = await fixture({
      catalog: msf00([other]),
      config: {
        disableAudio: true,
        authorization: {
          // Credential forwarding across origins is opt-in; without this the
          // migration is refused before any selection question arises.
          allowedRelayOrigins: ['https://new.example'],
          getTokens: (context: { namespace?: readonly Uint8Array[]; trackName?: Uint8Array }) => {
            if (context.trackName && dec.decode(context.trackName) === 'video') {
              seen.push((context.namespace ?? []).map(f => dec.decode(f)));
            }
            return [catToken(cat)];
          },
        },
      } as unknown as Partial<MoqtPlayerConfig>,
    });
    h.player.hooks.beforeSubscribe.add(intent => {
      if (intent.trackName === 'video') seen.push(intent.namespace);
      return intent;
    });
    try {
      await h.old.accept(target, 200n);
      await h.old.send(target, chunk('video', 1n));
      await h.migrate(msf00([other]));
      expect(h.next.media()).toEqual([target]);
      expect(h.next.tokenFor(target)).toMatchObject({ tokenType: 1n, tokenValue: cat });
      // Every identity the candidate reported for the media track.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every(fields => fields.join('/') === 'other/space')).toBe(true);
      await h.next.accept(target, 400n);
      await h.next.send(target, chunk('video', 7n), 7n);
      expect(h.received).toContainEqual({ name: 'video', group: 7n });
    } finally { await h.destroy(); }
  });

  it('does not replace established scope audio with another render group', async () => {
    // Candidate preparation has to apply the same scope policy as startup:
    // the replacement keeps the scope's video but moves its audio to another
    // render group, which is a different presentation, not a substitution.
    const v = videoTrack('side', { renderGroup: 2, altGroup: 2 });
    const a = audioTrack('side-audio', { renderGroup: 2 });
    const h = await fixture({ catalog: msf00([v, a]), config: { selection: { renderGroup: 2 } } });
    try {
      for (const [name, media, alias] of [['side', 'video', 200n], ['side-audio', 'audio', 201n]] as const) {
        await h.old.accept(ref(name), alias);
        await h.old.send(ref(name), chunk(media, 1n));
      }
      await h.migrate(msf00([v, audioTrack('main-audio', { renderGroup: 1 })]));
      expect(h.next.media()).toEqual([]);
      expect(h.errors.join(' ')).toMatch(/audio|scope|selection/i);
      // The old session stays authoritative.
      await h.old.send(ref('side'), chunk('video', 2n), 2n);
      expect(h.received).toContainEqual({ name: 'side', group: 2n });
    } finally { await h.destroy(); }
  });

  it('adopts an audio-only replacement with video enabled but never established', async () => {
    // Requiredness is symmetric: video is enabled and the catalog declares
    // none, so there is no video output to lose.
    const a = audioTrack('audio');
    const h = await fixture({ catalog: msf00([a]) });
    try {
      expect(h.old.media()).toEqual([ref('audio')]);
      await h.old.accept(ref('audio'), 200n);
      await h.old.send(ref('audio'), chunk('audio', 1n));
      await h.migrate(msf00([a]));
      expect(h.next.media()).toEqual([ref('audio')]);
      await h.next.accept(ref('audio'), 400n);
      await h.next.send(ref('audio'), chunk('audio', 7n), 7n);
      expect(h.migrated).toHaveBeenCalled();
      expect(h.received).toContainEqual({ name: 'audio', group: 7n });
    } finally { await h.destroy(); }
  });

  /** Two media types whose init tracks share a NAME in different namespaces. */
  const splitInitCatalog = () => cf01([
    cf01Video('video', 'init', { namespace: 'video/space', renderGroup: 1 }),
    {
      name: 'audio', namespace: 'audio/space', renderGroup: 1, initTrack: 'init',
      selectionParams: { codec: 'mp4a.40.2', mimeType: 'audio/mp4', samplerate: 48000, channelConfig: '2' },
    },
  ]);

  it('does not supply one namespace’s init to both selected media types', async () => {
    const initialize = vi.fn(() => true);
    const h = await fixture({
      catalog: splitInitCatalog(),
      config: { createMediaSource: () => ({ initialize, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }) },
    });
    try {
      expect(h.old.media()).toHaveLength(4);
      expect(initialize).not.toHaveBeenCalled();
      // Only VIDEO's init has arrived; audio is not initialized by it.
      const videoInitRef = ref('init', ['video', 'space']);
      await h.old.accept(videoInitRef, 201n);
      await h.old.send(videoInitRef, videoInit());
      expect(initialize).not.toHaveBeenCalled();
    } finally { await h.destroy(); }
  });

  it.each([
    ['video first', ['video', 'audio']],
    ['audio first', ['audio', 'video']],
  ] as const)('initializes only once BOTH namespaces’ init arrive (%s)', async (_label, order) => {
    const initialize = vi.fn(() => true);
    const h = await fixture({
      catalog: splitInitCatalog(),
      config: { createMediaSource: () => ({ initialize, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null }) },
    });
    try {
      const inits = {
        video: { target: ref('init', ['video', 'space']), alias: 201n, bytes: videoInit() },
        audio: { target: ref('init', ['audio', 'space']), alias: 202n, bytes: audioInit() },
      };
      await h.old.accept(inits[order[0]].target, inits[order[0]].alias);
      await h.old.send(inits[order[0]].target, inits[order[0]].bytes);
      expect(initialize).not.toHaveBeenCalled();
      await h.old.accept(inits[order[1]].target, inits[order[1]].alias);
      await h.old.send(inits[order[1]].target, inits[order[1]].bytes);
      expect(initialize).toHaveBeenCalledTimes(1);
      // Each output got the bytes of its OWN namespace's init track.
      const [config] = initialize.mock.calls[0] as unknown as [
        { video?: { initData?: Uint8Array }; audio?: { initData?: Uint8Array } },
      ];
      expect(config.video?.initData).toEqual(videoInit());
      expect(config.audio?.initData).toEqual(audioInit());
    } finally { await h.destroy(); }
  });
});

/** Narrow inspection of lifecycle state; wire and delivery assertions stay public. */
function migrationState(player: MoqtPlayer) {
  return player as unknown as {
    readonly connection: MoqtConnection | null;
    readonly currentMigration: unknown | null;
    readonly qualityController: QualityController | null;
    runningInitBytes(mediaType: 'video' | 'audio'): Uint8Array | undefined;
  };
}

describe('prepared handover adoption', () => {
  it('initializes pipelines from adopted separate init when old init has not arrived', async () => {
    const initialize = vi.fn(() => true);
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({
      catalog: cat,
      config: { disableAudio: true, createMediaSource: () => ({
        initialize, appendChunk: () => {}, reset: () => {}, endOfStream: () => {}, destroy: () => {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      expect(initialize).not.toHaveBeenCalled();
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(initialize).toHaveBeenCalledTimes(1);
    } finally { await h.destroy(); }
  });

  it('updates running init provenance after an in-band replacement', async () => {
    const first = videoInit();
    const second = videoInit();
    second[second.length - 1] = second[second.length - 1]! ^ 1;
    const track = { name: 'video', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', isLive: true };
    const changeType = vi.fn(async () => {});
    const h = await fixture({
      catalog: msf00([track]),
      config: { disableAudio: true, createMediaSource: () => ({
        initialize: () => true, changeType, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), first);
      await h.migrate(msf00([track]));
      await h.next.accept(ref('video'), 400n);
      await h.next.send(ref('video'), second);
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(changeType).toHaveBeenCalledTimes(1);
      expect(migrationState(h.player).runningInitBytes('video')).toEqual(second);
    } finally { await h.destroy(); }
  });

  it('declines a candidate whose current catalog moved the prepared video out of scope', async () => {
    const track = videoTrack('video', { renderGroup: 2, altGroup: 1 });
    const h = await fixture({
      catalog: msf00([track]), config: { disableAudio: true, selection: { renderGroup: 2 } },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      await h.migrate(msf00([track]));
      await h.next.send(ref('catalog'), msf00([videoTrack('video', { renderGroup: 1, altGroup: 1 })]), 2n);
      await h.next.accept(ref('video'), 400n);
      await flush(512);
      expect(migrationState(h.player).connection).toBe(h.old.client);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.migrated).not.toHaveBeenCalled();
      await h.old.send(ref('video'), chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally { await h.destroy(); }
  });

  it('adopts the runtime selected pin instead of the configured initial pin', async () => {
    const a = videoTrack('a', { altGroup: 1 });
    const b = videoTrack('b', { altGroup: 1 });
    const h = await fixture({
      catalog: msf00([a, b]), config: { disableAudio: true, selection: { videoTrack: { name: 'a' } } },
    });
    try {
      await h.old.accept(ref('a'), 200n);
      await h.old.send(ref('a'), chunk('video', 1n));
      await h.player.selectVideoTrack('b');
      await h.old.accept(ref('b'), 201n);
      await h.old.send(ref('b'), chunk('video', 2n), 2n);
      await h.migrate(msf00([b]));
      await h.next.accept(ref('b'), 400n);
      await flush(512);
      expect(migrationState(h.player).connection).toBe(h.next.client);
      expect(h.errors).toEqual([]);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.next.media()).toEqual([ref('b')]);
      expect(migrationState(h.player).qualityController?.currentVideoTrack?.name).toBe('b');
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(false);
      await h.next.send(ref('b'), chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'b', group: 3n });
    } finally { await h.destroy(); }
  });

  it('retires pending lazy init waiters with their source connection', async () => {
    const video = cf01Video('video', 'init', { altGroup: 1 });
    const future = cf01Video('future', 'future-init', {
      altGroup: 1,
      selectionParams: { codec: 'hev1.1.6.L93.B0', mimeType: 'video/mp4', width: 640, height: 360 },
    });
    const h = await fixture({
      catalog: cf01([video, future]),
      config: { disableAudio: true, selection: { videoTrack: { name: 'video' } } },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.accept(ref('init'), 201n);
      await h.old.send(ref('init'), videoInit());
      let result = 'pending';
      void h.player.selectVideoTrack('future').then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
      await flush(256);
      expect(h.old.names()).toContain('future-init');
      await h.migrate(cf01([video]));
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(result).toBe('rejected');
    } finally { await h.destroy(); }
  });

  it('initializes and migrates when the original separate init was delivered', async () => {
    const initialize = vi.fn(() => true);
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({
      catalog: cat,
      config: { disableAudio: true, createMediaSource: () => ({
        initialize, appendChunk: () => {}, reset: () => {}, endOfStream: () => {}, destroy: () => {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.accept(ref('init'), 201n);
      await h.old.send(ref('init'), videoInit());
      expect(initialize).toHaveBeenCalledTimes(1);
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(initialize).toHaveBeenCalledTimes(1);
    } finally { await h.destroy(); }
  });

  it('adopts the same pinned track when the configuration still matches', async () => {
    const b = videoTrack('b', { altGroup: 1 });
    const h = await fixture({
      catalog: msf00([b]), config: { disableAudio: true, selection: { videoTrack: { name: 'b' } } },
    });
    try {
      await h.old.accept(ref('b'), 200n);
      await h.old.send(ref('b'), chunk('video', 1n));
      await h.migrate(msf00([b]));
      await h.next.accept(ref('b'), 400n);
      await flush(512);
      expect(h.errors).toEqual([]);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(migrationState(h.player).currentMigration).toBeNull();
    } finally { await h.destroy(); }
  });
});

describe('candidate catalog revalidation', () => {
  const changedInlineInit = videoInit();
  changedInlineInit[changedInlineInit.length - 1] = changedInlineInit[changedInlineInit.length - 1]! ^ 1;
  it.each([
    ['codec', { codec: 'hev1.1.6.L93.B0' }],
    ['identity', { name: 'another-camera' }],
    ['init source', { initData: undefined }],
    ['inline init', { initData: b64(changedInlineInit) }],
  ] as const)('declines a changed %s before acceptance without disturbing old playback', async (_label, change) => {
    const track = videoTrack('video', { renderGroup: 2, altGroup: 1 });
    const changeType = vi.fn(async () => {});
    const h = await fixture({
      catalog: msf00([track]),
      config: { disableAudio: true, selection: { renderGroup: 2 }, createMediaSource: () => ({
        initialize: () => true, changeType, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      await h.migrate(msf00([track]));
      await h.next.send(ref('catalog'), msf00([{ ...track, ...change }]), 2n);
      await h.next.accept(ref('video'), 400n);
      await flush(512);
      expect(migrationState(h.player).connection === h.old.client).toBe(true);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors.join(' ')).toMatch(/selection|initialization/);
      expect(changeType).not.toHaveBeenCalled();
      await h.old.send(ref('video'), chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally { await h.destroy(); }
  });

  it.each([true, false])('accepts harmless repeated catalogs while preserving quality mode (auto=%s)', async autoQuality => {
    const track = videoTrack('video', { altGroup: 1 });
    const h = await fixture({ catalog: msf00([track]), config: { disableAudio: true, autoQuality } });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      await h.migrate(msf00([track]));
      await h.next.send(ref('catalog'), msf00([track]), 2n);
      await h.next.send(ref('catalog'), msf00([{ ...track, label: 'Updated label' }]), 3n);
      await h.next.accept(ref('video'), 400n);
      await flush(512);
      expect(h.errors).toEqual([]);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(h.next.media()).toEqual([ref('video')]);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(migrationState(h.player).qualityController?.isAutoQuality).toBe(autoQuality);
      expect(migrationState(h.player).qualityController?.currentVideoTrack?.label).toBe('Updated label');
      await h.next.send(ref('video'), chunk('video', 4n), 4n);
      expect(h.received).toContainEqual({ name: 'video', group: 4n });
    } finally { await h.destroy(); }
  });

  it('revalidates init after a pending retype and restores old init on invalidation', async () => {
    const first = videoInit();
    const second = first.slice();
    second[second.length - 1] = second[second.length - 1]! ^ 1;
    const third = first.slice();
    third[third.length - 1] = third[third.length - 1]! ^ 2;
    let finishRetype!: () => void;
    const retyping = new Promise<void>(resolve => { finishRetype = resolve; });
    const changeType = vi.fn(async (_mediaType: 'video' | 'audio', _codec: string, _bytes: Uint8Array) => {});
    changeType.mockImplementationOnce(() => retyping);
    const track = videoTrack('video', { altGroup: 1 });
    const h = await fixture({
      catalog: msf00([track]),
      config: { disableAudio: true, createMediaSource: () => ({
        initialize: () => true, changeType, appendChunk: () => {}, reset: () => {},
        endOfStream: () => {}, destroy: () => {}, mediaElement: null,
        onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      await h.migrate(msf00([{ ...track, initData: b64(second) }]));
      await h.next.accept(ref('video'), 400n);
      expect(changeType).toHaveBeenCalledTimes(1);
      expect(changeType.mock.calls[0]?.[2]).toEqual(second);
      await h.next.send(ref('catalog'), msf00([{ ...track, initData: b64(third) }]), 2n);
      finishRetype();
      await flush(1024);
      expect(changeType).toHaveBeenCalledTimes(2);
      expect(changeType.mock.calls[1]?.[2]).toEqual(first);
      expect(migrationState(h.player).runningInitBytes('video')).toEqual(first);
      expect(migrationState(h.player).connection === h.old.client).toBe(true);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.migrated).not.toHaveBeenCalled();
      expect(h.errors.join(' ')).toMatch(/initialization changed/);
      await h.old.send(ref('video'), chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally {
      finishRetype();
      await h.destroy();
    }
  });

  it('releases the migration slot and retires the old session when an adapter callback throws at commit', async () => {
    const initialize = vi.fn((): boolean => { throw new Error('application initialize callback failed'); });
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({
      catalog: cat,
      config: { disableAudio: true, createMediaSource: () => ({
        initialize, appendChunk: () => {}, reset: () => {}, endOfStream: () => {}, destroy: () => {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      await flush(512);
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.old.client.session.state).toBe('closed');
      expect(h.errors.join(' ')).toContain('application initialize callback failed');
      expect(h.migrated).not.toHaveBeenCalled();
    } finally { await h.destroy(); }
  });
});

describe('prepared initialization catalog references', () => {
  it('declines changed root init bytes behind the same initRef before acceptance', async () => {
    const track = msf01Video('video', { altGroup: 1 });
    const changed = videoInit();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    const h = await fixture({ catalog: msf01([track]), config: { disableAudio: true } });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.send(ref('video'), chunk('video', 1n));
      await h.migrate(msf01([track]));
      await h.next.send(ref('catalog'), msf01([track], changed), 2n);
      await h.next.accept(ref('video'), 400n);
      await flush(512);
      expect(migrationState(h.player).connection === h.old.client).toBe(true);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.errors.join(' ')).toMatch(/initialization changed/);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.old.send(ref('video'), chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally { await h.destroy(); }
  });

  it('declines a changed initTrack even when the original prepared init arrived', async () => {
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({ catalog: cat, config: { disableAudio: true } });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.accept(ref('init'), 201n);
      await h.old.send(ref('init'), videoInit());
      await h.migrate(cat);
      await h.next.send(ref('catalog'), cf01([cf01Video('video', 'new-init')]), 2n);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      await flush(512);
      expect(migrationState(h.player).connection === h.old.client).toBe(true);
      expect(migrationState(h.player).currentMigration).toBeNull();
      expect(h.errors.join(' ')).toMatch(/configuration changed/);
      expect(h.migrated).not.toHaveBeenCalled();
      await h.old.send(ref('video'), chunk('video', 3n), 3n);
      expect(h.received).toContainEqual({ name: 'video', group: 3n });
    } finally { await h.destroy(); }
  });
});

describe('initialization across source adoption', () => {
  it('creates and initializes pipelines when the replacement delivers the first catalog', async () => {
    const initialize = vi.fn<MediaSourceLike['initialize']>(() => true);
    const appendChunk = vi.fn();
    const createMediaSource = vi.fn(() => ({
      initialize, appendChunk, reset: () => {}, endOfStream: () => {}, destroy: () => {},
      mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
    }));
    const cat = cf01([cf01Video('video', 'init')]);
    const h = await fixture({
      catalog: cat, skipInitialCatalog: true, config: { disableAudio: true, createMediaSource },
    });
    try {
      expect(createMediaSource).not.toHaveBeenCalled();
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('init'), 401n);
      await h.next.send(ref('init'), videoInit());
      await flush(512);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      await h.next.send(ref('video'), chunk('video', 7n), 7n);
      expect(h.errors).toEqual([]);
      expect(createMediaSource).toHaveBeenCalledTimes(1);
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(appendChunk).toHaveBeenCalled();
      expect(h.received).toContainEqual({ name: 'video', group: 7n });
      expect(migrationState(h.player).currentMigration).toBeNull();
    } finally { await h.destroy(); }
  });

  it.each([false, true])('adopts all fresh init bytes before first initialization (changed video=%s)', async changed => {
    const initialize = vi.fn<MediaSourceLike['initialize']>(() => true);
    const cat = cf01([
      cf01Video('video', 'v-init'),
      { name: 'audio', initTrack: 'a-init', selectionParams: {
        codec: 'mp4a.40.2', mimeType: 'audio/mp4', samplerate: 48000, channelConfig: '2',
      } },
    ]);
    const h = await fixture({
      catalog: cat,
      config: { createMediaSource: () => ({
        initialize, appendChunk: () => {}, reset: () => {}, endOfStream: () => {}, destroy: () => {},
        mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
      }) },
    });
    try {
      await h.old.accept(ref('video'), 200n);
      await h.old.accept(ref('audio'), 202n);
      await h.old.accept(ref('v-init'), 201n);
      await h.old.send(ref('v-init'), videoInit());
      expect(initialize).not.toHaveBeenCalled();
      await h.migrate(cat);
      await h.next.accept(ref('video'), 400n);
      await h.next.accept(ref('audio'), 402n);
      await h.next.accept(ref('v-init'), 401n);
      await h.next.accept(ref('a-init'), 403n);
      const nextVideo = videoInit();
      if (changed) nextVideo[nextVideo.length - 1] = nextVideo[nextVideo.length - 1]! ^ 1;
      await h.next.send(ref('v-init'), nextVideo);
      expect(initialize).not.toHaveBeenCalled();
      await h.next.send(ref('a-init'), audioInit());
      await flush(512);
      expect(h.errors).toEqual([]);
      expect(h.migrated).toHaveBeenCalledTimes(1);
      expect(initialize).toHaveBeenCalledTimes(1);
      const adopted = initialize.mock.calls[0]![0];
      expect(adopted.video?.initData).toEqual(nextVideo);
      expect(adopted.audio?.initData).toEqual(audioInit());
      expect(migrationState(h.player).currentMigration).toBeNull();
    } finally { await h.destroy(); }
  });
});
