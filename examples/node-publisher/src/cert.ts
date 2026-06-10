/**
 * Cert pinning for connecting to the node-relay example.
 *
 * A WebTransport CLIENT must pin the SERVER's certificate hash, so this reads the
 * relay's generated cert (see node-relay's `gen-cert`). That is a deliberate
 * file-path dependency on the relay's cert OUTPUT — not a code dependency on the
 * relay package. Override with RELAY_CERT=/path/to/cert.pem.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const RELAY_CERT_PATH = resolve(
  process.env.RELAY_CERT ?? join(here, '..', '..', 'node-relay', 'certs', 'cert.pem'),
);

export function relayCertExists(): boolean {
  return existsSync(RELAY_CERT_PATH);
}

/** SHA-256 of the relay's DER cert — the serverCertificateHashes value, returned
 *  over a concrete ArrayBuffer so it satisfies the W3C `BufferSource` type. */
export function relayCertSha256(): Uint8Array<ArrayBuffer> {
  if (!relayCertExists()) {
    throw new Error(
      `relay cert not found at ${RELAY_CERT_PATH} — run \`pnpm --filter @moqt/example-node-relay gen-cert\` first (or set RELAY_CERT).`,
    );
  }
  void readFileSync(RELAY_CERT_PATH); // fail early with a clear error if unreadable
  const der = execFileSync('openssl', ['x509', '-in', RELAY_CERT_PATH, '-outform', 'der']);
  const digest = createHash('sha256').update(der).digest();
  const out = new Uint8Array(digest.length);
  out.set(digest);
  return out;
}
