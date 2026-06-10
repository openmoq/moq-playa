/**
 * Cert helpers shared by server/client/smoke. The certs are produced by
 * `scripts/gen-cert.mjs` (openssl, P-256, short-lived) into ./certs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const certDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'certs');
export const CERT_PATH = join(certDir, 'cert.pem');
export const KEY_PATH = join(certDir, 'key.pem');

export function certsExist(): boolean {
  return existsSync(CERT_PATH) && existsSync(KEY_PATH);
}

/** PEM cert + private key for the Http3Server constructor. */
export function loadCert(): { cert: string; privKey: string } {
  if (!certsExist()) {
    throw new Error('Missing ./certs — run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
  }
  return { cert: readFileSync(CERT_PATH, 'utf8'), privKey: readFileSync(KEY_PATH, 'utf8') };
}

/** SHA-256 of the DER cert — the value a client passes in serverCertificateHashes.
 *  Returned over a concrete ArrayBuffer so it satisfies the W3C `BufferSource` type. */
export function certSha256(): Uint8Array<ArrayBuffer> {
  const der = execFileSync('openssl', ['x509', '-in', CERT_PATH, '-outform', 'der']);
  const digest = createHash('sha256').update(der).digest();
  const out = new Uint8Array(digest.length);
  out.set(digest);
  return out;
}
