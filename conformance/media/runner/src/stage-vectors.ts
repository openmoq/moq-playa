import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Retain fixtures maintained outside this authoring script, such as LOCMAF. */
export function preserveUnmanagedVectors(
  source: string,
  staged: string,
  authoredDomains: ReadonlySet<string>,
): void {
  if (!existsSync(source)) return;
  for (const name of readdirSync(source)) {
    if (authoredDomains.has(name)) continue;
    cpSync(join(source, name), join(staged, name), { recursive: true });
  }
}
