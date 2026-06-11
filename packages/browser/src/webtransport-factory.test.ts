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

  it('draft-18: sends ["moqt-18"]', async () => {
    const factory = createWebTransport({ draftVersion: 18 });
    await factory('https://relay.example.com/moq');

    expect(capturedOptions.protocols).toEqual(['moqt-18']);
  });

  it('returned wrapper exposes incomingBidirectionalStreams when the transport has it', async () => {
    // draft-18 inbound request streams arrive as peer-initiated bidi streams; the
    // wrapper must surface the real transport's incomingBidirectionalStreams.
    const incoming = new ReadableStream();
    vi.stubGlobal('WebTransport', class {
      ready = Promise.resolve();
      protocol = '';
      incomingBidirectionalStreams = incoming;
      constructor(url: string, options?: any) { capturedUrl = url; capturedOptions = options; }
    });

    const factory = createWebTransport();
    const transport = await factory('https://relay.example.com/moq');

    expect(transport.incomingBidirectionalStreams).toBe(incoming);
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

// ─── Fallback: strict UAs that fail unnegotiated protocols ──────────
//
// Safari 26 fails the session when WT-Available-Protocols is offered but
// negotiation does not complete (per W3C spec; Chrome is lenient). MOQT
// does not require WT protocol negotiation — CLIENT_SETUP (§9.3) carries
// the version list in-band — so the factory retries once without
// offering before giving up.

describe('createWebTransport protocol fallback', () => {
  interface Constructed { options: any; closedCatches: number; }
  let constructed: Constructed[];

  const stubWebTransport = (mode: { rejectWithProtocols?: boolean; rejectAlways?: boolean }) => {
    constructed = [];
    vi.stubGlobal('WebTransport', class {
      ready: Promise<void>;
      closed: { catch: (fn: unknown) => Promise<void> };
      protocol?: string;
      constructor(_url: string, options: any = {}) {
        const rec: Constructed = { options, closedCatches: 0 };
        constructed.push(rec);
        const offered: string[] = options?.protocols ?? [];
        const reject = mode.rejectAlways === true
          || (mode.rejectWithProtocols === true && offered.length > 0);
        this.ready = reject
          ? Promise.reject(Object.assign(new Error('refused'), { source: 'session' }))
          : Promise.resolve();
        this.ready.catch(() => {}); // park local copy
        if (!reject && offered.length > 0) this.protocol = offered[0];
        this.closed = { catch: (_fn: unknown) => { rec.closedCatches++; return Promise.resolve(); } };
      }
    });
  };

  it('dials exactly once when the offering attempt succeeds (no double-dial)', async () => {
    stubWebTransport({}); // first attempt succeeds
    const transport = await createWebTransport({ draftVersion: 16 })('https://r:4433');

    // Guard: the retry helper must never become "always dial twice".
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.options.protocols).toEqual(['moqt-16']);
    expect(transport.protocol).toBe('moqt-16'); // negotiated value passes through
  });

  it('retries once without protocols when the offering attempt fails', async () => {
    stubWebTransport({ rejectWithProtocols: true });
    const transport = await createWebTransport({ draftVersion: 16 })('https://r:4433');

    expect(constructed).toHaveLength(2);
    expect(constructed[0]!.options.protocols).toEqual(['moqt-16']);
    expect(constructed[1]!.options.protocols).toBeUndefined();
    // No negotiated protocol on the fallback path — the adapter
    // negotiates in-band via CLIENT_SETUP.
    expect(transport.protocol).toBeUndefined();
  });

  it('preserves the cert hash on the fallback attempt', async () => {
    stubWebTransport({ rejectWithProtocols: true });
    const hash = new Uint8Array([0xAB]).buffer;
    await createWebTransport({ draftVersion: 16, certHash: hash })('https://r:4433');

    expect(constructed[1]!.options.serverCertificateHashes).toEqual([{
      algorithm: 'sha-256',
      value: hash,
    }]);
  });

  it('throws an error mentioning both attempts when the bare retry also fails', async () => {
    stubWebTransport({ rejectAlways: true });
    await expect(createWebTransport({ draftVersion: 16 })('https://r:4433'))
      .rejects.toThrow(/protocols=\[moqt-16\][\s\S]*retry without protocols/);
    expect(constructed).toHaveLength(2);
  });

  it('does not retry when no protocols were offered (draft-14 path)', async () => {
    stubWebTransport({ rejectAlways: true });
    await expect(createWebTransport({ draftVersion: 14 })('https://r:4433'))
      .rejects.toThrow(/WebTransport connection failed/);
    expect(constructed).toHaveLength(1);
  });

  it('parks closed on every constructed transport (no unhandled rejection spam)', async () => {
    stubWebTransport({ rejectWithProtocols: true });
    await createWebTransport({ draftVersion: 16 })('https://r:4433');
    for (const rec of constructed) {
      expect(rec.closedCatches).toBeGreaterThan(0);
    }
  });
});
