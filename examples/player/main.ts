/**
 * Player API example — A/V playback using @moqt/player with browser adapters.
 *
 * Demonstrates the convenience facade: load()/play()/pause()/destroy()
 * with adapter factories for plug-and-play decode/render.
 *
 * The player handles: connection, catalog, track selection, subscription,
 * object routing, pipeline processing, decoder command dispatch.
 *
 * Browser adapters handle: WebCodecs decode, Canvas rendering, audio scheduling.
 *
 * Compare with ../video/main.ts (588 lines of manual wiring).
 *
 * @see draft-ietf-moq-transport-16 §3 (Session)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoder)
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 */

import { MoqtPlayer, PlayerErrorCode } from '@moqt/player';
import { MoqtConnection } from '@moqt/webtransport';
import { QlogTrace, varint } from '@moqt/transport';
import { CATALOG_TRACK_NAME } from '@moqt/msf';
import { log } from '../shared/log.js';
import { relayUrl, namespace, namespaceArg, certHash, draftVersion } from '../shared/cert.js';
import {
    AudioAlignedClock,
    WebCodecsVideoDecoder,
    WebCodecsAudioDecoder,
    CanvasRenderer,
    WebAudioOutput,
    MseMediaSource,
    CmafAssembler,
    createWebTransport,
} from '@moqt/browser';

import type { PlayerStats, TTFFBreakdown } from '@moqt/player';

// ─── Settings Modal ──────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);

/** Read a catalog config from the `catalog` URL param (base64-encoded JSON). */
function readCatalogParam(): { tracks: any[] } | undefined {
    const b64 = params.get('catalog');
    if (!b64) return undefined;
    try {
        const json = atob(b64);
        const parsed = JSON.parse(json);
        if (parsed && Array.isArray(parsed.tracks)) return parsed;
    } catch { /* invalid — ignore */ }
    return undefined;
}

/** Parsed catalog from URL param (if any). */
const catalogFromUrl = readCatalogParam();

{
    const settingsBtn = document.getElementById('settings-btn')!;
    const backdrop = document.getElementById('settings-backdrop')!;
    const sUrl = document.getElementById('s-url') as HTMLInputElement;
    const sNs = document.getElementById('s-ns') as HTMLInputElement;
    const sHash = document.getElementById('s-hash') as HTMLInputElement;
    const sVersion = document.getElementById('s-version') as HTMLSelectElement;
    const sCatalog = document.getElementById('s-catalog') as HTMLTextAreaElement;
    const sLate = document.getElementById('s-late') as HTMLInputElement;
    const sGap = document.getElementById('s-gap') as HTMLInputElement;
    const sSwDec = document.getElementById('s-swdec') as HTMLInputElement;
    const sFetchCatalog = document.getElementById('s-fetch-catalog') as HTMLInputElement;
    const applyBtn = document.getElementById('settings-apply')!;
    const cancelBtn = document.getElementById('settings-cancel')!;

    // Populate from current URL params
    function populateFields() {
        sUrl.value = params.get('url') ?? 'https://localhost:4443';
        sNs.value = params.get('ns') ?? 'live';
        sHash.value = params.get('hash') ?? '';
        sVersion.value = params.get('v') ?? '';
        sLate.value = params.get('late') ?? '';
        sGap.value = params.get('gap') ?? '';
        sSwDec.checked = params.get('swdec') === '1';
        sFetchCatalog.checked = params.get('fetchCatalog') === '1';
        if (catalogFromUrl) {
            sCatalog.value = JSON.stringify(catalogFromUrl, null, 2);
        } else {
            sCatalog.value = '';
        }
    }

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        populateFields();
        backdrop.classList.add('visible');
    });

    cancelBtn.addEventListener('click', () => {
        backdrop.classList.remove('visible');
    });

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.remove('visible');
    });

    applyBtn.addEventListener('click', () => {
        const newParams = new URLSearchParams();
        const url = sUrl.value.trim();
        const ns = sNs.value.trim();
        const hash = sHash.value.trim();
        const v = sVersion.value;
        const late = sLate.value.trim();
        const gap = sGap.value.trim();
        const catalogJson = sCatalog.value.trim();

        if (url && url !== 'https://localhost:4443') newParams.set('url', url);
        if (ns && ns !== 'live') newParams.set('ns', ns);
        if (hash) newParams.set('hash', hash);
        if (v) newParams.set('v', v);
        if (late) newParams.set('late', late);
        if (gap) newParams.set('gap', gap);
        if (sSwDec.checked) newParams.set('swdec', '1');
        if (sFetchCatalog.checked) newParams.set('fetchCatalog', '1');

        if (catalogJson) {
            try {
                JSON.parse(catalogJson); // validate
                newParams.set('catalog', btoa(catalogJson));
            } catch {
                alert('Invalid catalog JSON');
                return;
            }
        }

        const qs = newParams.toString();
        window.location.href = window.location.pathname + (qs ? '?' + qs : '');
    });
}

// ─── DOM ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const videoEl = document.getElementById('video') as HTMLVideoElement;

// ── <video> element lifecycle forensics ──────────────────────────────
// Safari can pause/stall the element on its own (e.g. autoplay-policy edges
// around unmute) without any error event. Log the element's own lifecycle
// into the page log so intermittent episodes self-document which state the
// element was actually in. (Expected noise: our own Stop pauses the element;
// the MSE wedge ladder's rung-2 pulse emits a pause+play pair.)
for (const evt of ['pause', 'play', 'playing', 'waiting', 'stalled', 'volumechange'] as const) {
    videoEl.addEventListener(evt, () => {
        const detail = evt === 'volumechange' ? ` muted=${videoEl.muted}` : '';
        log(`[video] ${evt} t=${videoEl.currentTime.toFixed(2)} ready=${videoEl.readyState}${detail}`);
    });
}
const statsEl = document.getElementById('stats')!;
const playerWrap = document.getElementById('player-wrap')!;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const centerPlay = document.getElementById('center-play')!;
const loadingSpinner = document.getElementById('loading-spinner')!;
const centerFlash = document.getElementById('center-flash')!;
const flashIcon = document.getElementById('flash-icon')!;
const controls = document.getElementById('controls')!;
const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
const pauseIcon = document.getElementById('pause-icon')!;
const qlogBtn = document.getElementById('qlog-download') as HTMLButtonElement;
const statsBtn = document.getElementById('stats-btn') as HTMLButtonElement;
const fullscreenBtn = document.getElementById('fullscreen-btn')!;
const statsOverlay = document.getElementById('stats-overlay')!;
const statsContent = document.getElementById('stats-content')!;
const sparklineSection = document.getElementById('sparkline-section')!;
const sparkJitterCanvas = document.getElementById('spark-jitter') as HTMLCanvasElement;
const sparkLatencyCanvas = document.getElementById('spark-latency') as HTMLCanvasElement;
const sparkJitterVal = document.getElementById('spark-jitter-val')!;
const sparkLatencyVal = document.getElementById('spark-latency-val')!;
const videoTrackDropdown = document.getElementById('video-track-dropdown')!;
const videoTrackBtn = document.getElementById('video-track-btn')!;
const videoTrackLabel = document.getElementById('video-track-label')!;
const videoTrackMenu = document.getElementById('video-track-menu')!;
const audioTrackDropdown = document.getElementById('audio-track-dropdown')!;
const audioTrackBtn = document.getElementById('audio-track-btn')!;
const audioTrackLabel = document.getElementById('audio-track-label')!;
const audioTrackMenu = document.getElementById('audio-track-menu')!;

