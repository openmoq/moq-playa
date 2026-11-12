import { locSeekFixture as fixture } from '../test-support/loc-seek.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import type { MediaStageObservation } from './media-diagnostic-types.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { PlaybackPipeline, SyncController } from '@openmoq/playback';
import { WebAudioOutput } from '../../browser/src/webaudio-output.js';
import type { AudioDecoderLike } from './interfaces.js';
import { MessageParam, decodeSubscriptionFilter, decodeFillParameters, varint } from '@openmoq/transport';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());

async function sendPreparedGroup(f: Awaited<ReturnType<typeof fixture>>, requestIndex: number, targetPoint: bigint, futurePoint?: bigint) {
  const id = f.fetchIds[requestIndex]!;
  const points = futurePoint === undefined ? [1000n, targetPoint] : [1000n, targetPoint, futurePoint];
  await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: BigInt(points.length - (f.draft === 22 ? 1 : 0)) } });
  const stream = await f.server.openFetchStream(id);
  for (const [index, timestamp] of points.entries()) {
    const extensions = encodeLocHeaders({ timestamp, timescale: 1000n,
      videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(f.draft), locVersion: 4 });
    await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128,
      extensions, payload: Uint8Array.of(0, 0, 0, 2, index === 0 ? 0x65 : 0x41, 0x88) });
  }
  await f.server.closeFetchStream(stream); await flush(512);
}


