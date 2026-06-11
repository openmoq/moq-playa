/**
 * Deterministic WebTransport stream simulator (test harness).
 *
 * No timers, no races: byte delivery is driven explicitly by the test via
 * `push()` / `closeReadable()` / `reset()`. Reads resolve on the microtask queue
 * (ReadableStream semantics), so ordering is fully determined by the order of
 * test operations + `await flush()`.
 *
 * This is the shared harness for draft-18 topology tests (control + request
 * streams) and, later, data-plane interleaving. It is excluded from the build
 * (see tsconfig `exclude`).
 *
 * @module
 */

import type { WebTransportLike, WebTransportBidirectionalStream } from '../types.js';

/** Flush pending microtasks `n` times so awaited stream operations settle. */
export async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** A single simulated stream: a controllable readable + a recording writable. */
export class SimStream implements WebTransportBidirectionalStream {
  /** Chunks written to the writable side, in order. */
  readonly written: Uint8Array[] = [];
  /** Whether the writable side was closed (FIN) / aborted (reset). */
  writeClosed = false;
  /** When true, the writable rejects writes (simulates a broken send side). */
  failWrites = false;
  writeAborted = false;
  /** Whether the readable side was cancelled (the consumer sent STOP_SENDING). */
  readCancelled = false;

  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  private ctrl!: ReadableStreamDefaultController<Uint8Array>;
  private readClosed = false;

  constructor() {
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.ctrl = c;
      },
      cancel: () => {
        this.readCancelled = true;
        this.readClosed = true;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.failWrites) throw new Error('simulated write failure');
        this.written.push(chunk.slice());
      },
      close: () => {
        this.writeClosed = true;
      },
      abort: () => {
        this.writeAborted = true;
      },
    });
  }

  /** Deliver bytes to the readable side (buffered until read). */
  push(bytes: Uint8Array): this {
    this.ctrl.enqueue(bytes);
    return this;
  }

  /** FIN the readable side. */
  closeReadable(): this {
    if (!this.readClosed) {
      this.readClosed = true;
      this.ctrl.close();
    }
    return this;
  }

  /** RESET the readable side with an error. */
  resetReadable(reason = 'reset'): this {
    if (!this.readClosed) {
      this.readClosed = true;
      this.ctrl.error(new Error(reason));
    }
    return this;
  }

  /** Concatenate all written chunks (for assertions). */
  writtenBytes(): Uint8Array {
    const total = this.written.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of this.written) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}

/**
 * A simulated WebTransport. Bidi/uni streams opened by the code under test are
 * recorded in `bidi` / `uniOut`; inbound uni streams (peer control / data) are
 * injected by the test via `pushIncomingUni`.
 */
export class TransportSim implements WebTransportLike {
  readonly bidi: SimStream[] = [];
  readonly uniOut: SimStream[] = [];

  /** Recorded session close (set when the code under test calls close()). */
  closeInfo: { closeCode?: number; reason?: string } | undefined;
  private closedResolve!: (info: { closeCode?: number; reason?: string }) => void;
  readonly closed: Promise<{ closeCode?: number; reason?: string }> = new Promise((res) => {
    this.closedResolve = res;
  });

  /** WebTransport session close — records the close info for assertions. */
  close(info?: { closeCode?: number; reason?: string }): void {
    if (this.closeInfo) return;
    this.closeInfo = info ?? {};
    this.closedResolve(this.closeInfo);
  }

  private incomingCtrl!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;

  private incomingBidiCtrl!: ReadableStreamDefaultController<SimStream>;
  readonly incomingBidirectionalStreams: ReadableStream<SimStream>;

  private datagramCtrl!: ReadableStreamDefaultController<Uint8Array>;
  readonly datagrams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  /** Datagrams written by the code under test (the publisher send path). */
  readonly sentDatagrams: Uint8Array[] = [];

  constructor() {
    this.incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
      start: (c) => {
        this.incomingCtrl = c;
      },
    });
    this.incomingBidirectionalStreams = new ReadableStream<SimStream>({
      start: (c) => {
        this.incomingBidiCtrl = c;
      },
    });
    this.datagrams = {
      readable: new ReadableStream<Uint8Array>({
        start: (c) => {
          this.datagramCtrl = c;
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => { this.sentDatagrams.push(chunk.slice()); },
      }),
    };
  }

  /**
   * Inject a peer-initiated bidi stream the test controls: `push()` to its
   * readable to deliver inbound bytes, inspect `written` for our response.
   */
  pushIncomingBidi(): SimStream {
    const s = new SimStream();
    this.incomingBidiCtrl.enqueue(s);
    return s;
  }

  /** Inject an inbound datagram. */
  pushDatagram(bytes: Uint8Array): this {
    this.datagramCtrl.enqueue(bytes);
    return this;
  }

  /** Error the TOP-LEVEL incoming-uni accept stream (kills the accept loop),
   *  simulating a transport-layer failure like Safari's WT "network error". */
  errorIncomingUni(reason = 'simulated transport failure'): this {
    this.incomingCtrl.error(new Error(reason));
    return this;
  }

  /** Error the TOP-LEVEL incoming-bidi accept stream (kills the bidi accept loop). */
  errorIncomingBidi(reason = 'simulated transport failure'): this {
    this.incomingBidiCtrl.error(new Error(reason));
    return this;
  }

  /** Close the datagram readable (ends the datagram loop). */
  closeDatagrams(): this {
    this.datagramCtrl.close();
    return this;
  }

  async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    const s = new SimStream();
    this.bidi.push(s);
    return s;
  }

  async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
    const s = new SimStream();
    this.uniOut.push(s);
    return s.writable;
  }

  /** Inject an inbound unidirectional stream pre-loaded with `bytes` (then FIN). */
  pushIncomingUni(bytes: Uint8Array): SimStream {
    const s = new SimStream();
    s.push(bytes).closeReadable();
    this.incomingCtrl.enqueue(s.readable);
    return s;
  }

  /** Inject an inbound unidirectional stream the test controls (no auto-close). */
  openIncomingUni(): SimStream {
    const s = new SimStream();
    this.incomingCtrl.enqueue(s.readable);
    return s;
  }
}
