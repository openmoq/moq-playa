/**
 * Setup handshake gating and parameter validation.
 *
 * Enforces that CLIENT_SETUP and SERVER_SETUP are the first messages
 * exchanged on the control stream. Validates setup parameters and
 * extracts MAX_REQUEST_ID for request ID allocation.
 *
 * @see draft-ietf-moq-transport-16 §9.3
 * @module
 */

import { varint, type Varint } from '../primitives/varint.js';
import type { ControlMessage, ClientSetup, ServerSetup, Parameters, Setup, SetupOptionMap } from '../control/messages.js';
import { SetupParam } from '../control/parameters.js';
import { SetupOption18 } from '../control/codes-18.js';
import type { DraftVersion } from '../control/codec.js';
import { EndpointRole, type EndpointRoleValue, SessionState, type SessionStateValue } from './types.js';
import { AliasType, parseAuthorizationToken, parseAuthorizationToken18, type AuthorizationToken } from '../control/auth-token.js';

/**
 * Error thrown for setup handshake violations.
 */
export class SetupError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'PROTOCOL_VIOLATION'
      | 'VERSION_NEGOTIATION_FAILED'
      | 'INVALID_PATH'
      | 'INVALID_AUTHORITY'
      | 'MALFORMED_PATH'
      | 'MALFORMED_AUTHORITY'
      | 'KEY_VALUE_FORMATTING_ERROR',
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

/**
 * Result of successful setup handshake.
 */
export interface SetupResult {
  /** MAX_REQUEST_ID from peer's setup (default 0 if not provided). */
  readonly peerMaxRequestId: Varint;
  /** MOQT_IMPLEMENTATION from peer if provided. */
  readonly peerImplementation?: string;
  /** PATH from CLIENT_SETUP (server only). */
  readonly path?: string;
  /** AUTHORITY from CLIENT_SETUP (server only). */
  readonly authority?: string;
  /**
   * MAX_AUTH_TOKEN_CACHE_SIZE from peer's setup.
   * Indicates how many bytes of token aliases the peer is willing to cache.
   * Default 0 = aliases prohibited. Raw `bigint`: draft-18 §10.3.1.3 carries this
   * as a vi64 (full uint64); draft-14/16 use a QUIC varint (range-guarded there).
   * @see draft-ietf-moq-transport-18 §10.3.1.3
   */
  readonly peerMaxAuthTokenCacheSize?: bigint;
  /**
   * Parsed AUTHORIZATION_TOKEN parameters from the peer's setup message.
   * These are the raw parsed tokens — caller must process through AuthTokenCache.
   * @see draft-ietf-moq-transport-16 §9.3.1.5
   */
  readonly authTokens?: AuthorizationToken[];
}

/**
 * Manages the setup handshake for a MOQT session.
 *
 * Setup flow:
 * - Client: Create CLIENT_SETUP → send → receive SERVER_SETUP → done
 * - Server: Receive CLIENT_SETUP → validate → create SERVER_SETUP → send → done
 *
 * @example
 * ```typescript
 * // Client side
 * const setup = new SetupGate('client');
 * const clientSetup = setup.createClientSetup({ maxRequestId: 100n });
 * // send clientSetup...
 * // receive serverSetup...
 * const result = setup.handleServerSetup(serverSetup);
 *
 * // Server side
 * const setup = new SetupGate('server');
 * // receive clientSetup...
 * const result = setup.handleClientSetup(clientSetup);
 * const serverSetup = setup.createServerSetup({ maxRequestId: 100n });
 * // send serverSetup...
 * ```
 */

/**
 * Known draft-18 Setup Options that MUST NOT be repeated (§10.3). Every known
 * option except AUTHORIZATION_TOKEN (0x03, explicitly repeatable). Unknown
 * options may be duplicated and are ignored.
 */
const KNOWN_SINGLETON_SETUP_OPTIONS_18: ReadonlySet<number> = new Set([
  SetupOption18.PATH,                     // 0x01
  SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE, // 0x04
  SetupOption18.AUTHORITY,                // 0x05
  SetupOption18.MOQT_IMPLEMENTATION,      // 0x07
]);

export class SetupGate {
  private state: SessionStateValue = SessionState.IDLE;
  private setupResult: SetupResult | undefined;

