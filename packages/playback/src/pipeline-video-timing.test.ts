import { describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { DecoderCommand, PlaybackEvent } from './types.js';

function fixture(adaptiveTolerance = false) {
    let now = 0;
    const clock = { now: () => now };
    const sync = new SyncController({ clock, wallClock: { now: () => 1_000_250_000 },
        driftThresholdUs: 500_000, targetLatencyMs: 250, catchUpThresholdMs: 100, maxCatchUpRate: 1.1 });
    sync.setAudioReference(990_000_000n);
    now = 9_980_000;
    const commands: DecoderCommand[] = [], events: PlaybackEvent[] = [];
    const pipeline = new PlaybackPipeline({ mediaType: 'video', clock, sync, videoOnly: true,
        config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, adaptiveTolerance },
        onCommand: command => commands.push(command), onEvent: event => events.push(event) });
    pipeline.configure(Uint8Array.of(1));
    let next = 0;
    return { pipeline, sync, commands, events, setNow(value: number) { now = value; },
        push(source?: bigint, wallClock = false) {
            const headers: LocHeaders = Object.freeze({ ...(source === undefined ? {} : {
                captureTimestamp: source, timestamp: source, timescale: 1_000_000n }), timestampIsWallClock: wallClock,
                videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
                    discardable: false, baseLayerSync: false, temporalId: 0 } });
            pipeline.pushObject({ kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
                objectId: varint(next++), publisherPriority: 128, extensions: undefined, payload: Uint8Array.of(1, 2) }, headers);
            pipeline.tick();
            return headers;
        },
        lastVideo() {
            const command = commands.filter(command => command.type === 'decode_video').at(-1);
            if (!command || command.type !== 'decode_video') throw new Error('No video decode command');
            return command;
        } };
}