let player: MoqtPlayer | null = null;
let renderer: CanvasRenderer | null = null;
let trace: QlogTrace | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;
/** The `?fetchCatalog=1` external connection — player.destroy() won't close it. */
let externalConnection: InstanceType<typeof MoqtConnection> | null = null;

// One AudioContext/clock per PAGE (created on first user gesture, reused across
// stop/play cycles — each fresh player gets a new WebAudioOutput on the same ctx).
let audioCtx: AudioContext | null = null;
let audioClock: AudioAlignedClock | null = null;
function ensureAudio(): { ctx: AudioContext; clock: AudioAlignedClock } {
    if (!audioCtx || !audioClock) {
        audioClock = new AudioAlignedClock();
        audioCtx = new AudioContext();
        audioClock.attachAudioContext(audioCtx);
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return { ctx: audioCtx, clock: audioClock };
}

// ─── Sparkline Data ──────────────────────────────────────────────────

const SPARK_MAX = 300; // 10 seconds at ~30fps
const jitterSamples: number[] = [];
const latencySamples: number[] = [];
let lastVideoArrivalMs = 0;
let lastVideoExpectedIntervalMs = 33.3; // ~30fps default

function pushSpark(arr: number[], val: number): void {
    arr.push(val);
    if (arr.length > SPARK_MAX) arr.shift();
}

function drawSparkline(
    canvas: HTMLCanvasElement,
    data: number[],
    color: string,
    maxVal?: number,
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx || data.length < 2) return;

    const cw = canvas.clientWidth * devicePixelRatio;
    const ch = canvas.clientHeight * devicePixelRatio;
    // Only resize if dimensions actually changed
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const w = canvas.width;
    const h = canvas.height;

    let peak: number;
    if (maxVal) {
        peak = maxVal;
    } else {
        peak = 1;
        for (let i = 0; i < data.length; i++) {
            if (data[i]! > peak) peak = data[i]!;
        }
    }
    const step = w / (SPARK_MAX - 1);

    ctx.clearRect(0, 0, w, h);

    // Fill area
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < data.length; i++) {
        const x = (SPARK_MAX - data.length + i) * step;
        const y = h - (Math.min(data[i]!, peak) / peak) * h;
        ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = color.replace(')', ', 0.15)').replace('rgb', 'rgba');
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
        const x = (SPARK_MAX - data.length + i) * step;
        const y = h - (Math.min(data[i]!, peak) / peak) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();

    // Threshold line at 50% for jitter
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = devicePixelRatio * 0.5;
    ctx.stroke();
}

let sparkIntervalId = 0;

function sparklineTick(): void {
    if (jitterSamples.length > 1 || latencySamples.length > 1) {
        sparklineSection.style.display = '';
    }
    if (jitterSamples.length > 1) {
        drawSparkline(sparkJitterCanvas, jitterSamples, 'rgb(251, 191, 36)', 200);
        sparkJitterVal.textContent = `${jitterSamples[jitterSamples.length - 1]!.toFixed(0)}ms`;
    }
    if (latencySamples.length > 1) {
        drawSparkline(sparkLatencyCanvas, latencySamples, 'rgb(96, 165, 250)');
        sparkLatencyVal.textContent = `${latencySamples[latencySamples.length - 1]!.toFixed(0)}ms`;
    }
}

function startSparklineLoop(): void { sparkIntervalId = window.setInterval(sparklineTick, 60); }
function stopSparklineLoop(): void { clearInterval(sparkIntervalId); }

// ─── Player chrome (auto-hide, click-to-toggle, fullscreen) ─────────

// LIVE Stop/Play semantics (NOT pause/resume): this is live media, so "pause"
// via REQUEST_UPDATE forward:0 is wrong for the demo — the <video> element kept
// draining its buffer, and resume stranded currentTime behind a buffered gap
// (permanent stall). Stop now tears the player down (unsubscribe + close);
// Play performs a fresh tune-in (connect → catalog → subscribe → live edge).
let isPlaying = false;
let transitioning = false; // double-click guard while start/stop is in flight
let hideTimer: ReturnType<typeof setTimeout> | null = null;

// ── Live resilience: media-liveness watchdog + fatal-error reconnect ─────────
// A live player must never sit in "playing" with no media arriving (Safari WT
// stream death, relay restart). Watchdog: once the FIRST media object of a
// session arrives (startup is covered by the player's own watchdogs), if no
// object arrives for LIVENESS_TIMEOUT_MS — or a fatal connection error fires —
// run the same Stop + fresh-tune-in lifecycle the Stop/Play button uses, with
// bounded backoff. Intentional Stop disarms everything.
//
// LAYERING: MoqtPlayer's own liveness ladder fires first (livenessTimeoutMs
// default 10s) and restarts starved tracks IN-SESSION (REQUEST_UPDATE /
// resubscribe). This session-level watchdog is the OUTER safety net, so it
// waits 30s — long enough for the core ladder to recover transient
// starvation before we tear the whole session down. Fatal connection errors
// (including the core's MEDIA_STARVED escalation) still reconnect immediately.
const LIVENESS_TIMEOUT_MS = 30_000;
const HEALTHY_RESET_MS = 30_000;            // media flowing this long → retry budget resets
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];
const MAX_RECONNECT_ATTEMPTS = 6;           // per incident (budget resets when healthy)
const START_ATTEMPT_TIMEOUT_MS = 15_000;    // a hung tune-in counts as a failed attempt

