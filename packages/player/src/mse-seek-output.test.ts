import { describe, expect, it, vi } from 'vitest';
import type { MediaAppendObservation, MediaAppendObserver, MediaSeekResource, MediaSeekSample } from './interfaces.js';
import { MseSeekOutput } from './mse-seek-output.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture(roles: readonly ('video' | 'audio')[] = ['video'], playing = true) {
  const epoch = {}, resourceId = {}, positioned = deferred<MediaSeekSample>();
  let checkCurrent: (() => void) | undefined;
  let current = true, nativeCurrent = true, observer: MediaAppendObserver | undefined, sample: MediaSeekSample | null = null;
  const appended: Array<{ token: object; role: 'video' | 'audio' }> = [];
  const resource: MediaSeekResource = {
    epoch, resource: resourceId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: vi.fn(async () => {}),
    observeAppends(fn) { observer = fn; return vi.fn(() => { observer = undefined; }); },
    appendChunk: vi.fn((role, _bytes, _name, _group, token) => { appended.push({ token: token!, role }); }),
    getTimestampOffset: () => 0, setTimestampOffset: vi.fn(),
    position: vi.fn(() => positioned.promise), sample: vi.fn(() => sample),
    setPlaybackIntent: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }),
  };
  const adopted = vi.fn(), failed = vi.fn(), submitted = vi.fn();
  const output = new MseSeekOutput({ resource, targetMs: 5000, roles, playing,
    isCurrent: () => { checkCurrent?.(); return current; }, onPosition: adopted, retire: () => resource.cancel(), onError: failed, onSubmitted: submitted });
  const append = (role: 'video' | 'audio', end = 6, coversTarget = true) => output.append(role,
    Uint8Array.of(1), role, 3n, role, { endTimeSeconds: end, coversTarget });
  const terminal = (index: number, state: MediaAppendObservation['state'] = 'appended') => {
    const token = appended[index]!.token;
    observer?.(state === 'appended' ? { token, state, reason: null } : state === 'discarded'
      ? { token, state, reason: 'append error' } : { token, state, reason: 'completion unproven' });
  };
  const land = (time = 5.001) => {
    sample = { epoch, resource: resourceId, currentTime: time, buffered: { start: 4, end: 12 } };
    positioned.resolve(sample); return sample;
  };
  return { output, resource, append, terminal, land, positioned, appended, adopted, failed, submitted,
    setSample(value: MediaSeekSample | null) { sample = value; },
    lose() { current = false; },
    onCurrent(check: (() => void) | undefined) { checkCurrent = check; } };
}

