/**
 * Browser WebTransport factory for @moqt/player.
 *
 * Creates a `createTransport` factory that the player calls with a URL
 * to get a ready WebTransport connection. Handles cert hash pinning
 * for local development with self-signed certificates and MOQT version
 * negotiation via WT-Available-Protocols.
 *
 * Usage:
 * ```ts
 * const player = new MoqtPlayer({
 *   url: relayUrl,
 *   namespace,
 *   createTransport: createWebTransport({ certHash, draftVersion: 14 }),
 *   createConnection: () => new MoqtConnection(14),
 *   ...
 * });
 * ```
 *
 * @see draft-ietf-moq-transport-16 §3.1 (WebTransport + WT-Available-Protocols)
 * @module
 */

import type { WebTransportLike } from '@moqt/webtransport';

/** Options for creating the WebTransport factory. */
export interface WebTransportFactoryOptions {
  /**
   * SHA-256 certificate hash as ArrayBuffer for self-signed certs.
   * Passed to `serverCertificateHashes` in the WebTransport constructor.
   */
  readonly certHash?: ArrayBuffer;

  /**
   * MOQT draft version for protocol negotiation.
   *
   * Sets the `protocols` option on the WebTransport constructor, which
   * sends the `WT-Available-Protocols` header to the server. The server
   * selects a protocol and the result is available on `transport.protocol`.
   *
   * - 18 → `["moqt-18"]`
   * - 16 → `["moqt-16"]`
   * - 14 → no protocols sent (h3 ALPN fallback, in-band CLIENT_SETUP negotiation)
   * - undefined → `["moqt-16"]` (default, kept for backward compatibility)
   *
   * @see draft-ietf-moq-transport-16 §3.1 (version negotiation)
   * @see W3C WebTransport §3.3 (WT-Available-Protocols)
   */
  readonly draftVersion?: 14 | 16 | 18;
}

/**
 * Create a `createTransport` factory for the player config.
 *
 * Returns an async function that creates and awaits a WebTransport connection.
 * The player calls this with the constructed URL.
 *
 * @param options - Optional cert hash and draft version.
 * @returns Factory function: `(url: string) => Promise<WebTransportLike>`
 */
export function createWebTransport(
  options?: WebTransportFactoryOptions,
): (url: string) => Promise<WebTransportLike> {
  return async (url: string): Promise<WebTransportLike> => {
    // Build options as a plain object — WebTransportOptions varies by environment.
    // §3.1: WT-Available-Protocols for MOQT version negotiation.
    // Default: offer ['moqt-16']. Draft-14 does not send protocols —
    // it relies on h3 ALPN with in-band CLIENT_SETUP version list.
    const opts: any = {};
    if (options?.certHash) {
      opts.serverCertificateHashes = [{
        algorithm: 'sha-256',
        value: options.certHash,
      }];
    }
    // Protocol negotiation via WT-Available-Protocols (§3.1).
    // Draft-14 and below used "moq-00" ALPN over raw QUIC, but over WebTransport
    // the protocol string isn't recognized by servers. Draft-14 falls back to
    // plain h3 ALPN with in-band version negotiation in CLIENT_SETUP (§9.3).
    // Draft-15+ use "moqt-{N}" which servers recognize over WebTransport.
    if (options?.draftVersion && options.draftVersion >= 15) {
      opts.protocols = [`moqt-${options.draftVersion}`];
    } else if (!options?.draftVersion) {
      // Auto-negotiate: offer draft-16 protocol string.
      // Don't offer moq-00/moqt-14 — servers reject unknown protocol strings.
      opts.protocols = ['moqt-16'];
    }
    // draft-14: no protocols sent — h3 ALPN fallback with CLIENT_SETUP version list
    const transport = new WebTransport(url, opts);
    const connectStart = performance.now();
    try {
      await transport.ready;
    } catch (err) {
      // Enrich WebTransportError with diagnostic detail
      const wte = err as { source?: string; streamErrorCode?: number; message?: string };
      const detail = [
        wte.message ?? 'unknown',
        wte.source ? `source=${wte.source}` : '',
        wte.streamErrorCode != null ? `code=${wte.streamErrorCode}` : '',
        opts.protocols ? `protocols=[${opts.protocols.join(',')}]` : '',
      ].filter(Boolean).join(' | ');
      throw new Error(`WebTransport connection failed: ${detail}`);
    }
    const handshakeRttMs = performance.now() - connectStart;
    const wt = transport as unknown as WebTransportLike;

    // Return a thin wrapper that adds handshakeRttMs without mutating
    // the original WebTransport object (which may freeze properties).
    return {
      get protocol() { return ((transport as any).protocol as string | undefined) ?? ''; },
      get handshakeRttMs() { return handshakeRttMs; },
      createBidirectionalStream: () => wt.createBidirectionalStream(),
      createUnidirectionalStream: () => (transport as any).createUnidirectionalStream(),
      get incomingUnidirectionalStreams() { return wt.incomingUnidirectionalStreams; },
      // draft-18 inbound request streams (e.g. a publisher's PUBLISH, §10.10)
      // arrive as peer-initiated bidi streams; surface them when present.
      get incomingBidirectionalStreams() { return (transport as any).incomingBidirectionalStreams; },
      get datagrams() { return wt.datagrams; },
      close: (info) => wt.close(info),
      get closed() { return wt.closed; },
    } satisfies WebTransportLike;
  };
}
