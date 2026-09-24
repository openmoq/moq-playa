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
 *   - forwarding preserves the publisher's groupId/subgroupId/objectId and raw
 *     Object Properties/Extensions, and mirrors graceful subgroup FIN so
 *     downstream stream credit is returned.
 *
 * Deliberately a TOY — see README:
 *   - LIVE only: the cache holds just the latest group, so a late joiner gets that
 *     group, not full history (no DVR / no real init-segment retention policy).
 *   - NO route authorization, fairness, reconnect/migration, or persistence.
 *     A bounded per-subscription forwarder sheds a subscriber that cannot keep up.
 *   - Forwards DATA objects ONLY. Gap/status objects (incl. END_OF_GROUP) are NOT
 *     relayed: a live relay can't reproduce them with the public API — per-object
 *     status has no `sendObject` field, and the END_OF_GROUP header bit is set at
 *     subgroup-OPEN time (before the relay knows the group is ending). See README.
 * All forwarding uses the public MoqtConnection API — no internals.
 */
import type { MoqtConnection, IncomingPublish } from '@moqt/webtransport';
import { MessageParam, RequestError18, SessionError, locationEncodingLength, varint, writeLocation, type Fetch, type Parameters, type StandaloneFetch } from '@moqt/transport';
import { DEMO_NAMESPACE, DEMO_TRACK, MEDIA_TRACKS, td, nsStr, hex } from './demo.js';
import { SubgroupForwarder, type ForwardLimits } from './subgroup-forwarder.js';

const log = (...a: unknown[]) => console.log('[relay]', ...a);

/** Tracks this relay will route: the simple demo track + the toy media ladder. */
const REGISTERED_TRACKS = new Set<string>([DEMO_TRACK, ...MEDIA_TRACKS]);

interface CachedObject {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly payload: Uint8Array;
  /** Raw draft-18 Object Properties / draft-14/16 Extensions. */
  readonly extensions: Uint8Array | undefined;
}

interface SubscriberSubgroup {
  readonly streamId: bigint;
  /** Fixed by the subgroup header before its first object is sent. */
  readonly hasExtensions: boolean;
}

interface ForwardObjectFields {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly payload: Uint8Array;
  readonly extensions: Uint8Array | undefined;
}

class Subscriber {
  readonly subgroups = new Map<string, SubscriberSubgroup>();
  readonly forwarder: SubgroupForwarder<ForwardObjectFields>;

  constructor(
    readonly conn: MoqtConnection,
    readonly requestId: bigint,
    readonly alias: bigint,
    limits: ForwardLimits,
  ) {
    this.forwarder = new SubgroupForwarder(limits, {
      forward: (fields) => forwardObject(this, fields),
      close: (skey) => closeSubscriberSubgroup(this, skey),
      reportError: (err) => {
        console.error('[relay] FORWARD SCHEDULER ERROR:', (err as Error).message);
      },
    });
  }
}

export interface RelayOptions {
  /** Maximum downstream subgroup streams held open by one subscription. */
  readonly maxConcurrentSubgroupsPerSubscription?: number;
  /** Disconnect a subscriber rather than retain more queued objects than this. */
  readonly maxPendingObjectsPerSubscription?: number;
  /** Disconnect a subscriber rather than retain more queued payload bytes than this. */
  readonly maxPendingBytesPerSubscription?: number;
}

const DEFAULT_FORWARD_LIMITS: ForwardLimits = {
  maxConcurrentSubgroups: 8,
  maxPendingObjects: 256,
  maxPendingBytes: 4 * 1024 * 1024,
};

interface Track {
  subscribers: Subscriber[];
  /** Latest group seen (for late-join replay), and that group's objects. */
  cacheGroupId: bigint | null;
  cache: CachedObject[];
  /** Subgroups in the cached group whose publisher stream ended gracefully. */
  cacheClosedSubgroups: Set<string>;
}

/** ASCII-safe route-table key (hex of each namespace field + the track name). */
const trackKeyOf = (namespace: Uint8Array[], trackName: Uint8Array): string =>
  `${namespace.map(hex).join(',')}|${hex(trackName)}`;

const isRegisteredTrack = (namespace: Uint8Array[], trackName: Uint8Array): boolean =>
  nsStr(namespace) === DEMO_NAMESPACE.join('/') && REGISTERED_TRACKS.has(td(trackName));

export class Relay {
  private readonly tracks = new Map<string, Track>();
  private nextAlias = 100n;
  private readonly forwardLimits: ForwardLimits;

  constructor(options: RelayOptions = {}) {
    this.forwardLimits = {
      maxConcurrentSubgroups: positiveInteger(
        'maxConcurrentSubgroupsPerSubscription',
        options.maxConcurrentSubgroupsPerSubscription ?? DEFAULT_FORWARD_LIMITS.maxConcurrentSubgroups,
      ),
      maxPendingObjects: positiveInteger(
        'maxPendingObjectsPerSubscription',
        options.maxPendingObjectsPerSubscription ?? DEFAULT_FORWARD_LIMITS.maxPendingObjects,
      ),
      maxPendingBytes: positiveInteger(
        'maxPendingBytesPerSubscription',
        options.maxPendingBytesPerSubscription ?? DEFAULT_FORWARD_LIMITS.maxPendingBytes,
      ),
    };
  }

