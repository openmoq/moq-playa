/**
 * Minimal WebTransport type interfaces for testability.
 *
 * These mirror the browser WebTransport API but are defined locally
 * so the adapter can be tested without a real browser environment.
 *
 * @see https://www.w3.org/TR/webtransport/
 * @module
 */

/** Bidirectional stream — readable + writable byte channels. */
export interface WebTransportBidirectionalStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

/** Info returned when a WebTransport session closes. */
export interface WebTransportCloseInfo {
  closeCode?: number;
  reason?: string;
}

/**
 * Minimal subset of the WebTransport API used by MoqtConnection.
 *
 * Implementations can supply the real browser WebTransport object
 * or a mock for testing.
 */
export interface WebTransportLike {
  /**
   * Negotiated application protocol from WT-Available-Protocols.
   * Empty string if no protocol was negotiated.
   * @see draft-ietf-moq-transport-16 §3.1
   * @see W3C WebTransport §3.3
   */
  readonly protocol?: string;

  /**
   * QUIC handshake RTT in milliseconds. Set by the transport factory.
   * Used by the startup buffer to classify network conditions.
   */
  readonly handshakeRttMs?: number;

  /** Open a new client-initiated bidirectional stream. */
  createBidirectionalStream(): Promise<WebTransportBidirectionalStream>;

  /** Server-initiated unidirectional streams (data streams). */
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;

  /**
   * Peer-initiated bidirectional streams. In draft-18 these carry inbound
   * request-stream openers (e.g. a publisher's PUBLISH, §10.10). Optional so
   * existing transports/tests that never receive them need not provide it.
   */
  readonly incomingBidirectionalStreams?: ReadableStream<WebTransportBidirectionalStream>;

  /** Datagram channel. `writable` is present on transports that support sending
   *  datagrams (draft-18 publisher path). */
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable?: WritableStream<Uint8Array>;
  };

  /**
   * Open a new client-initiated unidirectional stream for publishing.
   * @see https://www.w3.org/TR/webtransport/#dom-webtransport-createunidirectionalstream
   */
  createUnidirectionalStream?(): Promise<WritableStream<Uint8Array>>;

  /** Close the session with optional error code and reason. */
  close(info?: WebTransportCloseInfo): void;

  /** Resolves when the session is closed. */
  readonly closed: Promise<WebTransportCloseInfo>;
}
