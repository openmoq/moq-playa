import { lookup as nodeLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NativeQuicConnectOptions, NativeQuicRuntime, NativeQuicSession } from './native.js';
import {
  BoundedReadableQueue,
  NodeQuicTransport,
  routeNativeStream,
  type MoqtQuicTransport,
} from './transport.js';
import type { WebTransportBidirectionalStream } from '@moqt/webtransport';

const ALPN = 'moqt-18';
const DEFAULT_PORT = '443';
const DEFAULT_MAX_DATAGRAM_FRAME_SIZE = 1200;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const STARTUP_QUEUE_LIMIT = 256;

export interface QuicConnectOptions {
  /** Trust a self-signed or otherwise unverified peer certificate. */
  readonly allowUnauthorized?: boolean;
  /** Additional certificate authorities accepted by Node's TLS verifier. */
  readonly ca?: ArrayBuffer | ArrayBufferView | readonly (ArrayBuffer | ArrayBufferView)[];
  /** Maximum handshake duration in milliseconds. */
  readonly handshakeTimeoutMs?: number;
  /** Maximum QUIC DATAGRAM frame size advertised to the peer. */
  readonly maxDatagramFrameSize?: number;
}

export interface ParsedMoqtUri {
  readonly address: string;
  readonly servername: string;
  readonly setup: {
    readonly authority: string;
    readonly path: string;
  };
}

export type HostLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

/** Parse one native `moqt` URI into QUIC and MOQT routing fields. */
export function parseMoqtUri(input: string | URL): ParsedMoqtUri {
  const raw = input instanceof URL ? input.href : input;
  const components = /^moqt:\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!components) {
    let protocol = 'an invalid URI';
    try { protocol = new URL(raw).protocol; } catch { /* use the syntax diagnostic */ }
    throw new TypeError(`native MoQT URI must use moqt: with an authority, not ${protocol}`);
  }

  const [, authority, path = '', query = '', fragment] = components;
  if (!authority) throw new TypeError('native MoQT URI must include a host');
  if (authority.includes('@')) throw new TypeError('native MoQT URI must not include credentials');
  validateUriComponent(path, 'path', false);
  validateUriComponent(query.startsWith('?') ? query.slice(1) : query, 'query', true);
  if (fragment !== undefined && !/^#[a-z0-9-]+:/.test(fragment)) {
    throw new TypeError('native MoQT URI fragment must have the form #<type>:<value>');
  }
  if (fragment !== undefined) {
    const colon = fragment.indexOf(':');
    validateUriComponent(fragment.slice(colon + 1), 'fragment value', true);
  }
  if (!isValidAuthority(authority) || !hasValidPercentEncoding(authority)) {
    throw new TypeError('native MoQT URI has an invalid authority');
  }

  let authorityUrl: URL;
  try {
    authorityUrl = new URL(`https://${authority}/`);
  } catch (error) {
    throw new TypeError('native MoQT URI has an invalid authority', { cause: error });
  }
  if (!authorityUrl.hostname) throw new TypeError('native MoQT URI must include a host');
  if (authorityUrl.username || authorityUrl.password) {
    throw new TypeError('native MoQT URI must not include credentials');
  }

  const port = authorityUrl.port || DEFAULT_PORT;
  const hostname = authorityUrl.hostname;
  const address = `${hostname}:${port}`;
  const servername = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return {
    address,
    servername,
    setup: {
      authority,
      path: `${path}${query}`,
    },
  };
}

/**
 * Connect to a native-QUIC MoQT endpoint using Node's experimental QUIC API.
 *
 * Requires a Node build configured with `--experimental-quic`, launched with
 * `--experimental-quic`. The returned transport is draft-18 only.
 */
export async function connectQuic(
  uri: string | URL,
  options: QuicConnectOptions = {},
): Promise<MoqtQuicTransport> {
  const features = process.features as unknown as Record<string, unknown>;
  if (features.quic !== true) {
    throw new Error(
      'Node QUIC is unavailable; use a Node build configured and launched with --experimental-quic',
    );
  }
  const specifier = 'node:quic';
  let runtime: NativeQuicRuntime;
  try {
    runtime = await import(specifier) as NativeQuicRuntime;
  } catch (error) {
    throw new Error('failed to load Node experimental QUIC runtime', { cause: error });
  }
  const parsed = parseMoqtUri(uri);
  const addresses = await resolveDialAddresses(
    parsed,
    async (hostname) => nodeLookup(hostname, { all: true }),
  );
  return connectQuicCandidatesWithRuntime(uri, options, runtime, addresses);
}

