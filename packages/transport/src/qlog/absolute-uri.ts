/**
 * RFC 3986 absolute-URI validation for qlog event schema identifiers.
 *
 * Validates the **raw** string against the component productions. `new URL()`
 * is unsuitable on its own: it normalizes as it parses — trimming whitespace,
 * percent-encoding spaces, rewriting backslashes, and accepting a second raw
 * `@` in the authority — so it approves inputs whose repaired form is not what
 * we would serialize. A schema URI is an identity; silently changing or
 * emitting a malformed one is worse than refusing it.
 *
 * @see RFC 3986 §3 (syntax components)
 * @see RFC 3986 §3.2 (authority)
 * @see [QLOG-MAIN] §8 (event schema URIs and extension identifiers)
 * @module
 */

// ─── Character productions (RFC 3986 §2) ────────────────────────────

/** unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~" */
const UNRESERVED = "A-Za-z0-9\\-._~";
/** sub-delims = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "=" */
const SUB_DELIMS = "!$&'()*+,;=";
/** pct-encoded = "%" HEXDIG HEXDIG */
const PCT = '%[0-9A-Fa-f]{2}';

const cls = (extra: string) => `[${UNRESERVED}${SUB_DELIMS}${extra}]`;
const star = (extra: string) => new RegExp(`^(?:${cls(extra)}|${PCT})*$`);

/** scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) */
const SCHEME = /^[A-Za-z][A-Za-z0-9+\-.]*$/;
/** userinfo = *( unreserved / pct-encoded / sub-delims / ":" ) */
const USERINFO = star(':');
/** reg-name = *( unreserved / pct-encoded / sub-delims ) */
const REG_NAME = star('');
/** port = *DIGIT */
const PORT = /^[0-9]*$/;
/** pchar = unreserved / pct-encoded / sub-delims / ":" / "@" */
const SEGMENT = star(':@');
/** query / fragment = *( pchar / "/" / "?" ) */
const QUERY = star(':@/?');
/**
 * IPvFuture = "v" 1*HEXDIG "." 1*( unreserved / sub-delims / ":" )
 *
 * The version flag is case-insensitive: RFC 3986 §3.2.2 says so directly, and
 * ABNF literals are case-insensitive per RFC 5234 §2.3.
 */
const IPV_FUTURE = new RegExp(`^[vV][0-9A-Fa-f]+\\.${cls(':')}+$`);
/** dec-octet = 0-255, no leading zeros */
const DEC_OCTET = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
/** h16 = 1*4HEXDIG */
const H16 = /^[0-9A-Fa-f]{1,4}$/;

/**
 * [QLOG-MAIN] §8: an event-schema extension identifier is non-empty and uses
 * only URI-unreserved characters — narrower than a generic RFC 3986 fragment,
 * which also admits `/`, `?`, and percent escapes.
 */
const EXTENSION_ID = new RegExp(`^[${UNRESERVED}]+$`);

// ─── Host productions (RFC 3986 §3.2.2) ─────────────────────────────

function isIPv4Address(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(p => DEC_OCTET.test(p));
}

/**
 * IPv6address, including `::` compression and a trailing IPv4 form.
 *
 * Written against the production rather than a single regex, which is
 * unreadable for this grammar and easy to get subtly wrong.
 */
function isIPv6Address(host: string): boolean {
  if (host.includes(':::')) return false;

  const compressions = host.split('::').length - 1;
  if (compressions > 1) return false;

  const [head, tail] = compressions === 1 ? host.split('::') : [host, undefined];
  const headParts = head === '' ? [] : head!.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');

  // Only the final group may be a dotted IPv4 address.
  let groups = 0;
  const check = (parts: string[], isTail: boolean): boolean => {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const last = i === parts.length - 1;
      if (last && (isTail || compressions === 0) && part.includes('.')) {
        if (!isIPv4Address(part)) return false;
        groups += 2;
        continue;
      }
      if (!H16.test(part)) return false;
      groups += 1;
    }
    return true;
  };

  if (!check(headParts, false)) return false;
  if (!check(tailParts, true)) return false;

  return compressions === 1 ? groups < 8 : groups === 8;
}

