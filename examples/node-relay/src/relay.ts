/**
 * Toy in-memory relay/fanout for the Node WebTransport MoQT example.
 *
 * One inbound publisher → many subscribers, over a small REGISTERED set of tracks
 * (a toy ABR media ladder + the simple demo track). Capabilities:
 *   - track registry (only registered tracks are accepted; others rejected);
 *   - multiple concurrent subscriptions PER viewer connection, one alias each
 *     (so a viewer can subscribe catalog + a video + an audio rendition);
 *   - per-subscription teardown via `onSubscribeClosed` — an ABR quality-switch
 *     resets one SUBSCRIBE stream and the relay drops only that subscription,
 *     WITHOUT closing the viewer connection;
 *   - a tiny per-track LIVE cache (the most-recent group) replayed to a late joiner;
 *   - forwarding preserves the publisher's groupId/subgroupId/objectId.
 *
 * Deliberately a TOY — see README:
 *   - LIVE only: the cache holds just the latest group, so a late joiner gets that
 *     group, not full history (no DVR / no real init-segment retention policy).
 *   - NO route authorization, NO backpressure/fairness, NO reconnect/migration.
 *   - Forwards DATA objects ONLY. Gap/status objects (incl. END_OF_GROUP) are NOT
 *     relayed: a live relay can't reproduce them with the public API — per-object
 *     status has no `sendObject` field, and the END_OF_GROUP header bit is set at
 *     subgroup-OPEN time (before the relay knows the group is ending). See README.
 * All forwarding uses the public MoqtConnection API — no internals.
 */
import type { MoqtConnection, IncomingPublish } from '@moqt/webtransport';
import { RequestError18 } from '@moqt/transport';
import { DEMO_NAMESPACE, DEMO_TRACK, MEDIA_TRACKS, td, nsStr, hex } from './demo.js';

const log = (...a: unknown[]) => console.log('[relay]', ...a);

/** Tracks this relay will route: the simple demo track + the toy media ladder. */
const REGISTERED_TRACKS = new Set<string>([DEMO_TRACK, ...MEDIA_TRACKS]);

interface CachedObject {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly payload: Uint8Array;
}

interface Subscriber {
  readonly conn: MoqtConnection;
  readonly requestId: bigint;
  readonly alias: bigint;
  /** Per-subscriber promise chain: serializes forwards so objects keep their order. */
  queue: Promise<void>;
  /** Outgoing subgroup streams keyed by the publisher's "groupId/subgroupId". */
  readonly subgroups: Map<string, bigint>;
}

interface Track {
  subscribers: Subscriber[];
  /** Latest group seen (for late-join replay), and that group's objects. */
  cacheGroupId: bigint | null;
  cache: CachedObject[];
}

/** ASCII-safe route-table key (hex of each namespace field + the track name). */
const trackKeyOf = (namespace: Uint8Array[], trackName: Uint8Array): string =>
  `${namespace.map(hex).join(',')}|${hex(trackName)}`;

const isRegisteredTrack = (namespace: Uint8Array[], trackName: Uint8Array): boolean =>
  nsStr(namespace) === DEMO_NAMESPACE.join('/') && REGISTERED_TRACKS.has(td(trackName));

export class Relay {
  private readonly tracks = new Map<string, Track>();
  private nextAlias = 100n;

  private getTrack(key: string): Track {
    let track = this.tracks.get(key);
    if (!track) { track = { subscribers: [], cacheGroupId: null, cache: [] }; this.tracks.set(key, track); }
    return track;
  }

  /** A subscriber's SUBSCRIBE: accept with a fresh alias, register, replay live cache. */
  async handleSubscribe(
    conn: MoqtConnection,
    requestId: bigint,
    namespace: Uint8Array[],
    trackName: Uint8Array,
  ): Promise<void> {
    try {
      if (!isRegisteredTrack(namespace, trackName)) {
        log(`SUBSCRIBE ${nsStr(namespace)}/${td(trackName)} — not registered; rejecting`);
        await conn.rejectSubscribe(requestId, RequestError18.DOES_NOT_EXIST, 'unknown track');
        return;
      }
      const name = td(trackName);
      const key = trackKeyOf(namespace, trackName);
      const alias = this.nextAlias++;
      await conn.acceptSubscribe(requestId, alias);

      const track = this.getTrack(key);
      const sub: Subscriber = { conn, requestId, alias, queue: Promise.resolve(), subgroups: new Map() };
      track.subscribers.push(sub);
      log(`subscriber joined ${name} (alias=${alias}, requestId=${requestId}); ${track.subscribers.length} now`);

      // Late-join: replay the cached latest group BEFORE any future live object.
      if (track.cache.length > 0) {
        log(`replaying ${track.cache.length} cached object(s) of group ${track.cacheGroupId} to the new ${name} subscriber`);
        for (const c of track.cache) {
          sub.queue = sub.queue.then(() => forwardObject(sub, c.groupId, c.subgroupId, c.objectId, c.payload));
        }
      }
    } catch (err) {
      console.error('[relay] SUBSCRIBE handling failed:', (err as Error).message);
    }
  }

