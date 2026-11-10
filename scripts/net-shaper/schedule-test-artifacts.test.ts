import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { writeScheduleCapture } from './schedule-test-artifacts.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('uses the configured artifact directory and preserves separate run captures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moq-shaper-artifacts-'));
  vi.stubEnv('MOQ_SHAPER_ARTIFACT_DIR', directory);
  try {
    const first = await writeScheduleCapture({ measurement: 1 });
    const second = await writeScheduleCapture({ measurement: 2 });
    expect(first).not.toBe(second);
    for (const file of [first, second]) expect(relative(directory, file).startsWith('..')).toBe(false);
    expect(JSON.parse(await readFile(first, 'utf8'))).toEqual({ measurement: 1 });
    expect(JSON.parse(await readFile(second, 'utf8'))).toEqual({ measurement: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('defaults to a portable OS-temporary directory with no repository/private path dependency', async () => {
  vi.stubEnv('MOQ_SHAPER_ARTIFACT_DIR', undefined);
  const file = await writeScheduleCapture({ packets: 625 });
  try {
    expect(relative(join(tmpdir(), 'openmoq-net-shaper'), file).startsWith('..')).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ packets: 625 });
  } finally { await rm(dirname(file), { recursive: true, force: true }); }
});
