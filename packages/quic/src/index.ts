/**
 * Experimental native QUIC binding for Node.js.
 *
 * This package requires Node's experimental `node:quic` module and currently
 * supports MOQT drafts 18 and 21 (one per connection, chosen with `draft`).
 * Browser applications should continue to use `@openmoq/webtransport` with a
 * WebTransport implementation.
 *
 * @module
 */

export { connectQuic, parseMoqtUri } from './connect.js';
export type { ParsedMoqtUri, QuicConnectOptions } from './connect.js';
export type { MoqtQuicProtocol, MoqtQuicTransport } from './transport.js';
