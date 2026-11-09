import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection, type FetchReceiveContext } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import type { CmafAssemblerLike, MediaAppendObserver, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import { MseSeekPlayback } from './mse-seek-playback.js';

/** Real protocol/format consumers with controlled native append/position witnesses; no browser-decode claim. */
async function fixture(draft: 18 | 22) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [], generic = vi.fn(), inputs: FetchReceiveContext[] = [];
  client.onError = server.onError = error => { errors.push(error.message); };
  client.onObject = generic;
  await Promise.all([client.connect(a), server.connect(b)]);
  const requests: Array<{ id: bigint; namespace: string[]; name: string }> = [];
  server.onFetch = (id, request) => {
    if (request.fetch.fetchType !== 0x1) throw new Error('Expected standalone historical FETCH');
    requests.push({ id, namespace: request.fetch.trackNamespace.map(field => new TextDecoder().decode(field)),
      name: new TextDecoder().decode(request.fetch.trackName) });
  };
  const epoch = {}, resourceId = {}, init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
  let current = true, nativeCurrent = true, observer: MediaAppendObserver | null = null;
  let positionResolve!: (sample: MediaSeekSample) => void;
  const positioned = new Promise<MediaSeekSample>(resolve => { positionResolve = resolve; });
  const tokens: object[] = [], appended = vi.fn();
  const resource: MediaSeekResource = { epoch, resource: resourceId, get current() { return nativeCurrent; },
    initialize: vi.fn(() => true), whenAttached: async () => {},
    observeAppends(fn) { observer = fn; return () => { observer = null; }; },
    appendChunk(role, bytes, name, group, token, key) { tokens.push(token!); appended(role, bytes, name, group, key); },
    getTimestampOffset: () => 0, setTimestampOffset: vi.fn(), position: vi.fn(() => positioned), sample: () => null,
    setPlaybackIntent: vi.fn(), cancel: vi.fn(() => { nativeCurrent = false; }) };
  const source: MediaSourceLike = { mediaElement: {}, onFirstFrame: null, onError: null, onStall: null,
    initialize: vi.fn(), appendChunk: vi.fn(), beginSeek: () => resource, endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
  const live = new CmafAssembler({ onSegment: vi.fn() }), adopted = vi.fn(), drained = vi.fn(), pageFailed = vi.fn(), failed = vi.fn();
  const page = {}, cancels: Array<() => void> = [];
  const pending: Promise<bigint>[] = [];
  let requestsRetired = false;
  const cancelRequests = () => { if (requestsRetired) return; requestsRetired = true; for (const cancel of cancels) cancel(); };
  const ownership: { current: { resource: MediaSeekResource; assembler: CmafAssemblerLike } | null } = { current: null };
  const playback = new MseSeekPlayback({ epoch, source, liveAssembler: live, createAssembler: callbacks => new CmafAssembler(callbacks),
    tracks: [{ role: 'video', name: 'v', namespace: ['one/slash', 'field'], sourceKey: 'video', codec: 'avc1.640028', init, packaging: 'cmaf' }],
    location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, timestampRounding: 'floor', targetMs: 5000,
    maxObjects: 500, maxBytes: 8 * 1024 * 1024, preparationTimeoutMs: 1000, playing: false, isCurrent: () => current,
    beforeResourceChange: vi.fn(), adopt: value => { ownership.current = value; }, onSegment: vi.fn(), onPosition: adopted,
    onPageDrained: drained,
    onPageError: (role, identity, error) => { pageFailed(role, identity, error); failed(error); cancelRequests(); },
    onError: error => { failed(error); cancelRequests(); } });
  const cancelAttempt = () => { playback.cancel(); cancelRequests(); };
  try {
    let requestId: bigint | null = null;
    client.onMessage = message => {
      if (message.type === 'FETCH_OK' && message.requestId === requestId) playback.acceptPage('video', page, message.endOfTrack === 1);
    };
    playback.start();
    const receiver = playback.beginPage('video', page), track = { namespace: ['one/slash', 'field'], name: 'v' };
    let cancelled = false;
    const request = client.fetch(track.namespace.map(field => new TextEncoder().encode(field)), new TextEncoder().encode(track.name), {
      startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 2n,
      onRequestId: value => { requestId = value; if (cancelled) void client.fetchCancel(value).catch(error => errors.push(String(error))); },
      receiver: { onObject: (object, context) => { inputs.push(context); return receiver.onObject(object); },
        onClosed: terminal => receiver.onClosed(terminal) },
    });
    const cancel = () => { if (cancelled) return; cancelled = true;
      if (requestId !== null) void client.fetchCancel(requestId).catch(error => errors.push(String(error))); };
    cancels.push(cancel); if (requestsRetired) cancel();
    pending.push(request); void request.catch(error => errors.push(String(error)));
    await Promise.all(pending); await flush(150);
    expect(requests).toHaveLength(1); const id = requests[0]!.id;
    await server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 1n : 2n } });
    const stream = await server.openFetchStream(id);
    const send = (object: bigint, raw: bigint) => server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: object,
      publisherPriority: 128, payload: buildChunk({ trackId: 1, bmdt: raw, samples: [{ duration: 2000, size: 4, flags: SYNC_FLAGS }],
        mdat: Uint8Array.of(1, 2, 3, 4) }) });
    return { playback, client, server, errors, generic, inputs, requests, id, resource, tokens, appended, adopted, drained, pageFailed, failed, page, cancelAttempt, send,
      terminal(index: number) { observer?.({ token: tokens[index]!, state: 'appended', reason: null }); },
      land() { positionResolve({ epoch, resource: resourceId, currentTime: 5.1, buffered: { start: 4, end: 8 } }); },
      finish: () => server.closeFetchStream(stream),
      async destroy() { current = false; cancelAttempt(); ownership.current?.resource.cancel(); ownership.current?.assembler.destroy(); live.destroy(); await client.close(); await server.close(); } };
  } catch (error) {
    current = false; cancelAttempt(); ownership.current?.resource.cancel(); ownership.current?.assembler.destroy(); live.destroy(); await client.close(); await server.close(); throw error;
  }
}

