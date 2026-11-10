import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Read original certificate DER, not a key export that may normalize EC parameters.
function derChildren(contents: Uint8Array): Array<{ tag: number; contents: Uint8Array }> {
  const children: Array<{ tag: number; contents: Uint8Array }> = [];
  for (let offset = 0; offset < contents.length;) {
    const tag = contents[offset++]!;
    let length = contents[offset++]!;
    if (length & 0x80) {
      const count = length & 0x7f;
      expect(count).toBeGreaterThan(0); expect(count).toBeLessThanOrEqual(4);
      expect(offset + count).toBeLessThanOrEqual(contents.length);
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + contents[offset++]!;
    }
    expect(offset + length).toBeLessThanOrEqual(contents.length);
    children.push({ tag, contents: contents.subarray(offset, offset + length) });
    offset += length;
  }
  return children;
}

function expectNamedP256(cert: X509Certificate): void {
  const root = derChildren(cert.raw); expect(root).toHaveLength(1); expect(root[0]!.tag).toBe(0x30);
  const certificate = derChildren(root[0]!.contents);
  const tbs = derChildren(certificate[0]!.contents);
  expect(tbs[0]!.tag).toBe(0xa0); // X.509 v3 includes the explicit version field.
  const spki = derChildren(tbs[6]!.contents);
  const algorithm = derChildren(spki[0]!.contents);
  expect(algorithm).toHaveLength(2);
  expect(algorithm[0]!.tag).toBe(0x06);
  expect(Buffer.from(algorithm[0]!.contents).toString('hex')).toBe('2a8648ce3d0201'); // id-ecPublicKey
  expect(algorithm[1]!.tag, 'RFC 5480 namedCurve OID, not an explicit-parameter SEQUENCE').toBe(0x06);
  expect(Buffer.from(algorithm[1]!.contents).toString('hex')).toBe('2a8648ce3d030107'); // prime256v1
}

describe('example relay certificate ownership', () => {
  it('generates two independent run-owned certificates without touching defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'playa-cert-')); dirs.push(root);
    const scripts = join(root, 'scripts'); mkdirSync(scripts);
    const script = join(scripts, 'gen-cert.mjs');
    writeFileSync(script, readFileSync(new URL('../scripts/gen-cert.mjs', import.meta.url)));
    const certs = ['run-a', 'run-b'].map((name) => {
      const output = join(root, name);
      execFileSync(process.execPath, [script, '--out-dir', output], { stdio: 'pipe' });
      expect(existsSync(join(output, 'key.pem'))).toBe(true);
      const cert = new X509Certificate(readFileSync(join(output, 'cert.pem')));
      expectNamedP256(cert);
      expect(cert.checkHost('localhost')).toBe('localhost');
      expect(cert.checkIP('127.0.0.1')).toBe('127.0.0.1');
      expect(Date.parse(cert.validTo) - Date.parse(cert.validFrom)).toBe(10 * 24 * 60 * 60 * 1000);
      expect(Math.abs(Date.now() - Date.parse(cert.validFrom))).toBeLessThan(120_000);
      const key = createPrivateKey(readFileSync(join(output, 'key.pem')));
      expect(cert.checkPrivateKey(key)).toBe(true);
      expect(cert.verify(cert.publicKey)).toBe(true);
      return { cert, key };
    });
    expect(certs[0]!.cert.fingerprint256).not.toBe(certs[1]!.cert.fingerprint256);
    expect(certs[0]!.cert.checkPrivateKey(certs[1]!.key)).toBe(false);
    expect(existsSync(join(root, 'certs'))).toBe(false);
  });
  it('loads the explicitly selected certificate and key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'playa-cert-')); dirs.push(root);
    const cert = join(root, 'cert.pem'); const key = join(root, 'key.pem');
    writeFileSync(cert, 'run-owned certificate'); writeFileSync(key, 'run-owned key');
    vi.stubEnv('RELAY_CERT', cert); vi.stubEnv('RELAY_KEY', key); vi.resetModules();
    const { loadCert, CERT_PATH, KEY_PATH } = await import('./cert.js');
    expect(CERT_PATH).toBe(cert); expect(KEY_PATH).toBe(key);
    expect(loadCert()).toEqual({ cert: 'run-owned certificate', privKey: 'run-owned key' });
  });
});
