import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import type { CmafAssemblerLike, MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import { MseSeekPlayback, type SeekInputReceiver, type SeekTrack } from './mse-seek-playback.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function fixture(audio = false, autoAccept = true) {
  const epoch = {}, nativeId = {}, position = deferred<MediaSeekSample>();
  let current = true, nativeCurrent = true, appendObserver: MediaAppendObserver | null = null;
  const roles = audio ? ['video', 'audio'] as const : ['video'] as const;
  const tracks: SeekTrack[] = roles.map(role => ({ role, name: role, namespace: ['track', role], sourceKey: role,
    codec: role === 'video' ? 'avc1.640028' : 'mp4a.40.2', packaging: 'cmaf',
    init: buildInit({ trackId: role === 'video' ? 1 : 2, timescale: 1000, handler: role === 'video' ? 'vide' : 'soun' }) }));
  const resource: MediaSeekResource = { epoch, resource: nativeId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: vi.fn(async () => {}), observeAppends(observer) { appendObserver = observer; return () => { appendObserver = null; }; },
    appendChunk: vi.fn((_role, _bytes, _name, _group, token) => { if (token) appendObserver?.({ token, state: 'appended', reason: null }); }),
    position: vi.fn(() => position.promise), sample: vi.fn(() => null), setPlaybackIntent: vi.fn(),
    getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }) };
  const begin = vi.fn(() => resource), source: MediaSourceLike = {
    mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    beginSeek: begin, initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
  };
  const receivers = new Map<string, SeekInputReceiver>(), pages = new Map<SeekTrack['role'], object>();
  const cancels: Array<ReturnType<typeof vi.fn>> = [];
  let requestsRetired = false;
  const cancelRequests = () => {
    if (requestsRetired) return;
    requestsRetired = true; for (const cancel of cancels) cancel();
  };
  const adopted = vi.fn(), drained = vi.fn(), pageFailed = vi.fn(), sharedFailed = vi.fn(), failed = vi.fn(), live = new CmafAssembler({ onSegment: vi.fn() });
  const create = vi.fn(options => new CmafAssembler(options));
  let playerOwned: { resource: MediaSeekResource; assembler: CmafAssemblerLike } | null = null;
  const adopt = vi.fn((owned: { resource: MediaSeekResource; assembler: CmafAssemblerLike }) => { playerOwned = owned; });
  type Options = ConstructorParameters<typeof MseSeekPlayback>[0];
  const options: { -readonly [K in keyof Options]: Options[K] } = { epoch, source, liveAssembler: live, createAssembler: create, tracks,
    location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, timestampRounding: 'floor' as const, targetMs: 5000,
    maxObjects: 500, maxBytes: 8 * 1024 * 1024, preparationTimeoutMs: 1000, playing: true,
    isCurrent: () => current, beforeResourceChange: vi.fn(), adopt, onSegment: vi.fn(), onPosition: adopted,
    onPageDrained: drained,
    // The attempt owner receives either explicit failure channel and retires its own request leases.
    onPageError: (role, page, error) => { pageFailed(role, page, error); failed(error); cancelRequests(); },
    onError: error => { sharedFailed(error); failed(error); cancelRequests(); },
  };
  const playback = new MseSeekPlayback(options);
  const cancelAttempt = () => { playback.cancel(); cancelRequests(); };
  const openRequest = vi.fn((track: SeekTrack, _receiver: SeekInputReceiver, page: object) => {
    if (autoAccept) playback.acceptPage(track.role, page, true);
    return vi.fn();
  });
  const startPages = () => {
    playback.start();
    for (const track of tracks) {
      const page = {}; pages.set(track.role, page);
      const receiver = playback.beginPage(track.role, page); receivers.set(track.role, receiver);
      const cancel = openRequest(track, receiver, page); cancels.push(cancel);
      // Request creation can reenter retirement before returning its cancellation.
      if (requestsRetired) { cancel(); break; }
    }
  };
  cleanups.push(() => {
    cancelAttempt(); playerOwned?.resource.cancel(); playerOwned?.assembler.destroy(); live.destroy();
  });
  const object = (role: 'video' | 'audio', raw = 4000n, id = 0n): MoqtObject => ({ kind: 'data',
    trackAlias: varint(0), groupId: varint(3), subgroupId: varint(0), objectId: varint(id), publisherPriority: 128,
    payload: buildChunk({ trackId: role === 'video' ? 1 : 2, bmdt: raw,
      samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) }) });
  const land = () => { position.resolve({ epoch, resource: nativeId, currentTime: 5.001, buffered: { start: 4, end: 6 } }); };
  return { playback, options, object, land, adopt, owned: () => playerOwned, receivers, pages, startPages, openRequest, cancelAttempt, cancels, resource, begin, source, create, adopted, drained, pageFailed, sharedFailed, failed,
    lose() { current = false; } };
}

