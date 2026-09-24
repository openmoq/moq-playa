import type {
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
  WebTransportLike,
} from '@moqt/webtransport';
import type { NativeQuicSession, NativeQuicStream } from './native.js';

const DEFAULT_QUEUE_LIMIT = 256;
const DRAINABLE_PROTOCOL = Symbol.for('Stream.drainableProtocol');
const STREAM_INTERNAL_ERROR = 0n;
const SESSION_INTERNAL_ERROR = 1n;
const STREAM_RESET_CODES = new Set([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 9n, 0x12n]);
const SESSION_ERROR_CODES = new Set([
  0n, 1n, 2n, 3n, 4n, 5n, 6n, 8n, 9n,
  0x10n, 0x11n, 0x12n, 0x13n, 0x14n, 0x15n, 0x16n, 0x17n, 0x18n, 0x19n, 0x1an,
]);

interface MoqtSetupRouting {
  readonly authority: string;
  readonly path: string;
}

/** Native QUIC transport plus the routing fields required in MOQT SETUP. */
export interface MoqtQuicTransport extends WebTransportLike {
  readonly kind: 'quic';
  readonly protocol: 'moqt-18';
  readonly maxDatagramSize: number;
  readonly setupOptions: MoqtSetupRouting;
}

/** A small bounded bridge from synchronous Node callbacks to WHATWG streams. */
export class BoundedReadableQueue<T> {
  readonly readable: ReadableStream<T>;
  private readonly pending: T[] = [];
  private controller: ReadableStreamDefaultController<T> | null = null;
  private pullWaiting = false;
  private terminal = false;

  constructor(
    private readonly limit = DEFAULT_QUEUE_LIMIT,
    private readonly onCancel?: (reason: unknown) => void | Promise<void>,
    private readonly onDiscard?: (value: T, reason: unknown) => void | Promise<void>,
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('queue limit must be a positive safe integer');
    }
    this.readable = new ReadableStream<T>({
      start: (controller) => { this.controller = controller; },
      pull: (controller) => {
        if (this.pending.length > 0) {
          controller.enqueue(this.pending.shift()!);
        } else {
          this.pullWaiting = true;
        }
      },
      cancel: async (reason) => {
        this.terminal = true;
        this.pullWaiting = false;
        await this.discardPending(reason);
        await this.onCancel?.(reason);
      },
    }, { highWaterMark: 0 });
  }

  push(value: T): boolean {
    if (this.terminal) return false;
    if (this.pending.length >= this.limit) return false;
    if (this.pullWaiting && this.controller) {
      this.pullWaiting = false;
      this.controller.enqueue(value);
      return true;
    }
    this.pending.push(value);
    return true;
  }

  close(discardReason: unknown = new Error('queue closed')): void {
    if (this.terminal) return;
    this.terminal = true;
    this.pullWaiting = false;
    void this.discardPending(discardReason);
    this.controller?.close();
  }

  error(reason: unknown, discardReason: unknown = reason): void {
    if (this.terminal) return;
    this.terminal = true;
    this.pullWaiting = false;
    void this.discardPending(discardReason);
    this.controller?.error(reason);
  }

  private async discardPending(reason: unknown): Promise<void> {
    const pending = this.pending.splice(0);
    if (!this.onDiscard) return;
    await Promise.allSettled(pending.map((value) => this.onDiscard!(value, reason)));
  }
}

