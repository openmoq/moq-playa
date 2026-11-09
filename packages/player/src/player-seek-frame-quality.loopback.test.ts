import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, videoInit, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { concat } from '../../locmaf/test-support/bytes.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture } from '../test-support/loc-seek.js';

type Fixture = Awaited<ReturnType<typeof locSeekFixture>>;
type Format = 'loc' | 'locmaf';
const namespace = ['live', 'show'];
const target = { name: 'alternate-video', namespace };
const cases = ([18, 22] as const).flatMap(draft => (['loc', 'locmaf'] as const).map(format => ({ draft, format })));
const videoPts = [1000n, 2500n, 2100n, 2600n];
const audioPts = [1000n, 2100n, 2500n, 2600n];

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function coded(key: boolean, marker: number) {
  return Uint8Array.of(0, 0, 0, 2, key ? 0x65 : 0x41, marker);
}
function objectBytes(f: Fixture, format: Format, index: number, marker: number, audio = false, point?: bigint, changedConfig = false) {
  if (format === 'loc' || audio) {
    const timestamp = point ?? (audio ? audioPts : videoPts)[index]!;
    return {
      payload: audio ? Uint8Array.of(0xf8, 0xff, 0xfe) : coded(index === 0, marker),
      extensions: encodeLocHeaders({ timestamp, timescale: 1000n,
        ...(changedConfig ? { videoConfig: Uint8Array.of(1, 100, 0, 41, 0xff, 0xe1, 0, 0, 1, 0) } : {}),
        ...(!audio ? { videoFrameMarking: { independent: index === 0, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
      { wireProfile: locWireProfileForDraft(f.draft), locVersion: 4 }),
    };
  }
  // DTS stays in decode order; the two middle pictures have reversed PTS.
  const dts = [90_000n, 189_000n, 225_000n, 234_000n][index]!;
  const duration = [99_000, 36_000, 9_000, 9_000][index]!;
  const cto = point === undefined ? [0, 36_000, -36_000, 0][index]! : Number(point * 90n - dts);
  const chunk = buildChunk({ bmdt: dts,
    samples: [{ duration, size: 6, flags: index === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS, cto }], mdat: coded(index === 0, marker) });
  const init = videoInit();
  if (changedConfig) {
    const avcc = init.findIndex((value, i) => value === 1 && init[i + 1] === 100 && init[i + 2] === 0 && init[i + 3] === 40 && init[i + 4] === 0xff);
    expect(avcc).toBeGreaterThan(0); init[avcc + 3] = 41;
  }
  return { payload: serializeLocmafObject({ kind: 'rawBoxes', boxes: index === 0 ? concat(init, chunk) : chunk }), extensions: undefined };
}
async function beginPrefix(f: Fixture, request: number) {
  const id = f.fetchIds[request]; expect(id, 'the SDK must have issued the historical FETCH').toBeDefined();
  await f.server.acceptFetch(id!, { endOfTrack: 1,
    endLocation: { group: 3n, object: f.draft === 22 ? 3n : 4n } });
  return f.server.openFetchStream(id!);
}
async function sendObject(f: Fixture, format: Format, stream: bigint, index: number, marker: number, audio = false, point?: bigint) {
  await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index), publisherPriority: 128,
    ...objectBytes(f, format, index, marker, audio, point) });
  await flush(128);
}
async function land(format: Format, draft: 18 | 22, audio = false) {
  const f = await locSeekFixture(draft, audio, true, { producingOutput: true, reorderVideoOutput: true,
    alternative: true, frameVideo: format === 'locmaf', frameAlternative: format === 'locmaf', catalogVersion: '1' });
  try {
    expect(f.player.seekable).toBe(true);
    expect(f.player.availableVideoTracks.map(track => track.name)).toContain(target.name);
    expect(f.timelineFormat()).toBe('msf-01');
    await f.player.seek(2000); await flush(128);
    expect(f.fetches.map(request => request.name)).toEqual(audio ? ['video', 'audio'] : ['video']);
    for (const [request, track] of f.fetches.entries()) {
      expect(track).toEqual({ namespace, name: track.name, group: 3n, object: 0n });
      const stream = await beginPrefix(f, request);
      try { for (let index = 0; index < 4; index++) await sendObject(f, format, stream, index, 0x88, track.name === 'audio'); }
      finally { await f.server.closeFetchStream(stream); }
    }
    await flush(512);
    expect(f.errors, 'owned first-sample timeline anchors and native preparation must be valid').toEqual([]);
    expect(f.seeked).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
    expect(f.player.state).toBe('playing'); expect(f.outputs).toHaveLength(1);
    const old = f.outputs[0]!;
    expect(vi.mocked(old.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp)).toEqual([1_000_000, 2_500_000, 2_100_000, 2_600_000]);
    expect(old.frames.map(frame => frame.timestamp)).toEqual([1_000_000, 2_100_000, 2_500_000, 2_600_000]);
    expect(old.draw).toHaveBeenCalledOnce(); expect(old.draw.mock.calls[0]![0].timestamp).toBe(2_100_000);
    f.player.setAutoQuality(true);
    return f;
  } catch (error) { await f.destroy(); throw error; }
}
function observeSelection(f: Fixture) {
  const switched = vi.fn(), switching = vi.fn();
  f.player.on('quality_switched', switched); f.player.on('quality_switching', switching);
  const hook = vi.fn(); f.player.hooks.beforeSubscribe.add(intent => { hook(intent); return intent; });
  const fetch = vi.spyOn(f.client, 'fetch'), subscribe = vi.spyOn(f.client, 'subscribe');
  const old = f.outputs[0]!;
  const rendererFlush = vi.spyOn(old.renderer, 'flush'), nativeFlush = vi.spyOn(old.decoder, 'flush');
  const reset = vi.mocked(old.decoder.reset), destroy = vi.mocked(old.decoder.destroy);
  const before = { rendererFlush: rendererFlush.mock.calls.length, nativeFlush: nativeFlush.mock.calls.length,
    reset: reset.mock.calls.length, destroy: destroy.mock.calls.length,
    fetches: f.fetches.length, requests: f.requests.length, graphs: f.outputs.length, audioGraphs: f.audioOutputs.length,
    errors: f.errors.slice(), selection: f.player.selection, seeked: f.seeked.mock.calls.length, seeking: f.seeking.mock.calls.length };
  return { switched, switching, hook, fetch, subscribe, old, rendererFlush, nativeFlush, reset, destroy, before };
}
function unchangedNative(f: Fixture, observation: ReturnType<typeof observeSelection>) {
  const { before } = observation;
  expect(observation.rendererFlush).toHaveBeenCalledTimes(before.rendererFlush);
  expect(observation.nativeFlush).toHaveBeenCalledTimes(before.nativeFlush);
  expect(observation.reset).toHaveBeenCalledTimes(before.reset); expect(observation.destroy).toHaveBeenCalledTimes(before.destroy);
  expect(f.seeked).toHaveBeenCalledTimes(before.seeked); expect(f.seeking).toHaveBeenCalledTimes(before.seeking);
}
async function refused(f: Fixture, observation: ReturnType<typeof observeSelection>, reference = target) {
  const error = await f.player.selectVideoTrack(reference).then(() => null, (failure: unknown) => failure);
  expect(error, 'unsupported positioned-frame selection must explicitly refuse').toBeInstanceOf(Error);
  await flush(256);
  expect(observation.hook).not.toHaveBeenCalled(); expect(observation.fetch).not.toHaveBeenCalled(); expect(observation.subscribe).not.toHaveBeenCalled();
  expect(observation.switched).not.toHaveBeenCalled(); expect(observation.switching).not.toHaveBeenCalled();
  expect(f.fetches).toHaveLength(observation.before.fetches); expect(f.requests).toHaveLength(observation.before.requests);
  expect(f.outputs).toHaveLength(observation.before.graphs); expect(f.audioOutputs).toHaveLength(observation.before.audioGraphs);
  expect(f.player.selection).toEqual(observation.before.selection); expect(f.errors).toEqual(observation.before.errors);
  unchangedNative(f, observation);
  return error as Error;
}

async function publishCatalog(f: Fixture, format: Format, targetChanges: Record<string, unknown> = {}, depends = ['video', target.name]) {
  const video = { name: 'video', packaging: format, role: 'video', isLive: false, renderGroup: 1, altGroup: 1,
    codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000,
    ...(format === 'locmaf' ? { initRef: 'video-init', locmafVersion: '0.3' } : {}) };
  const catalog = { version: '1',
    ...(format === 'locmaf' ? { initDataList: [{ id: 'video-init', type: 'inline', data: Buffer.from(videoInit()).toString('base64') }] } : {}),
    tracks: [video, { ...video, name: target.name, bitrate: 100000, ...targetChanges },
      { name: 'timeline', packaging: 'mediatimeline', isLive: false, mimeType: 'application/json', depends }] };
  const stream = await f.server.openSubgroup(100n, 1n, 0n, { publisherPriority: 128 });
  try { await f.server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify(catalog))); }
  finally { await f.server.closeSubgroup(stream); }
  await flush(512);
}
function selecting(f: Fixture) {
  const state: { result?: 'success' | Error; settlements: number } = { settlements: 0 };
  const done = f.player.selectVideoTrack(target).then(() => { state.result = 'success'; state.settlements++; },
    error => { state.result = error as Error; state.settlements++; });
  return { state, done };
}
async function admitted(f: Fixture) {
  const operation = selecting(f); await flush(512);
  expect(operation.state.result, 'the quality operation must reach target preparation').toBeUndefined();
  expect(f.fetches.at(-1)).toEqual({ namespace, name: target.name, group: 3n, object: 0n });
  expect(f.player.selection.autoQuality).toBe(true);
  return operation;
}
async function completeTarget(f: Fixture, format: Format, stream: bigint, missingTarget = false) {
  for (let i = 0; i < 4; i++) await sendObject(f, format, stream, i, 0x99, false, missingTarget && i === 2 ? 2200n : undefined);
  await f.server.closeFetchStream(stream); await flush(512);
}
function locOwner(f: Fixture) {
  return (f.player as unknown as { activeLocSeek: {
    quality?: { pending: boolean; preparation?: unknown; previous?: unknown; validate?: unknown };
    initialDispatcher?: unknown;
    playback: { options: { tracks: readonly { seed: object }[]; borrowed?: unknown }; borrowed?: unknown };
  }; preparingLocSeek: { quality: { pending: boolean; preparation?: unknown; previous?: unknown; validate?: unknown } } | null });
}

