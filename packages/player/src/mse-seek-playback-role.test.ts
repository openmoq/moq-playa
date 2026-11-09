import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import type { CmafAppendObservation, SeekTrack } from './mse-seek-playback.js';
import { MseSeekPlayback } from './mse-seek-playback.js';
import { MseSeekOutput } from './mse-seek-output.js';
import { SeekCmafInput } from './seek-cmaf-input.js';
import type { CmafAssemblerLike, MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function settle() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}

async function allLanded(f: ReturnType<typeof fixture>) {
  f.playback.start();
  for (const track of f.options.tracks) {
    const page = f.page(track.role);
    await page.receiver.onObject(object(track.role === 'video' ? payloads[0]! : cmaf(0, 2000, 'audio')));
    page.receiver.onClosed('fin');
  }
  await settle(); f.land(); await settle();
}


type Role = 'video' | 'audio';
const init = (role: Role) => buildInit({ trackId: role === 'video' ? 1 : 2, timescale: 1000, handler: role === 'video' ? 'vide' : 'soun' });
const cmaf = (index: number, duration = 2000, role: Role = 'video') => buildChunk({ trackId: role === 'video' ? 1 : 2,
  bmdt: 4000n + BigInt(index * 2000), samples: [{ duration, size: 4, flags: index ? NON_SYNC_FLAGS : SYNC_FLAGS }], mdat: Uint8Array.of(41, 42, 43, index) });
function encoded(count = 3, secondDuration = 2000) {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState(), context = parseLocmafTrackContext(init('video'));
  return Array.from({ length: count }, (_, i) => {
    const object = encoder.encode(cmaf(i, i === 1 ? secondDuration : 2000), state, context, false, BigInt(i));
    if (object.kind !== 'moof' || object.header.full !== (i === 0 || i === 2 && secondDuration !== 2000)) throw new Error('Bad LOCMAF fixture');
    return serializeLocmafObject(object);
  });
}
const payloads = encoded();
function object(payload: Uint8Array, id = 0n): MoqtObject {
  return { kind: 'data', payload, groupId: varint(3), objectId: varint(id), subgroupId: varint(0), trackAlias: varint(0), publisherPriority: 128 };
}
function fixture(audio = false, autoAppend = true, packaging: 'locmaf' | 'cmaf' = 'locmaf',
  indexed = { objectId: 0n, mediaPts: 4000, targetMs: 5000 }, budget = { maxObjects: 10, maxBytes: 8192 }) {
  const epoch = {}, nativeId = {}, position = deferred<MediaSeekSample>();
  const roles: readonly Role[] = audio ? ['video', 'audio'] : ['video'];
  let nativeAuto = autoAppend;
  let current = true, nativeCurrent = true, observer: MediaAppendObserver | null = null, now = 5.125, sample: MediaSeekSample | null = null;
  const tokens: object[] = [], appended: Uint8Array[] = [], observations: CmafAppendObservation[] = [];
  const placements: Array<MockInstance<CmafAssembler['setPresentationPlacement']>> = [];
  const resource: MediaSeekResource = { epoch, resource: nativeId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: vi.fn(async () => {}),
    observeAppends(fn) { observer = fn; return () => { observer = null; }; },
    appendChunk: vi.fn((_role, bytes, _name, _group, token) => {
      tokens.push(token!); appended.push(bytes.slice()); if (nativeAuto) observer?.({ token: token!, state: 'appended', reason: null });
    }),
    position: vi.fn(() => position.promise), sample: vi.fn(() => sample && { ...sample, currentTime: now }),
    setPlaybackIntent: vi.fn(), getTimestampOffset: vi.fn(() => 0), setTimestampOffset: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }) };
  const begin = vi.fn(() => resource), source: MediaSourceLike = { mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    beginSeek: begin, initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
  const tracks: SeekTrack[] = roles.map(role => ({ role, name: role, namespace: ['show'], sourceKey: role,
    codec: role === 'video' ? 'avc1.640028' : 'mp4a.40.2', init: init(role), packaging: role === 'audio' ? 'cmaf' : packaging }));
  const live = new CmafAssembler({ onSegment: vi.fn() }), adopted = vi.fn(), drained = vi.fn(), pageError = vi.fn(), failed = vi.fn(), positioned = vi.fn();
  const create = vi.fn((callbacks: Parameters<ConstructorParameters<typeof MseSeekPlayback>[0]['createAssembler']>[0]) => {
    const assembler = new CmafAssembler(callbacks); placements.push(vi.spyOn(assembler, 'setPresentationPlacement')); return assembler;
  });
  let owned: { resource: MediaSeekResource; assembler: CmafAssemblerLike } | null = null;
  type Options = ConstructorParameters<typeof MseSeekPlayback>[0];
  const options: { -readonly [K in keyof Options]: Options[K] } = { epoch, source, liveAssembler: live, createAssembler: create, tracks,
    location: { groupId: 3n, objectId: indexed.objectId }, mediaPts: indexed.mediaPts, timestampRounding: 'floor', targetMs: indexed.targetMs,
    maxObjects: budget.maxObjects, maxBytes: budget.maxBytes, preparationTimeoutMs: 1000, playing: false, isCurrent: () => current,
    beforeResourceChange: vi.fn(), adopt: value => { owned = value; adopted(value); }, onSegment: vi.fn(), onDiscard: vi.fn(),
    onPosition: positioned, onPageDrained: drained, onPageError: pageError, onError: failed, onSubmitted: vi.fn(),
    observeAppend: vi.fn(() => { const observation = { token: {}, discard: vi.fn() }; observations.push(observation); return observation; }) };
  const playback = new MseSeekPlayback(options);
  cleanups.push(() => { playback.cancel(); owned?.resource.cancel(); owned?.assembler.destroy(); live.destroy(); });
  function page(role: Role = 'video', end = false, accept = true) {
    const identity = {}, receiver = playback.beginPage(role, identity);
    if (accept) playback.acceptPage(role, identity, end);
    return { identity, receiver, accept: () => playback.acceptPage(role, identity, end) };
  }
  const complete = (i: number, state: 'appended' | 'discarded' = 'appended') => observer?.({ token: tokens[i]!, state, reason: state === 'appended' ? null : 'append error' });
  const land = () => { sample = { epoch, resource: nativeId, currentTime: now, buffered: { start: 4, end: 20 } }; position.resolve(sample); };
  async function first() {
    playback.start(); const p = page(); await p.receiver.onObject(object(packaging === 'locmaf' ? payloads[0]! : cmaf(0)));
    p.receiver.onClosed('fin'); await settle(); land(); await settle(); return p;
  }
  return { playback, options, page, first, complete, land, owned: () => owned, resource, begin, create, placements, appended, tokens,
    observations, adopted, drained, pageError, failed, positioned, setAutoAppend(value: boolean) { nativeAuto = value; }, setTime(value: number) { now = value; }, lose() { current = false; } };
}

