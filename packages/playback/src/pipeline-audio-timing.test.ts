import { describe, expect, it } from 'vitest';
import { varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { DecoderCommand, PlaybackEvent } from './types.js';

function object(objectId: number): MoqtObjectData {
    return { kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
        objectId: varint(objectId), publisherPriority: 128, extensions: undefined,
        payload: new Uint8Array([1, 2]) };
}

function fixture(adaptiveTolerance = false) {
    let nowUs = 0;
    const clock = { now: () => nowUs };
    const sync = new SyncController({ clock, wallClock: { now: () => 1_000_250_000 },
        driftThresholdUs: 500_000, targetLatencyMs: 250, catchUpThresholdMs: 100,
        maxCatchUpRate: 1.1 });
    // Raw source epoch 990 seconds corresponds to local presentation time zero.
    sync.setAudioReference(990_000_000n);
    nowUs = 9_980_000;
    const commands: DecoderCommand[] = [], events: PlaybackEvent[] = [];
    const pipeline = new PlaybackPipeline({ mediaType: 'audio', clock, sync,
        config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, adaptiveTolerance },
        onCommand: command => commands.push(command), onEvent: event => events.push(event) });
    pipeline.configure(new Uint8Array([1]));
    let nextObject = 0;
    return { pipeline, sync, clock, commands, events,
        setNow(value: number) { nowUs = value; },
        push(sourceUs: bigint, wallClock = false, input?: object) {
            const headers: LocHeaders = Object.freeze({ captureTimestamp: sourceUs,
                timestamp: sourceUs, timescale: 1_000_000n, timestampIsWallClock: wallClock });
            pipeline.pushObject(object(nextObject++), headers, input);
            pipeline.tick();
            return headers;
        },
        lastAudio() {
            const command = commands.filter(command => command.type === 'decode_audio').at(-1);
            if (!command || command.type !== 'decode_audio') throw new Error('fixture emitted no audio');
            return command;
        },
    };
}

function mapping(sync: SyncController, sourceUs: bigint, referenceUs = 1_000_000_000n) {
    const offset = referenceUs - sourceUs;
    const observed: bigint[] = [];
    return { observed, computeAudioRenderTime(timestamp: bigint) {
        observed.push(timestamp);
        return sync.computeAudioRenderTime(timestamp + offset);
    } };
}

describe('audio-only source timing', () => {
    it.each([90_000_000n, (1n << 60n) + 123n])(
        'maps source %s to reference 1000s and output 10s without changing raw decoder input', sourceUs => {
            const f = fixture(), provider = mapping(f.sync, sourceUs), input = {};
            f.pipeline.inputObserver = () => {};
            const nextVideo = f.sync.computeVideoRenderTime(1_000_020_000n);
            f.pipeline.setAudioTimingSource(provider);
            const headers = f.push(sourceUs, false, input);
            const command = f.lastAudio();
            expect(command.renderTimeUs).toBe(10_000_000);
            expect(provider.observed).toEqual([sourceUs]);
            // Number conversion remains at the existing WebCodecs chunk boundary.
            expect(command.chunk.timestamp).toBe(Number(sourceUs));
            expect(command.inputToken).toBe(input);
            expect(headers.captureTimestamp).toBe(sourceUs);
            expect(headers.timestamp).toBe(sourceUs);
            expect(headers.timestampIsWallClock).toBe(false);
            expect(f.sync.computeVideoRenderTime(1_000_020_000n)).toEqual(nextVideo);
            expect(nextVideo?.renderTimeUs).toBe(10_020_000);
        });

    it('keeps the ordinary same-timeline path on shared sync and raw capture-age control', () => {
        const f = fixture();
        f.push(1_000_000_000n, true);
        expect(f.lastAudio().renderTimeUs).toBe(10_000_000);
        expect(f.lastAudio().chunk.timestamp).toBe(1_000_000_000);
        expect(f.sync.captureTimestampAgeUs).toBe(250_000);
        expect(f.sync.currentRate).toBe(1);
    });

    it.each([false, true])('mapped audio cannot change shared capture age or catch-up: wall-clock=%s', wallClock => {
        const f = fixture();
        f.sync.evaluateCatchUp(1_000_000_000n, true);
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n));
        f.push(90_000_000n, wallClock);
        expect(f.sync.captureTimestampAgeUs).toBe(250_000);
        expect(f.sync.currentRate).toBe(1);
        expect(f.events.filter(event => event.type === 'catch_up_changed')).toEqual([]);
        expect(f.commands.filter(command => command.type === 'set_playback_rate')).toEqual([]);
        // Reference-domain video still owns its ordinary control path.
        const video = new PlaybackPipeline({ mediaType: 'video', clock: f.clock, sync: f.sync,
            config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100 },
            onCommand: () => {}, onEvent: () => {} });
        video.pushObject(object(0), { captureTimestamp: 1_000_020_000n, timestampIsWallClock: true,
            videoConfig: new Uint8Array([1]), videoFrameMarking: { independent: true,
                startOfFrame: true, endOfFrame: true, discardable: false, baseLayerSync: false, temporalId: 0 } });
        video.tick();
        expect(f.sync.captureTimestampAgeUs).toBe(230_000);
    });

    it('starts a fresh audio jitter estimate across provider changes without changing shared drift policy', () => {
        const f = fixture(true);
        f.setNow(10_000_000); f.push(1_000_000_000n);
        f.setNow(10_020_000); f.push(1_000_020_000n);
        expect(f.pipeline.effectiveGapTimeoutUs).toBe(50_000);
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n));
        f.sync.driftThresholdUs = 321_000;
        f.setNow(10_040_000); f.push(90_040_000n);
        expect(f.pipeline.effectiveGapTimeoutUs).toBe(50_000);
        expect(f.sync.driftThresholdUs).toBe(321_000);
        f.pipeline.setAudioTimingSource(undefined);
        f.setNow(10_060_000); f.push(1_000_060_000n);
        expect(f.pipeline.effectiveGapTimeoutUs).toBe(50_000);
    });

    it('restores ordinary scheduling and capture-age control when the engine removes the mapping', () => {
        const f = fixture();
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n));
        f.push(90_000_000n);
        f.pipeline.setAudioTimingSource(undefined);
        f.push(1_000_020_000n, true);
        expect(f.lastAudio().renderTimeUs).toBe(10_020_000);
        expect(f.sync.captureTimestampAgeUs).toBe(230_000);
    });

    it('does not establish a raw mapped-source reference if the continuing reference disappears', () => {
        const f = fixture();
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n));
        f.sync.reset();
        f.push(90_000_000n);
        expect(f.sync.hasReference).toBe(false);
        expect(f.commands.filter(command => command.type === 'decode_audio')).toEqual([]);
    });

    it('retains an explicitly mapped future schedule instead of substituting the local clock', () => {
        const f = fixture();
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n, 1_020_000_000n));
        f.push(90_000_000n);
        expect(f.lastAudio().renderTimeUs).toBe(30_000_000);
    });

    it('does not decode mapped audio at now when its proven schedule is already late', () => {
        const f = fixture();
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n, 980_000_000n));
        f.push(90_000_000n);
        expect(f.commands.filter(command => command.type === 'decode_audio')).toEqual([]);
    });

    it('does not invent a local schedule for a mapped source with no timestamp', () => {
        const f = fixture();
        f.pipeline.setAudioTimingSource(mapping(f.sync, 90_000_000n));
        f.pipeline.pushObject(object(0));
        f.pipeline.tick();
        expect(f.commands.filter(command => command.type === 'decode_audio')).toEqual([]);
    });
});
