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
 *   - a tiny per-track LIVE cache (the most-recent group) replayed to a late joiner
 *     (except Largest Object subscriptions, which start past the largest object
 *     per §5.1.2 and backfill the current group via a Joining FETCH instead);
 *   - standalone + joining FETCH served from the latest-group cache (§9.16 /
 *     draft-18 §10.12) — see handleFetch;
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
import { RequestError18, type Fetch, type StandaloneFetch } from '@moqt/transport';
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

      // Late-join: replay the cached latest group BEFORE any future live object —
      // but NOT for a Largest Object subscription (§5.1.2: it starts delivery at
      // {Largest.Group, Largest.Object + 1}; replaying the cached group would
      // violate the filter). Such a subscriber warm-starts the current group with
      // a Joining FETCH instead (§10.12.2, see handleFetch).
      const remoteFilter = conn.session.getIncomingSubscription(requestId)?.remoteFilterType;
      if (remoteFilter === 'LargestObject') {
        log(`Largest Object subscription on ${name} — no cache replay (join the group head via Joining FETCH)`);
      } else if (track.cache.length > 0) {
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

  /**
   * Answer a FETCH from the latest-group live cache (TOY semantics).
   *
   * Standalone (§9.16.3): serve `cache ∩ [startLocation, endLocation)` — the
   * End Location's Object component is one-past ("the end Location, plus 1");
   * value 0 requests the entire end group. Start beyond the largest cached
   * object → REQUEST_ERROR INVALID_RANGE. Because only the LATEST group is
   * retained, a range reaching further back is answered with what exists;
   * per §9.16.3 gaps in the response stream indicate objects that do not
   * exist (a real relay would confirm upstream — this toy has no upstream).
   *
   * Joining (§9.16.2 / §10.12.2): the session already validated the joining
   * reference; resolve the range from this track's largest cached object and
   * serve identically. No cached objects → REQUEST_ERROR INVALID_RANGE
   * ("If no Objects have been published for the track").
   */
  async handleFetch(conn: MoqtConnection, requestId: bigint, fetch: Fetch): Promise<void> {
    try {
      if (fetch.fetch.fetchType === 0x1) {
        const sf = fetch.fetch as StandaloneFetch;
        if (!isRegisteredTrack(sf.trackNamespace, sf.trackName)) {
          log(`FETCH ${nsStr(sf.trackNamespace)}/${td(sf.trackName)} — not registered; rejecting`);
          await conn.rejectFetch(requestId, RequestError18.DOES_NOT_EXIST as bigint, 'unknown track');
          return;
        }
        const track = this.tracks.get(trackKeyOf(sf.trackNamespace, sf.trackName));
        const largest = latestCached(track);
        if (!largest) {
          await conn.rejectFetch(requestId, RequestError18.INVALID_RANGE as bigint, 'no objects published');
          return;
        }
        const start = sf.startLocation;
        // §9.16.3: "If Start Location is greater than the Largest Object the
        // publisher MUST return REQUEST_ERROR with error code INVALID_RANGE."
        if (start.group > largest.groupId
          || (start.group === largest.groupId && start.object > largest.objectId)) {
          await conn.rejectFetch(requestId, RequestError18.INVALID_RANGE as bigint,
            `start (${start.group},${start.object}) beyond largest (${largest.groupId},${largest.objectId})`);
          return;
        }
        await serveFetchFromCache(conn, requestId, track!, start, sf.endLocation);
        return;
      }

      // Joining (0x2/0x3): locate the joined subscription's track on THIS conn.
      const joiningReqId = (fetch.fetch as { joiningRequestId: bigint }).joiningRequestId;
      const track = this.findSubscriptionTrack(conn, joiningReqId);
      const largest = latestCached(track);
      if (!track || !largest) {
        // §9.16.2: no objects published for the track → INVALID_RANGE.
        await conn.rejectFetch(requestId, RequestError18.INVALID_RANGE as bigint, 'no objects published');
        return;
      }
      let range;
      try {
        range = conn.resolveJoiningFetch(requestId, { group: largest.groupId, object: largest.objectId });
      } catch {
        // Absolute joining start beyond the largest group (§9.16.3).
        await conn.rejectFetch(requestId, RequestError18.INVALID_RANGE as bigint, 'joining start beyond largest');
        return;
      }
      log(`joining FETCH requestId=${requestId} → serving [${range.startLocation.group},${range.startLocation.object}) .. (${range.endLocation.group},${range.endLocation.object})`);
      await serveFetchFromCache(conn, requestId, track, range.startLocation, range.endLocation);
    } catch (err) {
      console.error('[relay] FETCH handling failed:', (err as Error).message);
      try { await conn.rejectFetch(requestId, RequestError18.INTERNAL_ERROR as bigint, 'relay error'); } catch { /* stream gone */ }
    }
  }

  /** Reverse lookup: the track a given (conn, requestId) subscription belongs to. */
  private findSubscriptionTrack(conn: MoqtConnection, requestId: bigint): Track | undefined {
    for (const track of this.tracks.values()) {
      if (track.subscribers.some((s) => s.conn === conn && s.requestId === requestId)) return track;
    }
    return undefined;
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

/** Largest cached object of a track (cache holds one group, appended in order). */
function latestCached(track: Track | undefined): CachedObject | undefined {
  return track && track.cache.length > 0 ? track.cache[track.cache.length - 1] : undefined;
}

/**
 * Serve `cache ∩ [start, end)` on a FETCH data stream, ascending. `end` is in
 * the wire convention (§9.16.3): Object is one-past; Object 0 requests the
 * entire end group. FETCH_OK's endLocation uses the same encoding and covers
 * exactly what was served (the request end capped at largest, per §10.13).
 */
async function serveFetchFromCache(
  conn: MoqtConnection,
  requestId: bigint,
  track: Track,
  start: { group: bigint; object: bigint },
  end: { group: bigint; object: bigint },
): Promise<void> {
  const beforeEnd = (groupId: bigint, objectId: bigint): boolean =>
    groupId < end.group
    || (groupId === end.group && (end.object === 0n || objectId < end.object));
  const atOrAfterStart = (groupId: bigint, objectId: bigint): boolean =>
    groupId > start.group
    || (groupId === start.group && objectId >= start.object);

  const servable = track.cache.filter((c) => atOrAfterStart(c.groupId, c.objectId) && beforeEnd(c.groupId, c.objectId));
  const last = servable[servable.length - 1];
  const endLocation = last
    ? { group: last.groupId, object: last.objectId + 1n }
    : { group: start.group, object: start.object }; // empty range: end == start is legal (§9.16.3)

  await conn.acceptFetch(requestId, { endLocation });
  const sid = await conn.openFetchStream(requestId);
  for (const c of servable) {
    await conn.sendFetchObject(sid, {
      groupId: c.groupId, subgroupId: c.subgroupId, objectId: c.objectId,
      publisherPriority: 128, payload: c.payload,
    });
  }
  // §9.16.3: if no objects exist in the range, the stream carries only the
  // FETCH_HEADER and closes with FIN.
  await conn.closeFetchStream(sid);
  log(`FETCH requestId=${requestId}: served ${servable.length} cached object(s)`);
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