async function sendPreparedAvGroup(f: Awaited<ReturnType<typeof fixture>>, index: number, epoch: bigint) {
  const id = f.fetchIds[index]!, name = f.fetches[index]!.name;
  await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: f.draft === 22 ? 2n : 3n } });
  const stream = await f.server.openFetchStream(id);
  for (const [i, offset] of [0n, 1_100_000n, 1_300_000n].entries()) {
    await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
      extensions: encodeLocHeaders({ captureTimestamp: epoch + offset,
        ...(name === 'video' ? { videoFrameMarking: { independent: i === 0, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { wireProfile: locWireProfileForDraft(f.draft), locVersion: 1 }),
      payload: name === 'video' ? Uint8Array.of(0, 0, 0, 2, i === 0 ? 0x65 : 0x41, 0x88) : Uint8Array.of(0xf8, 0xff, 0xfe) });
  }
  await f.server.closeFetchStream(stream); await flush(512);
}

describe.each([18, 22] as const)('LOC historical request ownership draft%i', draft => {
  it.each([false, true])('retrieves a finite snapshot beyond its last indexed Object; audio-only=%s', async audioOnly => {
    const f = await fixture(draft, audioOnly, true, { producingOutput: true, audioOnly, singleTimelineEntry: true });
    const fetch = vi.spyOn(f.client, 'fetch');
    try {
      await f.player.seek(2000); await flush(128);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]![2]!.endGroup).toBeGreaterThan(3n);
      expect(f.fetches[0]).toEqual({ namespace: ['live', 'show'], name: audioOnly ? 'audio' : 'video', group: 3n, object: 0n });
      expect(f.errors).toEqual([]); expect(f.update).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('rejects a factory that returns beyond the preparation deadline before issuing FETCH', async () => {
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = await fixture(draft, false, true, { producingOutput: true, connectionTimeoutMs: 100,
      beforeFactoryReturn: () => { elapsed.mockReturnValue(101); } });
    try {
      await f.player.seek(2000); await flush(128);
      expect(f.fetchIds).toEqual([]); expect(f.seeked).not.toHaveBeenCalled();
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/preparation timed out/);
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      expect(f.decoder.reset).not.toHaveBeenCalled(); expect(f.player.state).toBe('playing');
    } finally { await f.destroy(); elapsed.mockRestore(); }
  });

  it('does not accept late native readiness just because the timer callback has not run', async () => {
    const elapsed = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = await fixture(draft, false, true, { producingOutput: true, connectionTimeoutMs: 100 });
    try {
      await f.player.seek(2000); await flush(128); expect(f.fetchIds).toHaveLength(1);
      elapsed.mockReturnValue(101);
      await sendPreparedGroup(f, 0, 2100n);
      expect(f.seeked).not.toHaveBeenCalled(); expect(f.outputs[0]!.draw).not.toHaveBeenCalled();
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/preparation timed out/);
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce(); expect(f.decoder.reset).not.toHaveBeenCalled();
    } finally { await f.destroy(); elapsed.mockRestore(); }
  });

  it('closes its owned connection when a prepared native decoder throws during destroy', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const close = vi.spyOn(f.client, 'close');
    try {
      await f.player.seek(2000); await flush(128);
      vi.mocked(f.outputs[0]!.decoder.destroy).mockImplementation(() => { throw new Error('native destroy refused'); });
      await expect(f.player.destroy()).rejects.toMatchObject({ message: 'Frame output retirement failed',
        errors: [expect.objectContaining({ message: 'native destroy refused' })] });
      await flush(128);
      expect(close).toHaveBeenCalledOnce(); expect(f.client.onObject).toBeUndefined();
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      expect(f.player.state).toBe('ended');
    } finally { await f.destroy(); }
  });

  it('rounds the complete fractional source boundary upward before native PCM trimming', async () => {
    const f = await fixture(draft, true, true, { producingOutput: true, audioOnly: true });
    const epoch = 1_800_000_000_000_000n;
    try {
      await f.player.seek(2000); await flush(128);
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 1n : 2n } });
      const stream = await f.server.openFetchStream(id);
      // The first sample has a 2/3 us fraction, the later decoded block 1/3.
      // Truncating the anchor before adding the seek delta admits a PCM grid
      // point below the conservative requested-content boundary.
      for (const [i, ticks] of [epoch * 3n + 2n, epoch * 3n + 2_700_001n].entries()) {
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
          extensions: encodeLocHeaders({ timestamp: ticks, timescale: 3_000_000n }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 }),
          payload: Uint8Array.of(0xf8, 0xff, 0xfe) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
      expect(f.errors).toEqual([]); expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalledOnce();
      const timing = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]![3]!;
      expect(timing.context.sourceTimestampUs).toBe(epoch + 900_000n);
      expect(timing.context.presentFromSourceUs).toBe(epoch + 1_000_501n);
    } finally { await f.destroy(); }
  });

  it('positions audio-only seeking from an occupied native source head, never retained PCM', async () => {
    const f = await fixture(draft, true, true, { producingOutput: true, audioOnly: true });
    const epoch = 1_800_000_000_000_000n;
    try {
      await f.player.seek(2000); await flush(128);
      expect(f.fetches.map(item => item.name)).toEqual(['audio']);
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 1n : 2n } });
      const stream = await f.server.openFetchStream(id);
      for (const [i, offset] of [0n, 900_000n].entries()) {
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
          extensions: encodeLocHeaders({ captureTimestamp: epoch + offset }, { wireProfile: locWireProfileForDraft(draft), locVersion: 1 }),
          payload: Uint8Array.of(0xf8, 0xff, 0xfe) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
      expect(f.errors).toEqual([]); expect(f.seeked).not.toHaveBeenCalled();
      expect(f.player.playbackPositionMs).toBe(2000);
      expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalledOnce();
      const schedule = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]!, timing = schedule[3]!;
      expect(timing.context.sourceTimestampUs).toBe(epoch + 900_000n);
      expect(timing.context.presentFromSourceUs).toBe(epoch + 1_000_500n);
      f.audioOutputs[0]!.head.value = { epoch: timing.context.epoch, sourceTimestampUs: timing.context.sourceTimestampUs, sourceOffsetUs: 100_500 };
      f.player.tick(); await flush(64);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2000.5);
      f.audioOutputs[0]!.head.value = { ...f.audioOutputs[0]!.head.value!, sourceOffsetUs: 110_500 };
      expect(f.player.playbackPositionMs).toBe(2010.5);
      expect(f.update).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it.each([false, true])('adopts A/V only after native target PCM and the video picture are prepared; audio first=%s', async audioFirst => {
    const f = await fixture(draft, true, true, { producingOutput: true });
    const epoch = 1_800_000_000_000_000n;
    try {
      await f.player.seek(2000); await flush(128);
      expect(f.fetches.map(item => item.name)).toEqual(['video', 'audio']);
      const send = async (name: 'video' | 'audio') => {
        const request = f.fetchIds[f.fetches.findIndex(item => item.name === name)]!;
        await f.server.acceptFetch(request, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 2n : 3n } });
        const stream = await f.server.openFetchStream(request);
        for (const [i, offset] of [0n, 800_000n, 1_100_000n].entries()) {
          const extensions = encodeLocHeaders({ captureTimestamp: epoch + offset,
            ...(name === 'video' ? { videoFrameMarking: { independent: i === 0, startOfFrame: true, endOfFrame: true,
              discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
            { wireProfile: locWireProfileForDraft(draft), locVersion: 1 });
          await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
            extensions, payload: name === 'video' ? Uint8Array.of(0, 0, 0, 2, i === 0 ? 0x65 : 0x41, 0x88) : Uint8Array.of(0xf8, 0xff, 0xfe) });
        }
        await f.server.closeFetchStream(stream); await flush(512);
      };
      await send(audioFirst ? 'audio' : 'video');
      expect(f.seeked).not.toHaveBeenCalled(); expect(f.outputs[0]!.draw).not.toHaveBeenCalled();
      expect(f.audioOutputs[0]!.output.schedule).not.toHaveBeenCalled();
      await send(audioFirst ? 'video' : 'audio');
      expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalledOnce();
      const schedule = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]!;
      expect(schedule[3]!.context.sourceTimestampUs).toBe(epoch + 1_100_000n);
      expect(schedule[3]!.context.presentFromSourceUs).toBe(epoch + 1_100_000n);
      expect(f.audioOutputs[0]!.frames.slice(0, 2).every(frame => frame.close.mock.calls.length === 1)).toBe(true);
      expect(f.update).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('keeps historical ownership through a second seek and configures from installed transformed bytes once', async () => {
    let transformations = 0;
    const f = await fixture(draft, false, true, { producingOutput: true, commandTransform: command =>
      command.type === 'configure' ? { ...command, config: Uint8Array.of(++transformations) } : command });
    try {
      expect(transformations).toBe(1);
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n);
      expect(f.errors).toEqual([]); expect(f.player.playbackPositionMs).toBe(2100);
      expect(transformations).toBe(1);
      expect(vi.mocked(f.outputs[0]!.decoder.configure).mock.calls[0]![0]).toEqual(Uint8Array.of(1));
      await f.player.seek(2200); await flush(128);
      expect(f.fetchIds).toHaveLength(2); expect(f.update).not.toHaveBeenCalled();
      expect(f.player.playbackPositionMs).toBe(2200); expect(f.seeked).toHaveBeenCalledTimes(1);
      await sendPreparedGroup(f, 1, 2300n);
      expect(f.errors).toEqual([]); expect(f.player.playbackPositionMs).toBe(2300);
      expect(f.seeked).toHaveBeenCalledTimes(2); expect(transformations).toBe(1);
      expect(vi.mocked(f.outputs[1]!.decoder.configure).mock.calls[0]![0]).toEqual(Uint8Array.of(1));
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
  it.each([false, true])('positions only from a produced target draw with raw Unix timestamps; late response=%s', async lateResponse => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const epoch = 1_800_000_000_000_000n;
    try {
      await f.player.seek(2000); await flush(128);
      expect(f.errors).toEqual([]); expect(f.fetchIds).toHaveLength(1);
      const id = f.fetchIds[0]!;
      const accept = () => f.server.acceptFetch(id, { endOfTrack: 1,
        endLocation: { group: 3n, object: draft === 22 ? 3n : 4n } });
      if (!lateResponse) await accept();
      const stream = await f.server.openFetchStream(id);
      for (const [index, offset] of [0n, 800_000n, 1_100_000n, 1_500_000n].entries()) {
        const extensions = encodeLocHeaders({ captureTimestamp: epoch + offset,
          videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 1 });
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128,
          extensions, payload: Uint8Array.of(0, 0, 0, 2, index === 0 ? 0x65 : 0x41, 0x88) });
      }
      await flush(128);
      expect(f.outputs[0]!.decoder.decode).not.toHaveBeenCalled();
      expect(f.outputs[0]!.draw).not.toHaveBeenCalled(); expect(f.seeked).not.toHaveBeenCalled();
      expect(f.player.playbackPositionMs).toBe(2000);
      await f.server.closeFetchStream(stream); await flush(128);
      if (lateResponse) {
        expect(f.seeked).not.toHaveBeenCalled(); expect(f.outputs[0]!.draw).not.toHaveBeenCalled();
        await accept();
      }
      await flush(512);
      expect(f.errors).toEqual([]);
      expect(f.outputs[0]!.decoder.decode).toHaveBeenCalledTimes(4);
      expect(f.outputs[0]!.draw).toHaveBeenCalledTimes(1);
      const shown = f.outputs[0]!.draw.mock.calls[0]![0] as { timestamp: number };
      expect(shown.timestamp).toBe(Number(epoch + 1_100_000n));
      expect(f.seeked).toHaveBeenCalledExactlyOnceWith({ type: 'seeked', actualTimeMs: 2100, groupId: 3, objectId: 2 });
      expect(f.player.playbackPositionMs).toBe(2100);
    } finally { await f.destroy(); }
  });

  it('completes finite video after its final owned picture, without a live-edge recovery', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const ended = vi.fn(), recovery = vi.fn(); f.player.on('track_ended', ended); f.player.on('recovery_action', recovery);
    try {
      await f.player.seek(2000); await flush(128);
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 2n : 3n } });
      const stream = await f.server.openFetchStream(id);
      for (const [index, timestamp] of [1000n, 2100n, 2500n].entries()) {
        const extensions = encodeLocHeaders({ timestamp, timescale: 1000n,
          videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128,
          extensions, payload: Uint8Array.of(0, 0, 0, 2, index === 0 ? 0x65 : 0x41, 0x88) });
      }
      await f.server.closeFetchStream(stream); await flush(256);
      expect(f.errors).toEqual([]); expect(f.player.playbackPositionMs).toBe(2100); expect(ended).not.toHaveBeenCalled();
      f.advance(500_000); await flush(256); f.player.tick(); await flush(128);
      expect(f.player.playbackPositionMs).toBe(2500);
      expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'video' });
      f.advance(2_000_000); await flush(128);
      expect(ended).toHaveBeenCalledTimes(1); expect(recovery).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('uses this FETCH response timescale without borrowing a live subscription default', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128);
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 1n : 2n },
        trackProperties: new Map([[0x08n, [1000n]]]) });
      const stream = await f.server.openFetchStream(id);
      for (const [index, timestamp] of [1000n, 2100n].entries()) {
        const extensions = encodeLocHeaders({ timestamp,
          videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128,
          extensions, payload: Uint8Array.of(0, 0, 0, 2, index === 0 ? 0x65 : 0x41, 0x88) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
      expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.player.playbackPositionMs).toBe(2100);
      const first = vi.mocked(f.outputs[0]!.decoder.decode).mock.calls[0]![0];
      expect(first.sourceTimestamp).toEqual({ ticks: 1000n, ticksPerSecond: 1000n, domain: 'media' });
      expect(first.timestamp).toBe(1_000_000);
    } finally { await f.destroy(); }
  });

  it('retrieves indexed history with FETCH rather than asking an existing subscription to replay', async () => {
    const f = await fixture(draft);
    try {
      expect(f.player.seekable).toBe(true);
      await f.player.seek(2000); await flush(256);
      expect(f.fetches).toEqual([{ namespace: ['live', 'show'], name: 'video', group: 3n, object: 0n }]);
      expect(f.update).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('does not announce a completed seek before any response data or output', async () => {
    const f = await fixture(draft);
    try { await f.player.seek(2000); await flush(256); expect(f.seeked).not.toHaveBeenCalled(); }
    finally { await f.destroy(); }
  });
  it('retains the admitted target while the producing output has not supplied a clock', async () => {
    const f = await fixture(draft);
    try { await f.player.seek(2000); await flush(256); expect(f.player.playbackPositionMs).toBe(2000); }
    finally { await f.destroy(); }
  });
  it('does not reset the current decoder/output before replacement media is accepted', async () => {
    const f = await fixture(draft);
    try {
      const reset = vi.mocked(f.decoder.reset), flushOutput = vi.mocked(f.renderer.flush);
      reset.mockClear(); flushOutput.mockClear();
      await f.player.seek(2000); await flush(256);
      expect(reset).not.toHaveBeenCalled(); expect(flushOutput).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
  it('CONTROL: rejects out-of-index admission without issuing or resetting media', async () => {
    const f = await fixture(draft);
    try { await expect(f.player.seek(500)).rejects.toThrow(/first timeline/); expect(f.fetches).toEqual([]); f.unchanged(); }
    finally { await f.destroy(); }
  });
});

describe.each([18, 22] as const)('LOC post-hook reservation draft%i', draft => {
  it('refuses old-track historical admission when its public hook reserves a video selection', async () => {
    const f = await fixture(draft, false, true, { alternative: true });
    try {
      let entered = false;
      let selecting: Promise<unknown> | undefined;
      f.player.hooks.beforeSubscribe.add(intent => {
        if (!entered && intent.trackName === 'video') {
          entered = true;
          selecting = f.player.selectVideoTrack({ name: 'alternate-video' })
            .then(() => null, (error: unknown) => error);
        }
        return intent;
      });
      const admission = await f.player.seek(2000).then(() => null, (error: unknown) => error);
      await flush(256);
      expect(entered).toBe(true);
      expect(selecting).toBeDefined();
      expect(await selecting).toBeNull();
      expect(f.requests.filter(request => request.name === 'alternate-video')).toHaveLength(1);
      expect.soft(admission, 'the reserved selection must exclude the outer seek').toBeInstanceOf(Error);
      expect.soft(f.fetches, 'no old-track history may start after reservation').toEqual([]);
      expect.soft(f.outputs, 'no competing fresh graph may be created').toEqual([]);
    } finally { await f.destroy(); }
  });

  it('already-pending public selection refuses the same seek before output or FETCH', async () => {
    const f = await fixture(draft, false, true, { alternative: true });
    try {
      await f.player.selectVideoTrack({ name: 'alternate-video' });
      await flush(128);
      expect(f.requests.filter(request => request.name === 'alternate-video')).toHaveLength(1);
      await expect(f.player.seek(2000)).rejects.toThrow(/media change is preparing/);
      expect(f.fetches).toEqual([]);
      expect(f.outputs).toEqual([]);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('LOC seek admission order draft%i', draft => {
  it('does not overwrite a newer seek admitted from its subscription hook', async () => {
    const f = await fixture(draft);
    let nested: Promise<unknown> | undefined, entered = false;
    try {
      f.player.hooks.beforeSubscribe.add(intent => {
        if (!entered && intent.trackName === 'video') {
          entered = true; nested = f.player.seek(2500).then(() => null, (error: unknown) => error);
        }
        return intent;
      });
      const outer = await f.player.seek(2000).then(() => null, (error: unknown) => error);
      await flush(128);
      expect(entered).toBe(true); expect(await nested).toBeNull();
      expect(outer).toBeInstanceOf(Error);
      expect(f.seeking.mock.calls.map(call => call[0].targetTimeMs)).toEqual([2500]);
      expect(f.fetchIds).toHaveLength(1); expect(f.outputs).toHaveLength(1);
      expect(f.outputs[0]!.decoder.destroy).not.toHaveBeenCalled();
      expect(f.player.playbackPositionMs).toBe(2500);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('owned finite LOC resume draft%i', draft => {
  it.each([false, true])('continues to the actual next picture; pause/resume=%s', async paused => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const send = async (id: bigint) => {
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 2n : 3n } });
      const stream = await f.server.openFetchStream(id);
      for (const [i, point] of [1000n, 2100n, 2300n].entries()) {
        const extensions = encodeLocHeaders({ timestamp: point, timescale: 1000n,
          videoFrameMarking: { independent: i === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
          extensions, payload: Uint8Array.of(0, 0, 0, 2, i === 0 ? 0x65 : 0x41, 0x88) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
    };
    try {
      await f.player.seek(2000); await flush(128); await send(f.fetchIds[0]!);
      expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.player.playbackPositionMs).toBe(2100); expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      if (paused) {
        f.player.pause(); await flush(256); f.advance(150_000); expect(f.player.playbackPositionMs).toBe(2100);
        f.player.play(); await flush(128);
        // A correct implementation may retain the future picture or fetch it
        // anew. Answer a fresh historical request if it chose the latter.
        for (const id of f.fetchIds.slice(1)) await send(id);
      }
      f.advance(500_000); await flush(256);
      expect(f.errors).toEqual([]);
      expect(f.player.playbackPositionMs).toBe(2300);
      expect(f.outputs.reduce((n, item) => n + item.draw.mock.calls.length, 0)).toBeGreaterThanOrEqual(2);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('LOC resume output continuity draft%i', draft => {
  it('a pause inside the public retrieval hook cancels internal resume before output allocation', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      f.player.pause(); await flush(256);
      f.player.hooks.beforeSubscribe.add(intent => { if (intent.trackName === 'video') f.player.pause(); return intent; });
      f.player.play(); await flush(256);
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.fetchIds).toHaveLength(1); expect(f.outputs).toHaveLength(1);
      expect(f.errors).toEqual([]); expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('a new pause revokes an internal A/V resume before its held native PCM becomes ready', async () => {
    const f = await fixture(draft, true, true, { producingOutput: true });
    const epoch = 1_800_000_000_000_000n;
    const send = (index: number) => sendPreparedAvGroup(f, index, epoch);
    try {
      await f.player.seek(2000); await flush(128); await send(0); await send(1);
      const first = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]![3]!;
      f.audioOutputs[0]!.head.value = { epoch: first.context.epoch, sourceTimestampUs: first.context.sourceTimestampUs, sourceOffsetUs: 20_000 };
      expect(f.player.playbackPositionMs).toBe(2120);
      f.player.pause(); await flush(256); f.player.play(); await flush(128);
      const decoder = f.audioOutputs[1]!.decoder;
      const pending: Array<() => void> = [], closed: Array<ReturnType<typeof vi.fn>> = [];
      vi.mocked(decoder.decode).mockImplementation((chunk, time, input, context) => {
        const close = vi.fn(), receive = decoder.onData!; closed.push(close);
        pending.push(() => receive({ timestamp: chunk.timestamp, numberOfFrames: 9600, numberOfChannels: 2, sampleRate: 48000, close },
          time, input, context ? { context, sourceOffsetUs: 0 } : undefined));
      });
      await send(2); await send(3);
      expect(pending).toHaveLength(3); expect(f.outputs[1]!.draw).not.toHaveBeenCalled();
      f.player.pause(); await flush(256);
      for (const output of pending) output();
      await flush(256); f.advance(500_000); await flush(128);
      expect(f.errors).toEqual([]); expect(f.player.state).toBe('paused');
      expect(f.outputs[1]!.draw).not.toHaveBeenCalled(); expect(f.player.playbackPositionMs).toBe(2120);
      expect(f.audioOutputs[1]!.output.schedule).not.toHaveBeenCalled();
      expect(closed.every(close => close.mock.calls.length === 1)).toBe(true);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('starts playback from an already drawn paused preview without skipping that picture', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      f.player.pause(); await flush(256);
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      f.player.play(); await flush(128); await sendPreparedGroup(f, 1, 2100n, 2300n);
      expect(f.errors).toEqual([]); expect(f.player.playbackPositionMs).toBe(2100);
      f.advance(500_000); await flush(128);
      expect(f.player.playbackPositionMs).toBe(2300);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('keeps the held position paused on refusal and permits a later fresh resume', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      f.player.pause(); await flush(256);
      let refuse = true;
      f.player.hooks.beforeSubscribe.add(intent => refuse && intent.trackName === 'video' ? null : intent);
      f.player.play(); await flush(128);
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/could not resume/);
      expect(f.fetchIds).toHaveLength(1); expect(f.outputs).toHaveLength(1);
      refuse = false;
      f.player.play(); await flush(128); await sendPreparedGroup(f, 1, 2100n, 2300n);
      f.advance(500_000); await flush(128);
      expect(f.player.state).toBe('playing'); expect(f.player.playbackPositionMs).toBe(2300);
      expect(f.errors).toHaveLength(1); expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('does not prepare a resume after a play listener pauses again', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      f.player.pause(); await flush(256);
      f.player.on('state_changed', event => { if (event.from === 'paused' && event.to === 'playing') f.player.pause(); });
      f.player.play(); await flush(256);
      expect(f.player.state).toBe('paused'); expect(f.fetchIds).toHaveLength(1); expect(f.outputs).toHaveLength(1);
      expect(f.player.playbackPositionMs).toBe(2100); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('plays an inactive paused candidate with the latest intent and no second retrieval', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128);
      f.player.pause(); await flush(256); f.player.play(); await flush(128);
      expect(f.fetchIds).toHaveLength(1);
      await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(f.player.playbackPositionMs).toBe(2100);
      f.advance(500_000); await flush(256);
      expect(f.player.playbackPositionMs).toBe(2300); expect(f.errors).toEqual([]);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('keeps the last picture while resuming from the occupied audio head between pictures', async () => {
    const f = await fixture(draft, true, true, { producingOutput: true });
    const epoch = 1_800_000_000_000_000n;
    const send = (index: number) => sendPreparedAvGroup(f, index, epoch);
    try {
      await f.player.seek(2000); await flush(128); await send(0); await send(1);
      expect(f.player.playbackPositionMs).toBe(2100);
      const first = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]![3]!;
      f.audioOutputs[0]!.head.value = { epoch: first.context.epoch, sourceTimestampUs: first.context.sourceTimestampUs, sourceOffsetUs: 20_000 };
      expect(f.player.playbackPositionMs).toBe(2120);
      f.player.pause(); await flush(256); f.advance(150_000); f.player.play(); await flush(128);
      await send(2); await send(3);
      expect(f.errors).toEqual([]);
      expect(f.outputs[1]!.draw, 'the next picture is still in the future').not.toHaveBeenCalled();
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2120);
      const resumed = vi.mocked(f.audioOutputs[1]!.output.schedule).mock.calls[0]![3]!;
      expect(resumed.context.presentFromSourceUs).toBe(epoch + 1_120_000n);
      f.audioOutputs[1]!.head.value = { epoch: resumed.context.epoch, sourceTimestampUs: resumed.context.sourceTimestampUs, sourceOffsetUs: 30_000 };
      f.advance(160_000); await flush(128);
      expect(f.player.playbackPositionMs).toBe(2130); expect(f.outputs[1]!.draw).not.toHaveBeenCalled();
      f.audioOutputs[1]!.head.value = { ...f.audioOutputs[1]!.head.value!, sourceOffsetUs: 200_000 };
      f.advance(340_000); await flush(128);
      expect(f.outputs[1]!.draw).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2300);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('keeps paused output muted when the old decoder reports late frames and an error', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      const old = f.outputs[0]!, call = vi.mocked(old.decoder.decode).mock.calls.at(-1)!;
      f.player.pause(); await flush(256);
      const frame = { timestamp: call[0].timestamp, close: vi.fn() };
      old.decoder.onFrame?.(frame, call[1], call[0].sourceTimestamp, call[2], call[3]);
      old.decoder.onError?.(new Error('late abandoned decoder error'));
      f.advance(500_000); await flush(128);
      expect(f.errors).toEqual([]); expect(old.draw).toHaveBeenCalledOnce();
      expect(frame.close).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
    } finally { await f.destroy(); }
  });

  it('does not seek ahead or publish a new user seek while resuming', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(f.errors).toEqual([]); expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
      f.player.pause(); await flush(256); f.advance(150_000); f.player.play(); await flush(128);
      expect.soft(f.seeking, 'play is not a public seek action').toHaveBeenCalledOnce();
      for (const [i] of f.fetchIds.slice(1).entries()) await sendPreparedGroup(f, i + 1, 2100n, 2300n);
      expect(f.errors).toEqual([]);
      expect.soft(f.player.playbackPositionMs, 'do not reapply index uncertainty to a known picture and skip it').toBe(2100);
      expect.soft(f.seeked, 'internal output replacement is not a public seek action').toHaveBeenCalledOnce();
      f.advance(500_000); await flush(256);
      expect(f.player.playbackPositionMs).toBe(2300);
    } finally { await f.destroy(); }
  });

  it('resumes audio from its observed source point without adding another half-millisecond', async () => {
    const f = await fixture(draft, true, true, { producingOutput: true, audioOnly: true });
    const epoch = 1_800_000_000_000_000n;
    const send = async (index: number) => {
      const id = f.fetchIds[index]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: draft === 22 ? 2n : 3n } });
      const stream = await f.server.openFetchStream(id);
      for (const [i, offset] of [0n, 900_000n, 1_100_000n].entries()) {
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
          extensions: encodeLocHeaders({ captureTimestamp: epoch + offset }, { wireProfile: locWireProfileForDraft(draft), locVersion: 1 }),
          payload: Uint8Array.of(0xf8, 0xff, 0xfe) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
    };
    try {
      await f.player.seek(2000); await flush(128); await send(0);
      const first = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]![3]!;
      f.audioOutputs[0]!.head.value = { epoch: first.context.epoch, sourceTimestampUs: first.context.sourceTimestampUs, sourceOffsetUs: 110_500.25 };
      f.player.tick(); await flush(128);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2010.50025);
      f.player.pause(); await flush(256); f.player.play(); await flush(128);
      await send(1);
      expect(f.errors).toEqual([]);
      const resumed = vi.mocked(f.audioOutputs[1]!.output.schedule).mock.calls[0]![3]!;
      expect(resumed.context.presentFromSourceUs).toBe(epoch + 1_010_501n);
      expect(f.player.playbackPositionMs).toBe(2010.50025);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});

describe.each([18, 22] as const)('LOC resumed clock continuity draft%i', draft => {
  it.each([false, true])('retains audio clock authority across fresh resume graph; new head=%s', async newHead => {
    const f = await fixture(draft, true, true, { producingOutput: true });
    const epoch = 1_800_000_000_000_000n;
    const send = (index: number) => sendPreparedAvGroup(f, index, epoch);
    try {
      await f.player.seek(2000); await flush(128); await send(0); await send(1);
      expect(f.player.playbackPositionMs).toBe(2100);
      const first = vi.mocked(f.audioOutputs[0]!.output.schedule).mock.calls[0]![3]!;
      f.audioOutputs[0]!.head.value = { epoch: first.context.epoch,
        sourceTimestampUs: first.context.sourceTimestampUs, sourceOffsetUs: 20_000 };
      expect(f.player.playbackPositionMs).toBe(2120);
      f.player.pause(); await flush(256); f.player.play(); await flush(128);
      await send(2); await send(3);
      expect(f.errors).toEqual([]);
      const resumed = vi.mocked(f.audioOutputs[1]!.output.schedule).mock.calls[0]![3]!;
      expect(f.player.playbackPositionMs).toBe(2120);
      if (newHead) f.audioOutputs[1]!.head.value = { epoch: resumed.context.epoch,
        sourceTimestampUs: resumed.context.sourceTimestampUs, sourceOffsetUs: 40_000 };
      f.advance(500_000); await flush(128);
      expect(f.outputs[1]!.draw).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
      expect(f.player.playbackPositionMs, 'an unavailable resumed audio head must not transfer its clock to video')
        .toBe(newHead ? 2140 : 2120);
      if (!newHead) {
        f.player.pause(); await flush(256); f.player.play(); await flush(128);
        await send(4); await send(5);
        expect(f.player.playbackPositionMs).toBe(2120);
        expect(f.outputs[2]!.draw).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
      }
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('LOC seek render lifecycle draft%i', draft => {
  it('ignores unadopted and retired renderer callbacks without losing current draw accounting', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true }), first = vi.fn();
    f.player.on('first_frame', first);
    try {
      await f.player.seek(2000); await flush(128);
      f.outputs[0]!.renderer.onFirstFrame!(); f.outputs[0]!.renderer.onFrameRendered!(1_000_000n, 100_000);
      expect(first).not.toHaveBeenCalled(); expect(f.player.stats.framesRendered).toBe(0);
      await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(f.player.stats.framesRendered).toBe(1); expect(first).toHaveBeenCalledOnce();
      const oldFirst = f.outputs[0]!.renderer.onFirstFrame!, oldFrame = f.outputs[0]!.renderer.onFrameRendered!;
      await f.player.seek(2200); await flush(128); await sendPreparedGroup(f, 1, 2300n);
      expect(f.outputs[1]!.draw).toHaveBeenCalledOnce(); expect(f.player.stats.framesRendered).toBe(2);
      const events = first.mock.calls.length;
      oldFirst(); oldFrame(2_500_000n, 600_000);
      expect(first).toHaveBeenCalledTimes(events); expect(f.player.stats.framesRendered).toBe(2);
      const freshFirst = f.outputs[1]!.renderer.onFirstFrame!, freshFrame = f.outputs[1]!.renderer.onFrameRendered!;
      await f.player.destroy();
      freshFirst(); freshFrame(2_500_000n, 600_000);
      expect(first).toHaveBeenCalledTimes(events); expect(f.player.stats.framesRendered).toBe(2);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('counts actual target and later draws through the public player lifecycle', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true }), first = vi.fn();
    f.player.on('first_frame', first);
    try {
      const before = f.player.stats;
      expect(before.framesRendered).toBe(0); expect(before.ttffBreakdown?.firstFrameRenderedMs).toBeNull();
      await f.player.seek(2000); await flush(128);
      expect(first).not.toHaveBeenCalled(); expect(f.player.stats.framesRendered).toBe(0);
      await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      expect.soft(first).toHaveBeenCalledOnce();
      expect.soft(f.player.stats.framesRendered).toBe(1);
      expect.soft(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).not.toBeNull();
      f.advance(500_000); await flush(128);
      expect(f.outputs[0]!.draw).toHaveBeenCalledTimes(2);
      expect.soft(f.player.stats.framesRendered).toBe(2); expect.soft(first).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('CONTROL: the original renderer still reports its first frame and render count', async () => {
    const f = await fixture(draft), first = vi.fn();
    f.player.on('first_frame', first);
    try {
      f.renderer.onFirstFrame!(); f.renderer.onFrameRendered!(1000n, 100_000);
      expect(first).toHaveBeenCalledOnce(); expect(f.player.stats.framesRendered).toBe(1);
      expect(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).not.toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('CONTROL: retained and scheduled audio never reports a video frame', async () => {
    const f = await fixture(draft, true, true, { producingOutput: true, audioOnly: true }), first = vi.fn();
    f.player.on('first_frame', first);
    try {
      await f.player.seek(2000); await flush(128);
      await sendPreparedAvGroup(f, 0, 1_800_000_000_000_000n);
      expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalled(); expect(f.errors).toEqual([]);
      expect(f.outputs).toHaveLength(0); expect(first).not.toHaveBeenCalled();
      expect(f.player.stats.framesRendered).toBe(0); expect(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).toBeNull();
    } finally { await f.destroy(); }
  });
});

describe('LOC first-frame publication classification', () => {
  it('keeps completed draw accounting when the error reporter reenters public pause', async () => {
    const f = await fixture(22, false, true, { producingOutput: true }), failure = Error('first-frame listener');
    const report = vi.fn(() => { f.player.pause(); }); vi.stubGlobal('reportError', report);
    f.player.on('first_frame', () => { throw failure; });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(report).toHaveBeenCalledExactlyOnceWith(failure);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.player.stats.framesRendered).toBe(1); expect(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).not.toBeNull();
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.errors).toEqual([]); expect(f.outputs[0]!.decoder.destroy).not.toHaveBeenCalled();
      f.advance(500_000); await flush(128);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.player.stats.framesRendered).toBe(1);
      expect(report).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
  it.each([false, true])('keeps actual draw/accounting when first_frame listener throws=%s', async throwing => {
    const f = await fixture(22, false, true, { producingOutput: true });
    const failure = new Error('application first_frame listener failed'), report = vi.fn();
    vi.stubGlobal('reportError', report);
    const listener = vi.fn(() => { if (throwing) throw failure; });
    f.player.on('first_frame', listener);
    let surfaced: unknown;
    try {
      await f.player.seek(2000); await flush(128);
      try { await sendPreparedGroup(f, 0, 2100n, 2300n); } catch (error) { surfaced = error; }
      // The original application failure remains observable in the host's
      // error channel, independent of media preparation.
      expect(surfaced).toBeUndefined();
      expect(report).toHaveBeenCalledTimes(throwing ? 1 : 0);
      if (throwing) expect(report).toHaveBeenCalledExactlyOnceWith(failure);
      expect(listener).toHaveBeenCalledOnce();
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.player.stats.ttffBreakdown?.firstFrameRenderedMs).not.toBeNull();
      expect.soft(f.errors, 'a publication exception must not become a media error').toEqual([]);
      expect.soft(f.player.stats.framesRendered, 'the completed first draw must still count').toBe(1);
      expect.soft(f.player.state, 'application publication must not retire healthy media').toBe('playing');
      expect.soft(f.outputs[0]!.decoder.destroy).not.toHaveBeenCalled();
      f.advance(500_000); await flush(128);
      expect.soft(f.outputs[0]!.draw, 'later media must remain playable').toHaveBeenCalledTimes(2);
      expect.soft(f.player.stats.framesRendered).toBe(2);
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('historical LOC diagnostics draft%i', draft => {
  it('keeps a diagnostic unit-budget refusal separate from native target readiness', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const stages: MediaStageObservation[] = [], receipts: object[] = [];
    const off = f.player.observeMediaStages(event => { stages.push(event); }, {
      createTracker: (host, emit) => createMediaDiagnostics(host, emit, { maxUnits: 1 }),
    });
    const unobserve = f.client.observeObjectReceipts(event => { if (event.origin !== 'group-end') receipts.push(event.receipt); });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(stages.filter(event => event.inputs.includes(receipts[2]!)).map(event => event.stage)).toEqual(['decoded', 'scheduled']);
      await f.player.seek(2200); await flush(128); await sendPreparedGroup(f, 1, 2300n);
      expect(f.outputs[1]!.draw).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledTimes(2);
      expect(f.player.playbackPositionMs).toBe(2300); expect(f.errors).toEqual([]);
      const summary = f.player.diagnosticSnapshot().mediaStages!;
      expect(summary.refusedVideoCount).toBeGreaterThan(0); expect(summary.evidenceLossCount).toBeGreaterThan(0);
      expect(stages.filter(event => event.inputs.includes(receipts[4]!))).toEqual([]);
    } finally { unobserve(); off(); await f.destroy(); }
  });

  it('keeps playing when an observer detaches synchronously from decoded output', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const stages: MediaStageObservation[] = [];
    let off = () => {};
    off = f.player.observeMediaStages(event => { stages.push(event); if (event.stage === 'decoded') off(); }, { createTracker: createMediaDiagnostics });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(stages.map(event => event.stage)).toEqual(['decoded']); expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      f.advance(500_000); await flush(128);
      expect(f.outputs[0]!.draw).toHaveBeenCalledTimes(2); expect(f.player.playbackPositionMs).toBe(2300);
      expect(stages).toHaveLength(1); expect(f.player.diagnosticSnapshot().mediaStages).toBeUndefined(); expect(f.errors).toEqual([]);
    } finally { off(); await f.destroy(); }
  });

  it.each([false, true])('does not enable pipeline input tracking when diagnostics are absent; audio=%s', async audio => {
    const tracking = vi.spyOn(PlaybackPipeline.prototype, 'inputObserver', 'set');
    const f = await fixture(draft, audio, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128);
      if (audio) {
        await sendPreparedAvGroup(f, 0, 1_800_000_000_000_000n);
        await sendPreparedAvGroup(f, 1, 1_800_000_000_000_000n);
      } else await sendPreparedGroup(f, 0, 2100n);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      expect(tracking.mock.calls.filter(([observer]) => observer !== undefined)).toEqual([]);
    } finally { await f.destroy(); tracking.mockRestore(); }
  });

  it.each([false, true])('keeps audio and video units on their own FETCH receipts; audio-only=%s', async audioOnly => {
    const f = await fixture(draft, true, true, { producingOutput: true, audioOnly });
    const stages: MediaStageObservation[] = [], receipts: object[] = [];
    const off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => { if (event.origin !== 'group-end') receipts.push(event.receipt); });
    try {
      await f.player.seek(2000); await flush(128);
      const epoch = 1_800_000_000_000_000n;
      await sendPreparedAvGroup(f, 0, epoch);
      if (!audioOnly) await sendPreparedAvGroup(f, 1, epoch);
      expect(f.errors).toEqual([]); expect(receipts).toHaveLength(audioOnly ? 3 : 6);
      expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalled();
      const audio = stages.filter(event => event.inputs.includes(receipts[audioOnly ? 1 : 4]!));
      expect(audio.map(event => event.stage)).toEqual(['decoded', 'scheduled']);
      expect(new Set(audio.map(event => event.unit)).size).toBe(1);
      if (audioOnly) expect(stages.some(event => event.stage === 'presented')).toBe(false);
      else {
        const video = stages.filter(event => event.inputs.includes(receipts[1]!));
        expect(video.map(event => event.stage)).toEqual(['decoded', 'scheduled', 'presented']);
        expect(new Set(video.map(event => event.unit)).size).toBe(1);
        expect(video[0]!.unit).not.toBe(audio[0]!.unit); expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      }
      const summary = f.player.diagnosticSnapshot().mediaStages!;
      expect(summary.evidenceLossCount).toBe(0); expect(summary.unattributedInputCount).toBe(0);
    } finally { unobserve(); off(); await f.destroy(); }
  });

  it('installs during graph construction before any fresh decoder output', async () => {
    const stages: MediaStageObservation[] = [], receipts: object[] = [];
    let f!: Awaited<ReturnType<typeof fixture>>, off = () => {};
    f = await fixture(draft, false, true, { producingOutput: true, beforeFactoryReturn: () => {
      off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    } });
    const unobserve = f.client.observeObjectReceipts(event => { if (event.origin !== 'group-end') receipts.push(event.receipt); });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      const target = stages.filter(event => event.inputs.includes(receipts[1]!));
      expect(target.map(event => event.stage)).toEqual(['decoded', 'scheduled', 'presented']);
      expect(new Set(target.map(event => event.unit)).size).toBe(1);
    } finally { unobserve(); off(); await f.destroy(); }
  });

  it('detaches pending output evidence without changing playback or transferring its identity on reattach', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const old: MediaStageObservation[] = [], fresh: MediaStageObservation[] = [], receipts: object[] = [];
    const unobserve = f.client.observeObjectReceipts(event => { if (event.origin !== 'group-end') receipts.push(event.receipt); });
    const first = f.player.observeMediaStages(event => { old.push(event); }, { createTracker: createMediaDiagnostics });
    let second = () => {};
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      const waiting = old.filter(event => event.inputs.includes(receipts[2]!));
      expect(waiting.map(event => event.stage)).toEqual(['decoded', 'scheduled']);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); first(); const count = old.length;
      second = f.player.observeMediaStages(event => { fresh.push(event); }, { createTracker: createMediaDiagnostics });
      f.advance(500_000); await flush(128);
      expect(f.outputs[0]!.draw).toHaveBeenCalledTimes(2); expect(fresh).toEqual([]); expect(old).toHaveLength(count);
      await f.player.seek(2400); await flush(128); await sendPreparedGroup(f, 1, 2500n);
      expect(f.outputs[1]!.draw).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      const target = fresh.filter(event => event.inputs.includes(receipts[4]!));
      expect(target.map(event => event.stage)).toEqual(['decoded', 'scheduled', 'presented']);
      expect(fresh.every(event => event.inputs.every(input => receipts.slice(3).includes(input)))).toBe(true);
      expect(old).toHaveLength(count); expect(f.player.diagnosticSnapshot().mediaStages?.evidenceLossCount).toBe(0);
    } finally { unobserve(); first(); second(); await f.destroy(); }
  });

  it('preserves the playing graph while another graph prepares and reports its retirement terminal', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const stages: MediaStageObservation[] = [], receipts: object[] = [];
    const off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => { if (event.origin !== 'group-end') receipts.push(event.receipt); });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n, 2300n);
      expect(stages.filter(event => event.inputs.includes(receipts[2]!)).map(event => event.stage)).toEqual(['decoded', 'scheduled']);
      await f.player.seek(2200); await flush(128);
      expect(f.outputs[0]!.decoder.destroy).not.toHaveBeenCalled();
      await sendPreparedGroup(f, 1, 2300n);
      expect(f.outputs[1]!.draw).toHaveBeenCalledOnce(); expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      const retired = stages.filter(event => event.inputs.includes(receipts[2]!));
      expect(retired.map(event => event.stage)).toEqual(['decoded', 'scheduled', 'discarded']);
      expect(new Set(retired.map(event => event.unit)).size).toBe(1);
      const current = stages.filter(event => event.inputs.includes(receipts[4]!));
      expect(current.map(event => event.stage)).toEqual(['decoded', 'scheduled', 'presented']);
      expect(current[0]!.unit).not.toBe(retired[0]!.unit); expect(f.errors).toEqual([]);
    } finally { unobserve(); off(); await f.destroy(); }
  });

  it.each([false, true])('correlates the presented target with its original FETCH receipt; late installation=%s', async late => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    const stages: MediaStageObservation[] = [], receipts: object[] = [];
    let off = () => {};
    if (late) { await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n); }
    off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => { if (event.origin !== 'group-end') receipts.push(event.receipt); });
    try {
      await f.player.seek(late ? 2200 : 2000); await flush(128);
      await sendPreparedGroup(f, late ? 1 : 0, late ? 2300n : 2100n, late ? 2500n : 2300n);
      expect(f.outputs[late ? 1 : 0]!.draw).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]); expect(receipts).toHaveLength(3);
      const presented = stages.find(event => event.stage === 'presented');
      expect(presented, 'a real presented target must have diagnostic stages').toBeDefined();
      expect(presented!.inputs).toEqual([receipts[1]]);
      const chain = stages.filter(event => event.unit === presented!.unit);
      expect(chain.map(event => event.stage)).toEqual(['decoded', 'scheduled', 'presented']);
      expect(f.player.diagnosticSnapshot().mediaStages?.evidenceLossCount).toBe(0);
    } finally { unobserve(); off(); await f.destroy(); }
  });
});

describe('retiring LOC graph diagnostic ownership', () => {
  it.each([false, true])('keeps held terminal observations through retirement; nested seek=%s', async nested => {
    const f = await fixture(22, false, true, { producingOutput: true, singleTimelineEntry: true });
    const stages: MediaStageObservation[] = [];
    const receipts: object[] = [];
    let retiredInputs = new Set<object>();
    let armed = false;
    let triggered = false;
    let successor: Promise<unknown> | undefined;
    const off = f.player.observeMediaStages(event => {
      stages.push(event);
      if (armed && nested && !triggered && event.stage === 'discarded' && event.unit === null
          && event.inputs.some(input => retiredInputs.has(input))) {
        triggered = true;
        successor = f.player.seek(2400).then(() => null, error => error);
      }
    }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => {
      if (event.origin !== 'group-end') receipts.push(event.receipt);
    });
    try {
      await f.player.seek(2000); await flush(128);
      const id = f.fetchIds[0]!;
      const points = [1000n, ...Array.from({ length: 24 }, (_, index) => 2100n + BigInt(index) * 200n)];
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: BigInt(points.length - 1) } });
      const stream = await f.server.openFetchStream(id);
      for (const [index, timestamp] of points.entries()) {
        const extensions = encodeLocHeaders({ timestamp, timescale: 1000n,
          videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } },
          { wireProfile: locWireProfileForDraft(22), locVersion: 4 });
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index),
          publisherPriority: 128, extensions, payload: Uint8Array.of(0, 0, 0, 2, index === 0 ? 0x65 : 0x41, 0x88) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
      const held = stages.filter(event => event.stage === 'decoded'
        && !stages.some(other => other.unit === event.unit && other.stage === 'scheduled'));
      expect(held.length, 'real decoded outputs must be held before testing cleanup').toBeGreaterThan(0);
      retiredInputs = new Set(receipts);
      armed = true;
      await f.player.seek(2200); await flush(128);
      await sendPreparedGroup(f, 1, 2300n);
      await flush(128);
      if (nested) {
        expect(triggered, 'a raw input retirement terminal must start the nested public seek').toBe(true);
        expect(await successor).toBeNull();
        expect(f.outputs).toHaveLength(3);
      }
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      for (const frame of f.outputs[0]!.frames) expect(frame.close).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
      for (const output of held) {
        expect(stages.filter(event => event.unit === output.unit).map(event => event.stage))
          .toEqual(['decoded', 'discarded']);
      }
    } finally { unobserve(); off(); await f.destroy(); }
  });
});

describe.each([18, 22] as const)('LOC indexed continuity draft%i', draft => {
  async function sendGroups(f: Awaited<ReturnType<typeof fixture>>, groups: readonly { group: bigint; points: readonly bigint[] }[], requestIndex = 0) {
    const last = groups.at(-1)!;
    await f.server.acceptFetch(f.fetchIds[requestIndex]!, { endOfTrack: 1,
      endLocation: { group: last.group, object: BigInt(last.points.length - (draft === 22 ? 1 : 0)) } });
    const stream = await f.server.openFetchStream(f.fetchIds[requestIndex]!);
    for (const { group, points } of groups) for (const [i, timestamp] of points.entries()) {
      const extensions = encodeLocHeaders({ timestamp, timescale: 1_000_000n,
        videoFrameMarking: { independent: i === 0, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
      await f.server.sendFetchObject(stream, { groupId: group, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
        extensions, payload: Uint8Array.of(0, 0, 0, 2, i === 0 ? 0x65 : 0x41, 0x88) });
    }
    await f.server.closeFetchStream(stream); await flush(512);
  }

  it.each([false, true])('checks a later anchor before preparation; inconsistent=%s', async inconsistent => {
    const f = await fixture(draft, false, true, { producingOutput: true, catalogVersion: '1' });
    try {
      await f.player.seek(2500); await flush(128);
      await sendGroups(f, [{ group: 3n, points: [1_000_000n, 2_100_000n] },
        { group: 4n, points: [inconsistent ? 4_000_000n : 3_000_000n] }]);
      if (inconsistent) {
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        expect(f.outputs[0]!.decoder.decode).not.toHaveBeenCalled();
        expect(f.outputs[0]!.draw).not.toHaveBeenCalled(); expect(f.seeked).not.toHaveBeenCalled();
        expect(f.player.state).toBe('playing');
      } else {
        expect(f.errors).toEqual([]); expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
        expect(f.seeked).toHaveBeenCalledWith(expect.objectContaining({ actualTimeMs: 3000 }));
      }
    } finally { await f.destroy(); }
  });

  it.each([false, true])('checks a later anchor after adoption; inconsistent=%s', async inconsistent => {
    const f = await fixture(draft, false, true, { producingOutput: true, catalogVersion: '1' });
    try {
      await f.player.seek(2000); await flush(128);
      await sendGroups(f, [{ group: 3n, points: [1_000_000n, 2_100_000n] },
        { group: 4n, points: [inconsistent ? 4_000_000n : 3_000_000n] }]);
      expect(f.seeked).toHaveBeenCalledOnce();
      const decoded = vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp);
      if (inconsistent) {
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        expect(decoded).not.toContain(4_000_000);
        expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      } else { expect(f.errors).toEqual([]); expect(decoded).toContain(3_000_000); }
    } finally { await f.destroy(); }
  });

  it.each([false, true])('intersects all observed anchor intervals; inconsistent=%s', async inconsistent => {
    const f = await fixture(draft, false, true, { producingOutput: true, catalogVersion: '1',
      timeline: [[1000, [3, 0], 0], [2000, [4, 0], 0], [3000, [5, 0], 0]] });
    const third = inconsistent ? 3_000_750n : 2_999_750n;
    try {
      await f.player.seek(1500); await flush(128);
      await sendGroups(f, [{ group: 3n, points: [1_000_000n, 1_600_000n] },
        { group: 4n, points: [1_999_250n] }, { group: 5n, points: [third] }]);
      const decoded = vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp);
      expect(decoded).toContain(1_999_250); expect(f.seeked).toHaveBeenCalledOnce();
      if (inconsistent) {
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        expect(decoded).not.toContain(Number(third));
      } else { expect(f.errors).toEqual([]); expect(decoded).toContain(Number(third)); }
    } finally { await f.destroy(); }
  });

  it.each([false, true])('checks repeated timeline records against retained sample evidence; inconsistent=%s', async inconsistent => {
    const f = await fixture(draft, false, true, { producingOutput: true, catalogVersion: '1' });
    try {
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      await f.updateTimeline([[inconsistent ? 1100 : 1000, [3, 0], 0]]);
      if (inconsistent) {
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      } else { expect(f.errors).toEqual([]); expect(f.outputs[0]!.decoder.destroy).not.toHaveBeenCalled(); }
    } finally { await f.destroy(); }
  });

  it.each([false, true])('keeps cumulative mapping evidence across pause and resume; inconsistent=%s', async inconsistent => {
    const f = await fixture(draft, false, true, { producingOutput: true, catalogVersion: '1',
      timeline: [[1000, [3, 0], 0], [2000, [4, 0], 0], [3000, [5, 0], 0]] });
    const third = inconsistent ? 2_998_750n : 2_999_100n;
    try {
      await f.player.seek(1500); await flush(128);
      await sendGroups(f, [{ group: 3n, points: [1_000_000n, 1_600_000n] },
        { group: 4n, points: [1_999_250n, 2_200_000n] }]);
      f.advance(1_000_000); await flush(128);
      expect(f.player.playbackPositionMs).toBe(2200); expect(f.errors).toEqual([]);
      f.player.pause(); await flush(128); f.player.play(); await flush(128);
      expect(f.fetches[1]!.group).toBe(4n);
      await sendGroups(f, [{ group: 4n, points: [1_999_250n, 2_200_000n] }, { group: 5n, points: [third] }], 1);
      const decoded = vi.mocked(f.outputs[1]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp);
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
      if (inconsistent) {
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        expect(decoded).not.toContain(Number(third));
      } else { expect(f.errors).toEqual([]); expect(decoded).toContain(Number(third)); }
    } finally { await f.destroy(); }
  });

  it.each([false, true])('keeps a conservative nearest-tie narrowing learned while paused; inconsistent=%s', async inconsistent => {
    const f = await fixture(draft, false, true, { producingOutput: true, catalogVersion: 1 });
    const third = inconsistent ? 3_000_250n : 2_999_750n;
    try {
      expect(f.timelineFormat()).toBe('msf-00');
      await f.player.seek(2000); await flush(128); await sendPreparedGroup(f, 0, 2100n);
      expect(f.player.playbackPositionMs).toBe(2100);
      // Nearest rounding leaves tie direction unspecified. Both closed bands
      // can meet at beta=500us; that accepted evidence must survive resume.
      // Commit bytes while forwarding is enabled, then deliver them after the
      // pause has reached the peer. No data is sent under Forward State 0.
      const release = await f.holdTimelineUpdate([[1001, [3, 0], 0]]);
      f.player.pause(); await flush(128); await release();
      expect(f.errors).toEqual([]);
      f.player.play(); await flush(128);
      await sendGroups(f, [{ group: 3n, points: [1_000_000n, 2_100_000n] }, { group: 4n, points: [third] }], 1);
      const decoded = vi.mocked(f.outputs[1]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp);
      if (inconsistent) {
        expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        expect(decoded).not.toContain(Number(third));
      } else { expect(f.errors).toEqual([]); expect(decoded).toContain(Number(third)); }
      expect(f.seeking).toHaveBeenCalledOnce(); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });
});

describe.each([18, 22] as const)('LOC historical-to-live continuation draft%i', draft => {
  async function object(f: Awaited<ReturnType<typeof fixture>>, stream: bigint, id: bigint, timestamp: bigint, kind: 'fetch' | 'subgroup', group = 4n) {
    const extensions = encodeLocHeaders({ timestamp, timescale: 1000n,
      videoFrameMarking: { independent: id === 0n, startOfFrame: true, endOfFrame: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
    const payload = Uint8Array.of(0, 0, 0, 2, id === 0n ? 0x65 : 0x41, 0x88);
    if (kind === 'fetch') await f.server.sendFetchObject(stream, { groupId: group, subgroupId: 0n, objectId: id,
      publisherPriority: 128, extensions, payload });
    else await f.server.sendObject(stream, id, payload, extensions);
  }

  async function history(f: Awaited<ReturnType<typeof fixture>>) {
    await f.player.seek(2000); await flush(128);
    await f.server.acceptFetch(f.fetchIds[0]!, { endOfTrack: 0,
      endLocation: { group: 4n, object: draft === 22 ? 0n : 1n } });
    const stream = await f.server.openFetchStream(f.fetchIds[0]!);
    await object(f, stream, 0n, 1000n, 'fetch', 3n); await flush(128);
    expect(f.errors, 'the first historical object must decode with its connected wire profile').toEqual([]);
    await object(f, stream, 1n, 2100n, 'fetch', 3n);
    await object(f, stream, 0n, 3000n, 'fetch'); await f.server.closeFetchStream(stream); await flush(512);
    expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
    expect(f.outputs[0]!.draw).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
  }

  async function continued(early = false, endOfGroup = true, autoNegotiation = false) {
    const f = await fixture(draft, false, true, { producingOutput: true, isLive: true, catalogVersion: '1',
      ...(autoNegotiation ? { autoNegotiation: true, configuredDraft: null } : {}),
      timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0], [3100, [4, 1], 0]] });
    const streams: bigint[] = [];
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopObserving = () => {};
    try {
      await history(f);
      const subscriptions = f.requests.filter(request => request.name === 'video');
      expect(subscriptions, 'positioned history at the indexed frontier must open a fresh live request').toHaveLength(2);
      const sub = subscriptions[1]!;
      expect(sub.namespace).toEqual(['live', 'show']); expect(sub.id).not.toBe(subscriptions[0]!.id);
      const message = f.wire.mock.calls.map(([message]) => message).find(message => message.type === 'SUBSCRIBE' && message.requestId === sub.id);
      if (!message || message.type !== 'SUBSCRIBE') throw new Error('Missing actual live SUBSCRIBE');
      const filter = message.parameters.get(MessageParam.SUBSCRIPTION_FILTER)?.[0];
      if (!(filter instanceof Uint8Array)) throw new Error('Missing encoded live filter');
      expect(decodeSubscriptionFilter(filter, draft)).toEqual({ type: 'LargestObject' });
      if (draft === 22) {
        const fill = message.parameters.get(0x23n)?.[0];
        if (!(fill instanceof Uint8Array)) throw new Error('Missing actual FILL_PARAMETERS');
        expect(decodeFillParameters(fill)).toMatchObject({ filter: { type: 'AbsoluteStart', startGroup: 4n, startObject: 1n } });
      }
      // A pre-ACK alias is replayed on a host task, after the subscription's
      // promise continuation. Await actual delivery instead of only microtasks.
      const delivered = new Promise<void>((resolve, reject) => {
        stopObserving = f.player.on('decoder_command', event => {
          if (event.command.type === 'decode_video' && event.command.chunk.timestamp === 3_300_000) {
            clearTimeout(deliveryTimer); stopObserving(); resolve();
          }
        });
        deliveryTimer = setTimeout(() => { stopObserving(); reject(new Error('Live Object 4/3 was not decoded')); }, 1000);
      });
      void delivered.catch(() => {});
      const response = f.a.bidiOut.at(-1)!.in;
      if (early) response.faults.hold = true;
      const head = { group: 4n, object: 2n }; f.publishHead('video', head);
      await f.server.acceptSubscribe(sub.id, 201n, { parameters: new Map([[MessageParam.LARGEST_OBJECT, [head]]]) });
      await flush(256);
      const live = await f.server.openSubgroup(201n, 4n, 0n, { publisherPriority: 128, endOfGroup, hasExtensions: true }); streams.push(live);
      if (early) { await object(f, live, 3n, 3300n, 'subgroup'); await flush(256); }
      let prefix: bigint;
      if (draft === 22) prefix = await f.server.openFillStream(sub.id);
      else {
        if (early) { response.releaseHeld(); await flush(256); }
        expect(f.joins).toHaveLength(1);
        const join = f.joins[0]!, range = f.server.resolveJoiningFetch(join.id);
        expect(join.message.fetch).toEqual({ fetchType: 3, joiningRequestId: sub.id, joiningStart: 4n });
        await f.server.acceptFetch(join.id, { endOfTrack: 0, endLocation: range.endLocation });
        prefix = await f.server.openFetchStream(join.id);
        await object(f, prefix, 0n, 3000n, 'fetch');
      }
      await object(f, prefix, 1n, 3100n, 'fetch'); await object(f, prefix, 2n, 3200n, 'fetch');
      await f.server.closeFetchStream(prefix); await flush(256);
      if (early && draft === 22) { response.releaseHeld(); await flush(512); }
      if (!early) await object(f, live, 3n, 3300n, 'subgroup');
      await delivered; await flush(512);
      return { f, sub, live, streams, destroy: async () => {
        for (const stream of streams) await f.server.closeSubgroup(stream); await f.destroy();
      } };
    } catch (error) {
      clearTimeout(deliveryTimer); stopObserving();
      for (const stream of streams) await f.server.closeSubgroup(stream); await f.destroy(); throw error;
    }
  }

  it.each(['pause', 'destroy'] as const)('withdraws credit-blocked live work without late publication: %s', async action => {
    const run = await continued(), { f } = run;
    const ended = vi.fn(); f.player.on('track_ended', ended);
    try {
      for (let i = 4; i < 28; i++) await object(f, run.live, BigInt(i), 3000n + BigInt(i) * 100n, 'subgroup');
      await flush(256);
      const decoded = vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.length;
      const held = f.outputs[0]!.frames.filter(frame => frame.close.mock.calls.length === 0).length;
      expect(held, 'actual native/dispatcher outputs must occupy credit').toBeGreaterThanOrEqual(8);
      expect(decoded, 'the queued live sequence must exceed available output credit').toBeLessThan(30);
      if (action === 'pause') f.player.pause(); else await f.player.destroy();
      await flush(512);
      const drawn = f.outputs[0]!.draw.mock.calls.length;
      f.advance(10_000_000); await flush(256);
      expect(f.outputs[0]!.draw).toHaveBeenCalledTimes(drawn);
      for (const frame of f.outputs[0]!.frames) expect(frame.close).toHaveBeenCalledOnce();
      expect(ended).not.toHaveBeenCalled(); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.outputs).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await run.destroy(); }
  });

  it('uses the negotiated wire profile through its own history and live prefix', async () => {
    const run = await continued(false, true, true), { f } = run;
    try {
      expect(f.client.draftVersion).toBe(draft);
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp))
        .toEqual([1_000_000, 2_100_000, 3_000_000, 3_100_000, 3_200_000, 3_300_000]);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { await run.destroy(); }
  });

  it.each([false, true])('retains one decoder across its own prefix and early live data=%s', async early => {
    const run = await continued(early), { f } = run;
    try {
      await flush(512); f.advance(2_000_000); await flush(256);
      expect(f.errors).toEqual([]); expect(f.outputs).toHaveLength(1);
      expect(f.outputs[0]!.decoder.configure).toHaveBeenCalledOnce();
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp))
        .toEqual([1_000_000, 2_100_000, 3_000_000, 3_100_000, 3_200_000, 3_300_000]);
      expect(f.player.playbackPositionMs).toBe(3300); expect(f.seeked).toHaveBeenCalledOnce();
    } finally { await run.destroy(); }
  });

  it.each([false, true])('accepts independently arriving live groups; reversed=%s', async reversed => {
    const run = await continued(), { f } = run;
    try {
      await f.server.closeSubgroup(run.live); await flush(128);
      for (const group of reversed ? [6n, 5n] : [5n, 6n]) {
        const stream = await f.server.openSubgroup(201n, group, 0n, { publisherPriority: 128, endOfGroup: true, hasExtensions: true }); run.streams.push(stream);
        await object(f, stream, 0n, group === 5n ? 3500n : 3600n, 'subgroup', group);
        await f.server.closeSubgroup(stream); await flush(128);
      }
      f.advance(2_000_000); await flush(256);
      expect(f.errors).toEqual([]); expect(f.outputs).toHaveLength(1); expect(f.player.playbackPositionMs).toBe(3600);
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp))
        .toEqual([1_000_000, 2_100_000, 3_000_000, 3_100_000, 3_200_000, 3_300_000, 3_500_000, 3_600_000]);
    } finally { await run.destroy(); }
  });

  it('keeps accepted native output when a pending live request is refused', async () => {
    const f = await fixture(draft, false, true, { producingOutput: true, isLive: true, catalogVersion: '1',
      timeline: [[1000, [3, 0], 0], [3000, [4, 0], 0], [3100, [4, 1], 0]] });
    try {
      await history(f);
      const sub = f.requests.filter(request => request.name === 'video')[1]!;
      expect(sub).toBeDefined(); await f.server.rejectSubscribe(sub.id, 3n, 'live request refused'); await flush(512);
      expect(f.errors).toHaveLength(1); expect(f.errors[0]).toMatch(/Live video continuation unavailable/);
      expect(f.outputs[0]!.decoder.destroy).not.toHaveBeenCalled(); expect(f.outputs).toHaveLength(1);
      f.advance(2_000_000); await flush(256); expect(f.player.playbackPositionMs).toBe(3000);
      expect(f.requests.filter(request => request.name === 'video')).toHaveLength(2);
      expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.state).toBe('playing');
    } finally { await f.destroy(); }
  });

  it.each([false, true])('terminal input sealing drains accepted groups without a timeout; explicit ends=%s', async endOfGroup => {
    vi.useFakeTimers();
    let run: Awaited<ReturnType<typeof continued>> | undefined;
    try {
      run = await continued(false, endOfGroup); const { f } = run;
      const ended = vi.fn(), recovery = vi.fn(), stalled = vi.fn();
      f.player.on('track_ended', ended); f.player.on('recovery_action', recovery); f.player.on('stall', stalled);
      await f.server.closeSubgroup(run.live); await flush(128);
      for (const group of [6n, 5n]) {
        const stream = await f.server.openSubgroup(201n, group, 0n, { publisherPriority: 128, endOfGroup, hasExtensions: true }); run.streams.push(stream);
        await object(f, stream, 0n, group === 5n ? 3500n : 3600n, 'subgroup', group);
        await f.server.closeSubgroup(stream); await flush(128);
      }
      const flushed = vi.spyOn(f.outputs[0]!.decoder, 'flush');
      await f.server.publishDone(run.sub.id, varint(2n), 'source finished'); await flush(256);
      expect(ended).not.toHaveBeenCalled();
      // Drive the configured SDK grace, keeping the media clock fixed. Closing
      // intake is sufficient to drain accepted groups without a gap timeout.
      await vi.advanceTimersByTimeAsync(10_001); await flush(512);
      f.advance(100_000); await flush(256);
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp))
        .toEqual([1_000_000, 2_100_000, 3_000_000, 3_100_000, 3_200_000, 3_300_000, 3_500_000, 3_600_000]);
      expect(flushed).toHaveBeenCalledOnce();
      expect(ended, 'future native output is still held').not.toHaveBeenCalled();
      f.advance(2_000_000); await flush(512); f.player.tick(); await flush(256);
      expect(f.player.playbackPositionMs).toBe(3600);
      expect(ended).toHaveBeenCalledExactlyOnceWith({ type: 'track_ended', mediaType: 'video' });
      f.advance(4_000_000); await vi.advanceTimersByTimeAsync(1500); await flush(256);
      expect(ended).toHaveBeenCalledOnce(); expect(recovery).not.toHaveBeenCalled(); expect(stalled).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
    } finally { await run?.destroy(); vi.useRealTimers(); }
  });

  it.each([false, true])('discards missing references and drains the successor; prior group ended=%s', async endOfGroup => {
    vi.useFakeTimers();
    let run: Awaited<ReturnType<typeof continued>> | undefined;
    let off = () => {}, unobserve = () => {};
    const consumed = new Set<PlaybackPipeline>();
    const tick = PlaybackPipeline.prototype.tick;
    const ticking = vi.spyOn(PlaybackPipeline.prototype, 'tick').mockImplementation(function (this: PlaybackPipeline) {
      tick.call(this); if (this.currentGroupId === 4n) consumed.add(this);
    });
    try {
      run = await continued(false, endOfGroup); const { f } = run;
      expect(consumed.size).toBe(1);
      const consuming = [...consumed][0]!;
      const stages: MediaStageObservation[] = [], locations = new Map<object, { group: bigint; object: bigint }>();
      off = f.player.observeMediaStages(event => { stages.push(event); }, { createTracker: createMediaDiagnostics });
      unobserve = f.client.observeObjectReceipts(event => { locations.set(event.receipt, { group: event.groupId, object: event.objectId }); });
      const ended = vi.fn(), recovery = vi.fn(), stalled = vi.fn();
      f.player.on('track_ended', ended); f.player.on('recovery_action', recovery); f.player.on('stall', stalled);
      // This fixture sets absolute media time; SDK timer advancement is separate.
      let mediaNowUs = 100_000;
      const missingRAPBudgetUs = () => Math.ceil(consuming.effectiveGapTimeoutUs) + 1;
      const skippedMissingRAP = () => stages.some(event => event.stage === 'discarded' && event.reason === 'skipped'
        && event.inputs.some(input => locations.get(input)?.group === 5n && locations.get(input)?.object === 1n));
      await f.server.closeSubgroup(run.live); await flush(128);
      for (const group of [6n, 5n]) {
        const stream = await f.server.openSubgroup(201n, group, 0n, { publisherPriority: 128, hasExtensions: true }); run.streams.push(stream);
        await object(f, stream, group === 5n ? 1n : 0n, group === 5n ? 3500n : 3600n, 'subgroup', group);
        await f.server.closeSubgroup(stream); await flush(128);
      }
      expect([...locations.values()]).toContainEqual({ group: 5n, object: 1n });
      expect(skippedMissingRAP(), 'the arrived suffix is retained before its bounded dependency wait expires').toBe(false);
      if (endOfGroup) {
        // The prior Group is explicitly ended: its successor's missing-RAP
        // wait is already active, and expires before DONE in this arm.
        mediaNowUs += missingRAPBudgetUs(); f.advance(mediaNowUs); await flush(256);
        f.player.tick(); await flush(256);
        expect(skippedMissingRAP(), 'the missing-reference group was observed and skipped before DONE').toBe(true);
      }
      await f.server.publishDone(run.sub.id, varint(2n), 'source finished with a missing object'); await flush(256);
      await vi.advanceTimersByTimeAsync(10_001); await flush(512);
      f.advance(mediaNowUs); await flush(256); f.player.tick(); await flush(256);
      if (!endOfGroup) {
        // Intake sealing closes the old observed Group. It does not bypass
        // the newly active wait for successor Group5/Object0.
        expect(skippedMissingRAP()).toBe(false);
        mediaNowUs += missingRAPBudgetUs(); f.advance(mediaNowUs); await flush(256);
        f.player.tick(); await flush(256);
      }
      const decoded = vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp);
      expect(decoded).not.toContain(3_500_000); expect(decoded).toContain(3_600_000);
      expect(decoded).toEqual([1_000_000, 2_100_000, 3_000_000, 3_100_000, 3_200_000, 3_300_000, 3_600_000]);
      expect(stages.some(event => event.stage === 'discarded' && event.reason === 'skipped'
        && event.inputs.some(input => locations.get(input)?.group === 5n && locations.get(input)?.object === 1n))).toBe(true);
      expect(ended).not.toHaveBeenCalled();
      f.advance(2_000_000); await flush(512); f.player.tick(); await flush(256);
      expect(f.player.playbackPositionMs).toBe(3600); expect(ended).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      f.advance(4_000_000); await vi.advanceTimersByTimeAsync(1500); await flush(256);
      expect(ended).toHaveBeenCalledOnce(); expect(recovery).not.toHaveBeenCalled(); expect(stalled).not.toHaveBeenCalled();
    } finally { unobserve(); off(); await run?.destroy(); ticking.mockRestore(); vi.useRealTimers(); }
  });
});