  private getTrack(key: string): Track {
    let track = this.tracks.get(key);
    if (!track) {
      track = {
        subscribers: [],
        cacheGroupId: null,
        cache: [],
        cacheClosedSubgroups: new Set(),
      };
      this.tracks.set(key, track);
    }
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
      // §5.1 / §9.2.2.7: communicate the Largest Location in SUBSCRIBE_OK when
      // objects exist — the session SAVES it as the Joining Location, and any
      // Joining FETCH resolves against that exact snapshot (never the head at
      // fetch time, which may have advanced and would gap/overlap delivery).
      const cachedLargest = latestCached(this.tracks.get(key));
      let acceptParams: Parameters | undefined;
      if (cachedLargest) {
        const value = conn.draftVersion === 18
          ? { group: cachedLargest.groupId, object: cachedLargest.objectId }
          : (() => {
              const loc = { group: varint(cachedLargest.groupId), object: varint(cachedLargest.objectId) };
              const buf = new Uint8Array(locationEncodingLength(loc));
              writeLocation(loc, buf, 0);
              return buf;
            })();
        acceptParams = new Map([[MessageParam.LARGEST_OBJECT as bigint, [value]]]) as Parameters;
      }
      await conn.acceptSubscribe(requestId, alias, acceptParams ? { parameters: acceptParams } : undefined);

      const track = this.getTrack(key);
      const sub = new Subscriber(conn, requestId, alias, this.forwardLimits);
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
          this.enqueueObject(track, sub, c);
        }
        for (const skey of track.cacheClosedSubgroups) {
          sub.forwarder.enqueueClose(skey);
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
        if (track.cacheGroupId !== obj.groupId) {
          track.cacheGroupId = obj.groupId;
          track.cache = [];
          track.cacheClosedSubgroups.clear();
        }
        const extensions = obj.properties ?? obj.extensions;
        track.cache.push({
          groupId: obj.groupId,
          subgroupId: obj.subgroupId,
          objectId: obj.objectId,
          payload: obj.payload,
          extensions,
        });
        // Live fanout (identity preserved), ordered per subgroup. Independent
        // subgroup streams may advance concurrently up to the configured bound.
        const { groupId, subgroupId, objectId, payload } = obj;
        for (const sub of [...track.subscribers]) {
          this.enqueueObject(track, sub, {
            groupId, subgroupId, objectId, payload, extensions,
          });
        }
      };
      publish.onSubgroupClosed = (header) => {
        const skey = subgroupKey(header.groupId, header.subgroupId);
        if (track.cacheGroupId === header.groupId) {
          track.cacheClosedSubgroups.add(skey);
        }
        // onSubgroupClosed follows the final onObject from this incoming stream.
        // Its lane keeps FIN behind that subgroup's final downstream send.
        for (const sub of [...track.subscribers]) {
          sub.forwarder.enqueueClose(skey);
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
   * reference; the range resolves from the subscription's SAVED Joining
   * Location (the SUBSCRIBE_OK snapshot) and is served identically. No saved
   * Joining Location → REQUEST_ERROR INVALID_RANGE ("If no Objects have been
   * published for the track").
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
        // ONLY the SAVED Joining Location (the SUBSCRIBE_OK snapshot) anchors
        // the join. A subscription accepted before any object existed has no
        // Joining Location — the compliant answer is INVALID_RANGE, never a
        // range derived from the later cache head (it could overlap live
        // delivery the subscription already carries).
        range = conn.resolveJoiningFetch(requestId);
      } catch {
        // No saved Joining Location, or an absolute joining start beyond the
        // largest group (§9.16.3).
        await conn.rejectFetch(requestId, RequestError18.INVALID_RANGE as bigint, 'no joining location / start beyond largest');
        return;
      }
      log(`joining FETCH requestId=${requestId} → serving [${range.startLocation.group},${range.startLocation.object}) .. (${range.endLocation.group},${range.endLocation.object})`);
      await serveFetchFromCache(conn, requestId, track, range.startLocation, range.endLocation);
    } catch (err) {
      console.error('[relay] FETCH handling failed:', (err as Error).message);
      try { await conn.rejectFetch(requestId, RequestError18.INTERNAL_ERROR as bigint, 'relay error'); } catch { /* stream gone */ }
    }
  }

  /** The current cached Largest Location for the track a subscription joined —
   *  the session's Forward-resume provider (§5.1). Null when nothing cached. */
  currentLargestFor(conn: MoqtConnection, subRequestId: bigint): { group: bigint; object: bigint } | null {
    const track = this.findSubscriptionTrack(conn, subRequestId);
    const largest = latestCached(track);
    return largest ? { group: largest.groupId, object: largest.objectId } : null;
  }

