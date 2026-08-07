/**
 * Pure URL math for the examples' relay endpoint handling.
 *
 * No `window` access — everything here is testable in a plain node
 * environment and consumed by the browser glue in relay-endpoint.ts.
 */

/**
 * The explicit `?url=` value, without URL normalization, or undefined when
 * absent or empty.
 *
 * A non-empty `?url=` is authoritative: it names the complete WebTransport
 * endpoint (host, port, path, query) and suppresses endpoint discovery.
 */
export function explicitRelayUrl(search: string): string | undefined {
  const configured = new URLSearchParams(search).get('url');
  return configured ? configured : undefined;
}

/**
 * `https://<host>:4433` derived from the page hostname.
 *
 * Only the hostname feeds the origin — never the page origin/port (the old
 * default appended ":4433" to the full origin, producing invalid URLs like
 * "http://localhost:5173:4433"). Bare IPv6 hostnames are bracketed.
 */
export function relayOrigin(hostname: string): string {
  if (!hostname) {
    throw new Error(
      'Cannot derive a relay endpoint from an empty page hostname — pass an explicit ?url=https://host:port/path',
    );
  }
  const bracketed = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  return `https://${bracketed}:4433`;
}

/**
 * Discovery candidates in deterministic priority order.
 *
 * `/moq` and `/moq-relay` are deployment conventions, not MOQT-standard
 * paths — draft-18 §3.1.1 allows arbitrary path-abempty. The examples probe
 * the common conventions plus the bare origin and select the first successful
 * candidate in that order.
 */
export function relayCandidates(hostname: string): readonly [string, string, string] {
  const origin = relayOrigin(hostname);
  return [`${origin}/moq`, `${origin}/moq-relay`, `${origin}/`];
}

/**
 * Hex-encoded certificate hash → ArrayBuffer for `serverCertificateHashes`.
 * Separators (colons, spaces) are stripped; an odd digit count throws.
 */
export function parseCertHashHex(hex: string): ArrayBuffer {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid cert hash: odd number of hex chars (${clean.length})`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}
