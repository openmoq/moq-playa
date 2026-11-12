/**
 * Toy in-memory relay/fanout for the Node WebTransport MoQT example.
 *
 * Inbound publishers → many subscribers, over a small REGISTERED set of tracks
 * (a toy ABR media ladder + the simple demo track). Capabilities:
 *   - track registry (only registered tracks are accepted; others rejected);
 *   - multiple concurrent subscriptions PER viewer connection, one alias each
 *     (so a viewer can subscribe catalog + a video + an audio rendition);
 *   - per-subscription teardown via `onSubscribeClosed` — an ABR quality-switch
 *     resets one SUBSCRIBE stream and the relay drops only that subscription,
 *     WITHOUT closing the viewer connection;
 *   - SUBSCRIBE forwards only newly received Objects, including arrivals during
 *     acceptance; retrieve past Objects with FETCH (d18 §10.7);
 *   - standalone + joining FETCH served from bounded, proven history (§9.16 /
 *     draft-18 §10.12) — see handleFetch;
 *   - forwarding preserves the publisher's groupId/subgroupId/objectId and raw
 *     Object Properties/Extensions, and sends FIN only for complete subgroups so
 *     downstream stream credit is returned. The incoming END_OF_GROUP header
 *     bit is preserved before forwarding its first object.
 *
 * Deliberately a TOY — see README:
 *   - History defaults to one Group, 256 Objects and 4 MiB (no persistence).
 *   - NO route authorization, fairness, reconnect/migration, or persistence.
 *     A bounded per-subscription forwarder sheds a subscriber that cannot keep up.
 *   - Forwards DATA objects and their subgroup header evidence. Explicit wire
 *     gap/status objects are not relayed; sendObject has no status argument.
 * All forwarding uses the public MoqtConnection API — no internals.
 */
import type { MoqtConnection, IncomingPublish } from '@openmoq/webtransport';
import { windowContains, MessageParam, RequestError18, SessionError, locationEncodingLength, varint, writeLocation, type Fetch, type Parameters, type StandaloneFetch } from '@openmoq/transport';
import { DEMO_NAMESPACE, DEMO_TRACK, MEDIA_TRACKS, td, te, nsStr, hex } from './demo.js';
import { SubgroupForwarder, type ForwardLimits } from './subgroup-forwarder.js';
import { isRequestStreamDraft, decodeSubscriptionFilter, resolveFillWindow, MAX_VI64 } from '@openmoq/transport';
import { HistoryCache, type HistoryLimits } from './history-cache.js';

const log = (...a: unknown[]) => console.log('[relay]', ...a);

/** Tracks this relay will route: the simple demo track + the toy media ladder. */
const REGISTERED_TRACKS = new Set([DEMO_TRACK, ...MEDIA_TRACKS].map((name) => hex(te(name))));

interface SubscriberSubgroup {
  readonly streamId: bigint;
  /** Fixed by the subgroup header before its first object is sent. */
  readonly hasExtensions: boolean;
}

interface ForwardObjectFields {
  readonly firstObject: boolean;
  readonly endOfGroup: boolean;
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly payload: Uint8Array;
  readonly extensions: Uint8Array | undefined;
}

class Subscriber {
  pending = true;
  stopped = false;
  terminalStatus?: bigint;
  initialStart = { group: 0n, object: 0n };
  readonly subgroups = new Map<string, SubscriberSubgroup>();
  readonly forwarder: SubgroupForwarder<ForwardObjectFields>;

  constructor(
    readonly conn: MoqtConnection,
    readonly requestId: bigint,
    readonly alias: bigint,
    limits: ForwardLimits,
    readonly retire: () => void,
    readonly prefix: Map<string, { groupId: bigint; objectId: bigint }>,
  ) {
    this.forwarder = new SubgroupForwarder(limits, {
      forward: (fields) => forwardObject(this, fields),
      close: (skey) => closeSubscriberSubgroup(this, skey),
      reportError: (err) => {
        console.error('[relay] FORWARD SCHEDULER ERROR:', (err as Error).message);
      },
    }, false);
  }
}

