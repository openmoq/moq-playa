/**
 * InboundRequestStreamContext — owns one peer-initiated (inbound) request stream
 * (draft-18 §3.3). The peer opens the stream and sends a first request message
 * (PUBLISH §10.10, SUBSCRIBE §10.7, FETCH §10.12, TRACK_STATUS §10.14, or
 * PUBLISH_NAMESPACE §10.15); after we respond, the stream stays open (except the
 * one-shot TRACK_STATUS) and may carry follow-ups:
 *
 *   - a terminal message (e.g. PUBLISH_DONE §10.11) after which the owner seals
 *     the stream — any further message is a PROTOCOL_VIOLATION;
 *   - peer REQUEST_UPDATE (§10.9) — answered with REQUEST_OK / REQUEST_ERROR on
 *     the SAME stream;
 *   - REQUEST_OK / REQUEST_ERROR — responses to a LOCAL REQUEST_UPDATE we sent,
 *     matched FIFO by send order.
 *
 * The context is request-type-agnostic: it enforces the generic stream rules
 * (FIFO update responses, no message after seal, unsolicited responses fail) and
 * dispatches the rest to the owner, which applies the PUBLISH- or
 * SUBSCRIBE-specific semantics.
 *
 * @module
 */

import { ProtocolViolationError, type ControlCodec, type ControlMessage, type DecodedControlMessage } from '@moqt/transport';
import { ControlStreamFramer } from '../framer.js';
import type { WebTransportBidirectionalStream } from '../types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Which request type a peer-initiated bidi stream carries (set on bind). */
export type InboundOpenerKind =
  | 'publish' | 'subscribe' | 'fetch' | 'track-status'
  | 'publish-namespace' | 'subscribe-namespace' | 'subscribe-tracks';

/** Owner callbacks for messages to route (first request / terminal / peer
 *  REQUEST_UPDATE) plus stream lifecycle. The closing callbacks receive the
 *  context so the owner can clean up per-request state (e.g. withdraw an inbound
 *  PUBLISH_NAMESPACE on FIN/reset). */
export interface InboundRequestHandlers {
  onMessage(message: DecodedControlMessage, ctx: InboundRequestStreamContext): void | Promise<void>;
  onFailure(error: Error, ctx: InboundRequestStreamContext): void;
  onClosed(ctx: InboundRequestStreamContext): void;
}

/** In-order processing hook awaited before the next frame (wire-order barrier). */
type ResponseProcessor = (message: DecodedControlMessage) => void | Promise<void>;

interface PendingUpdate extends Deferred<DecodedControlMessage> {
  readonly process?: ResponseProcessor;
}

export class InboundRequestStreamContext {
  /** First request's Request ID, set once the owner binds a valid request. */
  requestId: bigint | null = null;
  /** Which opener this stream carries — set on bind. Local REQUEST_UPDATE is
   *  only valid for an inbound PUBLISH (we are the subscriber there). */
  openerKind: InboundOpenerKind | null = null;
  private sealed = false;

  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly framer: ControlStreamFramer;
  private readonly pendingUpdates: PendingUpdate[] = [];
  private aborted = false;

  constructor(
    stream: WebTransportBidirectionalStream,
    private readonly codec: ControlCodec,
    private readonly handlers: InboundRequestHandlers,
  ) {
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();
    this.framer = new ControlStreamFramer(codec);
  }

  /** Begin the continuous read loop. */
  start(): void {
    void this.readLoop();
  }

  /** Bind the validated first request's Request ID and opener kind. */
  bind(requestId: bigint, openerKind: InboundOpenerKind): void {
    this.requestId = requestId;
    this.openerKind = openerKind;
  }

  /** Seal the stream after a terminal message (e.g. PUBLISH_DONE) — any further
   *  message is then a PROTOCOL_VIOLATION. */
  seal(): void {
    this.sealed = true;
  }

