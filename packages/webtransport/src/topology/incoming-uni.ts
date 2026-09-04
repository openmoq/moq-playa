/**
 * Draft-18 incoming unidirectional stream classifier.
 *
 * SETUP, subgroup, FETCH, and PADDING streams share the QUIC unidirectional
 * stream space. Their arrival order is unconstrained, so no stream position may
 * be treated as the control stream. This router peeks the leading vi64 on every
 * stream concurrently, preserves the bytes it consumed, and holds data streams
 * until the owner confirms both sides of the SETUP exchange are complete.
 *
 * @see draft-ietf-moq-transport-18 §3.3, §3.4
 * @module
 */

import { createDataCodec, ProtocolViolationError } from '@moqt/transport';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface IncomingUniHandlers {
  /** Consume the peer's one control stream and resolve once SETUP is accepted. */
  onSetup(stream: ReadableStream<Uint8Array>): Promise<void>;
  /** Consume a subgroup, FETCH, or PADDING stream after releaseData(). */
  onData(stream: RoutedIncomingUniStream): void;
  /** Close the MOQT session for a stream-space protocol violation. */
  onViolation(reason: string, error: Error): void;
  /** Surface failure of the transport's stream-accept channel unchanged. */
  onTransportError(error: Error): void;
}

export interface IncomingUniRouterOptions {
  /** Maximum streams whose type or pre-release ownership is unresolved. */
  maxPendingStreams?: number;
}

type StreamKind = 'setup' | 'subgroup' | 'fetch' | 'padding' | 'terminal';

export interface RoutedIncomingUniStream {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly prefix: Uint8Array;
}

interface ClassifiedStream extends RoutedIncomingUniStream {
  readonly kind: StreamKind;
}

const DEFAULT_MAX_PENDING_STREAMS = 64;

/**
 * Owns the transport's incoming-unidirectional-stream reader for draft 18.
 * Call {@link start} exactly once and await the returned promise for SETUP.
 */
export class IncomingUniRouter {
  private readonly setup = deferred<void>();
  private readonly earlyData: RoutedIncomingUniStream[] = [];
  private readonly classifyingReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  private readonly maxPendingStreams: number;
  private sourceReader: ReadableStreamDefaultReader<ReadableStream<Uint8Array>> | null = null;
  private activeClassifiers = 0;
  private sourceEnded = false;
  private setupClaimed = false;
  private setupAccepted = false;
  private dataReleased = false;
  private terminal = false;
  private started = false;

