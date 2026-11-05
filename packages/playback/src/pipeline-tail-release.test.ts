import { expect, it } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import { ObjectStatus, varint } from '@openmoq/transport';

it('drains every fully received video tail object before decoding the successor despite a per-tick budget', () => {
  let now = 1_000_000;
  const clock = { now: () => now }, sync = new SyncController({ clock, driftThresholdUs: 500_000 });
  sync.setAudioReference(10_000_000n);
  const decoded: number[] = [], events: string[] = [];
  const pipeline = new PlaybackPipeline({ mediaType: 'video', clock, sync,
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 1 },
    onCommand: command => { if (command.type === 'decode_video') decoded.push(command.chunk.timestamp); },
    onEvent: event => { events.push(event.type); } });
  pipeline.configure(Uint8Array.of(1, 0x64));
  for (let i = 0; i < 4; i++) {
    const key = i === 0 || i === 3;
    pipeline.pushObject({ kind: 'data', trackAlias: varint(1), groupId: varint(i === 3 ? 1 : 0),
      objectId: varint(i === 3 ? 0 : i), subgroupId: varint(0), publisherPriority: 128,
      payload: Uint8Array.of(0, 0, 0, 1, key ? 0x65 : 0x41) },
      { captureTimestamp: 10_000_000n + BigInt(i * 20_000), videoFrameMarking: { independent: key,
        startOfFrame: true, endOfFrame: true, discardable: false, baseLayerSync: false, temporalId: 0 } });
  }
  pipeline.pushObject({ kind: 'gap', trackAlias: varint(1), groupId: varint(0), objectId: varint(3), subgroupId: varint(0), status: ObjectStatus.END_OF_GROUP });
  for (let i = 0; i < 4; i++) { pipeline.tick(); now += 20_000; }
  expect(decoded).toEqual([10_000_000, 10_020_000, 10_040_000, 10_060_000]);
  expect(events).not.toContain('skip_forward'); expect(events).not.toContain('partial_group_abandoned');
});