let lastMediaMs = 0;          // 0 = disarmed (no media yet this session)
let healthySinceMs = 0;       // start of the current uninterrupted media streak
let reconnecting = false;     // a reconnect loop is in flight
let reconnectCancelled = false; // user pressed Stop during a reconnect loop
let retryCount = 0;
let playEpoch = 0;            // bumped by every stopPlayback(); a startPlayback()
                              // that observes a stale epoch must not touch state

/** Called from the media_object listener inside startPlayback(). */
function noteMediaArrival(): void {
    const now = performance.now();
    // A fresh session or a liveness-sized gap starts a new healthy streak.
    if (lastMediaMs === 0 || now - lastMediaMs > LIVENESS_TIMEOUT_MS) healthySinceMs = now;
    lastMediaMs = now;
}

// Dev-console introspection for the resilience state (like window.__player).
(window as any).__liveness = () => ({
    lastMediaMs, healthySinceMs, isPlaying, transitioning, reconnecting, retryCount, playEpoch,
    sinceMediaMs: lastMediaMs === 0 ? null : Math.round(performance.now() - lastMediaMs),
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

/** Tear down and re-tune with bounded backoff. One loop per incident. */
async function reconnect(reason: string): Promise<void> {
    if (reconnecting || transitioning || !isPlaying) return;
    reconnecting = true;
    reconnectCancelled = false;
    log(`⚠ ${reason} — reconnecting...`);
    try {
        transitioning = true;
        try { await stopPlayback(); } finally { transitioning = false; }

        while (retryCount < MAX_RECONNECT_ATTEMPTS && !reconnectCancelled) {
            const delay = RECONNECT_BACKOFF_MS[Math.min(retryCount, RECONNECT_BACKOFF_MS.length - 1)]!;
            log(`Reconnect attempt ${retryCount + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`);
            await new Promise((r) => setTimeout(r, delay));
            if (reconnectCancelled) break;
            try {
                transitioning = true;
                loadingSpinner.style.display = '';
                await withTimeout(startPlayback(), START_ATTEMPT_TIMEOUT_MS, 'tune-in');
                if (reconnectCancelled) {
                    // User pressed Stop while this attempt was in flight — honor it.
                    try { await stopPlayback(); } catch { /* best effort */ }
                    return;
                }
                log('Reconnected.');
                return; // success — retry budget resets after sustained healthy media
            } catch (err) {
                retryCount++;
                log(`Reconnect failed: ${(err as Error).message}`);
                // Clean up any half-started state before the next attempt.
                try { await stopPlayback(); } catch { /* best effort */ }
            } finally {
                transitioning = false;
                loadingSpinner.style.display = 'none';
            }
        }
        if (!reconnectCancelled) {
            log(`Gave up after ${MAX_RECONNECT_ATTEMPTS} attempts — press play to retry manually.`);
            centerPlay.style.display = '';
        }
    } finally {
        reconnecting = false;
    }
}

// Liveness tick: 1s cadence, guards make it a no-op unless armed and playing.
setInterval(() => {
    const now = performance.now();
    // 30s of UNINTERRUPTED media after an incident → reset the retry budget.
    if (retryCount > 0 && healthySinceMs > 0 && lastMediaMs > 0
        && now - lastMediaMs < LIVENESS_TIMEOUT_MS
        && now - healthySinceMs > HEALTHY_RESET_MS) {
        retryCount = 0;
    }
    if (!isPlaying || transitioning || reconnecting) return;
    if (lastMediaMs === 0) return; // not armed: no media yet this session
    if (now - lastMediaMs > LIVENESS_TIMEOUT_MS) {
        void reconnect(`No media for ${Math.round((now - lastMediaMs) / 1000)}s`);
    }
}, 1000);

// ── Unexpected-pause recovery (intent-aware) ─────────────────────────
// Safari can pause the <video> element on its own — muted background-tab
// power saving, autoplay-policy edges around unmute — with no error event.
// With the adapter no longer chase-seeking paused elements, an unexpected
// pause would otherwise present as a stuck frame while the app intent is
// still "playing". Recovery policy (example-level by design):
//   - visible tab: retry video.play() after a short debounce
//   - foreground return (visibilitychange/pageshow/focus): retry play()
//   - if playback does not actually resume, fall back to reconnect()
// Never fought: manual Stop (intent flags), teardown (playEpoch), and the
// MSE wedge ladder's deliberate rung-2 pause/play pulse (onWedge signal).
const PAUSE_RETRY_DEBOUNCE_MS = 350;
const RESUME_VERIFY_MS = 3_000;
const WEDGE_PULSE_IGNORE_MS = 1_500;
let cmafActive = false;        // <video> is the active sink (CMAF mode)
let lastWedgePulseMs = 0;      // stamped from onWedge rung 2 — that pause is deliberate
let lastResumeAttemptMs = 0;   // visibilitychange/pageshow/focus arrive in bursts
let pendingPauseRetry: ReturnType<typeof setTimeout> | null = null;

function playbackIntentActive(): boolean {
    return cmafActive && isPlaying && !transitioning && !reconnecting;
}

/** Retry play(); if the element still isn't progressing shortly after, re-tune. */
function attemptPlaybackResume(reason: string): void {
    const epoch = playEpoch;
    lastResumeAttemptMs = performance.now();
    log(`[video] ${reason} — retrying play()`);
    videoEl.play().catch((err) => log(`[video] play() retry rejected: ${(err as Error).message}`));
    const tBefore = videoEl.currentTime;
    setTimeout(() => {
        if (epoch !== playEpoch || !playbackIntentActive()) return;
        if (!videoEl.paused && videoEl.currentTime > tBefore + 0.2) return; // resumed
        void reconnect(`Playback did not resume after ${reason}`);
    }, RESUME_VERIFY_MS);
}

videoEl.addEventListener('pause', () => {
    if (!playbackIntentActive()) return;  // manual Stop / teardown owns this pause
    if (performance.now() - lastWedgePulseMs < WEDGE_PULSE_IGNORE_MS) return; // wedge pulse
    if (document.hidden) return;          // background power saving — recover on return
    if (pendingPauseRetry) clearTimeout(pendingPauseRetry);
    const epoch = playEpoch;
    pendingPauseRetry = setTimeout(() => {
        pendingPauseRetry = null;
        if (epoch !== playEpoch || !playbackIntentActive() || !videoEl.paused) return;
        attemptPlaybackResume('unexpected pause');
    }, PAUSE_RETRY_DEBOUNCE_MS);
});

function maybeResumeOnForeground(source: string): void {
    if (!playbackIntentActive() || !videoEl.paused) return;
    if (performance.now() - lastResumeAttemptMs < 1_000) return; // coalesce event bursts
    // If the buffer ran far ahead while paused, the adapter's behind-live
    // chase rejoins the live edge on the first commit after playback resumes.
    attemptPlaybackResume(`foreground return (${source})`);
}
window.addEventListener('pageshow', () => maybeResumeOnForeground('pageshow'));
window.addEventListener('focus', () => maybeResumeOnForeground('focus'));
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeResumeOnForeground('visibilitychange');
});

