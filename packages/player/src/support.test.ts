/**
 * Capability detection tests — red/green TDD.
 *
 * Tests mock globalThis properties and restore them in afterEach.
 *
 * @see DESIGN-browser-adapter-gaps.md §6
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest';
import { checkSupport } from './support.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Track properties we've set on globalThis so we can clean up. */
const overrides: Array<{ key: string; had: boolean; prev: any }> = [];

function setGlobal(key: string, value: any): void {
  const g = globalThis as any;
  overrides.push({ key, had: key in g, prev: g[key] });
  g[key] = value;
}

function deleteGlobal(key: string): void {
  const g = globalThis as any;
  if (key in g) {
    overrides.push({ key, had: true, prev: g[key] });
    delete g[key];
  }
}

afterEach(() => {
  const g = globalThis as any;
  while (overrides.length > 0) {
    const { key, had, prev } = overrides.pop()!;
    if (had) {
      g[key] = prev;
    } else {
      delete g[key];
    }
  }
});

/** Set up a full Chrome-like environment. */
function simulateChrome(): void {
  setGlobal('WebTransport', class {});
  setGlobal('WebSocket', class {});
  setGlobal('VideoDecoder', class {});
  setGlobal('AudioDecoder', class {});
  setGlobal('MediaSource', class {});
  setGlobal('HTMLCanvasElement', class {});
  setGlobal('OffscreenCanvas', class {});
  setGlobal('AudioContext', class {});
  setGlobal('isSecureContext', true);
}

/** Strip everything to simulate bare Node.js. */
function simulateNode(): void {
  deleteGlobal('WebTransport');
  deleteGlobal('WebSocket');
  deleteGlobal('VideoDecoder');
  deleteGlobal('AudioDecoder');
  deleteGlobal('MediaSource');
  deleteGlobal('ManagedMediaSource');
  deleteGlobal('HTMLCanvasElement');
  deleteGlobal('OffscreenCanvas');
  deleteGlobal('AudioContext');
  deleteGlobal('webkitAudioContext');
  deleteGlobal('isSecureContext');
}

// ─── Individual capabilities ─────────────────────────────────────────

describe('checkSupport — individual capabilities', () => {
  it('detects WebTransport', () => {
    simulateNode();
    setGlobal('WebTransport', class {});
    expect(checkSupport().webTransport).toBe(true);
  });

  it('reports WebTransport absent', () => {
    simulateNode();
    expect(checkSupport().webTransport).toBe(false);
  });

  it('detects WebSocket', () => {
    simulateNode();
    setGlobal('WebSocket', class {});
    expect(checkSupport().webSocket).toBe(true);
  });

  it('detects VideoDecoder', () => {
    simulateNode();
    setGlobal('VideoDecoder', class {});
    expect(checkSupport().videoDecoder).toBe(true);
  });

  it('detects AudioDecoder', () => {
    simulateNode();
    setGlobal('AudioDecoder', class {});
    expect(checkSupport().audioDecoder).toBe(true);
  });

  it('detects MediaSource', () => {
    simulateNode();
    setGlobal('MediaSource', class {});
    expect(checkSupport().mediaSource).toBe(true);
  });

  it('detects ManagedMediaSource (Safari)', () => {
    simulateNode();
    setGlobal('ManagedMediaSource', class {});
    expect(checkSupport().mediaSource).toBe(true);
  });

  it('detects AudioContext', () => {
    simulateNode();
    setGlobal('AudioContext', class {});
    expect(checkSupport().audioContext).toBe(true);
  });

  it('detects webkitAudioContext (Safari)', () => {
    simulateNode();
    setGlobal('webkitAudioContext', class {});
    expect(checkSupport().audioContext).toBe(true);
  });

  it('detects HTMLCanvasElement', () => {
    simulateNode();
    setGlobal('HTMLCanvasElement', class {});
    expect(checkSupport().canvas).toBe(true);
  });

  it('detects OffscreenCanvas', () => {
    simulateNode();
    setGlobal('OffscreenCanvas', class {});
    expect(checkSupport().offscreenCanvas).toBe(true);
  });

  it('detects isSecureContext true', () => {
    simulateNode();
    setGlobal('isSecureContext', true);
    expect(checkSupport().isSecureContext).toBe(true);
  });

  it('detects isSecureContext false', () => {
    simulateNode();
    setGlobal('isSecureContext', false);
    expect(checkSupport().isSecureContext).toBe(false);
  });

  it('defaults isSecureContext to false when absent', () => {
    simulateNode();
    expect(checkSupport().isSecureContext).toBe(false);
  });
});

// ─── Transport rollup ────────────────────────────────────────────────

