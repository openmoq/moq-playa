// Real SDK loopback with the existing modeled LOC seek outputs.
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

function catalog(namespace?: string) {
  const fixture = JSON.parse(readFileSync(new URL('../../msf/src/fixtures/moqxr-msf02/loc-avc-aac.catalog.json', import.meta.url), 'utf8'));
  // Use the harness's media names; preserve the fixture's render-group dependency.
  fixture.tracks = fixture.tracks.filter((t: { packaging: string }) => t.packaging !== 'eventtimeline');
  for (const t of fixture.tracks) {
    if (t.role === 'video') t.name = 'video';
    if (t.role === 'audio') t.name = 'audio';
    if (t.packaging !== 'mediatimeline' && namespace) t.namespace = namespace;
  }
  return fixture;
}

it.each([18, 22] as const)('seeks through MSF-02 render-group dependencies on draft %i', async draft => {
  const f = await locSeekFixture(draft, true, true, { catalogDocument: catalog('media/source') });
  try {
    expect(f.player.seekable).toBe(true);
    await f.player.seek(2000); await flush(128);
    expect(f.fetches).toEqual([
      { namespace: ['media', 'source'], name: 'video', group: 3n, object: 0n },
      { namespace: ['media', 'source'], name: 'audio', group: 3n, object: 0n },
    ]);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});
