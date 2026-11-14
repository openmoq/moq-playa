/**
 * The fragment of an MSF URL (draft-ietf-moq-msf-01 §11.1), as an example page
 * reads it from its own address:
 *
 *   #msf:<namespace-name>--<track>[&name=value ...]
 *
 * The fragment is CLIENT-SIDE: it carries the track and the client's
 * parameters, including the `c4m` token, and a browser never sends it to a
 * server. Callers must keep it that way: do not copy a parsed fragment into a
 * query string, a log, or a link meant for someone else.
 *
 * Read here: the namespace-name string (§11.1.2), `c4m` and `connection`
 * (§11.1.1). Every other parameter, the range parameters included, is returned
 * by name and left to the caller. The session part of an MSF URL (before `#`)
 * is not parsed: a page already has its relay.
 *
 * Where the draft is silent this module refuses rather than guesses; each such
 * choice is marked CHOICE below. Errors never echo the input, because any part
 * of it may be a mistyped credential.
 *
 * @see draft-ietf-moq-msf-01 §11.1, §11.1.1, §11.1.2
 * @module
 */

/** A fragment parameter this module does not interpret, exactly as written. */
export interface MsfUrlParameter {
    readonly name: string;
    /** NOT percent-decoded: §11.1 does not say that a parameter value is. */
    readonly value: string;
}

/** The `msf:` fragment of an MSF URL (§11.1). */
export interface MsfFragment {
    /** Namespace tuple, one string per field (§11.1.2). At least one field, none empty. */
    readonly namespace: readonly string[];
    /** Track name. The draft's examples name the catalog, but any track may be named. */
    readonly trackName: string;
    /** `q` — native QUIC MUST be used; `wt` — WebTransport MUST be used; absent — either. */
    readonly connection?: 'q' | 'wt';
    /** The decoded `c4m` token: opaque bytes for the relay to validate. */
    readonly c4m?: Uint8Array;
    /** Every other parameter in document order. Names are case-sensitive and may repeat. */
    readonly parameters: readonly MsfUrlParameter[];
}

// §11.1: *( pchar-no-amp / "/" ) — RFC 3986 pchar without '&', and never '?'.
const FRAGMENT_COMPONENT = /^(?:[A-Za-z0-9\-._~!$'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$/;

/** Bound on the decoded `c4m` token, matching the 32 KiB credential bound in @openmoq/webtransport. */
const MAX_C4M_BYTES = 32_768;

/**
 * Parse the fragment of an MSF URL: `msf:` and everything after it, without
 * the leading `#`.
 *
 * CHOICES, where §11.1 is silent:
 * - A parameter is split at its FIRST `=`. The grammar admits `=` in both
 *   param-name and param-value, so `a=b=c` is otherwise ambiguous.
 * - `connection` and `c4m` may each appear once.
 * - An empty namespace, namespace field, or track name is refused: the
 *   encoding of §11.1.2 cannot express one unambiguously.
 * - `c4m` accepts base64 with padding (RFC 4648 §4), and base64url with or
 *   without it (§5). Either way the encoding must be canonical and the two
 *   alphabets must not be mixed.
 *
 * `.` escapes are accepted with upper-case hex digits and for bytes that need
 * no escaping, although §11.1.2 only ever produces the lower-case, minimal form.
 *
 * @throws {Error} missing `msf:` type, character outside the §11.1 grammar,
 *   malformed namespace-name string, malformed parameter, invalid or repeated
 *   `connection` or `c4m`.
 */
export function parseMsfFragment(fragment: string): MsfFragment {
    if (typeof fragment !== 'string') throw new TypeError('MSF URL fragment must be a string');
    // Fragment type names are not declared case-insensitive; "msf" is matched exactly.
    if (!fragment.startsWith('msf:')) throw new Error('MSF URL fragment must begin with "msf:" (§11.1)');
    // '&' only ever delimits: it is in neither the identifier's nor a parameter's alphabet.
    const [identifier = '', ...parameters] = fragment.slice(4).split('&');
    if (![identifier, ...parameters].every(part => FRAGMENT_COMPONENT.test(part))) {
        throw new Error('MSF URL fragment contains a character outside the msf-fragment grammar (§11.1)');
    }
    const track = decodeNamespaceName(identifier);

    let connection: 'q' | 'wt' | undefined;
    let c4m: Uint8Array | undefined;
    const other: MsfUrlParameter[] = [];
    for (const parameter of parameters) {
        if (parameter === '') throw new Error('MSF URL fragment has an empty parameter between or after "&" (§11.1)');
        const equals = parameter.indexOf('=');
        if (equals < 0) throw new Error('MSF URL fragment parameter has no "=" (§11.1)');
        if (equals === 0) throw new Error('MSF URL fragment parameter has an empty name (§11.1)');
        const name = parameter.slice(0, equals);
        const value = parameter.slice(equals + 1);
        // Key names are case-sensitive (§11.1.1): `Connection` is not reserved.
        if (name === 'connection') {
            if (connection !== undefined) throw new Error('MSF URL repeats the "connection" parameter (§11.1.1)');
            if (value !== 'q' && value !== 'wt') throw new Error('MSF URL "connection" must be "q" or "wt" (§11.1.1)');
            connection = value;
        } else if (name === 'c4m') {
            if (c4m !== undefined) throw new Error('MSF URL repeats the "c4m" parameter (§11.1.1)');
            c4m = decodeC4m(value);
        } else {
            other.push({ name, value });
        }
    }
    return {
        ...track,
        ...(connection !== undefined ? { connection } : {}),
        ...(c4m !== undefined ? { c4m } : {}),
        parameters: other,
    };
}

// ─── Namespace-name string (§11.1.2) ─────────────────────────────────

function isLiteral(byte: number): boolean {
    return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f;
}

function decodeElement(text: string, what: string): string {
    if (text === '') throw new Error(`MSF namespace-name string has an empty ${what} (§11.1.2)`);
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit === 0x2e) {
            const hex = text.slice(i + 1, i + 3);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error(`MSF ${what} has a "." not followed by two hexadecimal digits (§11.1.2)`);
            bytes.push(parseInt(hex, 16));
            i += 2;
        } else if (isLiteral(unit)) {
            bytes.push(unit);
        } else {
            throw new Error(`MSF ${what} contains a character that must be escaped (§11.1.2)`);
        }
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); }
    catch { throw new Error(`MSF ${what} is not valid UTF-8, which these pages require of a track identity`); }
}