describe('actor-originated LOC diagnostic retirement', () => {
  it.each([false, true])('brackets failed actor cleanup, including native cleanup throw=%s', async cleanupThrows => {
    const nested = true;
    const f = await fixture(22, false, true, { producingOutput: true, singleTimelineEntry: true });
    const stages: MediaStageObservation[] = [];
    const receipts: object[] = [];
    let retiredInputs = new Set<object>();
    let armed = false;
    let triggered = false;
    let successor: Promise<unknown> | undefined;
    const off = f.player.observeMediaStages(event => {
      stages.push(event);
      if (armed && nested && !triggered && event.stage === 'discarded' && event.unit === null
          && event.inputs.some(input => retiredInputs.has(input))) {
        triggered = true;
        successor = f.player.seek(2400).then(() => null, error => error);
      }
    }, { createTracker: createMediaDiagnostics });
    const unobserve = f.client.observeObjectReceipts(event => {
      if (event.origin !== 'group-end') receipts.push(event.receipt);
    });
    try {
      await f.player.seek(2000); await flush(128);
      const id = f.fetchIds[0]!;
      const points = [1000n, ...Array.from({ length: 24 }, (_, index) => 2100n + BigInt(index) * 200n)];
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 3n, object: BigInt(points.length - 1) } });
      const stream = await f.server.openFetchStream(id);
      for (const [index, timestamp] of points.entries()) {
        const extensions = encodeLocHeaders({ timestamp, timescale: 1000n,
          videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } },
          { wireProfile: locWireProfileForDraft(22), locVersion: 4 });
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index),
          publisherPriority: 128, extensions, payload: Uint8Array.of(0, 0, 0, 2, index === 0 ? 0x65 : 0x41, 0x88) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
      const held = stages.filter(event => event.stage === 'decoded'
        && !stages.some(other => other.unit === event.unit && other.stage === 'scheduled'));
      expect(held.length, 'real decoded outputs must be held before testing cleanup').toBeGreaterThan(0);
      retiredInputs = new Set(receipts);
      armed = true;
      const cleanupFailure = new Error('native decoder cleanup failed');
      if (cleanupThrows) f.outputs[0]!.decoder.destroy = vi.fn(() => { throw cleanupFailure; });
      f.outputs[0]!.decoder.onError?.(new Error('controlled native decode failure'));
      await flush(128);
      if (nested) {
        expect(triggered, 'a raw input retirement terminal must start the nested public seek').toBe(true);
        expect(await successor).toBeNull();
        expect(f.outputs).toHaveLength(2);
      }
      expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();
      for (const frame of f.outputs[0]!.frames) expect(frame.close).toHaveBeenCalledOnce();
      expect(f.errors).toHaveLength(1);
      expect(f.errors[0]).toContain('LOC seek media preparation failed');
      for (const output of held) {
        expect(stages.filter(event => event.unit === output.unit).map(event => event.stage))
          .toEqual(['decoded', 'discarded']);
      }
    } finally { unobserve(); off(); await f.destroy(); }
  });
});

