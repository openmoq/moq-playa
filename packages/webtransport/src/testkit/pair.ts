/**
 * Reusable two-endpoint draft-18 loopback helpers (testkit).
 *
 * Extracted so tests AND the scenario runner can build a real CLIENT+SERVER
 * `MoqtConnection` pair without importing helpers from a `.test.ts` file.
 *
 * @module
 */
import { MoqtConnection } from '../adapter.js';
import { createLoopback, type LoopbackTransport, type PipeFaults } from './loopback.js';
import type { WebTransportLike } from '../types.js';
import { varint, type DraftVersion, type SetupOptions } from '@moqt/transport';

/** Build a single-field Track Namespace tuple from a string. */
export const ns = (s: string): Uint8Array[] => [new TextEncoder().encode(s)];
/** Build a Track Name from a string. */
export const nm = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Wrap a loopback endpoint so it reports a negotiated `transport.protocol`
 * (the in-memory loopback hardcodes `protocol = undefined`). Delegates every
 * WebTransportLike call to the underlying endpoint, so `uniOut`/`bidiOut`
 * recordings still accrue on the real transport for assertions.
 */
export function withProtocol(t: LoopbackTransport, protocol: string): WebTransportLike {
  return {
    protocol,
    createBidirectionalStream: () => t.createBidirectionalStream(),
    createUnidirectionalStream: () => t.createUnidirectionalStream(),
    get incomingUnidirectionalStreams() { return t.incomingUnidirectionalStreams; },
    get incomingBidirectionalStreams() { return t.incomingBidirectionalStreams; },
    get datagrams() { return t.datagrams; },
    close: (info) => t.close(info),
    get closed() { return t.closed; },
  };
}

/** A connected CLIENT+SERVER draft-18 pair plus the transports and an error sink. */
export interface ConnectedPair {
  readonly client: MoqtConnection;
  readonly server: MoqtConnection;
  readonly a: LoopbackTransport;
  readonly b: LoopbackTransport;
  /** Every `onError` from either endpoint, in order (empty on valid schedules). */
  readonly errors: Error[];
}

/**
 * Create two real `MoqtConnection` endpoints (CLIENT + SERVER) wired through an
 * in-memory loopback and establish them concurrently.
 *
 * Version-parameterized (defaults to draft-18, the current at-risk surface) so
 * the same harness can drive any negotiated draft. Note that topology differs by
 * version: draft-18 uses a uni control-stream pair + per-request bidi streams,
 * while draft-14/16 multiplex requests on a single bidi control stream — callers
 * that assert topology-specific invariants must gate on `version`.
 */
export async function connectedPair(
  version: DraftVersion = 18,
  opts: { faults?: { a?: PipeFaults; b?: PipeFaults } } = {},
): Promise<ConnectedPair> {
  const { a, b } = createLoopback(opts.faults ?? {});
  const client = new MoqtConnection(version);
  const server = new MoqtConnection(version, { role: 'server' });
  const errors: Error[] = [];
  client.onError = (e) => errors.push(e);
  server.onError = (e) => errors.push(e);
  // draft-14/16 gate requests by a MAX_REQUEST_ID credit window. The credit a
  // requester may spend comes from the PEER's setup: the client's request
  // budget is the MAX_REQUEST_ID the server advertises in SERVER_SETUP. Since
  // our scenarios only have the client issue requests (the server merely
  // responds and publishes objects), only the SERVER needs to grant a window —
  // the client's CLIENT_SETUP credit would only bound server→client requests,
  // which never happen here. draft-18 has no request credit (the option is
  // ignored there), so both sides get an empty setup.
  const clientSetup: SetupOptions = {};
  const serverSetup: SetupOptions = version === 18 ? {} : { maxRequestId: varint(1_000_000n) };
  // Both endpoints establish concurrently — neither can complete before the other
  // starts (each must read the peer's SETUP).
  await Promise.all([client.connect(a, clientSetup), server.connect(b, serverSetup)]);
  return { client, server, a, b, errors };
}
