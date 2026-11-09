// A video switch whose next required group is already published when the target is accepted (drafts 14/16/18/22).
// Publisher model: a real SDK server holding an actual object cache per track; a SUBSCRIBE delivers only Objects
// published after acceptance (draft-18 §10.7); history is served only on a Joining FETCH (§10.12.2) or a
// draft-22 fill (§3.4) from that cache, with FIN on success and draft14 FETCH_ERROR / later REQUEST_ERROR / fill RESET on refusal.
// Continuation is judged from decode commands: every Object payload carries its track/group/object identity and the
// fake decoder records exactly what it was asked to decode, including switch-staged replay.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchFlags, FetchSubgroupMode, encodeFetchHeader, encodeFetchObject, MessageParam, RequestError, decodeFillParameters, decodeSubscriptionFilter, locationEncodingLength, varint, varintEncodingLength, writeLocation, writeVarint, type MoqtObject } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { PlaybackPipeline, type SyncController } from '@openmoq/playback';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { liveLocFixture } from '../test-support/live-loc.js';

type F = Awaited<ReturnType<typeof liveLocFixture>>;
type Draft = 14 | 16 | 18 | 22;
type Track = 'v' | 'v2';
type Fetch = Parameters<NonNullable<MoqtConnection['onFetch']>>[1];
type Loc = { group: bigint; object: bigint };
type Cached = Loc & { subgroup: bigint; payload: Uint8Array; extensions: Uint8Array };
type HistoryMode = 'serve' | 'refuse' | 'none';
const TRACK_ID: Record<Track, number> = { v: 1, v2: 2 }, ALIAS: Record<Track, bigint> = { v: 77n, v2: 79n };
const dec = new TextDecoder();
const loc = (g: bigint, o: bigint) => `${g}/${o}`;
const before = (a: Loc, b: Loc) => a.group < b.group || (a.group === b.group && a.object < b.object);
/** One past the Largest Object: the exclusive end of a fill that ends at Largest (draft-22 §3.4). */
const onePast = (l: Loc): Loc => ({ group: l.group, object: l.object + 1n });

/** Minimal real-SDK publisher: a per-track object cache; Largest Object is whatever the cache actually holds; a live
 *  SUBSCRIBE gets only Objects published after acceptance; history only on Joining FETCH / fill from the cache.
 *  Each Object is published on its own subgroup (subgroup id = object id), so no subgroup stream is ever reopened
 *  after FIN (draft-18 §2.2/§2.4.2), and FETCH output keeps each Object's original subgroup identity. */