// Dev-console / harness introspection (like window.__liveness).
(window as any).__pauseRecovery = {
    noteWedgePulse: () => { lastWedgePulseMs = performance.now(); },
    state: () => ({ cmafActive, isPlaying, pendingRetry: pendingPauseRetry !== null }),
};

function showPlayerControls() {
    controls.classList.remove('hidden');
    playerWrap.classList.remove('hide-cursor');
    resetHideTimer();
}

function hidePlayerControls() {
    if (isPlaying && player) {
        controls.classList.add('hidden');
        playerWrap.classList.add('hide-cursor');
    }
}

function resetHideTimer() {
    if (hideTimer) clearTimeout(hideTimer);
    if (isPlaying && player) hideTimer = setTimeout(hidePlayerControls, 3000);
}

function flashCenter(type: 'play' | 'stop') {
    flashIcon.innerHTML = type === 'play'
        ? '<svg viewBox="0 0 24 24" fill="white" width="40" height="40"><path d="M8 5.14v14l11-7z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="white" width="40" height="40"><path d="M6 6h12v12H6z"/></svg>';
    centerFlash.style.display = '';
    setTimeout(() => { centerFlash.style.display = 'none'; }, 500);
}

/** Reflect playing/stopped on the control button (square = stop, triangle = play). */
function setControlIcon(playing: boolean) {
    pauseIcon.innerHTML = playing ? '<path d="M6 6h12v12H6z"/>' : '<path d="M8 5.14v14l11-7z"/>';
}

/**
 * STOP: immediately halt the visible media, then tear the player down.
 * `player.destroy()` unsubscribes everything and (for player-owned connections)
 * closes the session; the `?fetchCatalog=1` external connection is closed here.
 */
async function stopPlayback(): Promise<void> {
    // Immediate visual stop FIRST — never let the element drain its buffer.
    videoEl.pause();
    renderer?.stop();
    lastMediaMs = 0; // disarm the liveness watchdog for this session
    healthySinceMs = 0;
    cmafActive = false; // disarm unexpected-pause recovery for this session
    playEpoch++;     // invalidate any in-flight startPlayback() attempt

    const p = player;
    player = null;
    (window as any).__player = null;
    isPlaying = false;
    setControlIcon(false);
    flashCenter('stop');
    showPlayerControls();
    if (hideTimer) clearTimeout(hideTimer);

    try {
        await p?.destroy(); // unsubscribes; closes player-owned connection; MSE detached
    } catch (err) {
        log(`stop: destroy error (ignored): ${(err as Error).message}`);
    }
    if (externalConnection) {
        try { await externalConnection.close(); } catch { /* already closed */ }
        externalConnection = null;
    }
    renderer = null;
    log('Stopped. Press play to tune back in at the live edge.');
}

/** Stop ⇄ fresh-tune-in toggle, guarded against double clicks. */
async function toggleStopPlay(): Promise<void> {
    // A user action overrides any in-flight auto-reconnect loop — checked BEFORE
    // the transition guard, because the loop's own stop/start phases set
    // `transitioning` and a Stop click during them must still cancel.
    if (reconnecting) {
        reconnectCancelled = true;
        log('Auto-reconnect cancelled.');
        return;
    }
    if (transitioning) return;
    transitioning = true;
    pauseBtn.disabled = true;
    try {
        if (isPlaying) {
            await stopPlayback();
        } else {
            retryCount = 0; // a manual play starts with a fresh retry budget
            flashCenter('play');
            loadingSpinner.style.display = '';
            await startPlayback();
        }
    } catch (err) {
        log(`Fatal: ${(err as Error).message}`);
        console.error(err);
        loadingSpinner.style.display = 'none';
    } finally {
        transitioning = false;
        pauseBtn.disabled = false;
    }
}

playerWrap.addEventListener('mousemove', showPlayerControls);
playerWrap.addEventListener('click', (e) => {
    // Any click unmutes — MSE autoplay may have muted to satisfy policy.
    if (videoEl.muted) videoEl.muted = false;
    // Don't toggle if clicking controls or center play
    if ((e.target as HTMLElement).closest('.controls, .center-play, .stats-overlay')) return;
    if (player || isPlaying) void toggleStopPlay();
});
playerWrap.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.controls, .center-play')) return;
    if (!document.fullscreenElement) playerWrap.requestFullscreen();
    else document.exitFullscreen();
});
pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); void toggleStopPlay(); });
fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!document.fullscreenElement) playerWrap.requestFullscreen();
    else document.exitFullscreen();
});

// ─── Main ────────────────────────────────────────────────────────────

startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (transitioning || isPlaying) return;
    centerPlay.style.display = 'none';
    void toggleStopPlay();
});

qlogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!trace) {
        // Start collecting
        trace = new QlogTrace(`browser-${Date.now()}`);
        qlogBtn.classList.add('recording');
        qlogBtn.title = 'Stop & download qlog';
        log('qlog recording started');
    } else {
        // Stop collecting and download
        const count = trace.length;
        const json = trace.toString();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `moqt-trace-${Date.now()}.qlog`;
        a.click();
        URL.revokeObjectURL(url);
        log(`Downloaded qlog trace (${count} events)`);
        trace = null;
        qlogBtn.classList.remove('recording');
        qlogBtn.title = 'Record qlog';
    }
});

const statsClose = document.getElementById('stats-close')!;
statsClose.addEventListener('click', (e) => {
    e.stopPropagation();
    statsOverlay.classList.remove('visible');
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    stopSparklineLoop();
});

statsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = statsOverlay.classList.toggle('visible');
    statsBtn.classList.toggle('active', isVisible);
    if (isVisible && player) {
        updateStatsOverlay();
        statsInterval = setInterval(updateStatsOverlay, 500); // text stats at 2Hz
        startSparklineLoop();
    } else if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
        stopSparklineLoop();
    }
});

// ─── Stats Overlay Rendering ──────────────────────────────────────────

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem.toFixed(0)}s`;
}

function formatBitrate(bps: number): string {
    if (bps === 0) return '--';
    if (bps < 1000) return `${bps} bps`;
    if (bps < 1_000_000) return `${(bps / 1000).toFixed(0)} Kbps`;
    return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

function ttffSegmentColor(index: number): string {
    const colors = ['#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#4ade80'];
    return colors[index % colors.length]!;
}

function renderTTFFBar(breakdown: TTFFBreakdown): string {
    const stages = [
        { label: 'Connect', ms: breakdown.transportConnectedMs },
        { label: 'Setup', ms: breakdown.setupCompleteMs },
        { label: 'Catalog', ms: breakdown.catalogReceivedMs },
        { label: '1st Obj', ms: breakdown.firstObjectReceivedMs },
        { label: 'Decoder', ms: breakdown.decoderConfiguredMs },
        { label: 'Render', ms: breakdown.firstFrameRenderedMs },
    ];

    const total = breakdown.firstFrameRenderedMs ?? 0;
    if (total === 0) return '';

    let prev = 0;
    const segments = stages
        .filter(s => s.ms !== null)
        .map((s, i) => {
            const delta = (s.ms ?? 0) - prev;
            prev = s.ms ?? 0;
            const pct = Math.max((delta / total) * 100, 1);
            return `<div class="ttff-segment" style="width:${pct}%;background:${ttffSegmentColor(i)}" title="${s.label}: ${s.ms}ms (+${delta}ms)"></div>`;
        });

    return `<div class="ttff-bar">${segments.join('')}</div>`;
}

function statRow(label: string, value: string, cls = ''): string {
    return `<div class="stat-row"><span class="stat-label">${label}</span><span class="stat-value${cls ? ' ' + cls : ''}">${value}</span></div>`;
}

function updateStatsOverlay(): void {
    if (!player) return;
    const s: PlayerStats = (player as any)._stats?.snapshot() ?? player.stats;

    const ttff = s.timeToFirstFrameMs;
    const ttffStr = ttff !== null ? `${ttff.toFixed(0)}ms` : '--';
    const res = s.currentResolution;
    const resStr = res ? `${res.width}x${res.height}` : '--';
    const fps = s.playbackDurationMs > 0 ? ((s.framesRendered / s.playbackDurationMs) * 1000).toFixed(1) : '0';
    const throughput = s.sessionAgeMs > 0 ? (s.bytesReceived * 8) / (s.sessionAgeMs / 1000) : 0;

    const healthClass = s.stallCount === 0 && s.decodeErrorCount === 0 ? 'good'
        : s.stallCount > 3 || s.decodeErrorCount > 3 ? 'bad' : 'warn';

    statsContent.innerHTML = `
    <div class="stats-title">Stats for Nerds</div>
    <div class="stats-grid">
      <div class="stats-section">
        <div class="section-label">Timing</div>
        ${statRow('TTFF', ttffStr, 'highlight')}
        ${statRow('Session', formatDuration(s.sessionAgeMs))}
        ${statRow('Playing', formatDuration(s.playbackDurationMs))}
        ${s.ttffBreakdown ? renderTTFFBar(s.ttffBreakdown) : ''}
      </div>
      <div class="stats-section">
        <div class="section-label">Quality</div>
        ${statRow('Resolution', resStr)}
        ${statRow('Video', s.currentVideoCodec ?? '--')}
        ${statRow('Audio', s.currentAudioCodec ?? '--')}
        ${statRow('Bitrate', formatBitrate(s.currentBitrate))}
        ${statRow('Switches', `${s.qualitySwitchCount}`)}
      </div>
      <div class="stats-section">
        <div class="section-label">Frames</div>
        ${statRow('Decoded', s.framesDecoded.toLocaleString())}
        ${statRow('Rendered', s.framesRendered.toLocaleString())}
        ${statRow('FPS', fps)}
        ${statRow('Dropped', `${s.framesDropped}`, s.framesDropped > 0 ? 'warn' : '')}
      </div>
      <div class="stats-section">
        <div class="section-label">Network</div>
        ${statRow('Objects', s.objectsReceived.toLocaleString())}
        ${statRow('Received', formatBytes(s.bytesReceived))}
        ${statRow('Throughput', formatBitrate(throughput))}
        ${statRow('Gaps', `${s.gapsReceived}`, s.gapsReceived > 0 ? 'warn' : '')}
      </div>
      <div class="stats-section">
        <div class="section-label">Health</div>
        ${statRow('Stalls', `${s.stallCount}${s.totalStallDurationMs > 0 ? ' (' + formatDuration(s.totalStallDurationMs) + ')' : ''}`, s.stallCount > 0 ? 'warn' : 'good')}
        ${statRow('Decode Errors', `${s.decodeErrorCount}`, s.decodeErrorCount > 0 ? 'bad' : 'good')}
        ${statRow('Gap Events', `${s.gapCount}`, s.gapCount > 0 ? 'warn' : '')}
        ${statRow('Recoveries', `${s.recoveryActionCount}`, s.recoveryActionCount > 0 ? 'warn' : '')}
        ${s.avSkewMs !== null ? statRow('A/V Skew', `${s.avSkewMs.toFixed(0)}ms (avg ${(s.avSkewEwmaMs ?? 0).toFixed(0)}ms)`, Math.abs(s.avSkewEwmaMs ?? 0) > 80 ? 'warn' : 'good') : ''}
      </div>
      <div class="stats-section">
        <div class="section-label">Session</div>
        ${statRow('State', player.state, healthClass)}
        ${statRow('Ready', player.readyStateLabel, player.readyState >= 2 ? 'good' : player.readyState >= 1 ? 'highlight' : 'warn')}
        ${statRow('Reconnects', `${s.reconnectCount}`)}
      </div>
    </div>
    ${renderPipelineBar(s)}
  `;
}

/** Render the pipeline status bar showing progression through stages. */
function renderPipelineBar(s: PlayerStats): string {
    if (!player) return '';

    const b = s.ttffBreakdown;
    const now = s.sessionAgeMs;

    // Define pipeline stages in order
    const stages: { label: string; doneMs: number | null; startMs: number }[] = [
        { label: 'Connect', doneMs: b?.transportConnectedMs ?? null, startMs: 0 },
        { label: 'Setup', doneMs: b?.setupCompleteMs ?? null, startMs: b?.transportConnectedMs ?? 0 },
        { label: 'Catalog', doneMs: b?.catalogReceivedMs ?? null, startMs: b?.setupCompleteMs ?? 0 },
        { label: 'Subscribe', doneMs: b?.firstObjectReceivedMs ?? null, startMs: b?.catalogReceivedMs ?? 0 },
        { label: 'Decode', doneMs: b?.decoderConfiguredMs ?? null, startMs: b?.firstObjectReceivedMs ?? 0 },
        { label: 'Render', doneMs: b?.firstFrameRenderedMs ?? null, startMs: b?.decoderConfiguredMs ?? 0 },
    ];

    // Find the first incomplete stage
    let activeIndex = stages.findIndex(st => st.doneMs === null);
    if (activeIndex === -1) activeIndex = stages.length; // all done

    const parts: string[] = [];

    for (let i = 0; i < stages.length; i++) {
        const st = stages[i]!;

        // Arrow between stages
        if (i > 0) {
            const arrowClass = i <= activeIndex ? 'done' : '';
            parts.push(`<span class="pipeline-arrow ${arrowClass}">&rarr;</span>`);
        }

        let pillClass: string;
        let timing: string;

        if (st.doneMs !== null) {
            // Completed
            pillClass = 'done';
            const delta = st.doneMs - st.startMs;
            timing = `${delta > 0 ? delta.toFixed(0) : '0'}ms`;
        } else if (i === activeIndex) {
            // Active — currently waiting
            pillClass = 'active';
            const elapsed = now - st.startMs;
            timing = `${elapsed > 0 ? (elapsed / 1000).toFixed(1) : '0'}s...`;
        } else {
            // Future
            pillClass = 'pending';
            timing = '';
        }

        parts.push(`<div class="pipeline-stage"><div class="pill ${pillClass}">${st.label}</div>${timing ? `<div class="timing">${timing}</div>` : ''}</div>`);
    }

    return `<div class="pipeline-bar">${parts.join('')}</div>`;
}

/**
 * `?fetchCatalog=1` opt-in: connect a single adapter, FETCH the catalog
 * out-of-band (no SUBSCRIBE on the catalog track), then hand the
 * already-connected adapter + parsed catalog to MoqtPlayer via external-
 * adapter mode. Useful for relays where catalog SUBSCRIBE is unreliable
 * but FETCH works (Synamedia, some Akamai paths).
 *
 * Demo-quality: assumes JSON (MSF) catalog; would need parseCatalogAuto
 * for CF01-encoded catalogs.
 */
async function prefetchCatalogViaFetch(): Promise<{
    connection: InstanceType<typeof MoqtConnection>;
    catalog: { tracks: any[] };
}> {
    log('FETCH-catalog mode: pre-fetching catalog (no SUBSCRIBE)...');
    const transport = await createWebTransport({ ...(certHash ? { certHash } : {}), ...(draftVersion ? { draftVersion } : {}) })(relayUrl);
    const connection = new MoqtConnection(draftVersion);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const nsFields: readonly string[] = typeof namespaceArg === 'string'
        ? namespaceArg.split('/')
        : namespaceArg;
    const nsBytes = nsFields.map((s) => enc.encode(s));

    const catalogPromise = new Promise<{ tracks: any[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('FETCH catalog timeout (10s)')), 10_000);
        connection.onObject = (_streamId, obj) => {
            clearTimeout(timer);
            if (obj.kind === 'gap') { reject(new Error('FETCH returned gap — catalog not in cache')); return; }
            if (!obj.payload || obj.payload.byteLength === 0) { reject(new Error('FETCH returned empty payload')); return; }
            try {
                const parsed = JSON.parse(dec.decode(obj.payload));
                if (!parsed?.tracks || !Array.isArray(parsed.tracks)) throw new Error('catalog has no tracks[]');
                resolve(parsed);
            } catch (err) { reject(err instanceof Error ? err : new Error(String(err))); }
        };
    });

    await connection.connect(transport, { maxRequestId: varint(100) });
    const reqId = await connection.fetch(nsBytes, enc.encode(CATALOG_TRACK_NAME), {
        startGroup: varint(0n), startObject: varint(0n),
        endGroup: varint(0n), endObject: varint(0n),
    });
    log(`FETCH catalog: reqId=${reqId} group=0 object=0`);

    const catalog = await catalogPromise;
    log(`FETCH'd catalog: ${catalog.tracks.length} tracks`);
    return { connection, catalog };
}