/** Web-Streams facade over one Node QUIC session. */
export class NodeQuicTransport implements MoqtQuicTransport {
  readonly kind = 'quic' as const;
  readonly protocol = 'moqt-18' as const;
  readonly maxDatagramSize: number;
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
  };
  readonly closed: Promise<WebTransportCloseInfo>;
  private localCloseInfo: WebTransportCloseInfo | null = null;
  private closeStarted = false;

  constructor(
    private readonly session: NativeQuicSession,
    readonly setupOptions: MoqtSetupRouting,
    private readonly incomingUni: BoundedReadableQueue<ReadableStream<Uint8Array>>,
    private readonly incomingBidi: BoundedReadableQueue<WebTransportBidirectionalStream>,
    private readonly incomingDatagrams: BoundedReadableQueue<Uint8Array>,
    sessionError: () => unknown,
  ) {
    this.maxDatagramSize = session.maxDatagramSize;
    this.incomingUnidirectionalStreams = incomingUni.readable;
    this.incomingBidirectionalStreams = incomingBidi.readable;
    let datagramController!: WritableStreamDefaultController;
    const datagramWritable = new WritableStream<Uint8Array>({
      start: (controller) => { datagramController = controller; },
      write: async (data) => {
        if (data.byteLength === 0 || data.byteLength > this.maxDatagramSize) {
          throw new RangeError(`QUIC datagram length ${data.byteLength} exceeds negotiated limit ${this.maxDatagramSize}`);
        }
        const id = await session.sendDatagram(data);
        if (id === 0n) throw new Error('native QUIC backend refused the datagram');
      },
    });
    this.datagrams = {
      readable: incomingDatagrams.readable,
      writable: datagramWritable,
    };

    void session.closed.then(
      () => datagramController.error(new Error('native QUIC session closed')),
      (error) => datagramController.error(asError(error, 'native QUIC session failed')),
    );

    this.closed = session.closed.then<WebTransportCloseInfo, WebTransportCloseInfo>(
      () => this.localCloseInfo ?? { closeCode: 0, reason: '' },
      (error: unknown) => {
        const failure = sessionError() ?? error;
        const application = applicationCloseInfo(failure);
        if (application) return application;
        throw failure;
      },
    );
    // Consumers still observe rejection through `closed`; this attached
    // branch only prevents a race with an error close before they attach.
    void this.closed.catch(() => {});
    void session.closed.then(
      () => this.closeIncoming(),
      (error) => this.errorIncoming(sessionError() ?? error),
    );
  }

  async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
    const stream = await this.session.createBidirectionalStream();
    if (stream.direction !== 'bidi') {
      stream.resetStream(1n);
      throw new Error('native QUIC backend returned a non-bidirectional stream');
    }
    return wrapBidirectional(stream);
  }

  async createUnidirectionalStream(): Promise<WritableStream<Uint8Array>> {
    const stream = await this.session.createUnidirectionalStream();
    if (stream.direction !== 'uni') {
      stream.resetStream(1n);
      throw new Error('native QUIC backend returned a non-unidirectional stream');
    }
    return wrapWritable(stream);
  }

  close(info: WebTransportCloseInfo = {}): void {
    if (this.closeStarted) return;
    this.closeStarted = true;
    const closeCode = info.closeCode ?? 0;
    const reason = info.reason ?? '';
    this.localCloseInfo = { closeCode, reason };
    this.session.destroy(undefined, { code: closeCode, type: 'application', reason });
  }

  private closeIncoming(): void {
    this.incomingUni.close(0x3n);
    this.incomingBidi.close(0x3n);
    this.incomingDatagrams.close();
  }

  private errorIncoming(error: unknown): void {
    this.incomingUni.error(error, 0x0n);
    this.incomingBidi.error(error, 0x0n);
    this.incomingDatagrams.error(error);
  }
}

export function routeNativeStream(
  stream: NativeQuicStream,
  incomingUni: BoundedReadableQueue<ReadableStream<Uint8Array>>,
  incomingBidi: BoundedReadableQueue<WebTransportBidirectionalStream>,
): boolean {
  if (stream.direction === 'uni') return incomingUni.push(wrapReadable(stream));
  if (stream.direction === 'bidi') return incomingBidi.push(wrapBidirectional(stream));
  return false;
}

function wrapBidirectional(stream: NativeQuicStream): WebTransportBidirectionalStream {
  return { readable: wrapReadable(stream), writable: wrapWritable(stream) };
}

function wrapReadable(stream: NativeQuicStream): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array[]> | null = null;
  const queued: Uint8Array[] = [];
  let resetError: unknown;
  stream.onreset = (error) => { resetError = error; };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (queued.length > 0) {
        controller.enqueue(queued.shift()!);
        return;
      }
      try {
        iterator ??= stream[Symbol.asyncIterator]();
        const { value, done } = await iterator.next();
        if (done) {
          if (resetError !== undefined) {
            controller.error(normalizeStreamError(resetError));
            return;
          }
          // Node can expose a reset-only incoming unidirectional stream as
          // iterator EOF while preserving the peer code on `closed`. Unlike a
          // bidirectional stream, a receive-only stream has no local send half
          // that could keep `closed` pending after a genuine peer FIN.
          if (stream.direction === 'uni') {
            try {
              await stream.closed;
            } catch (error) {
              controller.error(normalizeStreamError(resetError ?? error));
              return;
            }
          }
          controller.close();
          return;
        }
        for (const chunk of value) queued.push(chunk);
        if (queued.length > 0) controller.enqueue(queued.shift()!);
      } catch (error) {
        controller.error(normalizeStreamError(resetError ?? error));
      }
    },
    async cancel(reason) {
      try {
        stream.stopSending(applicationCode(reason));
      } finally {
        await iterator?.return?.();
      }
    },
  });
}

