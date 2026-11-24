import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture } from '../test-support/seek-role-retrieval.js';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { fixture as mseFixture, landHistory, locations } from '../test-support/seek-live-mse.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const role of ['video', 'audio'] as const) {
  it(`${role} page cancels an unanswered FETCH at its response deadline`, async () => {
    vi.useFakeTimers();
    const f = await fixture(22);
    try {
      const output = f.role(role); await flush(256);
      await vi.advanceTimersByTimeAsync(999);
      expect(output.failures).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await flush(256);
      expect(output.failures).toHaveBeenCalledOnce();
      expect(output.failures.mock.calls[0]![0].message).toMatch(/FETCH response timed out/);
      expect(output.failures.mock.calls[0]![1]).toBe('page');
      expect(f.cancelled).toHaveBeenCalledExactlyOnceWith(f.requests[0]!.id);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.destroy(); }
  });
}

it.each(['accepted', 'cancelled', 'error'] as const)(
  'clears the response deadline when the page is %s', async outcome => {
    vi.useFakeTimers();
    const f = await fixture(22);
    try {
      const output = f.role('video'); await flush(256);
      await vi.advanceTimersByTimeAsync(999);
      if (outcome === 'accepted') await f.accept(0);
      else if (outcome === 'cancelled') output.owner.cancel();
      else await f.server.rejectFetch(f.requests[0]!.id, 3n, 'refused');
      await flush(256);
      expect(vi.getTimerCount()).toBe(0);
      const failures = output.failures.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000); await flush(256);
      expect(output.failures).toHaveBeenCalledTimes(failures);
      expect(failures).toBe(outcome === 'error' ? 1 : 0);
      if (outcome === 'accepted') expect(f.cancelled).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  },
);

for (const draft of [18, 22] as const) {
  it.each([false, true])(`draft ${draft} keeps waiting after data FIN until response or silence (response=%s)`, async respond => {
    vi.useFakeTimers();
    const f = await fixture(draft);
    try {
      const output = f.role('video'); await flush(256);
      const id = f.requests[0]!.id, stream = await f.server.openFetchStream(id);
      await f.send(stream, 0n, 7);
      await f.server.closeFetchStream(stream); await flush(256);
      await vi.advanceTimersByTimeAsync(999);
      expect(output.failures).not.toHaveBeenCalled(); expect(output.ended).not.toHaveBeenCalled();
      if (respond) {
        await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 0n : 1n } });
        await flush(256);
        expect(output.accepted).toHaveBeenCalledOnce(); expect(output.ended).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(1); await flush(256);
      expect(output.failures).toHaveBeenCalledTimes(respond ? 0 : 1);
      expect(f.cancelled).toHaveBeenCalledTimes(respond ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.destroy(); }
  });

  it.each([false, true])(`draft ${draft} restarts the response wait on Objects (response=%s)`, async respond => {
    vi.useFakeTimers();
    const f = await fixture(draft);
    try {
      const output = f.role('video'); await flush(256);
      const id = f.requests[0]!.id, stream = await f.server.openFetchStream(id);
      await vi.advanceTimersByTimeAsync(600); await f.send(stream, 0n, 7);
      await vi.advanceTimersByTimeAsync(600);
      expect(output.failures).not.toHaveBeenCalled();
      await f.send(stream, 1n, 8);
      await vi.advanceTimersByTimeAsync(999);
      expect(output.received).toEqual([7, 8]); expect(output.failures).not.toHaveBeenCalled();
      if (respond) {
        await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 1n : 2n } });
        await f.server.closeFetchStream(stream); await flush(256);
        expect(output.ended).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(1); await flush(256);
      expect(output.failures).toHaveBeenCalledTimes(respond ? 0 : 1);
      expect(f.cancelled).toHaveBeenCalledTimes(respond ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await f.destroy(); }
  });
}

it('control: reports an unanswered first LOC seek page as degraded and preserves live playback', async () => {
  vi.useFakeTimers();
  const f = await locSeekFixture(22, false, true, { isLive: true, producingOutput: true, connectionTimeoutMs: 100 });
  const errors = vi.fn(), cancel = vi.spyOn(f.client, 'fetchCancel');
  f.player.on('error', errors);
  try {
    const live = f.client.session.getSubscription(f.requests.find(request => request.name === 'video')!.id);
    await f.player.seek(2000); await flush(256);
    await vi.advanceTimersByTimeAsync(99); expect(errors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await flush(256);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]![0].error).toMatchObject({ severity: 'degraded', source: 'player' });
    expect(cancel).toHaveBeenCalledWith(f.fetchIds[0]);
    expect(f.client.session.getSubscription(live!.requestId)).toBe(live);
    expect(f.decoder.reset).not.toHaveBeenCalled(); expect(f.outputs.every(output => output.draw.mock.calls.length === 0)).toBe(true);
    expect(f.player.state).toBe('playing');
  } finally { await f.destroy(); }
});

