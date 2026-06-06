/**
 * A/V Playback example — video + audio on screen.
 *
 * Full vertical slice exercising every layer:
 *   WebTransport → MoqtConnection → LOC headers → WebCodecs → Canvas + AudioContext
 *
 * Includes minimum gap handling required for live streams:
 * - Object Status 0x3 (End of Group) → skip forward
 * - Object Status 0x4 (End of Track) → stop
 * - Stream reset (DELIVERY_TIMEOUT) → wait for next keyframe
 * - Keyframe gating after gaps (delta frames without keyframe corrupt decoder)
 *
 * Audio requires a user gesture to start (Chrome autoplay policy).
 *
 * Uses the lower packages directly — not @moqt/player.
 *
 * @see draft-ietf-moq-transport-16 §3 (Session)
 * @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-transport-16 §9.2.2.2 (DELIVERY_TIMEOUT)
 * @see draft-ietf-moq-loc-01 §2.2 (LOC payload = EncodedVideoChunk/EncodedAudioChunk.data)
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking)
 * @see draft-ietf-moq-loc-01 §4.1 (Audio: each object independently decodable)
 * @see draft-ietf-moq-loc-01 §4.2 (Video: Group boundary = IDR boundary)
 * @see draft-ietf-moq-msf-00 §5.1.24 (Codec string)
 */

import { MoqtConnection } from '@moqt/webtransport';
import { varint } from '@moqt/transport';
import type { MoqtObject, Varint } from '@moqt/transport';
import { parseCatalog } from '@moqt/msf';
import type { Catalog, CatalogTrack } from '@moqt/msf';
import { parseLocHeaders, toVideoChunkInit } from '@moqt/loc';
import { log } from '../shared/log.js';
import { relayUrl, namespace, certHash } from '../shared/cert.js';

// ─── Capability checks ──────────────────────────────────────────────

if (!('WebTransport' in window)) {
    log('WebTransport is not available. Chrome 97+ or Edge 97+ required.');
    throw new Error('WebTransport not supported');
}

if (!('VideoDecoder' in window)) {
    log('WebCodecs VideoDecoder is not available. Chrome 94+ required.');
    throw new Error('WebCodecs not supported');
}

// ─── Video State ─────────────────────────────────────────────────────

let videoTrackAlias: bigint | null = null;
let videoDecoder: VideoDecoder | null = null;
let videoConfigured = false;
let needsKeyframe = true; // Start true — need first keyframe before decoding
let frameCount = 0;
let videoCodec = '';
let videoWidth = 0;
let videoHeight = 0;
let videoInitData: Uint8Array | undefined;

// ─── Audio State ─────────────────────────────────────────────────────

let audioTrackAlias: bigint | null = null;
let audioDecoder: AudioDecoder | null = null;
let audioCtx: AudioContext | null = null;
let audioCodec = '';
let audioSampleRate = 0;
let audioChannels = 0;
let audioSampleCount = 0;  // Successfully decoded + played
let audioSubmitCount = 0;  // Submitted to decoder (for timestamp fallback)
let audioErrorCount = 0;
let firstAudioTimestamp: number | null = null;
let lastAudioFrameInfo = ''; // For error diagnostics
let nextAudioPlayTime = 0; // AudioContext.currentTime for seamless scheduling

// ─── DOM ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;

// ─── Helpers ─────────────────────────────────────────────────────────

const enc = new TextEncoder();

function encodeNamespace(ns: string): Uint8Array[] {
    return ns
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .map((segment) => enc.encode(segment));
}

function updateStats(): void {
    statsEl.textContent = `Video: ${frameCount} frames | Audio: ${audioSampleCount} chunks`;
}

/**
 * Prepend a 7-byte ADTS header to a raw AAC access unit.
 *
 * The W3C AAC WebCodecs Registration defines two modes:
 *   - description present  → raw `raw_data_block()` per ISO 14496-3 §4.4.2.1
 *   - description absent   → ADTS frames (sync word 0xFFF)
 *
 * We use ADTS mode because Chrome's platform decoders (AudioToolbox on macOS,
 * Media Foundation on Windows) are more reliable with ADTS-framed data than
 * with bare raw_data_block() syntax.
 *
 * @see ISO/IEC 14496-3 §1.A.3.1 (ADTS fixed header)
 * @see W3C AAC WebCodecs Registration §2 (ADTS EncodedAudioChunk format)
 */