describe.each(cases)('paused frame rendition selection draft$draft / $format', ({ draft, format }) => {
  it('prepares the alternate from the owned index and preserves the paused 2100 ms preview', async () => {
    const f = await land(format, draft); let stream: bigint | undefined;
    try {
      f.player.pause(); await flush(256);
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      const observation = observeSelection(f);
      const state: { failure?: unknown } = {};
      const selecting = f.player.selectVideoTrack(target);
      void selecting.catch(error => { state.failure = error; });
      await flush(512);
      expect(state.failure, 'a paused video-only frame owner with an owned common index must enter preparation').toBeUndefined();
      expect(f.fetches.slice(observation.before.fetches)).toEqual([{ namespace, name: target.name, group: 3n, object: 0n }]);
      expect(f.requests.filter(request => request.name === target.name)).toEqual([]);
      expect(observation.switched).not.toHaveBeenCalled(); unchangedNative(f, observation);
      expect(f.player.selection.video?.name).toBe('video'); expect(f.player.playbackPositionMs).toBe(2100);
      stream = await beginPrefix(f, observation.before.fetches);
      await sendObject(f, format, stream, 0, 0x99);
      await sendObject(f, format, stream, 1, 0x99);
      await sendObject(f, format, stream, 2, 0x99);
      expect(observation.switched).not.toHaveBeenCalled(); unchangedNative(f, observation);
      expect(f.player.selection.video?.name).toBe('video'); expect(f.player.state).toBe('paused');
      expect(f.player.playbackPositionMs).toBe(2100);
      for (const candidate of f.outputs.slice(observation.before.graphs)) expect(candidate.draw).not.toHaveBeenCalled();
      await sendObject(f, format, stream, 3, 0x99);
      await f.server.closeFetchStream(stream); stream = undefined; await flush(512);
      await selecting; await flush(256);
      expect(f.errors).toEqual([]); expect(f.outputs).toHaveLength(observation.before.graphs + 1);
      const adopted = f.outputs.at(-1)!;
      expect(adopted).not.toBe(observation.old); expect(adopted.draw).toHaveBeenCalledOnce();
      expect(adopted.draw.mock.calls[0]![0].timestamp).toBe(2_100_000);
      expect(vi.mocked(adopted.decoder.decode).mock.calls.map(([chunk]) => chunk.timestamp)).toEqual([1_000_000, 2_500_000, 2_100_000, 2_600_000]);
      expect(vi.mocked(adopted.decoder.decode).mock.calls.every(([chunk]) => chunk.data.at(-1) === 0x99)).toBe(true);
      expect(adopted.frames.map(frame => frame.timestamp)).toEqual([1_000_000, 2_100_000, 2_500_000, 2_600_000]);
      expect(f.player.selection.video).toEqual({ name: target.name, namespaceFields: namespace });
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      expect(observation.switched).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ toTrackName: target.name }));
      expect(f.seeked).toHaveBeenCalledTimes(observation.before.seeked); expect(f.seeking).toHaveBeenCalledTimes(observation.before.seeking);
      expect(observation.old.draw).toHaveBeenCalledOnce();
      expect(observation.destroy).toHaveBeenCalledTimes(observation.before.destroy + 1);
    } finally {
      if (stream !== undefined) { try { await f.server.closeFetchStream(stream); } catch { /* Request retirement may already own closure. */ } }
      await f.destroy();
    }
  });

  it('refuses a running positioned video owner without starting candidate work', async () => {
    const f = await land(format, draft);
    try { const observation = observeSelection(f); expect((await refused(f, observation)).message).toMatch(/paused video-only/); expect(f.player.state).toBe('playing'); expect(f.player.playbackPositionMs).toBe(2100); }
    finally { await f.destroy(); }
  });

  it('refuses a paused audio/video owner without replacing either output graph', async () => {
    const f = await land(format, draft, true);
    try {
      f.player.pause(); await flush(256); expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.audioOutputs).toHaveLength(1);
      const observation = observeSelection(f); expect((await refused(f, observation)).message).toMatch(/video-only/);
      expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
    } finally { await f.destroy(); }
  });

  it('refuses after losing the declaring session instead of manufacturing a replacement timeline', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); await f.disconnect(); expect(f.player.seekable).toBe(false);
      const observation = observeSelection(f); await refused(f, observation);
    } finally { await f.destroy(); }
  });

  it('refuses a target outside the owned declaring timeline namespace', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(256); expect(f.player.state).toBe('paused'); expect(f.player.playbackPositionMs).toBe(2100);
      const updated = vi.fn(); f.player.on('catalog_updated', updated);
      const oldTrack = { name: 'video', packaging: format, role: 'video', isLive: false, renderGroup: 1, altGroup: 1,
        codec: 'avc1.640028', width: 640, height: 360, bitrate: 500000,
        ...(format === 'locmaf' ? { initRef: 'video-init', locmafVersion: '0.3' } : {}) };
      const catalog = { version: '1',
        ...(format === 'locmaf' ? { initDataList: [{ id: 'video-init', type: 'inline', data: Buffer.from(videoInit()).toString('base64') }] } : {}),
        tracks: [oldTrack, { ...oldTrack, name: target.name, namespace: 'other/rendition', bitrate: 100000 },
          { name: 'timeline', packaging: 'mediatimeline', isLive: false, mimeType: 'application/json', depends: ['video', target.name] }] };
      const stream = await f.server.openSubgroup(100n, 1n, 0n, { publisherPriority: 128 });
      try { await f.server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify(catalog))); }
      finally { await f.server.closeSubgroup(stream); }
      await flush(512);
      expect(updated).toHaveBeenCalledOnce();
      expect(updated.mock.calls[0]![0].catalog.tracks.find((track: { name: string }) => track.name === target.name).namespace).toBe('other/rendition');
      expect(f.player.selection.video?.namespaceFields).toEqual(namespace); expect(f.player.seekable).toBe(true);
      expect(f.player.playbackPositionMs).toBe(2100); expect(f.errors).toEqual([]);
      const observation = observeSelection(f);
      expect((await refused(f, observation, { name: target.name, namespace: ['other', 'rendition'] })).message).toMatch(/common media timeline/);
    } finally { await f.destroy(); }
  });

  it('refuses a changed target profile without locking manual quality', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); await publishCatalog(f, format, { width: 320 });
      const observation = observeSelection(f);
      expect((await refused(f, observation)).message).toMatch(/configuration/);
      expect(f.player.selection.autoQuality).toBe(true);
    } finally { await f.destroy(); }
  });

  it('rejects a target with no picture at the held nominal content position', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f);
      const operation = await admitted(f); const stream = await beginPrefix(f, observation.before.fetches);
      await completeTarget(f, format, stream, true);
      expect(operation.state.result).toBeInstanceOf(Error);
      expect((operation.state.result as Error).message).toMatch(/position/);
      await operation.done; expect(operation.state.settlements).toBe(1);
      expect(f.player.selection).toEqual(observation.before.selection); expect(f.player.playbackPositionMs).toBe(2100);
      expect(observation.switched).not.toHaveBeenCalled(); unchangedNative(f, observation);
      expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('rechecks declaring index coverage after the target FETCH was admitted', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f);
      const operation = await admitted(f); const stream = await beginPrefix(f, observation.before.fetches);
      await publishCatalog(f, format, {}, ['video']);
      await completeTarget(f, format, stream);
      expect(operation.state.result).toBeInstanceOf(Error);
      expect((operation.state.result as Error).message).toMatch(/common media timeline/);
      await operation.done; expect(operation.state.settlements).toBe(1);
      expect(f.player.selection).toEqual(observation.before.selection); unchangedNative(f, observation);
      expect(observation.switched).not.toHaveBeenCalled(); expect(f.player.playbackPositionMs).toBe(2100);
    } finally { await f.destroy(); }
  });

  it('refuses an actual target decoder configuration that contradicts its admitted profile', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f); const operation = await admitted(f);
      const stream = await beginPrefix(f, observation.before.fetches);
      for (let i = 0; i < 4 && operation.state.result === undefined; i++) {
        await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(i), publisherPriority: 128,
          ...objectBytes(f, format, i, 0x99, false, undefined, i === 0) });
        await flush(128);
      }
      if (operation.state.result === undefined) await f.server.closeFetchStream(stream);
      await flush(512);
      expect(operation.state.result).toBeInstanceOf(Error); expect((operation.state.result as Error).message).toMatch(/configuration/);
      await operation.done; expect(operation.state.settlements).toBe(1);
      expect(f.player.selection).toEqual(observation.before.selection); unchangedNative(f, observation);
      expect(observation.switched).not.toHaveBeenCalled(); expect(f.player.playbackPositionMs).toBe(2100);
    } finally { await f.destroy(); }
  });

  it.each(['destroy', 'session close', 'seek'] as const)('settles pending target preparation on %s', async action => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f); const operation = await admitted(f);
      if (action === 'destroy') await f.player.destroy();
      else if (action === 'session close') await f.disconnect();
      else await f.player.seek(2100);
      await flush(512);
      expect(operation.state.result).toBeInstanceOf(Error); await operation.done;
      expect(operation.state.settlements).toBe(1); expect(observation.switched).not.toHaveBeenCalled();
      expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();
      if (action === 'seek') { expect(f.outputs[2]!.decoder.destroy).not.toHaveBeenCalled(); expect(f.player.playbackPositionMs).toBe(2100); }
    } finally { await f.destroy(); }
  });

  it('rechecks admission after a target hook destroys playback', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f); let destruction: Promise<void> | undefined;
      f.player.hooks.beforeSubscribe.add(intent => {
        if (intent.trackName === target.name) destruction = f.player.destroy();
        return intent;
      });
      const operation = selecting(f); await flush(512);
      expect(destruction).toBeDefined(); await destruction; await operation.done;
      expect(operation.state.result).toBeInstanceOf(Error); expect(operation.state.settlements).toBe(1);
      expect(f.fetches).toHaveLength(observation.before.fetches); expect(f.outputs).toHaveLength(1);
      expect(observation.destroy).toHaveBeenCalledOnce(); expect(observation.switched).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it.each(['destroy', 'seek', 'play'] as const)('retires the captured old graph across selection publication reentry: %s', async action => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f); let followup: Promise<void> | undefined, entered = false;
      f.player.on('selection_changed', event => {
        if (entered || event.selection.video?.name !== target.name) return;
        entered = true;
        if (action === 'destroy') followup = f.player.destroy();
        else if (action === 'seek') followup = f.player.seek(2100);
        else f.player.play();
      });
      const operation = await admitted(f); const stream = await beginPrefix(f, observation.before.fetches);
      await completeTarget(f, format, stream); expect(entered).toBe(true); await followup;
      expect(operation.state.result).toBeInstanceOf(Error); expect(operation.state.settlements).toBe(1);
      await operation.done; expect(observation.destroy).toHaveBeenCalledOnce();
      expect(observation.old.frames.every(frame => frame.close.mock.calls.length === 1)).toBe(true);
      if (action === 'destroy') expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();
      else {
        expect(f.outputs[2]!.decoder.destroy).not.toHaveBeenCalled(); expect(f.player.selection.video?.name).toBe(target.name);
        expect(f.outputs[1]!.draw, 'the superseded unpositioned candidate must not draw over its successor').not.toHaveBeenCalled();
      }
      expect(observation.switched).not.toHaveBeenCalled(); expect(f.seeked).toHaveBeenCalledTimes(observation.before.seeked);
    } finally { await f.destroy(); }
  });

  it.each(['present', 'play'] as const)('keeps the quality result owned between adoption and the actual draw: %s', async action => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f); const operation = await admitted(f);
      const candidate = f.outputs[1]!;
      const render = vi.spyOn(candidate.renderer as { renderTick(now: number): void }, 'renderTick').mockImplementation(() => {});
      const stream = await beginPrefix(f, observation.before.fetches); await completeTarget(f, format, stream);
      expect(f.player.selection.video?.name).toBe(target.name); expect(observation.destroy).toHaveBeenCalledOnce();
      expect(candidate.draw).not.toHaveBeenCalled(); expect(operation.state.result).toBeUndefined(); expect(observation.switched).not.toHaveBeenCalled();
      render.mockRestore();
      if (action === 'present') {
        f.advance(100_000); await flush(256); await operation.done;
        expect(operation.state.result).toBe('success'); expect(candidate.draw).toHaveBeenCalledOnce();
        expect(observation.switched).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
      } else {
        f.player.play(); await flush(512);
        expect(operation.state.result).toBeInstanceOf(Error); await operation.done;
        expect(f.fetches.at(-1)?.name).toBe(target.name); expect(observation.switched).not.toHaveBeenCalled();
        expect(observation.destroy).toHaveBeenCalledOnce();
      }
      expect(operation.state.settlements).toBe(1); expect(f.seeked).toHaveBeenCalledTimes(observation.before.seeked);
    } finally { await f.destroy(); }
  });

  it('keeps successful preview ownership when selection and quality observers throw', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f);
      const selectionListener = vi.fn(() => { throw new Error('selection observer'); });
      const qualityListener = vi.fn(() => { throw new Error('quality observer'); });
      f.player.on('selection_changed', selectionListener); f.player.on('quality_switched', qualityListener);
      const operation = await admitted(f); const stream = await beginPrefix(f, observation.before.fetches);
      await completeTarget(f, format, stream); await operation.done;
      expect(operation.state.result).toBe('success'); expect(operation.state.settlements).toBe(1);
      expect(selectionListener).toHaveBeenCalledOnce(); expect(qualityListener).toHaveBeenCalledOnce();
      expect(observation.switched).toHaveBeenCalledOnce(); expect(f.outputs[1]!.draw).toHaveBeenCalledOnce();
      expect(observation.destroy).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('resumes the adopted rendition using its own observed source-position proof', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const observation = observeSelection(f); const operation = await admitted(f);
      await completeTarget(f, format, await beginPrefix(f, observation.before.fetches)); await operation.done;
      expect(operation.state.result).toBe('success'); expect(f.player.selection.autoQuality).toBe(false);
      f.player.play(); await flush(512);
      expect(f.fetches.at(-1)).toEqual({ namespace, name: target.name, group: 3n, object: 0n });
      await completeTarget(f, format, await beginPrefix(f, f.fetches.length - 1)); f.advance(700_000); await flush(256);
      expect(f.player.state).toBe('playing'); expect(f.player.playbackPositionMs).toBe(2600);
      expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce(); expect(f.outputs[2]!.decoder.destroy).not.toHaveBeenCalled();
      expect(observation.switched).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
      expect(f.seeking).toHaveBeenCalledTimes(observation.before.seeking); expect(f.seeked).toHaveBeenCalledTimes(observation.before.seeked);
    } finally { await f.destroy(); }
  });

  it('releases terminal quality validation and predecessor ownership across repeated public swaps', async () => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128);
      for (const name of [target.name, 'video', target.name]) {
        const before = f.fetches.length;
        const predecessor = locOwner(f).activeLocSeek; let settled = false;
        const done = f.player.selectVideoTrack({ name, namespace }); void done.then(() => { settled = true; }, () => { settled = true; }); await flush(512);
        expect(f.fetches.at(-1)?.name).toBe(name);
        const pending = locOwner(f).preparingLocSeek!.quality;
        expect(settled).toBe(false);
        await completeTarget(f, format, await beginPrefix(f, before)); await done;
        expect(f.outputs.at(-1)!.draw).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
        expect(settled).toBe(true);
        expect.soft(pending.previous, 'the terminal holder must not retain this exact predecessor').not.toBe(predecessor);
        expect.soft(pending.validate, 'terminal validation must not retain the old admission environment').not.toBeTypeOf('function');
        expect.soft(pending.preparation, 'terminal callback holder must release its validation environment').toBeNull();
        expect.soft(pending).not.toHaveProperty('previous'); expect.soft(pending).not.toHaveProperty('validate');
      }
    } finally { await f.destroy(); }
  });

  it.each(['seek', 'quality'] as const)('projects seed values and releases acquisition-only resources after public %s', async action => {
    const f = await land(format, draft);
    try {
      f.player.pause(); await flush(128); const before = f.fetches.length;
      let done: Promise<void>;
      if (action === 'seek') { done = f.player.seek(2100); await done; await flush(512); }
      else { done = f.player.selectVideoTrack(target); void done.catch(() => {}); await flush(512); }
      await completeTarget(f, format, await beginPrefix(f, before)); await done;
      expect(f.outputs.at(-1)!.draw).toHaveBeenCalledOnce(); expect(f.player.playbackPositionMs).toBe(2100);
      const owner = locOwner(f).activeLocSeek;
      expect.soft(owner.playback.options.tracks[0]!.seed, 'a live playback seed must not own its predecessor dispatcher').not.toHaveProperty('dispatcher');
      expect.soft(owner.playback.options, 'the long-lived options must not own the borrowed graph').not.toHaveProperty('borrowed');
      expect.soft(owner.playback.borrowed, 'factory acquisition has finished').toBeNull();
      expect.soft(owner.initialDispatcher, 'preparation-only engine dispatcher proof has finished').toBeNull();
    } finally { await f.destroy(); }
  });
});

