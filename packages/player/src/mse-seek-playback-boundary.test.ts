import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, readCmafObjectSamples, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MseSeekPlayback, type SeekRolePreparation } from './mse-seek-playback.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import type { FractionUs } from './presentation-placement.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
async function settle() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
function exact(value: FractionUs, numerator: bigint, denominator = 1n) {
  expect(value.numerator * denominator).toBe(numerator * value.denominator);
}
function object(payload: Uint8Array, id = 0n, group = 4n): MoqtObject {
  return { kind: 'data', groupId: varint(group), objectId: varint(id), subgroupId: varint(0), trackAlias: varint(0), payload, publisherPriority: 128 };
}
async function fixture(scale = 12288, offset = 0, packaging: 'cmaf' | 'locmaf' = 'locmaf') {
  const init = buildInit({ trackId: 1, timescale: scale, handler: 'vide' }), epoch = {}, identity = {};
  const context = parseLocmafTrackContext(init), native: Uint8Array[] = [];
  let observer: MediaAppendObserver | null = null, current = true, sample: MediaSeekSample | null = null, end = 6;
  const resource: MediaSeekResource = { epoch, resource: identity, get current() { return current; },
    initialize: vi.fn(() => true), whenAttached: async () => {},
    appendChunk: vi.fn((_role, bytes, _name, _group, token) => {
      native.push(bytes.slice()); const reads = readCmafObjectSamples(bytes, context)!;
      for (const read of reads) end = Math.max(end, Number(read.effective.baseMediaDecodeTime + BigInt(read.effective.durations.reduce((a, b) => a + b, 0))) / scale + offset);
      observer?.({ token: token!, state: 'appended', reason: null });
    }),
    observeAppends(fn) { observer = fn; return () => { observer = null; }; },
    getTimestampOffset: vi.fn(() => offset), setTimestampOffset: vi.fn(),
    position: vi.fn(async () => { sample = { epoch, resource: identity, currentTime: 5.125, buffered: { start: 4 + offset, end } }; return sample; }),
    sample: () => sample && { ...sample, buffered: { start: 4 + offset, end } }, setPlaybackIntent: vi.fn(), cancel: vi.fn(() => { current = false; }) };
  const source: MediaSourceLike = { mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    beginSeek: vi.fn(() => resource), initialize: vi.fn(), appendChunk: vi.fn(), changeType: vi.fn(async () => {}),
    reset: vi.fn(), destroy: vi.fn(), endOfStream: vi.fn() };
  const previous = new CmafAssembler({ onSegment: vi.fn() }), onError = vi.fn(), onPageError = vi.fn(), onPosition = vi.fn(), onDiscard = vi.fn();
  let owned: CmafAssembler | null = null;
  const actor = new MseSeekPlayback({ epoch, source, liveAssembler: previous,
    createAssembler: callbacks => { owned = new CmafAssembler(callbacks); return owned; },
    tracks: [{ role: 'video', namespace: ['show'], name: 'old', sourceKey: 'old', codec: 'avc1.640028', init, packaging }],
    location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, timestampRounding: 'floor', targetMs: 5000,
    maxObjects: 10, maxBytes: 8192, preparationTimeoutMs: 1000, playing: false, isCurrent: () => current,
    beforeResourceChange: vi.fn(), adopt: vi.fn(), onSegment: vi.fn(), onDiscard, onPosition, onPageDrained: vi.fn(), onPageError, onError });
  cleanups.push(() => { actor.cancel(); resource.cancel(); owned?.destroy(); previous.destroy(); });
  function payloads(pts: bigint, duration = scale * 2, samples?: Parameters<typeof buildChunk>[0]['samples']) {
    const encoder = new LocmafEncoder(), state = new LocmafGroupState();
    return [0, 1].map(i => {
      const chunk = buildChunk({ trackId: 1, bmdt: pts + BigInt(i * duration),
        samples: i === 0 && samples ? samples : [{ duration, size: 4, flags: i ? NON_SYNC_FLAGS : SYNC_FLAGS }],
        mdat: new Uint8Array((i === 0 && samples ? samples.length : 1) * 4).fill(42 + i) });
      return packaging === 'cmaf' ? chunk : serializeLocmafObject(encoder.encode(chunk, state, context, false, BigInt(i)));
    });
  }
  actor.start(); const first = {}, receiver = actor.beginPage('video', first); actor.acceptPage('video', first, false);
  await receiver.onObject(object(payloads(BigInt(4 * scale))[0]!, 0n, 3n)); receiver.onClosed('fin'); await settle();
  expect(onPosition).toHaveBeenCalledOnce(); expect(native).toHaveLength(1);
  const base = { track: { role: 'video' as const, namespace: ['show'], name: 'new', sourceKey: 'new', codec: 'avc1.640028', init, packaging },
    location: { groupId: 4n, objectId: 0n }, mediaPts: 6000, timestampRounding: 'floor' as 'floor' | 'nearest',
    placement: { sourceTimeUs: 6000000n, rebasedTimeUs: { numerator: 6000000n, denominator: 1n } },
    onPageDrained: vi.fn(), onPageError: vi.fn(), onError: vi.fn() };
  function prepare(options: SeekRolePreparation) {
    const candidate = actor.prepareRole(options), page = {}, receiver = candidate.beginPage(page);
    return { candidate, page, receiver, accept: () => candidate.acceptPage(page, false) };
  }
  return { actor, base, native, resource, source, onError, onPageError, onDiscard, payloads, prepare };
}