/** Fresh tune-in: connect → catalog → subscribe → play. Re-invokable after stopPlayback(). */
async function startPlayback(): Promise<void> {
    // Stale-attempt token: a reconnect attempt that times out (withTimeout) keeps
    // running underneath — the loop's cleanup stopPlayback() bumps playEpoch, and
    // this attempt must then bail without mutating player/UI state.
    const epoch = playEpoch;
    const { ctx: audioCtx, clock: audioClock } = ensureAudio();
    log(`Relay: ${relayUrl}`);
    log(`Namespace: ${Array.isArray(namespaceArg) ? `[${namespaceArg.map(f => `"${f}"`).join(', ')}]` : namespaceArg}`);
    if (catalogFromUrl) log(`Catalog: injected (${catalogFromUrl.tracks.length} tracks)`);
    log('');

    // ── Create browser adapters ──────────────────────────────────────
    // These wrap browser APIs behind the player's swappable interfaces.
    // CommandDispatcher routes pipeline decoder commands to them.

    renderer = new CanvasRenderer(canvas, { clock: audioClock });

    // ── Create player with adapter factories ─────────────────────────
    // The player internally creates these after catalog arrives (so it
    // can inject codec metadata from the MSF catalog).

    const lateMs = params.get('late') ? parseInt(params.get('late')!, 10) : undefined;
    const gapMs = params.get('gap') ? parseInt(params.get('gap')!, 10) : undefined;
    const preferSoftwareDecoder = params.get('swdec') === '1';

    // FETCH-catalog mode: pre-fetch + reuse adapter so the player skips
    // the connect handshake AND the catalog SUBSCRIBE.
    let prefetched: { connection: InstanceType<typeof MoqtConnection>; catalog: { tracks: any[] } } | null = null;
    if (params.get('fetchCatalog') === '1' && !catalogFromUrl) {
        prefetched = await prefetchCatalogViaFetch();
        if (epoch !== playEpoch) {
            // Superseded (timeout/stop) while prefetching — leave state alone.
            try { await prefetched.connection.close(); } catch { /* already closed */ }
            return;
        }
        externalConnection = prefetched.connection; // closed by stopPlayback()
    }

    // ?res=720 → quality controller picks the matching track at startup
    // (no subscribe-then-switch race). Uses maxHeight constraint so the
    // quality controller selects the highest track ≤ the target height.
    const resParam = params.get('res');
    const resHeight = resParam ? parseInt(resParam, 10) : 0;
    const videoConstraints = resHeight > 0
        ? { maxHeight: resHeight } : undefined;

    player = new MoqtPlayer({
        url: relayUrl,
        namespace: namespaceArg,
        ...(draftVersion ? { draftVersion } : {}),
        clock: audioClock,
        ...(videoConstraints ? { videoConstraints } : {}),
        ...(catalogFromUrl ? { catalog: catalogFromUrl } : {}),
        ...(prefetched ? { catalog: prefetched.catalog, connection: prefetched.connection } : {}),
        ...(lateMs ? { lateFrameThresholdMs: lateMs } : {}),
        ...(gapMs ? { gapTimeoutMs: gapMs } : {}),
        createTransport: createWebTransport({ ...(certHash ? { certHash } : {}), ...(draftVersion ? { draftVersion } : {}) }),
        createConnection: () => new MoqtConnection(draftVersion),
        createVideoDecoder: () => new WebCodecsVideoDecoder({ preferSoftwareDecoder }),
        createAudioDecoder: () => new WebCodecsAudioDecoder(),
        createRenderer: () => renderer!,
        createAudioOutput: () => new WebAudioOutput(audioCtx, undefined, 200, audioClock),
        createMediaSource: () => {
            const ms = new MseMediaSource(videoEl);
            // Playhead-wedge forensics into the PAGE log (the adapter's own
            // logWarn only reaches the console) — so unattended sessions
            // self-document which recovery rung fired. Rung 2 is a deliberate
            // pause/play pulse: stamp it so unexpected-pause recovery does
            // not fight the ladder (onWedge fires BEFORE the pulse acts).
            ms.onWedge = (w) => {
                if (w.rung === 2) lastWedgePulseMs = performance.now();
                log(`[MSE] playhead wedge rung ${w.rung}: t=${w.currentTime.toFixed(2)} `
                    + `ready=${w.readyState} dec=${w.decodedFrames ?? '?'} ranges=${w.bufferedRanges}`);
            };
            return ms;
        },
        createCmafAssembler: (opts) => new CmafAssembler(opts),
        onQlogEvent: (e) => trace?.record(e),
    });

    // ── Wire player events ──────────────────────────────────────────

    player.on('session_connecting', (e) => log(`Connecting to ${e.url}...`));
    player.on('session_established', () => log('Session established.'));
    player.on('session_goaway', (e) => log(`GOAWAY: ${e.newSessionUri ?? 'no URI'}`));
    player.on('session_closed', (e) => log(`Closed: ${e.reason ?? 'clean'}`));
    player.on('session_error', (e) => log(`Error: ${e.error.message}`));
    player.on('error', (e) => {
        const err = e.error;
        log(`[ErrorTaxonomy] ${err.severity}/${err.source} code=0x${err.code.toString(16)}: ${err.message}`);
        // Fatal connection loss → same Stop + fresh-tune-in lifecycle as the
        // liveness watchdog. (Intentional stop emits no errors — destroy() is
        // quiet and the adapter swallows teardown accept-loop failures.)
        // MEDIA_ELEMENT_WEDGED (fatal/decoder): Safari froze the <video>
        // element beyond the MSE adapter's nudge ladder — only a fresh
        // tune-in rebuilds the MediaSource, so it takes the same path.
        if (err.severity === 'fatal'
            && (err.source === 'connection' || err.code === PlayerErrorCode.MEDIA_ELEMENT_WEDGED)) {
            void reconnect(`Fatal ${err.source} error (0x${err.code.toString(16)})`);
        }
    });

    player.on('catalog_received', (e) => {
        log(`Catalog: ${e.catalog.tracks.length} tracks`);
        for (const t of e.catalog.tracks) {
            const parts: string[] = [t.name];
            if (t.codec) parts.push(t.codec);
            if (t.width && t.height) parts.push(`${t.width}x${t.height}`);
            if (t.bitrate) parts.push(`${(t.bitrate / 1000).toFixed(0)}kbps`);
            log(`  ${parts.join(' | ')}`);
        }

        // Detect packaging: CMAF uses <video> element, LOC uses <canvas>
        const hasCmaf = e.catalog.tracks.some(t => t.packaging === 'cmaf');
        cmafActive = hasCmaf; // gates unexpected-pause recovery to the <video> sink
        if (hasCmaf) {
            canvas.style.display = 'none';
            videoEl.hidden = false;
            videoEl.style.display = 'block';
            log('  [CMAF mode — using MSE/<video>]');
        }

        // Size canvas to video dimensions from catalog
        const videoTrack = e.catalog.tracks.find(t => t.role === 'video');
        if (videoTrack) {
            canvas.width = videoTrack.width ?? 1920;
            canvas.height = videoTrack.height ?? 1080;
        }

        // Populate track selector after subscriptions are set up (next microtask)
        setTimeout(() => { if (player) buildTrackSelector(player); }, 0);
    });

    player.on('catalog_updated', () => log('Catalog updated (delta).'));

    player.on('track_subscribed', (e) => {
        log(`Subscribed: ${e.trackName} (${e.mediaType}, reqId=${e.requestId})`);
    });

    // Rendering lifecycle events from the CanvasRenderer
    player.on('first_frame', () => log('First video frame rendered!'));
    player.on('stall', (e) => log(`Stall detected: ${e.durationMs.toFixed(0)}ms`));

    // Playback events from the pipeline
    player.on('gap_detected', (e) => log(`Gap: ${e.mediaType} group=${e.groupId}`));
    player.on('skip_forward', (e) => log(`Skip: ${e.mediaType} ${e.fromGroupId}->${e.toGroupId}`));
    player.on('track_ended', (e) => log(`Track ended: ${e.mediaType}`));
    player.on('keyframe_waiting', (e) => log(`Keyframe waiting: ${e.mediaType} group=${e.groupId}`));
    player.on('recovery_action', (e) => log(`Recovery: ${e.action.type}`));

    player.on('state_changed', (e) => log(`State: ${e.from} -> ${e.to}`));
    player.on('quality_switched', (e) => {
        log(`Quality: ${e.fromTrackName} -> ${e.toTrackName} (${e.reason})`);
        if (player) buildTrackSelector(player);
    });

    // Collect jitter + latency for sparkline graphs
    player.on('media_object', (e) => {
        // Liveness watchdog: ANY media object (audio included) proves the data
        // path is alive — stamp before the video-only sparkline filter.
        noteMediaArrival();
        if (e.mediaType !== 'video' || e.kind !== 'data') return;
        const nowMs = performance.now();

        // Interarrival jitter: |actual_interval - expected_interval|
        if (lastVideoArrivalMs > 0) {
            const intervalMs = nowMs - lastVideoArrivalMs;
            const jitterMs = Math.abs(intervalMs - lastVideoExpectedIntervalMs);
            pushSpark(jitterSamples, jitterMs);
        }
        lastVideoArrivalMs = nowMs;

        // End-to-end latency from CaptureTimestamp
        if (e.captureTimestamp && e.captureTimestamp > 0n) {
            const captureMs = Number(e.captureTimestamp) / 1000;
            const latencyMs = Date.now() - captureMs;
            if (latencyMs > 0 && latencyMs < 30_000) {
                pushSpark(latencySamples, latencyMs);
            }
        }
    });

    // ── Load + Play ─────────────────────────────────────────────────

    // Expose player on window for console inspection (dev only)
    (window as any).__player = player;

    const p = player; // local ref: the global may be swapped while load() is in flight
    await p.load();
    if (epoch !== playEpoch) {
        // This attempt was timed out / cancelled while load() was pending. The
        // reconnect loop (or a user Stop) has already torn down and moved on —
        // a late completion must not resurrect old player/UI state.
        try { await p.destroy(); } catch { /* best effort */ }
        return;
    }
    p.play();

    // MSE: ensure <video> element is playing (autoplay may be blocked)
    videoEl.play().catch(() => { /* autoplay blocked — user interaction needed */ });

    // Start the rendering loop (rAF-driven frame presentation)
    renderer.start();

    // Show controls, hide spinner; reflect playing state on the Stop/Play control.
    loadingSpinner.style.display = 'none';
    controls.style.display = '';
    isPlaying = true;
    setControlIcon(true);
    showPlayerControls();
}

