/**
 * Parse example configuration from URL query parameters.
 *
 * Usage: http://localhost:5173/connect/?hash=abc123&url=https://localhost:4433/moq
 *
 * The relay URL is NOT exported here: a non-empty `?url=` is authoritative,
 * and without one the endpoint is discovered asynchronously — use
 * `resolveRelayEndpoint()` from relay-endpoint.ts.
 *
 * The relay's cert generator prints its self-signed certificate hash;
 * serverCertificateHashes is the standard WebTransport mechanism
 * for local development TLS.
 *
 * @see draft-ietf-moq-transport-16 §3.1 (WebTransport requires TLS)
 */

import { parseCertHashHex } from './relay-url.js';

const params = new URLSearchParams(window.location.search);

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

/** Catalog retrieval mode override (?catalogBootstrap=auto|joining-fetch|strict|subscribe).
 *  For manual relay verification of the MSF-01 §5 bootstrap; unset = player default. */
export const catalogBootstrap: 'auto' | 'joining-fetch' | 'strict' | 'subscribe' | undefined = (() => {
  const v = params.get('catalogBootstrap');
  return v === 'auto' || v === 'joining-fetch' || v === 'strict' || v === 'subscribe' ? v : undefined;
})();

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
  return hex ? parseCertHashHex(hex) : undefined;
})();