describe('indexed independent role boundary', () => {
  it.each(['floor', 'nearest'] as const)('%s uses exact parsed fractional PTS and retains the format consumer after promotion', async rounding => {
    const f = await fixture(), p = f.prepare({ ...f.base, timestampRounding: rounding, readiness: 'indexed-boundary' });
    const payload = f.payloads(73729n); p.accept(); const work = p.receiver.onObject(object(payload[0]!)); void work.catch(() => {});
    await p.candidate.ready; const boundary = p.candidate.boundary!;
    exact(boundary.sourcePtsUs, 73729n * 1000000n, 12288n);
    exact(boundary.nativeSample.startUs, 73729n * 1000000n, 12288n);
    exact(boundary.nativeSample.endUs, (73729n + 24576n) * 1000000n, 12288n);
    exact(boundary.earliestNativeUs, 73729n * 1000000n, 12288n);
    expect(boundary.nativeSample.startUs.numerator > 6000050n * boundary.nativeSample.startUs.denominator).toBe(true);
    expect(Object.isFrozen(boundary)).toBe(true); expect(Object.isFrozen(boundary.nativeSample)).toBe(true);
    expect(Object.isFrozen(boundary.sourcePtsUs)).toBe(true); expect(Object.isFrozen(boundary.nativeSample.startUs)).toBe(true);
    expect(Object.isFrozen(boundary.nativeSample.endUs)).toBe(true); expect(Object.isFrozen(boundary.earliestNativeUs)).toBe(true);
    expect(f.native).toHaveLength(1);
    const hold = f.actor.holdRole('video', f.actor.roleOwner('video')!); await hold.nativeSettled; hold.commit(p.candidate); await work;
    p.receiver.onClosed('fin'); await settle(); const next = {}, receiver = p.candidate.beginPage(next); p.candidate.acceptPage(next, true);
    expect(new LocmafTrackDecoder(f.base.track.init).push(4n, 1n, payload[1]!).kind).toBe('rejected');
    await receiver.onObject(object(payload[1]!, 1n)); receiver.onClosed('fin'); await settle();
    expect(f.native).toHaveLength(3); expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
    expect(f.source.changeType).not.toHaveBeenCalled(); expect(p.candidate.boundary).toBe(boundary); expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(['floor', 'nearest'] as const)('%s numeric target at6000ms remains strictly before valid fractional media', async rounding => {
    const f = await fixture(), p = f.prepare({ ...f.base, timestampRounding: rounding, targetMs: 6000 });
    const rejection = expect(p.candidate.ready).rejects.toThrow(/coverage/); p.accept();
    await p.receiver.onObject(object(f.payloads(73729n)[0]!)); p.receiver.onClosed('fin'); await rejection;
    expect(f.native).toHaveLength(1); expect(f.onError).not.toHaveBeenCalled();
  });

  it('preserves successful numeric readiness inside an actual sample interval', async () => {
    const f = await fixture(), p = f.prepare({ ...f.base, targetMs: 6000.1 }); p.accept();
    const work = p.receiver.onObject(object(f.payloads(73729n)[0]!)); void work.catch(() => {});
    await p.candidate.ready; expect(f.native).toHaveLength(1); p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves a sub-microsecond first sample and positive interval without a guessed interior target', async () => {
    const f = await fixture(10000000), p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); p.accept();
    const work = p.receiver.onObject(object(f.payloads(60000001n, 1)[0]!)); void work.catch(() => {});
    await p.candidate.ready; const b = p.candidate.boundary!;
    exact(b.sourcePtsUs, 60000001n, 10n); exact(b.nativeSample.startUs, 60000001n, 10n); exact(b.nativeSample.endUs, 60000002n, 10n);
    p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([0.125, -0.125, 0.1])('applies negative fractional placement by floor ticks, then exact native offset%s', async offset => {
    const f = await fixture(12288, offset); f.base.placement.rebasedTimeUs = { numerator: 11999999n, denominator: 2n };
    const p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); p.accept();
    const work = p.receiver.onObject(object(f.payloads(73729n)[0]!)); void work.catch(() => {}); await p.candidate.ready;
    const n = offset === 0.1 ? 3602879701896397n * 1000000n : BigInt(offset * 1000000), d = offset === 0.1 ? 1n << 55n : 1n;
    exact(p.candidate.boundary!.nativeSample.startUs, 6000000n * d + n, d);
    exact(p.candidate.boundary!.nativeSample.endUs, 8000000n * d + n, d);
    const hold = f.actor.holdRole('video', f.actor.roleOwner('video')!); await hold.nativeSettled; hold.commit(p.candidate); await work;
    const parsed = readCmafObjectSamples(f.native[1]!, parseLocmafTrackContext(f.base.track.init))![0]!;
    expect(parsed.effective.baseMediaDecodeTime).toBe(73728n); expect(f.source.changeType).not.toHaveBeenCalled();
  });

  it('reports an earlier presentation sample in a SAP2-style decoded prefix without claiming continuous min/max coverage', async () => {
    const f = await fixture(12288, 0, 'cmaf'), p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); p.accept();
    const data = f.payloads(73729n, 100, [{ duration: 100, size: 4, flags: SYNC_FLAGS }, { duration: 100, size: 4, flags: NON_SYNC_FLAGS, cto: -24576 }])[0]!;
    const work = p.receiver.onObject(object(data)); void work.catch(() => {}); await p.candidate.ready;
    exact(p.candidate.boundary!.nativeSample.startUs, 73729n * 1000000n, 12288n);
    exact(p.candidate.boundary!.nativeSample.endUs, 73829n * 1000000n, 12288n);
    exact(p.candidate.boundary!.earliestNativeUs, (73729n + 100n - 24576n) * 1000000n, 12288n);
    expect(f.native).toHaveLength(1); p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the prepared boundary acceptance-owned and clears it on cancellation', async () => {
    const f = await fixture(), p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }), input = {};
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    await p.receiver.onObject(object(f.payloads(73729n)[0]!), input); p.receiver.onClosed('fin');
    expect(decode).not.toHaveBeenCalled(); expect(p.candidate.boundary).toBeNull(); p.candidate.acceptPage({}, false);
    await settle(); expect(p.candidate.boundary).toBeNull(); p.accept(); await p.candidate.ready;
    expect(p.candidate.boundary).not.toBeNull(); p.candidate.cancel(); expect(p.candidate.boundary).toBeNull();
    expect(f.onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'epoch refused'); expect(f.base.onPageDrained).not.toHaveBeenCalled();
  });

  it('cancellation before acceptance rejects readiness and never publishes parsed evidence', async () => {
    const f = await fixture(), p = f.prepare({ ...f.base, readiness: 'indexed-boundary' });
    const rejected = expect(p.candidate.ready).rejects.toMatchObject({ name: 'AbortError' });
    await p.receiver.onObject(object(f.payloads(73729n)[0]!)); p.candidate.cancel(); await rejected;
    expect(p.candidate.boundary).toBeNull(); expect(f.native).toHaveLength(1); expect(f.onError).not.toHaveBeenCalled();
  });

  it('rejects an indexed non-independent sample rather than borrowing earlier preroll SAP readiness', async () => {
    const f = await fixture(12288, 0, 'cmaf');
    const p = f.prepare({ ...f.base, location: { groupId: 4n, objectId: 1n }, readiness: 'indexed-boundary' }); p.accept();
    const rejected = expect(p.candidate.ready).rejects.toThrow(/independent|boundary/);
    await p.receiver.onObject(object(f.payloads(55296n, 12288)[0]!));
    const data = buildChunk({ trackId: 1, bmdt: 73729n, samples: [{ duration: 100, size: 4, flags: NON_SYNC_FLAGS }], mdat: Uint8Array.of(1,2,3,4) });
    await expect(p.receiver.onObject(object(data, 1n))).rejects.toThrow(/independent|boundary/); await rejected;
    expect(p.candidate.boundary).toBeNull(); expect(f.native).toHaveLength(1);
  });
  it('nearest indexing exposes the true sample start even when the nominal index would look future', async () => {
    const f = await fixture(10000), p = f.prepare({ ...f.base, timestampRounding: 'nearest', readiness: 'indexed-boundary' }); p.accept();
    const work = p.receiver.onObject(object(f.payloads(59997n)[0]!)); void work.catch(() => {}); await p.candidate.ready;
    const b = p.candidate.boundary!; exact(b.nativeSample.startUs, 5999700n);
    // A caller at5999.8ms must decline this actual5999.7ms boundary.
    expect(b.nativeSample.startUs.numerator < 5999800n * b.nativeSample.startUs.denominator).toBe(true);
    p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('includes earlier retained preroll in earliest presentation without changing the indexed sample interval', async () => {
    const f = await fixture(12288, 0, 'cmaf');
    const p = f.prepare({ ...f.base, location: { groupId: 4n, objectId: 1n }, readiness: 'indexed-boundary' }); p.accept();
    await p.receiver.onObject(object(f.payloads(55296n, 12288)[0]!));
    const data = buildChunk({ trackId: 1, bmdt: 73729n, samples: [{ duration: 100, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1,2,3,4) });
    const work = p.receiver.onObject(object(data, 1n)); void work.catch(() => {}); await p.candidate.ready;
    exact(p.candidate.boundary!.sourcePtsUs, 73729n * 1000000n, 12288n);
    exact(p.candidate.boundary!.earliestNativeUs, 4500000n);
    exact(p.candidate.boundary!.nativeSample.endUs, 73829n * 1000000n, 12288n);
    expect(f.native).toHaveLength(1); p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  });

});

describe('independent boundary facts and lifetime', () => {
  it('uses first-sample CTS and resets DTS per moof when finding the earliest prepared PTS', async () => {
    const f = await fixture(12288, 0.125, 'cmaf');
    f.base.placement.rebasedTimeUs = { numerator: 11999999n, denominator: 2n };
    const p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); p.accept();
    const first = buildChunk({ trackId: 1, bmdt: 73679n,
      samples: [{ duration: 100, size: 4, flags: SYNC_FLAGS, cto: 50 }], mdat: Uint8Array.of(1,2,3,4) });
    const later = buildChunk({ trackId: 1, bmdt: 74500n,
      samples: [{ duration: 200, size: 4, flags: NON_SYNC_FLAGS, cto: -1024 }], mdat: Uint8Array.of(5,6,7,8) });
    const bytes = new Uint8Array(first.length + later.length); bytes.set(first); bytes.set(later, first.length);
    const work = p.receiver.onObject(object(bytes)); void work.catch(() => {}); await p.candidate.ready;
    const b = p.candidate.boundary!;
    exact(b.sourcePtsUs, 73729n * 1000000n, 12288n);
    exact(b.nativeSample.startUs, 6125000n);
    exact(b.nativeSample.endUs, 73828n * 1000000n + 125000n * 12288n, 12288n);
    exact(b.earliestNativeUs, 73475n * 1000000n + 125000n * 12288n, 12288n);
    expect(f.native).toHaveLength(1); p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('retains exact indexed identity across the existing legacy moof/mdat split and discards both inputs once', async () => {
    const f = await fixture(12288, 0, 'cmaf'), p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); p.accept();
    const bytes = f.payloads(73729n)[0]!, size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const a = {}, b = {}; await p.receiver.onObject(object(bytes.slice(0, size)), a);
    expect(p.candidate.boundary).toBeNull(); expect(f.native).toHaveLength(1);
    const work = p.receiver.onObject(object(bytes.slice(size), 1n), b); void work.catch(() => {}); await p.candidate.ready;
    exact(p.candidate.boundary!.sourcePtsUs, 73729n * 1000000n, 12288n);
    p.candidate.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(p.candidate.boundary).toBeNull(); expect(f.onDiscard).toHaveBeenCalledTimes(2);
    expect(f.onDiscard).toHaveBeenCalledWith(a, 'epoch refused'); expect(f.onDiscard).toHaveBeenCalledWith(b, 'epoch refused');
    expect(f.native).toHaveLength(1); expect(f.onError).not.toHaveBeenCalled();
  });

  it('retains boundary as historical observation but refuses commit after candidate admission is revoked', async () => {
    const f = await fixture(); let admitted = true;
    const p = f.prepare({ ...f.base, readiness: 'indexed-boundary', isCurrent: () => admitted }); p.accept();
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    const work = p.receiver.onObject(object(f.payloads(73729n)[0]!)); void work.catch(() => {}); await p.candidate.ready;
    expect(decode).toHaveBeenCalledOnce(); const observation = p.candidate.boundary!, owner = f.actor.roleOwner('video');
    const hold = f.actor.holdRole('video', owner!); await hold.nativeSettled;
    admitted = false; expect(p.candidate.boundary).toBe(observation);
    expect(() => hold.commit(p.candidate)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    await expect(work).rejects.toMatchObject({ name: 'AbortError' }); expect(p.candidate.boundary).toBeNull();
    expect(f.actor.roleOwner('video')).toBe(owner); expect(hold.current).toBe(true); hold.resume();
    expect(f.native).toHaveLength(1); expect(f.onError).not.toHaveBeenCalled(); expect(f.onPageError).not.toHaveBeenCalled();
    const next = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); next.candidate.cancel();
  });
});

it('records the exact emitted end after one floor-tick placement and a finite native double offset', async () => {
  const f = await fixture(12288, 0.1, 'cmaf');
  f.base.placement.rebasedTimeUs = { numerator: 11999999n, denominator: 2n };
  const p = f.prepare({ ...f.base, readiness: 'indexed-boundary' }); p.accept();
  const work = p.receiver.onObject(object(f.payloads(73729n)[0]!)); void work.catch(() => {});
  await p.candidate.ready;
  const hold = f.actor.holdRole('video', f.actor.roleOwner('video')!); await hold.nativeSettled;
  hold.commit(p.candidate); await work;
  const frontier = f.actor.submissionFrontier('video', f.actor.roleOwner('video')!)!;
  // floor(-0.5us *12288/1e6)=-1 tick. Exact IEEE754 0.1 is retained.
  const offsetNumerator = 3602879701896397n * 1000000n, offsetDenominator = 36028797018963968n;
  exact(frontier.nativeOffsetUs, offsetNumerator, offsetDenominator);
  exact(frontier.maxSubmittedEndUs!, 8000000n * offsetDenominator + offsetNumerator, offsetDenominator);
  expect(frontier.highestSubmittedGroup).toBe(4n);
  expect(Object.isFrozen(frontier.placement)).toBe(true); expect(Object.isFrozen(frontier.placement.rebasedTimeUs)).toBe(true);
  expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
  expect(f.onError).not.toHaveBeenCalled();
});

it.each([0.1, -0.125])('uses exact fractional source intervals, floor ticks and native offset once for a closed group: %s', async offset => {
  const f = await fixture(12288, offset); f.base.placement.rebasedTimeUs = { numerator: 11999999n, denominator: 2n };
  const p = f.prepare({ ...f.base, readiness: 'indexed-group' }), payloads = f.payloads(73729n);
  p.candidate.acceptPage(p.page, true, { start: { groupId: 4n, objectId: 0n }, through: { kind: 'before', groupId: 4n, objectId: 2n },
    endOfTrack: true, groupOrder: 'ascending', rangeFilters: false });
  await p.receiver.onObject(object(payloads[0]!)); await p.receiver.onObject(object(payloads[1]!, 1n)); p.receiver.onClosed('fin'); await p.candidate.ready;
  const proof = p.candidate.groupProof!; expect(proof.coverage).toHaveLength(1);
  exact(proof.sourcePtsUs, 73729n * 1000000n, 12288n);
  const n = offset === 0.1 ? 3602879701896397n * 1000000n : -125000n;
  const d = offset === 0.1 ? 1n << 55n : 1n;
  exact(proof.coverage[0]!.startUs, 6000000n * d + n, d); exact(proof.coverage[0]!.endUs, 10000000n * d + n, d);
  expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.source.namespace)).toBe(true);
  expect(Object.isFrozen(proof.placement)).toBe(true); expect(Object.isFrozen(proof.nativeOffsetUs)).toBe(true);
  expect(Object.isFrozen(proof.coverage)).toBe(true); expect(Object.isFrozen(proof.coverage[0])).toBe(true);
  const cut = f.actor.holdRole('video', f.actor.roleOwner('video')!, { beforeGroup: 4n }), id = {}, old = f.actor.beginPage('video', id);
  f.actor.acceptPage('video', id, false); const pending = old.onObject(object(payloads[0]!)); void pending.catch(() => {});
  await cut.reached; await cut.nativeSettled; cut.commit(p.candidate); await settle();
  expect(f.native).toHaveLength(3); expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.onError).not.toHaveBeenCalled();
});
