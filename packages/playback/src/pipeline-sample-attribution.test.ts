import { describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObjectData } from '@openmoq/transport';
import { PlaybackPipeline, SyncController, type PlaybackSample, type DecoderCommand } from './index.js';

const wire: MoqtObjectData = { kind: 'data', trackAlias: varint(1n), groupId: varint(0n), objectId: varint(0n),
  subgroupId: varint(0n), publisherPriority: 128, payload: Uint8Array.of(9) };
const samples: readonly PlaybackSample[] = [0, 1, 2].map(index => ({ sampleIndex: index,
  headers: { videoConfig: Uint8Array.of(1), captureTimestamp: 1_000_000n + BigInt(index), timestampIsWallClock: false,
    videoFrameMarking: { independent: index === 0, discardable: index === 1, startOfFrame: true,
      endOfFrame: true, baseLayerSync: false, temporalId: 0 } },
  chunk: { type: index === 0 ? 'key' : 'delta', timestamp: 1_000_000 + index, duration: 1,
    sourceTimestamp: { ticks: BigInt(index), ticksPerSecond: 90000n, domain: 'media' }, data: Uint8Array.of(index) } }));

describe.each([false, true])('receipt across a safe per-sample discard, dropMiddle=%s', dropMiddle => {
  it('keeps the original receipt on every later decoded sample', () => {
    const clock = { now: () => 10_000 }, sync = new SyncController({ clock, driftThresholdUs: 500_000 });
    const commands: DecoderCommand[] = [], observer = vi.fn(), token = {};
    const pipeline = new PlaybackPipeline({ mediaType: 'video', clock, sync, videoOnly: true,
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 0 }, onCommand: command => commands.push(command), onEvent() {} });
    pipeline.inputObserver = observer;
    pipeline.setVideoTimingSource({ computeVideoRenderTime: source => ({ renderTimeUs: 10_000,
      offsetUs: dropMiddle && source === 1_000_001n ? -1000 : 0,
      shouldDrop: dropMiddle && source === 1_000_001n }) });
    try {
      pipeline.pushSampleObject(wire, samples, token); pipeline.tick();
      const decoded = commands.filter(command => command.type === 'decode_video');
      expect(decoded.map(command => command.chunk.data[0])).toEqual(dropMiddle ? [0, 2] : [0, 1, 2]);
      expect(pipeline.pendingSampleCount).toBe(0); expect(pipeline.bufferedGroupCount).toBe(0);
      expect(decoded.map(command => command.inputToken)).toEqual(dropMiddle ? [token, token] : [token, token, token]);
    } finally { pipeline.reset(); pipeline.inputObserver = undefined; }
  });
});
