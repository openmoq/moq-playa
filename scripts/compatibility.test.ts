import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const directories = ['transport', 'webtransport', 'quic', 'loc', 'locmaf', 'msf', 'playback', 'player', 'browser', 'playa'];

describe('legacy package compatibility', () => {
  it.each(directories)('%s preserves exports and delegates to one canonical package', (directory) => {
    const canonical = JSON.parse(readFileSync(resolve(root, 'packages', directory, 'package.json'), 'utf8'));
    const path = resolve(root, 'packages', `compat-${directory}`);
    const legacy = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
    expect(legacy.name).toBe(directory === 'playa' ? '@playa/player' : `@moqt/${directory}`);
    expect(legacy.version).toBe(canonical.version);
    expect(legacy.dependencies).toEqual({ [canonical.name]: 'workspace:*' });
    expect(Object.keys(legacy.exports)).toEqual(Object.keys(canonical.exports));
    expect(legacy.engines).toEqual(canonical.engines);
    expect(legacy.scripts?.postinstall).toBeUndefined();
    for (const [subpath, entry] of Object.entries(legacy.exports) as Array<[string, Record<string, string>]>) {
      const target = `${canonical.name}${subpath === '.' ? '' : subpath.slice(1)}`;
      expect(readFileSync(resolve(path, entry.import!), 'utf8')).toBe(`export * from '${target}';\n`);
      const typesTarget = canonical.name;
      expect(readFileSync(resolve(path, entry.types!), 'utf8')).toBe(`export * from '${typesTarget}';\n`);
    }
  });
});