  /** A publisher's PUBLISH: accept and forward its objects to all subscribers. */
  async handlePublish(conn: MoqtConnection, publish: IncomingPublish): Promise<void> {
    try {
      if (!isRegisteredTrack(publish.trackNamespace, publish.trackName)) {
        log(`PUBLISH ${nsStr(publish.trackNamespace)}/${td(publish.trackName)} — not registered; rejecting`);
        await conn.rejectSubscribe(publish.requestId, RequestError18.DOES_NOT_EXIST, 'unknown track');
        return;
      }
      const name = td(publish.trackName);
      const key = trackKeyOf(publish.trackNamespace, publish.trackName);
      await conn.acceptSubscribe(publish.requestId, publish.trackAlias);
      // Create the track on accepted PUBLISH so a publisher that publishes BEFORE any
      // viewer subscribes still populates the latest-group cache (the normal origin
      // case) — a late subscriber then gets the cached group via replay.
      const track = this.getTrack(key);
      log(`publisher accepted for ${name} (alias=${publish.trackAlias})`);

      publish.onObject = (obj) => {
        if (obj.kind !== 'data') return; // §see README: gap/status objects are not relayed
        // Maintain the latest-group cache for late joiners.
        if (track.cacheGroupId !== obj.groupId) { track.cacheGroupId = obj.groupId; track.cache = []; }
        track.cache.push({ groupId: obj.groupId, subgroupId: obj.subgroupId, objectId: obj.objectId, payload: obj.payload });
        // Live fanout (identity preserved), serialized per subscriber.
        const { groupId, subgroupId, objectId, payload } = obj;
        for (const sub of track.subscribers) {
          sub.queue = sub.queue.then(() => forwardObject(sub, groupId, subgroupId, objectId, payload));
        }
      };
    } catch (err) {
      console.error('[relay] PUBLISH handling failed:', (err as Error).message);
    }
  }

  /** A single subscription was cancelled (subscriber reset its SUBSCRIBE stream) —
   *  drop ONLY that subscription (ABR quality-switch), keep the connection. */
  removeSubscription(conn: MoqtConnection, requestId: bigint): void {
    for (const track of this.tracks.values()) {
      const i = track.subscribers.findIndex((s) => s.conn === conn && s.requestId === requestId);
      if (i < 0) continue;
      const [sub] = track.subscribers.splice(i, 1);
      // Close the subgroups AFTER any queued forwards drain (chain, don't race).
      sub!.queue = sub!.queue.then(() => closeAllSubgroups(sub!));
      log(`subscription requestId=${requestId} unsubscribed; ${track.subscribers.length} subscriber(s) remain on this track`);
      return; // (conn, requestId) is unique to one subscription
    }
  }

  /** Drop every subscription belonging to a closed/lost connection. */
  removeConn(conn: MoqtConnection): void {
    for (const track of this.tracks.values()) {
      const before = track.subscribers.length;
      const kept = track.subscribers.filter((s) => s.conn !== conn);
      if (kept.length !== before) {
        track.subscribers = kept;
        log(`removed ${before - kept.length} subscriber(s) on close; ${kept.length} remain on this track`);
      }
    }
  }
}

/** Forward ONE object to one subscriber, preserving identity: reuse (or lazily open) an
 *  outgoing subgroup for this `(groupId, subgroupId)` and send at the original objectId.
 *  Errors are logged loudly (never hidden) — a short subscriber fails the smoke. */
async function forwardObject(
  sub: Subscriber,
  groupId: bigint,
  subgroupId: bigint,
  objectId: bigint,
  payload: Uint8Array,
): Promise<void> {
  try {
    const skey = `${groupId}/${subgroupId}`;
    let sid = sub.subgroups.get(skey);
    if (sid === undefined) {
      sid = await sub.conn.openSubgroup(sub.alias, groupId, subgroupId, { publisherPriority: 128, firstObject: objectId === 0n });
      sub.subgroups.set(skey, sid);
    }
    await sub.conn.sendObject(sid, objectId, payload);
  } catch (err) {
    console.error('[relay] FORWARD ERROR (object dropped):', (err as Error).message);
  }
}

/** Close all of a subscriber's open outgoing subgroups (on unsubscribe). */
async function closeAllSubgroups(sub: Subscriber): Promise<void> {
  const ids = [...sub.subgroups.values()];
  sub.subgroups.clear();
  for (const sid of ids) {
    try { await sub.conn.closeSubgroup(sid); } catch { /* already gone */ }
  }
}
