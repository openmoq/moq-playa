/**
 * Ordinary MSE (CMAF) video switch behind the live edge when the OUTGOING
 * group is only partially committed. The only proven group frontier the
 * player owns is the adapter's committed group floor, which advances on ANY
 * successful fragment append of a group. A partially appended Group N
 * therefore reads floor = N while N's tail was never appended, so a switch
 * that starts the target at N+1 preserves the hole. Repair policy under
 * test: the target retrieves history from the start of N (the whole
 * independent group), not N+1.
 *
 * Evidence classes are kept apart and named:
 *   - control:    SUBSCRIBE / Joining FETCH / fill requests and their publisher-resolved ranges;
 *   - submission: appendChunk calls from the player into the real MseMediaSource (track/group/identity read from the bytes);
 *   - modeled browser API: MockSourceBuffer appendBuffer + update/updateend driving the adapter's own floor and its
 *     observeAppends 'appended' terminals. No real Chrome, codec or presentation is involved.
 *
 * Real SDK loopback (draft 18; draft 22 fill where cheap), real MoqtPlayer,
 * real CmafAssembler and MseMediaSource, parsed CMAF chunks with an explicit
 * timescale and baseMediaDecodeTime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import { MseMediaSource } from '../../browser/src/mse-adapter.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, RequestError, decodeFillParameters, varint, type MoqtObject } from '@openmoq/transport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';
import type { CatalogTrack } from '@openmoq/msf';
import type { MediaAppendObservation } from './interfaces.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../../browser/test-support/mse-native.js';

type Draft = 18 | 22;
type Track = 'video' | 'nextVideo';
type Loc = { group: bigint; object: bigint };
type Cached = { group: bigint; object: bigint; subgroup: bigint; payload: Uint8Array };
type HistoryMode = 'none' | 'serve' | 'refuse';
const ALIAS: Record<Track, bigint> = { video: 10n, nextVideo: 11n };
const TRACK_ID: Record<Track, number> = { video: 0xa1, nextVideo: 0xb2 };
const TIMESCALE = 1000, SAMPLE_MS = 20, OBJECTS_PER_GROUP = 3n, GROUP_MS = SAMPLE_MS * Number(OBJECTS_PER_GROUP);
const dec = new TextDecoder();
const loc = (g: bigint, o: bigint) => `${g}/${o}`;
const before = (a: Loc, b: Loc) => a.group < b.group || (a.group === b.group && a.object < b.object);
const onePast = (l: Loc): Loc => ({ group: l.group, object: l.object + 1n });
/** Explicit source timeline: every Object is one 20 ms sample; group g starts at g*60 ms (timescale 1000). */
const bmdtOf = (group: bigint, object: bigint) => Number(group) * GROUP_MS + Number(object) * SAMPLE_MS;
const INIT = buildInit({ trackId: 1, timescale: TIMESCALE, handler: 'vide' });
const INIT_CTX = parseLocmafTrackContext(INIT);
const SOURCE_KEY: Record<Track, string> = { video: JSON.stringify([['review', 'picture'], 'video']), nextVideo: JSON.stringify([['review', 'picture'], 'nextVideo']) };

let native: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); native = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return native; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:review', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Microtasks, then one timer turn (the SDK replays pre-ACK parked Objects on setTimeout(0)), then microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 512; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 0; i < 512; i++) await Promise.resolve();
}

/** Identity carried in the bytes: mdat = [track id, group, object, 0xee]; bmdt parsed from the moof. */
function identify(bytes: Uint8Array): { track: Track | string; group: bigint; object: bigint; bmdt: number } | null {
  if (String.fromCharCode(...bytes.subarray(4, 8)) !== 'moof') return null;
  const tail = bytes.subarray(bytes.length - 4);
  const track = tail[0] === TRACK_ID.video ? 'video' : tail[0] === TRACK_ID.nextVideo ? 'nextVideo' : `unknown(${tail[0]})`;
  return { track, group: BigInt(tail[1]!), object: BigInt(tail[2]!), bmdt: Number(readCmafChunkSamples(bytes, INIT_CTX).effective.baseMediaDecodeTime) };
}

/** Minimal real-SDK CMAF publisher: per-track cache; Largest is what the cache holds; a live SUBSCRIBE gets only Objects
 *  published after acceptance; history only via Joining FETCH (18) / fill (22) from the cache. One retained subgroup stream
 *  per (track, group), FIN'd only when the test closes the group; FETCH output keeps the original subgroup identity (0). */