export interface RelayOptions {
  /** Whole-Group retention; defaults to 1 Group, 256 Objects, 4 MiB including properties. */
  readonly historyCache?: Partial<HistoryLimits>;
  /** Concurrent pinned FETCH snapshots; defaults to 32. */
  readonly maxActiveHistoryRequests?: number;
  /** Exact namespace tuples this toy relay accepts. Defaults to DEMO_NAMESPACE. */
  readonly registeredNamespaces?: readonly (readonly string[])[];
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
  largest?: { groupId: bigint; objectId: bigint };
  sources: Set<IncomingPublish>;
  upstream: Map<string, { groupId: bigint; objectId: bigint }>;
  subscribers: Subscriber[];
  cache: HistoryCache;
}

/** ASCII-safe namespace key that preserves tuple-field boundaries. */
const namespaceKeyOf = (namespace: readonly Uint8Array[]): string =>
  namespace.map(hex).join(',');

const configuredNamespaceKeyOf = (namespace: readonly string[]): string =>
  namespaceKeyOf(namespace.map(te));

/** ASCII-safe route-table key (hex of each namespace field + the track name). */
const trackKeyOf = (namespace: Uint8Array[], trackName: Uint8Array): string =>
  `${namespaceKeyOf(namespace)}|${hex(trackName)}`;

export class Relay {
  private readonly tracks = new Map<string, Track>();
  private nextAlias = 100n;
  private readonly observed = new WeakSet<MoqtConnection>();
  private readonly finReceipts = new WeakSet<object>();
  private readonly finStreams = new WeakMap<object, bigint>();
  private readonly receptionStreams = new WeakMap<object, bigint | null>();
  private readonly historyLimits: HistoryLimits;
  private readonly maxHistory: number;
  private readonly historyResponses = new Set<{ conn: MoqtConnection; requestId: bigint; track: Track; malformed: boolean }>();
  private readonly forwardLimits: ForwardLimits;
  private readonly registeredNamespaceKeys: ReadonlySet<string>;