function targetObjects(start = 6000n, independent = true) {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState(), context = parseLocmafTrackContext(init('video'));
  return [0, 1, 2].map(i => {
    const bytes = buildChunk({ trackId: 1, bmdt: start + BigInt(i * 2000),
      samples: [{ duration: 2000, size: 4, flags: i || !independent ? NON_SYNC_FLAGS : SYNC_FLAGS }], mdat: Uint8Array.of(71, 72, 73, i) });
    return { ...object(serializeLocmafObject(encoder.encode(bytes, state, context, false, BigInt(i))), BigInt(i)), groupId: varint(4) };
  });
}
function target(f: ReturnType<typeof fixture>) {
  return { track: { ...f.options.tracks[0]!, name: 'new-video', sourceKey: 'new-video' },
    location: { groupId: 4n, objectId: 0n }, mediaPts: 6000, timestampRounding: 'floor' as const, targetMs: 6125,
    placement: { sourceTimeUs: 6000000n, rebasedTimeUs: { numerator: 6000000n, denominator: 1n } },
    onPageDrained: vi.fn(), onPageError: vi.fn(), onError: vi.fn() };
}
async function prepared(f: ReturnType<typeof fixture>, options: Parameters<MseSeekPlayback['prepareRole']>[0] = target(f)) {
  const candidate = f.playback.prepareRole(options), identity = {}, receiver = candidate.beginPage(identity);
  candidate.acceptPage(identity, false);
  const input = {}, work = receiver.onObject(targetObjects()[0]!, input); void work.catch(() => {});
  await candidate.ready; return { candidate, identity, receiver, work, input, options };
}