  constructor(
    private readonly role: EndpointRoleValue,
    private readonly draftVersion: DraftVersion = 16,
    /**
     * Whether the underlying transport is WebTransport. Per §10.3.1.1/§10.3.1.2,
     * PATH and AUTHORITY MUST NOT be used over WebTransport — a received PATH /
     * AUTHORITY closes the session with INVALID_PATH / INVALID_AUTHORITY. Default
     * `false` = native QUIC, where the legacy client→server PATH semantics apply.
     */
    private readonly webtransport: boolean = false,
  ) {}

  /**
   * Get the current session state.
   */
  get sessionState(): SessionStateValue {
    return this.state;
  }

  /**
   * Check if setup handshake is complete.
   */
  isComplete(): boolean {
    return this.state === SessionState.ESTABLISHED;
  }

  /**
   * Get the setup result after handshake completes.
   * @throws {Error} If handshake not complete
   */
  getResult(): SetupResult {
    if (!this.setupResult) {
      throw new Error('Setup handshake not complete');
    }
    return this.setupResult;
  }

  /**
   * Validate that the received message is appropriate for current state.
   * @throws {SetupError} If message violates handshake rules
   */
  validateMessage(msg: ControlMessage): void {
    if (this.draftVersion === 18) {
      // draft-18: each side sends a single unified SETUP on its uni control
      // stream; the first message received before ESTABLISHED must be SETUP.
      if (this.state !== SessionState.ESTABLISHED && msg.type !== 'SETUP') {
        throw new SetupError(`draft-18 expects SETUP, got ${msg.type}`, 'PROTOCOL_VIOLATION');
      }
      return;
    }
    if (this.state === SessionState.IDLE) {
      // First message must be CLIENT_SETUP (client sends) or we receive it (server)
      if (this.role === EndpointRole.CLIENT) {
        throw new SetupError(
          'Client must send CLIENT_SETUP before receiving any messages',
          'PROTOCOL_VIOLATION',
        );
      }
      if (msg.type !== 'CLIENT_SETUP') {
        throw new SetupError(
          `First message must be CLIENT_SETUP, got ${msg.type}`,
          'PROTOCOL_VIOLATION',
        );
      }
    } else if (this.state === SessionState.SETUP_PENDING) {
      // Waiting for response
      if (this.role === EndpointRole.CLIENT && msg.type !== 'SERVER_SETUP') {
        throw new SetupError(
          `Expected SERVER_SETUP after CLIENT_SETUP, got ${msg.type}`,
          'PROTOCOL_VIOLATION',
        );
      }
      if (this.role === EndpointRole.SERVER) {
        throw new SetupError(
          'Server should not receive messages while SETUP_PENDING',
          'PROTOCOL_VIOLATION',
        );
      }
    }
    // After ESTABLISHED, other messages are valid (handled by session)
  }

  // ── draft-18 unified SETUP ──────────────────────────────────────────