describe.each([18, 22] as const)('historical MSE receiver composition draft %s', draft => {
  it('addresses the exact identity and holds decoding/FIN behind actual native append credit', async () => {
    const f = await fixture(draft);
    try {
      expect(f.requests[0]).toMatchObject({ namespace: ['one/slash', 'field'], name: 'v' });
      await f.send(0n, 4000n); await f.send(1n, 6000n); await f.finish(); await flush(150);
      expect(f.appended).toHaveBeenCalledOnce(); expect(f.inputs).toHaveLength(1); expect(f.drained).not.toHaveBeenCalled();
      expect(f.resource.position).not.toHaveBeenCalled(); expect(f.generic).not.toHaveBeenCalled();
      f.terminal(0); await flush(150);
      expect(f.inputs).toHaveLength(2); expect(f.appended).toHaveBeenCalledTimes(2);
      expect(f.resource.position).toHaveBeenCalledExactlyOnceWith(5); expect(f.drained).not.toHaveBeenCalled();
      f.terminal(1); await flush(150);
      expect(f.drained).toHaveBeenCalledExactlyOnceWith('video', f.page); expect(f.adopted).not.toHaveBeenCalled();
      expect(f.inputs.every(input => input.requestId === f.id && input.streamId !== null && !input.signal.aborted)).toBe(true);
      f.land(); await flush(150); expect(f.adopted).toHaveBeenCalledOnce();
      expect(f.failed).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('cancels a receiver blocked on native work and cannot apply its late terminal to a successor', async () => {
    const f = await fixture(draft);
    try {
      await f.send(0n, 4000n); await flush(150);
      expect(f.inputs).toHaveLength(1); expect(f.appended).toHaveBeenCalledOnce();
      f.cancelAttempt(); await flush(150);
      expect(f.inputs[0]!.signal.aborted).toBe(true);
      f.terminal(0); f.land(); await flush(150);
      expect(f.adopted).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
      expect(f.resource.setPlaybackIntent).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