function publisherOn(server: MoqtConnection, serverTransport: { uniOut: Array<{ written: Uint8Array[]; faults: { resetAfterBytes?: number } }> },
  requests: Array<{ id: bigint; name: string; parameters?: ReadonlyMap<bigint, readonly unknown[]> }>) {
  const cache: Record<Track, Cached[]> = { video: [], nextVideo: [] };
  const subscribed = new Set<Track>();
  const streams = new Map<string, bigint>();
  const fetches: Array<{ id: bigint; fetch: { fetch: { fetchType: number; joiningRequestId?: bigint } } }> = [];
  const served: string[] = [];
  const resolved: Array<{ id: bigint; start: Loc; end: Loc }> = [];
  let mode: HistoryMode = 'none';
  const largestOf = (track: Track): Loc | null => { const last = cache[track].at(-1); return last ? { group: last.group, object: last.object } : null; };
  const requestOf = (name: Track) => requests.find(r => r.name === name);
  server.setLargestLocationProvider(id => { const name = requests.find(r => r.id === id)?.name as Track | undefined; return name ? largestOf(name) : null; });
  function make(track: Track, group: bigint, object: bigint, dependent = false): Cached {
    const payload = buildChunk({ trackId: 1, bmdt: BigInt(bmdtOf(group, object)), samples: [{ duration: SAMPLE_MS, size: 4, flags: object === 0n && !dependent ? SYNC_FLAGS : NON_SYNC_FLAGS }],
      mdat: Uint8Array.of(TRACK_ID[track], Number(group), Number(object), 0xee) });
    return { group, object, subgroup: 0n, payload };
  }
  /** Publish into the cache and, when subscribed, onto the group's retained subgroup stream. */
  async function publish(track: Track, group: bigint, object: bigint, options: { closeGroup?: boolean; dependent?: boolean } = {}) {
    const item = make(track, group, object, options.dependent); cache[track].push(item);
    if (subscribed.has(track)) {
      const key = `${track}:${group}`;
      const stream = streams.get(key) ?? await server.openSubgroup(ALIAS[track], group, 0n, { publisherPriority: 128, endOfGroup: true });
      streams.set(key, stream);
      await server.sendObject(stream, object, item.payload);
      if (options.closeGroup) { await server.closeSubgroup(stream); streams.delete(key); }
    }
    await settle();
  }
  async function publishGroup(track: Track, group: bigint) { for (let o = 0n; o < OBJECTS_PER_GROUP; o++) await publish(track, group, o, { closeGroup: o === OBJECTS_PER_GROUP - 1n }); }
  async function serveRange(stream: bigint, track: Track, start: Loc, endExclusive: Loc) {
    for (const item of [...cache[track]]) {
      if (before(item, start) || !before(item, endExclusive)) continue;
      await server.sendFetchObject(stream, { groupId: item.group, subgroupId: item.subgroup, objectId: item.object, publisherPriority: 128, payload: item.payload });
      served.push(`${track}:${loc(item.group, item.object)}`);
    }
  }
  server.onFetch = (id, fetch) => {
    const req = (fetch as { fetch: { fetchType: number; joiningRequestId?: bigint; trackName?: Uint8Array; startLocation?: Loc; endLocation?: Loc } }).fetch;
    fetches.push({ id, fetch: { fetch: { fetchType: req.fetchType, ...(req.joiningRequestId === undefined ? {} : { joiningRequestId: req.joiningRequestId }) } } });
    void (async () => {
      if (mode === 'refuse') { await server.rejectFetch(id, RequestError.DOES_NOT_EXIST, 'history unavailable'); return; }
      if (mode !== 'serve') return;
      if (req.fetchType === 3) {                                   // Joining FETCH: publisher-resolved half-open range (d18 §10.12.2.1)
        const range = server.resolveJoiningFetch(id); resolved.push({ id, start: range.startLocation, end: range.endLocation });
        const owner = requests.find(r => r.id === req.joiningRequestId)?.name as Track | undefined; if (!owner) return;
        await server.acceptFetch(id, { endLocation: range.endLocation });
        const stream = await server.openFetchStream(id); await serveRange(stream, owner, range.startLocation, range.endLocation); await server.closeFetchStream(stream);
      } else if (req.trackName && req.startLocation && req.endLocation) {   // standalone FETCH: the wire end is one past the last Object
        const track = dec.decode(req.trackName) as Track;
        await server.acceptFetch(id, { endLocation: req.endLocation });
        const stream = await server.openFetchStream(id); await serveRange(stream, track, req.startLocation, req.endLocation); await server.closeFetchStream(stream);
      }
    })().catch(error => { served.push(`responder-error:${String(error).slice(0, 120)}`); });
  };
  /** draft-22: answer FILL_PARAMETERS on an accepted SUBSCRIBE: FIN on success, transport RESET on refusal, no stream for an empty range (§3.4). */
  async function answerFill(track: Track) {
    const req = requestOf(track); const raw = req?.parameters?.get(0x23n)?.[0];
    if (!(raw instanceof Uint8Array) || mode === 'none') return null;
    const params = decodeFillParameters(raw); const largest = largestOf(track);
    const start: Loc = params.filter?.type === 'AbsoluteStart' ? { group: params.filter.startGroup, object: params.filter.startObject } : { group: 0n, object: 0n };
    if (!largest || !before(start, onePast(largest))) return { params, start, opened: false, reset: false };
    const stream = await server.openFillStream(req!.id);
    if (mode === 'refuse') {
      const pipe = serverTransport.uniOut.at(-1)!; pipe.faults.resetAfterBytes = pipe.written.reduce((n, c) => n + c.length, 0);
      const item = [...cache[track]].find(c => !before(c, start))!;
      try { await server.sendFetchObject(stream, { groupId: item.group, subgroupId: item.subgroup, objectId: item.object, publisherPriority: 128, payload: item.payload }); } catch { /* reset */ }
      return { params, start, opened: true, reset: true };
    }
    await serveRange(stream, track, start, onePast(largest)); await server.closeFetchStream(stream); return { params, start, opened: true, reset: false };
  }
  /** SUBSCRIBE_OK carries the Largest Object actually in the cache (saved Joining Location, d18 §5.1; fill bound, d22 §3.4). */
  async function accept(track: Track) {
    const req = requestOf(track); if (!req) throw new Error(`no ${track} SUBSCRIBE to accept`);
    const largest = largestOf(track);
    await server.acceptSubscribe(req.id, ALIAS[track], largest ? { parameters: new Map([[MessageParam.LARGEST_OBJECT, [largest]]]) } : undefined);
    subscribed.add(track); await settle(); return req;
  }
  return { cache, fetches, served, resolved, largestOf, publish, publishGroup, answerFill, requestOf, accept,
    setMode(next: HistoryMode) { mode = next; },
    joiningFor(track: Track) { const id = requestOf(track)?.id; return fetches.filter(({ fetch }) => fetch.fetch.fetchType === 3 && fetch.fetch.joiningRequestId === id); },
    fillOf(track: Track) { const raw = requestOf(track)?.parameters?.get(0x23n)?.[0]; return raw instanceof Uint8Array ? decodeFillParameters(raw) : null; } };
}

interface Submission { track: string; group: bigint; object: bigint; bmdt: number; groupArg: bigint | undefined; trackArg: string; token: object | undefined; index: number }
interface Terminal { track: string; group: bigint; object: bigint; bmdt: number; state: MediaAppendObservation['state']; reason: MediaAppendObservation['reason'] }
/** Modeled browser API terminal: one appendBuffer call on a MockSourceBuffer. 'appended' requires the double's `update` witness
 *  before `updateend`; `error`+`updateend` is 'failed'; `updateend` alone (abort) is 'unproven'. */
interface Modeled { track: string; group: bigint; object: bigint; bmdt: number; state: 'appended' | 'failed' | 'unproven' }

