/**
 * Decoder lifecycle FSM.
 *
 * Models the decoder's state without touching actual WebCodecs APIs.
 * Tracks whether a keyframe is needed before delta frames can be decoded
 * (after startup or after a gap).
 *
 * Audio is treated as independently decodable (Opus/AAC-LC frames are
 * self-contained) — no keyframe wait needed.
 *
 * ```
 * IDLE ──configure──► NEEDS_KEYFRAME ──keyframe──► DECODING ──gap──► NEEDS_KEYFRAME
 *                                                      │
 *                                                 END_OF_TRACK
 *                                                      │
 *                                                      ▼
 *                                                    ENDED
 * ```
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking.independent)
 * @module
 */

import type { VideoChunkInit, AudioChunkInit, VideoFrameMarking } from '@moqt/loc';

// ─── State constants ────────────────────────────────────────────────

/**
 * Decoder states.
 */
export const DecoderState = {
    /** Not yet configured. */
    IDLE: 'idle',
    /** Configured but waiting for a keyframe. */
    NEEDS_KEYFRAME: 'needs_keyframe',
    /** Actively decoding. */
    DECODING: 'decoding',
    /** Track ended. */
    ENDED: 'ended',
} as const;

export type DecoderStateValue = (typeof DecoderState)[keyof typeof DecoderState];

// ─── Frame decisions ────────────────────────────────────────────────

/**
 * Decision for each incoming chunk.
 */
export type FrameDecision =
    | { readonly action: 'decode'; readonly chunk: VideoChunkInit | AudioChunkInit }
    | { readonly action: 'skip'; readonly reason: string }
    | { readonly action: 'configure'; readonly config: Uint8Array }
    | { readonly action: 'flush' }
    | { readonly action: 'reset'; readonly reason: string };

// ─── DecoderStateMachine ────────────────────────────────────────────

/**
 * Decoder lifecycle FSM.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 */
export class DecoderStateMachine {
    private _state: DecoderStateValue = DecoderState.IDLE;
    private readonly _mediaType: 'video' | 'audio';
    private lastConfig: Uint8Array | null = null;

    constructor(mediaType: 'video' | 'audio') {
        this._mediaType = mediaType;
    }

    get state(): DecoderStateValue {
        return this._state;
    }

    get mediaType(): 'video' | 'audio' {
        return this._mediaType;
    }

    /**
     * Provide codec configuration.
     *
     * If the config is identical to the last one, skip reconfiguration
     * (stay in current state). This avoids resetting to NEEDS_KEYFRAME
     * on every group boundary when the server sends videoConfig on
     * every group's first object with unchanged codec parameters.
     *
     * Transitions IDLE/DECODING → NEEDS_KEYFRAME (video) or DECODING (audio)
     * only when the config actually changes.
     */
    configure(config: Uint8Array): FrameDecision {
        // Skip if config is unchanged
        if (this.lastConfig !== null && this.configEquals(this.lastConfig, config)) {
            return { action: 'skip', reason: 'config unchanged' };
        }

        this.lastConfig = config;

        if (this._mediaType === 'audio') {
            // Audio chunks are always independently decodable — go straight to DECODING
            this._state = DecoderState.DECODING;
        } else {
            this._state = DecoderState.NEEDS_KEYFRAME;
        }
        return { action: 'configure', config };
    }

    /** Byte-level config comparison. */
    private configEquals(a: Uint8Array, b: Uint8Array): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /**
     * Process a video chunk.
     * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking)
     */
    processVideoChunk(
        chunk: VideoChunkInit,
        marking: VideoFrameMarking | undefined,
    ): FrameDecision {
        if (this._state === DecoderState.IDLE || this._state === DecoderState.ENDED) {
            return { action: 'skip', reason: `decoder is ${this._state}` };
        }

        if (this._state === DecoderState.NEEDS_KEYFRAME) {
            // Need a confirmed independent frame to start decoding
            const isKeyframe = marking?.independent === true;
            if (!isKeyframe) {
                return { action: 'skip', reason: 'waiting for keyframe' };
            }
            this._state = DecoderState.DECODING;
            return { action: 'decode', chunk };
        }

        // DECODING — accept any frame
        return { action: 'decode', chunk };
    }

    /**
     * Process an audio chunk. Audio codecs (Opus, AAC-LC) produce
     * independently decodable frames — no keyframe gating needed.
     */
    processAudioChunk(chunk: AudioChunkInit): FrameDecision {
        if (this._state === DecoderState.IDLE || this._state === DecoderState.ENDED) {
            return { action: 'skip', reason: `decoder is ${this._state}` };
        }

        // Audio is always independently decodable — always decode
        this._state = DecoderState.DECODING;
        return { action: 'decode', chunk };
    }

    /**
     * Signal a gap — decoder needs to wait for next keyframe (video only).
     * Audio: stays in DECODING since all chunks are independently decodable.
     */
    notifyGap(): FrameDecision {
        if (this._mediaType === 'audio') {
            // Audio can resume immediately — all chunks are key
            return { action: 'reset', reason: 'gap detected (audio will resume immediately)' };
        }
        this._state = DecoderState.NEEDS_KEYFRAME;
        return { action: 'reset', reason: 'gap detected' };
    }

    /**
     * Signal track ended.
     * @see draft-ietf-moq-transport-16 §10.2.1.1
     */
    notifyTrackEnded(): FrameDecision {
        this._state = DecoderState.ENDED;
        return { action: 'flush' };
    }
}