it('reports an unanswered later MSE seek page through the committed failure path', async () => {
  vi.useFakeTimers();
  const f = await mseFixture(22, true, locations, { connectionTimeoutMs: 100, startPaused: false });
  const errors = vi.fn(), cancel = vi.spyOn(f.client, 'fetchCancel');
  f.player.on('error', errors);
  try {
    await landHistory(f);
    // Extend the index past the live-probe frontier so continuation opens a page.
    await f.updateIndex([...locations, [12000, [4, 0], 0]]);
    await flush(512);
    expect(f.fetches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(99); expect(errors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await flush(512);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]![0].error).toMatchObject({ severity: 'degraded', source: 'player' });
    expect(cancel).toHaveBeenCalledWith(f.fetches[1]!.id);
    expect(f.resources[0]!.current).toBe(true);
    expect(f.player.state).toBe('playing');
  } finally { await f.destroy(); }
});

it.each(['silent', 'finished', 'receiving'] as const)('bounds silence in a %s LOC page after output commitment', async outcome => {
  vi.useFakeTimers();
  const f = await locSeekFixture(22, false, true, { isLive: true, producingOutput: true, connectionTimeoutMs: 100,
    timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0], [5000, [5, 0], 0]] });
  const errors = vi.fn(), cancel = vi.spyOn(f.client, 'fetchCancel');
  f.player.on('error', errors);
  try {
    await f.player.seek(2000); await flush(256);
    await f.server.acceptFetch(f.fetchIds[0]!, { endOfTrack: 0, endLocation: { group: 4n, object: 0n } });
    const stream = await f.server.openFetchStream(f.fetchIds[0]!);
    for (const [index, timestamp] of [1000n, 2100n, 3000n].entries()) {
      await f.server.sendFetchObject(stream, { groupId: index === 2 ? 4n : 3n, subgroupId: 0n, objectId: index === 2 ? 0n : BigInt(index), publisherPriority: 128,
        extensions: encodeLocHeaders({ timestamp, timescale: 1000n,
          videoFrameMarking: { independent: index !== 1, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(22), locVersion: 4 }),
        payload: Uint8Array.of(0, 0, 0, 2, index !== 1 ? 0x65 : 0x41, 0x88) });
    }
    await f.server.closeFetchStream(stream); await flush(512);
    expect(f.seeked).toHaveBeenCalledOnce(); expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
    expect(f.fetchIds).toHaveLength(2);
    const id = f.fetchIds[1]!;
    if (outcome !== 'silent') {
      const next = await f.server.openFetchStream(id);
      if (outcome === 'finished') {
        await f.server.closeFetchStream(next); await flush(256);
      } else {
        for (const objectId of [1n, 2n]) {
          await vi.advanceTimersByTimeAsync(60);
          expect(errors).not.toHaveBeenCalled();
          await f.server.sendFetchObject(next, { groupId: 4n, subgroupId: 0n, objectId, publisherPriority: 128,
            extensions: encodeLocHeaders({ timestamp: 3000n + objectId * 100n, timescale: 1000n,
              videoFrameMarking: { independent: false, startOfFrame: true, endOfFrame: true,
                discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(22), locVersion: 4 }),
            payload: Uint8Array.of(0, 0, 0, 2, 0x41, 0x88) });
          await flush(256);
        }
        await vi.advanceTimersByTimeAsync(60);
        expect(errors).not.toHaveBeenCalled();
        await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 4n, object: 2n } });
        await f.server.closeFetchStream(next); await flush(512);
        await vi.advanceTimersByTimeAsync(101);
        expect(errors).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalledWith(id);
        expect(f.client.session.getFetch(id)).toBeUndefined();
        expect(f.player.state).toBe('playing');
        return;
      }
    }
    await vi.advanceTimersByTimeAsync(99); expect(errors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await flush(512);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0]![0].error).toMatchObject({ severity: 'fatal', source: 'player' });
    expect(cancel).toHaveBeenCalledWith(f.fetchIds[1]); expect(f.player.state).toBe('error');
  } finally { await f.destroy(); }
});