  constructor(
    private readonly handlers: IncomingUniHandlers,
    options: IncomingUniRouterOptions = {},
  ) {
    const limit = options.maxPendingStreams ?? DEFAULT_MAX_PENDING_STREAMS;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('maxPendingStreams must be a positive safe integer');
    }
    this.maxPendingStreams = limit;
  }

  start(source: ReadableStream<ReadableStream<Uint8Array>>): Promise<void> {
    if (this.started) throw new Error('IncomingUniRouter.start() may only be called once');
    this.started = true;
    this.sourceReader = source.getReader();
    void this.acceptLoop();
    return this.setup.promise;
  }

  /**
   * Release classified data only after both control-stream SETUP messages have
   * completed. Peer SETUP acceptance and local SETUP transmission are separate
   * transactions; keeping this gate explicit prevents either one from being
   * mistaken for the other.
   */
  releaseData(): void {
    if (!this.started) throw new Error('IncomingUniRouter.releaseData() called before start()');
    if (this.terminal) throw new Error('IncomingUniRouter.releaseData() called after termination');
    if (!this.setupAccepted) throw new Error('IncomingUniRouter.releaseData() called before peer SETUP');
    if (this.dataReleased) return;
    this.dataReleased = true;
    const queued = this.earlyData.splice(0);
    for (const stream of queued) this.handlers.onData(stream);
  }

  /** Stop locally-owned setup work and cancel the aggregate transport source. */
  abort(reason: unknown): void {
    this.stop(reason, true);
  }

  /**
   * Stop locally-owned work while leaving the aggregate source to transport
   * shutdown. The transport owns that readable's terminal transition; cancelling
   * it here can race a backend that closes the same controller from onClose.
   */
  retire(reason: unknown): void {
    this.stop(reason, false);
  }

  private stop(reason: unknown, cancelSource: boolean): void {
    if (this.terminal) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.terminal = true;
    this.setup.reject(error);
    this.cancelOwnedReaders(error);
    if (cancelSource) {
      try { void this.sourceReader?.cancel(error).catch(() => {}); } catch { /* transport already closed */ }
    }
  }

  private async acceptLoop(): Promise<void> {
    const reader = this.sourceReader!;
    try {
      for (;;) {
        const { value: stream, done } = await reader.read();
        if (done) {
          this.sourceEnded = true;
          this.failIfSetupImpossible();
          return;
        }
        if (this.terminal) {
          void stream.cancel().catch(() => {});
          continue;
        }
        if (this.activeClassifiers + this.earlyData.length >= this.maxPendingStreams) {
          void stream.cancel().catch(() => {});
          this.violate(`too many incoming streams awaiting classification or SETUP (limit ${this.maxPendingStreams})`);
          return;
        }
        this.activeClassifiers++;
        void this.classifyAndRoute(stream);
      }
    } catch (error) {
      if (!this.terminal) this.transportFailure(error);
    } finally {
      try { reader.releaseLock(); } catch { /* already released by transport teardown */ }
    }
  }

  private async classifyAndRoute(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    this.classifyingReaders.add(reader);
    try {
      const classified = await classifyIncomingStream(reader);
      if (this.terminal) {
        await classified.reader.cancel().catch(() => {});
        return;
      }
      if (classified.kind === 'setup') {
        if (this.setupClaimed) {
          await classified.reader.cancel().catch(() => {});
          this.violate('received more than one SETUP stream (§3.3)');
          return;
        }
        this.setupClaimed = true;
        try {
          await this.handlers.onSetup(replayStream(classified.reader, classified.prefix));
        } catch (error) {
          this.fail(error);
          return;
        }
        if (this.terminal) return;
        this.setupAccepted = true;
        this.setup.resolve();
        return;
      }

      if (!this.dataReleased) {
        if (this.earlyData.length >= this.maxPendingStreams) {
          await classified.reader.cancel().catch(() => {});
          this.violate(`too many data streams received before SETUP (limit ${this.maxPendingStreams})`);
          return;
        }
        this.earlyData.push(classified);
        return;
      }
      this.handlers.onData(classified);
    } catch (error) {
      if (!this.terminal) this.fail(error);
    } finally {
      this.classifyingReaders.delete(reader);
      this.activeClassifiers--;
      this.failIfSetupImpossible();
    }
  }

  private failIfSetupImpossible(): void {
    if (!this.terminal && this.sourceEnded && this.activeClassifiers === 0 && !this.setupClaimed) {
      this.fail(new ProtocolViolationError('incoming unidirectional stream source ended before SETUP'));
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.violate(message, error);
  }

  private transportFailure(error: unknown): void {
    if (this.terminal) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.stop(normalized, false);
    this.handlers.onTransportError(normalized);
  }

  private violate(reason: string, cause?: unknown): void {
    if (this.terminal) return;
    const error = cause instanceof Error ? cause : new ProtocolViolationError(reason);
    // The violation handler closes the session transport. Keep its aggregate
    // readable intact so the transport backend remains the sole terminal owner.
    this.stop(error, false);
    this.handlers.onViolation(reason, error);
  }

  private cancelOwnedReaders(reason: Error): void {
    for (const reader of this.classifyingReaders) {
      try { void reader.cancel(reason).catch(() => {}); } catch { /* stream already closed */ }
    }
    for (const stream of this.earlyData.splice(0)) {
      try { void stream.reader.cancel(reason).catch(() => {}); } catch { /* stream already closed */ }
    }
  }
}

/** Read enough bytes to classify a vi64 stream type, then replay every byte. */
async function classifyIncomingStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ClassifiedStream> {
  const codec = createDataCodec(18);
  let prefix: Uint8Array = new Uint8Array(0);

  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        // RESET_STREAM before the type is a normal stream terminal. Preserve
        // the errored reader so the adapter's lifecycle path observes the
        // reset and its application error code exactly as it did before this
        // classifier existed.
        return { kind: 'terminal', reader, prefix };
      }
      const { value, done } = result;
      if (done) {
        throw new ProtocolViolationError(
          prefix.length === 0
            ? 'unidirectional stream FIN received before stream type'
            : 'unidirectional stream FIN received mid-type',
        );
      }
      prefix = append(prefix, value);
      try {
        const kind = codec.classifyStream(prefix, 0);
        if (kind === 'unknown') {
          throw new ProtocolViolationError('unknown draft-18 unidirectional stream type');
        }
        return { kind, reader, prefix } as ClassifiedStream;
      } catch (error) {
        if (error instanceof RangeError) continue;
        throw error;
      }
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* peer or transport already ended it */ }
    try { reader.releaseLock(); } catch { /* cancel may have released it */ }
    throw error;
  }
}

function replayStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array,
): ReadableStream<Uint8Array> {
  let queued: Uint8Array | null = prefix.slice();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch { /* stream teardown already released it */ }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (queued) {
        controller.enqueue(queued);
        queued = null;
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left);
  out.set(right, left.length);
  return out;
}
