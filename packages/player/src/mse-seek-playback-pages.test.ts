import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MseSeekOutput } from './mse-seek-output.js';
import { SeekCmafInput } from './seek-cmaf-input.js';
import { planSeekFetchPage } from './seek-fetch-pages.js';
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
  let current = true, nativeCurrent = true, observer: MediaAppendObserver | null = null, now = 5.125, sample: MediaSeekSample | null = null;
  const tokens: object[] = [], appended: Uint8Array[] = [], observations: CmafAppendObservation[] = [];
  const placements: Array<MockInstance<CmafAssembler['setPresentationPlacement']>> = [];
  const resource: MediaSeekResource = { epoch, resource: nativeId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: vi.fn(async () => {}),
    observeAppends(fn) { observer = fn; return () => { observer = null; }; },
    appendChunk: vi.fn((_role, bytes, _name, _group, token) => {
      tokens.push(token!); appended.push(bytes.slice()); if (autoAppend) observer?.({ token: token!, state: 'appended', reason: null });
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
    observations, adopted, drained, pageError, failed, positioned, setTime(value: number) { now = value; }, lose() { current = false; } };
}

describe('paged historical actor', () => {
  it('start performs no I/O and initial A/V require matching acceptance plus parsed target coverage', async () => {
    const f = fixture(true); f.playback.start();
    expect(f.create).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
    const v = f.page('video', false, false), a = f.page('audio', false, false);
    await v.receiver.onObject(object(payloads[0]!)); await a.receiver.onObject(object(cmaf(0, 2000, 'audio')));
    v.receiver.onClosed('fin'); a.receiver.onClosed('fin');
    v.accept(); await settle(); expect(f.begin).not.toHaveBeenCalled(); a.accept(); await settle();
    expect(f.adopted).toHaveBeenCalledOnce(); expect(f.resource.appendChunk).toHaveBeenCalledTimes(2);
    expect(f.drained.mock.calls).toEqual([['video', v.identity], ['audio', a.identity]]);
    f.land(); await settle(); expect(f.positioned).toHaveBeenCalledOnce(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('non-EOT FIN keeps the LOCMAF reference and the same placement/resource/clock for the next delta', async () => {
    const end = vi.spyOn(SeekCmafInput.prototype, 'end'), nativeEnd = vi.spyOn(MseSeekOutput.prototype, 'end');
    expect(new LocmafTrackDecoder(init('video')).push(3n, 1n, payloads[1]!).kind).toBe('rejected');
    const f = fixture(); const first = await f.first(), next = f.page();
    await next.receiver.onObject(object(payloads[1]!, 1n)); next.receiver.onClosed('fin'); await settle();
    expect(f.drained.mock.calls).toEqual([['video', first.identity], ['video', next.identity]]);
    expect(end).not.toHaveBeenCalled(); expect(nativeEnd).not.toHaveBeenCalled();
    expect(f.appended.map(bytes => [...bytes.slice(-4)])).toEqual([[41, 42, 43, 0], [41, 42, 43, 1]]);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.begin).toHaveBeenCalledOnce(); expect(f.resource.initialize).toHaveBeenCalledOnce();
    expect(f.placements.flatMap(spy => spy.mock.calls)).toHaveLength(1); expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(5);
    expect(f.positioned).toHaveBeenCalledOnce(); expect(f.playback.sample()?.currentTime).toBe(5.125); expect(f.failed).not.toHaveBeenCalled();
  });

  it('an indexed dependent target includes physical preroll in page one and cannot wait for page two to adopt required A/V', async () => {
    const entries = [[4000, 0], [6000, 1], [8000, 2], [14000, 3]].map(([mediaPts, id]) =>
      ({ mediaPts: mediaPts!, location: [3, id!] as [number, number], wallclockTime: 0 }));
    const plan = planSeekFetchPage({ draftVersion: 22, trackName: 'video', timeline: { entries, depends: ['video', 'audio'], isLive: true },
      cut: { kind: 'before', groupId: 3n, objectId: 1n }, endOfTrack: false });
    expect(plan).toMatchObject({ kind: 'fetch-page', start: { groupId: 3n, objectId: 1n }, end: { groupId: 3n, objectId: 2n } });
    const f = fixture(true, true, 'locmaf', { objectId: 1n, mediaPts: 6000, targetMs: 6500 }); f.playback.start();
    const video = f.page('video', false, false), audio = f.page('audio', false, false);
    for (const [role, page] of [['video', video], ['audio', audio]] as const) {
      for (let i = 0; i < 2; i++) await page.receiver.onObject(object(role === 'video' ? payloads[i]! : cmaf(i, 2000, role), BigInt(i)));
      page.receiver.onClosed('fin');
    }
    video.accept(); await settle(); expect(f.begin).not.toHaveBeenCalled(); audio.accept(); await settle();
    expect(f.begin).toHaveBeenCalledOnce(); expect(f.appended).toHaveLength(4); expect(f.drained).toHaveBeenCalledTimes(2);
    expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(6.5); f.setTime(6.625); f.land(); await settle();
    expect(f.positioned).toHaveBeenCalledOnce();
    const next = f.page(); await next.receiver.onObject(object(payloads[2]!, 2n)); next.receiver.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenLastCalledWith('video', next.identity); expect(f.appended).toHaveLength(5);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.begin).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('stages successor data and FIN before OK without advancing its existing decoder, then drains the snapshot on acceptance', async () => {
    const f = fixture(); await f.first(); const next = f.page('video', false, false), input = {}, bytes = payloads[1]!.slice();
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    await next.receiver.onObject(object(bytes, 1n), input); bytes.fill(0); next.receiver.onClosed('fin'); await settle();
    expect(decode).not.toHaveBeenCalled(); expect(f.appended).toHaveLength(1); expect(f.drained).toHaveBeenCalledOnce();
    next.accept(); await settle();
    expect(decode).toHaveBeenCalledOnce(); expect(f.appended[1]!.slice(-4)).toEqual(Uint8Array.of(41, 42, 43, 1));
    expect(f.options.observeAppend).toHaveBeenLastCalledWith([input]); expect(f.tokens[1]).toBe(f.observations[1]!.token);
    expect(f.options.onSubmitted).toHaveBeenCalledTimes(2); expect(f.drained).toHaveBeenLastCalledWith('video', next.identity);
  });

  it('early FIN followed by refusal reports once and cannot poison a reentrant replacement page', async () => {
    const f = fixture(); await f.first(); const refused = f.page('video', false, false), input = {};
    await refused.receiver.onObject(object(payloads[1]!, 1n), input); refused.receiver.onClosed('fin');
    let next: ReturnType<typeof f.page> | undefined;
    f.pageError.mockImplementation(() => { next = f.page(); });
    refused.receiver.onClosed('error'); refused.receiver.onClosed('error'); refused.accept(); await settle();
    expect(f.pageError).toHaveBeenCalledExactlyOnceWith('video', refused.identity, expect.any(Error));
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'epoch refused');
    await next!.receiver.onObject(object(payloads[1]!, 1n)); next!.receiver.onClosed('fin'); await settle();
    expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
  });

  it('page error publication rechecks actor authority after discard observers revoke it', async () => {
    const f = fixture(); await f.first(); const page = f.page('video', false, false), input = {};
    await page.receiver.onObject(object(payloads[1]!, 1n), input);
    vi.mocked(f.options.onDiscard!).mockImplementation(() => { f.lose(); });
    page.receiver.onClosed('error'); await settle();
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'epoch refused');
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
  });

  it('current page error reports once after discard and permits a fresh owned page', async () => {
    const f = fixture(); await f.first(); const page = f.page('video', false, false), input = {};
    await page.receiver.onObject(object(payloads[1]!, 1n), input); page.receiver.onClosed('error'); await settle();
    expect(f.pageError).toHaveBeenCalledExactlyOnceWith('video', page.identity, expect.any(Error));
    const next = f.page(); await next.receiver.onObject(object(payloads[1]!, 1n)); next.receiver.onClosed('fin'); await settle();
    expect(f.appended).toHaveLength(2); expect(f.failed).not.toHaveBeenCalled();
  });

  it('explicit cancellation during discard suppresses the old page error', async () => {
    const f = fixture(); await f.first(); const page = f.page('video', false, false), input = {};
    await page.receiver.onObject(object(payloads[1]!, 1n), input);
    vi.mocked(f.options.onDiscard!).mockImplementation(() => { f.playback.cancel(); });
    page.receiver.onClosed('error'); await settle();
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
  });

  it('current pre-transfer page error still reports after deliberate local candidate closure', async () => {
    const f = fixture(); f.playback.start(); const page = f.page('video', false, false), input = {};
    await page.receiver.onObject(object(payloads[0]!), input); page.receiver.onClosed('error'); await settle();
    expect(f.pageError).toHaveBeenCalledExactlyOnceWith('video', page.identity, expect.any(Error));
    expect(f.begin).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
    expect(() => f.page()).toThrow(/retired/);
  });

  it('page error publication rechecks actor authority after deliberate close disposes another initial role', async () => {
    const f = fixture(true); f.playback.start(); const video = f.page('video'), audio = f.page('audio', false, false), input = {};
    await video.receiver.onObject(object(payloads[0]!), input); expect(f.begin).not.toHaveBeenCalled();
    vi.mocked(f.options.onDiscard!).mockImplementation(() => { f.lose(); });
    audio.receiver.onClosed('error'); await settle();
    expect(f.options.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'decoder reset');
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
  });

  it.each(['objects', 'bytes'] as const)('bounds successor early %s and permits a fresh page', async budget => {
    const f = fixture(false, true, budget === 'bytes' ? 'cmaf' : 'locmaf'); await f.first();
    const bytes = (i: number) => budget === 'bytes' ? cmaf(i) : payloads[i]!;
    if (budget === 'objects') f.options.maxObjects = 1; else f.options.maxBytes = bytes(1).length;
    const p = f.page('video', false, false), contexts = [{}, {}];
    await p.receiver.onObject(object(bytes(1), 1n), contexts[0]);
    await expect(p.receiver.onObject(object(bytes(2), 2n), contexts[1])).rejects.toThrow(/budget/);
    expect(f.pageError).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    expect(f.options.onDiscard).toHaveBeenCalledTimes(2);
    const next = f.page(); await next.receiver.onObject(object(bytes(1), 1n)); next.receiver.onClosed('fin'); await settle();
    expect(f.appended).toHaveLength(2); expect(f.resource.cancel).not.toHaveBeenCalled();
  });

  it('ignores old acceptance/terminals and refuses stale Objects without touching a successor', async () => {
    const f = fixture(); const old = await f.first(), next = f.page('video', false, false), stale = {};
    await next.receiver.onObject(object(payloads[1]!, 1n));
    old.accept(); old.receiver.onClosed('error'); f.playback.acceptPage('video', old.identity, true);
    await expect(old.receiver.onObject(object(payloads[2]!, 2n), stale)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.appended).toHaveLength(1); expect(f.options.onDiscard).toHaveBeenCalledWith(stale, 'epoch refused');
    next.accept(); next.receiver.onClosed('fin'); await settle(); expect(f.appended).toHaveLength(2); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('detaches a drained page before a callback begins its successor', async () => {
    const f = fixture(); let next: ReturnType<typeof f.page> | undefined;
    f.drained.mockImplementationOnce(() => { next = f.page(); });
    const old = await f.first(); old.receiver.onClosed('error'); old.accept();
    await next!.receiver.onObject(object(payloads[1]!, 1n)); next!.receiver.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenCalledTimes(2); expect(f.pageError).not.toHaveBeenCalled(); expect(f.appended).toHaveLength(2);
  });

  it('FIN cannot complete a page until native append and actual clock read credit settle', async () => {
    const f = fixture(false, false); f.playback.start(); const first = f.page();
    const initial = first.receiver.onObject(object(payloads[0]!)); void initial.catch(() => {}); first.receiver.onClosed('fin'); await settle();
    expect(f.drained).not.toHaveBeenCalled(); f.complete(0); await initial; f.land(); await settle();
    const next = f.page(), data = encoded(2, 12000), wait = next.receiver.onObject(object(data[1]!, 1n)); void wait.catch(() => {});
    next.receiver.onClosed('fin'); await settle(); f.complete(1); await settle();
    expect(f.drained).toHaveBeenCalledOnce(); f.setTime(14); f.playback.tick(); await wait; await settle();
    expect(f.drained).toHaveBeenLastCalledWith('video', next.identity); expect(f.failed).not.toHaveBeenCalled();
  });

  it('true EOT alone validates final format input and ends the role exactly once', async () => {
    const end = vi.spyOn(SeekCmafInput.prototype, 'end'), nativeEnd = vi.spyOn(MseSeekOutput.prototype, 'end');
    const f = fixture(); await f.first(); const final = f.page('video', true);
    await final.receiver.onObject(object(payloads[1]!, 1n)); final.receiver.onClosed('fin'); await settle();
    final.receiver.onClosed('fin'); final.accept();
    expect(end).toHaveBeenCalledOnce(); expect(nativeEnd).toHaveBeenCalledExactlyOnceWith('video');
    expect(f.drained).toHaveBeenCalledTimes(2); expect(() => f.page()).toThrow(/ended/);
  });

  it('preserves a legacy pending pair across a non-EOT page boundary after landing', async () => {
    const f = fixture(false, true, 'cmaf'); await f.first(); const bytes = cmaf(1), size = new DataView(bytes.buffer).getUint32(0);
    const half = f.page(); await half.receiver.onObject(object(bytes.slice(0, size), 1n)); half.receiver.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenCalledTimes(2); expect(f.appended).toHaveLength(1);
    const rest = f.page(); await rest.receiver.onObject(object(bytes.slice(size), 2n)); rest.receiver.onClosed('fin'); await settle();
    expect(f.appended[1]!.slice(-4)).toEqual(Uint8Array.of(41, 42, 43, 1)); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('a format error after landing is page-local and preserves adopted output', async () => {
    const f = fixture(); await f.first(); const next = f.page();
    await expect(next.receiver.onObject(object(Uint8Array.of(0xff), 1n))).rejects.toThrow();
    expect(f.pageError).toHaveBeenCalledExactlyOnceWith('video', next.identity, expect.any(Error));
    expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.playback.sample()?.currentTime).toBe(5.125);
  });

  it('refusal during a native wait wakes the receiver while preserving accepted output and its terminal owner', async () => {
    const f = fixture(false, false); f.playback.start(); const first = f.page();
    const initial = first.receiver.onObject(object(payloads[0]!)); await settle(); f.complete(0); await initial;
    first.receiver.onClosed('fin'); f.land(); await settle();
    const next = f.page(), waiting = next.receiver.onObject(object(payloads[1]!, 1n));
    const rejection = expect(waiting).rejects.toThrow(/reset/); await settle(); next.receiver.onClosed('reset'); await rejection;
    expect(f.pageError).toHaveBeenCalledOnce(); expect(f.resource.cancel).not.toHaveBeenCalled();
    f.complete(1); await settle(); expect(f.failed).not.toHaveBeenCalled(); expect(f.drained).toHaveBeenCalledOnce();
  });

  it('accepted partial-page reset preserves native bytes without announcing a completed-page cut', async () => {
    const f = fixture(); await f.first(); const partial = f.page();
    await partial.receiver.onObject(object(payloads[1]!, 1n)); expect(f.appended).toHaveLength(2);
    partial.receiver.onClosed('reset'); await settle(); partial.accept(); partial.receiver.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenCalledOnce(); expect(f.pageError).toHaveBeenCalledExactlyOnceWith('video', partial.identity, expect.any(Error));
    expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.observations[1]!.discard).not.toHaveBeenCalled(); expect(f.playback.sample()?.currentTime).toBe(5.125);
    // Recovery range selection belongs to the engine; this mutated consumer is not retried here.
  });

  it('cancel releases attachment/native waits and never tears down transferred resources', async () => {
    const f = fixture(false, false); f.playback.start(); const p = f.page();
    const pending = p.receiver.onObject(object(payloads[0]!)), rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); const destroy = vi.spyOn(f.owned()!.assembler, 'destroy'); f.playback.cancel(); await rejection;
    f.complete(0); f.land(); await settle();
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled(); expect(f.positioned).not.toHaveBeenCalled();
    expect(f.pageError).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('cancellation before attachment cannot later submit old media', async () => {
    const f = fixture(), attached = deferred<void>(); vi.mocked(f.resource.whenAttached).mockReturnValue(attached.promise);
    f.playback.start(); const p = f.page(), pending = p.receiver.onObject(object(payloads[0]!));
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); await settle(); f.playback.cancel(); await rejection;
    attached.resolve(); await settle(); expect(f.resource.appendChunk).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('native append failure remains shared onError and cannot also finish/report the page', async () => {
    const f = fixture(false, false); f.playback.start(); const p = f.page();
    const wait = p.receiver.onObject(object(payloads[0]!)), rejection = expect(wait).rejects.toThrow();
    await settle(); f.complete(0, 'discarded'); await rejection; p.receiver.onClosed('fin'); p.accept();
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.pageError).not.toHaveBeenCalled(); expect(f.drained).not.toHaveBeenCalled();
  });

  it('never adopts parsed indexed media that does not actually cover the requested target', async () => {
    const f = fixture(false, true, 'cmaf'); f.playback.start(); const p = f.page();
    await p.receiver.onObject(object(cmaf(0, 500))); expect(f.begin).not.toHaveBeenCalled(); p.receiver.onClosed('fin'); await settle();
    expect(f.begin).not.toHaveBeenCalled(); expect(f.adopted).not.toHaveBeenCalled(); expect(f.pageError).toHaveBeenCalledOnce();
  });

  it('preparation deadline remains shared and start has no request side effects', async () => {
    vi.useFakeTimers(); const f = fixture(); f.playback.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.failed.mock.calls[0]![0].message).toMatch(/timed out/);
    expect(f.begin).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled();
  });

  it('destroys a new assembler returned after factory reentry cancels the candidate', async () => {
    const f = fixture(); let destroy: MockInstance<() => void> | undefined;
    f.create.mockImplementation(callbacks => { const assembler = new CmafAssembler(callbacks); destroy = vi.spyOn(assembler, 'destroy'); f.playback.cancel(); return assembler; });
    f.playback.start(); const p = f.page(); await expect(p.receiver.onObject(object(payloads[0]!))).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalledOnce(); expect(f.begin).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('records ownership before an adopt callback throws and leaves the assembler usable by its owner', async () => {
    const f = fixture(); f.options.adopt = value => { f.adopted(value); throw new Error('owner failed'); };
    f.playback.start(); const p = f.page(); await expect(p.receiver.onObject(object(payloads[0]!))).rejects.toThrow('owner failed');
    const value = f.adopted.mock.calls[0]![0] as { resource: MediaSeekResource; assembler: CmafAssemblerLike };
    const destroy = vi.spyOn(value.assembler, 'destroy'); expect(value.resource.cancel).not.toHaveBeenCalled();
    value.assembler.push('video', 'video', 4n, cmaf(0), undefined, undefined, 'video', 0n);
    expect(f.options.onSegment).toHaveBeenCalledOnce(); expect(destroy).not.toHaveBeenCalled();
    value.resource.cancel(); value.assembler.destroy();
  });
});

it.each([{ draft: 18, target: 0 }, { draft: 22, target: 0 }, { draft: 18, target: 1 }, { draft: 22, target: 1 }] as const)(
  'draft $draft real SDK pages preserve reference for indexed Object $target and stage early successor data+FIN before OK', async ({ draft, target }) => {
  const f = fixture(false, false, 'locmaf', { objectId: BigInt(target), mediaPts: 4000 + target * 2000, targetMs: 5000 + target * 1500 }), { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const generic = vi.fn(), errors: string[] = [], pages = new Map<bigint, ReturnType<typeof f.page>>();
  client.onObject = generic; client.onError = server.onError = error => { errors.push(error.message); };
  client.onMessage = message => {
    if (message.type === 'FETCH_OK') {
      const page = pages.get(message.requestId)!;
      f.playback.acceptPage('video', page.identity, message.endOfTrack === 1);
    }
  };
  await Promise.all([client.connect(a), server.connect(b)]); f.playback.start();
  async function request(index: number, end = index + 1) {
    const page = f.page('video', false, false);
    const id = await client.fetch([new TextEncoder().encode('show')], new TextEncoder().encode('video'), {
      startGroup: 3n, startObject: BigInt(index), endGroup: 3n, endObject: BigInt(end), groupOrder: 'ascending',
      onRequestId: id => { pages.set(id, page); },
      receiver: { onObject: (object, context) => page.receiver.onObject(object, context), onClosed: terminal => page.receiver.onClosed(terminal) },
    });
    await flush(128); return { id, page };
  }
  async function send(id: bigint, indexes: readonly number[]) {
    const stream = await server.openFetchStream(id);
    for (const index of indexes) await server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128, payload: payloads[index]! });
    await server.closeFetchStream(stream); await flush(256);
  }
  try {
    const nextIndex = target + 1, first = await request(0, nextIndex);
    await server.acceptFetch(first.id, { endOfTrack: 0, endLocation: { group: 3n, object: BigInt(draft === 22 ? target : nextIndex) } });
    await send(first.id, target === 0 ? [0] : [0, 1]); expect(f.appended).toHaveLength(1); expect(f.drained).not.toHaveBeenCalled();
    for (let index = 0; index < nextIndex; index++) { f.complete(index); await flush(256); }
    f.setTime(target === 0 ? 5.125 : 6.625); f.land(); await flush(256); expect(f.drained).toHaveBeenCalledOnce();
    expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(f.options.targetMs / 1000);
    const next = await request(nextIndex); await send(next.id, [nextIndex]);
    expect(f.appended).toHaveLength(nextIndex); expect(f.drained).toHaveBeenCalledOnce();
    await server.acceptFetch(next.id, { endOfTrack: 0, endLocation: { group: 3n, object: BigInt(draft === 22 ? nextIndex : nextIndex + 1) } });
    await flush(256); expect(f.appended).toHaveLength(nextIndex + 1); expect(f.drained).toHaveBeenCalledOnce();
    f.complete(nextIndex); await flush(256);
    expect(f.drained.mock.calls).toEqual([['video', first.page.identity], ['video', next.page.identity]]);
    expect(f.appended[nextIndex]!.slice(-4)).toEqual(Uint8Array.of(41, 42, 43, nextIndex));
    expect(f.create).toHaveBeenCalledOnce(); expect(f.begin).toHaveBeenCalledOnce(); expect(f.positioned).toHaveBeenCalledOnce();
    expect(generic).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled(); expect(f.pageError).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  } finally { f.playback.cancel(); await client.close(); await server.close(); }
});
