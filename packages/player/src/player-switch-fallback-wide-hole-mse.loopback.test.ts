/**
 * Ordinary MSE (CMAF) switch whose history retrieval fails: the target restarts
 * on a later independent group, leaving a buffered span between the old and
 * the target ranges wider than the adapter's bounded gap jump. Real player,
 * CmafAssembler and MseMediaSource over the modeled browser API; buffered ranges
 * are derived from the bytes the modeled SourceBuffers accepted, never forced.
 * Audio continues on its own subscription, so the element's buffered ranges are
 * the audio/video intersection. Not Chrome, codec or presentation evidence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import { MseMediaSource } from '../../browser/src/mse-adapter.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, RequestError, decodeFillParameters, varint, type MoqtObject } from '@openmoq/transport';
import { createLoopback } from '../../webtransport/src/testkit/loopback.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';
import type { CatalogTrack } from '@openmoq/msf';
import type { MediaAppendObservation } from './interfaces.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../../browser/test-support/mse-native.js';

type Draft = 18 | 22;
type Track = 'video' | 'nextVideo' | 'audio';
type Loc = { group: bigint; object: bigint };
type Cached = { group: bigint; object: bigint; subgroup: bigint; payload: Uint8Array };
type HistoryMode = 'none' | 'serve' | 'refuse';
const ALIAS: Record<Track, bigint> = { video: 10n, nextVideo: 11n, audio: 12n };
const TRACK_ID: Record<Track, number> = { video: 0xa1, nextVideo: 0xb2, audio: 0xc3 };
const TIMESCALE = 1000, SAMPLE_MS = 500, OBJECTS_PER_GROUP = 3n, GROUP_MS = SAMPLE_MS * Number(OBJECTS_PER_GROUP);
const dec = new TextDecoder();
const loc = (g: bigint, o: bigint) => `${g}/${o}`;
const before = (a: Loc, b: Loc) => a.group < b.group || (a.group === b.group && a.object < b.object);
const onePast = (l: Loc): Loc => ({ group: l.group, object: l.object + 1n });
/** Explicit source timeline: every Object is one 20 ms sample; group g starts at g*60 ms (timescale 1000). */
const bmdtOf = (group: bigint, object: bigint) => Number(group) * GROUP_MS + Number(object) * SAMPLE_MS;
const INIT = buildInit({ trackId: 1, timescale: TIMESCALE, handler: 'vide' });
const INIT_CTX = parseLocmafTrackContext(INIT);
const AUDIO_INIT = buildInit({ trackId: 2, timescale: TIMESCALE, handler: 'soun' });
const AUDIO_CTX = parseLocmafTrackContext(AUDIO_INIT);
const SOURCE_KEY: Record<Track, string> = { video: JSON.stringify([['review', 'picture'], 'video']), nextVideo: JSON.stringify([['review', 'picture'], 'nextVideo']),
  audio: JSON.stringify([['review', 'picture'], 'audio']) };

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
  const track = tail[0] === TRACK_ID.video ? 'video' : tail[0] === TRACK_ID.nextVideo ? 'nextVideo' : tail[0] === TRACK_ID.audio ? 'audio' : `unknown(${tail[0]})`;
  return { track, group: BigInt(tail[1]!), object: BigInt(tail[2]!),
    bmdt: Number(readCmafChunkSamples(bytes, track === 'audio' ? AUDIO_CTX : INIT_CTX).effective.baseMediaDecodeTime) };
}

/** Minimal real-SDK CMAF publisher: per-track cache; Largest is what the cache holds; a live SUBSCRIBE gets only Objects
 *  published after acceptance; history only via Joining FETCH (18) / fill (22) from the cache. One retained subgroup stream
 *  per (track, group), FIN'd only when the test closes the group; FETCH output keeps the original subgroup identity (0). */
