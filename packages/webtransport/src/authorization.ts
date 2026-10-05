import {
  AliasType, encodeAuthorizationToken, encodeAuthorizationToken18, isRequestStreamDraft,
  type DraftVersion,
} from '@openmoq/transport';

/** Opaque issuer-supplied bytes. The relay, not the client, validates the claims. */
export interface AuthorizationToken {
  readonly tokenType: bigint;
  readonly value: Uint8Array;
}

/** CAT4MOQ draft-01 section 7.1.1. This does not mint or validate a CAT. */
export function catToken(value: Uint8Array): AuthorizationToken {
  return { tokenType: 1n, value: Uint8Array.from(value) };
}

export type AuthorizationOperation =
  | 'SETUP' | 'SUBSCRIBE' | 'PUBLISH' | 'FETCH' | 'REQUEST_UPDATE'
  | 'PUBLISH_NAMESPACE' | 'SUBSCRIBE_NAMESPACE' | 'SUBSCRIBE_TRACKS' | 'TRACK_STATUS';

export interface AuthorizationContext {
  readonly operation: AuthorizationOperation;
  readonly draftVersion: DraftVersion;
  /** Actual destination of this connection, including any migration. */
  readonly relayUrl: string;
  /** Namespace field boundaries and arbitrary bytes are preserved. */
  readonly namespace?: readonly Uint8Array[];
  readonly trackName?: Uint8Array;
  readonly existingRequestId?: bigint;
  readonly signal: AbortSignal;
}

export type AuthorizationProvider = (context: AuthorizationContext) =>
  readonly AuthorizationToken[] | Promise<readonly AuthorizationToken[]>;

export interface ConnectionAuthorization {
  readonly relayUrl: string;
  readonly getTokens: AuthorizationProvider;
  /** Credential acquisition deadline, 1..2147483647 ms. Default 10 seconds. */
  readonly timeoutMs?: number;
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

type OperationContext = Omit<AuthorizationContext, 'relayUrl' | 'signal'>;

/** Per-connection ownership of pending credential work; never caches credentials. */
export class AuthorizationSession {
  private readonly pending = new Set<AbortController>();
  private readonly timeoutMs: number;
  private closed = false;
  private readonly options: ConnectionAuthorization;

  constructor(options: ConnectionAuthorization) {
    this.options = { ...options };
    let url: URL;
    try { url = new URL(options.relayUrl); }
    catch { throw new AuthorizationError('Authorization requires a valid relay URL'); }
    if (!['https:', 'moqt:'].includes(url.protocol) || url.username || url.password || options.relayUrl.includes('#')) {
      throw new AuthorizationError('Authorization requires an https or moqt relay URL without credentials or fragment');
    }
    if (typeof options.getTokens !== 'function') throw new AuthorizationError('Authorization requires a credential provider');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new AuthorizationError('Authorization timeout must be an integer from 1 to 2147483647 ms');
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
  }

  async resolve(context: OperationContext): Promise<Uint8Array[]> {
    if (this.closed) throw new AuthorizationError('Authorization connection closed');
    if (this.pending.size >= 64) throw new AuthorizationError('Too many pending authorization requests');
    const controller = new AbortController();
    this.pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort!: () => void;
    let timedOut = false;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AuthorizationError(timedOut ? 'Authorization timed out' : 'Authorization connection closed'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    });
    try {
      const providerContext: AuthorizationContext = {
        ...context,
        ...(context.namespace ? { namespace: context.namespace.map(field => Uint8Array.from(field)) } : {}),
        ...(context.trackName ? { trackName: Uint8Array.from(context.trackName) } : {}),
        relayUrl: this.options.relayUrl,
        signal: controller.signal,
      };
      // A provider may include credentials in an exception. Do not propagate its
      // text or cause into application logs and exported traces.
      const acquired = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new AuthorizationError('Authorization connection closed');
        return this.options.getTokens(providerContext);
      })
        .catch(() => { throw new AuthorizationError('Authorization provider failed'); });
      const tokens = await Promise.race([acquired, cancelled]);
      if (this.closed || controller.signal.aborted) throw new AuthorizationError('Authorization connection closed');
      if (!Array.isArray(tokens) || tokens.length === 0) throw new AuthorizationError('Authorization provider returned no credentials');
      if (tokens.length > 16) throw new AuthorizationError('Too many authorization tokens');
      // Drafts 18 and later encode the token's integers as vi64.
      const encode = isRequestStreamDraft(context.draftVersion) ? encodeAuthorizationToken18 : encodeAuthorizationToken;
      const encoded: Uint8Array[] = [];
      let totalBytes = 0;
      for (const token of tokens) {
        if (!token || typeof token.tokenType !== 'bigint' || !(token.value instanceof Uint8Array) || token.value.length === 0) {
          throw new AuthorizationError('Invalid authorization credential');
        }
        totalBytes += token.value.length;
        if (totalBytes > 32_768) throw new AuthorizationError('Authorization credentials exceed 32 KiB');
        let wire: Uint8Array;
        try {
          wire = encode({ aliasType: AliasType.USE_VALUE, tokenType: token.tokenType, tokenValue: token.value });
        } catch { throw new AuthorizationError('Invalid authorization token type'); }
        if (encoded.some(prior => prior.length === wire.length && prior.every((byte, i) => byte === wire[i]))) {
          throw new AuthorizationError('Authorization provider returned duplicate credentials');
        }
        encoded.push(wire);
      }
      return encoded;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      this.pending.delete(controller);
    }
  }
}