describe.each([18, 22] as const)('paused LOC mapping evidence draft%i', draft => {
  it.each([
    { paused: false, inconsistent: true },
    { paused: true, inconsistent: true },
    { paused: true, inconsistent: false },
  ])('retains contradictory raw-anchor evidence across pause: %j', async ({ paused, inconsistent }) => {
    const f = await fixture(draft, false, true, { producingOutput: true });
    try {
      await f.player.seek(2000); await flush(128);
      await sendPreparedGroup(f, 0, 2100n);
      expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
      if (paused) f.player.pause();
      await f.updateTimeline([[inconsistent ? 1100 : 1000, [3, 0], 0]]);
      // Immediate refusal or refusal when resume prepares are both acceptable;
      // neither may silently decode a graph after discarding known conflict.
      if (paused && f.errors.length === 0) {
        f.player.play(); await flush(128);
        if (f.fetchIds.length > 1) await sendPreparedGroup(f, 1, 2100n);
      }
      if (inconsistent) {
        expect(f.errors, `known contradictory sample/index evidence must not vanish while paused; fresh draw count=${f.outputs[1]?.draw.mock.calls.length ?? 0}`).toHaveLength(1);
        expect(f.errors[0]).toMatch(/unit-rate.*mapping/i);
        if (f.outputs[1]) expect(f.outputs[1].decoder.decode).not.toHaveBeenCalled();
      } else {
        expect(f.errors).toEqual([]);
        expect(f.outputs[1]!.draw).toHaveBeenCalledOnce();
        expect(f.player.playbackPositionMs).toBe(2100);
      }
    } finally { await f.destroy(); }
  });
});


