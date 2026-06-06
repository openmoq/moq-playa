/**
 * Deterministic in-memory WebTransport loopback (test harness).
 *
 * Wires two {@link WebTransportLike} endpoints together so two real
 * `MoqtConnection` instances (one CLIENT, one SERVER) can run a full draft-18
 * exchange in-process: the uni SETUP pair, per-request bidi streams,
 * same-stream responses, and uni data streams + datagrams all cross over.
 *
 * No timers, no races: bytes are delivered on the microtask queue (WHATWG
 * ReadableStream semantics), so ordering is determined entirely by the test's
 * operations plus `await flush()` (re-exported from `stream-sim`).
 *
 * @module
 */

import type {
  WebTransportLike,
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
} from '../types.js';

export { flush } from './stream-sim.js';

/**
 * Deterministic, opt-in transport faults for a {@link LoopPipe}. All default to
 * off, so a pipe with no faults set behaves exactly as before (single full-chunk
 * enqueue). Faults are deterministic functions of the bytes written — no timers,
 * no randomness — so a seeded scenario reproduces byte-for-byte.
 */
export interface PipeFaults {
  /**
   * Split every write into ≤`chunkSize`-byte deliveries (e.g. 1 = one byte per
   * read). Exercises the framer/decoder partial-read paths. Semantically
   * transparent: all bytes still arrive, in order.
   */
  chunkSize?: number;
  /**
   * After this many bytes have been delivered, drop the rest and RESET the
   * readable (error it with a numeric `streamErrorCode`, like a real
   * RESET_STREAM). Models a peer resetting a stream mid-write.
   */
  resetAfterBytes?: number;
  /** Application error code carried by a {@link resetAfterBytes} reset (default 0). */
  resetCode?: number;
  /**
   * After this many bytes have been delivered, drop the rest and cleanly FIN the
   * readable (truncated stream end). Models a peer ending a stream mid-frame.
   */
  finAfterBytes?: number;
}

/** Error shape mirroring a WebTransport RESET_STREAM (the adapter reads `streamErrorCode`). */
class StreamResetError extends Error {
  constructor(readonly streamErrorCode: number) {
    super(`simulated RESET_STREAM (code ${streamErrorCode})`);
    this.name = 'StreamResetError';
  }
}

/**
 * A one-directional byte channel: writes to `writable` are recorded and
 * enqueued to `readable`. Mirrors a single QUIC stream direction.
 *
 * Optional {@link PipeFaults} (off by default) inject deterministic transport
 * chaos — write-splitting, mid-stream RESET, truncating FIN — for fault-injection
 * tests. The fault fields are mutable so a test can ARM a fault on an existing
 * pipe (e.g. a request stream the adapter opened) right before the peer writes.
 */
export class LoopPipe {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly written: Uint8Array[] = [];
  writeClosed = false;
  writeAborted = false;
  readCancelled = false;

  /** Deterministic fault config (all fields off by default). Mutable: arm late. */
  readonly faults: PipeFaults;
  /** Bytes delivered to the readable so far (drives resetAfterBytes/finAfterBytes). */
  private delivered = 0;
  private faultFired = false;

  private ctrl!: ReadableStreamDefaultController<Uint8Array>;
  private readClosed = false;

  constructor(faults: PipeFaults = {}) {
    this.faults = faults;
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => { this.ctrl = c; },
      cancel: () => { this.readCancelled = true; this.readClosed = true; },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.written.push(chunk.slice());
        if (!this.readClosed) this.deliver(chunk);
      },
      close: () => {
        this.writeClosed = true;
        if (!this.readClosed) { this.readClosed = true; this.ctrl.close(); }
      },
      abort: () => {
        this.writeAborted = true;
        if (!this.readClosed) {
          this.readClosed = true;
          try { this.ctrl.error(new Error('reset')); } catch { /* already closed */ }
        }
      },
    });
  }

  /** Enqueue a write to the readable, honoring any armed faults. */
  private deliver(chunk: Uint8Array): void {
    // How many more bytes may be delivered before a byte-count fault trips.
    const limit = this.faults.resetAfterBytes ?? this.faults.finAfterBytes;
    let data = chunk;
    if (limit !== undefined) {
      const room = Math.max(0, limit - this.delivered);
      if (data.length > room) data = data.subarray(0, room);
    }

    const chunkSize = this.faults.chunkSize;
    if (chunkSize && chunkSize > 0) {
      for (let i = 0; i < data.length; i += chunkSize) {
        this.ctrl.enqueue(data.subarray(i, i + chunkSize).slice());
      }
    } else if (data.length > 0) {
      this.ctrl.enqueue(data.slice());
    }
    this.delivered += data.length;

    if (limit !== undefined && this.delivered >= limit && !this.faultFired) {
      this.faultFired = true;
      this.readClosed = true;
      if (this.faults.resetAfterBytes !== undefined) {
        try { this.ctrl.error(new StreamResetError(this.faults.resetCode ?? 0)); } catch { /* closed */ }
      } else {
        try { this.ctrl.close(); } catch { /* closed */ } // truncating FIN
      }
    }
  }

  /**
   * Immediately RESET the readable (a peer RESET_STREAM with `code`), independent
   * of any byte-count trigger. Models a stream reset that happens with no write
   * pending — e.g. after a response was already consumed. Idempotent.
   */
  reset(code = 0): void {
    if (this.readClosed) return;
    this.readClosed = true;
    this.faultFired = true;
    try { this.ctrl.error(new StreamResetError(code)); } catch { /* already closed */ }
  }

  /** Concatenate all written chunks (for assertions). */
  writtenBytes(): Uint8Array {
    const total = this.written.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of this.written) { out.set(c, p); p += c.length; }
    return out;
  }
}

