#!/usr/bin/env node
/**
 * Generate a short-lived P-256 self-signed cert + key for the FAILS WebTransport
 * server, using openssl directly (the package's `generateWebTransportCertificate`
 * helper is NOT exported in @fails-components/webtransport@1.6.3).
 *
 * Output: PEM `cert.pem` + `key.pem` in ./certs (gitignored). Prints the SHA-256 of
 * the DER certificate — that is the value a browser client passes in
 * `serverCertificateHashes` (W3C WebTransport). The cert is intentionally valid for
 * < 14 days, which Chromium requires for `serverCertificateHashes`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const certDir = join(here, '..', 'certs');
const certPath = join(certDir, 'cert.pem');
const keyPath = join(certDir, 'key.pem');
const DAYS = 10; // < 14 days (serverCertificateHashes requirement)

function requireOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    console.error('openssl not found on PATH. Install it (e.g. `brew install openssl`) and retry.');
    process.exit(1);
  }
}

requireOpenssl();
mkdirSync(certDir, { recursive: true });

// P-256 (prime256v1) self-signed, no passphrase, SAN localhost + 127.0.0.1.
execFileSync('openssl', [
  'req', '-x509', '-nodes',
  '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
  '-keyout', keyPath, '-out', certPath,
  '-days', String(DAYS),
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: ['ignore', 'ignore', 'inherit'] });

// SHA-256 over the DER certificate == the serverCertificateHashes value.
const der = execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'der']);
const sha256 = createHash('sha256').update(der).digest();

console.log('Generated short-lived P-256 self-signed certificate:');
console.log('  cert :', certPath);
console.log('  key  :', keyPath);
console.log('  valid:', DAYS, 'days  (< 14 — required for serverCertificateHashes)');
console.log('');
console.log('serverCertificateHashes value (SHA-256 of DER cert):');
console.log('  hex   :', sha256.toString('hex'));
console.log('  base64:', sha256.toString('base64'));
console.log('');
console.log('Browser client (W3C WebTransport):');
console.log("  new WebTransport(url, {");
console.log("    serverCertificateHashes: [{ algorithm: 'sha-256', value: <Uint8Array of the 32 bytes above> }],");
console.log('  });');
