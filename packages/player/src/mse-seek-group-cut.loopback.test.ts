import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection, type FetchReceiveContext } from '@openmoq/webtransport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import type { MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import { MseSeekPlayback } from './mse-seek-playback.js';
import { seekChunkCoverage } from './seek-cmaf-input.js';

/** Real ordered SDK/format path; native terminals and clock are controlled, not browser pictures. */
async function fixture(draft: 18 | 22, far = false, policy: { maxObjects?: number; maxBytes?: number; extraPreCut?: boolean } = {}) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [], generic = vi.fn(), requests: bigint[] = [];
  client.onError = server.onError = error => { errors.push(error.message); }; client.onObject = generic;
  await Promise.all([client.connect(a), server.connect(b)]);
  server.onFetch = id => { requests.push(id); };
  const epoch = {}, nativeId = {}, init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
  const context = parseLocmafTrackContext(init), encoder = new LocmafEncoder(), group3 = new LocmafGroupState(), group4 = new LocmafGroupState();
  const duration = far ? 4000 : 2000;
  function encode(state: LocmafGroupState, id: bigint, pts: bigint, length: number, flags: number) {
    const bytes = buildChunk({ trackId: 1, bmdt: pts, samples: [{ duration: length, size: 4, flags }], mdat: Uint8Array.of(1, 2, 3, Number(id)) });
    return serializeLocmafObject(encoder.encode(bytes, state, context, false, id));
  }
  const payloads = [encode(group3, 0n, 4000n, duration, SYNC_FLAGS),
    encode(group3, 1n, 4000n + BigInt(duration), duration, NON_SYNC_FLAGS)];
  if (policy.extraPreCut) payloads.push(encode(group3, 2n, 4000n + BigInt(duration * 2), duration, NON_SYNC_FLAGS));
  payloads.push(encode(group4, 0n, 4000n + BigInt(duration * payloads.length), 2000, SYNC_FLAGS));
  expect(new LocmafTrackDecoder(init).push(3n, 1n, payloads[1]!).kind).toBe('rejected');
  let current = true, nativeCurrent = true, head = 5.125, bufferedEnd = 4, sample: MediaSeekSample | null = null;
  let observer: MediaAppendObserver | null = null, land!: (value: MediaSeekSample) => void;
  const positioned = new Promise<MediaSeekSample>(resolve => { land = resolve; });
  const appended: Array<{ bytes: Uint8Array; group: bigint; token: object }> = [], completed = new Set<number>();
  const resource: MediaSeekResource = { epoch, resource: nativeId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: async () => {},
    observeAppends(fn) { observer = fn; return () => { observer = null; }; },
    appendChunk(_role, bytes, _name, group, token) { appended.push({ bytes: bytes.slice(), group: group!, token: token! }); },
    getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), position: vi.fn(() => positioned),
    sample: () => sample && { ...sample, currentTime: head, buffered: { start: 4, end: bufferedEnd } },
    setPlaybackIntent: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }) };
  const source: MediaSourceLike = { mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    initialize: vi.fn(), appendChunk: vi.fn(), beginSeek: () => resource, endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
  const live = new CmafAssembler({ onSegment: vi.fn() }), adopted = vi.fn(), drained = vi.fn(), failed = vi.fn(), closed = vi.fn();
  let assembler: CmafAssembler | null = null, requestId: bigint | null = null;
  const received: Array<{ group: bigint; object: bigint; context: FetchReceiveContext }> = [], page = {};
  const playback = new MseSeekPlayback({ epoch, source, liveAssembler: live,
    createAssembler: callbacks => { assembler = new CmafAssembler(callbacks); return assembler; },
    tracks: [{ role: 'video', name: 'v', namespace: ['one/slash', 'field'], sourceKey: 'video', codec: 'avc1.640028', init, packaging: 'locmaf' }],
    location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, timestampRounding: 'floor', targetMs: 5000,
    maxObjects: policy.maxObjects ?? 10, maxBytes: policy.maxBytes ?? 8192, preparationTimeoutMs: 1000, playing: false, isCurrent: () => current,
    beforeResourceChange: vi.fn(), adopt: vi.fn(), onSegment: vi.fn(), onPosition: adopted,
    onPageDrained: drained, onPageError: failed, onError: failed });
  async function destroy() {
    current = false; playback.cancel();
    if (requestId !== null) await client.fetchCancel(requestId).catch(() => {});
    resource.cancel(); assembler?.destroy(); live.destroy(); await client.close(); await server.close();
  }
  function complete(index: number) {
    expect(completed.has(index)).toBe(false); completed.add(index);
    const item = appended[index]!; bufferedEnd = Math.max(bufferedEnd, seekChunkCoverage(item.bytes, context).endTimeSeconds);
    observer?.({ token: item.token, state: 'appended', reason: null });
  }
  try {
    playback.start(); const receiver = playback.beginPage('video', page);
    client.onMessage = message => {
      if (message.type === 'FETCH_OK' && message.requestId === requestId) playback.acceptPage('video', page, message.endOfTrack === 1);
    };
    await client.fetch([new TextEncoder().encode('one/slash'), new TextEncoder().encode('field')], new TextEncoder().encode('v'), {
      startGroup: 3n, startObject: 0n, endGroup: 4n, endObject: 1n, groupOrder: 'ascending', onRequestId: id => { requestId = id; },
      receiver: { onObject: (object, receipt) => { received.push({ group: BigInt(object.groupId), object: BigInt(object.objectId), context: receipt }); return receiver.onObject(object); },
        onClosed: terminal => { closed(terminal); receiver.onClosed(terminal); } },
    });
    await flush(150); expect(requests).toEqual([requestId]);
    await server.acceptFetch(requestId!, { endOfTrack: 0, endLocation: { group: 4n, object: draft === 22 ? 0n : 1n } });
    const stream = await server.openFetchStream(requestId!);
    const send = (index: number) => server.sendFetchObject(stream, { groupId: index === payloads.length - 1 ? 4n : 3n, subgroupId: 0n,
      objectId: index === payloads.length - 1 ? 0n : BigInt(index), publisherPriority: 128, payload: payloads[index]! });
    await send(0); await flush(150); expect(appended).toHaveLength(1); complete(0); await flush(150);
    sample = { epoch, resource: nativeId, currentTime: head, buffered: { start: 4, end: bufferedEnd } }; land(sample);
    await flush(150); expect(adopted).toHaveBeenCalledOnce();
    return { client, playback, errors, generic, received, appended, closed, drained, failed, resource, adopted, send, complete,
      finish: () => server.closeFetchStream(stream), destroy, setHead(value: number) { head = value; playback.tick(); } };
  } catch (error) { await destroy(); throw error; }
}

