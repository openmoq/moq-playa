/**
 * Parse relay URL and certificate hash from URL query parameters.
 *
 * Usage: http://localhost:5173/connect/?hash=abc123&url=https://localhost:4443
 *
 * The relay prints its self-signed certificate hash on startup.
 * serverCertificateHashes is the standard WebTransport mechanism
 * for local development TLS.
 *
 * @see draft-ietf-moq-transport-16 §3.1 (WebTransport requires TLS)
 */

const params = new URLSearchParams(window.location.search);

/** Relay URL (default: https://localhost:4443). */
export const relayUrl: string = params.get('url') ?? `${window.location.origin}:4433`;

/** Namespace as a display string (`?ns=`, default "live"). */
export const namespace: string = params.get('ns') ?? 'live';

/**
 * Namespace as the player config accepts it (`string | readonly string[]`).
 *
 * Spec §2.4.1: a Track Namespace is an ordered set of 1-32 byte-string
 * fields. The slash is purely a display convention. URL params support
 * both forms:
 *
 *   `?ns=live/broadcast`       → `"live/broadcast"`     (player splits on `/`)
 *   `?nsField=cmsf/clear`      → `["cmsf/clear"]`       (single literal field)
 *   `?nsField=foo&nsField=bar` → `["foo", "bar"]`       (multi-field, repeat)
 *
 * Use `nsField` (repeatable) when the publisher encodes the namespace
 * as one field with a slash inside, or when you want explicit control
 * over field boundaries. `ns` is the ergonomic legacy form and stays
 * the default.
 */
export const namespaceArg: string | readonly string[] = (() => {
  const fields = params.getAll('nsField');
  if (fields.length > 0) return fields;
  return namespace;
})();

/** Optional CLIENT_SETUP AUTHORITY interop override for tenant-routed relays. */
export const authority: string | undefined = (() => {
  const value = params.get('authority')?.trim();
  return value || undefined;
})();

/** `?warmStart=1`: joining-FETCH warm start of the current group (live LOC tracks). */
export const warmStart: boolean = params.get('warmStart') === '1';

/** Draft version override (e.g. ?v=14 for draft-14 relays, ?v=18 for draft-18). */
export const draftVersion: 14 | 16 | 18 | undefined = (() => {
  const v = params.get('v');
  if (v === '14') return 14;
  if (v === '16') return 16;
  if (v === '18') return 18;
  return undefined;
})();

/**
 * Certificate hash as ArrayBuffer, or undefined if not provided.
 * Pass to WebTransport({ serverCertificateHashes }).
 */
export const certHash: ArrayBuffer | undefined = (() => {
  const hex = params.get('hash');
  if (!hex) return undefined;
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid cert hash: odd number of hex chars (${clean.length})`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
})();
