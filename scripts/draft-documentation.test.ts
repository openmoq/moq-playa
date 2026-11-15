import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const qualification = 'opt-in, not tested against an independent draft-23 peer';
it('qualifies draft 23 in development documentation and package draft lists', () => {
  const guide = readFileSync(resolve(root, 'docs/draft-development.md'), 'utf8');
  expect(guide).toContain(qualification);
  expect(guide).toContain('default remains draft 16');
  for (const dir of readdirSync(resolve(root, 'packages'))) {
    const manifest = JSON.parse(readFileSync(resolve(root, 'packages', dir, 'package.json'), 'utf8'));
    if (manifest.private || !manifest.description.includes('draft-14/16/18')) continue;
    const readme = readFileSync(resolve(root, 'packages', dir, 'README.md'), 'utf8');
    expect(readme, dir).toContain(qualification);
    expect(readme, dir).toContain('draft-14/16/18/22');
  }
});