describe.each([18, 22] as const)('LOC negotiated historical profile draft%i', draft => {
  it.each([false, true])('uses the connected profile at startup and after historical preparation; omitted hint=%s', async omitted => {
    const f = await fixture(draft, false, true, { producingOutput: true, autoNegotiation: true,
      configuredDraft: omitted ? null : draft });
    try {
      expect(f.client.draftVersion).toBe(draft);
      const startup = await f.server.openSubgroup(200n, 1n, 0n, { hasExtensions: true, endOfGroup: true });
      const headers = (timestamp: bigint, independent: boolean) => encodeLocHeaders({ timestamp, timescale: 1000n,
        videoFrameMarking: { independent, startOfFrame: true, endOfFrame: true, discardable: false, baseLayerSync: false, temporalId: 0 } },
        { wireProfile: locWireProfileForDraft(draft), locVersion: 4 });
      await f.server.sendObject(startup, 0n, Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), headers(1000n, true));
      await f.server.closeSubgroup(startup); await flush(512); f.advance(1_000_000); await flush(256);
      expect(f.decoder.decode, 'ordinary routing must already decode the connected profile').toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
      await f.player.seek(2000); await flush(128);
      expect(f.fetchIds).toHaveLength(1); expect(f.seeked).not.toHaveBeenCalled();
      const id = f.fetchIds[0]!;
      await f.server.acceptFetch(id, { endOfTrack: 1, endLocation: { group: 4n, object: draft === 22 ? 0n : 1n } });
      const stream = await f.server.openFetchStream(id);
      for (const [groupId, objectId, timestamp] of [[3n, 0n, 1000n], [3n, 1n, 2100n], [4n, 0n, 3000n]] as const) {
        await f.server.sendFetchObject(stream, { groupId, subgroupId: 0n, objectId, publisherPriority: 128,
          extensions: headers(timestamp, objectId === 0n), payload: Uint8Array.of(0, 0, 0, 2, objectId === 0n ? 0x65 : 0x41, 0x88) });
      }
      await f.server.closeFetchStream(stream); await flush(512);
      expect(f.errors, 'historical input must use the connected profile too').toEqual([]);
      expect(vi.mocked(f.outputs[0]!.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp))
        .toEqual([1_000_000, 2_100_000, 3_000_000]);
      expect(f.outputs[0]!.draw).toHaveBeenCalled(); expect(f.seeked).toHaveBeenCalledOnce();
      expect(f.seeked.mock.calls[0]![0].actualTimeMs).toBe(2100);
    } finally { await f.destroy(); }
  });
});

