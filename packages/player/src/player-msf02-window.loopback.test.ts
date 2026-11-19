// Real SDK loopback; native outputs use the LOC seek harness doubles.
import { expect, it, vi } from 'vitest';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

it.each([false, true])('refuses the floor outside the most restrictive MSF-02 window; zero wallclock=%s', async zero => {
  const now = 1800000000000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const catalogDocument = { version: 'draft-02', tracks: [
    { name: 'video', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.640028', bitrate: 100, framerate: 30, renderGroup: 1, accessibleWindowTime: 600000 },
    { name: 'audio', packaging: 'loc', role: 'audio', isLive: true, codec: 'opus', bitrate: 10, samplerate: 48000, channelConfig: '2', renderGroup: 1, accessibleWindowTime: 300000 },
    { name: 'timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: [1] },
  ] };
  const timeline = [0, 50000, 100000, 100001, 400000].map((pts, i) => [pts, [i + 3, 0], zero ? 0 : now - 400000 + pts] as const);
  try {
    const f = await locSeekFixture(22, true, true, { catalogDocument, timeline });
    try {
      for (const target of [50000, 99999, 100000]) await expect(f.player.seek(target)).rejects.toThrow(RangeError);
      expect(f.fetches).toEqual([]); expect(f.update).not.toHaveBeenCalled();
      await f.player.seek(100001); await flush(128);
      expect(f.fetches.map(t => [t.name, t.group, t.object])).toEqual([['video', 6n, 0n], ['audio', 6n, 0n]]);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  } finally { clock.mockRestore(); }
});


it.each([false, true])('uses timeline time with descending group identifiers; zero wallclock=%s', async zero => {
  const now = 1800000000000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const catalogDocument = { version: 'draft-02', tracks: [
    { name: 'video', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.640028', bitrate: 100,
      framerate: 30, accessibleWindowTime: 300000 },
    { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['video'] },
  ] };
  const timeline = [[0, [100, 0], zero ? 0 : now - 400000],
    [200000, [3, 0], zero ? 0 : now - 200000], [400000, [1, 0], zero ? 0 : now]] as const;
  try {
    const f = await locSeekFixture(22, false, true, { catalogDocument, timeline });
    try {
      await expect(f.player.seek(0)).rejects.toThrow(RangeError);
      expect(f.fetches).toEqual([]);
      await f.player.seek(400000); await flush(128);
      expect(f.fetches.map(t => [t.name, t.group])).toEqual([['video', 1n]]);
    } finally { await f.destroy(); }
  } finally { clock.mockRestore(); }
});
