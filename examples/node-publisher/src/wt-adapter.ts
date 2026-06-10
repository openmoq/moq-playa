/**
 * Adapt a Node WebTransport session (the @fails-components/webtransport Node client)
 * to Playa's `WebTransportLike`.
 *
 * Deliberately DUPLICATED from examples/node-relay/src/wt-adapter.ts (same thin,
 * direct mapping) rather than importing another private example's internals —
 * duplication is cheaper than designing a shared examples API this early. The FAILS
 * session is already W3C-shaped, so the only adjustments are TypeScript
 * generic-variance casts, not runtime transforms.
 */
import type {
  WebTransportLike,
  WebTransportBidirectionalStream,
  WebTransportCloseInfo,
} from '@moqt/webtransport';

/** The subset of a Node/W3C WebTransport session we consume. Stream element types are
 *  left loose ONLY to absorb TS's invariant `ReadableStream<T>` generics. */
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
export function nodeSessionToWebTransportLike(session: NodeWebTransportSession): WebTransportLike {
  return {
    ...(session.protocol !== undefined ? { protocol: session.protocol } : {}),
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