function publisherOn(server: MoqtConnection, serverTransport: { createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>; uniOut: Array<{ written: Uint8Array[]; faults: { resetAfterBytes?: number } }> },
  requests: Array<{ id: bigint; name: string; parameters?: ReadonlyMap<bigint, readonly unknown[]> }>, draft: Draft) {
  const cache: Record<Track, Cached[]> = { v: [], v2: [] };
  const subscribed = new Set<Track>();
  let clockUs = 2_000_000;
  const fetches: Array<{ id: bigint; fetch: Fetch }> = [];
  const served: string[] = [];
  const resolved: Array<{ id: bigint; start: Loc; end: Loc }> = []; // publisher-resolved joining ranges, recorded at response time
  let mode: HistoryMode = 'none';
  const largestOf = (track: Track): Loc | null => { const last = cache[track].at(-1); return last ? { group: last.group, object: last.object } : null; };
  const requestOf = (name: string) => requests.find(r => r.name === name);
  server.setLargestLocationProvider(id => { const name = requests.find(r => r.id === id)?.name as Track | undefined; return name ? largestOf(name) : null; });
  function make(track: Track, group: bigint, object: bigint): Cached {
    clockUs += 20_000;
    const extensions = encodeLocHeaders({ captureTimestamp: BigInt(clockUs), videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: object === 0n, discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft) });
    if (!extensions) throw new Error('LOC headers are required for every published Object');
    return { group, object, subgroup: object, extensions, payload: Uint8Array.of(0, 0, 0, 1, object === 0n ? 0x65 : 0x41, TRACK_ID[track], Number(group), Number(object)) };
  }
  async function publish(track: Track, group: bigint, object: bigint) {
    const item = make(track, group, object); cache[track].push(item);
    if (!subscribed.has(track)) return;
    const stream = await server.openSubgroup(ALIAS[track], group, item.subgroup, { publisherPriority: 128, hasExtensions: true });
    await server.sendObject(stream, object, item.payload, item.extensions); await server.closeSubgroup(stream); await flush(128);
  }
  /** Serve the cached Objects in the half-open range [start, endExclusive) from a snapshot of the cache. */
  async function serveRange(stream: bigint, track: Track, start: Loc, endExclusive: Loc) {
    for (const item of [...cache[track]]) {
      if (before(item, start) || !before(item, endExclusive)) continue;
      await server.sendFetchObject(stream, { groupId: item.group, subgroupId: item.subgroup, objectId: item.object, publisherPriority: 128, extensions: item.extensions, payload: item.payload });
      served.push(`${track}:${loc(item.group, item.object)}`);
    }
  }
  async function serveFetch(requestId: bigint, track: Track, start: Loc, end: Loc) {
    if (draft !== 14 && draft !== 16) {
      const stream = await server.openFetchStream(requestId);
      await serveRange(stream, track, start, end);
      await server.closeFetchStream(stream);
      return;
    }
    // Legacy serving uses the actual uni stream and negotiated Object format;
    // the SDK convenience writer supports request-stream drafts only.
    const writer = (await serverTransport.createUnidirectionalStream()).getWriter();
    try {
      await writer.write(encodeFetchHeader({ requestId: varint(requestId) }));
      for (const item of [...cache[track]]) {
        if (before(item, start) || !before(item, end)) continue;
        if (draft === 14) {
          // Draft14 §10.4.4 has no serialization flags: every field is present.
          const bytes = new Uint8Array(varintEncodingLength(item.group) + varintEncodingLength(item.subgroup)
            + varintEncodingLength(item.object) + 1 + varintEncodingLength(BigInt(item.extensions.length))
            + item.extensions.length + varintEncodingLength(BigInt(item.payload.length)) + item.payload.length);
          let pos = writeVarint(varint(item.group), bytes, 0);
          pos += writeVarint(varint(item.subgroup), bytes, pos);
          pos += writeVarint(varint(item.object), bytes, pos);
          bytes[pos++] = 128;
          pos += writeVarint(varint(item.extensions.length), bytes, pos);
          bytes.set(item.extensions, pos); pos += item.extensions.length;
          pos += writeVarint(varint(item.payload.length), bytes, pos);
          bytes.set(item.payload, pos);
          await writer.write(bytes);
        } else await writer.write(encodeFetchObject({
          flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY
            | FetchFlags.EXTENSIONS | FetchSubgroupMode.EXPLICIT),
          groupId: varint(item.group), subgroupId: varint(item.subgroup),
          objectId: varint(item.object), publisherPriority: 128,
          isDatagram: false, extensions: item.extensions, payload: item.payload,
        }));
        served.push(`${track}:${loc(item.group, item.object)}`);
      }
      await writer.close();
    } finally {
      writer.releaseLock();
    }
  }
  server.onFetch = (id, fetch) => {
    fetches.push({ id, fetch });
    void (async () => {
      const req = (fetch as { fetch: { fetchType: number; joiningRequestId?: bigint; trackName?: Uint8Array; startLocation?: Loc; endLocation?: Loc } }).fetch;
      if (mode === 'refuse') {
        // Draft14 §9.18 has its own FETCH_ERROR table; history serving is unsupported here.
        await server.rejectFetch(id, draft === 14 ? 0x3n : RequestError.DOES_NOT_EXIST, 'history unavailable'); return;
      }
      if (mode !== 'serve') return;
      if (req.fetchType === 3) {                                   // Joining FETCH: publisher-resolved half-open range (§10.12.2.1)
        const range = server.resolveJoiningFetch(id); resolved.push({ id, start: range.startLocation, end: range.endLocation });
        const owner = requests.find(r => r.id === req.joiningRequestId)?.name as Track | undefined; if (!owner) return;
        await server.acceptFetch(id, { endLocation: range.endLocation });
        await serveFetch(id, owner, range.startLocation, range.endLocation);
      } else if (req.trackName && req.startLocation && req.endLocation) {   // standalone FETCH: wire end is one past the last object
        const track = dec.decode(req.trackName) as Track;
        await server.acceptFetch(id, { endLocation: req.endLocation });
        await serveFetch(id, track, req.startLocation, req.endLocation);
      }
    })().catch(error => { served.push(`responder-error:${String(error).slice(0, 120)}`); });
  };
  /** draft-22: answer FILL_PARAMETERS on an accepted SUBSCRIBE — FIN on success, transport RESET on refusal. */
  async function answerFill(track: Track) {
    const req = requestOf(track); const raw = req?.parameters?.get(0x23n)?.[0];
    if (!(raw instanceof Uint8Array) || mode === 'none') return null;
    const params = decodeFillParameters(raw); const largest = largestOf(track);
    const start: Loc = params.filter?.type === 'AbsoluteStart' ? { group: params.filter.startGroup, object: params.filter.startObject } : { group: 0n, object: 0n };
    if (!largest || !before(start, onePast(largest))) return { params, opened: false, reset: false }; // §3.4: empty range opens no stream
    const stream = await server.openFillStream(req!.id);
    if (mode === 'refuse') {
      const pipe = serverTransport.uniOut.at(-1)!; pipe.faults.resetAfterBytes = pipe.written.reduce((n, c) => n + c.length, 0); // RESET at the next write
      const item = [...cache[track]].find(c => !before(c, start))!;
      try { await server.sendFetchObject(stream, { groupId: item.group, subgroupId: item.subgroup, objectId: item.object, publisherPriority: 128, extensions: item.extensions, payload: item.payload }); } catch { /* reset */ }
      return { params, opened: true, reset: true };
    }
    await serveRange(stream, track, start, onePast(largest)); await server.closeFetchStream(stream); return { params, opened: true, reset: false };
  }
  /** SUBSCRIBE_OK carries the Largest Object actually in the cache: the saved Joining Location (d18 §5.1) and the fill bound (d22 §3.4). */
  async function accept(track: Track) {
    const req = requestOf(track); if (!req) throw new Error(`no ${track} SUBSCRIBE to accept`);
    const largest = largestOf(track);
    const location = largest && { group: varint(largest.group), object: varint(largest.object) };
    const legacyLargest = (draft === 14 || draft === 16) && location
      ? new Uint8Array(locationEncodingLength(location)) : undefined;
    if (legacyLargest && location) writeLocation(location, legacyLargest, 0);
    await server.acceptSubscribe(req.id, ALIAS[track], largest
      ? { parameters: new Map([[MessageParam.LARGEST_OBJECT, [legacyLargest ?? largest]]]) }
      : undefined);
    subscribed.add(track); await flush(256); return req;
  }
  return { cache, fetches, served, resolved, largestOf, publish, answerFill, requestOf, accept,
    setMode(next: HistoryMode) { mode = next; },
    markSubscribed(track: Track) { subscribed.add(track); },
    joiningFor(track: Track) { const id = requestOf(track)?.id; return fetches.filter(({ fetch }) => (fetch as { fetch: { fetchType: number; joiningRequestId?: bigint } }).fetch.fetchType === 3 && (fetch as { fetch: { joiningRequestId?: bigint } }).fetch.joiningRequestId === id); },
    fillOf(track: Track) { const raw = requestOf(track)?.parameters?.get(0x23n)?.[0]; return raw instanceof Uint8Array ? decodeFillParameters(raw) : null; },
    filterOf(track: Track) { const raw = requestOf(track)?.parameters?.get(MessageParam.SUBSCRIPTION_FILTER)?.[0]; return raw instanceof Uint8Array ? decodeSubscriptionFilter(raw, draft) : null; } };
}
function publisher(f: F, draft: Draft) {
  const pub = publisherOn(f.server, f.b as unknown as Parameters<typeof publisherOn>[1], f.requests, draft);
  pub.markSubscribed('v');
  return Object.assign(pub, { async acceptTarget() { await pub.accept('v2'); } });
}