function wrapInADTS(
    rawFrame: Uint8Array,
    sampleRate: number,
    channels: number,
): Uint8Array {
    const freqIndexMap: Record<number, number> = {
        96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
        24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
    };
    const freqIndex = freqIndexMap[sampleRate] ?? 3; // default 48kHz

    const frameLen = rawFrame.byteLength + 7; // 7 = ADTS header (no CRC)
    const header = new Uint8Array(7);

    // Byte 0-1: Sync word (0xFFF), MPEG-4 (ID=0), Layer=0, no CRC
    header[0] = 0xFF;
    header[1] = 0xF1;
    // Byte 2: Profile (AAC-LC=1, i.e. objectType-1), freq index, private, channel config MSB
    header[2] = (1 << 6) | (freqIndex << 2) | (channels >> 2);
    // Byte 3: Channel config LSBs, frame length upper 2 bits
    header[3] = ((channels & 0x3) << 6) | ((frameLen >> 11) & 0x3);
    // Byte 4: Frame length mid 8 bits
    header[4] = (frameLen >> 3) & 0xFF;
    // Byte 5: Frame length lower 3 bits, buffer fullness upper 5 bits (0x7FF = VBR)
    header[5] = ((frameLen & 0x7) << 5) | 0x1F;
    // Byte 6: Buffer fullness lower 6 bits, number of raw_data_blocks - 1 = 0
    header[6] = 0xFC;

    const adtsFrame = new Uint8Array(frameLen);
    adtsFrame.set(header);
    adtsFrame.set(rawFrame, 7);
    return adtsFrame;
}

/**
 * Create (or recreate) the AudioDecoder with error recovery.
 *
 * WebCodecs decoders enter 'closed' state on error and cannot be reused.
 * Since each AAC frame is independently decodable (LOC §4.1), we can
 * recreate the decoder and continue from the next frame.
 */
function createAudioDecoder(config: AudioDecoderConfig): void {
    audioDecoder = new AudioDecoder({
        output: (audioData: AudioData) => {
            // Play through AudioContext by copying decoded PCM into an AudioBuffer.
            // AudioData holds native memory — close() is required just like VideoFrame.
            const buf = audioCtx!.createBuffer(
                audioData.numberOfChannels,
                audioData.numberOfFrames,
                audioData.sampleRate,
            );

            for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
                const dest = buf.getChannelData(ch);
                audioData.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
            }
            audioData.close();

            // Schedule seamless back-to-back playback.
            // If we've fallen behind (network stall, decoder pause), skip ahead to now.
            const now = audioCtx!.currentTime;
            if (nextAudioPlayTime < now) {
                nextAudioPlayTime = now;
            }

            const source = audioCtx!.createBufferSource();
            source.buffer = buf;
            source.connect(audioCtx!.destination);
            source.start(nextAudioPlayTime);
            nextAudioPlayTime += buf.duration;

            audioSampleCount++;
            if (audioSampleCount === 1) {
                log('First audio chunk played!');
            }
        },
        error: (err: DOMException) => {
            audioErrorCount++;
            if (audioErrorCount <= 5) {
                log(`Audio decode error #${audioErrorCount} at frame ~${audioSampleCount}: ${err.message} [${lastAudioFrameInfo}]`);
            }
            // Decoder is now 'closed' — recreate to continue decoding.
            createAudioDecoder(config);
        },
    });

    audioDecoder.configure(config);
    if (audioErrorCount === 0) {
        log(`Audio decoder configured: ${config.codec} ${config.sampleRate}Hz ${config.numberOfChannels}ch (adts mode)`);
    }
}

// ─── Main ────────────────────────────────────────────────────────────

// AudioContext requires a user gesture (Chrome autoplay policy).
// We gate the entire flow on the Start button click.
startBtn.addEventListener('click', () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
    audioCtx = new AudioContext();
    log(`AudioContext created (sampleRate=${audioCtx.sampleRate}).`);
    main().catch((err) => {
        log(`Fatal: ${(err as Error).message}`);
        console.error(err);
    });
});