describe('same-init role preparation and suspension', () => {
  it('exposes the actual role binding and refuses preparation before adoption or for another codec/init', async () => {
    const f = fixture(); expect(f.playback.roleOwner('audio')).toBeNull();
    expect(() => f.playback.prepareRole(target(f))).toThrow(/adopt|position/i);
    await f.first(); const owner = f.playback.roleOwner('video'); expect(owner).not.toBeNull();
    const changed = target(f); changed.track.codec = 'hvc1.1.6.L93.90';
    expect(() => f.playback.prepareRole(changed)).toThrow(/codec|initialization/i);
    changed.track.codec = f.options.tracks[0]!.codec; changed.track.init = Uint8Array.of(0);
    expect(() => f.playback.prepareRole(changed)).toThrow(/initialization/i);
    expect(f.playback.roleOwner('video')).toBe(owner); expect(f.appended).toHaveLength(1);
  });

  it('requires matching acceptance before parsing and holds ready data without native mutation', async () => {
    const f = fixture(); await f.first(); const options = target(f), candidate = f.playback.prepareRole(options);
    const identity = {}, receiver = candidate.beginPage(identity), decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    await receiver.onObject(targetObjects()[0]!); receiver.onClosed('fin'); await settle();
    expect(decode).not.toHaveBeenCalled(); candidate.acceptPage({}, false); await settle(); expect(decode).not.toHaveBeenCalled();
    candidate.acceptPage(identity, false); await candidate.ready;
    expect(f.appended).toHaveLength(1); expect(f.create).toHaveBeenCalledOnce(); expect(f.placements[0]).toHaveBeenCalledOnce();
    expect(options.onPageDrained).not.toHaveBeenCalled(); candidate.cancel();
  });

  it('promotes the same LOCMAF consumer across target page, successor delta and live delta', async () => {
    const f = fixture(); await f.first(); const old = f.playback.roleOwner('video'), p = await prepared(f);
    const payload = targetObjects(), delta = payload[1]!; if (delta.kind !== 'data') throw new Error('Invalid fixture');
    expect(new LocmafTrackDecoder(init('video')).push(4n, 1n, delta.payload).kind).toBe('rejected');
    const hold = f.playback.holdRole('video', old!); await hold.nativeSettled; hold.commit(p.candidate);
    await p.work; p.receiver.onClosed('fin'); await settle();
    expect(p.options.onPageDrained).toHaveBeenCalledExactlyOnceWith(p.identity);
    const next = {}, receiver = p.candidate.beginPage(next); p.candidate.acceptPage(next, false);
    await receiver.onObject(payload[1]!); receiver.onClosed('fin'); await settle();
    const live = p.candidate.beginLive({}); f.setTime(8); f.playback.tick(); await live.onObject(payload[2]!);
    expect(f.appended.map(bytes => [...bytes.slice(-4)])).toEqual([[41,42,43,0],[71,72,73,0],[71,72,73,1],[71,72,73,2]]);
    expect(f.playback.roleOwner('video')).not.toBe(old); expect(f.begin).toHaveBeenCalledOnce();
    expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.positioned).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('holds old live parsing and resumes its exact retained delta chain while audio continues', async () => {
    const f = fixture(true); await allLanded(f);
    const video = f.playback.beginLive('video', {}), audio = f.playback.beginLive('audio', {}), old = f.playback.roleOwner('video');
    const hold = f.playback.holdRole('video', old!), decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    const waiting = video.onObject(object(payloads[1]!, 1n)), done = vi.fn(); void waiting.then(done, () => {});
    await settle(); expect(decode).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
    await audio.onObject(object(cmaf(1, 2000, 'audio'), 1n));
    expect(f.appended).toHaveLength(3); hold.resume(); await waiting;
    expect(decode).toHaveBeenCalledOnce(); expect(f.appended).toHaveLength(4); expect(f.failed).not.toHaveBeenCalled();
    expect(f.playback.roleOwner('video')).toBe(old);
  });

  it('commits while paused on far-ahead old native credit and preserves audio ownership', async () => {
    const f = fixture(true); await allLanded(f);
    const video = f.playback.beginLive('video', {}), audio = f.playback.beginLive('audio', {}), old = f.playback.roleOwner('video');
    const audioOwner = f.playback.roleOwner('audio');
    const far = video.onObject(object(encoded(2, 14000)[1]!, 1n), {}); void far.catch(() => {}); await settle();
    const p = await prepared(f), hold = f.playback.holdRole('video', old!); await hold.nativeSettled; hold.commit(p.candidate);
    await expect(far).rejects.toMatchObject({ name: 'AbortError' }); await p.work;
    expect(f.observations[2]!.discard).not.toHaveBeenCalled();
    p.receiver.onClosed('fin'); await settle();
    await audio.onObject(object(cmaf(1, 2000, 'audio'), 1n));
    expect(f.playback.roleOwner('audio')).toBe(audioOwner); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('waits for already submitted native work, not old read credit, before permitting commit', async () => {
    const f = fixture(); await f.first(); const p = await prepared(f); f.setAutoAppend(false);
    const live = f.playback.beginLive('video', {}), work = live.onObject(object(payloads[1]!, 1n)); void work.catch(() => {});
    await settle(); const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!), done = vi.fn(); void hold.nativeSettled.then(done);
    expect(() => hold.commit(p.candidate)).toThrow(/native|settle/i); await settle(); expect(done).not.toHaveBeenCalled();
    f.complete(1); await hold.nativeSettled; hold.commit(p.candidate); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); f.complete(2); await p.work; expect(f.failed).not.toHaveBeenCalled();
  });

  it('refuses unready and foreign candidates and stale holds without consuming the old role', async () => {
    const f = fixture(); await f.first(); const candidate = f.playback.prepareRole(target(f));
    const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!);
    expect(() => hold.commit(candidate)).toThrow(/ready|prepared/i); expect(hold.current).toBe(true);
    hold.resume(); expect(() => hold.commit(candidate)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    candidate.cancel(); const g = fixture(); await g.first(); const foreign = await prepared(g);
    const next = f.playback.holdRole('video', f.playback.roleOwner('video')!);
    expect(() => next.commit(foreign.candidate)).toThrow(/candidate|owner/i); next.resume(); foreign.candidate.cancel();
  });

  it('candidate refusal/cancel never poisons or resets the old decoder', async () => {
    const f = fixture(); await f.first(); const options = target(f), candidate = f.playback.prepareRole(options), identity = {}, receiver = candidate.beginPage(identity);
    const rejected = expect(candidate.ready).rejects.toThrow(/reset|error|FETCH/i); receiver.onClosed('reset'); await rejected;
    expect(options.onPageError).toHaveBeenCalledOnce(); expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
    const live = f.playback.beginLive('video', {}); await live.onObject(object(payloads[1]!, 1n)); expect(f.appended).toHaveLength(2);
  });

  it('retains diagnostics once through candidate cancellation and ignores late callbacks', async () => {
    const f = fixture(); await f.first(); const p = await prepared(f), rejected = expect(p.work).rejects.toMatchObject({ name: 'AbortError' });
    p.candidate.cancel(); await rejected;
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(p.input, 'epoch refused');
    p.receiver.onClosed('fin'); p.candidate.acceptPage(p.identity, false);
    await expect(p.receiver.onObject(targetObjects()[1]!)).rejects.toMatchObject({ name: 'AbortError' });
    expect(p.options.onPageError).not.toHaveBeenCalled(); expect(p.options.onPageDrained).not.toHaveBeenCalled();
  });

  it('late old page and live errors cannot publish into a promoted role generation', async () => {
    const f = fixture(); await f.first(); const old = f.playback.beginLive('video', {}), p = await prepared(f);
    const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!); await hold.nativeSettled; hold.commit(p.candidate); await p.work;
    await expect(old.onObject(object(payloads[1]!, 1n))).rejects.toMatchObject({ name: 'AbortError' }); old.cancel();
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled(); expect(f.appended).toHaveLength(2);
  });

  it('preparation is bounded even when many accepted objects arrive without promotion', async () => {
    const f = fixture(); await f.first(); f.options.maxObjects = 1; const p = await prepared(f);
    await expect(p.receiver.onObject(targetObjects()[1]!)).rejects.toThrow(/budget|exceeds/i);
    await expect(p.work).rejects.toThrow(); expect(p.options.onPageError).toHaveBeenCalledOnce();
    expect(f.failed).not.toHaveBeenCalled(); expect(f.appended).toHaveLength(1);
  });

  it('uses actual placement and native offset to prove target coverage without mutating the assembler', async () => {
    const f = fixture(); await f.first(); vi.mocked(f.resource.getTimestampOffset).mockImplementation(() => 1);
    const options = target(f); options.placement.rebasedTimeUs.numerator = 4000000n; options.targetMs = 5125;
    const p = await prepared(f, options); expect(f.appended).toHaveLength(1);
    const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!); await hold.nativeSettled; hold.commit(p.candidate); await p.work;
    expect(f.appended[1]!.slice(-4)).toEqual(Uint8Array.of(71,72,73,0)); expect(f.resource.position).toHaveBeenCalledOnce();
  });

  it('rejects offset changes before consuming hold or candidate authority', async () => {
    const f = fixture(); await f.first(); const p = await prepared(f), hold = f.playback.holdRole('video', f.playback.roleOwner('video')!);
    await hold.nativeSettled; vi.mocked(f.resource.getTimestampOffset).mockImplementation(() => 1);
    expect(() => hold.commit(p.candidate)).toThrow(/offset|placement/i); expect(hold.current).toBe(true); hold.resume(); p.candidate.cancel();
  });

  it('closes candidate, old gate and native waiters before cleanup callbacks can reenter', async () => {
    const f = fixture(); await f.first(); const p = await prepared(f), old = f.playback.beginLive('video', {});
    const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!), blocked = old.onObject(object(payloads[1]!, 1n));
    const rejected = [p.work, blocked].map(work => expect(work).rejects.toMatchObject({ name: 'AbortError' }));
    f.playback.cancel(); await Promise.all(rejected); expect(hold.current).toBe(false); expect(f.playback.roleOwner('video')).toBeNull();
    expect(f.failed).not.toHaveBeenCalled(); expect(p.options.onPageError).not.toHaveBeenCalled();
  });
  it('a held historical page resumes the exact object and FIN instead of reporting a range failure', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video'), page = f.page();
    const hold = f.playback.holdRole('video', owner!), input = {};
    const work = page.receiver.onObject(object(payloads[1]!, 1n), input), done = vi.fn(); void work.then(done, () => {});
    page.receiver.onClosed('fin'); await settle(); expect(done).not.toHaveBeenCalled(); expect(f.appended).toHaveLength(1);
    hold.resume(); await work; await settle(); expect(f.drained).toHaveBeenCalledTimes(2);
    expect(f.options.onDiscard).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('revokes old ownership before disposal reentry can close the promoted host', async () => {
    const f = fixture(); await f.first(); const p = await prepared(f), owner = f.playback.roleOwner('video');
    const old = f.playback.beginLive('video', {}), hold = f.playback.holdRole('video', owner!);
    const work = old.onObject(object(payloads[1]!, 1n), {});
    const rejected = [work, p.work].map(value => expect(value).rejects.toMatchObject({ name: 'AbortError' }));
    await hold.nativeSettled;
    vi.mocked(f.options.onDiscard!).mockImplementation(() => { expect(f.playback.roleOwner('video')).not.toBe(owner); f.playback.cancel(); });
    expect(() => hold.commit(p.candidate)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    await Promise.all(rejected); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('a hold reentered while native submission registers still owns that actual native terminal', async () => {
    const f = fixture(); await f.first(); const p = await prepared(f), old = f.playback.beginLive('video', {});
    let hold: ReturnType<MseSeekPlayback['holdRole']> | undefined, armed = false, used = false;
    vi.mocked(f.options.observeAppend!).mockImplementation(() => { armed = true; const observation = { token: {}, discard: vi.fn() }; f.observations.push(observation); return observation; });
    Object.defineProperty(f.resource, 'current', { get() {
      if (armed && !used) { used = true; hold = f.playback.holdRole('video', f.playback.roleOwner('video')!); }
      return true;
    } });
    const work = old.onObject(object(encoded(2, 14000)[1]!, 1n)); void work.catch(() => {});
    await settle(); expect(hold).toBeDefined(); await hold!.nativeSettled; hold!.commit(p.candidate);
    await expect(work).rejects.toMatchObject({ name: 'AbortError' }); await p.work;
    expect(f.appended.map(bytes => [...bytes.slice(-4)])).toEqual([[41,42,43,0],[41,42,43,1],[71,72,73,0]]);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('candidate disposal can withdraw admission without publishing a stale page error', async () => {
    const f = fixture(); await f.first(); let current = true;
    const options = { ...target(f), isCurrent: () => current }, p = await prepared(f, options);
    const rejected = expect(p.work).rejects.toThrow();
    vi.mocked(f.options.onDiscard!).mockImplementation(() => { current = false; });
    p.receiver.onClosed('reset'); await rejected;
    expect(options.onPageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('refuses a role hold before native positioning without leaving the original role gated', async () => {
    const f = fixture(); f.playback.start(); const page = f.page(); await page.receiver.onObject(object(payloads[0]!));
    expect(() => f.playback.holdRole('video', f.playback.roleOwner('video')!)).toThrow(/position/i);
    page.receiver.onClosed('fin'); await settle(); f.land(); await settle();
    const live = f.playback.beginLive('video', {}); await live.onObject(object(payloads[1]!, 1n));
    expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled();
  });

  it('genuine old live completion stays gated until resume and does not become a range failure', async () => {
    const f = fixture(); await f.first(); const live = f.playback.beginLive('video', {});
    const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!), end = live.endTrack(), done = vi.fn();
    void end.then(done, () => {}); await settle(); expect(done).not.toHaveBeenCalled();
    hold.resume(); await end; expect(done).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    expect(f.pageError).not.toHaveBeenCalled();
  });

  it.each(['index', 'SAP', 'coverage'] as const)('never declares target readiness without actual %s proof', async missing => {
    const f = fixture(); await f.first(); const options = target(f);
    if (missing === 'index') options.mediaPts = 6001;
    if (missing === 'coverage') options.targetMs = 10000;
    const candidate = f.playback.prepareRole(options), identity = {}, receiver = candidate.beginPage(identity);
    const rejected = expect(candidate.ready).rejects.toThrow(); candidate.acceptPage(identity, false);
    const work = receiver.onObject(targetObjects(6000n, missing !== 'SAP')[0]!); void work.catch(() => {});
    if (missing === 'index') await expect(work).rejects.toThrow(/index|timeline/i);
    else { await work; receiver.onClosed('fin'); }
    await rejected; expect(options.onPageError).toHaveBeenCalledOnce();
    expect(f.appended).toHaveLength(1); expect(f.failed).not.toHaveBeenCalled();
  });

});

describe('role commit admission reentry', () => {
  it('does not promote after final candidate admission resumes the old hold and installs a successor', async () => {
    const f = fixture(true); await allLanded(f);
    const owner = f.playback.roleOwner('video')!;
    let armed = false, fired = false;
    let hold: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    let successor: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    let successorBarrier = 'not-created';
    const p = await prepared(f, { ...target(f), isCurrent: () => {
      if (armed && !fired) {
        fired = true; hold!.resume();
        successor = f.playback.holdRole('video', owner);
        successorBarrier = 'pending';
        void successor.nativeSettled.then(() => { successorBarrier = 'resolved'; }, () => { successorBarrier = 'rejected'; });
      }
      return true;
    } });
    hold = f.playback.holdRole('video', owner); await hold.nativeSettled;
    vi.mocked(f.resource.getTimestampOffset).mockImplementation(() => { armed = true; return 0; });
    let caught: unknown;
    try { hold.commit(p.candidate); } catch (error) { caught = error; }
    await settle();
    const observed = { fired, abort: caught instanceof Error ? caught.name : null,
      oldOwnerPreserved: f.playback.roleOwner('video') === owner,
      successorCurrent: successor?.current, successorBarrier,
      globalErrors: f.failed.mock.calls.map(call => call[0] instanceof Error ? call[0].message : String(call[0])),
      nativeResourceCanceled: vi.mocked(f.resource.cancel).mock.calls.length,
    };
    expect(observed).toEqual({ fired: true, abort: 'AbortError', oldOwnerPreserved: true,
      successorCurrent: true, successorBarrier: 'resolved', globalErrors: [], nativeResourceCanceled: 0 });
    successor?.resume(); p.candidate.cancel();
  });

  it('healthy final admission preserves both roles and promotes exactly once', async () => {
    const f = fixture(true); await allLanded(f); const owner = f.playback.roleOwner('video'), audio = f.playback.roleOwner('audio');
    const admission = vi.fn(() => true), p = await prepared(f, { ...target(f), isCurrent: admission });
    const hold = f.playback.holdRole('video', owner!); await hold.nativeSettled; hold.commit(p.candidate); await p.work;
    expect(admission).toHaveBeenCalled(); expect(f.playback.roleOwner('video')).not.toBe(owner);
    expect(f.playback.roleOwner('audio')).toBe(audio); expect(f.failed).not.toHaveBeenCalled();
    expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.positioned).toHaveBeenCalledOnce();
  });
});

describe('stale role commit continuation', () => {
  it('resumes retained old-role delta work from the owned successor after the stale commit abort', async () => {
    const f = fixture(true); await allLanded(f);
    const owner = f.playback.roleOwner('video')!, audioOwner = f.playback.roleOwner('audio');
    const old = f.playback.beginLive('video', {});
    let armed = false, fired = false;
    let hold: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    let successor: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    const p = await prepared(f, { ...target(f), isCurrent: () => {
      if (armed && !fired) { fired = true; hold!.resume(); successor = f.playback.holdRole('video', owner); }
      return true;
    } });
    hold = f.playback.holdRole('video', owner); await hold.nativeSettled;
    const input = {}, pending = old.onObject(object(payloads[1]!, 1n), input), done = vi.fn();
    void pending.then(done, () => {}); await settle(); expect(done).not.toHaveBeenCalled();
    expect(f.appended).toHaveLength(2);
    vi.mocked(f.resource.getTimestampOffset).mockImplementation(() => { armed = true; return 0; });
    expect(() => hold!.commit(p.candidate)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    await settle(); expect(fired).toBe(true); expect(successor?.current).toBe(true);
    await successor!.nativeSettled; expect(done).not.toHaveBeenCalled();
    expect(f.playback.roleOwner('video')).toBe(owner); expect(f.playback.roleOwner('audio')).toBe(audioOwner);
    successor!.resume(); await pending;
    expect(done).toHaveBeenCalledOnce(); expect(f.appended).toHaveLength(3);
    expect(f.appended[2]!.slice(-4)).toEqual(Uint8Array.of(41,42,43,1));
    expect(f.playback.roleOwner('video')).toBe(owner); expect(f.playback.roleOwner('audio')).toBe(audioOwner);
    expect(f.options.onDiscard).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
    expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.positioned).toHaveBeenCalledOnce();
    expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.cancel).not.toHaveBeenCalled();
    p.candidate.cancel(); await expect(p.work).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });
});


describe('resource-bound native submission frontier', () => {
  it('reserves owner/group/exact end before a synchronous native callback, without claiming completion', async () => {
    const f = fixture(false, false);
    const before = f.playback.roleOwner('video')!;
    expect(f.playback.submissionFrontier('video', before)).toBeNull();
    const nativeAppend = vi.mocked(f.resource.appendChunk).getMockImplementation()!;
    vi.mocked(f.resource.appendChunk).mockImplementation((...args) => {
      const frontier = f.playback.submissionFrontier('video', before)!;
      expect(frontier.owner).toBe(before); expect(frontier.resource).toBe(f.resource.resource);
      expect(frontier.epoch).toBe(f.resource.epoch); expect(frontier.sourceKey).toBe('video');
      expect(frontier.highestSubmittedGroup).toBe(3n);
      expect(frontier.maxSubmittedEndUs!.numerator).toBe(6000000n * frontier.maxSubmittedEndUs!.denominator);
      expect(Object.isFrozen(frontier)).toBe(true); expect(Object.isFrozen(frontier.maxSubmittedEndUs)).toBe(true);
      nativeAppend(...args);
    });
    f.playback.start(); const p = f.page(), done = vi.fn();
    const work = p.receiver.onObject(object(payloads[0]!)); void work.then(done, () => {});
    await settle(); expect(f.appended).toHaveLength(1); expect(done).not.toHaveBeenCalled();
    expect(f.positioned).not.toHaveBeenCalled(); f.complete(0); await work;
    p.receiver.onClosed('fin'); await settle(); f.land(); await settle();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('preserves the resource end floor across video replacement while audio and native placement stay owned', async () => {
    const f = fixture(true); await allLanded(f); f.setTime(7);
    const p = f.page(); await p.receiver.onObject(object(payloads[1]!, 1n));
    await p.receiver.onObject(object(payloads[2]!, 2n)); p.receiver.onClosed('fin'); await settle();
    const old = f.playback.roleOwner('video')!, audio = f.playback.roleOwner('audio')!;
    const prior = f.playback.submissionFrontier('video', old)!, priorAudio = f.playback.submissionFrontier('audio', audio)!;
    const q = await prepared(f), hold = f.playback.holdRole('video', old); await hold.nativeSettled;
    hold.commit(q.candidate); await q.work;
    const owner = f.playback.roleOwner('video')!, frontier = f.playback.submissionFrontier('video', owner)!;
    expect(owner).not.toBe(old); expect(f.playback.submissionFrontier('video', old)).toBeNull();
    expect(frontier.resource).toBe(prior.resource); expect(frontier.epoch).toBe(prior.epoch);
    expect(frontier.highestSubmittedGroup).toBe(4n);
    expect(frontier.maxSubmittedEndUs!.numerator).toBe(10000000n * frontier.maxSubmittedEndUs!.denominator);
    expect(frontier.revision).not.toBe(prior.revision);
    expect(f.playback.roleOwner('audio')).toBe(audio);
    expect(f.playback.submissionFrontier('audio', audio)?.revision).toBe(priorAudio.revision);
    expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.positioned).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('refuses stale owners and changed native-offset context without rewriting the retained ledger', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
    const prior = f.playback.submissionFrontier('video', owner)!;
    expect(f.playback.submissionFrontier('video', {})).toBeNull();
    vi.mocked(f.resource.getTimestampOffset).mockReturnValue(0.25);
    expect(f.playback.submissionFrontier('video', owner)).toBeNull();
    vi.mocked(f.resource.getTimestampOffset).mockReturnValue(0);
    expect(f.playback.submissionFrontier('video', owner)?.revision).toBe(prior.revision);
    f.lose(); expect(f.playback.submissionFrontier('video', owner)).toBeNull();
  });

  it('does not return a stale snapshot when a native-offset accessor promotes a successor', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
    const q = await prepared(f), hold = f.playback.holdRole('video', owner); await hold.nativeSettled;
    vi.mocked(f.resource.getTimestampOffset).mockImplementationOnce(() => { hold.commit(q.candidate); return 0; });
    expect(f.playback.submissionFrontier('video', owner)).toBeNull(); await q.work;
    const successor = f.playback.roleOwner('video')!;
    expect(successor).not.toBe(owner); expect(f.playback.submissionFrontier('video', successor)?.highestSubmittedGroup).toBe(4n);
    expect(f.failed).not.toHaveBeenCalled();
  });
});

it('does not expose frontier authority when offset access revokes admission or retires native ownership', async () => {
  const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
  vi.mocked(f.resource.getTimestampOffset).mockImplementationOnce(() => { f.lose(); return 0; });
  expect(f.playback.submissionFrontier('video', owner)).toBeNull();
  const g = fixture(); await g.first(); const other = g.playback.roleOwner('video')!;
  vi.mocked(g.resource.getTimestampOffset).mockImplementationOnce(() => { g.resource.cancel(); return 0; });
  expect(g.playback.submissionFrontier('video', other)).toBeNull();
});

it('rejects actual actor append when the final offset accessor revokes only external admission', async () => {
  const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
  const prior = f.playback.submissionFrontier('video', owner)!;
  let reads = 0;
  vi.mocked(f.resource.getTimestampOffset).mockImplementation(() => { if (++reads === 2) f.lose(); return 0; });
  const p = f.page();
  await expect(p.receiver.onObject(object(payloads[1]!, 1n))).rejects.toMatchObject({ name: 'AbortError' });
  expect(reads).toBe(2); expect(f.appended).toHaveLength(1);
  expect(f.playback.submissionFrontier('video', owner)).toBeNull();
  expect(prior.highestSubmittedGroup).toBe(3n); expect(f.failed).not.toHaveBeenCalled();
});


describe('frontier final native-current authority', () => {
  it.each([false,true])('rechecks admission after the last native.current access: %s', async revoke => {
    const f=fixture(); await f.first();
    const owner=f.playback.roleOwner('video'); if(!owner)throw new Error('Expected adopted video owner');
    const before=f.playback.submissionFrontier('video',owner); expect(before).not.toBeNull();
    const descriptor=Object.getOwnPropertyDescriptor(f.resource,'current');
    if(!descriptor?.get)throw new Error('Expected native current getter');
    const cancel=vi.spyOn(f.playback,'cancel');let reads=0;
    Object.defineProperty(f.resource,'current',{...descriptor,get(){
      const value=descriptor.get!.call(f.resource);
      if(++reads===2&&revoke)f.lose();
      return value;
    }});
    const observed=f.playback.submissionFrontier('video',owner);
    expect(reads).toBe(2);expect(cancel).not.toHaveBeenCalled();
    expect(f.options.isCurrent()).toBe(!revoke);
    if(revoke)expect(observed,'final native getter revoked authority without canceling actor').toBeNull();
    else {expect(observed?.owner).toBe(owner);expect(observed?.revision).toBe(before?.revision);expect(Object.isFrozen(observed)).toBe(true);}
  });
});

describe('serial indexed group cut without additional read credit', () => {
  it('keeps earlier work serial and the exact G raw Object unparsed until resume', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false);
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push'), owner = f.playback.roleOwner('video')!;
    const cut = f.playback.holdRole('video', owner, { beforeGroup: 4n });
    expect(cut.reached).toBeInstanceOf(Promise);
    const reached = vi.fn(); void cut.reached.then(reached, () => {});
    const p = f.page(), prior = p.receiver.onObject(object(payloads[1]!, 1n)); void prior.catch(() => {});
    const raw = targetObjects(8000n)[0]!, held = p.receiver.onObject(raw); void held.catch(() => {});
    await settle(); expect(f.appended).toHaveLength(2); expect(reached).not.toHaveBeenCalled();
    expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(0);
    f.complete(1); await expect(cut.reached).resolves.toEqual({ groupId: 4n, objectId: 0n });
    await cut.nativeSettled;
    expect(cut.frontier?.highestSubmittedGroup).toBe(3n);
    expect(cut.frontier!.maxSubmittedEndUs!.numerator).toBe(8000000n * cut.frontier!.maxSubmittedEndUs!.denominator);
    expect(f.drained).toHaveBeenCalledTimes(1); expect(f.appended).toHaveLength(2);
    expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(0);
    cut.resume(); await settle(); expect(f.appended).toHaveLength(3); f.complete(2); await Promise.all([prior, held]);
    expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(1);
    p.receiver.onClosed('fin'); await settle(); expect(f.drained).toHaveBeenCalledTimes(2);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.positioned).toHaveBeenCalledOnce();
  });

  it('refuses a crossed submission or parser boundary and owns cancellation before any G arrives', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
    expect(() => f.playback.holdRole('video', owner, { beforeGroup: 3n })).toThrow(/submitted|frontier|crossed/);
    const p = f.page();
    await p.receiver.onObject({ kind: 'gap', trackAlias: varint(0), groupId: varint(8), objectId: varint(0), subgroupId: varint(0), status: varint(1) });
    expect(f.appended).toHaveLength(1);
    expect(() => f.playback.holdRole('video', owner, { beforeGroup: 8n })).toThrow(/entered|parser|crossed/);
    const cut = f.playback.holdRole('video', owner, { beforeGroup: 9n });
    const waits = [expect(cut.reached).rejects.toMatchObject({ name: 'AbortError' }), expect(cut.nativeSettled).rejects.toMatchObject({ name: 'AbortError' })];
    cut.resume(); await Promise.all(waits); expect(cut.current).toBe(false); expect(cut.frontier).toBeNull();
    const next = f.playback.holdRole('video', owner); await next.nativeSettled; next.resume();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('lets a preceding page finish and never needs FIN of the request bearing held G', async () => {
    const f = fixture(); await f.first(); const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 5n });
    expect(cut.reached).toBeInstanceOf(Promise);
    const p = f.page(); await p.receiver.onObject(object(payloads[1]!, 1n)); p.receiver.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenCalledTimes(2);
    const next = f.page(), raw = { ...targetObjects(8000n)[0]!, groupId: varint(5) };
    const work = next.receiver.onObject(raw); void work.catch(() => {});
    await cut.reached; await cut.nativeSettled; expect(f.drained).toHaveBeenCalledTimes(2);
    expect(f.appended).toHaveLength(2); cut.resume(); await work;
    next.receiver.onClosed('fin'); await settle(); expect(f.drained).toHaveBeenCalledTimes(3);
  });

  it('does not reach on pre-OK receipt and preserves that same staged raw Object', async () => {
    const f = fixture(); await f.first(); const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n });
    expect(cut.reached).toBeInstanceOf(Promise);
    const reached = vi.fn(); void cut.reached.then(reached, () => {});
    const p = f.page('video', false, false); await p.receiver.onObject(targetObjects(8000n)[0]!); await settle();
    expect(reached).not.toHaveBeenCalled(); expect(f.appended).toHaveLength(1);
    p.accept(); await cut.reached; await cut.nativeSettled; expect(f.appended).toHaveLength(1);
    cut.resume(); await settle(); expect(f.appended).toHaveLength(2);
    p.receiver.onClosed('fin'); await settle(); expect(f.drained).toHaveBeenCalledTimes(2);
  });

  it('commits only after reaching the cut and retires old G without poisoning the audio owner', async () => {
    const f = fixture(true); await allLanded(f); const owner = f.playback.roleOwner('video')!, audio = f.playback.roleOwner('audio')!;
    const q = await prepared(f), cut = f.playback.holdRole('video', owner, { beforeGroup: 4n });
    const earlySettlement = vi.fn(); void cut.nativeSettled.then(earlySettlement, () => {}); await settle();
    expect(earlySettlement).not.toHaveBeenCalled();
    expect(() => cut.commit(q.candidate)).toThrow(/cut|reached|settled/);
    const p = f.page(), input = {}, oldWork = p.receiver.onObject(targetObjects(8000n)[0]!, input); void oldWork.catch(() => {});
    await cut.reached; await cut.nativeSettled;
    const audioPage = f.page('audio'); await audioPage.receiver.onObject(object(cmaf(1, 2000, 'audio'), 1n));
    audioPage.receiver.onClosed('fin'); await settle();
    cut.commit(q.candidate); await q.work; await expect(oldWork).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.playback.roleOwner('video')).not.toBe(owner); expect(f.playback.roleOwner('audio')).toBe(audio);
    expect(f.options.onDiscard).toHaveBeenCalledWith(input, 'epoch refused');
    expect(f.playback.submissionFrontier('video', f.playback.roleOwner('video')!)?.highestSubmittedGroup).toBe(4n);
    expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('refuses arrival-ordered live intake and leaves that live consumer healthy', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {}), owner = f.playback.roleOwner('video')!;
    expect(() => f.playback.holdRole('video', owner, { beforeGroup: 4n })).toThrow(/ordered|historical/);
    await lease.onObject(object(payloads[1]!, 1n)); expect(f.appended).toHaveLength(2);
    expect(f.failed).not.toHaveBeenCalled(); lease.cancel();
  });
});