/** IP-literal = "[" ( IPv6address / IPvFuture ) "]" */
function isIpLiteral(host: string): boolean {
  if (!host.startsWith('[') || !host.endsWith(']') || host.length < 3) return false;
  const inner = host.slice(1, -1);
  return isIPv6Address(inner) || IPV_FUTURE.test(inner);
}

/** host = IP-literal / IPv4address / reg-name */
function isHost(host: string): boolean {
  if (host.startsWith('[') || host.endsWith(']')) return isIpLiteral(host);
  if (host.includes('[') || host.includes(']')) return false;
  return isIPv4Address(host) || REG_NAME.test(host);
}

/** authority = [ userinfo "@" ] host [ ":" port ] */
function isAuthority(authority: string): boolean {
  let rest = authority;

  // userinfo is delimited by the *first* "@". A second raw "@" needs no
  // special case: it lands in host or port, and neither production admits it —
  // unlike WHATWG URL, which accepts it.
  const at = rest.indexOf('@');
  if (at >= 0) {
    if (!USERINFO.test(rest.slice(0, at))) return false;
    rest = rest.slice(at + 1);
  }

  // The port colon is the last one outside an IP-literal.
  let host = rest;
  let port: string | undefined;
  const close = rest.lastIndexOf(']');
  const colon = rest.indexOf(':', close + 1);
  if (colon >= 0) {
    host = rest.slice(0, colon);
    port = rest.slice(colon + 1);
  }

  if (port !== undefined && !PORT.test(port)) return false;
  return isHost(host);
}

// ─── Path productions (RFC 3986 §3.3) ───────────────────────────────

/** path-abempty = *( "/" segment ) */
function isPathAbempty(path: string): boolean {
  if (path === '') return true;
  if (!path.startsWith('/')) return false;
  return path.slice(1).split('/').every(seg => SEGMENT.test(seg));
}

/** path-absolute / path-rootless / path-empty, for a URI with no authority. */
function isPathNoAuthority(path: string): boolean {
  if (path === '') return true;
  const segments = path.split('/');
  if (path.startsWith('/')) {
    // path-absolute: the first segment after "/" must be non-zero-length.
    if (segments.length > 1 && segments[1] === '' && segments.length > 2) return false;
  } else if (segments[0] === '') {
    return false;
  }
  return segments.every(seg => SEGMENT.test(seg));
}

// ─── Entry point ────────────────────────────────────────────────────

/**
 * Validate a raw absolute URI suitable for a qlog `event_schemas` entry.
 *
 * Beyond RFC 3986 this applies two [QLOG-MAIN] §8 constraints: the value after
 * the scheme is non-empty, because the URI must carry its namespace
 * identifier; and a fragment, which qlog uses as an extension identifier, is
 * non-empty and URI-unreserved.
 */
export function isAbsoluteUri(uri: string): boolean {
  const colon = uri.indexOf(':');
  if (colon < 0) return false;
  if (!SCHEME.test(uri.slice(0, colon))) return false;

  let rest = uri.slice(colon + 1);
  // [QLOG-MAIN] §8: the URI must include a namespace identifier.
  if (rest === '') return false;

  const hash = rest.indexOf('#');
  if (hash >= 0) {
    const fragment = rest.slice(hash + 1);
    if (!EXTENSION_ID.test(fragment)) return false;
    rest = rest.slice(0, hash);
  }

  const question = rest.indexOf('?');
  if (question >= 0) {
    if (!QUERY.test(rest.slice(question + 1))) return false;
    rest = rest.slice(0, question);
  }

  if (rest.startsWith('//')) {
    const after = rest.slice(2);
    const slash = after.indexOf('/');
    const authority = slash < 0 ? after : after.slice(0, slash);
    const path = slash < 0 ? '' : after.slice(slash);
    return isAuthority(authority) && isPathAbempty(path);
  }

  return isPathNoAuthority(rest);
}
