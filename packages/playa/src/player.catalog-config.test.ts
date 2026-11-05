import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Player } from './player.js';
import type { PlayerOptions } from './types.js';

beforeEach(() => { vi.stubGlobal('document', { hidden: false, removeEventListener() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });

it('accepts facade options that omit the catalog name', async () => {
  const options: PlayerOptions = { url: 'https://catalog.invalid/live', namespace: 'catalog/normalization' };
  const player = new Player(null, options);
  await player.destroy();
  expect(options).not.toHaveProperty('catalogTrackName');
});

it.each([null, 42, '\ud800'])('refuses invalid facade catalog name %j instead of replacing it with the default', async value => {
  const options: PlayerOptions = { url: 'https://catalog.invalid/live', namespace: 'catalog/normalization' };
  Reflect.set(options, 'catalogTrackName', value);
  let player: Player | undefined;
  try {
    expect(() => { player = new Player(null, options); }).toThrow(/catalogTrackName|UTF-8|surrogate/);
  } finally { await player?.destroy(); }
});