describe('indexed cut authority and teardown', () => {
  it('cannot publish an old cut snapshot after offset access resumes it and installs a successor hold', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
    const cut = f.playback.holdRole('video', owner, { beforeGroup: 4n });
    const rejection = expect(cut.nativeSettled).rejects.toMatchObject({ name: 'AbortError' });
    let successor: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    vi.mocked(f.resource.getTimestampOffset).mockImplementationOnce(() => {
      cut.resume(); successor = f.playback.holdRole('video', owner); return 0;
    });
    const p = f.page(), work = p.receiver.onObject(targetObjects(8000n)[0]!); void work.catch(() => {});
    await cut.reached; await rejection; await settle();
    expect(cut.current).toBe(false); expect(cut.frontier).toBeNull();
    expect(successor!.current).toBe(true); await successor!.nativeSettled;
    expect(f.appended).toHaveLength(1); successor!.resume(); await work;
    expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled();
  });

  it('releases only the consumed cut when native-current access installs a hold during resume', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
    const cut = f.playback.holdRole('video', owner, { beforeGroup: 4n }), p = f.page();
    const work = p.receiver.onObject(targetObjects(8000n)[0]!); void work.catch(() => {});
    await cut.reached; await cut.nativeSettled;
    const descriptor = Object.getOwnPropertyDescriptor(f.resource, 'current')!;
    let reads = 0, successor: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    Object.defineProperty(f.resource, 'current', { ...descriptor, get() {
      if (++reads === 2) successor = f.playback.holdRole('video', owner);
      return descriptor.get!.call(f.resource);
    } });
    cut.resume(); await settle(); expect(successor!.current).toBe(true); await successor!.nativeSettled;
    cut.resume(); expect(f.appended).toHaveLength(1); successor!.resume(); await work;
    expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled();
  });

  it('keeps the existing final commit identity fence when candidate admission replaces the cut', async () => {
    const f = fixture(); await f.first(); const owner = f.playback.roleOwner('video')!;
    let armed = false, used = false, successor: ReturnType<MseSeekPlayback['holdRole']> | undefined;
    const options = { ...target(f), isCurrent: () => {
      if (armed && !used) { used = true; cut.resume(); successor = f.playback.holdRole('video', owner); }
      return true;
    } };
    const q = await prepared(f, options), cut = f.playback.holdRole('video', owner, { beforeGroup: 4n }), p = f.page();
    const work = p.receiver.onObject(targetObjects(8000n)[0]!); void work.catch(() => {});
    await cut.reached; await cut.nativeSettled; armed = true;
    expect(() => cut.commit(q.candidate)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(f.playback.roleOwner('video')).toBe(owner); expect(successor!.current).toBe(true);
    await successor!.nativeSettled; expect(f.appended).toHaveLength(1);
    successor!.commit(q.candidate); await q.work; await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.playback.roleOwner('video')).not.toBe(owner); expect(f.failed).not.toHaveBeenCalled();
  });

  it('rejects owned witnesses and held raw work on actor cancellation without a late native mutation', async () => {
    const f = fixture(); await f.first(); const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n });
    const pending = [expect(cut.reached).rejects.toMatchObject({ name: 'AbortError' }), expect(cut.nativeSettled).rejects.toMatchObject({ name: 'AbortError' })];
    f.playback.cancel(); await Promise.all(pending); expect(cut.current).toBe(false); expect(cut.frontier).toBeNull();
    expect(f.appended).toHaveLength(1); expect(f.failed).not.toHaveBeenCalled();
  });
});