describe('MSE output owned by a seek', () => {
  it('uses the admitted observation token for native credit and reports submission before credit settles', async () => {
    const f = fixture(), token = {}, done = vi.fn();
    const work = f.output.append('video', Uint8Array.of(1), 'video', 3n, 'video',
      { endTimeSeconds: 6, coversTarget: true }, token);
    void work.then(done, () => {});
    expect(f.appended[0]!.token).toBe(token);
    expect(f.submitted).toHaveBeenCalledExactlyOnceWith('video');
    await settle(); expect(done).not.toHaveBeenCalled();
    f.terminal(0); await work; expect(done).toHaveBeenCalledOnce(); f.output.cancel();
  });

  it.each(['throws', 'retires'] as const)('does not report a native append that %s as a current submission', async outcome => {
    const f = fixture();
    vi.mocked(f.resource.appendChunk).mockImplementation(() => {
      if (outcome === 'throws') throw new Error('fixture append refusal');
      f.lose();
    });
    await expect(f.append('video')).rejects.toThrow();
    expect(f.submitted).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('positions only after actual append completion and reports the native landing, without playing first', async () => {
    const f = fixture(); const work = f.append('video');
    expect(f.resource.position).not.toHaveBeenCalled();
    f.terminal(0); await work;
    expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(5);
    expect(f.resource.setPlaybackIntent).not.toHaveBeenCalled();
    const sample = f.land(); await settle();
    expect(f.adopted).toHaveBeenCalledExactlyOnceWith(sample);
    expect(f.resource.setPlaybackIntent).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('requires every selected role to append target coverage, rather than borrowing video readiness for audio', async () => {
    const f = fixture(['video', 'audio']);
    const video = f.append('video'); f.terminal(0); await video;
    expect(f.resource.position).not.toHaveBeenCalled();
    const audio = f.append('audio', 4.5, false); f.terminal(1); await audio;
    expect(f.resource.position).not.toHaveBeenCalled();
    const later = f.append('audio'); f.terminal(2); await later;
    expect(f.resource.position).toHaveBeenCalledOnce(); f.land(); await settle();
    f.output.cancel();
  });

  it('holds a paused seek paused and accepts an explicit later play intent', async () => {
    const f = fixture(['video'], false); const work = f.append('video'); f.terminal(0); await work;
    f.land(); await settle();
    expect(f.resource.setPlaybackIntent).toHaveBeenCalledExactlyOnceWith(false);
    f.output.setPlaying(true);
    expect(f.resource.setPlaybackIntent).toHaveBeenLastCalledWith(true); f.output.cancel();
  });

  it('honors pause while native positioning is pending instead of replaying the admission intent', async () => {
    const f = fixture(); const work = f.append('video'); f.terminal(0); await work;
    f.output.setPlaying(false); f.land(); await settle();
    expect(f.resource.setPlaybackIntent).toHaveBeenCalledExactlyOnceWith(false); f.output.cancel();
  });

  it('handles a synchronous append terminal because ownership exists before the native call', async () => {
    const f = fixture();
    vi.mocked(f.resource.appendChunk).mockImplementation((_role, _bytes, _name, _group, token) => {
      // The observer is exercised through the same token recorded by the normal fake.
      f.appended.push({ token: token!, role: 'video' }); f.terminal(0);
    });
    await f.append('video'); expect(f.resource.position).toHaveBeenCalledOnce(); f.land(); await settle();
    f.output.cancel();
  });

  it.each(['discarded', 'unavailable'] as const)('refuses %s appends without certifying native positioning', async state => {
    const f = fixture(); const work = f.append('video'); const rejection = expect(work).rejects.toThrow(/append|completion/i);
    f.terminal(0, state); await rejection;
    expect(f.resource.position).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledOnce(); f.output.cancel();
  });

  it('backpressures a fast FETCH after bounded lookahead, releases on observed output progress and does not extrapolate', async () => {
    const f = fixture(); const first = f.append('video'); f.terminal(0); await first; f.land(); await settle();
    const fast = f.append('video', 11); const done = vi.fn(); void fast.then(done, () => {});
    f.terminal(1); await settle(); expect(done).not.toHaveBeenCalled();
    f.output.tick(); await settle(); expect(done).not.toHaveBeenCalled();
    f.setSample({ epoch: f.resource.epoch, resource: f.resource.resource, currentTime: 7,
      buffered: { start: 4, end: 11 } });
    f.output.tick(); await fast; expect(done).toHaveBeenCalledOnce(); f.output.cancel();
  });

  it('does not use a foreign sample to release FETCH credit', async () => {
    const f = fixture(); const first = f.append('video'); f.terminal(0); await first; f.land(); await settle();
    const fast = f.append('video', 11); const done = vi.fn(); void fast.then(done, () => {});
    f.terminal(1); await settle();
    f.setSample({ epoch: {}, resource: f.resource.resource, currentTime: 100, buffered: { start: 0, end: 200 } });
    f.output.tick(); await settle(); expect(done).not.toHaveBeenCalled();
    const rejection = expect(fast).rejects.toMatchObject({ name: 'AbortError' }); f.output.cancel(); await rejection;
  });

  it('cancellation wakes both pending native append and lookahead waiters exactly once', async () => {
    const f = fixture(['video', 'audio']);
    const video = f.append('video', 11); f.terminal(0); await settle();
    const audio = f.append('audio');
    const rejects = [video, audio].map(work => expect(work).rejects.toMatchObject({ name: 'AbortError' }));
    f.output.cancel(); f.output.cancel(); await Promise.all(rejects);
    f.terminal(1); expect(f.resource.cancel).toHaveBeenCalledOnce(); expect(f.adopted).not.toHaveBeenCalled();
  });

  it('does not publish or play when an obsolete native position completes', async () => {
    const f = fixture(); const work = f.append('video'); f.terminal(0); await work;
    f.lose(); f.land(); await settle();
    expect(f.adopted).not.toHaveBeenCalled(); expect(f.resource.setPlaybackIntent).not.toHaveBeenCalled();
    f.output.cancel();
  });

  it('a reentrant position callback cannot play a cancelled resource', async () => {
    const f = fixture(); f.adopted.mockImplementation(() => { f.output.cancel(); });
    const work = f.append('video'); f.terminal(0); await work; f.land(); await settle();
    expect(f.resource.setPlaybackIntent).not.toHaveBeenCalled(); expect(f.resource.cancel).toHaveBeenCalledOnce();
  });

  it('reports a native positioning failure once and consumes late rejection after cancellation', async () => {
    const f = fixture(); const work = f.append('video'); f.terminal(0); await work;
    f.positioned.reject(new Error('native seek failed')); await settle();
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.resource.cancel).toHaveBeenCalledOnce();
    const g = fixture(); const pending = g.append('video'); g.terminal(0); await pending;
    g.output.cancel(); g.positioned.reject(new Error('late native failure')); await settle();
    expect(g.failed).not.toHaveBeenCalled();
  });

  it.each([9, 11])('an uncovered Object ending at %ss releases the read that discovers EOF', async end => {
    const f = fixture(); let eofReads = 0;
    const work = f.append('video', end, false);
    const consumed = work.then(() => { eofReads++; f.output.end('video'); });
    f.terminal(0); await consumed;
    expect(eofReads).toBe(1); expect(f.failed).toHaveBeenCalledOnce();
    expect(f.resource.position).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('bounds native media accumulated before target coverage instead of waiting on an impossible head', async () => {
    const f = fixture();
    const first = f.output.append('video', new Uint8Array(8 * 1024 * 1024), 'v', 3n, 'v', { endTimeSeconds: 11, coversTarget: false });
    f.terminal(0); await first;
    await expect(f.append('video', 12, false)).rejects.toThrow(/byte budget/);
    expect(f.failed).toHaveBeenCalledOnce(); expect(f.resource.position).not.toHaveBeenCalled();
  });

  it.each([false, true])('rechecks admission after resource cleanup reentry=%s before publishing failure', async reentry => {
    const f = fixture(); const work = f.append('video'); f.terminal(0); await work;
    vi.mocked(f.resource.cancel).mockImplementation(() => { if (reentry) f.lose(); });
    f.positioned.reject(new Error('native failure')); await settle();
    expect(f.resource.cancel).toHaveBeenCalledOnce(); expect(f.failed).toHaveBeenCalledTimes(reentry ? 0 : 1);
  });

  it('refuses concurrent input on one role instead of accumulating an unbounded append queue', async () => {
    const f = fixture(); const first = f.append('video');
    await expect(f.append('video')).rejects.toThrow(/pending|concurrent/i);
    f.terminal(0); await first; f.land(); await settle(); f.output.cancel();
  });

  it('fails a completed FETCH that never supplied target coverage without pretending seek completion', async () => {
    const f = fixture(); const work = f.append('video', 4.5, false); f.terminal(0); await work;
    f.output.end('video'); expect(f.failed).toHaveBeenCalledOnce();
    expect(f.resource.position).not.toHaveBeenCalled(); expect(f.adopted).not.toHaveBeenCalled();
  });
});


async function positionedFixture(roles: readonly ('video' | 'audio')[] = ['video'], playing = false) {
  const f = fixture(roles, playing);
  for (const role of roles) { const work = f.append(role); f.terminal(f.appended.length - 1); await work; }
  f.land(); await settle();
  return f;
}

describe('positioned seek role suspension', () => {
  it('refuses an unselected role and an unpositioned output without disturbing their input', async () => {
    const f = fixture();
    expect(() => f.output.suspendRole('audio')).toThrow(/role|selected/i);
    expect(() => f.output.suspendRole('video')).toThrow(/position/i);
    const work = f.append('video'); f.terminal(0); await work;
    expect(() => f.output.suspendRole('video')).toThrow(/position/i);
    f.land(); await settle(); expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('settles the native barrier while paused far ahead without granting held read credit', async () => {
    const f = await positionedFixture();
    const work = f.append('video', 12), done = vi.fn(); void work.then(done, () => {});
    const hold = f.output.suspendRole('video'), native = vi.fn(); void hold.nativeSettled.then(native);
    f.output.tick(); await settle(); expect(native).not.toHaveBeenCalled();
    f.terminal(1); await hold.nativeSettled;
    expect(native).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
    f.setSample({ ...f.land(), currentTime: 10 }); f.output.tick(); await settle();
    expect(done).not.toHaveBeenCalled();
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    hold.commit(); await rejected; expect(hold.current).toBe(false);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.position).toHaveBeenCalledOnce();
    f.output.cancel();
  });

  it('an already appended far-ahead Object has an immediately settled native barrier', async () => {
    const f = await positionedFixture(), work = f.append('video', 12); void work.catch(() => {});
    f.terminal(1); await settle(); const hold = f.output.suspendRole('video');
    await hold.nativeSettled; hold.commit();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' }); f.output.cancel();
  });

  it.each([false, true])('resume preserves original pending credit, credit available=%s', async available => {
    const f = await positionedFixture(), work = f.append('video', 12), done = vi.fn(); void work.then(done, () => {});
    const hold = f.output.suspendRole('video'); f.terminal(1); await hold.nativeSettled;
    if (available) f.setSample({ ...f.land(), currentTime: 10 });
    hold.resume(); await settle(); expect(done).toHaveBeenCalledTimes(available ? 1 : 0);
    if (!available) { f.setSample({ ...f.land(), currentTime: 10 }); f.output.tick(); }
    await work; expect(done).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('resume before native completion abandons only the lease barrier, not the original append', async () => {
    const f = await positionedFixture(), work = f.append('video', 7);
    const hold = f.output.suspendRole('video');
    const abandoned = expect(hold.nativeSettled).rejects.toMatchObject({ name: 'AbortError' });
    hold.resume(); await abandoned; expect(hold.current).toBe(false);
    const successor = f.output.suspendRole('video'); f.terminal(1); await successor.nativeSettled;
    successor.resume(); await work; expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('refuses premature commit without consuming the lease or pending native owner', async () => {
    const f = await positionedFixture(), work = f.append('video', 12); void work.catch(() => {});
    const hold = f.output.suspendRole('video'); expect(() => hold.commit()).toThrow(/native|settle/i);
    expect(hold.current).toBe(true); f.terminal(1); await hold.nativeSettled; hold.commit();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' }); expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('a held video role leaves audio input, credit, clock and playback intent active', async () => {
    const f = await positionedFixture(['video', 'audio']);
    const oldVideo = f.append('video', 12); void oldVideo.catch(() => {});
    const hold = f.output.suspendRole('video'), audio = f.append('audio', 7);
    f.terminal(3); await audio; f.terminal(2); await hold.nativeSettled; hold.commit();
    await expect(oldVideo).rejects.toMatchObject({ name: 'AbortError' });
    const laterAudio = f.append('audio', 8); f.terminal(4); await laterAudio;
    const replacement = f.append('video', 7); f.terminal(5); await replacement;
    expect(f.adopted).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.resource.initialize).not.toHaveBeenCalled(); expect(f.resource.cancel).not.toHaveBeenCalled();
    expect(f.resource.setPlaybackIntent).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('reopens an ended role on the positioned graph without positioning again', async () => {
    const f = await positionedFixture(); f.output.end('video');
    const hold = f.output.suspendRole('video'); await hold.nativeSettled; hold.commit();
    const next = f.append('video', 7, false); f.terminal(1); await next;
    f.output.end('video'); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.adopted).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('retains graph coverage rather than applying the original precoverage byte budget again', async () => {
    const f = await positionedFixture(); const hold = f.output.suspendRole('video'); hold.commit();
    const work = f.output.append('video', new Uint8Array(8 * 1024 * 1024 + 1), 'new-video', 8n, 'new-source',
      { endTimeSeconds: 7, coversTarget: false });
    const rejected = vi.fn(); void work.catch(rejected); await settle();
    expect(rejected).not.toHaveBeenCalled(); f.terminal(1); await work; f.output.end('video');
    expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });

  it('a replacement beyond the original seek target waits for native credit and ends after drain', async () => {
    const f = await positionedFixture(); const hold = f.output.suspendRole('video'); hold.commit();
    const work = f.append('video', 20, false), done = vi.fn(); void work.then(done, () => {});
    try {
      f.terminal(1); await settle();
      expect(done).not.toHaveBeenCalled(); f.output.tick(); await settle();
      expect(done).not.toHaveBeenCalled();
      f.setSample({ ...f.land(), currentTime: 16, buffered: { start: 4, end: 21 } }); f.output.tick();
      await work; expect(done).toHaveBeenCalledOnce(); f.output.end('video');
      expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.position).toHaveBeenCalledOnce();
      expect(f.adopted).toHaveBeenCalledOnce();
    } finally { f.output.cancel(); }
  });

  it('refuses held append/end and a second lease before mutating the role', async () => {
    const f = await positionedFixture(), hold = f.output.suspendRole('video');
    await expect(f.append('video')).rejects.toThrow(/suspend|held/i);
    expect(() => f.output.end('video')).toThrow(/suspend|held/i);
    expect(() => f.output.suspendRole('video')).toThrow(/suspend|held|owned/i);
    expect(f.appended).toHaveLength(1); hold.resume();
    const next = f.append('video'); f.terminal(1); await next; f.output.cancel();
  });

  it('consumed leases cannot retire or resume a successor suspension', async () => {
    const f = await positionedFixture(), old = f.output.suspendRole('video'); old.resume();
    const successor = f.output.suspendRole('video'); old.resume();
    expect(() => old.commit()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(successor.current).toBe(true); successor.commit();
    expect(() => successor.commit()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    successor.resume(); const next = f.append('video'); f.terminal(1); await next; f.output.cancel();
  });

  it('ignores late old native tokens while a replacement append owns credit', async () => {
    const f = await positionedFixture(), old = f.append('video', 12); void old.catch(() => {});
    const hold = f.output.suspendRole('video'); f.terminal(1); await hold.nativeSettled; hold.commit();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const next = f.append('video'), done = vi.fn(); void next.then(done, () => {});
    f.terminal(1, 'discarded'); f.terminal(1); await settle();
    expect(done).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
    f.terminal(2); await next; expect(done).toHaveBeenCalledOnce(); f.output.cancel();
  });

  it.each(['discarded', 'unavailable'] as const)('native %s before commit remains a real shared output failure', async state => {
    const f = await positionedFixture(['video', 'audio']); const old = f.append('video', 12);
    const audio = f.append('audio', 8), hold = f.output.suspendRole('video');
    const rejected = [old, audio, hold.nativeSettled].map(work => expect(work).rejects.toThrow(/append|completion/i));
    f.terminal(2, state); await Promise.all(rejected);
    expect(hold.current).toBe(false); expect(f.failed).toHaveBeenCalledOnce();
    expect(() => hold.commit()).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });

  it('cancellation releases both role leases and append waits exactly once before cleanup reentry', async () => {
    const f = await positionedFixture(['video', 'audio']), video = f.append('video', 12), audio = f.append('audio', 12);
    const v = f.output.suspendRole('video'), a = f.output.suspendRole('audio');
    const rejected = [video, audio, v.nativeSettled, a.nativeSettled].map(work => expect(work).rejects.toMatchObject({ name: 'AbortError' }));
    vi.mocked(f.resource.cancel).mockImplementation(() => {
      expect(v.current).toBe(false); expect(a.current).toBe(false);
      expect(() => f.output.suspendRole('video')).toThrow(expect.objectContaining({ name: 'AbortError' }));
    });
    f.output.cancel(); f.output.cancel(); await Promise.all(rejected);
    expect(f.resource.cancel).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it.each(['current', 'commit', 'resume'] as const)('native current reentry closing output releases waiters during %s', async operation => {
    const f = await positionedFixture(), work = f.append('video', 12), hold = f.output.suspendRole('video');
    const rejected = [work, hold.nativeSettled].map(value => expect(value).rejects.toMatchObject({ name: 'AbortError' }));
    Object.defineProperty(f.resource, 'current', { get() { f.output.cancel(); return true; } });
    if (operation === 'current') expect(hold.current).toBe(false);
    else if (operation === 'commit') expect(() => hold.commit()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    else hold.resume();
    await Promise.all(rejected); expect(f.resource.cancel).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('a throwing current getter closes waits rather than leaking a native barrier', async () => {
    const f = await positionedFixture(), work = f.append('video', 12), hold = f.output.suspendRole('video');
    const rejected = [work, hold.nativeSettled].map(value => expect(value).rejects.toMatchObject({ name: 'AbortError' }));
    Object.defineProperty(f.resource, 'current', { get() { throw new Error('fixture current access failed'); } });
    expect(hold.current).toBe(false); await Promise.all(rejected); expect(f.failed).not.toHaveBeenCalled();
  });

  it('checks lease identity again after current access resumes it and installs a successor', async () => {
    const f = await positionedFixture(), old = f.output.suspendRole('video');
    let successor: ReturnType<MseSeekOutput['suspendRole']> | undefined, once = true;
    Object.defineProperty(f.resource, 'current', { get() {
      if (once) { once = false; old.resume(); successor = f.output.suspendRole('video'); }
      return true;
    } });
    expect(() => old.commit()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(successor?.current).toBe(true); successor!.resume();
    const next = f.append('video'); f.terminal(1); await next; f.output.cancel();
  });

  it('does not accept a final admission callback that synchronously closes the output', async () => {
    const f = await positionedFixture(), work = f.append('video', 12), hold = f.output.suspendRole('video');
    const rejected = [work, hold.nativeSettled].map(value => expect(value).rejects.toMatchObject({ name: 'AbortError' }));
    let reads = 0; f.onCurrent(() => { if (++reads === 2) f.output.cancel(); });
    expect(() => hold.commit()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    await Promise.all(rejected); expect(f.failed).not.toHaveBeenCalled();
  });

  it('resume rechecks ownership when sampling read credit cancels the output', async () => {
    const f = await positionedFixture(), work = f.append('video', 12); void work.catch(() => {});
    const hold = f.output.suspendRole('video'); f.terminal(1); await hold.nativeSettled;
    vi.mocked(f.resource.sample).mockImplementation(() => { f.output.cancel(); return f.land(10); });
    hold.resume(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.failed).not.toHaveBeenCalled();
  });
});

describe('independent role output ownership', () => {
  it('commits only the settled video lease while an independent audio lease still owns native work', async () => {
    const f = await positionedFixture(['video', 'audio']);
    const video = f.append('video', 12), audio = f.append('audio', 12);
    void video.catch(() => {}); void audio.catch(() => {});
    const v = f.output.suspendRole('video'), a = f.output.suspendRole('audio');
    const audioBarrierSettled = vi.fn(), audioCreditSettled = vi.fn();
    void a.nativeSettled.then(audioBarrierSettled, audioBarrierSettled);
    void audio.then(audioCreditSettled, audioCreditSettled);
    f.terminal(2); await v.nativeSettled; v.commit();
    await expect(video).rejects.toMatchObject({ name: 'AbortError' }); await settle();
    expect(a.current).toBe(true); expect(audioBarrierSettled).not.toHaveBeenCalled();
    expect(audioCreditSettled).not.toHaveBeenCalled();
    const replacement = f.append('video', 7, false); f.terminal(2, 'discarded');
    f.terminal(4); await replacement; await settle();
    expect(a.current).toBe(true); expect(audioBarrierSettled).not.toHaveBeenCalled();
    expect(audioCreditSettled).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
    expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.resource.cancel).not.toHaveBeenCalled();
    const rejects = [audio, a.nativeSettled].map(value => expect(value).rejects.toMatchObject({ name: 'AbortError' }));
    f.output.cancel(); await Promise.all(rejects); await settle();
    expect(audioBarrierSettled).toHaveBeenCalledOnce(); expect(audioCreditSettled).toHaveBeenCalledOnce();
    expect(f.resource.cancel).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('aborts an outer suspension when its current getter commits the captured role generation', async () => {
    const f = await positionedFixture(), work = f.append('video', 12); void work.catch(() => {});
    f.terminal(1); await settle();
    let once = true, inner: ReturnType<MseSeekOutput['suspendRole']> | undefined;
    Object.defineProperty(f.resource, 'current', { get() {
      if (once) { once = false; inner = f.output.suspendRole('video'); inner.commit(); }
      return true;
    } });
    expect(() => f.output.suspendRole('video')).toThrow(expect.objectContaining({ name: 'AbortError' }));
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(inner?.current).toBe(false); expect(f.failed).not.toHaveBeenCalled();
    const fresh = f.output.suspendRole('video'); await fresh.nativeSettled; fresh.resume();
    const replacement = f.append('video', 7, false); f.terminal(1, 'unavailable'); f.terminal(2); await replacement;
    expect(f.failed).not.toHaveBeenCalled(); expect(f.resource.position).toHaveBeenCalledOnce(); f.output.cancel();
  });
});

function tracked(f: ReturnType<typeof fixture>, group: bigint, endUs: bigint, admitted: () => boolean = () => true) {
  return f.output.append('video', Uint8Array.of(1), 'video', group, 'video',
    { endTimeSeconds: Number(endUs) / 1000000, coversTarget: true }, undefined,
    { endUs: { numerator: endUs, denominator: 1n }, timestampOffset: 0, admitted });
}

describe('native submission registration', () => {
  it('retains both maxima across out-of-order submissions and a role-state commit', async () => {
    const f = fixture();
    try {
      const first = tracked(f, 8n, 6000000n); f.terminal(0); await first; f.land(); await settle();
      const hold = f.output.suspendRole('video'); await hold.nativeSettled; hold.commit();
      const next = tracked(f, 7n, 5500000n); f.terminal(1); await next;
      const frontier = f.output.submissionFrontier('video')!;
      expect(frontier.highestSubmittedGroup).toBe(8n);
      expect(frontier.maxSubmittedEndUs).toEqual({ numerator: 6000000n, denominator: 1n });
      const more = tracked(f, 9n, 6500000n); f.terminal(2); await more;
      expect(f.output.submissionFrontier('video')!.highestSubmittedGroup).toBe(9n);
      expect(f.output.submissionFrontier('video')!.maxSubmittedEndUs).toEqual({ numerator: 6500000n, denominator: 1n });
      expect(frontier.highestSubmittedGroup).toBe(8n); expect(f.failed).not.toHaveBeenCalled();
    } finally { f.output.cancel(); }
  });

  it('reserves before a native throw and never rewinds the resource ledger on failure', async () => {
    const f = fixture();
    vi.mocked(f.resource.appendChunk).mockImplementation(() => {
      expect(f.output.submissionFrontier('video')?.highestSubmittedGroup).toBe(12n);
      throw new Error('fixture native throw');
    });
    await expect(tracked(f, 12n, 7000000n)).rejects.toThrow('fixture native throw');
    expect(f.output.submissionFrontier('video')!.maxSubmittedEndUs).toEqual({ numerator: 7000000n, denominator: 1n });
    expect(f.failed).toHaveBeenCalledOnce(); f.output.cancel();
  });

  it('refuses stale actor admission or offset mismatch before changing the pending token or frontier', async () => {
    const f = fixture(); const prior = f.output.submissionFrontier('video');
    await expect(tracked(f, 3n, 6000000n, () => false)).rejects.toMatchObject({ name: 'AbortError' });
    const badOffset = f.output.append('video', Uint8Array.of(1), 'video', 3n, 'video',
      { endTimeSeconds: 6, coversTarget: true }, undefined,
      { endUs: { numerator: 6000000n, denominator: 1n }, timestampOffset: 1, admitted: () => true });
    await expect(badOffset).rejects.toThrow(/context/);
    expect(f.output.submissionFrontier('video')).toBe(prior); expect(f.appended).toHaveLength(0);
    expect(f.failed).not.toHaveBeenCalled();
    const healthy = tracked(f, 3n, 6000000n); f.terminal(0); await healthy; f.output.cancel();
  });

  it('does not erase a successor suspension installed by callback-bearing native offset access', async () => {
    const f = await positionedFixture(); let hold: ReturnType<MseSeekOutput['suspendRole']> | undefined;
    const original = f.resource.getTimestampOffset;
    Object.defineProperty(f.resource, 'getTimestampOffset', { value: () => { hold = f.output.suspendRole('video'); return 0; } });
    const prior = f.output.submissionFrontier('video');
    await expect(tracked(f, 9n, 6000000n)).rejects.toMatchObject({ name: 'AbortError' });
    expect(hold!.current).toBe(true); await hold!.nativeSettled;
    expect(f.output.submissionFrontier('video')).toBe(prior); expect(f.appended).toHaveLength(1);
    hold!.resume(); Object.defineProperty(f.resource, 'getTimestampOffset', { value: original });
    const healthy = tracked(f, 9n, 6000000n); f.terminal(1); await healthy;
    expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
  });
});

it('does not reserve native work when offset access retires the resource', async () => {
  const f = fixture(), prior = f.output.submissionFrontier('video');
  Object.defineProperty(f.resource, 'getTimestampOffset', { value: () => { f.resource.cancel(); return 0; } });
  await expect(tracked(f, 4n, 6000000n)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.output.submissionFrontier('video')).toBe(prior); expect(f.appended).toHaveLength(0);
  expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
});

it('rejects last-offset admission revocation without an actor cancel call or native submission', async () => {
  const f = fixture(), prior = f.output.submissionFrontier('video');
  Object.defineProperty(f.resource, 'getTimestampOffset', { value: () => { f.lose(); return 0; } });
  await expect(tracked(f, 4n, 6000000n)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.output.submissionFrontier('video')).toBe(prior); expect(f.appended).toHaveLength(0);
  expect(f.failed).not.toHaveBeenCalled(); f.output.cancel();
});

it('changes the frontier revision on role commit without discarding either maximum', async () => {
  const f = fixture();
  try {
    const work = tracked(f, 8n, 6000000n); f.terminal(0); await work; f.land(); await settle();
    const prior = f.output.submissionFrontier('video')!, hold = f.output.suspendRole('video');
    await hold.nativeSettled; hold.commit();
    const next = f.output.submissionFrontier('video')!;
    expect(next.revision).not.toBe(prior.revision); expect(next.highestSubmittedGroup).toBe(prior.highestSubmittedGroup);
    expect(next.maxSubmittedEndUs).toBe(prior.maxSubmittedEndUs);
  } finally { f.output.cancel(); }
});

describe('owned preparation read credit', () => {
  it('grants only actual successful native credit for its role and restores ordinary policy when cleared', async () => {
    const f = await positionedFixture(['video', 'audio']), owner = {};
    try {
      f.output.enablePreparationReadCredit('video', owner, () => true);
      const video = f.append('video', 20), audio = f.append('audio', 20), vDone = vi.fn(), aDone = vi.fn();
      void video.then(vDone, () => {}); void audio.then(aDone, () => {}); await settle();
      expect(vDone).not.toHaveBeenCalled(); expect(aDone).not.toHaveBeenCalled();
      f.terminal(2); await video; f.terminal(3); await settle(); expect(aDone).not.toHaveBeenCalled();
      f.output.clearPreparationReadCredit('video', owner);
      const ordinary = f.append('video', 20), ordinaryDone = vi.fn(); void ordinary.then(ordinaryDone, () => {});
      f.terminal(4); await settle(); expect(ordinaryDone).not.toHaveBeenCalled();
      f.setSample({ ...f.land(), currentTime: 16, buffered: { start: 4, end: 21 } }); f.output.tick();
      await Promise.all([audio, ordinary]); expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    } finally { f.output.cancel(); }
  });

  it.each(['discarded', 'unavailable'] as const)('cannot convert native %s into successful credit', async state => {
    const f = await positionedFixture(), owner = {}; f.output.enablePreparationReadCredit('video', owner, () => true);
    const work = f.append('video', 20), done = vi.fn(); void work.then(done, () => {});
    const rejected = expect(work).rejects.toThrow(/append|completion/); f.terminal(1, state); await rejected;
    expect(done).not.toHaveBeenCalled(); expect(f.failed).toHaveBeenCalledOnce(); f.output.cancel();
  });

  it('does not transfer permission across role commit or allow stale cleanup to erase a successor', async () => {
    const f = await positionedFixture(), old = {}, next = {};
    try {
      f.output.enablePreparationReadCredit('video', old, () => true);
      const hold = f.output.suspendRole('video'); await hold.nativeSettled; hold.commit();
      const work = f.append('video', 20), done = vi.fn(); void work.then(done, () => {});
      f.terminal(1); await settle(); expect(done).not.toHaveBeenCalled();
      f.output.enablePreparationReadCredit('video', next, () => true);
      f.output.clearPreparationReadCredit('video', old); await work;
      const more = f.append('video', 20); f.terminal(2); await more;
      expect(done).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    } finally { f.output.cancel(); }
  });

  it('returns consumed preparation permission to ordinary credit while preserving a successor hold', async () => {
    const f = await positionedFixture(), old = {}; let once = false, armed = false;
    let successor: ReturnType<MseSeekOutput['suspendRole']> | undefined;
    try {
      f.output.enablePreparationReadCredit('video', old, () => {
        if (armed && !once) {
          once = true; f.output.clearPreparationReadCredit('video', old); successor = f.output.suspendRole('video');
        }
        return !armed;
      });
      const work = f.append('video', 20), done = vi.fn(); void work.then(done, () => {});
      armed = true; f.terminal(1); await settle(); expect(done).not.toHaveBeenCalled();
      expect(successor!.current).toBe(true); await successor!.nativeSettled;
      f.output.clearPreparationReadCredit('video', old); expect(successor!.current).toBe(true);
      successor!.resume(); await settle(); expect(done).not.toHaveBeenCalled();
      f.setSample({ ...f.land(), currentTime: 16, buffered: { start: 4, end: 21 } }); f.output.tick(); await work;
      expect(done).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled();
    } finally { f.output.cancel(); }
  });
});
