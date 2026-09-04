/**
 * Minimal byte-transport interfaces for testability.
 *
 * These mirror the browser WebTransport API. A native QUIC binding can expose
 * the same byte-stream surface while identifying its transport kind.
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

/** URI identity copied into native-QUIC MOQT SETUP. */
export interface MoqtSetupRouting {
  readonly authority: string;
  readonly path: string;
}

/**
 * Minimal transport surface used by MoqtConnection.
 *
 * Implementations can supply browser WebTransport, a native QUIC adapter, or
 * a mock for testing. The historical name is retained for API compatibility.
 */
export interface WebTransportLike {
  /**
   * Transport binding. Omitted preserves the historical WebTransport behavior;
   * native QUIC adapters must identify themselves explicitly.
   */
  readonly kind?: 'webtransport' | 'quic';

  /**
   * Negotiated application protocol from WT-Available-Protocols or ALPN.
   * Empty string if no protocol was negotiated.
   * @see draft-ietf-moq-transport-18 §3.1
   * @see W3C WebTransport §3.3
   */
  readonly protocol?: string;

  /**
   * QUIC handshake RTT in milliseconds. Set by the transport factory.
   * Used by the startup buffer to classify network conditions.
   */
  readonly handshakeRttMs?: number;

  /** Maximum peer-accepted QUIC datagram payload. Required and non-zero for
   * native QUIC, where MOQT negotiates datagrams at the QUIC layer. */
  readonly maxDatagramSize?: number;

  /**
   * URI-derived MOQT routing fields for native QUIC. Native adapters must
   * provide these so callers cannot accidentally omit or alter the AUTHORITY
   * and PATH carried in SETUP. WebTransport implementations omit this field.
   */
  readonly setupOptions?: MoqtSetupRouting;

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
