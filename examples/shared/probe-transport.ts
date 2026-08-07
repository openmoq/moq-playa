/**
 * Example-local cancellable WebTransport connector for endpoint discovery.
 *
 * Acceptance behavior deliberately MIRRORS the shared factory in
 * packages/browser/src/webtransport-factory.ts — same cert-hash pinning,
 * same WT-Available-Protocols offer (`moqt-<v>` for v ≥ 15, `moqt-16` by
 * default, none for draft 14), same strict-UA retry without protocols — so
 * probes and real connections apply the same compatibility rules.
 * The duplication is intentional: discovery is an example convenience, and
 * the published package must not grow abort/probe API for it (this pointer
 * is one-way; the package knows nothing of this module).
 *
 * What the factory does not have — and probes need — is cancellation:
 * per W3C WebTransport, `close()` may be called while the transport is
 * still connecting, which aborts the handshake and rejects `ready`.
 */

/** Options for one probe. */
export interface ProbeOptions {
  /** SHA-256 certificate hash for self-signed relays. */
  readonly certHash?: ArrayBuffer;
  /** MOQT draft version, controlling the WT protocols offer. */
  readonly draftVersion?: 14 | 16 | 18;
  /** Abort the handshake: closes the connecting transport, rejects with `signal.reason`. */
  readonly signal?: AbortSignal;
}

/** A successfully established probe session; only `close()` is ever used. */
export interface ProbeSession {
  close(): void;
}

function buildOptions(options: ProbeOptions | undefined, withProtocols: boolean): WebTransportOptions {
  const opts: WebTransportOptions & { protocols?: string[] } = {};
  if (options?.certHash) {
    opts.serverCertificateHashes = [{ algorithm: 'sha-256', value: options.certHash }];
  }
  if (!withProtocols) return opts;
  // Mirror of the factory's offer policy (see module doc comment).
  if (options?.draftVersion && options.draftVersion >= 15) {
    opts.protocols = [`moqt-${options.draftVersion}`];
  } else if (!options?.draftVersion) {
    opts.protocols = ['moqt-16'];
  }
  // draft 14: no protocols — h3 ALPN with in-band CLIENT_SETUP negotiation.
  return opts;
}

interface TransportLike {
  readonly ready: Promise<void>;
  readonly closed?: { catch?: (fn: (reason: unknown) => void) => unknown };
  close(info?: { closeCode?: number; reason?: string }): void;
}

function safeClose(transport: TransportLike): void {
  try {
    transport.close({ closeCode: 0, reason: 'endpoint probe' });
  } catch {
    // Double-close or a post-failure close may throw; the probe is done either way.
  }
}

/** One handshake attempt; resolves with the OPEN transport, rejects on failure/abort. */
async function attempt(
  url: string,
  options: ProbeOptions | undefined,
  withProtocols: boolean,
): Promise<TransportLike> {
  const signal = options?.signal;
  const transport = new WebTransport(url, buildOptions(options, withProtocols)) as unknown as TransportLike;
  // Park `closed`: it rejects on handshake failure and on close() of an
  // established session; unobserved, that spams strict UAs' consoles.
  transport.closed?.catch?.(() => {});
  if (!signal) {
    await transport.ready;
    return transport;
  }
  // Close the connecting transport when aborted. The listener is removed on
  // every settlement path.
  let rejectOnAbort!: (reason: unknown) => void;
  const abortRace = new Promise<never>((_, reject) => { rejectOnAbort = reject; });
  const onAbort = (): void => {
    safeClose(transport);
    rejectOnAbort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([transport.ready, abortRace]);
  } catch (err) {
    // Abort wins over whatever the closed handshake rejected with.
    throw signal.aborted ? signal.reason : err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) {
    // Abort landed between ready resolving and this check: don't leak the session.
    safeClose(transport);
    throw signal.reason;
  }
  return transport;
}

/**
 * Probe `url` with one cancellable handshake attempt sequence.
 *
 * Resolves with a session whose only use is `close()`. Rejects with the
 * abort reason when cancelled, or with an error naming both failures when
 * the offered-protocols attempt and its no-protocols retry both fail.
 */
export async function probeTransport(url: string, options?: ProbeOptions): Promise<ProbeSession> {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;

  const offersProtocols = options?.draftVersion !== 14;
  let transport: TransportLike;
  try {
    transport = await attempt(url, options, true);
  } catch (err) {
    // An abort must never be misread as a protocol-negotiation failure.
    if (signal?.aborted) throw signal.reason;
    if (!offersProtocols) throw err;
    // Strict-UA fallback (mirrors the shared factory): MOQT negotiates its
    // version in-band via CLIENT_SETUP, so retry once without offering.
    try {
      transport = await attempt(url, options, false);
    } catch (retryErr) {
      if (signal?.aborted) throw signal.reason;
      throw new Error(
        `${(err as Error)?.message ?? err} (retry without protocols also failed: ${(retryErr as Error)?.message ?? retryErr})`,
      );
    }
  }

  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      safeClose(transport);
    },
  };
}