async function fixture(draft: Draft, options: { transform?: MoqtPlayerConfig['objectTransform']; controlledClock?: boolean } = {}) {
  // Boundary arms need the player's own clock to cross the head's finite-prefix deadline; performance.now is not faked by vitest's
  // fake timers, so those arms inject the existing `clock` config and advance it together with the timers.
  let nowUs = 0; const clock = { now: () => nowUs };
  const advance = async (ms: number) => { nowUs += ms * 1000; await vi.advanceTimersByTimeAsync(ms); await settle(); };
  // Preparation class: target Objects whose objectTransform has COMPLETED (after any held promise resolves), in completion order.
  const prepared: string[] = [];
  const recordPrepared = (obj: MoqtObject) => { if (obj.kind === 'data' && obj.payload[obj.payload.length - 4] === TRACK_ID.nextVideo) prepared.push(loc(obj.groupId, obj.objectId)); };
  const transform: NonNullable<MoqtPlayerConfig['objectTransform']> = obj => {
    const out = options.transform ? options.transform(obj) : obj;
    if (out instanceof Promise) return out.then(result => { if (result) recordPrepared(result); return result; });
    if (out) recordPrepared(out);
    return out;
  };
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const wireErrors: Error[] = [];
  client.onError = server.onError = error => { wireErrors.push(error); };
  await Promise.all([client.connect(a, { maxRequestId: varint(1000) }), server.connect(b, { maxRequestId: varint(1000) })]);
  const requests: Array<{ id: bigint; name: string; parameters?: ReadonlyMap<bigint, readonly unknown[]> }> = [];
  server.onSubscribe = (id, _ns, name, parameters) => { requests.push({ id, name: dec.decode(name), ...(parameters ? { parameters } : {}) }); };
  const pub = publisherOn(server, b as unknown as Parameters<typeof publisherOn>[1], requests);
  const video = new MockVideoElement(), adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { maxAheadSec: Infinity });
  // Submission class: what the player handed the adapter, identified from the bytes it handed over.
  const submissions: Submission[] = [];
  const tokens = new Map<object, Submission>();
  const append = adapter.appendChunk.bind(adapter);
  vi.spyOn(adapter, 'appendChunk').mockImplementation((mediaType, data, trackName, groupId, token, sourceKey) => {
    const id = identify(data);
    if (id) { const s: Submission = { ...id, groupArg: groupId, trackArg: trackName, token, index: submissions.length }; submissions.push(s); if (token) tokens.set(token, s); }
    return append(mediaType, data, trackName, groupId, token, sourceKey);
  });
  // Adapter terminal class: the adapter's own observeAppends outcome per token (tokens exist only with the diagnostics runtime installed).
  const terminals: Terminal[] = [];
  adapter.observeAppends(event => { const s = tokens.get(event.token); if (s) terminals.push({ track: s.track, group: s.group, object: s.object, bmdt: s.bmdt, state: event.state, reason: event.reason }); });
  // Modeled browser API class: each appendBuffer on each MockSourceBuffer, completed by the double's update / error+updateend events.
  const modeled: Modeled[] = [];
  // A SourceBuffer reports what it accepted: each modeled-appended fragment covers [bmdt, bmdt + duration) seconds.
  function rebuffer(): void {
    const spans = modeled.filter(t => t.state === 'appended').map(t => [t.bmdt / 1000, (t.bmdt + SAMPLE_MS) / 1000] as [number, number]).sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const span of spans) { const last = merged.at(-1); if (last && span[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
    native.videoBuffer.buffered = video.buffered = makeTimeRanges(merged);
  }
  const addSourceBuffer = native.addSourceBuffer.bind(native);
  vi.spyOn(native, 'addSourceBuffer').mockImplementation(mime => {
    const buffer = addSourceBuffer(mime);
    const pending: Array<Omit<Modeled, 'state'> | null> = []; let failed = false, updated = false, lastOp: 'append' | 'remove' | null = null;
    const appendBuffer = buffer.appendBuffer.bind(buffer), remove = buffer.remove.bind(buffer);
    buffer.appendBuffer = data => {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      pending.push(identify(bytes)); lastOp = 'append'; appendBuffer(data);
    };
    buffer.remove = (start, end) => { lastOp = 'remove'; remove(start, end); };
    buffer.addEventListener('error', () => { failed = true; });
    buffer.addEventListener('update', () => { if (lastOp === 'append') updated = true; });
    buffer.addEventListener('updateend', () => {
      if (lastOp !== 'append') return;
      const id = pending.shift(); const state = updated ? 'appended' : failed ? 'failed' : 'unproven'; failed = false; updated = false;
      if (id) modeled.push({ ...id, state });
      rebuffer();
    });
    return buffer;
  });
  native.open();
  const cmaf = (name: Track, bitrate: number): CatalogTrack => ({ name, namespace: 'review/picture', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', isLive: true,
    initData: Buffer.from(INIT).toString('base64'), altGroup: 1, renderGroup: 1, bitrate });
  const player = new MoqtPlayer({ url: 'https://review.invalid/live', namespace: ['review', 'picture'], draftVersion: draft,
    objectTransform: transform, ...(options.controlledClock ? { clock } : {}),
    connection: client, createTransport: async () => a, disableAudio: true, cmafBootstrapTimeoutMs: 0, reconnectAttempts: 0, autoQuality: false, startLevel: 'lowest',
    catalog: { tracks: [cmaf('video', 100), cmaf('nextVideo', 200)] },
    createMediaSource: () => adapter, createCmafAssembler: options => new CmafAssembler(options) });
  const errors: string[] = []; player.on('error', event => { errors.push(event.error.message); });
  player.observeMediaStages(() => {}, { createTracker: createMediaDiagnostics }); // enables append tokens for the adapter terminal class
  const events: string[] = [];
  let committedWith: { prepared: string[]; submissions: number } | null = null;
  for (const type of ['quality_switching', 'quality_switched', 'quality_switch_failed'] as const) player.on(type, () => {
    events.push(`${type}@${submissions.length}`);
    if (type === 'quality_switched') committedWith ??= { prepared: prepared.slice(), submissions: submissions.length };
  });
  // Control class: the old request's retirement as the player issues it (draft 18 resets the request stream; nothing else is observable
  // server-side), with a snapshot of which target Objects had completed preparation at that instant.
  const unsubscribed: Array<{ id: bigint; atSubmission: number; prepared: string[] }> = [];
  const unsubscribe = client.unsubscribe.bind(client);
  vi.spyOn(client, 'unsubscribe').mockImplementation(async id => { unsubscribed.push({ id, atSubmission: submissions.length, prepared: prepared.slice() }); return unsubscribe(id); });
  await player.load(); await settle();
  expect(requests.map(r => r.name)).toEqual(['video']);
  const oldRequest = await pub.accept('video');
  const floor = (track: Track) => adapter.getCommittedGroupFloor('video', track, SOURCE_KEY[track]);
  const of = (track: Track, list: Array<{ track: string; group: bigint; object: bigint }>) => list.filter(e => e.track === track).map(e => loc(e.group, e.object));
  const appended = (track: Track) => modeled.filter(t => t.track === track && t.state === 'appended').map(t => loc(t.group, t.object));
  const adapterAppended = (track: Track) => terminals.filter(t => t.track === track && t.state === 'appended').map(t => loc(t.group, t.object));
  /** Output epoch: the assembler rebases bmdt. Measured from the first submission's (source, output) pair; every submission's offset is listed
   *  so a common offset across both renditions can be asserted rather than assumed. */
  const epoch = () => {
    const offsets = submissions.map(s => ({ track: s.track, loc: loc(s.group, s.object), offset: s.bmdt - bmdtOf(s.group, s.object) }));
    return { first: offsets[0]?.offset, distinct: [...new Set(offsets.map(o => o.offset))], offsets };
  };
  /** Modeled-appended byte-timeline coverage (output bmdt of the bytes the double accepted) as merged [start, end) ms; not browser buffer or presentation. */
  const coverage = () => {
    const spans = modeled.filter(t => t.state === 'appended').map(t => [t.bmdt, t.bmdt + SAMPLE_MS] as [number, number]).sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const s of spans) { const last = merged.at(-1); if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
    return merged;
  };
  /** Every remove() issued on any SourceBuffer of the modeled MediaSource: a revocation witness. */
  const removes = () => native.sourceBuffers.flatMap(b => b.removeCalls.map(([start, end]) => [start, end] as [number, number]));
  const destroy = async () => { await player.destroy(); await client.close(); await server.close(); };
  return { draft, client, server, player, adapter, native, pub, requests, oldRequest, submissions, terminals, modeled, prepared, events, unsubscribed, errors, wireErrors, floor, of, appended, adapterAppended, epoch, coverage, removes, advance, destroy,
    committed: () => committedWith, now: () => nowUs };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** Old rendition: Groups 1 and 2 complete, then ONLY the first fragment of Group 3; its stream stays open (tail pending). */
async function playOldPartial(f: F) {
  f.player.play();
  await f.pub.publishGroup('video', 1n); await f.pub.publishGroup('video', 2n);
  await f.pub.publish('video', 3n, 0n);
  await vi.advanceTimersByTimeAsync(50); await settle();
  return 3n;
}

/** Measured on the real adapter under the modeled browser API: floor = N with N's tail never appended. */
function expectPartialFloor(f: F, n: bigint) {
  expect(f.floor('video'), 'adapter committed group floor after one fragment of the group').toBe(n);
  expect(f.appended('video'), 'modeled-appended old Objects (MockSourceBuffer update/updateend)').toEqual(['1/0', '1/1', '1/2', '2/0', '2/1', '2/2', `${n}/0`]);
  expect(f.adapterAppended('video'), 'adapter observeAppends terminals agree with the modeled browser API').toEqual(f.appended('video'));
  expect(f.of('video', f.submissions).filter(l => l.startsWith(`${n}/`)), 'only the first fragment of the outgoing group was ever submitted').toEqual([`${n}/0`]);
  expect(f.modeled.filter(t => t.state !== 'appended'), 'no failed or unproven old appends').toEqual([]);
  // Output epoch measured on the old rendition: one common offset, source 1/0 (60 ms) landing at output 0.
  const epoch = f.epoch();
  expect(epoch.distinct, 'one common source-to-output offset so far').toHaveLength(1);
  expect(f.coverage(), 'modeled-appended byte-timeline coverage of the old rendition').toEqual([[bmdtOf(1n, 0n) + epoch.first!, bmdtOf(n, 0n) + SAMPLE_MS + epoch.first!]]);
  expect(f.terminals.filter(t => t.state !== 'appended'), 'no discarded or unproven old appends').toEqual([]);
}

describe.each([18, 22] as const)('ordinary MSE video switch with a partially committed outgoing group, draft %s', draft => {
  async function switchBehind(mode: HistoryMode, options: { transform?: MoqtPlayerConfig['objectTransform']; beforeLive?: (f: F) => Promise<void>; liveFrom?: bigint } = {}) {
    const f = await fixture(draft, options.transform ? { transform: options.transform } : {}); f.pub.setMode(mode);
    try {
      const n = await playOldPartial(f); expectPartialFloor(f, n);
      // Target history exists in the publisher cache only: whole Groups N and N+1.
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      expect(f.pub.largestOf('nextVideo')).toEqual({ group: n + 1n, object: OBJECTS_PER_GROUP - 1n });
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      expect(f.pub.requestOf('nextVideo'), 'target SUBSCRIBE issued').toBeDefined();
      const targetRequest = await f.pub.accept('nextVideo');
      const fill = draft === 22 ? await f.pub.answerFill('nextVideo') : null;
      await settle(); await vi.advanceTimersByTimeAsync(20); await settle();
      const prefixSubmitted = f.of('nextVideo', f.submissions);
      await options.beforeLive?.(f);
      // Live edge after acceptance: Group N+2 onwards (or after what beforeLive published), one retained stream per group, never reopened.
      for (let g = options.liveFrom ?? n + 2n; g <= n + 3n; g++) { await f.pub.publishGroup('nextVideo', g); await vi.advanceTimersByTimeAsync(100); await settle(); }
      return { f, n, targetRequest, fill, prefixSubmitted };
    } catch (error) { await f.destroy(); throw error; }
  }

  it('retrieves the whole partially committed group (start = N, not N+1) for the target, submits it before the live edge, and leaves no gap in the owned timeline', async () => {
    const { f, n, targetRequest, fill, prefixSubmitted } = await switchBehind('serve');
    try {
      const target = f.of('nextVideo', f.submissions);
      const prefix = [loc(n, 0n), loc(n, 1n), loc(n, 2n), loc(n + 1n, 0n), loc(n + 1n, 1n), loc(n + 1n, 2n)];
      // Control class: exact request owner and publisher-resolved range, starting at the partially committed group.
      if (draft === 18) {
        const joins = f.pub.joiningFor('nextVideo'); expect(joins, 'a Joining FETCH joined to the target SUBSCRIBE').toHaveLength(1);
        expect(f.pub.resolved.find(r => r.id === joins[0]!.id), 'publisher-resolved half-open range').toEqual({ id: joins[0]!.id, start: { group: n, object: 0n }, end: { group: n + 1n, object: OBJECTS_PER_GROUP } });
      } else {
        expect(fill?.params.filter, 'FILL_PARAMETERS start at the partially committed group').toMatchObject({ type: 'AbsoluteStart', startGroup: n, startObject: 0n });
        expect(fill).toMatchObject({ opened: true, reset: false });
      }
      expect(f.pub.served, 'history served from the cache, whole Groups N and N+1').toEqual(prefix.map(l => `nextVideo:${l}`));
      // Submission class: the target's history is submitted before any live Object, in order.
      expect(prefixSubmitted, 'history submitted before the live edge was published').toEqual(prefix);
      expect(target.slice(0, prefix.length + 3), 'target submission sequence through the gap').toEqual([...prefix, loc(n + 2n, 0n), loc(n + 2n, 1n), loc(n + 2n, 2n)]);
      // Preparation class: old authority is preserved until the finite prefix PREPARED (transform completed), independent of submission
      // or append order. Retirement and commit may legitimately precede the target flush (existing irreversible commit ordering).
      const retired = f.unsubscribed.find(u => u.id === f.oldRequest.id);
      expect(retired, 'old request retired once the switch committed').toBeDefined();
      expect(retired!.prepared.filter(l => prefix.includes(l)).sort(), 'all six prefix Objects prepared before the old request was retired').toEqual([...prefix].sort());
      expect(f.committed()?.prepared.filter(l => prefix.includes(l)).sort(), 'all six prefix Objects prepared before quality_switched').toEqual([...prefix].sort());
      // Modeled browser API class: one common output epoch across both renditions, and the appended byte timeline is one span [0, 360).
      const epoch = f.epoch();
      expect(epoch.distinct, 'one common source-to-output offset across both renditions').toHaveLength(1);
      expect(f.coverage(), 'no gap in the modeled-appended byte timeline').toEqual([[bmdtOf(1n, 0n) + epoch.first!, bmdtOf(n + 3n, OBJECTS_PER_GROUP - 1n) + SAMPLE_MS + epoch.first!]]);
      expect(f.events.some(e => e.startsWith('quality_switched'))).toBe(true);
      expect(targetRequest.id).not.toBe(f.oldRequest.id);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('holds commit while a later prefix Object is still in its async transform: old stays owned and nothing of the target is submitted until the finite prefix settles', async () => {
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const transform: MoqtPlayerConfig['objectTransform'] = obj => {
      const payload = obj.kind === 'data' ? obj.payload : undefined;
      if (payload && payload[payload.length - 4] === TRACK_ID.nextVideo && obj.groupId === 4n && obj.objectId === 1n) { entered = true; return held.then(() => obj); }
      return obj;
    };
    let duringHold: { entered: boolean; unsubscribed: number; targetSubmitted: string[]; events: string[]; prepared: string[] } | null = null;
    const run = switchBehind('serve', { transform, beforeLive: async f => {
      // The first live sync Object arrives while the prefix Object N+1/1 is still held in its transform.
      await f.pub.publish('nextVideo', 5n, 0n);
      await vi.advanceTimersByTimeAsync(50); await settle();
      duringHold = { entered, unsubscribed: f.unsubscribed.length, targetSubmitted: f.of('nextVideo', f.submissions), events: f.events.slice(), prepared: f.prepared.slice() };
      release(); await settle(); await vi.advanceTimersByTimeAsync(20); await settle();
      await f.pub.publish('nextVideo', 5n, 1n); await f.pub.publish('nextVideo', 5n, 2n, { closeGroup: true });
      await vi.advanceTimersByTimeAsync(100); await settle();
    }, liveFrom: 6n });
    const { f, n } = await run;
    try {
      const target = f.of('nextVideo', f.submissions);
      // History was retrieved and the held prefix Object actually entered its transform.
      expect(entered, 'prefix Object N+1/1 entered the async transform').toBe(true);
      expect(duringHold, 'hold window observed').not.toBeNull();
      const prefix = [loc(n, 0n), loc(n, 1n), loc(n, 2n), loc(n + 1n, 0n), loc(n + 1n, 1n), loc(n + 1n, 2n)];
      // While held: the held Object is not yet prepared; zero retirement, zero target submission, zero commit
      // (discriminates an early commit on a retrieval-only candidate).
      expect(duringHold!.prepared, 'the held prefix Object had not completed preparation during the hold').not.toContain(loc(n + 1n, 1n));
      expect(duringHold!.unsubscribed, 'old request not retired while the prefix is held').toBe(0);
      expect(duringHold!.targetSubmitted, 'no target submission while a prefix Object is held').toEqual([]);
      expect(duringHold!.events.some(e => e.startsWith('quality_switched')), 'no commit while the prefix is held').toBe(false);
      // After release: the held Object completes preparation; all six prefix Objects were prepared before retirement and before commit.
      const retired = f.unsubscribed.find(u => u.id === f.oldRequest.id);
      expect(retired).toBeDefined();
      expect(retired!.prepared.filter(l => prefix.includes(l)).sort(), 'all six prefix Objects prepared before the old request was retired').toEqual([...prefix].sort());
      expect(f.committed()?.prepared.filter(l => prefix.includes(l)).sort(), 'all six prefix Objects prepared before quality_switched').toEqual([...prefix].sort());
      // Separate: target submission order and modeled-appended byte-timeline coverage.
      expect(target.slice(0, prefix.length + 3)).toEqual([...prefix, loc(n + 2n, 0n), loc(n + 2n, 1n), loc(n + 2n, 2n)]);
      const epoch = f.epoch();
      expect(epoch.distinct).toHaveLength(1);
      expect(f.coverage()).toEqual([[bmdtOf(1n, 0n) + epoch.first!, bmdtOf(n + 3n, OBJECTS_PER_GROUP - 1n) + SAMPLE_MS + epoch.first!]]);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { release(); await f.destroy(); }
  });

  it('control: no history behind the target (empty cache head) — the switch lands from the live edge on an independent Object, no bogus past media, no error', async () => {
    const f = await fixture(draft); f.pub.setMode('serve');
    try {
      const n = await playOldPartial(f); expectPartialFloor(f, n);
      expect(f.pub.largestOf('nextVideo'), 'target cache is empty: SUBSCRIBE_OK carries no Largest').toBeNull();
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      const fill = draft === 22 ? await f.pub.answerFill('nextVideo') : null; // an empty fill request is legitimate (§3.4 opens no stream)
      await f.pub.publishGroup('nextVideo', n + 1n); await vi.advanceTimersByTimeAsync(100); await settle();
      await f.pub.publishGroup('nextVideo', n + 2n); await vi.advanceTimersByTimeAsync(100); await settle();
      const target = f.of('nextVideo', f.submissions);
      expect(f.pub.served, 'nothing served: there is no history').toEqual([]);
      if (fill) expect(fill.opened).toBe(false);
      expect(target.slice(0, 6)).toEqual([loc(n + 1n, 0n), loc(n + 1n, 1n), loc(n + 1n, 2n), loc(n + 2n, 0n), loc(n + 2n, 1n), loc(n + 2n, 2n)]);
      expect(target.some(l => BigInt(l.split('/')[0]!) <= n), 'no bogus past media on the target').toBe(false);
      expect(f.events.some(e => e.startsWith('quality_switched'))).toBe(true);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('control: history refused (draft 18 REQUEST_ERROR / draft 22 fill RESET) — the switch lands from the live edge on an independent Object', async () => {
    const { f, n, fill } = await switchBehind('refuse');
    try {
      const target = f.of('nextVideo', f.submissions);
      const requested = draft === 18 ? f.pub.joiningFor('nextVideo').length > 0 : fill?.opened === true;
      expect(requested, 'history request issued so that the refusal can be exercised').toBe(true);
      expect(f.pub.served).toEqual([]);
      expect(target.some(l => l.startsWith(`${n}/`) || l.startsWith(`${n + 1n}/`)), 'refused groups are not fabricated').toBe(false);
      expect(target[0]).toBe(loc(n + 2n, 0n));
      expect(f.events.some(e => e.startsWith('quality_switched'))).toBe(true);
      expect(f.errors, 'no error beyond an explicitly allowed non-fatal diagnostic (none defined yet)').toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { await f.destroy(); }
  });
});

/** Direct SDK controls for the CMAF publisher responders (no player): serve/refuse paths are exercised today. */
describe.each([18, 22] as const)('CMAF publisher responders under direct SDK requests, draft %s', draft => {
  async function pair() {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
    const requests: Array<{ id: bigint; name: string; parameters?: ReadonlyMap<bigint, readonly unknown[]> }> = [];
    server.onSubscribe = (id, _ns, name, parameters) => { requests.push({ id, name: dec.decode(name), ...(parameters ? { parameters } : {}) }); };
    const connected = server.connect(b); void connected.catch(() => {});
    await client.connect(a);
    const pub = publisherOn(server, b as unknown as Parameters<typeof publisherOn>[1], requests);
    await pub.publishGroup('nextVideo', 3n); await pub.publishGroup('nextVideo', 4n); // history in the cache only
    const headers: Array<{ id: bigint; fill: boolean; requestId: bigint }> = [], fillObjects: string[] = [], terminals: Array<{ id: bigint; terminal: string }> = [];
    client.onDataStream = (id, header) => { if (header.type === 'fetch') headers.push({ id, fill: !!(header as { fill?: boolean }).fill, requestId: header.header.requestId }); };
    client.onObject = (id, object) => { if (headers.some(h => h.id === id && h.fill) && object.kind === 'data') fillObjects.push(`${object.groupId}/${object.objectId}@sg${object.subgroupId}:${identify(object.payload)?.bmdt}`); };
    client.onStreamClosed = (id, _error, terminal) => { terminals.push({ id, terminal }); };
    return { client, server, pub, requests, headers, fillObjects, terminals, async close() { await client.close(); await server.close(); await connected.catch(() => {}); } };
  }
  const enc = new TextEncoder();
  async function subscribeTarget(p: Awaited<ReturnType<typeof pair>>, options: object) {
    const pending = p.client.subscribeTrack([enc.encode('review'), enc.encode('picture')], enc.encode('nextVideo'), options as never);
    pending.catch(() => {});
    await flush(256); const req = await p.pub.accept('nextVideo');
    return { sub: await pending, req };
  }

  it('serves the half-open Joining FETCH / fill range for whole Groups 3 and 4 with original subgroup identity and explicit timeline, then FINs', async () => {
    const p = await pair(); p.pub.setMode('serve');
    try {
      const received: string[] = [], live: string[] = [];
      const { sub, req } = await subscribeTarget(p, { filter: { type: 'LargestObject' }, onObject: (o: MoqtObject) => { if (o.kind === 'data') live.push(`${o.groupId}/${o.objectId}`); },
        ...(draft === 22 ? { fill: { filter: { type: 'AbsoluteStart' as const, startGroup: 3n, startObject: 0n }, groupOrder: 'ascending' as const } } : {}) });
      expect(sub.initialLargestLocation).toEqual({ groupId: 4n, objectId: 2n });
      let terminal: string | null = null;
      if (draft === 18) {
        await p.client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: req.id, joiningStart: 3n, receiver: {
          onObject: (o: MoqtObject) => { if (o.kind === 'data') received.push(`${o.groupId}/${o.objectId}@sg${o.subgroupId}:${identify(o.payload)?.bmdt}`); }, onClosed: (t: string) => { terminal = t; } } } as never);
        await flush(512); await settle();
        expect(p.pub.resolved).toEqual([{ id: p.pub.joiningFor('nextVideo')[0]!.id, start: { group: 3n, object: 0n }, end: { group: 4n, object: 3n } }]);
      } else {
        const fill = await p.pub.answerFill('nextVideo'); await flush(512); await settle();
        expect(fill).toMatchObject({ opened: true, reset: false }); received.push(...p.fillObjects);
        const stream = p.headers.find(h => h.fill && h.requestId === req.id); expect(stream).toBeDefined();
        terminal = p.terminals.find(t => t.id === stream!.id)?.terminal ?? null;
      }
      await p.pub.publish('nextVideo', 5n, 0n); await flush(256); await settle();
      expect(received).toEqual(['3/0@sg0:180', '3/1@sg0:200', '3/2@sg0:220', '4/0@sg0:240', '4/1@sg0:260', '4/2@sg0:280']);
      expect(p.pub.served).toEqual(['nextVideo:3/0', 'nextVideo:3/1', 'nextVideo:3/2', 'nextVideo:4/0', 'nextVideo:4/1', 'nextVideo:4/2']);
      expect(terminal).toBe('fin');
      expect(live).toEqual(['5/0']);
    } finally { await p.close(); }
  });

  it('refuses history: draft 18 REQUEST_ERROR, draft 22 fill RESET after its header; the live subscription is untouched', async () => {
    const p = await pair(); p.pub.setMode('refuse');
    try {
      const live: string[] = [];
      const { req } = await subscribeTarget(p, { filter: { type: 'LargestObject' }, onObject: (o: MoqtObject) => { if (o.kind === 'data') live.push(`${o.groupId}/${o.objectId}`); },
        ...(draft === 22 ? { fill: { filter: { type: 'AbsoluteStart' as const, startGroup: 3n, startObject: 0n }, groupOrder: 'ascending' as const } } : {}) });
      if (draft === 18) {
        const closed: string[] = [], got: string[] = [];
        await p.client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: req.id, joiningStart: 3n, receiver: { onObject: (o: MoqtObject) => { got.push(`${o.groupId}/${o.objectId}`); }, onClosed: (t: string) => { closed.push(t); } } } as never);
        await flush(512); await settle();
        expect(p.pub.joiningFor('nextVideo')).toHaveLength(1);
        expect(closed).toEqual(['error']); expect(got).toEqual([]);
      } else {
        const fill = await p.pub.answerFill('nextVideo'); await flush(512); await settle();
        expect(fill).toMatchObject({ opened: true, reset: true });
        const stream = p.headers.find(h => h.fill && h.requestId === req.id); expect(stream).toBeDefined();
        expect(p.terminals.find(t => t.id === stream!.id)?.terminal).toBe('reset');
      }
      expect(p.pub.served).toEqual([]);
      await p.pub.publish('nextVideo', 5n, 0n); await flush(256); await settle();
      expect(live).toEqual(['5/0']);
    } finally { await p.close(); }
  });
});

/** Boundary: the held finite prefix outlives the head's one-second deadline. Receiver fallback policy (not a transport mandate):
 *  partial history is never submitted; the old request stays owned through the hold; at abandonment the switch restarts on an
 *  independent live Object beyond Largest that is already retained (CMSF groups are independently decodable), so no further
 *  arrival is awaited; a retained dependent-only Object cannot be that restart; releasing the held work later neither appends
 *  it nor revokes new output. The skipped span remains a gap; nothing here calls the fallback seamless. */
describe.each([18, 22] as const)('held finite prefix past the deadline, draft %s', draft => {
  const prefix = ['3/0', '3/1', '3/2', '4/0', '4/1', '4/2'];
  const hold = () => {
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const transform: MoqtPlayerConfig['objectTransform'] = obj => {
      const payload = obj.kind === 'data' ? obj.payload : undefined;
      if (payload && payload[payload.length - 4] === TRACK_ID.nextVideo && obj.groupId === 4n && obj.objectId === 1n) { entered = true; return held.then(() => obj); }
      return obj;
    };
    return { transform, release: () => release(), entered: () => entered };
  };
  /** Old partial, target history cached, switch issued and accepted, history served with 4/1 held, first live sync 5/0 staged. */
  async function heldAtFirstSync(f: F, h: ReturnType<typeof hold>, firstLive: { group: bigint; object: bigint } = { group: 5n, object: 0n }) {
    const n = await playOldPartial(f); expectPartialFloor(f, n);
    await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
    const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
    await f.pub.accept('nextVideo');
    const fill = draft === 22 ? await f.pub.answerFill('nextVideo') : null;
    await f.advance(20);
    expect(h.entered(), 'prefix Object 4/1 entered the held transform').toBe(true);
    expect(draft === 18 ? f.pub.joiningFor('nextVideo').length > 0 : fill?.opened === true, 'history was requested and served').toBe(true);
    await f.pub.publish('nextVideo', firstLive.group, firstLive.object); await f.advance(50);
    const during = { unsubscribed: f.unsubscribed.length, targetSubmitted: f.of('nextVideo', f.submissions), committed: f.committed(), prepared: f.prepared.slice(), nowUs: f.now() };
    return { n, switching, during };
  }
  const snapshot = (f: F) => ({ submissions: f.submissions.length, target: f.of('nextVideo', f.submissions), modeled: f.modeled.length, unsubscribed: f.unsubscribed.length, events: f.events.slice(), removes: f.removes(), coverage: f.coverage(), errors: f.errors.slice() });

  it('at the deadline: partial history is never submitted, the old request was owned through the hold, the switch restarts once on the retained independent 5/0, and the late release is inert', async () => {
    const h = hold(); const f = await fixture(draft, { transform: h.transform, controlledClock: true }); f.pub.setMode('serve');
    try {
      const { n, during } = await heldAtFirstSync(f, h);
      expect(during.unsubscribed, 'old request owned while the prefix is held').toBe(0);
      expect(during.targetSubmitted, 'nothing of the target submitted while held').toEqual([]);
      expect(during.committed, 'no commit while held').toBeNull();
      // Cross the head's one-second finite-prefix deadline on the player's own clock while 4/1 stays held.
      await f.advance(1_100);
      const atDeadline = snapshot(f);
      expect(atDeadline.target, 'fallback restarts on exactly the retained independent live Object').toEqual(['5/0']);
      expect(atDeadline.target.some(l => prefix.includes(l)), 'no partial history submitted').toBe(false);
      expect(atDeadline.unsubscribed, 'old request retired once, at the fallback commit').toBe(1);
      expect(f.unsubscribed[0]!.id).toBe(f.oldRequest.id);
      expect(atDeadline.events.filter(e => e.startsWith('quality_switched')), 'committed exactly once').toHaveLength(1);
      // The remainder of Group 5 and later Groups continue on the target.
      await f.pub.publish('nextVideo', 5n, 1n); await f.pub.publish('nextVideo', 5n, 2n, { closeGroup: true }); await f.advance(50);
      await f.pub.publishGroup('nextVideo', 6n); await f.advance(100);
      await f.pub.publishGroup('nextVideo', 7n); await f.advance(100);
      const afterLive = snapshot(f);
      expect(afterLive.target).toEqual(['5/0', '5/1', '5/2', '6/0', '6/1', '6/2', '7/0', '7/1', '7/2']);
      expect(afterLive.target.some(l => prefix.includes(l)), 'no partial history submitted later either').toBe(false);
      expect(afterLive.unsubscribed).toBe(1);
      expect(afterLive.events.filter(e => e.startsWith('quality_switched'))).toHaveLength(1);
      const epoch = f.epoch(); expect(epoch.distinct, 'one retained source-to-output offset across both renditions').toHaveLength(1);
      // Old coverage through 3/0 plus target coverage from 5/0: the skipped span [3/1, 4/2] is a real gap, not invented media.
      expect(afterLive.coverage).toEqual([[bmdtOf(1n, 0n) + epoch.first!, bmdtOf(n, 0n) + SAMPLE_MS + epoch.first!], [bmdtOf(5n, 0n) + epoch.first!, bmdtOf(7n, 2n) + SAMPLE_MS + epoch.first!]]);
      // Release the held prefix Object long after abandonment: nothing appended, nothing revoked, nothing retired.
      h.release(); await f.advance(100);
      const afterRelease = snapshot(f);
      expect(afterRelease.submissions, 'late release submits nothing').toBe(afterLive.submissions);
      expect(afterRelease.modeled, 'late release appends nothing').toBe(afterLive.modeled);
      expect(afterRelease.removes, 'late release revokes no output').toEqual(afterLive.removes);
      expect(afterRelease.coverage).toEqual(afterLive.coverage);
      expect(afterRelease.unsubscribed).toBe(1);
      expect(afterRelease.events).toEqual(afterLive.events);
      expect(f.errors, 'no error across deadline, fallback and late release').toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { h.release(); await f.destroy(); }
  });

  it('control: a retained dependent-only Object (5/1 without 5/0) is not adopted at the deadline; a later independent 6/0 restarts the target', async () => {
    const h = hold(); const f = await fixture(draft, { transform: h.transform, controlledClock: true }); f.pub.setMode('serve');
    try {
      const { n, during } = await heldAtFirstSync(f, h, { group: 5n, object: 1n });
      expect(during.unsubscribed).toBe(0); expect(during.targetSubmitted).toEqual([]); expect(during.committed).toBeNull();
      await f.advance(1_100);
      const atDeadline = snapshot(f);
      expect(atDeadline.target, 'a dependent-only Object cannot start the fallback').toEqual([]);
      expect(atDeadline.unsubscribed, 'old request still owned').toBe(0);
      expect(atDeadline.events.some(e => e.startsWith('quality_switched')), 'no commit').toBe(false);
      await f.pub.publish('nextVideo', 5n, 2n, { closeGroup: true }); await f.advance(50);
      expect(snapshot(f).target, 'the rest of the dependent-only group is not adopted either').toEqual([]);
      await f.pub.publishGroup('nextVideo', 6n); await f.advance(100);
      await f.pub.publishGroup('nextVideo', 7n); await f.advance(100);
      const afterLive = snapshot(f);
      expect(afterLive.target, 'the first later independent Object restarts the target').toEqual(['6/0', '6/1', '6/2', '7/0', '7/1', '7/2']);
      expect(afterLive.unsubscribed).toBe(1); expect(f.unsubscribed[0]!.id).toBe(f.oldRequest.id);
      expect(afterLive.events.filter(e => e.startsWith('quality_switched'))).toHaveLength(1);
      const epoch = f.epoch(); expect(epoch.distinct).toHaveLength(1);
      expect(afterLive.coverage).toEqual([[bmdtOf(1n, 0n) + epoch.first!, bmdtOf(n, 0n) + SAMPLE_MS + epoch.first!], [bmdtOf(6n, 0n) + epoch.first!, bmdtOf(7n, 2n) + SAMPLE_MS + epoch.first!]]);
      h.release(); await f.advance(100);
      const afterRelease = snapshot(f);
      expect(afterRelease.submissions).toBe(afterLive.submissions); expect(afterRelease.modeled).toBe(afterLive.modeled);
      expect(afterRelease.removes).toEqual(afterLive.removes); expect(afterRelease.coverage).toEqual(afterLive.coverage);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { h.release(); await f.destroy(); }
  });

  it('destroy during the hold: the late release appends nothing, retires nothing further and raises no error', async () => {
    const h = hold(); const f = await fixture(draft, { transform: h.transform, controlledClock: true }); f.pub.setMode('serve');
    let destroyed = false;
    try {
      const { during } = await heldAtFirstSync(f, h);
      expect(during.unsubscribed).toBe(0); expect(during.targetSubmitted).toEqual([]);
      const beforeDestroy = snapshot(f);
      await f.player.destroy(); destroyed = true; await settle();
      const afterDestroy = snapshot(f);
      h.release(); await f.advance(100);
      await f.advance(1_100);
      const afterRelease = snapshot(f);
      expect(afterDestroy.target).toEqual([]);
      expect(afterDestroy.submissions, 'destroy itself submits nothing').toBe(beforeDestroy.submissions);
      expect(afterRelease.submissions, 'no submission after destroy').toBe(afterDestroy.submissions);
      expect(afterRelease.modeled, 'no modeled append after destroy').toBe(afterDestroy.modeled);
      expect(afterRelease.events.filter(e => e.startsWith('quality_switched')), 'no commit after destroy').toEqual([]);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { h.release(); if (!destroyed) await f.player.destroy(); await f.client.close(); await f.server.close(); }
  });

  it('superseding selection back to the old rendition during the hold: the pending switch fails, old output continues, held target work never appends', async () => {
    const h = hold(); const f = await fixture(draft, { transform: h.transform, controlledClock: true }); f.pub.setMode('serve');
    try {
      const { during } = await heldAtFirstSync(f, h);
      expect(during.unsubscribed).toBe(0); expect(during.targetSubmitted).toEqual([]);
      let outcome: string = 'resolved';
      await f.player.selectVideoTrack('video').then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`; });
      await f.advance(50);
      const afterSelect = snapshot(f);
      // The old rendition resumes its stalled group on its still-open stream, then continues.
      await f.pub.publish('video', 3n, 1n); await f.pub.publish('video', 3n, 2n, { closeGroup: true }); await f.pub.publishGroup('video', 4n); await f.advance(100);
      h.release(); await f.advance(100);
      await f.advance(1_100);
      const after = snapshot(f);
      // Contract of a superseding selection while a switch is pending: the selection resolves, the pending switch fails and
      // its target request is retired, nothing of the target is submitted, and the old request remains the owner.
      expect(outcome).toBe('resolved');
      expect(afterSelect.events.some(e => e.startsWith('quality_switch_failed')), 'pending switch fails on supersession').toBe(true);
      expect(afterSelect.target).toEqual([]);
      expect(afterSelect.unsubscribed, 'exactly one request retired by the supersession').toBe(1);
      expect(f.unsubscribed[0]!.id, 'the retired request is the target, not the old owner').not.toBe(f.oldRequest.id);
      expect(f.of('video', f.submissions).slice(-6), 'old rendition continues to be submitted after superseding back to it').toEqual(['3/0', '3/1', '3/2', '4/0', '4/1', '4/2']);
      expect(f.appended('video').slice(-5), 'old continuation appended under the modeled API').toEqual(['3/1', '3/2', '4/0', '4/1', '4/2']);
      expect(after.target.some(l => prefix.includes(l) || l.startsWith('5/')), 'held target history never appends after supersession').toBe(false);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { h.release(); await f.destroy(); }
  });
});


describe.each([18, 22] as const)('unanswered MSE switch history, draft %s', draft => {
  it.each(['queued', 'late'] as const)('uses an independent live head inside the abandoned range (%s)', async arrival => {
    const f = await fixture(draft, { controlledClock: true });
    try {
      const n = await playOldPartial(f); expectPartialFloor(f, n);
      // Model a relay that received a later group first on another stream.
      // Group n arrives newly after acceptance, not as a cache replay (§10.7).
      await f.pub.publish('nextVideo', n + 1n, 0n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo'); await f.advance(20);
      if (draft === 18) expect(f.pub.joiningFor('nextVideo')).toHaveLength(1);
      else expect(f.pub.fillOf('nextVideo')).not.toBeNull();
      expect(f.pub.served).toEqual([]);
      if (arrival === 'queued') await f.pub.publish('nextVideo', n, 0n);
      await f.advance(1_100);
      if (arrival === 'late') await f.pub.publish('nextVideo', n, 0n);
      await f.pub.publish('nextVideo', n, 1n);
      await f.pub.publish('nextVideo', n, 2n, { closeGroup: true });
      await f.advance(100);
      expect(f.of('nextVideo', f.submissions), 'live head remains usable when no history was dispatched').toEqual(['3/0', '3/1', '3/2']);
      expect(f.appended('nextVideo')).toEqual(['3/0', '3/1', '3/2']);
      expect(f.events.filter(e => e.startsWith('quality_switched'))).toHaveLength(1);
      expect(f.unsubscribed.filter(r => r.id === f.oldRequest.id)).toHaveLength(1);
      expect(f.epoch().distinct).toHaveLength(1);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { await f.destroy(); }
  });
  it('does not adopt a dependent payload merely because its Object ID is zero', async () => {
    const f = await fixture(draft, { controlledClock: true });
    try {
      const n = await playOldPartial(f); expectPartialFloor(f, n);
      // Model a relay that received a later group first on another stream.
      // Group n arrives newly after acceptance, not as a cache replay (§10.7).
      await f.pub.publish('nextVideo', n + 1n, 0n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo'); await f.advance(1_100);
      // Deliberately nonconforming CMSF group: the format guard must still
      // require a usable independent sample, not trust the Object ID.
      await f.pub.publish('nextVideo', n, 0n, { dependent: true, closeGroup: true });
      await f.advance(100);
      expect(f.of('nextVideo', f.submissions)).toEqual([]);
      expect(f.unsubscribed).toEqual([]);
      expect(f.events.some(e => e.startsWith('quality_switched'))).toBe(false);
      await f.pub.publishGroup('nextVideo', n + 2n); await f.advance(100);
      expect(f.appended('nextVideo')).toEqual(['5/0', '5/1', '5/2']);
      expect(f.events.filter(e => e.startsWith('quality_switched'))).toHaveLength(1);
      expect(f.errors).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

});