async function main(): Promise<void> {
    log(`Relay: ${relayUrl}`);
    log(`Namespace: ${namespace}`);
    log('');

    // ── 1. WebTransport connection ──────────────────────────────────
    // @see draft-ietf-moq-transport-16 §3.1
    log('Creating WebTransport connection...');
    const transportOptions: WebTransportOptions = {};
    if (certHash) {
        transportOptions.serverCertificateHashes = [{
            algorithm: 'sha-256',
            value: certHash,
        }];
    }
    const connectUrl = `${relayUrl}/?ns=${encodeURIComponent(namespace)}`;
    const transport = new WebTransport(connectUrl, transportOptions);
    await transport.ready;
    log('WebTransport connected.');

    // ── 2. MoqtConnection ─────────────────────────────────────────────
    // @see draft-ietf-moq-transport-16 §3
    const connection = new MoqtConnection();

    // ── 3. Wire callbacks ──────────────────────────────────────────

    connection.onMessage = (msg) => {
        log(`Control: ${msg.type}`);
    };

    connection.onClose = (error, reason) => {
        log(`Session closed: error=${error ?? 'none'} reason=${reason ?? ''}`);
    };

    connection.onError = (error) => {
        log(`Session error: ${error.message}`);
    };

    // Stream reset handling — DELIVERY_TIMEOUT resets mean objects on that
    // stream are lost; we need the next keyframe to resume decoding.
    // @see draft-ietf-moq-transport-16 §9.2.2.2 (DELIVERY_TIMEOUT)
    // @see draft-ietf-moq-transport-16 §13.4.4 (error code 0x2)
    connection.onStreamClosed = (_streamId, error) => {
        if (error !== undefined) {
            log(`Stream reset: error=0x${error.toString(16)}`);
            needsKeyframe = true;
        }
    };

    // Object handler — routes catalog, video, and audio objects.
    let catalogResolved: ((catalog: Catalog) => void) | null = null;
    const catalogPromise = new Promise<Catalog>((resolve) => {
        catalogResolved = resolve;
    });

    connection.onObject = (_streamId, obj) => {
        // Route by track alias
        if (videoTrackAlias !== null && BigInt(obj.trackAlias) === BigInt(videoTrackAlias)) {
            handleVideoObject(obj);
            return;
        }
        if (audioTrackAlias !== null && BigInt(obj.trackAlias) === BigInt(audioTrackAlias)) {
            handleAudioObject(obj);
            return;
        }

        // Assume anything else before media subscriptions is catalog
        if (obj.kind === 'gap') return;
        try {
            const catalog = parseCatalog(obj.payload!, namespace);
            catalogResolved?.(catalog);
            catalogResolved = null;
        } catch {
            // Not a valid catalog — ignore
        }
    };

    // ── 4. Connect ─────────────────────────────────────────────────
    // maxRequestId MUST be >= 1 for subscriptions to work.
    // @see draft-ietf-moq-transport-16 §9.3.1.3
    log('Connecting to MOQT session...');
    await connection.connect(transport, {
        maxRequestId: varint(100),
    });
    log(`Session established (state: ${connection.session.state}).`);

    // ── 5. Subscribe to catalog ────────────────────────────────────
    // @see draft-ietf-moq-transport-16 §9.9
    // @see draft-ietf-moq-msf-00 §5
    log('Subscribing to catalog...');
    await connection.subscribe(
        encodeNamespace(namespace),
        enc.encode('catalog'),
    );
    log('Waiting for catalog...');

    const catalog = await catalogPromise;
    log(`Catalog: version=${catalog.version}, ${catalog.tracks.length} tracks`);
    for (const t of catalog.tracks) {
        const parts: string[] = [t.name];
        if (t.codec) parts.push(t.codec);
        if (t.width && t.height) parts.push(`${t.width}x${t.height}`);
        if (t.bitrate) parts.push(`${(t.bitrate / 1000).toFixed(0)}kbps`);
        log(`  ${parts.join(' | ')}`);
    }

    // ── 6. Find video track ────────────────────────────────────────
    // @see draft-ietf-moq-msf-00 §5.1.12 (packaging must be "loc")
    // @see draft-ietf-moq-msf-00 §5.1.24 (codec)
    const videoTrack: CatalogTrack | undefined = catalog.tracks.find(
        (t) => t.role === 'video' && t.packaging === 'loc',
    );
    if (!videoTrack) {
        log('No LOC video track found in catalog.');
        return;
    }
    if (!videoTrack.codec) {
        log(`Video track "${videoTrack.name}" has no codec field.`);
        return;
    }

    videoCodec = videoTrack.codec;
    videoWidth = videoTrack.width ?? 1920;
    videoHeight = videoTrack.height ?? 1080;

    // Decode initData (Base64) if present in catalog.
    // @see draft-ietf-moq-msf-00 §5.1.20 (Initialization data)
    // @see draft-ietf-moq-loc-01 §2.1.2 (maps to VideoDecoderConfig.description)
    if (videoTrack.initData) {
        const binary = atob(videoTrack.initData);
        videoInitData = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            videoInitData[i] = binary.charCodeAt(i);
        }
    }

    // Size canvas to video dimensions
    canvas.width = videoWidth;
    canvas.height = videoHeight;

    log(`Video: ${videoTrack.name} | ${videoCodec} | ${videoWidth}x${videoHeight}`);

    // ── 7. Find audio track ────────────────────────────────────────
    // @see draft-ietf-moq-msf-00 §5.1.12 (packaging)
    // @see draft-ietf-moq-msf-00 §5.1.24 (codec)
    const audioTrack: CatalogTrack | undefined = catalog.tracks.find(
        (t) => t.role === 'audio' && t.packaging === 'loc',
    );

    if (audioTrack && audioTrack.codec) {
        audioCodec = audioTrack.codec;
        audioSampleRate = audioTrack.samplerate ?? 48000;
        audioChannels = Number(audioTrack.channelConfig ?? '2');
        log(`Audio: ${audioTrack.name} | ${audioCodec} | ${audioSampleRate}Hz | ${audioChannels}ch`);
    } else {
        log('No LOC audio track found in catalog (video-only mode).');
    }

    // ── 8. Create VideoDecoder ─────────────────────────────────────
    videoDecoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
            // Render to canvas
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);

            // frame.close() is NON-NEGOTIABLE — VideoFrame holds GPU memory
            // outside JavaScript GC. 1 sec of 1080p25 ~ 200MB unclosed.
            frame.close();

            frameCount++;
            if (frameCount === 1) {
                log('First video frame rendered!');
            }
            if (frameCount % 30 === 0) {
                updateStats();
            }
        },
        error: (err: DOMException) => {
            log(`Video decoder error: ${err.message}`);
        },
    });

    // ── 9. Create AudioDecoder ─────────────────────────────────────
    // @see draft-ietf-moq-loc-01 §4.1 (Audio: each object independently decodable)
    if (audioTrack && audioTrack.codec && audioCtx) {
        // Configure audio decoder in ADTS mode — omit description so the decoder
        // expects ADTS-framed input. We prepend ADTS headers client-side in
        // handleAudioObject(). This is more reliable across Chrome's platform
        // decoders (AudioToolbox/macOS, Media Foundation/Windows) than raw mode.
        // @see W3C AAC WebCodecs Registration §2 (ADTS mode = no description)
        // @see draft-ietf-moq-msf-00 §5.1.24 (codec string from catalog)
        const audioConfig: AudioDecoderConfig = {
            codec: audioCodec,
            sampleRate: audioSampleRate,
            numberOfChannels: audioChannels,
        };

        const support = await AudioDecoder.isConfigSupported(audioConfig);
        log(`Audio isConfigSupported: ${support.supported} (codec=${audioConfig.codec}, mode=adts)`);

        if (!support.supported) {
            log('Audio config not supported — skipping audio.');
        } else {
            createAudioDecoder(audioConfig);
        }
    }

    // ── 10. Subscribe to video track ───────────────────────────────
    // @see draft-ietf-moq-transport-16 §9.9 (SUBSCRIBE)
    // @see draft-ietf-moq-transport-16 §2.4.1 (namespace encoding)
    log('Subscribing to video track...');
    const videoNs = videoTrack.namespace ?? namespace;
    const videoReqId = await connection.subscribe(
        encodeNamespace(videoNs),
        enc.encode(videoTrack.name),
    );
    log(`Video subscribed (requestId=${videoReqId}). Waiting for frames...`);
    videoTrackAlias = videoReqId;

    // ── 11. Subscribe to audio track ───────────────────────────────
    if (audioTrack && audioDecoder) {
        log('Subscribing to audio track...');
        const audioNs = audioTrack.namespace ?? namespace;
        const audioReqId = await connection.subscribe(
            encodeNamespace(audioNs),
            enc.encode(audioTrack.name),
        );
        log(`Audio subscribed (requestId=${audioReqId}).`);
        audioTrackAlias = audioReqId;
    }

    startBtn.textContent = 'Playing';
}