// Real transport and shared sync, with modeled native decoding/output.
async function sendJumpMedia(f: Awaited<ReturnType<typeof fixture>>, group: bigint, offsetUs: bigint, audio = false) {
  const stream = await f.server.openSubgroup(audio ? 201n : 200n, group, 0n, { publisherPriority: 128, hasExtensions: true, endOfGroup: true });
  await f.server.sendObject(stream, 0n, audio ? Uint8Array.of(0xf8, 0xff, 0xfe) : Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
    encodeLocHeaders({ captureTimestamp: 1_000_000_000n + offsetUs,
      ...(!audio ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
    { wireProfile: locWireProfileForDraft(f.draft), locVersion: 1 }));
  await f.server.closeSubgroup(stream); await flush(128);
}

describe.each([18, 22] as const)('live jump ownership draft %i', draft => {
  it('keeps historical, finite, caller-range and retired observations out, with a live control', async () => {
    for (const mode of ['seek', 'finite', 'finite-update', 'range', 'headroom', 'pause', 'sync', 'pipeline', 'live'] as const) {
      const f = await fixture(draft, false, true, { isLive: mode !== 'finite', producingOutput: true,
        playerConfig: mode === 'range' ? { subscriptionFilter: { type: 'AbsoluteRange', startGroup: 0, endGroup: 100 } }
          : mode === 'headroom' ? { liveJumpThresholdMs: 100 } : {} });
      const jumps: unknown[] = [];
      f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
      // Narrow boundary cast: only owner replacement controls change graph identity.
      const graph = f.player as unknown as { syncController: SyncController; videoPipeline: PlaybackPipeline };
      try {
        await sendJumpMedia(f, 10n, 0n); f.advance(100_000);
        await sendJumpMedia(f, 11n, mode === 'headroom' ? 1_400_000n : 10_000_000n); f.advance(100_000);
        if (mode === 'seek') {
          await f.player.seek(2000); await flush(128);
          f.advance(1_200_000); expect(jumps).toEqual([]); // preparation owns playback
          await sendPreparedGroup(f, 0, 2100n, 2300n);
          f.advance(2_300_000); f.advance(3_400_000); // adopted history stays behind live
          expect(f.errors).toEqual([]); expect(f.seeked).toHaveBeenCalledOnce();
        } else if (mode === 'finite-update') {
          const stream = await f.server.openSubgroup(100n, 1n, 0n, { publisherPriority: 128 });
          await f.server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
            { name: 'video', packaging: 'loc', role: 'video', isLive: false, renderGroup: 1,
              codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000 },
            { name: 'timeline', packaging: 'mediatimeline', isLive: false, mimeType: 'application/json', depends: ['video'] },
          ] })));
          await f.server.closeSubgroup(stream); await flush(256);
        } else if (mode === 'pause') {
          f.player.pause(); f.player.play();
          graph.syncController.setVideoReference(1_000_000_000n);
        } else if (mode === 'sync') {
          graph.syncController = new SyncController({ clock: { now: () => 100_000 }, driftThresholdUs: 500_000 });
          graph.syncController.setVideoReference(1_000_000_000n);
        } else if (mode === 'pipeline') {
          // Replacement still shares the clock; stale observations must not transfer.
          graph.videoPipeline = new PlaybackPipeline({ mediaType: 'video', clock: { now: () => 100_000 },
            config: { gapTimeoutUs: 500_000, driftThresholdUs: 500_000, maxBufferDepth: 100 }, sync: graph.syncController, onCommand() {}, onEvent() {} });
        }
        if (mode !== 'seek') { f.advance(1_200_000); f.advance(2_300_000); }
        if (mode === 'live') {
          expect(jumps).toEqual([{ type: 'jump_to_live', trigger: 'latency', byMs: 8400 }]);
          expect(f.renderer.flush).toHaveBeenCalledOnce();
          expect(graph.syncController.computeAudioRenderTime(1_010_000_000n)!.offsetUs).toBe(-600_000);
        } else expect(jumps, mode).toEqual([]);
      } finally { await f.destroy(); }
    }
  });
});