// ─── Track Dropdowns ─────────────────────────────────────────────────

// Close any open dropdown on outside click
document.addEventListener('click', (e) => {
    if (!videoTrackDropdown.contains(e.target as Node)) videoTrackDropdown.classList.remove('open');
    if (!audioTrackDropdown.contains(e.target as Node)) audioTrackDropdown.classList.remove('open');
});
videoTrackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audioTrackDropdown.classList.remove('open');
    videoTrackDropdown.classList.toggle('open');
});
audioTrackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    videoTrackDropdown.classList.remove('open');
    audioTrackDropdown.classList.toggle('open');
});

function buildTrackSelector(p: MoqtPlayer): void {
    const videoTracks = p.availableVideoTracks;
    const currentRes = p.stats.currentResolution;

    // Video dropdown
    if (videoTracks.length > 0) {
        videoTrackDropdown.classList.add('visible');

        // Find current
        const current = videoTracks.find(t =>
            currentRes && t.width === currentRes.width && t.height === currentRes.height,
        ) ?? videoTracks[0];

        // Button label: current resolution
        const label = current?.width && current?.height
            ? `${current.height}p`
            : 'Video';
        videoTrackLabel.innerHTML = label +
            (videoTracks.length > 1 ? '' : '');

        // Hide chevron if only one track
        const chevron = videoTrackBtn.querySelector('.chevron') as HTMLElement;
        if (chevron) chevron.style.display = videoTracks.length > 1 ? '' : 'none';

        // Build menu
        videoTrackMenu.innerHTML = '';
        for (const t of videoTracks) {
            const item = document.createElement('div');
            item.className = 'track-dropdown-item';
            if (current && t.name === current.name) item.classList.add('active');

            const nameSpan = document.createElement('span');
            nameSpan.textContent = t.width && t.height ? `${t.width}x${t.height}` : t.name;

            const detailSpan = document.createElement('span');
            detailSpan.className = 'item-detail';
            detailSpan.textContent = t.bitrate ? `${(t.bitrate / 1000).toFixed(0)}k` : '';

            item.appendChild(nameSpan);
            item.appendChild(detailSpan);

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                videoTrackDropdown.classList.remove('open');
                p.selectVideoTrack(t.name).then(() => {
                    log(`Switched to ${t.name}`);
                }).catch((err: Error) => {
                    log(`Switch failed: ${err.message}`);
                });
            });

            videoTrackMenu.appendChild(item);
        }
    } else {
        videoTrackDropdown.classList.remove('visible');
    }

    // Audio dropdown — show codec/bitrate info (no switching yet)
    // TODO: wire audio track switching when implemented
    const catalog = (p as any)._catalogState;
    if (catalog) {
        const audioTracks = catalog.tracks.filter((t: any) => t.role === 'audio');
        if (audioTracks.length > 0) {
            audioTrackDropdown.classList.add('visible');
            const current = audioTracks[0];
            audioTrackLabel.textContent = current.codec ?? 'Audio';

            const chevron = audioTrackBtn.querySelector('.chevron') as HTMLElement;
            if (chevron) chevron.style.display = audioTracks.length > 1 ? '' : 'none';

            audioTrackMenu.innerHTML = '';
            for (const t of audioTracks) {
                const item = document.createElement('div');
                item.className = 'track-dropdown-item';
                if (t === current) item.classList.add('active');

                const nameSpan = document.createElement('span');
                nameSpan.textContent = t.codec ?? t.name;

                const detailSpan = document.createElement('span');
                detailSpan.className = 'item-detail';
                const parts: string[] = [];
                if (t.bitrate) parts.push(`${(t.bitrate / 1000).toFixed(0)}k`);
                if (t.samplerate) parts.push(`${t.samplerate / 1000}kHz`);
                detailSpan.textContent = parts.join(' ');

                item.appendChild(nameSpan);
                item.appendChild(detailSpan);
                audioTrackMenu.appendChild(item);
            }
        }
    }
}