describe('video producing timing context', () => {
    it('establishes mapped timing only at an input boundary, never during an output query', () => {
        const f = fixture();
        f.sync.reset();
        const establish = vi.fn((source: bigint) => f.sync.setVideoReference(source + 910_000_000n));
        const source = { computeVideoRenderTime: (raw: bigint) => f.sync.computeVideoRenderTime(raw + 910_000_000n),
            establishReference: establish };
        f.pipeline.setVideoTimingSource(source);
        expect(source.computeVideoRenderTime(90_000_000n)).toBeNull();
        expect(establish).not.toHaveBeenCalled();
        f.push(90_000_000n);
        expect(establish).toHaveBeenCalledExactlyOnceWith(90_000_000n);
        const command = f.lastVideo();
        expect(command.chunk.timestamp).toBe(90_000_000);
        f.sync.reset();
        expect(command.renderTiming?.recomputeRenderTimeUs()).toBeNull();
        expect(establish).toHaveBeenCalledTimes(1);
    });

    it('refuses the old input if reference establishment reenters a pipeline reset', () => {
        const f = fixture();
        f.sync.reset();
        const compute = vi.fn(() => ({ renderTimeUs: 10_000_000, offsetUs: 20_000, shouldDrop: false }));
        f.pipeline.setVideoTimingSource({
            establishReference: () => { f.pipeline.reset(); f.sync.setVideoReference(1_000_000_000n); },
            computeVideoRenderTime: compute,
        });
        f.push(90_000_000n);
        expect(compute).not.toHaveBeenCalled();
        expect(f.commands.filter(command => command.type === 'decode_video')).toEqual([]);
    });

    it.each([90_000_000n, (1n << 60n) + 123n])('retains source %s and its producing provider across replacement', source => {
        const f = fixture(), observed: bigint[] = [];
        const provider = { computeVideoRenderTime(timestamp: bigint) {
            observed.push(timestamp);
            return f.sync.computeAudioRenderTime(timestamp + 1_000_000_000n - source);
        } };
        const continuingAudio = f.sync.computeAudioRenderTime(1_000_020_000n);
        f.pipeline.setVideoTimingSource(provider);
        const headers = f.push(source);
        const command = f.lastVideo();
        expect(command.renderTimeUs).toBe(10_000_000);
        expect(command.chunk.timestamp).toBe(Number(source));
        expect(command.chunk.sourceTimestamp).toEqual({ ticks: source, ticksPerSecond: 1_000_000n, domain: 'media' });
        expect(headers.captureTimestamp).toBe(source);
        expect(Object.isFrozen(command.renderTiming)).toBe(true);
        f.pipeline.setVideoTimingSource({ computeVideoRenderTime: () => ({ renderTimeUs: 99, offsetUs: 1, shouldDrop: false }) });
        expect(command.renderTiming?.recomputeRenderTimeUs()).toBe(10_000_000);
        expect(observed).toEqual([source, source]);
        expect(f.sync.computeAudioRenderTime(1_000_020_000n)).toEqual(continuingAudio);
    });

    it('leaves the ordinary provider and command shape unchanged', () => {
        const f = fixture();
        f.push(1_000_000_000n, true);
        expect(f.lastVideo().renderTimeUs).toBe(10_000_000);
        expect(f.lastVideo()).not.toHaveProperty('renderTiming');
        expect(f.sync.captureTimestampAgeUs).toBe(250_000);
    });

    it.each([false, true])('mapped raw video does not control shared reference, join, age or catch-up: %s', wallClock => {
        const f = fixture(true), join = vi.spyOn(f.sync, 'onVideoJoin');
        f.sync.evaluateCatchUp(1_000_000_000n, true);
        f.sync.driftThresholdUs = 321_000;
        f.pipeline.setVideoTimingSource({ computeVideoRenderTime: () => ({ renderTimeUs: 10_000_000, offsetUs: 20_000, shouldDrop: false }) });
        f.push(90_000_000n, wallClock);
        expect(join).not.toHaveBeenCalled();
        expect(f.sync.captureTimestampAgeUs).toBe(250_000);
        expect(f.sync.currentRate).toBe(1);
        expect(f.sync.driftThresholdUs).toBe(321_000);
        expect(f.events.filter(event => event.type === 'catch_up_changed')).toEqual([]);
        f.sync.reset();
        f.push(90_020_000n, wallClock);
        expect(f.sync.hasReference).toBe(false);
    });

    it('returns unavailable from an existing context when its producing provider loses evidence', () => {
        const f = fixture(); let available = true;
        f.pipeline.setVideoTimingSource({ computeVideoRenderTime: () => available
            ? { renderTimeUs: 10_000_000, offsetUs: 20_000, shouldDrop: false } : null });
        f.push(90_000_000n); const timing = f.lastVideo().renderTiming;
        available = false;
        expect(timing?.recomputeRenderTimeUs()).toBeNull();
    });

    it('does not invent a schedule for mapped input without source time or timing evidence', () => {
        const f = fixture();
        f.pipeline.setVideoTimingSource({ computeVideoRenderTime: () => null });
        f.push(90_000_000n); f.push();
        expect(f.commands.filter(command => command.type === 'decode_video')).toEqual([]);
    });

    it.each([-10_000_000, 30_000_000])('retains the mapped nominal schedule %s for dependent decode instead of play-now', nominal => {
        const f = fixture();
        f.pipeline.setVideoTimingSource({ computeVideoRenderTime: () => ({ renderTimeUs: nominal,
            offsetUs: nominal - 9_980_000, shouldDrop: nominal < 0 }) });
        f.push(90_000_000n);
        expect(f.lastVideo().renderTimeUs).toBe(nominal);
        expect(f.lastVideo().renderTiming?.recomputeRenderTimeUs()).toBe(nominal);
    });

    it('restores ordinary scheduling without changing an already emitted context', () => {
        const f = fixture();
        f.pipeline.setVideoTimingSource({ computeVideoRenderTime: () => ({ renderTimeUs: 10_000_000, offsetUs: 20_000, shouldDrop: false }) });
        f.push(90_000_000n); const previous = f.lastVideo();
        f.pipeline.setVideoTimingSource(undefined);
        f.push(1_000_020_000n, true);
        expect(f.lastVideo()).not.toHaveProperty('renderTiming');
        expect(previous.renderTiming?.recomputeRenderTimeUs()).toBe(10_000_000);
        expect(f.sync.captureTimestampAgeUs).toBe(230_000);
    });
});