/** Resolve a URI host to numeric socket addresses accepted by Node QUIC. */
export async function resolveDialAddresses(
  parsed: ParsedMoqtUri,
  lookup: HostLookup,
): Promise<string[]> {
  const uri = new URL(`moqt://${parsed.setup.authority}`);
  const port = uri.port || DEFAULT_PORT;
  const literal = parsed.servername;
  const resolved = isIP(literal) === 0
    ? await lookup(literal)
    : [{ address: literal, family: isIP(literal) }];
  const addresses: string[] = [];
  for (const result of resolved) {
    const family = isIP(result.address);
    if (family === 0 || (result.family !== 4 && result.family !== 6)) {
      throw new Error(`DNS lookup returned a non-IP address for ${JSON.stringify(literal)}`);
    }
    const address = family === 6 ? `[${result.address}]:${port}` : `${result.address}:${port}`;
    if (!addresses.includes(address)) addresses.push(address);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${JSON.stringify(literal)}`);
  }
  return addresses;
}

/** @internal Try each address for one URI without changing its MOQT identity. */
export async function connectQuicCandidatesWithRuntime(
  uri: string | URL,
  options: QuicConnectOptions,
  runtime: NativeQuicRuntime,
  addresses: readonly string[],
): Promise<MoqtQuicTransport> {
  if (addresses.length === 0) throw new Error('native QUIC requires at least one dial address');
  const failures: Error[] = [];
  for (const address of addresses) {
    const localAddress = address.startsWith('[') ? '[::]:0' : '0.0.0.0:0';
    const candidateRuntime: NativeQuicRuntime = {
      // Node's default endpoint is IPv6. On platforms without working
      // IPv4-mapped UDP egress that silently strands an IPv4 handshake, so
      // bind each candidate to a wildcard endpoint of the same address family.
      connect: (_ignored, connectOptions) => runtime.connect(address, {
        ...connectOptions,
        endpoint: { address: localAddress },
        reuseEndpoint: false,
      }),
    };
    try {
      return await connectQuicWithRuntime(uri, options, candidateRuntime);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      failures.push(new Error(`native QUIC handshake to ${address} failed: ${cause.message}`, { cause }));
    }
  }
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'native QUIC handshake failed for every resolved address');
}

/** @internal Runtime-injected seam used by deterministic transport tests. */
export async function connectQuicWithRuntime(
  uri: string | URL,
  options: QuicConnectOptions,
  runtime: NativeQuicRuntime,
): Promise<MoqtQuicTransport> {
  const parsed = parseMoqtUri(uri);
  const maxDatagramFrameSize = options.maxDatagramFrameSize ?? DEFAULT_MAX_DATAGRAM_FRAME_SIZE;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  positiveInteger(maxDatagramFrameSize, 'maxDatagramFrameSize');
  positiveInteger(handshakeTimeoutMs, 'handshakeTimeoutMs');

  const unidirectional = new BoundedReadableQueue<ReadableStream<Uint8Array>>(
    STARTUP_QUEUE_LIMIT,
    undefined,
    (stream, reason) => stream.cancel(reason),
  );
  const bidirectional = new BoundedReadableQueue<WebTransportBidirectionalStream>(
    STARTUP_QUEUE_LIMIT,
    undefined,
    async (stream, reason) => {
      await Promise.allSettled([
        stream.readable.cancel(reason),
        stream.writable.abort(reason),
      ]);
    },
  );
  const datagrams = new BoundedReadableQueue<Uint8Array>(STARTUP_QUEUE_LIMIT);
  let session: NativeQuicSession | null = null;
  let startupError: Error | null = null;
  let observedSessionError: unknown;
  let closedFailure: unknown;
  let teardownStarted = false;

  const destroySession = (failure: Error): void => {
    if (!session || teardownStarted) return;
    teardownStarted = true;
    try {
      session.destroy(failure, { code: 1, type: 'application', reason: failure.message });
    } catch { /* backend is already terminal */ }
  };

  const failStartup = (reason: string): void => {
    if (startupError) return;
    startupError = new Error(reason);
    destroySession(startupError);
  };

  const connectOptions: NativeQuicConnectOptions = {
    alpn: ALPN,
    servername: parsed.servername,
    enableEarlyData: false,
    verifyPeer: options.allowUnauthorized ? 'manual' : 'strict',
    rejectUnauthorized: !options.allowUnauthorized,
    ...(options.ca !== undefined ? { ca: options.ca } : {}),
    handshakeTimeout: handshakeTimeoutMs,
    transportParams: { maxDatagramFrameSize },
    onstream: (stream) => {
      if (stream.early) {
        failStartup('native QUIC delivered a 0-RTT stream while early data was disabled');
        rejectNativeStream(stream, 1n);
        return;
      }
      if (!routeNativeStream(stream, unidirectional, bidirectional)) {
        failStartup('native QUIC incoming stream queue overflowed or had no direction');
        rejectNativeStream(stream, 1n);
      }
    },
    ondatagram: (datagram, early) => {
      if (early) {
        failStartup('native QUIC delivered a 0-RTT datagram while early data was disabled');
        return;
      }
      if (!datagrams.push(datagram.slice())) failStartup('native QUIC incoming datagram queue overflowed');
    },
    onerror: (error) => { observedSessionError = error; },
  };

  try {
    session = await runtime.connect(parsed.address, connectOptions);
    // A failed handshake can reject `closed` before `opened` rejects. Keep that
    // backend promise observed and retain its diagnostic; callers receive the
    // more specific backend failure rather than `opened`'s generic aftermath.
    void session.closed.catch((error: unknown) => { closedFailure = error; });
    const pendingFailure = startupError as Error | null;
    if (pendingFailure) {
      destroySession(pendingFailure);
      throw pendingFailure;
    }
    const opened = await session.opened;
    if (opened.protocol !== ALPN) {
      throw new Error(`native QUIC negotiated ALPN ${JSON.stringify(opened.protocol)}; expected ${JSON.stringify(ALPN)}`);
    }
    if (opened.earlyDataAttempted || opened.earlyDataAccepted) {
      throw new Error('native QUIC attempted or accepted 0-RTT despite early data being disabled');
    }
    if (!options.allowUnauthorized
        && opened.validationErrorCode !== undefined
        && opened.validationErrorCode !== 0
        && opened.validationErrorCode !== '0') {
      const detail = opened.validationErrorReason ?? String(opened.validationErrorCode);
      throw new Error(`native QUIC certificate validation failed: ${detail}`);
    }
    if (!Number.isSafeInteger(session.maxDatagramSize) || session.maxDatagramSize <= 0) {
      throw new Error('peer did not negotiate QUIC DATAGRAM support');
    }
    if (startupError) throw startupError;

    return new NodeQuicTransport(
      session,
      parsed.setup,
      unidirectional,
      bidirectional,
      datagrams,
      () => observedSessionError,
    );
  } catch (error) {
    const reported = observedSessionError ?? closedFailure ?? error;
    const failure = reported instanceof Error ? reported : new Error(String(reported));
    destroySession(failure);
    unidirectional.error(failure);
    bidirectional.error(failure);
    datagrams.error(failure);
    throw failure;
  }
}

function rejectNativeStream(
  stream: Parameters<NativeQuicConnectOptions['onstream']>[0],
  code: bigint,
): void {
  try { stream.stopSending(code); } catch { /* receive side already closed */ }
  try { stream.resetStream(code); } catch { /* no writable side or already closed */ }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function validateUriComponent(value: string, name: string, allowSlashAndQuestion: boolean): void {
  const pattern = allowSlashAndQuestion
    ? /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/
    : /^(\/[A-Za-z0-9\-._~!$&'()*+,;=:@%]*)*$/;
  if (!pattern.test(value) || !hasValidPercentEncoding(value)) {
    throw new TypeError(`native MoQT URI has an invalid ${name}`);
  }
}

function hasValidPercentEncoding(value: string): boolean {
  return !value.replace(/%[0-9A-Fa-f]{2}/g, '').includes('%');
}

function isValidAuthority(value: string): boolean {
  const regName = "[A-Za-z0-9._~!$&'()*+,;=%-]+";
  const ipLiteral = "\\[[A-Za-z0-9._~!$&'()*+,;=:%-]+\\]";
  return new RegExp(`^(?:${regName}|${ipLiteral})(?::[0-9]*)?$`).test(value);
}