describe.each([18, 22] as const)('serial before-group cut through real FETCH draft %s', draft => {
  it('reaches a near cut only after prior native completion and holds G before parsing without request FIN', async () => {
    const f = await fixture(draft), decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    try {
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n });
      const reached = vi.fn(); void cut.reached.then(reached, () => {});
      await f.send(1); await f.send(2); await f.finish(); await flush(150);
      expect(f.received).toHaveLength(2); expect(f.appended).toHaveLength(2);
      expect(reached).not.toHaveBeenCalled(); expect(cut.frontier).toBeNull(); expect(f.closed).not.toHaveBeenCalled();
      f.complete(1); await cut.reached; await cut.nativeSettled;
      expect(f.received).toHaveLength(3); expect(f.appended).toHaveLength(2);
      expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(0);
      expect(f.closed).not.toHaveBeenCalled(); expect(f.drained).not.toHaveBeenCalled();
      expect(cut.frontier?.highestSubmittedGroup).toBe(3n);
      cut.resume(); await flush(150); expect(f.appended).toHaveLength(3);
      f.complete(2); await flush(150);
      expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(1);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith('fin'); expect(f.drained).toHaveBeenCalledOnce();
      expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.resource.initialize).toHaveBeenCalledOnce();
      expect(f.failed).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { decode.mockRestore(); await f.destroy(); }
  });

  it('cannot reach a far cut while the actual reader awaits ordinary lookahead credit', async () => {
    const f = await fixture(draft, true);
    try {
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n });
      const reached = vi.fn(), settled = vi.fn(); void cut.reached.then(reached, () => {}); void cut.nativeSettled.then(settled, () => {});
      await f.send(1); await f.send(2); await f.finish(); await flush(150); f.complete(1); await flush(150);
      f.playback.tick(); await flush(150);
      expect(f.received).toHaveLength(2); expect(f.appended).toHaveLength(2);
      expect(reached).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
      expect(cut.frontier).toBeNull(); expect(f.closed).not.toHaveBeenCalled();
      f.setHead(8); await cut.reached; await cut.nativeSettled;
      expect(f.received).toHaveLength(3); expect(f.appended).toHaveLength(2); expect(f.closed).not.toHaveBeenCalled();
      expect(cut.frontier!.maxSubmittedEndUs!.numerator).toBe(12000000n * cut.frontier!.maxSubmittedEndUs!.denominator);
      expect(f.adopted).toHaveBeenCalledOnce(); expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      cut.resume(); await flush(150); f.complete(2); f.setHead(10); await flush(150);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith('fin');
    } finally { await f.destroy(); }
  });

  it('canceling an unreached far cut leaves original SDK credit and LOCMAF continuation intact', async () => {
    const f = await fixture(draft, true);
    try {
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n });
      await f.send(1); await f.send(2); await f.finish(); await flush(150); f.complete(1); await flush(150);
      const waits = [expect(cut.reached).rejects.toMatchObject({ name: 'AbortError' }), expect(cut.nativeSettled).rejects.toMatchObject({ name: 'AbortError' })];
      cut.resume(); await Promise.all(waits); await flush(150);
      expect(f.received).toHaveLength(2); expect(f.closed).not.toHaveBeenCalled();
      expect(f.received.every(item => !item.context.signal.aborted)).toBe(true);
      f.setHead(8); await flush(150); expect(f.received).toHaveLength(3); expect(f.appended).toHaveLength(3);
      f.complete(2); f.setHead(10); await flush(150);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith('fin'); expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });


  it('opt-in bounded preparation reaches a far cut after native success without advancing the paused head', async () => {
    const f = await fixture(draft, true), decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    try {
      // A typed proposed option: phase1 structurally accepts but ignores this
      // extra field. This red requires actual reader progress, not API presence.
      const options: { readonly beforeGroup: bigint; readonly readCredit: 'bounded-preparation' } = {
        beforeGroup: 4n, readCredit: 'bounded-preparation',
      };
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, options);
      const reached = vi.fn(), settled = vi.fn();
      void cut.reached.then(reached, () => {}); void cut.nativeSettled.then(settled, () => {});
      await f.send(1); await f.send(2); await f.finish(); await flush(150);
      expect(f.resource.sample()?.currentTime).toBe(5.125);
      expect(f.received).toHaveLength(2); expect(f.appended).toHaveLength(2);
      expect(reached).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
      expect(f.closed).not.toHaveBeenCalled(); expect(cut.frontier).toBeNull();
      f.complete(1); await flush(150); f.playback.tick(); await flush(150);
      expect(f.resource.sample()?.buffered.end).toBe(12);
      expect(f.resource.sample()?.currentTime).toBe(5.125);
      expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      expect({ receivedObjects: f.received.length, reached: reached.mock.calls.length, nativeSettled: settled.mock.calls.length,
        head: f.resource.sample()?.currentTime, completedNativeEnd: f.resource.sample()?.buffered.end },
        'opt-in must let the real SDK read G after native success at the unchanged head').toEqual({
        receivedObjects: 3, reached: 1, nativeSettled: 1, head: 5.125, completedNativeEnd: 12,
      });
      expect(reached).toHaveBeenCalledExactlyOnceWith({ groupId: 4n, objectId: 0n });
      expect(settled).toHaveBeenCalledOnce();
      expect(f.appended).toHaveLength(2); expect(f.closed).not.toHaveBeenCalled(); expect(f.drained).not.toHaveBeenCalled();
      expect(decode.mock.calls.filter(([group]) => group === 4n)).toHaveLength(0);
      expect(cut.frontier!.maxSubmittedEndUs!.numerator).toBe(12000000n * cut.frontier!.maxSubmittedEndUs!.denominator);
      expect(f.generic).not.toHaveBeenCalled(); expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce();
      cut.resume(); await flush(150); expect(f.appended).toHaveLength(3);
      f.complete(2); await flush(150);
      // Consuming the cut restores ordinary credit for G at this same head.
      expect(f.resource.sample()?.currentTime).toBe(5.125); expect(f.closed).not.toHaveBeenCalled();
    } finally { decode.mockRestore(); await f.destroy(); }
  });


  it('enrolls existing completed native work while the real reader is already parked on credit', async () => {
    const f = await fixture(draft, true);
    try {
      await f.send(1); await f.send(2); await f.finish(); await flush(150); f.complete(1); await flush(150);
      expect(f.received).toHaveLength(2); expect(f.resource.sample()?.currentTime).toBe(5.125);
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n, readCredit: 'bounded-preparation' });
      await cut.reached; await cut.nativeSettled;
      expect(f.received).toHaveLength(3); expect(f.appended).toHaveLength(2); expect(f.closed).not.toHaveBeenCalled();
      expect(f.resource.sample()?.currentTime).toBe(5.125); expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      cut.resume(); await flush(150); f.complete(2); f.setHead(10); await flush(150);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith('fin');
    } finally { await f.destroy(); }
  });

  it.each(['raw', 'media'] as const)('a %s budget refusal preserves the actual FETCH and its accepted LOCMAF reference', async kind => {
    const bytes = buildChunk({ trackId: 1, bmdt: 0n, samples: [{ duration: 4000, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) }).length;
    const f = await fixture(draft, true, { extraPreCut: true, maxObjects: kind === 'raw' ? 1 : 10, maxBytes: kind === 'media' ? bytes : 8192 });
    const decode = vi.spyOn(LocmafTrackDecoder.prototype, 'push');
    try {
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n, readCredit: 'bounded-preparation' });
      const refused = expect(cut.reached).rejects.toThrow(kind === 'raw' ? /raw input budget/ : /reconstructed media budget/);
      void cut.nativeSettled.catch(() => {});
      await f.send(1); await f.send(2); await f.send(3); await f.finish(); await flush(150);
      f.complete(1); await flush(150); await refused;
      expect(cut.current).toBe(false); expect(f.received).toHaveLength(3); expect(f.appended).toHaveLength(3);
      expect(decode.mock.calls.filter(([group, id]) => group === 3n && id === 2n)).toHaveLength(1);
      expect(f.received.every(item => !item.context.signal.aborted)).toBe(true);
      expect(f.failed).not.toHaveBeenCalled(); expect(f.closed).not.toHaveBeenCalled();
      f.complete(2); await flush(150); expect(f.received).toHaveLength(3);
      f.setHead(12); await flush(150); expect(f.received).toHaveLength(4); expect(f.appended).toHaveLength(4);
      f.complete(3); f.setHead(14); await flush(150);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith('fin'); expect(f.drained).toHaveBeenCalledOnce();
      expect(f.resource.initialize).toHaveBeenCalledOnce(); expect(f.resource.position).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { decode.mockRestore(); await f.destroy(); }
  });


  it('revoking bounded credit before native completion preserves the request and its ordinary wait', async () => {
    const f = await fixture(draft, true);
    try {
      const cut = f.playback.holdRole('video', f.playback.roleOwner('video')!, { beforeGroup: 4n, readCredit: 'bounded-preparation' });
      await f.send(1); await f.send(2); await f.finish(); await flush(150);
      expect(f.received).toHaveLength(2); expect(f.appended).toHaveLength(2);
      const waits = [expect(cut.reached).rejects.toMatchObject({ name: 'AbortError' }), expect(cut.nativeSettled).rejects.toMatchObject({ name: 'AbortError' })];
      cut.resume(); await Promise.all(waits); f.complete(1); await flush(150);
      expect(f.received).toHaveLength(2); expect(f.closed).not.toHaveBeenCalled();
      expect(f.resource.sample()?.currentTime).toBe(5.125);
      expect(f.received.every(item => !item.context.signal.aborted)).toBe(true);
      f.setHead(8); await flush(150); expect(f.received).toHaveLength(3); expect(f.appended).toHaveLength(3);
      f.complete(2); f.setHead(10); await flush(150);
      expect(f.closed).toHaveBeenCalledExactlyOnceWith('fin'); expect(f.drained).toHaveBeenCalledOnce();
      expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