  /** Send a LOCAL REQUEST_UPDATE; its REQUEST_OK / REQUEST_ERROR resolves the
   *  returned promise (matched FIFO against responses on this stream). The read
   *  loop AWAITS `onResponse` before the next frame, so a response coalesced
   *  with a following message (e.g. PUBLISH_DONE) is applied in wire order. */
  async sendUpdate(message: ControlMessage, onResponse: ResponseProcessor): Promise<DecodedControlMessage> {
    if (typeof onResponse !== 'function') {
      throw new Error('InboundRequestStreamContext.sendUpdate: an onResponse processor (the wire-order acknowledgement) is required');
    }
    const d: PendingUpdate = { ...deferred<DecodedControlMessage>(), process: onResponse };
    this.pendingUpdates.push(d);
    try {
      await this.writer.write(this.codec.encode(message));
    } catch (err) {
      // The write never reached the peer — drop the queued deferred so a later
      // REQUEST_OK / REQUEST_ERROR cannot be mis-correlated to this failed update.
      const i = this.pendingUpdates.indexOf(d);
      if (i !== -1) this.pendingUpdates.splice(i, 1);
      throw err;
    }
    return d.promise;
  }

  /** Write a message (e.g. SUBSCRIBE_OK or a peer-update REQUEST_OK) on this stream. */
  async writeMessage(message: ControlMessage): Promise<void> {
    await this.writer.write(this.codec.encode(message));
  }

  /** FIN our writable — e.g. after writing PUBLISH_DONE (§10.11). */
  async finish(): Promise<void> {
    try { await this.writer.close(); } catch { /* already closed/aborted */ }
  }

  /**
   * Gracefully terminate after a terminal response (REQUEST_ERROR rejection or
   * PUBLISH_DONE, §10.11 / §3.3.2): FIN our writable AND STOP_SENDING the
   * readable, so neither direction stays half-open and the read loop ends
   * without surfacing the teardown as a failure. Unlike {@link abort} the
   * response bytes are flushed with a clean FIN, not a RESET.
   */
  async terminate(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true; // stops the read loop; suppresses onFailure/onClosed
    this.rejectPendingUpdates(new Error('inbound request stream terminated'));
    try { await this.writer.close(); } catch { /* already closed/aborted */ }
    try { await this.reader.cancel(); } catch { /* already closed */ }
  }

  /** Abort the stream (rejected request / session teardown). Suppresses onFailure. */
  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    // Setting `aborted` makes the read loop return WITHOUT reaching its catch, so it
    // will never reject queued REQUEST_UPDATE promises — do it here, else a caller
    // awaiting an earlier update's response hangs forever (§11.4.1: the request
    // stream is gone, so no response can ever arrive).
    this.rejectPendingUpdates(new Error('inbound request stream aborted'));
    try { await this.reader.cancel(); } catch { /* already closed */ }
    try { await this.writer.abort(); } catch { /* already closed */ }
  }

  /** Reject + drop every queued REQUEST_UPDATE promise (teardown with no response). */
  private rejectPendingUpdates(reason: Error): void {
    for (const d of this.pendingUpdates.splice(0)) d.reject(reason);
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        for (const { message } of this.framer.drain()) {
          if (this.aborted) return;
          await this.dispatch(message);
        }
        if (this.aborted) return;
        const { value, done } = await this.reader.read();
        if (this.aborted) return;
        if (value) this.framer.push(value);
        if (done) {
          for (const { message } of this.framer.drain()) await this.dispatch(message);
          if (this.pendingUpdates.length > 0) {
            throw new ProtocolViolationError('inbound request stream ended with pending REQUEST_UPDATE responses');
          }
          this.handlers.onClosed(this);
          return;
        }
      }
    } catch (err) {
      if (this.aborted) return;
      const e = err instanceof Error ? err : new Error(String(err));
      for (const d of this.pendingUpdates.splice(0)) d.reject(e);
      this.handlers.onFailure(e, this);
    }
  }

  private async dispatch(message: DecodedControlMessage): Promise<void> {
    // No message may follow a terminal message (e.g. PUBLISH_DONE, §10.11).
    if (this.sealed) {
      throw new ProtocolViolationError('message received after the inbound request stream was sealed');
    }
    if (message.type === 'REQUEST_OK' || message.type === 'REQUEST_ERROR') {
      // Response to a LOCAL REQUEST_UPDATE — match FIFO. The wire-order barrier:
      // the owner's processing is AWAITED before the next frame is dispatched.
      const exp = this.pendingUpdates.shift();
      if (!exp) {
        throw new ProtocolViolationError('unsolicited REQUEST_OK/REQUEST_ERROR on inbound request stream');
      }
      if (exp.process) {
        try {
          await exp.process(message);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          exp.reject(e);
          throw e;
        }
      }
      exp.resolve(message);
      return;
    }
    // First request / terminal / peer REQUEST_UPDATE → owner routes it.
    await this.handlers.onMessage(message, this);
  }
}