it('accounts every terminal when the assembler emits one segment per complete chunk', async () => {
  const f = fixture(false, true, 'cmaf'); await f.first(); f.setAutoAppend(false);
  const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n }), reached = vi.fn();
  void cut.reached.then(reached, () => {});
  const chunks = [6000n, 7000n].map(bmdt => buildChunk({ trackId: 1, bmdt,
    samples: [{ duration: 1000, size: 4, flags: NON_SYNC_FLAGS }], mdat: new Uint8Array(4) }));
  const bytes = new Uint8Array(chunks[0]!.length + chunks[1]!.length); bytes.set(chunks[0]!); bytes.set(chunks[1]!, chunks[0]!.length);
  // The default assembler forwards a complete multi-chunk Object as one
  // segment. This valid adapter variant emits each complete chunk separately.
  const assembler = f.owned()!.assembler, push = assembler.push.bind(assembler);
  vi.spyOn(assembler, 'push').mockImplementation((...args) => {
    if (args[3].length !== bytes.length) { push(...args); return; }
    const [role, name, group, , inputs, token, key, id] = args;
    push(role, name, group, chunks[0]!, inputs, token, key, id);
    push(role, name, group, chunks[1]!, inputs, token, key, id);
  });
  const p = f.page(), prior = p.receiver.onObject(object(bytes, 1n)); void prior.catch(() => {});
  const raw = { ...targetObjects(8000n)[0]!, payload: buildChunk({ trackId: 1, bmdt: 8000n,
    samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) }) };
  const held = p.receiver.onObject(raw); void held.catch(() => {});
  await settle(); expect(f.appended).toHaveLength(2); expect(reached).not.toHaveBeenCalled();
  f.complete(1); await settle(); expect(f.appended).toHaveLength(3); expect(reached).not.toHaveBeenCalled();
  expect(cut.frontier).toBeNull(); f.complete(2); await cut.reached; await cut.nativeSettled;
  expect(cut.frontier!.maxSubmittedEndUs!.numerator).toBe(8000000n * cut.frontier!.maxSubmittedEndUs!.denominator);
  expect(f.appended).toHaveLength(3); cut.resume(); await settle(); f.complete(3); await Promise.all([prior, held]);
  expect(f.appended).toHaveLength(4); expect(f.failed).not.toHaveBeenCalled();
});