describe('owned historical MSE media', () => {
  it('releases bounded receive credit when accepted video precedes the audio FETCH body', async () => {
    const f = fixture(true); f.startPages();
    let released = false;
    const first = f.receivers.get('video')!.onObject(f.object('video')).then(() => { released = true; });
    await settle(); expect(released).toBe(true); expect(f.begin).not.toHaveBeenCalled();
    await first;
    await f.receivers.get('audio')!.onObject(f.object('audio'));
    expect(f.begin).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('retains early A/V data and FIN until both FETCH responses accept the replacement', async () => {
    const f = fixture(true, false); f.startPages();
    for (const role of ['video', 'audio'] as const) {
      await f.receivers.get(role)!.onObject(f.object(role));
      f.receivers.get(role)!.onClosed('fin');
    }
    expect(f.create).not.toHaveBeenCalled(); expect(f.drained).not.toHaveBeenCalled();
    f.playback.acceptPage('video', f.pages.get('video')!, true); await settle(); expect(f.begin).not.toHaveBeenCalled();
    f.playback.acceptPage('audio', f.pages.get('audio')!, true); await settle();
    expect(f.begin).toHaveBeenCalledOnce(); expect(f.resource.appendChunk).toHaveBeenCalledTimes(2);
    expect(f.drained.mock.calls).toEqual([['video', f.pages.get('video')], ['audio', f.pages.get('audio')]]);
    f.land(); await settle(); expect(f.adopted).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('drains multiple pre-response objects in order without waiting on the sender for acceptance', async () => {
    const f = fixture(false, false); f.startPages();
    const receiver = f.receivers.get('video')!;
    await receiver.onObject(f.object('video'));
    await receiver.onObject(f.object('video', 6000n, 1n)); receiver.onClosed('fin');
    expect(f.begin).not.toHaveBeenCalled(); expect(f.resource.appendChunk).not.toHaveBeenCalled();
    f.playback.acceptPage('video', f.pages.get('video')!, true); await settle();
    expect(f.resource.appendChunk).toHaveBeenCalledTimes(2); expect(f.drained).toHaveBeenCalledOnce();
    f.land(); await settle(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('refuses excessive early media before output replacement and releases each request once', async () => {
    const f = fixture(false, false); f.options.maxObjects = 1; f.startPages();
    const receiver = f.receivers.get('video')!;
    await receiver.onObject(f.object('video'));
    await expect(receiver.onObject(f.object('video', 6000n, 1n))).rejects.toThrow(/preparation budget/);
    f.playback.acceptPage('video', f.pages.get('video')!, true); await settle();
    expect(f.begin).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledOnce();
    expect(f.pageFailed).toHaveBeenCalledExactlyOnceWith('video', f.pages.get('video'), expect.any(Error));
    expect(f.sharedFailed).not.toHaveBeenCalled();
    expect(f.cancels[0]).toHaveBeenCalledOnce(); expect(f.drained).not.toHaveBeenCalled();
    const control = fixture(false, false); control.options.maxObjects = 1; control.startPages();
    await control.receivers.get('video')!.onObject(control.object('video'));
    control.playback.acceptPage('video', control.pages.get('video')!, true); await settle(); expect(control.begin).toHaveBeenCalledOnce();
  });

  it('cannot adopt twice when an assembler factory reenters acceptance', async () => {
    const f = fixture(false, false);
    f.create.mockImplementation(callbacks => { f.playback.acceptPage('video', f.pages.get('video')!, true); return new CmafAssembler(callbacks); });
    f.startPages(); await f.receivers.get('video')!.onObject(f.object('video'));
    f.playback.acceptPage('video', f.pages.get('video')!, true); await settle();
    expect(f.create).toHaveBeenCalledOnce(); expect(f.begin).toHaveBeenCalledOnce(); expect(f.adopt).toHaveBeenCalledOnce();
  });

  it('ignores late acceptance after pre-response media has been retired', async () => {
    const f = fixture(false, false); f.startPages();
    await f.receivers.get('video')!.onObject(f.object('video'));
    f.receivers.get('video')!.onClosed('fin'); f.cancelAttempt(); f.playback.acceptPage('video', f.pages.get('video')!, true); await settle();
    expect(f.begin).not.toHaveBeenCalled(); expect(f.drained).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('prepares A/V independently and mutates no native output until both indexed tracks are ready', async () => {
    const f = fixture(true); f.startPages();
    const video = f.receivers.get('video')!.onObject(f.object('video', 4000n));
    await settle(); expect(f.begin).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    const audio = f.receivers.get('audio')!.onObject(f.object('audio', 4000n));
    await Promise.all([video, audio]);
    expect(f.begin).toHaveBeenCalledExactlyOnceWith(f.options.epoch);
    expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(5);
    expect(f.resource.appendChunk).toHaveBeenCalledTimes(2);
    expect(f.resource.setPlaybackIntent).not.toHaveBeenCalled();
    f.land(); await settle(); expect(f.adopted).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    for (const track of f.options.tracks) expect(f.receivers.has(track.role)).toBe(true);
  });

  it('holds accepted media until the owned resource reports attachment and cancellation wakes that wait', async () => {
    const f = fixture(), attachment = deferred<void>();
    vi.mocked(f.resource.whenAttached).mockReturnValue(attachment.promise);
    f.startPages(); const input = f.receivers.get('video')!.onObject(f.object('video'));
    await settle(); expect(f.resource.appendChunk).not.toHaveBeenCalled();
    attachment.resolve(); await input; expect(f.resource.appendChunk).toHaveBeenCalledOnce();
    f.land(); await settle();
    const g = fixture(), pending = deferred<void>();
    vi.mocked(g.resource.whenAttached).mockReturnValue(pending.promise);
    g.startPages(); const oldInput = g.receivers.get('video')!.onObject(g.object('video'));
    const rejection = expect(oldInput).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); g.cancelAttempt(); await rejection;
    pending.resolve(); await settle(); expect(g.resource.appendChunk).not.toHaveBeenCalled();
    expect(g.failed).not.toHaveBeenCalled();
  });

  it('transfers output resources to the player so stopping retrieval cannot tear down adopted playback', async () => {
    const f = fixture(); f.startPages();
    await f.receivers.get('video')!.onObject(f.object('video')); f.land(); await settle();
    const assembler = f.create.mock.results[0]!.value, destroy = vi.spyOn(assembler, 'destroy');
    f.cancelAttempt();
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
    expect(f.adopt).toHaveBeenCalledExactlyOnceWith({ resource: f.resource, assembler });
    expect(f.owned()?.resource).toBe(f.resource);
  });

  it('leaves an adopted assembler usable by its player after retrieval retirement', async () => {
    const f = fixture(); f.startPages();
    await f.receivers.get('video')!.onObject(f.object('video')); f.land(); await settle();
    const assembler = f.owned()!.assembler;
    f.cancelAttempt();
    const next = f.object('video', 6000n); if (next.kind !== 'data') throw new Error('Invalid fixture');
    expect(() => assembler.push('video', 'video', 4n, next.payload, undefined, undefined, 'video', 0n)).not.toThrow();
    expect(f.options.onSegment).toHaveBeenCalledOnce();
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('fences the old output before changing the native resource, then transfers the returned handle', async () => {
    const f = fixture(), order: string[] = [];
    f.options.beforeResourceChange = () => { order.push('commit'); };
    f.begin.mockImplementation(() => { order.push('native'); return f.resource; });
    f.options.adopt = owned => { order.push('adopt'); f.adopt(owned); };
    f.startPages(); await f.receivers.get('video')!.onObject(f.object('video'));
    expect(order).toEqual(['commit', 'native', 'adopt']); f.land(); await settle();
  });

  it('does not create a native resource when commit reentry retires the candidate', async () => {
    const f = fixture(); f.options.beforeResourceChange = () => { f.cancelAttempt(); };
    f.startPages(); await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.begin).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it('records resource transfer before the player callback can synchronously retire retrieval', async () => {
    const f = fixture(); f.options.adopt = owned => { f.adopt(owned); f.cancelAttempt(); };
    f.startPages();
    await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.owned()?.resource).toBe(f.resource);
  });

  it('does not cancel a foreign resource returned by an invalid source factory', async () => {
    const f = fixture(); Object.defineProperty(f.resource, 'epoch', { value: {} });
    f.startPages();
    await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toThrow(/unrelated/);
    expect(f.resource.cancel).not.toHaveBeenCalled(); expect(f.adopt).not.toHaveBeenCalled();
  });

  it('does not mutate the source when preroll cannot establish the indexed Object', async () => {
    const f = fixture(); f.startPages();
    await expect(f.receivers.get('video')!.onObject(f.object('video', 4000n, 1n))).rejects.toThrow(/indexed Object/);
    expect(f.begin).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledOnce();
    expect(f.pageFailed).toHaveBeenCalledExactlyOnceWith('video', f.pages.get('video'), expect.any(Error));
    expect(f.sharedFailed).not.toHaveBeenCalled();
    expect(f.cancels[0]).toHaveBeenCalledOnce();
  });

  it('retires bounded partial A/V preparation without waiting for the other body', async () => {
    const f = fixture(true); f.startPages();
    await f.receivers.get('video')!.onObject(f.object('video'));
    f.cancelAttempt();
    await expect(f.receivers.get('audio')!.onObject(f.object('audio'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.begin).not.toHaveBeenCalled(); for (const cancel of f.cancels) expect(cancel).toHaveBeenCalledOnce();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('bounds preparation without requiring the network or a second track to finish', async () => {
    vi.useFakeTimers(); const f = fixture(true); f.startPages();
    await f.receivers.get('video')!.onObject(f.object('video'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.begin).not.toHaveBeenCalled();
    expect(f.failed.mock.calls[0]![0].message).toMatch(/timed out/);
    expect(f.sharedFailed).toHaveBeenCalledOnce(); expect(f.pageFailed).not.toHaveBeenCalled();
    for (const cancel of f.cancels) expect(cancel).toHaveBeenCalledOnce();
  });

  it('handles a FETCH refusal before any data without calling it media completion', () => {
    const f = fixture(); f.startPages();
    f.receivers.get('video')!.onClosed('error');
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.pageFailed).toHaveBeenCalledExactlyOnceWith('video', f.pages.get('video'), expect.any(Error));
    expect(f.sharedFailed).not.toHaveBeenCalled();
    expect(f.drained).not.toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
  });

  it('rejects a factory returning the live assembler before any live capability read, mutation or destroy', async () => {
    const f = fixture(); const live = f.options.liveAssembler;
    const init = vi.spyOn(live, 'setInitSegment'), place = vi.spyOn(live, 'setPresentationPlacement'), destroy = vi.spyOn(live, 'destroy');
    f.create.mockImplementation(() => live as CmafAssembler);
    f.startPages(); await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toThrow(/live assembler/);
    expect(init).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
    expect(f.begin).not.toHaveBeenCalled();
  });

  it('consumes a cancellation returned after an opening callback reenters retirement', () => {
    const f = fixture(); const cancel = vi.fn();
    f.openRequest.mockImplementation(() => { f.cancelAttempt(); return cancel; });
    f.startPages(); expect(cancel).toHaveBeenCalledOnce(); expect(f.begin).not.toHaveBeenCalled();
  });

  it('does not accept old data after retirement even if its transport invokes a stale callback', async () => {
    const f = fixture(); f.startPages(); const receiver = f.receivers.get('video')!;
    f.cancelAttempt(); await expect(receiver.onObject(f.object('video'))).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.begin).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('reports FETCH input completion separately from native seek completion', async () => {
    const f = fixture(); f.startPages();
    await f.receivers.get('video')!.onObject(f.object('video'));
    f.receivers.get('video')!.onClosed('fin'); await settle();
    expect(f.drained).toHaveBeenCalledExactlyOnceWith('video', f.pages.get('video')); expect(f.adopted).not.toHaveBeenCalled();
    f.land(); await settle(); expect(f.adopted).toHaveBeenCalledOnce();
    f.receivers.get('video')!.onClosed('fin'); expect(f.drained).toHaveBeenCalledOnce();
  });
});

it('destroys a newly-created assembler returned after its factory reenters actor cancellation', async () => {
  const f=fixture(); const allocated: CmafAssembler[]=[];
  let destroyed: ReturnType<typeof vi.spyOn> | null=null;
  f.create.mockImplementation(callbacks => {
    const assembler=new CmafAssembler(callbacks); allocated.push(assembler); destroyed=vi.spyOn(assembler,'destroy');
    f.cancelAttempt(); return assembler;
  });
  f.startPages();
  try {
    await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toMatchObject({name:'AbortError'});
    expect(f.begin).not.toHaveBeenCalled(); expect(f.adopt).not.toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalledOnce();
  } finally { for (const assembler of allocated) assembler.destroy(); }
});

it('cancels an owned native resource returned after beginSeek reenters actor cancellation', async () => {
  const f=fixture();
  f.begin.mockImplementation(() => { f.cancelAttempt(); return f.resource; });
  f.startPages();
  try {
    await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toMatchObject({name:'AbortError'});
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.resource.cancel).toHaveBeenCalledOnce();
  } finally { f.resource.cancel(); }
});

it(' cancellation in beforeResourceChange destroys owned preparation without creating a native handle', async () => {
  const f=fixture(); let destroyed: ReturnType<typeof vi.spyOn> | null=null;
  f.create.mockImplementation(callbacks => {
    const a=new CmafAssembler(callbacks); destroyed=vi.spyOn(a,'destroy'); return a;
  });
  f.options.beforeResourceChange=() => f.cancelAttempt();
  f.startPages();
  await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toMatchObject({name:'AbortError'});
  expect(destroyed).toHaveBeenCalledOnce(); expect(f.begin).not.toHaveBeenCalled();
  expect(f.resource.cancel).not.toHaveBeenCalled();
});

it(' a throwing adopt callback still owns both resources and steady assembler output', async () => {
  const f=fixture(); let destroyed: ReturnType<typeof vi.spyOn> | null=null;
  f.create.mockImplementation(callbacks => {
    const a=new CmafAssembler(callbacks); destroyed=vi.spyOn(a,'destroy'); return a;
  });
  f.options.adopt=owned => { f.adopt(owned); throw new Error('player callback failed'); };
  f.startPages();
  await expect(f.receivers.get('video')!.onObject(f.object('video'))).rejects.toThrow('player callback failed');
  expect(f.resource.cancel).not.toHaveBeenCalled(); expect(destroyed).not.toHaveBeenCalled();
  expect(f.owned()?.resource).toBe(f.resource);
  const next=f.object('video',6000n); if(next.kind!=='data')throw new Error('fixture');
  expect(() => f.owned()!.assembler.push('video','video',4n,next.payload,undefined,undefined,'video',0n)).not.toThrow();
  expect(f.options.onSegment).toHaveBeenCalledOnce();
});