  /**
   * Create a draft-18 unified SETUP message (both roles). Setup Options carry
   * the same inputs as draft-14/16 EXCEPT MAX_REQUEST_ID, which draft-18 removes
   * (QUIC stream limits replace request credit). Advances IDLE → SETUP_PENDING
   * (the side that opens) or SETUP_PENDING → ESTABLISHED (the responder).
   */
  createSetup18(options: {
    path?: string;
    authority?: string;
    implementation?: string;
    // §10.3.1.3: vi64 (full uint64) — emitted as a vi64 Setup Option below.
    maxAuthTokenCacheSize?: bigint;
    authTokens?: Uint8Array[];
  } = {}): Setup {
    const enc = new TextEncoder();
    const setupOptions: SetupOptionMap = new Map();
    if (options.path !== undefined) {
      setupOptions.set(BigInt(SetupOption18.PATH), [enc.encode(options.path)]);
    }
    if (options.authority !== undefined) {
      setupOptions.set(BigInt(SetupOption18.AUTHORITY), [enc.encode(options.authority)]);
    }
    if (options.implementation !== undefined) {
      setupOptions.set(BigInt(SetupOption18.MOQT_IMPLEMENTATION), [enc.encode(options.implementation)]);
    }
    if (options.maxAuthTokenCacheSize !== undefined) {
      setupOptions.set(BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE), [options.maxAuthTokenCacheSize]);
    }
    if (options.authTokens !== undefined && options.authTokens.length > 0) {
      setupOptions.set(BigInt(SetupOption18.AUTHORIZATION_TOKEN), options.authTokens);
    }
    // Deliberately NO MAX_REQUEST_ID for draft-18.
    this.state = this.state === SessionState.IDLE ? SessionState.SETUP_PENDING : SessionState.ESTABLISHED;
    return { type: 'SETUP', setupOptions };
  }

  /**
   * Handle a received draft-18 SETUP (either role). Interprets Setup Options
   * (unknown options ignored) and advances the handshake state.
   */
  handleSetup18(msg: Setup): SetupResult {
    const result = this.extractSetupOptions18(msg.setupOptions);
    this.setupResult = result;
    this.state = this.state === SessionState.IDLE ? SessionState.SETUP_PENDING : SessionState.ESTABLISHED;
    return result;
  }

  /** Interpret draft-18 Setup Options into a {@link SetupResult}. */
  private extractSetupOptions18(options: SetupOptionMap): SetupResult {
    // §10.3.1.1 / §10.3.1.2: over WebTransport, PATH and AUTHORITY MUST NOT be used
    // at all — a received one closes the session with INVALID_PATH / INVALID_AUTHORITY
    // (regardless of role). This takes precedence over the native role policy below.
    if (this.webtransport) {
      if (options.has(BigInt(SetupOption18.PATH))) {
        throw new SetupError('PATH MUST NOT be used over WebTransport (§10.3.1.2)', 'INVALID_PATH');
      }
      if (options.has(BigInt(SetupOption18.AUTHORITY))) {
        throw new SetupError('AUTHORITY MUST NOT be used over WebTransport (§10.3.1.1)', 'INVALID_AUTHORITY');
      }
    }
    // Native-QUIC role policy: PATH and AUTHORITY are client→server only. If WE are
    // the client, the SETUP we are reading came from the server, which MUST NOT
    // include them.
    if (this.role === EndpointRole.CLIENT) {
      if (options.has(BigInt(SetupOption18.PATH)) || options.has(BigInt(SetupOption18.AUTHORITY))) {
        throw new SetupError('Server SETUP must not contain PATH or AUTHORITY', 'PROTOCOL_VIOLATION');
      }
    }

    const dec = new TextDecoder();
    let peerImplementation: string | undefined;
    let path: string | undefined;
    let authority: string | undefined;
    // draft-18 §10.3.1.3 MAX_AUTH_TOKEN_CACHE_SIZE is a vi64 (full uint64) — store
    // the raw bigint without folding it through the QUIC-varint range.
    let peerMaxAuthTokenCacheSize: bigint | undefined;
    let authTokens: AuthorizationToken[] | undefined;

    for (const [type, values] of options) {
      // §10.3 / §10.3.1: a known singleton Setup Option MUST NOT be repeated
      // (AUTHORIZATION_TOKEN is the only repeatable known option; unknown options
      // may be duplicated and are ignored). Reject duplicates on receive.
      if (values.length > 1 && KNOWN_SINGLETON_SETUP_OPTIONS_18.has(Number(type))) {
        throw new SetupError(
          `Repeated Setup Option 0x${type.toString(16)} (singleton)`,
          'PROTOCOL_VIOLATION',
        );
      }
      const first = values[0];
      switch (Number(type)) {
        case SetupOption18.MOQT_IMPLEMENTATION:
          if (first instanceof Uint8Array) peerImplementation = dec.decode(first);
          break;
        case SetupOption18.PATH:
          if (first instanceof Uint8Array) path = dec.decode(first);
          break;
        case SetupOption18.AUTHORITY:
          if (first instanceof Uint8Array) authority = dec.decode(first);
          break;
        case SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE:
          if (typeof first === 'bigint') peerMaxAuthTokenCacheSize = first;
          break;
        case SetupOption18.AUTHORIZATION_TOKEN:
          // draft-18 Token internals are vi64 (full uint64), not QUIC varint.
          authTokens = values
            .filter((v): v is Uint8Array => v instanceof Uint8Array)
            .map((v) => parseAuthorizationToken18(v));
          break;
        // Unknown Setup Options are ignored (§10.3).
      }
    }
    // draft-18 has no MAX_REQUEST_ID; request flow control is QUIC stream limits.
    return {
      peerMaxRequestId: varint(0n),
      ...(peerImplementation !== undefined ? { peerImplementation } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(authority !== undefined ? { authority } : {}),
      ...(peerMaxAuthTokenCacheSize !== undefined ? { peerMaxAuthTokenCacheSize } : {}),
      ...(authTokens !== undefined ? { authTokens } : {}),
    };
  }

  /**
   * Create CLIENT_SETUP message (client only).
   * @param options Setup options
   * @returns CLIENT_SETUP message to send
   * @throws {Error} If not in correct state or role
   */
  createClientSetup(options: {
    maxRequestId?: Varint;
    path?: string;
    authority?: string;
    implementation?: string;
    // draft-14/16: QUIC varint — the encoder range-guards an above-range value.
    maxAuthTokenCacheSize?: bigint;
    authTokens?: Uint8Array[];
  } = {}): ClientSetup {
    if (this.role !== EndpointRole.CLIENT) {
      throw new Error('Only client can create CLIENT_SETUP');
    }
    if (this.state !== SessionState.IDLE) {
      throw new Error(`Cannot create CLIENT_SETUP in state ${this.state}`);
    }

    const parameters: Parameters = new Map();

    if (options.maxRequestId !== undefined) {
      parameters.set(varint(SetupParam.MAX_REQUEST_ID), [options.maxRequestId]);
    }

    if (options.path !== undefined) {
      parameters.set(varint(SetupParam.PATH), [new TextEncoder().encode(options.path)]);
    }

    if (options.authority !== undefined) {
      parameters.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode(options.authority)]);
    }

    if (options.implementation !== undefined) {
      parameters.set(
        varint(SetupParam.MOQT_IMPLEMENTATION),
        [new TextEncoder().encode(options.implementation)],
      );
    }

    if (options.maxAuthTokenCacheSize !== undefined) {
      parameters.set(varint(SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE), [options.maxAuthTokenCacheSize]);
    }

    if (options.authTokens !== undefined && options.authTokens.length > 0) {
      parameters.set(varint(SetupParam.AUTHORIZATION_TOKEN), options.authTokens);
    }

    this.state = SessionState.SETUP_PENDING;

    return {
      type: 'CLIENT_SETUP',
      parameters,
    };
  }

  /**
   * Handle received CLIENT_SETUP (server only).
   * @param msg The CLIENT_SETUP message
   * @returns Extracted setup parameters
   * @throws {SetupError} If validation fails
   */
  handleClientSetup(msg: ClientSetup): SetupResult {
    if (this.role !== EndpointRole.SERVER) {
      throw new SetupError('Only server handles CLIENT_SETUP', 'PROTOCOL_VIOLATION');
    }
    if (this.state !== SessionState.IDLE) {
      throw new SetupError(
        `Cannot handle CLIENT_SETUP in state ${this.state}`,
        'PROTOCOL_VIOLATION',
      );
    }

    const result = this.extractSetupParams(msg.parameters, true);
    this.setupResult = result;
    this.state = SessionState.SETUP_PENDING;

    return result;
  }

  /**
   * Create SERVER_SETUP message (server only).
   * @param options Setup options
   * @returns SERVER_SETUP message to send
   * @throws {Error} If not in correct state or role
   */
  createServerSetup(options: {
    maxRequestId?: Varint;
    implementation?: string;
    // draft-14/16: QUIC varint — the encoder range-guards an above-range value.
    maxAuthTokenCacheSize?: bigint;
    authTokens?: Uint8Array[];
  } = {}): ServerSetup {
    if (this.role !== EndpointRole.SERVER) {
      throw new Error('Only server can create SERVER_SETUP');
    }
    if (this.state !== SessionState.SETUP_PENDING) {
      throw new Error(`Cannot create SERVER_SETUP in state ${this.state}`);
    }

    const parameters: Parameters = new Map();

    if (options.maxRequestId !== undefined) {
      parameters.set(varint(SetupParam.MAX_REQUEST_ID), [options.maxRequestId]);
    }

    if (options.implementation !== undefined) {
      parameters.set(
        varint(SetupParam.MOQT_IMPLEMENTATION),
        [new TextEncoder().encode(options.implementation)],
      );
    }

    if (options.maxAuthTokenCacheSize !== undefined) {
      parameters.set(varint(SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE), [options.maxAuthTokenCacheSize]);
    }

    if (options.authTokens !== undefined && options.authTokens.length > 0) {
      parameters.set(varint(SetupParam.AUTHORIZATION_TOKEN), options.authTokens);
    }

    this.state = SessionState.ESTABLISHED;

    return {
      type: 'SERVER_SETUP',
      parameters,
    };
  }

  /**
   * Handle received SERVER_SETUP (client only).
   * @param msg The SERVER_SETUP message
   * @returns Extracted setup parameters
   * @throws {SetupError} If validation fails
   */
  handleServerSetup(msg: ServerSetup): SetupResult {
    if (this.role !== EndpointRole.CLIENT) {
      throw new SetupError('Only client handles SERVER_SETUP', 'PROTOCOL_VIOLATION');
    }
    if (this.state !== SessionState.SETUP_PENDING) {
      throw new SetupError(
        `Cannot handle SERVER_SETUP in state ${this.state}`,
        'PROTOCOL_VIOLATION',
      );
    }

    // Server must not send PATH or AUTHORITY
    if (msg.parameters.has(SetupParam.PATH)) {
      throw new SetupError('Server sent PATH parameter', 'INVALID_PATH');
    }
    if (msg.parameters.has(SetupParam.AUTHORITY)) {
      throw new SetupError('Server sent AUTHORITY parameter', 'INVALID_AUTHORITY');
    }

    const result = this.extractSetupParams(msg.parameters, false);
    this.setupResult = result;
    this.state = SessionState.ESTABLISHED;

    return result;
  }

  /**
   * Extract known parameters from setup message.
   * Unknown parameters are ignored per §9.3.
   * AUTHORIZATION_TOKEN may appear multiple times (§9.3.1.5).
   * Other known parameters with duplicates are protocol violations.
   */
  private extractSetupParams(params: Parameters, isClientSetup: boolean): SetupResult {
    let peerMaxRequestId: Varint = varint(0); // §9.3.1.3: absent = 0 (no requests permitted)
    let peerImplementation: string | undefined;
    let path: string | undefined;
    let authority: string | undefined;
    let peerMaxAuthTokenCacheSize: Varint | undefined;
    const authTokens: AuthorizationToken[] = [];

    for (const [key, values] of params) {
      // Skip unknown parameters (§9.3: "An endpoint MUST ignore unknown setup parameters")
      // Unknown parameters are allowed to have duplicates per §9.2
      const isKnown = key === SetupParam.MAX_REQUEST_ID ||
                      key === SetupParam.MOQT_IMPLEMENTATION ||
                      key === SetupParam.PATH ||
                      key === SetupParam.AUTHORITY ||
                      key === SetupParam.AUTHORIZATION_TOKEN ||
                      key === SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE;

      if (!isKnown) {
        continue;
      }

      // AUTHORIZATION_TOKEN can have multiple values (§9.3.1.5)
      if (key === SetupParam.AUTHORIZATION_TOKEN) {
        for (const rawValue of values) {
          if (!(rawValue instanceof Uint8Array)) continue;

          // §9.2.2.1: "If the Token structure cannot be decoded, the receiver
          // MUST close the Session with KEY_VALUE_FORMATTING_ERROR."
          let token: AuthorizationToken;
          try {
            token = parseAuthorizationToken(rawValue);
          } catch {
            throw new SetupError(
              'Malformed AUTHORIZATION_TOKEN structure',
              'KEY_VALUE_FORMATTING_ERROR',
            );
          }

          // §9.2.2.1: "If a server receives Alias Type DELETE (0x0) or
          // USE_ALIAS (0x2) in a CLIENT_SETUP message, it MUST close the
          // session with a PROTOCOL_VIOLATION."
          if (isClientSetup) {
            if (token.aliasType === (AliasType.DELETE as bigint) ||
                token.aliasType === (AliasType.USE_ALIAS as bigint)) {
              throw new SetupError(
                `CLIENT_SETUP AUTHORIZATION_TOKEN cannot use Alias Type ${token.aliasType} ` +
                '(DELETE and USE_ALIAS are prohibited in CLIENT_SETUP)',
                'PROTOCOL_VIOLATION',
              );
            }
          }

          authTokens.push(token);
        }
        continue;
      }

      // Other known parameters must not have duplicates
      if (values.length > 1) {
        throw new SetupError(`Duplicate setup parameter: ${key}`, 'PROTOCOL_VIOLATION');
      }

      const value = values[0];

      if (key === SetupParam.MAX_REQUEST_ID) {
        if (typeof value === 'bigint') {
          // Request IDs are QUIC-varint range; re-validate (a raw vi64-range
          // bigint above 2^62-1 is out of range for this setup parameter).
          peerMaxRequestId = varint(value);
        }
      } else if (key === SetupParam.MOQT_IMPLEMENTATION) {
        if (value instanceof Uint8Array) {
          peerImplementation = new TextDecoder().decode(value);
        }
      } else if (key === SetupParam.MAX_AUTH_TOKEN_CACHE_SIZE) {
        // §9.3.1.4: MAX_AUTH_TOKEN_CACHE_SIZE — max bytes of token aliases
        // the peer is willing to store
        if (typeof value === 'bigint') {
          peerMaxAuthTokenCacheSize = varint(value);
        }
      } else if (key === SetupParam.PATH) {
        if (isClientSetup && value instanceof Uint8Array) {
          const pathStr = new TextDecoder().decode(value);
          this.validatePath(pathStr);
          path = pathStr;
        }
      } else if (key === SetupParam.AUTHORITY) {
        if (isClientSetup && value instanceof Uint8Array) {
          const authorityStr = new TextDecoder().decode(value);
          this.validateAuthority(authorityStr);
          authority = authorityStr;
        }
      }
    }

    const result: SetupResult = { peerMaxRequestId };
    if (peerImplementation !== undefined) {
      (result as { peerImplementation: string }).peerImplementation = peerImplementation;
    }
    if (path !== undefined) {
      (result as { path: string }).path = path;
    }
    if (authority !== undefined) {
      (result as { authority: string }).authority = authority;
    }
    if (peerMaxAuthTokenCacheSize !== undefined) {
      (result as { peerMaxAuthTokenCacheSize: bigint }).peerMaxAuthTokenCacheSize = peerMaxAuthTokenCacheSize;
    }
    if (authTokens.length > 0) {
      (result as { authTokens: AuthorizationToken[] }).authTokens = authTokens;
    }
    return result;
  }

  /**
   * Validate PATH parameter per §9.3.1.2.
   * Must be a valid path-abempty per RFC3986, optionally with query.
   * The spec explicitly allows appending ?query to PATH.
   * Valid forms: "", "/", "/path", "/path?query", "?query" (empty path with query)
   * @throws {SetupError} If path is malformed (MALFORMED_PATH)
   */
  private validatePath(path: string): void {
    // Split path and query first
    const queryIndex = path.indexOf('?');
    const pathPart = queryIndex === -1 ? path : path.slice(0, queryIndex);
    const queryPart = queryIndex === -1 ? '' : path.slice(queryIndex + 1);

    // path-abempty allows empty path, so pathPart can be ""
    // If pathPart is non-empty, it must start with '/' (absolute-path form)
    if (pathPart.length > 0 && !pathPart.startsWith('/')) {
      throw new SetupError('PATH path component must start with / or be empty', 'MALFORMED_PATH');
    }

    // Validate path part
    // path-abempty = *( "/" segment )
    // segment = *pchar
    // pchar = unreserved / pct-encoded / sub-delims / ":" / "@"
    const pathRegex = /^(\/[A-Za-z0-9\-._~!$&'()*+,;=:@%]*)*$/;
    if (!pathRegex.test(pathPart)) {
      throw new SetupError('PATH contains invalid characters', 'MALFORMED_PATH');
    }

    // Validate query part if present
    // query = *( pchar / "/" / "?" )
    if (queryPart.length > 0) {
      const queryRegex = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%\/?]*$/;
      if (!queryRegex.test(queryPart)) {
        throw new SetupError('PATH query contains invalid characters', 'MALFORMED_PATH');
      }
    }

    // Check percent encoding is valid in both parts
    const fullPath = path;
    const percentRegex = /%[0-9A-Fa-f]{2}/g;
    const strippedPath = fullPath.replace(percentRegex, '');
    if (strippedPath.includes('%')) {
      throw new SetupError('PATH contains malformed percent encoding', 'MALFORMED_PATH');
    }
  }

  /**
   * Validate AUTHORITY parameter per §9.3.1.1.
   * Must be a valid authority per RFC3986 §3.2 (includes userinfo, host, port).
   * The spec says "authority portion of the URI" and only forbids malformed values.
   * This is a lenient validator that accepts full RFC3986 authority.
   * @throws {SetupError} If authority is malformed (MALFORMED_AUTHORITY)
   */
  private validateAuthority(authority: string): void {
    if (authority.length === 0) {
      throw new SetupError('AUTHORITY cannot be empty', 'MALFORMED_AUTHORITY');
    }

    // RFC3986 authority = [ userinfo "@" ] host [ ":" port ]
    let remaining = authority;

    // Extract userinfo if present (user:password@)
    const atIndex = remaining.indexOf('@');
    if (atIndex !== -1) {
      const userinfo = remaining.slice(0, atIndex);
      remaining = remaining.slice(atIndex + 1);

      // userinfo = *( unreserved / pct-encoded / sub-delims / ":" )
      const userinfoRegex = /^[A-Za-z0-9\-._~!$&'()*+,;=:%]*$/;
      if (!userinfoRegex.test(userinfo)) {
        throw new SetupError('AUTHORITY userinfo contains invalid characters', 'MALFORMED_AUTHORITY');
      }

      // Check percent encoding in userinfo
      if (!this.hasValidPercentEncoding(userinfo)) {
        throw new SetupError('AUTHORITY userinfo has malformed percent encoding', 'MALFORMED_AUTHORITY');
      }
    }

    // Extract port if present (after last colon for non-IPv6, after ] for IPv6)
    let host = remaining;
    let port: string | undefined;

    if (remaining.startsWith('[')) {
      // IP-literal = "[" ( IPv6address / IPvFuture  ) "]"
      const bracketEnd = remaining.indexOf(']');
      if (bracketEnd === -1) {
        throw new SetupError('AUTHORITY has unclosed IP-literal bracket', 'MALFORMED_AUTHORITY');
      }
      host = remaining.slice(0, bracketEnd + 1);
      if (remaining.length > bracketEnd + 1) {
        if (remaining[bracketEnd + 1] !== ':') {
          throw new SetupError('AUTHORITY has invalid characters after IP-literal', 'MALFORMED_AUTHORITY');
        }
        port = remaining.slice(bracketEnd + 2);
      }

      // Validate IP-literal content (IPv6 or IPvFuture)
      const ipLiteral = host.slice(1, -1);

      if (ipLiteral.startsWith('v')) {
        // IPvFuture = "v" 1*HEXDIG "." 1*( unreserved / sub-delims / ":" )
        const ipvFutureRegex = /^v[0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/;
        if (!ipvFutureRegex.test(ipLiteral)) {
          throw new SetupError('AUTHORITY has invalid IPvFuture', 'MALFORMED_AUTHORITY');
        }
      } else {
        // IPv6address validation per RFC3986
        this.validateIPv6(ipLiteral);
      }
    } else {
      // reg-name or IPv4
      const colonIdx = remaining.lastIndexOf(':');
      if (colonIdx !== -1) {
        const potentialPort = remaining.slice(colonIdx + 1);
        // Port must be all digits (or empty)
        if (/^\d*$/.test(potentialPort)) {
          host = remaining.slice(0, colonIdx);
          port = potentialPort;
        }
      }

      // §3.1.2: "The authority portion MUST NOT contain an empty host portion"
      if (host.length === 0) {
        throw new SetupError('AUTHORITY MUST NOT contain an empty host portion', 'MALFORMED_AUTHORITY');
      }

      // Validate reg-name: *( unreserved / pct-encoded / sub-delims )
      const regNameRegex = /^[A-Za-z0-9\-._~!$&'()*+,;=%]*$/;
      if (!regNameRegex.test(host)) {
        throw new SetupError('AUTHORITY host contains invalid characters', 'MALFORMED_AUTHORITY');
      }

      // Check percent encoding in host
      if (!this.hasValidPercentEncoding(host)) {
        throw new SetupError('AUTHORITY host has malformed percent encoding', 'MALFORMED_AUTHORITY');
      }
    }

    // Validate port if present and non-empty
    if (port !== undefined && port.length > 0) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 0 || portNum > 65535) {
        throw new SetupError('AUTHORITY has invalid port number', 'MALFORMED_AUTHORITY');
      }
    }
  }

  /**
   * Check if a string has valid percent encoding (all % followed by 2 hex digits).
   */
  private hasValidPercentEncoding(str: string): boolean {
    const percentRegex = /%[0-9A-Fa-f]{2}/g;
    const strippedStr = str.replace(percentRegex, '');
    return !strippedStr.includes('%');
  }

  /**
   * Validate IPv6 address per RFC3986 §3.2.2 / RFC4291.
   * Rules:
   * - At most one "::" (zero-compression) is allowed
   * - "::" must compress at least one group (non-empty count < 8)
   * - Each segment is 1-4 hex digits
   * - 8 segments total when expanded (or embedded IPv4 suffix replaces last 2)
   * - No stray single ":" at start or end (must be part of "::")
   * @throws {SetupError} If IPv6 is malformed
   */
  private validateIPv6(ipv6: string): void {
    // Check for embedded IPv4 suffix (e.g., ::ffff:192.168.1.1)
    let hasIPv4Suffix = false;
    let ipv6Part = ipv6;

    // IPv4 suffix is after the last colon if it contains dots
    const lastColonIdx = ipv6.lastIndexOf(':');
    if (lastColonIdx !== -1 && ipv6.slice(lastColonIdx + 1).includes('.')) {
      const ipv4Part = ipv6.slice(lastColonIdx + 1);
      // Validate IPv4 format per RFC3986 dec-octet (no leading zeros)
      const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
      const match = ipv4Regex.exec(ipv4Part);
      if (!match) {
        throw new SetupError('AUTHORITY has invalid embedded IPv4 in IPv6', 'MALFORMED_AUTHORITY');
      }
      // Validate each octet: 0-255, no leading zeros (except "0" itself)
      for (let i = 1; i <= 4; i++) {
        const octetStr = match[i]!;
        // Reject leading zeros: "01", "001", "00", etc. (but "0" is fine)
        if (octetStr.length > 1 && octetStr[0] === '0') {
          throw new SetupError('AUTHORITY has invalid embedded IPv4 in IPv6 (leading zeros)', 'MALFORMED_AUTHORITY');
        }
        const octet = parseInt(octetStr, 10);
        if (octet > 255) {
          throw new SetupError('AUTHORITY has invalid embedded IPv4 in IPv6', 'MALFORMED_AUTHORITY');
        }
      }
      hasIPv4Suffix = true;
      // Handle the case where IPv4 directly follows :: (e.g., ::192.0.2.1, 2001:db8::192.0.2.1)
      // In this case, lastColonIdx points to the second colon of ::, so include it
      if (lastColonIdx > 0 && ipv6[lastColonIdx - 1] === ':') {
        ipv6Part = ipv6.slice(0, lastColonIdx + 1);
      } else {
        ipv6Part = ipv6.slice(0, lastColonIdx);
      }
    }

    // Three consecutive colons is always invalid
    if (ipv6Part.includes(':::')) {
      throw new SetupError('AUTHORITY IPv6 has invalid consecutive colons', 'MALFORMED_AUTHORITY');
    }

    // Count "::" occurrences - only one allowed
    const hasDoubleColon = ipv6Part.includes('::');
    const doubleColonCount = (ipv6Part.match(/::/g) || []).length;
    if (doubleColonCount > 1) {
      throw new SetupError('AUTHORITY IPv6 has multiple zero-compression (::)', 'MALFORMED_AUTHORITY');
    }

    // Split into segments
    const segments = ipv6Part.split(':');

    // Validate each segment is 1-4 hex digits (or empty for ::)
    const hexSegmentRegex = /^[0-9A-Fa-f]{1,4}$/;
    let nonEmptyCount = 0;
    const emptyIndices: number[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === '') {
        emptyIndices.push(i);
      } else {
        if (!hexSegmentRegex.test(segment!)) {
          throw new SetupError('AUTHORITY IPv6 has invalid segment', 'MALFORMED_AUTHORITY');
        }
        nonEmptyCount++;
      }
    }

    // Calculate required segments (8 for pure IPv6, 6 if IPv4 suffix)
    const requiredSegments = hasIPv4Suffix ? 6 : 8;

    if (hasDoubleColon) {
      // With ::, empty segments must be consecutive (they represent the ::)
      // Valid: "::1" → ['', '', '1'] → empties at 0,1 (consecutive)
      // Valid: "1::" → ['1', '', ''] → empties at 1,2 (consecutive)
      // Valid: "1::2" → ['1', '', '2'] → empty at 1 (single is fine)
      // Invalid: ":1::2" → ['', '1', '', '2'] → empties at 0,2 (not consecutive)
      // Invalid: "1::2:" → ['1', '', '2', ''] → empties at 1,3 (not consecutive)
      for (let i = 1; i < emptyIndices.length; i++) {
        if (emptyIndices[i] !== emptyIndices[i - 1]! + 1) {
          throw new SetupError(
            'AUTHORITY IPv6 has stray colon (empty segments not consecutive)',
            'MALFORMED_AUTHORITY',
          );
        }
      }

      // :: must compress at least one group
      // If we have 8 non-empty segments (or 6 with IPv4), :: compresses nothing → invalid
      if (nonEmptyCount >= requiredSegments) {
        throw new SetupError(
          'AUTHORITY IPv6 :: must compress at least one segment',
          'MALFORMED_AUTHORITY',
        );
      }
    } else {
      // Without ::, must have exactly the required number of segments, all non-empty
      if (segments.length !== requiredSegments) {
        throw new SetupError(
          `AUTHORITY IPv6 must have ${requiredSegments} segments, got ${segments.length}`,
          'MALFORMED_AUTHORITY',
        );
      }
      if (nonEmptyCount !== requiredSegments) {
        // Has empty segments but no :: → stray colons
        throw new SetupError('AUTHORITY IPv6 has empty segment without ::', 'MALFORMED_AUTHORITY');
      }
    }
  }
}