/** One endpoint of a loopback pair. Streams it opens surface on the peer. */
export class LoopbackTransport implements WebTransportLike {
  /** No negotiated protocol — callers pass the draft version explicitly. */
  readonly protocol: string | undefined = undefined;

  /** Outbound uni streams WE opened (uniOut[0] is our control stream). */
  readonly uniOut: LoopPipe[] = [];
  /** Outbound bidi streams WE opened; `out` records what we wrote. */
  readonly bidiOut: Array<{ view: WebTransportBidirectionalStream; out: LoopPipe; in: LoopPipe }> = [];

  closeInfo: WebTransportCloseInfo | undefined;
  private closedResolve!: (info: WebTransportCloseInfo) => void;
  readonly closed: Promise<WebTransportCloseInfo> = new Promise((res) => { this.closedResolve = res; });

  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  readonly datagrams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

  private incomingUniCtrl!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  private incomingBidiCtrl!: ReadableStreamDefaultController<WebTransportBidirectionalStream>;
  private datagramInCtrl!: ReadableStreamDefaultController<Uint8Array>;

  /** Set by {@link createLoopback}. The peer receives our opened streams. */
  peer!: LoopbackTransport;

  /** Default fault config stamped onto every stream pipe this transport opens. */
  private readonly streamFaults: PipeFaults;

  constructor(streamFaults: PipeFaults = {}) {
    this.streamFaults = streamFaults;
    this.incomingUnidirectionalStreams = new ReadableStream<ReadableStream<Uint8Array>>({
      start: (c) => { this.incomingUniCtrl = c; },
    });
    this.incomingBidirectionalStreams = new ReadableStream<WebTransportBidirectionalStream>({
      start: (c) => { this.incomingBidiCtrl = c; },
    });
    this.datagrams = {
      readable: new ReadableStream<Uint8Array>({ start: (c) => { this.datagramInCtrl = c; } }),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => { this.peer.datagramInCtrl.enqueue(chunk.slice()); },
      }),
    };
  }

  async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
    const pipe = new LoopPipe({ ...this.streamFaults });
    this.uniOut.push(pipe);
    this.peer.incomingUniCtrl.enqueue(pipe.readable); // peer reads what we write
    return pipe.writable;
  }

  async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    const out = new LoopPipe({ ...this.streamFaults }); // we write → peer reads
    const inn = new LoopPipe({ ...this.streamFaults }); // peer writes → we read
    const ourView: WebTransportBidirectionalStream = { writable: out.writable, readable: inn.readable };
    const peerView: WebTransportBidirectionalStream = { writable: inn.writable, readable: out.readable };
    this.bidiOut.push({ view: ourView, out, in: inn });
    this.peer.incomingBidiCtrl.enqueue(peerView);
    return ourView;
  }

  close(info?: WebTransportCloseInfo): void {
    if (this.closeInfo) return;
    this.closeInfo = info ?? {};
    this.closedResolve(this.closeInfo);
  }
}

/**
 * Create a wired loopback pair: streams `a` opens surface on `b`, and vice versa.
 *
 * `faults` (default none) stamps a default {@link PipeFaults} onto every stream
 * pipe both transports open — used for the transport chunk-splitting fault. To
 * arm a one-off fault (mid-stream RESET / truncating FIN) on a specific stream,
 * mutate that pipe's `faults` after it is opened (e.g. `a.bidiOut[0]!.in.faults`).
 */
export function createLoopback(
  faults: { a?: PipeFaults; b?: PipeFaults } = {},
): { a: LoopbackTransport; b: LoopbackTransport } {
  const a = new LoopbackTransport(faults.a ?? {});
  const b = new LoopbackTransport(faults.b ?? {});
  a.peer = b;
  b.peer = a;
  return { a, b };
}
