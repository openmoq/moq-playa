/**
 * Playa — Simple Example
 *
 * The entire player wired to a full UI in ~30 lines of player code.
 * Everything else is DOM glue.
 */

import { Player } from '@playa/player';
import { relayUrl, namespace, certHash, draftVersion } from '../shared/cert.js';

// ─── DOM refs & helpers ─────────────────────────────────────────────

const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const seekBar = document.getElementById('seek') as HTMLInputElement;
const timeDisplay = document.getElementById('time')!;
const volumeBar = document.getElementById('volume') as HTMLInputElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const qualitySelect = document.getElementById('quality') as HTMLSelectElement;
const stateBadge = document.getElementById('state')!;
const statsDiv = document.getElementById('stats')!;
const logEl = document.getElementById('log')!;
const playerContainer = document.getElementById('player-container')!;

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Create Player ──────────────────────────────────────────────────

const player = new Player(playerContainer, {
  url: relayUrl,
  namespace,
  ...(certHash ? { certHash } : {}),
  ...(draftVersion ? { draftVersion } : {})
});

// ─── Wire Events ────────────────────────────────────────────────────

player.on('statechange', ({ state }) => {
  stateBadge.textContent = state;
  stateBadge.className = `state-badge ${state}`;
});

player.on('ready', ({ levels }) => {
  log(`Ready: ${levels.length} quality level(s)`);
  playBtn.disabled = false;
  muteBtn.disabled = false;
  qualitySelect.disabled = false;
  qualitySelect.innerHTML = '<option value="auto">Auto</option>';
  for (const level of levels) {
    const opt = document.createElement('option');
    opt.value = String(level.index);
    opt.textContent = `${level.label} (${Math.round(level.bitrate / 1000)}k)`;
    qualitySelect.appendChild(opt);
  }
});

player.on('playing', () => log('First frame rendered'));

player.on('timeupdate', ({ currentTime }) => {
  timeDisplay.textContent = formatTime(currentTime);
  if (player.duration) {
    seekBar.max = String(player.duration);
    seekBar.value = String(currentTime);
    seekBar.disabled = !player.seekable;
  }
});

player.on('durationchange', ({ duration }) => log(`Duration: ${formatTime(duration)}`));
player.on('qualitychange', ({ level, auto }) => log(`Quality: ${level.label} (${auto ? 'ABR' : 'manual'})`));
player.on('stall', ({ durationMs }) => log(`Stall: ${durationMs}ms`));
player.on('error', ({ severity, message }) => log(`[${severity}] ${message}`));

player.on('stats', (s) => {
  statsDiv.innerHTML = [
    `<span>${s.framesRendered}</span> frames`,
    s.resolution ? `<span>${s.resolution.width}x${s.resolution.height}</span>` : '',
    s.videoCodec ? `<span>${s.videoCodec}</span>` : '',
    s.timeToFirstFrameMs !== null ? `TTFF <span>${s.timeToFirstFrameMs.toFixed(0)}ms</span>` : '',
    s.stallCount > 0 ? `stalls <span>${s.stallCount}</span>` : '',
  ].filter(Boolean).join(' &middot; ');
});

// ─── Controls ───────────────────────────────────────────────────────

playBtn.addEventListener('click', () => {
  if (player.state === 'playing') player.pause();
  else player.play();
});

player.on('play', () => { playBtn.textContent = 'Pause'; });
player.on('pause', () => { playBtn.textContent = 'Play'; });

seekBar.addEventListener('input', () => player.seek(Number(seekBar.value)));
volumeBar.addEventListener('input', () => player.setVolume(Number(volumeBar.value) / 100));
muteBtn.addEventListener('click', () => player.toggleMute());
player.on('volumechange', ({ muted }) => { muteBtn.textContent = muted ? 'Unmute' : 'Mute'; });

qualitySelect.addEventListener('change', () => {
  const val = qualitySelect.value;
  void player.setQuality(val === 'auto' ? 'auto' : Number(val))
    .catch((err: unknown) => log(`Quality switch failed: ${(err as Error).message}`));
});

// ─── Load ───────────────────────────────────────────────────────────

log(`Relay: ${relayUrl}`);
log(`Namespace: ${namespace}`);
player.load().catch((err) => log(`Fatal: ${(err as Error).message}`));