/** Decode-command identities: what the decoder was actually asked to decode, in order, including staged replay. */
function decodes(f: F) {
  const log: Array<{ track: Track; group: bigint; object: bigint; type: string; afterSwitch: boolean }> = []; let switched = false; const events: string[] = [];
  vi.mocked(f.video.decode).mockImplementation((chunk, time, input) => {
    const data = (chunk as { data?: Uint8Array }).data ?? new Uint8Array();
    const track = data[5] === TRACK_ID.v ? 'v' : data[5] === TRACK_ID.v2 ? 'v2' : (`unknown(${data[5]})` as Track);
    log.push({ track, group: BigInt(data[6] ?? -1), object: BigInt(data[7] ?? -1), type: String((chunk as { type?: string }).type), afterSwitch: switched });
    f.video.onFrame?.({ timestamp: chunk.timestamp, close() {} } as never, time, null, input as never);
  });
  for (const type of ['quality_switching', 'quality_switched', 'quality_switch_failed'] as const) f.player.on(type, e => { if (type === 'quality_switched') switched = true; events.push(`${type}:${(e as { toTrackName?: string }).toTrackName ?? ''}`); });
  return { log, events, of: (track: Track) => log.filter(d => d.track === track).map(d => loc(d.group, d.object)), firstAfterSwitch: () => log.find(d => d.afterSwitch) ?? null };
}
/** Read-only fixture inspection; no clock/reference mutation or acoustic claim. */
function inspectTiming(f: F) {
  const owned = f.player as unknown as {
    readonly syncController: Pick<SyncController, 'reset'> | null;
    readonly clock: { now(): number };
  };
  if (!owned.syncController) throw new Error('Playing fixture must own a shared sync controller');
  return { reset: vi.spyOn(owned.syncController, 'reset'), now: () => owned.clock.now() };
}
async function settle(f: F, ticks = 12) { for (let i = 0; i < ticks; i++) { f.tick(1); await flush(64); } await flush(256); }

