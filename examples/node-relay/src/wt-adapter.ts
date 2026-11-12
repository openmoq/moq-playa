/**
 * Adapt a Node WebTransport SESSION (the @fails-components/webtransport server
 * session OR its Node client `WebTransport`) to Playa's `WebTransportLike`.
 *
 * This is the entire I/O seam. The FAILS session is already W3C-shaped
 * (`WebTransportReceiveStream extends ReadableStream<Uint8Array>`,
 * `WebTransportSendStream extends WritableStream<Uint8Array>`, W3C `datagrams`), so
 * streams, getters and `closed` are passed through unchanged apart from TypeScript
 * generic-variance casts. One semantic adjustment: `resetSendStream` applies the
 * WebTransport pending-FIN identity rule (below). Not a rule for arbitrary WritableStreams.
 */
import type {
  WebTransportLike,
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
} from '@openmoq/webtransport';

/**
 * The subset of a Node/W3C WebTransport session we consume. Stream element types are
 * left as `any` ONLY to absorb TS's invariant `ReadableStream<T>` generics — both the
 * FAILS client and server sessions satisfy this structurally at runtime.
 */
export interface NodeWebTransportSession {
  readonly protocol?: string | undefined;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly datagrams: { readonly readable: ReadableStream<Uint8Array>; readonly writable?: WritableStream<Uint8Array> };
  readonly incomingUnidirectionalStreams: ReadableStream<unknown>;
  readonly incomingBidirectionalStreams: ReadableStream<unknown>;
  createBidirectionalStream(opts?: unknown): Promise<unknown>;
  createUnidirectionalStream(opts?: unknown): Promise<unknown>;
  close(info?: WebTransportCloseInfo): void;
}

/**
 * Normalize the W3C reset-during-pending-FIN sequence; pinned FAILS 1.6.8 does not implement this sequence.
 * A rejected abort counts as reset only if it rejects with the exact `reason` AND the caller's
 * pending FIN rejects with that exact `reason` (W3C WebTransport 2026-07-30 §7.4 abort-signal steps; Streams
 * FinishInFlightCloseWithError). Otherwise the abort rejection is rethrown; an unsettled FIN leaves this pending.
 */
async function resetWebTransportSendStream(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reason: unknown,
  pendingFin?: Promise<void>,
): Promise<void> {
  try {
    await writer.abort(reason);
  } catch (error) {
    if (error !== reason || !pendingFin) throw error;
    const finResetWithReason = await pendingFin.then(() => false, (finError: unknown) => finError === reason);
    if (!finResetWithReason) throw error;
  }
}

/** Wrap a Node WebTransport session as a Playa `WebTransportLike`. Thin + explicit, plus the reset normalization above. */
export function nodeSessionToWebTransportLike(
  session: NodeWebTransportSession,
  opts?: { handshakeRttMs?: number },
): WebTransportLike {
  return {
    // Optional fields: only set when defined (exactOptionalPropertyTypes).
    ...(session.protocol !== undefined ? { protocol: session.protocol } : {}),
    ...(opts?.handshakeRttMs !== undefined ? { handshakeRttMs: opts.handshakeRttMs } : {}),

    // Incoming streams — element types are real ReadableStreams of bytes / bidi pairs.
    get incomingUnidirectionalStreams(): ReadableStream<ReadableStream<Uint8Array>> {
      return session.incomingUnidirectionalStreams as ReadableStream<ReadableStream<Uint8Array>>;
    },
    get incomingBidirectionalStreams(): ReadableStream<WebTransportBidirectionalStream> {
      return session.incomingBidirectionalStreams as ReadableStream<WebTransportBidirectionalStream>;
    },
    get datagrams() {
      return session.datagrams;
    },
    get closed() {
      return session.closed;
    },

    createBidirectionalStream: () =>
      session.createBidirectionalStream() as Promise<WebTransportBidirectionalStream>,
    createUnidirectionalStream: () =>
      session.createUnidirectionalStream() as Promise<WritableStream<Uint8Array>>,
    createStreamError: (code, cause) => Object.assign(new Error('Stream cancelled', { cause }), { code }),
    resetSendStream: resetWebTransportSendStream,
    close: (info?: WebTransportCloseInfo) => session.close(info),
  } satisfies WebTransportLike;
}
