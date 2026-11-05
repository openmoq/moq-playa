import { MessageType, ProtocolViolationError, readVarint } from '@openmoq/transport';
import type { WebTransportBidirectionalStream } from '../types.js';

interface PendingStream {
  readonly stream: WebTransportBidirectionalStream;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  cancelled: boolean;
}

export interface AcceptedControlStream {
  readonly stream: WebTransportBidirectionalStream;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly prefix: readonly Uint8Array[];
}

/** Select CLIENT_SETUP by its bytes, since independent streams can arrive first (§3.3). */
export class Draft16ControlAcceptor {
  private source: ReadableStreamDefaultReader<WebTransportBidirectionalStream> | null = null;
  private readonly pending = new Set<PendingStream>();
  private finished = false;
  private releasePendingStreams = false;
  private resolve!: (control: AcceptedControlStream) => void;
  private reject!: (error: Error) => void;
  private readonly ready = new Promise<AcceptedControlStream>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  start(source: ReadableStream<WebTransportBidirectionalStream>): Promise<AcceptedControlStream> {
    try {
      this.source = source.getReader();
      void this.accept();
    } catch (error) {
      this.retire(error instanceof Error ? error : new Error(String(error)));
    }
    return this.ready;
  }

  retire(error: Error, options: { graceful?: boolean } = {}): void {
    if (this.finished) return;
    this.finished = true;
    this.releasePendingStreams = options.graceful === true;
    this.releaseSource();
    for (const entry of this.pending) this.drop(entry);
    this.reject(error);
  }

  private async accept(): Promise<void> {
    try {
      const source = this.source!;
      while (!this.finished) {
        const { value: stream, done } = await source.read();
        if (this.finished) {
          if (stream && !this.releasePendingStreams) this.abortStream(stream);
          return;
        }
        if (done) {
          this.retire(new ProtocolViolationError('Incoming streams ended before CLIENT_SETUP'));
          return;
        }
        if (this.pending.size >= 32) {
          this.abortStream(stream);
          this.retire(new Error('Pending control stream classification capacity exhausted'));
          return;
        }
        const entry = { stream, reader: stream.readable.getReader(), cancelled: false };
        this.pending.add(entry);
        void this.classify(entry);
      }
    } catch (error) {
      if (!this.finished) this.retire(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async classify(entry: PendingStream): Promise<void> {
    const header = new Uint8Array(8);
    const prefix: Uint8Array[] = [];
    let used = 0;
    try {
      while (!this.finished && !entry.cancelled) {
        const { value, done } = await entry.reader.read();
        if (this.finished || entry.cancelled) return;
        if (done) { this.drop(entry); return; }
        if (value.length === 0) continue;
        prefix.push(value);
        const count = Math.min(header.length - used, value.length);
        header.set(value.subarray(0, count), used);
        used += count;
        if (used < 1 << (header[0]! >> 6)) continue;
        const type = readVarint(header, 0).value;
        if (type === MessageType.CLIENT_SETUP) {
          this.pending.delete(entry);
          this.finished = true;
          this.releaseSource();
          // §3.3 permits resetting other bidi streams before setup. In
          // particular, an unfinished namespace opener must not hide control.
          for (const other of this.pending) this.drop(other);
          this.resolve({ stream: entry.stream, reader: entry.reader, prefix });
        } else if (type === MessageType.SUBSCRIBE_NAMESPACE) {
          this.drop(entry);
        } else {
          this.retire(new ProtocolViolationError('Invalid bidirectional stream opener before CLIENT_SETUP (3.3)'));
        }
        return;
      }
    } catch {
      // A peer may abandon an early namespace stream before its type completes.
      this.drop(entry);
    }
  }

  private drop(entry: PendingStream): void {
    if (entry.cancelled) return;
    entry.cancelled = true;
    this.pending.delete(entry);
    if (!this.releasePendingStreams) {
      void entry.reader.cancel().catch(() => {});
      void entry.stream.writable.abort().catch(() => {});
    }
    try { entry.reader.releaseLock(); } catch { /* pending read cancellation */ }
  }

  private abortStream(stream: WebTransportBidirectionalStream): void {
    void stream.readable.cancel().catch(() => {});
    void stream.writable.abort().catch(() => {});
  }

  private releaseSource(): void {
    const source = this.source;
    this.source = null;
    // Release our pending read; the transport owns closing this aggregate source.
    try { source?.releaseLock(); } catch { /* already released */ }
  }
}