it('flushes scheduled native audio and queued video, then schedules both on the advanced timeline', async () => {
  let nowUs = 100_000;
  const nodes: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const starts: number[] = [];
  const context = {
    state: 'running', destination: {}, get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (channel: number) => planes[channel]! };
    },
    createBufferSource() {
      const node = { buffer: null, onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {}, start(when: number) { starts.push(when); }, stop: vi.fn(() => node.onended?.()) };
      nodes.push(node); return node;
    },
  };
  const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, { now: () => nowUs });
  const schedules = vi.spyOn(output, 'schedule'), flushOutput = vi.spyOn(output, 'flush');
  const decoder: AudioDecoderLike = { configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk, time, input, timing) {
      decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: 960,
        copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, time, input,
      timing ? { context: timing, sourceOffsetUs: 0 } : undefined);
    }, async flush() {}, reset() {}, destroy() {} };
  const f = await fixture(18, true, true, { isLive: true,
    playerConfig: { createAudioDecoder: () => decoder, createAudioOutput: () => output } });
  f.decoder.decode = vi.fn((chunk, time, input, timing) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, input,
      timing ? { context: timing, sourceTimestamp: { ticks: BigInt(chunk.timestamp), ticksPerSecond: 1_000_000n, domain: 'unix' } } : undefined);
  });
  const jumps: unknown[] = [];
  f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  const advance = (us: number) => { nowUs = us; f.advance(us); };
  try {
    await sendJumpMedia(f, 10n, 0n, true); await sendJumpMedia(f, 10n, 0n); advance(100_000);
    await sendJumpMedia(f, 11n, 10_000_000n); advance(100_000); advance(1_200_000);
    expect(jumps).toEqual([]); // Every selected role must have received the excess.
    await sendJumpMedia(f, 11n, 10_000_000n, true); advance(1_200_000); advance(2_300_000);
    expect(jumps).toHaveLength(1);
    expect(flushOutput).toHaveBeenCalledTimes(2); expect(f.renderer.flush).toHaveBeenCalledOnce();
    expect(nodes[0]!.stop).toHaveBeenCalledOnce();
    await sendJumpMedia(f, 12n, 10_020_000n, true); await sendJumpMedia(f, 12n, 10_020_000n); advance(2_300_000);
    const audioTime = schedules.mock.calls.at(-1)![1];
    const videoTime = vi.mocked(f.renderer.enqueue).mock.calls.at(-1)![1];
    expect(audioTime).toBeCloseTo(videoTime, 6);
    expect(audioTime).toBeGreaterThan(nowUs); expect(audioTime).toBeLessThan(nowUs + 1_000_000);
    expect(starts.at(-1)! * 1_000_000).toBeCloseTo(audioTime, 6);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

// Delayed native completion models preserve the adapter's reset generation semantics.
it('keeps a delayed decoder completion aligned across the jump', async () => {
  let nowUs = 100_000;
  const nodes: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const starts: number[] = [];
  const context = {
    state: 'running', destination: {}, get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (channel: number) => planes[channel]! };
    },
    createBufferSource() {
      const node = { buffer: null, onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {}, start(when: number) { starts.push(when); }, stop: vi.fn(() => node.onended?.()) };
      nodes.push(node); return node;
    },
  };
  const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, { now: () => nowUs });
  const schedules = vi.spyOn(output, 'schedule'), flushOutput = vi.spyOn(output, 'flush');
  let generation = 0;
  let audioDecodes = 0; let pending: (() => void) | undefined;
  const decoder: AudioDecoderLike = { configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk, time, input, timing) {
      const admittedGeneration = generation;
      const deliver = () => { if (admittedGeneration !== generation) return; decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: 960,
        copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, time, input,
      timing ? { context: timing, sourceOffsetUs: 0 } : undefined); };
      if (++audioDecodes === 2) pending = deliver; else deliver();
    }, async flush() {}, reset() { generation++; }, destroy() { generation++; } };
  const f = await fixture(18, true, true, { isLive: true,
    playerConfig: { createAudioDecoder: () => decoder, createAudioOutput: () => output } });
  f.decoder.decode = vi.fn((chunk, time, input, timing) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, input,
      timing ? { context: timing, sourceTimestamp: { ticks: BigInt(chunk.timestamp), ticksPerSecond: 1_000_000n, domain: 'unix' } } : undefined);
  });
  const jumps: unknown[] = [];
  f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  const advance = (us: number) => { nowUs = us; f.advance(us); };
  try {
    await sendJumpMedia(f, 10n, 0n, true); await sendJumpMedia(f, 10n, 0n); advance(100_000);
    await sendJumpMedia(f, 11n, 4_500_000n); await sendJumpMedia(f, 11n, 4_500_000n, true);
    advance(100_000); advance(1_200_000);
    expect(pending).toBeDefined(); const before = schedules.mock.calls.length; pending!();
    expect(jumps).toHaveLength(1);
    expect(schedules.mock.calls.length, 'pre-jump completion cannot schedule').toBe(before);
    expect(flushOutput).toHaveBeenCalledTimes(2);
    await sendJumpMedia(f, 12n, 4_520_000n, true);
    await sendJumpMedia(f, 12n, 4_520_000n); advance(1_200_000);
    const audioTime = schedules.mock.calls.at(-1)![1];
    const videoTime = vi.mocked(f.renderer.enqueue).mock.calls.at(-1)![1];
    expect(starts.at(-1)! * 1_000_000).toBeCloseTo(audioTime, 6);
    expect(audioTime).toBeCloseTo(videoTime, 6);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

async function runDelayedAudio(options: { asyncAudio: boolean; excessUs: bigint; threshold?: number }) {
  let nowUs = 100_000;
  const starts: number[] = [];
  const context = {
    state: 'running', destination: {}, get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (channel: number) => planes[channel]! };
    },
    createBufferSource() {
      const node = { buffer: null, onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {}, start(when: number) { starts.push(when); }, stop: vi.fn(() => node.onended?.()) };
      return node;
    },
  };
  const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, { now: () => nowUs });
  const schedules = vi.spyOn(output, 'schedule');
  const pending: Array<() => void> = [];
  const decoder: AudioDecoderLike = { configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk, time, input, timing) {
      const emit = () => decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: 960,
        copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, time, input,
      timing ? { context: timing, sourceOffsetUs: 0 } : undefined);
      if (options.asyncAudio) pending.push(emit); else emit();
    }, async flush() {}, reset() { pending.length = 0; }, destroy() { pending.length = 0; } };
  const f = await fixture(18, true, true, { isLive: true,
    playerConfig: { createAudioDecoder: () => decoder, createAudioOutput: () => output,
      ...(options.threshold === undefined ? {} : { liveJumpThresholdMs: options.threshold }) } });
  f.decoder.decode = vi.fn((chunk, time, input, timing) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, input,
      timing ? { context: timing, sourceTimestamp: { ticks: BigInt(chunk.timestamp), ticksPerSecond: 1_000_000n, domain: 'unix' } } : undefined);
  });
  const jumps: unknown[] = [];
  f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  // Native output arrives in a later task than the tick that submitted the chunk.
  const advance = (us: number) => { nowUs = us; f.advance(us); for (const emit of pending.splice(0)) emit(); };
  try {
    const x = options.excessUs;
    await sendJumpMedia(f, 10n, 0n, true); await sendJumpMedia(f, 10n, 0n); advance(100_000);
    await sendJumpMedia(f, 11n, x, true); await sendJumpMedia(f, 11n, x); advance(1_200_000);
    // One more audio Object reaches the pipeline before the tick that jumps.
    await sendJumpMedia(f, 12n, x + 20_000n, true); await sendJumpMedia(f, 12n, x + 20_000n); advance(2_300_000);
    // First fresh media after that tick, the same capture on both roles.
    // Steady delivery afterwards: one A/V pair every 20 ms for 200 ms.
    for (let i = 0n; i < 10n; i++) {
      await sendJumpMedia(f, 13n + i, x + 40_000n + i * 20_000n, true); await sendJumpMedia(f, 13n + i, x + 40_000n + i * 20_000n);
      advance(2_310_000 + Number(i) * 20_000);
    }
    const capture = 1_000_000_000 + Number(x + 40_000n + 9n * 20_000n);
    const videoCall = vi.mocked(f.renderer.enqueue).mock.calls.find(call => (call[0] as { timestamp: number }).timestamp === capture)!;
    const audioIndex = schedules.mock.calls.findIndex(call => (call[0] as { timestamp: number }).timestamp === capture);
    expect(videoCall, 'video for the fresh capture was enqueued').toBeDefined();
    expect(audioIndex, 'audio for the fresh capture was scheduled').toBeGreaterThanOrEqual(0);
    const videoUs = videoCall[1] as number;
    expect(starts.length, 'every schedule started one source').toBe(schedules.mock.calls.length);
    const audioStartUs = starts[audioIndex]! * 1_000_000;
    return { jumps, videoUs, audioStartUs, skewMs: (audioStartUs - videoUs) / 1000, errors: [...f.errors] };
  } finally { await f.destroy(); }
}

