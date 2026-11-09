import { describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObjectData } from '@openmoq/transport';
import { PlaybackPipeline, SyncController, type AudioRenderTiming, type DecoderCommand, type PlaybackSample } from './index.js';

const wire: MoqtObjectData = { kind: 'data', trackAlias: varint(1), groupId: varint(0), objectId: varint(0),
  subgroupId: varint(0), publisherPriority: 128, payload: Uint8Array.of(1) };
const samples: readonly PlaybackSample[] = [0, 1].map(sampleIndex => ({ sampleIndex,
  headers: { captureTimestamp: BigInt(1000 + sampleIndex), audioConfig: Uint8Array.of(0x12, 0x10) },
  chunk: { type: 'key', timestamp: 1000 + sampleIndex, data: Uint8Array.of(sampleIndex) } }));
function fixture(getAudioPlayoutDelayUs?: () => number) {
  const clock = { now: () => 10000 }, sync = new SyncController({ clock, driftThresholdUs: 100000 }), commands: DecoderCommand[] = [], discard = vi.fn();
  const pipeline = new PlaybackPipeline({ mediaType: 'audio', clock, sync,
    config: { gapTimeoutUs: 200000, driftThresholdUs: 100000, maxBufferDepth: 20 },
    ...(getAudioPlayoutDelayUs ? { getAudioPlayoutDelayUs } : {}),
    onCommand(command) { commands.push(command); }, onEvent() {} });
  pipeline.inputObserver = discard;
  return { pipeline, commands, discard };
}
describe('sample batches with audio producing and admission contexts', () => {
  it('reports one wire receipt when both samples fail the playout delay query', () => {
    const f = fixture(() => NaN), token = {};
    try {
      f.pipeline.pushSampleObject(wire, samples, token); f.pipeline.tick();
      expect(f.commands.filter(c => c.type === 'decode_audio')).toEqual([]);
      expect(f.discard.mock.calls).toEqual([[token, 'decoder policy']]);
      expect(f.pipeline.pendingSampleCount).toBe(0); expect(f.pipeline.bufferedGroupCount).toBe(0);
    } finally { f.pipeline.reset(); }
  });
  it.each([false, true])('keeps a captured producing provider current before decode; replace=%s', replace => {
    const f = fixture(), token = {}, replacement = vi.fn(() => ({ renderTimeUs: 10000, offsetUs: 0, shouldDrop: false }));
    const old = vi.fn(() => ({ renderTimeUs: 10000, offsetUs: 0, shouldDrop: false }));
    const context: AudioRenderTiming = { epoch: {}, sourceTimestampUs: 1000n, presentFromSourceUs: 1000n,
      recomputeRenderTimeUs: () => 10000 };
    const capture = vi.fn(() => {
      if (replace) f.pipeline.setAudioTimingSource({ computeAudioRenderTime: replacement });
      return context;
    });
    f.pipeline.setAudioTimingSource({ captureOutputTiming: capture, computeAudioRenderTime: old });
    try {
      f.pipeline.pushSampleObject(wire, samples.slice(0, 1), token); f.pipeline.tick();
      const decoded = f.commands.filter(c => c.type === 'decode_audio');
      if (replace) {
        expect(decoded).toEqual([]); expect(old).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
        expect(f.discard.mock.calls).toEqual([[token, 'decoder reset']]);
      } else {
        expect(decoded).toHaveLength(1); expect(decoded[0]!.renderTiming).toBe(context); expect(old).toHaveBeenCalledOnce();
        expect(f.discard).not.toHaveBeenCalled();
      }
      expect(f.pipeline.pendingSampleCount).toBe(0);
    } finally { f.pipeline.reset(); }
  });
});
