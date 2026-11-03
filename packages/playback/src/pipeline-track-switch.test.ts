import { describe, expect, it } from 'vitest';
import { ObjectStatus, varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import type { AudioChunkInit, VideoChunkInit } from '@openmoq/loc';
import { DecoderStateMachine } from './decoder-state.js';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { DecoderCommand, PlaybackEvent } from './types.js';

const audioChunk: AudioChunkInit = { type: 'key', timestamp: 10_000_000, data: Uint8Array.of(0x48, 1) };
const videoChunk: VideoChunkInit = { type: 'key', timestamp: 10_000_000, data: Uint8Array.of(1) };
const independent = { independent: true, startOfFrame: true, endOfFrame: true,
    discardable: false, baseLayerSync: false, temporalId: 0 };

function data(group: bigint): MoqtObjectData {
    return { kind: 'data', trackAlias: varint(1), groupId: varint(group), subgroupId: varint(0),
        objectId: varint(0), publisherPriority: 128, extensions: undefined, payload: Uint8Array.of(0x48, 1) };
}

describe('track decoder lifetime', () => {
    it.each([false, true])('decodes a new same-config audio track after previous end: %s', ended => {
        const clock = { now: () => 0 };
        const sync = new SyncController({ clock, driftThresholdUs: 500_000 });
        sync.setAudioReference(10_000_000n);
        const beforeVideo = sync.computeVideoRenderTime(10_040_000n);
        const commands: DecoderCommand[] = [], events: PlaybackEvent[] = [];
        const pipeline = new PlaybackPipeline({ mediaType: 'audio', clock, sync,
            config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 20 },
            onCommand: command => commands.push(command), onEvent: event => events.push(event) });
        const config = Uint8Array.of(1);
        pipeline.configure(config);
        pipeline.pushObject(data(7n), { captureTimestamp: 10_000_000n });
        pipeline.tick();
        expect(commands.filter(command => command.type === 'decode_audio')).toHaveLength(1);
        if (ended) {
            pipeline.pushObject({ kind: 'gap', trackAlias: varint(1), groupId: varint(7),
                subgroupId: varint(0), objectId: varint(1), status: ObjectStatus.END_OF_TRACK });
            pipeline.tick();
            expect(events.filter(event => event.type === 'track_ended')).toHaveLength(1);
        }
        pipeline.resetForTrackSwitch(80n);
        pipeline.configure(config.slice());
        pipeline.pushObject(data(80n), { captureTimestamp: 10_020_000n });
        pipeline.tick();
        const decodes = commands.filter(command => command.type === 'decode_audio');
        expect(decodes).toHaveLength(2);
        expect(decodes[1]?.chunk.timestamp).toBe(10_020_000);
        expect(commands.filter(command => command.type === 'configure')).toHaveLength(1);
        expect(commands.filter(command => command.type === 'flush')).toHaveLength(ended ? 1 : 0);
        expect(events.filter(event => event.type === 'track_ended')).toHaveLength(ended ? 1 : 0);
        expect(sync.computeVideoRenderTime(10_040_000n)).toEqual(beforeVideo);
    });

    it('does not reopen ended audio through repeated config or ordinary gap recovery', () => {
        const decoder = new DecoderStateMachine('audio');
        decoder.configure(Uint8Array.of(1));
        expect(decoder.processAudioChunk(audioChunk).action).toBe('decode');
        decoder.notifyTrackEnded();
        expect(decoder.configure(Uint8Array.of(1)).action).toBe('skip');
        decoder.notifyGap();
        expect(decoder.processAudioChunk(audioChunk)).toEqual({ action: 'skip', reason: 'decoder is ended' });
    });

    it('requires an independent video frame after a same-config track change', () => {
        const decoder = new DecoderStateMachine('video');
        decoder.configure(Uint8Array.of(1));
        decoder.processVideoChunk(videoChunk, independent);
        decoder.notifyTrackEnded();
        decoder.notifyTrackSwitch();
        expect(decoder.configure(Uint8Array.of(1)).action).toBe('skip');
        expect(decoder.processVideoChunk({ ...videoChunk, type: 'delta' }, { ...independent, independent: false }).action).toBe('skip');
        expect(decoder.processVideoChunk(videoChunk, independent).action).toBe('decode');
    });

    it.each(['audio', 'video'] as const)('keeps unconfigured %s idle at a track change', type => {
        const decoder = new DecoderStateMachine(type);
        decoder.notifyTrackSwitch();
        expect(decoder.state).toBe('idle');
        const decision = type === 'audio' ? decoder.processAudioChunk(audioChunk) : decoder.processVideoChunk(videoChunk, independent);
        expect(decision.action).toBe('skip');
    });
});
