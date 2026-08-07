/**
 * Tests for the example-local discovery probe connector.
 *
 * The probe must accept exactly what a real example connection would accept:
 * same cert-hash pinning, same protocol offer, same strict-UA no-protocols
 * fallback (mirroring packages/browser/src/webtransport-factory.ts) — plus
 * cancellation, which the probe alone needs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeTransport } from './probe-transport.js';

// ─── Controllable WebTransport stub ─────────────────────────────────

interface StubInstance {
  url: string;
  options: any;
  closeCalls: number;
  resolveReady: () => void;
  rejectReady: (err?: unknown) => void;
  closedCatches: number;
}

let constructed: StubInstance[];
let autoResolve: boolean;
let rejectWithProtocols: boolean;
let rejectAlways: boolean;

function installStub(): void {
  constructed = [];
  vi.stubGlobal('WebTransport', class {
    ready: Promise<void>;
    closed: { catch: (fn: unknown) => Promise<void> };
    constructor(url: string, options: any = {}) {
      let resolveReady!: () => void;
      let rejectReady!: (err?: unknown) => void;
      this.ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
      const rec: StubInstance = {
        url, options, closeCalls: 0,
        resolveReady,
        rejectReady: (err?: unknown) =>
          rejectReady(err ?? Object.assign(new Error('refused'), { source: 'session' })),
        closedCatches: 0,
      };
      constructed.push(rec);
      this.closed = { catch: (_fn: unknown) => { rec.closedCatches++; return Promise.resolve(); } };
      const offered: string[] = options?.protocols ?? [];
      if (rejectAlways || (rejectWithProtocols && offered.length > 0)) {
        rec.rejectReady();
      } else if (autoResolve) {
        rec.resolveReady();
      }
      (this as any).close = () => {
        rec.closeCalls++;
        // Chrome: closing a CONNECTING transport rejects `ready`.
        rec.rejectReady(Object.assign(new Error('WebTransport closed'), { source: 'session' }));
      };
    }
  });
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  autoResolve = true;
  rejectWithProtocols = false;
  rejectAlways = false;
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  installStub();
});

afterEach(async () => {
  // Let any stray rejection surface before asserting.
  await new Promise((r) => setTimeout(r, 0));
  process.off('unhandledRejection', onUnhandled);
  vi.unstubAllGlobals();
  expect(unhandled).toEqual([]);
});

// ─── Option building (mirror of the shared factory) ─────────────────

describe('probeTransport option building', () => {
  it('forwards the cert hash as a sha-256 serverCertificateHashes entry', async () => {
    const hash = new Uint8Array([0xab, 0xcd]).buffer;
    await probeTransport('https://r:4433/moq', { certHash: hash });
    expect(constructed[0]!.options.serverCertificateHashes).toEqual([
      { algorithm: 'sha-256', value: hash },
    ]);
  });

  it('omits serverCertificateHashes entirely when no cert hash is given', async () => {
    await probeTransport('https://r:4433/moq');
    expect('serverCertificateHashes' in constructed[0]!.options).toBe(false);
  });

  it('offers moqt-18 for draft 18 and moqt-16 for draft 16', async () => {
    await probeTransport('https://r:4433/moq', { draftVersion: 18 });
    expect(constructed[0]!.options.protocols).toEqual(['moqt-18']);
    await probeTransport('https://r:4433/moq', { draftVersion: 16 });
    expect(constructed[1]!.options.protocols).toEqual(['moqt-16']);
  });

  it('offers moqt-16 when no draft version is specified (factory default)', async () => {
    await probeTransport('https://r:4433/moq');
    expect(constructed[0]!.options.protocols).toEqual(['moqt-16']);
  });

  it('offers no protocols for draft 14 (h3 ALPN fallback)', async () => {
    await probeTransport('https://r:4433/moq', { draftVersion: 14 });
    expect('protocols' in constructed[0]!.options).toBe(false);
  });

  it('parks the closed-promise rejection on every constructed transport', async () => {
    await probeTransport('https://r:4433/moq');
    expect(constructed[0]!.closedCatches).toBeGreaterThan(0);
  });
});

// ─── No-protocols fallback (strict-UA mirror) ───────────────────────

describe('probeTransport protocol fallback', () => {
  it('retries exactly once without protocols when the offered attempt fails', async () => {
    rejectWithProtocols = true;
    const session = await probeTransport('https://r:4433/moq', { draftVersion: 16 });
    expect(constructed).toHaveLength(2);
    expect(constructed[0]!.options.protocols).toEqual(['moqt-16']);
    expect('protocols' in constructed[1]!.options).toBe(false);
    session.close();
  });

  it('keeps the cert hash on the fallback attempt', async () => {
    rejectWithProtocols = true;
    const hash = new Uint8Array([0x01]).buffer;
    await probeTransport('https://r:4433/moq', { certHash: hash });
    expect(constructed[1]!.options.serverCertificateHashes).toEqual([
      { algorithm: 'sha-256', value: hash },
    ]);
  });

  it('rejects naming both failures when offered and fallback attempts both fail', async () => {
    rejectAlways = true;
    await expect(probeTransport('https://r:4433/moq')).rejects.toThrow(/retry without protocols also failed/);
    expect(constructed).toHaveLength(2);
  });

  it('does NOT retry when the first attempt offered no protocols (draft 14)', async () => {
    rejectAlways = true;
    await expect(probeTransport('https://r:4433/moq', { draftVersion: 14 })).rejects.toThrow();
    expect(constructed).toHaveLength(1);
  });

  it('dials exactly once when the offered attempt succeeds', async () => {
    await probeTransport('https://r:4433/moq');
    expect(constructed).toHaveLength(1);
  });
});

// ─── Cancellation ───────────────────────────────────────────────────

describe('probeTransport cancellation', () => {
  it('rejects before constructing anything when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    await expect(
      probeTransport('https://r:4433/moq', { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(constructed).toHaveLength(0);
  });

  it('closes the CONNECTING transport and rejects with the abort reason on mid-handshake abort', async () => {
    autoResolve = false;
    const controller = new AbortController();
    const reason = new Error('probe cancelled');
    const probe = probeTransport('https://r:4433/moq', { signal: controller.signal });
    const pending = expect(probe).rejects.toBe(reason);
    expect(constructed).toHaveLength(1);
    controller.abort(reason);
    await pending;
    expect(constructed[0]!.closeCalls).toBe(1);
  });

  it('suppresses the no-protocols fallback when the offered attempt is aborted (one construction only)', async () => {
    autoResolve = false;
    const controller = new AbortController();
    const reason = new Error('probe cancelled');
    const probe = probeTransport('https://r:4433/moq', { draftVersion: 16, signal: controller.signal });
    const pending = expect(probe).rejects.toBe(reason);
    controller.abort(reason);
    await pending;
    // The abort must not be misread as a protocol-negotiation failure.
    expect(constructed).toHaveLength(1);
  });

  it('closes the connecting fallback transport on abort during the retry attempt', async () => {
    rejectWithProtocols = true;
    autoResolve = false; // fallback attempt hangs
    const controller = new AbortController();
    const reason = new Error('probe cancelled');
    const probe = probeTransport('https://r:4433/moq', { signal: controller.signal });
    const pending = expect(probe).rejects.toBe(reason);
    // Let the first (offered) attempt fail and the fallback start.
    await vi.waitFor(() => expect(constructed).toHaveLength(2));
    controller.abort(reason);
    await pending;
    expect(constructed[1]!.closeCalls).toBe(1);
  });

  it('closes and rejects when abort lands after ready resolved but before return', async () => {
    autoResolve = false;
    const controller = new AbortController();
    const reason = new Error('probe cancelled');
    const probe = probeTransport('https://r:4433/moq', { signal: controller.signal });
    const pending = expect(probe).rejects.toBe(reason);
    // Abort and resolve in the same turn: abort wins, the session must not leak.
    controller.abort(reason);
    constructed[0]!.resolveReady();
    await pending;
    expect(constructed[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('probeTransport listener hygiene', () => {
  it('removes every abort listener it adds (balanced add/remove on success)', async () => {
    const controller = new AbortController();
    const adds = vi.spyOn(controller.signal, 'addEventListener');
    const removes = vi.spyOn(controller.signal, 'removeEventListener');
    await probeTransport('https://r:4433/moq', { signal: controller.signal });
    const abortAdds = adds.mock.calls.filter(([type]) => type === 'abort').length;
    const abortRemoves = removes.mock.calls.filter(([type]) => type === 'abort').length;
    expect(abortAdds).toBeGreaterThan(0);
    expect(abortRemoves).toBe(abortAdds);
  });

  it('stays balanced across the no-protocols retry', async () => {
    rejectWithProtocols = true;
    const controller = new AbortController();
    const adds = vi.spyOn(controller.signal, 'addEventListener');
    const removes = vi.spyOn(controller.signal, 'removeEventListener');
    await probeTransport('https://r:4433/moq', { signal: controller.signal });
    const abortAdds = adds.mock.calls.filter(([type]) => type === 'abort').length;
    const abortRemoves = removes.mock.calls.filter(([type]) => type === 'abort').length;
    expect(abortRemoves).toBe(abortAdds);
  });
});

// ─── Session surface ────────────────────────────────────────────────

describe('probeTransport session', () => {
  it('close() closes the underlying transport and swallows a throwing close', async () => {
    const session = await probeTransport('https://r:4433/moq');
    session.close();
    expect(constructed[0]!.closeCalls).toBe(1);
    // Second close (transport may throw on double-close) must not propagate.
    (globalThis as any).WebTransport; // stub keeps counting
    expect(() => session.close()).not.toThrow();
  });
});