function wrapWritable(stream: NativeQuicStream): WritableStream<Uint8Array> {
  let stopError: unknown;
  let locallyTerminal = false;
  let controller!: WritableStreamDefaultController;
  const writable = new WritableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async write(chunk) {
      try {
        await writeWithBackpressure(stream.writer, chunk, controller.signal);
      } catch (error) {
        throw normalizeWriteError(stopError ?? error);
      }
    },
    async close() {
      locallyTerminal = true;
      try {
        await stream.writer.end();
      } catch (error) {
        throw normalizeWriteError(stopError ?? error);
      }
    },
    abort(reason) {
      locallyTerminal = true;
      stream.resetStream(applicationCode(reason));
    },
  });
  stream.onstopsending = (error) => {
    locallyTerminal = true;
    const normalized = normalizeWriteError(error);
    stopError = normalized;
    controller.error(normalized);
    try { stream.resetStream(applicationCode(normalized)); } catch { /* already closed */ }
  };
  void stream.closed.then(
    () => {
      if (!locallyTerminal) controller.error(new Error('native QUIC stream closed'));
    },
    (error) => {
      if (!locallyTerminal) controller.error(normalizeWriteError(stopError ?? error));
    },
  );
  return writable;
}

/** Wait for Node's native writer budget instead of treating flow control as failure. */
async function writeWithBackpressure(
  writer: NativeQuicStream['writer'],
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  // Node 26.8.1 throws from write() when the native buffer is full. Its
  // stream/iter writer exposes the corresponding drain promise on this symbol.
  while (writer.canWrite === false) {
    const drain = (writer as unknown as Record<symbol, unknown>)[DRAINABLE_PROTOCOL];
    if (typeof drain !== 'function') {
      throw new Error('native QUIC writer is flow-controlled but exposes no drain protocol');
    }
    const pending = drain.call(writer) as Promise<unknown> | null;
    if (pending) {
      await raceAbort(pending, signal);
    } else if (writer.canWrite === null) {
      throw new Error('native QUIC writer closed while waiting for flow control');
    }
  }
  await raceAbort(writer.write(chunk), signal);
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function applicationCode(reason: unknown): bigint {
  return extractApplicationCode(reason) ?? 0n;
}

function extractApplicationCode(reason: unknown): bigint | undefined {
  if (typeof reason === 'bigint' && reason >= 0n) return reason;
  if (typeof reason === 'number' && Number.isSafeInteger(reason) && reason >= 0) return BigInt(reason);
  if (reason && typeof reason === 'object') {
    const object = reason as { streamErrorCode?: unknown; errorCode?: unknown };
    return extractApplicationCode(object.streamErrorCode ?? object.errorCode);
  }
  return undefined;
}

function normalizeStreamError(error: unknown): unknown {
  const code = extractQuicApplicationCode(error);
  if (code !== undefined) {
    // draft-18 §14: unknown error codes are handled as INTERNAL_ERROR in
    // their context. Preserve the native bigint separately for diagnostics.
    const mapped = STREAM_RESET_CODES.has(code) ? code : STREAM_INTERNAL_ERROR;
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      Object.defineProperties(normalized, {
        streamErrorCode: { value: Number(mapped), configurable: true },
        quicErrorCode: { value: code, configurable: true },
      });
      return normalized;
    } catch {
      const copy = new Error(normalized.message, { cause: normalized });
      copy.name = normalized.name;
      Object.defineProperties(copy, {
        streamErrorCode: { value: Number(mapped), configurable: true },
        quicErrorCode: { value: code, configurable: true },
      });
      return copy;
    }
  }
  return error;
}

function extractQuicApplicationCode(error: unknown): bigint | undefined {
  if (typeof error === 'bigint' || typeof error === 'number') {
    return extractApplicationCode(error);
  }
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    type?: unknown;
    streamErrorCode?: unknown;
    quicErrorCode?: unknown;
    errorCode?: unknown;
  };
  if (candidate.quicErrorCode !== undefined) {
    return extractApplicationCode(candidate.quicErrorCode);
  }
  if (candidate.streamErrorCode !== undefined) {
    return extractApplicationCode(candidate.streamErrorCode);
  }
  if (candidate.type === 'application') {
    return extractApplicationCode(candidate.errorCode);
  }
  return undefined;
}

function normalizeWriteError(error: unknown): unknown {
  const normalized = normalizeStreamError(error);
  return normalized instanceof Error ? normalized : new Error(String(normalized));
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(error === undefined ? fallback : String(error));
}

function applicationCloseInfo(error: unknown): WebTransportCloseInfo | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    type?: unknown;
    errorCode?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  if (candidate.type !== 'application') return null;
  const code = extractApplicationCode(candidate.errorCode);
  if (code === undefined) return null;
  const reason = typeof candidate.reason === 'string'
    ? candidate.reason
    : typeof candidate.message === 'string' ? candidate.message : '';
  if (!SESSION_ERROR_CODES.has(code)) {
    return {
      closeCode: Number(SESSION_INTERNAL_ERROR),
      reason: `unknown session error code ${code}; treated as INTERNAL_ERROR${reason ? `: ${reason}` : ''}`,
    };
  }
  return {
    closeCode: Number(code),
    reason,
  };
}