/** Per-object subgroup FIN does not end a whole video Group. Let one actual
 *  existing unfinished-group wait elapse before the next publication burst.
 *  This is one policy-window advancement, not polling until decode succeeds. */
async function playOutGroupBoundary(f: F) {
  f.tick(1); await flush(256); // Apply current tolerance and arm any boundary wait.
  const owned = f.player as unknown as {
    readonly clock: { now(): number };
    readonly videoPipeline: { readonly gapDetector: { readonly gapTimeoutUs: number } } | null;
  };
  const waitUs = owned.videoPipeline?.gapDetector.gapTimeoutUs;
  if (waitUs === undefined || !Number.isFinite(waitUs) || waitUs <= 0) throw new Error('Expected an existing finite video group wait');
  const fromUs = owned.clock.now(), ticks = Math.ceil(waitUs / 20_000) + 1;
  await settle(f, ticks);
  const elapsedUs = owned.clock.now() - fromUs;
  expect(elapsedUs, 'one existing group-wait window elapsed on the controlled clock').toBeGreaterThan(waitUs);
  return { waitUs, elapsedUs, ticks };
}
/** v plays four groups; returns the group the LOC pipeline is actually decoding (it keeps one group buffered). */
async function playV(f: F, pub: ReturnType<typeof publisher>) {
  f.player.play();
  for (let g = 0n; g < 4n; g++) { await pub.publish('v', g, 0n); f.tick(2); await pub.publish('v', g, 1n); f.tick(2); }
  await settle(f, 4); const cur = f.currentVideoGroup(); expect(cur).not.toBeNull(); return cur!;
}

