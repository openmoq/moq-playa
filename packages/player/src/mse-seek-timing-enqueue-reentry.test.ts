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
  let nativeSample: MediaSeekSample | null = null;
  let current = true, nativeCurrent = true, appendObserver: MediaAppendObserver | null = null;
  const roles = audio ? ['video', 'audio'] as const : ['video'] as const;
  const tracks: SeekTrack[] = roles.map(role => ({ role, name: role, namespace: ['track', role], sourceKey: role,
    codec: role === 'video' ? 'avc1.640028' : 'mp4a.40.2', packaging: 'cmaf',
    init: buildInit({ trackId: role === 'video' ? 1 : 2, timescale: 1000, handler: role === 'video' ? 'vide' : 'soun' }) }));
  const resource: MediaSeekResource = { epoch, resource: nativeId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: vi.fn(async () => {}), observeAppends(observer) { appendObserver = observer; return () => { appendObserver = null; }; },
    appendChunk: vi.fn((_role, _bytes, _name, _group, token) => { if (token) appendObserver?.({ token, state: 'appended', reason: null }); }),
    position: vi.fn(() => position.promise), sample: vi.fn(() => nativeSample), setPlaybackIntent: vi.fn(),
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
    if (autoAccept) playback.acceptPage(track.role, page, false);
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
  const land = () => { nativeSample = { epoch, resource: nativeId, currentTime: 5.001, buffered: { start: 4, end: 6 } }; position.resolve(nativeSample); };
  return { playback, options, object, land, adopt, owned: () => playerOwned, receivers, pages, startPages, openRequest, cancelAttempt, cancels, resource, begin, source, create, adopted, drained, pageFailed, sharedFailed, failed,
    lose() { current = false; } };
}

describe('post-capture live enqueue ownership', () => {
  it.each(['cancel and true', 'cancel and false', 'unchanged'] as const)('%s after timing capture settles the delivered Object', async mode => {
    const f = fixture(); f.startPages();
    const page = f.receivers.get('video')!; await page.onObject(f.object('video')); page.onClosed('fin');
    await settle(); f.land(); await settle(); expect(f.adopted).toHaveBeenCalledOnce();
    const live = f.playback.beginLive('video', {}), before = vi.mocked(f.resource.appendChunk).mock.calls.length;
    let captured = false, cancelled = false, outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    const report = vi.fn(), capture = vi.fn(() => { captured = true; return { authority: {}, report }; });
    f.options.captureLiveTiming = capture;
    const admitted = vi.fn(() => {
      if (captured && mode !== 'unchanged') {
        cancelled = true; live.cancel(); return mode === 'cancel and true';
      }
      return true;
    });
    const work = live.onObject(f.object('video', 6000n, 1n), undefined, admitted);
    void work.then(() => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; });
    await settle();
    expect(capture).toHaveBeenCalledOnce();
    if (mode === 'unchanged') {
      expect(cancelled).toBe(false); expect(outcome).toBe('fulfilled'); expect(report).toHaveBeenCalledOnce();
      expect(vi.mocked(f.resource.appendChunk).mock.calls.length).toBeGreaterThan(before);
    } else {
      expect(cancelled).toBe(true); expect(admitted).toHaveBeenCalledTimes(2);
      expect(report).not.toHaveBeenCalled(); expect(vi.mocked(f.resource.appendChunk).mock.calls).toHaveLength(before);
      expect(outcome).toBe('rejected');
    }
  });
});
