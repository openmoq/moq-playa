/** Test-only postmeasurement artifact writer; no shaper/runtime dependency. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function writeScheduleCapture(data: unknown, directory = process.env['MOQ_SHAPER_ARTIFACT_DIR']
  ?? join(tmpdir(), 'openmoq-net-shaper')): Promise<string> {
  await mkdir(directory, { recursive: true });
  const runDirectory = await mkdtemp(join(directory, 'schedule-step-'));
  const file = join(runDirectory, 'raw.json');
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  return file;
}
