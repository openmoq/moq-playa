import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, landHistory } from '../test-support/seek-live-mse.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

afterEach(() => vi.restoreAllMocks());

// Real player/transport seek ownership; the adapter models a hole reaching its
// escalation bound. Its recovery double would seek if the player authorized it.
describe.each([18, 22] as const)('escalated gap during owned MSE seek, draft %s', draft => {
  it.each(['preparing', 'landed'] as const)('keeps fatal escalation while %s', async phase => {
    const f = await fixture(draft, true);
    try {
      if (phase === 'landed') await landHistory(f);
      else { await f.player.seek(5000); await flush(512); expect(f.fetches).toHaveLength(1); }
      let seeks = 0;
      f.source.tryRecoverBufferedGap = () => { seeks++; return true; };
      const fatal: string[] = [];
      f.player.on('error', event => { if (event.error.severity === 'fatal') fatal.push(event.error.message); });
      const error = new Error('unexplained buffered hole at its escalation bound');
      error.name = 'MediaGapUnrecoverableError';
      f.source.onError!(error);
      expect(seeks).toBe(0);
      expect(fatal).toEqual([error.message]);
    } finally { await f.destroy(); }
  });
});
