/**
 * Tests for WebTransport factory — protocol negotiation.
 *
 * Verifies that the factory correctly sets WT-Available-Protocols
 * for MOQT version negotiation per draft-ietf-moq-transport-16 §3.1.
 *
 * @see draft-ietf-moq-transport-16 §3.1 (WT-Available-Protocols)
 * @see W3C WebTransport §3.3 (protocols option)
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebTransport } from './webtransport-factory.js';

// ─── Mock WebTransport ──────────────────────────────────────────────

let capturedUrl: string | undefined;
let capturedOptions: any;

beforeEach(() => {
  capturedUrl = undefined;
  capturedOptions = undefined;
  vi.stubGlobal('WebTransport', class {
    ready = Promise.resolve();
    protocol = '';
    constructor(url: string, options?: any) {
      capturedUrl = url;
      capturedOptions = options;
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('createWebTransport', () => {
  it('auto-negotiate offers moqt-16 only (safe default)', async () => {
    const factory = createWebTransport();
    await factory('https://relay.example.com/moq');

    expect(capturedUrl).toBe('https://relay.example.com/moq');
    expect(capturedOptions.protocols).toEqual(['moqt-16']);
  });

  it('draft-14: no protocols sent (h3 ALPN fallback)', async () => {
    const factory = createWebTransport({ draftVersion: 14 });
    await factory('https://relay.example.com/moq');

    expect(capturedOptions.protocols).toBeUndefined();
  });

  it('draft-16: sends ["moqt-16"]', async () => {
    const factory = createWebTransport({ draftVersion: 16 });
    await factory('https://relay.example.com/moq');

    expect(capturedOptions.protocols).toEqual(['moqt-16']);
  });

  it('cert hash with draft-14: no protocols, hash present', async () => {
    const hash = new Uint8Array([0xAB, 0xCD]).buffer;
    const factory = createWebTransport({ certHash: hash, draftVersion: 14 });
    await factory('https://localhost:4443');

    expect(capturedOptions.serverCertificateHashes).toEqual([{
      algorithm: 'sha-256',
      value: hash,
    }]);
    expect(capturedOptions.protocols).toBeUndefined();
  });

  it('cert hash without draftVersion offers moqt-16', async () => {
    const hash = new Uint8Array([0x01, 0x02]).buffer;
    const factory = createWebTransport({ certHash: hash });
    await factory('https://localhost:4443');

    expect(capturedOptions.serverCertificateHashes).toBeDefined();
    expect(capturedOptions.protocols).toEqual(['moqt-16']);
  });

  it('returned transport has handshakeRttMs', async () => {
    const factory = createWebTransport();
    const transport = await factory('https://relay.example.com/moq');

    expect(transport.handshakeRttMs).toBeDefined();
    expect(typeof transport.handshakeRttMs).toBe('number');
    expect(transport.handshakeRttMs!).toBeGreaterThanOrEqual(0);
  });
});
