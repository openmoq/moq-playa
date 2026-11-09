import type { Fact } from '../../devtools-protocol/src/index.js';
import { describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { encodeObjectDatagram18 } from '@openmoq/transport';
import { serializeLocmafObject, parseLocmafTrackContext, codecDescriptionFromInit } from '@openmoq/locmaf';
import { videoInit, audioInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import { createMediaDiagnostics } from './media-diagnostics.js';
import type { MediaStageObservation, MediaDiagnosticsFactory } from './media-diagnostic-types.js';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike, VideoFrameObserver, AudioScheduleObserver } from './interfaces.js';

async function fixture(options: { observed?: boolean; dropToken?: boolean; transform?: boolean; frameLocmaf?: boolean; deferred?: boolean; unobservable?: boolean; alternative?: boolean; oneUnit?: boolean } = {}) {
  const { a, b } = createLoopback(), client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const requests: Array<{ id: bigint; name: string }> = [];
  server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
  const nativeOutputs: Array<() => void> = [];
  const frames = new Set<VideoFrameObserver>(), schedules = new Set<AudioScheduleObserver>();
  const video: VideoDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null,
    decode: vi.fn((chunk, time, input) => { const emit = () => video.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, null, options.dropToken ? undefined : input);
      if (options.deferred) nativeOutputs.push(emit); else emit(); }) };
  const audio: AudioDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null,
    decode: vi.fn((chunk, time, input) => { const emit = () => audio.onData?.({ timestamp: chunk.timestamp, close() {} }, time, options.dropToken ? undefined : input);
      if (options.deferred) nativeOutputs.push(emit); else emit(); }) };
  const renderer: VideoRendererLike = { flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null,
    enqueue: vi.fn((_frame, _time, token) => { if (token) for (const observe of [...frames]) {
      observe({ token, state: 'scheduled', reason: null }); observe({ token, state: 'presented', reason: null });
    } }), observeFrames(observe) { frames.add(observe); return () => { frames.delete(observe); }; } };
  const output: AudioOutputLike = { flush() {}, destroy() {}, currentPlayoutTimeUs: 0,
    schedule: vi.fn((_data, _time, token) => { if (token) for (const observe of [...schedules]) {
      observe({ token, state: 'scheduled', reason: null }); observe({ token, state: 'released', reason: null });
    } }), observeSchedules(observe) { schedules.add(observe); return () => { schedules.delete(observe); }; } };
  if (options.unobservable) { delete renderer.observeFrames; delete output.observeSchedules; }
  const createVideo = vi.fn(() => video), createRenderer = vi.fn(() => renderer);
  let serving: Promise<void> | undefined, clock = 1_000_000;
  const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: 18, maxBufferDepth: 2048, clock: { now: () => clock },
    createConnection: () => client, createTransport: async () => { serving = server.connect(b); void serving.catch(() => {}); return a; },
    ...(options.frameLocmaf ? { locmafDecoding: 'frame' as const } : {}),
    createVideoDecoder: createVideo, createAudioDecoder: () => audio, createRenderer, createAudioOutput: () => output,
    ...(options.transform ? { objectTransform: async obj => obj.kind === 'data' ? { ...obj, payload: obj.payload.slice() } : { ...obj } } : {}),
    catalog: { tracks: [
      { name: 'v', packaging: options.frameLocmaf ? 'locmaf' : 'loc', role: 'video', isLive: true, codec: 'avc1.4D4028', ...(options.alternative ? { altGroup: 7, bitrate: 100 } : {}),
        ...(options.frameLocmaf ? { locmafVersion: '0.3', initData: Buffer.from(videoInit()).toString('base64') } : {}) },
      ...(options.alternative ? [{ name: 'v2', packaging: 'loc' as const, role: 'video' as const, isLive: true, codec: 'avc1.640028', altGroup: 7, bitrate: 200, initData: Buffer.from(codecDescriptionFromInit(videoInit())!).toString('base64') }] : []),
      { name: 'a', packaging: options.frameLocmaf ? 'locmaf' : 'loc', role: 'audio', isLive: true, codec: options.frameLocmaf ? 'mp4a.40.2' : 'opus', samplerate: 48000, channelConfig: '2',
        ...(options.frameLocmaf ? { locmafVersion: '0.3', initData: Buffer.from(audioInit()).toString('base64') } : {}) },
    ] },
  });
  const events: MediaStageObservation[] = [], receipts: Array<{ alias: bigint; token: object }> = [];
  const trackerFactory: MediaDiagnosticsFactory = options.oneUnit ? (host, emit) => createMediaDiagnostics(host, emit, { maxUnits: 1 }) : createMediaDiagnostics;
  const remove = options.observed === false ? () => {} : player.observeMediaStages(e => { events.push(e); }, { createTracker: trackerFactory });
  const off = client.observeObjectReceipts(e => { if (e.origin !== 'group-end' && e.origin !== 'fetch') receipts.push({ alias: e.trackAlias, token: e.receipt }); });
  await player.load(); await flush(128);
  for (const request of requests) await server.acceptSubscribe(request.id, request.name === 'v' ? 77n : 78n);
  await flush(128);
  async function send(type: 'video' | 'audio', datagram = false, objectId = 0n, replacement = false) {
    const alias = replacement ? 79n : type === 'video' ? 77n : 78n;
    const extensions = encodeLocHeaders({ captureTimestamp: BigInt(clock) + objectId * 20_000n,
      ...(type === 'video' ? { videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: true, discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { wireProfile: locWireProfileForDraft(18) });
    let payload: Uint8Array = type === 'video' ? Uint8Array.of(0, 0, 0, 1, 0x65) : Uint8Array.of(0x48, 0);
    if (options.frameLocmaf) {
      const context = parseLocmafTrackContext(type === 'video' ? videoInit() : audioInit());
      const mdat = new Uint8Array([...payload, ...payload]);
      payload = serializeLocmafObject({ kind: 'rawBoxes', boxes: buildChunk({ trackId: context.trackId, bmdt: context.timescale,
        samples: [{ duration: 1000, size: payload.length, flags: SYNC_FLAGS }, { duration: 1000, size: payload.length, flags: SYNC_FLAGS }], mdat }) });
    }
    if (datagram) {
      const writer = b.datagrams.writable!.getWriter(); try {
        await writer.write(encodeObjectDatagram18({ typeByte: 0x01, trackAlias: alias, groupId: 2n, objectId,
          publisherPriority: 128, payload, extensions, status: undefined, isEndOfGroup: false }));
      } finally { writer.releaseLock(); }
    } else {
      const stream = await server.openSubgroup(alias, replacement ? 3n : 2n, 0n, { publisherPriority: 128, hasExtensions: true });
      await server.sendObject(stream, objectId, payload, extensions);
    }
    await flush(128);
  }
  function tick() { for (let i = 0; i < 8; i++) { clock += 20_000; player.tick(); } }
  return { player, client, video, audio, renderer, output, events, receipts, remove, send, tick, createVideo, createRenderer,
    async acceptAlternative() {
      await flush(128); const next = requests.find(r => r.name === 'v2'); if (!next) throw Error('No alternative request');
      await server.acceptSubscribe(next.id, 79n); await flush(128);
    }, flushNative() { for (const emit of nativeOutputs.splice(0)) emit(); },
    async fillVideo(count: number) {
      const stream = await server.openSubgroup(77n, 2n, 0n, { hasExtensions: true });
      for (let i = 0; i < count; i++) await server.sendObject(stream, BigInt(i), Uint8Array.of(0, 0, 0, 1, 0x65),
        encodeLocHeaders({ captureTimestamp: BigInt(1_000_000 + i * 20_000) }, { wireProfile: locWireProfileForDraft(18) }));
      await flush(128);
    },
    async close() { off(); remove(); await player.destroy(); await server.close(); await serving?.catch(() => {}); } };
}

describe('real player LOC receipt to output chain', () => {
  it.each([false, true])('preserves exact video/audio receipt identity through real transport (datagrams=%s)', async datagram => {
    const f = await fixture(); try {
      await f.send('audio', datagram); await f.send('video', datagram); f.tick();
      expect(f.video.decode).toHaveBeenCalled(); expect(f.audio.decode).toHaveBeenCalled();
      const video = f.events.filter(e => e.inputs.includes(f.receipts.find(r => r.alias === 77n)!.token));
      const audio = f.events.filter(e => e.inputs.includes(f.receipts.find(r => r.alias === 78n)!.token));
      expect(video.map(e => e.stage)).toEqual(['decoded', 'scheduled', 'presented']);
      expect(audio.map(e => e.stage)).toEqual(['decoded', 'scheduled']);
      expect(new Set(video.map(e => e.unit)).size).toBe(1); expect(new Set(audio.map(e => e.unit)).size).toBe(1);
      expect(f.player.diagnosticSnapshot().mediaStages?.evidenceLossCount).toBe(0);
    } finally { await f.close(); }
  });
  it('captures before an asynchronous transform replaces the routed object', async () => {
    const f = await fixture({ transform: true }); try {
      await f.send('audio'); await f.send('video'); f.tick();
      expect(f.events.filter(e => e.stage === 'decoded').map(e => e.inputs[0])).toEqual(f.receipts.map(r => r.token));
    } finally { await f.close(); }
  });
  it('keeps media running with legacy callback arity when diagnostics are not installed', async () => {
    const f = await fixture({ observed: false }); try {
      await f.send('audio'); await f.send('video'); f.tick();
      expect(vi.mocked(f.video.decode).mock.calls[0]).toHaveLength(2);
      expect(vi.mocked(f.renderer.enqueue).mock.calls[0]).toHaveLength(2);
      expect(vi.mocked(f.output.schedule).mock.calls[0]).toHaveLength(2); expect(f.events).toEqual([]);
    } finally { await f.close(); }
  });
  it('detaching before buffered media is decoded removes its metadata, never its playback', async () => {
    const f = await fixture(); try {
      await f.send('audio'); await f.send('video'); f.remove(); f.tick();
      expect(f.video.decode).toHaveBeenCalled(); expect(f.renderer.enqueue).toHaveBeenCalled();
      expect(f.events).toEqual([]); expect(vi.mocked(f.renderer.enqueue).mock.calls[0]).toHaveLength(2);
    } finally { await f.close(); }
  });
  it('a custom decoder dropping the input token cannot borrow an observed receipt', async () => {
    const f = await fixture({ dropToken: true }); try {
      await f.send('audio'); await f.send('video'); f.tick();
      expect(f.renderer.enqueue).toHaveBeenCalled(); expect(f.events).toEqual([]);
      expect(f.player.diagnosticSnapshot().mediaStages?.unattributedInputCount).toBe(2);
    } finally { await f.close(); }
  });
  it('a reentrant pause after receipt reports the actual discard before pipeline admission', async () => {
    const f = await fixture(); try {
      f.player.play(); f.player.on('media_object', () => f.player.pause()); await f.send('video');
      expect(f.events.map(e => [e.unit, e.stage, e.reason])).toEqual([[null, 'discarded', 'paused']]);
      expect(f.video.decode).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('a repeated wire location terminates only the newly rejected buffered input', async () => {
    const f = await fixture(); try {
      await f.send('video'); await f.send('video');
      expect(f.events.map(e => [e.unit, e.stage, e.reason, e.inputs[0]])).toEqual([
        [null, 'discarded', 'treated as a replay', f.receipts[1]!.token],
      ]);
      await f.send('audio'); f.tick();
      expect(f.events.find(e => e.stage === 'decoded' && e.inputs.includes(f.receipts[0]!.token))).toBeDefined();
    } finally { await f.close(); }
  });
  it('distinguishes decode submissions from deferred actual native outputs', async () => {
    const f = await fixture({ deferred: true }); try {
      await f.send('audio'); await f.send('video'); f.tick();
      expect(f.player.stats.framesDecoded).toBe(1); // Legacy SDK field counts submitted commands.
      expect(f.player.diagnosticSnapshot().mediaStages).toMatchObject({ decodedVideoCount: 0, decodedAudioCount: 0 });
      f.flushNative();
      expect(f.player.stats.framesDecoded).toBe(1);
      expect(f.player.diagnosticSnapshot().mediaStages).toMatchObject({ decodedVideoCount: 1, decodedAudioCount: 1 });
    } finally { await f.close(); }
  });
  it('a real codec configuration switch reuses the dispatcher and terminates held units at reset', async () => {
    const f = await fixture({ alternative: true, oneUnit: true }); try {
      await f.send('video'); f.tick();
      expect(f.events.map(e => e.stage)).toEqual(['decoded']);
      const held = f.events[0]!;
      await f.player.selectVideoTrack('v2'); await f.acceptAlternative();
      await f.send('video', false, 0n, true); await f.send('audio'); f.tick();
      expect(f.createVideo).toHaveBeenCalledOnce(); expect(f.createRenderer).toHaveBeenCalledOnce();
      expect(vi.mocked(f.video.configure).mock.calls.map(call => call[1])).toEqual(['avc1.4D4028', 'avc1.640028']);
      expect(f.events.filter(e => e.unit === held.unit).map(e => [e.stage, e.reason])).toEqual([['decoded', null], ['discarded', 'decoder reset']]);
      expect(f.events.some(e => e.stage === 'decoded' && e.inputs.includes(f.receipts.find(r => r.alias === 79n)!.token))).toBe(true);
      expect(f.player.diagnosticSnapshot().mediaStages).toMatchObject({ evidenceLossCount: 0, refusedVideoCount: 0, refusedAudioCount: 0 });
    } finally { await f.close(); }
  });
  it('does not transfer delayed old native outputs into a new diagnostics lifetime', async () => {
    const f = await fixture({ deferred: true }), later: MediaStageObservation[] = []; let stop = () => {};
    try {
      await f.send('audio'); await f.send('video'); f.tick();
      f.remove(); stop = f.player.observeMediaStages(e => { later.push(e); }, { createTracker: createMediaDiagnostics });
      f.flushNative();
      expect(later).toEqual([]); expect(f.player.diagnosticSnapshot().mediaStages?.unattributedInputCount).toBe(2);
      await f.send('audio', false, 1n); await f.send('video', false, 1n); f.tick(); f.flushNative();
      expect(later.filter(e => e.stage === 'decoded').map(e => e.inputs[0])).toEqual(f.receipts.slice(2).map(r => r.token));
    } finally { stop(); await f.close(); }
  });
  it('decoded evidence remains truthful for custom outputs without completion hooks', async () => {
    const f = await fixture({ unobservable: true }); try {
      await f.send('audio'); await f.send('video'); f.tick();
      expect(f.events.map(e => e.stage)).toEqual(['decoded', 'decoded']);
      expect(f.player.diagnosticSnapshot().mediaStages).toMatchObject({ unobservableVideoCount: 1, unobservableAudioCount: 1, evidenceLossCount: 0 });
    } finally { await f.close(); }
  });
  it('a decoded-stage listener can destroy the player before target submission', async () => {
    const f = await fixture(); let destroying: Promise<void> | undefined;
    const stop = f.player.observeMediaStages(e => { if (e.stage === 'decoded') destroying = f.player.destroy(); });
    try {
      await f.send('audio'); await f.send('video'); f.tick(); await destroying;
      expect(f.output.schedule).not.toHaveBeenCalled(); expect(f.renderer.enqueue).not.toHaveBeenCalled();
    } finally { stop(); await f.close(); }
  });
  it('counts real pipeline association refusals separately from media discards and unit refusals', async () => {
    const f = await fixture(); try {
      await f.fillVideo(1025);
      expect(f.receipts).toHaveLength(1025); expect(f.video.decode).not.toHaveBeenCalled();
      expect(f.player.diagnosticSnapshot().mediaStages).toMatchObject({ inputAdmissionRefusalCount: 1, evidenceLossCount: 0,
        refusedVideoCount: 0, refusedAudioCount: 0, refusedReconstructionCount: 0 });
      expect(f.events).toEqual([]);
    } finally { await f.close(); }
  });
  it('uses the original LOCMAF object receipt for every synthetic sample, with distinct decoded units', async () => {
    const f = await fixture({ frameLocmaf: true }); try {
      await f.send('audio'); await f.send('video'); f.tick();
      expect(f.video.decode).toHaveBeenCalledTimes(2); expect(f.audio.decode).toHaveBeenCalledTimes(2);
      for (const receipt of f.receipts) {
        const outputs = f.events.filter(e => e.stage === 'decoded' && e.inputs.includes(receipt.token));
        expect(outputs).toHaveLength(2); expect(outputs[0]!.unit).not.toBe(outputs[1]!.unit);
      }
      expect(f.events.some(e => e.stage === 'reconstructed' || e.stage === 'appended')).toBe(false);
    } finally { await f.close(); }
  });

});

it('exposes LOC capabilities and correlated exact output facts through the optional adapter', async () => {
  const { DiagnosticRegistry } = await import('../../devtools/src/index.js');
  const { installPlayerDiagnostics } = await import('../../devtools/src/player.js');
  const { encodeMessage, decodeMessage, PROTOCOL_VERSION } = await import('../../devtools-protocol/src/index.js');
  const f = await fixture({ observed: false }), registry = new DiagnosticRegistry();
  const installed = installPlayerDiagnostics(f.player, { registry, exposure: 'development' }), owner = registry.open('loc-stages');
  try {
    const facts: import('../../devtools-protocol/src/index.js').Fact[] = [];
    const baseline = owner.request(encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION, kind: 'attach', requestId: 'attach',
      target: { ownerId: 'loc-stages', sourceId: installed.source.sourceId, runId: installed.source.runId } }));
    for (const raw of baseline) {
      const decoded = decodeMessage(raw); if (!decoded.ok) throw Error('Invalid baseline');
      if (decoded.message.kind === 'snapshot') facts.push(...decoded.message.facts.map(entry => entry.fact));
    }
    await f.send('audio'); await f.send('video'); f.tick();
    for (let i = 0; i < 100; i++) {
      const raw = owner.pull(); if (raw === null) break;
      const decoded = decodeMessage(raw); if (!decoded.ok) throw Error('Invalid frame');
      if (decoded.message.kind === 'batch') facts.push(...decoded.message.events.map(e => e.fact));
    }
    for (const alias of ['77', '78']) {
      const object = facts.find(f => f.kind === 'object' && f.trackAlias === alias);
      if (object?.kind !== 'object') throw Error('Missing object for ' + alias);
      const stages = facts.filter((f): f is Extract<Fact, { kind: 'stage' }> => f.kind === 'stage' && f.deliveryId === object.deliveryId);
      expect(stages.map(s => s.stage)).toEqual(alias === '77' ? ['decoded', 'scheduled', 'presented'] : ['decoded', 'scheduled']);
      expect(new Set(stages.map(s => s.unitId)).size).toBe(1); expect(stages[0]!.unitId).not.toBeNull();
    }
    expect(installed.source.capabilities).toEqual(expect.arrayContaining(['loc-video-stages', 'loc-audio-stages']));
    for (const name of ['diagnostic_refused_reconstructed_units', 'diagnostic_refused_video_units', 'diagnostic_refused_audio_units',
      'diagnostic_unobservable_video_outputs', 'diagnostic_unobservable_audio_outputs', 'diagnostic_input_admission_refusals']) {
      expect(facts.find(f => f.kind === 'metric' && f.name === name)).toMatchObject({ value: 0 });
    }
  } finally { owner.close(); installed.dispose(); registry.dispose(); await f.close(); }
});

it('publishes actual output counts separately from submission counts through the codec', async () => {
  const { DiagnosticRegistry } = await import('../../devtools/src/index.js');
  const { installPlayerDiagnostics } = await import('../../devtools/src/player.js');
  const { encodeMessage, decodeMessage, PROTOCOL_VERSION } = await import('../../devtools-protocol/src/index.js');
  const f = await fixture({ observed: false, deferred: true }), registry = new DiagnosticRegistry();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const installed = installPlayerDiagnostics(f.player, { registry, exposure: 'development' }), owner = registry.open('output-counts');
  try {
    const replies = owner.request(encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION, kind: 'attach', requestId: 'attach',
      target: { ownerId: 'output-counts', sourceId: installed.source.sourceId, runId: installed.source.runId } }));
    const initial = decodeMessage(replies[0]);
    if (!initial.ok || initial.message.kind !== 'snapshot') throw Error('Expected snapshot');
    const target = initial.message.target;
    const sample = () => {
      vi.advanceTimersByTime(250);
      const replies = owner.request(encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION, kind: 'snapshot.request', requestId: 'sample', target, scope: { kind: 'source' } }));
      for (const raw of replies) {
        const reply = decodeMessage(raw);
        if (!reply.ok) throw Error('Invalid sampled frame');
        if (reply.message.kind === 'snapshot') return reply.message.facts.map(e => e.fact);
        if (reply.message.kind !== 'batch') throw Error('Unexpected sampled frame: ' + reply.message.kind);
      }
      throw Error('Expected sampled snapshot');
    };
    await f.send('audio'); await f.send('video'); f.tick();
    const before = sample();
    expect(before.find(f => f.kind === 'metric' && f.name === 'video_decode_submissions')).toMatchObject({ value: 1 });
    expect(before.find(f => f.kind === 'metric' && f.name === 'frames_decoded')).toMatchObject({ value: 0 });
    expect(before.find(f => f.kind === 'metric' && f.name === 'audio_outputs_decoded')).toMatchObject({ value: 0 });
    f.flushNative(); const after = sample();
    expect(after.find(f => f.kind === 'metric' && f.name === 'video_decode_submissions')).toMatchObject({ value: 1 });
    expect(after.find(f => f.kind === 'metric' && f.name === 'frames_decoded')).toMatchObject({ value: 1 });
    expect(after.find(f => f.kind === 'metric' && f.name === 'audio_outputs_decoded')).toMatchObject({ value: 1 });
  } finally { owner.close(); installed.dispose(); registry.dispose(); vi.useRealTimers(); await f.close(); }
});