it.each([6_000_000n, 10_000_000n])('keeps subsequent audio buffers aligned after delayed output at excess %s', async excessUs => {
  const delayed = await runDelayedAudio({ asyncAudio: true, excessUs });
  const synchronous = await runDelayedAudio({ asyncAudio: false, excessUs });
  for (const result of [delayed, synchronous]) {
    expect(result.jumps).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(Math.abs(result.skewMs)).toBeLessThan(20);
  }
  // Above five seconds the base has a separate scheduling clamp defect.
  if (excessUs === 6_000_000n) {
    const disabled = await runDelayedAudio({ asyncAudio: true, excessUs, threshold: 0 });
    expect(disabled.jumps).toEqual([]);
    expect(disabled.errors).toEqual([]);
    expect(Math.abs(disabled.skewMs)).toBeLessThan(250);
  }
});

it('waits five seconds between live jumps and reports whole milliseconds', async () => {
  const f = await fixture(18, false, true, { isLive: true });
  const jumps: Array<{ byMs?: number }> = [];
  f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  try {
    await sendJumpMedia(f, 10n, 0n); f.advance(100_000);
    await sendJumpMedia(f, 11n, 10_000_345n); f.advance(100_000); f.advance(1_200_000);
    expect(jumps).toHaveLength(1);
    await sendJumpMedia(f, 12n, 20_000_345n); f.advance(1_200_000);
    f.advance(2_300_000); expect(jumps).toHaveLength(1);
    f.advance(6_199_999); expect(jumps).toHaveLength(1);
    f.advance(6_200_000); expect(jumps).toHaveLength(2);
    expect(jumps[0]!.byMs).toBe(8400);
    expect(jumps.every(jump => Number.isInteger(jump.byMs))).toBe(true);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each(['backfill', 'fetched'] as const)('ignores %s timestamps, then jumps on ordinary live delivery', async origin => {
  const f = await fixture(18, false, true, { isLive: true });
  // Classify real routed objects at the delivery boundary without altering their timestamps.
  const manager = (f.player as unknown as { subscriptionManager: import('./subscription-manager.js').SubscriptionManager }).subscriptionManager;
  const deliver = manager.onObject!;
  const jumps: unknown[] = [];
  f.player.on('recovery_action', event => { if (event.action.type === 'jump_to_live') jumps.push(event.action); });
  try {
    await sendJumpMedia(f, 10n, 0n); f.advance(100_000);
    manager.onObject = (role, track, object, headers, input, delivery) =>
      deliver(role, track, object, headers, input, { ...delivery, [origin]: true });
    await sendJumpMedia(f, 11n, 10_000_000n); f.advance(100_000); f.advance(1_200_000);
    expect(jumps).toEqual([]);
    manager.onObject = deliver;
    await sendJumpMedia(f, 12n, 10_020_000n); f.advance(1_200_000); f.advance(2_300_000);
    expect(jumps).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { manager.onObject = deliver; await f.destroy(); }
});
