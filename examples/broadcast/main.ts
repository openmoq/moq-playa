/**
 * Broadcast example — publish camera/screen to a MoQ relay.
 *
 * Captures via getUserMedia/getDisplayMedia, encodes via WebCodecs,
 * packages with LOC headers, and publishes via MoqtConnection.
 *
 * The viewer URL points to the player example with matching relay + namespace.
 *
 * @see draft-ietf-moq-transport-16 §9.13 (PUBLISH)
 * @see draft-ietf-moq-transport-16 §10.4.2 (Subgroup streams)
 * @see draft-ietf-moq-loc-01 §2.3 (LOC header extensions)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import { MoqtConnection } from '@moqt/webtransport';
import { varint, SubgroupIdMode, PublishDoneCode } from '@moqt/transport';
import { encodeLocHeaders } from '@moqt/loc';
import { buildCatalog } from '@moqt/msf';
import type { Varint } from '@moqt/transport';
import { log } from '../shared/log.js';
import { relayUrl, namespace, certHash, draftVersion } from '../shared/cert.js';
import {
  WebCodecsVideoEncoder,
  WebCodecsAudioEncoder,
  MediaCapture,
  createWebTransport,
} from '../shared/browser/index.js';

// ─── URL params ──────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const videoCodec = params.get('codec') ?? 'avc1.42001f'; // Baseline Level 3.1 (720p)
const videoBitrate = parseInt(params.get('bitrate') ?? '2000', 10) * 1000;
const keyframeInterval = parseInt(params.get('keyframe') ?? '60', 10);

// ─── Settings modal ──────────────────────────────────────────────────

{
  const settingsBtn = document.getElementById('settings-btn')!;
  const backdrop = document.getElementById('settings-backdrop')!;
  const sUrl = document.getElementById('s-url') as HTMLInputElement;
  const sNs = document.getElementById('s-ns') as HTMLInputElement;
  const sHash = document.getElementById('s-hash') as HTMLInputElement;
  const sVersion = document.getElementById('s-version') as HTMLSelectElement;
  const sCodec = document.getElementById('s-codec') as HTMLSelectElement;
  const sBitrate = document.getElementById('s-bitrate') as HTMLInputElement;
  const sKeyframe = document.getElementById('s-keyframe') as HTMLInputElement;
  const applyBtn = document.getElementById('settings-apply')!;
  const cancelBtn = document.getElementById('settings-cancel')!;

  function populateFields() {
    sUrl.value = params.get('url') ?? 'https://localhost:4443';
    sNs.value = params.get('ns') ?? 'live';
    sHash.value = params.get('hash') ?? '';
    sVersion.value = params.get('v') ?? '';
    sCodec.value = videoCodec;
    sBitrate.value = String(videoBitrate / 1000);
    sKeyframe.value = String(keyframeInterval);
  }

  settingsBtn.addEventListener('click', () => { populateFields(); backdrop.classList.add('visible'); });
  cancelBtn.addEventListener('click', () => backdrop.classList.remove('visible'));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.remove('visible'); });

  applyBtn.addEventListener('click', () => {
    const np = new URLSearchParams();
    const url = sUrl.value.trim();
    const ns = sNs.value.trim();
    if (url && url !== 'https://localhost:4443') np.set('url', url);
    if (ns && ns !== 'live') np.set('ns', ns);
    if (sHash.value.trim()) np.set('hash', sHash.value.trim());
    if (sVersion.value) np.set('v', sVersion.value);
    if (sCodec.value !== 'avc1.42001f') np.set('codec', sCodec.value);
    if (sBitrate.value !== '2000') np.set('bitrate', sBitrate.value);
    if (sKeyframe.value !== '60') np.set('keyframe', sKeyframe.value);
    const qs = np.toString();
    window.location.href = window.location.pathname + (qs ? '?' + qs : '');
  });
}

// ─── DOM ─────────────────────────────────────────────────────────────

const preview = document.getElementById('preview') as HTMLVideoElement;
const statusEl = document.getElementById('status')!;
const viewerCard = document.getElementById('viewer-card')!;
const shareBtn = document.getElementById('share-btn')!;
const shareBackdrop = document.getElementById('share-backdrop')!;
const shareUrlInput = document.getElementById('share-url') as HTMLInputElement;
const shareCopyBtn = document.getElementById('share-copy')!;
const shareCopied = document.getElementById('share-copied')!;
const shareOpenBtn = document.getElementById('share-open')!;
const shareCloseBtn = document.getElementById('share-close')!;
let currentViewerLink = '';
const liveBadge = document.getElementById('live-badge')!;
const statFrames = document.getElementById('stat-frames')!;
const statAudio = document.getElementById('stat-audio')!;
const statRes = document.getElementById('stat-res')!;
const statResContainer = document.getElementById('stat-res-container')!;
const startCameraBtn = document.getElementById('start-camera') as HTMLButtonElement;
const startScreenBtn = document.getElementById('start-screen') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;

let connection: MoqtConnection | null = null;
let capture: MediaCapture | null = null;
let videoEncoder: WebCodecsVideoEncoder | null = null;
let audioEncoder: WebCodecsAudioEncoder | null = null;

// MoQ state
let videoGroupId = BigInt(Date.now());
let videoObjectId = 0n;
let audioGroupId = BigInt(Date.now()) + 1_000_000n; // offset to avoid collision
let videoStreamId: bigint | null = null;
let videoTrackAlias = 0n;
let audioTrackAlias = 0n;
let nextAlias = 1n;
let audioSampleRate = 48000;
let audioChannels = 1;
let frameCount = 0;
let audioChunkCount = 0;

// ─── Share modal ─────────────────────────────────────────────────────

shareBtn.addEventListener('click', () => {
  shareUrlInput.value = currentViewerLink;
  shareCopied.style.display = 'none';
  shareBackdrop.classList.add('visible');
  shareUrlInput.select();
});

shareCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentViewerLink).then(() => {
    shareCopied.style.display = 'block';
    setTimeout(() => { shareCopied.style.display = 'none'; }, 2000);
  });
});

shareOpenBtn.addEventListener('click', () => window.open(currentViewerLink, '_blank'));
shareCloseBtn.addEventListener('click', () => shareBackdrop.classList.remove('visible'));
shareBackdrop.addEventListener('click', (e) => {
  if (e.target === shareBackdrop) shareBackdrop.classList.remove('visible');
});

// ─── Start ───────────────────────────────────────────────────────────

startCameraBtn.addEventListener('click', () => startBroadcast('camera'));
startScreenBtn.addEventListener('click', () => startBroadcast('screen'));
stopBtn.addEventListener('click', stopBroadcast);

async function startBroadcast(source: 'camera' | 'screen'): Promise<void> {
  startCameraBtn.disabled = true;
  startScreenBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = 'Connecting...';

  try {
    // 1. Start capture
    capture = new MediaCapture();
    const stream = source === 'camera'
      ? await capture.startCamera({ width: 1280, height: 720, frameRate: 30 })
      : await capture.startScreen({ video: true, audio: false });

    preview.srcObject = stream;
    log(`Capture started: ${source}`);

    const settings = capture.videoSettings;
    const width = settings?.width ?? 1280;
    const height = settings?.height ?? 720;
    const fps = settings?.frameRate ?? 30;
    log(`Video: ${width}x${height} @ ${fps}fps`);

    // 2. Configure encoders
    videoEncoder = new WebCodecsVideoEncoder();
    videoEncoder.configure(videoCodec, width, height, {
      bitrate: videoBitrate,
      framerate: fps,
      keyframeInterval,
      latencyMode: 'realtime',
    });
    log(`Video encoder: ${videoCodec} @ ${videoBitrate / 1000}kbps`);

    // Configure audio encoder from actual mic settings
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      const audioSettings = audioTrack.getSettings();
      audioSampleRate = audioSettings.sampleRate ?? 48000;
      audioChannels = audioSettings.channelCount ?? 1;
      audioEncoder = new WebCodecsAudioEncoder();
      audioEncoder.configure('opus', audioSampleRate, audioChannels, { bitrate: 128_000 });
      log(`Audio encoder: opus @ 128kbps (${audioSampleRate}Hz, ${audioChannels}ch)`);
    } else {
      log('Audio: no mic available');
    }

    // 3. Connect to relay
    log(`Connecting to ${relayUrl}...`);
    const transportFactory = createWebTransport({ ...(certHash ? { certHash } : {}), ...(draftVersion ? { draftVersion } : {}) });
    const transport = await transportFactory(relayUrl);
    connection = new MoqtConnection(draftVersion);

    connection.onClose = (error, reason) => {
      log(`Session closed: error=${error ?? 'none'} reason=${reason ?? 'clean'}`);
      // Check WebTransport close info
      transport.closed.then((info: any) => {
        log(`WebTransport closed: code=${info?.closeCode ?? 'N/A'} reason=${info?.reason ?? 'N/A'}`);
      }).catch(() => {});
      stopBroadcast();
    };

    connection.onError = (err) => {
      log(`Session error: ${err.message}`);
    };

    connection.onMessage = (msg) => {
      log(`[CTRL] ${msg.type}${('requestId' in msg) ? ` reqId=${(msg as any).requestId}` : ''}`);
    };

    // Handle incoming SUBSCRIBE from relay
    connection.onSubscribe = (requestId, _ns, trackName) => {
      const name = new TextDecoder().decode(trackName);
      const alias = nextAlias++;
      log(`Relay subscribed to "${name}" (reqId=${requestId}, alias=${alias})`);

      if (name === 'catalog') {
        handleCatalogSubscribe(requestId, alias, width, height, fps);
      } else if (name === 'video') {
        videoTrackAlias = alias;
        connection!.acceptSubscribe(varint(requestId), varint(alias));
        log(`Accepted video subscription`);
      } else if (name === 'audio') {
        audioTrackAlias = alias;
        connection!.acceptSubscribe(varint(requestId), varint(alias));
        log(`Accepted audio subscription`);
      } else {
        connection!.rejectSubscribe(varint(requestId), varint(0), `Unknown track: ${name}`);
      }
    };

    await connection.connect(transport, { maxRequestId: varint(100) });
    log('Session established.');

    // Listen for WebTransport close reason
    (transport as any).closed?.then?.((info: any) => {
      log(`[WT] closed: code=${info?.closeCode} reason=${info?.reason}`);
    }).catch?.((err: any) => {
      log(`[WT] closed with error: ${err?.message ?? err}`);
    });

    // 4. Announce namespace
    const enc = new TextEncoder();
    const nsBytes = namespace.split('/').map(s => enc.encode(s));
    log(`Sending PUBLISH_NAMESPACE for [${namespace}]...`);
    await connection.publishNamespace(nsBytes);
    log(`PUBLISH_NAMESPACE sent, waiting for relay response...`);

    statusEl.textContent = 'Waiting for relay to subscribe...';

    // 5. Wire encoder output → MoQ publish
    videoEncoder.onChunk = handleVideoChunk;
    videoEncoder.onError = (err) => log(`[VideoEncoder ERROR] ${err.message}`);
    capture.onError = (err) => log(`[Capture ERROR] ${err.message}`);
    if (audioEncoder) {
      audioEncoder.onChunk = handleAudioChunk;
      audioEncoder.onError = (err) => log(`[AudioEncoder ERROR] ${err.message}`);
    }

    // 6. Wire capture → encoder
    capture.onVideoFrame = (frame) => {
      videoEncoder?.encode(frame);
      frame.close();
    };

    capture.onAudioData = (data) => {
      audioEncoder?.encode(data);
      data.close();
    };

    // Show viewer URL + resolution
    const viewerBase = window.location.origin + '/player/';
    const viewerParams = new URLSearchParams();
    viewerParams.set('url', relayUrl);
    viewerParams.set('ns', namespace);
    if (draftVersion) viewerParams.set('v', String(draftVersion));
    const viewerLink = `${viewerBase}?${viewerParams.toString()}`;
    currentViewerLink = viewerLink;
    viewerCard.style.display = 'block';
    statRes.textContent = `${width}x${height}`;
    statResContainer.style.display = '';

  } catch (err) {
    log(`Fatal: ${(err as Error).message}`);
    console.error(err);
    stopBroadcast();
  }
}

// ─── Catalog ─────────────────────────────────────────────────────────

async function handleCatalogSubscribe(
  requestId: bigint,
  alias: bigint,
  width: number,
  height: number,
  fps: number,
): Promise<void> {
  await connection!.acceptSubscribe(varint(requestId), varint(alias));

  const catalogPayload = buildCatalog({
    tracks: [
      {
        name: 'video',
        packaging: 'loc',
        isLive: true,
        role: 'video',
        codec: videoCodec,
        width,
        height,
        framerate: fps,
        bitrate: videoBitrate,
        renderGroup: 1,
      },
      {
        name: 'audio',
        packaging: 'loc',
        isLive: true,
        role: 'audio',
        codec: 'opus',
        samplerate: audioSampleRate,
        channelConfig: String(audioChannels),
        bitrate: 128_000,
        renderGroup: 1,
      },
    ],
  });

  // Publish catalog with timestamp-based group ID (matches mojito pattern).
  // Close the stream after writing (mojito does `defer stream.Close()`).
  // Wire format matches mojito: SubgroupIDZero, DefaultPriority, EndOfGroup.
  const catalogGroupId = varint(BigInt(Date.now()));
  const streamId = await connection!.openSubgroup(
    varint(alias), catalogGroupId, varint(0),
    {
      hasExtensions: false,
      endOfGroup: true,
      defaultPriority: true,
      subgroupIdMode: SubgroupIdMode.ZERO,
    },
  );
  await connection!.sendObject(streamId, varint(0), catalogPayload);
  await connection!.closeSubgroup(streamId);

  // §9.15: PUBLISH_DONE signals the catalog subscription is complete.
  // Some relays require this to cache and replay the catalog to subsequent
  // viewers. Trade-off: terminates the subscription, so catalog delta updates
  // would require a new SUBSCRIBE from the relay. Acceptable for this example.
  await connection!.publishDone(varint(requestId), PublishDoneCode.TRACK_ENDED, '');

  log(`Catalog published (${catalogPayload.byteLength} bytes)`);
  statusEl.textContent = 'Broadcasting';
  liveBadge.classList.add('visible');
}

// ─── Video chunks → MoQ objects ──────────────────────────────────────

async function handleVideoChunk(
  data: Uint8Array,
  isKeyframe: boolean,
  timestamp: number,
  _duration: number,
  description: Uint8Array | undefined,
): Promise<void> {
  if (!connection || videoTrackAlias === 0n) return;

  // New group on keyframe
  if (isKeyframe) {
    // Close previous stream in background (don't await — delta frames may still be writing)
    if (videoStreamId !== null) {
      const oldStreamId = videoStreamId;
      connection.closeSubgroup(oldStreamId).catch(() => { /* stream may already be closed */ });
    }

    videoGroupId++;
    videoObjectId = 0n;

    // endOfGroup: true — required for one-subgroup-per-GOP LOC video.
    // Without this, receivers cannot distinguish normal group completion
    // from an incomplete group and will wait for the intra-group timeout.
    videoStreamId = await connection.openSubgroup(
      varint(videoTrackAlias), varint(videoGroupId), varint(0),
      { hasExtensions: true, endOfGroup: true, publisherPriority: 128 },
    );
  }

  if (videoStreamId === null) return; // No stream yet (waiting for first keyframe)

  // Build LOC extensions
  const extensions = encodeLocHeaders({
    captureTimestamp: BigInt(Math.round(timestamp)),
    videoFrameMarking: {
      independent: isKeyframe,
      discardable: !isKeyframe,
      baseLayerSync: false,
      startOfFrame: true,
      endOfFrame: true,
      temporalId: 0,
    },
    ...(description || videoEncoder?.description ? { videoConfig: description ?? videoEncoder!.description! } : {}),
  }, { deltaEncoded: draftVersion !== 14 });

  try {
    await connection.sendObject(
      videoStreamId,
      varint(videoObjectId),
      data,
      extensions,
    );
  } catch {
    // Stream may have been closed by a keyframe race — silently skip
    return;
  }

  videoObjectId++;
  frameCount++;

  // Update status every 30 frames
  if (frameCount % 30 === 0) {
    statFrames.textContent = String(frameCount);
    statAudio.textContent = String(audioChunkCount);
  }
}

