/**
 * Adapt a Node WebTransport SESSION (the @fails-components/webtransport server
 * session OR its Node client `WebTransport`) to Playa's `WebTransportLike`.
 *
 * This is the entire I/O seam: NO protocol logic lives here. The FAILS session is
 * already W3C-shaped (`WebTransportReceiveStream extends ReadableStream<Uint8Array>`,
 * `WebTransportSendStream extends WritableStream<Uint8Array>`, W3C `datagrams`), so
 * the mapping is direct — the only adjustments are TypeScript generic-variance casts
 * (`ReadableStream<WebTransportReceiveStream>` → `ReadableStream<ReadableStream<…>>`),
 * not runtime transforms.
 */
import type {
  WebTransportLike,
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
} from '@moqt/webtransport';

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

/** Wrap a Node WebTransport session as a Playa `WebTransportLike`. Thin + explicit. */
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
    close: (info?: WebTransportCloseInfo) => session.close(info),
  } satisfies WebTransportLike;
}