// ─── Video object handler ────────────────────────────────────────────

/**
 * Handle a video MoqtObject.
 *
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-loc-01 §2.2 (LOC payload = EncodedVideoChunk.data)
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking)
 * @see draft-ietf-moq-loc-01 §4.2 (ObjectID 0 = IDR frame)
 */
function handleVideoObject(obj: MoqtObject): void {
    // ── Gap handling ───────────────────────────────────────────────
    // @see draft-ietf-moq-transport-16 §10.2.1.1
    if (obj.kind === 'gap') {
        const status = Number(obj.status ?? 0n);
        if (status === 0x3) {
            log(`Video gap: End of Group (group=${obj.groupId}, objId=${obj.objectId})`);
            needsKeyframe = true;
        } else if (status === 0x4) {
            log(`Video gap: End of Track (group=${obj.groupId}, objId=${obj.objectId})`);
            log('Video track ended.');
        } else {
            log(`Video gap: status=0x${status.toString(16)} group=${obj.groupId}`);
            needsKeyframe = true;
        }
        return;
    }

    // ── Parse LOC headers ──────────────────────────────────────────
    // @see draft-ietf-moq-loc-01 §2.3 (LOC Header Extensions)
    const headers = parseLocHeaders(obj.properties);
    const chunkInit = toVideoChunkInit(obj.payload!, headers);

    // ── Keyframe gating ────────────────────────────────────────────
    const isKeyframe = chunkInit.type === 'key';

    if (needsKeyframe) {
        if (!isKeyframe) {
            return;
        }

        if (videoDecoder && videoConfigured) {
            videoDecoder.reset();
        }
        configureVideoDecoder();
        needsKeyframe = false;
        log(`Keyframe received (group=${obj.groupId}, objId=${obj.objectId})`);
    }

    // ── First keyframe ever — configure decoder ────────────────────
    if (!videoConfigured) {
        configureVideoDecoder();
        needsKeyframe = false;
    }

    // ── Decode ─────────────────────────────────────────────────────
    if (videoDecoder && videoDecoder.state === 'configured') {
        videoDecoder.decode(new EncodedVideoChunk(chunkInit));
    }
}

