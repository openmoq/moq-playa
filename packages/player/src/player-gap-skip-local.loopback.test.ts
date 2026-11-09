/**
 * A pipeline gap skip must continue locally, not resubscribe that one track from
 * the live edge; an explicit custom RecoveryController returning `resubscribe` must still execute (healthy control).
 */
import { describe, expect, it } from 'vitest';
import { liveLocFixture } from '../test-support/live-loc.js';
import type { RecoveryController } from '@openmoq/playback';

describe('gap skip recovery on a live LOC audio track (real SDK loopback)', () => {
  it('a skipped missing group continues from the buffered group: no NextGroupStart REQUEST_UPDATE for that track', async () => {
    const f = await liveLocFixture();
    try {
      const skips: unknown[] = []; f.player.on('skip_forward', e => skips.push(e));
      await f.send('a', 0n); f.tick();
      await f.send('a', 2n);                                   // group 1 never arrives
      for (let i = 0; i < 100 && skips.length === 0; i++) f.tick(1);
      await new Promise(r => setTimeout(r, 0));
      expect(skips.length, 'the pipeline skipped the missing group').toBeGreaterThan(0);
      const audioId = f.requestOf('a')!.id;
      const liveEdge = f.update.mock.calls.filter(c => BigInt(c[0] as bigint) === audioId && (c[1] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'NextGroupStart');
      expect(liveEdge, 'a gap skip must not be followed by a live-edge resubscribe').toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('control — a custom RecoveryController answering a gap with resubscribe still gets its fresh subscription start', async () => {
    const controller: RecoveryController = { evaluate: trigger => trigger.type === 'gap' ? { type: 'resubscribe' } : { type: 'skip_forward' } };
    const f = await liveLocFixture({ createRecoveryController: () => controller });
    try {
      await f.send('a', 0n); f.tick();
      await f.send('a', 2n);
      for (let i = 0; i < 100 && f.update.mock.calls.length === 0; i++) f.tick(1);
      await new Promise(r => setTimeout(r, 0));
      const audioId = f.requestOf('a')!.id;
      const liveEdge = f.update.mock.calls.filter(c => BigInt(c[0] as bigint) === audioId && (c[1] as { subscriptionFilter?: { type?: string } })?.subscriptionFilter?.type === 'NextGroupStart');
      expect(liveEdge.length, 'explicit resubscribe must be executed').toBe(1);
    } finally { await f.close(); }
  });
});
