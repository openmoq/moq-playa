import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture } from './startup-lifecycle-support.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Actual page initialization and startup, with modeled window and player APIs.
it.each(['?ns=live', '?ns=other', '?nsField=other', '?ns=other&nsField=elsewhere'])('uses the fragment over %s at player startup', async search => {
  const f = fixture(undefined, { hash: '#msf:live--catalog.2dv2&c4m=YWJj', search });
  try {
    await f.context.startPlayback();
    expect(f.playerOptions).toHaveLength(1);
    expect(f.playerOptions[0]).toMatchObject({ namespace: ['live'], catalogTrackName: 'catalog-v2' });
    expect(f.logs.filter(line => line.includes('ignored in favor'))).toEqual([
      'MSF URL: ?ns= and ?nsField= are ignored in favor of the fragment',
    ]);
    expect(f.logs.join('\n')).not.toContain('YWJj');
  } finally {
    await f.close();
  }
});

it.each([
  ['#top', '#bottom', 0],
  ['', '#top', 0],
  ['#msf:live--catalog', '#msf:live--catalog', 0],
  ['#top', '#msf:live--catalog', 1],
  ['#msf:live--catalog', '#top', 1],
  ['#msf:live--catalog', '#msf:other--catalog', 1],
  ['#msf:live--catalog&c4m=YQ', '#msf:live--catalog&c4m=Yg', 1],
  ['#msf:live', '#msf:live--catalog', 1],
  ['#MSF:live--catalog', '#top', 1],
])('reloads only for an MSF link change: %s → %s', async (oldHash, newHash, count) => {
  const f = fixture(undefined, { hash: oldHash, search: '' });
  try {
    expect(f.hashListeners).toHaveLength(1);
    for (const listener of f.hashListeners) {
      listener({ oldURL: `https://player.test/${oldHash}`, newURL: `https://player.test/${newHash}` });
    }
    expect(f.reload).toHaveBeenCalledTimes(count);
  } finally {
    await f.close();
  }
});