describe.each([14, 16, 18, 22] as const)('video switch behind the live edge, draft %s', draft => {
  afterEach(() => vi.restoreAllMocks());

  async function behind(mode: HistoryMode) {
    const f = await liveLocFixture({}, draft); const pub = publisher(f, draft); const d = decodes(f); pub.setMode(mode);
    try {
      const cur = await playV(f, pub), next = cur + 1n, edge = cur + 2n;
      for (const g of [next, edge]) { await pub.publish('v2', g, 0n); await pub.publish('v2', g, 1n); }
      expect(pub.largestOf('v2')).toEqual({ group: edge, object: 1n });
      const fetchCancel = vi.spyOn(f.client, 'fetchCancel');
      const cancelFill = vi.spyOn(f.client, 'cancelFill');
      const refusedRequests: bigint[] = [];
      const onMessage = f.client.onMessage;
      f.client.onMessage = message => {
        if (message.type === 'REQUEST_ERROR') refusedRequests.push(BigInt(message.requestId));
        onMessage?.(message);
      };
      const timing = inspectTiming(f), openedAtUs = timing.now();
      const switching = f.player.selectVideoTrack('v2'); switching.catch(() => {}); await flush(256);
      expect(f.requestOf('v2'), 'target SUBSCRIBE issued').toBeDefined();
      await pub.acceptTarget();
      const fill = draft === 22 ? await pub.answerFill('v2') : null;
      const requested = draft !== 22 ? pub.joiningFor('v2').length > 0 : pub.fillOf('v2') !== null;
      if (mode === 'refuse' && draft !== 22) {
        const request = pub.joiningFor('v2')[0];
        expect(request, 'refused history request exists').toBeDefined();
        expect(refusedRequests, 'peer refusal observed for this history request').toContain(request!.id);
        expect(fetchCancel, 'peer-refused FETCH must not be cancelled after REQUEST_ERROR').not.toHaveBeenCalled();
      }
      // Admit/drain prefix+edge before publishing enough later groups to exceed
      // the existing three-group backlog policy. Each later group is paced too.
      await pub.publish('v2', edge, 2n);
      const groupWaits: Awaited<ReturnType<typeof playOutGroupBoundary>>[] = [];
      if (mode === 'serve') groupWaits.push(await playOutGroupBoundary(f));
      else await settle(f, 4);
      const prefixDecoded = d.of('v2').slice();
      const beforeDeadlineEvents = d.events.slice(), beforeAdvanceUs = timing.now();
      if (mode === 'none') {
        // WarmStartHead's existing default is 1,000,000us; this fixture's
        // public tick advances its controlled clock by 20,000us per tick.
        // A subsequent actual live Object observes expiry; no wall sleep or
        // microtask-only inference substitutes for this elapsed deadline.
        f.tick(51); await flush(256);
      }
      const afterAdvanceUs = timing.now();
      for (const g of [edge + 1n, edge + 2n]) {
        await pub.publish('v2', g, 0n); await pub.publish('v2', g, 1n);
        groupWaits.push(await playOutGroupBoundary(f));
      }
      await settle(f);
      return { f, pub, d, cur, next, edge, fill, reset: timing.reset, prefixDecoded, groupWaits, fetchCancel, cancelFill,
        timeout: { requested, openedAtUs, beforeAdvanceUs, afterAdvanceUs, beforeDeadlineEvents } };
    } catch (error) { await f.close(); throw error; }
  }

  it('continues the target rendition through the gap: history retrieved from the publisher cache, then the live edge, each Object decoded once in order', async () => {
    const shed = vi.spyOn(PlaybackPipeline.prototype as unknown as { shedBacklog(): void }, 'shedBacklog');
    const { f, pub, d, next, edge, fill, prefixDecoded, groupWaits } = await behind('serve');
    try {
      const v2 = d.of('v2');
      console.log(`[switch d${draft}] filter=${JSON.stringify(pub.filterOf('v2'), (_k, v) => typeof v === 'bigint' ? String(v) : v)} joining=${pub.joiningFor('v2').length} fill=${fill ? JSON.stringify(fill.params, (_k, v) => typeof v === 'bigint' ? String(v) : v) : null} served=${pub.served.join(',') || '-'} waits=${JSON.stringify(groupWaits)} decodedV2=${v2.join(',')} events=${d.events.join(' | ')} errors=${JSON.stringify(f.errors)}`);
      // Required continuation: from the next required group, contiguous and exactly once, through the live edge.
      const expected = [loc(next, 0n), loc(next, 1n), loc(edge, 0n), loc(edge, 1n), loc(edge, 2n), loc(edge + 1n, 0n), loc(edge + 1n, 1n), loc(edge + 2n, 0n), loc(edge + 2n, 1n)];
      expect(v2.slice(0, expected.length), 'target decode sequence through the gap').toEqual(expected);
      expect(prefixDecoded, 'history and edge were decoded before later groups were published').toEqual(expected.slice(0, 5));
      expect(shed, 'paced playout does not invoke the existing backlog-shedding policy').not.toHaveBeenCalled();
      expect(d.firstAfterSwitch()?.type).toBe('key');
      // The history that made it possible must have been requested with exact identity (owner = the target SUBSCRIBE, start = next required group).
      if (draft === 14 || draft === 16) expect(pub.filterOf('v2'), 'legacy Joining FETCH requires LargestObject').toMatchObject({ type: 'LargestObject' });
      if (draft !== 22) {
        const joins = pub.joiningFor('v2'); expect(joins, 'a Joining FETCH joined to the target SUBSCRIBE').toHaveLength(1);
        expect(pub.resolved.find(r => r.id === joins[0]!.id)?.start, 'publisher-resolved joining start').toEqual({ group: next, object: 0n });
      } else {
        expect(fill?.params.filter, 'FILL_PARAMETERS start at the next required group').toMatchObject({ type: 'AbsoluteStart', startGroup: next, startObject: 0n });
        expect(fill?.opened).toBe(true); expect(fill?.reset).toBe(false);
      }
      // The Object exactly at the joining end (edge/2, published live after acceptance) is served by the live subscription once, never by the prefix.
      expect(pub.served).toEqual([`v2:${loc(next, 0n)}`, `v2:${loc(next, 1n)}`, `v2:${loc(edge, 0n)}`, `v2:${loc(edge, 1n)}`]);
      expect(v2.filter(l => l === loc(edge, 2n))).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  if (draft !== 14) it('control: next required group still in the future — the subscription alone continues contiguously from an independent start; no bogus past media', async () => {
    const f = await liveLocFixture({}, draft); const pub = publisher(f, draft); const d = decodes(f); pub.setMode('serve');
    try {
      const cur = await playV(f, pub), next = cur + 1n;
      for (const g of [0n, 1n, cur]) { await pub.publish('v2', g, 0n); await pub.publish('v2', g, 1n); } // v2 cache ends at the current group
      expect(pub.largestOf('v2')).toEqual({ group: cur, object: 1n });
      const switching = f.player.selectVideoTrack('v2'); switching.catch(() => {}); await flush(256);
      await pub.acceptTarget(); const fill = draft === 22 ? await pub.answerFill('v2') : null; // an empty fill request is legitimate: §3.4 opens no stream
      for (const g of [next, next + 1n]) { await pub.publish('v2', g, 0n); await pub.publish('v2', g, 1n); }
      await settle(f);
      const v2 = d.of('v2');
      console.log(`[switch d${draft} future] decodedV2=${v2.join(',')} fill=${fill ? JSON.stringify({ opened: fill.opened }) : null} served=${pub.served.join(',') || '-'} events=${d.events.join(' | ')} errors=${JSON.stringify(f.errors)}`);
      expect(v2.slice(0, 4)).toEqual([loc(next, 0n), loc(next, 1n), loc(next + 1n, 0n), loc(next + 1n, 1n)]);
      expect(v2.some(l => BigInt(l.split('/')[0]!) <= cur), 'no past media on the target').toBe(false);
      expect(d.firstAfterSwitch()?.type).toBe('key');
      if (fill) expect(fill.opened, 'draft 22: no fill stream when the range starts after Largest').toBe(false);
      expect(pub.served).toEqual([]);
      expect(d.events.some(e => e.startsWith('quality_switched'))).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  if (draft !== 14) it('control: unanswered history crosses the existing prefix deadline before independent live fallback; nothing is invented for the skipped groups', async () => {
    const { f, pub, d, next, edge, reset, timeout, fetchCancel, cancelFill } = await behind('none');
    try {
      const v2 = d.of('v2');
      expect(timeout.requested, 'unanswered history was actually requested before advancing the deadline').toBe(true);
      expect(timeout.beforeDeadlineEvents.some(e => e.startsWith('quality_switched')), 'no pre-deadline adoption').toBe(false);
      expect(timeout.afterAdvanceUs - timeout.beforeAdvanceUs).toBe(1_020_000);
      expect(timeout.afterAdvanceUs - timeout.openedAtUs, 'actual controlled prefix age exceeds the existing one-second limit').toBeGreaterThan(1_000_000);
      console.log(`[switch d${draft} no-history] decodedV2=${v2.join(',')} served=${pub.served.join(',') || '-'} events=${d.events.join(' | ')} errors=${JSON.stringify(f.errors)}`);
      expect(pub.served).toEqual([]);
      if (draft === 22) {
        const targetRequestId = pub.requestOf('v2')!.id;
        expect(cancelFill.mock.calls.filter(([id]) => id === targetRequestId),
          'timeout cancels this initial fill exactly once, excluding old-owner retirement').toHaveLength(1);
      }
      else expect(fetchCancel).toHaveBeenCalledExactlyOnceWith(pub.joiningFor('v2')[0]!.id);
      expect(v2.some(l => l.startsWith(`${next}/`) || l.startsWith(`${edge}/`)), 'skipped groups are not fabricated').toBe(false);
      expect(d.firstAfterSwitch()?.type).toBe('key');
      expect(v2[0]).toBe(loc(edge + 1n, 0n));
      expect(d.events.some(e => e.startsWith('quality_switched'))).toBe(true);
      expect(reset, 'timeout fallback preserves the existing shared-sync re-anchor policy').toHaveBeenCalledTimes(1);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('control: history refused (draft14 FETCH_ERROR / draft16/18 REQUEST_ERROR / draft22 fill RESET) — the switch still lands from the live edge on an independent Object', async () => {
    const { f, pub, d, next, edge, fill, reset } = await behind('refuse');
    try {
      const v2 = d.of('v2');
      const requested = draft !== 22 ? pub.joiningFor('v2').length > 0 : fill?.opened === true;
      console.log(`[switch d${draft} refusal] requested=${requested} decodedV2=${v2.join(',')} events=${d.events.join(' | ')} errors=${JSON.stringify(f.errors)}`);
      // Refusal is meaningful only after the history request was actually issued.
      expect(requested, 'history request issued so that the refusal can be exercised').toBe(true);
      expect(v2.some(l => l.startsWith(`${next}/`) || l.startsWith(`${edge}/`))).toBe(false);
      expect(d.firstAfterSwitch()?.type).toBe('key');
      expect(v2[0]).toBe(loc(edge + 1n, 0n));
      expect(d.events.some(e => e.startsWith('quality_switched'))).toBe(true);
      expect(reset, 'refusal fallback preserves the existing shared-sync re-anchor policy').toHaveBeenCalledTimes(1);
      expect(f.errors, 'no error beyond an explicitly allowed non-fatal diagnostic (none defined yet)').toEqual([]);
    } finally { await f.close(); }
  });
});

/** Direct SDK controls for the publisher responders (no player): a client subscribes to v2 at the live edge and requests
 *  history itself, independently checking the serve/refuse responders. */
describe.each([16, 18, 22] as const)('publisher responders under direct SDK requests, draft %s', draft => {
  async function pair() {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
    const requests: Array<{ id: bigint; name: string; parameters?: ReadonlyMap<bigint, readonly unknown[]> }> = [];
    server.onSubscribe = (id, _ns, name, parameters) => { requests.push({ id, name: dec.decode(name), ...(parameters ? { parameters } : {}) }); };
    const connected = server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {}); void connected.catch(() => {});
    await client.connect(a);
    const pub = publisherOn(server, b as unknown as Parameters<typeof publisherOn>[1], requests, draft);
    for (const g of [4n, 5n]) { await pub.publish('v2', g, 0n); await pub.publish('v2', g, 1n); } // history in the cache only
    const headers: Array<{ id: bigint; fill: boolean; requestId: bigint }> = [], fillObjects: string[] = [], terminals: Array<{ id: bigint; terminal: string }> = [];
    client.onDataStream = (id, header) => { if (header.type === 'fetch') headers.push({ id, fill: !!(header as { fill?: boolean }).fill, requestId: header.header.requestId }); };
    client.onObject = (id, object) => { if (headers.some(h => h.id === id && h.fill) && object.kind === 'data') fillObjects.push(`${object.groupId}/${object.objectId}@sg${object.subgroupId}`); };
    client.onStreamClosed = (id, _error, terminal) => { terminals.push({ id, terminal }); };
    return { client, server, pub, requests, headers, fillObjects, terminals, async close() { await client.close(); await server.close(); await connected.catch(() => {}); } };
  }
  const enc = new TextEncoder();
  /** subscribeTrack resolves only after SUBSCRIBE_OK: accept on the server while the request is pending. */
  async function subscribeV2(p: Awaited<ReturnType<typeof pair>>, options: object) {
    const pending = p.client.subscribeTrack([enc.encode('live')], enc.encode('v2'), options as never);
    pending.catch(() => {});
    await flush(256); const req = await p.pub.accept('v2');
    return { sub: await pending, req };
  }

  it('serves the half-open Joining FETCH / fill range from the cache with original subgroup identity and FINs; the Object at the end is not part of it', async () => {
    const p = await pair(); p.pub.setMode('serve');
    try {
      const received: string[] = [], liveObjects: string[] = [];
      const { sub, req } = await subscribeV2(p, { filter: { type: 'LargestObject' }, onObject: (o: MoqtObject) => { if (o.kind === 'data') liveObjects.push(`${o.groupId}/${o.objectId}`); },
        ...(draft === 22 ? { fill: { filter: { type: 'AbsoluteStart' as const, startGroup: 4n, startObject: 0n }, groupOrder: 'ascending' as const } } : {}) });
      expect(sub.initialLargestLocation).toEqual({ groupId: 5n, objectId: 1n });
      let terminal: string | null = null;
      if (draft !== 22) {
        await p.client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: req.id, joiningStart: 4n, receiver: { onObject: (o: MoqtObject) => { if (o.kind === 'data') received.push(`${o.groupId}/${o.objectId}@sg${o.subgroupId}`); }, onClosed: (tm: string) => { terminal = tm; } } } as never);
        await flush(512);
        expect(p.pub.joiningFor('v2')).toHaveLength(1);
        // Half-open range as the publisher resolved it: end is one past the Joining Location {5,1} (d18 §10.12.2.1).
        expect(p.pub.resolved).toEqual([{ id: p.pub.joiningFor('v2')[0]!.id, start: { group: 4n, object: 0n }, end: { group: 5n, object: 2n } }]);
      } else {
        const fill = await p.pub.answerFill('v2'); await flush(512);
        expect(fill).toMatchObject({ opened: true, reset: false }); received.push(...p.fillObjects);
        const fillStream = p.headers.find(h => h.fill && h.requestId === req.id); expect(fillStream).toBeDefined();
        terminal = p.terminals.find(t => t.id === fillStream!.id)?.terminal ?? null;
      }
      // Then the live subscription publishes the Object exactly at the end of the history range.
      await p.pub.publish('v2', 5n, 2n); await flush(256);
      expect(received).toEqual(['4/0@sg0', '4/1@sg1', '5/0@sg0', '5/1@sg1']);
      expect(p.pub.served).toEqual(['v2:4/0', 'v2:4/1', 'v2:5/0', 'v2:5/1']);
      expect(terminal).toBe('fin');
      expect(liveObjects).toEqual(['5/2']);
    } finally { await p.close(); }
  });

  it('refuses history: draft 16/18 REQUEST_ERROR on the Joining FETCH, draft 22 fill stream RESET after its header; the live subscription is untouched', async () => {
    const p = await pair(); p.pub.setMode('refuse');
    try {
      const liveObjects: string[] = [];
      const { req } = await subscribeV2(p, { filter: { type: 'LargestObject' }, onObject: (o: MoqtObject) => { if (o.kind === 'data') liveObjects.push(`${o.groupId}/${o.objectId}`); },
        ...(draft === 22 ? { fill: { filter: { type: 'AbsoluteStart' as const, startGroup: 4n, startObject: 0n }, groupOrder: 'ascending' as const } } : {}) });
      if (draft !== 22) {
        const closed: string[] = [], got: string[] = [];
        await p.client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: req.id, joiningStart: 4n, receiver: { onObject: (o: MoqtObject) => { got.push(`${o.groupId}/${o.objectId}`); }, onClosed: (terminal: string) => { closed.push(terminal); } } } as never);
        await flush(512);
        expect(p.pub.joiningFor('v2')).toHaveLength(1);
        expect(closed, 'REQUEST_ERROR ends the fetch receiver with an error terminal').toEqual(['error']); expect(got).toEqual([]);
      } else {
        const fill = await p.pub.answerFill('v2'); await flush(512);
        expect(fill).toMatchObject({ opened: true, reset: true });
        const fillStream = p.headers.find(h => h.fill && h.requestId === req.id); expect(fillStream).toBeDefined();
        expect(p.terminals.find(t => t.id === fillStream!.id)?.terminal).toBe('reset');
      }
      expect(p.pub.served).toEqual([]);
      await p.pub.publish('v2', 5n, 2n); await flush(256);
      expect(liveObjects).toEqual(['5/2']);
    } finally { await p.close(); }
  });
});
