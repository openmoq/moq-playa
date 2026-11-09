import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MseSeekOutput } from './mse-seek-output.js';
import { SeekCmafInput } from './seek-cmaf-input.js';
import type { CmafAppendObservation, SeekTrack } from './mse-seek-playback.js';
import { MseSeekPlayback } from './mse-seek-playback.js';
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

describe('retained live actor input', () => {
  it('required A/V pages wake their queued drain when adoption races the prior progress task', async () => {
    const f = fixture(true); await allLanded(f);
    expect(f.drained).toHaveBeenCalledTimes(2); expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled();
  });

  it('requires adopted output and a successfully drained page before beginning live input', async () => {
    const f = fixture(); f.playback.start(); expect(() => f.playback.beginLive('video', {})).toThrow(/adopt|output/);
    const page = f.page(); await page.receiver.onObject(object(payloads[0]!));
    expect(() => f.playback.beginLive('video', {})).toThrow(/drain/);
    page.receiver.onClosed('fin'); await settle();
    const lease = f.playback.beginLive('video', {}); await lease.onObject(object(payloads[1]!, 1n));
    expect(() => f.playback.beginPage('video', {})).toThrow(/live/);
    expect(() => f.playback.beginLive('video', {})).toThrow(/live/);
  });

  it('a finite full-header page continues with a live LOCMAF delta on the same consumer/native epoch', async () => {
    const f = fixture(); await f.first();
    expect(new LocmafTrackDecoder(init('video')).push(3n, 1n, payloads[1]!).kind).toBe('rejected');
    const end = vi.spyOn(SeekCmafInput.prototype, 'end'), nativeEnd = vi.spyOn(MseSeekOutput.prototype, 'end');
    const lease = f.playback.beginLive('video', {}), input = {};
    await lease.onObject(object(payloads[1]!, 1n), input);
    expect(f.appended.map(bytes => [...bytes.slice(-4)])).toEqual([[41, 42, 43, 0], [41, 42, 43, 1]]);
    expect(f.options.observeAppend).toHaveBeenLastCalledWith([input]); expect(f.tokens[1]).toBe(f.observations[1]!.token);
    expect(f.options.onSubmitted).toHaveBeenCalledTimes(2); expect(f.drained).toHaveBeenCalledOnce(); expect(f.pageError).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled(); expect(nativeEnd).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledOnce(); expect(f.begin).toHaveBeenCalledOnce(); expect(f.resource.initialize).toHaveBeenCalledOnce();
    expect(f.placements.flatMap(spy => spy.mock.calls)).toHaveLength(1); expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(5);
    expect(f.playback.sample()?.currentTime).toBe(5.125); expect(f.positioned).toHaveBeenCalledOnce();
  });

  it('healthy stream FIN remains engine-owned admission and cannot erase the live delta reference', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {});
    let terminal: 'open' | 'fin' | 'reset' = 'open';
    const admitted = () => terminal !== 'reset';
    await lease.onObject(object(payloads[1]!, 1n), undefined, admitted);
    terminal = 'fin';
    await lease.onObject(object(payloads[2]!, 2n), undefined, admitted);
    expect(f.appended).toHaveLength(3); expect(f.failed).not.toHaveBeenCalled(); expect(f.drained).toHaveBeenCalledOnce();
  });

  it('lease cancellation wakes video native credit without canceling healthy audio or the adopted resource', async () => {
    const f = fixture(true); await allLanded(f); f.setAutoAppend(false);
    const video = f.playback.beginLive('video', {}), audio = f.playback.beginLive('audio', {});
    const wait = video.onObject(object(payloads[1]!, 1n)), aborted = expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); video.cancel(); await aborted;
    const other = audio.onObject(object(cmaf(1, 2000, 'audio'), 1n)); void other.catch(() => {}); await settle();
    const audioCall = vi.mocked(f.resource.appendChunk).mock.calls.findIndex((call, i) => i >= 2 && call[0] === 'audio');
    f.complete(audioCall); await other;
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
    expect(f.appended.at(-1)!.slice(-4)).toEqual(Uint8Array.of(41, 42, 43, 1));
  });

  it('genuine end waits for queued native work, validates once, and never emits a page callback', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false);
    const end = vi.spyOn(SeekCmafInput.prototype, 'end'), nativeEnd = vi.spyOn(MseSeekOutput.prototype, 'end');
    const lease = f.playback.beginLive('video', {}), pending = lease.onObject(object(payloads[1]!, 1n));
    await settle(); const done = lease.endTrack(), repeated = lease.endTrack();
    expect(end).not.toHaveBeenCalled(); expect(nativeEnd).not.toHaveBeenCalled();
    f.complete(1); await pending; await Promise.all([done, repeated]);
    await lease.endTrack(); expect(end).toHaveBeenCalledOnce(); expect(nativeEnd).toHaveBeenCalledExactlyOnceWith('video');
    expect(f.drained).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    await expect(lease.onObject(object(payloads[2]!, 2n))).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => f.playback.beginLive('video', {})).toThrow(/ended/);
  });

  it('an end-of-track Object alone does not substitute for the engine terminal/drain decision', async () => {
    const f = fixture(); await f.first(); const end = vi.spyOn(SeekCmafInput.prototype, 'end'), lease = f.playback.beginLive('video', {});
    await lease.onObject({ kind: 'gap', groupId: varint(3), objectId: varint(1), subgroupId: varint(0), trackAlias: varint(0), status: varint(4) });
    expect(end).not.toHaveBeenCalled(); await lease.endTrack(); expect(end).toHaveBeenCalledOnce();
  });

  it('refuses withdrawn admission before parsing while leaving the retained reference intact', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {}), input = {}, decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    await expect(lease.onObject(object(payloads[1]!, 1n), input, () => false)).rejects.toMatchObject({ name: 'AbortError' });
    expect(decode).not.toHaveBeenCalled(); expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'epoch refused');
    await lease.onObject(object(payloads[1]!, 1n)); expect(f.appended).toHaveLength(2);
  });

  it('checks queued admission again before parsing after the previous native wait', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const lease = f.playback.beginLive('video', {});
    const first = lease.onObject(object(payloads[1]!, 1n)); await settle(); let admitted = true;
    const next = lease.onObject(object(payloads[2]!, 2n), {}, () => admitted), denied = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    admitted = false; f.complete(1); await first; await denied;
    expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('post-await withdrawal rejects the lease input without relabeling already accepted native work', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const lease = f.playback.beginLive('video', {}); let admitted = true;
    const pending = lease.onObject(object(payloads[1]!, 1n), {}, () => admitted), denied = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); admitted = false; f.complete(1); await denied;
    expect(f.observations[1]!.discard).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.playback.sample()?.currentTime).toBe(5.125); expect(f.failed).not.toHaveBeenCalled();
  });

  it('cancellation during append-observation reentry fences native submission', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {});
    vi.mocked(f.options.observeAppend!).mockImplementation(() => { const obs = { token: {}, discard: vi.fn() }; lease.cancel(); f.observations.push(obs); return obs; });
    await expect(lease.onObject(object(payloads[1]!, 1n))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.appended).toHaveLength(1); expect(f.observations[1]!.discard).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('cancellation fences and detaches queued inputs before discard callbacks install another live owner', async () => {
    const f = fixture(); await f.first(); const old = f.playback.beginLive('video', {}), input = {};
    const queued = old.onObject(object(payloads[1]!, 1n), input), denied = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    let successor: ReturnType<typeof f.playback.beginLive> | undefined;
    vi.mocked(f.options.onDiscard!).mockImplementationOnce(() => { successor = f.playback.beginLive('video', {}); });
    old.cancel(); await denied; await settle();
    await expect(old.onObject(object(payloads[1]!, 1n))).rejects.toMatchObject({ name: 'AbortError' });
    await successor!.onObject(object(payloads[1]!, 1n)); expect(f.appended).toHaveLength(2);
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'epoch refused');
  });

  it.each(['objects', 'bytes'] as const)('live %s budget includes active work and overflow retires only that lease', async budget => {
    const f = fixture(false, true, 'cmaf'); await f.first(); f.setAutoAppend(false);
    if (budget === 'objects') f.options.maxObjects = 1; else f.options.maxBytes = cmaf(1).length;
    const lease = f.playback.beginLive('video', {}), accepted = {}, rejected = {};
    const pending = lease.onObject(object(cmaf(1), 1n), accepted), aborted = expect(pending).rejects.toThrow(/budget/); await settle();
    await expect(lease.onObject(object(cmaf(2), 2n), rejected)).rejects.toThrow(/budget/); await aborted;
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(rejected, 'epoch refused');
    expect(f.observations[1]!.discard).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(() => f.playback.beginLive('video', {})).toThrow(/sett|pending|work/);
    f.complete(1); await settle(); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('cancel releases an end waiter immediately, retaining pending native credit until its real terminal', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const lease = f.playback.beginLive('video', {});
    const pending = lease.onObject(object(payloads[1]!, 1n)), aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); await settle();
    const done = lease.endTrack(), endAborted = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    lease.cancel(); lease.cancel(); await Promise.all([aborted, endAborted]);
    expect(() => f.playback.beginLive('video', {})).toThrow(/sett|pending|work/);
    f.complete(1); await settle(); expect(f.observations[1]!.discard).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
  });

  it('cancel releases queued callers once while accepted native work keeps its terminal ownership', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const lease = f.playback.beginLive('video', {}), data = encoded(4);
    const active = lease.onObject(object(data[1]!, 1n)), activeAbort = expect(active).rejects.toMatchObject({ name: 'AbortError' }); await settle();
    const contexts = [{}, {}], a = lease.onObject(object(data[2]!, 2n), contexts[0]), b = lease.onObject(object(data[3]!, 3n), contexts[1]);
    const aAbort = expect(a).rejects.toMatchObject({ name: 'AbortError' }), bAbort = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    lease.cancel(); await Promise.all([activeAbort, aAbort, bAbort]);
    expect(f.options.onDiscard).toHaveBeenCalledTimes(2); expect(f.observations[1]!.discard).not.toHaveBeenCalled();
    f.complete(1); await settle(); expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled();
  });

  it('actor authority withdrawn before the pump runs cannot strand accepted queue callers', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {}), input = {};
    const pending = lease.onObject(object(payloads[1]!, 1n), input), denied = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    f.lose(); await denied;
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'epoch refused'); expect(f.appended).toHaveLength(1);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('cancel wakes a paused caller after native append while genuine clock credit remains owned', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const lease = f.playback.beginLive('video', {}), data = encoded(2, 12000);
    const pending = lease.onObject(object(data[1]!, 1n)), denied = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); f.complete(1); await settle(); lease.cancel(); await denied;
    expect(() => f.playback.beginLive('video', {})).toThrow(/sett|pending|work/);
    expect(f.observations[1]!.discard).not.toHaveBeenCalled(); f.setTime(14); f.playback.tick(); await settle();
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('queued snapshots remain ordered and include their original diagnostic contexts', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {}), contexts = [{}, {}], bytes = payloads[1]!.slice();
    const a = lease.onObject(object(bytes, 1n), contexts[0]), b = lease.onObject(object(payloads[2]!, 2n), contexts[1]); bytes.fill(0);
    await Promise.all([a, b]);
    expect(f.appended.map(chunk => chunk.at(-1))).toEqual([0, 1, 2]);
    expect(vi.mocked(f.options.observeAppend!).mock.calls.slice(1)).toEqual([[[contexts[0]]], [[contexts[1]]]]);
  });

  it('live format rejection stays local to its promise and preserves accepted output', async () => {
    const f = fixture(); await f.first(); const lease = f.playback.beginLive('video', {});
    await expect(lease.onObject(object(Uint8Array.of(0xff), 1n))).rejects.toThrow();
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.playback.sample()?.currentTime).toBe(5.125);
  });

  it('shared native failure retains onError and cannot become a page callback', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false); const lease = f.playback.beginLive('video', {});
    const pending = lease.onObject(object(payloads[1]!, 1n)), rejected = expect(pending).rejects.toThrow(); await settle();
    f.complete(1, 'discarded'); await rejected;
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.pageError).not.toHaveBeenCalled(); expect(f.drained).toHaveBeenCalledOnce();
  });
});
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
  indexed = { objectId: 0n, mediaPts: 4000, targetMs: 5000 }) {
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
    setPlaybackIntent: vi.fn(), getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }) };
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
    maxObjects: 10, maxBytes: 8192, preparationTimeoutMs: 1000, playing: false, isCurrent: () => current,
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

