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
  it('does not construct a transport after startup is cancelled', async () => {
    const construct = vi.fn();
    vi.stubGlobal('WebTransport', class { ready = Promise.resolve(); constructor() { construct(); } });
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);
    await expect(createWebTransport({ signal: controller.signal })('https://r/moq')).rejects.toBe(reason);
    expect(construct).not.toHaveBeenCalled();
  });

  it('closes a connecting transport on cancellation without retrying', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn();
    const construct = vi.fn();
    vi.stubGlobal('WebTransport', class { ready = ready; close = close; constructor() { construct(); } });
    const controller = new AbortController();
    const reason = new Error('stopped');
    const pending = createWebTransport({ signal: controller.signal })('https://r/moq');
    void pending.catch(() => {});
    try {
      controller.abort(reason);
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      await expect(pending).rejects.toBe(reason);
      expect(construct).toHaveBeenCalledTimes(1);
    } finally { release(); }
  });

  it('removes its startup listener and does not close an established transport on late abort', async () => {
    const close = vi.fn();
    vi.stubGlobal('WebTransport', class { ready = Promise.resolve(); close = close; });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await createWebTransport({ signal: controller.signal })('https://r/moq');
    controller.abort();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
  it('proves a reset when abort rejects the pending FIN with its own reason (§7.4)', async () => {
    let rejectFin!: (reason: unknown) => void;
    let completeReset!: () => void;
    const resetCompletion = new Promise<void>((resolve) => { completeReset = resolve; });
    let reset = false;
    const stream = new WritableStream<Uint8Array>({
      start(controller) {
        controller.signal.addEventListener('abort', () => {
          // WebTransport rejects PendingOperation only AFTER resetting the stream.
          void resetCompletion.then(() => {
            reset = true;
            rejectFin(controller.signal.reason);
          });
        });
      },
      close: () => new Promise<void>((_, reject) => { rejectFin = reject; }),
    });
    vi.stubGlobal('WebTransport', class {
      ready = Promise.resolve();
      createUnidirectionalStream = async () => stream;
    });
    const transport = await createWebTransport()('https://r/moq');
    const writer = (await transport.createUnidirectionalStream!()).getWriter();
    const fin = writer.close();
    const reason = new Error('subscription cancelled');
    const finOutcome = fin.catch((error) => error);
    await Promise.resolve();
    let settled = false;
    const resetting = transport.resetSendStream!(writer, reason, fin).then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    expect(reset).toBe(false);
    completeReset();
    await expect(resetting).resolves.toBeUndefined();
    expect(reset).toBe(true);
    expect(await finOutcome).toBe(reason);
  });

  it.each(['different reason', 'no pending FIN', 'fulfilled FIN', 'different FIN reason'])('does not normalize an abort rejection with %s', async (mode) => {
    const reason = new Error('subscription cancelled');
    const error = mode === 'different reason' ? new Error('network failure') : reason;
    vi.stubGlobal('WebTransport', class { ready = Promise.resolve(); });
    const transport = await createWebTransport()('https://r/moq');
    const writer = { abort: vi.fn().mockRejectedValue(error) } as unknown as WritableStreamDefaultWriter<Uint8Array>;
    const fin = mode === 'no pending FIN' ? undefined
      : mode === 'fulfilled FIN' ? Promise.resolve()
      : Promise.reject(mode === 'different FIN reason' ? new Error('FIN failed') : reason);
    fin?.catch(() => {});
    await expect(transport.resetSendStream!(writer, reason, fin)).rejects.toBe(error);
    expect(writer.abort).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it('accepts a normally fulfilled abort without a pending FIN', async () => {
    vi.stubGlobal('WebTransport', class { ready = Promise.resolve(); });
    const transport = await createWebTransport()('https://r/moq');
    const writer = new WritableStream<Uint8Array>().getWriter();
    await expect(transport.resetSendStream!(writer, new Error('cancelled'))).resolves.toBeUndefined();
  });

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
  it('does not retry draft 22 without its protocol offer', async () => {
    stubWebTransport({ rejectWithProtocols: true });
    await expect(createWebTransport({ draftVersion: 22 })('https://r:4433')).rejects.toThrow();
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.options.protocols).toEqual(['moqt-22']);
  });

  it('accepts a negotiated draft-22 session', async () => {
    stubWebTransport({});
    expect((await createWebTransport({ draftVersion: 22 })('https://r:4433')).protocol).toBe('moqt-22');
    expect(constructed).toHaveLength(1);
  });

  it.each([undefined, '', 'moqt-18'])('closes a ready transport that selected %s instead of moqt-22', async (protocol) => {
    const close = vi.fn();
    vi.stubGlobal('WebTransport', class {
      ready = Promise.resolve();
      closed = Promise.resolve();
      protocol = protocol;
      close = close;
    });
    await expect(createWebTransport({ draftVersion: 22 })('https://r:4433')).rejects.toThrow(/moqt-22/);
    expect(close).toHaveBeenCalledTimes(1);
  });
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