// ─── Audio chunks → MoQ objects ──────────────────────────────────────

async function handleAudioChunk(
  data: Uint8Array,
  timestamp: number,
  _duration: number,
): Promise<void> {
  if (!connection || audioTrackAlias === 0n) return;

  audioGroupId++;

  // Audio: one object per group (independently decodable, LOC §4.1)
  const extensions = encodeLocHeaders({
    captureTimestamp: BigInt(Math.round(timestamp)),
  }, { deltaEncoded: draftVersion !== 14 });

  const streamId = await connection.openSubgroup(
    varint(audioTrackAlias), varint(audioGroupId), varint(0),
    { hasExtensions: true, endOfGroup: true, publisherPriority: 64 }, // audio higher priority
  );
  await connection.sendObject(streamId, varint(0), data, extensions);
  await connection.closeSubgroup(streamId);

  audioChunkCount++;
}

// ─── Stop ────────────────────────────────────────────────────────────

async function stopBroadcast(): Promise<void> {
  capture?.stop();
  capture = null;
  videoEncoder?.destroy();
  videoEncoder = null;
  audioEncoder?.destroy();
  audioEncoder = null;

  if (videoStreamId !== null && connection) {
    try { await connection.closeSubgroup(videoStreamId); } catch { /* ignore */ }
    videoStreamId = null;
  }

  try { await connection?.close(); } catch { /* ignore */ }
  connection = null;

  preview.srcObject = null;
  statusEl.textContent = 'Ready';
  liveBadge.classList.remove('visible');
  viewerCard.style.display = 'none';
  statFrames.textContent = '0';
  statAudio.textContent = '0';
  statResContainer.style.display = 'none';
  startCameraBtn.disabled = false;
  startScreenBtn.disabled = false;
  stopBtn.disabled = true;
  frameCount = 0;
  audioChunkCount = 0;

  log('Broadcast stopped.');
}