function decodeNamespaceName(text: string): Pick<MsfFragment, 'namespace' | 'trackName'> {
    // A hyphen in data is escaped as .2d, so the only "--" is the delimiter
    // between namespace and track name. Two of them cannot be told apart.
    const delimiter = text.indexOf('--');
    if (delimiter < 0) throw new Error('MSF namespace-name string has no "--" before the track name (§11.1.2)');
    if (text.indexOf('--', delimiter + 2) >= 0) throw new Error('MSF namespace-name string has more than one "--" (§11.1.2)');
    const namespace = text.slice(0, delimiter).split('-').map(field => decodeElement(field, 'namespace field'));
    return { namespace, trackName: decodeElement(text.slice(delimiter + 2), 'track name') };
}

// ─── c4m (§11.1.1) ───────────────────────────────────────────────────

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode the `c4m` value. Never throws with the value in the message.
 *
 * Non-canonical input (non-zero bits after the last whole byte) is refused so
 * that one token has one spelling per alphabet. The token fragment printed in
 * §11.1.1 is such a string — it is cut short for display — and does not decode.
 */
function decodeC4m(text: string): Uint8Array {
    const invalid = (): never => { throw new Error('MSF URL "c4m" is not a valid base64 token (§11.1.1)'); };
    // Check the encoded size before decoding an untrusted credential.
    if (text === '' || text.length > 4 * Math.ceil(MAX_C4M_BYTES / 3)) invalid();
    const urlSafe = !/[+/]/.test(text);
    const data = text.replace(/={1,2}$/, '');
    const padding = text.length - data.length;
    if (!(urlSafe ? /^[A-Za-z0-9\-_]+$/ : /^[A-Za-z0-9+/]+$/).test(data)) invalid();
    // Padding, when present, must complete the quantum; RFC 4648 §4 base64 requires it.
    if (data.length % 4 === 1 || (padding > 0 ? (data.length + padding) % 4 !== 0 : !urlSafe && data.length % 4 !== 0)) invalid();
    const out = new Uint8Array(Math.floor(data.length * 6 / 8));
    let accumulator = 0;
    let bits = 0;
    let length = 0;
    for (let i = 0; i < data.length; i++) {
        const char = data[i]!;
        accumulator = (accumulator << 6) | BASE64.indexOf(char === '-' ? '+' : char === '_' ? '/' : char);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[length++] = accumulator >> bits;
            accumulator &= (1 << bits) - 1;
        }
    }
    if (accumulator !== 0 || out.length > MAX_C4M_BYTES) invalid();
    return out;
}
