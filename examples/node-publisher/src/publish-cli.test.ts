import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('publisher CLI catalog validation', () => {
  it('rejects legacy LOCMAF signaling before loading a fixture or connecting', () => {
    const cli = fileURLToPath(new URL('./publish-cli.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli,
      '--packaging', 'locmaf', '--catalog-format', 'msf-00', '/nonexistent-locmaf-fixture'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('LOCMAF publication requires a CMSF-01 catalog');
    expect(result.stdout).not.toContain('connecting');
    expect(result.stderr).not.toContain('fixture manifest');
  });
});