describe('live input completion ownership', () => {
  it('keeps queued accepted delta work after healthy FIN and ends only after both native terminals', async () => {
    const f = fixture(); await f.first(); f.setAutoAppend(false);
    const end = vi.spyOn(SeekCmafInput.prototype, 'end');
    const lease = f.playback.beginLive('video', {});
    let terminal: 'open' | 'fin' | 'reset' = 'open';
    const admitted = () => terminal !== 'reset';
    const first = lease.onObject(object(payloads[1]!, 1n), {}, admitted); await settle();
    const second = lease.onObject(object(payloads[2]!, 2n), {}, admitted);
    terminal = 'fin'; let finished = false;
    const done = lease.endTrack(); void done.then(() => { finished = true; });
    await settle(); expect(end).not.toHaveBeenCalled(); expect(finished).toBe(false);
    f.complete(1); await first; await settle();
    expect(f.appended).toHaveLength(3); expect(end).not.toHaveBeenCalled(); expect(finished).toBe(false);
    f.complete(2); await Promise.all([second, done]);
    expect(end).toHaveBeenCalledOnce(); expect(finished).toBe(true);
    expect(f.appended.map(bytes => bytes.at(-1))).toEqual([0, 1, 2]);
    expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('a genuinely ended page role leaves the other adopted role free to progress and end live input', async () => {
    const f = fixture(true, true, 'cmaf'); f.playback.start();
    const video = f.page('video', true); await video.receiver.onObject(object(cmaf(0)));
    video.receiver.onClosed('fin');
    const audio = f.page('audio'); await audio.receiver.onObject(object(cmaf(0, 2000, 'audio')));
    audio.receiver.onClosed('fin'); await settle(); f.land(); await settle();
    expect(f.drained).toHaveBeenCalledTimes(2);
    expect(() => f.playback.beginLive('video', {})).toThrow(/ended/);
    const end = vi.spyOn(SeekCmafInput.prototype, 'end'), nativeEnd = vi.spyOn(MseSeekOutput.prototype, 'end');
    const live = f.playback.beginLive('audio', {});
    await live.onObject(object(cmaf(1, 2000, 'audio'), 1n));
    await live.endTrack(); await live.endTrack();
    expect(end).toHaveBeenCalledOnce(); expect(nativeEnd).toHaveBeenCalledExactlyOnceWith('audio');
    expect(f.drained).toHaveBeenCalledTimes(2); expect(f.appended).toHaveLength(3);
    expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.resource.initialize).toHaveBeenCalledOnce();
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });
});
