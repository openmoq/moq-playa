/**
 * Experimental native QUIC binding for Node.js.
 *
 * This package requires Node's experimental `node:quic` module and currently
 * supports MOQT draft 18 only. Browser applications should continue to use
 * `@moqt/webtransport` with a WebTransport implementation.
 *
 * @module
 */

export { connectQuic, parseMoqtUri } from './connect.js';
export type { ParsedMoqtUri, QuicConnectOptions } from './connect.js';
export type { MoqtQuicTransport } from './transport.js';
