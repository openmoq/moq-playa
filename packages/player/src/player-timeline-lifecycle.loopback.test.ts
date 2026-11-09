import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture } from '../test-support/player-timeline-lifecycle.fixture.js';
import { MoqtPlayer } from './player.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

afterEach(() => vi.restoreAllMocks());
function read(object: object, key: string): unknown { return Reflect.get(object, key); }
function set(object: object, key: string, value: unknown): void { Reflect.set(object, key, value); }
function mseAttempt(connection: unknown, cancel: () => void, playbackCancel = vi.fn()) {
  return { connection, retired: false, bridges: new Set(), retrievals: new Map([['video', { cancel, requests: { handleStreamClose: () => false, handleStreamOpen: () => false, handleControl: () => false } }]]),
    preparingRetrievals: new Set(), playback: { cancel: playbackCancel } };
}

describe('timeline and close ownership', () => {
  it.each([false, true])('real SDK close attempts later cleanup and publishes session_closed (injected failure=%s)', async throwing => {
    const f = await fixture(18), closed = vi.fn(), first = new Error('owned retrieval cancellation failed');
    const later = vi.fn(), native = vi.fn();
    f.player.on('session_closed', closed);
    // Controlled failure injection: actual onClose and retireMseSeek bodies run.
    set(f.player, 'preparingMseSeek', mseAttempt(f.client, () => { if (throwing) throw first; }));
    set(f.player, 'activeMseSeek', mseAttempt(f.client, later, native));
    try {
      await f.disconnect();
      expect.soft(later, 'later captured seek retrieval must retire').toHaveBeenCalledOnce();
      expect.soft(native, 'later captured seek playback must cancel').toHaveBeenCalledOnce();
      expect.soft(closed, 'mandatory public session completion must publish').toHaveBeenCalledOnce();
      expect(f.player.seekable).toBe(false);
    } finally {
      set(f.player, 'preparingMseSeek', null); set(f.player, 'activeMseSeek', null);
      await f.destroy();
    }
  });

  it.each([false, true])('direct retirement attempts every captured owner and playback (injected failure=%s)', async throwing => {
    const f = await fixture(18), failure = new Error('first owner failed');
    const second = vi.fn(), preparing = vi.fn(), native = vi.fn();
    const attempt = mseAttempt(f.client, () => { if (throwing) throw failure; }, native);
    attempt.retrievals.set('audio', { ...attempt.retrievals.get('video')!, cancel: second });
    const controlled = { ...attempt, preparingRetrievals: new Set([{ cancel: preparing }]) };
    const retire = read(f.player, 'retireMseSeek') as (attempt: unknown) => void;
    try {
      let caught: unknown;
      try { retire.call(f.player, controlled); } catch (error) { caught = error; }
      expect(caught, 'original failure identity after cleanup').toBe(throwing ? failure : undefined);
      expect.soft(second, 'second owned retrieval').toHaveBeenCalledOnce();
      expect.soft(preparing, 'preparing owned retrieval').toHaveBeenCalledOnce();
      expect.soft(native, 'owned native playback').toHaveBeenCalledOnce();
    } finally { await f.destroy(); }
  });

  it('captured old timeline rollback cannot revoke a successor with the same numeric request ID', async () => {
    type Aux = (ns: Uint8Array[], name: Uint8Array, options: unknown, info: { mediaType: string },
      registered?: (id: bigint) => void, rolledBack?: (id: bigint) => void) => Promise<bigint | undefined>;
    const prototype = MoqtPlayer.prototype as unknown as { subscribeAuxTrackOwned: Aux };
    const original = prototype.subscribeAuxTrackOwned;
    let rollback: ((id: bigint) => void) | undefined;
    const spy = vi.spyOn(prototype, 'subscribeAuxTrackOwned').mockImplementation(function(this: MoqtPlayer, ...args: Parameters<Aux>) {
      if (args[3].mediaType === 'mediatimeline') rollback = args[5];
      return original.apply(this, args);
    });
    const old = await fixture(18); spy.mockRestore();
    const successor = await fixture(18);
    const fields = ['connection', 'timelineSource', 'timelineState', 'timelineRequestId', 'activeSubscriptions'] as const;
    const saved = fields.map(field => read(old.player, field));
    try {
      const id = read(old.player, 'timelineRequestId');
      expect(typeof id).toBe('bigint'); expect(read(successor.player, 'timelineRequestId')).toBe(id);
      expect(rollback).toBeTypeOf('function');
      // Controlled adoption seam: real accepted SDK timeline/connection from a
      // second loopback replaces authority; invoke the actual old closure.
      for (const field of fields) set(old.player, field, read(successor.player, field));
      expect(old.player.seekable).toBe(true);
      rollback!(id as bigint);
      expect(old.player.seekable, 'successor timeline remains publicly admissible').toBe(true);
    } finally {
      fields.forEach((field, index) => set(old.player, field, saved[index]));
      await old.destroy(); await successor.destroy();
    }
  });

  it('real timeline delivery publishes no updated event after a controlled pump destroys the player', async () => {
    const f = await fixture(18), updated = vi.fn(); let destruction: Promise<void> | undefined;
    f.player.on('timeline_updated', updated);
    const pump = vi.fn(() => {
      set(f.player, 'preparingMseSeek', null);
      destruction = f.player.destroy(); void destruction.catch(() => {});
    });
    // Pump scheduling is the controlled seam; wire parsing and callback delivery are real SDK.
    set(f.player, 'preparingMseSeek', { pump });
    try {
      await f.sendTimeline(); await destruction;
      expect(pump).toHaveBeenCalledOnce();
      expect(updated, 'retired callback cannot publish timeline_updated').not.toHaveBeenCalled();
    } finally { set(f.player, 'preparingMseSeek', null); await f.destroy(); }
  });

  it('timeline_loaded may retire the player but cannot be followed by duration_changed', async () => {
    const f = await fixture(18, false, true, { skipInitialTimeline: true });
    let destruction: Promise<void> | undefined;
    const loaded = vi.fn(() => { destruction = f.player.destroy(); void destruction.catch(() => {}); });
    const duration = vi.fn(); f.player.on('timeline_loaded', loaded); f.player.on('duration_changed', duration);
    try {
      await f.sendTimeline(); await destruction; await flush(32);
      expect(loaded).toHaveBeenCalledOnce();
      expect(duration, 'duration event must not follow retirement').not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it('control: an ordinary timeline update still publishes and updates duration', async () => {
    const f = await fixture(18), updated = vi.fn(); f.player.on('timeline_updated', updated);
    try { await f.sendTimeline(); expect(updated).toHaveBeenCalledOnce(); expect(f.player.duration).toBe(5000); }
    finally { await f.destroy(); }
  });
});