  constructor(options: RelayOptions = {}) {
    this.historyLimits = {
      maxGroups: positiveInteger('maxGroups', options.historyCache?.maxGroups ?? 1),
      maxObjects: positiveInteger('maxObjects', options.historyCache?.maxObjects ?? 256),
      maxBytes: positiveInteger('maxBytes', options.historyCache?.maxBytes ?? 4 * 1024 * 1024),
    };
    this.maxHistory = positiveInteger('maxActiveHistoryRequests', options.maxActiveHistoryRequests ?? 32);
    const registeredNamespaces = options.registeredNamespaces ?? [DEMO_NAMESPACE];
    if (registeredNamespaces.length === 0) {
      throw new RangeError('registeredNamespaces must contain at least one namespace');
    }
    this.registeredNamespaceKeys = new Set(
      registeredNamespaces.map(configuredNamespaceKeyOf),
    );
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
        sources: new Set(),
        upstream: new Map(),
        subscribers: [],
        cache: new HistoryCache(this.historyLimits),
      };
      this.tracks.set(key, track);
    }
    return track;
  }

  private isRegisteredTrack(namespace: Uint8Array[], trackName: Uint8Array): boolean {
    return this.registeredNamespaceKeys.has(namespaceKeyOf(namespace))
      && REGISTERED_TRACKS.has(hex(trackName));
  }

  /** Register before acceptance so newly received Objects are queued, never replay history. */
  async handleSubscribe(
    conn: MoqtConnection,
    requestId: bigint,
    namespace: Uint8Array[],
    trackName: Uint8Array,
  ): Promise<void> {
    conn.setLargestLocationProvider(id => this.currentLargestFor(conn, id));
    try {
      if (!this.isRegisteredTrack(namespace, trackName)) {
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
      const cachedLargest = this.trackHead(this.getTrack(key));
      let acceptParams: Parameters | undefined;
      if (cachedLargest) {
        const value = isRequestStreamDraft(conn.draftVersion)
          ? { group: cachedLargest.groupId, object: cachedLargest.objectId }
          : (() => {
              const loc = { group: varint(cachedLargest.groupId), object: varint(cachedLargest.objectId) };
              const buf = new Uint8Array(locationEncodingLength(loc));
              writeLocation(loc, buf, 0);
              return buf;
            })();
        acceptParams = new Map([[MessageParam.LARGEST_OBJECT as bigint, [value]]]) as Parameters;
      }
      this.servedTracks.set(conn.session.getIncomingSubscription(requestId)!, this.getTrack(key));
      const track = this.getTrack(key);
      const sub = new Subscriber(conn, requestId, alias, this.forwardLimits, () => this.removeSubscription(conn, requestId), new Map(track.upstream));
      track.subscribers.push(sub);
      log(`subscriber joined ${name} (alias=${alias}, requestId=${requestId}); ${track.subscribers.length} now`);

      try {
        await conn.acceptSubscribe(requestId, alias, acceptParams ? { parameters: acceptParams } : undefined);
        if (sub.stopped || conn.session.getIncomingSubscription(requestId)?.isTerminated !== false) {
          sub.retire(); return;
        }
        sub.initialStart = conn.session.getIncomingSubscription(requestId)?.locationWindow?.start ?? sub.initialStart;
        sub.pending = false;
        if (sub.terminalStatus !== undefined) {
          sub.retire();
          if (sub.terminalStatus === 0x12n) await conn.terminateMalformedPublication(requestId);
          else await conn.publishDone(requestId, varint(sub.terminalStatus), 'acceptance backlog exceeded');
        } else sub.forwarder.start();
      } catch (error) { sub.retire(); throw error; }
    } catch (err) {
      console.error('[relay] SUBSCRIBE handling failed:', (err as Error).message);
    }
  }

  /** A publisher's PUBLISH: accept and forward its objects to all subscribers. */
  async handlePublish(conn: MoqtConnection, publish: IncomingPublish): Promise<void> {
    if (!this.observed.has(conn)) {
      this.observed.add(conn);
      conn.observeObjectReceipts(event => { if (event.origin === 'group-end') this.finReceipts.add(event.receipt); });
      const fin = conn.onSubgroupFin; conn.onSubgroupFin = (id, header) => { this.finStreams.set(header, id); fin?.(id, header); };
    }
    try {
      if (!this.isRegisteredTrack(publish.trackNamespace, publish.trackName)) {
        log(`PUBLISH ${nsStr(publish.trackNamespace)}/${td(publish.trackName)} — not registered; rejecting`);
        await conn.rejectSubscribe(publish.requestId, RequestError18.DOES_NOT_EXIST, 'unknown track');
        return;
      }
      const name = td(publish.trackName);
      const key = trackKeyOf(publish.trackNamespace, publish.trackName);
      const track = this.getTrack(key);
      track.sources.add(publish);
      const stop = conn.observeObjectReception(event => {
        if (event.type === 'progress' || event.trackAlias !== publish.trackAlias) return;
        this.receptionStreams.set(event.reception, event.streamId);
        track.cache.attribute(publish, event.groupId, event.subgroupId, event.streamId);
      });
      void publish.closed.then(stop);
      void publish.closed.then(() => { this.trackHead(track); track.sources.delete(publish); track.cache.forgetSource(publish); });
      await conn.acceptSubscribe(publish.requestId, publish.trackAlias);
      // Create the track on accepted PUBLISH so a publisher that publishes BEFORE any
      // viewer subscribes still populates the history available to FETCH.
      log(`publisher accepted for ${name} (alias=${publish.trackAlias})`);

      publish.onObject = (obj) => {
        if (!track.sources.has(publish)) return;
        this.trackHead(track);
        const receipt = conn.objectReceiptFor(obj);
        if (receipt && this.finReceipts.has(receipt)) return; // FIN is handled below, never as a wire status.
        const reception = conn.objectReceptionFor(obj);
        track.cache.observe(publish, obj, reception && this.receptionStreams.get(reception));
        if (obj.kind !== 'data') return;
        if (!track.largest || obj.groupId > track.largest.groupId || (obj.groupId === track.largest.groupId && obj.objectId > track.largest.objectId)) {
          track.largest = { groupId: obj.groupId, objectId: obj.objectId };
        }
        const extensions = obj.properties ?? obj.extensions;
        const firstObject = obj.isFirstObjectInSubgroup === true;
        const endOfGroup = obj.subgroupContainsEndOfGroup === true;
        const added = track.cache.admit({
          firstObject,
          endOfGroup,
          groupId: obj.groupId,
          subgroupId: obj.subgroupId,
          objectId: obj.objectId,
          payload: obj.payload,
          extensions,
        });
        if (added === 'malformed') { this.retireMalformed(track, conn, publish); return; }
        if (added === 'duplicate') return;
        track.upstream.set(subgroupKey(obj.groupId, obj.subgroupId), { groupId: obj.groupId, objectId: obj.objectId });
        // Live fanout (identity preserved), ordered per subgroup. Independent
        // subgroup streams may advance concurrently up to the configured bound.
        const { groupId, subgroupId, objectId, payload } = obj;
        for (const sub of [...track.subscribers]) {
          this.enqueueObject(track, sub, {
            groupId, subgroupId, objectId, payload, extensions, firstObject, endOfGroup,
          });
        }
      };
      publish.onSubgroupClosed = (header) => queueMicrotask(() => {
        const skey = subgroupKey(header.groupId, header.subgroupId);
        track.upstream.delete(skey);
        if (!track.sources.has(publish)) return;
        if (track.cache.finish(publish, header, this.finStreams.get(header))) { this.retireMalformed(track, conn, publish); return; }
        // onSubgroupClosed follows the final onObject from this incoming stream.
        // Its lane keeps FIN behind that subgroup's final downstream send.
        for (const sub of [...track.subscribers]) {
          sub.forwarder.enqueueClose(skey);
        }
      });
    } catch (err) {
      console.error('[relay] PUBLISH handling failed:', (err as Error).message);
    }
  }

  /** FETCH refuses unknown coverage before acceptance (d18 §10.12.3). */
  private readonly servedTracks = new WeakMap<object, Track>();
  private readonly fetchTracks = new WeakMap<object, Track>();

  async handleFetch(conn: MoqtConnection, requestId: bigint, fetch: Fetch): Promise<void> {
    conn.setFetchLargestLocationProvider(id => this.currentLargestFor(conn, id));
    const owner = conn.session.getIncomingFetch(requestId);
    let response: { conn: MoqtConnection; requestId: bigint; track: Track; malformed: boolean } | undefined;
    try {
      if (conn.draftVersion <= 16) { await conn.rejectFetch(requestId, 0x3n, 'history FETCH requires draft18 or newer'); return; }
      let track: Track | undefined, start: { group: bigint; object: bigint }, end: { group: bigint; object: bigint };
      if (fetch.fetch.fetchType === 0x1) {
        const sf = fetch.fetch as StandaloneFetch;
        if (!this.isRegisteredTrack(sf.trackNamespace, sf.trackName)) {
          await conn.rejectFetch(requestId, RequestError18.DOES_NOT_EXIST, 'unknown track'); return;
        }
        track = this.tracks.get(trackKeyOf(sf.trackNamespace, sf.trackName));
        start = sf.startLocation; end = sf.endLocation;
      } else {
        track = this.findSubscriptionTrack(conn, (fetch.fetch as { joiningRequestId: bigint }).joiningRequestId);
        const range = conn.resolveJoiningFetch(requestId);
        start = range.startLocation; end = range.endLocation;
      }
      const largest = track && this.trackHead(track);
      if (!track || !largest) throw new Error('no published head');
      const head = { group: largest.groupId, object: largest.objectId };
      if (conn.draftVersion !== 22) end = { group: end.group, object: end.object === 0n ? MAX_VI64 : end.object - 1n };
      const filter = fetch.parameters.get(0x21n)?.[0];
      if (conn.draftVersion === 22 && filter instanceof Uint8Array) {
        const window = resolveFillWindow(decodeSubscriptionFilter(filter, 22), head);
        if (!window?.end || window.end.object === undefined) throw new Error('empty relative range');
        start = window.start; end = { group: window.end.group, object: window.end.object };
      }
      if (end.group > head.group || (end.group === head.group && end.object > head.object)) end = head;
      const rows = track.cache.plan(start, end);
      if (!rows || this.historyResponses.size >= this.maxHistory) throw new Error('history unavailable');
      if (fetch.parameters.get(0x22n)?.[0] === 2n) rows.sort((a, b) => a.groupId === b.groupId ? 0 : a.groupId > b.groupId ? -1 : 1);
      this.fetchTracks.set(owner!, track);
      response = { conn, requestId, track, malformed: false }; this.historyResponses.add(response);
      const endLocation = conn.draftVersion === 22 ? end : { group: end.group, object: end.object === MAX_VI64 ? 0n : end.object + 1n };
      await conn.acceptFetch(requestId, { endLocation });
      if (response.malformed) { await conn.abortIncomingFetch(requestId, { streamErrorCode: 0x12 }); return; }
      const sid = await conn.openFetchStream(requestId);
      for (const row of rows) {
        if (response.malformed) return;
        await conn.sendFetchObject(sid, { ...row, publisherPriority: 128 });
      }
      await conn.closeFetchStream(sid);
    } catch (err) {
      if (!owner || conn.session.state !== 'established' || conn.session.getIncomingFetch(requestId) !== owner) return;
      if (owner.state === 'transferring') await conn.abortIncomingFetch(requestId, { streamErrorCode: 0 }).catch(error => log('FETCH abort failed', error));
      else if (conn.session.getIncomingFetch(requestId) === owner) {
        await conn.rejectFetch(requestId, RequestError18.INVALID_RANGE, String(err)).catch(error => log('FETCH refusal failed', error));
      }
    } finally { if (response) this.historyResponses.delete(response); }
  }

  private retireMalformed(track: Track, conn: MoqtConnection, publish: IncomingPublish): void {
    if (!isRequestStreamDraft(conn.draftVersion)) return;
    track.sources.delete(publish); // Fence callbacks even if cancellation cannot be issued.
    track.cache.clear(); delete track.largest;
    for (const sub of [...track.subscribers]) {
      sub.terminalStatus = 0x12n; sub.forwarder.abort();
      if (!sub.pending) {
        sub.retire();
        void sub.conn.terminateMalformedPublication(sub.requestId).catch(error => console.error('[relay] malformed downstream', error));
      }
    }
    for (const response of this.historyResponses) if (response.track === track) {
      response.malformed = true;
      if (response.conn.session.getIncomingFetch(response.requestId)?.responseSent) {
        void response.conn.abortIncomingFetch(response.requestId, { streamErrorCode: 0x12 }).catch(error => console.error('[relay] malformed FETCH', error));
      }
    }
    void conn.cancelMalformedIncomingPublish(publish).catch(error => console.error('[relay] malformed source', error));
  }

  /** Current upstream head for an exact live subscription or FETCH; null means known empty. */
  currentLargestFor(conn: MoqtConnection, subRequestId: bigint): { group: bigint; object: bigint } | null {
    const fetch = conn.session.getIncomingFetch(subRequestId);
    const owner = conn.session.getIncomingSubscription(subRequestId);
    const track = fetch ? this.fetchTracks.get(fetch) : owner && !owner.isTerminated ? this.servedTracks.get(owner) : undefined;
    if (!track) throw new Error('Publication unavailable');
    const largest = this.trackHead(track);
    return largest ? { group: largest.groupId, object: largest.objectId } : null;
  }

  private trackHead(track: Track): Track['largest'] {
    const merge = (head: IncomingPublish['largestLocation'] | undefined) => {
      if (head && (!track.largest || head.groupId > track.largest.groupId
          || (head.groupId === track.largest.groupId && head.objectId > track.largest.objectId))) track.largest = { ...head };
    };
    for (const source of track.sources) merge(source.largestLocation);
    return track.largest;
  }

  /** Reverse lookup: the track a given (conn, requestId) subscription belongs to. */
  private findSubscriptionTrack(conn: MoqtConnection, requestId: bigint): Track | undefined {
    for (const track of this.tracks.values()) {
      if (track.subscribers.some((s) => s.conn === conn && s.requestId === requestId)) return track;
    }
    return undefined;
  }

  private enqueueObject(track: Track, sub: Subscriber, fields: ForwardObjectFields): void {
    if (sub.conn.session.getIncomingSubscription(sub.requestId)?.isTerminated !== false) { sub.retire(); return; }
    const skey = subgroupKey(fields.groupId, fields.subgroupId);
    const retainedBytes = fields.payload.byteLength + (fields.extensions?.byteLength ?? 0);
    const result = sub.forwarder.enqueueObject(skey, fields, retainedBytes);
    if (result.status !== 'overloaded') return;
    if (sub.pending) {
      sub.terminalStatus = sub.conn.draftVersion <= 16 ? 0x6n : 0x5n;
      sub.forwarder.abort();
      return;
    }
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
      // Cancellation is not completion. Stop queued writes; the adapter resets
      // this request's open data streams (§5.1.1), without inventing a FIN.
      sub!.stopped = true;
      sub!.forwarder.abort();
      log(`subscription requestId=${requestId} unsubscribed; ${track.subscribers.length} subscriber(s) remain on this track`);
      return; // (conn, requestId) is unique to one subscription
    }
  }

  /** Drop every subscription belonging to a closed/lost connection. */
  removeConn(conn: MoqtConnection): void {
    for (const track of this.tracks.values()) {
      const removed = track.subscribers.filter((s) => s.conn === conn);
      if (removed.length > 0) {
        for (const sub of removed) { sub.stopped = true; sub.forwarder.abort(); }
        const kept = track.subscribers.filter((s) => s.conn !== conn);
        track.subscribers = kept;
        log(`removed ${removed.length} subscriber(s) on close; ${kept.length} remain on this track`);
      }
    }
  }
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
    if (sub.stopped) return;
    if (sub.conn.session.getIncomingSubscription(sub.requestId)?.isTerminated !== false) { sub.retire(); return; }
    const { groupId, subgroupId, objectId, payload, extensions, firstObject, endOfGroup } = fields;
    const skey = subgroupKey(groupId, subgroupId);
    let subgroup = sub.subgroups.get(skey);
    if (subgroup === undefined) {
      const hasExtensions = extensions !== undefined;
      const streamId = await sub.conn.openSubgroup(sub.alias, groupId, subgroupId, {
        publisherPriority: 128,
        firstObject,
        hasExtensions,
        ...(endOfGroup ? { endOfGroup: true } : {}),
      });
      subgroup = { streamId, hasExtensions };
      sub.subgroups.set(skey, subgroup);
    } else if (!subgroup.hasExtensions && extensions !== undefined) {
      throw new Error(
        `subgroup ${skey} opened without Properties/Extensions, but object ${objectId} carries them`,
      );
    }
    if (!sub.stopped) await sub.conn.sendObject(subgroup.streamId, objectId, payload, extensions);
  } catch (err) {
    console.error('[relay] FORWARD ERROR (object dropped):', (err as Error).message);
  }
}

const subgroupKey = (groupId: bigint, subgroupId: bigint): string =>
  `${groupId}/${subgroupId}`;

/** Close one outgoing subgroup after its queued objects have settled. */
async function closeSubscriberSubgroup(sub: Subscriber, skey: string): Promise<void> {
  if (sub.conn.session.getIncomingSubscription(sub.requestId)?.isTerminated !== false) { sub.retire(); return; }
  const prefix = sub.prefix.get(skey);
  const missed = prefix && windowContains({ start: sub.initialStart }, prefix.groupId, prefix.objectId);
  sub.prefix.delete(skey);
  const subgroup = sub.subgroups.get(skey);
  if (subgroup === undefined) return;
  sub.subgroups.delete(skey);
  try {
    // d18 §11.4.3: omitted eligible Objects require RESET, never a completion FIN.
    if (missed) await sub.conn.resetSubgroup(subgroup.streamId);
    else await sub.conn.closeSubgroup(subgroup.streamId);
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
