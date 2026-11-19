// Real SDK seek retrieval with modeled outputs.
import { expect, it, vi } from 'vitest';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

it.each([false, true])('anchors group-start retrieval on the indexed object; zero wallclock=%s', async zero => {
  const now = 1800000000000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const catalogDocument = { version: 'draft-02', tracks: [
    { name: 'video', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.640028', bitrate: 100, framerate: 30,
      accessibleWindowTime: 600000 },
    { name: 'timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['video'] },
  ] };
  const timeline = [[0, [3, 0], zero ? 0 : zero ? 0 : now - 100000], [2000, [4, 5], zero ? 0 : now - 50000], [4000, [5, 0], zero ? 0 : now - 10000]] as const;
  try {
    const f = await locSeekFixture(22, false, true, { catalogDocument, timeline });
    try {
      await f.player.seek(2000); await flush(128);
      expect(f.fetches.map(t => [t.group, t.object])).toEqual([[4n, 0n]]);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  } finally { clock.mockRestore(); }
});
