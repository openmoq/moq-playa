/**
 * Tests for the decoder lifecycle FSM.
 *
 * Tracks whether the decoder needs a keyframe (after startup or a gap)
 * before it can accept delta frames. Audio is always independently
 * decodable — no keyframe wait after gaps.
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking.independent)
 */

import { describe, it, expect } from 'vitest';
import { DecoderStateMachine, DecoderState } from './decoder-state.js';
import type { VideoChunkInit, AudioChunkInit, VideoFrameMarking } from '@moqt/loc';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeVideoChunk(type: 'key' | 'delta', timestamp = 0): VideoChunkInit {
    return { type, timestamp, data: new Uint8Array([0xCA, 0xFE]) };
}

function makeAudioChunk(timestamp = 0): AudioChunkInit {
    return { type: 'key', timestamp, data: new Uint8Array([0x4F, 0x70]) };
}

function makeMarking(independent: boolean): VideoFrameMarking {
    return {
        startOfFrame: true,
        endOfFrame: true,
        independent,
        discardable: false,
        baseLayerSync: false,
        temporalId: 0,
    };
}

// ─── Video Decoder FSM ───────────────────────────────────────────────

describe('DecoderStateMachine — video', () => {
    it('initial state is IDLE', () => {
        const fsm = new DecoderStateMachine('video');
        expect(fsm.state).toBe(DecoderState.IDLE);
        expect(fsm.mediaType).toBe('video');
    });

    it('configure() transitions IDLE → NEEDS_KEYFRAME (§4.2)', () => {
        const fsm = new DecoderStateMachine('video');
        const config = new Uint8Array([0x01, 0x64, 0x00, 0x1e]);
        const decision = fsm.configure(config);

        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
        expect(decision.action).toBe('configure');
        if (decision.action === 'configure') {
            expect(decision.config).toBe(config);
        }
    });

    it('delta frame in NEEDS_KEYFRAME → skip (§2.3.2.2)', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));

        const decision = fsm.processVideoChunk(
            makeVideoChunk('delta'),
            makeMarking(false),
        );
        expect(decision.action).toBe('skip');
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
    });

    it('keyframe in NEEDS_KEYFRAME → DECODING (§2.3.2.2)', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));

        const chunk = makeVideoChunk('key');
        const decision = fsm.processVideoChunk(chunk, makeMarking(true));
        expect(decision.action).toBe('decode');
        if (decision.action === 'decode') {
            expect(decision.chunk).toBe(chunk);
        }
        expect(fsm.state).toBe(DecoderState.DECODING);
    });

    it('delta frame in DECODING → decode', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));
        fsm.processVideoChunk(makeVideoChunk('key'), makeMarking(true));

        const chunk = makeVideoChunk('delta', 33333);
        const decision = fsm.processVideoChunk(chunk, makeMarking(false));
        expect(decision.action).toBe('decode');
        if (decision.action === 'decode') {
            expect(decision.chunk).toBe(chunk);
        }
        expect(fsm.state).toBe(DecoderState.DECODING);
    });

    it('notifyGap() transitions DECODING → NEEDS_KEYFRAME', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));
        fsm.processVideoChunk(makeVideoChunk('key'), makeMarking(true));
        expect(fsm.state).toBe(DecoderState.DECODING);

        const decision = fsm.notifyGap();
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
        expect(decision.action).toBe('reset');
    });

    it('notifyTrackEnded() transitions to ENDED (§10.2.1.1)', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));

        const decision = fsm.notifyTrackEnded();
        expect(fsm.state).toBe(DecoderState.ENDED);
        expect(decision.action).toBe('flush');
    });

    it('processVideoChunk in IDLE → skip', () => {
        const fsm = new DecoderStateMachine('video');
        const decision = fsm.processVideoChunk(makeVideoChunk('key'), makeMarking(true));
        expect(decision.action).toBe('skip');
    });

    it('no VideoFrameMarking → treat as delta, skip in NEEDS_KEYFRAME', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));

        // undefined marking → cannot confirm independent → treat as delta
        const decision = fsm.processVideoChunk(makeVideoChunk('key'), undefined);
        expect(decision.action).toBe('skip');
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
    });

    it('reconfigure with DIFFERENT config in DECODING → NEEDS_KEYFRAME', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));
        fsm.processVideoChunk(makeVideoChunk('key'), makeMarking(true));
        expect(fsm.state).toBe(DecoderState.DECODING);

        const decision = fsm.configure(new Uint8Array([0x02]));
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
        expect(decision.action).toBe('configure');
    });

    it('reconfigure with SAME config in DECODING → skip, stay DECODING', () => {
        const fsm = new DecoderStateMachine('video');
        const config = new Uint8Array([0x01, 0x64, 0x00, 0x1e]);
        fsm.configure(config);
        fsm.processVideoChunk(makeVideoChunk('key'), makeMarking(true));
        expect(fsm.state).toBe(DecoderState.DECODING);

        // Same config bytes → no reconfigure, stay in DECODING
        const decision = fsm.configure(new Uint8Array([0x01, 0x64, 0x00, 0x1e]));
        expect(fsm.state).toBe(DecoderState.DECODING);
        expect(decision.action).toBe('skip');
    });

    it('reconfigure with same config in NEEDS_KEYFRAME → still configures (first time)', () => {
        const fsm = new DecoderStateMachine('video');
        // First configure from IDLE — always configures
        const config = new Uint8Array([0x01]);
        const d1 = fsm.configure(config);
        expect(d1.action).toBe('configure');
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);

        // Second configure with same config while still in NEEDS_KEYFRAME
        // Should skip since config hasn't changed
        const d2 = fsm.configure(new Uint8Array([0x01]));
        expect(d2.action).toBe('skip');
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
    });

    it('reconfigure after gap with same config → skip, stay NEEDS_KEYFRAME', () => {
        const fsm = new DecoderStateMachine('video');
        fsm.configure(new Uint8Array([0x01]));
        fsm.processVideoChunk(makeVideoChunk('key'), makeMarking(true));
        fsm.notifyGap(); // → NEEDS_KEYFRAME
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);

        // Same config after gap → no unnecessary reconfigure
        const decision = fsm.configure(new Uint8Array([0x01]));
        expect(decision.action).toBe('skip');
        expect(fsm.state).toBe(DecoderState.NEEDS_KEYFRAME);
    });
});

// ─── Audio Decoder FSM ───────────────────────────────────────────────

describe('DecoderStateMachine — audio', () => {
    it('audio after gap → immediate decode, no keyframe wait', () => {
        const fsm = new DecoderStateMachine('audio');
        fsm.configure(new Uint8Array([0x01]));
        // Audio goes straight to DECODING after configure (all chunks are key)
        const chunk = makeAudioChunk(1000000);
        const decision = fsm.processAudioChunk(chunk);
        expect(decision.action).toBe('decode');
        expect(fsm.state).toBe(DecoderState.DECODING);

        // Gap occurs
        fsm.notifyGap();
        // Audio: gap should NOT block — stays DECODING or immediately resumes
        const chunk2 = makeAudioChunk(1020000);
        const decision2 = fsm.processAudioChunk(chunk2);
        expect(decision2.action).toBe('decode');
    });
});