it.each([false, true])('releases only its cut when the owning historical page fails, reached=%s', async atCut => {
  const f = fixture(); await f.first(); const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n });
  const rejected = vi.fn(); void cut.reached.catch(rejected); void cut.nativeSettled.catch(rejected);
  const p = f.page(); let work: Promise<void> | undefined;
  if (atCut) { work = p.receiver.onObject(targetObjects(8000n)[0]!); void work.catch(() => {}); await cut.reached; await cut.nativeSettled; }
  p.receiver.onClosed('error'); await settle();
  expect(cut.current).toBe(false); expect(cut.frontier).toBeNull();
  if (!atCut) expect(rejected).toHaveBeenCalledTimes(2);
  if (work) await expect(work).rejects.toThrow();
  expect(f.appended).toHaveLength(1); expect(f.pageError).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
});

function bounded(f: ReturnType<typeof fixture>, group = 4n) {
  return f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: group, readCredit: 'bounded-preparation' });
}

describe('bounded preparation credit accounting', () => {
  it.each(['cmaf', 'locmaf'] as const)('admits exact raw Object/byte and native-byte limits without charging held G: %s', async packaging => {
    const bytes = cmaf(0).length, f = fixture(false, true, packaging, undefined, { maxObjects: 1, maxBytes: bytes });
    await f.first(); const cut = bounded(f), p = f.page();
    await p.receiver.onObject(object(packaging === 'cmaf' ? cmaf(1) : payloads[1]!, 1n));
    const raw = packaging === 'cmaf' ? { ...object(cmaf(2)), groupId: varint(4) } : targetObjects(8000n)[0]!;
    const work = p.receiver.onObject(raw); void work.catch(() => {});
    await cut.reached; await cut.nativeSettled; expect(cut.current).toBe(true);
    expect(f.appended).toHaveLength(2); expect(f.appended[1]).toHaveLength(bytes);
    cut.resume(); await work; expect(f.appended).toHaveLength(3);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('keeps raw Object spending across successful native terminals and page FIN', async () => {
    const f = fixture(false, true, 'locmaf', undefined, { maxObjects: 1, maxBytes: 8192 }); await f.first();
    const cut = bounded(f), refused = expect(cut.reached).rejects.toThrow(/raw input budget/); void cut.nativeSettled.catch(() => {});
    const p = f.page(); await p.receiver.onObject(object(payloads[1]!, 1n)); p.receiver.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenCalledTimes(2); expect(cut.current).toBe(true);
    const parse = vi.spyOn(SeekCmafInput.prototype, 'push'), next = f.page();
    await next.receiver.onObject(object(payloads[2]!, 2n)); await refused;
    expect(parse.mock.calls.filter(([raw]) => raw.objectId === 2n)).toHaveLength(1);
    expect(cut.current).toBe(false); expect(f.appended).toHaveLength(3);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('refuses excess raw bytes before parser entry and continues the exact original Object once', async () => {
    const bytes = cmaf(0).length, f = fixture(false, true, 'cmaf', undefined, { maxObjects: 10, maxBytes: bytes }); await f.first();
    const cut = bounded(f), refused = expect(cut.reached).rejects.toThrow(/raw input budget/); void cut.nativeSettled.catch(() => {});
    const p = f.page(); await p.receiver.onObject(object(cmaf(1), 1n));
    const original = SeekCmafInput.prototype.push;
    const parse = vi.spyOn(SeekCmafInput.prototype, 'push').mockImplementation(function(this: SeekCmafInput, ...args) {
      if (args[0].objectId === 2n) expect(cut.current).toBe(false);
      return original.call(this, ...args);
    });
    await p.receiver.onObject(object(cmaf(2), 2n)); await refused;
    expect(parse.mock.calls.filter(([raw]) => raw.objectId === 2n)).toHaveLength(1);
    expect(f.appended).toHaveLength(3); expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('refuses late reconstructed-byte excess without reparsing a LOCMAF delta or failing its page', async () => {
    const f = fixture(false, true, 'locmaf', undefined, { maxObjects: 10, maxBytes: cmaf(0).length }); await f.first();
    const cut = bounded(f), refused = expect(cut.reached).rejects.toThrow(/reconstructed media budget/); void cut.nativeSettled.catch(() => {});
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push'), p = f.page(), values = encoded(4);
    await p.receiver.onObject(object(values[1]!, 1n)); await p.receiver.onObject(object(values[2]!, 2n)); await refused;
    expect(decode.mock.calls.filter(([, id]) => id === 2n)).toHaveLength(1);
    expect(f.appended).toHaveLength(3); expect(cut.current).toBe(false);
    const later = p.receiver.onObject(object(values[3]!, 3n)); void later.catch(() => {}); await settle();
    expect(f.appended).toHaveLength(4); f.setTime(8); f.playback.tick(); await later;
    expect(decode.mock.calls.filter(([, id]) => id === 3n)).toHaveLength(1);
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it.each([false, true])('charges a partial pair exactly once across enrollment, armAfterMoof=%s', async afterMoof => {
    const bytes = cmaf(1), moofSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    const f = fixture(false, true, 'cmaf', undefined, { maxObjects: 2, maxBytes: bytes.length }); await f.first(); const p = f.page();
    let cut: ReturnType<typeof bounded>;
    if (afterMoof) { await p.receiver.onObject(object(bytes.slice(0, moofSize), 1n)); cut = bounded(f); }
    else { cut = bounded(f); await p.receiver.onObject(object(bytes.slice(0, moofSize), 1n)); }
    expect(cut.current).toBe(true); expect(f.appended).toHaveLength(1);
    await p.receiver.onObject(object(bytes.slice(moofSize), 2n));
    const work = p.receiver.onObject({ ...object(cmaf(2)), groupId: varint(4) }); void work.catch(() => {});
    await cut.reached; await cut.nativeSettled; expect(cut.current).toBe(true); expect(f.appended).toHaveLength(2);
    cut.resume(); await work; expect(f.appended).toHaveLength(3); expect(f.failed).not.toHaveBeenCalled();
  });

  it('refuses a second pair half over its raw Object budget and completes existing assembly normally', async () => {
    const bytes = cmaf(1), moofSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    const f = fixture(false, true, 'cmaf', undefined, { maxObjects: 2, maxBytes: bytes.length }); await f.first(); const p = f.page(), cut = bounded(f);
    const refused = expect(cut.reached).rejects.toThrow(/raw input budget/); void cut.nativeSettled.catch(() => {});
    await p.receiver.onObject({ kind: 'gap', trackAlias: varint(0), groupId: varint(3), objectId: varint(1), subgroupId: varint(0), status: varint(1) });
    await p.receiver.onObject(object(bytes.slice(0, moofSize), 2n)); expect(cut.current).toBe(true);
    await p.receiver.onObject(object(bytes.slice(moofSize), 3n)); await refused;
    expect(cut.current).toBe(false); expect(f.appended).toHaveLength(2);
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('enrolls an already-appended native input still waiting for ordinary credit', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const p = f.page(), done = vi.fn();
    const work = p.receiver.onObject(object(encoded(3, 6000)[1]!, 1n)); void work.then(done, () => {});
    await settle(); f.complete(1); await settle(); expect(done).not.toHaveBeenCalled();
    const cut = bounded(f); await work; expect(done).toHaveBeenCalledOnce();
    const held = p.receiver.onObject(targetObjects(12000n)[0]!); void held.catch(() => {});
    await cut.reached; await cut.nativeSettled; expect(f.appended).toHaveLength(2);
    cut.resume(); await settle(); f.complete(2); f.setTime(10); f.playback.tick(); await held;
    expect(f.failed).not.toHaveBeenCalled();
  });
});

it('refuses stale credit enablement when admission resumes the cut and installs a successor hold', async () => {
  const f = fixture(true); await allLanded(f); const owner = f.playback.roleOwner('video')!, audio = f.playback.roleOwner('audio')!;
  const cut = bounded(f), refused = expect(cut.reached).rejects.toMatchObject({ name: 'AbortError' }); void cut.nativeSettled.catch(() => {});
  let enabling = false, once = false, successor: ReturnType<MseSeekPlayback['holdRole']> | undefined;
  const original = MseSeekOutput.prototype.enablePreparationReadCredit;
  vi.spyOn(MseSeekOutput.prototype, 'enablePreparationReadCredit').mockImplementation(function(this: MseSeekOutput, ...args) {
    enabling = true; try { original.call(this, ...args); } finally { enabling = false; }
  });
  f.options.isCurrent = () => {
    if (enabling && !once) { once = true; cut.resume(); successor = f.playback.holdRole('video', owner); }
    return true;
  };
  const p = f.page(), work = p.receiver.onObject(object(encoded(3, 6000)[1]!, 1n)); void work.catch(() => {});
  await refused; await settle(); expect(successor!.current).toBe(true); expect(f.appended).toHaveLength(2);
  const ap = f.page('audio'); await ap.receiver.onObject(object(cmaf(1, 2000, 'audio'), 1n));
  expect(f.playback.roleOwner('audio')).toBe(audio); expect(f.appended).toHaveLength(3);
  await successor!.nativeSettled; successor!.resume(); await settle();
  const done = vi.fn(); void work.then(done, () => {}); await settle(); expect(done).not.toHaveBeenCalled();
  f.setTime(8); f.playback.tick(); await work; expect(f.appended).toHaveLength(4);
  expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
});

it('enrolls the entire active emission batch once, including native-pending and unsubmitted chunks', async () => {
  const parts = [6000n, 10000n].map(bmdt => buildChunk({ trackId: 1, bmdt,
    samples: [{ duration: 4000, size: 4, flags: NON_SYNC_FLAGS }], mdat: new Uint8Array(4) }));
  const bytes = new Uint8Array(parts[0]!.length + parts[1]!.length); bytes.set(parts[0]!); bytes.set(parts[1]!, parts[0]!.length);
  const f = fixture(false, true, 'cmaf', undefined, { maxObjects: 1, maxBytes: bytes.length }); await f.first(); f.setAutoAppend(false);
  const assembler = f.owned()!.assembler, push = assembler.push.bind(assembler);
  vi.spyOn(assembler, 'push').mockImplementation((...args) => {
    if (args[3].length !== bytes.length) { push(...args); return; }
    const [role, name, group, , inputs, token, key, id] = args;
    for (const part of parts) push(role, name, group, part, inputs, token, key, id);
  });
  const p = f.page(), prior = p.receiver.onObject(object(bytes, 1n)); void prior.catch(() => {});
  await settle(); expect(f.appended).toHaveLength(2); const cut = bounded(f), reached = vi.fn();
  void cut.reached.then(reached, () => {}); f.complete(1); await settle();
  expect(f.appended).toHaveLength(3); expect(reached).not.toHaveBeenCalled();
  const raw = { ...object(buildChunk({ trackId: 1, bmdt: 14000n,
    samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) })), groupId: varint(4) };
  const held = p.receiver.onObject(raw); void held.catch(() => {}); f.complete(2); await cut.reached; await cut.nativeSettled;
  expect(cut.frontier!.maxSubmittedEndUs!.numerator).toBe(14000000n * cut.frontier!.maxSubmittedEndUs!.denominator);
  expect(f.appended).toHaveLength(3); expect(cut.current).toBe(true);
  cut.resume(); await settle(); f.complete(3); f.setTime(12); f.playback.tick(); await Promise.all([prior, held]);
  expect(f.appended).toHaveLength(4); expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
});

it('enrolls queued prepared preroll and preserves cumulative spending after promotion and FIN', async () => {
  const f = fixture(false, true, 'cmaf', undefined, { maxObjects: 2, maxBytes: cmaf(0).length * 2 }); await f.first();
  const options = { ...target(f), mediaPts: 8000, targetMs: 8125,
    placement: { sourceTimeUs: 8000000n, rebasedTimeUs: { numerator: 8000000n, denominator: 1n } } };
  const candidate = f.playback.prepareRole(options), identity = {}, receiver = candidate.beginPage(identity);
  candidate.acceptPage(identity, false);
  const chunk = (pts: bigint) => buildChunk({ trackId: 1, bmdt: pts,
    samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
  await receiver.onObject(object(chunk(6000n)));
  const prep = receiver.onObject({ ...object(chunk(8000n)), groupId: varint(4) }); void prep.catch(() => {});
  receiver.onClosed('fin'); await candidate.ready;
  const hold = f.playback.holdRole('video', f.playback.roleOwner('video')!); await hold.nativeSettled;
  hold.commit(candidate);
  const cut = bounded(f, 6n), refused = expect(cut.reached).rejects.toThrow(/raw input budget/); void cut.nativeSettled.catch(() => {});
  await prep; await settle(); expect(options.onPageDrained).toHaveBeenCalledOnce(); expect(cut.current).toBe(true);
  const next = {}, page = candidate.beginPage(next); candidate.acceptPage(next, false);
  const work = page.onObject({ ...object(chunk(10000n)), groupId: varint(5) }); void work.catch(() => {});
  await refused; expect(cut.current).toBe(false);
  f.setTime(8); f.playback.tick(); await work;
  expect(f.appended).toHaveLength(4); expect(options.onPageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
});
