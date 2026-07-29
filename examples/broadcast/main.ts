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
import { varint } from '@moqt/transport';
import { BroadcastSession } from './broadcast-session.js';
import type { BroadcastSessionConnection } from './broadcast-session.js';
import { BroadcastAttempt } from './broadcast-attempt.js';
import type { AttemptResources } from './broadcast-attempt.js';
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

// MoQ state. Everything a broadcast touches — capture, encoders, connection,
// media publisher, alias allocator, audio settings — is owned by the
// per-broadcast startup TRANSACTION (BroadcastAttempt) and its
// BroadcastSession. There are no mutable resource globals: stopping attempt
// A and starting attempt B lets A's late continuations clean up only A's
// own resources, never B's — and lifecycle callbacks are identity-guarded
// in the session, so a delayed old-session onClose/onSubscribe cannot stop
// or mutate a replacement.
let currentAttempt: BroadcastAttempt | null = null;

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

  // Attempt-local state threaded between steps (never module globals).
  let capture: MediaCapture | null = null;
  let videoEncoder: WebCodecsVideoEncoder | null = null;
  let audioEncoder: WebCodecsAudioEncoder | null = null;
  let connection: MoqtConnection | null = null;
  let audio: { sampleRate: number; channels: number } | undefined;
  let width = 1280;
  let height = 720;
  let fps = 30;

  const attempt: BroadcastAttempt = new BroadcastAttempt({
    // 1. Start capture — audio settings are ATTEMPT-LOCAL, derived from the
    // actual tracks (a screen capture without audio yields none).
    startCapture: async (ctx: AttemptResources) => {
      // Adopted BEFORE the start resolves: a rejected getUserMedia (or a
      // cancellation mid-prompt) must still stop the handle.
      const cap = ctx.adopt(new MediaCapture(), (c) => { c.stop(); });
      // Capture retires SYNCHRONOUSLY when Stop is pressed — camera/mic tracks
      // are released immediately, not after the session's bounded shutdown.
      ctx.onCancel(() => { try { cap.stop(); } catch { /* not started */ } });
      capture = cap;
      const stream = source === 'camera'
        ? await cap.startCamera({ width: 1280, height: 720, frameRate: 30 })
        : await cap.startScreen({ video: true, audio: false });
      // The tracks only become real HERE — MediaCapture.stop() before this
      // point cannot stop a stream it does not yet hold. Re-adopt the ACQUIRED
      // capture so a permission prompt that resolved AFTER Stop still has its
      // camera released (the adoption disposes immediately when cancelled).
      ctx.adopt(cap, (c) => { c.stop(); });
      ctx.throwIfCancelled();
      preview.srcObject = stream;
      log(`Capture started: ${source}`);

      const settings = cap.videoSettings;
      width = settings?.width ?? 1280;
      height = settings?.height ?? 720;
      fps = settings?.frameRate ?? 30;
      log(`Video: ${width}x${height} @ ${fps}fps`);

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioSettings = audioTrack.getSettings();
        audio = {
          sampleRate: audioSettings.sampleRate ?? 48000,
          channels: audioSettings.channelCount ?? 1,
        };
      } else {
        log('Audio: no audio track in this capture');
      }
      return { stop: () => cap.stop() };
    },

    // 2. Configure encoders
    createEncoders: (ctx: AttemptResources) => {
      // Each encoder is adopted at construction, so a throw while configuring
      // the SECOND one still destroys the first.
      const ve = ctx.adopt(new WebCodecsVideoEncoder(), (e) => { e.destroy(); });
      // Encoders also retire synchronously at Stop: no further frames are
      // encoded while the session drains.
      ctx.onCancel(() => { try { ve.destroy(); } catch { /* already destroyed */ } });
      videoEncoder = ve;
      ve.configure(videoCodec, width, height, {
        bitrate: videoBitrate,
        framerate: fps,
        keyframeInterval,
        latencyMode: 'realtime',
      });
      log(`Video encoder: ${videoCodec} @ ${videoBitrate / 1000}kbps`);
      if (audio) {
        const ae = ctx.adopt(new WebCodecsAudioEncoder(), (e) => { e.destroy(); });
        ctx.onCancel(() => { try { ae.destroy(); } catch { /* already destroyed */ } });
        audioEncoder = ae;
        ae.configure('opus', audio.sampleRate, audio.channels, { bitrate: 128_000 });
        log(`Audio encoder: opus @ 128kbps (${audio.sampleRate}Hz, ${audio.channels}ch)`);
      }
      // Disposal is handled per-encoder by the adoptions above.
      return { destroy: () => { /* owned by the attempt registry */ } };
    },

    // 3. Transport + connection + session, wired. The session's wire
    // behavior binds to the NEGOTIATED draft (connection.draftVersion after
    // connect), not the configured preference.
    openSession: async (ctx: AttemptResources) => {
      log(`Connecting to ${relayUrl}...`);
      const transportFactory = createWebTransport({ ...(certHash ? { certHash } : {}), ...(draftVersion ? { draftVersion } : {}) });
      // Each resource is adopted the moment it exists — a cancellation or a
      // handshake failure between these awaits must not leak the transport or
      // the connection.
      const transport = ctx.adopt(await transportFactory(relayUrl), (t) => {
        try { (t as unknown as { close(): void }).close(); } catch { /* already closed */ }
      });
      ctx.throwIfCancelled();
      const conn = ctx.adopt(new MoqtConnection(draftVersion), (c) => c.close());
      connection = conn;

      conn.onError = (err) => { log(`Session error: ${err.message}`); };
      conn.onMessage = (msg) => {
        log(`[CTRL] ${msg.type}${('requestId' in msg) ? ` reqId=${(msg as any).requestId}` : ''}`);
      };

      // Cancellation must REACH the in-progress handshake: closing the
      // transport makes a pending connect() settle instead of hanging.
      ctx.onCancel(() => {
        try { (transport as unknown as { close(): void }).close(); } catch { /* already closed */ }
      });
      await conn.connect(transport, { maxRequestId: varint(100) });
      ctx.throwIfCancelled();
      const negotiatedDraft = conn.draftVersion;
      log(`Session established (draft-${negotiatedDraft}).`);

      const session = ctx.adopt(new BroadcastSession(conn as unknown as BroadcastSessionConnection, {
        catalog: {
          videoCodec,
          width,
          height,
          fps,
          videoBitrate,
          ...(audio ? { audio } : {}),
        },
        publisher: {
          wrapInt: (n) => varint(n),
          draft: negotiatedDraft,
          onError: (context, err) => log(`Failed ${context}: ${(err as Error)?.message ?? err}`),
          onCounts: (videoFrames, audioChunks) => {
            if (videoFrames % 30 === 0) {
              statFrames.textContent = String(videoFrames);
              statAudio.textContent = String(audioChunks);
            }
          },
        },
        log,
        onCatalogPublished: () => {
          statusEl.textContent = 'Broadcasting';
          liveBadge.classList.add('visible');
        },
        // Only the CURRENT attempt's session may drive the global stop.
        onSessionClosed: () => { if (currentAttempt === attempt) void stopBroadcast(); },
      }), (sess) => sess.shutdown());

      // No await between connect resolution and these assignments — nothing
      // can be missed. Handlers reference only this attempt's session.
      conn.onClose = (error, reason) => {
        log(`Session closed: error=${error ?? 'none'} reason=${reason ?? 'clean'}`);
        transport.closed.then((info: any) => {
          log(`WebTransport closed: code=${info?.closeCode ?? 'N/A'} reason=${info?.reason ?? 'N/A'}`);
        }).catch(() => {});
        session.handleClose(error, reason);
      };
      conn.onSubscribe = (requestId, _ns, trackName) => {
        session.handleSubscribe(requestId, new TextDecoder().decode(trackName));
      };
      return session;
    },

    // 4. Announce namespace
    publishNamespace: async (ctx: AttemptResources) => {
      const enc = new TextEncoder();
      const nsBytes = namespace.split('/').map(p => enc.encode(p));
      log(`Sending PUBLISH_NAMESPACE for [${namespace}]...`);
      await connection!.publishNamespace(nsBytes);
      ctx.throwIfCancelled();
      log(`PUBLISH_NAMESPACE sent, waiting for relay response...`);
    },

    // 5. Wire encoder output → MoQ publish. WebCodecs chunk callbacks are
    // synchronous and void — publication is a synchronous ENQUEUE into this
    // generation's serialized publisher, which builds the LOC extensions
    // under the negotiated draft's wire profile.
    wirePublication: (session) => {
      const mediaPublisher = session.publisher;
      const ve = videoEncoder!;
      ve.onChunk = (data, isKeyframe, timestamp, _duration, description) => {
        const videoConfig = description ?? ve.description;
        mediaPublisher.publishVideo(data, {
          isKeyframe,
          timestampUs: timestamp,
          ...(videoConfig ? { videoConfig } : {}),
        });
      };
      ve.onError = (err) => log(`[VideoEncoder ERROR] ${err.message}`);
      capture!.onError = (err) => log(`[Capture ERROR] ${err.message}`);
      if (audioEncoder) {
        const ae = audioEncoder;
        ae.onChunk = (data, timestamp) => {
          mediaPublisher.publishAudio(data, { timestampUs: timestamp });
        };
        ae.onError = (err) => log(`[AudioEncoder ERROR] ${err.message}`);
      }

      // 6. Wire capture → encoder
      capture!.onVideoFrame = (frame) => {
        ve.encode(frame);
        frame.close();
      };
      capture!.onAudioData = (data) => {
        audioEncoder?.encode(data);
        data.close();
      };

      // Show viewer URL + resolution
      const viewerBase = window.location.origin + '/player/';
      const viewerParams = new URLSearchParams();
      viewerParams.set('url', relayUrl);
      viewerParams.set('ns', namespace);
      if (draftVersion) viewerParams.set('v', String(draftVersion));
      currentViewerLink = `${viewerBase}?${viewerParams.toString()}`;
      viewerCard.style.display = 'block';
      statRes.textContent = `${width}x${height}`;
      statResContainer.style.display = '';
      statusEl.textContent = 'Waiting for relay to subscribe...';
    },
  });

  currentAttempt = attempt;
  try {
    const result = await attempt.run();
    if (result === 'cancelled') return; // superseded — the UI belongs to the replacement
  } catch (err) {
    // Only the CURRENT attempt's failure is the user's failure; a stale
    // attempt has already been quiet-cancelled inside run().
    log(`Fatal: ${(err as Error).message}`);
    console.error(err);
    if (currentAttempt === attempt) {
      currentAttempt = null;
      resetBroadcastUi();
    }
  }
}

// ─── Stop ────────────────────────────────────────────────────────────

async function stopBroadcast(): Promise<void> {
  // Cancel the pending/current attempt SYNCHRONOUSLY (its continuations go
  // inert at their next gate), then await its teardown: capture, encoders,
  // and a graceful bounded session shutdown.
  const attempt = currentAttempt;
  currentAttempt = null;
  await attempt?.cancel();
  // If a new broadcast started while we awaited, the UI belongs to it.
  if (currentAttempt === null) resetBroadcastUi();
  log('Broadcast stopped.');
}

function resetBroadcastUi(): void {
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
}
