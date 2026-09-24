import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const WEBTRANSPORT_VERIFICATION_NOTE =
  'NOTE: TLS_DISABLE_VERIFY=1 requested but the certificate verified normally; verification was NOT disabled';

const WEBTRANSPORT_SKIP_VERIFY_LIMITATION =
  '@fails-components/webtransport 1.6.7 exposes serverCertificateHashes but no documented option to skip certificate verification';

interface LoadedWebTransportModule {
  readonly quicheLoaded?: PromiseLike<unknown>;
  readonly WebTransport: new (url: string, options: Record<string, unknown>) => {
    readonly ready: PromiseLike<void>;
  };
}

export interface InteropWebTransportOptions {
  readonly protocols?: readonly string[];
  readonly disableCertificateVerification: boolean;
  readonly certificatePath: string;
  readonly onTapComment?: (message: string) => void;
}

export interface InteropWebTransportDependencies {
  readonly loadWebTransport: () => Promise<LoadedWebTransportModule>;
  readonly readCertificate: (path: string) => string;
}

const WEBTRANSPORT_DEFAULTS: InteropWebTransportDependencies = {
  loadWebTransport: async () => await import('@fails-components/webtransport') as unknown as LoadedWebTransportModule,
  readCertificate: (path) => readFileSync(path, 'utf8'),
};

function isMissingCertificate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = String((error as { code?: unknown }).code);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function certificateHash(pem: string, path: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!b64) throw new Error(`TLS_DISABLE_VERIFY=1 but ${path} holds no certificate`);
  const der = Buffer.from(b64, 'base64');
  if (der.length === 0) throw new Error(`TLS_DISABLE_VERIFY=1 but ${path} is malformed`);
  return new Uint8Array(createHash('sha256').update(der).digest());
}

/**
 * Connect the interop cell's WebTransport backend under the runner's TLS flag.
 * Environment parsing remains in main.ts; this boundary receives explicit
 * policy inputs and never weakens verification when the backend cannot do so.
 */
export async function connectInteropWebTransport(
  url: string,
  options: InteropWebTransportOptions,
  dependencies: InteropWebTransportDependencies = WEBTRANSPORT_DEFAULTS,
): Promise<InstanceType<LoadedWebTransportModule['WebTransport']>> {
  const wt = await dependencies.loadWebTransport();
  if (wt.quicheLoaded) await wt.quicheLoaded;

  const constructorOptions: Record<string, unknown> = {};
  if (options.protocols) constructorOptions.protocols = [...options.protocols];

  let usedOrdinaryVerificationFallback = false;
  if (options.disableCertificateVerification) {
    let pem: string;
    try {
      pem = dependencies.readCertificate(options.certificatePath);
    } catch (error) {
      if (!isMissingCertificate(error)) {
        throw new Error(
          `TLS_DISABLE_VERIFY=1 but ${options.certificatePath} is unreadable: ${errorMessage(error)}`,
        );
      }
      usedOrdinaryVerificationFallback = true;
      pem = '';
    }
    if (!usedOrdinaryVerificationFallback) {
      constructorOptions.serverCertificateHashes = [{
        algorithm: 'sha-256',
        value: certificateHash(pem, options.certificatePath),
      }];
    }
  }

  try {
    const transport = new wt.WebTransport(url, constructorOptions);
    await transport.ready;
    if (usedOrdinaryVerificationFallback) {
      options.onTapComment?.(WEBTRANSPORT_VERIFICATION_NOTE);
    }
    return transport;
  } catch (error) {
    if (!usedOrdinaryVerificationFallback) throw error;
    throw new Error(
      `TLS_DISABLE_VERIFY=1 could not be honored: ${WEBTRANSPORT_SKIP_VERIFY_LIMITATION}; `
      + `ordinary WebTransport verification failed: ${errorMessage(error)}`,
    );
  }
}

export interface RelayTransportFactories {
  readonly webtransport: (url: string, draft: number) => Promise<any>;
  readonly quic: (url: string) => Promise<any>;
}

/** Return the unconditional TAP diagnostic required for an insecure QUIC run. */
export function transportSecurityDiagnostic(
  url: string,
  disableVerification: boolean,
): string | undefined {
  if (!disableVerification || new URL(url).protocol !== 'moqt:') return undefined;
  return 'WARNING: native QUIC certificate verification disabled by TLS_DISABLE_VERIFY=1';
}

/** Select the transport solely from the URI scheme; never fall back. */
export async function selectRelayTransport(
  url: string,
  draft: number,
  factories: RelayTransportFactories,
): Promise<any> {
  const scheme = new URL(url).protocol;
  if (scheme === 'https:') {
    return factories.webtransport(url, draft);
  }
  if (scheme === 'moqt:') {
    if (draft !== 18) throw new Error(`native QUIC supports draft 18 only, not draft ${draft}`);
    const transport = await factories.quic(url);
    if (transport?.kind !== 'quic') {
      throw new Error('native QUIC factory returned a transport without kind="quic"');
    }
    return transport;
  }
  throw new Error(`unsupported relay URL scheme ${JSON.stringify(scheme)}; expected https: or moqt:`);
}
