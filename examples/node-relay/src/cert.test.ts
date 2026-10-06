import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
      return new X509Certificate(readFileSync(join(output, 'cert.pem'))).fingerprint256;
    });
    expect(certs[0]).not.toBe(certs[1]);
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
