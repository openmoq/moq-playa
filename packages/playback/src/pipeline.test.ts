/**
 * Tests for the playback pipeline orchestrator.
 *
 * Wires jitter-buffer + gap-detector + decoder-state + sync together.
 * Accepts MoqtObject + LocHeaders, emits DecoderCommand + PlaybackEvent.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 */

import { describe, it, expect } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import { DefaultRecoveryController } from './recovery.js';
import type { ClockSource, DecoderCommand, PlaybackEvent, PlaybackConfig, DecoderFeedback } from './types.js';
import type { MoqtObjectData, MoqtObjectGap } from '@moqt/transport';
import { varint, ObjectStatus } from '@moqt/transport';
import type { LocHeaders } from '@moqt/loc';

// ─── Helpers ──────────────────────────────────────────────────────────

class MockClock implements ClockSource {
    private _now = 0;
    now(): number { return this._now; }
    advance(us: number): void { this._now += us; }
    set(us: number): void { this._now = us; }
}

function makeData(
    groupId: number,
    objectId: number,
    payload = new Uint8Array([0xCA, 0xFE]),
    subgroupId = 0,
    priority: number | undefined = 128,
): MoqtObjectData {
    return {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(groupId),
        subgroupId: varint(subgroupId),
        objectId: varint(objectId),
        publisherPriority: priority,
        extensions: undefined,
        payload,
    };
}

function makeGap(
    groupId: number,
    objectId: number,
    status: typeof ObjectStatus[keyof typeof ObjectStatus],
): MoqtObjectGap {
    return {
        kind: 'gap',
        trackAlias: varint(1),
        groupId: varint(groupId),
        subgroupId: varint(0),
        objectId: varint(objectId),
        status,
    };
}

function videoHeaders(
    captureTimestampUs: bigint,
    independent: boolean,
    videoConfig?: Uint8Array,
): LocHeaders {
    const h: LocHeaders = {
        captureTimestamp: captureTimestampUs,
        videoFrameMarking: {
            startOfFrame: true,
            endOfFrame: true,
            independent,
            discardable: false,
            baseLayerSync: false,
            temporalId: 0,
        },
    };
    if (videoConfig) {
        return { ...h, videoConfig };
    }
    return h;
}

function audioHeaders(captureTimestampUs: bigint): LocHeaders {
    return { captureTimestamp: captureTimestampUs };
}

const DEFAULT_CONFIG: PlaybackConfig = {
    gapTimeoutUs: 200_000,
    driftThresholdUs: 500_000,
    maxBufferDepth: 100,
};