// ─── Audio object handler ────────────────────────────────────────────

/**
 * Handle an audio MoqtObject.
 *
 * Audio is simpler than video — every LOC audio object is independently
 * decodable (no keyframe gating needed).
 *
 * @see draft-ietf-moq-loc-01 §4.1 (Audio: each chunk independently decodable)
 * @see draft-ietf-moq-loc-01 §2.2 (LOC payload = EncodedAudioChunk.data)
 */
function handleAudioObject(obj: MoqtObject): void {
    if (obj.kind === 'gap') return;
    if (!audioDecoder || audioDecoder.state !== 'configured') return;

    const payload = obj.payload!;

    // Parse LOC headers for CaptureTimestamp; fall back to sequential.
    // Normalize to zero-based timestamps for decoder stability.
    // @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp in microseconds)
    // 1024 samples per AAC-LC frame
    const frameDurationUs = Math.round(1024 / audioSampleRate * 1_000_000);
    let timestamp = audioSubmitCount * frameDurationUs;
    try {
        const headers = parseLocHeaders(obj.properties);
        if (headers.captureTimestamp !== undefined) {
            timestamp = Number(headers.captureTimestamp);
        }
    } catch {
        // LOC parse failed — use sequential timestamp
    }

    // Normalize to zero-based
    if (firstAudioTimestamp === null) firstAudioTimestamp = timestamp;
    timestamp -= firstAudioTimestamp;

    // Wrap raw AAC access unit in ADTS for Chrome's decoder.
    // LOC payload is the raw access unit (§2.2); ADTS framing is client-side only.
    const adtsFrame = wrapInADTS(payload, audioSampleRate, audioChannels);

    // Record frame info for error diagnostics (async errors fire later)
    lastAudioFrameInfo = `${payload.length}B`;

    // AAC-LC frames are always independently decodable → type 'key'.
    // @see W3C AAC WebCodecs Registration: type is always "key" for AAC
    // @see draft-ietf-moq-loc-01 §4.1 (each audio object independently decodable)
    audioDecoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp,
        duration: frameDurationUs,
        data: adtsFrame,
    }));

    audioSubmitCount++;
}

// ─── Decoder configuration ───────────────────────────────────────────

/**
 * Configure the VideoDecoder with codec parameters from the catalog.
 *
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec → VideoDecoderConfig.codec)
 * @see draft-ietf-moq-msf-00 §5.1.29 (width → codedWidth)
 * @see draft-ietf-moq-msf-00 §5.1.30 (height → codedHeight)
 * @see draft-ietf-moq-msf-00 §5.1.20 (initData → description)
 */
function configureVideoDecoder(): void {
    if (!videoDecoder) return;

    const config: VideoDecoderConfig = {
        codec: videoCodec,
        codedWidth: videoWidth,
        codedHeight: videoHeight,
    };

    if (videoInitData) {
        config.description = videoInitData;
    }

    videoDecoder.configure(config);
    videoConfigured = true;
}