describe('checkSupport — transport rollup', () => {
  it('selects webtransport when available and secure', () => {
    simulateNode();
    setGlobal('WebTransport', class {});
    setGlobal('WebSocket', class {});
    setGlobal('isSecureContext', true);
    expect(checkSupport().transport).toBe('webtransport');
  });

  it('falls back to websocket when WebTransport is insecure', () => {
    simulateNode();
    setGlobal('WebTransport', class {});
    setGlobal('WebSocket', class {});
    setGlobal('isSecureContext', false);
    expect(checkSupport().transport).toBe('websocket');
  });

  it('falls back to websocket when WebTransport is absent', () => {
    simulateNode();
    setGlobal('WebSocket', class {});
    expect(checkSupport().transport).toBe('websocket');
  });

  it('returns none when no transport is available', () => {
    simulateNode();
    expect(checkSupport().transport).toBe('none');
  });
});

// ─── Decoder rollup ──────────────────────────────────────────────────

describe('checkSupport — decoder rollup', () => {
  it('selects webcodecs when VideoDecoder is available', () => {
    simulateNode();
    setGlobal('VideoDecoder', class {});
    setGlobal('MediaSource', class {});
    expect(checkSupport().decoder).toBe('webcodecs');
  });

  it('falls back to mse when VideoDecoder is absent', () => {
    simulateNode();
    setGlobal('MediaSource', class {});
    expect(checkSupport().decoder).toBe('mse');
  });

  it('returns none when neither decoder is available', () => {
    simulateNode();
    expect(checkSupport().decoder).toBe('none');
  });
});

// ─── supported + reason ──────────────────────────────────────────────

describe('checkSupport — supported + reason', () => {
  it('returns supported=true when transport and decoder exist', () => {
    simulateNode();
    setGlobal('WebSocket', class {});
    setGlobal('MediaSource', class {});
    const report = checkSupport();
    expect(report.supported).toBe(true);
    expect(report.reason).toBeUndefined();
  });

  it('returns supported=false with reason when no transport', () => {
    simulateNode();
    setGlobal('VideoDecoder', class {});
    const report = checkSupport();
    expect(report.supported).toBe(false);
    expect(report.reason).toContain('WebTransport');
    expect(report.reason).toContain('WebSocket');
  });

  it('returns supported=false with reason when no decoder', () => {
    simulateNode();
    setGlobal('WebSocket', class {});
    const report = checkSupport();
    expect(report.supported).toBe(false);
    expect(report.reason).toContain('WebCodecs');
    expect(report.reason).toContain('MediaSource');
  });
});

// ─── Environment simulations ─────────────────────────────────────────

describe('checkSupport — environment simulations', () => {
  it('full Chrome environment', () => {
    simulateChrome();
    const report = checkSupport();
    expect(report.supported).toBe(true);
    expect(report.transport).toBe('webtransport');
    expect(report.decoder).toBe('webcodecs');
    expect(report.webTransport).toBe(true);
    expect(report.videoDecoder).toBe(true);
    expect(report.audioDecoder).toBe(true);
    expect(report.canvas).toBe(true);
    expect(report.offscreenCanvas).toBe(true);
    expect(report.audioContext).toBe(true);
    expect(report.isSecureContext).toBe(true);
  });

  it('bare Node.js environment', () => {
    simulateNode();
    const report = checkSupport();
    expect(report.supported).toBe(false);
    expect(report.transport).toBe('none');
    expect(report.decoder).toBe('none');
    expect(report.webTransport).toBe(false);
    expect(report.webSocket).toBe(false);
    expect(report.videoDecoder).toBe(false);
    expect(report.audioDecoder).toBe(false);
    expect(report.mediaSource).toBe(false);
    expect(report.canvas).toBe(false);
    expect(report.offscreenCanvas).toBe(false);
    expect(report.audioContext).toBe(false);
  });
});

// ─── MoqtPlayer static methods ──────────────────────────────────────

describe('MoqtPlayer static methods', () => {
  // Dynamic import to avoid circular issues — the static methods just
  // delegate to checkSupport(), so we verify the wiring here.
  it('isSupported() returns boolean', async () => {
    simulateNode();
    const { MoqtPlayer } = await import('./player.js');
    expect(MoqtPlayer.isSupported()).toBe(false);
  });

  it('checkSupport() returns SupportReport', async () => {
    simulateNode();
    const { MoqtPlayer } = await import('./player.js');
    const report = MoqtPlayer.checkSupport();
    expect(report).toHaveProperty('supported');
    expect(report).toHaveProperty('transport');
    expect(report).toHaveProperty('decoder');
    expect(report.supported).toBe(false);
  });
});