function publisherOn(server: MoqtConnection, serverTransport: { uniOut: Array<{ written: Uint8Array[]; faults: { resetAfterBytes?: number } }> },
  requests: Array<{ id: bigint; name: string; parameters?: ReadonlyMap<bigint, readonly unknown[]> }>) {
  const cache: Record<Track, Cached[]> = { video: [], nextVideo: [], audio: [] };
  const subscribed = new Set<Track>();
  const streams = new Map<string, bigint>();
  const fetches: Array<{ id: bigint; fetch: { fetch: { fetchType: number; joiningRequestId?: bigint } } }> = [];
  const served: string[] = [];
  const resolved: Array<{ id: bigint; start: Loc; end: Loc }> = [];
  let mode: HistoryMode = 'none';
  const largestOf = (track: Track): Loc | null => { const last = cache[track].at(-1); return last ? { group: last.group, object: last.object } : null; };
  const requestOf = (name: Track) => requests.filter(r => r.name === name).at(-1); // the latest request when a track is subscribed again
  server.setLargestLocationProvider(id => { const name = requests.find(r => r.id === id)?.name as Track | undefined; return name ? largestOf(name) : null; });
  function make(track: Track, group: bigint, object: bigint, dependent = false): Cached {
    const payload = buildChunk({ trackId: track === 'audio' ? 2 : 1, bmdt: BigInt(bmdtOf(group, object)),
      samples: [{ duration: SAMPLE_MS, size: 4, flags: track === 'audio' || (object === 0n && !dependent) ? SYNC_FLAGS : NON_SYNC_FLAGS }],
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
    /** The subscriber dropped this track: stop sending it. */
    stop(track: Track) { subscribed.delete(track); },
    joiningFor(track: Track) { const id = requestOf(track)?.id; return fetches.filter(({ fetch }) => fetch.fetch.fetchType === 3 && fetch.fetch.joiningRequestId === id); },
    fillOf(track: Track) { const raw = requestOf(track)?.parameters?.get(0x23n)?.[0]; return raw instanceof Uint8Array ? decodeFillParameters(raw) : null; } };
}

interface Submission { track: string; group: bigint; object: bigint; bmdt: number; groupArg: bigint | undefined; trackArg: string; token: object | undefined; index: number }
interface Terminal { track: string; group: bigint; object: bigint; bmdt: number; state: MediaAppendObservation['state']; reason: MediaAppendObservation['reason'] }
/** Modeled browser API terminal: one appendBuffer call on a MockSourceBuffer. 'appended' requires the double's `update` witness
 *  before `updateend`; `error`+`updateend` is 'failed'; `updateend` alone (abort) is 'unproven'. */
interface Modeled { track: string; group: bigint; object: bigint; bmdt: number; state: 'appended' | 'failed' | 'unproven' }

async function fixture(draft: Draft, options: { transform?: MoqtPlayerConfig['objectTransform']; controlledClock?: boolean; subscriptionFilter?: MoqtPlayerConfig['subscriptionFilter']; finiteTarget?: boolean; noSwitchRecovery?: boolean;
  /** Runs inside the media source's reserveSwitchRecovery, after the real reservation was made. */
  duringReserve?: () => void } = {}) {
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
  // Buffered ranges follow from accepted bytes only: each modeled-appended fragment covers [bmdt, bmdt + duration).
  const rangesOf = (kind: 'video' | 'audio'): Array<[number, number]> => {
    const spans = modeled.filter(t => t.state === 'appended' && (kind === 'audio') === (t.track === 'audio'))
      .map(t => [t.bmdt / 1000, (t.bmdt + SAMPLE_MS) / 1000] as [number, number]).sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const s of spans) { const last = merged.at(-1); if (last && s[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
    return merged;
  };
  const intersect = (x: Array<[number, number]>, y: Array<[number, number]>) => x.flatMap(([a0, a1]) => y
    .map(([b0, b1]) => [Math.max(a0, b0), Math.min(a1, b1)] as [number, number]).filter(([s, e]) => e > s));
  const elementRanges = () => intersect(rangesOf('video'), rangesOf('audio'));
  function rebuffer(): void {
    native.videoBuffer.buffered = makeTimeRanges(rangesOf('video'));
    native.audioBuffer.buffered = makeTimeRanges(rangesOf('audio'));
    video.buffered = makeTimeRanges(elementRanges());
  }
  // A media source written before the recovery existed: the method is absent.
  if (options.noSwitchRecovery) (adapter as { reserveSwitchRecovery?: unknown }).reserveSwitchRecovery = undefined;
  // Every handle the media source returned, with the calls the player made on it.
  const handles: Array<{ activated: number; revoked: number }> = [];
  if (!options.noSwitchRecovery) {
    const reserve = adapter.reserveSwitchRecovery.bind(adapter);
    adapter.reserveSwitchRecovery = target => {
      const real = reserve(target); if (!real) return null;
      const seen = { activated: 0, revoked: 0 }; handles.push(seen);
      options.duringReserve?.();
      return { activate: () => { seen.activated++; real.activate(); }, revoke: () => { seen.revoked++; real.revoke(); } };
    };
  }
  native.open();
  const cmaf = (name: Track, bitrate: number): CatalogTrack => ({ name, namespace: 'review/picture', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', isLive: !(options.finiteTarget === true && name === 'nextVideo'),
    initData: Buffer.from(INIT).toString('base64'), altGroup: 1, renderGroup: 1, bitrate });
  const player = new MoqtPlayer({ url: 'https://review.invalid/live', namespace: ['review', 'picture'], draftVersion: draft,
    objectTransform: transform, ...(options.controlledClock ? { clock } : {}),
    ...(options.subscriptionFilter ? { subscriptionFilter: options.subscriptionFilter } : {}),
    connection: client, createTransport: async () => a, cmafBootstrapTimeoutMs: 0, reconnectAttempts: 0, autoQuality: false, startLevel: 'lowest',
    catalog: { tracks: [cmaf('video', 100), cmaf('nextVideo', 200), { name: 'audio', namespace: 'review/picture', role: 'audio', packaging: 'cmaf',
      codec: 'mp4a.40.2', isLive: true, renderGroup: 1, samplerate: 48000, channelConfig: '2', initData: Buffer.from(AUDIO_INIT).toString('base64') } satisfies CatalogTrack] },
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
  expect(requests.map(r => r.name).sort()).toEqual(['audio', 'video']);
  const oldRequest = await pub.accept('video');
  await pub.accept('audio');
  const fatal: string[] = []; player.on('error', event => { if (event.error.severity === 'fatal') fatal.push(event.error.message); });
  const jumps: unknown[] = []; player.on('gap_jump' as never, (event: unknown) => { jumps.push(event); });
  /** The element runs out of media at `sec`: the playhead rests there with no future data, as at the end of a buffered range. */
  const stallAt = (sec: number) => { video.advancePlayback(sec); video.readyState = 2; video.seekCount = 0; };
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
    committed: () => committedWith, now: () => nowUs, video, fatal, jumps, stallAt, rangesOf, elementRanges, handles };
}
type F = Awaited<ReturnType<typeof fixture>>;


/** Old rendition: Groups 1 and 2 complete, then only the first fragment of Group 3 (tail pending); audio complete through Group 3. */
async function playOldPartial(f: F) {
  f.player.play();
  for (const g of [1n, 2n]) { await f.pub.publishGroup('video', g); await f.pub.publishGroup('audio', g); }
  await f.pub.publish('video', 3n, 0n); await f.pub.publishGroup('audio', 3n);
  await vi.advanceTimersByTimeAsync(50); await settle();
  expect(f.floor('video'), 'adapter floor on a partly appended group').toBe(3n);
  expect(f.rangesOf('video'), 'old video accepted through 3/0').toEqual([[0, 3.5]]);
  expect(f.rangesOf('audio')).toEqual([[0, 4.5]]);
  return 3n;
}
const OLD_END = 3.5, TARGET_START = 6, FATAL_AFTER_MS = 10_000;

/** Let the element sit at the end of the old range for `ms`, one watchdog second at a time. */
async function sit(f: F, ms: number) { for (let t = 0; t < ms; t += 1000) { await f.advance(1000); } }
/** As `sit`, but once the adapter has moved the playhead into buffered media the element is modeled as playing it:
 *  one second per second up to the end of that range. The mock does not play by itself; this is not autonomous playback. */
async function sitPlayingAfterSeek(f: F, ms: number) {
  for (let t = 0; t < ms; t += 1000) {
    await f.advance(1000);
    const at = f.video.currentTime, range = f.video.seekCount > 0 ? f.elementRanges().find(([a, b]) => a <= at && at < b) : undefined;
    if (range) { f.video.advancePlayback(Math.min(range[1], at + 1)); f.video.readyState = at + 1 < range[1] ? 4 : 2; }
  }
}
const outcome = (f: F) => ({ currentTime: f.video.currentTime, seeks: f.video.seekCount, fatal: f.fatal.slice(), errors: f.errors.slice(),
  state: String(f.player.state), element: f.elementRanges(), jumps: f.jumps.length });

describe.each([18, 22] as const)('wide hole after a failed MSE switch history retrieval, draft %s', draft => {
  /** Old partial, target history cached, switch issued; history refused or left unanswered; target restarts on live Group 5. */
  async function fallback(mode: 'refuse' | 'none', options: { noSwitchRecovery?: boolean; duringReserve?: () => void } = {}) {
    const f = await fixture(draft, { controlledClock: true, ...options }); f.pub.setMode(mode);
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      if (draft === 22) await f.pub.answerFill('nextVideo');
      await f.advance(20);
      if (mode === 'none') {
        expect(f.events.some(e => e.startsWith('quality_switched')), 'unanswered history: no commit before the prefix deadline').toBe(false);
        await f.advance(1_100); // the head's finite-prefix deadline
      }
      for (const g of [n + 2n, n + 3n]) { await f.pub.publishGroup('nextVideo', g); await f.pub.publishGroup('audio', g - 1n); await f.advance(100); }
      await f.pub.publishGroup('audio', n + 2n); await f.pub.publishGroup('audio', n + 3n); await f.advance(100);
      return { f, n };
    } catch (error) { await f.destroy(); throw error; }
  }

  it.each(['refuse', 'none'] as const)('history %s: the fallback is adopted, with exact buffered ranges and a playable target', async mode => {
    const { f, n } = await fallback(mode);
    try {
      const target = f.of('nextVideo', f.submissions);
      expect(f.events.some(e => e.startsWith('quality_switched')), 'fallback committed').toBe(true);
      expect(target[0], 'restart on the first independent live Object').toBe(loc(n + 2n, 0n));
      expect(target.some(l => l.startsWith(`${n}/`) || l.startsWith(`${n + 1n}/`)), 'no unretrieved history submitted').toBe(false);
      expect(f.epoch().distinct, 'one source-to-output offset across video renditions and audio').toHaveLength(1);
      expect(f.rangesOf('video'), 'old range, then the target from Group 5').toEqual([[0, OLD_END], [TARGET_START, 9]]);
      expect(f.rangesOf('audio'), 'audio continuous across the switch').toEqual([[0, 9]]);
      expect(f.elementRanges(), 'element ranges are the audio/video intersection').toEqual([[0, OLD_END], [TARGET_START, 9]]);
      expect(TARGET_START - OLD_END, 'wider than the adapter gap-jump bound').toBeGreaterThan(2);
      expect(f.removes()).toEqual([]); expect(f.fatal).toEqual([]); expect(f.wireErrors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each(['refuse', 'none'] as const)('history %s: when the playhead reaches the end of the old range, the owned fallback does not end in a fatal or a permanent freeze', async mode => {
    const { f } = await fallback(mode);
    try {
      f.stallAt(OLD_END);
      await sitPlayingAfterSeek(f, FATAL_AFTER_MS + 4_000);
      const seen = outcome(f);
      const committed = f.events.some(e => e.startsWith('quality_switched'));
      expect(seen.fatal, 'the player\'s own fallback must not escalate to MediaSource rebuild').toEqual([]);
      expect(seen.state).not.toBe('error');
      if (committed) {
        // The target is authoritative and the old request is retired: only one owned crossing into the adopted target resumes output.
        expect(seen.seeks, 'exactly one crossing').toBe(1);
        const landing = (f.jumps as Array<{ from: number; to: number }>)[0];
        expect(f.jumps, 'reported as one gap jump').toHaveLength(1);
        expect(landing?.from).toBe(OLD_END);
        expect(landing!.to, 'landed at the start of the adopted target range').toBeGreaterThanOrEqual(TARGET_START);
        expect(landing!.to).toBeLessThan(TARGET_START + SAMPLE_MS / 1000);
        expect(f.elementRanges().some(([a, b]) => a <= landing!.to && landing!.to < b), 'landing is buffered in audio and video').toBe(true);
        expect(seen.currentTime, 'modeled playback continued through the target range').toBe(9);
        // Resting at the live end of the target: neither a late fatal nor a second crossing follows.
        await sit(f, FATAL_AFTER_MS + 2_000);
        expect(f.fatal).toEqual([]); expect(f.video.seekCount, 'the permission is one-use').toBe(1);
      } else {
        // Declined instead: suppressing the fatal is not enough. The old rendition must really remain the output and keep playing.
        expect(f.unsubscribed.some(u => u.id === f.oldRequest.id), 'old request retained').toBe(false);
        expect(f.of('nextVideo', f.submissions), 'no target media under a declined switch').toEqual([]);
        await f.pub.publish('video', 3n, 1n); await f.pub.publish('video', 3n, 2n); await f.pub.publishGroup('video', 4n); await f.advance(100);
        expect(f.appended('video'), 'the old tail is accepted').toEqual(expect.arrayContaining([loc(3n, 1n), loc(3n, 2n), loc(4n, 0n)]));
        expect(f.rangesOf('video')[0], 'old output continuous past the former end').toEqual([0, TARGET_START]);
        f.video.advancePlayback(OLD_END + 1); f.video.readyState = 4;
        await sit(f, FATAL_AFTER_MS + 2_000);
        expect(f.fatal).toEqual([]); expect(f.video.seekCount).toBe(0); expect(String(f.player.state)).not.toBe('error');
      }
    } finally { await f.destroy(); }
  });

  it.each(['refuse', 'none'] as const)('history %s: a media source without the recovery declines the restart before the old rendition is retired', async mode => {
    const f = await fixture(draft, { controlledClock: true, noSwitchRecovery: true }); f.pub.setMode(mode);
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      if (draft === 22) await f.pub.answerFill('nextVideo');
      await f.advance(mode === 'none' ? 1_120 : 20);
      await f.pub.publish('nextVideo', n + 2n, 0n); await f.advance(100); f.pub.stop('nextVideo');
      expect(f.events.some(e => e.startsWith('quality_switched')), 'not committed').toBe(false);
      expect(f.events.some(e => e.startsWith('quality_switch_failed')), 'reported through the existing switch failure').toBe(true);
      expect(f.unsubscribed.some(u => u.id === f.oldRequest.id), 'old request retained').toBe(false);
      expect(f.of('nextVideo', f.submissions), 'no target media submitted').toEqual([]);
      expect(f.fatal).toEqual([]);
      await f.pub.publish('video', 3n, 1n); await f.pub.publish('video', 3n, 2n); await f.pub.publishGroup('video', 4n); await f.advance(100);
      expect(f.appended('video'), 'the old route keeps delivering').toEqual(expect.arrayContaining([loc(3n, 1n), loc(3n, 2n), loc(4n, 0n)]));
      expect(f.rangesOf('video')).toEqual([[0, TARGET_START]]);
      expect(f.removes()).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('the handle is activated once on adoption and released when the player is destroyed before any crossing', async () => {
    const { f } = await fallback('refuse');
    try {
      expect(f.handles).toEqual([{ activated: 1, revoked: 0 }]);
      await f.player.destroy();
      expect(f.handles, 'released by the player, not left to the media source').toEqual([{ activated: 1, revoked: 1 }]);
    } finally { await f.destroy(); }
  });

  it('a reservation whose call destroys the player is revoked and never installed, activated or followed by a retype', async () => {
    let f: F | undefined; let ran = 0;
    const made = await fixture(draft, { controlledClock: true, duringReserve: () => { ran++; void f!.player.destroy(); } }); f = made; f.pub.setMode('refuse');
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      if (draft === 22) await f.pub.answerFill('nextVideo');
      await f.advance(20);
      const buffers = [...f.native.sourceBuffers];
      const before = buffers.map(b => [b.changeTypeCalls.length, b.appendedPayloads.length]);
      await f.pub.publish('nextVideo', n + 2n, 0n).catch(() => {}); await f.advance(100); f.pub.stop('nextVideo');
      expect(ran, 'the reservation was requested').toBe(1);
      expect(f.handles, 'returned stale: revoked, never activated').toEqual([{ activated: 0, revoked: 1 }]);
      expect((f.player as unknown as { videoSwitchRecovery: unknown }).videoSwitchRecovery, 'not installed').toBeNull();
      expect(f.events.some(e => e.startsWith('quality_switched')), 'not adopted').toBe(false);
      expect(f.of('nextVideo', f.submissions), 'no target media submitted').toEqual([]);
      expect(buffers.map(b => [b.changeTypeCalls.length, b.appendedPayloads.length]), 'no retype, init or media after the stale return').toEqual(before);
    } finally { await f.destroy(); }
  });

  it('a player destroyed while the timestamp offset is read after the reservation releases the installed handle', async () => {
    const f = await fixture(draft, { controlledClock: true }); f.pub.setMode('refuse');
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      if (draft === 22) await f.pub.answerFill('nextVideo');
      await f.advance(20);
      const read = f.adapter.getTimestampOffset.bind(f.adapter); let reads = 0;
      f.adapter.getTimestampOffset = mediaType => { if (f.handles.length === 1 && reads++ === 0) void f.player.destroy(); return read(mediaType); };
      await f.pub.publish('nextVideo', n + 2n, 0n).catch(() => {}); await f.advance(100); f.pub.stop('nextVideo');
      expect(reads, 'the offset was read after the reservation').toBeGreaterThan(0);
      expect(f.handles).toEqual([{ activated: 0, revoked: 1 }]);
      expect(f.of('nextVideo', f.submissions)).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('a newer video selection ends the permission of the adopted restart', async () => {
    const { f } = await fallback('refuse');
    try {
      f.video.advancePlayback(2);
      const back = f.player.selectVideoTrack('video'); back.catch(() => {}); await settle(); // left unanswered
      f.stallAt(OLD_END);
      await sit(f, 5_000);
      expect(f.video.seekCount, 'the superseded restart may no longer cross').toBe(0);
      expect(f.video.currentTime).toBe(OLD_END); expect(f.jumps).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('revisit: with video already buffered ahead of the output, a restart back to the earlier rendition is declined and the current route continues', async () => {
    const { f, n } = await fallback('refuse');
    try {
      // nextVideo is now the output with [[0, 3.5], [6, 9]] buffered; the playhead is still inside the first range.
      expect(f.rangesOf('video')).toEqual([[0, OLD_END], [TARGET_START, 9]]);
      f.video.advancePlayback(2);
      const current = f.requests.filter(r => r.name === 'nextVideo').at(-1)!;
      const before = { events: f.events.length, unsubscribed: f.unsubscribed.length, old: f.of('video', f.submissions).length };
      // The earlier rendition has history the subscriber never received, and its retrieval is refused again.
      f.pub.stop('video'); await f.pub.publishGroup('video', n + 2n); await f.pub.publishGroup('video', n + 3n);
      const back = f.player.selectVideoTrack('video'); back.catch(() => {}); await settle();
      await f.pub.accept('video');
      if (draft === 22) await f.pub.answerFill('video');
      await f.advance(20);
      await f.pub.publish('video', n + 5n, 0n); await f.advance(100); f.pub.stop('video');
      const later = f.events.slice(before.events);
      expect(later.some(e => e.startsWith('quality_switched')), 'the restart is not adopted').toBe(false);
      expect(later.some(e => e.startsWith('quality_switch_failed'))).toBe(true);
      expect(f.unsubscribed.slice(before.unsubscribed).some(u => u.id === current.id), 'the current rendition is not retired').toBe(false);
      expect(f.of('video', f.submissions).length, 'no media of the declined rendition submitted').toBe(before.old);
      await f.pub.publishGroup('nextVideo', n + 4n); await f.pub.publishGroup('audio', n + 4n); await f.advance(100);
      expect(f.appended('nextVideo'), 'the current route keeps delivering').toEqual(expect.arrayContaining([loc(n + 4n, 0n)]));
      expect(f.rangesOf('video')).toEqual([[0, OLD_END], [TARGET_START, 10.5]]);
      expect(f.fatal).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('control: while history is still pending, nothing is crossed and nothing of the target is appended', async () => {
    const f = await fixture(draft, { controlledClock: true }); f.pub.setMode('none');
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      await f.advance(20);
      await f.pub.publishGroup('nextVideo', n + 2n);
      f.stallAt(OLD_END);
      await f.advance(500); // inside the one-second prefix window
      expect(f.events.some(e => e.startsWith('quality_switched')), 'not committed while pending').toBe(false);
      expect(f.of('nextVideo', f.submissions), 'no target media appended while pending').toEqual([]);
      expect(f.video.seekCount, 'no crossing while pending').toBe(0);
      expect(f.video.currentTime).toBe(OLD_END);
      expect(f.fatal).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('control: the same wide hole on one rendition, with no fallback decision, keeps the current policy (no crossing; fatal after its bound)', async () => {
    const f = await fixture(draft, { controlledClock: true });
    try {
      const n = await playOldPartial(f);
      // The publisher itself skips: the old rendition continues at Group 5 with Groups 3-tail and 4 never published.
      await f.pub.publishGroup('video', n + 2n); for (const g of [n + 1n, n + 2n]) await f.pub.publishGroup('audio', g);
      await f.advance(3_000); // the existing old-group tail wait releases the successor
      expect(f.rangesOf('video'), 'same shape of hole, no switch').toEqual([[0, OLD_END], [TARGET_START, 7.5]]);
      f.stallAt(OLD_END);
      await sit(f, FATAL_AFTER_MS + 4_000);
      const seen = outcome(f);
      expect(seen.seeks, 'no crossing of an unexplained wide hole').toBe(0);
      expect(seen.currentTime).toBe(OLD_END);
      expect(seen.fatal.some(m => m.includes('unrecoverable buffered hole')), 'current bounded policy escalates').toBe(true);
    } finally { await f.destroy(); }
  });

  it('control: an explicit caller subscription filter issues no history retrieval and gains no permission to cross the resulting hole', async () => {
    const f = await fixture(draft, { controlledClock: true, subscriptionFilter: { type: 'LargestObject' } }); f.pub.setMode('serve');
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      await f.advance(20);
      for (const g of [n + 2n, n + 3n]) { await f.pub.publishGroup('nextVideo', g); await f.pub.publishGroup('audio', g - 1n); await f.advance(100); }
      await f.pub.publishGroup('audio', n + 2n); await f.pub.publishGroup('audio', n + 3n); await f.advance(100);
      expect(f.pub.joiningFor('nextVideo'), 'no automatic history request under an explicit filter').toHaveLength(0);
      expect(f.pub.fillOf('nextVideo')).toBeNull();
      expect(f.pub.served).toEqual([]);
      expect(f.rangesOf('video')).toEqual([[0, OLD_END], [TARGET_START, 9]]);
      f.stallAt(OLD_END);
      await sit(f, FATAL_AFTER_MS + 4_000);
      const seen = outcome(f);
      expect(seen.seeks, 'an explicit range intent is not a live-jump permission').toBe(0);
      expect(seen.currentTime).toBe(OLD_END);
    } finally { await f.destroy(); }
  });
  it('control: a finite target gets no history retrieval, no live fallback and no permission to cross the resulting hole', async () => {
    const f = await fixture(draft, { controlledClock: true, finiteTarget: true }); f.pub.setMode('serve');
    try {
      const n = await playOldPartial(f);
      await f.pub.publishGroup('nextVideo', n); await f.pub.publishGroup('nextVideo', n + 1n);
      const switching = f.player.selectVideoTrack('nextVideo'); switching.catch(() => {}); await settle();
      await f.pub.accept('nextVideo');
      await f.advance(20);
      for (const g of [n + 2n, n + 3n]) { await f.pub.publishGroup('nextVideo', g); await f.pub.publishGroup('audio', g - 1n); await f.advance(100); }
      await f.pub.publishGroup('audio', n + 2n); await f.pub.publishGroup('audio', n + 3n); await f.advance(1_300);
      expect(f.pub.joiningFor('nextVideo'), 'no automatic history request for a finite target').toHaveLength(0);
      expect(f.pub.fillOf('nextVideo')).toBeNull();
      expect(f.pub.served).toEqual([]);
      expect(f.rangesOf('video')).toEqual([[0, OLD_END], [TARGET_START, 9]]);
      f.stallAt(OLD_END);
      await sit(f, FATAL_AFTER_MS + 4_000);
      const seen = outcome(f);
      expect(seen.seeks, 'finite media is not skipped under a live recovery policy').toBe(0);
      expect(seen.currentTime).toBe(OLD_END);
      expect(seen.jumps).toBe(0);
    } finally { await f.destroy(); }
  });
});