describe.each(cases)('publication boundary draft$draft / $format', ({ draft, format }) => {
  it.each(['play', 'destroy'] as const)('settles exactly once when quality_switching synchronously calls %s', async action => {
    const f = await land(format, draft);
    let cleanup: Promise<void> | undefined;
    try {
      f.player.pause(); await flush(128);
      const observation = observeSelection(f);
      f.player.on('quality_switching', () => {
        if (action === 'play') f.player.play();
        else cleanup = f.player.destroy();
      });
      const operation = selecting(f);
      await flush(512); await operation.done; await cleanup;
      expect(operation.state.result).toBeInstanceOf(Error);
      expect(operation.state.settlements).toBe(1);
      expect(observation.switched).not.toHaveBeenCalled();
      expect(f.fetches.filter(request => request.name === target.name)).toEqual([]);
      expect(f.errors).toEqual([]);
      if (action === 'play') {
        expect(f.player.state).toBe('playing');
        expect(f.player.selection.video?.name).toBe('video');
        expect(observation.destroy).not.toHaveBeenCalled();
      } else expect(observation.destroy).toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('allows a new quality from quality_switched without retaining or disturbing its predecessor', async () => {
    const f = await land(format, draft);
    const state: { result?: 'success' | Error; settlements: number } = { settlements: 0 };
    let successor: Promise<void> | undefined;
    try {
      f.player.pause(); await flush(128);
      const observation = observeSelection(f);
      f.player.on('quality_switched', event => {
        if (event.toTrackName !== target.name) return;
        successor = f.player.selectVideoTrack({ name: 'video', namespace }).then(() => {
          state.result = 'success'; state.settlements++;
        }, error => { state.result = error as Error; state.settlements++; });
      });
      const first = await admitted(f);
      await completeTarget(f, format, await beginPrefix(f, observation.before.fetches));
      await first.done;
      expect(first.state.result).toBe('success'); expect(first.state.settlements).toBe(1);
      expect(f.fetches.at(-1)?.name).toBe('video'); expect(state.result).toBeUndefined();
      expect(f.outputs[1]!.decoder.destroy).not.toHaveBeenCalled();
      await completeTarget(f, format, await beginPrefix(f, f.fetches.length - 1));
      await successor;
      expect(state.result).toBe('success'); expect(state.settlements).toBe(1);
      expect(f.player.selection.video?.name).toBe('video');
      expect(f.player.playbackPositionMs).toBe(2100);
      expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();
      expect(f.outputs[2]!.decoder.destroy).not.toHaveBeenCalled();
      expect(f.outputs[2]!.draw).toHaveBeenCalledOnce();
      expect(locOwner(f).activeLocSeek.quality?.preparation).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
