import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preserveUnmanagedVectors } from './stage-vectors.js';

describe('corpus staging ownership', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('preserves external fixture bytes and licenses but removes stale authored files', () => {
    const root = mkdtempSync(join(tmpdir(), 'moq-corpus-stage-'));
    roots.push(root);
    const source = join(root, 'vectors');
    const staged = join(root, 'vectors.tmp');
    mkdirSync(join(source, 'locmaf', 'objects'), { recursive: true });
    mkdirSync(join(source, 'loc'), { recursive: true });
    mkdirSync(join(staged, 'loc'), { recursive: true });
    const bytes = Uint8Array.of(0, 0xff, 0x80, 0x42);
    writeFileSync(join(source, 'locmaf', 'objects', 'frame.bin'), bytes);
    writeFileSync(join(source, 'locmaf', 'LICENSE'), 'fixture license\n');
    writeFileSync(join(source, 'loc', 'obsolete.bin'), bytes);
    writeFileSync(join(staged, 'loc', 'fresh.bin'), bytes);

    preserveUnmanagedVectors(source, staged, new Set(['loc']));

    expect(new Uint8Array(readFileSync(join(staged, 'locmaf', 'objects', 'frame.bin')))).toEqual(bytes);
    expect(readFileSync(join(staged, 'locmaf', 'LICENSE'), 'utf8')).toBe('fixture license\n');
    expect(existsSync(join(staged, 'loc', 'obsolete.bin'))).toBe(false);
    expect(new Uint8Array(readFileSync(join(staged, 'loc', 'fresh.bin')))).toEqual(bytes);
    expect(new Uint8Array(readFileSync(join(source, 'locmaf', 'objects', 'frame.bin')))).toEqual(bytes);
  });

  it('allows an initial authoring run with no existing vectors', () => {
    const root = mkdtempSync(join(tmpdir(), 'moq-corpus-stage-'));
    roots.push(root);
    expect(() => preserveUnmanagedVectors(join(root, 'absent'), join(root, 'staged'), new Set(['loc'])))
      .not.toThrow();
  });
});