function createPipeline(opts: {
    mediaType: 'video' | 'audio';
    clock: MockClock;
    config?: PlaybackConfig;
    sync?: SyncController;
    recovery?: import('./recovery.js').RecoveryController;
}) {
    const commands: DecoderCommand[] = [];
    const events: PlaybackEvent[] = [];
    const config = opts.config ?? DEFAULT_CONFIG;
    const sync = opts.sync ?? new SyncController({
        driftThresholdUs: config.driftThresholdUs,
        clock: opts.clock,
    });

    const pipeline = new PlaybackPipeline({
        mediaType: opts.mediaType,
        config,
        clock: opts.clock,
        sync,
        onCommand: (cmd) => commands.push(cmd),
        onEvent: (evt) => events.push(evt),
        recovery: opts.recovery,
    });

    return { pipeline, commands, events, sync };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('PlaybackPipeline', () => {
    it('sequential group, 3 video objects → configure + 3 decode commands (§4.2)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });

        // Establish sync reference from audio
        sync.setAudioReference(1_000_000_000n);

        // Object 0: keyframe with videoConfig
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])),
        );
        // Object 1: delta
        pipeline.pushObject(
            makeData(0, 1),
            videoHeaders(1_000_033_333n, false),
        );
        // Object 2: delta
        pipeline.pushObject(
            makeData(0, 2),
            videoHeaders(1_000_066_666n, false),
        );

        pipeline.tick();

        // 1 configure + 3 decode_video
        expect(commands).toHaveLength(4);
        expect(commands[0]!.type).toBe('configure');
        expect(commands[1]!.type).toBe('decode_video');
        expect(commands[2]!.type).toBe('decode_video');
        expect(commands[3]!.type).toBe('decode_video');
    });

    it('cross-subgroup arrival → reordered by (groupId, objectId) (§4.3)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Arrive out of order from different subgroups
        pipeline.pushObject(
            makeData(0, 2, new Uint8Array([0x03]), 1),
            videoHeaders(1_000_066_666n, false),
        );
        pipeline.pushObject(
            makeData(0, 0, new Uint8Array([0x01]), 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(0, 1, new Uint8Array([0x02]), 0),
            videoHeaders(1_000_033_333n, false),
        );

        pipeline.tick();

        // Should produce configure + 3 decodes in objectId order
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes).toHaveLength(3);
        // Verify ordering by checking payloads
        expect((decodes[0]! as any).chunk.data).toEqual(new Uint8Array([0x01]));
        expect((decodes[1]! as any).chunk.data).toEqual(new Uint8Array([0x02]));
        expect((decodes[2]! as any).chunk.data).toEqual(new Uint8Array([0x03]));
    });

    it('END_OF_GROUP gap → skip forward to next group (§10.2.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0; // Clear

        // Group 1 ended explicitly
        pipeline.pushObject(makeGap(1, 0, ObjectStatus.END_OF_GROUP));

        // Group 2 available with keyframe
        pipeline.pushObject(
            makeData(2, 0),
            videoHeaders(1_000_100_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(2, 1),
            videoHeaders(1_000_133_333n, false),
        );

        pipeline.tick();

        // Should skip forward to group 2
        const skipEvt = events.find(e => e.type === 'skip_forward');
        expect(skipEvt).toBeDefined();
        if (skipEvt?.type === 'skip_forward') {
            expect(skipEvt.toGroupId).toBe(2n);
        }

        // Should have reset + configure + decode commands for group 2
        const resets = commands.filter(c => c.type === 'reset');
        expect(resets.length).toBeGreaterThanOrEqual(1);
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBeGreaterThanOrEqual(1);
    });

    it('missing group + timeout → skip_forward event + decoder reset (§10.2.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;
        events.length = 0;

        // Group 1 missing — group 2 arrives
        pipeline.pushObject(
            makeData(2, 0),
            videoHeaders(1_000_100_000n, true, new Uint8Array([0x01])),
        );

        // First tick: timeout not exceeded → WAIT
        pipeline.tick();
        expect(events.filter(e => e.type === 'skip_forward')).toHaveLength(0);

        // Advance past gap timeout (200ms)
        clock.advance(250_000);
        pipeline.tick();

        // Now should skip forward
        const skipEvt = events.find(e => e.type === 'skip_forward');
        expect(skipEvt).toBeDefined();

        // Decoder should be reset
        const resets = commands.filter(c => c.type === 'reset');
        expect(resets.length).toBeGreaterThanOrEqual(1);
    });

    it('keyframe recovery after gap → decode resumes (§2.3.2.2)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;

        // Group 1 ended
        pipeline.pushObject(makeGap(1, 0, ObjectStatus.END_OF_GROUP));

        // Group 2: keyframe + delta
        pipeline.pushObject(
            makeData(2, 0),
            videoHeaders(1_000_100_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(2, 1),
            videoHeaders(1_000_133_333n, false),
        );

        pipeline.tick();

        // After skip + keyframe, should decode group 2 objects
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBeGreaterThanOrEqual(2);
    });

    it('END_OF_TRACK → track_ended event + flush (§10.2.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;
        events.length = 0;

        // END_OF_TRACK
        pipeline.pushObject(makeGap(0, 1, ObjectStatus.END_OF_TRACK));
        pipeline.tick();

        const endedEvt = events.find(e => e.type === 'track_ended');
        expect(endedEvt).toBeDefined();

        const flushCmd = commands.find(c => c.type === 'flush');
        expect(flushCmd).toBeDefined();
    });

    it('track_ended emits only once across multiple ticks', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        events.length = 0;

        // END_OF_TRACK
        pipeline.pushObject(makeGap(0, 1, ObjectStatus.END_OF_TRACK));
        pipeline.tick();
        pipeline.tick();
        pipeline.tick();

        const endedEvents = events.filter(e => e.type === 'track_ended');
        expect(endedEvents.length).toBe(1);
    });

    it('audio pipeline: gap → immediate resume, no keyframe wait (§4.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'audio', clock });

        // Configure audio decoder (config from catalog, not LOC headers)
        pipeline.configure(new Uint8Array([0x01]));

        // Audio object in group 0
        pipeline.pushObject(
            makeData(0, 0),
            audioHeaders(1_000_000_000n),
        );
        pipeline.tick();

        // sync should have reference now (pipeline sets it for audio)
        expect(sync.hasReference).toBe(true);
        commands.length = 0;

        // Group 1 ended
        pipeline.pushObject(makeGap(1, 0, ObjectStatus.END_OF_GROUP));

        // Group 2 audio
        pipeline.pushObject(
            makeData(2, 0),
            audioHeaders(1_000_100_000n),
        );

        pipeline.tick();

        // Audio should decode immediately after gap — no keyframe waiting
        const decodes = commands.filter(c => c.type === 'decode_audio');
        expect(decodes.length).toBeGreaterThanOrEqual(1);

        // Should NOT have keyframe_waiting event
        const kfEvents = events.filter(e => e.type === 'keyframe_waiting');
        expect(kfEvents).toHaveLength(0);
    });

    it('render timing uses sync controller CaptureTimestamp mapping (§2.3.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });

        // Audio baseline: capture 1000s → local 5s
        sync.setAudioReference(1_000_000_000n);

        // Video captured 33333µs after audio reference
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_033_333n, true, new Uint8Array([0x01])),
        );

        pipeline.tick();

        // renderTimeUs = 5_000_000 + (1_000_033_333 - 1_000_000_000) = 5_033_333
        const decodeCmd = commands.find(c => c.type === 'decode_video');
        expect(decodeCmd).toBeDefined();
        if (decodeCmd?.type === 'decode_video') {
            expect(decodeCmd.renderTimeUs).toBe(5_033_333);
        }
    });

    it('buffer overflow → insert rejected', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const smallConfig: PlaybackConfig = { ...DEFAULT_CONFIG, maxBufferDepth: 2 };
        const { pipeline, commands, sync } = createPipeline({
            mediaType: 'video',
            clock,
            config: smallConfig,
        });
        sync.setAudioReference(1_000_000_000n);

        // Push 3 objects into buffer with depth 2
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(0, 1),
            videoHeaders(1_000_033_333n, false),
        );
        // Third should fail silently (buffer full)
        pipeline.pushObject(
            makeData(0, 2),
            videoHeaders(1_000_066_666n, false),
        );

        pipeline.tick();

        // Only 2 objects should have been decoded (configure + 2 decode)
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes).toHaveLength(2);
    });

    // ─── Priority-aware buffer management (§7) ─────────────────────

    it('buffer full + high-priority incoming → evicts low-priority (§7)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const smallConfig: PlaybackConfig = { ...DEFAULT_CONFIG, maxBufferDepth: 2 };
        const { pipeline, commands, sync } = createPipeline({
            mediaType: 'video',
            clock,
            config: smallConfig,
        });
        sync.setAudioReference(1_000_000_000n);

        // First: consume keyframe to configure decoder and enter DECODING state
        pipeline.pushObject(
            makeData(0, 0, new Uint8Array([0xCA, 0xFE]), 0, 10),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;

        // Now fill buffer with low-priority deltas (priority 200 = low importance)
        pipeline.pushObject(
            makeData(0, 1, new Uint8Array([0xCA, 0xFE]), 0, 200),
            videoHeaders(1_000_033_333n, false),
        );
        pipeline.pushObject(
            makeData(0, 2, new Uint8Array([0xCA, 0xFE]), 0, 200),
            videoHeaders(1_000_066_666n, false),
        );

        // High-priority object arrives (priority 10 = high importance)
        // renderTimeUs = 5_000_000 + 100_000 = 5_100_000
        pipeline.pushObject(
            makeData(0, 3, new Uint8Array([0xCA, 0xFE]), 0, 10),
            videoHeaders(1_000_100_000n, false),
        );

        pipeline.tick();

        // Eviction created an intra-group gap (the evicted delta is
        // gone). The contiguity check discards the rest of the group
        // and resets to NEEDS_KEYFRAME — decoding a frame without its
        // reference would produce artifacts. The high-priority object
        // was accepted into the buffer (eviction worked) but not
        // decoded (gap prevents it). A decoder reset command should
        // have been emitted instead.
        const resets = commands.filter(c => c.type === 'reset');
        expect(resets.length).toBeGreaterThanOrEqual(1);
    });

    it('buffer full + low-priority incoming → dropped, no eviction (§7)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const smallConfig: PlaybackConfig = { ...DEFAULT_CONFIG, maxBufferDepth: 2 };
        const { pipeline, commands, sync } = createPipeline({
            mediaType: 'video',
            clock,
            config: smallConfig,
        });
        sync.setAudioReference(1_000_000_000n);

        // First: consume keyframe to configure decoder
        pipeline.pushObject(
            makeData(0, 0, new Uint8Array([0xCA, 0xFE]), 0, 10),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;

        // Fill buffer with high-priority deltas (priority 10 = high importance)
        pipeline.pushObject(
            makeData(0, 1, new Uint8Array([0xCA, 0xFE]), 0, 10),
            videoHeaders(1_000_033_333n, false),
        );
        pipeline.pushObject(
            makeData(0, 2, new Uint8Array([0xCA, 0xFE]), 0, 10),
            videoHeaders(1_000_066_666n, false),
        );

        // Low-priority object arrives (priority 200 = low importance)
        // renderTimeUs would be 5_100_000 — but it should NOT appear
        pipeline.pushObject(
            makeData(0, 3, new Uint8Array([0xCA, 0xFE]), 0, 200),
            videoHeaders(1_000_100_000n, false),
        );

        pipeline.tick();

        // Low-priority incoming dropped — only original 2 decoded
        const decodes = commands.filter(c => c.type === 'decode_video');
        const renderTimes = decodes.map(c => (c as any).renderTimeUs);
        expect(renderTimes).not.toContain(5_100_000);
        expect(decodes).toHaveLength(2);
    });

    it('empty tick → no commands', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events } = createPipeline({ mediaType: 'video', clock });

        pipeline.tick();

        expect(commands).toHaveLength(0);
        expect(events).toHaveLength(0);
    });

    it('after SKIP_FORWARD, stale objects from pre-skip groups are rejected', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;
        events.length = 0;

        // Group 1 missing, group 3 arrives → will trigger SKIP_FORWARD after timeout
        pipeline.pushObject(
            makeData(3, 0),
            videoHeaders(1_000_200_000n, true, new Uint8Array([0x01])),
        );

        // Advance past gap timeout to trigger SKIP_FORWARD to group 3
        clock.advance(250_000);
        pipeline.tick();
        commands.length = 0;

        // Verify skip happened
        const skipEvt = events.find(e => e.type === 'skip_forward');
        expect(skipEvt).toBeDefined();

        // Now stale objects from group 1 arrive late (from in-flight QUIC stream)
        pipeline.pushObject(
            makeData(1, 0),
            videoHeaders(1_000_050_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(1, 1),
            videoHeaders(1_000_083_333n, false),
        );

        pipeline.tick();

        // Stale group 1 objects should NOT generate decode commands
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes).toHaveLength(0);
    });

    it('renders video at clock.now() when >5s BEHIND audio without resetting sync (past misalignment)', () => {
        const clock = new MockClock();
        clock.set(8_000_000); // 8 seconds after page load
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });

        // Audio established sync reference from a captureTimestamp far ahead
        // of the video stream (audio group joined at a different media position)
        sync.setAudioReference(78_262_000_000n); // ~78262 seconds

        // Configure video decoder
        pipeline.configure(new Uint8Array([0x01, 0x64]));

        // Video group arrives with captureTimestamp ~79s BEHIND the audio reference
        // This simulates audio/video subscriptions joining at different media points
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(78_183_000_000n, true), // ~79s behind audio → offsetUs ≈ -79s
        );
        pipeline.pushObject(
            makeData(0, 1),
            videoHeaders(78_183_033_333n, false),
        );

        pipeline.tick();

        // Despite massive offset, frames should NOT be dropped — rendered at clock.now()
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBeGreaterThanOrEqual(2);

        // CRITICAL: Sync reference must NOT be cleared — audio scheduling depends on
        // a stable reference. Resetting each video tick would garble audio output.
        expect(sync.hasReference).toBe(true);
    });

    it('renders video at clock.now() when timestamp is >5s AHEAD without resetting audio sync', () => {
        const clock = new MockClock();
        clock.set(8_000_000); // 8 seconds after page load
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });

        // Audio established sync reference at a low captureTimestamp
        sync.setAudioReference(55_837_008n); // ~55.8 seconds (audio epoch)

        // Configure video decoder
        pipeline.configure(new Uint8Array([0x01, 0x64]));

        // Video arrives with captureTimestamp ~49s AHEAD of the audio reference.
        // This simulates Red5's misaligned audio/video capture clocks.
        // Without the fix, these frames would be scheduled 49 seconds in the future.
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(104_741_820n, true), // ~49s ahead of audio → offsetUs ≈ +49s
        );
        pipeline.pushObject(
            makeData(0, 1),
            videoHeaders(104_775_153n, false),
        );

        pipeline.tick();

        // Despite massive positive offset, frames should NOT be delayed — rendered at clock.now()
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBeGreaterThanOrEqual(2);

        // CRITICAL: Sync reference must NOT be cleared — audio scheduling depends on
        // a stable reference. Resetting would cause audio render times to jump,
        // producing garbled/overlapping audio output.
        expect(sync.hasReference).toBe(true);
    });

    it('decodes video when VideoFrameMarking is absent — infers keyframe from objectId=0 (LOC §4.2)', () => {
        // MoQ data model: Group = GOP, objectId 0 = keyframe.
        // If the publisher omits the VideoFrameMarking LOC extension,
        // the pipeline should infer keyframe status from the group structure
        // rather than staying stuck in NEEDS_KEYFRAME.
        const clock = new MockClock();
        clock.set(1_000_000);
        const { pipeline, commands } = createPipeline({ mediaType: 'video', clock });

        // Configure the decoder (moves from IDLE → NEEDS_KEYFRAME)
        pipeline.configure(new Uint8Array([0x01, 0x64]));

        // Push 3 objects WITHOUT VideoFrameMarking headers (server doesn't send LOC extensions)
        // objectId 0 = keyframe by convention, objectId 1,2 = delta frames
        const headersNoMarking: LocHeaders = {};
        pipeline.pushObject(makeData(0, 0), headersNoMarking);
        pipeline.pushObject(makeData(0, 1), headersNoMarking);
        pipeline.pushObject(makeData(0, 2), headersNoMarking);

        pipeline.tick();

        // All 3 should be decoded — objectId 0 inferred as keyframe
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBe(3);
    });

    // ─── Pipeline reset (pause→resume) ─────────────────────────────

    it('reset() clears buffer and accepts fresh groups without gap escalation', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });

        // Establish sync and process group 0
        sync.setAudioReference(1_000_000_000n);
        pipeline.configure(new Uint8Array([0x01]));
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        expect(commands.filter(c => c.type === 'decode_video').length).toBe(1);

        // Simulate pause→resume: reset pipeline
        pipeline.reset();

        // After reset, a 'reset' command should have been emitted (decoder needs new keyframe)
        expect(commands.some(c => c.type === 'reset')).toBe(true);

        // Clear command/event collectors
        commands.length = 0;
        events.length = 0;

        // Re-establish sync for new position
        clock.set(50_000_000);
        sync.setAudioReference(2_000_000_000n);

        // Push objects at a much later group (500) — should NOT trigger gap escalation
        pipeline.pushObject(
            makeData(500, 0),
            videoHeaders(2_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(500, 1),
            videoHeaders(2_000_033_333n, false),
        );
        pipeline.tick();

        // Objects should be decoded — no gap spam
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBe(2);

        // No recovery events should have fired
        const recoveries = events.filter(e => e.type === 'recovery');
        expect(recoveries.length).toBe(0);
    });

    it('reset() emits decoder reset command for video (needs new keyframe)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands } = createPipeline({ mediaType: 'video', clock });

        pipeline.configure(new Uint8Array([0x01]));
        pipeline.reset();

        const resets = commands.filter(c => c.type === 'reset');
        expect(resets.length).toBe(1);
        expect(resets[0]!.mediaType).toBe('video');
    });

    it('reset() emits decoder reset command for audio', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands } = createPipeline({ mediaType: 'audio', clock });

        pipeline.configure(new Uint8Array([0x01]));
        pipeline.reset();

        const resets = commands.filter(c => c.type === 'reset');
        expect(resets.length).toBe(1);
        expect(resets[0]!.mediaType).toBe('audio');
    });

    // ─── Seek reset with target group (§9.11.1) ──────────────────

    it('reset(targetGroupId) rejects stale in-flight objects from groups before target (§9.11.1)', () => {
        // §9.11.1: "it might still receive Objects outside the new range
        // if the publisher sent them before the update was processed."
        // The pipeline must reject these stale objects.
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.configure(new Uint8Array([0x01]));
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;

        // Seek to group 10 — reset with target
        pipeline.reset(10n);

        // Re-establish sync
        clock.set(50_000_000);
        sync.setAudioReference(2_000_000_000n);

        // Stale in-flight objects from group 5 arrive (before seek target)
        pipeline.pushObject(
            makeData(5, 0),
            videoHeaders(1_500_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(5, 1),
            videoHeaders(1_500_033_333n, false),
        );

        // Clear the reset command from commands
        commands.length = 0;

        pipeline.tick();

        // Stale objects MUST NOT generate decode commands
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes).toHaveLength(0);
    });

    it('reset(targetGroupId) accepts objects from target group and later (§9.11.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.configure(new Uint8Array([0x01]));
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;

        // Seek to group 10
        pipeline.reset(10n);

        // Re-establish sync
        clock.set(50_000_000);
        sync.setAudioReference(2_000_000_000n);

        // Objects from the target group arrive
        pipeline.pushObject(
            makeData(10, 0),
            videoHeaders(2_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.pushObject(
            makeData(10, 1),
            videoHeaders(2_000_033_333n, false),
        );

        // Clear reset command
        commands.length = 0;

        pipeline.tick();

        // Target group objects MUST be decoded
        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBe(2);
    });

    it('reset() without targetGroupId still accepts all groups (backward compat)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        // Consume group 0
        pipeline.configure(new Uint8Array([0x01]));
        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
        );
        pipeline.tick();
        commands.length = 0;

        // Reset without target (pause→resume)
        pipeline.reset();

        // Re-establish sync
        clock.set(50_000_000);
        sync.setAudioReference(2_000_000_000n);

        // Any group should be accepted
        pipeline.pushObject(
            makeData(500, 0),
            videoHeaders(2_000_000_000n, true, new Uint8Array([0x01])),
        );

        commands.length = 0;
        pipeline.tick();

        const decodes = commands.filter(c => c.type === 'decode_video');
        expect(decodes.length).toBe(1);
    });

    // ─── Decoder feedback (§7 backpressure, §2.3.1.1 drift) ──────────

    describe('decoder feedback', () => {
        it('throttles tick() draining on high queue pressure', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Configure + push objects
            pipeline.pushObject(
                makeData(0, 0),
                videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
            );
            pipeline.pushObject(
                makeData(0, 1),
                videoHeaders(1_000_033_333n, false),
            );

            // Signal high queue pressure
            pipeline.handleFeedback({
                type: 'queue_pressure',
                mediaType: 'video',
                depth: 8,
                maxRecommended: 8,
            });

            expect(pipeline.throttled).toBe(true);

            pipeline.tick();

            // No decode commands — draining is throttled.
            // Un-throttle comes from CommandDispatcher on frame output.
            const decodes = commands.filter(c => c.type === 'decode_video');
            expect(decodes).toHaveLength(0);
        });

        it('un-throttles on low queue pressure', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            pipeline.pushObject(
                makeData(0, 0),
                videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
            );

            // Throttle then un-throttle
            pipeline.handleFeedback({
                type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8,
            });
            expect(pipeline.throttled).toBe(true);

            pipeline.handleFeedback({
                type: 'queue_pressure', mediaType: 'video', depth: 3, maxRecommended: 8,
            });
            expect(pipeline.throttled).toBe(false);

            pipeline.tick();

            // Should drain now
            const decodes = commands.filter(c => c.type === 'decode_video');
            expect(decodes.length).toBeGreaterThanOrEqual(1);
        });

        it('gap evaluation still runs while throttled', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, events, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Consume group 0
            pipeline.pushObject(
                makeData(0, 0),
                videoHeaders(1_000_000_000n, true, new Uint8Array([0x01])),
            );
            pipeline.tick();
            events.length = 0;

            // Group 1 missing, group 2 arrives
            pipeline.pushObject(
                makeData(2, 0),
                videoHeaders(1_000_100_000n, true, new Uint8Array([0x01])),
            );

            // Throttle the pipeline
            pipeline.handleFeedback({
                type: 'queue_pressure', mediaType: 'video', depth: 10, maxRecommended: 8,
            });

            // Advance past gap timeout
            clock.advance(250_000);
            pipeline.tick();

            // skip_forward should still fire even while throttled
            const skipEvt = events.find(e => e.type === 'skip_forward');
            expect(skipEvt).toBeDefined();
        });

        it('routes decode_error to RecoveryController', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const recovery = new DefaultRecoveryController({ maxDecodeErrors: 2 });
            const { pipeline, events } = createPipeline({
                mediaType: 'video', clock, recovery,
            });

            pipeline.handleFeedback({
                type: 'decode_error', mediaType: 'video', message: 'codec error',
            });

            const recoveryEvt = events.find(e => e.type === 'recovery');
            expect(recoveryEvt).toBeDefined();
            if (recoveryEvt?.type === 'recovery') {
                // First decode_error → resubscribe (per DefaultRecoveryController)
                expect(recoveryEvt.action.type).toBe('resubscribe');
            }
        });

        it('resets video decoder FSM to NEEDS_KEYFRAME on decode_error', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const { pipeline, commands } = createPipeline({ mediaType: 'video', clock, sync });

            // Configure and send a keyframe → decoder enters DECODING state
            pipeline.configure(new Uint8Array([0x01]));
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true));
            pipeline.tick();
            const decodeCount1 = commands.filter(c => c.type === 'decode_video').length;
            expect(decodeCount1).toBe(1);

            // Decode error → decoder should reset to NEEDS_KEYFRAME
            pipeline.handleFeedback({
                type: 'decode_error', mediaType: 'video', message: 'codec error',
            });

            // Now push a delta frame — should be SKIPPED (waiting for keyframe)
            commands.length = 0;
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_333n, false));
            pipeline.tick();
            const decodeCount2 = commands.filter(c => c.type === 'decode_video').length;
            expect(decodeCount2).toBe(0); // Skipped — no keyframe yet

            // End group 0 so the transition to group 1 is allowed
            pipeline.pushObject(makeGap(0, 2, ObjectStatus.END_OF_GROUP));

            // Push a keyframe — should decode
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_000_066_666n, true));
            pipeline.tick();
            const decodeCount3 = commands.filter(c => c.type === 'decode_video').length;
            expect(decodeCount3).toBe(1); // Keyframe accepted
        });

        it('does not reset audio decoder FSM on decode_error (audio is always key)', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands } = createPipeline({ mediaType: 'audio', clock });

            pipeline.configure(new Uint8Array([0x01]));
            pipeline.pushObject(makeData(0, 0), audioHeaders(1_000_000_000n));
            pipeline.tick();
            expect(commands.filter(c => c.type === 'decode_audio').length).toBe(1);

            // Decode error
            pipeline.handleFeedback({
                type: 'decode_error', mediaType: 'audio', message: 'codec error',
            });

            // Audio should still decode — all chunks are independently decodable
            commands.length = 0;
            pipeline.pushObject(makeData(0, 1), audioHeaders(1_000_020_000n));
            pipeline.tick();
            expect(commands.filter(c => c.type === 'decode_audio').length).toBe(1);
        });

        it('forwards frame_rendered to SyncController', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const { pipeline } = createPipeline({ mediaType: 'video', clock, sync });

            // Report actual render time
            pipeline.handleFeedback({
                type: 'frame_rendered',
                mediaType: 'video',
                captureTimestampUs: 1_000_100_000n,
                actualRenderUs: 5_100_500, // 500µs off from expected
            });

            // Drift should be updated
            expect(sync.currentDriftUs).not.toBe(0);
        });

        it('emits sync_drift when drift exceeds threshold', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const { pipeline, events } = createPipeline({ mediaType: 'video', clock, sync });

            // Report a render time with massive drift (>500ms)
            pipeline.handleFeedback({
                type: 'frame_rendered',
                mediaType: 'video',
                captureTimestampUs: 1_000_100_000n,
                actualRenderUs: 5_700_000, // expected ~5_100_000, so drift ~600_000
            });

            const driftEvt = events.find(e => e.type === 'sync_drift');
            expect(driftEvt).toBeDefined();
        });

        it('no sync_drift when drift below threshold', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const { pipeline, events } = createPipeline({ mediaType: 'video', clock, sync });

            // Report a render time with small drift (<500ms)
            pipeline.handleFeedback({
                type: 'frame_rendered',
                mediaType: 'video',
                captureTimestampUs: 1_000_100_000n,
                actualRenderUs: 5_100_100, // ~100µs drift — well within threshold
            });

            const driftEvt = events.find(e => e.type === 'sync_drift');
            expect(driftEvt).toBeUndefined();
        });

        it('ignores frame_rendered with zero captureTimestampUs', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const { pipeline, events } = createPipeline({ mediaType: 'video', clock, sync });

            // Report with 0n — e.g., CanvasRenderer doesn't track capture timestamps
            pipeline.handleFeedback({
                type: 'frame_rendered',
                mediaType: 'video',
                captureTimestampUs: 0n,
                actualRenderUs: 5_100_000,
            });

            // Drift should NOT be updated (0n guard)
            expect(sync.currentDriftUs).toBe(0);
            // No sync_drift event
            expect(events.find(e => e.type === 'sync_drift')).toBeUndefined();
        });

        it('flush_complete is no-op', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, events } = createPipeline({ mediaType: 'video', clock });

            // Should not throw or emit anything
            pipeline.handleFeedback({
                type: 'flush_complete', mediaType: 'video',
            });

            expect(commands).toHaveLength(0);
            expect(events).toHaveLength(0);
        });

        it('decode_error clears throttle (prevents deadlock after decoder recreation)', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline } = createPipeline({ mediaType: 'audio', clock });

            // Simulate: initial burst → high queue → throttle
            pipeline.handleFeedback({
                type: 'queue_pressure', mediaType: 'audio', depth: 10, maxRecommended: 8,
            });
            expect(pipeline.throttled).toBe(true);

            // Decoder errors and recreates — queue is now 0 but no output
            // to trigger queue_pressure_low. decode_error must clear throttle.
            pipeline.handleFeedback({
                type: 'decode_error', mediaType: 'audio', message: 'Decoding error.',
            });
            expect(pipeline.throttled).toBe(false);
        });

        it('reset() clears throttle state', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline } = createPipeline({ mediaType: 'video', clock });

            pipeline.handleFeedback({
                type: 'queue_pressure', mediaType: 'video', depth: 10, maxRecommended: 8,
            });
            expect(pipeline.throttled).toBe(true);

            pipeline.reset();
            expect(pipeline.throttled).toBe(false);
        });
    });

    // ─── Live Catch-Up (§5.1.16) ──────────────────────────────────

    describe('catch-up', () => {
        // Mock wall clock for latency measurement
        class MockWallClock {
            private _now = 0;
            now(): number { return this._now; }
            set(us: number): void { this._now = us; }
        }

        function createCatchUpPipeline(wallClock: MockWallClock) {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
                targetLatencyMs: 1000,
                maxCatchUpRate: 1.1,
                catchUpThresholdMs: 500,
                catchUpRecoveryMs: 50,
                wallClock,
            });
            const commands: DecoderCommand[] = [];
            const events: PlaybackEvent[] = [];
            const pipeline = new PlaybackPipeline({
                mediaType: 'audio',
                config: DEFAULT_CONFIG,
                clock,
                sync,
                onCommand: (cmd) => commands.push(cmd),
                onEvent: (evt) => events.push(evt),
            });
            return { pipeline, commands, events, sync, clock };
        }

        it('emits set_playback_rate command during catch-up (§5.1.16)', () => {
            const wallClock = new MockWallClock();
            const { pipeline, commands, sync } = createCatchUpPipeline(wallClock);

            // Set up audio reference
            sync.setAudioReference(1_000_000_000n);

            // Configure audio decoder first
            pipeline.configure(new Uint8Array([0x00]));

            // Push audio object with high latency (1600ms > target 1000 + threshold 500)
            wallClock.set(1_001_600_000);
            pipeline.pushObject(
                makeData(0, 0),
                audioHeaders(1_000_000_000n),
            );
            pipeline.tick();

            // Should have: configure + catch_up rate command + decode_audio
            const rateCmd = commands.find(c => c.type === 'set_playback_rate');
            expect(rateCmd).toBeDefined();
            expect((rateCmd as any).rate).toBeGreaterThan(1.0);
        });

        it('emits catch_up_changed event on activation (§5.1.16)', () => {
            const wallClock = new MockWallClock();
            const { pipeline, events, sync } = createCatchUpPipeline(wallClock);

            sync.setAudioReference(1_000_000_000n);
            pipeline.configure(new Uint8Array([0x00]));

            // Push with high latency
            wallClock.set(1_001_600_000);
            pipeline.pushObject(makeData(0, 0), audioHeaders(1_000_000_000n));
            pipeline.tick();

            const catchUpEvt = events.find(e => e.type === 'catch_up_changed');
            expect(catchUpEvt).toBeDefined();
            expect((catchUpEvt as any).state.active).toBe(true);
            expect((catchUpEvt as any).state.latencyMs).toBe(1600);
        });

        it('does not spam commands when rate unchanged', () => {
            const wallClock = new MockWallClock();
            const { pipeline, commands, sync } = createCatchUpPipeline(wallClock);

            sync.setAudioReference(1_000_000_000n);
            pipeline.configure(new Uint8Array([0x00]));

            // Push two objects at the same latency — rate should be emitted once
            wallClock.set(1_001_600_000);
            pipeline.pushObject(makeData(0, 0), audioHeaders(1_000_000_000n));
            pipeline.tick();

            const firstRateCount = commands.filter(c => c.type === 'set_playback_rate').length;
            expect(firstRateCount).toBe(1);

            // Push another object at same latency — rate unchanged, no new command
            pipeline.pushObject(makeData(0, 1), audioHeaders(1_000_000_001n));
            pipeline.tick();

            const secondRateCount = commands.filter(c => c.type === 'set_playback_rate').length;
            expect(secondRateCount).toBe(1); // Still 1 — not spammed
        });
    });

    // ── Automatic sync re-anchor on drift ────────────────────────────

    describe('sync reference stability', () => {
        it('does NOT re-anchor on drift — reference set once for stability', () => {
            const clock = new MockClock();
            clock.set(5_000_000);

            const config: PlaybackConfig = {
                gapTimeoutUs: 200_000,
                driftThresholdUs: 200_000,
                maxBufferDepth: 100,
            };
            const sync = new SyncController({
                driftThresholdUs: config.driftThresholdUs,
                clock,
            });

            const { pipeline } = createPipeline({
                mediaType: 'audio',
                clock,
                config,
                sync,
            });

            pipeline.configure(new Uint8Array([0x01]));

            // First audio sample sets the sync reference
            pipeline.pushObject(makeData(0, 0), audioHeaders(1_000_000_000n));
            pipeline.tick();
            expect(sync.hasReference).toBe(true);

            // Simulate drift
            clock.set(5_700_000);
            pipeline.handleFeedback({
                type: 'frame_rendered',
                captureTimestampUs: 1_000_400_000n,
                actualRenderUs: 5_700_000,
            });

            // Drift is detected but reference is NOT reset —
            // re-anchoring destabilizes render times when video uses
            // output-side recompute. Jitter is handled by adaptive tolerance.
            pipeline.pushObject(makeData(0, 1), audioHeaders(1_000_500_000n));
            pipeline.tick();

            // Reference should NOT have been reset — drift persists
            expect(sync.currentDriftUs).not.toBe(0);
        });

        it('does not re-anchor from video pipeline (only audio sets reference)', () => {
            const clock = new MockClock();
            clock.set(5_000_000);

            const config: PlaybackConfig = {
                gapTimeoutUs: 200_000,
                driftThresholdUs: 200_000,
                maxBufferDepth: 100,
            };
            const sync = new SyncController({
                driftThresholdUs: config.driftThresholdUs,
                clock,
            });

            // Set initial reference from audio externally
            sync.setAudioReference(1_000_000_000n);

            const { pipeline } = createPipeline({
                mediaType: 'video',
                clock,
                config,
                sync,
            });

            pipeline.configure(new Uint8Array([0x01]));

            // Simulate drift
            clock.set(5_700_000);
            pipeline.handleFeedback({
                type: 'frame_rendered',
                captureTimestampUs: 1_000_400_000n,
                actualRenderUs: 5_700_000,
            });

            expect(sync.needsResync).toBe(true);

            // Push a video keyframe — should NOT re-anchor (that's audio's job)
            pipeline.pushObject(
                makeData(0, 0),
                videoHeaders(1_000_500_000n, true),
            );
            pipeline.tick();

            // Video doesn't reset the audio sync reference.
            // needsResync may be suppressed during video join phase (offset active),
            // but the audio reference (localBaselineUs/captureBaselineUs) is unchanged.
            // Verify the drift value itself is still large (reference wasn't reset).
            expect(Math.abs(sync.currentDriftUs)).toBeGreaterThan(200_000);
        });
    });

    // ── Adaptive tolerance integration ──────────────────────────────

    describe('adaptive tolerance integration', () => {
        it('updates gap detector timeout from adaptive controller', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const config: PlaybackConfig = {
                gapTimeoutUs: 500_000,   // 500ms initial
                driftThresholdUs: 500_000,
                maxBufferDepth: 100,
                adaptiveTolerance: true,
            };

            const { pipeline } = createPipeline({
                mediaType: 'video',
                clock,
                config,
                sync,
            });

            pipeline.configure(new Uint8Array([0x01]));

            // Feed frames with jitter — the adaptive controller should lower
            // the gap timeout from the initial 500ms to something auto-calibrated
            for (let i = 0; i < 60; i++) {
                const jitter = (i % 2 === 0) ? 5000 : -5000; // ±5ms in µs
                clock.advance(33333 + jitter);
                pipeline.pushObject(
                    makeData(0, i),
                    videoHeaders(BigInt(1_000_000_000 + i * 33333), i === 0),
                );
            }
            pipeline.tick();

            // The adaptive gap timeout should be < 500ms (the initial fixed value)
            // since observed jitter is only ±5ms
            expect(pipeline.effectiveGapTimeoutUs).toBeLessThan(500_000);
            expect(pipeline.effectiveGapTimeoutUs).toBeGreaterThanOrEqual(50_000);
        });

        it('pipeline without adaptive tolerance uses fixed gap timeout', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({
                driftThresholdUs: 500_000,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            const config: PlaybackConfig = {
                gapTimeoutUs: 500_000,
                driftThresholdUs: 500_000,
                maxBufferDepth: 100,
                // adaptiveTolerance not set → disabled
            };

            const { pipeline } = createPipeline({
                mediaType: 'video',
                clock,
                config,
                sync,
            });

            // Without adaptive tolerance, effectiveGapTimeoutUs === config value
            expect(pipeline.effectiveGapTimeoutUs).toBe(500_000);
        });
    });

    // ─── Bounded release ─────────────────────────────────────────────

    describe('bounded release (pre-decode backlog control)', () => {
        it('video: releases at most maxReleasePerTick objects per tick', () => {
            const clock = new MockClock();
            clock.set(1_000_000);
            const { pipeline, commands, sync } = createPipeline({
                mediaType: 'video',
                clock,
                config: { ...DEFAULT_CONFIG, maxReleasePerTick: 2, maxBacklogGroups: 0 },
            });
            sync.setAudioReference(1_000_000_000n);

            // Push 5 objects in group 0
            pipeline.pushObject(
                makeData(0, 0),
                videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])),
            );
            for (let i = 1; i < 5; i++) {
                pipeline.pushObject(makeData(0, i), videoHeaders(BigInt(1_000_000_000 + i * 33_000), false));
            }

            pipeline.tick();

            // Should have released only 2 objects (configure + decode for first, decode for second)
            const decodeCommands = commands.filter(c => c.type === 'decode_video' || c.type === 'configure');
            expect(decodeCommands.length).toBeLessThanOrEqual(3); // configure + 2 decodes max

            // Second tick should release more
            commands.length = 0;
            pipeline.tick();
            const moreDecodes = commands.filter(c => c.type === 'decode_video');
            expect(moreDecodes.length).toBeGreaterThan(0);
        });

        it('audio: drains all objects regardless of maxReleasePerTick', () => {
            const clock = new MockClock();
            clock.set(1_000_000);
            const { pipeline, commands } = createPipeline({
                mediaType: 'audio',
                clock,
                config: { ...DEFAULT_CONFIG, maxReleasePerTick: 2 },
            });

            pipeline.configure(new Uint8Array([0x01]));

            // Push 5 audio objects
            for (let i = 0; i < 5; i++) {
                pipeline.pushObject(makeData(0, i), audioHeaders(BigInt(1_000_000_000 + i * 20_000)));
            }

            pipeline.tick();

            // Audio should drain all — maxReleasePerTick is ignored for audio
            const decodeCommands = commands.filter(c => c.type === 'decode_audio');
            expect(decodeCommands.length).toBe(5);
        });

        it('sheds oldest groups when backlog exceeds maxBacklogGroups', () => {
            const clock = new MockClock();
            clock.set(1_000_000);
            const { pipeline, events, sync } = createPipeline({
                mediaType: 'video',
                clock,
                config: { ...DEFAULT_CONFIG, maxReleasePerTick: 0, maxBacklogGroups: 2 },
            });
            sync.setAudioReference(1_000_000_000n);

            // Push keyframe objects for 5 groups
            for (let g = 0; g < 5; g++) {
                pipeline.pushObject(
                    makeData(g, 0),
                    videoHeaders(BigInt(1_000_000_000 + g * 33_000), true, new Uint8Array([0x01, 0x64])),
                );
            }

            pipeline.tick();

            // Should have shed 3 groups (5 - 2 = 3)
            const shedEvents = events.filter(e => e.type === 'backlog_shed');
            expect(shedEvents.length).toBe(1);
            expect(shedEvents[0]!.droppedGroups).toBe(3);

            // Only 2 groups should remain
            expect(pipeline.bufferedGroupCount).toBeLessThanOrEqual(2);
        });

        it('backlog shedding drops whole groups, not partial', () => {
            const clock = new MockClock();
            clock.set(1_000_000);
            const { pipeline, events, sync } = createPipeline({
                mediaType: 'video',
                clock,
                // maxReleasePerTick=1 so drain doesn't consume everything after shed
                config: { ...DEFAULT_CONFIG, maxReleasePerTick: 1, maxBacklogGroups: 1 },
            });
            sync.setAudioReference(1_000_000_000n);

            // Group 0: 3 objects
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_000n, false));

            // Group 1: 2 objects
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(1, 1), videoHeaders(1_001_033_000n, false));

            pipeline.tick();

            // Group 0 should be shed entirely, group 1 should remain (partially drained)
            const shedEvents = events.filter(e => e.type === 'backlog_shed');
            expect(shedEvents.length).toBe(1);
            expect(shedEvents[0]!.droppedGroups).toBe(1);
            // Group 1 still has objects (budget=1, only 1 released)
            expect(pipeline.bufferedGroupCount).toBeGreaterThanOrEqual(1);
        });

        it('stops draining mid-tick when queue_pressure fires during decode', () => {
            const clock = new MockClock();
            clock.set(1_000_000);

            // Use onCommand callback that injects throttle after 3 decode_video commands
            const commands: DecoderCommand[] = [];
            let pipeline: PlaybackPipeline;
            const sync = new SyncController({
                driftThresholdUs: DEFAULT_CONFIG.driftThresholdUs,
                clock,
            });
            sync.setAudioReference(1_000_000_000n);

            pipeline = new PlaybackPipeline({
                mediaType: 'video',
                config: { ...DEFAULT_CONFIG, maxReleasePerTick: 0, maxBacklogGroups: 0 },
                clock,
                sync,
                onCommand: (cmd) => {
                    commands.push(cmd);
                    // Simulate decoder backpressure after 3 decode commands
                    if (commands.filter(c => c.type === 'decode_video').length === 3) {
                        pipeline.handleFeedback({
                            type: 'queue_pressure', mediaType: 'video',
                            depth: 10, maxRecommended: 8,
                        });
                    }
                },
                onEvent: () => {},
            });

            // Push 10 objects in group 0 (unlimited budget)
            pipeline.pushObject(
                makeData(0, 0),
                videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])),
            );
            for (let i = 1; i < 10; i++) {
                pipeline.pushObject(
                    makeData(0, i),
                    videoHeaders(BigInt(1_000_000_000 + i * 33_000), false),
                );
            }

            pipeline.tick();

            // Should have stopped at 3 decode_video (configure + 3 decodes, then throttled)
            const decodes = commands.filter(c => c.type === 'decode_video').length;
            expect(decodes).toBe(3);
            expect(pipeline.throttled).toBe(true);
        });
    });

    // ─── Stale-group rejection ──────────────────────────────────────

    describe('stale-group rejection during normal forward progress', () => {
        it('rejects late old-group objects after forward consumption', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Consume group 0
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            // End group 0 so the transition to group 1 is allowed
            pipeline.pushObject(makeGap(0, 2, ObjectStatus.END_OF_GROUP));

            // Consume group 1
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.tick();

            const commandsBefore = commands.length;

            // Late group 0 object arrives — should be rejected
            pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_000n, false));
            pipeline.tick();

            // No new decode commands — the stale object was dropped
            expect(commands.length).toBe(commandsBefore);
        });

        it('rejects same-group duplicate/late objects', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Push and consume objects 0 and 1 from group 0
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            const commandsBefore = commands.length;

            // Late duplicate of object 0 arrives — already consumed
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.tick();

            // No new decode commands
            expect(commands.length).toBe(commandsBefore);
        });

        it('dedupes a BUFFERED duplicate by identity before decode (warm-start FETCH/SUBSCRIBE overlap)', () => {
            // Warm-start contract (§9.16.2.1): FETCH pre-roll and live SUBSCRIBE
            // are contiguous by construction, but a non-compliant publisher may
            // overlap them. The same (group, object) arriving once via the
            // FETCH stream and once via live delivery must reach the decoder
            // exactly once — pinned at the pre-decode buffer, not after.
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            // Duplicate of object 1 arrives BEFORE anything is consumed.
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            const decodes = commands.filter((c) => c.type === 'decode_video');
            expect(decodes.length).toBe(2); // objects 0 and 1, each exactly once
        });

        it('fetched group head arriving AFTER the live tail (no intervening tick) decodes in order from object 0', () => {
            // Warm-start ordering: live objects {2,3} can land before the
            // joining-FETCH head {0,1}. When no tick intervenes, the jitter
            // buffer inserts by identity and decode starts at the keyframe.
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_000n, false));
            pipeline.pushObject(makeData(0, 3), videoHeaders(1_000_100_000n, false));
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            const decoded = commands.filter((c) => c.type === 'decode_video');
            expect(decoded.length).toBe(4);
            // In-order from the keyframe: capture timestamps ascend.
            const ts = decoded.map((c: any) => c.captureTimestampUs as bigint);
            expect([...ts].sort((a, b) => Number(a - b))).toEqual(ts);
        });

        it('DOCUMENTED LIMITATION: a tick between live tail and fetched head discards one tail object per tick', () => {
            // The reset-sync path (initial join / pause-resume) extracts and
            // drops the buffer top when it is not a keyframe, one object per
            // tick, until a keyframe-starting group appears. Under warm start
            // this means live-tail objects racing ahead of the FETCH head can
            // be discarded, leaving a gap the existing gap-timeout recovery
            // must skip. This test pins that exact behavior so any future
            // keyframe-wait relaxation shows up as a deliberate change.
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_000n, false));
            pipeline.pushObject(makeData(0, 3), videoHeaders(1_000_100_000n, false));
            pipeline.tick(); // discards object 2 (top, not a keyframe)

            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            // Head decodes; object 3 is stranded behind the discarded 2 (gap
            // recovery, not this test's scope, would eventually skip forward).
            const decoded = commands.filter((c) => c.type === 'decode_video');
            expect(decoded.length).toBe(2);
        });
    });

    // ─── Recovery reset flush ────────────────────────────────────────

    describe('recovery reset emits decoder reset command', () => {
        it('reset() emits reset command so CommandDispatcher flushes decoder/renderer', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Push and consume some objects
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            commands.length = 0;

            // Reset the pipeline (simulating stall recovery)
            pipeline.reset(2n);

            // Should emit a reset command for the decoder/renderer to flush
            const resetCmd = commands.find(c => c.type === 'reset');
            expect(resetCmd).toBeDefined();
            expect((resetCmd as any).mediaType).toBe('video');
        });

        it('reset() clears buffer so stale objects cannot be decoded', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Push objects but don't tick (still in buffer)
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));

            // Reset
            pipeline.reset(5n);
            commands.length = 0;

            // Tick — should NOT produce any decode commands from the old objects
            pipeline.tick();
            const decodes = commands.filter(c => c.type === 'decode_video');
            expect(decodes.length).toBe(0);
        });
    });

    // ─── Partial group transition ────────────────────────────────────

    describe('group lifecycle — explicit abandon on partial GOP (Tranche 2)', () => {
        it('N+1 keyframe before N suffix, BEFORE timeout: pipeline does NOT decode N+1 yet', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Group 0: objects 0-2 consumed (partial — object 3+ could still arrive)
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_000n, false));
            pipeline.tick();

            // Group 1 keyframe arrives — but group 0 is not complete/timed out
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));

            commands.length = 0;
            // Small time advance — NOT past gap timeout
            clock.advance(10_000); // 10ms, well under gap timeout
            pipeline.tick();

            // Pipeline should NOT have decoded group 1 yet — waiting for group 0 suffix
            const group1Decodes = commands.filter(c =>
                c.type === 'decode_video' || c.type === 'configure',
            );
            expect(group1Decodes.length).toBe(0);
        });

        it('N+1 keyframe before N suffix, AFTER timeout: pipeline abandons N with reset, then decodes N+1', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Group 0: objects 0-2 consumed (partial)
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_000n, false));
            pipeline.tick();

            // Group 1 keyframe arrives
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));

            // First tick: drain loop encounters incomplete group 0, starts wait timer
            pipeline.tick();

            commands.length = 0;
            events.length = 0;
            // Advance past gap timeout
            clock.advance(500_000); // 500ms > default gap timeout (200ms in test config)
            pipeline.tick();

            // Should have emitted partial_group_abandoned event BEFORE group 1 decode
            const abandonEvents = events.filter(e => (e as any).type === 'partial_group_abandoned');
            expect(abandonEvents.length).toBe(1);
            expect((abandonEvents[0] as any).fromGroupId).toBe(0n);
            expect((abandonEvents[0] as any).toGroupId).toBe(1n);

            // Should have emitted a reset (abandon of partial group 0)
            const resetCmds = commands.filter(c => c.type === 'reset');
            expect(resetCmds.length).toBeGreaterThan(0);

            // Group N+1 should actually decode after the abandon
            const decodes = commands.filter(c => c.type === 'decode_video');
            expect(decodes.length).toBeGreaterThanOrEqual(1);

            // Ordering invariant: reset must appear before first decode_video
            const resetIdx = commands.findIndex(c => c.type === 'reset');
            const decodeIdx = commands.findIndex(c => c.type === 'decode_video');
            expect(resetIdx).toBeLessThan(decodeIdx);
        });

        it('END_OF_GROUP for N allows normal transition to N+1 without abandon/reset', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Group 0: complete with END_OF_GROUP
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();
            pipeline.pushObject(makeGap(0, 2, ObjectStatus.END_OF_GROUP));

            // Group 1: keyframe
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));

            commands.length = 0;
            events.length = 0;
            pipeline.tick();

            // Should NOT have emitted partial_group_abandoned (group 0 ended normally)
            const abandonEvents = events.filter(e => (e as any).type === 'partial_group_abandoned');
            expect(abandonEvents.length).toBe(0);

            // Group 1 should be decoded
            const decodes = commands.filter(c => c.type === 'decode_video' || c.type === 'configure');
            expect(decodes.length).toBeGreaterThan(0);
        });

        it('group N suffix arrives before timeout: pipeline continues N and does not abandon', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, events, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Group 0: partial (obj 0 only)
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.tick();

            // Group 1: keyframe arrives — timer starts
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.tick(); // starts wait timer

            // Group 0 suffix arrives before timeout
            clock.advance(50_000); // 50ms, well under 200ms gap timeout
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));

            // END_OF_GROUP for group 0 — normal completion
            pipeline.pushObject(makeGap(0, 2, ObjectStatus.END_OF_GROUP));

            commands.length = 0;
            events.length = 0;
            pipeline.tick();

            // No abandon — group 0 completed normally
            const abandonEvents = events.filter(e => (e as any).type === 'partial_group_abandoned');
            expect(abandonEvents.length).toBe(0);

            // Group 0 suffix should be decoded, then group 1
            const decodes = commands.filter(c => c.type === 'decode_video');
            expect(decodes.length).toBeGreaterThanOrEqual(1);
        });

        it('late suffix from abandoned group N is rejected', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
            sync.setAudioReference(1_000_000_000n);

            // Group 0: partial
            pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.tick();

            // Group 1: keyframe
            pipeline.pushObject(makeData(1, 0), videoHeaders(1_001_000_000n, true, new Uint8Array([0x01, 0x64])));
            pipeline.tick(); // starts intra-group wait timer
            clock.advance(500_000); // past timeout — abandon group 0
            pipeline.tick();

            commands.length = 0;

            // Late group 0 suffix arrives
            pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_000n, false));
            pipeline.tick();

            // Rejected — no decode commands
            const decodes = commands.filter(c => c.type === 'decode_video');
            expect(decodes.length).toBe(0);
        });

        it('audio is NOT affected by video group lifecycle (independently decodable)', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const { pipeline, commands, sync } = createPipeline({ mediaType: 'audio', clock });

            pipeline.configure(new Uint8Array([0x01]));

            // Audio group 0
            pipeline.pushObject(makeData(0, 0), audioHeaders(1_000_000_000n));
            pipeline.tick();

            // Audio group 1 — should transition without any abandon logic
            pipeline.pushObject(makeData(1, 0), audioHeaders(1_001_000_000n));

            commands.length = 0;
            pipeline.tick();

            const decodes = commands.filter(c => c.type === 'decode_audio');
            expect(decodes.length).toBe(1);
        });
    });
});
