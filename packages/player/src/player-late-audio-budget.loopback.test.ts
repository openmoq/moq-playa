/** Real transport/player/dispatcher with modeled native PCM and video decoding. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import type { SyncController } from '@openmoq/playback';
import { WebAudioOutput } from '../../browser/src/webaudio-output.js';
import type { AudioDecoderLike } from './interfaces.js';
import type { SubscriptionManager } from './subscription-manager.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => vi.unstubAllGlobals());
const ORIGIN = 1_000_000_000n;

async function fixture(_jumps = false, av = false, asyncAll = false) {
  let nowUs = 100_000, generation = 0, group = 10n, holdNext = false;
  const pending: Array<() => void> = [];
  const starts: number[] = [];
  const context = {
    state: 'running', destination: {}, get currentTime() { return nowUs / 1_000_000; },
    createBuffer(channels: number, length: number, rate: number) {
      const planes = Array.from({ length: channels }, () => new Float32Array(length));
      return { duration: length / rate, getChannelData: (channel: number) => planes[channel]! };
    },
    createBufferSource() {
      const node = { buffer: null, onended: null as (() => void) | null, playbackRate: { value: 1 },
        connect() {}, disconnect() {}, start(when: number) { starts.push(when); }, stop() { node.onended?.(); } };
      return node;
    },
  };
  const output = new WebAudioOutput(context as unknown as AudioContext, undefined, 0, { now: () => nowUs });
  const schedules = vi.spyOn(output, 'schedule');
  const decoder: AudioDecoderLike = { configure() {}, queueDepth: 0, onData: null, onError: null,
    decode(chunk, time, input, timing) {
      const admitted = generation;
      const emit = () => {
        if (admitted !== generation) return;
        decoder.onData!({ timestamp: chunk.timestamp, sampleRate: 48_000, numberOfChannels: 1, numberOfFrames: 960,
          copyTo(plane: Float32Array) { plane.fill(0.25); }, close() {} }, time, input,
          timing ? { context: timing, sourceOffsetUs: 0 } : undefined);
      };
      if (holdNext || asyncAll) { holdNext = false; pending.push(emit); } else emit();
    }, async flush() {}, reset() { generation++; }, destroy() { generation++; } };
  const f = await locSeekFixture(18, true, true, { isLive: true, audioOnly: !av,
    playerConfig: { liveJumpThresholdMs: 3000, createAudioDecoder: () => decoder, createAudioOutput: () => output } });
  f.decoder.decode = vi.fn((chunk, time, input, timing) => {
    f.decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, input,
      timing ? { context: timing, sourceTimestamp: { ticks: BigInt(chunk.timestamp), ticksPerSecond: 1_000_000n, domain: 'unix' } } : undefined);
  });
  // Read the real shared timeline; classify history at the real object-routing boundary.
  const graph = f.player as unknown as { syncController: SyncController; subscriptionManager: SubscriptionManager; audioPipeline: import('@openmoq/playback').PlaybackPipeline };
  const offsets: number[] = [], handler = graph.audioPipeline.lateAudioHandler;
  if (handler) graph.audioPipeline.lateAudioHandler = (offset, object) => { offsets.push(offset); return handler(offset, object); };
  const manager = graph.subscriptionManager, deliver = manager.onObject!;
  let history: 'backfill' | 'fetched' | undefined;
  manager.onObject = (role, track, object, headers, input, delivery) =>
    deliver(role, track, object, headers, input, role === 'audio' && history ? { ...delivery, [history]: true } : delivery);
  async function emit(atUs: number, sourceUs: number, origin?: typeof history, videoSourceUs = sourceUs) {
    nowUs = atUs; f.setNow(atUs); history = origin;
    for (const audio of av ? [true, false] : [true]) {
      const stream = await f.server.openSubgroup(audio ? 201n : 200n, group, 0n,
        { publisherPriority: 128, hasExtensions: true, endOfGroup: true });
      await f.server.sendObject(stream, 0n, audio ? Uint8Array.of(0xf8, 0xff, 0xfe) : Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
        encodeLocHeaders({ captureTimestamp: ORIGIN + BigInt(audio ? sourceUs : videoSourceUs),
          ...(!audio ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) },
        { wireProfile: locWireProfileForDraft(18), locVersion: 1 }));
      await f.server.closeSubgroup(stream); await flush(128);
    }
    group++; f.advance(atUs); history = undefined;
  }
  const baseline = () => graph.syncController.computeAudioRenderTime(ORIGIN)!.renderTimeUs;
  return { f, emit, baseline, schedules, starts, offsets, graph, holdNext: () => { holdNext = true; }, release: () => pending.splice(0).forEach(emit => emit()),
    align(sourceUs: number) {
      const timestamp = Number(ORIGIN) + sourceUs;
      const audio = schedules.mock.calls.findIndex(call => (call[0] as { timestamp: number }).timestamp === timestamp);
      const video = vi.mocked(f.renderer.enqueue).mock.calls.find(call => (call[0] as { timestamp: number }).timestamp === timestamp);
      expect(audio).toBeGreaterThanOrEqual(0); expect(video).toBeDefined();
      expect(Math.abs(starts[audio]! * 1_000_000 - video![1])).toBeLessThan(20_000);
    }, async destroy() { expect(f.errors).toEqual([]); manager.onObject = deliver; await f.destroy(); } };
}


it('bounds video delay when only audio delivery falls behind',async()=>{
 const t=await fixture(true,true), jumps:unknown[]=[];
 t.f.player.on('recovery_action',event=>{if(event.action.type==='jump_to_live')jumps.push(event.action);});
 try{
 await t.emit(100_000,0);
 for(let i=1;i<=1000;i++)await t.emit(100_000+i*40_000,i*20_000,undefined,i*40_000);
 const last=vi.mocked(t.f.renderer.enqueue).mock.calls.at(-1)!;
 const ahead=last[1]-40_100_000;
 console.log('healthy video', {baseline:t.baseline(),ahead,jumps:jumps.length});
 for(let i=1001;i<=2000;i++)await t.emit(100_000+i*40_000,i*20_000,undefined,i*40_000);
 const ahead80=vi.mocked(t.f.renderer.enqueue).mock.calls.at(-1)![1]-80_100_000;
 console.log('healthy video at 80s',{baseline:t.baseline(),ahead:ahead80,jumps:jumps.length});
 expect(ahead80).toBeLessThanOrEqual(3_216_000);
 }finally{await t.destroy();}
});

it('repays slip debt only after a live jump or a clock re-anchor', async () => {
 const t=await fixture(true), jumps: unknown[]=[];
 t.f.player.on('recovery_action', event=>{if(event.action.type==='jump_to_live') jumps.push(event.action);});
 try {
  await t.emit(100_000,0);
  for(let i=1;i<=200;i++) await t.emit(100_000+i*40_000,i*20_000);
  expect(t.baseline()).toBe(3_100_000);
  const schedules=t.schedules.mock.calls.length;
  for(let i=201;i<=220;i++) await t.emit(100_000+i*40_000,i*20_000);
  expect(t.baseline()).toBe(3_100_000); expect(t.schedules).toHaveBeenCalledTimes(schedules);
  // Both received roles (audio-only here) stand beyond the jump threshold.
  await t.emit(9_000_000,9_000_000); await t.emit(10_100_000,10_100_000);
  expect(jumps).toHaveLength(1);
  const repaid=t.baseline();
  for(let i=0;i<=15;i++) { const at=12_200_000+i*20_000; await t.emit(at,at-repaid-600_000); }
  expect(t.baseline()).toBe(repaid+900_000);
 }finally{await t.destroy();}
});

it('a genuine clock re-anchor restores an exhausted slip budget', async () => {
 const t=await fixture(true);
 try {
  await t.emit(100_000,0);
  for(let i=1;i<=220;i++) await t.emit(100_000+i*40_000,i*20_000);
  expect(t.baseline()).toBe(3_100_000);
  (t.f.player as unknown as { resetMediaClock(): void }).resetMediaClock();
  t.graph.syncController.setAudioReference(ORIGIN+8_800_000n);
  const before=t.baseline();
  for(let i=0;i<=15;i++){ const at=9_100_000+i*20_000; await t.emit(at,at-before-600_000); }
  expect(t.baseline()).toBe(before+900_000);
 }finally{await t.destroy();}
});