  /** Reverse lookup: the track a given (conn, requestId) subscription belongs to. */
  private findSubscriptionTrack(conn: MoqtConnection, requestId: bigint): Track | undefined {
    for (const track of this.tracks.values()) {
      if (track.subscribers.some((s) => s.conn === conn && s.requestId === requestId)) return track;
    }
    return undefined;
  }

  private enqueueObject(track: Track, sub: Subscriber, fields: ForwardObjectFields): void {
    const skey = subgroupKey(fields.groupId, fields.subgroupId);
    const retainedBytes = fields.payload.byteLength + (fields.extensions?.byteLength ?? 0);
    const result = sub.forwarder.enqueueObject(skey, fields, retainedBytes);
    if (result.status !== 'overloaded') return;
    const reason = `subscriber requestId=${sub.requestId} cannot keep up: ${result.reason}`;
    log(`${reason}; closing its connection`);
    // A WebTransport connection may own several track subscriptions. Once one
    // subscription has exceeded its bounded backlog, stop all work for that
    // connection before initiating the asynchronous session close.
    this.removeConn(sub.conn);
    void sub.conn.close(SessionError.INTERNAL_ERROR, reason).catch((err) => {
      console.error('[relay] SLOW SUBSCRIBER CLOSE ERROR:', (err as Error).message);
    });
  }

  /** A single subscription was cancelled (subscriber reset its SUBSCRIBE stream) —
   *  drop ONLY that subscription (ABR quality-switch), keep the connection. */
  removeSubscription(conn: MoqtConnection, requestId: bigint): void {
    for (const track of this.tracks.values()) {
      const i = track.subscribers.findIndex((s) => s.conn === conn && s.requestId === requestId);
      if (i < 0) continue;
      const [sub] = track.subscribers.splice(i, 1);
      // Finish already-queued forwards in subgroup order, then FIN each stream.
      void sub!.forwarder.retire();
      log(`subscription requestId=${requestId} unsubscribed; ${track.subscribers.length} subscriber(s) remain on this track`);
      return; // (conn, requestId) is unique to one subscription
    }
  }

  /** Drop every subscription belonging to a closed/lost connection. */
  removeConn(conn: MoqtConnection): void {
    for (const track of this.tracks.values()) {
      const removed = track.subscribers.filter((s) => s.conn === conn);
      if (removed.length > 0) {
        for (const sub of removed) sub.forwarder.abort();
        const kept = track.subscribers.filter((s) => s.conn !== conn);
        track.subscribers = kept;
        log(`removed ${removed.length} subscriber(s) on close; ${kept.length} remain on this track`);
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
      publisherPriority: 128, extensions: c.extensions, payload: c.payload,
    });
  }
  // §9.16.3: if no objects exist in the range, the stream carries only the
  // FETCH_HEADER and closes with FIN.
  await conn.closeFetchStream(sid);
  log(`FETCH requestId=${requestId}: served ${servable.length} cached object(s)`);
}

/** Forward ONE object to one subscriber, preserving identity: reuse (or lazily open) an
 *  outgoing subgroup for this `(groupId, subgroupId)` and send at the original objectId.
 *  The first object fixes whether the outgoing subgroup carries Properties/Extensions.
 *  Later property-free objects are representable as empty blocks; properties cannot
 *  first appear after a property-free subgroup header is already on the wire.
 *  Errors are logged loudly (never hidden) — a short subscriber fails the smoke. */
async function forwardObject(
  sub: Subscriber,
  fields: ForwardObjectFields,
): Promise<void> {
  try {
    const { groupId, subgroupId, objectId, payload, extensions } = fields;
    const skey = subgroupKey(groupId, subgroupId);
    let subgroup = sub.subgroups.get(skey);
    if (subgroup === undefined) {
      const hasExtensions = extensions !== undefined;
      const streamId = await sub.conn.openSubgroup(sub.alias, groupId, subgroupId, {
        publisherPriority: 128,
        firstObject: objectId === 0n,
        hasExtensions,
      });
      subgroup = { streamId, hasExtensions };
      sub.subgroups.set(skey, subgroup);
    } else if (!subgroup.hasExtensions && extensions !== undefined) {
      throw new Error(
        `subgroup ${skey} opened without Properties/Extensions, but object ${objectId} carries them`,
      );
    }
    await sub.conn.sendObject(subgroup.streamId, objectId, payload, extensions);
  } catch (err) {
    console.error('[relay] FORWARD ERROR (object dropped):', (err as Error).message);
  }
}

const subgroupKey = (groupId: bigint, subgroupId: bigint): string =>
  `${groupId}/${subgroupId}`;

/** Close one outgoing subgroup after its queued objects have settled. */
async function closeSubscriberSubgroup(sub: Subscriber, skey: string): Promise<void> {
  const subgroup = sub.subgroups.get(skey);
  if (subgroup === undefined) return;
  sub.subgroups.delete(skey);
  try {
    await sub.conn.closeSubgroup(subgroup.streamId);
  } catch (err) {
    console.error('[relay] SUBGROUP CLOSE ERROR:', (err as Error).message);
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
